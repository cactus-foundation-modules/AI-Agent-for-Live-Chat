import { describe, expect, it } from 'vitest'
import {
  MAX_DISCUSSED_PRODUCTS,
  fromProductDetail,
  fromSkuHits,
  parseDiscussedProducts,
  productLinksToSend,
  productsToSend,
  rememberProducts,
  type DiscussedProduct,
} from './discussed-products'

// What a chat remembers it was about, and what a note or a text lists from it.

const desk: DiscussedProduct = { id: 'desk', url: 'https://shop.test/desk', parentId: null }
const deskBlack: DiscussedProduct = { id: 'desk-black', url: 'https://shop.test/desk?colour=black', parentId: 'desk' }
const chair: DiscussedProduct = { id: 'chair', url: 'https://shop.test/chair', parentId: null }

describe('what the product tools record', () => {
  it('get_product: the one variation that matched, else the product itself', () => {
    expect(fromProductDetail({ id: 'desk', url: desk.url, matchingVariations: [{ id: 'desk-black', url: deskBlack.url }] })).toEqual([deskBlack])
    expect(fromProductDetail({ id: 'desk', url: desk.url, matchingVariations: null })).toEqual([desk])
    expect(fromProductDetail({ id: 'desk', url: desk.url, matchingVariations: [{ id: 'a', url: null }, { id: 'b', url: null }] })).toEqual([desk])
  })

  it('find_by_sku: the one hit, or the one exact hit, never a guess among several', () => {
    const variation = { productId: 'desk', url: deskBlack.url, match: 'exact' as const, variation: { id: 'desk-black' } }
    const close = { productId: 'chair', url: chair.url, match: 'close' as const, variation: null }
    expect(fromSkuHits([variation])).toEqual([deskBlack])
    expect(fromSkuHits([variation, close])).toEqual([deskBlack])
    expect(fromSkuHits([close])).toEqual([chair])
    expect(fromSkuHits([close, { ...close, productId: 'stool' }])).toEqual([])
    expect(fromSkuHits([])).toEqual([])
  })
})

describe('rememberProducts', () => {
  it('keeps the newest last, moving a repeat to the end', () => {
    expect(rememberProducts([desk, chair], [desk]).map((p) => p.id)).toEqual(['chair', 'desk'])
  })

  it('lets a chosen variation replace its listing', () => {
    expect(rememberProducts([desk, chair], [deskBlack]).map((p) => p.id)).toEqual(['chair', 'desk-black'])
  })

  it('brings the chosen variation forward when its listing is read again', () => {
    expect(rememberProducts([deskBlack, chair], [desk]).map((p) => p.id)).toEqual(['chair', 'desk-black'])
  })

  it('keeps only the newest ten', () => {
    const many = Array.from({ length: MAX_DISCUSSED_PRODUCTS + 4 }, (_, i) => ({ id: `p${i}`, url: null, parentId: null }))
    const kept = rememberProducts([], many)
    expect(kept).toHaveLength(MAX_DISCUSSED_PRODUCTS)
    expect(kept[kept.length - 1]?.id).toBe(`p${MAX_DISCUSSED_PRODUCTS + 3}`)
  })
})

describe('parseDiscussedProducts', () => {
  it('reads the stored list and drops anything without an id', () => {
    expect(parseDiscussedProducts([{ id: 'desk', url: desk.url }, { url: 'x' }, 'chair', null, { id: ' ', url: null }])).toEqual([desk])
    expect(parseDiscussedProducts({})).toEqual([])
    expect(parseDiscussedProducts(null)).toEqual([])
  })
})

describe('productsToSend (the live-site bug: a note with no products)', () => {
  it('falls back to the chat\'s own record, newest first, when the model passes none', () => {
    expect(productsToSend([], [chair, deskBlack], 5)).toEqual(['desk-black', 'chair'])
  })

  it('uses the ids the model passed when it passed any', () => {
    expect(productsToSend(['chair'], [chair, deskBlack], 5)).toEqual(['chair'])
  })

  it('swaps a listing the model named for the variation the chat settled on', () => {
    expect(productsToSend(['desk', 'chair'], [deskBlack, chair], 5)).toEqual(['desk-black', 'chair'])
  })

  it('never lists more than asked, never twice, and nothing when nothing was discussed', () => {
    expect(productsToSend([], [desk, chair, deskBlack], 1)).toEqual(['desk-black'])
    expect(productsToSend(['chair', 'chair', ' '], [], 5)).toEqual(['chair'])
    expect(productsToSend([], [], 5)).toEqual([])
  })
})

describe('productLinksToSend', () => {
  it('links only products the chat recorded, the named ones first', () => {
    expect(productLinksToSend(['chair', 'invented'], [chair, deskBlack], 3)).toEqual([chair.url])
    expect(productLinksToSend(['desk'], [chair, deskBlack], 3)).toEqual([deskBlack.url])
  })

  it('falls back to the newest recorded when none named are known', () => {
    expect(productLinksToSend(['invented'], [chair, deskBlack], 3)).toEqual([deskBlack.url, chair.url])
    expect(productLinksToSend([], [chair, deskBlack, { id: 'x', url: null, parentId: null }], 1)).toEqual([deskBlack.url])
  })
})
