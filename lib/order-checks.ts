import { scrubContactDetails } from './contact-text'
import {
  MAX_FAILED_CHECKS_PER_CHAT,
  MAX_FAILED_CHECKS_PER_VISITOR_PER_HOUR,
  addVerifiedOrders,
  recentRateEvents,
  recordFailedCheck,
  visitorKey,
} from './order-state'
import { listMemberOrders, lookupMemberOrder, lookupOrders, type VerifiedOrder } from './shop/order-queries'
import { isCheckableClaim, type OrderClaim } from './shop/order-verify'
import { normaliseOrderNumber, orderNumbersMatch } from './shop/text'
import type { ToolContext, ToolResult } from './tools/registry'

// ---------------------------------------------------------------------------
// Order enquiries in a chat: who may hear about which order.
//
// Two ways to prove an order is yours:
//   - signed in: the chat's member (recorded when the message was offered,
//     lib/people.ts) may ask about any order on their own account with no
//     further proof, and only those (shp_orders.member_id);
//   - anybody else: the delivery postcode plus one of the order number, the
//     email on the order or the company name, exactly as on the phone
//     (lib/shop/order-verify.ts).
// A proved order is remembered on the chat (aichat_conversations
// .verified_orders) and is the only kind the other order tools will touch.
//
// Wrong answers are limited: three in a chat, six from one visitor in an hour
// (Live Chat's visitor id, or the chat when it has none). A signed-in member
// naming an order that is not on their account is not a wrong answer - they
// guessed nothing - and is checked the ordinary way if they give a postcode.
//
// What comes back never carries an email address, a phone number or a street
// address: the order rows are read without them (lib/shop/order-queries.ts),
// and the free text an order holds is scrubbed of anything that looks like one.
// ---------------------------------------------------------------------------

/** The order as the model may see it: free text scrubbed of contact details. */
export function safeOrder(order: VerifiedOrder): VerifiedOrder {
  const clean = (text: string | null) => (text ? scrubContactDetails(text) : text)
  return {
    ...order,
    deliveryInstructions: clean(order.deliveryInstructions),
    customerReference: clean(order.customerReference),
    notesFromTeam: order.notesFromTeam.map((note) => ({ ...note, text: scrubContactDetails(note.text) })),
  }
}

export type CheckArgs = {
  postcode: string
  orderNumber: string | null
  email: string | null
  companyName: string | null
}

const MATCHED_NOTE =
  'Proved for this chat. Answer only about the order they asked about: where it is and the one date that matters, then stop. Never write out an email address, a phone number or a street address; the town is fine.'

function matched(orders: VerifiedOrder[], how: 'account' | 'details'): ToolResult {
  return {
    ok: true,
    matched: true,
    how,
    orders: orders.map(safeOrder),
    note: MATCHED_NOTE,
  }
}

/** Whether order checks are closed for this chat or this visitor. */
export async function checksLocked(ctx: Pick<ToolContext, 'conversationId' | 'visitorId' | 'orders'>): Promise<boolean> {
  if (ctx.orders.failedChecks >= MAX_FAILED_CHECKS_PER_CHAT) return true
  const recent = await recentRateEvents(visitorKey(ctx.conversationId, ctx.visitorId), 'failed_check')
  return recent >= MAX_FAILED_CHECKS_PER_VISITOR_PER_HOUR
}

async function remember(ctx: ToolContext, orderNumbers: readonly string[]): Promise<void> {
  const saved = await addVerifiedOrders(ctx.conversationId, orderNumbers)
  for (const number of saved.length > 0 ? saved : orderNumbers) {
    if (!ctx.orders.verified.includes(number)) ctx.orders.verified.push(number)
  }
}

/** lookup_order: the member's own order, or the postcode check. */
export async function checkOrder(ctx: ToolContext, args: CheckArgs): Promise<ToolResult> {
  // A signed-in member's own order needs nothing more.
  if (ctx.member && args.orderNumber) {
    const own = await lookupMemberOrder(ctx.member.id, args.orderNumber)
    if (own.matched) {
      await remember(ctx, own.internalNumbers)
      return matched(own.orders, 'account')
    }
  }

  if (await checksLocked(ctx)) {
    return { ok: false, locked: true, message: 'Too many checks have not matched. Do not try again. Offer to take their name and email for a callback.' }
  }

  const claim: OrderClaim = {
    postcode: args.postcode,
    orderNumber: args.orderNumber,
    email: args.email,
    companyName: args.companyName,
  }
  if (!isCheckableClaim(claim)) {
    return {
      ok: false,
      message: ctx.member && args.orderNumber
        ? 'That order is not on the account they are signed in with. To check it, ask for the delivery postcode as well; do not say whose account it might be on.'
        : 'To check an order I need the delivery postcode and one of: the order number, the email address on the order, or the company name. Ask for what is missing.',
    }
  }

  const outcome = await lookupOrders(claim)
  if (!outcome.matched) {
    await recordFailedCheck(ctx.conversationId, visitorKey(ctx.conversationId, ctx.visitorId))
    ctx.orders.failedChecks += 1
    return { ok: false, matched: false, message: 'No order matches those details. Ask them to double-check and try once more. Do not say which part was wrong.' }
  }
  await remember(ctx, outcome.internalNumbers)
  return matched(outcome.orders, 'details')
}

/** list_my_orders: a signed-in member's newest orders, summary only. */
export async function myOrders(ctx: ToolContext): Promise<ToolResult> {
  if (!ctx.member) {
    return { ok: false, message: 'They are not signed in, so there is no account to list. Ask for the order number and the delivery postcode instead (lookup_order).' }
  }
  const orders = await listMemberOrders(ctx.member.id)
  if (orders.length === 0) {
    return { ok: true, orders: [], message: 'There are no orders on the account they are signed in with. If they ordered as a guest or on another account, check it with lookup_order (order number and delivery postcode).' }
  }
  return {
    ok: true,
    orders,
    note: 'Use this only to find the order they mean (ask when, or what was in it, if unclear). Do not list them back. For any detail, call lookup_order with that order number.',
  }
}

/** The proved order a tool should act on: the one whose number they gave
 *  (with or without the prefix and padding zeros), or the only one proved.
 *  Never an order not proved in this chat. Pure. */
export function pickVerifiedOrder(verified: readonly string[], requested: string | null): string | null {
  if (requested?.trim()) {
    const wanted = normaliseOrderNumber(requested)
    return verified.find((held) => normaliseOrderNumber(held) === wanted) ?? verified.find((held) => orderNumbersMatch(requested, held)) ?? null
  }
  return verified.length === 1 ? (verified[0] ?? null) : null
}
