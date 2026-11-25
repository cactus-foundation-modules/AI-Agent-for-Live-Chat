import { emailsUsedUp, countEmail } from './emails'
import { isPlausibleEmail, visitorWroteEmail } from './contact-text'
import { titleCaseName } from './name-case'
import { quotesAvailable, saveQuote } from './shop/quote-saver'
import type { ToolContext, ToolResult } from './tools/registry'

// ---------------------------------------------------------------------------
// save_quote: the products the visitor settled on, saved as a quote in their
// name, which the shop emails them with a link that opens the basket.
//
// Optional, like the phone assistant's: it goes through whatever module
// publishes `shop.basket-quote-saver` (quote-for-shop), found at run time and
// never imported (lib/shop/quote-saver.ts). Without one the tool says so and
// the model offers a note of the chat instead.
//
// The phone built a basket first and quoted that; a chat has product cards and
// Add to basket instead, so the lines come straight from the model's call:
// exact variation ids from get_product, and quantities. The quote module prices
// them itself, so nothing the model writes sets a price.
//
// It is an email to the visitor, so it needs their yes, goes only to an
// address they typed in the chat (or gave Live Chat's form, or their
// account's), and counts against the same limits as every other email.
// ---------------------------------------------------------------------------

export const MAX_QUOTE_LINES = 100

export type QuoteLine = { productId: string; quantity: number }

export async function saveChatQuote(ctx: ToolContext, input: { name: string | null; email: string | null; lines: QuoteLine[] }): Promise<ToolResult> {
  if (!(await quotesAvailable())) {
    return { ok: false, message: 'This shop does not save quotes. Offer a note of the chat by email instead (email_summary), with the products in product_ids.' }
  }
  if (input.lines.length === 0) return { ok: false, message: 'There is nothing to quote. Pass every product they want, each with its exact variation id and quantity.' }
  if (await emailsUsedUp(ctx)) return { ok: false, message: 'Enough emails have been sent from this chat to send a quote as well. Offer a callback instead.' }

  const name = titleCaseName((input.name ?? '').trim() || ctx.visitorName?.trim() || '')
  if (!name) return { ok: false, message: 'The quote needs their name. Ask for it and try again.' }

  const given = (input.email ?? '').trim().toLowerCase()
  const known = [ctx.visitorEmail, ctx.member?.email].filter((e): e is string => !!e).map((e) => e.trim().toLowerCase())
  const email = given || known[0] || ''
  if (!email || !isPlausibleEmail(email)) return { ok: false, message: 'The quote needs an email address. Ask them to type the address they want it sent to.' }
  if (given && !visitorWroteEmail(ctx.visitorText, given) && !known.includes(given)) {
    return { ok: false, message: 'A quote can only go to an email address the visitor has typed in this chat themselves. Ask them to type it.' }
  }

  let saved
  try {
    saved = await saveQuote({
      lines: input.lines.slice(0, MAX_QUOTE_LINES).map((line) => ({ productId: line.productId, quantity: line.quantity })),
      customerName: name,
      customerEmail: email,
      customerPhone: '',
      staffNotes: 'Saved by the chat assistant in a live chat.',
    })
  } catch {
    return { ok: false, message: 'The quote could not be saved just now. Offer a note of the chat by email instead.' }
  }
  if (!saved) return { ok: false, message: 'This shop does not save quotes. Offer a note of the chat by email instead (email_summary).' }
  if (!saved.ok) return { ok: false, message: `The quote could not be saved: ${saved.message} Offer a note of the chat by email instead.` }

  if (saved.emailedCustomer) await countEmail(ctx)
  const dropped = saved.unavailable.length > 0
    ? `${saved.unavailable.length} item(s) could not be quoted and were left off (${saved.unavailable.map((line) => line.name).join(', ')}): tell them which.`
    : ''
  return {
    ok: true,
    quoteNumber: saved.quote.quoteNumber,
    emailed: saved.emailedCustomer,
    message: [
      saved.emailedCustomer
        ? `Saved as quote ${saved.quote.quoteNumber}, and the shop has emailed it to them with a link that opens the basket. Tell them the quote number and to check their junk folder if it does not arrive. Never write the address out.`
        : `Saved as quote ${saved.quote.quoteNumber}, but the shop does not email quotes, so it has NOT been sent. Tell them the quote number and offer a note of the chat by email instead.`,
      dropped,
      'Do not email the quote or its items again by any other means.',
    ].filter(Boolean).join(' '),
  }
}
