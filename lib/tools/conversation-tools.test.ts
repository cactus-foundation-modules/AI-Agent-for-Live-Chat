import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fakeContext } from './fake-context'
import type { ToolContext } from './registry'

const chat = vi.hoisted(() => ({ askForColleague: vi.fn(async () => true) }))
const db = vi.hoisted(() => ({ enterWaiting: vi.fn(async () => new Date('2026-11-24T12:03:00Z')), setCallbackWanted: vi.fn() }))
const timer = vi.hoisted(() => ({ scheduleHandoverCheck: vi.fn() }))
const callbacks = vi.hoisted(() => ({ saveCallback: vi.fn(async () => 'cb1') }))
const unanswered = vi.hoisted(() => ({ recordUnanswered: vi.fn() }))

vi.mock('@/modules/chat/lib/responder-api', () => chat)
vi.mock('../conversations', () => db)
vi.mock('../handover', () => timer)
vi.mock('../callbacks', () => callbacks)
vi.mock('../unanswered', () => unanswered)

const { flagNotGenuine, handToColleague, noteUnanswered, saveCallbackTool } = await import('./conversation-tools')
const { dispatchTool } = await import('./registry')
// The 2a tools on their own: the full list (lib/tools/index.ts) reaches the
// shop and is pinned in tool-list.test.ts.
const TOOLS = [handToColleague, flagNotGenuine, saveCallbackTool, noteUnanswered]

function ctx(over: Partial<ToolContext> = {}, state = 'auto'): ToolContext {
  return fakeContext(over, state)
}

beforeEach(() => vi.clearAllMocks())

describe('hand_to_colleague', () => {
  it('with somebody online: asks for a colleague, starts the clock and tells the model what to say', async () => {
    const c = ctx()
    const done = await dispatchTool(TOOLS, 'hand_to_colleague', '{"reason":"wants a person"}', c)
    expect(done.ok).toBe(true)
    expect(chat.askForColleague).toHaveBeenCalledWith('c1')
    expect(db.enterWaiting).toHaveBeenCalledWith('c1', 180)
    expect(timer.scheduleHandoverCheck).toHaveBeenCalledWith('c1', new Date('2026-11-24T12:03:00Z'))
    expect(c.effects.handedOver).toBe(true)
    expect(String(done.result.message)).toMatch(/fetching a colleague/)
  })

  it('with nobody in: hands nothing over and has the model take details instead', async () => {
    const done = await dispatchTool(TOOLS, 'hand_to_colleague', '{"reason":"x"}', ctx({ online: false }))
    expect(done.ok).toBe(false)
    expect(done.result.nobodyIn).toBe(true)
    expect(chat.askForColleague).not.toHaveBeenCalled()
    expect(db.setCallbackWanted).toHaveBeenCalledWith('c1', true)
    expect(String(done.result.message)).toMatch(/name and email/)
  })

  it('does not ask twice', async () => {
    await dispatchTool(TOOLS, 'hand_to_colleague', '{"reason":"x"}', ctx({}, 'waiting'))
    expect(chat.askForColleague).not.toHaveBeenCalled()
  })
})

describe('flag_not_genuine', () => {
  it('ends the turn and leaves the reason for the runner', async () => {
    const c = ctx()
    const done = await dispatchTool(TOOLS, 'flag_not_genuine', '{"reason":"abuse"}', c)
    expect(done.stop).toBe(true)
    expect(c.effects.notGenuine).toBe('abuse')
  })
})

describe('save_callback', () => {
  it('saves a callback with a real-looking address', async () => {
    const c = ctx()
    const done = await dispatchTool(TOOLS, 'save_callback', '{"name":"Sam","email":"sam@example.com","about":"A quote for ten desks"}', c)
    expect(done.ok).toBe(true)
    expect(callbacks.saveCallback).toHaveBeenCalledWith({ conversationId: 'c1', name: 'Sam', email: 'sam@example.com', about: 'A quote for ten desks', source: 'tool' })
    expect(db.setCallbackWanted).toHaveBeenCalledWith('c1', false)
    expect(c.effects.callbackSaved).toBe(true)
    expect(done.summary).not.toContain('sam@example.com')
  })

  it('refuses an address that is not one', async () => {
    const done = await dispatchTool(TOOLS, 'save_callback', '{"name":"Sam","email":"sam at example","about":""}', ctx())
    expect(done.ok).toBe(false)
    expect(callbacks.saveCallback).not.toHaveBeenCalled()
  })
})

describe('note_unanswered', () => {
  it('records the question', async () => {
    const done = await dispatchTool(TOOLS, 'note_unanswered', '{"question":"Do you ship to Jersey?"}', ctx())
    expect(done.ok).toBe(true)
    expect(unanswered.recordUnanswered).toHaveBeenCalledWith('c1', 'Do you ship to Jersey?')
  })
})
