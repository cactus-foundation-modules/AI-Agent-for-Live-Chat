import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { fakeContext } from './fake-context'
import { BAD_INPUT, TOOL_FAILED, defineTool, dispatchTool, functionTools, parseArguments, summariseArgs, type ToolContext } from './registry'

function ctx(): ToolContext {
  return fakeContext()
}

const echo = defineTool({
  name: 'echo',
  description: 'Says it back.',
  parameters: { type: 'object', properties: { word: { type: 'string' } }, required: ['word'], additionalProperties: false },
  input: z.object({ word: z.string().min(1) }),
  guidance: 'Echo when asked.',
  async handler(_ctx, args) {
    return { ok: true, said: args.word }
  },
})

const stopper = defineTool({
  name: 'stopper',
  description: 'Ends the turn.',
  parameters: { type: 'object', properties: {}, required: [], additionalProperties: false },
  input: z.object({}),
  stopsTurn: () => true,
  async handler(c) {
    c.effects.notGenuine = 'testing'
    return { ok: true }
  },
})

const broken = defineTool({
  name: 'broken',
  description: 'Always throws.',
  parameters: { type: 'object', properties: {}, required: [], additionalProperties: false },
  input: z.object({}),
  async handler() {
    throw new Error('boom')
  },
})

const refuses = defineTool({
  name: 'refuses',
  description: 'Says no.',
  parameters: { type: 'object', properties: {}, required: [], additionalProperties: false },
  input: z.object({}),
  summarise: () => 'custom summary',
  async handler() {
    return { ok: false, message: 'no' }
  },
})

const TOOLS = [echo, stopper, broken, refuses]

describe('the tool registry', () => {
  it('shows the model every tool, in the registry\'s order, as Responses function tools', () => {
    const shown = functionTools(TOOLS)
    expect(shown.map((t) => t.name)).toEqual(['echo', 'stopper', 'broken', 'refuses'])
    expect(shown[0]).toEqual({ type: 'function', name: 'echo', description: 'Says it back.', parameters: echo.parameters, strict: false })
    expect(echo.guidance).toBe('Echo when asked.')
  })

  it('dispatches by name, checks the arguments and times the call', async () => {
    let clock = 1_000
    const done = await dispatchTool(TOOLS, 'echo', '{"word":"hello"}', ctx(), () => (clock += 25))
    expect(done).toEqual({ tool: 'echo', result: { ok: true, said: 'hello' }, ok: true, summary: 'word: hello', stop: false, ms: 25 })
  })

  it('refuses arguments that do not check out, without running the tool', async () => {
    const handler = vi.fn()
    const guarded = defineTool({ ...{ name: 'g', description: '', parameters: echo.parameters }, input: z.object({ word: z.string().min(1) }), handler })
    const done = await dispatchTool([guarded], 'g', '{"word":""}', ctx())
    expect(done.ok).toBe(false)
    expect(done.result).toEqual(BAD_INPUT)
    expect(handler).not.toHaveBeenCalled()
    expect((await dispatchTool([guarded], 'g', 'not json', ctx())).result).toEqual(BAD_INPUT)
  })

  it('answers an unknown tool with a result the model can read', async () => {
    const done = await dispatchTool(TOOLS, 'nope', '{}', ctx())
    expect(done.ok).toBe(false)
    expect(done.result.message).toMatch(/no tool called nope/)
  })

  it('turns a throwing tool into a failure result rather than an exception', async () => {
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const done = await dispatchTool(TOOLS, 'broken', '{}', ctx())
    expect(done).toMatchObject({ ok: false, result: TOOL_FAILED, stop: false })
    quiet.mockRestore()
  })

  it('reports a refusal as not ok, and uses a tool\'s own summary', async () => {
    const done = await dispatchTool(TOOLS, 'refuses', '{}', ctx())
    expect(done).toMatchObject({ ok: false, summary: 'custom summary' })
  })

  it('lets a tool end the turn and leave effects for the runner', async () => {
    const c = ctx()
    const done = await dispatchTool(TOOLS, 'stopper', '{}', c)
    expect(done.stop).toBe(true)
    expect(c.effects.notGenuine).toBe('testing')
  })
})

describe('helpers', () => {
  it('summarises arguments briefly', () => {
    expect(summariseArgs({ a: 'x', b: 2 })).toBe('a: x, b: 2')
    expect(summariseArgs({ long: 'y'.repeat(100) })).toBe(`long: ${'y'.repeat(60)}…`)
    expect(summariseArgs(null)).toBe('')
  })

  it('parses arguments, and gives null for nonsense', () => {
    expect(parseArguments('{"a":1}')).toEqual({ a: 1 })
    expect(parseArguments('{')).toBeNull()
  })
})
