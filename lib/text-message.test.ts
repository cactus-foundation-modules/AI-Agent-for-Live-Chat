import { describe, expect, it } from 'vitest'
import { MAX_TEXT_CHARS, cleanNote, composeText, mobilesTyped, pickTextRecipient, textSignOff, ukMobile, visitorWroteNumber } from './text-message'

// Which number a text may go to, and what it may say.

describe('ukMobile', () => {
  it('reads a UK mobile however it was written, as +447...', () => {
    for (const written of ['07700 900123', '07700900123', '+447700900123', '+44 (0)7700-900123', '0044 7700 900123', '447700900123']) {
      expect(ukMobile(written)).toEqual({ ok: true, to: '+447700900123' })
    }
  })

  it('refuses a landline, a number from abroad, and anything unusable', () => {
    expect(ukMobile('0113 249 6000')).toEqual({ ok: false, reason: 'landline' })
    expect(ukMobile('+44 20 7946 0000')).toEqual({ ok: false, reason: 'landline' })
    expect(ukMobile('+33 6 12 34 56 78')).toEqual({ ok: false, reason: 'abroad' })
    expect(ukMobile('0700 123 4567')).toEqual({ ok: false, reason: 'unusable' })
    expect(ukMobile('07700 9001')).toEqual({ ok: false, reason: 'unusable' })
    expect(ukMobile('call me')).toEqual({ ok: false, reason: 'unusable' })
  })
})

describe('what the visitor typed', () => {
  it('finds the mobiles in the chat, however spaced', () => {
    expect(mobilesTyped('my mobile is 07700 900123, or +44 7700 900456. Order DW000101')).toEqual(['+447700900123', '+447700900456'])
  })

  it('matches a number only if the visitor wrote it', () => {
    expect(visitorWroteNumber('text me on 07700 900123', '+447700900123')).toBe(true)
    expect(visitorWroteNumber('text me on 07700 900123', '07700900999')).toBe(false)
    expect(visitorWroteNumber('ring 0113 249 6000', '+441132496000')).toBe(true)
    expect(visitorWroteNumber('', '07700900123')).toBe(false)
  })
})

describe('pickTextRecipient', () => {
  const base = { given: null, orderNumber: null, orderOnly: false, verified: [] as string[], orderPhones: [], visitorText: '', contactPhone: null }

  it('sends to a mobile the visitor typed in the chat', () => {
    expect(pickTextRecipient({ ...base, given: '07700 900123', visitorText: 'it is 07700900123' }))
      .toEqual({ kind: 'send', to: '+447700900123', source: 'typed' })
  })

  it('sends to the number they gave the contact box', () => {
    expect(pickTextRecipient({ ...base, contactPhone: '07700 900123' })).toEqual({ kind: 'send', to: '+447700900123', source: 'chat' })
    expect(pickTextRecipient({ ...base, given: '+447700900123', contactPhone: '07700 900123' })).toMatchObject({ kind: 'send', source: 'chat' })
  })

  it('sends to the mobile on a proved order, skipping a landline on it', () => {
    const orderPhones = [{ orderNumber: 'DW1', phones: ['0113 249 6000', '07700 900777'] }]
    expect(pickTextRecipient({ ...base, verified: ['DW1'], orderPhones })).toEqual({ kind: 'send', to: '+447700900777', source: 'order' })
    expect(pickTextRecipient({ ...base, verified: ['DW1'], orderPhones, orderNumber: 'DW1' })).toMatchObject({ kind: 'send', source: 'order' })
  })

  it('refuses a number the model made up, without repeating it', () => {
    const out = pickTextRecipient({ ...base, given: '07700 900999', visitorText: 'my number is 07700 900123' })
    expect(out.kind).toBe('refuse')
    if (out.kind === 'refuse') expect(out.message).not.toMatch(/\d{4}/)
  })

  it('refuses a landline the visitor typed, and tells the model to offer email', () => {
    const out = pickTextRecipient({ ...base, given: '0113 249 6000', visitorText: 'ring 0113 249 6000' })
    expect(out).toMatchObject({ kind: 'refuse' })
    if (out.kind === 'refuse') expect(out.message).toMatch(/landline.*email/i)
    expect(pickTextRecipient({ ...base, contactPhone: '0113 249 6000' })).toMatchObject({ kind: 'refuse' })
  })

  it('never uses an order that was not proved, and asks when proved orders disagree', () => {
    const orderPhones = [{ orderNumber: 'DW1', phones: ['07700 900111'] }, { orderNumber: 'DW2', phones: ['07700 900222'] }]
    expect(pickTextRecipient({ ...base, verified: ['DW1'], orderPhones, orderNumber: 'DW2' }).kind).toBe('refuse')
    expect(pickTextRecipient({ ...base, verified: ['DW1'], orderPhones })).toMatchObject({ kind: 'send', to: '+447700900111' })
    const several = pickTextRecipient({ ...base, verified: ['DW1', 'DW2'], orderPhones })
    expect(several.kind).toBe('refuse')
    if (several.kind === 'refuse') expect(several.message).not.toMatch(/0770/)
  })

  it('sends an order link only to the mobile on that order, whatever was typed', () => {
    const orderPhones = [{ orderNumber: 'DW1', phones: ['07700 900777'] }]
    expect(pickTextRecipient({ ...base, orderOnly: true, orderNumber: 'DW1', verified: ['DW1'], orderPhones, given: '07700 900123', visitorText: '07700 900123' }))
      .toEqual({ kind: 'send', to: '+447700900777', source: 'order' })
    expect(pickTextRecipient({ ...base, orderOnly: true, orderNumber: 'DW1', verified: ['DW1'], orderPhones: [{ orderNumber: 'DW1', phones: ['0113 249 6000'] }] }).kind).toBe('refuse')
  })

  it('asks for a number when there is nothing to go on', () => {
    expect(pickTextRecipient(base).kind).toBe('refuse')
  })
})

