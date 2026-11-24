import { prisma } from '@/lib/db/prisma'
import { parseOrderList } from './conversation-row'

// ---------------------------------------------------------------------------
// What a chat has proved and spent: the orders the visitor has shown are
// theirs, the order checks that did not match, the emails sent, and the
// overview colleagues read in Notes.
//
// The per-chat counts live on the chat's own row (aichat_conversations). The
// hourly ones live in aichat_rate_events, keyed on the visitor rather than the
// chat, so somebody guessing at postcodes cannot start a fresh chat to start
// afresh: Live Chat's visitor id when the chat has one, the chat itself when it
// does not (a visitor who declined to be listed has no id to follow).
//
// Executed against a real Postgres by lib/sql.live.test.ts.
// ---------------------------------------------------------------------------

/** Order checks that may fail in one chat before the assistant stops trying. */
export const MAX_FAILED_CHECKS_PER_CHAT = 3
/** ...and from one visitor in an hour, across every chat they open. */
export const MAX_FAILED_CHECKS_PER_VISITOR_PER_HOUR = 6
/** Emails one chat may send, and one visitor in an hour. */
export const MAX_EMAILS_PER_CHAT = 3
export const MAX_EMAILS_PER_VISITOR_PER_HOUR = 6

export type RateKind = 'failed_check' | 'email'

/** Who the hourly limits count against. Pure. */
export function visitorKey(conversationId: string, visitorId: string | null): string {
  return visitorId ? `visitor:${visitorId}` : `chat:${conversationId}`
}

/** Adds order numbers to the chat's proved list and returns the whole list. */
export async function addVerifiedOrders(conversationId: string, orderNumbers: readonly string[]): Promise<string[]> {
  if (orderNumbers.length === 0) return []
  const json = JSON.stringify([...orderNumbers])
  const rows = await prisma.$queryRaw<Array<{ verified_orders: unknown }>>`
    UPDATE "aichat_conversations" SET
      "verified_orders" = (
        SELECT COALESCE(jsonb_agg(DISTINCT "number"), '[]'::jsonb)
        FROM jsonb_array_elements_text("verified_orders" || ${json}::jsonb) AS "number"
      ),
      "updated_at" = CURRENT_TIMESTAMP
    WHERE "conversation_id" = ${conversationId}
    RETURNING "verified_orders"
  `
  return parseOrderList(rows[0]?.verified_orders)
}

async function addRateEvent(key: string, kind: RateKind): Promise<void> {
  // Pruned as it grows: an hour is all that is ever counted, a day is slack.
  await prisma.$executeRaw`DELETE FROM "aichat_rate_events" WHERE "created_at" < CURRENT_TIMESTAMP - INTERVAL '1 day'`
  await prisma.$executeRaw`INSERT INTO "aichat_rate_events" ("visitor_key", "kind") VALUES (${key}, ${kind})`
}

/** How many times this visitor did `kind` in the last hour. */
export async function recentRateEvents(key: string, kind: RateKind): Promise<number> {
  const rows = await prisma.$queryRaw<Array<{ n: number }>>`
    SELECT COUNT(*)::int AS "n" FROM "aichat_rate_events"
    WHERE "visitor_key" = ${key} AND "kind" = ${kind} AND "created_at" > CURRENT_TIMESTAMP - INTERVAL '1 hour'
  `
  return Number(rows[0]?.n ?? 0)
}

/** An order check that did not match: counted on the chat and on the visitor. */
export async function recordFailedCheck(conversationId: string, key: string): Promise<void> {
  await prisma.$executeRaw`
    UPDATE "aichat_conversations" SET "failed_order_checks" = "failed_order_checks" + 1, "updated_at" = CURRENT_TIMESTAMP
    WHERE "conversation_id" = ${conversationId}
  `
  await addRateEvent(key, 'failed_check')
}

/** An email went to the visitor: counted on the chat and on the visitor. */
export async function recordEmailSent(conversationId: string, key: string): Promise<void> {
  await prisma.$executeRaw`
    UPDATE "aichat_conversations" SET "emails_sent" = "emails_sent" + 1, "updated_at" = CURRENT_TIMESTAMP
    WHERE "conversation_id" = ${conversationId}
  `
  await addRateEvent(key, 'email')
}

/** Keeps a freshly written overview with the newest message it covered. */
export async function saveOverview(conversationId: string, overview: string, messageId: number): Promise<void> {
  await prisma.$executeRaw`
    UPDATE "aichat_conversations" SET
      "overview" = ${overview.slice(0, 4000)},
      "overview_message_id" = ${BigInt(Math.max(0, Math.floor(messageId)))},
      "updated_at" = CURRENT_TIMESTAMP
    WHERE "conversation_id" = ${conversationId}
  `
}
