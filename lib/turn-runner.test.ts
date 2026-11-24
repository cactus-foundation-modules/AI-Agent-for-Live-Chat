import { beforeEach, describe, expect, it, vi } from 'vitest'
import { parseConversationRow, type ConversationRow } from './conversation-row'
import { NOT_GENUINE_FIRST } from './lines'
import { DEFAULT_SETTINGS, type AiChatSettings } from './settings-model'

// The turn runner's moving parts with the database, Live Chat and OpenAI
// stood in for: the one-at-a-time claim, the loop, and which of the three
// ways (fixed lines, spam check, model) a turn goes.

type Msg = { id: number; sender: 'visitor' | 'agent' | 'system'; authorId: string | null; authorName: string | null; body: string; createdAt: Date; attachments: [] }

const world = vi.hoisted(() => ({
  settings: null as AiChatSettings | null,
  row: null as ConversationRow | null,
  messages: [] as Msg[],
  claims: [] as boolean[],
  releases: [] as boolean[],
}))

const chat = vi.hoisted(() => {
  class ChatEndedError extends Error {}
  return {
    ChatEndedError,
    askForColleague: vi.fn(async () => true),
    postResponderMessage: vi.fn(),
    setResponderTyping: vi.fn(async () => undefined),
    getConversationForResponder: vi.fn(),
    readResponderAttachment: vi.fn(async () => null),
  }
})

const db = vi.hoisted(() => ({
  addUsage: vi.fn(async () => undefined),
  appendToolLog: vi.fn(async () => undefined),
  claimTurn: vi.fn(),
  enterNotGenuine: vi.fn(),
  enterQuiet: vi.fn(),
  enterWaiting: vi.fn(async () => new Date()),
  extendTurn: vi.fn(async () => undefined),
  getConversationState: vi.fn(),
  // The live switch read; in these tests it agrees with the row's copy.
  colleaguesOnlineNow: vi.fn(async (fallback: boolean) => fallback),
  markHandled: vi.fn(),
  markPending: vi.fn(),
  markTaken: vi.fn(),
  releaseTurn: vi.fn(),
  setCallbackWanted: vi.fn(),
  setNotGenuineAsks: vi.fn(),
}))
const callbacks = vi.hoisted(() => ({ saveCallback: vi.fn(async () => 'cb1') }))
const handover = vi.hoisted(() => ({ scheduleHandoverCheck: vi.fn() }))
const openai = vi.hoisted(() => ({ runTurn: vi.fn() }))

vi.mock('@/modules/chat/lib/responder-api', () => chat)
vi.mock('./conversations', () => db)
vi.mock('./callbacks', () => callbacks)
vi.mock('./handover', () => handover)
vi.mock('./openai', () => openai)
vi.mock('./settings', () => ({ getSettings: async () => world.settings }))
vi.mock('./unanswered', () => ({ recordUnanswered: vi.fn() }))
// The shop-facing tools and their limits reach the shop's own code; the turn
// itself is what is under test here.
vi.mock('./tools', () => ({ TOOLS: [] }))
vi.mock('./emails', () => ({ emailsUsedUp: vi.fn(async () => false) }))
vi.mock('./order-checks', () => ({ checksLocked: vi.fn(async () => false) }))

const { processConversation, catchUp } = await import('./turn-runner')

const longAgo = new Date(Date.now() - 60_000)
const visitor = (id: number, body: string): Msg => ({ id, sender: 'visitor', authorId: null, authorName: null, body, createdAt: longAgo, attachments: [] })

function posted(): string[] {
  return chat.postResponderMessage.mock.calls.map((call) => (call[0] as { body: string }).body)
}

beforeEach(() => {
  vi.clearAllMocks()
  world.settings = { ...DEFAULT_SETTINGS, mode: 'on', assistantName: 'Charlie', openaiApiKey: 'sk-test' }
  world.row = parseConversationRow({ conversation_id: 'c1', state: 'auto', last_taken_message_id: 1, last_handled_message_id: 0, colleagues_online: false })
  world.messages = [visitor(1, 'Do you deliver to Leeds?')]
  world.claims = [true]
  world.releases = [false]
  db.claimTurn.mockImplementation(async () => (world.claims.shift() ? world.row : null))
  db.releaseTurn.mockImplementation(async () => world.releases.shift() ?? false)
  db.getConversationState.mockImplementation(async () => world.row)
  chat.getConversationForResponder.mockImplementation(async () => ({
    conversation: { id: 'c1', status: 'open', pageUrl: '/', visitorName: null, visitorEmail: null },
    messages: world.messages,
    visitor: null,
  }))
  openai.runTurn.mockResolvedValue({ kind: 'reply', text: 'We do, yes.', usage: { input: 10, cached: 0, output: 2 }, rounds: 1 })
})

