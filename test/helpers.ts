import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Efood } from '../src/index.js';

export function fixture(name: string): unknown {
  return JSON.parse(readFileSync(new URL(`../../test/fixtures/${name}.json`, import.meta.url), 'utf8'));
}

export const ok = (data: unknown) => ({ status: 'ok', error_code: 'success', data });
export const authError = { status: 'error', error_code: 'authentication_error', message: 'login needed', data: {} };

export interface Call {
  method: string;
  path: string;
  query: URLSearchParams;
  body: any;
  session: string | null;
}

type Handler = (call: Call) => unknown | Response;

/** A fake `fetch` that answers by "METHOD /path" and records every call. */
export function fakeFetch(routes: Record<string, Handler>) {
  const calls: Call[] = [];
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const headers = new Headers(init?.headers);
    const call: Call = {
      method: init?.method ?? 'GET',
      path: url.pathname,
      query: url.searchParams,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
      session: headers.get('x-core-session-id'),
    };
    calls.push(call);
    const handler = routes[`${call.method} ${call.path}`];
    if (!handler) return new Response(JSON.stringify(authError), { status: 200 });
    const result = handler(call);
    return result instanceof Response ? result : new Response(JSON.stringify(result), { status: 200 });
  }) as typeof fetch;
  return { fetch: impl, calls, count: (key: string) => calls.filter((c) => `${c.method} ${c.path}` === key).length };
}

export const SHOP = 4489803;
export const ADDRESS = { id: 77, description: 'Home', street: 'Odos', street_number: '1', latitude: 37.98, longitude: 23.72, is_default: true };

/** One saved-cart line as `/api/carts/retrieve` returns it. */
export function cartItem(over: { quantity?: number; unit_price?: number; product_id?: string } = {}) {
  const unit = over.unit_price ?? 2.5;
  return {
    type: 'product',
    attributes: { quantity: { current: over.quantity ?? 1 }, unit_price: unit, total_price: unit, comment: '' },
    data: {
      product_id: over.product_id ?? 'IT_000000000275',
      name: 'Freddo espresso',
      materials_names: [
        { code: '515.1894', name: 'Regular' },
        { code: '945.28665', name: 'Μέτριος' },
      ],
    },
  };
}

/** Routes for a logged-in account with one shop, backed by the saved fixtures. */
export function standardRoutes(over: Record<string, Handler> = {}): Record<string, Handler> {
  return {
    'GET /api/v1/user/account': () => ok({ user: { id: 1, first_name: 'Test', email: 't@example.com' } }),
    'GET /api/v1/user/clients/address': () => ok([ADDRESS]),
    'GET /v3/shops/info': () => ok(fixture('info')),
    'GET /v3/shops/catalog': () => ok(fixture('catalog')),
    'GET /v3/shops/catalog/product': () => ok(fixture('product')),
    'POST /api/carts/retrieve': () => ({ status: 'success', data: { carts: [{ items: [cartItem()] }] } }),
    'POST /api/carts/delete': () => ({ status: 'success', data: {} }),
    'POST /api/v1/order/validate/': () => ok({ valid: true }),
    'POST /api/v1/order/submit/': () => ok({ order_id: 9001 }),
    ...over,
  };
}

export function makeEfood(routes: Record<string, Handler>, options: { session?: boolean; now?: () => Date } = {}) {
  const fake = fakeFetch(routes);
  const dataDir = mkdtempSync(join(tmpdir(), 'efood-test-'));
  const efood = new Efood({ dataDir, fetch: fake.fetch, minRequestIntervalMs: 0, now: options.now });
  return { efood, dataDir, ...fake, login: () => efood.setSession('sid-123') };
}
