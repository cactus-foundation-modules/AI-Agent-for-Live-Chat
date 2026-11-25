import { escapeHtml } from '@/lib/email/render'
import { sendTemplateEmail } from '@/lib/email'
import { getShopConfigCached } from '@/modules/shop/lib/config'
import { orderUrlVars } from '@/modules/shop/lib/email'
import { orderTrackingUrl } from '@/modules/shop/lib/order-tracking'
import { renderProductTable } from '@/modules/unified-inbox/lib/products/render'
import { resolveProducts, type ProductChoice, type ProductRef } from '@/modules/unified-inbox/lib/products'
import { isPlausibleEmail, visitorWroteEmail } from './contact-text'
import { chosenDeliveries, productsToSend, type DiscussedProduct } from './discussed-products'
import { titleCaseName } from './name-case'
import { pickVerifiedOrder } from './order-checks'
import { MAX_EMAILS_PER_CHAT, MAX_EMAILS_PER_VISITOR_PER_HOUR, recentRateEvents, recordEmailSent, visitorKey } from './order-state'
import { getSettings } from './settings'
import { contactOnOrder, emailsOnOrders } from './shop/order-queries'
import { withDeliveryParam } from './shop/product-links'
import { toProductRefs } from './shop/product-queries'
import { sendableLinks } from './shop/site-content'
import { pickLinks, unknownLinksMessage, type SiteLink } from './shop/site-links'
import type { ToolContext, ToolResult } from './tools/registry'

// ---------------------------------------------------------------------------
// The emails the assistant sends a visitor: their order's link, and a written
// note of the chat. Both go through core's sender as this module, so the
// address they leave from is the one chosen on the settings tab (the Unified
// Inbox's sender for `ai-agent-for-live-chat`), and their wording is editable
// under Settings > Emails (lib/email-templates.ts).
//
// The security is in what is not free text:
//   - the order link goes ONLY to the address on that order, read from the
//     order here; nothing the model writes can change where it goes;
//   - the note goes to an address the visitor really typed in this chat (or
//     gave Live Chat's form, or their account's), or to the one on an order
//     they proved; never to one the model made up or was talked into;
//   - no address is ever handed back to the model, so none can be repeated in
//     the chat.
// The model's words reach the email only as escaped text; products and links
// are the shop's own, looked up by id. When the model passes no products, the
// note lists the ones this chat's product tools settled on
// (lib/discussed-products.ts), newest first, so a note of a chat about a desk
// never arrives without the desk. The visitor's name is greeted in proper case
// (lib/name-case.ts): "Hi Chris,", not "Hi chris,". A product the visitor
// chose a delivery service for (choose_delivery) is printed with that service
// under it, priced by the shop as the unified inbox prices one, and its link
// carries the service, exactly as the phone assistant's note does.
//
// Every send needs the visitor's yes (visitorAgreement), and a chat may send
// MAX_EMAILS_PER_CHAT, a visitor MAX_EMAILS_PER_VISITOR_PER_HOUR.
// ---------------------------------------------------------------------------

export const MAX_PRODUCTS_PER_EMAIL = 5
export const MAX_LINKS_PER_EMAIL = 5
const SUMMARY_MAX = 3000

/** Fewer letters than this is not an answer. */
const MIN_AGREEMENT_LENGTH = 2

/** What the visitor wrote to agree, as the tool received it, or null when
 *  there is no real agreement to go on. Pure. */
export function visitorAgreement(value: string | undefined): string | null {
  const said = value?.trim() ?? ''
  return said.replace(/[^\p{L}\p{N}]/gu, '').length >= MIN_AGREEMENT_LENGTH ? said : null
}

/** The answer a send tool gives without a yes. Pure. */
export function notAgreedResult(what: string, how: 'emailed' | 'texted' = 'emailed'): ToolResult {
  return {
    ok: false,
    sent: false,
    message: `Nothing has been sent. Do not say anything was. Ask whether they would like ${what} ${how} to them, and only once they say yes, call this again with their words in visitor_agreed.`,
  }
}

const SEND_FAILED: ToolResult = { ok: false, message: 'The email could not be sent just now. Say so, and offer to take their details for a callback instead.' }

/** Whether this chat or this visitor has used up its emails. */
export async function emailsUsedUp(ctx: Pick<ToolContext, 'conversationId' | 'visitorId' | 'orders'>): Promise<boolean> {
  if (ctx.orders.emailsSent >= MAX_EMAILS_PER_CHAT) return true
  return (await recentRateEvents(visitorKey(ctx.conversationId, ctx.visitorId), 'email')) >= MAX_EMAILS_PER_VISITOR_PER_HOUR
}

const USED_UP: ToolResult = { ok: false, message: 'Enough emails have been sent from this chat. Do not try again. Offer a callback instead.' }

