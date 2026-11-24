import { describe, expect, it, vi } from 'vitest'
import { DEFAULT_SETTINGS } from '../settings-model'
import { fakeContext } from './fake-context'

// The full tool list, the standing instructions built from it, the words the
// Notes panel uses for each tool, and that the log never holds what a visitor
// typed to prove an order. The shop-facing work behind each tool is stood in
// for; it has its own tests.

const orders = vi.hoisted(() => ({ checkOrder: vi.fn(), myOrders: vi.fn(), pickVerifiedOrder: vi.fn() }))
vi.mock('../order-checks', () => orders)
vi.mock('../emails', () => ({
  emailChatSummary: vi.fn(async () => ({ ok: true, sent: true })),
  emailOrderLink: vi.fn(async () => ({ ok: true, sent: true })),
  notAgreedResult: (what: string) => ({ ok: false, sent: false, message: `Nothing has been sent: ask about ${what}.` }),
  visitorAgreement: (value: string | undefined) => (value && value.trim().length > 1 ? value : null),
  MAX_PRODUCTS_PER_EMAIL: 5,
  MAX_LINKS_PER_EMAIL: 5,
}))
vi.mock('../order-request', () => ({ raiseOrderRequest: vi.fn(async () => ({ ok: true, raised: true })) }))
vi.mock('../quote', () => ({ MAX_QUOTE_LINES: 100, saveChatQuote: vi.fn(async () => ({ ok: true })) }))
vi.mock('../visitor-history', () => ({ visitorHistory: vi.fn(async () => ({ items: [], openRequests: [], matchedOn: 0 })) }))
vi.mock('../shop/faq-queries', () => ({ lookupFaqs: vi.fn() }))
vi.mock('../shop/payment-queries', () => ({ paymentInfo: vi.fn() }))
vi.mock('../shop/postcode-delivery', () => ({ deliveryToPostcode: vi.fn(async () => ({ ok: true, delivers: true })) }))
vi.mock('../shop/product-queries', () => ({ findBySku: vi.fn(), getProductDetail: vi.fn(), listTopCategories: vi.fn(), searchProducts: vi.fn() }))
vi.mock('../shop/site-content', () => ({ productReviews: vi.fn(), searchGuides: vi.fn(), searchPages: vi.fn() }))
vi.mock('@/modules/chat/lib/responder-api', () => ({ askForColleague: vi.fn() }))
vi.mock('../conversations', () => ({ enterWaiting: vi.fn(), setCallbackWanted: vi.fn() }))
vi.mock('../handover', () => ({ scheduleHandoverCheck: vi.fn() }))
vi.mock('../callbacks', () => ({ saveCallback: vi.fn() }))
vi.mock('../unanswered', () => ({ recordUnanswered: vi.fn() }))

const { TOOLS } = await import('./index')
const { dispatchTool, functionTools } = await import('./registry')
const { buildInstructions, MAX_PRODUCTS_PER_REPLY } = await import('../prompt')
const { TOOL_WORDS } = await import('../../components/chat/ConversationControls')

const ORDER = [
  'hand_to_colleague', 'flag_not_genuine', 'save_callback', 'note_unanswered',
  'search_products', 'find_by_sku', 'get_product', 'list_categories', 'get_faqs', 'get_payment_info',
  'lookup_order', 'list_my_orders', 'email_order_link', 'email_summary', 'get_visitor_history',
  'search_pages', 'check_delivery_postcode', 'get_reviews', 'search_guides', 'raise_order_request', 'save_quote',
]

describe('the tool list', () => {
  it('keeps the 2a tools first and the rest in their fixed order', () => {
    expect(TOOLS.map((tool) => tool.name)).toEqual(ORDER)
  })

  it('has no phone-only tools', () => {
    const names = TOOLS.map((tool) => tool.name)
    for (const gone of ['lookup_caller_orders', 'build_basket', 'send_text', 'get_caller_history']) expect(names).not.toContain(gone)
  })

  it('shows the model a JSON schema for each, and the Notes panel words for each', () => {
    for (const tool of functionTools(TOOLS)) {
      expect(tool.parameters.type).toBe('object')
      expect(TOOL_WORDS[tool.name]).toBeTruthy()
    }
  })
})

