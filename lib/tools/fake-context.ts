import { parseConversationRow } from '../conversation-row'
import { DEFAULT_SETTINGS } from '../settings-model'
import { noEffects, type ToolContext } from './registry'

// A tool context for tests: an ordinary visitor in chat c1, nobody signed in,
// nothing proved, nothing sent, no product discussed. Pure; imported only by
// the tests.

export function fakeContext(over: Partial<ToolContext> = {}, state = 'auto'): ToolContext {
  return {
    conversationId: 'c1',
    settings: { ...DEFAULT_SETTINGS, handoverWaitSeconds: 180 },
    row: parseConversationRow({ conversation_id: 'c1', state }),
    member: null,
    staff: false,
    online: true,
    visitorId: null,
    visitorName: null,
    visitorEmail: null,
    visitorPhone: null,
    visitorText: '',
    photos: [],
    orders: { verified: [], failedChecks: 0, emailsSent: 0 },
    textsSent: 0,
    products: [],
    effects: noEffects(),
    ...over,
  }
}
