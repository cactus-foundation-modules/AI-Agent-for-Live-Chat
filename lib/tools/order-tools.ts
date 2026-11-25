import { z } from 'zod'
import { checkOrder, myOrders } from '../order-checks'
import { emailChatSummary, emailOrderLink, notAgreedResult, visitorAgreement, MAX_LINKS_PER_EMAIL, MAX_PRODUCTS_PER_EMAIL } from '../emails'
import { raiseOrderRequest } from '../order-request'
import { MAX_QUOTE_LINES, saveChatQuote } from '../quote'
import { MAX_TEXT_LINKS } from '../text-message'
import { sendChatText } from '../texts'
import { visitorHistory } from '../visitor-history'
import { defineTool, type ToolParameters, type ToolResult } from './registry'

// ---------------------------------------------------------------------------
// The tools about a visitor's own orders and anything sent to them: checking
// an order, a signed-in member's list, the order link, a note of the chat,
// earlier contact, raising a request, saving a quote and a text. Ported from
// the phone assistant's tools and rewritten for a chat (lib/order-checks.ts
// says who may hear about which order).
//
// None of them ever hands the model an email address, a phone number or a
// street address, and none of them logs one: each summarise says what
// happened (matched, sent, raised), never what it was given.
// ---------------------------------------------------------------------------

function text(description: string): Record<string, unknown> {
  return { type: 'string', description }
}

const NO_ARGS: ToolParameters = { type: 'object', properties: {}, required: [], additionalProperties: false }

function blankToNull(value: string | undefined): string | null {
  return value && value.trim() !== '' ? value.trim() : null
}

/** Every tool that sends the visitor something, or files something for them,
 *  carries their yes in their own words. */
const VISITOR_AGREED =
  "The visitor's own words agreeing to this, written in reply to you offering it in this chat, for example \"yes please\". Never fill this in from a question they asked or from what you think they would want: if they have not said yes, do not call this tool, ask them first."

const AgreedField = z.string().max(300).optional()

function sent(result: ToolResult | null): string {
  if (!result) return 'failed'
  return result.sent === true ? 'sent' : 'not sent'
}

export const lookupOrderTool = defineTool({
  name: 'lookup_order',
  description: 'Check an order for the visitor. A signed-in visitor needs only the order number for an order on their own account. Anybody else needs the delivery postcode AND one of: the order number, the email address on the order, or the company name on the order. Returns status, items, costs, paperwork and delivery progress only when it matches; otherwise says it did not match.',
  parameters: {
    type: 'object',
    properties: {
      order_number: text('The order number, if they gave it.'),
      delivery_postcode: text('The delivery postcode of the order, as they wrote it. Not needed for a signed-in visitor\'s own order.'),
      email: text('The email address used on the order, if they gave it instead of the order number.'),
      company_name: text('The company name on the order, if they gave it instead of the order number.'),
    },
    required: [],
    additionalProperties: false,
  },
  input: z.object({
    order_number: z.string().trim().max(60).optional(),
    delivery_postcode: z.string().trim().max(20).optional(),
    email: z.string().trim().max(320).optional(),
    company_name: z.string().trim().max(160).optional(),
  }),
  // Whether it matched, and nothing of what was given.
  summarise: (_args, result) => {
    if (!result) return 'order check failed'
    if (result.locked === true) return 'locked: too many checks did not match'
    if (result.matched === true) return result.how === 'account' ? 'matched (their own account)' : 'matched'
    if (result.matched === false) return 'did not match'
    return 'details incomplete'
  },
  guidance: 'Never reveal anything about an order until lookup_order has matched it in this chat, and talk only about the one order they asked about.',
  async handler(ctx, args) {
    return checkOrder(ctx, {
      postcode: args.delivery_postcode ?? '',
      orderNumber: blankToNull(args.order_number),
      email: blankToNull(args.email),
      companyName: blankToNull(args.company_name),
    })
  },
})

