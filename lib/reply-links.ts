// ---------------------------------------------------------------------------
// Mending a product address the model mangled while copying it. Pure, pinned
// by lib/reply-links.test.ts.
//
// Learned on a live chat: the assistant wrote
// "httpskwell.co.uk/qube-steel-office-filing-cabinet-in-25-colours", dropping
// "://des" from an address a tool had handed it, and the visitor saw a dead
// line where a product card should have been. The address it meant is never
// in doubt: the page's own path is there, whole. So before a reply goes, any
// word that is not a working web address but ends in the path (and options) of
// an address the tools returned this chat is swapped for that address. Words
// that match nothing are left exactly as written.
// ---------------------------------------------------------------------------

/** The part of an address after its host: path and query. */
function tail(address: string): string | null {
  try {
    const url = new URL(address)
    const rest = `${url.pathname}${url.search}`
    return rest.length >= 8 ? rest : null
  } catch {
    return null
  }
}

function works(word: string): boolean {
  if (!/^https?:\/\//i.test(word)) return false
  try {
    return new URL(word).hostname.includes('.')
  } catch {
    return false
  }
}

/** The reply with every mangled copy of a known address replaced by it. */
export function repairLinks(reply: string, known: readonly string[]): string {
  const tails = known
    .map((address) => ({ address, tail: tail(address) }))
    .filter((entry): entry is { address: string; tail: string } => entry.tail !== null)
    .sort((a, b) => b.tail.length - a.tail.length)
  if (tails.length === 0) return reply
  return reply.replace(/\S+/g, (token) => {
    const trailing = token.match(/[.,;:!?)]+$/)?.[0] ?? ''
    const word = trailing ? token.slice(0, -trailing.length) : token
    if (!word.includes('/') || works(word)) return token
    const hit = tails.find((entry) => word.endsWith(entry.tail))
    return hit ? `${hit.address}${trailing}` : token
  })
}
