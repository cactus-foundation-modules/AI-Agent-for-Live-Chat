// POST /api/m/ai-agent-for-live-chat/admin/copy-from-phone - copies the phone
// assistant's business name, extra instructions, OpenAI key and sending
// address across, once (lib/copy-from-phone.ts).
import { NextResponse } from 'next/server'
import { errorResponse } from '@/lib/utils'
import { requirePermission } from '@/modules/ai-agent-for-live-chat/lib/admin-auth'
import { PERM_MANAGE } from '@/modules/ai-agent-for-live-chat/lib/constants'
import { copyFromPhoneAssistant } from '@/modules/ai-agent-for-live-chat/lib/copy-from-phone'

export async function POST() {
  const auth = await requirePermission(PERM_MANAGE)
  if ('response' in auth) return auth.response
  try {
    const result = await copyFromPhoneAssistant()
    if (!result.copied) return errorResponse(result.reason, 409)
    return NextResponse.json(result)
  } catch (cause) {
    console.error('[ai-agent-for-live-chat] could not copy from the phone assistant', cause)
    return errorResponse('Could not copy the phone assistant\'s settings. Check that this site has an encryption key set up.', 500)
  }
}
