/**
 * Thin wrappers around individual efood endpoints. One function per call, no logic.
 *
 * Confidence, as of 2026-11:
 *  - shop list, shop info, catalogue, product (v3): verified live, no login needed.
 *    The older v1 shop/menu endpoints stopped answering anonymous calls.
 *  - account, addresses, history, validate, saved cart: used by 2026 clients.
 *  - saved cards, status: verified live with a real session.
 *  - submit: from the 2019-2021 SDK (kpapadatos/efoodgr), unproven since.
 */
import type { EfoodClient } from './client.js';
import type { OrderPayload, Raw } from './types.js';

/** The website's own backend. It accepts the same `x-core-session-id` header. */
export const WEB_BASE_URL = 'https://www.e-food.gr';
const WEB_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
};

/** Auth: the logged-in user's account. Doubles as the session check. */
export function getAccount(client: EfoodClient): Promise<Raw> {
  return client.request<Raw>('GET', '/api/v1/user/account', { auth: true });
}

/** Auth: saved delivery addresses. */
export function getAddresses(client: EfoodClient): Promise<unknown> {
  return client.request<unknown>('GET', '/api/v1/user/clients/address', { auth: true });
}

/** Auth: one page of past orders, most recent first. */
export function getOrderHistory(client: EfoodClient, limit: number, offset: number): Promise<unknown> {
  return client.request<unknown>('GET', '/api/v1/user/orders/history', {
    auth: true,
    query: { limit, offset, mode: 'extended' },
  });
}

/**
 * Shops that deliver to a coordinate. Works anonymously; with a session the
 * per-user `is_favorite` flag is filled in and `filters` can select favourites.
 */
export function listRestaurants(
  client: EfoodClient,
  latitude: number,
  longitude: number,
  filters: Record<string, unknown> = {},
): Promise<Raw> {
  return client.request<Raw>('GET', '/api/v1/restaurants/', {
    auth: 'optional',
    query: { filters: JSON.stringify(filters), latitude, longitude, mode: 'filter', version: 3 },
  });
}

/**
 * Public: shop details. With coordinates, `meta` also says whether the shop
 * serves that spot and at what minimum order and delivery cost.
 */
export function getShopInfo(
  client: EfoodClient,
  shopId: number,
  coords?: { latitude: number; longitude: number },
): Promise<Raw> {
  return client.request<Raw>('GET', '/v3/shops/info', {
    query: { shop_id: shopId, latitude: coords?.latitude, longitude: coords?.longitude },
  });
}

/** Public: the menu of one shop. */
export function getShopCatalog(client: EfoodClient, shopId: number): Promise<Raw> {
  return client.request<Raw>('GET', '/v3/shops/catalog', { query: { shop_id: shopId } });
}

/** Public: one menu item with its option groups ("tiers"). */
export function getProduct(client: EfoodClient, shopId: number, itemCode: string): Promise<Raw> {
  return client.request<Raw>('GET', '/v3/shops/catalog/product', {
    query: { shop_id: shopId, item_code: itemCode },
  });
}

/**
 * Auth: saved cards. Each card's `id` is a signed token that is reissued on
 * every call and expires after two hours; it is what an order pays with.
 * `hashcode` is the stable identifier of the card.
 */
export function getCards(client: EfoodClient): Promise<unknown> {
  return client.request<unknown>('GET', '/api/v1/ext/piraeus/methods/', { auth: true });
}

/** Auth: read the cart efood has saved for one shop. Note the body key: `shopId`. */
export function getServerCart(client: EfoodClient, shopId: number): Promise<Raw> {
  return client.request<Raw>('POST', '/api/carts/retrieve', {
    auth: true,
    baseUrl: WEB_BASE_URL,
    headers: WEB_HEADERS,
    body: { shopId },
  });
}

/** Auth: delete the saved cart for one shop. Note the body key: `shop_id`. */
export function deleteServerCart(client: EfoodClient, shopId: number): Promise<Raw> {
  return client.request<Raw>('POST', '/api/carts/delete', {
    auth: true,
    baseUrl: WEB_BASE_URL,
    headers: WEB_HEADERS,
    body: { shop_id: shopId },
  });
}

/**
 * Auth: validate an order without placing it. Side effect: the products sent
 * replace the saved cart for that shop. `address_id: 0` is accepted.
 */
export function validateOrder(client: EfoodClient, order: OrderPayload): Promise<Raw> {
  return client.request<Raw>('POST', '/api/v1/order/validate/', { auth: true, body: order });
}

/** Auth: place an order. This is a real purchase. */
export function submitOrder(client: EfoodClient, order: OrderPayload): Promise<Raw> {
  return client.request<Raw>('POST', '/api/v1/order/submit/', { auth: true, body: order });
}

/** Auth: status of a placed order. */
export function getOrderStatus(client: EfoodClient, orderId: string | number): Promise<Raw> {
  return client.request<Raw>('GET', `/api/v1/order/status/${orderId}/`, { auth: true });
}
