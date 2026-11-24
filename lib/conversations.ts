import { prisma } from '@/lib/db/prisma'
import type { ChatState } from './constants'
import { parseConversationRow, type ConversationRow, type ToolLogEntry, type Usage } from './conversation-row'

// ---------------------------------------------------------------------------
// aichat_conversations: each chat's state and the bookkeeping of answering it.
//
// Every statement here is small and single-row (the two sweeps aside), because
// several of them run inside Live Chat's two-second window. State moves that
// could race - a turn being claimed, a hand-over running out - are one
// conditional UPDATE each, so exactly one caller wins.
//
// Executed against a real Postgres by lib/sql.live.test.ts.
// ---------------------------------------------------------------------------

type Row = Record<string, unknown>

/** A turn may run this long before another may claim the chat. A running turn
 *  extends it each time it refreshes "typing", so only a crashed one lapses. */
export const TURN_LEASE_SECONDS = 90

/** A chat's tool log stops growing here: past it the chat is stuck in a loop
 *  and the rest add nothing. */
export const MAX_TOOL_LOG_ENTRIES = 100

function first(rows: Row[]): ConversationRow | null {
  const row = rows[0]
  return row ? parseConversationRow(row) : null
}

export async function getConversationState(conversationId: string): Promise<ConversationRow | null> {
  return first(await prisma.$queryRaw<Row[]>`
    SELECT * FROM "aichat_conversations" WHERE "conversation_id" = ${conversationId} LIMIT 1
  `)
}

/**
 * At offer time: makes sure the chat has a row and records what only the
 * request knows (a colleague testing, the signed-in member) and the Online
 * switch. Returns the row as it now stands.
 */
export async function recordOffer(input: {
  conversationId: string
  staff: boolean
  memberId: string | null
  memberEmail: string | null
  online: boolean
}): Promise<ConversationRow | null> {
  return first(await prisma.$queryRaw<Row[]>`
    INSERT INTO "aichat_conversations" ("conversation_id", "staff", "member_id", "member_email", "colleagues_online")
    VALUES (${input.conversationId}, ${input.staff}, ${input.memberId}, ${input.memberEmail}, ${input.online})
    ON CONFLICT ("conversation_id") DO UPDATE SET
      "staff" = "aichat_conversations"."staff" OR EXCLUDED."staff",
      "member_id" = COALESCE(EXCLUDED."member_id", "aichat_conversations"."member_id"),
      "member_email" = COALESCE(EXCLUDED."member_email", "aichat_conversations"."member_email"),
      "colleagues_online" = EXCLUDED."colleagues_online",
      "updated_at" = CURRENT_TIMESTAMP
    RETURNING *
  `)
}

/** The assistant has taken this message: it is the newest one to answer, and
 *  the chat moves to `state`. Leaving `waiting` clears its clock. */
export async function takeMessage(conversationId: string, messageId: number, state: ChatState, callbackWanted: boolean): Promise<void> {
  await prisma.$executeRaw`
    UPDATE "aichat_conversations" SET
      "state" = ${state},
      "last_taken_message_id" = GREATEST("last_taken_message_id", ${BigInt(messageId)}),
      "callback_wanted" = "callback_wanted" OR ${callbackWanted},
      "waiting_since" = CASE WHEN ${state} = 'waiting' THEN "waiting_since" ELSE NULL END,
      "waiting_until" = CASE WHEN ${state} = 'waiting' THEN "waiting_until" ELSE NULL END,
      "updated_at" = CURRENT_TIMESTAMP
    WHERE "conversation_id" = ${conversationId}
  `
}

/** Marks a message as wanting an answer without changing anything else - for
 *  a chat handed to the assistant with the visitor's question still open. */
export async function markTaken(conversationId: string, messageId: number): Promise<void> {
  await prisma.$executeRaw`
    UPDATE "aichat_conversations" SET
      "last_taken_message_id" = GREATEST("last_taken_message_id", ${BigInt(messageId)}),
      "updated_at" = CURRENT_TIMESTAMP
    WHERE "conversation_id" = ${conversationId}
  `
}

