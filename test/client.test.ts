import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EfoodClient } from '../src/efood/client.js';
import { EfoodError } from '../src/efood/errors.js';
import { authError, fakeFetch, ok } from './helpers.js';

function client(routes: Parameters<typeof fakeFetch>[0]) {
  const fake = fakeFetch(routes);
  const c = new EfoodClient({ baseUrl: 'https://api.test', userAgent: 'test', minRequestIntervalMs: 0, fetch: fake.fetch });
  return { c, ...fake };
}

const code = (expected: string) => (err: unknown) => err instanceof EfoodError && err.code === expected;

test('returns the data of an ok envelope and of a "success" envelope', async () => {
  const { c } = client({ 'GET /a': () => ok({ x: 1 }), 'GET /b': () => ({ status: 'success', data: { y: 2 } }) });
  assert.deepEqual(await c.request('GET', '/a'), { x: 1 });
  assert.deepEqual(await c.request('GET', '/b'), { y: 2 });
});

test('sends the session header only when asked to', async () => {
  const { c, calls } = client({ 'GET /a': () => ok({}) });
  c.setSessionId('sid');
  await c.request('GET', '/a');
  await c.request('GET', '/a', { auth: true });
  assert.deepEqual(calls.map((x) => x.session), [null, 'sid']);
});

test('an authenticated call without a session fails before any request', async () => {
  const { c, calls } = client({});
  await assert.rejects(c.request('GET', '/a', { auth: true }), code('no_session'));
  assert.equal(calls.length, 0);
});

test('an auth error with a session sent means the session expired', async () => {
  const { c } = client({ 'GET /a': () => authError });
  c.setSessionId('sid');
  await assert.rejects(c.request('GET', '/a', { auth: true }), code('session_expired'));
  await assert.rejects(c.request('GET', '/a'), code('no_session'));
});

test('other error envelopes become api_error with efood\'s message', async () => {
  const { c } = client({ 'GET /a': () => ({ status: 'error', error_code: 'shop_closed', message: 'Κλειστό' }) });
  await assert.rejects(c.request('GET', '/a'), (err: unknown) => {
    return err instanceof EfoodError && err.code === 'api_error' && err.apiCode === 'shop_closed' && err.message === 'Κλειστό';
  });
});

test('an HTML page is reported as blocked', async () => {
  const { c } = client({ 'GET /a': () => new Response('<html>Just a moment...</html>', { status: 403 }) });
  await assert.rejects(c.request('GET', '/a'), code('blocked'));
});

test('a rate-limited read is retried, a rate-limited write is not', async () => {
  let hits = 0;
  const limited = () => {
    hits += 1;
    return hits === 1 ? new Response('', { status: 429, headers: { 'retry-after': '0.01' } }) : ok({ done: true });
  };
  const { c, count } = client({ 'GET /a': limited, 'POST /b': () => new Response('', { status: 429 }) });
  assert.deepEqual(await c.request('GET', '/a'), { done: true });
  await assert.rejects(c.request('POST', '/b', { body: {} }), code('rate_limited'));
  assert.equal(count('POST /b'), 1);
});
