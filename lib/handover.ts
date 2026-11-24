import { ChatEndedError, postResponderMessage } from '@/modules/chat/lib/responder-api'
import { AUTHOR_ID } from './constants'
import { expireHandovers } from './conversations'
import { comeBackLine } from './lines'
import { getCachedSettings } from './settings'

// ---------------------------------------------------------------------------
// The hand-over clock. When the assistant hands a chat to a colleague while
// somebody is online, the chat waits (state `waiting`) for the hand-over wait
// set on the settings screen. Nobody replying by then, the assistant comes
// back: it says sorry and asks for a name and email, and its next turn takes
// them down (callback_wanted, passed to the model).
//
// Two things watch the clock. A timer in this server process fires on time;
// it is unreferenced, so it never holds a process open, and it dies with the
// process. The manifest's cron job (every two minutes) sweeps up whatever a
// restart or another server dropped. Both go through expireHandovers, one
// conditional UPDATE that hands each chat to exactly one of them, so the
// apology goes once.
// ---------------------------------------------------------------------------

const timers = new Map<string, ReturnType<typeof setTimeout>>()

/** A beat after the deadline, so the database agrees it has passed. */
export const TIMER_SLACK_MS = 500

export function handoverDelayMs(until: Date, now: number): number {
  return Math.max(0, until.getTime() - now) + TIMER_SLACK_MS
}

/** Starts (or restarts) this chat's clock in this process. */
export function scheduleHandoverCheck(conversationId: string, until: Date | null, now: number = Date.now()): void {
  if (!until) return
  const existing = timers.get(conversationId)
  if (existing) clearTimeout(existing)
  const timer = setTimeout(() => {
    timers.delete(conversationId)
    sweepHandovers(conversationId).catch((err: unknown) => {
      console.error('[ai-agent-for-live-chat] the hand-over check failed', err)
    })
  }, handoverDelayMs(until, now))
  timer.unref?.()
  timers.set(conversationId, timer)
}

/** Tells the visitor the assistant is back, and why. Quietly does nothing on
 *  an ended chat, or with the assistant switched off since. */
export async function comeBack(conversationId: string, reason: 'timeout' | 'offline'): Promise<void> {
  const settings = await getCachedSettings()
  if (settings.mode === 'off') return
  try {
    await postResponderMessage({ conversationId, authorId: AUTHOR_ID, authorName: settings.assistantName, body: comeBackLine(reason) })
  } catch (err) {
    if (err instanceof ChatEndedError) return
    throw err
  }
}

/** Brings back every waiting chat whose wait has run out (or just this one).
 *  Returns how many came back. */
export async function sweepHandovers(conversationId: string | null = null): Promise<number> {
  const expired = await expireHandovers(conversationId)
  for (const id of expired) {
    await comeBack(id, 'timeout').catch((err: unknown) => {
      console.error('[ai-agent-for-live-chat] could not tell a visitor the hand-over ran out', err)
    })
  }
  return expired.length
}
