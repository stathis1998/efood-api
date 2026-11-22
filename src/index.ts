/**
 * Public API: the `Efood` class.
 *
 *   const efood = new Efood();
 *   await efood.setSession(sid);
 *   await efood.cart(shopId).add({ item: 'Freddo Espresso', options: ['Μέτριος'] });
 *   await efood.favorites.saveFromCart('coffee', shopId);
 *   await efood.favorites.order('coffee', { dryRun: false });
 *
 * Anything that places an order is a dry run unless `dryRun: false` is passed.
 */
import { describeTiers, norm, resolveSelections, type CatalogTier } from './cart/builder.js';
import { compileOrder } from './cart/order.js';
import { DEFAULT_BASE_URL, DEFAULT_USER_AGENT, EfoodClient } from './efood/client.js';
import * as api from './efood/endpoints.js';
import { EfoodError } from './efood/errors.js';
import {
  asRecord,
  listOf,
  parseAccount,
  parseAddress,
  parseMenu,
  parsePastOrder,
  parseServerCart,
  parseShop,
  round2,
  type Account,
  type Address,
  type Cart,
  type CartLine,
  type Menu,
  type MenuItem,
  type PastOrder,
  type Raw,
  type Shop,
} from './efood/types.js';
import { defaultDataDir, Store, type Favorite, type LastOrder } from './store.js';

export { EfoodError } from './efood/errors.js';
export type { EfoodErrorCode } from './efood/errors.js';
export type * from './efood/types.js';
export type { Favorite, LastOrder } from './store.js';
export type { CatalogTier } from './cart/builder.js';

export interface EfoodOptions {
  /** Where the session, favourites and order log live. */
  dataDir?: string;
  /** Menu language: "el" (default) or "en". */
  lang?: 'el' | 'en';
  minRequestIntervalMs?: number;
  /** Injectable for tests. */
  fetch?: typeof fetch;
  now?: () => Date;
}

export interface ShopQuery {
  /** Use the coordinates of this saved address (default: the default address). */
  addressId?: number;
  latitude?: number;
  longitude?: number;
  favoritesOnly?: boolean;
  openOnly?: boolean;
  /** Case- and accent-insensitive match on the shop name. */
  query?: string;
}

export interface AddToCart {
  /** Item code (IT_...) or name. */
  item: string;
  /** Option names or codes. Required single-choice groups are filled in if omitted. */
  options?: string[];
  quantity?: number;
  comment?: string;
}

export interface ItemOptions {
  code: string;
  name: string;
  price: number;
  available: boolean;
  tiers: CatalogTier[];
}

export interface OrderOptions {
  addressId?: number;
  /** Only "cash" is implemented. */
  payment?: 'cash';
  /** Default true: validate and report, do not place the order. */
  dryRun?: boolean;
  /** Refuse if items + delivery cost exceed this. */
  maxTotal?: number;
}

export interface OrderResult {
  dryRun: boolean;
  shopId: number;
  shopName: string | undefined;
  addressId: number;
  lines: CartLine[];
  itemsTotal: number;
  deliveryCost: number;
  /** Items + delivery cost as listed by the shop; efood may add fees on top. */
  estimatedTotal: number;
  /** What efood will charge, from its own validation of the order (fees included). */
  total: number;
  /** The shop's own delivery estimate, as text. */
  eta: string | undefined;
  /** Set only when the order was really placed. */
  orderId?: string;
  /** Raw efood response: validation for a dry run, submission otherwise. */
  response: unknown;
}

export interface FavoriteOrderOptions {
  dryRun?: boolean;
  /** Overrides the limit saved with the favourite. */
  maxTotal?: number;
  /** Allow a second order of the same favourite on the same day. */
  force?: boolean;
}

