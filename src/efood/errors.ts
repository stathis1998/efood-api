/**
 * One error type for everything this library throws. `code` is stable and meant
 * to be switched on by callers (CLI exit messages, HTTP status mapping).
 */
export type EfoodErrorCode =
  // session
  | 'no_session'
  | 'session_expired'
  // transport
  | 'blocked'
  | 'rate_limited'
  | 'network_error'
  | 'api_error'
  // lookups and input
  | 'not_found'
  | 'ambiguous'
  | 'option_not_found'
  | 'bad_request'
  // order guards
  | 'empty_cart'
  | 'shop_closed'
  | 'out_of_stock'
  | 'below_minimum'
  | 'over_max_total'
  | 'payment_unavailable'
  | 'confirmation_required'
  | 'outcome_unknown'
  | 'already_ordered_today';

export interface EfoodErrorInfo {
  /** HTTP status of the efood response, when there was one. */
  httpStatus?: number;
  /** efood's own `error_code` from the response envelope. */
  apiCode?: string;
  /** Structured extras (e.g. the available options after a failed match). */
  details?: unknown;
}

export class EfoodError extends Error {
  readonly code: EfoodErrorCode;
  readonly httpStatus?: number;
  readonly apiCode?: string;
  readonly details?: unknown;

  constructor(code: EfoodErrorCode, message: string, info: EfoodErrorInfo = {}) {
    super(message);
    this.name = 'EfoodError';
    this.code = code;
    this.httpStatus = info.httpStatus;
    this.apiCode = info.apiCode;
    this.details = info.details;
  }

  toJSON(): Record<string, unknown> {
    return {
      error: this.code,
      message: this.message,
      ...(this.apiCode ? { apiCode: this.apiCode } : {}),
      ...(this.details !== undefined ? { details: this.details } : {}),
    };
  }
}
