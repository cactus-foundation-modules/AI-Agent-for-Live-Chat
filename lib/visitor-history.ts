import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/db/prisma'
import { isPlausibleEmail } from './contact-text'
import { emailsOnOrders } from './shop/order-queries'
import type { ToolContext } from './tools/registry'

// ---------------------------------------------------------------------------
// "I chatted to someone last week about the chairs." What this visitor has
// said to the shop before: earlier live chats, calls to the phone assistant,
// and threads in the Unified Inbox (emails, texts, contact forms), plus any
// return or damage request still open on an order they proved in this chat.
// From the phone assistant's caller-history.ts, matched on email rather than
// a phone number, since a chat has no caller ID.
//
// Matched only on addresses the site has proved belong to this visitor: the
// ones on orders proved in this chat, and their account's when signed in.
// Never an address the model passes in, and never the one typed into Live
// Chat's contact box - anybody can type anybody's email there, and history
// matched on it would let a stranger read the outline of somebody else's
// dealings with the shop. Each item is a
// date, a channel and a line of what it was about, scrubbed of addresses and
// numbers: enough to recognise what they mean, not a transcript to read back.
//
// The phone assistant, Live Chat and the inbox are other modules' tables, read
// only when they are there.
// ---------------------------------------------------------------------------

export const HISTORY_DAYS = 120
const MAX_PER_SOURCE = 5
const LINE_CHARS = 220

export type HistoryItem = {
  when: string
  channel: 'call' | 'chat' | 'email' | 'text' | 'voicemail' | 'form' | 'other'
  about: string
  /** Still waiting on the shop, as far as its own records say. */
  open: boolean
}

type Dated = HistoryItem & { at: Date }

async function tableExists(table: string): Promise<boolean> {
  const rows = await prisma.$queryRaw<Array<{ present: boolean }>>`SELECT to_regclass(${`public.${table}`}) IS NOT NULL AS present`
  return rows[0]?.present === true
}

/** A line of what something was about, with addresses and long numbers taken
 *  out. Pure. */
export function aboutLine(text: string | null | undefined): string {
  const flat = (text ?? '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
  const scrubbed = flat
    .replace(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g, '[email]')
    .replace(/\+?\d[\d\s]{8,}\d/g, '[number]')
  return scrubbed.length > LINE_CHARS ? `${scrubbed.slice(0, LINE_CHARS - 1)}…` : scrubbed
}

/** "Tuesday 27 October", in UK time. */
export function writtenDate(date: Date): string {
  return date.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'Europe/London' })
}

/** The addresses the history is matched on: lower case, plausible, distinct.
 *  Pure. */
export function historyEmails(sources: ReadonlyArray<string | null | undefined>): string[] {
  const out: string[] = []
  for (const value of sources) {
    const email = value?.trim().toLowerCase() ?? ''
    if (email && isPlausibleEmail(email) && !out.includes(email)) out.push(email)
  }
  return out
}

function inboxChannel(channel: string): HistoryItem['channel'] {
  if (channel === 'email') return 'email'
  if (channel === 'sms' || channel === 'whatsapp') return 'text'
  if (channel === 'phone') return 'voicemail'
  if (channel === 'form') return 'form'
  return 'other'
}

async function earlierChats(currentId: string, emails: string[], since: Date): Promise<Dated[]> {
  const rows = await prisma.$queryRaw<Array<{ created_at: Date; last_message_preview: string | null; status: string }>>`
    SELECT "created_at", "last_message_preview", "status" FROM "chat_conversations"
    WHERE lower("visitor_email") = ANY(${emails}::text[]) AND "id" <> ${currentId} AND "created_at" > ${since}
    ORDER BY "created_at" DESC LIMIT ${MAX_PER_SOURCE}
  `
  return rows.map((row) => ({
    at: row.created_at,
    when: writtenDate(row.created_at),
    channel: 'chat' as const,
    about: aboutLine(row.last_message_preview) || 'A live chat',
    open: row.status === 'open',
  }))
}

