import { describe, expect, it } from 'vitest'
import { stripGuessedName } from './reply-names'

describe('stripGuessedName (the real customer called "Mike" from his email)', () => {
  const typed = 'yes please\nmikegreely28@example.com'

  it('takes out a name found only inside their email address', () => {
    expect(stripGuessedName("Thanks, Mike. I've saved your question.", typed, null)).toBe("Thanks. I've saved your question.")
    expect(stripGuessedName('Hi Mike, here it is.', typed, null)).toBe('Hi, here it is.')
    expect(stripGuessedName("That's saved, Mike.", typed, null)).toBe("That's saved.")
  })

  it('keeps a name they typed or gave the contact box', () => {
    expect(stripGuessedName('Thanks, Mike.', `I'm Mike\n${typed}`, null)).toBe('Thanks, Mike.')
    expect(stripGuessedName('Thanks, Mike.', typed, 'Mike Greely')).toBe('Thanks, Mike.')
  })

  it('leaves replies alone when no email was typed, or the word is not a name from it', () => {
    expect(stripGuessedName('Thanks, Mike.', 'hello', null)).toBe('Thanks, Mike.')
    expect(stripGuessedName('Thanks, Sarah will reply.', typed, null)).toBe('Thanks, Sarah will reply.')
  })
})
