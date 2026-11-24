import { prisma } from '@/lib/db/prisma'
import { upsertAlert } from '@/lib/notifications/alerts'

// ---------------------------------------------------------------------------
// Questions the assistant had no answer for. Every "I cannot see that from
// here" is a gap - a missing FAQ, a page that does not say it - so the model
// notes each one (note_unanswered) and the settings screen lists them, newest
// first, to tick off once dealt with. Each Monday morning a notification says
// how many came in that week (cron/unanswered, notification kind
// `unanswered`).
// ---------------------------------------------------------------------------

export type UnansweredRow = {
  id: string
  conversationId: string | null
  question: string
  resolved: boolean
  createdAt: string
}

export async function recordUnanswered(conversationId: string, question: string): Promise<void> {
  const text = question.replace(/\s+/g, ' ').trim().slice(0, 300)
  if (!text) return
  await prisma.$executeRaw`
    INSERT INTO "aichat_unanswered" ("conversation_id", "question") VALUES (${conversationId}, ${text})
  `
}

export async function listUnanswered(days: number): Promise<UnansweredRow[]> {
  const span = Math.min(Math.max(Math.round(days), 1), 365)
  const rows = await prisma.$queryRaw<Array<Record<string, unknown>>>`
    SELECT "id", "conversation_id", "question", "resolved", "created_at"
    FROM "aichat_unanswered"
    WHERE "created_at" > CURRENT_TIMESTAMP - make_interval(days => ${span}::int4)
    ORDER BY "created_at" DESC
    LIMIT 500
  `
  return rows.map((row) => ({
    id: String(row.id),
    conversationId: typeof row.conversation_id === 'string' ? row.conversation_id : null,
    question: typeof row.question === 'string' ? row.question : '',
    resolved: row.resolved === true,
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : '',
  }))
}

export async function setUnansweredResolved(id: string, resolved: boolean): Promise<void> {
  await prisma.$executeRaw`UPDATE "aichat_unanswered" SET "resolved" = ${resolved} WHERE "id" = ${id}`
}

export const UNANSWERED_LINK = '/config?tab=ai-agent-for-live-chat&sub=unanswered'

/** The bell's line for a week's count. Pure. */
export function weeklyUnansweredTitle(count: number): string {
  return `${count} question${count === 1 ? '' : 's'} the chat assistant could not answer this week`
}

/** Monday's notification: how many questions from the last seven days are
 *  still open. Nothing is raised for a week with none, and a second run on the
 *  same day updates the same alert rather than adding another. */
export async function announceWeeklyUnanswered(now: Date = new Date()): Promise<number> {
  const rows = await prisma.$queryRaw<Array<{ n: number }>>`
    SELECT COUNT(*)::int AS "n" FROM "aichat_unanswered"
    WHERE "resolved" = false AND "created_at" > CURRENT_TIMESTAMP - INTERVAL '7 days'
  `
  const count = Number(rows[0]?.n ?? 0)
  if (count === 0) return 0
  await upsertAlert({
    type: 'message',
    dedupeKey: `ai-agent-for-live-chat:unanswered:${now.toISOString().slice(0, 10)}`,
    title: weeklyUnansweredTitle(count),
    link: UNANSWERED_LINK,
  })
  return count
}
