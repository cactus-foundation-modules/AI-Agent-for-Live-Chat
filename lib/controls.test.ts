import { describe, expect, it } from 'vitest'
import { chatControl, minutesSince } from './controls'

const now = new Date('2026-11-24T12:00:00Z')
const base = { name: 'Charlie', aiFirst: false, waitingSince: null, now }

describe('chatControl', () => {
  it('offers "Hand to" on a chat following the rules while the assistant does not go first', () => {
    expect(chatControl({ ...base, state: 'auto' })).toEqual({ pill: null, action: { kind: 'hand', label: 'Hand to Charlie' } })
  })

  it('says the assistant is answering when it goes first, or was handed the chat', () => {
    expect(chatControl({ ...base, state: 'auto', aiFirst: true })).toEqual({ pill: 'Charlie answering', action: null })
    expect(chatControl({ ...base, state: 'assistant' })).toEqual({ pill: 'Charlie answering', action: null })
  })

  it('offers "Hand back" to a colleague, and while waiting for one', () => {
    expect(chatControl({ ...base, state: 'colleague' })).toEqual({ pill: 'Colleague answering', action: { kind: 'hand_back', label: 'Hand back to Charlie' } })
    expect(chatControl({ ...base, state: 'waiting', waitingSince: new Date('2026-11-24T11:57:30Z') })).toEqual({
      pill: 'Waiting for a colleague 2 min',
      action: { kind: 'hand_back', label: 'Hand back to Charlie' },
    })
  })

  it('shows a stepped-back chat, and lets a colleague hand it over again', () => {
    expect(chatControl({ ...base, state: 'quiet' })).toEqual({ pill: 'Stepped back', action: { kind: 'hand', label: 'Hand to Charlie' } })
    expect(chatControl({ ...base, state: 'not_genuine' }).action?.kind).toBe('hand')
  })
})

describe('minutesSince', () => {
  it('counts whole minutes and never goes below nought', () => {
    expect(minutesSince(null, now)).toBe(0)
    expect(minutesSince(new Date('2026-11-24T11:58:59Z'), now)).toBe(1)
    expect(minutesSince(new Date('2026-11-24T12:05:00Z'), now)).toBe(0)
  })
})
