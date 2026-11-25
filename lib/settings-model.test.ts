import { describe, expect, it } from 'vitest'
import {
  DEFAULT_MODEL,
  DEFAULT_SETTINGS,
  HANDOVER_WAIT_DEFAULT_SECONDS,
  HANDOVER_WAIT_MAX_SECONDS,
  HANDOVER_WAIT_MIN_SECONDS,
  clampHandoverSeconds,
  cleanAssistantName,
  envOpenAiKey,
  settingsFromRow,
} from './settings-model'

const decrypt = (ciphertext: string | null) => (ciphertext ? `plain:${ciphertext}` : null)

describe('settingsFromRow', () => {
  it('gives the defaults with no row at all', () => {
    expect(settingsFromRow(null, decrypt, {})).toEqual(DEFAULT_SETTINGS)
  })

  it('reads every column', () => {
    const copied = new Date('2026-11-20T10:00:00Z')
    const s = settingsFromRow({
      mode: 'on', ai_first: true, assistant_name: '  Charlie ', business_name: 'Deskwell', extra_instructions: ' Be kind ', email_signature: ' Charlie\nDeskwell ',
      language: 'cy', handover_wait_seconds: 240, model: 'gpt-6-sol', openai_api_key_encrypted: 'abc', copied_from_phone_at: copied,
    }, decrypt, {})
    expect(s).toEqual({
      mode: 'on', aiFirst: true, assistantName: 'Charlie', businessName: 'Deskwell', extraInstructions: 'Be kind', emailSignature: 'Charlie\nDeskwell',
      language: 'cy', handoverWaitSeconds: 240, model: 'gpt-6-sol', openaiApiKey: 'plain:abc', openaiApiKeyFromEnv: false,
      hasSavedKey: true, copiedFromPhoneAt: copied,
    })
  })

  it('falls back on nonsense rather than trusting it', () => {
    const s = settingsFromRow({ mode: 'sometimes', ai_first: 'yes', assistant_name: '   ', model: '', handover_wait_seconds: 5 }, decrypt, {})
    expect(s.mode).toBe('off')
    expect(s.aiFirst).toBe(false)
    expect(s.assistantName).toBe('Assistant')
    expect(s.model).toBe(DEFAULT_MODEL)
    expect(s.handoverWaitSeconds).toBe(HANDOVER_WAIT_MIN_SECONDS)
  })

  it('lets the env key win over a saved one, and says so', () => {
    const s = settingsFromRow({ openai_api_key_encrypted: 'abc' }, decrypt, { OPENAI_API_KEY: 'sk-env' })
    expect(s.openaiApiKey).toBe('sk-env')
    expect(s.openaiApiKeyFromEnv).toBe(true)
    expect(s.hasSavedKey).toBe(true)
  })

  it('treats a saved key it cannot read as no key', () => {
    const s = settingsFromRow({ openai_api_key_encrypted: 'from-another-site' }, () => null, {})
    expect(s.openaiApiKey).toBeNull()
    expect(s.hasSavedKey).toBe(true)
  })

  it('ignores a blank env key', () => {
    expect(envOpenAiKey({ OPENAI_API_KEY: '  ' })).toBeNull()
    expect(envOpenAiKey({})).toBeNull()
  })
})

describe('cleaning values', () => {
  it('keeps the hand-over wait within its bounds', () => {
    expect(clampHandoverSeconds(10)).toBe(HANDOVER_WAIT_MIN_SECONDS)
    expect(clampHandoverSeconds(99_999)).toBe(HANDOVER_WAIT_MAX_SECONDS)
    expect(clampHandoverSeconds(200.4)).toBe(200)
    expect(clampHandoverSeconds('180')).toBe(HANDOVER_WAIT_DEFAULT_SECONDS)
    expect(clampHandoverSeconds(Number.NaN)).toBe(HANDOVER_WAIT_DEFAULT_SECONDS)
  })

  it('makes the name one short line, never empty', () => {
    expect(cleanAssistantName('  Char\n lie ')).toBe('Char lie')
    expect(cleanAssistantName('x'.repeat(80))).toHaveLength(40)
    expect(cleanAssistantName(null)).toBe('Assistant')
  })
})
