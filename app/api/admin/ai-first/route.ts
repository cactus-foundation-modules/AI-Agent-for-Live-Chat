// GET/PUT /api/m/ai-agent-for-live-chat/admin/ai-first - the "<name> first"
// switch beside Live Chat's Online switch. Site-wide, like the Online switch,
// and open to whoever may answer chats (Live Chat's chat.reply), not only to
// those who manage this module's settings.
import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { hasPermission } from '@/lib/permissions/check'
import { errorResponse } from '@/lib/utils'
import { requirePermission } from '@/modules/ai-agent-for-live-chat/lib/admin-auth'
import { CHAT_PERM_REPLY, CHAT_PERM_VIEW } from '@/modules/ai-agent-for-live-chat/lib/constants'
import { getSettings, updateSettings } from '@/modules/ai-agent-for-live-chat/lib/settings'

export async function GET() {
  const auth = await requirePermission(CHAT_PERM_VIEW)
  if ('response' in auth) return auth.response
  const [settings, canChange] = await Promise.all([getSettings(), hasPermission(auth.user, CHAT_PERM_REPLY)])
  return NextResponse.json(
    { mode: settings.mode, aiFirst: settings.aiFirst, assistantName: settings.assistantName, canChange },
    { headers: { 'Cache-Control': 'no-store' } },
  )
}

const Body = z.object({ aiFirst: z.boolean() }).strict()

export async function PUT(request: NextRequest) {
  const auth = await requirePermission(CHAT_PERM_REPLY)
  if ('response' in auth) return auth.response
  const parsed = Body.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return errorResponse('That did not look like on or off.')
  const settings = await getSettings()
  if (settings.mode === 'off') return errorResponse('The assistant is switched off in its settings.', 409)
  await updateSettings({ aiFirst: parsed.data.aiFirst })
  return NextResponse.json({ ok: true, aiFirst: parsed.data.aiFirst })
}