export const listMyOrdersTool = defineTool({
  name: 'list_my_orders',
  description: "A signed-in visitor's own recent orders, newest first: order number, when it was placed, status, total and how many items. Summary only, for finding which order they mean when they do not have the number. Works only when they are signed in, and only lists orders on their account.",
  parameters: NO_ARGS,
  input: z.object({}).passthrough(),
  summarise: (_args, result) => (result?.ok === true ? `${Array.isArray(result.orders) ? result.orders.length : 0} order(s) on their account` : 'not signed in'),
  async handler(ctx) {
    return myOrders(ctx)
  },
})

export const emailOrderLinkTool = defineTool({
  name: 'email_order_link',
  description: "Email the visitor the link to their order's page (progress, tracking, paperwork). Only for an order proved in this chat, and only ever to the email address on that order, which cannot be changed. Only once they have said yes to it, in reply to you offering it.",
  parameters: {
    type: 'object',
    properties: {
      visitor_agreed: text(VISITOR_AGREED),
      order_number: text('Only if more than one order is proved in this chat: the one they mean.'),
    },
    required: ['visitor_agreed'],
    additionalProperties: false,
  },
  input: z.object({ visitor_agreed: AgreedField, order_number: z.string().trim().max(60).optional() }),
  summarise: (_args, result) => sent(result),
  guidance: 'Asking about tracking is a question, not a request: say their order\'s page shows it and is linked in their confirmation email, then offer to email the link, and only on a yes call email_order_link.',
  async handler(ctx, args) {
    if (!visitorAgreement(args.visitor_agreed)) return notAgreedResult('the link to their order page')
    return emailOrderLink(ctx, blankToNull(args.order_number))
  },
})

export const emailSummaryTool = defineTool({
  name: 'email_summary',
  description: "Email the visitor a short written note of the chat (product advice, answers to their questions), with the shop's own links to the products, pages and articles you pass. Only once they have said yes to it. ALWAYS pass product_ids with every product you recommended or they chose (the chosen variation's own id where there is one); the email lists them with picture, link and price, and with the delivery service they chose for one (choose_delivery) under it. Goes to an email address they typed in this chat (pass it in email), or the one on an order proved in this chat. Never include order details.",
  parameters: {
    type: 'object',
    properties: {
      visitor_agreed: text(VISITOR_AGREED),
      email: text('The email address exactly as they typed it in this chat. Omit to use the address on an order proved in this chat, or the one they gave the chat form.'),
      order_number: text('Only to send it to the address on one particular order proved in this chat, when several are.'),
      name: text('Their first name for the greeting, if they gave it.'),
      subject: text('A short subject line, for example "The standing desks we talked about".'),
      summary: text('The note itself: plain sentences covering what they wanted, what you recommended and why, and the key facts. No prices (the email lists them, delivery included), no order details, no web addresses.'),
      product_ids: {
        type: 'array',
        description: `Always fill this in when any product came up: the id of every product you recommended or they chose, the chosen variation's own id (from matchingVariations or find_by_sku) where there is one, never only the listing's. The email lists each with its picture, link and price. At most ${MAX_PRODUCTS_PER_EMAIL}.`,
        items: text('One product or variation id, exactly as the tools returned it.'),
      },
      link_ids: {
        type: 'array',
        description: `Pages or articles they wanted, linked under the note: each a link id (pageLinkId, or an id from links) from search_pages or search_guides, or an address the tools gave you. At most ${MAX_LINKS_PER_EMAIL}.`,
        items: text('One link id or address, exactly as the tools returned it.'),
      },
    },
    required: ['visitor_agreed', 'summary'],
    additionalProperties: false,
  },
  input: z.object({
    visitor_agreed: AgreedField,
    email: z.string().trim().max(320).optional(),
    order_number: z.string().trim().max(60).optional(),
    name: z.string().trim().max(120).optional(),
    subject: z.string().trim().max(200).optional(),
    summary: z.string().trim().min(1).max(4000),
    product_ids: z.array(z.string().trim().min(1).max(100)).max(MAX_PRODUCTS_PER_EMAIL * 2).optional(),
    link_ids: z.array(z.string().trim().min(1).max(600)).max(10).optional(),
  }),
  // The products the email listed (the chat's own record when none were
  // passed), not merely how many the model named.
  summarise: (args, result) => `${sent(result)}; ${typeof result?.productCount === 'number' ? result.productCount : args.product_ids?.length ?? 0} product(s), ${args.link_ids?.length ?? 0} link(s)`,
  async handler(ctx, args) {
    if (!visitorAgreement(args.visitor_agreed)) return notAgreedResult('a written note of the chat')
    return emailChatSummary(ctx, {
      email: blankToNull(args.email),
      orderNumber: blankToNull(args.order_number),
      name: blankToNull(args.name),
      subject: args.subject,
      summary: args.summary,
      productIds: args.product_ids ?? [],
      linkIds: args.link_ids ?? [],
    })
  },
})

