/**
 * Everything this tool keeps on disk, in one data directory:
 *   state.json      session id and the last order placed per favourite
 *   favorites.json  named order templates
 *   orders.log      one JSON line per submitted order
 * The session id is a login secret: it is never written anywhere else.
 */
import { appendFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CartLine } from './efood/types.js';

export interface LastOrder {
  /** Local calendar date, YYYY-MM-DD. */
  date: string;
  orderId: string;
}

export interface State {
  sessionId?: string;
  sessionSavedAt?: string;
  lastOrders: Record<string, LastOrder>;
}

export interface Favorite {
  name: string;
  shopId: number;
  shopName: string;
  /** Delivery address; when unset the account's default address is used. */
  addressId?: number;
  /** How to pay; cash when unset. */
  payment?: 'cash' | 'card';
  /** For card payment: the stable key of the card. */
  cardKey?: string;
  /** Last four digits of that card, for display. */
  cardLast4?: string;
  lines: CartLine[];
  /** Upper bound for items + delivery; an order above it is refused. */
  maxTotal: number;
  savedAt: string;
}

/** `EFOOD_DATA_DIR`, or `data/` at the package root. */
export function defaultDataDir(): string {
  return process.env.EFOOD_DATA_DIR?.trim() || fileURLToPath(new URL('../../data', import.meta.url));
}

export class Store {
  constructor(readonly dir: string) {}

  private read<T>(file: string, fallback: T): T {
    try {
      return JSON.parse(readFileSync(join(this.dir, file), 'utf8')) as T;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return fallback;
      throw err;
    }
  }

  private write(file: string, value: unknown): void {
    mkdirSync(this.dir, { recursive: true });
    const path = join(this.dir, file);
    writeFileSync(`${path}.tmp`, JSON.stringify(value, null, 2), { mode: 0o600 });
    renameSync(`${path}.tmp`, path);
  }

  state(): State {
    return { lastOrders: {}, ...this.read<Partial<State>>('state.json', {}) };
  }

  saveState(state: State): void {
    this.write('state.json', state);
  }

  favorites(): Record<string, Favorite> {
    return this.read<Record<string, Favorite>>('favorites.json', {});
  }

  saveFavorites(favorites: Record<string, Favorite>): void {
    this.write('favorites.json', favorites);
  }

  logOrder(entry: Record<string, unknown>): void {
    mkdirSync(this.dir, { recursive: true });
    appendFileSync(join(this.dir, 'orders.log'), `${JSON.stringify(entry)}\n`);
  }
}
