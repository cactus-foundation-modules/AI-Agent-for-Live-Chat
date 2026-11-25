import { contentPart, fileNote, type AttachmentLike, type ContentPart, type LoadedFile } from './attachments'

// ---------------------------------------------------------------------------
// The conversation as the model reads it, and the note about the visitor that
// ends every turn. Pure: the chat in, Responses API input items out.
//
// The order matters for the prompt cache (lib/prompt.ts): the transcript grows
// at the end, so each turn's start matches the last one's, and everything that
// changes from turn to turn - the page, the basket, the time - goes in the
// note at the very end, never in the instructions.
// ---------------------------------------------------------------------------

/** A message to the model: words, or (for the visitor's own messages that
 *  carry pictures or PDFs) words and files. */
export type InputItem = { role: 'user' | 'assistant' | 'developer'; content: string | ContentPart[] }

/** One chat message, as much of it as the model needs. Structurally the same
 *  as Live Chat's ResponderMessage. */
export type TranscriptLine = {
  id: number
  sender: 'visitor' | 'agent' | 'system'
  authorId: string | null
  authorName: string | null
  body: string
  attachments: ReadonlyArray<AttachmentLike>
}

function withFiles(line: TranscriptLine): string {
  const files = line.attachments.map((a) => a.filename).filter(Boolean)
  const body = line.body.trim()
  if (files.length === 0) return body
  const note = `[Sent ${files.length === 1 ? 'a file' : 'files'}: ${files.join(', ')}]`
  return body ? `${body}\n${note}` : note
}

/** A visitor's message with its files: each one the turn read goes in as the
 *  file itself, each one it did not as a line saying why (lib/attachments.ts).
 *  Plain words when nothing was read, so a chat without files looks exactly as
 *  it always did. */
function visitorContent(line: TranscriptLine, loaded: ReadonlyMap<string, LoadedFile>): string | ContentPart[] {
  const shown = line.attachments.filter((a) => a.id && loaded.has(a.id))
  if (shown.length === 0) {
    const anyKnown = line.attachments.some((a) => a.contentType)
    if (!anyKnown) return withFiles(line)
    const notes = line.attachments.map(fileNote)
    const body = line.body.trim()
    return [body, ...notes].filter(Boolean).join('\n')
  }
  const words = [line.body.trim(), ...line.attachments.filter((a) => !(a.id && loaded.has(a.id))).map(fileNote)].filter(Boolean).join('\n')
  const parts: ContentPart[] = [{ type: 'input_text', text: words || '[Sent files]' }]
  for (const attachment of shown) {
    const file = attachment.id ? loaded.get(attachment.id) : undefined
    if (file) parts.push(contentPart(file))
  }
  return parts
}

/**
 * The chat up to and including `upToId`, oldest first. The visitor speaks as
 * the user; the assistant's own messages as the assistant; a colleague's as the
 * assistant too, marked with their name, so the model sees one side of the
 * counter; the site's automatic messages marked as such; system lines ("Sam
 * joined") as notes. `loaded` holds the visitor's files this turn read, by
 * attachment id.
 */
export function transcriptInput(
  messages: readonly TranscriptLine[],
  upToId: number,
  ownAuthorId: string,
  loaded: ReadonlyMap<string, LoadedFile> = new Map(),
): InputItem[] {
  const items: InputItem[] = []
  for (const line of messages) {
    if (line.id > upToId) break
    if (line.sender === 'visitor') {
      const content = visitorContent(line, loaded)
      if (content.length > 0) items.push({ role: 'user', content })
      continue
    }
    const text = withFiles(line)
    if (!text) continue
    if (line.sender === 'system') items.push({ role: 'developer', content: `(Chat note) ${text}` })
    else if (line.authorId === ownAuthorId) items.push({ role: 'assistant', content: text })
    else if (line.authorId === null) items.push({ role: 'assistant', content: `(Automatic message) ${text}` })
    else items.push({ role: 'assistant', content: `(Colleague ${line.authorName?.trim() || 'from the team'}) ${text}` })
  }
  return items
}

export type BasketLine = { name: string | null; quantity: number; unitPrice: string | null }

