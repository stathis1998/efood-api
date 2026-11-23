/**
 * Low-level HTTP client for the (unofficial) efood.gr consumer API.
 *
 * The API returns HTTP 200 for most responses and signals success/failure in a
 * JSON envelope: `{ status: "ok" | "error", error_code, message, data, ... }`.
 * This client turns that into either the parsed `data` payload or a thrown
 * `EfoodError` with a stable code.
 */
import { loggable, type Logger } from '../log.js';
import { EfoodError } from './errors.js';

export interface ClientConfig {
  baseUrl: string;
  userAgent: string;
  /** Minimum gap between requests, in ms. Requests are sent one at a time. */
  minRequestIntervalMs: number;
  /** Default `Accept-Language` header; efood localises menu names from it. */
  acceptLanguage?: string;
  /** Injectable for tests. */
  fetch?: typeof fetch;
  /** Where calls are logged; nothing is logged without it. */
  logger?: Logger;
}

/** Counts of the efood calls made by one client, for a summary or for debugging. */
export interface RequestStats {
  /** Calls made, counting each one once however many times it was retried. */
  requests: number;
  /** Calls that ended in an error. */
  failed: number;
  /** Extra attempts after a rate limit. */
  retries: number;
  /** Time spent waiting for efood, in ms (the pause between calls is not counted). */
  totalMs: number;
  byEndpoint: Record<string, { requests: number; failed: number; totalMs: number }>;
}

/** What one call did, filled in as it goes so a failure can still be logged. */
interface Exchange {
  attempts: number;
  httpStatus?: number;
  bytes?: number;
  response?: unknown;
}

export interface EfoodEnvelope<T = unknown> {
  status?: string;
  error_code?: string;
  message?: string;
  data?: T;
  [k: string]: unknown;
}

export const DEFAULT_BASE_URL = 'https://api.e-food.gr';
export const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Mobile Safari/537.36';

export interface RequestOptions {
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  /**
   * Session handling:
   *  - `true`: attach `x-core-session-id`; throw `no_session` if none is set.
   *  - `'optional'`: attach it if a session is set, otherwise go anonymous.
   *  - falsy: never attach it.
   */
  auth?: boolean | 'optional';
  /** Override the base URL for this call (the web backend at www.e-food.gr). */
  baseUrl?: string;
  /** Extra headers merged over the defaults for this call. */
  headers?: Record<string, string>;
}

