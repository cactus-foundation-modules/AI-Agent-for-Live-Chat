import { describe, expect, it } from 'vitest'
import { notGenuineFirstLine, notGenuineLastLine } from './lines'
import { notGenuineOnFlag } from './not-genuine'

describe('the not-genuine flow', () => {
  it('warns once, calmly, and carries on', () => {
    expect(notGenuineOnFlag(false, 'Deskwell')).toEqual({ kind: 'warn', reply: notGenuineFirstLine('Deskwell') })
    expect(notGenuineFirstLine('Deskwell')).toBe("I'm here to help with Deskwell's products, orders and deliveries. If there's anything like that I can do for you, just ask.")
    expect(notGenuineFirstLine(' ')).toContain('our products')
  })

  it('steps back the second time', () => {
    expect(notGenuineOnFlag(true, 'Deskwell')).toEqual({ kind: 'step_back', reply: notGenuineLastLine() })
  })

  it('never promises a colleague or a callback (the live-site bug)', () => {
    for (const line of [notGenuineFirstLine('Deskwell'), notGenuineLastLine()]) {
      expect(line).not.toMatch(/colleague|in touch|email|passed/i)
    }
  })
})
