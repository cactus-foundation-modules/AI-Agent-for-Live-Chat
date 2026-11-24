// GET/POST /api/m/ai-agent-for-live-chat/cron/handover
//
// Every two minutes: brings back any chat handed to a colleague whose
// hand-over wait has run out with nobody replying. The timer in the server
// process normally does this on time (lib/handover.ts); this is the safety net
// for a restart, or a chat handed over on another server. Idempotent - each
// chat is claimed by one conditional UPDATE, so a sweep racing the timer never
// apologises twice. Same CRON_SECRET bearer as every other module's cron.
import { NextRequest, NextResponse } from 'next/server'
import { errorResponse } from '@/lib/utils'
import { sweepHandovers } from '@/modules/ai-agent-for-live-chat/lib/handover'

async function handle(request: NextRequest) {
  const secret = process.env.CRON_SECRET
  if (!secret) return errorResponse('CRON_SECRET is not configured', 503)
  if (request.headers.get('authorization') !== `Bearer ${secret}`) return errorResponse('Unauthorized', 401)
  try {
    const cameBack = await sweepHandovers()
    return NextResponse.json({ ok: true, cameBack })
  } catch (error) {
    console.error('[ai-agent-for-live-chat] the hand-over sweep failed', error)
    return NextResponse.json({ ok: false, error: 'the hand-over sweep failed' }, { status: 500 })
  }
}

export async function GET(request: NextRequest) {
  return handle(request)
}

export async function POST(request: NextRequest) {
  return handle(request)
}
