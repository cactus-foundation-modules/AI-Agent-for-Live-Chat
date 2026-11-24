import { getSessionFromCookie } from '@/lib/auth/session'
import { hasPermission } from '@/lib/permissions/check'
import { getMemberFromCookie } from '@/lib/members/session'
import { CHAT_PERM_VIEW } from './constants'

// Who is behind the request Live Chat is answering, as far as the cookies say.
//
// Only the request knows: a turn running later in the background has no
// cookies to read. So the responder reads this while it is being offered the
// message and writes it onto the chat's row (lib/conversations.ts recordOffer).
//
// Outside a request the cookie readers throw; that is "nobody", not an error.

/** Whether the request is a signed-in colleague who can see Live Chat. Null
 *  when there is no request to read. */
export async function requestIsStaff(): Promise<boolean | null> {
  try {
    const user = await getSessionFromCookie()
    if (!user) return false
    return await hasPermission(user, CHAT_PERM_VIEW)
  } catch {
    return null
  }
}

/** The signed-in site member, if any. */
export async function requestMember(): Promise<{ id: string; email: string | null } | null> {
  try {
    const member = await getMemberFromCookie()
    if (!member) return null
    return { id: member.id, email: typeof member.email === 'string' && member.email ? member.email : null }
  } catch {
    return null
  }
}
