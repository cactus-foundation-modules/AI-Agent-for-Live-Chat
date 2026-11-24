import { prisma } from '@/lib/db/prisma'
import { upsertAlert } from '@/lib/notifications/alerts'

// ---------------------------------------------------------------------------
// Visitors who asked to be got back to: saved by the model's save_callback
// tool, or by the not-genuine flow when a visitor gives an email address.
// Each one lights the bell (notification kind `callback`) and waits on the
// settings screen's Callbacks tab until somebody marks it done.
// ---------------------------------------------------------------------------

export type CallbackSource = 'tool' | 'not_genuine'

export type CallbackRow = {
  id: string
  conversationId: string | null
  name: string
  email: string
  about: string
  source: CallbackSource
  handled: boolean
  createdAt: string
}

export const CALLBACKS_LINK = '/config?tab=ai-agent-for-live-chat&sub=callbacks'

export async function saveCallback(input: {
  conversationId: string
  name: string | null
  email: string
  about: string
  source: CallbackSource
}): Promise<string> {
  const name = (input.name ?? '').replace(/\s+/g, ' ').trim().slice(0, 120)
  const about = input.about.replace(/\s+/g, ' ').trim().slice(0, 1000)
  const rows = await prisma.$queryRaw<Array<{ id: string }>>`
    INSERT INTO "aichat_callbacks" ("conversation_id", "name", "email", "about", "source")
    VALUES (${input.conversationId}, ${name}, ${input.email.trim().toLowerCase()}, ${about}, ${input.source})
    RETURNING "id"
  `
  const id = rows[0]?.id ?? ''
  await upsertAlert({
    type: 'message',
    dedupeKey: `ai-agent-for-live-chat:callback:${id}`,
    title: `Callback requested from the live chat by ${name || input.email}`,
    link: CALLBACKS_LINK,
  })
  return id
}

function iso(value: unknown): string {
  return value instanceof Date ? value.toISOString() : ''
}

/** The newest first; the open ones and the last `days` days of handled ones. */
export async function listCallbacks(days: number): Promise<CallbackRow[]> {
  const span = Math.min(Math.max(Math.round(days), 1), 365)
  const rows = await prisma.$queryRaw<Array<Record<string, unknown>>>`
    SELECT "id", "conversation_id", "name", "email", "about", "source", "handled", "created_at"
    FROM "aichat_callbacks"
    WHERE "handled" = false OR "created_at" > CURRENT_TIMESTAMP - make_interval(days => ${span}::int4)
    ORDER BY "created_at" DESC
    LIMIT 500
  `
  return rows.map((row) => ({
    id: String(row.id),
    conversationId: typeof row.conversation_id === 'string' ? row.conversation_id : null,
    name: typeof row.name === 'string' ? row.name : '',
    email: typeof row.email === 'string' ? row.email : '',
    about: typeof row.about === 'string' ? row.about : '',
    source: row.source === 'not_genuine' ? 'not_genuine' : 'tool',
    handled: row.handled === true,
    createdAt: iso(row.created_at),
  }))
}

export async function setCallbackHandled(id: string, handled: boolean): Promise<void> {
  await prisma.$executeRaw`UPDATE "aichat_callbacks" SET "handled" = ${handled} WHERE "id" = ${id}`
}
