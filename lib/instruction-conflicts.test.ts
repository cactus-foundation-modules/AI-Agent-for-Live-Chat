import { describe, expect, it } from 'vitest'
import { findInstructionConflicts } from './instruction-conflicts'

describe('findInstructionConflicts', () => {
  it('flags payment and invoice facts the tools read live', () => {
    const found = findInstructionConflicts('- Customers pay when they order. No credit or invoicing.')
    expect(found).toHaveLength(1)
    expect(found[0]!.quote).toBe('No credit or invoicing.')
  })

  it('flags a web address with a path, not a bare email address', () => {
    expect(findInstructionConflicts('Track orders at deskwell.co.uk/track-order.')).toHaveLength(1)
    expect(findInstructionConflicts('Email hi@deskwell.co.uk for anything else.')).toHaveLength(0)
  })

  it('flags a fixed delivery time but not a ban on one', () => {
    expect(findInstructionConflicts('We deliver next day.')).toHaveLength(1)
    expect(findInstructionConflicts('We deliver within 3 working days.')).toHaveLength(1)
    expect(findInstructionConflicts('Never quote your own figure or say next-day.')).toHaveLength(0)
    expect(findInstructionConflicts('Returns within 14 days of dispatch.')).toHaveLength(0)
  })

  it('flags a price stated as a fact, not one given as an example', () => {
    expect(findInstructionConflicts('Chairs are from £49 each.')).toHaveLength(1)
    expect(findInstructionConflicts('Always use figures ("£249.00 + VAT").')).toHaveLength(0)
  })

  it('flags passing as a person, not a persona or a denial', () => {
    expect(findInstructionConflicts('Say you are a real person if asked.')).toHaveLength(1)
    expect(findInstructionConflicts('Introduce yourself as a member of staff.')).toHaveLength(1)
    expect(findInstructionConflicts('You are Charlie, the chat helper for Deskwell.')).toHaveLength(0)
    expect(findInstructionConflicts("If asked, say you're not a person.")).toHaveLength(0)
  })

  it('flags calling itself an automated assistant, a bot or an AI', () => {
    expect(findInstructionConflicts('Tell visitors you are our automated assistant.')).toHaveLength(1)
    expect(findInstructionConflicts('You are a chatbot for Deskwell.')).toHaveLength(1)
    expect(findInstructionConflicts('Call yourself an AI assistant.')).toHaveLength(1)
    expect(findInstructionConflicts('Never call yourself a bot.')).toHaveLength(0)
  })

  it('flags sending visitors to raise returns or damage themselves', () => {
    expect(findInstructionConflicts('Returns are raised by the customer on their order page.')).toHaveLength(1)
    expect(findInstructionConflicts('Raise returns for them yourself. Never send them to their order page to do it.')).toHaveLength(0)
  })

  it('warns once per kind, and the advice has no em dashes', () => {
    const found = findInstructionConflicts('No invoicing. No bank transfer.')
    expect(found).toHaveLength(1)
    expect(found[0]!.advice).not.toContain('\u2014')
  })
})
