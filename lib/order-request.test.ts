import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fakeContext } from './tools/fake-context'

const shop = vi.hoisted(() => ({
  submitOrderRequest: vi.fn(),
  addOrderNote: vi.fn(),
  getOrderByNumber: vi.fn(),
  loadOrderDetail: vi.fn(),
  receiveIssuePhoto: vi.fn(),
  resolveIssuePhotos: vi.fn(),
}))
const chat = vi.hoisted(() => ({ readResponderAttachment: vi.fn() }))

vi.mock('@/modules/shop/lib/order-request-actions', () => ({ submitOrderRequest: shop.submitOrderRequest }))
vi.mock('@/modules/shop/lib/db/orders', () => ({ addOrderNote: shop.addOrderNote, getOrderByNumber: shop.getOrderByNumber }))
vi.mock('@/modules/shop/lib/member-orders', () => ({ loadOrderDetail: shop.loadOrderDetail }))
vi.mock('@/modules/shop/lib/issue-photos', () => ({ receiveIssuePhoto: shop.receiveIssuePhoto, resolveIssuePhotos: shop.resolveIssuePhotos }))
vi.mock('@/modules/chat/lib/responder-api', () => chat)

const { DEFAULT_PHOTO_NOTE, matchLine, matchLines, raiseOrderRequest } = await import('./order-request')
type LineChoice = import('./order-request').LineChoice

const desk: LineChoice = { orderItemId: 'i1', name: 'Air Lite Height Adjustable Desk', available: 2 }
const chair: LineChoice = { orderItemId: 'i2', name: 'Prism Mesh Chair', available: 4 }
const pedestal: LineChoice = { orderItemId: 'i3', name: 'Mobile Pedestal', available: 0 }
const skus = new Map([['i1', 'AL-1280-BK'], ['i2', 'PRISM-BLK'], ['i3', 'PED-3']])

describe('matchLine and matchLines', () => {
  const opts = { missingReport: false, wholeOrderAllowed: false }
  it('finds a line by code or by words, and refuses to guess', () => {
    expect(matchLine('prism-blk', [desk, chair], skus)?.orderItemId).toBe('i2')
    expect(matchLine('the desk', [desk, chair], skus)?.orderItemId).toBe('i1')
    expect(matchLine('sofa', [desk, chair], skus)).toBeNull()
  })
  it('takes the only open line, and asks which when there are several', () => {
    expect(matchLines([], [desk, pedestal], skus, opts)).toEqual({ ok: true, lines: [{ orderItemId: 'i1', quantity: 2, missing: null }] })
    const out = matchLines([], [desk, chair, pedestal], skus, opts)
    expect(out.ok).toBe(false)
    if (!out.ok) expect(out.message).not.toContain('Pedestal')
  })
  it('refuses more than the line covers, and needs whole-or-parts on a missing report', () => {
    expect(matchLines([{ item: 'chair', quantity: 5, missing: null }], [desk, chair], skus, opts).ok).toBe(false)
    expect(matchLines([{ item: 'desk', quantity: 1, missing: null }], [desk], skus, { missingReport: true, wholeOrderAllowed: false }).ok).toBe(false)
  })
})

