import { describe, expect, it } from 'vitest'
import { countLinks, isGibberish, isGibberishWord, isRepeated, isTooFast, notGenuineReason, type VisitorLine } from './spam'

let nextId = 1
function line(body: string, at = 0): VisitorLine {
  return { id: nextId++, body, createdAt: new Date(Date.UTC(2026, 10, 24, 12, 0, 0) + at) }
}

describe('isRepeated', () => {
  it('spots the same message three times in a row', () => {
    expect(isRepeated([line('Hello?'), line('hello'), line('HELLO!')])).toBe(true)
    expect(isRepeated([line('Hello?'), line('hello')])).toBe(false)
  })

  it('never counts short everyday replies', () => {
    expect(isRepeated([line('yes'), line('yes'), line('yes')])).toBe(false)
    expect(isRepeated([line('ok'), line('ok'), line('ok'), line('ok')])).toBe(false)
  })

  it('counts only a run, nothing between (the live-site "tell me more" false alarm)', () => {
    const lines = [line('tell me more'), line('oh great, tell me more about him'), line('tell me more', 45_000), line('who is oscar', 59_000), line('tell me more', 70_000)]
    expect(isRepeated(lines)).toBe(false)
    expect(isRepeated([line('thanks'), line('thanks'), line('a'), line('thanks')])).toBe(false)
  })

  it('counts a run only inside a minute', () => {
    expect(isRepeated([line('hello?', 0), line('hello?', 50_000), line('hello?', 59_000)])).toBe(true)
    expect(isRepeated([line('hello?', 0), line('hello?', 90_000), line('hello?', 180_000)])).toBe(false)
  })
})

describe('countLinks', () => {
  it('counts web addresses', () => {
    expect(countLinks('see https://a.test and http://b.test and www.c.test')).toBe(3)
    expect(countLinks('no links here')).toBe(0)
  })
})

describe('gibberish', () => {
  it('spots keyboard runs, long consonant runs and held-down keys', () => {
    expect(isGibberishWord('asdfasdf')).toBe(true)
    expect(isGibberishWord('sdkfjhsdkfjh')).toBe(true)
    expect(isGibberishWord('aaaaaaaaa')).toBe(true)
  })

  it('leaves real words alone, Welsh and London included', () => {
    for (const word of ['property', 'strengths', 'rhythms', 'Knightsbridge', 'Llanfairpwllgwyngyll', 'strewn', 'hello', 'qwerty']) {
      expect(isGibberishWord(word), word).toBe(word === 'qwerty')
    }
  })

  it('judges a message by most of its words, ignoring codes, addresses and emails', () => {
    expect(isGibberish('asdfgh jkjkjkjkjkjk')).toBe(true)
    expect(isGibberish('Do you have the DW-1234-BLK in stock for SW1A 1AA?')).toBe(false)
    expect(isGibberish('Is a qwerty keyboard included with the desk bundle?')).toBe(false)
    expect(isGibberish('sam@example.com https://x.test/asdfgh')).toBe(false)
    expect(isGibberish('1234 5678')).toBe(false)
  })
})

describe('isTooFast', () => {
  const long = 'x'.repeat(200)
  it('flags a long message far quicker than anybody types', () => {
    expect(isTooFast(line('hi', 0), line(long, 1_000))).toBe(true)
  })
  it('lets short messages, slow messages and first messages through', () => {
    expect(isTooFast(line('hi', 0), line('quick one', 500))).toBe(false)
    expect(isTooFast(line('hi', 0), line(long, 30_000))).toBe(false)
    expect(isTooFast(undefined, line(long, 0))).toBe(false)
  })
})

describe('notGenuineReason', () => {
  it('names the first sign found among the new messages', () => {
    const a = line('please help')
    const b = line('please help')
    const c = line('please help')
    expect(notGenuineReason([a, b, c], new Set([c.id]))).toBe('repeated')

    const links = line('https://a.test https://b.test https://c.test https://d.test')
    expect(notGenuineReason([links], new Set([links.id]))).toBe('links')

    const mash = line('asdfjkl qwerqwer')
    expect(notGenuineReason([mash], new Set([mash.id]))).toBe('gibberish')

    const first = line('hello', 0)
    const pasted = line('y'.repeat(180).replace(/y/g, (_, i: number) => (i % 6 === 5 ? ' ' : 'a')), 900)
    expect(notGenuineReason([first, pasted], new Set([pasted.id]))).toBe('too_fast')
  })

  it('ignores messages already answered, and genuine chats', () => {
    const a = line('asdfasdf')
    const b = line('Sorry, cat on the keyboard. Do you deliver to Leeds?')
    expect(notGenuineReason([a, b], new Set([b.id]))).toBeNull()
    expect(notGenuineReason([], new Set())).toBeNull()
  })
})
