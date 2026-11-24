// POST /api/m/ai-agent-for-live-chat/admin/conversation/overview - the written
// overview at the top of a chat's Notes. Reuses the stored one while no newer
// message has arrived; otherwise writes a fresh one with one model call (no
// tools) and keeps it with the newest message it covered. POST because it may
// spend money; Live Chat's chat.view, like the rest of the chat window
// controls.
import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { errorResponse } from '@/lib/utils'
import { getConversationForResponder } from '@/modules/chat/lib/responder-api'
import { requirePermission } from '@/modules/ai-agent-for-live-chat/lib/admin-auth'
import { AUTHOR_ID, CHAT_PERM_VIEW } from '@/modules/ai-agent-for-live-chat/lib/constants'
import { getConversationState } from '@/modules/ai-agent-for-live-chat/lib/conversations'
import { saveOverview } from '@/modules/ai-agent-for-live-chat/lib/order-state'
import { overviewInput, overviewIsCurrent, writeOverview } from '@/modules/ai-agent-for-live-chat/lib/overview'
import { getSettings } from '@/modules/ai-agent-for-live-chat/lib/settings'

const Body = z.object({ id: z.string().trim().min(1).max(100).regex(/^[A-Za-z0-9_-]+$/) }).strict()

export async function POST(request: NextRequest) {
  const auth = await requirePermission(CHAT_PERM_VIEW)
  if ('response' in auth) return auth.response
  const parsed = Body.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return errorResponse('Which chat?')

  const [chat, row] = await Promise.all([getConversationForResponder(parsed.data.id), getConversationState(parsed.data.id)])
  if (!chat) return errorResponse('That chat is no longer here.', 404)
  if (!row) return NextResponse.json({ overview: '', fresh: false }, { headers: { 'Cache-Control': 'no-store' } })

  const newest = chat.messages[chat.messages.length - 1]?.id ?? 0
  if (overviewIsCurrent(row, newest)) {
    return NextResponse.json({ overview: row.overview, fresh: false }, { headers: { 'Cache-Control': 'no-store' } })
  }

  const settings = await getSettings()
  if (!settings.openaiApiKey) return errorResponse('No OpenAI key is set, so no overview can be written.', 409)
  try {
    const overview = await writeOverview({ apiKey: settings.openaiApiKey, model: settings.model, text: overviewInput(chat.messages, row, AUTHOR_ID) })
    if (!overview) return errorResponse('The overview came back empty. Try again in a moment.', 502)
    await saveOverview(parsed.data.id, overview, newest)
    return NextResponse.json({ overview, fresh: true }, { headers: { 'Cache-Control': 'no-store' } })
  } catch (cause) {
    console.error('[ai-agent-for-live-chat] could not write a chat overview', cause)
    return errorResponse('The overview could not be written just now.', 502)
  }
}
