import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { EfoodError } from '../src/index.js';
import { authError, cartItem, fixture, makeEfood, ok, SHOP, standardRoutes } from './helpers.js';

const code = (expected: string) => (err: unknown) => err instanceof EfoodError && err.code === expected;
const SUBMIT = 'POST /api/v1/order/submit/';
const VALIDATE = 'POST /api/v1/order/validate/';

test('setSession saves a working session and rejects a dead one', async () => {
  const t = makeEfood(standardRoutes());
  const account = await t.login();
  assert.equal(account.firstName, 'Test');
  assert.equal(JSON.parse(readFileSync(join(t.dataDir, 'state.json'), 'utf8')).sessionId, 'sid-123');

  const bad = makeEfood(standardRoutes({ 'GET /api/v1/user/account': () => authError }));
  await assert.rejects(bad.login(), code('session_expired'));
  assert.equal(existsSync(join(bad.dataDir, 'state.json')), false);
  assert.equal(bad.efood.hasSession(), false);
});

test('orders pages through the history until hasNext is false', async () => {
  const order = (id: number) => ({ id, price: 3, restaurant: { id: SHOP, name: 'Badger' }, products: [] });
  const t = makeEfood(
    standardRoutes({
      'GET /api/v1/user/orders/history': (c) =>
        c.query.get('offset') === '0'
          ? ok({ orders: [order(1), order(2)], hasNext: true })
          : ok({ orders: [order(3)], hasNext: false }),
    }),
  );
  await t.login();
  const orders = await t.efood.orders({ limit: 50 });
  assert.deepEqual(orders.map((o) => o.id), [1, 2, 3]);
  assert.equal(t.calls.at(-1)?.query.get('offset'), '2');
});

test('orders can be filtered by shop id or name, and limit counts the matches', async () => {
  const order = (id: number, shopId: number, name: string) => ({ id, price: 3, restaurant: { id: shopId, name }, products: [] });
  const pages = [
    [order(1, 10, 'Badger coffee'), order(2, 20, 'Καφές του Γιώργου'), order(3, 10, 'Badger coffee')],
    [order(4, 20, 'Καφές του Γιώργου'), order(5, 10, 'Badger coffee'), order(6, 30, 'Pizza place')],
  ];
  const t = makeEfood(
    standardRoutes({
      'GET /api/v1/user/orders/history': (c) => {
        const offset = Number(c.query.get('offset'));
        return ok({ orders: pages[offset / 3] ?? [], hasNext: offset === 0 });
      },
    }),
  );
  await t.login();
  const ids = async (o: Parameters<typeof t.efood.orders>[0]) => (await t.efood.orders(o)).map((x) => x.id);
  assert.deepEqual(await ids({ shop: 10 }), [1, 3, 5]);
  assert.deepEqual(await ids({ shop: '20' }), [2, 4]);
  assert.deepEqual(await ids({ shop: 'BADGER' }), [1, 3, 5]);
  assert.deepEqual(await ids({ shop: 'καφες' }), [2, 4]); // accents and case are ignored
  assert.deepEqual(await ids({ shop: 'badger', limit: 3 }), [1, 3, 5]);
  assert.deepEqual(await ids({ shop: 'badger', limit: 2 }), [1, 3]);
  assert.deepEqual(await ids({ shop: 'sushi' }), []);
});

test('menu and item lookup work without a session', async () => {
  const t = makeEfood(standardRoutes());
  const menu = await t.efood.menu(SHOP);
  assert.equal(menu.shop.name, 'Badger coffee');
  assert.equal(menu.shop.isServing, undefined);
  assert.equal((await t.efood.findItem(SHOP, 'freddo espresso')).code, 'IT_000000000275');
  await assert.rejects(t.efood.findItem(SHOP, 'freddo'), code('ambiguous'));
  await assert.rejects(t.efood.findItem(SHOP, 'pizza'), code('not_found'));
});

test('cart.add re-sends the saved cart plus the new line', async () => {
  const t = makeEfood(standardRoutes());
  await t.login();
  await t.efood.cart(SHOP).add({ item: 'freddo espresso', options: ['grande', 'σκετος'], quantity: 2 });
  const sent = t.calls.find((c) => c.path === '/api/v1/order/validate/')!.body;
  assert.equal(sent.address_id, 0);
  assert.equal(sent.products.length, 2);
  assert.deepEqual(sent.products[1].materials, ['515.1895', '945.28667']);
  assert.equal(sent.products[1].total, 8);
  assert.equal(sent.amount, 10.5);
  assert.equal('optionNames' in sent.products[0], false);
});

test('cart.add with a bad option reports the choices and changes nothing', async () => {
  const t = makeEfood(standardRoutes());
  await t.login();
  await assert.rejects(t.efood.cart(SHOP).add({ item: 'freddo espresso', options: ['regular'] }), (err: unknown) => {
    return err instanceof EfoodError && err.code === 'option_not_found' && Array.isArray((err.details as any).tiers);
  });
  assert.equal(t.count(VALIDATE), 0);
});

test('checkout is a dry run by default', async () => {
  const t = makeEfood(standardRoutes());
  await t.login();
  const r = await t.efood.checkout(SHOP);
  assert.equal(r.dryRun, true);
  assert.equal(r.addressId, 77);
  assert.equal(r.estimatedTotal, 3); // 2.50 + 0.50 delivery
  assert.equal(r.total, 2.5); // what the (fake) validation quoted
  assert.equal(t.count(VALIDATE), 1);
  assert.equal(t.count(SUBMIT), 0);
  // The shop was asked about the delivery address, not in general.
  assert.equal(t.calls.find((c) => c.path === '/v3/shops/info')?.query.get('latitude'), '37.98');
});

