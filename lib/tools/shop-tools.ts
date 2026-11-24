import { z } from 'zod'
import { lookupFaqs } from '../shop/faq-queries'
import { paymentInfo } from '../shop/payment-queries'
import { deliveryToPostcode } from '../shop/postcode-delivery'
import { findBySku, getProductDetail, listTopCategories, searchProducts } from '../shop/product-queries'
import { productReviews, searchGuides, searchPages, type Passage } from '../shop/site-content'
import { defineTool, type ToolParameters } from './registry'

// ---------------------------------------------------------------------------
// The tools about the shop itself: its products, FAQs, payment methods, pages,
// articles, reviews and delivery. Ported from the phone assistant's tools
// (modules/ai-call-answering/lib/agent-config.ts and tool-handlers.ts), copied
// rather than imported and rewritten for a chat window: written answers, links
// allowed, nothing spelled out digit by digit.
//
// Products come back with their page address (`url`), because Live Chat draws
// a product card, with this module's Add to basket under it, for any product
// page address on a line of its own.
//
// Read only. Nothing here writes anything or touches anybody's details.
// ---------------------------------------------------------------------------

function text(description: string): Record<string, unknown> {
  return { type: 'string', description }
}

const NO_ARGS: ToolParameters = { type: 'object', properties: {}, required: [], additionalProperties: false }

function blankToNull(value: string | undefined): string | null {
  return value && value.trim() !== '' ? value.trim() : null
}

const LINKS_NOTE =
  'pageUrl is the page or article itself; links are the links written in that passage. You may write one out in full, on its own, if they would find it useful. To email one, pass its id (or the address exactly) in link_ids to email_summary.'

/** A passage as the model sees it: the words, the page's own address and the
 *  links written in it, each with an id the email tool can look up again. */
function writtenPassage(passage: Passage): Record<string, unknown> {
  return {
    source: passage.source,
    heading: passage.heading,
    text: passage.text,
    ...(passage.page ? { pageUrl: passage.page.url, pageLinkId: passage.page.id } : {}),
    ...(passage.links ? { links: passage.links.map((link) => ({ id: link.id, label: link.label, url: link.url })) } : {}),
  }
}

export const searchProductsTool = defineTool({
  name: 'search_products',
  description: "Search the shop's products by what the visitor wants (for example 'height adjustable desk' or 'black office chair'). Use it to answer product questions and to suggest products. Returns up to six matches, each with its page address (url), name, price, stock and a short description.",
  parameters: {
    type: 'object',
    properties: {
      query: text('What the visitor is looking for, in a few plain words.'),
      max_price: { type: 'number', description: 'Optional. The most the visitor wants to spend, in pounds.' },
    },
    required: ['query'],
    additionalProperties: false,
  },
  input: z.object({
    query: z.string().trim().min(1).max(200),
    max_price: z.number().positive().max(1_000_000).optional(),
  }),
  guidance: 'If search_products finds nothing, search again with a different word for the same thing (shorter, a synonym, another spelling) before saying the shop does not sell it.',
  async handler(_ctx, args) {
    const { products, note } = await searchProducts(args.query, args.max_price ?? null)
    return { ok: true, products, note }
  },
})

export const findBySkuTool = defineTool({
  name: 'find_by_sku',
  description: "Find a product or variation from its product code (SKU), when the visitor gives one. It forgives a wrong letter and missing zeros. Returns the product name and its page address, and for a code that is one variation, its exact options, price and stock, plus the productId to give get_product. Use it instead of search_products whenever the visitor gives a code.",
  parameters: {
    type: 'object',
    properties: { sku: text('The code as the visitor wrote it.') },
    required: ['sku'],
    additionalProperties: false,
  },
  input: z.object({ sku: z.string().trim().min(1).max(80) }),
  async handler(_ctx, args) {
    const { hits, note } = await findBySku(args.sku)
    return { ok: true, products: hits, note }
  },
})

