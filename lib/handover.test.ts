import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_SETTINGS, type AiChatSettings } from './settings-model'

const chat = vi.hoisted(() => {
  class ChatEndedError extends Error {}
  return { ChatEndedError, postResponderMessage: vi.fn() }
})
const db = vi.hoisted(() => ({ expireHandovers: vi.fn(async (): Promise<string[]> => []) }))
const settings = vi.hoisted(() => ({ value: null as AiChatSettings | null }))

vi.mock('@/modules/chat/lib/responder-api', () => chat)
vi.mock('./conversations', () => db)
vi.mock('./settings', () => ({ getCachedSettings: async () => settings.value }))

const { TIMER_SLACK_MS, comeBack, handoverDelayMs, scheduleHandoverCheck, sweepHandovers } = await import('./handover')

beforeEach(() => {
  vi.clearAllMocks()
  settings.value = { ...DEFAULT_SETTINGS, mode: 'on', assistantName: 'Charlie' }
})

afterEach(() => {
  vi.useRealTimers()
})

describe('handoverDelayMs', () => {
  it('waits until just after the deadline, and never a negative time', () => {
    const now = Date.UTC(2026, 10, 24, 12, 0, 0)
    expect(handoverDelayMs(new Date(now + 180_000), now)).toBe(180_000 + TIMER_SLACK_MS)
    expect(handoverDelayMs(new Date(now - 5_000), now)).toBe(TIMER_SLACK_MS)
  })
})

describe('sweepHandovers', () => {
  it('apologises once to each chat it claimed, and to nobody else', async () => {
    db.expireHandovers.mockResolvedValueOnce(['c1', 'c2'])
    expect(await sweepHandovers()).toBe(2)
    expect(db.expireHandovers).toHaveBeenCalledWith(null)
    expect(chat.postResponderMessage).toHaveBeenCalledTimes(2)
    expect(chat.postResponderMessage).toHaveBeenCalledWith(expect.objectContaining({ conversationId: 'c1', authorId: 'module:ai-agent-for-live-chat', authorName: 'Charlie' }))
  })

  it('claims nothing, says nothing, when no wait has run out', async () => {
    expect(await sweepHandovers('c1')).toBe(0)
    expect(db.expireHandovers).toHaveBeenCalledWith('c1')
    expect(chat.postResponderMessage).not.toHaveBeenCalled()
  })

  it('carries on past an ended chat', async () => {
    db.expireHandovers.mockResolvedValueOnce(['gone', 'c2'])
    chat.postResponderMessage.mockRejectedValueOnce(new chat.ChatEndedError('ended'))
    expect(await sweepHandovers()).toBe(2)
    expect(chat.postResponderMessage).toHaveBeenCalledTimes(2)
  })
})

describe('comeBack', () => {
  it('says nothing once the assistant is switched off', async () => {
    settings.value = { ...DEFAULT_SETTINGS, mode: 'off' }
    await comeBack('c1', 'timeout')
    expect(chat.postResponderMessage).not.toHaveBeenCalled()
  })

  it('words the timeout and the switch going off differently', async () => {
    await comeBack('c1', 'timeout')
    await comeBack('c1', 'offline')
    const bodies = chat.postResponderMessage.mock.calls.map((call) => (call[0] as { body: string }).body)
    expect(bodies[0]).toMatch(/Sorry for the wait/)
    expect(bodies[1]).toMatch(/step away/)
  })
})

describe('scheduleHandoverCheck', () => {
  it('sweeps this chat when its wait runs out, once, however often it is restarted', async () => {
    vi.useFakeTimers()
    const now = Date.now()
    scheduleHandoverCheck('c9', new Date(now + 1_000), now)
    scheduleHandoverCheck('c9', new Date(now + 2_000), now)
    await vi.advanceTimersByTimeAsync(1_000 + TIMER_SLACK_MS)
    expect(db.expireHandovers).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1_000)
    expect(db.expireHandovers).toHaveBeenCalledTimes(1)
    expect(db.expireHandovers).toHaveBeenCalledWith('c9')
  })

  it('does nothing without a deadline', () => {
    vi.useFakeTimers()
    scheduleHandoverCheck('c9', null)
    expect(vi.getTimerCount()).toBe(0)
  })
})
