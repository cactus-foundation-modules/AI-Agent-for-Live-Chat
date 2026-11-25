import {
  ChatEndedError,
  askForColleague,
  getConversationForResponder,
  postResponderMessage,
  readResponderAttachment,
  setResponderTyping,
  type ResponderChat,
} from '@/modules/chat/lib/responder-api'
import { filesForModel, loadedFile, photosForReport, type FileRef, type LoadedFile } from './attachments'
import { AUTHOR_ID } from './constants'
import type { ConversationRow } from './conversation-row'
import { addressOf, markLinked } from './discussed-products'
import { saveDiscussedProducts } from './order-state'
import {
  addUsage,
  appendToolLog,
  claimTurn,
  enterNotGenuine,
  enterQuiet,
  enterWaiting,
  extendTurn,
  colleaguesOnlineNow,
  getConversationState,
  markHandled,
  markPending,
  markTaken,
  releaseTurn,
  setCallbackWanted,
  setNotGenuineAsks,
} from './conversations'
import { saveCallback } from './callbacks'
import { scheduleHandoverCheck } from './handover'
import { cannotAnswerLine, notGenuineAskLine } from './lines'
import { emailsUsedUp } from './emails'
import { textingAvailable, textsUsedUp } from './texts'
import { contextNote, transcriptInput } from './model-input'
import { checksLocked } from './order-checks'
import { notGenuineStep } from './not-genuine'
import { runTurn } from './openai'
import { buildInstructions } from './prompt'
import { modeAllows } from './routing'
import { getSettings } from './settings'
import type { AiChatSettings } from './settings-model'
import { REASON_WORDS, notGenuineReason } from './spam'
import { TOOLS } from './tools'
import { dispatchTool, functionTools, noEffects, type ToolContext } from './tools/registry'
import {
  DEBOUNCE_MS,
  MAX_TURN_LOOPS,
  TYPING_REFRESH_MS,
  catchUpMessage,
  debounceWaitMs,
  hasWork,
  newVisitorMessages,
  stateAnswers,
} from './turn-plan'

// ---------------------------------------------------------------------------
// Answering a chat: one turn of the assistant, run in the background after the
// responder has taken a visitor's message.
//
// One turn per chat at a time. A turn claims the chat (an atomic UPDATE with a
// lease); a message arriving mid-turn finds it claimed, marks it pending and
// leaves. When the turn lets go it is told whether more came in, and goes
// round again, so nothing is dropped and nothing is answered twice.
//
// Each turn waits for the visitor to stop typing (lib/turn-plan.ts), shows
// "<name> is typing…", and then either runs the fixed not-genuine lines, or
// the free spam checks, or the model with its tools. Whatever happens, the
// messages it set out to answer are marked handled, so a fault can never send
// it round in circles.
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Posts as the assistant. False when the chat has ended in the meantime. */
async function say(conversationId: string, settings: AiChatSettings, body: string): Promise<boolean> {
  try {
    await postResponderMessage({ conversationId, authorId: AUTHOR_ID, authorName: settings.assistantName, body })
    return true
  } catch (err) {
    if (err instanceof ChatEndedError) return false
    throw err
  }
}

async function log(conversationId: string, tool: string, args: string, ok: boolean, ms = 0): Promise<void> {
  await appendToolLog(conversationId, { tool, at: new Date().toISOString(), ms, args, ok }).catch((err: unknown) => {
    console.error('[ai-agent-for-live-chat] could not write the tool log', err)
  })
}

/**
 * The model could not help (no key, OpenAI down, an empty answer): ask for a
 * colleague and say one plain line. With somebody online the chat waits for
 * them like any hand-over; with nobody in, the next turn takes a name and
 * email.
 */
