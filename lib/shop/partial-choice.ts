// ---------------------------------------------------------------------------
// The options a visitor actually chose, when their words leave more than one
// variation. Pure, pinned by lib/shop/partial-choice.test.ts.
//
// Learned on a live chat: asked for "your cheapest yellow office chair", the
// assistant linked the cheapest yellow variation, so the card, the email and
// the text all arrived with seat adjustment, arms and back colour chosen too -
// "I only wanted the yellow colour selected". And a desk asked for as "120cm,
// no mod panel, black frame" came with cable ports and a depth picked.
//
// So where several variations fit, only the options every one of them shares
// are chosen: those are the ones the visitor's words settled. The link carries
// just those (`?upholstery-colour=senna-yellow`), which the storefront, Live
// Chat's card and the Unified Inbox all open with the rest left to choose, and
// the inbox is handed the same choice as `picks` (its ProductRef format,
// `option-key.value-slug` joined with "+", sorted).
// ---------------------------------------------------------------------------

/** One option of one variation: [option name, value slug, value label]. */
export type OptionPick = readonly [name: string, slug: string, label: string]

/** An option's query key, as the storefront and the variations module spell
 *  it. Restated here (and in product-links.ts) so this file stays pure. */
function paramKey(name: string): string {
  return name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

/**
 * The options every fitting variation shares, in the shop's order. An option
 * the listing sells in only one value is left out: nobody chose it, and the
 * page has nothing else to pick. `all` is every switched-on variation of the
 * listing; `fits` the ones the visitor's words fit.
 */
export function settledOptions(all: ReadonlyArray<readonly OptionPick[]>, fits: ReadonlyArray<readonly OptionPick[]>): OptionPick[] {
  const first = fits[0]
  if (!first) return []
  const valuesOf = new Map<string, Set<string>>()
  for (const picks of all) {
    for (const [name, slug] of picks) {
      const values = valuesOf.get(name) ?? new Set<string>()
      values.add(slug)
      valuesOf.set(name, values)
    }
  }
  return first.filter(([name, slug]) =>
    (valuesOf.get(name)?.size ?? 0) > 1
    && fits.every((picks) => picks.some(([otherName, otherSlug]) => otherName === name && otherSlug === slug)))
}

const SAFE = /^[a-z0-9-]+$/

/** The Unified Inbox's spelling of a partial choice, or null for none. */
export function picksRef(settled: readonly OptionPick[]): string | null {
  const parts = settled
    .map(([name, slug]) => [paramKey(name), slug] as const)
    .filter(([key, slug]) => SAFE.test(key) && SAFE.test(slug))
    .map(([key, slug]) => `${key}.${slug}`)
    .sort()
  return parts.length > 0 ? parts.join('+') : null
}

/** A stored picks string, or null for anything that is not one. */
export function parsePicksRef(value: unknown): string | null {
  if (typeof value !== 'string') return null
  return /^[a-z0-9-]+\.[a-z0-9-]+(?:\+[a-z0-9-]+\.[a-z0-9-]+)*$/.test(value) ? value : null
}
