import { readResponderAttachment } from '@/modules/chat/lib/responder-api'
import { addOrderNote, getOrderByNumber } from '@/modules/shop/lib/db/orders'
import { resolveIssuePhotos, receiveIssuePhoto } from '@/modules/shop/lib/issue-photos'
import { loadOrderDetail, type MemberOrderLine } from '@/modules/shop/lib/member-orders'
import { submitOrderRequest } from '@/modules/shop/lib/order-request-actions'
import { issueKindOf, isValidReason, reasonsFor } from '@/modules/shop/lib/order-requests'
import type { ShpOrderRequestType } from '@/modules/shop/lib/types'
import type { FileRef } from './attachments'
import { pickVerifiedOrder } from './order-checks'
import type { ToolContext, ToolResult } from './tools/registry'

// ---------------------------------------------------------------------------
// Raising a cancellation, a return or an issue report for a visitor, from the
// phone assistant's order-request-tool.ts (copied and kept in step by hand).
//
// The assistant files exactly what the customer could have filed on their
// order page, through the shop's own recording path, so it is checked the same
// way: the shop's rules for what may be asked for online (the returns window,
// the switches), and the lines checked against the order. Only an order proved
// in this chat can be touched, and only once the visitor has said yes to what
// was read back to them.
//
// PHOTOGRAPHS. On the phone a damage report asks for photographs in the
// confirmation email. In a chat the visitor has often sent them already, so
// those go straight into the report: each picture is handed to the shop's own
// upload path (receiveIssuePhoto - the same checks, the same Orders / <number>
// / issues folder as the customer's report form), then named on the report the
// way the form names its uploads (resolveIssuePhotos). Only the kinds the shop
// takes (JPEG, PNG, WebP), six at most; a PDF stays in the chat for a
// colleague. When none could be added - none sent, or the shop's media storage
// is not set up - the report asks for photographs in its email instead, as on
// the phone.
// ---------------------------------------------------------------------------

export type RequestKind = 'cancel' | 'return' | 'issue'

const SHOP_TYPE: Record<RequestKind, ShpOrderRequestType> = {
  cancel: 'CANCEL',
  return: 'RETURN',
  issue: 'DAMAGE',
}

const KIND_WORD: Record<RequestKind, string> = {
  cancel: 'cancellation',
  return: 'return',
  issue: 'issue report',
}

/** What is asked for when a damage report goes in without photographs. */
export const DEFAULT_PHOTO_NOTE =
  'Please send us photographs of the damage, and of the packaging too if that was damaged.'

export type RequestedLine = { item: string; quantity: number | null; missing: 'whole' | 'parts' | null }

export type LineChoice = { orderItemId: string; name: string; available: number }

export type MatchedLines =
  | { ok: true; lines: Array<{ orderItemId: string; quantity: number; missing: 'WHOLE' | 'PARTS' | null }> }
  | { ok: false; message: string }

function words(value: string): string[] {
  return value.toLowerCase().normalize('NFKD').replace(/[^\p{L}\p{N}]+/gu, ' ').trim().split(' ').filter(Boolean)
}

/** The order line the visitor means: an exact product code, else the one line
 *  whose name holds every word they used, else the one line that holds most of
 *  them. Null when nothing fits or two lines fit as well as each other. Pure. */
export function matchLine(said: string, lines: readonly LineChoice[], skus: ReadonlyMap<string, string>): LineChoice | null {
  const wanted = said.trim().toLowerCase()
  if (!wanted) return null
  const bySku = lines.filter((line) => (skus.get(line.orderItemId) ?? '').toLowerCase() === wanted)
  if (bySku.length === 1) return bySku[0] ?? null

  const saidWords = words(said)
  if (saidWords.length === 0) return null
  const scored = lines.map((line) => {
    const nameWords = new Set(words(`${line.name} ${skus.get(line.orderItemId) ?? ''}`))
    return { line, hits: saidWords.filter((word) => nameWords.has(word)).length }
  })
  const best = Math.max(...scored.map((entry) => entry.hits))
  if (best === 0) return null
  const top = scored.filter((entry) => entry.hits === best)
  return top.length === 1 ? (top[0]?.line ?? null) : null
}

/** The lines the visitor named as the shop's own lines, or a sentence the
 *  assistant can act on. An order of one line needs no naming. Pure. */
