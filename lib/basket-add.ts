import { z } from 'zod'

// The client half of "Add to basket" carrying a chosen delivery service
// (components/chat/ProductButtons.tsx). Kept free of anything server-side.
//
// A product card names its chosen service as `delivery.key` (Live Chat 0.1.29
// onwards). Treated as optional at runtime: an older Live Chat sends a delivery
// with no key, and then the product is added exactly as before, without the
// service. Every failure (no key, a refusal, a network fault, a slow answer,
// an odd reply) ends the same way: add without the service, never block the add.

const SERVICE_KEY = /^[A-Za-z0-9][A-Za-z0-9_-]{0,59}$/
const ENDPOINT = '/api/m/ai-agent-for-live-chat/public/basket-line'
const TIMEOUT_MS = 5000

export type BasketMeta = Record<string, string>

const Reply = z.object({ meta: z.record(z.string().min(1).max(100), z.string().max(100)).nullable() })

/** The chosen service's key on a card, or null. Read defensively: the card's
 *  shape crosses a module seam and an older Live Chat has no key. Pure. */
export function serviceKeyOf(product: { delivery?: unknown }): string | null {
  const delivery = product.delivery
  if (!delivery || typeof delivery !== 'object') return null
  const key = (delivery as { key?: unknown }).key
  return typeof key === 'string' && SERVICE_KEY.test(key) ? key : null
}

/** The meta out of the route's reply, or null for anything else. Pure. */
export function metaFromReply(body: unknown): BasketMeta | null {
  const parsed = Reply.safeParse(body)
  if (!parsed.success || !parsed.data.meta) return null
  return Object.keys(parsed.data.meta).length > 0 ? parsed.data.meta : null
}

/** The options to hand the shop's addToCart: the meta where there is one,
 *  nothing otherwise (a plain add, exactly as before). Pure. */
export function addToCartOptions(meta: BasketMeta | null): { meta: BasketMeta } | undefined {
  return meta ? { meta } : undefined
}

type Fetcher = (input: string, init?: { signal?: AbortSignal; cache?: RequestCache; credentials?: RequestCredentials }) => Promise<{ ok: boolean; json: () => Promise<unknown> }>

/** The basket meta for this product with its chosen service, or null. Asks the
 *  route once; never throws. */
export async function basketMetaFor(productId: string, product: { delivery?: unknown }, fetcher: Fetcher = fetch): Promise<BasketMeta | null> {
  const service = serviceKeyOf(product)
  if (!service) return null
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  try {
    const query = new URLSearchParams({ product: productId, service })
    const response = await fetcher(`${ENDPOINT}?${query.toString()}`, { signal: controller.signal, cache: 'no-store', credentials: 'omit' })
    if (!response.ok) return null
    return metaFromReply(await response.json())
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}