async function fallBack(conversationId: string, settings: AiChatSettings, online: boolean): Promise<void> {
  await askForColleague(conversationId)
  if (online) {
    const until = await enterWaiting(conversationId, settings.handoverWaitSeconds)
    scheduleHandoverCheck(conversationId, until)
  } else {
    await setCallbackWanted(conversationId, true)
  }
  await say(conversationId, settings, cannotAnswerLine(online))
}

/** Flags the chat and says the first of the fixed not-genuine lines. */
async function flag(conversationId: string, settings: AiChatSettings, reason: string): Promise<void> {
  await enterNotGenuine(conversationId, reason)
  await say(conversationId, settings, notGenuineAskLine(1))
}

/** A chat already flagged: the fixed lines, by lib/not-genuine.ts's rule. */
async function notGenuineTurn(conversationId: string, settings: AiChatSettings, row: ConversationRow, text: string): Promise<void> {
  const step = notGenuineStep(row.notGenuineAsks, text)
  if (step.kind === 'save') {
    await saveCallback({
      conversationId,
      name: step.name,
      email: step.email,
      about: `The assistant stepped back from this chat (${row.notGenuineReason ?? 'not a genuine enquiry'}) and asked for contact details.`,
      source: 'not_genuine',
    })
    await askForColleague(conversationId)
    await enterQuiet(conversationId)
    await say(conversationId, settings, step.reply)
    await log(conversationId, 'not_genuine', 'details given', true)
  } else if (step.kind === 'ask') {
    await setNotGenuineAsks(conversationId, step.asks)
    await say(conversationId, settings, step.reply)
    await log(conversationId, 'not_genuine', `asked for details (${step.asks} of 3)`, true)
  } else {
    await askForColleague(conversationId)
    await enterQuiet(conversationId)
    await log(conversationId, 'not_genuine', 'no details after three asks; stepped back', true)
  }
}

/** Reads the files the model is shown this turn. A file that cannot be read
 *  is left out (the transcript then says it was not shown), never a reason to
 *  fail the turn. */
async function loadFiles(conversationId: string, files: readonly FileRef[]): Promise<Map<string, LoadedFile>> {
  const loaded = new Map<string, LoadedFile>()
  await Promise.all(files.map(async (file) => {
    try {
      const read = await readResponderAttachment(conversationId, file.id)
      if (read && read.content.length > 0) loaded.set(file.id, loadedFile({ filename: read.filename, contentType: file.contentType }, read.content))
    } catch (err) {
      console.error('[ai-agent-for-live-chat] could not read a file the visitor sent', err)
    }
  }))
  return loaded
}

/** Marks the products the reply showed (their addresses in it) on the chat's
 *  record, so a note or a text sent later carries what was recommended. A
 *  record that cannot be saved never costs the visitor their reply. */
async function rememberShown(ctx: ToolContext, reply: string): Promise<void> {
  const next = markLinked(ctx.products, ctx.shown, reply)
  if (JSON.stringify(next) === JSON.stringify(ctx.products)) return
  ctx.products = next
  await saveDiscussedProducts(ctx.conversationId, next).catch((err: unknown) => {
    console.error('[ai-agent-for-live-chat] could not remember the products shown', err)
  })
}

