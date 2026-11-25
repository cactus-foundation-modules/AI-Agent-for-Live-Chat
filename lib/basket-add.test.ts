import { describe, it, expect, vi } from 'vitest'
import { addToCartOptions, basketMetaFor, metaFromReply, serviceKeyOf } from './basket-add'

const withKey = { delivery: { key: 'installed', label: 'Installed', price: '£40.00' } }
const reply = (body: unknown, ok = true) => vi.fn(async (_input: string, _init?: unknown) => ({ ok, json: async () => body }))

describe('serviceKeyOf', () => {
  it('reads the chosen service key off a card', () => {
    expect(serviceKeyOf(withKey)).toBe('installed')
  })

  it('is null for a card from an older Live Chat with no key, or no delivery', () => {
    expect(serviceKeyOf({ delivery: { label: 'Installed', price: '£40.00' } })).toBeNull()
    expect(serviceKeyOf({ delivery: null })).toBeNull()
    expect(serviceKeyOf({})).toBeNull()
    expect(serviceKeyOf({ delivery: { key: '../x' } })).toBeNull()
  })
})

describe('metaFromReply and addToCartOptions', () => {
  it('passes the meta on when the route found the service', () => {
    const meta = metaFromReply({ meta: { asf_service: 'installed' } })
    expect(meta).toEqual({ asf_service: 'installed' })
    expect(addToCartOptions(meta)).toEqual({ meta: { asf_service: 'installed' } })
  })

  it('falls back to a plain add for meta null, an empty meta or an odd reply', () => {
    for (const body of [{ meta: null }, { meta: {} }, { error: 'Invalid request' }, null, 'nonsense', { meta: { field: 4 } }]) {
      const meta = metaFromReply(body)
      expect(meta).toBeNull()
      expect(addToCartOptions(meta)).toBeUndefined()
    }
  })
})

describe('basketMetaFor', () => {
  it('asks the route once, with the product and the service', async () => {
    const fetcher = reply({ meta: { asf_service: 'installed' } })
    expect(await basketMetaFor('p1', withKey, fetcher)).toEqual({ asf_service: 'installed' })
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(fetcher.mock.calls[0]?.[0]).toBe('/api/m/ai-agent-for-live-chat/public/basket-line?product=p1&service=installed')
  })

  it('does not ask at all without a key', async () => {
    const fetcher = reply({ meta: { asf_service: 'installed' } })
    expect(await basketMetaFor('p1', { delivery: { label: 'Installed', price: '£40.00' } }, fetcher)).toBeNull()
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('is null on a refusal or a network fault, never a throw', async () => {
    expect(await basketMetaFor('p1', withKey, reply({ error: 'Invalid request' }, false))).toBeNull()
    expect(await basketMetaFor('p1', withKey, vi.fn(async () => { throw new Error('offline') }))).toBeNull()
  })
})
