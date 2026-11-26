import { describe, expect, it } from 'vitest'
import { keepSaidSizes } from './said-sizes'

describe('keepSaidSizes (the live-site 120cm nobody asked for)', () => {
  it('sets aside a size the visitor never wrote', () => {
    const out = keepSaidSizes('120cm / 80cm / Dark Teal / Black', 'i need a cheap blue desk please. ideally with a black frame')
    expect(out.setAside).toEqual(['120cm', '80cm'])
    expect(out.options).toContain('Dark Teal')
    expect(out.options).not.toMatch(/\d/)
  })

  it('keeps a size they wrote, in any unit', () => {
    expect(keepSaidSizes('140cm dark teal', 'ideally 140cm wide').setAside).toEqual([])
    expect(keepSaidSizes('120cm', 'about 1.2m wide').setAside).toEqual([])
    expect(keepSaidSizes('160cm', 'a 1600mm desk').setAside).toEqual([])
    expect(keepSaidSizes('120cm without modesty panel', '120 no mod panel').setAside).toEqual([])
    expect(keepSaidSizes('2 drawer', 'a two drawer cabinet').setAside).toEqual([])
  })

  it('leaves options without figures alone', () => {
    expect(keepSaidSizes('dark teal black frame', 'blue')).toEqual({ options: 'dark teal black frame', setAside: [] })
  })
})
