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

/** The first time a chat is flagged: calm, and an open door. */
export function notGenuineFirstLine(businessName: string): string {
  const shop = businessName.trim()
  return `I'm here to help with ${shop ? `${shop}'s` : 'our'} products, orders and deliveries. If there's anything like that I can do for you, just ask.`
}

/** The second time: the assistant leaves the chat there. */
export function notGenuineLastLine(): string {
  return "I'll leave the chat there for now."
}
