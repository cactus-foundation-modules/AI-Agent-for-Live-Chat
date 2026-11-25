import type { z } from 'zod'
import type { FileRef } from '../attachments'
import type { ConversationRow } from '../conversation-row'
import type { DiscussedProduct } from '../discussed-products'
import type { AiChatSettings } from '../settings-model'

// ---------------------------------------------------------------------------
// The assistant's tools: what the model may ask the site to do, and how each
// request is checked and carried out.
//
// One shape for every tool. A tool is defined once (defineTool) with its name,
// what the model is told about it, a JSON schema for the model, a Zod schema
// the arguments are actually checked against, and the handler. The list the
// model sees is built from the registered tools in their fixed order, so the
// start of every request stays byte-for-byte the same and OpenAI can read it
// from its prompt cache.
//
// To add a tool: write it with defineTool and add it to the list in
// lib/tools/index.ts. Nothing else changes - the runner, the log and the
// request are all driven by the list.
//
// Pure apart from what the handlers themselves do.
// ---------------------------------------------------------------------------

/** What every tool is handed about the chat it is working in. */
export type ToolContext = {
  conversationId: string
  settings: AiChatSettings
  /** The chat's row as it stood when the turn began. */
  row: ConversationRow
  /** The signed-in site member who started the chat, if any. Their own
   *  orders are theirs to ask about; nobody else's are. */
  member: { id: string; email: string | null } | null
  /** The person chatting is a signed-in colleague testing (Staff only). */
  staff: boolean
  /** Live Chat's Online switch as of the newest message. */
  online: boolean
  /** Live Chat's visitor id for the chat, when it has one: what the hourly
   *  limits count against (lib/order-state.ts). */
  visitorId: string | null
  /** The name, email and phone the visitor gave Live Chat's own form, if any. */
  visitorName: string | null
  visitorEmail: string | null
  visitorPhone: string | null
  /** Everything the visitor has typed in this chat, joined. An email address
   *  the model passes is only used if the visitor really wrote it. */
  visitorText: string
  /** Pictures the visitor sent in this chat that can go into a damage
   *  report, newest first. */
  photos: readonly FileRef[]
  /** This chat's proved orders, failed checks and emails, kept up to date as
   *  the tools run so a second call in one turn sees the first. */
  orders: ChatOrders
  /** Texts this chat has sent, kept up to date as the tools run. */
  textsSent: number
  /** The products this chat has been about, newest last, kept up to date as
   *  the product tools run (lib/discussed-products.ts). */
  products: DiscussedProduct[]
  /** What the tools did this turn that the turn runner acts on afterwards. */
  effects: TurnEffects
}

export type ChatOrders = { verified: string[]; failedChecks: number; emailsSent: number }

export type TurnEffects = {
  /** Set by flag_not_genuine: the reason. Ends the turn; the fixed lines take
   *  over from the model. */
  notGenuine: string | null
  /** The chat was handed to a colleague this turn. */
  handedOver: boolean
  /** A callback was saved this turn. */
  callbackSaved: boolean
}

export function noEffects(): TurnEffects {
  return { notGenuine: null, handedOver: false, callbackSaved: false }
}

export type ToolResult = Record<string, unknown>

/** The JSON schema the model is shown. Kept as plain data. */
export type ToolParameters = {
  type: 'object'
  properties: Record<string, unknown>
  required: string[]
  additionalProperties: false
}

export type ToolSpec<T> = {
  name: string
  /** What the model is told the tool does and when to use it. */
  description: string
  parameters: ToolParameters
  /** The real check on what the model sends. */
  input: z.ZodType<T, z.ZodTypeDef, unknown>
  /** A line added to the standing instructions, for rules that are about the
   *  conversation rather than the call itself. Settings-free, so it caches. */
  guidance?: string
  /** One short line for the log, written once the tool has run (result null
   *  when it threw). Defaults to the arguments, trimmed. A tool that handles
   *  personal details says what happened instead, never what it was given. */
  summarise?: (args: T, result: ToolResult | null) => string
  /** Whether a result ends the turn at once, nothing more from the model. */
  stopsTurn?: (result: ToolResult) => boolean
  handler: (ctx: ToolContext, args: T) => Promise<ToolResult>
}

