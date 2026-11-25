import { getActiveSmsProvider } from '@/lib/auth/sms'
import { getShopConfigCached } from '@/modules/shop/lib/config'
import { orderTrackingUrl } from '@/modules/shop/lib/order-tracking'
import { productLinksToSend } from './discussed-products'
import { pickVerifiedOrder } from './order-checks'
import { MAX_TEXTS_PER_CHAT, MAX_TEXTS_PER_VISITOR_PER_HOUR, recentRateEvents, recordTextSent, visitorKey } from './order-state'
import { getSettings } from './settings'
import { phonesOnOrders } from './shop/order-queries'
import { sendableLinks } from './shop/site-content'
import { pickLinks, unknownLinksMessage } from './shop/site-links'
import { getSiteUrlOrNull } from '@/lib/config/env'
import { MAX_TEXT_LINKS, composeText, pickTextRecipient, textSignOff, type TextLinkLine } from './text-message'
import type { ToolContext, ToolResult } from './tools/registry'

// ---------------------------------------------------------------------------
// send_text: a short note with the shop's own links, texted to the visitor.
//
// It goes through core's SMS provider (getActiveSmsProvider, whichever module
// offers one), never a provider directly, so this module carries no texting
// dependency of its own; a site with none set up is told so, and the model
// offers an email instead. Who it may go to and what it may say are in
// lib/text-message.ts: the email rule for the number, the shop's own links for
// the content, and the number never handed back.
//
// Every text needs the visitor's yes (the tool checks it), and a chat may send
// MAX_TEXTS_PER_CHAT, a visitor MAX_TEXTS_PER_VISITOR_PER_HOUR, counted in
// aichat_rate_events like the emails.
// ---------------------------------------------------------------------------

export type TextWhat = 'summary' | 'order_link'

export type TextArgs = {
  what: TextWhat
  note: string | null
  phone: string | null
  orderNumber: string | null
  productIds: string[]
  linkIds: string[]
}

const NOT_SET_UP: ToolResult = { ok: false, sent: false, message: 'Texts are not set up on this site. Do not offer one again; offer to email it instead.' }
const USED_UP: ToolResult = { ok: false, sent: false, message: 'Enough texts have been sent from this chat. Do not try again. Offer to email it instead.' }
const WHICH_ORDER = 'Which order do they mean? Ask for the order number (one already proved in this chat), then try again.'
const SEND_FAILED: ToolResult = { ok: false, sent: false, message: 'The text could not be sent just now. Say so, and offer to email it instead.' }

/** Whether the site can send a text at all. Cheap enough to ask at the start
 *  of each turn; false whenever anything about it fails. */
export async function textingAvailable(): Promise<boolean> {
  try {
    return (await getActiveSmsProvider()) !== null
  } catch {
    return false
  }
}

/** Whether this chat or this visitor has used up its texts. */
export async function textsUsedUp(ctx: Pick<ToolContext, 'conversationId' | 'visitorId' | 'textsSent'>): Promise<boolean> {
  if (ctx.textsSent >= MAX_TEXTS_PER_CHAT) return true
  return (await recentRateEvents(visitorKey(ctx.conversationId, ctx.visitorId), 'text')) >= MAX_TEXTS_PER_VISITOR_PER_HOUR
}

type Content = { kind: 'text'; body: string; links: number; leftOut: string } | { kind: 'refuse'; message: string }

/** The words and links of the text, or why there are none. */
async function content(ctx: ToolContext, args: TextArgs, orderNumber: string | null): Promise<Content> {
  const settings = await getSettings()
  const signOff = textSignOff(settings.businessName, getSiteUrlOrNull())
  if (args.what === 'order_link') {
    if (!orderNumber) return { kind: 'refuse', message: WHICH_ORDER }
    const url = orderTrackingUrl(orderNumber, await getShopConfigCached())
    if (!url) return { kind: 'refuse', message: 'Order links are not switched on for this shop, so none can be texted. Offer a callback instead.' }
    const note = args.note || `Here is the page for your order ${orderNumber}, where you can follow its progress and report a problem.`
    return { kind: 'text', body: composeText(note, [{ label: null, url }], signOff), links: 1, leftOut: '' }
  }
  const note = (args.note ?? '').trim()
  if (!note) return { kind: 'refuse', message: 'Write a short note of what the text is for and try again.' }
  // The page or article they asked for comes first; products fill what room is left.
  const picked = args.linkIds.length > 0
    ? pickLinks(args.linkIds, await sendableLinks(settings.extraInstructions), MAX_TEXT_LINKS)
    : { links: [], unknown: 0 }
  if (args.linkIds.length > 0 && picked.links.length === 0) {
    return { kind: 'refuse', message: `Nothing was sent. ${unknownLinksMessage(picked.unknown)}` }
  }
  const links: TextLinkLine[] = []
  for (const link of [...picked.links.map((page) => ({ label: page.label, url: page.url })), ...productLinksToSend(args.productIds, ctx.products, MAX_TEXT_LINKS)]) {
    if (!links.some((kept) => kept.url === link.url)) links.push(link)
  }
  links.splice(MAX_TEXT_LINKS)
  return { kind: 'text', body: composeText(note, links, signOff), links: links.length, leftOut: unknownLinksMessage(picked.unknown) }
}

export async function sendChatText(ctx: ToolContext, args: TextArgs): Promise<ToolResult> {
  const provider = await getActiveSmsProvider().catch(() => null)
  if (!provider) return NOT_SET_UP
  if (await textsUsedUp(ctx)) return USED_UP

  const orderOnly = args.what === 'order_link'
  if (orderOnly && ctx.orders.verified.length === 0) {
    return { ok: false, sent: false, message: 'No order has been proved in this chat yet. Check the order first (lookup_order), then try again.' }
  }
  const orderNumber = orderOnly || args.orderNumber ? pickVerifiedOrder(ctx.orders.verified, args.orderNumber) : null
  if (orderOnly && !orderNumber) return { ok: false, sent: false, message: WHICH_ORDER }
  const recipient = pickTextRecipient({
    given: args.phone,
    // An order they named but did not prove is passed as named, and refused.
    orderNumber: orderNumber ?? args.orderNumber,
    orderOnly,
    verified: ctx.orders.verified,
    orderPhones: ctx.orders.verified.length > 0 ? await phonesOnOrders(ctx.orders.verified) : [],
    visitorText: ctx.visitorText,
    contactPhone: ctx.visitorPhone,
  })
  if (recipient.kind === 'refuse') return { ok: false, sent: false, message: recipient.message }

  const made = await content(ctx, args, orderNumber)
  if (made.kind === 'refuse') return { ok: false, sent: false, message: made.message }
  try {
    await provider.sendSms(recipient.to, made.body)
  } catch (err) {
    console.error('[ai-agent-for-live-chat] a text to the visitor failed', err)
    return SEND_FAILED
  }
  await recordTextSent(ctx.conversationId, visitorKey(ctx.conversationId, ctx.visitorId))
  ctx.textsSent += 1
  return {
    ok: true,
    sent: true,
    linkCount: made.links,
    message: ['Texted. Tell them it is on its way. Never write the number out.', made.leftOut].filter(Boolean).join(' '),
  }
}
