import { describe, expect, it } from 'vitest'
import { OpenAiError, parseResponse, runTurn, type FetchLike } from './openai'

function respond(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

const textReply = (text: string) => ({
  output: [{ type: 'reasoning', id: 'rs_1', encrypted_content: 'x' }, { type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] }],
  usage: { input_tokens: 1000, output_tokens: 20, input_tokens_details: { cached_tokens: 900 } },
})

const toolCall = (name: string, args: string, callId = 'call_1') => ({
  output: [{ type: 'reasoning', id: 'rs_0' }, { type: 'function_call', id: 'fc_1', call_id: callId, name, arguments: args }],
  usage: { input_tokens: 800, output_tokens: 10 },
})

describe('parseResponse', () => {
  it('reads the text, the calls and the usage', () => {
    expect(parseResponse(textReply('Hello'))).toMatchObject({ text: 'Hello', calls: [], usage: { input: 1000, cached: 900, output: 20 } })
    expect(parseResponse(toolCall('note_unanswered', '{"question":"x"}')).calls).toEqual([{ callId: 'call_1', name: 'note_unanswered', arguments: '{"question":"x"}' }])
  })

  it('refuses something that is not a response', () => {
    expect(() => parseResponse('nonsense')).toThrow(OpenAiError)
  })
})

describe('runTurn', () => {
  const base = { apiKey: 'sk', model: 'gpt-6-luna', instructions: 'Be good.', tools: [], conversation: [{ role: 'user' as const, content: 'Hi' }] }

  it('feeds tool results back until the model writes its reply, adding up the tokens', async () => {
    const bodies: Array<Record<string, unknown>> = []
    const replies = [toolCall('echo', '{"word":"a"}'), textReply('Done.')]
    const fetchImpl: FetchLike = async (_url, init) => {
      bodies.push(JSON.parse(String(init.body)) as Record<string, unknown>)
      return respond(replies.shift())
    }
    const seen: string[] = []
    const outcome = await runTurn({ ...base, fetchImpl, onToolCall: async (call) => { seen.push(call.name); return { output: '{"ok":true}', stop: false } } })
    expect(outcome).toEqual({ kind: 'reply', text: 'Done.', usage: { input: 1800, cached: 900, output: 30 }, rounds: 2 })
    expect(seen).toEqual(['echo'])
    const second = bodies[1]?.input as unknown[]
    expect(second).toContainEqual({ type: 'function_call_output', call_id: 'call_1', output: '{"ok":true}' })
    expect(second).toContainEqual({ type: 'reasoning', id: 'rs_0' })
    expect(bodies[0]).toMatchObject({ store: false, tool_choice: 'auto', instructions: 'Be good.', prompt_cache_key: 'ai-agent-for-live-chat' })
  })

  it('stops at once when a tool says so', async () => {
    const fetchImpl: FetchLike = async () => respond(toolCall('flag_not_genuine', '{"reason":"abuse"}'))
    const outcome = await runTurn({ ...base, fetchImpl, onToolCall: async () => ({ output: '{}', stop: true }) })
    expect(outcome.kind).toBe('stopped')
  })

  it('switches tools off for the last round, so a turn always ends', async () => {
    const choices: unknown[] = []
    const fetchImpl: FetchLike = async (_url, init) => {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>
      choices.push(body.tool_choice)
      return respond(body.tool_choice === 'none' ? textReply('Finally.') : toolCall('echo', '{}'))
    }
    const outcome = await runTurn({ ...base, fetchImpl, maxRounds: 2, onToolCall: async () => ({ output: '{}', stop: false }) })
    expect(choices).toEqual(['auto', 'auto', 'none'])
    expect(outcome).toMatchObject({ kind: 'reply', text: 'Finally.', rounds: 3 })
  })

  it('throws OpenAI\'s own message when it refuses', async () => {
    const fetchImpl: FetchLike = async () => respond({ error: { message: 'Incorrect API key', code: 'invalid_api_key' } }, 401)
    await expect(runTurn({ ...base, fetchImpl, onToolCall: async () => ({ output: '', stop: false }) })).rejects.toMatchObject({
      status: 401,
      code: 'invalid_api_key',
    })
  })
})
