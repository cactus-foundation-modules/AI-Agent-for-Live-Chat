import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { DiscussedProduct } from '../discussed-products'
import { fakeContext } from './fake-context'

// choose_delivery: a delivery service is recorded only for a product looked up
// in this chat and only when the shop offers it for that product, and from then
// on the product's address carries it.

const timing = vi.hoisted(() => ({ menus: new Map<string, Array<{ key: string; label: string }>>() }))
const saved = vi.hoisted(() => ({ saveDiscussedProducts: vi.fn(async () => undefined) }))
const queries = vi.hoisted(() => ({ getProductDetail: vi.fn(), findBySku: vi.fn(), searchProducts: vi.fn(), listTopCategories: vi.fn(), variationIdsOf: vi.fn(async (): Promise<string[]> => []) }))

vi.mock('../shop/delivery-choice', async (original) => ({
  ...(await original<typeof import('../shop/delivery-choice')>()),
  timingMenus: vi.fn(async (ids: string[]) => new Map(ids.flatMap((id) => (timing.menus.has(id) ? [[id, timing.menus.get(id)!] as const] : [])))),
}))
vi.mock('@/modules/shop/lib/checkout', () => ({ resolveCartLines: vi.fn(async () => []) }))
vi.mock('../order-state', () => saved)
vi.mock('../shop/product-queries', () => queries)
vi.mock('../shop/faq-queries', () => ({ lookupFaqs: vi.fn() }))
vi.mock('../shop/payment-queries', () => ({ paymentInfo: vi.fn() }))
vi.mock('../shop/postcode-delivery', () => ({ deliveryToPostcode: vi.fn() }))
vi.mock('../shop/site-content', () => ({ productReviews: vi.fn(), searchGuides: vi.fn(), searchPages: vi.fn(), shopReviews: vi.fn() }))

const { chooseDeliveryTool, getProductTool, findBySkuTool } = await import('./shop-tools')
const { dispatchTool } = await import('./registry')

const PISTE = 'https://shop.test/shop/products/oslo-air-piste?width=140cm'
const piste: DiscussedProduct = { id: 'piste-140', url: PISTE, parentId: 'piste' }
const chair: DiscussedProduct = { id: 'chair', url: 'https://shop.test/shop/products/aero', parentId: null }

beforeEach(() => {
  vi.clearAllMocks()
  timing.menus = new Map([['piste-140', [{ key: 'standard', label: 'Standard delivery' }, { key: 'express', label: 'Express' }]]])
})

const choose = (ctx: ReturnType<typeof fakeContext>, productId: string, service: string) =>
  dispatchTool([chooseDeliveryTool], 'choose_delivery', JSON.stringify({ product_id: productId, service }), ctx)

describe('choose_delivery', () => {
  it('records a service the shop offers, saves it and hands back the address carrying it', async () => {
    const ctx = fakeContext({ products: [piste, chair] })
    const done = await choose(ctx, 'piste-140', 'express delivery')
    expect(done.result).toMatchObject({ ok: true, delivery: 'Express', url: `${PISTE}&delivery-service=express` })
    expect(ctx.products).toEqual([chair, { ...piste, delivery: { key: 'express', label: 'Express' } }])
    expect(saved.saveDiscussedProducts).toHaveBeenCalledWith('c1', ctx.products)
    expect(done.summary).toBe('express delivery: recorded')
  })

  it('refuses a service the shop does not offer for it, naming what it does, and records nothing', async () => {
    const ctx = fakeContext({ products: [piste] })
    const done = await choose(ctx, 'piste-140', 'installed')
    expect(done.result.ok).toBe(false)
    expect(String(done.result.message)).toContain('Standard delivery, Express')
    expect(String(done.result.message)).toContain('get_product')
    expect(ctx.products).toEqual([piste])
    expect(saved.saveDiscussedProducts).not.toHaveBeenCalled()
  })

  it('refuses a product with no delivery choice at all', async () => {
    const ctx = fakeContext({ products: [chair] })
    const done = await choose(ctx, 'chair', 'express')
    expect(done.result).toMatchObject({ ok: false })
    expect(String(done.result.message)).toContain('no delivery choice')
    expect(ctx.products).toEqual([chair])
  })

  it('says a service its variations offer is available on a part-chosen listing, recording nothing (the live-site yellow chair)', async () => {
    const eclipse = { id: 'eclipse', url: 'https://shop.test/eclipse?seat=senna-yellow', parentId: null, picks: 'seat.senna-yellow' }
    queries.variationIdsOf.mockResolvedValueOnce(['eclipse-a', 'eclipse-b'])
    timing.menus.set('eclipse-b', [{ key: 'pre-assembled', label: 'Pre-Assembled' }])
    const ctx = fakeContext({ products: [eclipse] })
    const done = await choose(ctx, 'eclipse', 'pre-assembled')
    expect(done.result).toMatchObject({ ok: true, recorded: false, delivery: 'Pre-Assembled' })
    expect(String(done.result.message)).toMatch(/is offered for this product/)
    expect(ctx.products).toEqual([eclipse])
  })

  it('refuses a product this chat never looked up', async () => {
    const ctx = fakeContext({ products: [chair] })
    const done = await choose(ctx, 'made-up', 'express')
    expect(done.result).toMatchObject({ ok: false })
    expect(String(done.result.message)).toContain('get_product')
    expect(saved.saveDiscussedProducts).not.toHaveBeenCalled()
  })

  it('takes the listing\'s id as the variation the chat settled on, and a second choice replaces the first', async () => {
    const ctx = fakeContext({ products: [piste] })
    await choose(ctx, 'piste', 'Express')
    await choose(ctx, 'piste-140', 'standard')
    expect(ctx.products).toEqual([{ ...piste, delivery: { key: 'standard', label: 'Standard delivery' } }])
  })
})

describe('once chosen, the product tools hand back the address with it', () => {
  const chosen = { ...piste, delivery: { key: 'express', label: 'Express' } }

  it('get_product puts it on the chosen variation\'s address, not on the listing\'s', async () => {
    queries.getProductDetail.mockResolvedValue({
      id: 'piste', url: 'https://shop.test/shop/products/oslo-air-piste',
      matchingVariations: [{ id: 'piste-140', url: PISTE }],
    })
    const ctx = fakeContext({ products: [chosen] })
    const done = await dispatchTool([getProductTool], 'get_product', JSON.stringify({ product_id: 'piste', options: '140' }), ctx)
    const product = done.result.product as { url: string; matchingVariations: Array<{ url: string }> }
    expect(product.url).toBe('https://shop.test/shop/products/oslo-air-piste')
    expect(product.matchingVariations[0]?.url).toBe(`${PISTE}&delivery-service=express`)
    expect(ctx.products).toEqual([chosen])
  })

  it('find_by_sku does too', async () => {
    queries.findBySku.mockResolvedValue({ hits: [{ productId: 'piste', url: PISTE, match: 'exact', variation: { id: 'piste-140' } }], note: '' })
    const done = await dispatchTool([findBySkuTool], 'find_by_sku', JSON.stringify({ sku: 'OAP140' }), fakeContext({ products: [chosen] }))
    expect((done.result.products as Array<{ url: string }>)[0]?.url).toBe(`${PISTE}&delivery-service=express`)
  })
})
