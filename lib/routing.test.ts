import { describe, expect, it } from 'vitest'
import { CHAT_STATES, type ChatState, type Mode } from './constants'
import {
  coversWhenSwitchedOff,
  decideAnswering,
  decideOffer,
  handoverExpired,
  modeAllows,
  stateAfterColleagueReplied,
  stateForHand,
  stateWhenSwitchedOff,
} from './routing'

const offer = (state: ChatState, over: Partial<{ mode: Mode; staff: boolean; online: boolean; aiFirst: boolean }> = {}) =>
  decideOffer({ mode: 'on', staff: false, online: false, aiFirst: false, state, ...over })

describe('modeAllows', () => {
  it('Off never, On always, Staff only for staff', () => {
    expect(modeAllows('off', true)).toBe(false)
    expect(modeAllows('on', false)).toBe(true)
    expect(modeAllows('staff', false)).toBe(false)
    expect(modeAllows('staff', true)).toBe(true)
  })
})

describe('decideOffer', () => {
  it('never takes anything with the mode off, whatever the state', () => {
    for (const state of CHAT_STATES) {
      const d = offer(state, { mode: 'off', staff: true })
      expect(d.take).toBe(false)
      expect(d.state).toBe(state)
    }
  })

  it('in Staff only, takes nothing from a visitor and follows the rules for staff', () => {
    for (const state of CHAT_STATES) expect(offer(state, { mode: 'staff', staff: false }).take).toBe(false)
    expect(offer('auto', { mode: 'staff', staff: true }).take).toBe(true)
    expect(offer('auto', { mode: 'staff', staff: true, online: true }).take).toBe(false)
  })

  it('auto: taken when nobody is online or the assistant goes first', () => {
    expect(offer('auto', { online: false })).toEqual({ take: true, state: 'auto', flow: 'ai', callbackWanted: false })
    expect(offer('auto', { online: true, aiFirst: true }).take).toBe(true)
    expect(offer('auto', { online: true, aiFirst: false })).toEqual({ take: false, state: 'auto', flow: null, callbackWanted: false })
  })

  it('assistant: always taken, switches or not', () => {
    expect(offer('assistant', { online: true, aiFirst: false })).toMatchObject({ take: true, state: 'assistant', flow: 'ai' })
    expect(offer('assistant', { online: false }).take).toBe(true)
  })

  it('colleague: left alone while online; taken and back to auto once nobody is', () => {
    expect(offer('colleague', { online: true, aiFirst: true })).toMatchObject({ take: false, state: 'colleague' })
    expect(offer('colleague', { online: false })).toEqual({ take: true, state: 'auto', flow: 'ai', callbackWanted: false })
  })

  it('waiting: left for colleagues while online; taken back with an apology owed once nobody is', () => {
    expect(offer('waiting', { online: true, aiFirst: true })).toMatchObject({ take: false, state: 'waiting' })
    expect(offer('waiting', { online: false })).toEqual({ take: true, state: 'auto', flow: 'ai', callbackWanted: true })
  })

  it('not_genuine: taken by the fixed lines, never the model', () => {
    expect(offer('not_genuine', { online: true })).toEqual({ take: true, state: 'not_genuine', flow: 'not_genuine', callbackWanted: false })
    expect(offer('not_genuine', { online: false }).flow).toBe('not_genuine')
  })

  it('quiet: never taken', () => {
    expect(offer('quiet', { online: false, aiFirst: true })).toMatchObject({ take: false, state: 'quiet' })
  })
})

describe('decideAnswering', () => {
  it('is never answering with the mode off', () => {
    expect(decideAnswering({ mode: 'off', staff: true, online: false, aiFirst: true })).toBe(false)
  })

  it('in On, answers while offline or going first', () => {
    expect(decideAnswering({ mode: 'on', staff: null, online: false, aiFirst: false })).toBe(true)
    expect(decideAnswering({ mode: 'on', staff: null, online: true, aiFirst: true })).toBe(true)
    expect(decideAnswering({ mode: 'on', staff: null, online: true, aiFirst: false })).toBe(false)
  })

  it('in Staff only, answers only a signed-in colleague, and not with no request to read', () => {
    expect(decideAnswering({ mode: 'staff', staff: true, online: false, aiFirst: false })).toBe(true)
    expect(decideAnswering({ mode: 'staff', staff: true, online: true, aiFirst: false })).toBe(false)
    expect(decideAnswering({ mode: 'staff', staff: false, online: false, aiFirst: true })).toBe(false)
    expect(decideAnswering({ mode: 'staff', staff: null, online: false, aiFirst: true })).toBe(false)
  })
})

describe('stateAfterColleagueReplied', () => {
  it('hands every state but quiet to the colleague', () => {
    for (const state of CHAT_STATES) {
      expect(stateAfterColleagueReplied(state)).toBe(state === 'quiet' ? 'quiet' : 'colleague')
    }
  })
})

describe('stateWhenSwitchedOff', () => {
  it('sends colleague chats back to auto, and waiting ones back owed a callback', () => {
    expect(stateWhenSwitchedOff('colleague')).toEqual({ state: 'auto', callbackWanted: false })
    expect(stateWhenSwitchedOff('waiting')).toEqual({ state: 'auto', callbackWanted: true })
  })

  it('leaves everything else exactly where it was', () => {
    for (const state of ['auto', 'assistant', 'not_genuine', 'quiet'] as const) {
      expect(stateWhenSwitchedOff(state)).toEqual({ state, callbackWanted: false })
    }
  })
})

describe('coversWhenSwitchedOff', () => {
  it('covers only in On, and only when the switch goes off', () => {
    expect(coversWhenSwitchedOff('on', false)).toBe(true)
    expect(coversWhenSwitchedOff('on', true)).toBe(false)
    expect(coversWhenSwitchedOff('staff', false)).toBe(false)
    expect(coversWhenSwitchedOff('off', false)).toBe(false)
  })
})

describe('stateForHand', () => {
  it('"Hand to" always gives the assistant the chat outright', () => {
    expect(stateForHand('hand', false)).toBe('assistant')
    expect(stateForHand('hand', true)).toBe('assistant')
  })

  it('"Hand back" follows the site rules when the assistant goes first anyway', () => {
    expect(stateForHand('hand_back', true)).toBe('auto')
    expect(stateForHand('hand_back', false)).toBe('assistant')
  })
})

describe('handoverExpired', () => {
  const now = new Date('2026-11-24T12:00:00Z')
  it('is true only for a waiting chat whose deadline has passed', () => {
    expect(handoverExpired({ state: 'waiting', waitingUntil: new Date('2026-11-24T11:59:59Z') }, now)).toBe(true)
    expect(handoverExpired({ state: 'waiting', waitingUntil: now }, now)).toBe(true)
    expect(handoverExpired({ state: 'waiting', waitingUntil: new Date('2026-11-24T12:00:01Z') }, now)).toBe(false)
    expect(handoverExpired({ state: 'waiting', waitingUntil: null }, now)).toBe(false)
    expect(handoverExpired({ state: 'colleague', waitingUntil: new Date('2026-11-24T11:00:00Z') }, now)).toBe(false)
  })
})