/** The model, with its tools, writing the reply. */
async function modelTurn(chat: ResponderChat, settings: AiChatSettings, row: ConversationRow, upToId: number, online: boolean): Promise<void> {
  const conversationId = chat.conversation.id
  if (!settings.openaiApiKey) {
    console.error('[ai-agent-for-live-chat] no OpenAI key is set, so a colleague was asked for instead')
    await fallBack(conversationId, settings, online)
    return
  }

  const visitor = chat.visitor
  const ctx: ToolContext = {
    conversationId,
    settings,
    row,
    member: row.memberId ? { id: row.memberId, email: row.memberEmail } : null,
    staff: row.staff,
    online,
    visitorId: chat.conversation.visitorId,
    visitorName: chat.conversation.visitorName,
    visitorEmail: chat.conversation.visitorEmail,
    visitorPhone: chat.conversation.visitorPhone,
    visitorText: chat.messages.filter((m) => m.sender === 'visitor' && m.id <= upToId).map((m) => m.body).join('\n'),
    photos: photosForReport(chat.messages, upToId),
    orders: { verified: [...row.verifiedOrders], failedChecks: row.failedOrderChecks, emailsSent: row.emailsSent },
    textsSent: row.textsSent,
    products: [...row.discussedProducts],
    shown: [],
    effects: noEffects(),
  }
  const [loaded, locked, usedUp, canText, textsGone] = await Promise.all([
    loadFiles(conversationId, filesForModel(chat.messages, upToId)),
    checksLocked(ctx).catch(() => false),
    emailsUsedUp(ctx).catch(() => false),
    textingAvailable(),
    textsUsedUp(ctx).catch(() => false),
  ])
  const conversation = [
    ...transcriptInput(chat.messages, upToId, AUTHOR_ID, loaded),
    {
      role: 'developer' as const,
      content: contextNote({
        now: new Date(),
        startedOn: chat.conversation.pageUrl,
        currentPath: visitor?.currentPath ?? null,
        currentTitle: visitor?.currentTitle ?? null,
        basket: visitor?.cart ?? null,
        basketTotal: visitor?.cartTotal ?? null,
        signedIn: row.memberId !== null,
        visitorName: chat.conversation.visitorName,
        visitorEmail: chat.conversation.visitorEmail,
        staff: row.staff,
        colleaguesOnline: online,
        callbackWanted: row.callbackWanted,
        verifiedOrders: row.verifiedOrders,
        orderChecksLocked: locked,
        emailsUsedUp: usedUp,
        textingAvailable: canText,
        textsUsedUp: textsGone,
        deliveryChoices: row.discussedProducts.flatMap((entry) => (entry.delivery ? [{ label: entry.delivery.label, url: addressOf(entry) }] : [])),
      }),
    },
  ]

  const typing = async () => {
    await setResponderTyping(conversationId, settings.assistantName).catch(() => undefined)
    await extendTurn(conversationId).catch(() => undefined)
  }
  await typing()
  const heartbeat = setInterval(() => { void typing() }, TYPING_REFRESH_MS)
  heartbeat.unref?.()

  try {
    const outcome = await runTurn({
      apiKey: settings.openaiApiKey,
      model: settings.model,
      instructions: buildInstructions(settings, TOOLS),
      tools: functionTools(TOOLS),
      conversation,
      onToolCall: async (call) => {
        const done = await dispatchTool(TOOLS, call.name, call.arguments, ctx)
        await log(conversationId, done.tool, done.summary, done.ok, done.ms)
        return { output: JSON.stringify(done.result), stop: done.stop }
      },
    })
    await addUsage(conversationId, outcome.usage).catch((err: unknown) => {
      console.error('[ai-agent-for-live-chat] could not record token use', err)
    })
    if (outcome.kind === 'stopped' || ctx.effects.notGenuine) {
      await flag(conversationId, settings, ctx.effects.notGenuine ?? 'flagged by the assistant')
      return
    }
    if (!outcome.text) {
      console.error('[ai-agent-for-live-chat] the model gave an empty reply')
      await fallBack(conversationId, settings, online)
      return
    }
    await say(conversationId, settings, outcome.text)
    await rememberShown(ctx, outcome.text)
    // The callback has now been offered once; it is not offered again unasked.
    if (row.callbackWanted && !ctx.effects.callbackSaved) {
      await setCallbackWanted(conversationId, false).catch(() => undefined)
    }
  } catch (err) {
    if (err instanceof ChatEndedError) return
    console.error('[ai-agent-for-live-chat] the assistant could not answer', err)
    await fallBack(conversationId, settings, online).catch((cause: unknown) => {
      if (!(cause instanceof ChatEndedError)) console.error('[ai-agent-for-live-chat] could not hand the chat over either', cause)
    })
  } finally {
    clearInterval(heartbeat)
    await setResponderTyping(conversationId, null).catch(() => undefined)
  }
}

