import { describe, expect, it } from 'vitest'
import { repairLinks } from './reply-links'

const QUBE = 'https://deskwell.co.uk/qube-steel-office-filing-cabinet-in-25-colours'
const BLUE = 'https://deskwell.co.uk/qube-steel-office-filing-cabinet-in-25-colours?drawers=2-drawer&finish=qube-steel-blue'

describe('repairLinks', () => {
  it('mends the live-site "httpskwell.co.uk/..." back into the address the tool gave', () => {
    expect(repairLinks(`Here:\n\nhttpskwell.co.uk/qube-steel-office-filing-cabinet-in-25-colours`, [QUBE, BLUE]))
      .toBe(`Here:\n\n${QUBE}`)
  })

  it('matches the longest address, options included, and keeps the full stop after it', () => {
    expect(repairLinks('See deskwell.co.uk/qube-steel-office-filing-cabinet-in-25-colours?drawers=2-drawer&finish=qube-steel-blue.', [QUBE, BLUE]))
      .toBe(`See ${BLUE}.`)
  })

  it('leaves working addresses and anything it does not know alone', () => {
    const text = `${QUBE} and https://workplaceinsight.net/an-article/ and a/b test`
    expect(repairLinks(text, [QUBE])).toBe(text)
    expect(repairLinks('httpsexample.com/nothing-we-know', [QUBE])).toBe('httpsexample.com/nothing-we-know')
  })
})
