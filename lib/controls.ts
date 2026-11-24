import type { ChatState } from './constants'
import type { HandAction } from './routing'

// What the controls in a chat's header show: a short pill saying who is
// answering, and the one button that changes it. Pure and import-free (types
// aside), so the browser can use it and a test can pin it.

export type ChatControl = {
  /** The pill, or null for none. */
  pill: string | null
  /** The button, or null for none. A colleague takes a chat over simply by
   *  replying, so there is never a "take over" button. */
  action: { kind: HandAction; label: string } | null
}

/** Whole minutes since a moment, for "Waiting for a colleague 2 min". */
export function minutesSince(since: Date | null, now: Date): number {
  if (!since) return 0
  return Math.max(0, Math.floor((now.getTime() - since.getTime()) / 60_000))
}

export function chatControl(input: { state: ChatState; name: string; aiFirst: boolean; waitingSince: Date | null; now: Date }): ChatControl {
  const { name } = input
  switch (input.state) {
    case 'auto':
      return input.aiFirst
        ? { pill: `${name} answering`, action: null }
        : { pill: null, action: { kind: 'hand', label: `Hand to ${name}` } }
    case 'assistant':
      return { pill: `${name} answering`, action: null }
    case 'colleague':
      return { pill: 'Colleague answering', action: { kind: 'hand_back', label: `Hand back to ${name}` } }
    case 'waiting':
      return {
        pill: `Waiting for a colleague ${minutesSince(input.waitingSince, input.now)} min`,
        action: { kind: 'hand_back', label: `Hand back to ${name}` },
      }
    case 'not_genuine':
      return { pill: 'Asking for contact details', action: { kind: 'hand', label: `Hand to ${name}` } }
    case 'quiet':
      return { pill: 'Stepped back', action: { kind: 'hand', label: `Hand to ${name}` } }
  }
}
