'use client'

// "AI Agent for Live Chat" tab on the core admin settings page (settingsTabs
// manifest entry), split into sub-tabs:
//
//   Assistant  - when it answers, who it is, how it thinks, its OpenAI key and
//                the address its emails go out from
//   Unanswered - questions it had no answer for, to tick off once dealt with
//   Callbacks  - visitors waiting to be got back to
//
// The "<name> first" switch is here too, but it lives day to day beside Live
// Chat's Online switch, where whoever answers chats can flip it.
import { useCallback, useEffect, useState } from 'react'
import { TabStrip } from '@/components/admin/TabStrip'
import { useTabParam } from '@/components/admin/useTabParam'
import { SettingsHeaderActions, SettingsHeaderStatus } from '@/components/admin/SettingsHeaderActions'
import { InfoTip } from '@/components/admin/InfoTip'
import { ModuleSenderPanel } from '@/modules/unified-inbox/components/admin/ModuleSenderPanel'
import { API_BASE, MODULE_NAME, type Mode } from '@/modules/ai-agent-for-live-chat/lib/constants'
import { findInstructionConflicts } from '@/modules/ai-agent-for-live-chat/lib/instruction-conflicts'

const SETTINGS_API = `${API_BASE}/admin/settings`
const COPY_API = `${API_BASE}/admin/copy-from-phone`
const UNANSWERED_API = `${API_BASE}/admin/unanswered`
const CALLBACKS_API = `${API_BASE}/admin/callbacks`

type Choice = { id: string; label: string }

type State = {
  mode: Mode
  aiFirst: boolean
  assistantName: string
  businessName: string
  extraInstructions: string
  language: string
  handoverWaitSeconds: number
  model: string
  hasOpenaiApiKey: boolean
  openaiApiKeyFromEnv: boolean
  hasSavedKey: boolean
  phoneAvailable: boolean
  copiedFromPhoneAt: string | null
  messageLabel: string
  models: Choice[]
  languages: Choice[]
  handoverWaitMinSeconds: number
  handoverWaitMaxSeconds: number
  assistantNameMax: number
  extraInstructionsMax: number
}

type Draft = {
  mode: Mode
  aiFirst: boolean
  assistantName: string
  businessName: string
  extraInstructions: string
  language: string
  handoverWaitSeconds: number
  model: string
  openaiApiKey: string
}

const MODE_CHOICES: ReadonlyArray<{ id: Mode; label: string; hint: string }> = [
  { id: 'off', label: 'Off', hint: 'Live Chat works exactly as it does without this module.' },
  { id: 'staff', label: 'Staff only', hint: 'It answers only chats started by a signed-in colleague, for trying it out: on the site, press the eye in the chat bubble to see the chat as a visitor does, and write in. Visitors see no change.' },
  { id: 'on', label: 'On', hint: 'It answers visitors, by the rules below.' },
]

const SUB_TABS = [
  { key: 'assistant', label: 'Assistant' },
  { key: 'unanswered', label: 'Unanswered' },
  { key: 'callbacks', label: 'Callbacks' },
] as const
type SubTab = (typeof SUB_TABS)[number]['key']

function draftOf(state: State): Draft {
  return {
    mode: state.mode,
    aiFirst: state.aiFirst,
    assistantName: state.assistantName,
    businessName: state.businessName,
    extraInstructions: state.extraInstructions,
    language: state.language,
    handoverWaitSeconds: state.handoverWaitSeconds,
    model: state.model,
    // Never seeded from the server: the key is not sent back, and an empty box
    // means "leave whatever is saved alone".
    openaiApiKey: '',
  }
}

async function readError(res: Response, fallback: string): Promise<string> {
  const body = await res.json().catch(() => null) as { error?: string } | null
  return body?.error ?? fallback
}

function isMode(value: string): value is Mode {
  return value === 'off' || value === 'staff' || value === 'on'
}