function localDate(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export class Efood {
  private readonly client: EfoodClient;
  private readonly store: Store;
  private readonly now: () => Date;

  constructor(options: EfoodOptions = {}) {
    this.store = new Store(options.dataDir ?? defaultDataDir());
    this.now = options.now ?? (() => new Date());
    this.client = new EfoodClient({
      baseUrl: DEFAULT_BASE_URL,
      userAgent: DEFAULT_USER_AGENT,
      minRequestIntervalMs: options.minRequestIntervalMs ?? 350,
      acceptLanguage: options.lang === 'en' ? 'en-US,en;q=0.9' : 'el-GR,el;q=0.9',
      fetch: options.fetch,
    });
    this.client.setSessionId(this.store.state().sessionId ?? null);
  }

  // ------------------------------------------------------------ session

  hasSession(): boolean {
    return this.client.hasSession();
  }

  /** Check a session id against efood and, if it works, save it. */
  async setSession(sessionId: string): Promise<Account> {
    const sid = sessionId.trim().replace(/^["']|["']$/g, '');
    if (!sid) throw new EfoodError('bad_request', 'Empty session id.');
    const previous = this.store.state().sessionId ?? null;
    this.client.setSessionId(sid);
    try {
      const account = await this.me();
      this.store.saveState({
        ...this.store.state(),
        sessionId: sid,
        sessionSavedAt: this.now().toISOString(),
      });
      return account;
    } catch (err) {
      this.client.setSessionId(previous);
      throw err;
    }
  }

  /** The logged-in account. Throws `session_expired` when the session is dead. */
  async me(): Promise<Account> {
    return parseAccount(await api.getAccount(this.client));
  }

  // ------------------------------------------------------------ account data

  async addresses(): Promise<Address[]> {
    return listOf(await api.getAddresses(this.client), 'addresses').map(parseAddress);
  }

  /** Past orders, most recent first. */
  async orders(options: { limit?: number } = {}): Promise<PastOrder[]> {
    const limit = options.limit ?? 20;
    const out: PastOrder[] = [];
    while (out.length < limit) {
      const page = await api.getOrderHistory(this.client, Math.min(100, limit - out.length), out.length);
      const orders = listOf(page, 'orders');
      out.push(...orders.map(parsePastOrder));
      if (orders.length === 0 || asRecord(page).hasNext !== true) break;
    }
    return out.slice(0, limit);
  }

  /** A saved address by id, or the default one. */
  private async resolveAddress(addressId?: number): Promise<Address & { id: number }> {
    const addresses = await this.addresses();
    const pick =
      addressId !== undefined
        ? addresses.find((a) => a.id === addressId)
        : (addresses.find((a) => a.isDefault) ?? addresses[0]);
    if (pick?.id === undefined) {
      throw new EfoodError(
        'not_found',
        addressId !== undefined
          ? `Address ${addressId} is not on the account.`
          : 'No saved address on the account.',
      );
    }
    return pick as Address & { id: number };
  }

  // ------------------------------------------------------------ browsing

  async shops(query: ShopQuery = {}): Promise<Shop[]> {
    let { latitude, longitude } = query;
    if (latitude === undefined || longitude === undefined) {
      const address = await this.resolveAddress(query.addressId);
      if (address.latitude === undefined || address.longitude === undefined) {
        throw new EfoodError('bad_request', 'That address has no coordinates; pass latitude and longitude.');
      }
      ({ latitude, longitude } = address);
    }
    if (latitude === undefined || longitude === undefined) {
      throw new EfoodError('bad_request', 'Pass both latitude and longitude.');
    }
    const raw = await api.listRestaurants(
      this.client,
      latitude,
      longitude,
      query.favoritesOnly ? { is_favorite: true } : {},
    );
    let shops = listOf(raw, 'restaurants').map(parseShop);
    if (query.openOnly) shops = shops.filter((s) => s.isOpen !== false);
    if (query.query) {
      const q = norm(query.query);
      shops = shops.filter((s) => norm(s.name ?? '').includes(q));
    }
    return shops;
  }

  /**
   * Shop details and menu. With coordinates, the minimum order, delivery cost
   * and `isServing` are the ones that apply to that spot.
   */
  async menu(shopId: number, coords?: { latitude: number; longitude: number }): Promise<Menu> {
    const info = await api.getShopInfo(this.client, shopId, coords);
    const catalog = await api.getShopCatalog(this.client, shopId);
    return parseMenu(info, catalog, coords !== undefined);
  }

  /** Find one menu item by code or by name. */
  async findItem(shopId: number, item: string, menu?: Menu): Promise<MenuItem & { code: string }> {
    const items = (menu ?? (await this.menu(shopId))).categories.flatMap((c) => c.items);
    const withCode = (it: MenuItem) => it as MenuItem & { code: string };
    const byCode = items.find((it) => it.code === item.trim());
    if (byCode) return withCode(byCode);

    const q = norm(item);
    const unique = (list: MenuItem[]) => [...new Map(list.map((it) => [it.code, it])).values()];
    const exact = unique(items.filter((it) => norm(it.name ?? '') === q));
    const matches = exact.length ? exact : unique(items.filter((it) => norm(it.name ?? '').includes(q)));
    if (matches.length === 1 && matches[0].code) return withCode(matches[0]);
    const candidates = matches.slice(0, 15).map((it) => ({ code: it.code, name: it.name, price: it.price }));
    if (matches.length === 0) {
      throw new EfoodError('not_found', `No menu item matches "${item}" in shop ${shopId}.`);
    }
    throw new EfoodError('ambiguous', `"${item}" matches ${matches.length} menu items; use the item code.`, {
      details: { candidates },
    });
  }

  /** The option groups of one item (sizes, sugar, extras...). */
  async itemOptions(shopId: number, item: string): Promise<ItemOptions> {
    const found = await this.findItem(shopId, item);
    const raw = await api.getProduct(this.client, shopId, found.code);
    return {
      code: found.code,
      name: found.name ?? '',
      // The menu price: efood's "from" price, with the cheapest required options.
      price: found.price ?? 0,
      available: found.available && raw.is_available !== false,
      tiers: describeTiers(raw),
    };
  }

  // ------------------------------------------------------------ cart

  /**
   * The cart efood itself keeps for one shop, shared with the app and website.
   * efood has no "add line" call: every change re-sends the whole cart through
   * /order/validate, which replaces what is saved.
   */
  cart(shopId: number) {
    const get = async (): Promise<Cart> =>
      parseServerCart(await api.getServerCart(this.client, shopId), shopId);

    const put = async (lines: CartLine[]): Promise<Cart> => {
      if (lines.length === 0) {
        await api.deleteServerCart(this.client, shopId);
      } else {
        await api.validateOrder(
          this.client,
          compileOrder(shopId, lines, { addressId: 0, deliveryType: 'delivery', paymentMethod: 'cash' }),
        );
      }
      return get();
    };

    return {
      get,
      /** Build the cart line for an item without touching the saved cart. */
      preview: (add: AddToCart): Promise<CartLine> => this.buildLine(shopId, add),
      add: async (add: AddToCart): Promise<Cart> => {
        const line = await this.buildLine(shopId, add);
        return put([...(await get()).lines, line]);
      },
      /** Remove a line by its 1-based position in the cart. */
      remove: async (position: number): Promise<Cart> => {
        const { lines } = await get();
        if (!Number.isInteger(position) || position < 1 || position > lines.length) {
          throw new EfoodError('bad_request', `The cart has ${lines.length} line(s); no line ${position}.`);
        }
        return put(lines.filter((_, i) => i !== position - 1));
      },
      clear: async (): Promise<void> => {
        await api.deleteServerCart(this.client, shopId);
      },
    };
  }

  private async buildLine(shopId: number, add: AddToCart): Promise<CartLine> {
    const quantity = add.quantity ?? 1;
    if (!Number.isInteger(quantity) || quantity < 1) {
      throw new EfoodError('bad_request', 'Quantity must be a whole number, 1 or more.');
    }
    const item = await this.findItem(shopId, add.item);
    if (!item.available) {
      throw new EfoodError('out_of_stock', `"${item.name}" is out of stock.`);
    }
    const raw = await api.getProduct(this.client, shopId, item.code);
    const r = resolveSelections(raw, add.options ?? []);
    if (r.errors.length) {
      throw new EfoodError('option_not_found', `Cannot build "${item.name}": ${r.errors.join('; ')}.`, {
        details: { errors: r.errors, tiers: describeTiers(raw) },
      });
    }
    return {
      product_id: item.code,
      name: item.name ?? '',
      quantity,
      price: r.unitPrice,
      total: round2(r.unitPrice * quantity),
      comment: add.comment ?? '',
      materials: r.selected.map((o) => o.code),
      offer: null,
      description: '',
      optionNames: r.selected.map((o) => o.name),
    };
  }

  // ------------------------------------------------------------ ordering

  /** Order what is in the saved cart of a shop. Dry run unless `dryRun: false`. */
  async checkout(shopId: number, options: OrderOptions = {}): Promise<OrderResult> {
    const { lines } = await this.cart(shopId).get();
    return this.placeOrder(shopId, lines, options);
  }

  private async placeOrder(
    shopId: number,
    lines: CartLine[],
    options: OrderOptions,
    label?: string,
  ): Promise<OrderResult> {
    const dryRun = options.dryRun !== false;
    const payment = options.payment ?? 'cash';
    if (payment !== 'cash') {
      throw new EfoodError('payment_unavailable', 'Only cash on delivery is implemented.');
    }
    if (lines.length === 0) throw new EfoodError('empty_cart', 'Nothing to order: the cart is empty.');

    const address = await this.resolveAddress(options.addressId);
    const addressId = address.id;
    const coords =
      address.latitude !== undefined && address.longitude !== undefined
        ? { latitude: address.latitude, longitude: address.longitude }
        : undefined;
    const menu = await this.menu(shopId, coords);
    const shopName = menu.shop.name ?? `Shop ${shopId}`;
    if (menu.shop.isOpen === false) {
      throw new EfoodError('shop_closed', `${shopName} is closed right now.`);
    }
    if (menu.shop.isServing === false) {
      throw new EfoodError('shop_closed', `${shopName} is not delivering to this address right now.`);
    }
    if (menu.shop.hasCash === false) {
      throw new EfoodError('payment_unavailable', `${shopName} does not accept cash.`);
    }

    const items = new Map(menu.categories.flatMap((c) => c.items).map((it) => [it.code, it]));
    const missing = lines.filter((l) => items.get(l.product_id)?.available !== true);
    if (missing.length) {
      throw new EfoodError(
        'out_of_stock',
        `Not available right now: ${missing.map((l) => l.name).join(', ')}.`,
        { details: { items: missing.map((l) => ({ code: l.product_id, name: l.name })) } },
      );
    }

    const itemsTotal = round2(lines.reduce((s, l) => s + l.price * l.quantity, 0));
    const deliveryCost = menu.shop.deliveryCost ?? 0;
    const estimatedTotal = round2(itemsTotal + deliveryCost);
    if (menu.shop.minimumOrder !== undefined && itemsTotal < menu.shop.minimumOrder) {
      throw new EfoodError(
        'below_minimum',
        `Items total ${itemsTotal.toFixed(2)} is below the shop minimum of ${menu.shop.minimumOrder.toFixed(2)}.`,
      );
    }
    if (options.maxTotal !== undefined && estimatedTotal > options.maxTotal) {
      throw new EfoodError(
        'over_max_total',
        `Estimated total ${estimatedTotal.toFixed(2)} exceeds the limit of ${options.maxTotal.toFixed(2)}.`,
      );
    }

    const payload = compileOrder(shopId, lines, {
      addressId,
      deliveryType: 'delivery',
      paymentMethod: payment,
    });
    const result: Omit<OrderResult, 'response' | 'orderId' | 'total'> = {
      dryRun,
      shopId,
      shopName: menu.shop.name,
      addressId,
      lines,
      itemsTotal,
      deliveryCost,
      estimatedTotal,
      eta: menu.shop.eta,
    };

    const validation = await api.validateOrder(this.client, payload);
    // efood's own figure is the one that counts: it includes any fees.
    const total = typeof validation.price === 'number' ? validation.price : estimatedTotal;
    if (options.maxTotal !== undefined && total > options.maxTotal) {
      throw new EfoodError(
        'over_max_total',
        `efood's total ${total.toFixed(2)} exceeds the limit of ${options.maxTotal.toFixed(2)}.`,
      );
    }
    if (dryRun) return { ...result, total, response: validation };

    const submitted = await api.submitOrder(this.client, payload);
    const orderId = String(submitted.order_id ?? asRecord(submitted.order).id ?? '');
    this.store.logOrder({
      time: this.now().toISOString(),
      favorite: label,
      shopId,
      shopName: menu.shop.name,
      addressId,
      itemsTotal,
      total,
      orderId,
      response: submitted,
    });
    return { ...result, total, orderId, response: submitted };
  }

  /** Raw status of a placed order. */
  orderStatus(orderId: string | number): Promise<Raw> {
    return api.getOrderStatus(this.client, orderId);
  }

  // ------------------------------------------------------------ favourites

  /** Named order templates: a shop, an address and a fixed set of cart lines. */
  readonly favorites = {
    list: (): Favorite[] => Object.values(this.store.favorites()),

    get: (name: string): Favorite => {
      const fav = this.store.favorites()[name];
      if (!fav) throw new EfoodError('not_found', `No favourite named "${name}".`);
      return fav;
    },

    /** Save the current saved cart of a shop (built here or in the efood app). */
    saveFromCart: async (
      name: string,
      shopId: number,
      options: { addressId?: number; maxTotal?: number } = {},
    ): Promise<Favorite> => {
      if (!/^[\w-]+$/.test(name)) {
        throw new EfoodError('bad_request', 'Favourite names may use letters, digits, "-" and "_" only.');
      }
      const { lines, total } = await this.cart(shopId).get();
      if (lines.length === 0) {
        throw new EfoodError('empty_cart', `The saved cart for shop ${shopId} is empty.`);
      }
      const { shop } = await this.menu(shopId);
      const fav: Favorite = {
        name,
        shopId,
        shopName: shop.name ?? `Shop ${shopId}`,
        addressId: options.addressId,
        lines,
        // Default limit: today's price plus 20% headroom for price changes.
        maxTotal: options.maxTotal ?? round2((total + (shop.deliveryCost ?? 0)) * 1.2),
        savedAt: this.now().toISOString(),
      };
      this.store.saveFavorites({ ...this.store.favorites(), [name]: fav });
      return fav;
    },

    remove: (name: string): void => {
      const { [name]: removed, ...rest } = this.store.favorites();
      if (!removed) throw new EfoodError('not_found', `No favourite named "${name}".`);
      this.store.saveFavorites(rest);
    },

    lastOrder: (name: string): LastOrder | undefined => this.store.state().lastOrders[name],

    /** Order a favourite. Dry run unless `dryRun: false`; once per day unless `force`. */
    order: async (name: string, options: FavoriteOrderOptions = {}): Promise<OrderResult> => {
      const fav = this.favorites.get(name);
      const dryRun = options.dryRun !== false;
      const today = localDate(this.now());
      const last = this.store.state().lastOrders[name];
      if (!dryRun && !options.force && last?.date === today) {
        throw new EfoodError(
          'already_ordered_today',
          `"${name}" was already ordered today (order ${last.orderId}). Use force to order again.`,
        );
      }
      const result = await this.placeOrder(
        fav.shopId,
        fav.lines,
        { addressId: fav.addressId, dryRun, maxTotal: options.maxTotal ?? fav.maxTotal },
        name,
      );
      if (!dryRun) {
        const state = this.store.state();
        state.lastOrders[name] = { date: today, orderId: result.orderId ?? '' };
        this.store.saveState(state);
      }
      return result;
    },
  };
}
