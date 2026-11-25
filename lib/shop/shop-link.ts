// ---------------------------------------------------------------------------
// A link to the shop the visitor pastes into the chat, read into what the
// product tools take. Pure, pinned by lib/shop/shop-link.test.ts.
//
// Learned on a live chat: told "I just went to /shop/categories/computer-task-
// chairs?sort=price-asc&colour=green and there's loads of green chairs", the
// assistant said it could not check that link. It can: a category page is a
// category, its filters are words to search for and its sort is the order, and
// a product page is a product with its options in the address.
// ---------------------------------------------------------------------------

export type ShopLink =
  | { kind: 'category'; category: string; words: string[]; sort: 'price' | 'relevance' }
  | { kind: 'product'; slug: string; options: string }
  | { kind: 'other' }

/** Query keys that are about the page, never about the products. */
const PAGE_KEYS = new Set(['page', 'sort', 'order', 'view', 'per', 'limit', 'ref', 'gclid', 'fbclid', 'msclkid', 'delivery-service', 'delivery'])

function isPageKey(key: string): boolean {
  return PAGE_KEYS.has(key) || key.startsWith('utm_') || key.startsWith('utm-')
}

/** A slug as words: "myrrh-green" is "myrrh green". */
function slugWords(value: string): string {
  return value.replace(/[-_+]+/g, ' ').trim()
}

/** The words a link's filters stand for. A price band or any other bare number
 *  range ("0-200") says nothing a word search can use, so it is skipped. */
function filterWords(params: URLSearchParams): string[] {
  const words: string[] = []
  for (const [key, raw] of params) {
    if (isPageKey(key.toLowerCase())) continue
    for (const value of raw.split(',')) {
      const trimmed = value.trim()
      if (!trimmed || /^[\d.\s_-]+$/.test(trimmed)) continue
      words.push(slugWords(trimmed.toLowerCase()))
    }
  }
  return [...new Set(words)]
}

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment)
  } catch {
    return segment
  }
}

/** Whether text looks like a link rather than an id: a full address or a
 *  site-relative path. */
export function looksLikeLink(value: string): boolean {
  return /^(?:https?:\/\/|www\.|\/)/i.test(value.trim())
}

/** What a shop link means, or 'other' for anything that is not one (another
 *  site's, or a page that is neither a category nor a product). `siteHost`,
 *  when known, is this site's host: a link to anywhere else is 'other'. */
export function readShopLink(link: string, siteHost: string | null = null): ShopLink {
  const trimmed = link.trim()
  if (!/^(?:https?:\/\/|\/)/i.test(trimmed)) return { kind: 'other' }
  let url: URL
  try {
    url = new URL(trimmed, 'https://shop.invalid')
  } catch {
    return { kind: 'other' }
  }
  const host = url.hostname.replace(/^www\./, '').toLowerCase()
  const own = siteHost ? siteHost.replace(/^www\./, '').toLowerCase() : null
  if (host !== 'shop.invalid' && own && host !== own) return { kind: 'other' }
  const segments = url.pathname.split('/').map(decodeSegment).filter(Boolean)
  if (segments.length === 0) return { kind: 'other' }

  const at = segments.indexOf('categories')
  if (at >= 0 && segments[0] === 'shop') {
    const category = segments[segments.length - 1]
    if (!category || category === 'categories') return { kind: 'other' }
    const sort = url.searchParams.get('sort') ?? ''
    return {
      kind: 'category',
      category,
      words: filterWords(url.searchParams),
      sort: /price[-_ ]?(asc|low)|cheap/i.test(sort) ? 'price' : 'relevance',
    }
  }
  // Anything else under /shop is the basket, checkout, an account page.
  if (segments[0] === 'shop' && segments.length !== 2) return { kind: 'other' }
  if (segments[0] === 'shop' && segments[1] && ['cart', 'basket', 'checkout', 'account', 'orders', 'search', 'collections', 'tags'].includes(segments[1])) {
    return { kind: 'other' }
  }
  if (segments.length > 2) return { kind: 'other' }
  const slug = segments[segments.length - 1] ?? ''
  return { kind: 'product', slug, options: filterWords(url.searchParams).join(' ') }
}
