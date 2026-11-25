import { resolveCartLines } from '@/modules/shop/lib/checkout'

// Copied from the phone assistant (modules/ai-call-answering/lib/delivery-choice.ts)
// and kept in step by hand: the two modules never import each other. Adapted
// for a chat, where the choice is recorded on the chat's products rather than
// on a phone basket, and the words the model reads differ.
// ---------------------------------------------------------------------------
// The delivery service a visitor chose ("pre-assembled", "installed",
// "express"), carried onto the product card, the note, the text and the quote
// instead of left for them to pick again at checkout.
//
// Two doors, neither of them another module's code:
//
//   - The SERVICES a product is offered come from `shop.product-delivery-timing`,
//     the point Live Chat reads to draw a delivery line on a product card and the
//     unified inbox reads to print one under a product in an email. Its keys are
//     what both of them expect, so a choice is only ever one of these.
//   - A QUOTE line is asked through shop's own cart-line resolution. A module
//     that prices a per-line service (advanced shipping today) answers each line
//     with a `control`: the meta field it reads (`key`) and the services on offer
//     (`options`, value = the service's key). Writing `meta[control.key] = value`
//     is exactly what the basket page does when a shopper picks one, so a quote
//     saved with it opens with the visitor's choice, and nothing here knows what
//     the field is called.
//
// The model names a service in its own words, taken from get_product. Matching
// those words to one service is pure (matchService) and pinned by tests.
// ---------------------------------------------------------------------------

/** One service a line or product can have: its key, and the words to match on. */
export type ServiceOption = { key: string; label: string; alsoKnownAs?: string }

export type ServiceMatch =
  | { kind: 'match'; option: ServiceOption }
  | { kind: 'ambiguous'; labels: string[] }
  | { kind: 'none'; labels: string[] }

/** Words that say nothing about WHICH service: "the installation option". */
const SERVICE_FILLER = new Set(['delivery', 'delivered', 'service', 'option', 'the', 'a', 'an', 'with', 'please', 'one', 'and'])

function words(value: string): string[] {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .filter((word) => word !== '' && !SERVICE_FILLER.has(word))
}

/** A word and its obvious relatives: "installed" and "installation" both say
 *  "install", "assembled" and "assembly" both say "assembl". */
function stem(word: string): string {
  return word.replace(/(ation|ations|ed|ing|s|y)$/, '') || word
}

function stems(value: string): Set<string> {
  return new Set(words(value).map(stem))
}

/**
 * Which one service a visitor's words name. Exact key or name first; then the
 * only service whose name holds every word given ("pre-assembled" in
 * "Pre-assembled delivery"); then the only one sharing any word. Pure.
 */
export function matchService(given: string, options: readonly ServiceOption[]): ServiceMatch {
  const labels = options.map((option) => option.label)
  const said = given.trim().toLowerCase()
  if (!said || options.length === 0) return { kind: 'none', labels }
  const exact = options.find((option) => option.key.toLowerCase() === said || option.label.toLowerCase() === said)
  if (exact) return { kind: 'match', option: exact }

  const wanted = [...stems(given)]
  if (wanted.length === 0) return { kind: 'none', labels }
  const haystack = (option: ServiceOption) => stems(`${option.label} ${option.key} ${option.alsoKnownAs ?? ''}`)
  const pick = (fits: ServiceOption[]): ServiceMatch | null => {
    if (fits.length === 1) return { kind: 'match', option: fits[0]! }
    if (fits.length > 1) return { kind: 'ambiguous', labels: fits.map((option) => option.label) }
    return null
  }
  const full = options.filter((option) => {
    const hay = haystack(option)
    return wanted.every((word) => hay.has(word))
  })
  const fullAnswer = pick(full)
  if (fullAnswer) return fullAnswer
  const some = options.filter((option) => {
    const hay = haystack(option)
    return wanted.some((word) => hay.has(word))
  })
  return pick(some) ?? { kind: 'none', labels }
}

type CartLines = Parameters<typeof resolveCartLines>[0]

