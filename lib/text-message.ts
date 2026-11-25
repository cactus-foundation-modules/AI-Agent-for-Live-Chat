// ---------------------------------------------------------------------------
// Texting a visitor: which number a text may go to, and what it may say. Pure.
//
// Ported from the phone assistant (modules/ai-call-answering/lib/sms.ts
// textableNumber and composeText) and kept in step by hand; the two modules
// never import each other. A call texts the number it came from; a chat has no
// number of its own, so the rule is the email rule instead (lib/emails.ts
// pickSummaryRecipient): a number the visitor typed in this chat themselves,
// the one they gave Live Chat's contact box, or the one on an order they
// proved. Never a number the model wrote or was talked into, and the number is
// never handed back, so it cannot be repeated in the chat.
//
// Only UK mobiles take a text: 07... or +447..., written down as +447... A
// landline, a number from abroad or anything unusable is refused in words that
// tell the model to offer an email instead.
//
// What a text says is a short note and the shop's own links: product pages the
// chat's tools found, a page or article the tools returned, the order page for
// a proved order. Anything in the note that looks like an email address, a
// phone number or a web address is taken out, so it carries no personal
// details and no link the shop did not make.
// ---------------------------------------------------------------------------

/** Three SMS segments. Long enough for a short note and a few links. */
export const MAX_TEXT_CHARS = 459
/** A text holds three links at most: past that the note has no room. */
export const MAX_TEXT_LINKS = 3

export type Mobile = { ok: true; to: string } | { ok: false; reason: 'unusable' | 'landline' | 'abroad' }

/**
 * A number as written ("07700 900123", "+44 (0)7700-900123", "00447700900123")
 * read as a UK mobile in international form (+447700900123), or why it cannot
 * take a text. Pure.
 */
export function ukMobile(raw: string): Mobile {
  const compact = raw.trim().replace(/[\s().-]/g, '')
  if (!/^\+?\d{6,16}$/.test(compact)) return { ok: false, reason: 'unusable' }
  let national: string
  if (compact.startsWith('+44')) national = `0${compact.slice(3).replace(/^0/, '')}`
  else if (compact.startsWith('0044')) national = `0${compact.slice(4).replace(/^0/, '')}`
  else if (compact.startsWith('44') && compact.length === 12) national = `0${compact.slice(2)}`
  else if (compact.startsWith('+') || compact.startsWith('00')) return { ok: false, reason: 'abroad' }
  else national = compact
  if (!/^0\d{9,10}$/.test(national)) return { ok: false, reason: 'unusable' }
  if (!/^07\d{9}$/.test(national) || national.startsWith('070') || national.startsWith('076')) {
    // 070 is personal numbering and 076 pagers: neither is a mobile.
    return { ok: false, reason: national.startsWith('07') ? 'unusable' : 'landline' }
  }
  return { ok: true, to: `+44${national.slice(1)}` }
}

/** Runs of digits, spaces, brackets and dashes that could be a phone number. */
const NUMBER_RUN = /\+?\d[\d\s().-]{7,20}\d/g

/** Every UK mobile the visitor typed in the chat, in international form. */
export function mobilesTyped(visitorText: string): string[] {
  const found: string[] = []
  for (const match of visitorText.matchAll(NUMBER_RUN)) {
    const mobile = ukMobile(match[0])
    if (mobile.ok && !found.includes(mobile.to)) found.push(mobile.to)
  }
  return found
}

/** Whether the visitor typed this number in the chat themselves, however they
 *  spaced it. Landlines count too, so a typed landline can be refused as one
 *  rather than as a number they never gave. */
export function visitorWroteNumber(visitorText: string, number: string): boolean {
  const digits = (value: string) => {
    const mobile = ukMobile(value)
    if (mobile.ok) return mobile.to
    return value.replace(/\D/g, '').replace(/^(?:00)?44/, '0')
  }
  const wanted = digits(number)
  if (wanted.replace(/\D/g, '').length < 6) return false
  return [...visitorText.matchAll(NUMBER_RUN)].some((match) => digits(match[0]) === wanted)
}

const REFUSALS = {
  landline: 'That number is a landline, which cannot take texts. Offer to email it instead.',
  abroad: 'Texts can only go to a UK mobile number. Offer to email it instead.',
  unusable: 'That does not look like a mobile number that can take a text. Ask them to check it, or offer to email it instead.',
} as const

export type TextRecipient =
  | { kind: 'send'; to: string; source: 'typed' | 'chat' | 'order' }
  | { kind: 'refuse'; message: string }

/** The phones on one proved order, as the order holds them (the number chosen
 *  for updates first, then the customer's). */
export type OrderPhones = { orderNumber: string; phones: readonly string[] }

