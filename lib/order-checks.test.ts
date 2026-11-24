import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fakeContext } from './tools/fake-context'

// Who may hear about which order: the member path, the postcode check, the
// limits, and that nothing personal comes back.

const queries = vi.hoisted(() => ({
  lookupOrders: vi.fn(),
  lookupMemberOrder: vi.fn(),
  listMemberOrders: vi.fn(),
}))
const state = vi.hoisted(() => ({
  addVerifiedOrders: vi.fn(async (_id: string, numbers: string[]) => numbers),
  recentRateEvents: vi.fn(async () => 0),
  recordFailedCheck: vi.fn(async () => undefined),
}))

vi.mock('./shop/order-queries', () => queries)
vi.mock('./order-state', async (original) => ({ ...(await original<typeof import('./order-state')>()), ...state }))

const { checkOrder, myOrders, pickVerifiedOrder, safeOrder } = await import('./order-checks')
type VerifiedOrder = import('./shop/order-queries').VerifiedOrder

function order(number: string, over: Partial<VerifiedOrder> = {}): VerifiedOrder {
  return {
    orderNumber: number,
    placed: '2026-11-01',
    placedWords: 'on the 1st of November',
    placedMonth: 'November 2026',
    status: 'dispatched',
    payment: 'paid',
    total: '£120',
    deliveringTo: 'Leeds',
    breakdown: { subtotal: '£100', discount: null, couponCode: null, delivery: 'free', deliveryService: null, tax: '£20', paymentMethod: 'Card' },
    deliveryInstructions: null,
    customerReference: null,
    items: [],
    refunds: [],
    requests: [],
    extraCharges: [],
    notesFromTeam: [],
    invoiceAvailable: false,
    proformaAvailable: false,
    paperwork: '',
    howToPay: null,
    deliveries: [],
    ...over,
  }
}

const args = (over: Partial<{ postcode: string; orderNumber: string | null; email: string | null; companyName: string | null }> = {}) =>
  ({ postcode: '', orderNumber: null, email: null, companyName: null, ...over })

beforeEach(() => {
  vi.clearAllMocks()
  state.recentRateEvents.mockResolvedValue(0)
  queries.lookupMemberOrder.mockResolvedValue({ matched: false })
})

describe('a signed-in member', () => {
  const member = { id: 'm1', email: 'sam@example.com' }

  it('needs only the order number for an order on their own account', async () => {
    queries.lookupMemberOrder.mockResolvedValue({ matched: true, orders: [order('DW100')], internalNumbers: ['DW100'] })
    const ctx = fakeContext({ member })
    const out = await checkOrder(ctx, args({ orderNumber: '100' }))
    expect(out).toMatchObject({ ok: true, matched: true, how: 'account' })
    expect(queries.lookupMemberOrder).toHaveBeenCalledWith('m1', '100')
    expect(queries.lookupOrders).not.toHaveBeenCalled()
    expect(ctx.orders.verified).toEqual(['DW100'])
    expect(state.addVerifiedOrders).toHaveBeenCalledWith('c1', ['DW100'])
  })

  it('gets nothing for an order not on their account without the postcode, and it is not a failed check', async () => {
    const ctx = fakeContext({ member })
    const out = await checkOrder(ctx, args({ orderNumber: 'DW999' }))
    expect(out).toMatchObject({ ok: false })
    expect(String(out.message)).toMatch(/not on the account/)
    expect(state.recordFailedCheck).not.toHaveBeenCalled()
    expect(ctx.orders.verified).toEqual([])
  })

  it('can still prove somebody else\'s order the ordinary way', async () => {
    queries.lookupOrders.mockResolvedValue({ matched: true, orders: [order('DW999')], internalNumbers: ['DW999'] })
    const out = await checkOrder(fakeContext({ member }), args({ orderNumber: 'DW999', postcode: 'LS1 4AP' }))
    expect(out).toMatchObject({ matched: true, how: 'details' })
  })

  it('lists only their own orders, and nothing for somebody not signed in', async () => {
    queries.listMemberOrders.mockResolvedValue([{ orderNumber: 'DW100', placedWords: 'today', status: 'dispatched', total: '£10', itemCount: 1 }])
    expect(await myOrders(fakeContext({ member }))).toMatchObject({ ok: true, orders: [{ orderNumber: 'DW100' }] })
    expect(queries.listMemberOrders).toHaveBeenCalledWith('m1')
    expect(await myOrders(fakeContext())).toMatchObject({ ok: false })
    expect(queries.listMemberOrders).toHaveBeenCalledTimes(1)
  })
})

