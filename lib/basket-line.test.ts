import { describe, it, expect } from 'vitest'
import { BasketLineQuery, basketLineMeta } from './basket-line'

const menus = new Map([
  ['p1', { field: 'asf_service', options: [{ key: 'standard', label: 'Standard' }, { key: 'pre-assembled', label: 'Pre-assembled' }] }],
])

describe('basketLineMeta', () => {
  it('writes the service under the field the basket reads, where it is offered', () => {
    expect(basketLineMeta('p1', 'pre-assembled', menus)).toEqual({ asf_service: 'pre-assembled' })
  })

  it('is null for a service the basket does not offer that product', () => {
    expect(basketLineMeta('p1', 'installed', menus)).toBeNull()
  })

  it('is null for a product with no picker at all', () => {
    expect(basketLineMeta('p2', 'standard', menus)).toBeNull()
    expect(basketLineMeta('p1', 'standard', new Map())).toBeNull()
  })
})

describe('BasketLineQuery', () => {
  it('takes a product id and a service key', () => {
    expect(BasketLineQuery.safeParse({ product: '3f2b9c1e-0a4d-4e1f-9b7a-2c5d8e6f0a11', service: 'next_day' }).success).toBe(true)
  })

  it('refuses ids and keys that are not the shape the shop uses', () => {
    expect(BasketLineQuery.safeParse({ product: '', service: 'standard' }).success).toBe(false)
    expect(BasketLineQuery.safeParse({ product: 'p1', service: '' }).success).toBe(false)
    expect(BasketLineQuery.safeParse({ product: "p1' OR 1=1", service: 'standard' }).success).toBe(false)
    expect(BasketLineQuery.safeParse({ product: 'p1', service: '<b>' }).success).toBe(false)
    expect(BasketLineQuery.safeParse({ product: 'p'.repeat(101), service: 'standard' }).success).toBe(false)
  })
})
