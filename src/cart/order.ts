/**
 * Builds the order payload shared by /order/validate and /order/submit.
 */
import { round2, type CartProduct, type OrderPayload } from '../efood/types.js';

export interface CompileOptions {
  addressId: number;
  deliveryType: 'delivery' | 'pickup';
  paymentMethod: string;
}

export function compileOrder(
  shopId: number,
  lines: CartProduct[],
  opts: CompileOptions,
): OrderPayload {
  // Copy field by field so display-only extras (optionNames) are not sent.
  const products: CartProduct[] = lines.map((l) => ({
    product_id: l.product_id,
    name: l.name,
    quantity: l.quantity,
    price: l.price,
    total: round2(l.price * l.quantity),
    comment: l.comment,
    materials: [...l.materials],
    offer: l.offer,
    description: l.description,
  }));
  return {
    restaurant_id: shopId,
    address_id: opts.addressId,
    amount: round2(products.reduce((s, p) => s + p.total, 0)),
    delivery_type: opts.deliveryType,
    payment_method: opts.paymentMethod,
    products,
    coupons: [],
    discount: [],
    created: '',
  };
}
