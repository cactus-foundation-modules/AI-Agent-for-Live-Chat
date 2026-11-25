import { isChatState, type ChatState } from './constants'
import { parseDiscussedProducts, type DiscussedProduct } from './discussed-products'

// One aichat_conversations row, as the rest of the module reads it. Pure: the
// raw row in (Prisma hands BIGINT back as bigint, TIMESTAMP as Date, JSONB
// already parsed), a typed record out.

export type Usage = { input: number; cached: number; output: number; turns: number }

export type ToolLogEntry = {
  tool: string
  /** When it ran, ISO. */
  at: string
  ms: number
  /** A short, readable summary of what it was given. */
  args: string
  ok: boolean
}

export type ConversationRow = {
  conversationId: string
  state: ChatState
  callbackWanted: boolean
  staff: boolean
  memberId: string | null
  memberEmail: string | null
  colleaguesOnline: boolean
  lastTakenMessageId: number
  lastHandledMessageId: number
  processingUntil: Date | null
  pending: boolean
  notGenuineAsks: number
  notGenuineReason: string | null
  waitingSince: Date | null
  waitingUntil: Date | null
  usage: Usage
  toolLog: ToolLogEntry[]
  /** Order numbers proved this chat (lib/order-state.ts). */
  verifiedOrders: string[]
  failedOrderChecks: number
  emailsSent: number
  textsSent: number
  /** The products this chat has been about, newest last (lib/discussed-products.ts). */
  discussedProducts: DiscussedProduct[]
  overview: string
  /** The newest chat message the overview covered; 0 for none yet. */
  overviewMessageId: number
}

function num(value: unknown): number {
  if (typeof value === 'bigint') return Number(value)
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && /^\d+$/.test(value)) return Number(value)
  return 0
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null
}

function date(value: unknown): Date | null {
  return value instanceof Date ? value : null
}

export function parseUsage(value: unknown): Usage {
  const record = value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
  return { input: num(record.input), cached: num(record.cached), output: num(record.output), turns: num(record.turns) }
}

export function parseToolLog(value: unknown): ToolLogEntry[] {
  if (!Array.isArray(value)) return []
  const out: ToolLogEntry[] = []
  for (const item of value) {
    if (!item || typeof item !== 'object') continue
    const entry = item as Record<string, unknown>
    if (typeof entry.tool !== 'string') continue
    out.push({
      tool: entry.tool,
      at: typeof entry.at === 'string' ? entry.at : '',
      ms: num(entry.ms),
      args: typeof entry.args === 'string' ? entry.args : '',
      ok: entry.ok !== false,
    })
  }
  return out
}

/** A JSONB list of order numbers. Anything that is not a non-empty string is
 *  dropped, and repeats go. */
export function parseOrderList(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const out: string[] = []
  for (const item of value) {
    if (typeof item === 'string' && item.trim() !== '' && !out.includes(item)) out.push(item)
  }
  return out
}

export function parseConversationRow(row: Record<string, unknown>): ConversationRow {
  return {
    conversationId: String(row.conversation_id ?? ''),
    state: isChatState(row.state) ? row.state : 'auto',
    callbackWanted: row.callback_wanted === true,
    staff: row.staff === true,
    memberId: text(row.member_id),
    memberEmail: text(row.member_email),
    colleaguesOnline: row.colleagues_online === true,
    lastTakenMessageId: num(row.last_taken_message_id),
    lastHandledMessageId: num(row.last_handled_message_id),
    processingUntil: date(row.processing_until),
    pending: row.pending === true,
    notGenuineAsks: num(row.not_genuine_asks),
    notGenuineReason: text(row.not_genuine_reason),
    waitingSince: date(row.waiting_since),
    waitingUntil: date(row.waiting_until),
    usage: parseUsage(row.usage),
    toolLog: parseToolLog(row.tool_log),
    verifiedOrders: parseOrderList(row.verified_orders),
    failedOrderChecks: num(row.failed_order_checks),
    emailsSent: num(row.emails_sent),
    textsSent: num(row.texts_sent),
    discussedProducts: parseDiscussedProducts(row.discussed_products),
    overview: typeof row.overview === 'string' ? row.overview : '',
    overviewMessageId: num(row.overview_message_id),
  }
}
