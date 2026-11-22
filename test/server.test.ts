import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { after, before, test } from 'node:test';
import { createEfoodServer } from '../src/server.js';
import { authError, makeEfood, SHOP, standardRoutes } from './helpers.js';

const TOKEN = 'test-token';
let sessionAlive = true;
const t = makeEfood(standardRoutes({ 'GET /api/v1/user/account': () => (sessionAlive ? { status: 'ok', data: { user: { first_name: 'Test' } } } : authError) }));
const server = createEfoodServer({ efood: t.efood, token: TOKEN, healthCacheMs: 0 });
let base = '';

before(async () => {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => server.close());

async function call(method: string, path: string, body?: unknown, token = TOKEN) {
  // The real fetch: the fake one only backs the library's calls to efood.
  const res = await fetch(base + path, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as any };
}

test('requests without the right token are refused', async () => {
  assert.equal((await call('GET', '/health', undefined, 'wrong')).status, 401);
  assert.equal((await fetch(`${base}/health`)).status, 401);
});

test('health reports a missing session, then a valid one after POST /session', async () => {
  const missing = await call('GET', '/health');
  assert.equal(missing.status, 200);
  assert.deepEqual([missing.body.ok, missing.body.session], [false, 'missing']);

  assert.equal((await call('POST', '/session', {})).status, 400);
  assert.equal((await call('POST', '/session', { sessionId: 'sid-123' })).body.ok, true);

  const valid = await call('GET', '/health');
  assert.deepEqual([valid.body.ok, valid.body.session, valid.body.user], [true, 'valid', 'Test']);
});

test('ordering a favourite is a dry run unless dryRun is exactly false', async () => {
  await t.efood.favorites.saveFromCart('coffee', SHOP);
  const submits = () => t.count('POST /api/v1/order/submit/');

  for (const body of [undefined, {}, { dryRun: 'false' }, { dryRun: 0 }]) {
    const r = await call('POST', '/favorites/coffee/order', body);
    assert.equal(r.status, 200);
    assert.equal(r.body.dryRun, true);
  }
  assert.equal(submits(), 0);

  const real = await call('POST', '/favorites/coffee/order', { dryRun: false });
  assert.deepEqual([real.status, real.body.dryRun, real.body.orderId], [200, false, '9001']);
  assert.equal('response' in real.body, false);
  assert.equal(submits(), 1);

  const again = await call('POST', '/favorites/coffee/order', { dryRun: false });
  assert.deepEqual([again.status, again.body.error], [409, 'already_ordered_today']);
  assert.equal(submits(), 1);

  const health = await call('GET', '/health');
  assert.equal(health.body.lastOrders.coffee.orderId, '9001');
});

test('errors map to HTTP statuses', async () => {
  assert.equal((await call('POST', '/favorites/nope/order')).status, 404);
  assert.equal((await call('GET', '/nope')).status, 404);
  assert.equal((await call('GET', '/shops/abc/menu')).status, 400);
});

test('an expired efood session shows in health and as 503', async () => {
  sessionAlive = false;
  const health = await call('GET', '/health');
  assert.deepEqual([health.status, health.body.ok, health.body.session], [200, false, 'expired']);
  const r = await call('POST', '/session', { sessionId: 'dead' });
  assert.deepEqual([r.status, r.body.error], [503, 'session_expired']);
});