describe('raiseOrderRequest', () => {
  const allowed = { allowed: true }
  const detail = {
    cancel: allowed,
    return: allowed,
    damage: allowed,
    lines: [{ item: { id: 'i1', productName: 'Air Lite Height Adjustable Desk', productSku: 'AL-1280-BK', quantity: 1, refundedQty: 0 }, cancellableQty: 0, returnableQty: 1 }],
  }
  const photo = { id: 'a'.repeat(32), filename: 'split.jpg', contentType: 'image/jpeg', sizeBytes: 1000 }
  const verified = () => fakeContext({ orders: { verified: ['DW000290'], failedChecks: 0, emailsSent: 0 } })

  beforeEach(() => {
    vi.clearAllMocks()
    shop.getOrderByNumber.mockResolvedValue({ id: 'o290', memberId: null, orderNumber: 'DW000290' })
    shop.loadOrderDetail.mockResolvedValue(detail)
    shop.submitOrderRequest.mockResolvedValue({ ok: true, request: { id: 'r1' } })
    shop.addOrderNote.mockResolvedValue(undefined)
    chat.readResponderAttachment.mockResolvedValue({ filename: 'split.jpg', contentType: 'image/jpeg', content: Buffer.from([1, 2, 3]) })
    shop.receiveIssuePhoto.mockResolvedValue({ ok: true, mediaId: 'm1', url: 'https://x/m1.jpg' })
    shop.resolveIssuePhotos.mockResolvedValue([{ mediaId: 'm1', url: 'https://x/m1.jpg' }])
  })

  it('puts the photos sent in the chat into a damage report, through the shop\'s own upload', async () => {
    const out = await raiseOrderRequest({ ...verified(), photos: [photo] }, { kind: 'issue', reason: 'ARRIVED_DAMAGED', orderNumber: '290', items: [], whatHappened: 'Split top', photoNote: null })
    expect(out).toMatchObject({ ok: true, raised: true, photosAdded: 1, photosRequested: false })
    expect(chat.readResponderAttachment).toHaveBeenCalledWith('c1', photo.id)
    const [request, orderNumber] = shop.receiveIssuePhoto.mock.calls[0]! as [Request, string]
    expect(orderNumber).toBe('DW000290')
    const file = (await request.formData()).get('file')
    expect(file).toBeInstanceOf(File)
    expect(shop.resolveIssuePhotos).toHaveBeenCalledWith('DW000290', ['m1'])
    const [input, opts] = shop.submitOrderRequest.mock.calls[0]!
    expect(input).toMatchObject({ orderId: 'o290', type: 'DAMAGE', photos: [{ mediaId: 'm1', url: 'https://x/m1.jpg' }] })
    expect(opts).toEqual({ notifyCustomer: true, alertShop: true, photoRequest: null })
    expect(String(shop.addOrderNote.mock.calls[0]![1])).toContain('chat assistant')
  })

  it('asks for photographs in the email when none were sent, or none would go', async () => {
    await raiseOrderRequest(verified(), { kind: 'issue', reason: 'ARRIVED_DAMAGED', orderNumber: null, items: [], whatHappened: 'Split', photoNote: null })
    expect(shop.submitOrderRequest.mock.calls[0]![1].photoRequest).toEqual({ note: DEFAULT_PHOTO_NOTE, userId: null })

    shop.receiveIssuePhoto.mockResolvedValue({ ok: false, status: 503, error: 'no storage' })
    const out = await raiseOrderRequest({ ...verified(), photos: [photo] }, { kind: 'issue', reason: 'FAULTY', orderNumber: null, items: [], whatHappened: 'Motor', photoNote: 'the panel' })
    expect(out).toMatchObject({ photosAdded: 0, photosRequested: true })
    expect(shop.submitOrderRequest.mock.calls[1]![1].photoRequest).toEqual({ note: 'the panel', userId: null })
  })

  it('never puts photos on a return or a missing-item report', async () => {
    await raiseOrderRequest({ ...verified(), photos: [photo] }, { kind: 'return', reason: 'NO_LONGER_NEEDED', orderNumber: null, items: [], whatHappened: null, photoNote: null })
    expect(shop.receiveIssuePhoto).not.toHaveBeenCalled()
    expect(shop.submitOrderRequest.mock.calls[0]![1].photoRequest).toBeNull()
  })

  it('touches only an order proved in this chat', async () => {
    expect((await raiseOrderRequest(fakeContext(), { kind: 'return', reason: 'NO_LONGER_NEEDED', orderNumber: null, items: [], whatHappened: null, photoNote: null })).ok).toBe(false)
    expect((await raiseOrderRequest(verified(), { kind: 'return', reason: 'NO_LONGER_NEEDED', orderNumber: '168', items: [], whatHappened: null, photoNote: null })).ok).toBe(false)
    expect(shop.submitOrderRequest).not.toHaveBeenCalled()
  })

  it('passes on the shop refusing it, and a reason it does not take', async () => {
    shop.loadOrderDetail.mockResolvedValue({ ...detail, return: { allowed: false, reason: 'The returns window has closed.' } })
    expect(await raiseOrderRequest(verified(), { kind: 'return', reason: 'NO_LONGER_NEEDED', orderNumber: null, items: [], whatHappened: null, photoNote: null }))
      .toMatchObject({ ok: false, raised: false, refusedBecause: 'The returns window has closed.' })
    const wrong = await raiseOrderRequest(verified(), { kind: 'return', reason: 'ARRIVED_DAMAGED', orderNumber: null, items: [], whatHappened: null, photoNote: null })
    expect(String(wrong.message)).toContain('NO_LONGER_NEEDED')
    expect(shop.submitOrderRequest).not.toHaveBeenCalled()
  })
})
