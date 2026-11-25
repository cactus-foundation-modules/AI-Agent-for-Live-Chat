import { notGenuineFirstLine, notGenuineLastLine } from './lines'

// ---------------------------------------------------------------------------
// What happens in a chat that is not a genuine enquiry (lib/spam.ts, or the
// model's flag_not_genuine tool). Two strikes:
//
//   - The first time, the assistant says one calm, fixed line - it is here to
//     help with the shop - and carries on: the visitor's next message is
//     answered as normal, so somebody who was only blowing off steam, or
//     testing, gets helped.
//   - A second time in the same chat, it says a short closing line and goes
//     quiet. A colleague still sees the chat in the list.
//
// Never a callback and never a colleague fetched: nobody asked for either.
// Learned on a live chat, where stepping back saved a callback with the email
// from the contact box and told the visitor "I have passed this to a
// colleague", which they had not asked for and did not want, and a colleague's
// "we have stepped away" notice followed it.
//
// Fixed lines, no model, no cost. The chat is never ended.
//
// Pure: the decision only. lib/turn-runner.ts carries it out.
// ---------------------------------------------------------------------------

export type NotGenuineStep =
  | { kind: 'warn'; reply: string }
  | { kind: 'step_back'; reply: string }

/** What to do when a chat is flagged. `alreadyWarned`: it was flagged before
 *  in this chat and the visitor has had the first line. */
export function notGenuineOnFlag(alreadyWarned: boolean, businessName: string): NotGenuineStep {
  return alreadyWarned
    ? { kind: 'step_back', reply: notGenuineLastLine() }
    : { kind: 'warn', reply: notGenuineFirstLine(businessName) }
}
