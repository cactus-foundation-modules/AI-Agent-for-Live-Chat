import { describe, expect, it } from 'vitest'
import { readShopLink } from './shop-link'

describe('readShopLink', () => {
  it('reads a filtered, sorted category page', () => {
    expect(readShopLink('https://deskwell.co.uk/shop/categories/computer-task-chairs?sort=price-asc&colour=green', 'deskwell.co.uk')).toEqual({
      kind: 'category',
      category: 'computer-task-chairs',
      words: ['green'],
      sort: 'price',
    })
  })

  it('takes the deepest category, skips page keys and price bands', () => {
    expect(readShopLink('/shop/categories/seating/mesh-chairs?page=2&price=0-200&back-colour=moss-green,black&utm_source=x')).toEqual({
      kind: 'category',
      category: 'mesh-chairs',
      words: ['moss green', 'black'],
      sort: 'relevance',
    })
  })

  it('reads a product page with its options in either URL style', () => {
    expect(readShopLink('https://www.deskwell.co.uk/crew-2-chair?upholstery-colour=myrrh-green&delivery-service=express', 'deskwell.co.uk')).toEqual({
      kind: 'product',
      slug: 'crew-2-chair',
      options: 'myrrh green',
    })
    expect(readShopLink('/shop/oslo-air?width=120cm&modesty-panel=without-modesty-panel')).toEqual({
      kind: 'product',
      slug: 'oslo-air',
      options: '120cm without modesty panel',
    })
  })

  it('refuses another site, the basket and the home page', () => {
    expect(readShopLink('https://elsewhere.example/shop/categories/chairs', 'deskwell.co.uk').kind).toBe('other')
    expect(readShopLink('https://deskwell.co.uk/shop/cart', 'deskwell.co.uk').kind).toBe('other')
    expect(readShopLink('https://deskwell.co.uk/', 'deskwell.co.uk').kind).toBe('other')
    expect(readShopLink('not a link at all %%%').kind).toBe('other')
    expect(readShopLink('/%E0%A4%A').kind).toBe('product')
  })
})
