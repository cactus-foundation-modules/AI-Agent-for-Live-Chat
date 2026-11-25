import { describe, expect, it } from 'vitest'
import {
  MAX_DISCUSSED_PRODUCTS,
  addressOf,
  addressWithChoice,
  chooseDelivery,
  chosenDeliveries,
  fromProductDetail,
  fromSkuHits,
  parseDiscussedProducts,
  productLinksToSend,
  productsToSend,
  recordedEntry,
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

describe('a chosen delivery service', () => {
  const express = { key: 'express', label: 'Express' }
  const installed = { key: 'installed', label: 'Delivered and installed' }

  it('reads rows saved before deliveries were kept exactly as before', () => {
    const old = [{ id: 'desk-black', url: deskBlack.url, parentId: 'desk' }, { id: 'chair', url: chair.url, parentId: null }]
    expect(parseDiscussedProducts(old)).toEqual([deskBlack, chair])
    expect(parseDiscussedProducts(old)[0]).not.toHaveProperty('delivery')
  })

  it('reads a stored choice back, and drops one that is not a real key and name', () => {
    expect(parseDiscussedProducts([{ ...deskBlack, delivery: express }])).toEqual([{ ...deskBlack, delivery: express }])
    expect(parseDiscussedProducts([{ ...deskBlack, delivery: { key: 'bad key!', label: 'Express' } }])).toEqual([deskBlack])
    expect(parseDiscussedProducts([{ ...deskBlack, delivery: { key: 'express' } }])).toEqual([deskBlack])
    expect(parseDiscussedProducts([{ ...deskBlack, delivery: 'express' }])).toEqual([deskBlack])
  })

  it('is recorded on the entry, which becomes the newest, and a new choice replaces it', () => {
    const once = chooseDelivery([deskBlack, chair], 'desk-black', express)
    expect(once).toEqual([chair, { ...deskBlack, delivery: express }])
    const twice = chooseDelivery(once, 'desk-black', installed)
    expect(twice).toEqual([chair, { ...deskBlack, delivery: installed }])
  })

  it('is not recorded for a product the chat never looked up', () => {
    expect(chooseDelivery([chair], 'invented', express)).toEqual([chair])
  })

  it('survives the product being looked up again, but is not handed from a listing to its variation', () => {
    const chosen = chooseDelivery([desk, chair], 'desk', express)
    expect(rememberProducts(chosen, [desk])).toEqual([chair, { ...desk, delivery: express }])
    expect(rememberProducts(chosen, [deskBlack])).toEqual([chair, deskBlack])
    const variation = chooseDelivery([deskBlack], 'desk-black', express)
    expect(rememberProducts(variation, [desk])).toEqual([{ ...deskBlack, delivery: express }])
  })

  it('finds the entry a product id means: itself, or the variation the chat settled on', () => {
    expect(recordedEntry([deskBlack, chair], 'chair')).toBe(chair)
    expect(recordedEntry([deskBlack, chair], 'desk')).toBe(deskBlack)
    expect(recordedEntry([deskBlack, chair], 'invented')).toBeUndefined()
    expect(recordedEntry([deskBlack], ' ')).toBeUndefined()
  })

  it('puts the service on the address, the options kept, and on a text\'s links', () => {
    const chosen = chooseDelivery([chair, deskBlack], 'desk-black', express)
    expect(addressOf(chosen[1]!)).toBe('https://shop.test/desk?colour=black&delivery-service=express')
    expect(addressOf(chair)).toBe(chair.url)
    expect(addressWithChoice('desk-black', deskBlack.url, chosen)).toBe('https://shop.test/desk?colour=black&delivery-service=express')
    expect(addressWithChoice('desk', desk.url, chosen)).toBe(desk.url)
    expect(productLinksToSend([], chosen, 3)).toEqual(['https://shop.test/desk?colour=black&delivery-service=express', chair.url])
    expect(chosenDeliveries(chosen)).toEqual(new Map([['desk-black', express]]))
  })
})