describe('one turn at a time', () => {
  it('leaves a note and goes when another turn holds the chat', async () => {
    world.claims = [false]
    await processConversation('c1')
    expect(db.markPending).toHaveBeenCalledWith('c1')
    expect(openai.runTurn).not.toHaveBeenCalled()
  })

  it('goes round again while more came in, then stops', async () => {
    world.claims = [true, true]
    world.releases = [true, false]
    await processConversation('c1')
    expect(db.claimTurn).toHaveBeenCalledTimes(2)
    expect(db.releaseTurn).toHaveBeenCalledTimes(2)
  })

  it('never loops for ever', async () => {
    world.claims = Array.from({ length: 20 }, () => true)
    world.releases = Array.from({ length: 20 }, () => true)
    await processConversation('c1')
    expect(db.claimTurn).toHaveBeenCalledTimes(5)
  })
})

describe('a model turn', () => {
  it('answers, records the tokens and marks the message handled', async () => {
    await processConversation('c1')
    expect(openai.runTurn).toHaveBeenCalledTimes(1)
    expect(posted()).toEqual(['We do, yes.'])
    expect(db.addUsage).toHaveBeenCalledWith('c1', { input: 10, cached: 0, output: 2 })
    expect(db.markHandled).toHaveBeenCalledWith('c1', 1)
    expect(chat.setResponderTyping).toHaveBeenLastCalledWith('c1', null)
  })

  it('falls back to a colleague, plainly, when OpenAI fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    openai.runTurn.mockRejectedValueOnce(new Error('timeout'))
    world.row = { ...world.row!, colleaguesOnline: true }
    await processConversation('c1')
    expect(chat.askForColleague).toHaveBeenCalledWith('c1')
    expect(db.enterWaiting).toHaveBeenCalled()
    expect(posted()).toEqual(['Sorry, I cannot answer that just now - I have asked a colleague to pick this up.'])
    expect(db.markHandled).toHaveBeenCalledWith('c1', 1)
  })

  it('with no key, asks for details instead when nobody is online', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    world.settings = { ...world.settings!, openaiApiKey: null }
    await processConversation('c1')
    expect(openai.runTurn).not.toHaveBeenCalled()
    expect(db.setCallbackWanted).toHaveBeenCalledWith('c1', true)
    expect(posted()[0]).toMatch(/name and email address/)
  })

  it('switches to the fixed lines when the model flags the chat', async () => {
    openai.runTurn.mockResolvedValueOnce({ kind: 'stopped', usage: { input: 1, cached: 0, output: 1 }, rounds: 1 })
    await processConversation('c1')
    expect(db.enterNotGenuine).toHaveBeenCalled()
    expect(posted()).toEqual([NOT_GENUINE_FIRST])
  })
})

describe('the free checks and the fixed lines', () => {
  it('flags spam before any money is spent', async () => {
    world.messages = [visitor(1, 'asdfasdf jkljkljkl')]
    await processConversation('c1')
    expect(openai.runTurn).not.toHaveBeenCalled()
    expect(db.enterNotGenuine).toHaveBeenCalledWith('c1', 'Keyboard-mashing or gibberish')
    expect(posted()).toEqual([NOT_GENUINE_FIRST])
  })

  it('in a flagged chat, an email address saves a callback and the assistant steps back', async () => {
    world.row = { ...world.row!, state: 'not_genuine', notGenuineAsks: 1 }
    world.messages = [visitor(1, 'fine. Sam, sam@example.com')]
    await processConversation('c1')
    expect(callbacks.saveCallback).toHaveBeenCalledWith(expect.objectContaining({ email: 'sam@example.com', source: 'not_genuine' }))
    expect(chat.askForColleague).toHaveBeenCalledWith('c1')
    expect(db.enterQuiet).toHaveBeenCalledWith('c1')
    expect(openai.runTurn).not.toHaveBeenCalled()
  })

  it('after the third ask goes unanswered, steps back and says nothing', async () => {
    world.row = { ...world.row!, state: 'not_genuine', notGenuineAsks: 3 }
    world.messages = [visitor(1, 'no')]
    await processConversation('c1')
    expect(db.enterQuiet).toHaveBeenCalledWith('c1')
    expect(chat.askForColleague).toHaveBeenCalledWith('c1')
    expect(posted()).toEqual([])
  })
})

describe('staying out of the way', () => {
  it('says nothing once a colleague has stepped in, but marks the message handled', async () => {
    world.row = { ...world.row!, state: 'colleague' }
    await processConversation('c1')
    expect(posted()).toEqual([])
    expect(db.markHandled).toHaveBeenCalledWith('c1', 1)
  })

  it('says nothing with the assistant switched off since', async () => {
    world.settings = { ...world.settings!, mode: 'off' }
    await processConversation('c1')
    expect(posted()).toEqual([])
  })
})

describe('catchUp', () => {
  it('takes the visitor\'s waiting question and answers it', async () => {
    world.row = { ...world.row!, lastTakenMessageId: 0 }
    await catchUp('c1')
    expect(db.markTaken).toHaveBeenCalledWith('c1', 1)
  })

  it('leaves a chat where somebody had the last word', async () => {
    world.messages = [visitor(1, 'Hi'), { ...visitor(2, 'Hello!'), sender: 'agent', authorId: 'u1' }]
    await catchUp('c1')
    expect(db.markTaken).not.toHaveBeenCalled()
  })
})
