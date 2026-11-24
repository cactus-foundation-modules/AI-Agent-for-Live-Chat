import { NextRequest } from 'next/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// The weekly notice of questions the assistant could not answer, and the cron
// route that sends it.

const db = vi.hoisted(() => ({ $queryRaw: vi.fn(), $executeRaw: vi.fn() }))
const alerts = vi.hoisted(() => ({ upsertAlert: vi.fn(async () => undefined) }))
vi.mock('@/lib/db/prisma', () => ({ prisma: db }))
vi.mock('@/lib/notifications/alerts', () => alerts)

const { UNANSWERED_LINK, announceWeeklyUnanswered, weeklyUnansweredTitle } = await import('./unanswered')
const route = await import('../app/api/cron/unanswered/route')

beforeEach(() => {
  vi.clearAllMocks()
  process.env.CRON_SECRET = 'secret'
})

describe('announceWeeklyUnanswered', () => {
  it('raises one notice for the week, linking to the list', async () => {
    db.$queryRaw.mockResolvedValue([{ n: 3 }])
    expect(await announceWeeklyUnanswered(new Date('2026-11-23T07:00:00Z'))).toBe(3)
    expect(alerts.upsertAlert).toHaveBeenCalledWith({
      type: 'message',
      dedupeKey: 'ai-agent-for-live-chat:unanswered:2026-11-23',
      title: '3 questions the chat assistant could not answer this week',
      link: UNANSWERED_LINK,
    })
  })

  it('says nothing for a week with none', async () => {
    db.$queryRaw.mockResolvedValue([{ n: 0 }])
    expect(await announceWeeklyUnanswered()).toBe(0)
    expect(alerts.upsertAlert).not.toHaveBeenCalled()
  })

  it('words one question as one', () => {
    expect(weeklyUnansweredTitle(1)).toBe('1 question the chat assistant could not answer this week')
  })
})

describe('cron/unanswered', () => {
  const call = (auth: string | null) => route.GET(new NextRequest('https://shop.test/api/m/ai-agent-for-live-chat/cron/unanswered', { headers: auth ? { authorization: auth } : {} }))

  it('needs the cron secret', async () => {
    expect((await call(null)).status).toBe(401)
    expect((await call('Bearer wrong')).status).toBe(401)
    delete process.env.CRON_SECRET
    expect((await call('Bearer secret')).status).toBe(503)
  })

  it('sends the notice', async () => {
    db.$queryRaw.mockResolvedValue([{ n: 2 }])
    const res = await call('Bearer secret')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, unanswered: 2 })
  })
})