describe('everybody else', () => {
  it('needs the postcode and one other detail before anything is looked up', async () => {
    expect(await checkOrder(fakeContext(), args({ orderNumber: 'DW1' }))).toMatchObject({ ok: false })
    expect(await checkOrder(fakeContext(), args({ postcode: 'LS1 4AP' }))).toMatchObject({ ok: false })
    expect(queries.lookupOrders).not.toHaveBeenCalled()
    expect(state.recordFailedCheck).not.toHaveBeenCalled()
  })

  it('remembers a match for the chat', async () => {
    queries.lookupOrders.mockResolvedValue({ matched: true, orders: [order('DW1')], internalNumbers: ['DW1'] })
    const ctx = fakeContext()
    const out = await checkOrder(ctx, args({ postcode: 'LS1 4AP', email: 'jo@example.com' }))
    expect(out).toMatchObject({ ok: true, matched: true })
    expect(ctx.orders.verified).toEqual(['DW1'])
  })

  it('counts a miss against the chat and the visitor, without saying which part was wrong', async () => {
    queries.lookupOrders.mockResolvedValue({ matched: false })
    const ctx = fakeContext({ visitorId: 'v9' })
    const out = await checkOrder(ctx, args({ postcode: 'LS1 4AP', orderNumber: 'DW1' }))
    expect(out).toMatchObject({ ok: false, matched: false })
    expect(state.recordFailedCheck).toHaveBeenCalledWith('c1', 'visitor:v9')
    expect(ctx.orders.failedChecks).toBe(1)
    expect(String(out.message)).not.toMatch(/postcode was|order number was/i)
  })

  it('stops after three misses in a chat', async () => {
    const out = await checkOrder(fakeContext({ orders: { verified: [], failedChecks: 3, emailsSent: 0 } }), args({ postcode: 'LS1 4AP', orderNumber: 'DW1' }))
    expect(out).toMatchObject({ ok: false, locked: true })
    expect(queries.lookupOrders).not.toHaveBeenCalled()
  })

  it('stops after six misses from one visitor in an hour, keyed on the chat when there is no visitor id', async () => {
    state.recentRateEvents.mockResolvedValue(6)
    const out = await checkOrder(fakeContext(), args({ postcode: 'LS1 4AP', orderNumber: 'DW1' }))
    expect(out).toMatchObject({ locked: true })
    expect(state.recentRateEvents).toHaveBeenCalledWith('chat:c1', 'failed_check')
  })

  it('never hands back an email, a phone number or an address in the order\'s free text', async () => {
    const messy = order('DW1', {
      deliveryInstructions: 'Ring 07700 900123 or email jo.bloggs@example.com',
      customerReference: 'PO for jo@example.com',
      notesFromTeam: [{ date: '2026-11-02', text: 'Customer asked us to call +44 7700 900123' }],
    })
    queries.lookupOrders.mockResolvedValue({ matched: true, orders: [messy], internalNumbers: ['DW1'] })
    const out = await checkOrder(fakeContext(), args({ postcode: 'LS1 4AP', orderNumber: 'DW1' }))
    const json = JSON.stringify(out)
    expect(json).not.toMatch(/@example\.com/)
    expect(json).not.toMatch(/7700/)
    expect(safeOrder(messy).deliveryInstructions).toBe('Ring [number] or email [email]')
  })
})

describe('pickVerifiedOrder', () => {
  it('picks the named order, or the only one, and never one not proved', () => {
    expect(pickVerifiedOrder(['DW000290'], '290')).toBe('DW000290')
    expect(pickVerifiedOrder(['DW000290'], null)).toBe('DW000290')
    expect(pickVerifiedOrder(['DW1', 'DW2'], null)).toBeNull()
    expect(pickVerifiedOrder(['DW1'], 'DW3')).toBeNull()
    expect(pickVerifiedOrder([], null)).toBeNull()
  })
})
