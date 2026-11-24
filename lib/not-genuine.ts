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

/** `asksSoFar`: how many times the visitor has already been asked (1 once the
 *  chat is flagged). `text`: everything they have written since the last ask. */
export function notGenuineStep(asksSoFar: number, text: string): NotGenuineStep {
  const email = findEmail(text)
  if (email) {
    const name = findName(text)
    return { kind: 'save', email, name, reply: notGenuineThanksLine(name) }
  }
  if (asksSoFar >= NOT_GENUINE_MAX_ASKS) return { kind: 'give_up' }
  const asks = Math.max(asksSoFar, 0) + 1
  return { kind: 'ask', asks, reply: notGenuineAskLine(asks) }
}