/** Counts one email against the chat and the visitor. */
export async function countEmail(ctx: ToolContext): Promise<void> {
  await recordEmailSent(ctx.conversationId, visitorKey(ctx.conversationId, ctx.visitorId))
  ctx.orders.emailsSent += 1
}

// --- the order link ---------------------------------------------------------

export async function emailOrderLink(ctx: ToolContext, requested: string | null): Promise<ToolResult> {
  if (ctx.orders.verified.length === 0) {
    return { ok: false, message: 'No order has been proved in this chat yet. Check the order first (lookup_order), then try again.' }
  }
  const orderNumber = pickVerifiedOrder(ctx.orders.verified, requested)
  if (!orderNumber) return { ok: false, message: 'Which order do they mean? Ask for the order number (one already proved in this chat), then try again.' }
  if (await emailsUsedUp(ctx)) return USED_UP

  const contact = await contactOnOrder(orderNumber)
  if (!contact || !isPlausibleEmail(contact.email)) {
    return { ok: false, message: 'There is no usable email address on that order, so the link cannot be sent. Offer a callback instead.' }
  }
  const config = await getShopConfigCached()
  const url = orderTrackingUrl(orderNumber, config)
  if (!url) return { ok: false, message: 'Order links are not switched on for this shop, so none can be emailed. Offer a callback instead.' }

  const sent = await sendTemplateEmail(contact.email, 'ai-agent-for-live-chat.order-link', {
    customerName: titleCaseName(contact.name) || 'there',
    orderNumber,
    ...orderUrlVars(url, config),
  })
  if (!sent) return SEND_FAILED
  await countEmail(ctx)
  return { ok: true, sent: true, message: 'Sent to the email address on the order. Tell them it is on its way and to check their junk folder if it does not arrive in a few minutes. Never write the address out.' }
}

// --- the note of the chat ---------------------------------------------------

export type Recipient =
  | { kind: 'send'; email: string; source: 'typed' | 'order' | 'chat' | 'account' }
  | { kind: 'refuse'; message: string }

/**
 * Who a note of the chat goes to. Pure: everything it needs is passed in.
 *   - an address the model passes must be one the visitor typed in the chat,
 *     gave Live Chat's form or is signed in with;
 *   - else the address on a proved order (the one they name, or the only one);
 *   - else the address they gave Live Chat's form, or their account's.
 * The messages never contain an address.
 */
export function pickSummaryRecipient(input: {
  given: string | null
  orderNumber: string | null
  verified: readonly string[]
  orderEmails: readonly string[]
  namedOrderEmail: string | null
  visitorText: string
  visitorEmail: string | null
  memberEmail: string | null
}): Recipient {
  const given = input.given?.trim().toLowerCase() ?? ''
  const known = [input.visitorEmail, input.memberEmail].filter((e): e is string => !!e).map((e) => e.trim().toLowerCase())
  if (given) {
    if (!isPlausibleEmail(given)) return { kind: 'refuse', message: 'That email address does not look complete. Ask them to check it and type it again.' }
    if (visitorWroteEmail(input.visitorText, given)) return { kind: 'send', email: given, source: 'typed' }
    if (known.includes(given)) return { kind: 'send', email: given, source: input.visitorEmail?.trim().toLowerCase() === given ? 'chat' : 'account' }
    return { kind: 'refuse', message: 'A note can only go to an email address the visitor has typed in this chat themselves. Ask them to type the address they want it sent to.' }
  }
  if (input.orderNumber) {
    if (!input.namedOrderEmail || !isPlausibleEmail(input.namedOrderEmail)) {
      return { kind: 'refuse', message: 'That is not an order proved in this chat, or it has no usable email address. Ask them to type the address they want it sent to.' }
    }
    return { kind: 'send', email: input.namedOrderEmail.toLowerCase(), source: 'order' }
  }
  const onOrders = input.orderEmails.filter(isPlausibleEmail)
  if (onOrders.length === 1) return { kind: 'send', email: (onOrders[0] ?? '').toLowerCase(), source: 'order' }
  if (onOrders.length > 1) {
    return { kind: 'refuse', message: 'The orders proved in this chat carry different email addresses. Ask which order\'s address to use (pass its order_number) or for them to type the address they want; never write any address out.' }
  }
  const fallback = known[0]
  if (fallback && isPlausibleEmail(fallback)) return { kind: 'send', email: fallback, source: input.visitorEmail ? 'chat' : 'account' }
  return { kind: 'refuse', message: 'There is no email address to send it to. Ask them to type the address they want it sent to.' }
}

/** Plain text to email-safe HTML: blank lines split paragraphs, single newlines
 *  become line breaks. Everything is escaped. Pure. */
export function textToHtml(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter((p) => p !== '')
    .map((p) => `<p>${escapeHtml(p).replace(/\n/g, '<br>')}</p>`)
    .join('')
}