export type ToolRun = {
  result: ToolResult
  /** False when the arguments did not check out, the tool refused, or it threw. */
  ok: boolean
  summary: string
  stop: boolean
}

export type RegisteredTool = {
  name: string
  description: string
  parameters: ToolParameters
  guidance?: string
  run: (ctx: ToolContext, args: unknown) => Promise<ToolRun>
}

/** A Responses API function tool. Strict mode is off: tools may have optional
 *  fields, which strict schemas do not allow, and Zod checks everything anyway. */
export type FunctionTool = {
  type: 'function'
  name: string
  description: string
  parameters: ToolParameters
  strict: false
}

const SUMMARY_MAX = 200

/** key: value pairs, each value cut short, for the log. */
export function summariseArgs(args: unknown): string {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return ''
  const parts = Object.entries(args as Record<string, unknown>).map(([key, value]) => {
    const text = typeof value === 'string' ? value : JSON.stringify(value)
    return `${key}: ${text && text.length > 60 ? `${text.slice(0, 60)}…` : text}`
  })
  const joined = parts.join(', ')
  return joined.length > SUMMARY_MAX ? `${joined.slice(0, SUMMARY_MAX)}…` : joined
}

export const BAD_INPUT: ToolResult = { ok: false, message: 'Those details did not look right. Check them against the tool description and try again.' }
export const TOOL_FAILED: ToolResult = { ok: false, message: 'That did not work just now. Do not try again in this reply; tell the visitor plainly and offer to fetch a colleague.' }

export function defineTool<T>(spec: ToolSpec<T>): RegisteredTool {
  return {
    name: spec.name,
    description: spec.description,
    parameters: spec.parameters,
    guidance: spec.guidance,
    async run(ctx, raw) {
      const parsed = spec.input.safeParse(raw)
      if (!parsed.success) return { result: BAD_INPUT, ok: false, summary: summariseArgs(raw), stop: false }
      const summaryOf = (result: ToolResult | null) =>
        spec.summarise ? spec.summarise(parsed.data, result).slice(0, SUMMARY_MAX) : summariseArgs(parsed.data)
      try {
        const result = await spec.handler(ctx, parsed.data)
        return { result, ok: result.ok !== false, summary: summaryOf(result), stop: spec.stopsTurn?.(result) === true }
      } catch (err) {
        console.error(`[ai-agent-for-live-chat] the ${spec.name} tool failed`, err)
        return { result: TOOL_FAILED, ok: false, summary: summaryOf(null), stop: false }
      }
    },
  }
}

/** The tools as the model is shown them, in the registry's own order. */
export function functionTools(tools: readonly RegisteredTool[]): FunctionTool[] {
  return tools.map((tool) => ({ type: 'function', name: tool.name, description: tool.description, parameters: tool.parameters, strict: false }))
}

/** Arguments arrive as a JSON string; anything that is not an object is no
 *  arguments at all, which the tool's own check then refuses or accepts. */
export function parseArguments(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown
  } catch {
    return null
  }
}

export type Dispatched = ToolRun & { tool: string; ms: number }

/** Runs one call the model made. Never throws: an unknown tool, bad arguments
 *  and a failing handler all come back as a result the model can read. */
export async function dispatchTool(
  tools: readonly RegisteredTool[],
  name: string,
  rawArguments: string,
  ctx: ToolContext,
  now: () => number = Date.now,
): Promise<Dispatched> {
  const started = now()
  const tool = tools.find((t) => t.name === name)
  if (!tool) {
    return { tool: name, result: { ok: false, message: `There is no tool called ${name}.` }, ok: false, summary: '', stop: false, ms: 0 }
  }
  const run = await tool.run(ctx, parseArguments(rawArguments))
  return { ...run, tool: name, ms: Math.max(0, Math.round(now() - started)) }
}
