import { describe, expect, it } from 'vitest'
import { AUTHOR_ID } from './constants'
import { basketWords, contextNote, londonDateTime, transcriptInput, type TranscriptLine } from './model-input'
import { buildInstructions } from './prompt'
import { DEFAULT_SETTINGS } from './settings-model'
import { z } from 'zod'
import { defineTool } from './tools/registry'

// A stand-in for the real list, which reaches the database when imported.
const TOOLS = [defineTool({
  name: 'hand_to_colleague',
  description: 'Fetch a colleague.',
  parameters: { type: 'object', properties: {}, required: [], additionalProperties: false },
  input: z.object({}),
  guidance: 'If the visitor asks for a person, call hand_to_colleague.',
  async handler() { return { ok: true } },
})]

const msg = (id: number, sender: TranscriptLine['sender'], body: string, authorId: string | null = null, authorName: string | null = null, files: string[] = []): TranscriptLine =>
  ({ id, sender, body, authorId, authorName, attachments: files.map((filename) => ({ filename })) })

describe('transcriptInput', () => {
  it('gives each side its role and marks colleagues, automatic messages and notes', () => {
    const items = transcriptInput([
      msg(1, 'agent', 'Welcome!', null, 'Charlie'),
      msg(2, 'visitor', 'Hi, do you deliver?'),
      msg(3, 'agent', 'We do.', AUTHOR_ID, 'Charlie'),
      msg(4, 'system', 'Sam joined the chat.'),
      msg(5, 'agent', 'Sam here.', 'user_1', 'Sam'),
      msg(6, 'visitor', '', null, null, ['photo.jpg']),
      msg(7, 'visitor', 'Not taken yet'),
    ], 6, AUTHOR_ID)
    expect(items).toEqual([
      { role: 'assistant', content: '(Automatic message) Welcome!' },
      { role: 'user', content: 'Hi, do you deliver?' },
      { role: 'assistant', content: 'We do.' },
      { role: 'developer', content: '(Chat note) Sam joined the chat.' },
      { role: 'assistant', content: '(Colleague Sam) Sam here.' },
      { role: 'user', content: '[Sent a file: photo.jpg]' },
    ])
  })
})

describe('contextNote', () => {
  const now = new Date('2026-11-24T14:05:00Z')
  it('says where they are, what they have and what is owed', () => {
    const note = contextNote({
      now, startedOn: '/', currentPath: '/chairs/aero', currentTitle: 'Aero chair',
      basket: [{ name: 'Aero chair', quantity: 2, unitPrice: '£199.00' }], basketTotal: '£398.00',
      signedIn: true, visitorName: 'Sam', visitorEmail: null, staff: true, colleaguesOnline: false, callbackWanted: true,
    })
    expect(note).toMatch(/Tuesday,? 24 November 2026/)
    expect(note).toContain('On the page: Aero chair (/chairs/aero)')
    expect(note).toContain('Started the chat on: /')
    expect(note).toContain('2 x Aero chair (£199.00 each). Total £398.00')
    expect(note).toContain('Signed in')
    expect(note).toContain('Name given: Sam')
    expect(note).toContain('No colleague is online')
    expect(note).toContain('colleague testing you')
    expect(note).toContain('could not be reached for them earlier')
    expect(note).toContain('offer, once')
  })

  it('lists the delivery services chosen in this chat with the addresses carrying them', () => {
    const facts = {
      now, startedOn: null, currentPath: null, currentTitle: null, basket: null, basketTotal: null,
      signedIn: false, visitorName: null, visitorEmail: null, staff: false, colleaguesOnline: true, callbackWanted: false,
    }
    const note = contextNote({ ...facts, deliveryChoices: [{ label: 'Express', url: 'https://shop.test/desk?delivery-service=express' }, { label: 'Installed', url: null }] })
    expect(note).toContain('Delivery chosen in this chat')
    expect(note).toContain('Express: https://shop.test/desk?delivery-service=express')
    expect(note).not.toContain('Installed')
    expect(contextNote(facts)).not.toContain('Delivery chosen')
  })

  it('reads UK time, summer and winter', () => {
    expect(londonDateTime(new Date('2026-07-01T12:00:00Z'))).toContain('13:00')
    expect(londonDateTime(new Date('2026-12-01T12:00:00Z'))).toContain('12:00')
  })

  it('describes an empty or long basket sensibly', () => {
    expect(basketWords(null, null)).toMatch(/empty/)
    const many = Array.from({ length: 17 }, (_, i) => ({ name: `Item ${i}`, quantity: 1, unitPrice: null }))
    expect(basketWords(many, null)).toMatch(/and 2 more$/)
  })
})

describe('buildInstructions', () => {
  const settings = { ...DEFAULT_SETTINGS, assistantName: 'Charlie', businessName: 'Deskwell', extraInstructions: 'Open 9 to 5.' }

  it('is built from the settings and tools alone, so it is the same for every chat', () => {
    const a = buildInstructions(settings, TOOLS)
    const b = buildInstructions({ ...settings }, TOOLS)
    expect(a).toBe(b)
    expect(a).not.toMatch(/\d{4}-\d{2}-\d{2}/)
  })

  it('calls it a digital assistant and never an automated one', () => {
    const text = buildInstructions(settings, TOOLS)
    expect(text).toContain('You are Charlie, the digital assistant')
    expect(text).not.toMatch(/You are an automated/i)
    expect(text).toContain('Open 9 to 5.')
    expect(text).toContain('call hand_to_colleague')
  })

  it('has no em dashes anywhere', () => {
    expect(buildInstructions(settings, TOOLS)).not.toContain('\u2014')
  })
})
