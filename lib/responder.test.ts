import { beforeEach, describe, expect, it, vi } from 'vitest'
import { parseConversationRow, type ConversationRow } from './conversation-row'
import { DEFAULT_SETTINGS, type AiChatSettings } from './settings-model'

// The responder's wiring: that it reads what it should, asks lib/routing.ts,
// and writes and schedules what comes back. The routing itself is pinned in
// routing.test.ts; the SQL in sql.live.test.ts.

const state = vi.hoisted(() => ({
  settings: null as AiChatSettings | null,
  staff: false as boolean | null,
  member: null as { id: string; email: string | null } | null,
  row: null as ConversationRow | null,
  waiting: [] as string[],
  auto: [] as string[],
}))

const conversations = vi.hoisted(() => ({
  recordOffer: vi.fn(),
  takeMessage: vi.fn(),
  colleagueTookOver: vi.fn(),
  switchedOff: vi.fn(),
  autoChatsAmong: vi.fn(),
}))
const runner = vi.hoisted(() => ({ processConversation: vi.fn(async () => undefined), catchUp: vi.fn(async () => undefined) }))
const handover = vi.hoisted(() => ({ comeBack: vi.fn(async () => undefined) }))
const background = vi.hoisted(() => ({ tasks: [] as Array<() => Promise<void>> }))

vi.mock('./settings', () => ({ getCachedSettings: async () => state.settings }))
vi.mock('./people', () => ({ requestIsStaff: async () => state.staff, requestMember: async () => state.member }))
vi.mock('./conversations', () => conversations)
vi.mock('./turn-runner', () => runner)
vi.mock('./handover', () => handover)
vi.mock('./background', () => ({ runLater: (_label: string, task: () => Promise<void>) => { background.tasks.push(task) } }))

const { aiChatResponder: responder } = await import('./responder')

function row(over: Record<string, unknown> = {}): ConversationRow {
  return parseConversationRow({ conversation_id: 'c1', state: 'auto', ...over })
}

const offer = { conversationId: 'c1', messageId: 42, visitorId: null, online: false, newConversation: false }

async function drain() {
  while (background.tasks.length > 0) await background.tasks.shift()?.()
}

beforeEach(() => {
  vi.clearAllMocks()
  background.tasks.length = 0
  state.settings = { ...DEFAULT_SETTINGS, mode: 'on', assistantName: 'Charlie' }
  state.staff = false
  state.member = null
  state.row = row()
  state.waiting = []
  state.auto = []
  conversations.recordOffer.mockImplementation(async (input: { staff: boolean }) => (state.row ? { ...state.row, staff: state.row.staff || input.staff } : null))
  conversations.switchedOff.mockImplementation(async () => state.waiting)
  conversations.autoChatsAmong.mockImplementation(async () => state.auto)
})

describe('authorId', () => {
  it('is a module author id Live Chat will accept', () => {
    expect(responder.authorId).toBe('module:ai-agent-for-live-chat')
  })
})

describe('offerVisitorMessage', () => {
  it('says no without touching the database with the mode off', async () => {
    state.settings = { ...DEFAULT_SETTINGS, mode: 'off' }
    expect(await responder.offerVisitorMessage(offer)).toBe(false)
    expect(conversations.recordOffer).not.toHaveBeenCalled()
  })

  it('in Staff only, says no to a visitor without writing a row', async () => {
    state.settings = { ...DEFAULT_SETTINGS, mode: 'staff' }
    expect(await responder.offerVisitorMessage(offer)).toBe(false)
    expect(conversations.recordOffer).not.toHaveBeenCalled()
  })

  it('in Staff only, takes a signed-in colleague\'s message and records them as staff', async () => {
    state.settings = { ...DEFAULT_SETTINGS, mode: 'staff' }
    state.staff = true
    expect(await responder.offerVisitorMessage(offer)).toBe(true)
    expect(conversations.recordOffer).toHaveBeenCalledWith(expect.objectContaining({ staff: true }))
  })

  it('takes a message while nobody is online, records the member, and schedules the turn', async () => {
    state.member = { id: 'm1', email: 'sam@example.com' }
    expect(await responder.offerVisitorMessage(offer)).toBe(true)
    expect(conversations.recordOffer).toHaveBeenCalledWith({ conversationId: 'c1', staff: false, memberId: 'm1', memberEmail: 'sam@example.com', online: false })
    expect(conversations.takeMessage).toHaveBeenCalledWith('c1', 42, 'auto', false)
    expect(runner.processConversation).not.toHaveBeenCalled()
    await drain()
    expect(runner.processConversation).toHaveBeenCalledWith('c1')
  })

  it('leaves a message to colleagues while they are online, unless it goes first', async () => {
    expect(await responder.offerVisitorMessage({ ...offer, online: true })).toBe(false)
    expect(conversations.takeMessage).not.toHaveBeenCalled()
    state.settings = { ...DEFAULT_SETTINGS, mode: 'on', aiFirst: true }
    expect(await responder.offerVisitorMessage({ ...offer, online: true })).toBe(true)
  })

  it('takes a waiting chat back, owed an apology, once nobody is online', async () => {
    state.row = row({ state: 'waiting' })
    expect(await responder.offerVisitorMessage(offer)).toBe(true)
    expect(conversations.takeMessage).toHaveBeenCalledWith('c1', 42, 'auto', true)
  })

  it('never takes a quiet chat', async () => {
    state.row = row({ state: 'quiet' })
    expect(await responder.offerVisitorMessage(offer)).toBe(false)
  })
})

