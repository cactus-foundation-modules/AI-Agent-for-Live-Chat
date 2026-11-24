// GET/PUT /api/m/ai-agent-for-live-chat/admin/conversation - the controls in a
// chat's header: who is answering it and what the assistant did in it (GET
// ?id=), and "Hand to <name>" / "Hand back to <name>" (PUT).
import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { hasPermission } from '@/lib/permissions/check'
import { errorResponse } from '@/lib/utils'
import { requirePermission } from '@/modules/ai-agent-for-live-chat/lib/admin-auth'
import { runLater } from '@/modules/ai-agent-for-live-chat/lib/background'
import { CHAT_PERM_REPLY, CHAT_PERM_VIEW } from '@/modules/ai-agent-for-live-chat/lib/constants'
import { getConversationState, handToAssistant } from '@/modules/ai-agent-for-live-chat/lib/conversations'
import { stateForHand } from '@/modules/ai-agent-for-live-chat/lib/routing'
import { getSettings } from '@/modules/ai-agent-for-live-chat/lib/settings'
import { catchUp } from '@/modules/ai-agent-for-live-chat/lib/turn-runner'

const ConversationId = z.string().trim().min(1).max(100).regex(/^[A-Za-z0-9_-]+$/)

export async function GET(request: NextRequest) {
  const auth = await requirePermission(CHAT_PERM_VIEW)
  if ('response' in auth) return auth.response
  const id = ConversationId.safeParse(request.nextUrl.searchParams.get('id') ?? '')
  if (!id.success) return errorResponse('Which chat?')
  const [settings, row, canAct] = await Promise.all([
    getSettings(),
    getConversationState(id.data),
    hasPermission(auth.user, CHAT_PERM_REPLY),
  ])
  return NextResponse.json({
    mode: settings.mode,
    assistantName: settings.assistantName,
    aiFirst: settings.aiFirst,
    // A chat the assistant has never had anything to do with follows the site
    // rules, exactly as one with a fresh row would.
    state: row?.state ?? 'auto',
    waitingSince: row?.waitingSince ? row.waitingSince.toISOString() : null,
    notGenuineReason: row?.notGenuineReason ?? null,
    toolLog: row?.toolLog ?? [],
    canAct,
  }, { headers: { 'Cache-Control': 'no-store' } })
}

const Body = z.object({ id: ConversationId, action: z.enum(['hand', 'hand_back']) }).strict()

export async function PUT(request: NextRequest) {
  const auth = await requirePermission(CHAT_PERM_REPLY)
  if ('response' in auth) return auth.response
  const parsed = Body.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return errorResponse('That did not look right.')
  const settings = await getSettings()
  if (settings.mode === 'off') return errorResponse('The assistant is switched off in its settings.', 409)

  const { id, action } = parsed.data
  let row
  try {
    row = await handToAssistant(id, stateForHand(action, settings.aiFirst))
  } catch (cause) {
    // The only way this insert fails on good input is a chat that is not there
    // (the row's foreign key), so that is what is said.
    console.error('[ai-agent-for-live-chat] could not hand a chat to the assistant', cause)
    return errorResponse('That chat is no longer here.', 404)
  }
  // The visitor may be sitting on an unanswered question: answer it now.
  runLater('picking up a handed-over chat', () => catchUp(id))
  return NextResponse.json({ ok: true, state: row?.state ?? 'assistant' })
}
