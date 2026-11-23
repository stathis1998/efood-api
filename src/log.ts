/**
 * Logging, built on pino. Off unless a level is set.
 *
 * Levels, from quiet to noisy:
 *   silent  nothing (the default)
 *   error   failures of this tool itself
 *   warn    failed or retried efood calls
 *   info    orders, session changes, service requests, a call summary
 *   debug   one line per efood call: method, path, status, duration
 *   trace   the same plus request and response bodies
 *
 * Logs go to stderr, or to a file. Secrets (session id, payment tokens, the
 * token in a bank confirmation link) are replaced before anything is written.
 * Bodies logged at `trace` still hold personal data such as addresses and
 * order contents, so treat a trace log as private.
 */
import { pino, type Logger } from 'pino';
import { PinoPretty } from 'pino-pretty';

export type { Logger };

export const LOG_LEVELS = ['silent', 'error', 'warn', 'info', 'debug', 'trace'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

export const LOG_FORMATS = ['pretty', 'expanded', 'json'] as const;
export type LogFormat = (typeof LOG_FORMATS)[number];

export interface LogOptions {
  /** Default: `silent`. */
  level?: LogLevel;
  /** Append to this file instead of writing to stderr. */
  file?: string;
  /**
   * `pretty`: one readable line per entry (time, level, a sentence, then the
   * details as JSON). `expanded`: the same with the details listed underneath,
   * one per line. `json`: one object per line, for tools.
   * Default: pretty on a terminal, json otherwise.
   */
  format?: LogFormat;
}

const isLevel = (v: unknown): v is LogLevel => (LOG_LEVELS as readonly string[]).includes(v as string);

/** Read `EFOOD_LOG_LEVEL`, `EFOOD_LOG_FILE` and `EFOOD_LOG_FORMAT`. Unknown values are ignored. */
export function logOptionsFromEnv(env: NodeJS.ProcessEnv = process.env): LogOptions {
  const level = env.EFOOD_LOG_LEVEL?.trim().toLowerCase();
  const format = env.EFOOD_LOG_FORMAT?.trim().toLowerCase();
  return {
    level: isLevel(level) ? level : undefined,
    file: env.EFOOD_LOG_FILE?.trim() || undefined,
    format: (LOG_FORMATS as readonly string[]).includes(format ?? '') ? (format as LogFormat) : undefined,
  };
}

export function parseLogLevel(value: string): LogLevel | undefined {
  const level = value.trim().toLowerCase();
  return isLevel(level) ? level : undefined;
}

export function createLogger(options: LogOptions = {}): Logger {
  const level = options.level ?? 'silent';
  if (level === 'silent') return pino({ level: 'silent' });
  const onTerminal = !options.file && process.stderr.isTTY === true;
  const format = options.format ?? (onTerminal ? 'pretty' : 'json');
  // Synchronous writes: a command line exits right after its last line.
  const stream =
    format !== 'json'
      ? PinoPretty({
          destination: options.file ?? 2,
          sync: true,
          mkdir: true,
          colorize: onTerminal && !process.env.NO_COLOR,
          translateTime: 'SYS:HH:MM:ss.l',
          // Expanded lists each detail on its own line, so the ones the message
          // already states are left out there.
          ignore: format === 'expanded' ? 'pid,hostname,method,path,ms,httpStatus' : 'pid,hostname',
          singleLine: format === 'pretty',
        })
      : pino.destination({ dest: options.file ?? 2, sync: true, mkdir: true });
  return pino({ level, base: undefined }, stream);
}

const SECRET_KEY = /token|session|password|passwd|secret|authorization|cookie|^sid$/i;
const JWT = /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}(\.[A-Za-z0-9_-]*)?/g;
const SECRET_PARAM = /([?&](?:token|t|sid|session[^=&]*)=)[^&#\s"]+/gi;
export const REDACTED = '[redacted]';

/**
 * A copy of `value` that is safe to log: values under secret-looking keys,
 * signed tokens anywhere in a string, and token parameters in links are
 * replaced. Never log an efood payload without passing it through this.
 */
export function sanitize(value: unknown, key = ''): unknown {
  if (value === null || value === undefined) return value;
  if (key && SECRET_KEY.test(key) && typeof value !== 'boolean') return REDACTED;
  if (typeof value === 'string') return value.replace(JWT, REDACTED).replace(SECRET_PARAM, `$1${REDACTED}`);
  if (Array.isArray(value)) return value.map((v) => sanitize(v));
  if (typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, sanitize(v, k)]));
  }
  return value;
}

/** `sanitize`, then cut to a size worth reading: big payloads become a clipped JSON string. */
export function loggable(value: unknown, limit = 4000): unknown {
  const clean = sanitize(value);
  const json = JSON.stringify(clean);
  if (json === undefined || json.length <= limit) return clean;
  return `${json.slice(0, limit)}… (${json.length} characters)`;
}
