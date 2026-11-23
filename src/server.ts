/**
 * Small HTTP service in front of the library, meant for Home Assistant
 * (`rest_command` + a REST sensor on /health).
 *
 * Every route needs `Authorization: Bearer <token>`.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { Efood, EfoodError, type EfoodErrorCode } from './index.js';

export interface ServerOptions {
  efood: Efood;
  token: string;
  /** How long a session check is reused by /health, in ms. */
  healthCacheMs?: number;
}

const STATUS_BY_CODE: Partial<Record<EfoodErrorCode, number>> = {
  bad_request: 400,
  not_found: 404,
  ambiguous: 409,
  option_not_found: 409,
  empty_cart: 409,
  shop_closed: 409,
  out_of_stock: 409,
  below_minimum: 409,
  over_max_total: 409,
  payment_unavailable: 409,
  already_ordered_today: 409,
  // Nothing was ordered yet: the bank wants the payment approved at `details.url`.
  confirmation_required: 409,
  // The order may or may not exist: the caller must not retry on its own.
  outcome_unknown: 502,
  // The efood session is a problem with this service's setup, not the caller's token.
  no_session: 503,
  session_expired: 503,
  rate_limited: 503,
  blocked: 502,
  network_error: 502,
  api_error: 502,
};

function send(res: ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(json);
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > 64 * 1024) throw new EfoodError('bad_request', 'Request body too large.');
    chunks.push(chunk as Buffer);
  }
  const text = Buffer.concat(chunks).toString('utf8').trim();
  if (!text) return {};
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // fall through
  }
  throw new EfoodError('bad_request', 'Request body must be a JSON object.');
}

function tokenMatches(header: string | undefined, token: string): boolean {
  const given = Buffer.from(header?.startsWith('Bearer ') ? header.slice(7) : '');
  const expected = Buffer.from(token);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

function optNumber(v: unknown, name: string): number | undefined {
  if (v === undefined || v === null || v === '') return undefined;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new EfoodError('bad_request', `"${name}" must be a number.`);
  return n;
}

function paymentOf(v: unknown): 'cash' | 'card' | undefined {
  if (v === undefined || v === null) return undefined;
  if (v === 'cash' || v === 'card') return v;
  throw new EfoodError('bad_request', '"payment" must be "cash" or "card".');
}

function shopIdOf(v: string): number {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw new EfoodError('bad_request', 'Shop id must be a number.');
  return n;
}

export function createEfoodServer(options: ServerOptions): Server {
  const { efood, token } = options;
  const healthCacheMs = options.healthCacheMs ?? 5 * 60_000;
  if (!token) throw new Error('A bearer token is required to start the server.');

  let health: { at: number; body: Record<string, unknown> } | null = null;

  async function checkHealth(): Promise<Record<string, unknown>> {
    if (health && Date.now() - health.at < healthCacheMs) return health.body;
    let session: 'valid' | 'expired' | 'missing' | 'unknown';
    let detail: string | undefined;
    let user: string | undefined;
    try {
      user = (await efood.me()).firstName;
      session = 'valid';
    } catch (err) {
      if (!(err instanceof EfoodError)) throw err;
      session = err.code === 'no_session' ? 'missing' : err.code === 'session_expired' ? 'expired' : 'unknown';
      detail = err.message;
    }
    const favorites = Object.fromEntries(
      efood.favorites.list().map((f) => [f.name, efood.favorites.lastOrder(f.name) ?? null]),
    );
    const body = { ok: session === 'valid', session, user, detail, lastOrders: favorites };
    // An "unknown" result (network trouble) is not cached, so it clears quickly.
    if (session !== 'unknown') health = { at: Date.now(), body };
    return body;
  }

  async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
    const key = `${req.method} /${parts[0] ?? ''}`;
    const q = url.searchParams;

    if (key === 'GET /health' && parts.length === 1) {
      return send(res, 200, await checkHealth());
    }
    if (key === 'POST /session' && parts.length === 1) {
      const body = await readJson(req);
      if (typeof body.sessionId !== 'string') {
        throw new EfoodError('bad_request', 'Body must be {"sessionId": "..."}.');
      }
      const account = await efood.setSession(body.sessionId);
      health = null;
      return send(res, 200, { ok: true, user: account.firstName });
    }
    if (key === 'GET /addresses' && parts.length === 1) {
      return send(res, 200, await efood.addresses());
    }
    if (key === 'GET /cards' && parts.length === 1) {
      return send(res, 200, await efood.cards());
    }
    if (key === 'GET /orders' && parts.length === 1) {
      return send(res, 200, await efood.orders({ limit: optNumber(q.get('limit'), 'limit'), shop: q.get('shop') ?? undefined }));
    }
    if (key === 'GET /orders' && parts.length === 3 && parts[2] === 'status') {
      return send(res, 200, await efood.orderStatus(parts[1]));
    }
    if (key === 'GET /shops' && parts.length === 1) {
      return send(
        res,
        200,
        await efood.shops({
          addressId: optNumber(q.get('addressId'), 'addressId'),
          latitude: optNumber(q.get('latitude'), 'latitude'),
          longitude: optNumber(q.get('longitude'), 'longitude'),
          favoritesOnly: q.get('favorites') === 'true',
          openOnly: q.get('open') === 'true',
          query: q.get('q') ?? undefined,
        }),
      );
    }
    if (key === 'GET /shops' && parts.length === 3 && parts[2] === 'menu') {
      return send(res, 200, await efood.menu(shopIdOf(parts[1])));
    }
    if (key === 'GET /shops' && parts.length === 3 && parts[2] === 'cart') {
      return send(res, 200, await efood.cart(shopIdOf(parts[1])).get());
    }
    if (key === 'GET /favorites' && parts.length === 1) {
      return send(res, 200, efood.favorites.list());
    }
    if (key === 'POST /favorites' && parts.length === 3 && parts[2] === 'order') {
      const body = await readJson(req);
      const result = await efood.favorites.order(parts[1], {
        // Only an explicit JSON `false` places a real order.
        dryRun: body.dryRun !== false,
        maxTotal: optNumber(body.maxTotal, 'maxTotal'),
        force: body.force === true,
        payment: paymentOf(body.payment),
        card: typeof body.card === 'string' ? body.card : undefined,
      });
      const { response: _response, ...summary } = result;
      return send(res, 200, summary);
    }
    send(res, 404, { error: 'not_found', message: `No route for ${req.method} ${url.pathname}.` });
  }

  return createServer((req, res) => {
    if (!tokenMatches(req.headers.authorization, token)) {
      return send(res, 401, { error: 'unauthorized', message: 'Missing or wrong bearer token.' });
    }
    route(req, res).catch((err: unknown) => {
      if (err instanceof EfoodError) {
        return send(res, STATUS_BY_CODE[err.code] ?? 500, err.toJSON());
      }
      console.error(err);
      send(res, 500, { error: 'internal_error', message: 'Unexpected error; see the service log.' });
    });
  });
}
