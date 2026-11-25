import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { Client } from 'pg'
import {
  connectionUri,
  createTestDatabase,
  createTestRole,
  dropStaleTestObjects,
  dropTestDatabase,
  dropTestRole,
  testServerFromEnv,
  type TestRole,
  type TestServer,
} from '@/lib/backup/test-database'

// This module's raw SQL, ACTUALLY EXECUTED by Postgres.
//
// Nothing else runs it. `tsc` and `eslint` see template strings, `npm test`
// never opens a connection, and the module build gate builds without executing
// a query - so a statement Postgres will not parse passes every gate there is
// and fails for the first time on a live site.
//
// Covers every statement this module writes: the settings row (and the
// encrypted key), the chat state row through every move (offer, take, claim,
// release, hand-over, the switch going off, the sweep), usage and the tool log,
// callbacks, unanswered questions and the weekly notice, the copy from the
// phone assistant, the proved orders, failed checks, emails, texts, products
// discussed and overview of a chat, and the hourly limits; and 002 brought onto
// an install made before it, twice over. And every query the tools read the shop with:
// products (with their page addresses, variations and accessories), orders (a
// member's own, the postcode check, the contact an email goes to, the phones a
// text may go to), pages, FAQs,
// payment methods, delivery to a postcode, and earlier contact. Core, the shop,
// shop-variations and product-addons are migrated in first so those run against
// the real tables.
//
// Gated like the other live suites: it needs the OVH server, makes cactus_rt_*
// databases and drops them afterwards.
//
//   RUN_LEDGER_GUARDS=1 npx vitest run modules/ai-agent-for-live-chat/lib/sql.live.test.ts
//
// A SKIP IS A FAIL for a release that touches this module's SQL.
const ENABLED = process.env.RUN_LEDGER_GUARDS === '1'
if (ENABLED) {
  try {
    ;(process as unknown as { loadEnvFile: (path: string) => void }).loadEnvFile('.env')
  } catch {
    // No .env - testServerFromEnv below fails the suite loudly rather than here.
  }
}
const suite = ENABLED ? describe : describe.skip

// The bell and the Unified Inbox are other people's tables, not here.
vi.mock('@/lib/notifications/alerts', () => ({ upsertAlert: vi.fn(async () => undefined) }))
const senders = vi.hoisted(() => ({
  getModuleMailSettings: vi.fn(async () => ({ inboxId: 'inbox-1', copyInboxId: null })),
  setModuleSender: vi.fn(async () => undefined),
  setModuleCopyInbox: vi.fn(async () => undefined),
}))
vi.mock('@/modules/unified-inbox/lib/module-senders', () => senders)
// The shop asks every installed payment module whether it is ready, and each
// reads its own settings table. Those modules' tables are not in this
// throwaway database (on a real site an installed module's always are), so
// only the shop's own methods are offered here. The SQL under test is ours and
// the shop's payment settings, not the payment modules'.
vi.mock('@/modules/shop/lib/payments/registry', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/modules/shop/lib/payments/registry')>()
  const builtIn = new Set(['STRIPE', 'PAYPAL', 'BANK_TRANSFER', 'CASH'])
  return { ...actual, getAllPaymentProviders: () => actual.getAllPaymentProviders().filter((provider) => builtIn.has(provider.id)) }
})

function migrationFiles(module: string): string[] {
  const directory = join(__dirname, '..', '..', module, 'migrations')
  return readdirSync(directory).filter((name) => name.endsWith('.sql')).sort().map((name) => join(directory, name))
}