/** The per-line picker the shop offers each product, by product id: the meta
 *  field to write and the services on offer. A product with no picker is absent;
 *  so is everything if the basket cannot be worked out just now. */
export async function basketServiceMenus(
  productIds: readonly string[],
): Promise<Map<string, { field: string; options: ServiceOption[] }>> {
  const out = new Map<string, { field: string; options: ServiceOption[] }>()
  const ids = [...new Set(productIds)].filter(Boolean)
  if (ids.length === 0) return out
  try {
    const cart: CartLines = ids.map((productId) => ({ productId, quantity: 1 }))
    const [resolved, names] = await Promise.all([resolveCartLines(cart), timingMenus(ids)])
    for (const line of resolved) {
      const control = line.control
      if (!control || !control.key || !Array.isArray(control.options) || control.options.length === 0) continue
      const plain = new Map((names.get(line.product.id) ?? []).map((option) => [option.key, option.label]))
      out.set(line.product.id, {
        field: control.key,
        options: control.options.map((option) => ({
          key: option.value,
          // The plain name ("Pre-assembled") where the timing point gives one;
          // the basket's own wording carries a date and a price, which make a
          // poor thing to match a name against.
          label: plain.get(option.value) ?? option.label,
          alsoKnownAs: option.label,
        })),
      })
    }
  } catch (error) {
    console.error('[ai-agent-for-live-chat] could not read the basket delivery services:', error)
  }
  return out
}

type TimingProvider = (productIds: string[]) => Promise<Map<string, unknown>>

/** The shape of a service key, as Live Chat and the unified inbox accept one. */
export const SERVICE_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,59}$/

/** The services each product is offered, from `shop.product-delivery-timing`,
 *  by product id. Checked field by field: the shape crosses a registry seam. */
export async function timingMenus(productIds: readonly string[]): Promise<Map<string, ServiceOption[]>> {
  const out = new Map<string, ServiceOption[]>()
  const ids = [...new Set(productIds)].filter(Boolean)
  if (ids.length === 0) return out
  try {
    const { modulePublicExtensionPointComponents } = await import('@/lib/modules/extension-points.public')
    const registered: Record<string, unknown> = modulePublicExtensionPointComponents['shop.product-delivery-timing'] ?? {}
    const provider = Object.values(registered).find((entry): entry is TimingProvider => typeof entry === 'function')
    if (!provider) return out
    const answered = await provider(ids)
    if (!(answered instanceof Map)) return out
    for (const [productId, value] of answered) {
      if (typeof productId !== 'string' || typeof value !== 'object' || value === null) continue
      const list = (value as Record<string, unknown>).options
      const options = (Array.isArray(list) ? list : []).flatMap((entry: unknown): ServiceOption[] => {
        const row = entry as Record<string, unknown> | null
        const key = typeof row?.key === 'string' ? row.key.trim() : ''
        const label = typeof row?.label === 'string' ? row.label.trim() : ''
        return SERVICE_KEY_PATTERN.test(key) && label ? [{ key, label }] : []
      })
      if (options.length > 0) out.set(productId, options)
    }
  } catch (error) {
    console.error('[ai-agent-for-live-chat] could not read the delivery services:', error)
  }
  return out
}

/** What the model is told when a service could not be recorded, in words it
 *  can act on. Pure. */
export function serviceMissMessage(said: string, match: ServiceMatch | null): string {
  if (!match || (match.kind === 'none' && match.labels.length === 0)) {
    return `The shop offers no delivery choice for this product, so "${said}" could not be recorded. Nothing was recorded. Tell them the checkout shows its delivery.`
  }
  if (match.kind === 'ambiguous') return `"${said}" could mean ${match.labels.join(' or ')}. Nothing was recorded. Ask which, then call choose_delivery again with that name.`
  if (match.kind === 'match') return `Recorded ${match.option.label}.`
  return `"${said}" is not one of the delivery services the shop offers for this product (${match.labels.join(', ')}). Nothing was recorded. Check what get_product lists under delivery for it, ask which they want, then call choose_delivery again with that name.`
}