async function earlierCalls(emails: string[], since: Date): Promise<Dated[]> {
  if (!(await tableExists('acall_calls'))) return []
  const rows = await prisma.$queryRaw<Array<{ started_at: Date; summary: string; callback_needed: boolean; callback_reason: string; handled_at: Date | null }>>`
    SELECT "started_at", "summary", "callback_needed", "callback_reason", "handled_at" FROM "acall_calls"
    WHERE (lower("caller_email") = ANY(${emails}::text[]) OR lower("verified_contact_email") = ANY(${emails}::text[]))
      AND "status" = 'completed' AND "started_at" > ${since}
    ORDER BY "started_at" DESC LIMIT ${MAX_PER_SOURCE}
  `
  return rows.map((row) => ({
    at: row.started_at,
    when: writtenDate(row.started_at),
    channel: 'call' as const,
    about: aboutLine(row.callback_needed && row.callback_reason ? `Left a message: ${row.callback_reason}` : row.summary) || 'A phone call',
    open: row.callback_needed && row.handled_at === null,
  }))
}

async function inboxThreads(emails: string[], since: Date): Promise<Dated[]> {
  if (!(await tableExists('uin_messages'))) return []
  // The newest message they sent in each thread. Chat is read from its own
  // table above; notes are staff talking to each other.
  const rows = await prisma.$queryRaw<Array<{ sent_at: Date; channel: string; subject: string | null; snippet: string | null; handled_at: Date | null }>>`
    SELECT DISTINCT ON ("thread_id") "sent_at", "channel", "subject", "snippet", "handled_at"
    FROM "uin_messages"
    WHERE "direction" = 'in' AND "channel" <> 'chat' AND "sent_at" > ${since}
      AND lower("from_address") = ANY(${emails}::text[])
    ORDER BY "thread_id", "sent_at" DESC
  `
  return rows
    .sort((a, b) => b.sent_at.getTime() - a.sent_at.getTime())
    .slice(0, MAX_PER_SOURCE)
    .map((row) => ({
      at: row.sent_at,
      when: writtenDate(row.sent_at),
      channel: inboxChannel(row.channel),
      about: aboutLine([row.subject, row.snippet].filter(Boolean).join(' - ')) || 'A message',
      open: row.handled_at === null,
    }))
}

export type OpenRequest = { orderNumber: string; type: string; status: string; raised: string }

async function openRequests(verifiedOrders: string[]): Promise<OpenRequest[]> {
  if (verifiedOrders.length === 0) return []
  const rows = await prisma.$queryRaw<Array<{ order_number: string; type: string; status: string; created_at: Date }>>(Prisma.sql`
    SELECT o."order_number", r."type", r."status", r."created_at"
    FROM "shp_order_requests" r JOIN "shp_orders" o ON o."id" = r."order_id"
    WHERE o."order_number" IN (${Prisma.join(verifiedOrders)})
      AND r."status" IN ('PENDING', 'APPROVED')
    ORDER BY r."created_at" DESC LIMIT ${MAX_PER_SOURCE}
  `)
  return rows.map((row) => ({
    orderNumber: row.order_number,
    type: row.type.toLowerCase(),
    status: row.status.toLowerCase().replace(/_/g, ' '),
    raised: writtenDate(row.created_at),
  }))
}

export type VisitorHistory = { items: HistoryItem[]; openRequests: OpenRequest[]; matchedOn: number }

export async function visitorHistory(ctx: Pick<ToolContext, 'conversationId' | 'orders' | 'member'>, now: Date = new Date()): Promise<VisitorHistory> {
  const since = new Date(now.getTime() - HISTORY_DAYS * 24 * 60 * 60 * 1000)
  const orderEmails = ctx.orders.verified.length > 0 ? await emailsOnOrders(ctx.orders.verified) : []
  const emails = historyEmails([...orderEmails, ctx.member?.email])
  const [chats, calls, inbox, requests] = await Promise.all([
    emails.length > 0 ? earlierChats(ctx.conversationId, emails, since).catch(() => []) : Promise.resolve([]),
    emails.length > 0 ? earlierCalls(emails, since).catch(() => []) : Promise.resolve([]),
    emails.length > 0 ? inboxThreads(emails, since).catch(() => []) : Promise.resolve([]),
    openRequests(ctx.orders.verified),
  ])
  const items = [...chats, ...calls, ...inbox]
    .sort((a, b) => b.at.getTime() - a.at.getTime())
    .slice(0, MAX_PER_SOURCE * 2)
    .map(({ at: _at, ...item }) => item)
  return { items, openRequests: requests, matchedOn: emails.length }
}