/** The pages and articles asked for, as the shop's own links. Pure. */
export function linksHtml(links: readonly SiteLink[]): string {
  if (links.length === 0) return ''
  const items = links.map((link) => `<li><a href="${escapeHtml(link.url)}">${escapeHtml(link.label)}</a></li>`).join('')
  return `<p>${links.length === 1 ? 'The link we mentioned:' : 'The links we mentioned:'}</p><ul>${items}</ul>`
}

/** One line, short enough for a subject. Pure. */
export function cleanSubject(raw: string | undefined): string {
  const line = (raw ?? '').replace(/\s+/g, ' ').trim().slice(0, 120)
  return line || 'A note of our chat'
}

/** The references with the delivery service the chat recorded for each one
 *  (by the exact product or variation id). The inbox prices it from the shop
 *  and prints it under the product; one no longer offered is simply left off.
 *  Pure. */
export function withChosenDeliveries(refs: readonly ProductRef[], recorded: readonly DiscussedProduct[]): ProductRef[] {
  const chosen = chosenDeliveries(recorded)
  return refs.map((ref) => {
    const delivery = chosen.get(ref.id)
    return delivery ? { ...ref, delivery: delivery.key } : ref
  })
}

/** A product as the email prints it: linked with its delivery service chosen
 *  where it has one the shop still offers. Pure. */
export function linkWithDelivery(choice: ProductChoice): ProductChoice {
  const key = choice.deliveryQuote?.key
  return key ? { ...choice, url: withDeliveryParam(choice.url, key) } : choice
}

export type SummaryArgs = {
  email: string | null
  orderNumber: string | null
  name: string | null
  subject: string | undefined
  summary: string
  productIds: string[]
  linkIds: string[]
}

export async function emailChatSummary(ctx: ToolContext, args: SummaryArgs): Promise<ToolResult> {
  if (await emailsUsedUp(ctx)) return USED_UP
  const named = args.orderNumber ? pickVerifiedOrder(ctx.orders.verified, args.orderNumber) : null
  const [orderEmails, namedContact] = await Promise.all([
    args.email || args.orderNumber ? Promise.resolve([] as string[]) : emailsOnOrders(ctx.orders.verified),
    named ? contactOnOrder(named) : Promise.resolve(null),
  ])
  const recipient = pickSummaryRecipient({
    given: args.email,
    orderNumber: args.orderNumber,
    verified: ctx.orders.verified,
    orderEmails,
    namedOrderEmail: namedContact?.email ?? null,
    visitorText: ctx.visitorText,
    visitorEmail: ctx.visitorEmail,
    memberEmail: ctx.member?.email ?? null,
  })
  if (recipient.kind === 'refuse') return { ok: false, sent: false, message: recipient.message }

  const summary = args.summary.trim().slice(0, SUMMARY_MAX)
  if (!summary) return { ok: false, message: 'There was nothing to put in the email. Write a short note of what was discussed and try again.' }

  const settings = await getSettings()
  const picked = args.linkIds.length > 0
    ? pickLinks(args.linkIds, await sendableLinks(settings.extraInstructions), MAX_LINKS_PER_EMAIL)
    : { links: [], unknown: 0 }
  if (args.linkIds.length > 0 && picked.links.length === 0) {
    return { ok: false, message: `Nothing was sent. ${unknownLinksMessage(picked.unknown)}` }
  }
  const listFor = async (given: readonly string[]) =>
    resolveProducts(withChosenDeliveries(await toProductRefs(productsToSend(given, ctx.products, MAX_PRODUCTS_PER_EMAIL)), ctx.products))
  let resolved = await listFor(args.productIds)
  if (resolved.length === 0 && args.productIds.length > 0 && ctx.products.length > 0) {
    // None of the ids the model passed is a product the shop can show: the
    // chat's own record, rather than a note with nothing in it.
    resolved = await listFor([])
  }
  const listing = renderProductTable(resolved.map((entry) => linkWithDelivery(entry.choice)))
  const name = args.name?.trim() || ctx.visitorName?.trim() || (recipient.source === 'order' ? namedContact?.name : '') || ''

  const sent = await sendTemplateEmail(recipient.email, 'ai-agent-for-live-chat.chat-summary', {
    customerName: titleCaseName(name) || 'there',
    subject: cleanSubject(args.subject),
    summaryHtml: textToHtml(summary) + linksHtml(picked.links),
    productsHtml: listing,
    hasProducts: listing ? 'true' : '',
  })
  if (!sent) return SEND_FAILED
  await countEmail(ctx)
  const leftOut = unknownLinksMessage(picked.unknown)
  return {
    ok: true,
    sent: true,
    productCount: resolved.length,
    message: ['Sent. Tell them it is on its way and to check their junk folder if it does not arrive in a few minutes. Never write the address out.', leftOut].filter(Boolean).join(' '),
  }
}
