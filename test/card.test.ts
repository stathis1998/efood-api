import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { EfoodError } from '../src/index.js';
import { fixture, makeEfood, ok, SHOP, standardRoutes } from './helpers.js';

const code = (expected: string) => (err: unknown) => err instanceof EfoodError && err.code === expected;
const SUBMIT = 'POST /api/v1/order/submit/';
const VALIDATE = 'POST /api/v1/order/validate/';
const CARDS = 'GET /api/v1/ext/piraeus/methods/';
const NOW = () => new Date(2026, 10, 23, 8, 0);

// Tokens change on every listing, like the real endpoint's.
let listing = 0;
const cards = () => {
  listing += 1;
  return ok([
    { hashcode: 'h-main', card_number: '555555******4444', card_type: 'mastercard', bank: 'BANK A', expiration_date: '10-2027', is_default: true, is_active: true, id: `secret-main-${listing}` },
    { hashcode: 'h-old', card_number: '411111******1111', card_type: 'visa', bank: 'BANK B', expiration_date: '07-2026', is_default: false, is_active: true, id: `secret-old-${listing}` },
    { hashcode: 'h-other', card_number: '222300******0023', card_type: 'mastercard', bank: 'BANK C', expiration_date: '11-2026', is_default: false, is_active: true, id: `secret-other-${listing}` },
  ]);
};
const setup = (over: Parameters<typeof standardRoutes>[0] = {}) => makeEfood(standardRoutes({ [CARDS]: cards, ...over }), { now: NOW });

test('cards lists saved cards without their payment tokens', async () => {
  const t = setup();
  await t.login();
  const list = await t.efood.cards();
  assert.deepEqual(list.map((c) => [c.last4, c.isDefault, c.expired]), [
    ['4444', true, false],
    ['1111', false, true],
    ['0023', false, false], // expires at the end of this month: still good
  ]);
  assert.doesNotMatch(JSON.stringify(list), /secret/);
});

test('a card dry run validates with the card and submits nothing', async () => {
  const t = setup();
  await t.login();
  const r = await t.efood.checkout(SHOP, { payment: 'card' });
  assert.deepEqual([r.dryRun, r.payment, r.card], [true, 'card', '555555******4444']);
  const sent = t.calls.find((c) => c.path === '/api/v1/order/validate/')!.body;
  assert.equal(sent.payment_method, 'piraeus.creditcard');
  assert.match(sent.payment_token, /^secret-main-/);
  assert.equal(t.count(SUBMIT), 0);
});

test('a card order pays with a token fetched just before submitting', async () => {
  const t = setup();
  await t.login();
  await t.efood.cards(); // an earlier listing must not be reused
  const r = await t.efood.checkout(SHOP, { payment: 'card', card: '0023', dryRun: false });
  assert.equal(r.orderId, '9001');
  const sent = t.calls.find((c) => c.path === '/api/v1/order/submit/')!.body;
  assert.equal(sent.payment_method, 'piraeus.creditcard');
  assert.equal(sent.payment_token, `secret-other-${listing}`);
  // The token is a payment secret: not in the result, not in the log.
  assert.doesNotMatch(JSON.stringify(r), /secret/);
  const log = readFileSync(join(t.dataDir, 'orders.log'), 'utf8');
  assert.match(log, /"card":"222300\*\*\*\*\*\*0023"/);
  assert.doesNotMatch(log, /secret/);
});

test('cash orders carry no payment token', async () => {
  const t = setup();
  await t.login();
  await t.efood.checkout(SHOP, { dryRun: false });
  const sent = t.calls.find((c) => c.path === '/api/v1/order/submit/')!.body;
  assert.equal(sent.payment_method, 'cash');
  assert.equal('payment_token' in sent, false);
  assert.equal(t.count(CARDS), 0);
});

const refusals: Array<[string, { card?: string }, Parameters<typeof standardRoutes>[0]]> = [
  ['an expired card', { card: '1111' }, {}],
  ['a card that is not saved', { card: '0000' }, {}],
  ['no default card', {}, { [CARDS]: () => ok([{ hashcode: 'h', card_number: '1111******2222', expiration_date: '10-2027', is_default: false, id: 'secret' }]) }],
  ['a shop that does not take cards', {}, {
    'GET /v3/shops/info': () => {
      const info = structuredClone(fixture('info')) as any;
      info.shop.payment_methods.credit_card = false;
      return ok(info);
    },
  }],
];
for (const [name, options, over] of refusals) {
  test(`a card order with ${name} is refused before anything is sent`, async () => {
    const t = setup(over);
    await t.login();
    await assert.rejects(t.efood.checkout(SHOP, { payment: 'card', dryRun: false, ...options }), code('payment_unavailable'));
    assert.equal(t.count(VALIDATE), 0);
    assert.equal(t.count(SUBMIT), 0);
  });
}