describe('what a text says', () => {
  it('takes personal details and stray addresses out of the note', () => {
    expect(cleanNote('Call 07700 900123 or email jo@example.com, see https://evil.test/x and www.evil.test. Thanks!'))
      .toBe('Call or email, see and. Thanks!')
  })

  it('keeps every link whole and stays inside the limit', () => {
    const links = [
      { label: 'Air Lite Desk', url: 'https://shop.test/shop/products/air-lite-desk?frame-colour=black' },
      { label: 'Delivery', url: 'https://shop.test/pages/delivery' },
    ]
    const body = composeText('word '.repeat(200), links, 'Deskwell.co.uk')
    expect(body.length).toBeLessThanOrEqual(MAX_TEXT_CHARS)
    for (const link of links) expect(body).toContain(`${link.label}\n${link.url}`)
    expect(body.endsWith('Deskwell.co.uk')).toBe(true)
    expect(body).toContain('…')
  })

  it('puts each product\'s name above its link, a blank line between them (the live-site "garbled mess")', () => {
    expect(composeText('Here are the products we talked about.', [
      { label: 'Oslo Air Standing Desk', url: 'https://shop.test/oslo-air?width=120cm' },
      { label: 'Crew 2 Chair', url: 'https://shop.test/crew-2' },
      { label: null, url: 'https://shop.test/qube' },
    ], 'Deskwell.co.uk')).toBe(
      'Here are the products we talked about.\n\nOslo Air Standing Desk\nhttps://shop.test/oslo-air?width=120cm\n\nCrew 2 Chair\nhttps://shop.test/crew-2\n\nhttps://shop.test/qube\n\nDeskwell.co.uk',
    )
  })

  it('drops the names, never an address, when the links alone nearly fill it', () => {
    const long = (n: number) => ({ label: `Product number ${n} with a long name`, url: `https://shop.test/${'x'.repeat(170)}${n}` })
    const body = composeText('Hello', [long(1), long(2), long(3)], 'Deskwell.co.uk')
    expect(body.length).toBeLessThanOrEqual(MAX_TEXT_CHARS)
    expect(body).not.toContain('Product number')
    for (const n of [1, 2, 3]) expect(body).toContain(`${'x'.repeat(170)}${n}`)
  })

  it('leaves a short note as it is', () => {
    expect(composeText('Here are the desks.', [{ label: null, url: 'https://shop.test/a' }], 'Deskwell')).toBe('Here are the desks.\n\nhttps://shop.test/a\n\nDeskwell')
  })
})

describe('textSignOff', () => {
  it('signs off with the site address, in the business\'s own capitals', () => {
    expect(textSignOff('Deskwell', 'https://deskwell.co.uk')).toBe('Deskwell.co.uk')
    expect(textSignOff('Deskwell', 'https://www.deskwell.co.uk/')).toBe('Deskwell.co.uk')
    expect(textSignOff('Tiller Well', 'https://tillerwell.com')).toBe('TillerWell.com')
    expect(textSignOff('Acme Ltd', 'https://shop.example')).toBe('shop.example')
  })

  it('falls back to the name with no usable address', () => {
    expect(textSignOff('Deskwell', null)).toBe('Deskwell')
    expect(textSignOff('Deskwell', 'http://localhost:3000')).toBe('Deskwell')
    expect(textSignOff('Deskwell', 'nonsense')).toBe('Deskwell')
  })
})