export const getProductTool = defineTool({
  name: 'get_product',
  description: 'Get the full details of one product: description, sizes, options, the exact price and page address of a chosen variation (pass options), specifications, stock, delivery services with prices and dates (worked out option by option), common questions answered, and accessories sold alongside it (each with its own productId and url). Use it before answering a detailed product question.',
  parameters: {
    type: 'object',
    properties: {
      product_id: text('The id exactly as returned by search_products or find_by_sku.'),
      quantity: { type: 'number', description: 'Optional. How many they want, as a whole number. Returns quantityQuote: the unit price, the exact total and whether there is enough stock. Always pass it when they give a quantity, instead of working the total out yourself.' },
      options: text('Optional. The options they have chosen, in their own words, for example "black high back" or "1600 walnut". Returns matchingVariations: each fitting variation with its own id, url and exact price. Pass it whenever they have named any option, and again with more words if several still fit.'),
    },
    required: ['product_id'],
    additionalProperties: false,
  },
  input: z.object({
    product_id: z.string().trim().min(1).max(100),
    options: z.string().trim().max(200).optional(),
    quantity: z.number().int().positive().max(100_000).optional(),
  }),
  guidance: 'When they name an option, call get_product with it in options and quote that variation\'s exact price; quote a range only while they have not chosen. When they give a quantity, pass it and use quantityQuote: never do the sum yourself.',
  async handler(_ctx, args) {
    const detail = await getProductDetail(args.product_id, blankToNull(args.options), args.quantity ?? null)
    return detail ? { ok: true, product: detail } : { ok: false, message: 'That product could not be found. Search again.' }
  },
})

export const listCategoriesTool = defineTool({
  name: 'list_categories',
  description: "List the shop's top-level product categories. Use it when a search finds nothing or the visitor is browsing and unsure what they want.",
  parameters: NO_ARGS,
  input: z.object({}).passthrough(),
  summarise: () => '',
  async handler() {
    return { ok: true, categories: await listTopCategories() }
  },
})

export const getFaqsTool = defineTool({
  name: 'get_faqs',
  description: "Look up the shop's own written answers to frequently asked questions: delivery areas, returns, assembly, payment, warranties, lead times. Give a category or collection name for that range's questions (they include the shop-wide ones); neither for the shop-wide ones. Pass query with a few words from the question to get just the matching answers.",
  parameters: {
    type: 'object',
    properties: {
      category: text('Optional. A product category name, such as "office chairs".'),
      collection: text('Optional. A collection name. Use category or collection, not both.'),
      query: text("Optional. A few words from the visitor's question, such as 'returns' or 'assembly'."),
    },
    required: [],
    additionalProperties: false,
  },
  input: z.object({
    category: z.string().trim().max(200).optional(),
    collection: z.string().trim().max(200).optional(),
    query: z.string().trim().max(200).optional(),
  }),
  guidance: 'Quote the shop\'s written answers (get_faqs, search_pages); never add to them.',
  async handler(_ctx, args) {
    return lookupFaqs({ category: blankToNull(args.category), collection: blankToNull(args.collection), query: blankToNull(args.query) })
  },
})

export const getPaymentInfoTool = defineTool({
  name: 'get_payment_info',
  description: "The ways the shop can be paid right now, read live: each method's name, the card brands and wallets it takes, whether it is paid at checkout or afterwards, whether it comes with a pro-forma invoice, any order-size limit, and for a bank transfer or cash the shop's own instructions for where to send the money (howToPay). Also when VAT invoices and pro-formas are and are not issued. Use it for every question about paying or invoices.",
  parameters: NO_ARGS,
  input: z.object({}).passthrough(),
  summarise: () => '',
  guidance: 'For any question about paying, cards, bank transfer, bank details, VAT invoices or pro-formas, call get_payment_info first and answer from it alone.',
  async handler() {
    return paymentInfo()
  },
})