export const getVisitorHistoryTool = defineTool({
  name: 'get_visitor_history',
  description: "What this visitor has said to the shop before: earlier live chats, phone calls and emails or messages, matched only on the email on an order proved in this chat or their account's (so for anybody else, prove an order first); newest first, with what each was about and whether it is still open. Plus any return or damage request still open on a proved order. Use when they refer to an earlier conversation.",
  parameters: NO_ARGS,
  input: z.object({}).passthrough(),
  summarise: (_args, result) => (result?.ok === true ? `${Array.isArray(result.items) ? result.items.length : 0} earlier contact(s)` : ''),
  async handler(ctx) {
    const history = await visitorHistory(ctx)
    if (history.matchedOn === 0 && history.openRequests.length === 0) {
      return { ok: true, items: [], openRequests: [], note: 'There is nothing to match their history on yet. Ask what it was about; if it was about an order, check the order as usual.' }
    }
    const empty = history.items.length === 0 && history.openRequests.length === 0
    return {
      ok: true,
      items: history.items,
      openRequests: history.openRequests,
      note: empty
        ? 'Nothing earlier is linked to them. Do not tell them that; ask what it was about.'
        : 'Use this to recognise what they mean. Do not list it back, and never promise what somebody else may have said.',
    }
  },
})

export const raiseOrderRequestTool = defineTool({
  name: 'raise_order_request',
  description: "Raise a cancellation, a return or an issue report (damaged, faulty or missing items, or another problem with what arrived) on an order proved in this chat, exactly as they could on their order page, once you have written back what you will raise and they have said yes. The shop checks it against its own rules, emails the customer to confirm and alerts the team. Pictures they sent in this chat go into a damage report; with none, the confirmation email asks for them. Tells you if the shop will not take it, and why.",
  parameters: {
    type: 'object',
    properties: {
      visitor_agreed: text("The visitor's own words agreeing to you raising it, written after you wrote back which order, which items and why, for example \"yes, go ahead\". If they have not said yes, do not call this tool; ask them first."),
      kind: { type: 'string', enum: ['cancel', 'return', 'issue'], description: 'cancel: they want all or part of an order called off before it arrives. return: they want to send back something that arrived and that they do not want. issue: something arrived damaged, has a fault, is missing (all of it or parts), or is otherwise wrong. Damage and faults are ALWAYS issue, never return.' },
      reason: text('The reason code. cancel: CHANGED_MIND, ORDERED_WRONG, FOUND_ELSEWHERE, TOO_SLOW or OTHER. return: WRONG_ITEM, NOT_AS_DESCRIBED, NO_LONGER_NEEDED or OTHER. issue: ARRIVED_DAMAGED, FAULTY (developed a fault since), MISSING (a whole item or parts did not turn up) or OTHER.'),
      order_number: text('Only if more than one order is proved in this chat: the one they mean.'),
      items: {
        type: 'array',
        description: 'The items it covers, as named on the order. Omit only for a cancellation of the whole order, or when the order has a single item.',
        items: {
          type: 'object',
          description: 'One item on the order.',
          properties: {
            item: text('The item as the order lookup named it (its name, or its product code).'),
            quantity: { type: 'number', description: 'How many of that item. Omit for all of them.' },
            missing: { type: 'string', enum: ['whole', 'parts'], description: 'Only for reason MISSING: whole if the whole item did not arrive, parts if only some parts are missing.' },
          },
          required: ['item'],
        },
      },
      what_happened: text('What they told you, in a sentence or two (what is damaged and how, which parts are missing, what is wrong). Required for reason OTHER and for missing parts; always worth giving for damage.'),
      photo_note: text('Optional, for damage or a fault when they have sent no pictures: what the photographs should show, if they described something particular.'),
    },
    required: ['visitor_agreed', 'kind', 'reason'],
    additionalProperties: false,
  },
  input: z.object({
    visitor_agreed: AgreedField,
    kind: z.enum(['cancel', 'return', 'issue']),
    reason: z.string().trim().min(1).max(40),
    order_number: z.string().trim().max(60).optional(),
    items: z.array(z.object({
      item: z.string().trim().min(1).max(200),
      quantity: z.number().int().positive().max(100_000).optional(),
      missing: z.enum(['whole', 'parts']).optional(),
    })).max(50).optional(),
    what_happened: z.string().trim().max(2000).optional(),
    photo_note: z.string().trim().max(1000).optional(),
  }),
  summarise: (args, result) => `${args.kind} (${args.reason.toUpperCase()}): ${result?.raised === true ? 'raised' : 'not raised'}`,
  async handler(ctx, args) {
    if (!visitorAgreement(args.visitor_agreed)) {
      return {
        ok: false,
        raised: false,
        message: 'Nothing has been raised. Write back what you are about to raise (which order, which items, and why) and ask whether you should go ahead. Only once they say yes, call this again with their words in visitor_agreed.',
      }
    }
    return raiseOrderRequest(ctx, {
      kind: args.kind,
      reason: args.reason.toUpperCase(),
      orderNumber: blankToNull(args.order_number),
      items: (args.items ?? []).map((entry) => ({ item: entry.item, quantity: entry.quantity ?? null, missing: entry.missing ?? null })),
      whatHappened: blankToNull(args.what_happened),
      photoNote: blankToNull(args.photo_note),
    })
  },
})

