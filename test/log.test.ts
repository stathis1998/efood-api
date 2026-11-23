import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EfoodClient } from '../src/efood/client.js';
import { loggable, logOptionsFromEnv, REDACTED, sanitize } from '../src/log.js';
import { fakeFetch, makeEfood, memoryLogger, ok, SHOP, standardRoutes } from './helpers.js';

const JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJkYXRhIjoiY2FyZCJ9.c2lnbmF0dXJlLXZhbHVl';

test('sanitize removes secrets by key, signed tokens anywhere, and tokens in links', () => {
  const clean = sanitize({
    payment_token: 'abc',
    sessionId: 'sid-123',
    cards: [{ id: JWT, card_number: '555555******4444' }],
    redirect: `https://pay.example/3ds/form?token=${JWT}&lang=el`,
    note: `card ${JWT} used`,
    price: 2.5,
    coupon_valid: false,
  }) as any;
  assert.equal(clean.payment_token, REDACTED);
  assert.equal(clean.sessionId, REDACTED);
  assert.deepEqual(clean.cards, [{ id: REDACTED, card_number: '555555******4444' }]);
  assert.equal(clean.redirect, `https://pay.example/3ds/form?token=${REDACTED}&lang=el`);
  assert.equal(clean.note, `card ${REDACTED} used`);
  assert.deepEqual([clean.price, clean.coupon_valid], [2.5, false]);
  assert.doesNotMatch(JSON.stringify(clean), /eyJ|sid-123/);
});

test('loggable clips big payloads', () => {
  assert.deepEqual(loggable({ a: 1 }), { a: 1 });
  const clipped = loggable({ list: Array.from({ length: 500 }, (_, i) => `item ${i}`) }, 100) as string;
  assert.equal(typeof clipped, 'string');
  assert.match(clipped, /characters\)$/);
});

test('log settings come from the environment and ignore unknown values', () => {
  assert.deepEqual(logOptionsFromEnv({ EFOOD_LOG_LEVEL: 'DEBUG', EFOOD_LOG_FILE: ' efood.log ', EFOOD_LOG_FORMAT: 'json' }), { level: 'debug', file: 'efood.log', format: 'json' });
  assert.equal(logOptionsFromEnv({ EFOOD_LOG_FORMAT: 'Expanded' }).format, 'expanded');
  assert.deepEqual(logOptionsFromEnv({ EFOOD_LOG_LEVEL: 'loud', EFOOD_LOG_FORMAT: 'xml' }), { level: undefined, file: undefined, format: undefined });
});

test('every efood call is counted and logged with its status and duration', async () => {
  const log = memoryLogger();
  const fake = fakeFetch({
    'GET /a': () => ok({ x: 1 }),
    'POST /b': () => ({ status: 'error', error_code: 'nope', message: 'refused' }),
  });
  const c = new EfoodClient({ baseUrl: 'https://api.test', userAgent: 'test', minRequestIntervalMs: 0, fetch: fake.fetch, logger: log.logger });
  c.setSessionId('sid-123');
  await c.request('GET', '/a', { auth: true, query: { limit: 5 } });
  await c.request('GET', '/a');
  await assert.rejects(c.request('POST', '/b', { auth: true, body: { payment_token: JWT, amount: 2.5 } }));

  const stats = c.stats();
  assert.deepEqual([stats.requests, stats.failed, stats.retries], [3, 1, 0]);
  assert.deepEqual([stats.byEndpoint['GET /a'].requests, stats.byEndpoint['POST /b'].failed], [2, 1]);

  assert.equal(log.lines.length, 3);
  const [first, , failed] = log.lines;
  assert.deepEqual([first.call, first.method, first.host, first.path, first.httpStatus, first.query.limit, first.auth], [1, 'GET', 'api.test', '/a', 200, 5, true]);
  assert.equal(typeof first.ms, 'number');
  assert.deepEqual(first.response.data, { x: 1 });
  // A refused call is a warning, with efood's own code and the body that was sent, minus the token.
  assert.deepEqual([failed.level, failed.error, failed.apiCode, failed.reason], [40, 'api_error', 'nope', 'refused']);
  assert.deepEqual(failed.requestBody, { payment_token: REDACTED, amount: 2.5 });
  assert.doesNotMatch(log.text(), /sid-123|eyJ/);
});

test('a call refused for lack of a session is logged but not counted as a request', async () => {
  const log = memoryLogger();
  const c = new EfoodClient({ baseUrl: 'https://api.test', userAgent: 'test', minRequestIntervalMs: 0, fetch: fakeFetch({}).fetch, logger: log.logger });
  await assert.rejects(c.request('GET', '/a', { auth: true }));
  assert.equal(c.stats().requests, 0);
  assert.equal(log.lines[0].error, 'no_session');
});

test('a card order at the most detailed log level leaves no session id or payment token in the log', async () => {
  const log = memoryLogger();
  const t = makeEfood(
    standardRoutes({
      'GET /api/v1/ext/piraeus/methods/': () => ok([{ hashcode: 'h', card_number: '555555******4444', expiration_date: '10-2099', is_default: true, is_active: true, id: JWT }]),
    }),
    { logger: log.logger },
  );
  await t.login();
  const r = await t.efood.checkout(SHOP, { payment: 'card', dryRun: false });
  assert.equal(r.orderId, '9001');
  assert.equal(t.efood.requestStats().requests, t.calls.length);
  const messages = log.lines.map((l) => l.msg);
  assert.ok(messages.includes('placing order') && messages.includes('order placed'));
  assert.match(log.text(), /555555\*{6}4444/); // the masked number is fine
  assert.doesNotMatch(log.text(), /sid-123|eyJ/);
});