test('checkout with dryRun false submits once and logs the order', async () => {
  const t = makeEfood(standardRoutes({ 'POST /api/carts/retrieve': () => ({ status: 'success', data: { carts: [{ items: [cartItem({ quantity: 2 })] }] } }) }));
  await t.login();
  const r = await t.efood.checkout(SHOP, { dryRun: false });
  assert.equal(r.orderId, '9001');
  assert.equal(t.count(SUBMIT), 1);
  const sent = t.calls.find((c) => c.path === '/api/v1/order/submit/')!.body;
  assert.equal(sent.address_id, 77);
  assert.equal(sent.payment_method, 'cash');
  assert.equal(sent.amount, 5);
  const log = readFileSync(join(t.dataDir, 'orders.log'), 'utf8');
  assert.match(log, /"orderId":"9001"/);
  assert.doesNotMatch(log, /sid-123/);
});

const guardCases: Array<[string, string, Record<string, any>, { maxTotal?: number }]> = [
  ['a closed shop', 'shop_closed', { info: (i: any) => (i.meta.is_open = false) }, {}],
  ['a shop not serving the address', 'shop_closed', { info: (i: any) => (i.meta.is_serving = false) }, {}],
  ['a shop without cash', 'payment_unavailable', { info: (i: any) => (i.shop.payment_methods.cash = false) }, {}],
  ['an out-of-stock item', 'out_of_stock', { catalog: (c: any) => c.menu.categories.forEach((k: any) => k.items.forEach((x: any) => (x.shortage = true))) }, {}],
  ['an item no longer on the menu', 'out_of_stock', { catalog: (c: any) => (c.menu.categories = []) }, {}],
  ['a total over the limit', 'over_max_total', {}, { maxTotal: 2.99 }],
  ['a total under the shop minimum', 'below_minimum', { info: (i: any) => (i.meta.minimum_order_value = 5) }, {}],
];
for (const [name, expected, edits, options] of guardCases) {
  test(`checkout refuses ${name} before sending anything`, async () => {
    const patched = (file: 'info' | 'catalog') => () => {
      const data = structuredClone(fixture(file)) as any;
      edits[file]?.(data);
      return ok(data);
    };
    const t = makeEfood(standardRoutes({ 'GET /v3/shops/info': patched('info'), 'GET /v3/shops/catalog': patched('catalog') }));
    await t.login();
    await assert.rejects(t.efood.checkout(SHOP, { dryRun: false, ...options }), code(expected));
    assert.equal(t.count(VALIDATE), 0);
    assert.equal(t.count(SUBMIT), 0);
  });
}

test('checkout refuses an empty cart', async () => {
  const t = makeEfood(standardRoutes({ 'POST /api/carts/retrieve': () => ({ status: 'success', data: { carts: [] } }) }));
  await t.login();
  await assert.rejects(t.efood.checkout(SHOP, { dryRun: false }), code('empty_cart'));
});

test('fees that push the quoted total over the limit stop the order', async () => {
  const t = makeEfood(standardRoutes({ [VALIDATE]: () => ok({ price: 4.1 }) }));
  await t.login();
  await assert.rejects(t.efood.checkout(SHOP, { dryRun: false, maxTotal: 4 }), code('over_max_total'));
  assert.equal(t.count(SUBMIT), 0);
});

test('a failed validation stops the order', async () => {
  const t = makeEfood(standardRoutes({ [VALIDATE]: () => ({ status: 'error', error_code: 'invalid', message: 'no' }) }));
  await t.login();
  await assert.rejects(t.efood.checkout(SHOP, { dryRun: false }), code('api_error'));
  assert.equal(t.count(SUBMIT), 0);
});

test('a favourite is saved from the cart and ordered once per day', async () => {
  let now = new Date(2026, 10, 23, 8, 0);
  const t = makeEfood(standardRoutes(), { now: () => now });
  await t.login();

  const fav = await t.efood.favorites.saveFromCart('coffee', SHOP);
  assert.equal(fav.shopName, 'Badger coffee');
  assert.equal(fav.maxTotal, 3.6); // (2.50 + 0.50) * 1.2
  assert.deepEqual(fav.lines[0].optionNames, ['Regular', 'Μέτριος']);

  const dry = await t.efood.favorites.order('coffee');
  assert.equal(dry.dryRun, true);
  assert.equal(t.count(SUBMIT), 0);
  assert.equal(t.efood.favorites.lastOrder('coffee'), undefined);

  const real = await t.efood.favorites.order('coffee', { dryRun: false });
  assert.equal(real.orderId, '9001');
  assert.deepEqual(t.efood.favorites.lastOrder('coffee'), { date: '2026-11-23', orderId: '9001' });

  await assert.rejects(t.efood.favorites.order('coffee', { dryRun: false }), code('already_ordered_today'));
  assert.equal(t.count(SUBMIT), 1);

  await t.efood.favorites.order('coffee', { dryRun: false, force: true });
  assert.equal(t.count(SUBMIT), 2);

  now = new Date(2026, 10, 24, 8, 0);
  await t.efood.favorites.order('coffee', { dryRun: false });
  assert.equal(t.count(SUBMIT), 3);
});

test('a favourite refuses to order when the price rose past its limit', async () => {
  const t = makeEfood(standardRoutes());
  await t.login();
  await t.efood.favorites.saveFromCart('coffee', SHOP, { maxTotal: 2 });
  await assert.rejects(t.efood.favorites.order('coffee', { dryRun: false }), code('over_max_total'));
  await assert.rejects(t.efood.favorites.order('tea'), code('not_found'));
});
