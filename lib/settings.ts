import { prisma } from '@/lib/db/prisma'
import { encryptSecret, tryDecryptSecret } from '@/lib/crypto/secrets'
import type { Mode } from './constants'
import {
  DEFAULT_MODEL,
  clampHandoverSeconds,
  cleanAssistantName,
  settingsFromRow,
  type AiChatSettings,
} from './settings-model'

// ---------------------------------------------------------------------------
// The settings row, read and written. Parsing lives in lib/settings-model.ts.
//
// Live Chat asks the responder something on almost every request the bubble
// makes, with two seconds to answer, so the hot paths read a copy held in
// memory for a few seconds (getCachedSettings). A save on this server drops
// the copy at once; another server process sees it within the TTL.
// ---------------------------------------------------------------------------

export const SETTINGS_TTL_MS = 5_000

type Row = Record<string, unknown>

let cached: { at: number; value: AiChatSettings } | null = null

async function readRow(): Promise<Row | null> {
  const rows = await prisma.$queryRaw<Row[]>`SELECT * FROM "aichat_settings" WHERE "id" = 'singleton' LIMIT 1`
  return rows[0] ?? null
}

/** Straight from the database. For the settings screen and anything about to
 *  spend money; the responder's quick answers use getCachedSettings. */
export async function getSettings(): Promise<AiChatSettings> {
  const value = settingsFromRow(await readRow(), tryDecryptSecret)
  cached = { at: Date.now(), value }
  return value
}

/** The settings as of at most a few seconds ago. */
export async function getCachedSettings(now: number = Date.now()): Promise<AiChatSettings> {
  if (cached && now - cached.at < SETTINGS_TTL_MS) return cached.value
  return getSettings()
}

/** Forget the copy held in memory, so the next read goes to the database. */
export function invalidateSettings(): void {
  cached = null
}

async function ensureRow(): Promise<void> {
  await prisma.$executeRaw`INSERT INTO "aichat_settings" ("id") VALUES ('singleton') ON CONFLICT ("id") DO NOTHING`
}

export type SettingsPatch = {
  mode?: Mode
  aiFirst?: boolean
  assistantName?: string
  businessName?: string
  extraInstructions?: string
  emailSignature?: string
  language?: string
  handoverWaitSeconds?: number
  model?: string
  openaiApiKey?: string
  clearOpenaiApiKey?: boolean
}

/** Written a column at a time: every value is optional, and a template literal
 *  cannot build a SET list without losing the parameterisation. */
export async function updateSettings(patch: SettingsPatch): Promise<void> {
  await ensureRow()
  try {
    if (patch.mode !== undefined) {
      await prisma.$executeRaw`UPDATE "aichat_settings" SET "mode" = ${patch.mode} WHERE "id" = 'singleton'`
    }
    if (patch.aiFirst !== undefined) {
      await prisma.$executeRaw`UPDATE "aichat_settings" SET "ai_first" = ${patch.aiFirst} WHERE "id" = 'singleton'`
    }
    if (patch.assistantName !== undefined) {
      await prisma.$executeRaw`UPDATE "aichat_settings" SET "assistant_name" = ${cleanAssistantName(patch.assistantName)} WHERE "id" = 'singleton'`
    }
    if (patch.businessName !== undefined) {
      await prisma.$executeRaw`UPDATE "aichat_settings" SET "business_name" = ${patch.businessName.trim()} WHERE "id" = 'singleton'`
    }
    if (patch.extraInstructions !== undefined) {
      await prisma.$executeRaw`UPDATE "aichat_settings" SET "extra_instructions" = ${patch.extraInstructions.trim()} WHERE "id" = 'singleton'`
    }
    if (patch.emailSignature !== undefined) {
      await prisma.$executeRaw`UPDATE "aichat_settings" SET "email_signature" = ${patch.emailSignature.trim()} WHERE "id" = 'singleton'`
    }
    if (patch.language !== undefined) {
      await prisma.$executeRaw`UPDATE "aichat_settings" SET "language" = ${patch.language.trim() || 'en'} WHERE "id" = 'singleton'`
    }
    if (patch.handoverWaitSeconds !== undefined) {
      await prisma.$executeRaw`UPDATE "aichat_settings" SET "handover_wait_seconds" = ${clampHandoverSeconds(patch.handoverWaitSeconds)} WHERE "id" = 'singleton'`
    }
    if (patch.model !== undefined) {
      await prisma.$executeRaw`UPDATE "aichat_settings" SET "model" = ${patch.model.trim() || DEFAULT_MODEL} WHERE "id" = 'singleton'`
    }
    if (patch.clearOpenaiApiKey) {
      await prisma.$executeRaw`UPDATE "aichat_settings" SET "openai_api_key_encrypted" = NULL WHERE "id" = 'singleton'`
    } else if (patch.openaiApiKey) {
      const encrypted = encryptSecret(patch.openaiApiKey.trim())
      await prisma.$executeRaw`UPDATE "aichat_settings" SET "openai_api_key_encrypted" = ${encrypted} WHERE "id" = 'singleton'`
    }
    await prisma.$executeRaw`UPDATE "aichat_settings" SET "updated_at" = CURRENT_TIMESTAMP WHERE "id" = 'singleton'`
  } finally {
    invalidateSettings()
  }
}

/** What "Copy from phone assistant" writes, as one statement so a copy is
 *  never half made. `encryptedKey` null leaves the saved key alone. */
export async function saveCopiedSettings(input: { businessName: string; extraInstructions: string; emailSignature: string | null; encryptedKey: string | null }): Promise<void> {
  await ensureRow()
  try {
    await prisma.$executeRaw`
      UPDATE "aichat_settings" SET
        "business_name" = ${input.businessName.trim()},
        "extra_instructions" = ${input.extraInstructions.trim()},
        "email_signature" = COALESCE(${input.emailSignature?.trim() ?? null}::text, "email_signature"),
        "openai_api_key_encrypted" = COALESCE(${input.encryptedKey}::text, "openai_api_key_encrypted"),
        "copied_from_phone_at" = CURRENT_TIMESTAMP,
        "updated_at" = CURRENT_TIMESTAMP
      WHERE "id" = 'singleton'
    `
  } finally {
    invalidateSettings()
  }
}
