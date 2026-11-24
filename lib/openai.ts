import { z } from 'zod'
import type { InputItem } from './model-input'
import type { FunctionTool } from './tools/registry'

// ---------------------------------------------------------------------------
// The OpenAI side: one turn of the assistant through the Responses API, tool
// calls and all. Raw fetch, the same request shape and error handling as the
// phone assistant's GPT-Live backend.
//
// Nothing is stored at OpenAI (store: false). The model's reasoning is handed
// back to it, encrypted, between tool rounds, so it does not lose its train of
// thought while the site runs a tool.
//
// SERVER ONLY. Everything here holds the OpenAI key.
// ---------------------------------------------------------------------------

const API = 'https://api.openai.com/v1'

/** One request may take this long. A chat visitor waits, but not forever. */
export const REQUEST_TIMEOUT_MS = 45_000
/** Tool rounds in one turn before the model is told to just answer. */
export const MAX_TOOL_ROUNDS = 8
export const MAX_OUTPUT_TOKENS = 2_500
/** Routes this module's requests to the same cache, whichever chat they are. */
export const PROMPT_CACHE_KEY = 'ai-agent-for-live-chat'

export class OpenAiError extends Error {
  constructor(message: string, readonly status: number, readonly code: string | null = null) {
    super(message)
  }
}

export type TokenUsage = { input: number; cached: number; output: number }

export type FunctionCall = { callId: string; name: string; arguments: string }

export type ParsedResponse = {
  /** Every output item, exactly as given, to hand back on the next round. */
  output: unknown[]
  calls: FunctionCall[]
  text: string
  usage: TokenUsage
}

const Usage = z.object({
  input_tokens: z.number().optional(),
  output_tokens: z.number().optional(),
  input_tokens_details: z.object({ cached_tokens: z.number().optional() }).passthrough().optional(),
}).passthrough()

const Output = z.array(z.unknown())

const Body = z.object({
  output: Output.default([]),
  usage: Usage.optional(),
}).passthrough()

const CallItem = z.object({
  type: z.literal('function_call'),
  call_id: z.string().min(1),
  name: z.string().min(1),
  arguments: z.string().default('{}'),
}).passthrough()

const MessageItem = z.object({
  type: z.literal('message'),
  content: z.array(z.object({ type: z.string(), text: z.string().optional() }).passthrough()).default([]),
}).passthrough()

/** Reads a /responses body. Throws OpenAiError on something unreadable. */
export function parseResponse(json: unknown): ParsedResponse {
  const parsed = Body.safeParse(json)
  if (!parsed.success) throw new OpenAiError('OpenAI sent back something that could not be read', 502)
  const calls: FunctionCall[] = []
  const text: string[] = []
  for (const item of parsed.data.output) {
    const call = CallItem.safeParse(item)
    if (call.success) {
      calls.push({ callId: call.data.call_id, name: call.data.name, arguments: call.data.arguments })
      continue
    }
    const message = MessageItem.safeParse(item)
    if (message.success) {
      for (const part of message.data.content) if (part.type === 'output_text' && part.text) text.push(part.text)
    }
  }
  const usage = parsed.data.usage
  return {
    output: parsed.data.output,
    calls,
    text: text.join('').trim(),
    usage: {
      input: usage?.input_tokens ?? 0,
      cached: usage?.input_tokens_details?.cached_tokens ?? 0,
      output: usage?.output_tokens ?? 0,
    },
  }
}

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>

async function failure(res: Response): Promise<OpenAiError> {
  const body = await res.json().catch(() => null) as { error?: { message?: string; code?: string } } | null
  return new OpenAiError(`OpenAI refused the request: ${body?.error?.message ?? `HTTP ${res.status}`}`, res.status, body?.error?.code ?? null)
}

export async function createResponse(apiKey: string, body: Record<string, unknown>, fetchImpl: FetchLike = fetch): Promise<ParsedResponse> {
  const res = await fetchImpl(`${API}/responses`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    cache: 'no-store',
  })
  if (!res.ok) throw await failure(res)
  return parseResponse(await res.json().catch(() => null))
}

/** What the turn runner does with one tool call: the output for the model, and
 *  whether the turn ends there. */
export type ToolCallHandler = (call: FunctionCall) => Promise<{ output: string; stop: boolean }>

export type TurnOutcome =
  | { kind: 'reply'; text: string; usage: TokenUsage; rounds: number }
  | { kind: 'stopped'; usage: TokenUsage; rounds: number }

function addUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  return { input: a.input + b.input, cached: a.cached + b.cached, output: a.output + b.output }
}

/**
 * One turn: ask, run whatever tools the model calls, feed the results back,
 * until it writes its reply. After MAX_TOOL_ROUNDS rounds of tools it is asked
 * once more with tools switched off, so a turn always ends. A tool that says
 * stop ends the turn at once with no reply. Throws OpenAiError (or a fetch
 * error) when OpenAI cannot be reached or says no; an empty reply comes back
 * as an empty string for the caller to treat as a failure.
 */
export async function runTurn(input: {
  apiKey: string
  model: string
  instructions: string
  tools: FunctionTool[]
  conversation: InputItem[]
  onToolCall: ToolCallHandler
  fetchImpl?: FetchLike
  maxRounds?: number
}): Promise<TurnOutcome> {
  const maxRounds = input.maxRounds ?? MAX_TOOL_ROUNDS
  const items: unknown[] = [...input.conversation]
  let usage: TokenUsage = { input: 0, cached: 0, output: 0 }

  for (let round = 0; round <= maxRounds; round++) {
    const lastChance = round === maxRounds
    const response = await createResponse(input.apiKey, {
      model: input.model,
      instructions: input.instructions,
      input: items,
      tools: input.tools,
      tool_choice: lastChance ? 'none' : 'auto',
      parallel_tool_calls: true,
      reasoning: { effort: 'low' },
      text: { verbosity: 'low' },
      store: false,
      include: ['reasoning.encrypted_content'],
      max_output_tokens: MAX_OUTPUT_TOKENS,
      prompt_cache_key: PROMPT_CACHE_KEY,
    }, input.fetchImpl)
    usage = addUsage(usage, response.usage)

    if (response.calls.length === 0 || lastChance) return { kind: 'reply', text: response.text, usage, rounds: round + 1 }

    items.push(...response.output)
    for (const call of response.calls) {
      const { output, stop } = await input.onToolCall(call)
      if (stop) return { kind: 'stopped', usage, rounds: round + 1 }
      items.push({ type: 'function_call_output', call_id: call.callId, output })
    }
  }
  // Unreachable: the last round always returns. Kept so the types agree.
  return { kind: 'reply', text: '', usage, rounds: maxRounds + 1 }
}