suite('ai-agent-for-live-chat SQL, against a real Postgres', () => {
  let server: TestServer
  let role: TestRole
  let client: Client
  const databaseName = `cactus_rt_aichat_${process.pid}`
  const roleName = `cactus_rt_role_aichat_${process.pid}`

  let settings: typeof import('./settings')
  let conversations: typeof import('./conversations')
  let callbacks: typeof import('./callbacks')
  let unanswered: typeof import('./unanswered')
  let copy: typeof import('./copy-from-phone')
  let orderState: typeof import('./order-state')
  let orderQueries: typeof import('./shop/order-queries')
  let products: typeof import('./shop/product-queries')
  let history: typeof import('./visitor-history')
  let siteContent: typeof import('./shop/site-content')
  let faqs: typeof import('./shop/faq-queries')
  let payments: typeof import('./shop/payment-queries')
  let postcodes: typeof import('./shop/postcode-delivery')

  async function chat(id: string): Promise<void> {
    await client.query(`INSERT INTO "chat_conversations" ("id", "visitor_token_hash") VALUES ($1, $2)`, [id, 'x'.repeat(64)])
  }

  beforeAll(async () => {
    server = testServerFromEnv()
    await dropStaleTestObjects(server)
    role = await createTestRole(server, roleName)
    await createTestDatabase(server, databaseName, role)

    const uri = connectionUri(server, databaseName, role)
    client = new Client({ connectionString: `${uri}&uselibpqcompat=true` })
    await client.connect()

    // Core and the shop (and the two modules the product tools read when they
    // are there), so the tools' shop queries meet the real tables; then Live
    // Chat's (ours points at chat_conversations); then ours twice over, so 001
    // is proven idempotent on top of itself.
    await client.query(readFileSync(join(__dirname, '..', '..', '..', 'prisma', 'migrations', '20260626000000_init', 'migration.sql'), 'utf8'))
    for (const name of ['shop', 'shop-variations', 'product-addons-for-shop']) {
      for (const file of migrationFiles(name)) await client.query(readFileSync(file, 'utf8'))
    }
    for (const file of migrationFiles('chat')) await client.query(readFileSync(file, 'utf8'))
    for (const pass of [1, 2]) {
      for (const file of migrationFiles('ai-agent-for-live-chat')) {
        await client.query(readFileSync(file, 'utf8')).catch((err: unknown) => {
          throw new Error(`${file} (pass ${pass}): ${String(err)}`)
        })
      }
    }

    process.env.DATABASE_URL = uri
    process.env.SITE_URL = 'https://shop.test'
    process.env.ENCRYPTION_KEY = 'ab'.repeat(32)
    delete process.env.OPENAI_API_KEY
    settings = await import('./settings')
    conversations = await import('./conversations')
    callbacks = await import('./callbacks')
    unanswered = await import('./unanswered')
    copy = await import('./copy-from-phone')
    orderState = await import('./order-state')
    orderQueries = await import('./shop/order-queries')
    products = await import('./shop/product-queries')
    history = await import('./visitor-history')
    siteContent = await import('./shop/site-content')
    faqs = await import('./shop/faq-queries')
    payments = await import('./shop/payment-queries')
    postcodes = await import('./shop/postcode-delivery')
  }, 180_000)

  afterAll(async () => {
    await import('@/lib/db/prisma').then((module) => module.prisma.$disconnect()).catch(() => undefined)
    await client?.end().catch(() => undefined)
    if (server) {
      await dropTestDatabase(server, databaseName).catch(() => undefined)
      await dropTestRole(server, roleName).catch(() => undefined)
    }
  }, 120_000)

  it('brings an install made before 002 up to date, twice over', async () => {
    // The shape a site had on 0.1.0: no texts, no products discussed, and only
    // two kinds of rate event.
    await client.query(`ALTER TABLE "aichat_conversations" DROP COLUMN "discussed_products", DROP COLUMN "texts_sent"`)
    await client.query(`ALTER TABLE "aichat_rate_events" DROP CONSTRAINT "aichat_rate_events_kind_check"`)
    await client.query(`ALTER TABLE "aichat_rate_events" ADD CONSTRAINT "aichat_rate_events_kind_check" CHECK ("kind" IN ('failed_check', 'email'))`)
    const upgrade = readFileSync(join(__dirname, '..', 'migrations', '002_products_and_texts.sql'), 'utf8')
    await client.query(upgrade)
    await client.query(upgrade)
    const columns = await client.query<{ column_name: string }>(
      `SELECT "column_name" FROM information_schema.columns WHERE "table_name" = 'aichat_conversations' AND "column_name" IN ('discussed_products', 'texts_sent') ORDER BY 1`,
    )
    expect(columns.rows.map((row) => row.column_name)).toEqual(['discussed_products', 'texts_sent'])
    await client.query(`INSERT INTO "aichat_rate_events" ("visitor_key", "kind") VALUES ('visitor:upgrade', 'text')`)
    await client.query(`DELETE FROM "aichat_rate_events" WHERE "visitor_key" = 'visitor:upgrade'`)
  })

  it('reads the defaults the migration seeds', async () => {
    const s = await settings.getSettings()
    expect(s).toMatchObject({ mode: 'off', aiFirst: false, assistantName: 'Assistant', handoverWaitSeconds: 180, model: 'gpt-6-luna', openaiApiKey: null })
  })

  it('round-trips every setting, the key encrypted at rest', async () => {
    await settings.updateSettings({
      mode: 'on', aiFirst: true, assistantName: 'Charlie', businessName: 'Deskwell', extraInstructions: 'Be kind',
      language: 'cy', handoverWaitSeconds: 240, model: 'gpt-6-sol', openaiApiKey: 'sk-test-key',
    })
    const s = await settings.getSettings()
    expect(s).toMatchObject({ mode: 'on', aiFirst: true, assistantName: 'Charlie', businessName: 'Deskwell', extraInstructions: 'Be kind', language: 'cy', handoverWaitSeconds: 240, model: 'gpt-6-sol', openaiApiKey: 'sk-test-key' })
    const raw = await client.query<{ openai_api_key_encrypted: string }>('SELECT "openai_api_key_encrypted" FROM "aichat_settings"')
    expect(raw.rows[0]?.openai_api_key_encrypted).not.toContain('sk-test-key')
    await settings.updateSettings({ clearOpenaiApiKey: true })
    expect((await settings.getSettings()).openaiApiKey).toBeNull()
    expect(await settings.getCachedSettings()).toMatchObject({ mode: 'on' })
  })

  it('refuses a mode the CHECK does not know', async () => {
    await expect(client.query(`UPDATE "aichat_settings" SET "mode" = 'sometimes'`)).rejects.toThrow()
  })

  it('records an offer, keeping what an earlier request knew', async () => {
    await chat('c1')
    const first = await conversations.recordOffer({ conversationId: 'c1', staff: true, memberId: 'm1', memberEmail: 'sam@example.com', online: true })
    expect(first).toMatchObject({ conversationId: 'c1', state: 'auto', staff: true, memberId: 'm1', colleaguesOnline: true })
    const second = await conversations.recordOffer({ conversationId: 'c1', staff: false, memberId: null, memberEmail: null, online: false })
    expect(second).toMatchObject({ staff: true, memberId: 'm1', memberEmail: 'sam@example.com', colleaguesOnline: false })
    expect(await conversations.getConversationState('c1')).toMatchObject({ conversationId: 'c1' })
    expect(await conversations.getConversationState('nope')).toBeNull()
  })

  it('takes messages, claims one turn at a time, and reports more work on release', async () => {
    await conversations.takeMessage('c1', 10, 'auto', true)
    await conversations.takeMessage('c1', 7, 'auto', false)
    let row = await conversations.getConversationState('c1')
    expect(row).toMatchObject({ lastTakenMessageId: 10, callbackWanted: true })

    const claimed = await conversations.claimTurn('c1')
    expect(claimed).not.toBeNull()
    expect(await conversations.claimTurn('c1')).toBeNull()
    await conversations.markPending('c1')
    await conversations.extendTurn('c1')
    await conversations.markHandled('c1', 10)
    expect(await conversations.releaseTurn('c1')).toBe(true) // pending was set mid-turn

    expect(await conversations.claimTurn('c1')).not.toBeNull()
    expect(await conversations.releaseTurn('c1')).toBe(false)

    await conversations.markTaken('c1', 11)
    expect(await conversations.claimTurn('c1')).not.toBeNull()
    expect(await conversations.releaseTurn('c1')).toBe(true) // 11 taken, 10 handled
    await conversations.markHandled('c1', 11)
    row = await conversations.getConversationState('c1')
    expect(row).toMatchObject({ lastHandledMessageId: 11, processingUntil: null, pending: false })
  })

  it('reads Live Chat\'s Online switch as it stands', async () => {
    await client.query(`UPDATE "chat_settings" SET "agent_online" = false WHERE "id" = 'singleton'`)
    expect(await conversations.colleaguesOnlineNow(true)).toBe(false)
    await client.query(`UPDATE "chat_settings" SET "agent_online" = true WHERE "id" = 'singleton'`)
    expect(await conversations.colleaguesOnlineNow(false)).toBe(true)
  })

  it('lets a lapsed claim be taken over', async () => {
    expect(await conversations.claimTurn('c1', 0)).not.toBeNull()
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(await conversations.claimTurn('c1')).not.toBeNull()
    await conversations.releaseTurn('c1')
  })

  it('moves through hand-over, colleague and back', async () => {
    const until = await conversations.enterWaiting('c1', 60)
    expect(until).toBeInstanceOf(Date)
    expect(await conversations.getConversationState('c1')).toMatchObject({ state: 'waiting', callbackWanted: false })
    expect(await conversations.expireHandovers('c1')).toEqual([]) // not run out yet

    await conversations.colleagueTookOver('c1')
    expect(await conversations.getConversationState('c1')).toMatchObject({ state: 'colleague', waitingUntil: null })

    await chat('c-new')
    await conversations.colleagueTookOver('c-new') // no row yet: one is made
    expect(await conversations.getConversationState('c-new')).toMatchObject({ state: 'colleague' })

    expect(await conversations.handToAssistant('c1', 'assistant')).toMatchObject({ state: 'assistant', notGenuineAsks: 0 })
    await conversations.takeMessage('c1', 12, 'assistant', false)
    expect(await conversations.getConversationState('c1')).toMatchObject({ state: 'assistant', lastTakenMessageId: 12 })
  })

  it('hands back to the assistant when a wait runs out, to exactly one sweep', async () => {
    await chat('c2')
    await conversations.recordOffer({ conversationId: 'c2', staff: false, memberId: null, memberEmail: null, online: true })
    await conversations.enterWaiting('c2', 0)
    await new Promise((resolve) => setTimeout(resolve, 20))
    const [a, b] = await Promise.all([conversations.expireHandovers(), conversations.expireHandovers('c2')])
    expect([...a, ...b]).toEqual(['c2'])
    expect(await conversations.getConversationState('c2')).toMatchObject({ state: 'assistant', callbackWanted: true, waitingUntil: null })
  })

  it('sorts the chats when the switch goes off', async () => {
    await chat('c3')
    await chat('c4')
    await conversations.recordOffer({ conversationId: 'c3', staff: false, memberId: null, memberEmail: null, online: true })
    await conversations.recordOffer({ conversationId: 'c4', staff: false, memberId: null, memberEmail: null, online: true })
    await conversations.enterWaiting('c3', 600)
    await conversations.colleagueTookOver('c4')
    expect(await conversations.switchedOff()).toEqual(['c3'])
    expect(await conversations.getConversationState('c3')).toMatchObject({ state: 'auto', callbackWanted: true })
    expect(await conversations.getConversationState('c4')).toMatchObject({ state: 'auto' })
    expect((await conversations.autoChatsAmong(['c3', 'c4', 'c1', 'missing'])).sort()).toEqual(['c3', 'c4'])
    expect(await conversations.autoChatsAmong([])).toEqual([])
  })

  it('runs the not-genuine moves', async () => {
    await conversations.enterNotGenuine('c3', 'Keyboard-mashing or gibberish')
    expect(await conversations.getConversationState('c3')).toMatchObject({ state: 'not_genuine', notGenuineAsks: 1, notGenuineReason: 'Keyboard-mashing or gibberish' })
    await conversations.setNotGenuineAsks('c3', 2)
    await conversations.setCallbackWanted('c3', false)
    await conversations.enterQuiet('c3')
    expect(await conversations.getConversationState('c3')).toMatchObject({ state: 'quiet', notGenuineAsks: 2, callbackWanted: false })
    await conversations.colleagueTookOver('c3')
    expect(await conversations.getConversationState('c3')).toMatchObject({ state: 'quiet' })
  })

  it('adds up usage and caps the tool log', async () => {
    await conversations.addUsage('c1', { input: 1000, cached: 900, output: 20 })
    await conversations.addUsage('c1', { input: 500, cached: 0, output: 5 })
    expect((await conversations.getConversationState('c1'))?.usage).toEqual({ input: 1500, cached: 900, output: 25, turns: 2 })
    const entry = { tool: 'note_unanswered', at: new Date().toISOString(), ms: 12, args: 'question: x', ok: true }
    for (let i = 0; i < conversations.MAX_TOOL_LOG_ENTRIES + 3; i++) await conversations.appendToolLog('c1', entry)
    const log = (await conversations.getConversationState('c1'))?.toolLog ?? []
    expect(log).toHaveLength(conversations.MAX_TOOL_LOG_ENTRIES)
    expect(log[0]).toEqual(entry)
  })

  it('goes when the chat goes', async () => {
    await chat('c-gone')
    await conversations.recordOffer({ conversationId: 'c-gone', staff: false, memberId: null, memberEmail: null, online: false })
    await client.query(`DELETE FROM "chat_conversations" WHERE "id" = 'c-gone'`)
    expect(await conversations.getConversationState('c-gone')).toBeNull()
  })

  it('saves, lists and ticks off callbacks and unanswered questions', async () => {
    const id = await callbacks.saveCallback({ conversationId: 'c1', name: ' Sam ', email: 'SAM@example.com', about: 'Ten desks', source: 'tool' })
    expect(id).toMatch(/[0-9a-f-]{36}/)
    let list = await callbacks.listCallbacks(30)
    expect(list[0]).toMatchObject({ id, name: 'Sam', email: 'sam@example.com', about: 'Ten desks', source: 'tool', handled: false })
    await callbacks.setCallbackHandled(id, true)
    list = await callbacks.listCallbacks(30)
    expect(list[0]?.handled).toBe(true)

    await unanswered.recordUnanswered('c1', '  Do you ship to   Jersey? ')
    await unanswered.recordUnanswered('c1', '   ')
    const questions = await unanswered.listUnanswered(7)
    expect(questions).toHaveLength(1)
    expect(questions[0]).toMatchObject({ question: 'Do you ship to Jersey?', resolved: false })
    await unanswered.setUnansweredResolved(questions[0]!.id, true)
    expect((await unanswered.listUnanswered(7))[0]?.resolved).toBe(true)
  })

  it('copies from the phone assistant only when it is installed', async () => {
    expect(await copy.phoneAssistantInstalled()).toBe(false)
    expect(await copy.copyFromPhoneAssistant()).toMatchObject({ copied: false })

    const { encryptSecret } = await import('@/lib/crypto/secrets')
    await client.query(`CREATE TABLE "acall_settings" ("id" TEXT PRIMARY KEY, "business_name" TEXT NOT NULL DEFAULT '', "extra_instructions" TEXT NOT NULL DEFAULT '', "openai_api_key_encrypted" TEXT)`)
    expect(await copy.phoneAssistantInstalled()).toBe(true)
    expect(await copy.copyFromPhoneAssistant()).toMatchObject({ copied: false })

    await client.query(`INSERT INTO "acall_settings" VALUES ('singleton', 'Deskwell Ltd', 'Open 9 to 5', $1)`, [encryptSecret('sk-phone')])
    expect(await copy.copyFromPhoneAssistant()).toEqual({ copied: true, key: true, sender: true })
    expect(await settings.getSettings()).toMatchObject({ businessName: 'Deskwell Ltd', extraInstructions: 'Open 9 to 5', openaiApiKey: 'sk-phone' })
    expect((await settings.getSettings()).copiedFromPhoneAt).toBeInstanceOf(Date)
    expect(senders.setModuleSender).toHaveBeenCalledWith('ai-agent-for-live-chat', 'inbox-1')
  })
  it('remembers proved orders once each, and counts failed checks and emails per chat and per visitor', async () => {
    await chat('c-orders')
    await conversations.recordOffer({ conversationId: 'c-orders', staff: false, memberId: null, memberEmail: null, online: false })
    expect((await orderState.addVerifiedOrders('c-orders', ['DW1', 'DW2'])).sort()).toEqual(['DW1', 'DW2'])
    expect((await orderState.addVerifiedOrders('c-orders', ['DW2', 'DW3'])).sort()).toEqual(['DW1', 'DW2', 'DW3'])
    expect(await orderState.addVerifiedOrders('c-orders', [])).toEqual([])

    const key = orderState.visitorKey('c-orders', 'v1')
    await orderState.recordFailedCheck('c-orders', key)
    await orderState.recordFailedCheck('c-orders', key)
    await orderState.recordEmailSent('c-orders', key)
    expect(await orderState.recentRateEvents(key, 'failed_check')).toBe(2)
    expect(await orderState.recentRateEvents(key, 'email')).toBe(1)
    expect(await orderState.recentRateEvents('visitor:other', 'failed_check')).toBe(0)

    const row = await conversations.getConversationState('c-orders')
    expect(row).toMatchObject({ failedOrderChecks: 2, emailsSent: 1 })
    expect([...(row?.verifiedOrders ?? [])].sort()).toEqual(['DW1', 'DW2', 'DW3'])
  })

  it('counts texts per chat and per visitor, and keeps the products a chat was about', async () => {
    const key = orderState.visitorKey('c-orders', 'v1')
    await orderState.recordTextSent('c-orders', key)
    await orderState.recordTextSent('c-orders', key)
    expect(await orderState.recentRateEvents(key, 'text')).toBe(2)
    expect(await orderState.recentRateEvents(key, 'email')).toBe(1)

    const fresh = await conversations.getConversationState('c-orders')
    expect(fresh).toMatchObject({ textsSent: 2, discussedProducts: [] })

    const list = [
      { id: 'chair', url: 'https://shop.test/shop/products/chair', parentId: null },
      { id: 'desk-black', url: 'https://shop.test/shop/products/air-lite-desk?frame-colour=black', parentId: 'desk' },
    ]
    await orderState.saveDiscussedProducts('c-orders', list)
    expect((await conversations.getConversationState('c-orders'))?.discussedProducts).toEqual(list)
    const many = Array.from({ length: 14 }, (_, i) => ({ id: `p${i}`, url: null, parentId: null }))
    await orderState.saveDiscussedProducts('c-orders', many)
    const kept = (await conversations.getConversationState('c-orders'))?.discussedProducts ?? []
    expect(kept).toHaveLength(10)
    expect(kept[9]?.id).toBe('p13')
    await orderState.saveDiscussedProducts('c-orders', list)
  })

  it('prunes rate events older than a day, and refuses a kind the CHECK does not know', async () => {
    await client.query(`INSERT INTO "aichat_rate_events" ("visitor_key", "kind", "created_at") VALUES ('visitor:old', 'email', CURRENT_TIMESTAMP - INTERVAL '2 days')`)
    await orderState.recordEmailSent('c-orders', 'visitor:new')
    const left = await client.query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM "aichat_rate_events" WHERE "visitor_key" = 'visitor:old'`)
    expect(left.rows[0]?.n).toBe(0)
    await expect(client.query(`INSERT INTO "aichat_rate_events" ("visitor_key", "kind") VALUES ('x', 'texts')`)).rejects.toThrow()
  })

  it('keeps an overview with the newest message it covered', async () => {
    await orderState.saveOverview('c-orders', 'They wanted a desk.', 42)
    expect(await conversations.getConversationState('c-orders')).toMatchObject({ overview: 'They wanted a desk.', overviewMessageId: 42 })
  })

  it('counts the week\'s open unanswered questions for the Monday notice', async () => {
    expect(await unanswered.announceWeeklyUnanswered()).toBeGreaterThanOrEqual(0)
  })

  describe('the shop, as the tools read it', () => {
    let deskId = ''
    let blackId = ''

    beforeAll(async () => {
      const desk = await client.query<{ id: string }>(`INSERT INTO "shp_products" ("name", "slug", "type", "price", "status", "sku", "short_description") VALUES ('Air Lite Standing Desk', 'air-lite-desk', 'PHYSICAL', 0, 'ACTIVE', 'AL-100', 'A height adjustable desk') RETURNING "id"`)
      deskId = desk.rows[0]!.id
      const black = await client.query<{ id: string }>(`INSERT INTO "shp_products" ("name", "slug", "type", "price", "status", "sku", "catalogue_hidden") VALUES ('Air Lite Standing Desk - Black', 'air-lite-desk-black', 'PHYSICAL', 249, 'ACTIVE', 'AL-100-BK', true) RETURNING "id"`)
      blackId = black.rows[0]!.id
      const option = await client.query<{ id: string }>(`INSERT INTO "svr_options" ("product_id", "name") VALUES ($1, 'Frame Colour') RETURNING "id"`, [deskId])
      const value = await client.query<{ id: string }>(`INSERT INTO "svr_option_values" ("option_id", "label", "slug") VALUES ($1, 'Black', 'black') RETURNING "id"`, [option.rows[0]!.id])
      const variant = await client.query<{ id: string }>(`INSERT INTO "svr_variants" ("product_id", "child_product_id") VALUES ($1, $2) RETURNING "id"`, [deskId, blackId])
      await client.query(`INSERT INTO "svr_variant_values" ("variant_id", "option_value_id") VALUES ($1, $2)`, [variant.rows[0]!.id, value.rows[0]!.id])
      const mat = await client.query<{ id: string }>(`INSERT INTO "shp_products" ("name", "slug", "type", "price", "status") VALUES ('Anti-fatigue Mat', 'mat', 'PHYSICAL', 40, 'ACTIVE') RETURNING "id"`)
      await client.query(`INSERT INTO "pad_links" ("id", "product_id", "addon_product_id") VALUES ('link-1', $1, $2)`, [deskId, mat.rows[0]!.id])
    })

    it('finds products with their page addresses, variations and accessories', async () => {
      const found = await products.searchProducts('standing desk', null)
      expect(found.products[0]).toMatchObject({ id: deskId, url: 'https://shop.test/shop/products/air-lite-desk', hasVariations: true })
      const detail = await products.getProductDetail(deskId, 'black', 2)
      expect(detail?.matchingVariations?.[0]).toMatchObject({ id: blackId, url: 'https://shop.test/shop/products/air-lite-desk?frame-colour=black' })
      expect(detail?.accessories?.items[0]).toMatchObject({ name: 'Anti-fatigue Mat', url: 'https://shop.test/shop/products/mat' })
      const sku = await products.findBySku('AL100BK')
      expect(sku.hits[0]).toMatchObject({ productId: deskId, url: 'https://shop.test/shop/products/air-lite-desk?frame-colour=black' })
      expect(await products.toProductRefs([blackId, deskId])).toEqual([
        { moduleName: 'shop', kind: 'variation', id: blackId },
        { moduleName: 'shop', kind: 'product', id: deskId },
      ])
      expect(Array.isArray(await products.listTopCategories())).toBe(true)
    })

    it('reads FAQs, pages, payment methods and delivery to a postcode', async () => {
      expect((await faqs.lookupFaqs({ category: 'desks', collection: null, query: 'returns' })).ok).toBe(true)
      expect(Array.isArray((await siteContent.searchPages('returns')).passages)).toBe(true)
      expect(await siteContent.searchGuides('back pain')).toEqual([])
      expect((await payments.paymentInfo()).ok).toBe(true)
      expect(await postcodes.deliveryToPostcode('LS1 4AP', deskId)).toHaveProperty('ok')
    })

    it('reads orders: the postcode check, a member\'s own, and the contact an email goes to', async () => {
      const insert = `INSERT INTO "shp_orders" ("order_number", "member_id", "customer_email", "customer_name", "shipping_address", "subtotal", "total", "tax_mode", "payment_method", "status", "payment_status")
        VALUES ($1, $2, $3, 'Jo Bloggs', $4::jsonb, 100, 120, 'EXCLUSIVE', 'card', 'SHIPPED', 'PAID') RETURNING "id"`
      const own = await client.query<{ id: string }>(insert, ['DW000101', 'member-1', 'jo@example.com', JSON.stringify({ postcode: 'LS1 4AP', city: 'Leeds', line1: '1 High Street' })])
      await client.query(insert, ['DW000102', null, 'sam@example.com', JSON.stringify({ postcode: 'M1 1AA', city: 'Manchester' })])
      await client.query(`INSERT INTO "shp_order_items" ("order_id", "product_name", "product_type", "quantity", "unit_price", "tax_rate", "tax_amount", "total") VALUES ($1, 'Air Lite Standing Desk', 'PHYSICAL', 1, 100, 0.2, 20, 120)`, [own.rows[0]!.id])

      const proved = await orderQueries.lookupOrders({ postcode: 'ls1 4ap', orderNumber: '101', email: null, companyName: null })
      expect(proved).toMatchObject({ matched: true, internalNumbers: ['DW000101'] })
      if (proved.matched) {
        expect(proved.orders[0]).toMatchObject({ orderNumber: 'DW000101', deliveringTo: 'Leeds' })
        expect(JSON.stringify(proved.orders)).not.toMatch(/jo@example\.com|High Street/)
      }
      expect(await orderQueries.lookupOrders({ postcode: 'M1 1AA', orderNumber: '101', email: null, companyName: null })).toEqual({ matched: false })

      expect(await orderQueries.lookupMemberOrder('member-1', '101')).toMatchObject({ matched: true })
      expect(await orderQueries.lookupMemberOrder('member-1', 'DW000102')).toEqual({ matched: false })
      expect(await orderQueries.listMemberOrders('member-1')).toMatchObject([{ orderNumber: 'DW000101', itemCount: 1 }])
      expect(await orderQueries.listMemberOrders('member-2')).toEqual([])

      expect(await orderQueries.contactOnOrder('DW000101')).toEqual({ email: 'jo@example.com', name: 'Jo Bloggs' })
      expect(await orderQueries.contactOnOrder('DW999')).toBeNull()
      expect((await orderQueries.emailsOnOrders(['DW000101', 'DW000102'])).sort()).toEqual(['jo@example.com', 'sam@example.com'])

      await client.query(`UPDATE "shp_orders" SET "customer_phone" = '0113 249 6000', "notify_phone" = '07700 900123' WHERE "order_number" = 'DW000101'`)
      expect(await orderQueries.phonesOnOrders(['DW000101', 'DW000102', 'DW999'])).toEqual(expect.arrayContaining([
        { orderNumber: 'DW000101', phones: ['07700 900123', '0113 249 6000'] },
        { orderNumber: 'DW000102', phones: [] },
      ]))
      expect(await orderQueries.phonesOnOrders([])).toEqual([])
    })

    it('reads earlier contact by the addresses tied to the visitor', async () => {
      await client.query(`INSERT INTO "chat_conversations" ("id", "visitor_token_hash", "visitor_email", "last_message_preview") VALUES ('c-earlier', $1, 'jo@example.com', 'About a desk')`, ['y'.repeat(64)])
      // The phone assistant's and the inbox's tables, as far as the history reads them.
      await client.query(`CREATE TABLE "acall_calls" ("id" TEXT PRIMARY KEY, "status" TEXT NOT NULL, "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "summary" TEXT NOT NULL DEFAULT '', "caller_email" TEXT NOT NULL DEFAULT '', "verified_contact_email" TEXT NOT NULL DEFAULT '', "callback_needed" BOOLEAN NOT NULL DEFAULT false, "callback_reason" TEXT NOT NULL DEFAULT '', "handled_at" TIMESTAMP(3))`)
      await client.query(`INSERT INTO "acall_calls" ("id", "status", "summary", "verified_contact_email") VALUES ('call-1', 'completed', 'Asked about delivery', 'jo@example.com')`)
      await client.query(`CREATE TABLE "uin_messages" ("id" TEXT PRIMARY KEY, "thread_id" TEXT NOT NULL, "direction" TEXT NOT NULL, "channel" TEXT NOT NULL, "sent_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "subject" TEXT, "snippet" TEXT, "handled_at" TIMESTAMP(3), "from_address" TEXT)`)
      await client.query(`INSERT INTO "uin_messages" ("id", "thread_id", "direction", "channel", "subject", "from_address") VALUES ('m1', 't1', 'in', 'email', 'Invoice please', 'JO@example.com')`)

      const found = await history.visitorHistory({
        conversationId: 'c-orders',
        orders: { verified: ['DW000101'], failedChecks: 0, emailsSent: 0 },
        member: null,
      })
      expect(found.matchedOn).toBe(1)
      expect(found.items.map((item) => item.channel).sort()).toEqual(['call', 'chat', 'email'])
      expect(found.openRequests).toEqual([])
      expect(JSON.stringify(found)).not.toContain('jo@example.com')
    })
  })
})
