import { describe, expect, it } from 'vitest'
import { findEmail, findName, isPlausibleEmail } from './contact-text'
import { NOT_GENUINE_FIRST, NOT_GENUINE_AGAIN, notGenuineAskLine } from './lines'
import { NOT_GENUINE_MAX_ASKS, notGenuineStep } from './not-genuine'

describe('the not-genuine flow', () => {
  it('saves the details, with a name, the moment an email address arrives', () => {
    const step = notGenuineStep(1, 'Sam Jones sam@example.com')
    expect(step).toEqual({ kind: 'save', email: 'sam@example.com', name: 'Sam Jones', reply: 'Thank you, Sam Jones. I have passed this to a colleague, who will be in touch by email.' })
  })

  it('saves an email with no name too, on any ask, even the last', () => {
    const step = notGenuineStep(NOT_GENUINE_MAX_ASKS, 'SAM@Example.com')
    expect(step.kind).toBe('save')
    if (step.kind === 'save') {
      expect(step.email).toBe('sam@example.com')
      expect(step.name).toBeNull()
      expect(step.reply).toBe('Thank you. I have passed this to a colleague, who will be in touch by email.')
    }
  })

  it('asks again, up to three asks in all', () => {
    expect(notGenuineStep(1, 'no')).toEqual({ kind: 'ask', asks: 2, reply: NOT_GENUINE_AGAIN[0] })
    expect(notGenuineStep(2, 'lol')).toEqual({ kind: 'ask', asks: 3, reply: NOT_GENUINE_AGAIN[1] })
  })

  it('gives up silently after the third unanswered ask', () => {
    expect(notGenuineStep(3, 'whatever')).toEqual({ kind: 'give_up' })
    expect(notGenuineStep(7, 'still nothing')).toEqual({ kind: 'give_up' })
  })

  it('opens with the fixed first line', () => {
    expect(notGenuineAskLine(1)).toBe(NOT_GENUINE_FIRST)
    expect(NOT_GENUINE_FIRST).toMatch(/name and email/)
  })
})

describe('contact text', () => {
  it('recognises ordinary email addresses only', () => {
    expect(isPlausibleEmail('sam@example.co.uk')).toBe(true)
    expect(isPlausibleEmail('sam.o\'neill+chat@example.com')).toBe(true)
    expect(isPlausibleEmail('sam@example')).toBe(false)
    expect(isPlausibleEmail('sam at example.com')).toBe(false)
    expect(isPlausibleEmail('sam@@example.com')).toBe(false)
    expect(isPlausibleEmail('sam..x@example.com')).toBe(false)
  })

  it('finds the first address in a sentence, without trailing full stops', () => {
    expect(findEmail('It is Sam.Jones@Example.com. Thanks')).toBe('sam.jones@example.com')
    expect(findEmail('no address here')).toBeNull()
  })

  it('finds a name beside the address, in the ways people write it', () => {
    expect(findName('my name is Sam, sam@x.com')).toBe('Sam')
    expect(findName("hi it's sam and my email is sam@x.com")).toBe('Sam')
    expect(findName('Hi, Sam Jones here sam@x.com')).toBe('Sam Jones')
    expect(findName('sam@x.com')).toBeNull()
    expect(findName('hello there sam@x.com')).toBeNull()
    expect(findName('I would like somebody to call me back about my order please sam@x.com')).toBeNull()
  })
})
