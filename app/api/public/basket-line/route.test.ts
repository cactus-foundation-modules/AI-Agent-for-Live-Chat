import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

const menus = vi.hoisted(() => ({ basketServiceMenus: vi.fn() }))
vi.mock('@/modules/ai-agent-for-live-chat/lib/shop/delivery-choice', () => menus)

import { GET } from './route'

const ask = (query: string) => GET(new NextRequest(`https://example.com/api/m/ai-agent-for-live-chat/public/basket-line${query}`))

beforeEach(() => {
  menus.basketServiceMenus.mockReset()
  menus.basketServiceMenus.mockResolvedValue(new Map([
    ['p1', { field: 'asf_service', options: [{ key: 'standard', label: 'Standard' }, { key: 'installed', label: 'Installed' }] }],
  ]))
})

describe('GET basket-line', () => {
  it('answers the line meta for a service the shop offers', async () => {
    const response = await ask('?product=p1&service=installed')
    expect(response.status).toBe(200)
    expect(response.headers.get('Cache-Control')).toBe('no-store')
    expect(await response.json()).toEqual({ meta: { asf_service: 'installed' } })
    expect(menus.basketServiceMenus).toHaveBeenCalledWith(['p1'])
  })

  it('answers meta null for a service the shop does not offer', async () => {
    const response = await ask('?product=p1&service=express')
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ meta: null })
  })

  it('answers meta null when the basket cannot be worked out', async () => {
    menus.basketServiceMenus.mockResolvedValue(new Map())
    expect(await (await ask('?product=p1&service=installed')).json()).toEqual({ meta: null })
  })

  it('refuses bad input without asking the shop', async () => {
    for (const query of ['', '?product=p1', '?service=installed', '?product=p%27%3B&service=installed', '?product=p1&service=%3Cx%3E']) {
      const response = await ask(query)
      expect(response.status).toBe(400)
      expect(response.headers.get('Cache-Control')).toBe('no-store')
    }
    expect(menus.basketServiceMenus).not.toHaveBeenCalled()
  })
})
