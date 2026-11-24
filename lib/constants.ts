// Shared by the server and the browser, so nothing in here may import anything
// with a runtime cost.

export const MODULE_NAME = 'ai-agent-for-live-chat'
export const API_BASE = `/api/m/${MODULE_NAME}`

/** Stored as the author of every message the assistant writes. Live Chat's
 *  responder contract needs it to start "module:". */
export const AUTHOR_ID = `module:${MODULE_NAME}`

export const PERM_MANAGE = 'ai-agent-for-live-chat.manage'

/** Live Chat's own permissions, restated rather than imported so the chat
 *  window controls never pull a Live Chat file into the browser. */
export const CHAT_PERM_VIEW = 'chat.view'
export const CHAT_PERM_REPLY = 'chat.reply'

/** The badge beside the assistant's messages. Fixed wording: it is a digital
 *  assistant, never "automated", never a person. */
export const MESSAGE_LABEL = 'Digital assistant'

export const MODES = ['off', 'staff', 'on'] as const
export type Mode = (typeof MODES)[number]

export const CHAT_STATES = ['auto', 'assistant', 'colleague', 'waiting', 'not_genuine', 'quiet'] as const
export type ChatState = (typeof CHAT_STATES)[number]

export function isMode(value: unknown): value is Mode {
  return typeof value === 'string' && (MODES as readonly string[]).includes(value)
}

export function isChatState(value: unknown): value is ChatState {
  return typeof value === 'string' && (CHAT_STATES as readonly string[]).includes(value)
}