const AUTH_CODE_RE = /authentication|session|unauthori[sz]ed|not_logged_in|login_required/i;
const MAX_RATE_LIMIT_RETRIES = 2;
const MAX_RETRY_AFTER_MS = 10_000;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export class EfoodClient {
  private sessionId: string | null = null;
  private lastRequestAt = 0;
  /** Tail of the request queue: keeps requests sequential and spaced out. */
  private queue: Promise<unknown> = Promise.resolve();
  private calls = 0;
  private readonly counts: RequestStats = { requests: 0, failed: 0, retries: 0, totalMs: 0, byEndpoint: {} };

  constructor(private readonly config: ClientConfig) {}

  setSessionId(sessionId: string | null): void {
    this.sessionId = sessionId;
  }

  hasSession(): boolean {
    return Boolean(this.sessionId);
  }

  /** How many efood calls this client has made so far. */
  stats(): RequestStats {
    return structuredClone(this.counts);
  }

  request<T = unknown>(
    method: 'GET' | 'POST',
    path: string,
    options: RequestOptions = {},
  ): Promise<T> {
    const run = () => this.send<T>(method, path, options);
    const result = this.queue.then(run, run);
    this.queue = result.catch(() => undefined);
    return result;
  }

  private async throttle(): Promise<void> {
    const wait = this.lastRequestAt + this.config.minRequestIntervalMs - Date.now();
    if (wait > 0) await sleep(wait);
    this.lastRequestAt = Date.now();
  }

  private buildUrl(path: string, query?: RequestOptions['query'], baseUrl?: string): string {
    const url = new URL(path, baseUrl ?? this.config.baseUrl);
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
    return url.toString();
  }

  /** One call, counted and logged. Headers are never logged: they hold the session id. */
  private async send<T>(method: 'GET' | 'POST', path: string, options: RequestOptions): Promise<T> {
    const log = this.config.logger;
    const call = (this.calls += 1);
    const host = new URL(options.baseUrl ?? this.config.baseUrl).host;
    const exchange: Exchange = { attempts: 0 };
    const started = Date.now();
    let failure: EfoodError | undefined;
    try {
      return await this.exchange<T>(method, path, options, exchange);
    } catch (err) {
      if (err instanceof EfoodError) failure = err;
      throw err;
    } finally {
      const ms = Date.now() - started;
      const failed = failure !== undefined || exchange.httpStatus === undefined;
      // A call refused before anything was sent (no session) is logged but not counted.
      if (exchange.attempts > 0) {
        const key = `${method} ${path}`;
        const endpoint = (this.counts.byEndpoint[key] ??= { requests: 0, failed: 0, totalMs: 0 });
        endpoint.requests += 1;
        endpoint.totalMs += ms;
        this.counts.requests += 1;
        this.counts.totalMs += ms;
        this.counts.retries += exchange.attempts - 1;
        if (failed) {
          endpoint.failed += 1;
          this.counts.failed += 1;
        }
      }
      if (log) {
        const fields: Record<string, unknown> = {
          call,
          method,
          host,
          path,
          query: options.query && Object.keys(options.query).length ? options.query : undefined,
          auth: options.auth ? Boolean(this.sessionId) : undefined,
          httpStatus: exchange.httpStatus,
          ms,
          bytes: exchange.bytes,
          attempts: exchange.attempts > 1 ? exchange.attempts : undefined,
        };
        if (failure) {
          fields.error = failure.code;
          fields.apiCode = failure.apiCode;
          fields.reason = failure.message;
        }
        if (log.isLevelEnabled('trace')) {
          if (options.body !== undefined) fields.requestBody = loggable(options.body);
          if (exchange.response !== undefined) fields.response = loggable(exchange.response);
        }
        const line = `${method} ${path} -> ${failure ? failure.code : exchange.httpStatus} in ${ms} ms`;
        if (failed) log.warn(fields, line);
        else if (log.isLevelEnabled('trace')) log.trace(fields, line);
        else log.debug(fields, line);
      }
    }
  }

  private async exchange<T>(method: 'GET' | 'POST', path: string, options: RequestOptions, exchange: Exchange): Promise<T> {
    const headers: Record<string, string> = {
      Accept: 'application/json',
      'User-Agent': this.config.userAgent,
    };
    if (this.config.acceptLanguage) headers['Accept-Language'] = this.config.acceptLanguage;

    let sentSession = false;
    if (options.auth === true || options.auth === 'optional') {
      if (this.sessionId) {
        headers['x-core-session-id'] = this.sessionId;
        sentSession = true;
      } else if (options.auth === true) {
        throw new EfoodError('no_session', 'No efood session saved. Run `efood login` first.');
      }
    }

    let payload: string | undefined;
    if (options.body !== undefined) {
      headers['Content-Type'] = 'application/json';
      payload = JSON.stringify(options.body);
    }
    if (options.headers) Object.assign(headers, options.headers);

    const url = this.buildUrl(path, options.query, options.baseUrl);
    const doFetch = this.config.fetch ?? fetch;

    let response: Response;
    for (let attempt = 0; ; attempt++) {
      await this.throttle();
      exchange.attempts = attempt + 1;
      try {
        response = await doFetch(url, {
          method,
          headers,
          body: payload,
          signal: AbortSignal.timeout(30_000),
        });
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        throw new EfoodError('network_error', `Network error calling efood: ${reason}`);
      }
      exchange.httpStatus = response.status;
      if (response.status !== 429) break;
      // Only reads are retried: a write is never sent twice.
      if (method !== 'GET' || attempt >= MAX_RATE_LIMIT_RETRIES) {
        throw new EfoodError('rate_limited', 'efood is rate limiting requests. Try again later.', {
          httpStatus: 429,
        });
      }
      const retryAfter = Number(response.headers.get('retry-after'));
      const waitMs = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 2000;
      await sleep(Math.min(waitMs, MAX_RETRY_AFTER_MS));
    }

    const text = await response.text();
    exchange.bytes = text.length;
    let envelope: EfoodEnvelope<T> | null = null;
    if (text) {
      try {
        envelope = JSON.parse(text) as EfoodEnvelope<T>;
        exchange.response = envelope;
      } catch {
        exchange.response = text.slice(0, 300);
        // An HTML page instead of JSON: a Cloudflare challenge or a proxy error.
        throw new EfoodError(
          'blocked',
          `efood returned a non-JSON page (HTTP ${response.status}); the request was probably blocked by its bot protection.`,
          { httpStatus: response.status },
        );
      }
    }

    // v1 endpoints signal success with "ok"; the web backend uses "success".
    const status = envelope?.status;
    const failed = !response.ok || (status !== undefined && status !== 'ok' && status !== 'success');
    if (failed) {
      const apiCode = envelope?.error_code;
      const message = envelope?.message ?? `efood returned HTTP ${response.status}.`;
      const info = { httpStatus: response.status, apiCode };
      if (response.status === 401 || (apiCode && AUTH_CODE_RE.test(apiCode))) {
        throw sentSession
          ? new EfoodError('session_expired', `efood session expired or invalid: ${message}`, info)
          : new EfoodError('no_session', `This call needs a logged-in session: ${message}`, info);
      }
      throw new EfoodError('api_error', message, info);
    }

    return (envelope?.data ?? envelope ?? ({} as T)) as T;
  }
}
