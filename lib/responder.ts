import type {
  AnsweringContext,
  ColleagueRepliedContext,
  OnlineChangedContext,
  ResponderContract,
  VisitorMessageOffer,
} from '@/modules/chat/lib/responder'
import { runLater } from './background'
import { AUTHOR_ID, MESSAGE_LABEL } from './constants'
import { autoChatsAmong, colleagueTookOver, recordOffer, switchedOff, takeMessage } from './conversations'
import { comeBack } from './handover'
import { requestIsStaff, requestMember } from './people'
import { coversWhenSwitchedOff, decideAnswering, decideOffer, modeAllows } from './routing'
import { getCachedSettings } from './settings'
import { catchUp, processConversation } from './turn-runner'

// ---------------------------------------------------------------------------
// This module's answer to Live Chat's `chat.responder` point (see
// modules/chat/lib/responder.ts for the contract). Published in the manifest
// as serverOnly.
//
// Live Chat gives each call two seconds and treats a throw or a timeout as
// "no", so everything here is quick: settings come from the copy held in
// memory, the chat's state is one small upsert, and the slow work - waiting
// for the visitor to finish typing, the model, the tools - is scheduled to run
// after the response has gone (lib/background.ts, lib/turn-runner.ts).
//
// The decisions themselves are lib/routing.ts, pure and tested.
// ---------------------------------------------------------------------------

/** Most chats the assistant will pick up at once when the switch goes off;
 *  the rest are answered when the visitor next writes. */
export const CATCH_UP_LIMIT = 25

async function offerVisitorMessage(ctx: VisitorMessageOffer): Promise<boolean> {
  const settings = await getCachedSettings()
  if (settings.mode === 'off') return false

  // Only the request knows who is behind it, so it is read now and kept on the
  // chat's row for the turn that runs later.
  const [staff, member] = await Promise.all([requestIsStaff(), requestMember()])
  if (!modeAllows(settings.mode, staff === true)) return false

  const row = await recordOffer({
    conversationId: ctx.conversationId,
    staff: staff === true,
    memberId: member?.id ?? null,
    memberEmail: member?.email ?? null,
    online: ctx.online,
  })
  if (!row) return false

  const decision = decideOffer({ mode: settings.mode, staff: row.staff, state: row.state, online: ctx.online, aiFirst: settings.aiFirst })
  if (!decision.take) return false

  await takeMessage(ctx.conversationId, ctx.messageId, decision.state, decision.callbackWanted)
  runLater('answering a chat', () => processConversation(ctx.conversationId))
  return true
}

async function answeringAs(ctx: AnsweringContext): Promise<{ authorName: string } | null> {
  const settings = await getCachedSettings()
  if (settings.mode === 'off') return null
  // Staff only answers a signed-in colleague, so it is the one case that
  // needs the session; On and Off are settled from memory.
  const staff = settings.mode === 'staff' ? await requestIsStaff() : null
  const answering = decideAnswering({ mode: settings.mode, staff, online: ctx.online, aiFirst: settings.aiFirst })
  return answering ? { authorName: settings.assistantName } : null
}

async function colleagueReplied(ctx: ColleagueRepliedContext): Promise<void> {
  await colleagueTookOver(ctx.conversationId)
}

/**
 * The switch went off: chats a colleague had go back to the site rules, and
 * chats waiting for one come back to the assistant at once with an apology
 * (when it answers the public - Mode On). Visitors left with a question
 * nobody has answered get an answer to it now. The switch going on changes
 * nothing: chats the assistant is in the middle of stay its own.
 */
async function onlineChanged(ctx: OnlineChangedContext): Promise<{ covered: boolean }> {
  if (ctx.online) return { covered: false }
  const settings = await getCachedSettings()
  if (settings.mode === 'off') return { covered: false }

  const waiting = await switchedOff()
  const covered = coversWhenSwitchedOff(settings.mode, ctx.online)
  if (covered) {
    // In Staff only Live Chat sends its own "we have had to step away"
    // message, so the apology would be a second one; the next turn asks for
    // the details instead (callback_wanted is already set).
    const open = new Set(ctx.openConversationIds)
    const toTell = waiting.filter((id) => open.has(id))
    const waitingSet = new Set(waiting)
    runLater('picking chats up after the switch went off', async () => {
      for (const id of toTell) await comeBack(id, 'offline').catch((err: unknown) => {
        console.error('[ai-agent-for-live-chat] could not tell a waiting visitor', err)
      })
      const auto = await autoChatsAmong(ctx.openConversationIds.slice(0, CATCH_UP_LIMIT * 4))
      for (const id of auto.filter((chat) => !waitingSet.has(chat)).slice(0, CATCH_UP_LIMIT)) {
        await catchUp(id).catch((err: unknown) => {
          console.error('[ai-agent-for-live-chat] could not pick a chat up', err)
        })
      }
    })
  }
  return { covered }
}

async function messageLabel(): Promise<string | null> {
  const settings = await getCachedSettings()
  return settings.mode === 'off' ? null : MESSAGE_LABEL
}

export const aiChatResponder: ResponderContract = {
  authorId: AUTHOR_ID,
  offerVisitorMessage,
  answeringAs,
  colleagueReplied,
  onlineChanged,
  messageLabel,
}