export type ContextFacts = {
  now: Date
  /** The page the chat was started on, and the one they are on now. */
  startedOn: string | null
  currentPath: string | null
  currentTitle: string | null
  basket: readonly BasketLine[] | null
  basketTotal: string | null
  signedIn: boolean
  /** What the visitor has told the chat about themselves. */
  visitorName: string | null
  visitorEmail: string | null
  /** A colleague testing the assistant (Staff only). */
  staff: boolean
  /** Whether any colleague is online to hand to. */
  colleaguesOnline: boolean
  /** The visitor is owed an apology and a request for their details. */
  callbackWanted: boolean
  /** The chat was flagged as not genuine once already, and the visitor told
   *  the assistant is here to help with the shop. */
  warnedOnce?: boolean
  /** Emails and texts already sent from this chat, so the assistant never
   *  denies one it sent. */
  emailsSent?: number
  textsSent?: number
  /** Order numbers the visitor has proved are theirs in this chat. */
  verifiedOrders?: readonly string[]
  /** Order checks have failed too often (this chat, or this visitor this hour). */
  orderChecksLocked?: boolean
  /** No more emails may go from this chat. */
  emailsUsedUp?: boolean
  /** Whether the site can send a text (a provider is set up), and whether this
   *  chat has used up its texts. Left out, nothing is said about texts. */
  textingAvailable?: boolean
  textsUsedUp?: boolean
  /** The delivery services chosen in this chat (choose_delivery): each one's
   *  name and the product's address carrying it. */
  deliveryChoices?: ReadonlyArray<{ label: string; url: string | null }>
}

/** "Tuesday 24 November 2026, 14:05" in UK time. */
export function londonDateTime(now: Date): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/London',
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(now)
}

export function basketWords(lines: readonly BasketLine[] | null, total: string | null): string {
  if (!lines || lines.length === 0) return 'empty, as far as the site can tell'
  const shown = lines.slice(0, 15).map((line) => {
    const name = line.name?.trim() || 'an item'
    return `${line.quantity} x ${name}${line.unitPrice ? ` (${line.unitPrice} each)` : ''}`
  })
  const more = lines.length > shown.length ? `, and ${lines.length - shown.length} more` : ''
  return `${shown.join('; ')}${more}${total ? `. Total ${total}` : ''}`
}

/** The note that ends every turn: who the visitor is, as far as the site knows. */
export function contextNote(facts: ContextFacts): string {
  const lines = [
    'About this visitor (for you only - never read this out):',
    `- Now: ${londonDateTime(facts.now)}, UK time.`,
  ]
  if (facts.currentPath) lines.push(`- On the page: ${facts.currentTitle ? `${facts.currentTitle} (${facts.currentPath})` : facts.currentPath}`)
  if (facts.startedOn && facts.startedOn !== facts.currentPath) lines.push(`- Started the chat on: ${facts.startedOn}`)
  lines.push(`- Basket: ${basketWords(facts.basket, facts.basketTotal)}.`)
  lines.push(`- ${facts.signedIn
    ? 'Signed in to their account on the site: their own orders need no postcode (list_my_orders, or lookup_order with the order number).'
    : 'Not signed in.'}`)
  if (facts.visitorName) lines.push(`- Name given: ${facts.visitorName}`)
  if (facts.visitorEmail) lines.push(`- Email given: ${facts.visitorEmail}`)
  lines.push(`- ${facts.colleaguesOnline ? 'Colleagues are online and can be fetched.' : 'No colleague is online just now.'}`)
  if (facts.verifiedOrders && facts.verifiedOrders.length > 0) {
    lines.push(`- Orders proved in this chat: ${facts.verifiedOrders.join(', ')}. Discuss only the one they are asking about.`)
  }
  if (facts.orderChecksLocked) lines.push('- Order checks are locked: too many did not match. Do not try another; offer a callback.')
  if (facts.emailsUsedUp) lines.push('- No more emails can be sent from this chat. Offer a callback instead.')
  if (facts.textingAvailable === true) {
    lines.push(facts.textsUsedUp
      ? '- Texting is available on this site, but no more texts can be sent from this chat.'
      : '- Texting is available: you may offer to text them links (send_text).')
  } else if (facts.textingAvailable === false) {
    lines.push('- Texting is not set up on this site: never offer a text.')
  }
  const chosen = (facts.deliveryChoices ?? []).filter((choice) => choice.url)
  if (chosen.length > 0) {
    lines.push(`- Delivery chosen in this chat (show each of these products with this address, so its card carries the service): ${chosen.map((choice) => `${choice.label}: ${choice.url}`).join('; ')}.`)
  }
  if (facts.staff) lines.push('- This is a colleague testing you. Answer exactly as you would a visitor.')
  if (facts.emailsSent || facts.textsSent) {
    const sent = [
      facts.emailsSent ? `${facts.emailsSent} email${facts.emailsSent === 1 ? '' : 's'}` : '',
      facts.textsSent ? `${facts.textsSent} text${facts.textsSent === 1 ? '' : 's'}` : '',
    ].filter(Boolean).join(' and ')
    lines.push(`- Already sent from this chat: ${sent}. They went; never say otherwise. If asked about one, it is on its way or has arrived.`)
  }
  if (facts.warnedOnce) lines.push('- Earlier in this chat they were told you are here to help with the shop. Help them normally if they now ask something genuine; only if they carry on abusing or wasting time, call flag_not_genuine, which ends your part in the chat.')
  if (facts.callbackWanted) lines.push('- A colleague could not be reached for them earlier. Say sorry once for that and offer, once, to have somebody get back to them by email; save_callback only if they say yes. If they decline or move on, drop it.')
  return lines.join('\n')
}