export const saveQuoteTool = defineTool({
  name: 'save_quote',
  description: "Save the products they settled on as a quote in their name, which the shop emails them with its quote number and a link that opens the basket. Only once the list is complete and they have said yes to having it emailed as a quote. Pass every line with its exact variation id (from matchingVariations in get_product; a product with no options uses its own id) and quantity. A line they chose a delivery service for (choose_delivery) is saved with it. Needs their name, and an email address they typed in this chat unless they gave one to the chat form. Says if this shop does not save quotes.",
  parameters: {
    type: 'object',
    properties: {
      visitor_agreed: text(VISITOR_AGREED),
      items: {
        type: 'array',
        description: `Every line of the quote. At most ${MAX_QUOTE_LINES}.`,
        items: {
          type: 'object',
          description: 'One line.',
          properties: {
            product_id: text('The exact variation id, or the product id for a product with no options.'),
            quantity: { type: 'number', description: 'How many, as a whole number.' },
          },
          required: ['product_id', 'quantity'],
        },
      },
      name: text('Their full name, for the quote.'),
      email: text('The email address exactly as they typed it in this chat. Omit only if they gave one to the chat form.'),
    },
    required: ['visitor_agreed', 'items'],
    additionalProperties: false,
  },
  input: z.object({
    visitor_agreed: AgreedField,
    items: z.array(z.object({
      product_id: z.string().trim().min(1).max(100),
      quantity: z.number().int().positive().max(100_000),
    })).min(1).max(MAX_QUOTE_LINES),
    name: z.string().trim().max(120).optional(),
    email: z.string().trim().max(320).optional(),
  }),
  summarise: (args, result) => `${args.items.length} line(s): ${result?.ok === true ? 'saved' : 'not saved'}`,
  async handler(ctx, args) {
    if (!visitorAgreement(args.visitor_agreed)) return notAgreedResult('the products as a quote')
    return saveChatQuote(ctx, {
      name: blankToNull(args.name),
      email: blankToNull(args.email),
      lines: args.items.map((line) => ({ productId: line.product_id, quantity: line.quantity })),
    })
  },
})

