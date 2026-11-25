import { describe, expect, it, vi } from 'vitest'

// Which service the visitor's words name, what the model is told when none
// fits, and that only well-formed services the shop publishes are offered.

const timing = vi.hoisted(() => ({
  provider: vi.fn(async (ids: string[]) => new Map<string, unknown>(ids.map((id) => [id, { options: [
    { key: 'standard', label: 'Standard delivery', price: 0 },
    { key: 'express', label: 'Express', price: 25 },
    { key: 'bad key!', label: 'Broken' },
    { key: 'nameless' },
  ] }]))),
}))
vi.mock('@/lib/modules/extension-points.public', () => ({
  modulePublicExtensionPointComponents: { 'shop.product-delivery-timing': { 'advanced-shipping': timing.provider } },
}))
vi.mock('@/modules/shop/lib/checkout', () => ({ resolveCartLines: vi.fn(async () => []) }))

const { matchService, serviceMissMessage, timingMenus } = await import('./delivery-choice')
type ServiceOption = import('./delivery-choice').ServiceOption

const CHAIR: ServiceOption[] = [
  { key: 'flat-pack', label: 'Flat-packed', alsoKnownAs: 'Flat-packed by Fri 27 Nov (free)' },
  { key: 'pre-assembled', label: 'Pre-assembled', alsoKnownAs: 'Pre-assembled by Fri 27 Nov (£25.00 + VAT)' },
]
const DESK: ServiceOption[] = [
  { key: 'standard', label: 'Standard delivery' },
  { key: 'installed', label: 'Delivered and installed' },
]

describe('matchService', () => {
  it('takes an exact name or key', () => {
    expect(matchService('Pre-assembled', CHAIR)).toEqual({ kind: 'match', option: CHAIR[1] })
    expect(matchService('flat-pack', CHAIR)).toEqual({ kind: 'match', option: CHAIR[0] })
  })

  it('matches the words a visitor uses for a service', () => {
    expect(matchService('pre-assembled delivery', CHAIR)).toMatchObject({ kind: 'match', option: { key: 'pre-assembled' } })
    expect(matchService('installation', DESK)).toMatchObject({ kind: 'match', option: { key: 'installed' } })
  })

  it('says when nothing or several fit', () => {
    expect(matchService('express', DESK)).toEqual({ kind: 'none', labels: ['Standard delivery', 'Delivered and installed'] })
    expect(matchService('delivery', DESK).kind).toBe('none')
    expect(matchService('by Fri 27 Nov', CHAIR).kind).toBe('ambiguous')
  })
})

describe('serviceMissMessage', () => {
  it('says what is on offer, that nothing was recorded, and to check get_product', () => {
    const none = serviceMissMessage('express', { kind: 'none', labels: ['Standard', 'Installed'] })
    expect(none).toContain('Standard, Installed')
    expect(none).toContain('Nothing was recorded')
    expect(none).toContain('get_product')
    expect(serviceMissMessage('installed', null)).toContain('no delivery choice')
    expect(serviceMissMessage('fast', { kind: 'ambiguous', labels: ['Express', 'Express plus'] })).toContain('Express or Express plus')
  })

  it('has no em dashes', () => {
    expect(serviceMissMessage('x', { kind: 'none', labels: ['A'] })).not.toContain('\u2014')
  })
})

describe('timingMenus', () => {
  it('keeps only services with a proper key and a name', async () => {
    const menus = await timingMenus(['desk', 'desk', ''])
    expect(timing.provider).toHaveBeenCalledWith(['desk'])
    expect(menus.get('desk')).toEqual([{ key: 'standard', label: 'Standard delivery' }, { key: 'express', label: 'Express' }])
  })

  it('asks nobody for no products, and says nothing when the provider fails', async () => {
    timing.provider.mockClear()
    expect((await timingMenus([])).size).toBe(0)
    expect(timing.provider).not.toHaveBeenCalled()
    timing.provider.mockRejectedValueOnce(new Error('down'))
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    expect((await timingMenus(['desk'])).size).toBe(0)
    spy.mockRestore()
  })
})