/** Waits for the visitor to finish typing, then reads the chat and its row as
 *  they stand. Null when the chat has gone. */
async function settle(conversationId: string): Promise<{ chat: ResponderChat; row: ConversationRow } | null> {
  const started = new Date()
  for (;;) {
    const [chat, row] = await Promise.all([getConversationForResponder(conversationId), getConversationState(conversationId)])
    if (!chat || !row) return null
    const newest = [...chat.messages].reverse().find((m) => m.sender === 'visitor')
    const wait = debounceWaitMs(newest?.createdAt ?? null, new Date(), started)
    if (wait <= 0) return { chat, row }
    await sleep(Math.max(wait, Math.min(DEBOUNCE_MS, 200)))
    await extendTurn(conversationId).catch(() => undefined)
  }
}

/** One turn, with the chat already claimed. */
async function oneTurn(conversationId: string): Promise<void> {
  const settled = await settle(conversationId)
  if (!settled) return
  const { chat, row } = settled
  if (!hasWork(row)) return
  const upToId = row.lastTakenMessageId
  try {
    const settings = await getSettings()
    // Switched off or narrowed since the message was taken, the chat has
    // ended, or a colleague stepped in while the turn waited: nothing to say.
    if (!modeAllows(settings.mode, row.staff)) return
    if (chat.conversation.status === 'closed') return
    if (!stateAnswers(row.state)) return

    const fresh = newVisitorMessages(chat.messages, row)
    if (row.state === 'not_genuine') {
      await notGenuineTurn(conversationId, settings, row, fresh.map((m) => m.body).join('\n'))
      return
    }

    const lines = chat.messages.filter((m) => m.sender === 'visitor' && m.id <= upToId)
    const reason = notGenuineReason(lines, new Set(fresh.map((m) => m.id)))
    if (reason) {
      await log(conversationId, 'spam_check', REASON_WORDS[reason], true)
      await flag(conversationId, settings, REASON_WORDS[reason])
      return
    }

    await modelTurn(chat, settings, row, upToId, await colleaguesOnlineNow(row.colleaguesOnline))
  } finally {
    await markHandled(conversationId, upToId)
  }
}

/**
 * Answers whatever the assistant has taken in this chat and not yet answered.
 * Safe to call as often as you like: a second call while a turn runs just
 * leaves a note for it. Never throws.
 */
export async function processConversation(conversationId: string): Promise<void> {
  for (let loop = 0; loop < MAX_TURN_LOOPS; loop++) {
    let claimed: ConversationRow | null
    try {
      claimed = await claimTurn(conversationId)
      if (!claimed) {
        await markPending(conversationId)
        return
      }
    } catch (err) {
      console.error('[ai-agent-for-live-chat] could not claim a chat to answer it', err)
      return
    }
    try {
      await oneTurn(conversationId)
    } catch (err) {
      console.error('[ai-agent-for-live-chat] a turn failed', err)
    }
    let more = false
    try {
      more = await releaseTurn(conversationId)
    } catch (err) {
      console.error('[ai-agent-for-live-chat] could not let go of a chat; its lease will run out', err)
    }
    if (!more) return
  }
}

/**
 * A chat has come back to the assistant with no new message to prompt it - the
 * switch went off, or a colleague handed it over. If the visitor's last
 * message is still waiting on an answer, take it and answer it.
 */
export async function catchUp(conversationId: string): Promise<void> {
  const [chat, row] = await Promise.all([getConversationForResponder(conversationId), getConversationState(conversationId)])
  if (!chat || !row || chat.conversation.status === 'closed') return
  const waiting = catchUpMessage(chat.messages, row.lastHandledMessageId, new Date())
  if (!waiting) return
  await markTaken(conversationId, waiting.id)
  await processConversation(conversationId)
}