export const sendTextTool = defineTool({
  name: 'send_text',
  description: `Text the visitor a short note with the shop's own links: the pages of products discussed in this chat, a page or article the tools returned, or (what "order_link") the page of an order proved in this chat. Only once they have said yes to it, and only when the note about the visitor says texting is available. Goes only to a UK mobile: a number they typed in this chat themselves (pass it in phone, exactly as typed), the one they gave the chat form, or the one on an order proved in this chat; the order link goes only to the mobile on that order. Never put personal details in the note. Says if texts are not set up or the number cannot take one; then offer email instead. At most ${MAX_TEXT_LINKS} links.`,
  parameters: {
    type: 'object',
    properties: {
      visitor_agreed: text(VISITOR_AGREED),
      what: { type: 'string', enum: ['summary', 'order_link'], description: 'summary: a short note with product, page or article links. order_link: the page of an order proved in this chat (progress, tracking, reporting a problem).' },
      note: text('The words of the text: one or two plain sentences, for example "Here are the two desks we talked about." No prices, no web addresses, no email addresses or phone numbers. Required for summary.'),
      phone: text('The mobile number exactly as they typed it in this chat. Omit to use the number they gave the chat form, or the one on an order proved in this chat.'),
      order_number: text('Only when several orders are proved in this chat: the one they mean (its page for order_link, or its mobile number for summary).'),
      product_ids: {
        type: 'array',
        description: 'For summary: the products to link, each the id the tools returned (the chosen variation\'s own id where there is one). Omit to link the products this chat settled on. A product they chose a delivery service for is linked with it chosen.',
        items: text('One product or variation id, exactly as the tools returned it.'),
      },
      link_ids: {
        type: 'array',
        description: 'For summary: pages or articles to link, each a link id (pageLinkId, or an id from links) from search_pages or search_guides.',
        items: text('One link id or address, exactly as the tools returned it.'),
      },
    },
    required: ['visitor_agreed', 'what'],
    additionalProperties: false,
  },
  input: z.object({
    visitor_agreed: AgreedField,
    what: z.enum(['summary', 'order_link']),
    note: z.string().trim().max(1000).optional(),
    phone: z.string().trim().max(40).optional(),
    order_number: z.string().trim().max(60).optional(),
    product_ids: z.array(z.string().trim().min(1).max(100)).max(10).optional(),
    link_ids: z.array(z.string().trim().min(1).max(600)).max(10).optional(),
  }),
  // Whether it went and how many links, never the number or the words.
  summarise: (args, result) => `${args.what === 'order_link' ? 'order link' : 'note'}: ${sent(result)}; ${typeof result?.linkCount === 'number' ? result.linkCount : 0} link(s)`,
  guidance: 'Offer a text only when the note about the visitor says texting is available, and only send one (send_text) once they have said yes. Never write a phone number out, theirs or anybody\'s.',
  async handler(ctx, args) {
    if (!visitorAgreement(args.visitor_agreed)) return notAgreedResult(args.what === 'order_link' ? 'the link to their order page' : 'the links', 'texted')
    return sendChatText(ctx, {
      what: args.what,
      note: blankToNull(args.note),
      phone: blankToNull(args.phone),
      orderNumber: blankToNull(args.order_number),
      productIds: args.product_ids ?? [],
      linkIds: args.link_ids ?? [],
    })
  },
})