/** A colleague replied. Quiet stays quiet; anything else is theirs now. Makes
 *  the row if the chat has none, so a later switch change finds it. */
export async function colleagueTookOver(conversationId: string): Promise<void> {
  await prisma.$executeRaw`
    INSERT INTO "aichat_conversations" ("conversation_id", "state")
    VALUES (${conversationId}, 'colleague')
    ON CONFLICT ("conversation_id") DO UPDATE SET
      "state" = CASE WHEN "aichat_conversations"."state" = 'quiet' THEN 'quiet' ELSE 'colleague' END,
      "waiting_since" = NULL,
      "waiting_until" = NULL,
      "callback_wanted" = false,
      "updated_at" = CURRENT_TIMESTAMP
  `
}

/** A colleague pressed "Hand to <name>" / "Hand back to <name>". A fresh start
 *  for the assistant: the not-genuine count and any hand-over are cleared. */
export async function handToAssistant(conversationId: string, state: ChatState): Promise<ConversationRow | null> {
  return first(await prisma.$queryRaw<Row[]>`
    INSERT INTO "aichat_conversations" ("conversation_id", "state")
    VALUES (${conversationId}, ${state})
    ON CONFLICT ("conversation_id") DO UPDATE SET
      "state" = EXCLUDED."state",
      "waiting_since" = NULL,
      "waiting_until" = NULL,
      "not_genuine_asks" = 0,
      "not_genuine_reason" = NULL,
      "updated_at" = CURRENT_TIMESTAMP
    RETURNING *
  `)
}

// --- one turn at a time -----------------------------------------------------

/** Claims the chat for one turn. Null when another turn holds it; the caller
 *  then marks it pending and leaves the work to that turn. */
export async function claimTurn(conversationId: string, leaseSeconds: number = TURN_LEASE_SECONDS): Promise<ConversationRow | null> {
  return first(await prisma.$queryRaw<Row[]>`
    UPDATE "aichat_conversations" SET
      "processing_until" = CURRENT_TIMESTAMP + make_interval(secs => ${leaseSeconds}::int4),
      "pending" = false
    WHERE "conversation_id" = ${conversationId}
      AND ("processing_until" IS NULL OR "processing_until" < CURRENT_TIMESTAMP)
    RETURNING *
  `)
}

export async function markPending(conversationId: string): Promise<void> {
  await prisma.$executeRaw`UPDATE "aichat_conversations" SET "pending" = true WHERE "conversation_id" = ${conversationId}`
}

export async function extendTurn(conversationId: string, leaseSeconds: number = TURN_LEASE_SECONDS): Promise<void> {
  await prisma.$executeRaw`
    UPDATE "aichat_conversations" SET "processing_until" = CURRENT_TIMESTAMP + make_interval(secs => ${leaseSeconds}::int4)
    WHERE "conversation_id" = ${conversationId} AND "processing_until" IS NOT NULL
  `
}

/** Lets the chat go. True when there is more to do: a message arrived while
 *  the turn ran, or one was taken that has not been answered. */
export async function releaseTurn(conversationId: string): Promise<boolean> {
  // Two statements in one transaction, the row locked by the first: an offer
  // marking the chat pending has to wait for the release, so the flag read here
  // is the flag as it stood. (One statement cannot do it: RETURNING sees the
  // row as written, with pending already false, and a locking read of the same
  // row inside that statement skips it as already changed.)
  return prisma.$transaction(async (tx) => {
    const before = await tx.$queryRaw<Array<{ pending: boolean }>>`
      SELECT "pending" FROM "aichat_conversations" WHERE "conversation_id" = ${conversationId} FOR UPDATE
    `
    const rows = await tx.$queryRaw<Array<{ more: boolean }>>`
      UPDATE "aichat_conversations" SET "processing_until" = NULL, "pending" = false
      WHERE "conversation_id" = ${conversationId}
      RETURNING ("last_taken_message_id" > "last_handled_message_id") AS "more"
    `
    return before[0]?.pending === true || rows[0]?.more === true
  })
}

