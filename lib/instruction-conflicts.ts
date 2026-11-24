// Lines in the owner's extra instructions that work against the built-in ones.
//
// Copied from the phone assistant (modules/ai-call-answering/lib/instruction-
// conflicts.ts) and kept in step by hand, with the rules adapted to a chat.
//
// The extra instructions are appended after the module's own rules, and a model
// given two rules that disagree follows whichever it noticed last - usually the
// owner's. Most of the damage is facts typed in once that the tools already read
// live: a "no invoicing" line written before bank transfer was switched on
// stopped the phone assistant giving the bank details. This spots the common
// kinds so the settings screen can say so while the text is being written.
//
// Pure and dependency-free: the settings screen runs it as the owner types.

export type InstructionConflict = {
  /** The sentence that triggered it, as written. */
  quote: string
  /** Why it is a problem and what to do instead, in plain words. */
  advice: string
}

type Rule = {
  test: RegExp
  /** The sentence must also match this, to be about the right subject. */
  about?: RegExp
  /** ...and must not match this. */
  notAbout?: RegExp
  /** Skip a sentence that says not to do the thing, e.g. "never say next-day". */
  skipWhenNegated?: boolean
  advice: string
}

const NEGATION = /\b(never|not|don'?t|do not|no)\b/i

const RULES: Rule[] = [
  {
    test: /\b(invoic\w*|bank transfer|bank details|pro-?formas?|card payments?|pay(ing)? by|credit terms?|on credit|no credit|payment methods?)\b/i,
    advice:
      "Payment methods, bank details, VAT invoices and pro-formas are read live from the shop's Payments and Invoices tabs every time somebody asks. A line about them here goes stale when those tabs change, and can stop the assistant giving the bank details. Leave payments out of these instructions.",
  },
  {
    test: /\b[a-z0-9-]+(\.[a-z0-9-]+)*\.(co\.uk|org\.uk|com|uk|net|org|io|shop)\/\S*/i,
    advice:
      "A web address typed here goes stale when the page moves, and the assistant may hand it out where it does not fit. It already finds the shop's own pages, articles and products itself and gives their current addresses, and emails an order's link only to the address on that order.",
  },
  {
    test: /\b(next[- ]day|same[- ]day|within \d+\s*(working\s*)?days|\d+\s*(-|to)\s*\d+\s*(working\s*)?days|\d+\s*working days)\b/i,
    about: /\b(deliver\w*|arriv\w*|ship\w*|lead times?)\b/i,
    notAbout: /\b(return\w*|cancel\w*|report\w*)\b/i,
    skipWhenNegated: true,
    advice:
      'A fixed delivery time here overrides the dates the assistant reads for each product and option from the shop. Leave delivery times to those.',
  },
  {
    // A price stated as a fact, not one given as an example of how to say one.
    test: /\b(costs?|is|are|from|priced at|only|just)\s+£\s?\d/i,
    skipWhenNegated: true,
    advice: 'A price written here goes stale when the shop changes. The assistant reads every price live, option by option.',
  },
  {
    test: /\b(you are|you're|say you are|say you're|pretend( to be)?|act as|introduce yourself as|call yourself)\b[^.\n]{0,30}\b(real |human |actual )?(person|human|member of (the )?staff|employee|colleague)\b/i,
    skipWhenNegated: true,
    advice:
      'Visitors must never be told, or led to believe, that they are chatting with a person. The built-in rules have the assistant say plainly that it is a digital assistant when asked. A name and a friendly manner are fine.',
  },
  {
    // The owner's chosen wording: "digital assistant", never "automated".
    test: /\b(automated|automatic|ai|robot|bot|chat ?bot|virtual)\s+(assistant|agent|helper|bot)\b|\b(you are|you're|say you are|call yourself)\s+an?\s+(bot|chat ?bot|robot|ai)\b/i,
    skipWhenNegated: true,
    advice:
      'The assistant always calls itself a digital assistant, and its messages carry a "Digital assistant" badge. A line telling it to call itself an automated assistant, a bot or an AI fights that. Leave how it describes itself to the built-in rules.',
  },
  {
    // "Returns are raised on the order page": it sends every visitor off to do
    // it alone, when the assistant can raise it for them.
    test: /\b(order page|account page|on the website|online|themselves|not (in|by|over) (the )?chat)\b/i,
    about: /\b(return\w*|cancel\w*|damage\w*|report\w*|faulty|missing|shortages?)\b/i,
    // "Never send them to their order page to do it" says the opposite.
    notAbout: /\b(never|don'?t|do not)\s+(send|ask|tell|direct|point)\b/i,
    advice:
      'The assistant raises cancellations, returns and issue reports for the visitor once their order is checked, with any photographs they sent in the chat. A line sending visitors to do it themselves stops it. Say instead what your rules are (the returns window, how long they have to report damage) and leave the raising to the assistant.',
  },
]

function sentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+|\n+/)
    .map((piece) => piece.replace(/^[-*•\s]+/, '').trim())
    .filter(Boolean)
}

export function findInstructionConflicts(text: string): InstructionConflict[] {
  const found: InstructionConflict[] = []
  const seenAdvice = new Set<string>()
  for (const sentence of sentences(text)) {
    for (const rule of RULES) {
      if (!rule.test.test(sentence)) continue
      if (rule.about && !rule.about.test(sentence)) continue
      if (rule.notAbout && rule.notAbout.test(sentence)) continue
      if (rule.skipWhenNegated && NEGATION.test(sentence)) continue
      // One warning per kind: the first sentence is enough to find the rest.
      if (seenAdvice.has(rule.advice)) continue
      seenAdvice.add(rule.advice)
      found.push({ quote: sentence.length > 160 ? `${sentence.slice(0, 159)}…` : sentence, advice: rule.advice })
    }
  }
  return found
}