function AssistantSection() {
  const [saved, setSaved] = useState<State | null>(null)
  const [draft, setDraft] = useState<Draft | null>(null)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')
  const [err, setErr] = useState('')

  const load = useCallback(async () => {
    try {
      const res = await fetch(SETTINGS_API, { cache: 'no-store' })
      if (!res.ok) return
      const state = await res.json() as State
      setSaved(state)
      setDraft(draftOf(state))
    } catch { /* retried on next open */ }
  }, [])

  useEffect(() => {
    let cancelled = false
    void (async () => {
      await Promise.resolve()
      if (!cancelled) await load()
    })()
    return () => { cancelled = true }
  }, [load])

  const patch = useCallback(async (body: Record<string, unknown>): Promise<boolean> => {
    const res = await fetch(SETTINGS_API, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    if (!res.ok) {
      setErr(await readError(res, 'Could not save those settings.'))
      return false
    }
    const state = await res.json() as State
    setSaved(state)
    setDraft(draftOf(state))
    return true
  }, [])

  const run = useCallback(async (work: () => Promise<string | null>) => {
    setBusy(true)
    setMsg('')
    setErr('')
    try {
      const done = await work()
      if (done) setMsg(done)
    } catch {
      setErr('Could not reach the site.')
    } finally {
      setBusy(false)
    }
  }, [])

  if (!saved || !draft) return <p className="field-hint">Loading…</p>

  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => setDraft({ ...draft, [key]: value })

  const save = () => run(async () => {
    const body: Record<string, unknown> = {
      mode: draft.mode,
      aiFirst: draft.aiFirst,
      assistantName: draft.assistantName,
      businessName: draft.businessName,
      extraInstructions: draft.extraInstructions,
      language: draft.language,
      handoverWaitSeconds: draft.handoverWaitSeconds,
      model: draft.model,
    }
    if (draft.openaiApiKey.trim()) body.openaiApiKey = draft.openaiApiKey.trim()
    return (await patch(body)) ? 'Saved.' : null
  })

  const clearKey = () => run(async () => ((await patch({ clearOpenaiApiKey: true })) ? 'The saved key is removed.' : null))

  const copyFromPhone = () => run(async () => {
    if (!window.confirm('Copy the phone assistant’s business name, extra instructions, OpenAI key and sending address over the ones here? After this the two are set separately.')) return null
    const res = await fetch(COPY_API, { method: 'POST' })
    if (!res.ok) {
      setErr(await readError(res, 'Could not copy the phone assistant’s settings.'))
      return null
    }
    await load()
    return 'Copied from the phone assistant.'
  })

  const name = draft.assistantName.trim() || 'Assistant'
  const conflicts = findInstructionConflicts(draft.extraInstructions)
  const modeHint = MODE_CHOICES.find((m) => m.id === draft.mode)?.hint ?? ''
  const keyStatus = saved.openaiApiKeyFromEnv
    ? 'The key is set on this site’s hosting (OPENAI_API_KEY).'
    : saved.hasOpenaiApiKey
      ? 'A key is saved.'
      : saved.hasSavedKey
        ? 'A key is saved but this site cannot read it (it was saved under another encryption key). Paste it again.'
        : 'No key yet. Without one, every chat it takes is handed straight to a colleague.'

  return (
    <div>
      <SettingsHeaderActions>
        <SettingsHeaderStatus message={msg} error={err} />
        <button type="button" className="btn btn-primary" onClick={save} disabled={busy}>
          {busy ? 'Working…' : 'Save changes'}
        </button>
      </SettingsHeaderActions>

      <div className="settings-cols">
        <div className="card">
          <div className="card-title">
            Answering chats
            <InfoTip>
              A digital assistant that answers your Live Chat. It says it is a digital assistant if anybody asks, its
              messages carry a small &ldquo;{saved.messageLabel}&rdquo; badge, and it hands a chat to a colleague whenever it
              should.
            </InfoTip>
          </div>
          <div className="field">
            <label>Mode</label>
            <select value={draft.mode} onChange={(e) => { if (isMode(e.target.value)) set('mode', e.target.value) }}>
              {MODE_CHOICES.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
            </select>
            <p className="field-hint">{modeHint}</p>
          </div>
          <div className="field">
            <label style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
              <input type="checkbox" checked={draft.aiFirst} onChange={(e) => set('aiFirst', e.target.checked)} />
              {name} first
            </label>
            <p className="field-hint">
              On: {name} answers new messages even while you are online. Off: it answers only while nobody is. The same switch
              sits beside Online in the chat window, where anybody who answers chats can flip it.
            </p>
          </div>
          <div className="field">
            <label>Hand-over wait (seconds)</label>
            <input
              type="number"
              min={saved.handoverWaitMinSeconds}
              max={saved.handoverWaitMaxSeconds}
              value={draft.handoverWaitSeconds}
              onChange={(e) => set('handoverWaitSeconds', Number(e.target.value))}
              style={{ maxWidth: '10rem' }}
            />
            <p className="field-hint">
              When {name} fetches a colleague and nobody replies within this time, it comes back, says sorry and takes the
              visitor&rsquo;s name and email so somebody can get back to them. Between {saved.handoverWaitMinSeconds} and{' '}
              {saved.handoverWaitMaxSeconds}.
            </p>
          </div>
        </div>

        <div className="card">
          <div className="card-title">How it decides who answers</div>
          <p className="field-hint">With the mode on, each new message from a visitor goes to {name} when:</p>
          <ul className="field-hint" style={{ margin: '0 0 0.5rem 1.2rem', padding: 0 }}>
            <li>nobody is online (the Online switch in the chat window is off), or</li>
            <li>&ldquo;{name} first&rdquo; is on, or</li>
            <li>a colleague pressed &ldquo;Hand to {name}&rdquo; on that chat.</li>
          </ul>
          <p className="field-hint">
            As soon as a colleague replies in a chat, it is theirs: {name} stays out of it until they press &ldquo;Hand back
            to {name}&rdquo; or go offline. When {name} fetches a colleague, the visitor&rsquo;s messages go to you until
            somebody replies or the hand-over wait runs out.
          </p>
          <p className="field-hint">
            Spam and time-wasters (the same message over and over, keyboard-mashing, a pile of links, abuse) are not
            answered: {name} asks up to three times for a name and email, then steps back and leaves the chat to you.
          </p>
        </div>

        <div className="card">
          <div className="card-title">Who it is</div>
          {saved.phoneAvailable && (
            <div className="field">
              <button type="button" className="btn btn-secondary" onClick={copyFromPhone} disabled={busy}>
                Copy from phone assistant
              </button>
              <p className="field-hint">
                Copies the business name, extra instructions, OpenAI key and sending address from AI Call Answering, once.
                {saved.copiedFromPhoneAt ? ` Last copied ${new Date(saved.copiedFromPhoneAt).toLocaleString('en-GB')}.` : ''}
              </p>
            </div>
          )}
          <div className="field">
            <label>Assistant name</label>
            <input type="text" maxLength={saved.assistantNameMax} value={draft.assistantName} onChange={(e) => set('assistantName', e.target.value)} />
            <p className="field-hint">What visitors see it called, for example Charlie. It still says it is a digital assistant.</p>
          </div>
          <div className="field">
            <label>Business name</label>
            <input type="text" maxLength={120} value={draft.businessName} onChange={(e) => set('businessName', e.target.value)} />
          </div>
          <div className="field">
            <label>Language</label>
            <select value={draft.language} onChange={(e) => set('language', e.target.value)}>
              {saved.languages.map((l) => <option key={l.id} value={l.id}>{l.label}</option>)}
            </select>
            <p className="field-hint">The language it writes in. A visitor who writes in another language is answered in theirs.</p>
          </div>
          <div className="field">
            <label>Extra instructions</label>
            <textarea rows={6} maxLength={saved.extraInstructionsMax} value={draft.extraInstructions} onChange={(e) => set('extraInstructions', e.target.value)} />
            <p className="field-hint">
              {draft.extraInstructions.length.toLocaleString()} / {saved.extraInstructionsMax.toLocaleString()} characters.{' '}
              Anything particular to your business: opening hours, how you handle returns, what never to promise. These are
              added to the built-in rules, which already cover never guessing and handing over when it cannot help.
            </p>
            {conflicts.length > 0 && (
              <div className="alert alert-warning" role="status">
                <strong>{conflicts.length === 1 ? 'One line here may work against the built-in rules:' : 'Some lines here may work against the built-in rules:'}</strong>
                <ul style={{ margin: '0.4rem 0 0 1.1rem', padding: 0 }}>
                  {conflicts.map((conflict) => (
                    <li key={conflict.advice} style={{ marginBottom: '0.4rem' }}>
                      &ldquo;{conflict.quote}&rdquo; - {conflict.advice}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        </div>

        <div className="card">
          <div className="card-title">
            OpenAI
            <InfoTip>
              The assistant thinks with OpenAI. Its standing instructions are the same for every chat, so OpenAI can reuse
              them from its cache rather than charge for reading them afresh each time.
            </InfoTip>
          </div>
          <p className="field-hint"><strong>{keyStatus}</strong></p>
          {!saved.openaiApiKeyFromEnv && (
            <div className="field">
              <label>OpenAI API key</label>
              <input
                type="password"
                autoComplete="off"
                value={draft.openaiApiKey}
                placeholder={saved.hasSavedKey ? 'A key is saved. Type a new one to replace it.' : 'Paste your key here'}
                onChange={(e) => set('openaiApiKey', e.target.value)}
              />
              {saved.hasSavedKey && (
                <button type="button" className="btn btn-secondary" style={{ marginTop: '0.5rem' }} onClick={clearKey} disabled={busy}>
                  Remove the saved key
                </button>
              )}
            </div>
          )}
          <div className="field">
            <label>Thinking model</label>
            <select value={draft.model} style={{ maxWidth: '36rem' }} onChange={(e) => set('model', e.target.value)}>
              {saved.models.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
              {!saved.models.some((m) => m.id === draft.model) && <option value={draft.model}>{draft.model}</option>}
            </select>
          </div>
        </div>
      </div>

      <div className="card">
        <div className="card-title">Emails to visitors</div>
        <p className="field-hint">
          When a visitor asks, the assistant emails them their order&rsquo;s link (only ever to the address on the order) or a
          short note of the chat with links to the products it mentioned. Choose the address those emails come from, and the
          inbox a copy is filed in. The wording is under Settings &gt; Emails, in the Chat assistant group.
        </p>
        <ModuleSenderPanel moduleName={MODULE_NAME} what="the chat assistant's emails" />
      </div>
    </div>
  )
}

type UnansweredRow = { id: string; conversationId: string | null; question: string; resolved: boolean; createdAt: string }
type CallbackRow = { id: string; conversationId: string | null; name: string; email: string; about: string; source: 'tool' | 'not_genuine'; handled: boolean; createdAt: string }

const SPANS = [
  { days: 7, label: 'This week' },
  { days: 30, label: 'Last 30 days' },
  { days: 90, label: 'Last 90 days' },
] as const

/** A list loaded from one of the admin routes, ticked off one row at a time. */
function useTickList<T>(api: string, days: number) {
  const [items, setItems] = useState<T[] | null>(null)
  const [err, setErr] = useState('')

  const load = useCallback(async () => {
    try {
      const res = await fetch(`${api}?days=${days}`, { cache: 'no-store' })
      if (!res.ok) return
      setItems((await res.json() as { items: T[] }).items)
    } catch { /* retried on next open */ }
  }, [api, days])

  useEffect(() => {
    let cancelled = false
    void (async () => {
      await Promise.resolve()
      if (!cancelled) await load()
    })()
    return () => { cancelled = true }
  }, [load])

  const tick = async (body: Record<string, unknown>) => {
    setErr('')
    try {
      const res = await fetch(api, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
      if (!res.ok) setErr(await readError(res, 'Could not save that.'))
      await load()
    } catch {
      setErr('Could not reach the site.')
    }
  }

  return { items, err, tick }
}

function SpanPicker({ days, onChange }: { days: number; onChange: (days: number) => void }) {
  return (
    <div className="field">
      <select value={days} onChange={(e) => onChange(Number(e.target.value))}>
        {SPANS.map((span) => <option key={span.days} value={span.days}>{span.label}</option>)}
      </select>
    </div>
  )
}

function UnansweredSection() {
  const [days, setDays] = useState<number>(30)
  const { items, err, tick } = useTickList<UnansweredRow>(UNANSWERED_API, days)
  if (!items) return <p className="field-hint">Loading…</p>
  const open = items.filter((item) => !item.resolved).length
  return (
    <div className="card">
      <div className="card-title">
        Questions it could not answer
        <InfoTip>
          Each one is a visitor question the assistant had no answer for. Most want an FAQ, a line on a page or a product
          detail filling in. Tick one off once it is dealt with.
        </InfoTip>
      </div>
      <SpanPicker days={days} onChange={setDays} />
      {err && <div className="alert alert-error">{err}</div>}
      {items.length === 0 && <p className="field-hint">Nothing went unanswered in this period.</p>}
      {items.length > 0 && <p className="field-hint"><strong>{open}</strong> still to deal with.</p>}
      {items.map((item) => (
        <div key={item.id} style={{ borderTop: '1px solid var(--color-border)', padding: '0.5rem 0', opacity: item.resolved ? 0.6 : 1 }}>
          <label style={{ display: 'flex', gap: '0.5rem', alignItems: 'flex-start' }}>
            <input type="checkbox" checked={item.resolved} onChange={(e) => { void tick({ id: item.id, resolved: e.target.checked }) }} />
            <span>
              {item.question}
              <br />
              <span className="field-hint">{new Date(item.createdAt).toLocaleString('en-GB')}</span>
            </span>
          </label>
        </div>
      ))}
    </div>
  )
}

function CallbacksSection() {
  const [days, setDays] = useState<number>(30)
  const { items, err, tick } = useTickList<CallbackRow>(CALLBACKS_API, days)
  if (!items) return <p className="field-hint">Loading…</p>
  const open = items.filter((item) => !item.handled).length
  return (
    <div className="card">
      <div className="card-title">
        Callbacks
        <InfoTip>
          Visitors the assistant could not help, or stepped back from, who left a name and email so somebody can get back to
          them. Open ones stay here whatever the period; tick one off once it is done.
        </InfoTip>
      </div>
      <SpanPicker days={days} onChange={setDays} />
      {err && <div className="alert alert-error">{err}</div>}
      {items.length === 0 && <p className="field-hint">Nobody is waiting for a callback.</p>}
      {items.length > 0 && <p className="field-hint"><strong>{open}</strong> still to do.</p>}
      {items.map((item) => (
        <div key={item.id} style={{ borderTop: '1px solid var(--color-border)', padding: '0.5rem 0', opacity: item.handled ? 0.6 : 1 }}>
          <label style={{ display: 'flex', gap: '0.5rem', alignItems: 'flex-start' }}>
            <input type="checkbox" checked={item.handled} onChange={(e) => { void tick({ id: item.id, handled: e.target.checked }) }} />
            <span>
              <strong>{item.name || 'No name given'}</strong> - <a href={`mailto:${item.email}`}>{item.email}</a>
              {item.about ? <><br />{item.about}</> : null}
              <br />
              <span className="field-hint">
                {new Date(item.createdAt).toLocaleString('en-GB')}
                {item.source === 'not_genuine' ? ' - from a chat it stepped back from' : ''}
              </span>
            </span>
          </label>
        </div>
      ))}
    </div>
  )
}

export function AiAgentForLiveChatSettingsTab() {
  const [sub, setSub] = useTabParam<SubTab>('sub', 'assistant', SUB_TABS.map((t) => t.key))
  return (
    <div>
      <TabStrip
        items={SUB_TABS.map((t) => ({ key: t.key, label: t.label, active: t.key === sub, onClick: () => setSub(t.key) }))}
      />
      {sub === 'assistant' && <AssistantSection />}
      {sub === 'unanswered' && <UnansweredSection />}
      {sub === 'callbacks' && <CallbacksSection />}
    </div>
  )
}
