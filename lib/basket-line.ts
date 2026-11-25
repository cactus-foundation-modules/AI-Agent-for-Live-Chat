import { z } from 'zod'
import type { ServiceOption } from './shop/delivery-choice'

// The basket line a product card's "Add to basket" needs to carry the delivery
// service the visitor chose (app/api/public/basket-line/route.ts).
//
// The shop's basket stores a chosen service in a line's meta, under a field only
// the shop's own cart-line resolution names (basketServiceMenus). This is the
// pure half: given that menu, the meta for one product with one service, or
// null where the basket does not offer that service for it. Nothing here is
// per-visitor; it is exactly what the shop's own picker on the basket shows.

/** A shop product id: text, uuid by default, never anything that needs escaping. */
export const PRODUCT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/
/** A service key, as Live Chat and the unified inbox accept one. Restated from
 *  lib/shop/delivery-choice.ts so this file stays free of the shop's code. */
export const SERVICE_KEY = /^[A-Za-z0-9][A-Za-z0-9_-]{0,59}$/

export const BasketLineQuery = z.object({
  product: z.string().trim().regex(PRODUCT_ID_PATTERN),
  service: z.string().trim().regex(SERVICE_KEY),
}).strict()

type Menus = ReadonlyMap<string, { field: string; options: readonly ServiceOption[] }>

/** The line meta that puts `serviceKey` on `productId` in the basket, or null
 *  where the basket offers no such service for it. Pure. */
export function basketLineMeta(productId: string, serviceKey: string, menus: Menus): Record<string, string> | null {
  const menu = menus.get(productId)
  if (!menu || !menu.field) return null
  return menu.options.some((option) => option.key === serviceKey) ? { [menu.field]: serviceKey } : null
}
