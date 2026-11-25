import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fakeContext } from './tools/fake-context'

// save_quote carries the delivery service chosen for a line into the line's
// meta, under the field the shop's own basket picker uses, so the quote opens
// with it chosen.

const saver = vi.hoisted(() => ({
  quotesAvailable: vi.fn(async () => true),
  saveQuote: vi.fn(async () => ({ ok: true as const, quote: { id: 'q1', quoteNumber: 'Q-101', code: 'abc', url: '/q/abc' }, emailedCustomer: true, unavailable: [] })),
}))
const menus = vi.hoisted(() => ({ basketServiceMenus: vi.fn(async () => new Map([['piste-140', { field: 'shippingTier', options: [{ key: 'standard', label: 'Standard' }, { key: 'express', label: 'Express' }] }]])) }))

vi.mock('./shop/quote-saver', () => saver)
vi.mock('./shop/delivery-choice', () => menus)
vi.mock('./emails', () => ({ emailsUsedUp: vi.fn(async () => false), countEmail: vi.fn(async () => undefined) }))

const { linesWithDeliveries, saveChatQuote } = await import('./quote')

const express = { key: 'express', label: 'Express' }
const piste = { id: 'piste-140', url: 'https://shop.test/piste?width=140cm', parentId: 'piste', delivery: express }
const chair = { id: 'chair', url: 'https://shop.test/chair', parentId: null }

beforeEach(() => vi.clearAllMocks())

describe('linesWithDeliveries', () => {
  const menu = new Map([['piste-140', { field: 'shippingTier', options: [{ key: 'express', label: 'Express' }] }]])

  it('writes the chosen service into the line\'s meta under the basket\'s own field', () => {
    const out = linesWithDeliveries([{ productId: 'piste-140', quantity: 2 }, { productId: 'chair', quantity: 1 }], new Map([['piste-140', express]]), menu)
    expect(out).toEqual({ lines: [{ productId: 'piste-140', quantity: 2, meta: { shippingTier: 'express' } }, { productId: 'chair', quantity: 1 }], missed: [] })
  })

  it('leaves a service the basket does not offer off, and says which', () => {
    const out = linesWithDeliveries([{ productId: 'piste-140', quantity: 1 }], new Map([['piste-140', { key: 'installed', label: 'Installed' }]]), menu)
    expect(out).toEqual({ lines: [{ productId: 'piste-140', quantity: 1 }], missed: ['Installed'] })
    expect(linesWithDeliveries([{ productId: 'piste-140', quantity: 1 }], new Map([['piste-140', express]]), new Map()).missed).toEqual(['Express'])
  })
})

describe('saveChatQuote', () => {
  it('saves the chosen service on its line and asks the basket only about lines that have one', async () => {
    const ctx = fakeContext({ visitorName: 'Jo Bloggs', visitorText: 'jo@example.com', products: [chair, piste] })
    const out = await saveChatQuote(ctx, { name: null, email: 'jo@example.com', lines: [{ productId: 'piste-140', quantity: 1 }, { productId: 'chair', quantity: 2 }] })
    expect(menus.basketServiceMenus).toHaveBeenCalledWith(['piste-140'])
    expect(saver.saveQuote).toHaveBeenCalledWith(expect.objectContaining({
      lines: [{ productId: 'piste-140', quantity: 1, meta: { shippingTier: 'express' } }, { productId: 'chair', quantity: 2 }],
    }))
    expect(out).toMatchObject({ ok: true, quoteNumber: 'Q-101' })
    expect(String(out.message)).toContain('delivery services they chose are on the quote')
  })

  it('does not ask the basket at all when nothing has a service chosen', async () => {
    const ctx = fakeContext({ visitorName: 'Jo', visitorText: 'jo@example.com', products: [chair] })
    await saveChatQuote(ctx, { name: null, email: 'jo@example.com', lines: [{ productId: 'chair', quantity: 1 }] })
    expect(menus.basketServiceMenus).not.toHaveBeenCalled()
    expect(saver.saveQuote).toHaveBeenCalledWith(expect.objectContaining({ lines: [{ productId: 'chair', quantity: 1 }] }))
  })
})
