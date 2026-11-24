import type { ChatState, Mode } from './constants'

// ---------------------------------------------------------------------------
// Who answers a chat: the assistant or a colleague. The heart of the module,
// and pure - settings and the chat's state in, a decision out - so every
// branch is pinned by a test. lib/responder.ts reads what it needs, asks here,
// and writes what comes back.
//
// Two things decide it. The site rules: the mode (Off, Staff only, On), Live
// Chat's Online switch, and the "<name> first" switch. And the chat's own
// state, which moves as colleagues and the assistant hand it to each other:
//
//   auto        follows the site rules: answered when nobody is online, or
//               when "<name> first" is on
//   assistant   a colleague pressed "Hand to <name>": answered whatever the
//               switches say
//   colleague   a colleague replied: the assistant keeps out until handed it
//               back, or until the Online switch goes off (then auto again,
//               and it answers the visitor's next message, having read the
//               whole chat)
//   waiting     the assistant asked for a colleague while somebody was
//               online; visitor messages go to colleagues until one replies,
//               the hand-over wait runs out, or the switch goes off - then
//               the assistant comes back, apologises and takes a name and
//               email for a callback
//   not_genuine spam or time-wasting: fixed lines asking for a name and
//               email, three times at most (lib/not-genuine.ts)
//   quiet       the assistant has stepped back from this chat for good
// ---------------------------------------------------------------------------

export type OfferInput = {
  mode: Mode
  /** The person sending is a signed-in colleague with Live Chat's chat.view. */
  staff: boolean
  state: ChatState
  /** Live Chat's real Online switch. */
  online: boolean
  aiFirst: boolean
}

export type OfferDecision = {
  take: boolean
  /** The chat's state once the message is taken (or left). */
  state: ChatState
  /** How the reply is written: the model, or the fixed not-genuine lines. */
  flow: 'ai' | 'not_genuine' | null
  /** The visitor is owed an apology and a request for their details. */
  callbackWanted: boolean
}

const LEAVE = (state: ChatState): OfferDecision => ({ take: false, state, flow: null, callbackWanted: false })
const TAKE = (state: ChatState, callbackWanted = false): OfferDecision => ({ take: true, state, flow: 'ai', callbackWanted })

/** Whether the site rules let the assistant answer at all, for this sender. */
export function modeAllows(mode: Mode, staff: boolean): boolean {
  if (mode === 'off') return false
  if (mode === 'staff') return staff
  return true
}

/** Whether the assistant takes a visitor's message, and what the chat's state
 *  becomes. */
export function decideOffer(input: OfferInput): OfferDecision {
  if (!modeAllows(input.mode, input.staff)) return LEAVE(input.state)
  switch (input.state) {
    case 'auto':
      return !input.online || input.aiFirst ? TAKE('auto') : LEAVE('auto')
    case 'assistant':
      return TAKE('assistant')
    case 'colleague':
      // The colleague who took over has gone offline: back to the site rules,
      // and this message is the assistant's.
      return input.online ? LEAVE('colleague') : TAKE('auto')
    case 'waiting':
      // Nobody is left to pick it up. The assistant takes it back the way it
      // would when the wait runs out: sorry, and a name and email.
      return input.online ? LEAVE('waiting') : TAKE('auto', true)
    case 'not_genuine':
      return { take: true, state: 'not_genuine', flow: 'not_genuine', callbackWanted: false }
    case 'quiet':
      return LEAVE('quiet')
  }
}

export type AnsweringInput = {
  mode: Mode
  /** Whether the request is a signed-in colleague's; null when there is no
   *  request to read (a background job). */
  staff: boolean | null
  online: boolean
  aiFirst: boolean
}

/** Whether the assistant is answering visitors right now (Live Chat's
 *  `answeringAs`): it decides the visitor-facing online state while the switch
 *  is off, and whose name the welcome and basket messages go under. */
export function decideAnswering(input: AnsweringInput): boolean {
  if (input.mode === 'off') return false
  if (input.mode === 'staff' && input.staff !== true) return false
  return !input.online || input.aiFirst
}

/** A colleague replied in the chat. */
export function stateAfterColleagueReplied(state: ChatState): ChatState {
  return state === 'quiet' ? 'quiet' : 'colleague'
}

export type OfflineMove = {
  state: ChatState
  /** The visitor is owed an apology and a request for their details. */
  callbackWanted: boolean
}

/** The Online switch went off: what becomes of a chat in this state. */
export function stateWhenSwitchedOff(state: ChatState): OfflineMove {
  if (state === 'colleague') return { state: 'auto', callbackWanted: false }
  if (state === 'waiting') return { state: 'auto', callbackWanted: true }
  return { state, callbackWanted: false }
}

/** Whether the assistant looks after visitors left mid-chat when the switch
 *  goes off, so Live Chat skips its own "we have had to step away" message.
 *  Staff only does not answer the public, so it covers nobody. */
export function coversWhenSwitchedOff(mode: Mode, online: boolean): boolean {
  return !online && mode === 'on'
}

export type HandAction = 'hand' | 'hand_back'

/** What a colleague's "Hand to <name>" / "Hand back to <name>" sets. Handing
 *  back follows the site rules again when "<name> first" is on (it would answer
 *  anyway); otherwise the chat is the assistant's outright, or nobody would
 *  answer it while colleagues are online. */
export function stateForHand(action: HandAction, aiFirst: boolean): ChatState {
  if (action === 'hand_back' && aiFirst) return 'auto'
  return 'assistant'
}

/** A waiting chat whose hand-over wait has run out. */
export function handoverExpired(row: { state: ChatState; waitingUntil: Date | null }, now: Date): boolean {
  return row.state === 'waiting' && row.waitingUntil !== null && row.waitingUntil.getTime() <= now.getTime()
}
