<p align="center">
  <img src="module-art.webp" alt="AI Agent for Live Chat" width="640" />
</p>

# AI Agent for Live Chat module

A digital assistant that answers your site's [Live Chat](https://github.com/cactus-foundation-modules/live-chat). It goes first or only when nobody is in, hands a chat to a colleague when it should, steps back from time-wasters, and takes a name and email for anything it cannot help with. It thinks with OpenAI.

It only ever calls itself a digital assistant, never a person, and its messages carry a small "Digital assistant" badge.

## What it does

- **Answers visitors** under the name you choose (for example "Charlie"), in the language you choose, following your own extra instructions on top of its built-in rules.
- **Knows when to go first.** Three modes: Off (Live Chat exactly as it was), Staff only (it answers only a signed-in colleague's own test chats) and On. With the mode on it answers whenever nobody is online, and also while you are online if "<name> first" is switched on. That switch sits beside Live Chat's Online switch, in the admin chat window and the bubble you see on the site, so anybody who answers chats can flip it.
- **Gets out of the way.** The moment a colleague replies in a chat, the chat is theirs and the assistant stays out of it, until somebody presses "Hand back to <name>" or the Online switch goes off. "Hand to <name>" gives it any chat, whatever the switches say.
- **Fetches a colleague** when a visitor asks for a person or needs something it cannot do. The chat shows as waiting in the admin list and the bell, and the visitor's messages go to you. If nobody replies within the hand-over wait (three minutes unless you change it), it comes back, says sorry and takes a name and email for a callback. The same happens straight away if everybody goes offline.
- **Steps back from spam.** The same message three or more times, keyboard-mashing, a pile of links, messages faster than anybody could type, abuse or attempts to talk it out of its instructions: it says it is passing the chat to a colleague and asks for a name and email, up to three times, then goes quiet and leaves the chat to you. Fixed wording, so it costs nothing.
- **Answers questions about any product**: sizes, options, price, stock, specifications, delivery dates option by option, accessories and your FAQs. "Which finishes are in stock?" is answered across every variation that fits.
- **Recommends products as cards.** Each product it suggests appears in the chat as a card with its picture and price (a chosen variation's own card, so the right one goes in the basket), with "Add to basket", "Add all" for two or more, and "Choose options" for anything that needs a choice first. Nothing is added without a click.
- **Remembers the delivery they chose.** When a visitor picks a delivery service for a product (pre-assembled, installed, express), from the ones the shop offers for it, the product's card in the chat shows that service with the shop's price, the emailed note prints it under the product, a texted link and a saved quote carry it, and "Add to basket" puts the product in the basket with that service already picked. Prices and dates still come only from the shop.
- **Checks orders, carefully.** A signed-in customer can ask about the orders on their own account with nothing more to prove. Anybody else gives the delivery postcode plus the order number, the email on the order or the company name, as on the phone. Wrong answers are limited (three a chat, six an hour per visitor), it only talks about the order asked about, and it never shows an email address, a phone number or a street address.
- **Raises cancellations, returns and damage reports** on a checked order, through the shop's own rules, once it has written back what it will raise and the visitor has said yes. Photos the visitor sent in the chat go straight into a damage report; with none, the shop's confirmation email asks for them.
- **Reads pictures and PDFs** the visitor sends: a photo of the damage, a screenshot, a floor plan. Anything else is left for a colleague.
- **Explains how to pay and when the paperwork comes**, read live from the shop's Payments and Invoices tabs, including your own bank transfer wording.
- **Emails, when asked**: the order's link (only ever to the address on the order) or a short note of the chat with links to the products it mentioned, from the address you choose. The note always lists the products the chat settled on, even if the assistant forgets to say which, and greets the visitor by name in proper case ("Hi Chris,"). Saves a quote too, where the shop has the Quotes module. The wording is editable under Settings > Emails, in the Chat assistant group.
- **Texts, when asked**: a short note with the shop's own links (the products discussed, a page or article, or a proved order's page) to a UK mobile the visitor typed in the chat, gave Live Chat's contact box or has on a proved order. It uses whichever texting module the site has set up (Twilio today) through the site's own texting settings; with none, it offers email instead and never mentions texts.
- **Reads your pages, articles and reviews**, answers "can you get it to ... by Friday?" from the checkout's own delivery zones, and, once a visitor has proved an order or is signed in, recognises their earlier chats, calls and emails (never on an email address merely typed into the chat, which anybody could type).
- **Takes callbacks** and lists them on its settings screen, with a notification each time.
- **Notes what it could not answer**, so you know which FAQs and pages are worth adding, with a notification each Monday.
- **Warns about clashing instructions.** The Extra instructions box flags lines that fight the built-in rules: payment or invoice facts read live, web addresses, fixed delivery times, prices, or telling it to pass as a person or call itself an automated assistant.
- **Shows its working.** "Notes" in the chat header opens with a short written overview of the chat (what they wanted, what was checked, how it ended, any callback), then lists what the assistant did, step by step.

## Setting it up

1. Install it (it needs Live Chat, the shop and the Unified Inbox).
2. Settings > AI Agent for Live Chat > Assistant: paste an OpenAI key (or set `OPENAI_API_KEY` on the site's hosting), choose a name, and fill in your business name and any extra instructions. A site that already uses the AI Call Answering module can press **Copy from phone assistant** to bring its business name, instructions, key and sending address across in one go.
3. Set the mode to **Staff only** and try it: on the site, press the eye in the Live Chat bubble to see the chat as a visitor does, and write in. Then **On**.

## Environment

| Name | Required | What for |
| --- | --- | --- |
| `ENCRYPTION_KEY` | yes | Keeps a pasted OpenAI key encrypted. |
| `OPENAI_API_KEY` | no | The OpenAI key, instead of pasting one. Wins over a pasted key. |
| `CRON_SECRET` | no | Protects the two-minute hand-over sweep and the Monday unanswered notice. |

## Its tools

In the order the model is shown them (append new ones at the end: the order is part of the prompt cache).

| Tool | What it does |
| --- | --- |
| `hand_to_colleague` | Asks a colleague to take the chat; with nobody in, takes details instead. |
| `flag_not_genuine` | Steps back from abuse or time-wasting; the fixed lines take over. |
| `save_callback` | Saves a name, email and what it is about for a colleague to get back to. Only with the visitor's own yes (`visitor_agreed`), which must be words they typed in the chat. |
| `note_unanswered` | Notes a question it could not answer. |
| `search_products` | Searches the products; each comes back with its page address. Words match names, categories, blurbs and each product's variation labels and attribute values (a colour), and a matching variation comes back with its own price, stock and address. Leaves out what cannot be bought unless `in_stock_only` is false; `sort: cheapest`; `category`; `link` (a pasted category page: its category, filters and sort). |
| `find_by_sku` | Finds a product or one variation from its code. |
| `get_product` | One product in full: options, the exact variation and its address, quantity totals, delivery by option, FAQs, accessories. |
| `list_categories` | The shop's top-level categories. |
| `get_faqs` | The shop's own written answers, shop-wide, by category or collection. |
| `get_payment_info` | Payment methods, card brands, bank transfer wording, VAT invoice and pro-forma rules, read live. |
| `lookup_order` | Checks an order: a signed-in member's own by number, anybody else's by postcode plus one other detail. Remembers it for the chat. |
| `list_my_orders` | A signed-in member's recent orders, summary only. |
| `email_order_link` | Emails a checked order's page to the address on that order. |
| `email_summary` | Emails a short note of the chat, with product and page links. |
| `get_visitor_history` | Earlier chats, calls and inbox threads matched on a checked order's email or the signed-in account, and open requests on checked orders. |
| `search_pages` | Passages from the shop's published pages. |
| `check_delivery_postcode` | Whether the shop delivers there, and the dates for a product. |
| `get_reviews` | Published reviews: count, average and a few quotes. |
| `search_guides` | Passages from the shop's articles. |
| `raise_order_request` | Raises a cancellation, return or issue report on a checked order, with the chat's photos. |
| `save_quote` | Saves the chosen products as a quote the shop emails (only with the Quotes module). |
| `send_text` | Texts a short note with the shop's own links, or a proved order's page, to the visitor's UK mobile (only with a texting module set up). |
| `choose_delivery` | Records the delivery service the visitor chose for a product looked up in the chat, only one the shop offers for it, and hands back the product's address carrying it. |

### How order checks work

- `lookup_order` first tries the signed-in member's own account (`shp_orders.member_id`, recorded on the chat when the message was offered). A match there needs no postcode, and only orders on that account can match.
- Otherwise it needs the delivery postcode plus the order number, the email on the order or the company name (`lib/shop/order-verify.ts`, the phone assistant's rule, forgiving a typo).
- A miss counts once on the chat (`aichat_conversations.failed_order_checks`) and once for the visitor (`aichat_rate_events`, keyed `visitor:<Live Chat visitor id>`, or `chat:<id>` when the chat has none). Three a chat or six an hour and it stops.
- Proved orders are kept on the chat (`verified_orders`); every other order tool only touches those.
- Order rows are read without email, phone or street address, and the free text on an order is scrubbed of anything that looks like one, so the model never has one to repeat. An email goes to an address picked on the server (the order's own, or one the visitor typed in the chat), never one the model writes.
- Emails are capped at three a chat and six an hour per visitor, and every send, request and quote needs the visitor's own yes (`visitor_agreed`).
- Texts follow the email rule for where they go: a number the visitor typed in this chat, the one they gave Live Chat's contact box, or the mobile on a proved order (an order's page only ever to the mobile on that order). UK mobiles only, written as +447...; a landline is refused and the model offers email. They are capped at three a chat and six an hour per visitor (`aichat_conversations.texts_sent`, `aichat_rate_events` kind `text`), need the visitor's yes, and the number is never handed back to the model or logged.

### Products a chat was about

`get_product` (when one variation matches exactly, that variation; otherwise the product) and `find_by_sku` (its one hit) remember what they found on the chat, newest last, ten at most (`aichat_conversations.discussed_products`, `lib/discussed-products.ts`), with the product's name. After each reply, every product address the reply shows is matched against what the tools returned that turn and the record (`markLinked`): those entries are marked `linked` and added if missing, so a search result the assistant showed counts. `email_summary` lists the products the model passes, swapping a listing for the variation the chat settled on, and when it passes none (or none the shop can show) it lists the remembered ones the assistant showed (all of them if it showed none), newest first. `send_text` links only remembered products, whose page addresses the tools built, each under its name, and signs off with the site's address (`textSignOff`).

### Finding products and options

- `search_products` ranks against an in-memory index of every visible product (`loadSearchIndex`, ten minutes, like the vocabulary): name 4, variation labels and attribute values 3, category 2, blurb and description 1 (`lib/shop/search-rank.ts`). Every word must be found; failing that, the products with the most words, if at least half. For `sort: cheapest` only products whose meaningful words (not ones in more than half the catalogue) land in the name, variations or category are priced. The words a listing's variations carry pick out the cheapest buyable fitting variation (`lib/shop/search-variations.ts`). Prices and stock are read fresh.
- `get_product` takes an id, a slug or a pasted product link (`lib/shop/shop-link.ts`, options read from its parameters). Options are matched by `lib/shop/variation-match.ts`: "no/not/w/o" fold to "without", words no variation carries are set aside and reported, a colour next to an option's name binds to it, a word said twice needs two options, and when nothing fits the nearest come back as `closest` with what they lack. Copied to the phone assistant.
- Only what the visitor chose (`lib/shop/partial-choice.ts`): where several variations fit, only the options they all share are chosen. `get_product` returns `chosenOptions` (an address with just those picked, the labels, "from" price and the Unified Inbox `picks` string) and a search hit's `variation` is marked `exact: false` with the listing's id. The record keeps `picks` on the listing's entry (a new partial choice replaces an earlier full one), `email_summary` hands the inbox `ProductRef.picks`, and a text links the partial address. Live Chat draws it as a "Choose options" card.
- Emails greet by a name only if the visitor typed it (an email address does not count) or gave it to the contact box (`greetingName`); quotes too.
- Spam's "same message" sign needs three in a row inside a minute (`REPEAT_SPAN_MS`). When the contact box already holds an email, the not-genuine flow saves the callback with it instead of asking (`notGenuineOnFlag`), and the fallback line does not ask for details either.

### Delivery choices travel with the product

`choose_delivery` matches the visitor's words (the service's name as `get_product` gave it, or its key) against the services the shop publishes for that exact product or variation at `shop.product-delivery-timing` (`lib/shop/delivery-choice.ts`, copied from the phone assistant). Anything else is refused with what is on offer, and a product the chat has not looked up is refused too. The choice is kept on the product's entry in `discussed_products` (`delivery: { key, label }`, no new column; older rows simply have none), and a new choice replaces the old one. From then on:

- every address the product tools hand back for it carries `delivery-service=<key>`, and so does the end-of-turn note, so the card Live Chat draws shows the service with the shop's price (Live Chat checks it is still offered);
- `email_summary` passes the key on each product to the unified inbox, which prints the service under the product with today's price and leaves it off if it is no longer offered; the product's link carries it too;
- `send_text` links carry it;
- `save_quote` writes it into the line's meta under the field the shop's own basket picker uses (asked through shop's cart-line resolution), so the quote and checkout open with it chosen;
- "Add to basket" and "Add all" under the card add it with the service picked. Live Chat (0.1.29 onwards) hands the card's buttons `delivery: { key, label, price }` once it has checked the shop still offers the service; on the click the button asks `GET /api/m/ai-agent-for-live-chat/public/basket-line?product=<id>&service=<key>` once (`app/api/public/basket-line/route.ts`, `lib/basket-line.ts`), which answers the line meta through the same cart-line resolution `save_quote` uses, or `{ meta: null }` where the service is not offered. The route is public, `no-store`, and returns nothing per-visitor: it is the menu the shop's own basket shows anyone. The button then calls the shop's `addToCart(id, 1, { meta })` (`lib/basket-add.ts`). With no key (an older Live Chat sends none), a `null` meta or any failure or slow answer, the product goes in without the service, never not at all.

### Photos in a damage report

The visitor's JPEG, PNG and WebP pictures from the chat (six at most) are put through the shop's own photo upload (`receiveIssuePhoto`, filed under Orders / <number> / issues) and named on the report (`resolveIssuePhotos`), as the customer's own report form does. If none were sent, or the site's media storage cannot take them, the report asks for photos in its confirmation email instead.

## For developers

- Answers chats through Live Chat's `chat.responder` point (`lib/responder.ts`, server only), and draws its controls in Live Chat's `chat.admin-toolbar`, `chat.conversation-actions` and `chat.product-actions` slots (`components/chat/`).
- Who answers is decided in `lib/routing.ts`, pure and fully tested. Each chat's state (`auto`, `assistant`, `colleague`, `waiting`, `not_genuine`, `quiet`) lives in `aichat_conversations`.
- Turns run one at a time per chat (`lib/turn-runner.ts`), after a short wait so three quick lines get one reply, through the OpenAI Responses API with the tools in `lib/tools/`. To add a tool, write it with `defineTool` and append it to `lib/tools/index.ts`.
- The instructions are built from settings alone (`lib/prompt.ts`) so OpenAI can serve them from its prompt cache; the visitor's page, basket, proved orders and the time go at the end of each turn's input (`lib/model-input.ts`). The newest four pictures or PDFs the visitor sent go into their own messages as `input_image` / `input_file` parts (`lib/attachments.ts`).
- The shop queries in `lib/shop/` are copied from the phone assistant and kept in step by hand; nothing imports the other module. Product page addresses are built in `lib/shop/product-links.ts`.
- The Notes overview is written on demand (`admin/conversation/overview`, one call with no tools) and stored with the newest message it covered (`overview_message_id`), so it is reused until the chat moves on.
- Texts go through core's SMS provider (`getActiveSmsProvider` in `lib/auth/sms`), so this module has no texting dependency of its own. Whether texting is set up is checked at the start of each turn and told to the model in the end-of-turn note, so the instructions stay settings-only for the prompt cache.
- Raw SQL is run against a real Postgres by `lib/sql.live.test.ts` (`RUN_LEDGER_GUARDS=1`).

## Licence

MIT