export function matchLines(
  requested: readonly RequestedLine[],
  choices: readonly LineChoice[],
  skus: ReadonlyMap<string, string>,
  opts: { missingReport: boolean; wholeOrderAllowed: boolean },
): MatchedLines {
  const open = choices.filter((choice) => choice.available > 0)
  const names = open.map((choice) => choice.name).join('; ')
  if (requested.length === 0) {
    if (opts.wholeOrderAllowed) return { ok: true, lines: [] }
    const only = open.length === 1 ? open[0] : undefined
    if (only && !opts.missingReport) return { ok: true, lines: [{ orderItemId: only.orderItemId, quantity: only.available, missing: null }] }
    return { ok: false, message: `Which item is it about? Ask them, then pass it in items. The items it can cover: ${names || 'none'}.` }
  }

  const lines: Array<{ orderItemId: string; quantity: number; missing: 'WHOLE' | 'PARTS' | null }> = []
  for (const entry of requested) {
    const line = matchLine(entry.item, open, skus)
    if (!line) {
      return { ok: false, message: `"${entry.item}" does not match one item this can cover. Ask them which they mean. The items it can cover: ${names || 'none'}.` }
    }
    const quantity = entry.quantity ?? line.available
    if (quantity > line.available) {
      return { ok: false, message: `Only ${line.available} of the ${line.name} can be included. Check the number with them.` }
    }
    if (opts.missingReport && !entry.missing) {
      return { ok: false, message: `For the ${line.name}, ask whether all of it is missing or just some parts, then pass missing as whole or parts.` }
    }
    lines.push({
      orderItemId: line.orderItemId,
      quantity,
      missing: opts.missingReport ? (entry.missing === 'parts' ? 'PARTS' : 'WHOLE') : null,
    })
  }
  return { ok: true, lines }
}

/** Units of a line a request of this kind can still name. An issue report
 *  covers what has arrived, and the visitor is believed when they say it has. */
function availableUnits(line: MemberOrderLine, kind: RequestKind): number {
  if (kind === 'cancel') return line.cancellableQty
  if (kind === 'return') return line.returnableQty
  return Math.max(line.item.quantity - line.item.refundedQty, 0)
}

export type RaiseInput = {
  kind: RequestKind
  reason: string
  orderNumber: string | null
  items: RequestedLine[]
  whatHappened: string | null
  photoNote: string | null
}

/**
 * The visitor's pictures, put through the shop's own photo upload for this
 * order. Returns the ones that landed, as the report names them. Never throws:
 * a picture that will not go is left in the chat, and the report still goes in.
 */
export async function uploadChatPhotos(conversationId: string, orderNumber: string, photos: readonly FileRef[]): Promise<Array<{ mediaId: string; url: string }>> {
  const ids: string[] = []
  for (const photo of photos) {
    try {
      const file = await readResponderAttachment(conversationId, photo.id)
      if (!file) continue
      const form = new FormData()
      form.append('file', new File([new Uint8Array(file.content)], file.filename || 'photo', { type: file.contentType }))
      // The shop's upload reads a multipart request; this is one, made here,
      // so the picture goes through exactly the checks a customer's would.
      const received = await receiveIssuePhoto(new Request('https://chat.invalid/issue-photo', { method: 'POST', body: form }), orderNumber)
      if (received.ok) ids.push(received.mediaId)
      else console.error(`[ai-agent-for-live-chat] the shop would not take a chat photo: ${received.error}`)
    } catch (err) {
      console.error('[ai-agent-for-live-chat] could not put a chat photo on a report', err)
    }
  }
  return ids.length > 0 ? resolveIssuePhotos(orderNumber, ids) : []
}

