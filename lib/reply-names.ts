import { visitorTyped } from './contact-text'

// ---------------------------------------------------------------------------
// A name the model worked out from an email address, taken back out of the
// reply before it goes. Pure, pinned by lib/reply-names.test.ts.
//
// Learned with a real customer: they typed only "mikegreely28@gmail.com" and
// were thanked as "Mike", though no name was ever given; the standing rule
// against it did not hold. So a name the reply addresses them by ("Thanks,
// Mike." "Hi Mike,") is removed when it appears nowhere they wrote except
// inside an email address, and is not the name in Live Chat's contact box.
// ---------------------------------------------------------------------------

const EMAIL = /[A-Za-z0-9._%+'-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,24}/g

/** The reply with any name guessed from an email address taken out. */
export function stripGuessedName(reply: string, visitorText: string, contactName: string | null): string {
  const locals = [...visitorText.matchAll(EMAIL)].map((match) => (match[0].split('@')[0] ?? '').toLowerCase())
  if (locals.length === 0) return reply
  const words = visitorText.replace(EMAIL, ' ')
  const contact = (contactName ?? '').toLowerCase()
  const guessed = (name: string) => {
    const lower = name.toLowerCase()
    if (lower.length < 2 || contact.split(/\s+/).includes(lower) || visitorTyped(words, name)) return false
    return locals.some((local) => local.replace(/[^a-z]/g, '').includes(lower))
  }
  return reply
    // "Thanks, Mike." / "Thank you Mike!" / "Hi Mike," / "Sorry, Mike"
    .replace(/\b(Thanks|Thank you|Cheers|Hi|Hello|Hey|Sorry|Great|Lovely|Perfect)(,?)\s+([A-Z][a-z]+)\b(?=[.,!?\s])/g, (whole, lead: string, _comma: string, name: string) => (guessed(name) ? lead : whole))
    // "..., Mike." at the end of a sentence.
    .replace(/,\s+([A-Z][a-z]+)(?=[.!?])/g, (whole, name: string) => (guessed(name) ? '' : whole))
}
