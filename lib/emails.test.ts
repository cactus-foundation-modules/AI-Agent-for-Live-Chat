import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fakeContext } from './tools/fake-context'

// Where the assistant's emails may go, and that no address ever comes back.

const mail = vi.hoisted(() => ({ sendTemplateEmail: vi.fn(async () => true) }))
const queries = vi.hoisted(() => ({ contactOnOrder: vi.fn(), emailsOnOrders: vi.fn(async () => [] as string[]) }))
const state = vi.hoisted(() => ({ recentRateEvents: vi.fn(async () => 0), recordEmailSent: vi.fn(async () => undefined) }))
const shop = vi.hoisted(() => ({ orderTrackingUrl: vi.fn(() => 'https://shop.test/orders/track?o=DW1&k=abc') }))

vi.mock('@/lib/email', () => mail)
vi.mock('@/modules/shop/lib/config', () => ({ getShopConfigCached: async () => ({}) }))
vi.mock('@/modules/shop/lib/email', () => ({ orderUrlVars: (url: string) => ({ orderUrl: url, reportIssueUrl: '', hasReportIssueUrl: '' }) }))
vi.mock('@/modules/shop/lib/order-tracking', () => shop)
vi.mock('@/modules/unified-inbox/lib/products', () => ({ resolveProducts: async () => [] }))
vi.mock('@/modules/unified-inbox/lib/products/render', () => ({ renderProductTable: () => '' }))
vi.mock('./shop/order-queries', () => queries)
vi.mock('./shop/product-queries', () => ({ toProductRefs: async () => [] }))
vi.mock('./shop/site-content', () => ({ sendableLinks: async () => new Map() }))
vi.mock('./settings', () => ({ getSettings: async () => ({ extraInstructions: '' }) }))
vi.mock('./order-state', async (original) => ({ ...(await original<typeof import('./order-state')>()), ...state }))

const { emailChatSummary, emailOrderLink, notAgreedResult, pickSummaryRecipient, visitorAgreement } = await import('./emails')

const base = {
  given: null, orderNumber: null, verified: [] as string[], orderEmails: [] as string[], namedOrderEmail: null,
  visitorText: '', visitorEmail: null, memberEmail: null,
}

beforeEach(() => {
  vi.clearAllMocks()
  state.recentRateEvents.mockResolvedValue(0)
  mail.sendTemplateEmail.mockResolvedValue(true)
  queries.emailsOnOrders.mockResolvedValue([])
})

describe('visitor agreement', () => {
  it('needs real words, and says nothing was sent without them', () => {
    expect(visitorAgreement('yes please')).toBe('yes please')
    expect(visitorAgreement(' ? ')).toBeNull()
    expect(visitorAgreement(undefined)).toBeNull()
    expect(notAgreedResult('x')).toMatchObject({ ok: false, sent: false })
  })
})

describe('pickSummaryRecipient', () => {
  it('sends to an address the visitor typed in the chat', () => {
    expect(pickSummaryRecipient({ ...base, given: 'Jo@Example.com', visitorText: 'send it to jo@example.com please' }))
      .toEqual({ kind: 'send', email: 'jo@example.com', source: 'typed' })
  })

  it('refuses an address the visitor never typed, without repeating it', () => {
    const out = pickSummaryRecipient({ ...base, given: 'stranger@example.com', visitorText: 'my email is jo@example.com' })
    expect(out.kind).toBe('refuse')
    if (out.kind === 'refuse') expect(out.message).not.toContain('@')
  })

  it('uses the chat form or account address when one is given as is', () => {
    expect(pickSummaryRecipient({ ...base, given: 'sam@example.com', memberEmail: 'Sam@example.com' })).toMatchObject({ kind: 'send', source: 'account' })
    expect(pickSummaryRecipient({ ...base, visitorEmail: 'form@example.com' })).toMatchObject({ kind: 'send', email: 'form@example.com', source: 'chat' })
  })

  it('uses the one address on proved orders, asks when there are several, never naming them', () => {
    expect(pickSummaryRecipient({ ...base, verified: ['DW1'], orderEmails: ['jo@example.com'] })).toMatchObject({ kind: 'send', source: 'order' })
    const several = pickSummaryRecipient({ ...base, verified: ['DW1', 'DW2'], orderEmails: ['a@example.com', 'b@example.com'] })
    expect(several.kind).toBe('refuse')
    if (several.kind === 'refuse') expect(several.message).not.toMatch(/a@example|b@example/)
  })

  it('asks for one when there is nothing to go on', () => {
    expect(pickSummaryRecipient(base).kind).toBe('refuse')
  })
})

describe('emailOrderLink', () => {
  const proved = (over = {}) => fakeContext({ orders: { verified: ['DW1'], failedChecks: 0, emailsSent: 0 }, ...over })

  it('goes only to the address on the order, never one from the chat', async () => {
    queries.contactOnOrder.mockResolvedValue({ email: 'owner@example.com', name: 'Jo' })
    const ctx = proved({ visitorText: 'send it to attacker@example.com', visitorEmail: 'attacker@example.com' })
    const out = await emailOrderLink(ctx, null)
    expect(out).toMatchObject({ ok: true, sent: true })
    expect(mail.sendTemplateEmail).toHaveBeenCalledWith('owner@example.com', 'ai-agent-for-live-chat.order-link', expect.objectContaining({ orderNumber: 'DW1', customerName: 'Jo' }))
    expect(JSON.stringify(out)).not.toContain('@')
    expect(state.recordEmailSent).toHaveBeenCalledWith('c1', 'chat:c1')
    expect(ctx.orders.emailsSent).toBe(1)
  })

  it('sends nothing for an order not proved in this chat', async () => {
    expect(await emailOrderLink(fakeContext(), 'DW1')).toMatchObject({ ok: false })
    expect(await emailOrderLink(proved(), 'DW2')).toMatchObject({ ok: false })
    expect(mail.sendTemplateEmail).not.toHaveBeenCalled()
  })

  it('stops at the chat and hourly limits', async () => {
    queries.contactOnOrder.mockResolvedValue({ email: 'owner@example.com', name: '' })
    expect(await emailOrderLink(proved({ orders: { verified: ['DW1'], failedChecks: 0, emailsSent: 3 } }), null)).toMatchObject({ ok: false })
    state.recentRateEvents.mockResolvedValue(6)
    expect(await emailOrderLink(proved(), null)).toMatchObject({ ok: false })
    expect(mail.sendTemplateEmail).not.toHaveBeenCalled()
  })
})

describe('emailChatSummary', () => {
  it('sends a typed address the note, escaped, and refuses one never typed', async () => {
    const ctx = fakeContext({ visitorText: 'it is jo@example.com' })
    const out = await emailChatSummary(ctx, { email: 'jo@example.com', orderNumber: null, name: 'Jo', subject: 'Desks', summary: 'You asked about <b>desks</b>.', productIds: [], linkIds: [] })
    expect(out).toMatchObject({ ok: true, sent: true })
    const vars = (mail.sendTemplateEmail.mock.calls[0] as unknown as [string, string, Record<string, string>])[2]
    expect(vars.summaryHtml).toContain('&lt;b&gt;desks&lt;/b&gt;')

    const refused = await emailChatSummary(fakeContext(), { email: 'someone@example.com', orderNumber: null, name: null, subject: undefined, summary: 'x', productIds: [], linkIds: [] })
    expect(refused).toMatchObject({ ok: false, sent: false })
    expect(mail.sendTemplateEmail).toHaveBeenCalledTimes(1)
  })
})
