'use client'

import { useCallback, useEffect, useState } from 'react'
import type { ChatAdminToolbarProps } from '@/modules/chat/lib/slots'
import { API_BASE, type Mode } from '@/modules/ai-agent-for-live-chat/lib/constants'
import { AiChatStyles } from './styles'

// The "<name> first" switch, beside Live Chat's Online switch in the admin chat
// window and in the bubble a signed-in colleague sees on the site (Live Chat's
// `chat.admin-toolbar` slot). Site-wide, like the Online switch: on, the
// assistant answers new messages even while colleagues are online; off, it
// answers only while nobody is.
//
// Hidden while the assistant is switched off in its settings, and for anybody
// who cannot see Live Chat. Anybody who can reply to chats may flip it.
//
// Read on mount and every half minute while the tab is in front, so a
// colleague flipping it elsewhere shows up here soon enough without a poll
// worth noticing.

const API = `${API_BASE}/admin/ai-first`
const REFRESH_MS = 30_000

type State = { mode: Mode; aiFirst: boolean; assistantName: string; canChange: boolean }

export function AiFirstSwitch({ surface }: ChatAdminToolbarProps) {
  const [state, setState] = useState<State | null>(null)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async (): Promise<State | null> => {
    try {
      const res = await fetch(API, { cache: 'no-store' })
      if (!res.ok) return null
      return await res.json() as State
    } catch {
      return null
    }
  }, [])

  useEffect(() => {
    let live = true
    const refresh = () => {
      if (document.visibilityState !== 'visible') return
      void load().then((next) => { if (live && next) setState(next) })
    }
    void load().then((next) => { if (live) setState(next) })
    const timer = setInterval(refresh, REFRESH_MS)
    return () => { live = false; clearInterval(timer) }
  }, [load])

  if (!state || state.mode === 'off') return null

  const change = async () => {
    const next = !state.aiFirst
    const before = state
    setBusy(true)
    setState({ ...state, aiFirst: next })
    try {
      const res = await fetch(API, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ aiFirst: next }) })
      if (!res.ok) setState(before)
    } catch {
      setState(before)
    } finally {
      setBusy(false)
    }
  }

  const name = state.assistantName
  const title = state.aiFirst
    ? `${name} answers new messages first, even while you are online. Click so it only answers while nobody is online.`
    : `${name} only answers while nobody is online. Click so it answers new messages first.`

  return (
    <>
      <AiChatStyles />
      <button
        type="button"
        className={`aic-pill${state.aiFirst ? ' on' : ''}${surface === 'bubble' ? ' aic-dark' : ''}`}
        role="switch"
        aria-checked={state.aiFirst}
        disabled={busy || !state.canChange}
        title={state.canChange ? title : `${name} first is ${state.aiFirst ? 'on' : 'off'}.`}
        onClick={() => { void change() }}
      >
        <span className="aic-dot" aria-hidden="true" />
        {name} first
      </button>
    </>
  )
}
