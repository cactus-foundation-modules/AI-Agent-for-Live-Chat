import { findEmail, findName } from './contact-text'
import { notGenuineAskLine, notGenuineThanksLine } from './lines'

// ---------------------------------------------------------------------------
// What happens in a chat flagged as not genuine (lib/spam.ts, or the model's
// flag_not_genuine tool). The owner's rule, exactly:
//
//   - On flagging, the assistant says it is passing the chat to a colleague
//     and asks for a name and email. That is the first ask.
//   - Each later visitor message: an email address in it (and a name, if one
//     is there) is saved as a callback, a colleague is asked for, the chat goes
//     quiet and the visitor is thanked.
//   - Otherwise it asks again, up to three asks in all. After the third goes
//     unanswered: a colleague is asked for, the chat goes quiet, and nothing
//     more is said.
//
// When the chat already holds their email address (Live Chat's contact box),
// it is never asked for: the callback is saved with it straight away and the
// visitor told a colleague will reply by email. Learned on a live chat, where a
// visitor who had given their address was asked for it three times.
//
// Fixed lines, no model, no cost. The chat is never ended and there is no
// cooling-off: the visitor can still write, and a colleague still sees it.
//
// Pure: the decision only. lib/turn-runner.ts carries it out.
// ---------------------------------------------------------------------------

export const NOT_GENUINE_MAX_ASKS = 3

export type NotGenuineStep =
  | { kind: 'save'; email: string; name: string | null; reply: string }
  | { kind: 'ask'; asks: number; reply: string }
  | { kind: 'give_up' }

/** The contact details Live Chat's own box already holds for this chat. */
export type KnownContact = { name: string | null; email: string | null }

/** What to do the moment a chat is flagged: with an email already given, save
 *  it and say so; otherwise the first ask. */
export function notGenuineOnFlag(known: KnownContact): NotGenuineStep {
  const email = known.email?.trim()
  if (email) return { kind: 'save', email, name: known.name?.trim() || null, reply: notGenuineThanksLine(null) }
  return { kind: 'ask', asks: 1, reply: notGenuineAskLine(1) }
}

/** `asksSoFar`: how many times the visitor has already been asked (1 once the
 *  chat is flagged). `text`: everything they have written since the last ask.
 *  `known`: what Live Chat's contact box holds, which counts as given. */
export function notGenuineStep(asksSoFar: number, text: string, known: KnownContact = { name: null, email: null }): NotGenuineStep {
  const email = findEmail(text) ?? (known.email?.trim() || null)
  if (email) {
    const name = findName(text) ?? (known.name?.trim() || null)
    return { kind: 'save', email, name, reply: notGenuineThanksLine(name) }
  }
  if (asksSoFar >= NOT_GENUINE_MAX_ASKS) return { kind: 'give_up' }
  const asks = Math.max(asksSoFar, 0) + 1
  return { kind: 'ask', asks, reply: notGenuineAskLine(asks) }
}
