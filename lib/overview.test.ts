import { describe, expect, it, vi } from 'vitest'
import { AUTHOR_ID } from './constants'
import { parseConversationRow } from './conversation-row'
import { overviewInput, overviewIsCurrent, writeOverview } from './overview'

describe('overviewIsCurrent', () => {
  const row = (overview: string, id: number) => parseConversationRow({ conversation_id: 'c1', overview, overview_message_id: BigInt(id) })

  it('reuses an overview that covers the newest message', () => {
    expect(overviewIsCurrent(row('They wanted a desk.', 12), 12)).toBe(true)
  })

  it('writes a fresh one once a newer message arrives, or when there is none', () => {
    expect(overviewIsCurrent(row('They wanted a desk.', 12), 13)).toBe(false)
    expect(overviewIsCurrent(row('', 0), 0)).toBe(false)
    expect(overviewIsCurrent(null, 1)).toBe(false)
  })
})

describe('overviewInput', () => {
  it('says who said what, and what the assistant did', () => {
    const row = parseConversationRow({
      conversation_id: 'c1',
      state: 'waiting',
      callback_wanted: true,
      verified_orders: ['DW1'],
      tool_log: [{ tool: 'lookup_order', at: '', ms: 1, args: 'matched', ok: true }],
    })
    const text = overviewInput([
      { id: 1, sender: 'visitor', authorId: null, authorName: null, body: 'Where is my order?', attachments: [] },
      { id: 2, sender: 'agent', authorId: AUTHOR_ID, authorName: 'Charlie', body: 'It is on its way.', attachments: [] },
      { id: 3, sender: 'agent', authorId: 'user_1', authorName: 'Sam', body: 'Sam here.', attachments: [] },
    ], row, AUTHOR_ID)
    expect(text).toContain('Visitor: Where is my order?')
    expect(text).toContain('Assistant: It is on its way.')
    expect(text).toContain('Colleague Sam: Sam here.')
    expect(text).toContain('- lookup_order (matched)')
    expect(text).toContain('Orders proved in the chat: DW1')
    expect(text).toContain('owed a callback')
  })
})

describe('writeOverview', () => {
  it('makes one call with no tools and keeps em dashes out', async () => {
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>
      expect(body.tools).toBeUndefined()
      return new Response(JSON.stringify({ output: [{ type: 'message', content: [{ type: 'output_text', text: 'They wanted a desk \u2014 sorted.' }] }] }), { status: 200 })
    })
    const text = await writeOverview({ apiKey: 'sk', model: 'gpt-6-luna', text: 'CHAT', fetchImpl })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(text).toBe('They wanted a desk - sorted.')
  })
})
