// ---------------------------------------------------------------------------
// Sizes the model chose for a visitor, taken back out. Pure, pinned by
// lib/shop/said-sizes.test.ts.
//
// Learned on a live chat: asked for "a cheap blue desk with a black frame",
// the assistant looked the desk up as "120cm / 80cm / Dark Teal / Black", a
// width and depth nobody had mentioned, and the emailed link arrived with
// 120cm picked. Words can be mapped onto the shop's names ("no mod panel");
// a number cannot be guessed. So a figure in the options the model passes
// counts only if the visitor wrote it, allowing for cm, mm and metres
// ("1.2m" and "1200mm" are 120cm). Anything else is set aside and the model
// told, so it asks instead.
// ---------------------------------------------------------------------------

/** Every size the visitor wrote, as plain numbers in every unit it could be. */
const WORD_NUMBERS: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, single: 1, double: 2, twin: 2 }

function saidNumbers(visitorText: string): Set<string> {
  const out = new Set<string>()
  for (const word of visitorText.toLowerCase().split(/[^a-z]+/)) {
    const value = WORD_NUMBERS[word]
    if (value !== undefined) out.add(String(value))
  }
  for (const match of visitorText.toLowerCase().matchAll(/(\d+(?:\.\d+)?)\s*(mm|cm|m\b|metres?|meters?)?/g)) {
    const value = Number(match[1])
    if (!Number.isFinite(value)) continue
    const unit = match[2] ?? ''
    const add = (n: number) => { if (Number.isInteger(n)) out.add(String(n)) }
    add(value)
    if (unit === 'mm') add(value / 10)
    if (unit.startsWith('m') && unit !== 'mm') add(Math.round(value * 100))
    if (!unit) { add(value * 10); add(value / 10); add(Math.round(value * 100)) }
  }
  return out
}

/** The options with every figure the visitor never wrote taken out, and the
 *  words taken out. Words without figures are left alone. */
export function keepSaidSizes(options: string, visitorText: string): { options: string; setAside: string[] } {
  const said = saidNumbers(visitorText)
  const setAside: string[] = []
  const kept = options.replace(/\b\d+(?:\.\d+)?\s*(?:mm|cm|m)?\b/gi, (word) => {
    const number = word.match(/\d+(?:\.\d+)?/)?.[0] ?? ''
    if (said.has(String(Number(number)))) return word
    setAside.push(word.trim())
    return ''
  })
  return { options: kept.replace(/\s*\/\s*(?=\/|$)/g, ' ').replace(/\s{2,}/g, ' ').replace(/^[\s/,]+|[\s/,]+$/g, '').trim(), setAside }
}
