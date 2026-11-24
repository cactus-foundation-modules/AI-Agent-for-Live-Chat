// GET/PATCH /api/m/ai-agent-for-live-chat/admin/callbacks - visitors waiting to
// be got back to, and marking one done.
import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { errorResponse } from '@/lib/utils'
import { requirePermission } from '@/modules/ai-agent-for-live-chat/lib/admin-auth'
import { listCallbacks, setCallbackHandled } from '@/modules/ai-agent-for-live-chat/lib/callbacks'
import { PERM_MANAGE } from '@/modules/ai-agent-for-live-chat/lib/constants'

const Days = z.coerce.number().int().min(1).max(365).catch(30)

export async function GET(request: NextRequest) {
  const auth = await requirePermission(PERM_MANAGE)
  if ('response' in auth) return auth.response
  const days = Days.parse(request.nextUrl.searchParams.get('days') ?? 30)
  return NextResponse.json({ items: await listCallbacks(days) }, { headers: { 'Cache-Control': 'no-store' } })
}

const Body = z.object({ id: z.string().trim().min(1).max(100), handled: z.boolean() }).strict()

export async function PATCH(request: NextRequest) {
  const auth = await requirePermission(PERM_MANAGE)
  if ('response' in auth) return auth.response
  const parsed = Body.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return errorResponse('Bad request', 400)
  await setCallbackHandled(parsed.data.id, parsed.data.handled)
  return NextResponse.json({ ok: true })
}
