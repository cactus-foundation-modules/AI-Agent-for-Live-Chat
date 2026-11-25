import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fakeContext } from './tools/fake-context'

// send_text: through core's SMS provider, within the caps, to a number the
// rules allow, and never a number handed back.

const sms = vi.hoisted(() => ({ provider: { isConfigured: () => true, sendSms: vi.fn(async () => undefined) } as { isConfigured: () => boolean; sendSms: ReturnType<typeof vi.fn> } | null }))
const state = vi.hoisted(() => ({ recentRateEvents: vi.fn(async () => 0), recordTextSent: vi.fn(async () => undefined) }))
const queries = vi.hoisted(() => ({ phonesOnOrders: vi.fn(async () => [] as Array<{ orderNumber: string; phones: string[] }>) }))

vi.mock('@/lib/auth/sms', () => ({ getActiveSmsProvider: async () => sms.provider }))
vi.mock('@/modules/shop/lib/config', () => ({ getShopConfigCached: async () => ({}) }))
vi.mock('@/modules/shop/lib/order-tracking', () => ({ orderTrackingUrl: (n: string) => `https://shop.test/orders/track?o=${n}&k=abc` }))
vi.mock('./order-state', async (original) => ({ ...(await original<typeof import('./order-state')>()), ...state }))
vi.mock('./shop/order-queries', () => queries)
vi.mock('./shop/site-content', () => ({ sendableLinks: async () => new Map() }))
vi.mock('./settings', () => ({ getSettings: async () => ({ extraInstructions: '', businessName: 'Deskwell' }) }))

const { sendChatText, textingAvailable, textsUsedUp } = await import('./texts')

const summary = { what: 'summary' as const, note: 'Here is the desk we talked about.', phone: null, orderNumber: null, productIds: [], linkIds: [] }
const desk = { id: 'desk-black', url: 'https://shop.test/shop/products/air-lite-desk?frame-colour=black', parentId: 'desk' }

beforeEach(() => {
  vi.clearAllMocks()
  sms.provider = { isConfigured: () => true, sendSms: vi.fn(async () => undefined) }
  state.recentRateEvents.mockResolvedValue(0)
  queries.phonesOnOrders.mockResolvedValue([])
})

describe('send_text', () => {
  it('texts a mobile the visitor typed, with the chat\'s product link, and counts it', async () => {
    const ctx = fakeContext({ visitorText: 'my mobile is 07700 900123', products: [desk] })
    const out = await sendChatText(ctx, { ...summary, phone: '07700900123' })
    expect(out).toMatchObject({ ok: true, sent: true, linkCount: 1 })
    expect(sms.provider?.sendSms).toHaveBeenCalledWith('+447700900123', expect.stringContaining(desk.url))
    expect(JSON.stringify(out)).not.toMatch(/0770|\+44/)
    expect(state.recordTextSent).toHaveBeenCalledWith('c1', 'chat:c1')
    expect(ctx.textsSent).toBe(1)
  })

  it('uses the number given to the chat\'s contact box', async () => {
    const out = await sendChatText(fakeContext({ visitorPhone: '+447700900456', products: [desk] }), summary)
    expect(out).toMatchObject({ ok: true })
    expect(sms.provider?.sendSms).toHaveBeenCalledWith('+447700900456', expect.any(String))
  })

  it('uses the mobile on a proved order, and sends its order link only there', async () => {
    queries.phonesOnOrders.mockResolvedValue([{ orderNumber: 'DW1', phones: ['07700 900777'] }])
    const ctx = fakeContext({ orders: { verified: ['DW1'], failedChecks: 0, emailsSent: 0 }, visitorText: '07700 900123' })
    expect(await sendChatText(ctx, { ...summary, what: 'order_link', note: null, phone: '07700 900123' })).toMatchObject({ ok: true })
    expect(sms.provider?.sendSms).toHaveBeenCalledWith('+447700900777', expect.stringContaining('https://shop.test/orders/track?o=DW1'))
  })

  it('refuses a landline and a number the model invented, sending nothing', async () => {
    const landline = await sendChatText(fakeContext({ visitorText: 'ring 0113 249 6000' }), { ...summary, phone: '0113 249 6000' })
    expect(landline).toMatchObject({ ok: false, sent: false })
    expect(String(landline.message)).toMatch(/email/i)
    const invented = await sendChatText(fakeContext({ visitorText: 'hello' }), { ...summary, phone: '07700 900999' })
    expect(invented).toMatchObject({ ok: false, sent: false })
    expect(sms.provider?.sendSms).not.toHaveBeenCalled()
  })

  it('says texts are not set up when no provider is configured', async () => {
    sms.provider = null
    const out = await sendChatText(fakeContext({ visitorPhone: '07700 900456' }), summary)
    expect(out).toMatchObject({ ok: false, sent: false })
    expect(String(out.message)).toMatch(/not set up.*email/i)
    expect(await textingAvailable()).toBe(false)
  })

  it('stops at three a chat and six an hour per visitor', async () => {
    expect(await sendChatText(fakeContext({ visitorPhone: '07700 900456', textsSent: 3 }), summary)).toMatchObject({ ok: false, sent: false })
    state.recentRateEvents.mockResolvedValue(6)
    expect(await sendChatText(fakeContext({ visitorPhone: '07700 900456' }), summary)).toMatchObject({ ok: false, sent: false })
    expect(state.recentRateEvents).toHaveBeenCalledWith('chat:c1', 'text')
    expect(sms.provider?.sendSms).not.toHaveBeenCalled()
    state.recentRateEvents.mockResolvedValue(5)
    expect(await textsUsedUp(fakeContext({ textsSent: 2 }))).toBe(false)
  })

  it('needs a note for a summary, and a provider failure is said plainly', async () => {
    expect(await sendChatText(fakeContext({ visitorPhone: '07700 900456' }), { ...summary, note: null })).toMatchObject({ ok: false })
    sms.provider?.sendSms.mockRejectedValueOnce(new Error('down'))
    expect(await sendChatText(fakeContext({ visitorPhone: '07700 900456' }), summary)).toMatchObject({ ok: false, sent: false })
    expect(state.recordTextSent).not.toHaveBeenCalled()
  })
})
