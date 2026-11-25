// The fixed things the assistant says, written once here so they cost nothing
// to send and read the same every time. British English, plain, and never
// claiming to be a person.

/** The model could not be reached, or gave nothing usable. A colleague has
 *  been asked for. */
export function cannotAnswerLine(online: boolean, haveEmail = false): string {
  if (online) return 'Sorry, I cannot answer that just now - I have asked a colleague to pick this up.'
  return haveEmail
    ? 'Sorry, I cannot answer that just now. A colleague will get back to you by email as soon as they can.'
    : 'Sorry, I cannot answer that just now. If you leave your name and email address, a colleague will get back to you as soon as they can.'
}

/** A hand-over ran out with nobody picking it up, or every colleague went
 *  offline while the visitor was waiting. */
export function comeBackLine(reason: 'timeout' | 'offline'): string {
  return reason === 'timeout'
    ? 'Sorry for the wait - nobody has been able to pick this up just yet. If you leave your name and email address, a colleague will get back to you as soon as they can.'
    : 'Sorry - my colleagues have had to step away. If you leave your name and email address, one of them will get back to you as soon as they can.'
}

// --- the not-genuine flow (lib/not-genuine.ts) ------------------------------

/** The first thing said once a chat is flagged. */
export const NOT_GENUINE_FIRST =
  'I am going to pass this chat to a colleague. So they can get back to you, please reply with your name and email address.'

/** Asking again, when the reply carried no email address. */
export const NOT_GENUINE_AGAIN = [
  'Sorry, I did not catch an email address there. Please reply with your name and email address and a colleague will be in touch.',
  'A colleague can only get back to you with an email address. Please reply with your name and email address.',
] as const

export function notGenuineAskLine(askNumber: number): string {
  if (askNumber <= 1) return NOT_GENUINE_FIRST
  return NOT_GENUINE_AGAIN[Math.min(askNumber - 2, NOT_GENUINE_AGAIN.length - 1)] ?? NOT_GENUINE_FIRST
}

export function notGenuineThanksLine(name: string | null): string {
  return `Thank you${name ? `, ${name}` : ''}. I have passed this to a colleague, who will be in touch by email.`
}