export async function markHandled(conversationId: string, messageId: number): Promise<void> {
  await prisma.$executeRaw`
    UPDATE "aichat_conversations" SET
      "last_handled_message_id" = GREATEST("last_handled_message_id", ${BigInt(messageId)}),
      "updated_at" = CURRENT_TIMESTAMP
    WHERE "conversation_id" = ${conversationId}
  `
}

// --- moves the assistant makes ----------------------------------------------

/** Handed to a colleague: waiting, with the clock running. Returns when the
 *  wait runs out. */
export async function enterWaiting(conversationId: string, waitSeconds: number): Promise<Date | null> {
  const rows = await prisma.$queryRaw<Array<{ waiting_until: Date }>>`
    UPDATE "aichat_conversations" SET
      "state" = 'waiting',
      "waiting_since" = CURRENT_TIMESTAMP,
      "waiting_until" = CURRENT_TIMESTAMP + make_interval(secs => ${waitSeconds}::int4),
      "callback_wanted" = false,
      "updated_at" = CURRENT_TIMESTAMP
    WHERE "conversation_id" = ${conversationId}
    RETURNING "waiting_until"
  `
  return rows[0]?.waiting_until ?? null
}

export async function enterNotGenuine(conversationId: string, reason: string): Promise<void> {
  await prisma.$executeRaw`
    UPDATE "aichat_conversations" SET
      "state" = 'not_genuine',
      "not_genuine_asks" = 1,
      "not_genuine_reason" = ${reason.slice(0, 300)},
      "waiting_since" = NULL,
      "waiting_until" = NULL,
      "updated_at" = CURRENT_TIMESTAMP
    WHERE "conversation_id" = ${conversationId}
  `
}

export async function setNotGenuineAsks(conversationId: string, asks: number): Promise<void> {
  await prisma.$executeRaw`
    UPDATE "aichat_conversations" SET "not_genuine_asks" = ${asks}, "updated_at" = CURRENT_TIMESTAMP
    WHERE "conversation_id" = ${conversationId}
  `
}

export async function enterQuiet(conversationId: string): Promise<void> {
  await prisma.$executeRaw`
    UPDATE "aichat_conversations" SET
      "state" = 'quiet',
      "waiting_since" = NULL,
      "waiting_until" = NULL,
      "updated_at" = CURRENT_TIMESTAMP
    WHERE "conversation_id" = ${conversationId}
  `
}

export async function setCallbackWanted(conversationId: string, wanted: boolean): Promise<void> {
  await prisma.$executeRaw`
    UPDATE "aichat_conversations" SET "callback_wanted" = ${wanted}, "updated_at" = CURRENT_TIMESTAMP
    WHERE "conversation_id" = ${conversationId}
  `
}

// --- the switch, and the hand-over clock ------------------------------------

/** The Online switch went off. Chats a colleague had go back to the site
 *  rules; chats waiting for one come back to the assistant, owed an apology.
 *  Returns the chats that were waiting. */
export async function switchedOff(): Promise<string[]> {
  const waiting = await prisma.$queryRaw<Array<{ conversation_id: string }>>`
    UPDATE "aichat_conversations" SET
      "state" = 'auto',
      "callback_wanted" = true,
      "waiting_since" = NULL,
      "waiting_until" = NULL,
      "updated_at" = CURRENT_TIMESTAMP
    WHERE "state" = 'waiting'
    RETURNING "conversation_id"
  `
  await prisma.$executeRaw`
    UPDATE "aichat_conversations" SET "state" = 'auto', "updated_at" = CURRENT_TIMESTAMP
    WHERE "state" = 'colleague'
  `
  return waiting.map((row) => row.conversation_id)
}