describe('answeringAs', () => {
  it('answers under the assistant\'s name in On while offline', async () => {
    expect(await responder.answeringAs({ online: false, visitorId: null })).toEqual({ authorName: 'Charlie' })
    expect(await responder.answeringAs({ online: true, visitorId: null })).toBeNull()
  })

  it('in Staff only, answers only a signed-in colleague, and nobody with no request to read', async () => {
    state.settings = { ...DEFAULT_SETTINGS, mode: 'staff', assistantName: 'Charlie' }
    state.staff = true
    expect(await responder.answeringAs({ online: false, visitorId: null })).toEqual({ authorName: 'Charlie' })
    state.staff = null
    expect(await responder.answeringAs({ online: false, visitorId: null })).toBeNull()
  })

  it('is null with the mode off', async () => {
    state.settings = { ...DEFAULT_SETTINGS, mode: 'off' }
    expect(await responder.answeringAs({ online: false, visitorId: null })).toBeNull()
  })
})

describe('colleagueReplied', () => {
  it('hands the chat to the colleague', async () => {
    await responder.colleagueReplied({ conversationId: 'c1', userId: 'u1' })
    expect(conversations.colleagueTookOver).toHaveBeenCalledWith('c1')
  })
})

describe('onlineChanged', () => {
  it('does nothing when the switch goes on', async () => {
    expect(await responder.onlineChanged({ online: true, openConversationIds: ['c1'] })).toEqual({ covered: false })
    expect(conversations.switchedOff).not.toHaveBeenCalled()
  })

  it('in On, moves the chats, apologises to the waiting ones and answers questions left open', async () => {
    state.waiting = ['w1', 'closed-waiting']
    state.auto = ['w1', 'a1']
    expect(await responder.onlineChanged({ online: false, openConversationIds: ['w1', 'a1'] })).toEqual({ covered: true })
    expect(conversations.switchedOff).toHaveBeenCalled()
    await drain()
    expect(handover.comeBack).toHaveBeenCalledTimes(1)
    expect(handover.comeBack).toHaveBeenCalledWith('w1', 'offline')
    expect(runner.catchUp).toHaveBeenCalledTimes(1)
    expect(runner.catchUp).toHaveBeenCalledWith('a1')
  })

  it('in Staff only, moves the chats but covers nobody and says nothing', async () => {
    state.settings = { ...DEFAULT_SETTINGS, mode: 'staff' }
    state.waiting = ['w1']
    expect(await responder.onlineChanged({ online: false, openConversationIds: ['w1'] })).toEqual({ covered: false })
    expect(conversations.switchedOff).toHaveBeenCalled()
    await drain()
    expect(handover.comeBack).not.toHaveBeenCalled()
  })

  it('with the mode off, touches nothing', async () => {
    state.settings = { ...DEFAULT_SETTINGS, mode: 'off' }
    expect(await responder.onlineChanged({ online: false, openConversationIds: [] })).toEqual({ covered: false })
    expect(conversations.switchedOff).not.toHaveBeenCalled()
  })
})

describe('messageLabel', () => {
  it('is the fixed badge unless the mode is off', async () => {
    expect(await responder.messageLabel()).toBe('Digital assistant')
    state.settings = { ...DEFAULT_SETTINGS, mode: 'off' }
    expect(await responder.messageLabel()).toBeNull()
  })
})
