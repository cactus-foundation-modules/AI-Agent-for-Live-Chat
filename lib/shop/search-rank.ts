// ---------------------------------------------------------------------------
// Ranking the shop's products against the words searched for. Pure, pinned by
// lib/shop/search-rank.test.ts; the text it ranks is read and cached by
// lib/shop/product-queries.ts (loadSearchIndex).
//
// Every product carries its words in five places, weighted by how much a hit
// there says the product IS the thing asked for: its name (4), its variations'
// option values and the attribute values on it and them, such as a colour (3),
// its category (2), and its blurb and description (1). A product must carry
// every word somewhere. When none does, the products carrying the most words
// are offered instead, as long as that is at least half of them, and marked
// loosened - never the old "any one word will do", which answered "height
// adjustable desk black wooden edge" with screen clamps.
//
// For "the cheapest", only the products where the words that mean something
// land in the name, the variations or the category go forward to be priced:
// a filing frame that mentions cabinets in its description is not the
// cheapest filing cabinet. A word half the catalogue carries ("office" in an
// office furniture shop) means nothing here and is not counted. Where no
// product has every such word in those places, the ones with the most do.
// ---------------------------------------------------------------------------

export type IndexedProduct = {
  id: string
  /** Each field lower case. */
  name: string
  variants: string
  category: string
  body: string
  /** The product's categories: its own and every one it is filed under. */
  categoryIds: readonly string[]
  popularity: number
}

export type RankOptions = {
  /** Only products in one of these categories, when given. */
  categoryIds: ReadonlySet<string> | null
  /** 'price': keep only the strong matches, for pricing afterwards. */
  sort: 'relevance' | 'price'
  limit: number
}

export type Ranked = { ids: string[]; loosened: boolean }

/** A word carried by more than this share of the catalogue says nothing about
 *  which product is meant. */
const COMMON_SHARE = 0.5

const WEIGHTS = [
  ['name', 4],
  ['variants', 3],
  ['category', 2],
  ['body', 1],
] as const

/** What one word, under any of its spellings, scores against a product: the
 *  weight of the best place it appears, 0 for nowhere. */
function wordScore(product: IndexedProduct, variants: readonly string[]): number {
  for (const [field, weight] of WEIGHTS) {
    if (variants.some((variant) => product[field].includes(variant))) return weight
  }
  return 0
}

/** The products the words find, best first. `words` is each word with its
 *  spellings, as expandSearchWords gives. With no words every product in the
 *  category qualifies, most popular first. */
export function rankProducts(index: readonly IndexedProduct[], words: readonly (readonly string[])[], options: RankOptions): Ranked {
  const pool = options.categoryIds
    ? index.filter((product) => product.categoryIds.some((id) => options.categoryIds?.has(id)))
    : index
  const common = words.map((variants) => index.length > 0 && index.filter((product) => wordScore(product, variants) > 0).length / index.length > COMMON_SHARE)
  const scored = pool.map((product) => {
    const scores = words.map((variants) => wordScore(product, variants))
    return {
      product,
      matched: scores.filter((score) => score > 0).length,
      score: scores.reduce((sum, score) => sum + score, 0),
      // Meaningful words found in the name, the variations or the category.
      strong: scores.filter((score, at) => score >= 2 && !common[at]).length,
    }
  })
  const best = scored.reduce((most, entry) => Math.max(most, entry.matched), 0)
  let loosened = false
  let kept = scored.filter((entry) => entry.matched === words.length)
  if (kept.length === 0 && words.length > 1 && best >= Math.ceil(words.length / 2)) {
    kept = scored.filter((entry) => entry.matched === best)
    loosened = true
  }
  if (options.sort === 'price' && kept.length > 0) {
    const most = Math.max(...kept.map((entry) => entry.strong))
    kept = kept.filter((entry) => entry.strong === most)
  }
  kept.sort((a, b) => b.score - a.score || b.product.popularity - a.product.popularity || a.product.name.localeCompare(b.product.name))
  return { ids: kept.slice(0, options.limit).map((entry) => entry.product.id), loosened }
}