describe('the standing instructions', () => {
  const settings = { ...DEFAULT_SETTINGS, assistantName: 'Charlie', businessName: 'Deskwell', extraInstructions: 'Open 9 to 5.' }
  const text = buildInstructions(settings, TOOLS)

  it('calls it a digital assistant, never an automated one or a person', () => {
    expect(text).toContain('You are Charlie, the digital assistant')
    expect(text).not.toMatch(/You are (an? )?(automated|virtual)/i)
    expect(text).toContain('Never call yourself an automated assistant, a bot or a person')
  })

  it('tells it to put each product\'s address on a line of its own, no markdown, a handful at most', () => {
    expect(text).toContain('on a line of its own as its full url')
    expect(text).toContain('never as a markdown link')
    expect(text).toContain('that variation\'s own url')
    expect(text).toContain(`Never more than about ${MAX_PRODUCTS_PER_REPLY} in one reply`)
  })

  it('carries the order rules: member orders, the postcode check, no personal details', () => {
    expect(text).toContain('their own orders need no postcode')
    expect(text).toContain('BOTH (a) one of the order number, the email address used on the order, or the company name on the order, AND (b) the delivery postcode')
    expect(text).toContain('NEVER write out an email address, a phone number or a street address')
  })

  it('has nothing spoken and nothing for a phone', () => {
    expect(text).not.toMatch(/one digit at a time|read (it )?aloud|caller|send_text|build_basket/i)
  })

  it('includes every tool\'s guidance and no em dashes', () => {
    for (const tool of TOOLS) if (tool.guidance) expect(text).toContain(tool.guidance)
    expect(text).not.toContain('\u2014')
  })
})

describe('the log never holds what proved an order', () => {
  it('lookup_order logs only whether it matched', async () => {
    orders.checkOrder.mockResolvedValueOnce({ ok: true, matched: true, how: 'details' })
    const done = await dispatchTool(TOOLS, 'lookup_order', JSON.stringify({ delivery_postcode: 'LS1 4AP', email: 'jo@example.com', order_number: 'DW1' }), fakeContext())
    expect(done.summary).toBe('matched')
    orders.checkOrder.mockResolvedValueOnce({ ok: false, matched: false })
    const miss = await dispatchTool(TOOLS, 'lookup_order', JSON.stringify({ delivery_postcode: 'LS1 4AP', company_name: 'Bloggs Ltd' }), fakeContext())
    expect(miss.summary).toBe('did not match')
    expect(miss.ok).toBe(false)
  })

  it('a postcode check logs only the district, and emails only whether they went', async () => {
    const postcode = await dispatchTool(TOOLS, 'check_delivery_postcode', JSON.stringify({ postcode: 'LS1 4AP' }), fakeContext())
    expect(postcode.summary).toBe('district: LS1')
    const email = await dispatchTool(TOOLS, 'email_summary', JSON.stringify({ visitor_agreed: 'yes please', email: 'jo@example.com', summary: 'About desks' }), fakeContext())
    expect(email.summary).not.toContain('@')
  })

  it('a send tool without the visitor\'s yes sends nothing', async () => {
    const done = await dispatchTool(TOOLS, 'email_order_link', JSON.stringify({}), fakeContext())
    expect(done.result).toMatchObject({ ok: false, sent: false })
    const raise = await dispatchTool(TOOLS, 'raise_order_request', JSON.stringify({ kind: 'issue', reason: 'ARRIVED_DAMAGED' }), fakeContext())
    expect(raise.result).toMatchObject({ ok: false, raised: false })
  })
})
