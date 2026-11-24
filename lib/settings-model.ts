import { isMode, type Mode } from './constants'

// ---------------------------------------------------------------------------
// The settings, as plain data: what a row turns into, what every value falls
// back to, and which OpenAI key wins. Pure - no database, no crypto - so the
// parsing and the env-first rule are pinned by tests. lib/settings.ts reads
// and writes the row.
// ---------------------------------------------------------------------------

/** The model that does the thinking. The same list the phone assistant offers
 *  its GPT-Live backend, copied rather than imported: the two modules are
 *  independent. */
export const DEFAULT_MODEL = 'gpt-6-luna'

export const MODEL_CHOICES: ReadonlyArray<{ id: string; label: string }> = [
  { id: 'gpt-6-luna', label: 'GPT-6 Luna - quick, OpenAI\'s suggested start (recommended)' },
  { id: 'gpt-6-sol', label: 'GPT-6 Sol - more careful with tricky questions, a little slower' },
]

export const LANGUAGE_CHOICES: ReadonlyArray<{ id: string; label: string }> = [
  { id: 'en', label: 'English' },
  { id: 'cy', label: 'Welsh' },
  { id: 'fr', label: 'French' },
  { id: 'de', label: 'German' },
  { id: 'es', label: 'Spanish' },
  { id: 'pl', label: 'Polish' },
]

export const DEFAULT_ASSISTANT_NAME = 'Assistant'

/** How long a chat handed to a colleague waits for one, in seconds. Long
 *  enough for somebody to finish a phone call, short enough that a visitor is
 *  not left wondering. */
export const HANDOVER_WAIT_DEFAULT_SECONDS = 180
export const HANDOVER_WAIT_MIN_SECONDS = 30
export const HANDOVER_WAIT_MAX_SECONDS = 1800

export const ASSISTANT_NAME_MAX = 40
export const BUSINESS_NAME_MAX = 120
export const EXTRA_INSTRUCTIONS_MAX = 8000

export type AiChatSettings = {
  mode: Mode
  aiFirst: boolean
  assistantName: string
  businessName: string
  extraInstructions: string
  language: string
  handoverWaitSeconds: number
  model: string
  openaiApiKey: string | null
  openaiApiKeyFromEnv: boolean
  /** Whether a key is saved on the row, whatever the env says. */
  hasSavedKey: boolean
  copiedFromPhoneAt: Date | null
}

export const DEFAULT_SETTINGS: AiChatSettings = {
  mode: 'off',
  aiFirst: false,
  assistantName: DEFAULT_ASSISTANT_NAME,
  businessName: '',
  extraInstructions: '',
  language: 'en',
  handoverWaitSeconds: HANDOVER_WAIT_DEFAULT_SECONDS,
  model: DEFAULT_MODEL,
  openaiApiKey: null,
  openaiApiKeyFromEnv: false,
  hasSavedKey: false,
  copiedFromPhoneAt: null,
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null
}

export function clampHandoverSeconds(value: unknown): number {
  const seconds = typeof value === 'number' ? Math.round(value) : Number.NaN
  if (!Number.isFinite(seconds)) return HANDOVER_WAIT_DEFAULT_SECONDS
  return Math.min(Math.max(seconds, HANDOVER_WAIT_MIN_SECONDS), HANDOVER_WAIT_MAX_SECONDS)
}

/** A name fit to show a visitor: trimmed, one line, not too long, and never
 *  empty. */
export function cleanAssistantName(value: unknown): string {
  const name = typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, ASSISTANT_NAME_MAX) : ''
  return name || DEFAULT_ASSISTANT_NAME
}

export function languageName(language: string): string {
  return LANGUAGE_CHOICES.find((choice) => choice.id === language)?.label ?? 'English'
}

export function envOpenAiKey(env: Record<string, string | undefined> = process.env): string | null {
  return str(env.OPENAI_API_KEY)
}

/**
 * The row, as settings. `decrypt` turns the saved ciphertext into the key (or
 * null when it cannot be read - a restored backup carries ciphertext written
 * under another install's key). The env key wins, so rotating the env var can
 * never be shadowed by a stale row.
 */
export function settingsFromRow(
  row: Record<string, unknown> | null,
  decrypt: (ciphertext: string | null) => string | null,
  env: Record<string, string | undefined> = process.env,
): AiChatSettings {
  const fromEnv = envOpenAiKey(env)
  const saved = str(row?.openai_api_key_encrypted)
  return {
    mode: isMode(row?.mode) ? row.mode : 'off',
    aiFirst: row?.ai_first === true,
    assistantName: cleanAssistantName(row?.assistant_name),
    businessName: str(row?.business_name)?.trim() ?? '',
    extraInstructions: str(row?.extra_instructions)?.trim() ?? '',
    language: str(row?.language) ?? 'en',
    handoverWaitSeconds: typeof row?.handover_wait_seconds === 'number'
      ? clampHandoverSeconds(row.handover_wait_seconds)
      : HANDOVER_WAIT_DEFAULT_SECONDS,
    model: str(row?.model) ?? DEFAULT_MODEL,
    openaiApiKey: fromEnv ?? decrypt(saved),
    openaiApiKeyFromEnv: !!fromEnv,
    hasSavedKey: !!saved,
    copiedFromPhoneAt: row?.copied_from_phone_at instanceof Date ? row.copied_from_phone_at : null,
  }
}