export const searchPagesTool = defineTool({
  name: 'search_pages',
  description: "Search the shop's own published pages (returns and cancellations, delivery and installation, terms, about us, contact) for the passages that answer a question. Returns up to three passages with the page they come from, its address and the links written in each. Use for how-it-works questions get_faqs does not answer.",
  parameters: {
    type: 'object',
    properties: { query: text("The visitor's question in a few plain words, for example 'report damage photos' or 'return unwanted chair'.") },
    required: ['query'],
    additionalProperties: false,
  },
  input: z.object({ query: z.string().trim().min(1).max(200) }),
  async handler(_ctx, args) {
    const { passages, pages } = await searchPages(args.query)
    return passages.length > 0
      ? { ok: true, passages: passages.map(writtenPassage), note: `Answer from these words only, briefly, and say which page it is on. If none of them answers the question, say you cannot see it and call note_unanswered. ${LINKS_NOTE}` }
      : { ok: false, pages, message: 'Nothing on the shop\'s pages matches that. Try other words once, or say you cannot see it and call note_unanswered.' }
  },
})

export const checkDeliveryPostcodeTool = defineTool({
  name: 'check_delivery_postcode',
  description: "Whether the shop delivers to a postcode (the same rule the checkout applies, including places it does not deliver to), and with a product or variation id, the delivery services, prices and dates for that product. Use for 'do you deliver to...' and 'could it be here by Friday?'.",
  parameters: {
    type: 'object',
    properties: {
      postcode: text('The postcode as the visitor wrote it. The first half alone (for example IV2) is enough.'),
      product_id: text('Optional. The product, or better the exact variation id, they are asking about.'),
    },
    required: ['postcode'],
    additionalProperties: false,
  },
  input: z.object({
    postcode: z.string().trim().min(2).max(20),
    product_id: z.string().trim().max(100).optional(),
  }),
  // A postcode is where somebody lives: only the district goes in the log.
  summarise: (args) => `district: ${args.postcode.trim().split(/\s+/)[0]?.slice(0, 4).toUpperCase() ?? ''}`,
  guidance: 'For "do you deliver to..." or "could it be here by Friday?", call check_delivery_postcode. If the shop does not deliver there, say so in its own words before anything else; otherwise compare the date with the day they named and answer yes or no, with the date.',
  async handler(_ctx, args) {
    return deliveryToPostcode(args.postcode, blankToNull(args.product_id))
  },
})

export const getReviewsTool = defineTool({
  name: 'get_reviews',
  description: "Published customer reviews of a product (and its variations): how many, the average rating, and up to four short quotes, those that best match the question first. Use for 'is it comfortable?', 'do people like it?', 'is it easy to put together?'.",
  parameters: {
    type: 'object',
    properties: {
      product_id: text('The id from search_products or find_by_sku.'),
      query: text("Optional. What they want to know, in a few words, such as 'comfortable long day' or 'assembly'."),
    },
    required: ['product_id'],
    additionalProperties: false,
  },
  input: z.object({
    product_id: z.string().trim().min(1).max(100),
    query: z.string().trim().max(200).optional(),
  }),
  async handler(_ctx, args) {
    const digest = await productReviews(args.product_id, blankToNull(args.query))
    if (!digest) return { ok: false, message: 'This shop does not collect reviews. Say so if asked, and offer what the product page says instead.' }
    return digest.count === 0
      ? { ok: true, count: 0, message: 'Nobody has reviewed this one yet. Say so plainly; do not offer an opinion of your own.' }
      : { ok: true, ...digest, note: 'Say how many reviews and the average out of five, then paraphrase one or two that answer the question. Never invent or exaggerate.' }
  },
})

export const searchGuidesTool = defineTool({
  name: 'search_guides',
  description: "Search the shop's own articles and buying guides for advice, such as 'chair for back pain', 'standing desk height' or 'mesh or fabric'. Returns up to three passages with the article they come from, its address and the links written in each.",
  parameters: {
    type: 'object',
    properties: { query: text("The visitor's question in a few plain words.") },
    required: ['query'],
    additionalProperties: false,
  },
  input: z.object({ query: z.string().trim().min(1).max(200) }),
  async handler(_ctx, args) {
    const passages = await searchGuides(args.query)
    return passages.length > 0
      ? { ok: true, passages: passages.map(writtenPassage), note: `Give the gist in a sentence or two, as the shop's own advice ("our guide on mesh chairs says..."), then suggest products if it fits. ${LINKS_NOTE}` }
      : { ok: false, message: 'The shop has no article on that. Answer from the products instead, or say you cannot see it.' }
  },
})
