// ---------------------------------------------------------------------------
// The free checks for a chat that is not genuine, run before any money is
// spent on the model. Pure: the visitor's messages in, a reason or null out.
//
// Four signs, each one enough on its own (the owner's rule):
//   - the same message three or more times in a row, within a minute
//   - keyboard-mashing or gibberish
//   - four or more links in one message
//   - a message arriving faster than a person could type it
//
// Each check is tuned to miss rather than misfire. A real customer pasting an
// order list, writing a product code or saying "yes" three times in a long
// chat must never be mistaken for spam: the cost of a false alarm is a real
// customer being asked for their email instead of helped, and the model's own
// flag_not_genuine tool catches the cleverer cases anyway.
// ---------------------------------------------------------------------------

export type VisitorLine = { id: number; body: string; createdAt: Date }

export type NotGenuineReason = 'repeated' | 'gibberish' | 'links' | 'too_fast'

/** Plain words for the tool log and the settings screen. */
export const REASON_WORDS: Record<NotGenuineReason, string> = {
  repeated: 'Sent the same message three or more times in a row',
  gibberish: 'Keyboard-mashing or gibberish',
  links: 'Four or more links in one message',
  too_fast: 'Messages arriving faster than anybody could type them',
}

export const REPEAT_LIMIT = 3
/** Repeats count only as a run, one straight after another, inside this long. */
export const REPEAT_SPAN_MS = 60_000
export const LINK_LIMIT = 4
/** A message at least this long... */
export const FAST_MIN_CHARS = 150
/** ...arriving sooner than this after their previous message is faster than
 *  anybody types (75+ characters a second). */
export const FAST_MAX_MS = 2_000

function normalise(body: string): string {
  return body.toLowerCase().replace(/\s+/g, ' ').replace(/[.!?,]+$/g, '').trim()
}

/**
 * The same thing three or more times in a row, nothing else between, all
 * inside a minute: what flooding looks like. Short everyday replies ("ok",
 * "yes", "no") never count.
 *
 * Learned on a live chat: a visitor asking about the boss and then the dog
 * wrote "tell me more" three times, each answered, with other questions in
 * between, and was treated as a time-waster. Counting any three among the
 * latest six could not tell that from a flood; a run inside a minute can.
 */
export function isRepeated(lines: readonly VisitorLine[]): boolean {
  const latest = lines[lines.length - 1]
  if (!latest) return false
  const wanted = normalise(latest.body)
  if (wanted.length < 4) return false
  let run = 0
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]
    if (!line || normalise(line.body) !== wanted) break
    if (latest.createdAt.getTime() - line.createdAt.getTime() > REPEAT_SPAN_MS) break
    run++
  }
  return run >= REPEAT_LIMIT
}

export function countLinks(body: string): number {
  return (body.match(/\bhttps?:\/\/|\bwww\./gi) ?? []).length
}

// Four keys along a row, either way. Runs that turn up inside real words are
// left out ("erty" in property, "trew" in strewn, "wert" in Wertheim).
const KEYBOARD_RUNS = /(?:qwer|rtyu|tyui|yuio|uiop|asdf|sdfg|dfgh|fghj|ghjk|hjkl|zxcv|xcvb|cvbn|vbnm|poiu|oiuy|iuyt|uytr|ytre|rewq|lkjh|kjhg|jhgf|hgfd|gfds|fdsa|mnbv|nbvc|bvcx|vcxz)/

/** One word of letters that nobody would type on purpose: seven consonants in
 *  a row (w and y count as vowels, as in Welsh, and "Knightsbridge" has six),
 *  seven of the same letter in a row, or a run along a keyboard row. */
export function isGibberishWord(word: string): boolean {
  const w = word.toLowerCase()
  if (!/^[a-z]+$/.test(w) || w.length < 5) return false
  if (/[bcdfghjklmnpqrstvxz]{7,}/.test(w)) return true
  if (/([a-z])\1{6,}/.test(w)) return true
  return KEYBOARD_RUNS.test(w)
}

/**
 * Keyboard-mashing: most of the message's words are gibberish. Words with
 * digits (product codes, order numbers, postcodes), addresses and email
 * addresses are left out of the count altogether.
 */
export function isGibberish(body: string): boolean {
  const words = body
    .replace(/\bhttps?:\/\/\S+|\bwww\.\S+|\S+@\S+/gi, ' ')
    .split(/[^A-Za-z0-9]+/)
    .filter((w) => w.length >= 4 && !/\d/.test(w))
  if (words.length === 0) return false
  const bad = words.filter(isGibberishWord).length
  return bad > 0 && bad * 2 >= words.length
}

/** A long message that arrived sooner after their last one than anybody could
 *  type it. The first message of a chat has nothing to measure against. */
export function isTooFast(previous: VisitorLine | undefined, latest: VisitorLine): boolean {
  if (!previous) return false
  if (latest.body.trim().length < FAST_MIN_CHARS) return false
  return latest.createdAt.getTime() - previous.createdAt.getTime() < FAST_MAX_MS
}

/**
 * Whether the visitor's newest messages show the chat is not genuine.
 * `lines` is every visitor message in the chat, oldest first; `newIds` the ones
 * not yet answered. Each new message is judged against what came before it.
 */
export function notGenuineReason(lines: readonly VisitorLine[], newIds: ReadonlySet<number>): NotGenuineReason | null {
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (!line || !newIds.has(line.id)) continue
    if (isRepeated(lines.slice(0, i + 1))) return 'repeated'
    if (countLinks(line.body) >= LINK_LIMIT) return 'links'
    if (isGibberish(line.body)) return 'gibberish'
    if (isTooFast(lines[i - 1], line)) return 'too_fast'
  }
  return null
}