export async function raiseOrderRequest(ctx: ToolContext, input: RaiseInput): Promise<ToolResult> {
  if (ctx.orders.verified.length === 0) {
    return { ok: false, raised: false, message: 'No order has been proved in this chat yet. Check the order first (lookup_order), then try again.' }
  }
  const orderNumber = pickVerifiedOrder(ctx.orders.verified, input.orderNumber)
  if (!orderNumber) return { ok: false, raised: false, message: 'Which order is it about? Ask for the order number (one proved in this chat), then try again.' }

  const type = SHOP_TYPE[input.kind]
  if (!isValidReason(type, input.reason)) {
    const codes = reasonsFor(type).map((reason) => `${reason.code} (${reason.label})`).join(', ')
    return { ok: false, raised: false, message: `That is not a reason the shop takes for a ${KIND_WORD[input.kind]}. Pick the closest of: ${codes}.` }
  }
  const issueKind = type === 'DAMAGE' ? issueKindOf(input.reason) : null
  const whatHappened = input.whatHappened?.trim() || null
  if (issueKind === 'OTHER' && !whatHappened) {
    return { ok: false, raised: false, message: 'Ask them what is wrong, in a sentence, and pass it in what_happened.' }
  }
  if (issueKind === 'MISSING' && !whatHappened && input.items.some((item) => item.missing === 'parts')) {
    return { ok: false, raised: false, message: 'Ask them which parts are missing and pass it in what_happened, so the right ones can be sent.' }
  }

  const order = await getOrderByNumber(orderNumber)
  const detail = order ? await loadOrderDetail(order.id) : null
  if (!order || !detail) return { ok: false, raised: false, message: 'That order could not be opened just now. Offer a callback instead.' }

  const eligibility = type === 'CANCEL' ? detail.cancel : type === 'DAMAGE' ? detail.damage : detail.return
  if (!eligibility.allowed) {
    return {
      ok: false,
      raised: false,
      refusedBecause: eligibility.reason,
      message: `Nothing was raised: the shop does not take this as a ${KIND_WORD[input.kind]} on this order (reason above). Tell them kindly, in your own words, and offer a callback so the team can look at it.`,
    }
  }

  const choices: LineChoice[] = detail.lines.map((line) => ({
    orderItemId: line.item.id,
    name: line.item.productName,
    available: availableUnits(line, input.kind),
  }))
  const skus = new Map(detail.lines.map((line) => [line.item.id, line.item.productSku ?? '']))
  const matched = matchLines(input.items, choices, skus, {
    missingReport: issueKind === 'MISSING',
    // A cancellation naming nothing is the whole order, which the shop allows
    // only while none of it has gone; it says so itself if not.
    wholeOrderAllowed: type === 'CANCEL',
  })
  if (!matched.ok) return { ok: false, raised: false, message: matched.message }

  // Damage and faults need photographs. The ones sent in this chat go on the
  // report; with none, the confirmation email asks for them.
  const wantsPhotos = issueKind === 'DAMAGE'
  const photos = wantsPhotos && ctx.photos.length > 0 ? await uploadChatPhotos(ctx.conversationId, orderNumber, ctx.photos) : []
  const askForPhotos = wantsPhotos && photos.length === 0
  const photoNote = askForPhotos ? input.photoNote?.trim() || DEFAULT_PHOTO_NOTE : null

  const outcome = await submitOrderRequest(
    {
      orderId: order.id,
      memberId: order.memberId,
      type,
      reason: input.reason,
      customerNote: whatHappened,
      items: matched.lines.map((line) => ({ orderItemId: line.orderItemId, quantity: line.quantity, missing: line.missing })),
      photos,
    },
    {
      notifyCustomer: true,
      alertShop: true,
      photoRequest: askForPhotos ? { note: photoNote, userId: null } : null,
    },
  )
  if (!outcome.ok) {
    return { ok: false, raised: false, message: `Nothing was raised: ${outcome.error} Tell them in your own words, and offer a callback if it cannot be put right in the chat.` }
  }

  // The trail on the order: a request the customer did not type, from a chat
  // nobody at the shop was in.
  const word = KIND_WORD[input.kind]
  await addOrderNote(
    order.id,
    `${word.charAt(0).toUpperCase()}${word.slice(1)} raised by the chat assistant in a live chat.${photos.length > 0 ? ` ${photos.length} photograph(s) from the chat were added to it.` : askForPhotos ? ' The customer was asked for photographs.' : ''}`,
    true,
    null,
  ).catch((err: unknown) => console.error('[ai-agent-for-live-chat] could not add the order note', err))

  return {
    ok: true,
    raised: true,
    photosAdded: photos.length,
    photosRequested: askForPhotos,
    message: [
      `The ${word} is raised on order ${orderNumber}. The customer is being emailed to confirm it, at the address on the order.`,
      photos.length > 0
        ? `The ${photos.length === 1 ? 'photograph' : `${photos.length} photographs`} they sent in this chat went in with it. Tell them, and that the team will look at it.`
        : askForPhotos
          ? 'That email asks for photographs of the damage, with a link to add them to the report. Tell them that, and to check their junk folder if it does not arrive.'
          : 'Tell them the team will look at it and be in touch.',
      'Do not promise a refund, a replacement or a time.',
    ].join(' '),
  }
}