test('a favourite remembers its card and pays with it', async () => {
  const t = setup();
  await t.login();
  const fav = await t.efood.favorites.saveFromCart('coffee', SHOP, { payment: 'card', card: '0023' });
  assert.deepEqual([fav.payment, fav.cardKey, fav.cardLast4], ['card', 'h-other', '0023']);
  await assert.rejects(t.efood.favorites.saveFromCart('bad', SHOP, { payment: 'card', card: '1111' }), code('payment_unavailable'));

  const r = await t.efood.favorites.order('coffee', { dryRun: false });
  assert.equal(r.card, '222300******0023');
  assert.match(t.calls.find((c) => c.path === '/api/v1/order/submit/')!.body.payment_token, /^secret-other-/);

  // Paying one order differently does not change the favourite.
  const cash = await t.efood.favorites.order('coffee', { dryRun: true, payment: 'cash' });
  assert.equal(cash.payment, 'cash');
  assert.equal(t.efood.favorites.get('coffee').payment, 'card');
});

test('a submit that returns no order id is reported as unknown and not retried the same day', async () => {
  const t = setup({ [SUBMIT]: () => ok({ redirect_url: 'https://bank.example/3ds' }) });
  await t.login();
  await t.efood.favorites.saveFromCart('coffee', SHOP, { payment: 'card' });
  await assert.rejects(t.efood.favorites.order('coffee', { dryRun: false }), (err: unknown) => {
    return err instanceof EfoodError && err.code === 'outcome_unknown' && (err.details as any).response.redirect_url !== undefined;
  });
  assert.deepEqual(t.efood.favorites.lastOrder('coffee'), { date: '2026-11-23', orderId: '' });
  await assert.rejects(t.efood.favorites.order('coffee', { dryRun: false }), code('already_ordered_today'));
  assert.equal(t.count(SUBMIT), 1);
  assert.match(readFileSync(join(t.dataDir, 'orders.log'), 'utf8'), /redirect_url/);
});

test('a dropped connection on submit is reported as unknown and not retried the same day', async () => {
  const t = setup({
    [SUBMIT]: () => {
      throw new Error('socket hang up');
    },
  });
  await t.login();
  await t.efood.favorites.saveFromCart('coffee', SHOP);
  await assert.rejects(t.efood.favorites.order('coffee', { dryRun: false }), code('outcome_unknown'));
  await assert.rejects(t.efood.favorites.order('coffee', { dryRun: false }), code('already_ordered_today'));
  assert.equal(t.count(SUBMIT), 1);
});

test('a clean refusal from efood leaves the favourite free to retry', async () => {
  const t = setup({ [SUBMIT]: () => ({ status: 'error', error_code: 'payment_failed', message: 'declined' }) });
  await t.login();
  await t.efood.favorites.saveFromCart('coffee', SHOP, { payment: 'card' });
  await assert.rejects(t.efood.favorites.order('coffee', { dryRun: false }), code('api_error'));
  assert.equal(t.efood.favorites.lastOrder('coffee'), undefined);
});

test('a bank confirmation (3-D Secure) is reported with its link, and the order is picked up once approved', async () => {
  const order = (id: number) => ({ id, price: 2.5, restaurant: { id: SHOP, name: 'Badger coffee' }, products: [] });
  let approved = false;
  const t = setup({
    [SUBMIT]: () => ok({ reason: { error_code: 'redirect', code: 20037 }, redirect: 'https://pay.example/3ds/form?token=secret-3ds', redirect_metadata: null }),
    'GET /api/v1/user/orders/history': () => ok({ orders: approved ? [order(7002), order(7001)] : [order(7001)], hasNext: false }),
  });
  await t.login();
  await t.efood.favorites.saveFromCart('coffee', SHOP, { payment: 'card' });

  let pending: any;
  await assert.rejects(t.efood.favorites.order('coffee', { dryRun: false }), (err: unknown) => {
    pending = (err as EfoodError).details;
    return err instanceof EfoodError && err.code === 'confirmation_required';
  });
  assert.equal(pending.url, 'https://pay.example/3ds/form?token=secret-3ds');
  assert.deepEqual(pending.knownOrderIds, [7001]);
  // No order exists yet: the favourite is not marked, and the link's token is not logged.
  assert.equal(t.efood.favorites.lastOrder('coffee'), undefined);
  assert.doesNotMatch(readFileSync(join(t.dataDir, 'orders.log'), 'utf8'), /secret/);

  // Not approved: an older order from the same shop is not mistaken for the new one.
  assert.equal(await t.efood.waitForConfirmation(pending, { timeoutMs: 0, intervalMs: 1 }), undefined);
  approved = true;
  const found = await t.efood.waitForConfirmation(pending, { timeoutMs: 1000, intervalMs: 1 });
  assert.equal(found?.id, 7002);
  assert.deepEqual(t.efood.favorites.lastOrder('coffee'), { date: '2026-11-23', orderId: '7002' });
});

test('a placed order reports what efood charged, including a fee its quote left out', async () => {
  const t = setup({ [SUBMIT]: () => ok({ order_id: 9002, information: { price: 2.6, service_fee: 0.1 } }) });
  await t.login();
  assert.equal((await t.efood.checkout(SHOP, { payment: 'card' })).total, 2.5);
  assert.equal((await t.efood.checkout(SHOP, { payment: 'card', dryRun: false })).total, 2.6);
});
