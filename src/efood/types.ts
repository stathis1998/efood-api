/**
 * Types and defensive parsers for efood payloads.
 *
 * The raw responses are large and undocumented, so parsers read only the fields
 * we use and tolerate missing or renamed keys rather than failing hard.
 */

export type Raw = Record<string, unknown>;

export function asRecord(v: unknown): Raw {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Raw) : {};
}
function str(v: unknown): string | undefined {
  return typeof v === 'string' && v !== '' ? v : undefined;
}
function num(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
  return undefined;
}
function bool(v: unknown): boolean | undefined {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v !== 0;
  return undefined;
}
function arr(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

export function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/** Strip tags and the basic HTML entities that appear in efood names. */
export function cleanText(s: string): string {
  return s
    .replace(/<[^>]*>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'");
}
function text(v: unknown): string | undefined {
  const s = str(v);
  return s === undefined ? undefined : cleanText(s);
}

/**
 * Some list endpoints return a bare array, others wrap it (`{orders: [...]}`).
 * Returns the array under one of `keys`, or the value itself if it is an array.
 */
export function listOf(raw: unknown, ...keys: string[]): unknown[] {
  if (Array.isArray(raw)) return raw;
  const r = asRecord(raw);
  for (const key of keys) {
    if (Array.isArray(r[key])) return r[key] as unknown[];
  }
  return [];
}

// ---------------------------------------------------------------- account

export interface Account {
  id: number | undefined;
  email: string | undefined;
  firstName: string | undefined;
  lastName: string | undefined;
  phone: string | undefined;
}

export function parseAccount(raw: unknown): Account {
  const root = asRecord(raw);
  const u = Object.keys(asRecord(root.user)).length ? asRecord(root.user) : root;
  return {
    id: num(u.id),
    email: str(u.email),
    firstName: str(u.first_name),
    lastName: str(u.last_name),
    phone: str(u.cellphone),
  };
}

// ---------------------------------------------------------------- addresses

export interface Address {
  id: number | undefined;
  /** The user's own name for it ("Home"), when set. */
  label: string | undefined;
  street: string | undefined;
  latitude: number | undefined;
  longitude: number | undefined;
  isDefault: boolean;
}

export function parseAddress(raw: unknown): Address {
  const a = asRecord(raw);
  const street = [str(a.street) ?? str(a.address), str(a.street_number) ?? str(a.number)]
    .filter(Boolean)
    .join(' ');
  const area = str(a.area) ?? str(a.city) ?? str(a.zip);
  return {
    id: num(a.id),
    label: str(a.description) ?? str(a.label) ?? str(a.title),
    street: [street, area].filter(Boolean).join(', ') || undefined,
    latitude: num(a.latitude),
    longitude: num(a.longitude),
    isDefault: bool(a.is_default) === true,
  };
}

// ---------------------------------------------------------------- shops

export interface Shop {
  id: number | undefined;
  name: string | undefined;
  cuisine: string | undefined;
  rating: number | undefined;
  deliveryCost: number | undefined;
  etaMinutes: number | undefined;
  minimumOrder: number | undefined;
  isOpen: boolean | undefined;
  isFavorite: boolean | undefined;
  hasCash: boolean | undefined;
  slug: string | undefined;
}

export function parseShop(raw: unknown): Shop {
  const r = asRecord(raw);
  return {
    id: num(r.id),
    name: text(r.title),
    cuisine: str(r.basic_cuisine),
    rating: num(r.average_rating),
    deliveryCost: num(r.delivery_cost),
    etaMinutes: num(r.delivery_eta),
    minimumOrder: num(r.minimum_order),
    isOpen: bool(r.is_open),
    isFavorite: bool(r.is_favorite),
    hasCash: bool(r.has_cash_on_delivery),
    slug: str(r.slug),
  };
}

// ---------------------------------------------------------------- menu

export interface MenuItem {
  code: string | undefined;
  name: string | undefined;
  price: number | undefined;
  description: string | undefined;
  hasOptions: boolean;
  /** False when out of stock; such items fail order validation. */
  available: boolean;
}

export function parseMenuItem(raw: unknown): MenuItem {
  const it = asRecord(raw);
  const outOfStock =
    bool(it.shortage) === true || it.is_available === false || it.is_serving === false;
  return {
    code: str(it.code),
    name: text(it.name),
    price: num(it.price),
    description: text(it.description),
    hasOptions:
      bool(it.has_options) === true ||
      bool(it.has_variations) === true ||
      arr(it.option_codes).length > 0 ||
      arr(it.personalized_options).length > 0,
    available: !outOfStock,
  };
}

export interface MenuCategory {
  code: string | undefined;
  name: string | undefined;
  items: MenuItem[];
}

export interface Menu {
  shop: {
    id: number | undefined;
    name: string | undefined;
    isOpen: boolean | undefined;
    /** Open and delivering to the coordinates asked about; undefined without coordinates. */
    isServing: boolean | undefined;
    minimumOrder: number | undefined;
    deliveryCost: number | undefined;
    /** efood's own estimate, as text (e.g. "30' - 35'"). */
    eta: string | undefined;
    hasCash: boolean | undefined;
  };
  categories: MenuCategory[];
}

/** Combine `/v3/shops/info` and `/v3/shops/catalog`. */
export function parseMenu(infoRaw: unknown, catalogRaw: unknown, hasCoords: boolean): Menu {
  const info = asRecord(infoRaw);
  const shop = asRecord(info.shop);
  const meta = asRecord(info.meta);
  return {
    shop: {
      id: num(shop.id),
      name: text(shop.title),
      isOpen: bool(meta.is_open),
      isServing: hasCoords ? bool(meta.is_serving) : undefined,
      minimumOrder: num(meta.minimum_order_value),
      deliveryCost: num(asRecord(meta.delivery_cost).amount),
      eta: str(asRecord(shop.messages).delivery_information),
      hasCash: bool(asRecord(shop.payment_methods).cash),
    },
    categories: arr(asRecord(asRecord(catalogRaw).menu).categories).map((c) => {
      const cat = asRecord(c);
      return { code: str(cat.category_slug), name: text(cat.name), items: arr(cat.items).map(parseMenuItem) };
    }),
  };
}

// ---------------------------------------------------------------- history

export interface PastOrderItem {
  code: string | undefined;
  name: string | undefined;
  quantity: number | undefined;
  unitPrice: number | undefined;
  /** Free-text description of the chosen options, as efood shows it. */
  customisation: string | undefined;
}

export interface PastOrder {
  id: number | undefined;
  shopId: number | undefined;
  shopName: string | undefined;
  date: string | undefined;
  total: number | undefined;
  status: string | undefined;
  payment: string | undefined;
  items: PastOrderItem[];
}

export function parsePastOrder(raw: unknown): PastOrder {
  const o = asRecord(raw);
  const shop = asRecord(o.restaurant);
  return {
    id: num(o.id),
    shopId: num(shop.id),
    shopName: text(shop.name),
    date: str(o.submission_date),
    total: num(o.price),
    status: str(o.status),
    payment: str(o.payment_description) ?? str(o.payment_type),
    items: arr(o.products).map((p) => {
      const pr = asRecord(p);
      return {
        code: str(pr.item_code),
        name: text(pr.name),
        quantity: num(pr.quantity),
        unitPrice: num(pr.unit_price),
        customisation: text(pr.customisation),
      };
    }),
  };
}

// ---------------------------------------------------------------- cart and order

/** One line of a cart, in the exact shape the order endpoints expect. */
export interface CartProduct {
  product_id: string;
  name: string;
  quantity: number;
  /** Unit price including the chosen options. */
  price: number;
  total: number;
  comment: string;
  /** Codes of the chosen options. */
  materials: string[];
  offer: number | null;
  description: string;
}

/** A cart line plus the option names, for display and for saved favourites. */
export interface CartLine extends CartProduct {
  optionNames: string[];
}

export interface Cart {
  shopId: number;
  lines: CartLine[];
  total: number;
}

/** Parse the saved-cart response (`/api/carts/retrieve`) for one shop. */
export function parseServerCart(raw: unknown, shopId: number): Cart {
  const root = asRecord(raw);
  const carts = arr(root.carts ?? asRecord(root.data).carts);
  const lines: CartLine[] = [];
  for (const rawItem of arr(asRecord(carts[0]).items)) {
    const it = asRecord(rawItem);
    if (it.type !== 'product') continue;
    const attrs = asRecord(it.attributes);
    const data = asRecord(it.data);
    const quantity = num(asRecord(attrs.quantity).current) || 1;
    const price = num(attrs.unit_price) ?? 0;
    const materials = arr(data.materials_names).map(asRecord);
    lines.push({
      product_id: String(data.product_id ?? ''),
      name: text(data.name) ?? '',
      quantity,
      price,
      total: round2(price * quantity),
      comment: str(attrs.comment) ?? '',
      materials: materials.map((m) => String(m.code ?? '')).filter(Boolean),
      offer: null,
      description: '',
      optionNames: materials.map((m) => text(m.name) ?? '').filter(Boolean),
    });
  }
  return { shopId, lines, total: round2(lines.reduce((s, l) => s + l.total, 0)) };
}

/** The payload sent to /order/validate and /order/submit. */
export interface OrderPayload {
  restaurant_id: number;
  address_id: number;
  amount: number;
  delivery_type: string;
  payment_method: string;
  payment_token?: string;
  products: CartProduct[];
  coupons: unknown[];
  discount: unknown[];
  created: string;
}
