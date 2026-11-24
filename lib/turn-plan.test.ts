import { describe, expect, it } from 'vitest'
import { DEBOUNCE_MS, MAX_DEBOUNCE_MS, catchUpMessage, debounceWaitMs, hasWork, newVisitorMessages, stateAnswers } from './turn-plan'

const t0 = new Date('2026-11-24T12:00:00.000Z')
const at = (ms: number) => new Date(t0.getTime() + ms)

describe('debounceWaitMs', () => {
  it('goes at once when the visitor has been quiet long enough, or there is no message', () => {
    expect(debounceWaitMs(at(0), at(DEBOUNCE_MS), at(0))).toBe(0)
    expect(debounceWaitMs(null, at(0), at(0))).toBe(0)
  })

  it('waits out the rest of the quiet spell after a fresh message', () => {
    expect(debounceWaitMs(at(1_000), at(1_200), at(1_000))).toBe(DEBOUNCE_MS - 200)
  })

  it('never waits past the overall limit, so a non-stop typist still gets a reply', () => {
    const started = at(0)
    expect(debounceWaitMs(at(MAX_DEBOUNCE_MS - 100), at(MAX_DEBOUNCE_MS - 50), started)).toBe(50)
    expect(debounceWaitMs(at(MAX_DEBOUNCE_MS + 10), at(MAX_DEBOUNCE_MS + 20), started)).toBe(0)
  })
})

describe('turn decisions', () => {
  it('answers only in the states that are still the assistant\'s', () => {
    expect(stateAnswers('auto')).toBe(true)
    expect(stateAnswers('assistant')).toBe(true)
    expect(stateAnswers('not_genuine')).toBe(true)
    expect(stateAnswers('colleague')).toBe(false)
    expect(stateAnswers('waiting')).toBe(false)
    expect(stateAnswers('quiet')).toBe(false)
  })

  it('has work while a taken message is ahead of the handled one', () => {
    expect(hasWork({ lastTakenMessageId: 5, lastHandledMessageId: 4 })).toBe(true)
    expect(hasWork({ lastTakenMessageId: 5, lastHandledMessageId: 5 })).toBe(false)
  })

  it('picks the visitor\'s taken, unhandled messages and nothing else', () => {
    const messages = [
      { id: 1, sender: 'visitor' }, { id: 2, sender: 'agent' }, { id: 3, sender: 'visitor' },
      { id: 4, sender: 'visitor' }, { id: 5, sender: 'visitor' },
    ]
    expect(newVisitorMessages(messages, { lastHandledMessageId: 2, lastTakenMessageId: 4 }).map((m) => m.id)).toEqual([3, 4])
  })
})

describe('catchUpMessage', () => {
  const now = at(60_000)
  it('answers the visitor\'s last message when it is unanswered and recent', () => {
    const msgs = [{ id: 1, sender: 'agent', createdAt: at(0) }, { id: 2, sender: 'visitor', createdAt: at(30_000) }]
    expect(catchUpMessage(msgs, 1, now)?.id).toBe(2)
  })

  it('leaves it when somebody had the last word, it was handled, or it is old', () => {
    expect(catchUpMessage([{ id: 2, sender: 'agent', createdAt: at(0) }], 0, now)).toBeNull()
    expect(catchUpMessage([{ id: 2, sender: 'visitor', createdAt: at(0) }], 2, now)).toBeNull()
    expect(catchUpMessage([{ id: 2, sender: 'visitor', createdAt: at(0) }], 0, now, 1_000)).toBeNull()
    expect(catchUpMessage([], 0, now)).toBeNull()
  })
})