/**
 * Claims the waiting chats whose hand-over wait has run out (one chat, or all
 * of them), moving each back to the assistant owed an apology. A chat is
 * returned by exactly one caller however many sweeps run at once, so the
 * apology goes once. They come back as `assistant`, not `auto`: with
 * colleagues still online and "<name> first" off, `auto` would send the
 * visitor's reply (their name and email) to the colleagues who did not come,
 * and nobody would take it down. A colleague replying still takes it over.
 */
export async function expireHandovers(conversationId: string | null = null): Promise<string[]> {
  const rows = conversationId
    ? await prisma.$queryRaw<Array<{ conversation_id: string }>>`
        UPDATE "aichat_conversations" SET
          "state" = 'assistant', "callback_wanted" = true, "waiting_since" = NULL, "waiting_until" = NULL, "updated_at" = CURRENT_TIMESTAMP
        WHERE "state" = 'waiting' AND "waiting_until" <= CURRENT_TIMESTAMP AND "conversation_id" = ${conversationId}
        RETURNING "conversation_id"
      `
    : await prisma.$queryRaw<Array<{ conversation_id: string }>>`
        UPDATE "aichat_conversations" SET
          "state" = 'assistant', "callback_wanted" = true, "waiting_since" = NULL, "waiting_until" = NULL, "updated_at" = CURRENT_TIMESTAMP
        WHERE "state" = 'waiting' AND "waiting_until" <= CURRENT_TIMESTAMP
        RETURNING "conversation_id"
      `
  return rows.map((row) => row.conversation_id)
}

/** Live Chat's Online switch as it stands now (a plain read of its settings
 *  row: this module requires Live Chat). Read at the start of every turn
 *  rather than trusting the value recorded at the last offer, which goes stale
 *  when the switch moves with no visitor writing - a catch-up after the switch
 *  went off, or a chat handed over by a colleague. No row means Live Chat's
 *  default, online; a failed read falls back to what the caller knew. */
export async function colleaguesOnlineNow(fallback: boolean): Promise<boolean> {
  try {
    const rows = await prisma.$queryRaw<Array<{ online: boolean }>>`
      SELECT "agent_online" AS "online" FROM "chat_settings" WHERE "id" = 'singleton' LIMIT 1
    `
    return rows[0] ? rows[0].online !== false : true
  } catch {
    return fallback
  }
}

/** Of these chats, the ones following the site rules. */
export async function autoChatsAmong(conversationIds: readonly string[]): Promise<string[]> {
  if (conversationIds.length === 0) return []
  const rows = await prisma.$queryRaw<Array<{ conversation_id: string }>>`
    SELECT "conversation_id" FROM "aichat_conversations"
    WHERE "conversation_id" = ANY(${[...conversationIds]}::text[]) AND "state" = 'auto'
  `
  return rows.map((row) => row.conversation_id)
}

// --- the record of what it did ----------------------------------------------

export async function addUsage(conversationId: string, usage: Omit<Usage, 'turns'>): Promise<void> {
  await prisma.$executeRaw`
    UPDATE "aichat_conversations" SET "usage" = jsonb_build_object(
      'input', COALESCE(("usage"->>'input')::bigint, 0) + ${usage.input},
      'cached', COALESCE(("usage"->>'cached')::bigint, 0) + ${usage.cached},
      'output', COALESCE(("usage"->>'output')::bigint, 0) + ${usage.output},
      'turns', COALESCE(("usage"->>'turns')::bigint, 0) + 1
    )
    WHERE "conversation_id" = ${conversationId}
  `
}

export async function appendToolLog(conversationId: string, entry: ToolLogEntry): Promise<void> {
  const json = JSON.stringify(entry)
  await prisma.$executeRaw`
    UPDATE "aichat_conversations" SET "tool_log" = "tool_log" || jsonb_build_array(${json}::jsonb)
    WHERE "conversation_id" = ${conversationId} AND jsonb_array_length("tool_log") < ${MAX_TOOL_LOG_ENTRIES}
  `
}