function firstMobile(phones: readonly string[]): string | null {
  for (const phone of phones) {
    const mobile = ukMobile(phone)
    if (mobile.ok) return mobile.to
  }
  return null
}

/**
 * Who a text goes to. Pure: everything it needs is passed in.
 *   - a number the model passes must be one the visitor typed in this chat or
 *     gave Live Chat's contact box;
 *   - else the mobile on a proved order (the one they name, or the only one);
 *   - else the number they gave the contact box.
 * The order link (`orderOnly`) goes only to the mobile on that order, as its
 * email goes only to the address on it. No message ever contains a number.
 */
export function pickTextRecipient(input: {
  given: string | null
  orderNumber: string | null
  orderOnly: boolean
  verified: readonly string[]
  orderPhones: readonly OrderPhones[]
  visitorText: string
  contactPhone: string | null
}): TextRecipient {
  const proved = input.orderPhones.filter((order) => input.verified.includes(order.orderNumber))
  if (input.orderOnly) {
    const order = proved.find((entry) => entry.orderNumber === input.orderNumber)
    const mobile = order ? firstMobile(order.phones) : null
    return mobile
      ? { kind: 'send', to: mobile, source: 'order' }
      : { kind: 'refuse', message: 'There is no mobile number on that order, so its link cannot be texted. Offer to email it instead (email_order_link).' }
  }

  const given = input.given?.trim() ?? ''
  if (given) {
    const contact = input.contactPhone ? ukMobile(input.contactPhone) : null
    const mobile = ukMobile(given)
    const fromBox = !!contact?.ok && mobile.ok && contact.to === mobile.to
    if (!fromBox && !visitorWroteNumber(input.visitorText, given)) {
      return { kind: 'refuse', message: 'A text can only go to a number the visitor has typed in this chat themselves. Ask them to type the mobile number they want it sent to.' }
    }
    if (!mobile.ok) return { kind: 'refuse', message: REFUSALS[mobile.reason] }
    return { kind: 'send', to: mobile.to, source: fromBox ? 'chat' : 'typed' }
  }

  if (input.orderNumber) {
    const order = proved.find((entry) => entry.orderNumber === input.orderNumber)
    if (!order) return { kind: 'refuse', message: 'That is not an order proved in this chat. Ask them to type the mobile number they want it sent to.' }
    const mobile = firstMobile(order.phones)
    return mobile
      ? { kind: 'send', to: mobile, source: 'order' }
      : { kind: 'refuse', message: 'There is no mobile number on that order. Ask them to type the mobile number they want it sent to, or offer to email it instead.' }
  }

  const onOrders = [...new Set(proved.map((order) => firstMobile(order.phones)).filter((m): m is string => !!m))]
  if (onOrders.length === 1) return { kind: 'send', to: onOrders[0] ?? '', source: 'order' }
  if (onOrders.length > 1) {
    return { kind: 'refuse', message: 'The orders proved in this chat carry different mobile numbers. Ask which order\'s number to use (pass its order_number) or for them to type the number they want; never write any number out.' }
  }

  if (input.contactPhone?.trim()) {
    const mobile = ukMobile(input.contactPhone)
    return mobile.ok ? { kind: 'send', to: mobile.to, source: 'chat' } : { kind: 'refuse', message: REFUSALS[mobile.reason] }
  }
  return { kind: 'refuse', message: 'There is no mobile number to send it to. Ask them to type the mobile number they want it sent to, or offer to email it instead.' }
}

const EMAIL_LIKE = /[A-Za-z0-9._%+'-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,24}/g
/** A web address, leaving any full stop or comma that ends the sentence. */
const WEB_LIKE = /\b(?:https?:\/\/|www\.)\S*[^\s.,;:!?)]/gi
const PHONE_LIKE = /\+?\d[\d\s().-]{7,}\d/g

/** The model's note with anything that looks like an email address, a phone
 *  number or a web address taken out, and its spacing tidied. Pure. */
export function cleanNote(note: string): string {
  return note
    .replace(WEB_LIKE, ' ')
    .replace(EMAIL_LIKE, ' ')
    .replace(PHONE_LIKE, ' ')
    .replace(/\s+/g, ' ')
    .replace(/\s+([.,;:!?])/g, '$1')
    .trim()
}

/** Keeps a text inside MAX_TEXT_CHARS without cutting a link in half: the
 *  note is shortened, the links are kept whole. Pure. */
export function composeText(note: string, links: readonly string[], signOff: string): string {
  const tail = [...links, signOff].filter(Boolean).join('\n')
  const room = MAX_TEXT_CHARS - tail.length - 2
  let body = cleanNote(note)
  if (room < 20) body = ''
  else if (body.length > room) body = `${body.slice(0, room - 1).replace(/\s+\S*$/, '')}…`
  return [body, tail].filter(Boolean).join('\n\n').slice(0, MAX_TEXT_CHARS)
}
