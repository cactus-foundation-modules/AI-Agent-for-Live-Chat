import type { ChatState } from './constants'

// ---------------------------------------------------------------------------
// The small decisions a turn makes, kept pure so they are pinned by tests:
// how long to let the visitor finish typing, whether there is anything to
// answer, and which of their messages are new. lib/turn-runner.ts does the
// rest.
// ---------------------------------------------------------------------------

/** A visitor typing three short lines gets one reply: the turn waits until
 *  they have been quiet this long... */
export const DEBOUNCE_MS = 1_500
/** ...but never longer than this in all, so somebody typing non-stop still
 *  gets an answer. */
export const MAX_DEBOUNCE_MS = 6_000
/** "<name> is typing…" lasts about seven seconds per stamp in Live Chat, so it
 *  is stamped again this often while the reply is being written. */
export const TYPING_REFRESH_MS = 4_000
/** Turns run back to back for one chat at most this many times per wake-up;
 *  anything still left is picked up by the next message. */
export const MAX_TURN_LOOPS = 5
/** When the switch goes off, or a chat is handed over, a visitor message
 *  still waiting for an answer is answered - if it is no older than this. */
export const CATCH_UP_MAX_AGE_MS = 2 * 60 * 60 * 1000

/** How much longer to wait before answering; 0 means go now. */
export function debounceWaitMs(newestVisitorAt: Date | null, now: Date, startedAt: Date): number {
  if (!newestVisitorAt) return 0
  const quietFor = now.getTime() - newestVisitorAt.getTime()
  if (quietFor >= DEBOUNCE_MS) return 0
  const budget = MAX_DEBOUNCE_MS - (now.getTime() - startedAt.getTime())
  return Math.max(0, Math.min(DEBOUNCE_MS - quietFor, budget))
}

/** The states in which a taken message is still the assistant's to answer.
 *  Anything else means a colleague stepped in while the turn waited. */
export function stateAnswers(state: ChatState): boolean {
  return state === 'auto' || state === 'assistant' || state === 'not_genuine'
}

export function hasWork(row: { lastTakenMessageId: number; lastHandledMessageId: number }): boolean {
  return row.lastTakenMessageId > row.lastHandledMessageId
}

/** The visitor's messages the turn is answering: taken, not yet handled. */
export function newVisitorMessages<T extends { id: number; sender: string }>(
  messages: readonly T[],
  row: { lastTakenMessageId: number; lastHandledMessageId: number },
): T[] {
  return messages.filter((m) => m.sender === 'visitor' && m.id > row.lastHandledMessageId && m.id <= row.lastTakenMessageId)
}

/**
 * The visitor message to answer when a chat comes back to the assistant with
 * no new message to prompt it (the switch went off, a colleague handed it
 * over): the chat's last message, if it is the visitor's, not yet handled and
 * recent. Null when there is nothing waiting on an answer.
 */
export function catchUpMessage<T extends { id: number; sender: string; createdAt: Date }>(
  messages: readonly T[],
  lastHandledMessageId: number,
  now: Date,
  maxAgeMs: number = CATCH_UP_MAX_AGE_MS,
): T | null {
  const last = messages[messages.length - 1]
  if (!last || last.sender !== 'visitor') return null
  if (last.id <= lastHandledMessageId) return null
  if (now.getTime() - last.createdAt.getTime() > maxAgeMs) return null
  return last
}
