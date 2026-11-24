import type { ConversationRow } from './conversation-row'
import type { TranscriptLine } from './model-input'
import { createResponse, type FetchLike } from './openai'

// ---------------------------------------------------------------------------
// The written overview colleagues read at the top of Notes: what the visitor
// wanted, what was checked, how it ended, and any callback owed.
//
// Written on demand, when somebody opens Notes, by one cheap model call with
// no tools, and kept on the chat's row with the id of the newest message it
// covered. Opening Notes again reuses it until a newer message arrives, so a
// chat read ten times costs one overview, not ten.
//
// Colleagues only: it is never shown to the visitor, and it is written from
// the chat itself plus the assistant's tool log, whose lines already leave
// personal details out.
// ---------------------------------------------------------------------------

export const OVERVIEW_MAX_OUTPUT_TOKENS = 500
/** The transcript given to the overview, newest last, at most this long. */
const TRANSCRIPT_CHARS = 12_000

/** Whether the stored overview still covers the chat. Pure. */
export function overviewIsCurrent(row: Pick<ConversationRow, 'overview' | 'overviewMessageId'> | null, newestMessageId: number): boolean {
  if (!row || !row.overview.trim()) return false
  return row.overviewMessageId >= newestMessageId
}

const OVERVIEW_INSTRUCTIONS = `You write a short overview of a website live chat for the shop's staff, who will read it before picking the chat up or getting back to the visitor.
Write three to five short plain sentences, no headings, no lists, no em dashes, in British English:
- what the visitor wanted;
- what was looked up or checked (products, an order, delivery), and what was found;
- how it ended: answered, handed to a colleague, a request raised, an email sent, or still open;
- any callback owed, and what it is about.
Only state what the chat and the log show. Do not quote email addresses, phone numbers or street addresses. If the chat is only a greeting, say so in one sentence.`

/** The chat as plain lines for the overview: who said what, then what the
 *  assistant did. Pure. */
export function overviewInput(
  messages: readonly TranscriptLine[],
  row: Pick<ConversationRow, 'toolLog' | 'verifiedOrders' | 'callbackWanted' | 'state'> | null,
  ownAuthorId: string,
): string {
  const lines: string[] = []
  for (const message of messages) {
    const body = message.body.trim()
    const files = message.attachments.length > 0 ? ` [sent ${message.attachments.length} file(s)]` : ''
    if (!body && !files) continue
    const who = message.sender === 'visitor'
      ? 'Visitor'
      : message.sender === 'system'
        ? 'Note'
        : message.authorId === ownAuthorId
          ? 'Assistant'
          : message.authorId === null
            ? 'Automatic message'
            : `Colleague ${message.authorName?.trim() || ''}`.trim()
    lines.push(`${who}: ${body}${files}`)
  }
  let transcript = lines.join('\n')
  if (transcript.length > TRANSCRIPT_CHARS) transcript = `[earlier messages left out]\n${transcript.slice(-TRANSCRIPT_CHARS)}`
  const log = (row?.toolLog ?? []).map((entry) => `- ${entry.tool}${entry.args ? ` (${entry.args})` : ''}${entry.ok ? '' : ' - did not work'}`)
  const facts = [
    row?.verifiedOrders.length ? `Orders proved in the chat: ${row.verifiedOrders.join(', ')}` : '',
    row?.callbackWanted ? 'The visitor is owed a callback.' : '',
    row ? `Who has the chat now: ${row.state}` : '',
  ].filter(Boolean)
  return [`CHAT\n${transcript || '(no messages)'}`, log.length > 0 ? `WHAT THE ASSISTANT DID\n${log.join('\n')}` : '', facts.join('\n')].filter(Boolean).join('\n\n')
}

/** One call, no tools. Throws OpenAiError when OpenAI says no. */
export async function writeOverview(input: { apiKey: string; model: string; text: string; fetchImpl?: FetchLike }): Promise<string> {
  const response = await createResponse(input.apiKey, {
    model: input.model,
    instructions: OVERVIEW_INSTRUCTIONS,
    input: [{ role: 'user', content: input.text }],
    reasoning: { effort: 'low' },
    text: { verbosity: 'low' },
    store: false,
    max_output_tokens: OVERVIEW_MAX_OUTPUT_TOKENS,
  }, input.fetchImpl)
  return response.text.replace(/\s*\u2014\s*/g, ' - ').trim()
}
