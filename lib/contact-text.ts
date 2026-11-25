// Picking an email address and a name out of what a visitor typed. Pure.

/** Deliberately ordinary: something@somewhere.tld, no spaces, no angle
 *  brackets. Good enough to say "that looks like an address"; the email itself
 *  proves the rest. */
const EMAIL = /[A-Za-z0-9._%+'-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,24}/

export function isPlausibleEmail(value: string): boolean {
  const email = value.trim()
  if (email.length > 254) return false
  const match = email.match(EMAIL)
  return match !== null && match[0] === email && !email.includes('..')
}

/** The first plausible email address in a message, lower-cased; null when
 *  there is none. */
export function findEmail(text: string): string | null {
  const match = text.match(EMAIL)
  if (!match) return null
  const email = match[0].replace(/\.+$/, '')
  return isPlausibleEmail(email) ? email.toLowerCase() : null
}

/** Whether the visitor typed this address themselves somewhere in the chat
 *  (case aside). An email the model wants to send to must pass this, so it
 *  can never be talked into mailing somebody the visitor never named. */
export function visitorWroteEmail(visitorText: string, email: string): boolean {
  const wanted = email.trim().toLowerCase()
  if (!wanted) return false
  const all = visitorText.match(new RegExp(EMAIL.source, 'g')) ?? []
  return all.some((found) => found.replace(/\.+$/, '').toLowerCase() === wanted)
}

/** Text from an order (delivery instructions, a note from the team, the
 *  customer's reference) with anything that looks like an email address or a
 *  phone number taken out, so the model is never handed contact details it
 *  could repeat back. */
export function scrubContactDetails(text: string): string {
  return text
    .replace(new RegExp(EMAIL.source, 'g'), '[email]')
    .replace(/\+?\d[\d\s()-]{8,}\d/g, '[number]')
}

const NAME_INTRO =/\b(?:my name is|my name's|name is|name's|i am|i'm|im|it's|its|this is|name:|regards,?|thanks,?|cheers,?)\s+/i
const NAME_WORD = /^[\p{L}][\p{L}'.-]{0,30}$/u
/** Words a reply often starts with that are never a name. */
const FILLER = new Set(['hi', 'hello', 'hey', 'hiya', 'good', 'morning', 'afternoon', 'evening', 'there', 'ok', 'okay', 'yes', 'yeah', 'sure', 'thanks', 'thank', 'you', 'cheers', 'sorry', 'please', 'here', 'mine', 'me'])

/**
 * A name, when the message holds one alongside (or instead of) the email: "Sam
 * Jones sam@x.com", "my name is Sam, sam@x.com". Up to four words of letters;
 * anything longer reads as a sentence, not a name, and gives null.
 */
export function findName(text: string): string | null {
  let rest = text.replace(EMAIL, ' ').replace(/[\r\n]+/g, ' ')
  const intro = rest.match(NAME_INTRO)
  if (intro && intro.index !== undefined) rest = rest.slice(intro.index + intro[0].length)
  rest = rest.replace(/\b(?:and|email|e-mail|address|is|at)\b.*$/i, ' ')
  const words = rest.split(/[\s,;:!?()]+/).map((w) => w.replace(/^[.'-]+|[.'-]+$/g, '')).filter(Boolean)
  while (words.length > 0 && FILLER.has((words[0] ?? '').toLowerCase())) words.shift()
  while (words.length > 0 && FILLER.has((words[words.length - 1] ?? '').toLowerCase())) words.pop()
  if (words.length === 0 || words.length > 4) return null
  if (!words.every((w) => NAME_WORD.test(w))) return null
  return words.map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ').slice(0, 80)
}

/** Whether the visitor really typed these words in the chat. Case, spacing and
 *  punctuation aside, they must appear in what they wrote, as whole words. Pure. */
export function visitorTyped(visitorText: string, said: string): boolean {
  const plain = (value: string) => value.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
  const words = plain(said)
  return words.length > 0 && ` ${plain(visitorText)} `.includes(` ${words} `)
}

/**
 * The name to greet somebody by in an email: one the model passes only when
 * the visitor typed it in the chat or gave it to Live Chat's contact box, else
 * the contact box's own, else none. Never a name worked out from an email
 * address: learned on a live chat, where "Hi Chris," went to chris@... before
 * the visitor had given any name at all. Pure.
 */
export function greetingName(given: string | null | undefined, visitorText: string, contactName: string | null | undefined): string {
  const name = given?.trim() ?? ''
  const contact = contactName?.trim() ?? ''
  // An email address is not a name: "chris@..." must not count as "Chris".
  const words = visitorText.replace(/\S+@\S+/g, ' ')
  if (name && (visitorTyped(words, name) || (contact && name.toLowerCase() === contact.toLowerCase()))) return name
  return contact
}
