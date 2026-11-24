import { getSessionFromCookie, type SessionUser } from '@/lib/auth/session'
import { hasPermission } from '@/lib/permissions/check'
import { errorResponse } from '@/lib/utils'

/** The signed-in colleague, if they hold the permission; otherwise the response
 *  to send back instead. Settings need this module's own permission; the chat
 *  window controls take Live Chat's, so whoever answers chats can use them. */
export async function requirePermission(permission: string): Promise<{ user: SessionUser } | { response: Response }> {
  const user = await getSessionFromCookie()
  if (!user) return { response: errorResponse('Not authenticated', 401) }
  if (!await hasPermission(user, permission)) return { response: errorResponse('Forbidden', 403) }
  return { user }
}
