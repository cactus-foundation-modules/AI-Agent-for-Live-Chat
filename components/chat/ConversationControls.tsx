'use client'

import { useCallback, useEffect, useState } from 'react'
import type { ChatConversationActionsProps } from '@/modules/chat/lib/slots'
import { API_BASE, type ChatState, type Mode } from '@/modules/ai-agent-for-live-chat/lib/constants'
import { chatControl } from '@/modules/ai-agent-for-live-chat/lib/controls'
import { AiChatStyles } from './styles'

// In the header of the chat on screen, in the admin chat window and the bubble
// (Live Chat's `chat.conversation-actions` slot): a small pill saying who is
// answering this chat, the one button that changes it ("Hand to <name>",
// "Hand back to <name>"), and Notes - a short written overview of the chat
// (written when Notes is opened, reused until a newer message arrives) above
// what the assistant did in it, tool by tool. A colleague takes a chat over simply by replying, so there is
// no button for that. Hidden while the assistant is switched off.
//
// Read again every ten seconds while the tab is in front: the state moves on
// its own (a hand-over running out, the assistant stepping back).

const API = `${API_BASE}/admin/conversation`
const OVERVIEW_API = `${API_BASE}/admin/conversation/overview`
const REFRESH_MS = 10_000

type LogEntry = { tool: string; at: string; ms: number; args: string; ok: boolean }

type State = {
  mode: Mode
  assistantName: string
  aiFirst: boolean
  state: ChatState
  waitingSince: string | null
  notGenuineReason: string | null
  toolLog: LogEntry[]
  canAct: boolean
}

/** The tool names, said plainly. Anything newer shows as its own name. */
export const TOOL_WORDS: Record<string, string> = {
  hand_to_colleague: 'Asked for a colleague',
  flag_not_genuine: 'Flagged as not genuine',
  save_callback: 'Saved a callback',
  note_unanswered: 'Noted a question it could not answer',
  search_products: 'Searched the products',
  find_by_sku: 'Looked up a product code',
  get_product: 'Read a product\'s details',
  list_categories: 'Listed the categories',
  get_faqs: 'Read the FAQs',
  get_payment_info: 'Read the payment methods',
  lookup_order: 'Checked an order',
  list_my_orders: 'Listed their own orders',
  email_order_link: 'Emailed the order link',
  email_summary: 'Emailed a note of the chat',
  get_visitor_history: 'Looked for earlier contact',
  search_pages: 'Searched the shop\'s pages',
  check_delivery_postcode: 'Checked delivery to a postcode',
  get_reviews: 'Read the reviews',
  search_guides: 'Searched the articles',
  raise_order_request: 'Raised a request on an order',
  save_quote: 'Saved a quote',
  spam_check: 'Spam check',
  not_genuine: 'Not-genuine follow-up',
}

function timeOf(iso: string): string {
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
}

export function ConversationControls({ conversationId, status }: ChatConversationActionsProps) {
  const [state, setState] = useState<State | null>(null)
  const [busy, setBusy] = useState(false)
  const [notes, setNotes] = useState(false)
  const [overview, setOverview] = useState<{ text: string; status: 'loading' | 'ready' | 'error' } | null>(null)
  const [now, setNow] = useState(() => Date.now())

  const load = useCallback(async (): Promise<State | null> => {
    try {
      const res = await fetch(`${API}?id=${encodeURIComponent(conversationId)}`, { cache: 'no-store' })
      if (!res.ok) return null
      return await res.json() as State
    } catch {
      return null
    }
  }, [conversationId])

  useEffect(() => {
    let live = true
    const refresh = () => {
      if (document.visibilityState !== 'visible') return
      void load().then((next) => {
        if (!live) return
        if (next) setState(next)
        setNow(Date.now())
      })
    }
    void load().then((next) => { if (live) setState(next) })
    const timer = setInterval(refresh, REFRESH_MS)
    return () => { live = false; clearInterval(timer) }
  }, [load])

  if (!state || state.mode === 'off') return null

  // Asked for each time Notes opens: the server reuses the stored overview
  // until a newer message arrives, so opening it again costs nothing.
  const loadOverview = async () => {
    setOverview((current) => ({ text: current?.text ?? '', status: 'loading' }))
    try {
      const res = await fetch(OVERVIEW_API, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: conversationId }) })
      const body = await res.json().catch(() => null) as { overview?: string; error?: string } | null
      if (!res.ok) {
        setOverview({ text: body?.error ?? 'The overview could not be written just now.', status: 'error' })
        return
      }
      setOverview({ text: body?.overview ?? '', status: 'ready' })
    } catch {
      setOverview({ text: 'The overview could not be fetched just now.', status: 'error' })
    }
  }

  const toggleNotes = () => {
    const opening = !notes
    setNotes(opening)
    if (opening) void loadOverview()
  }

  const control = chatControl({
    state: state.state,
    name: state.assistantName,
    aiFirst: state.aiFirst,
    waitingSince: state.waitingSince ? new Date(state.waitingSince) : null,
    now: new Date(now),
  })

  const act = async (kind: 'hand' | 'hand_back') => {
    setBusy(true)
    try {
      const res = await fetch(API, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: conversationId, action: kind }) })
      if (res.ok) {
        const next = await load()
        if (next) setState(next)
      }
    } catch {
      // The next refresh shows where it stands.
    } finally {
      setBusy(false)
    }
  }

  const action = status === 'open' && state.canAct ? control.action : null

  return (
    <span className="aic-controls">
      <AiChatStyles />
      {control.pill ? <span className="aic-state">{control.pill}</span> : null}
      {action ? (
        <button type="button" className="aic-act" disabled={busy} onClick={() => { void act(action.kind) }}>
          {action.label}
        </button>
      ) : null}
      <button type="button" className="aic-act" aria-expanded={notes} onClick={toggleNotes}>
        Notes
      </button>
      {notes ? (
        <div className="aic-notes" role="region" aria-label={`What ${state.assistantName} did in this chat`}>
          <h3>Overview</h3>
          {overview?.status === 'loading' && !overview.text ? <p className="aic-muted">Writing an overview…</p> : null}
          {overview?.status === 'error' ? <p className="aic-bad">{overview.text}</p> : null}
          {overview && overview.status !== 'error' && overview.text ? <p>{overview.text}</p> : null}
          {overview?.status === 'ready' && !overview.text ? <p className="aic-muted">Nothing to sum up yet.</p> : null}
          <h3>What {state.assistantName} did in this chat</h3>
          {state.notGenuineReason ? <p className="aic-muted">Stepped back because: {state.notGenuineReason}</p> : null}
          {state.toolLog.length === 0 ? (
            <p className="aic-muted">Nothing yet.</p>
          ) : (
            <ul>
              {state.toolLog.map((entry, index) => (
                <li key={`${entry.at}-${index}`}>
                  <span className="aic-muted">{timeOf(entry.at)}</span>{' '}
                  {TOOL_WORDS[entry.tool] ?? entry.tool}
                  {entry.ok ? '' : <span className="aic-bad"> (did not work)</span>}
                  {entry.args ? <div className="aic-muted">{entry.args}</div> : null}
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}
    </span>
  )
}
