// GET/PATCH /api/m/ai-agent-for-live-chat/admin/settings - the module's settings.
import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { errorResponse } from '@/lib/utils'
import { requirePermission } from '@/modules/ai-agent-for-live-chat/lib/admin-auth'
import { MESSAGE_LABEL, MODES, PERM_MANAGE } from '@/modules/ai-agent-for-live-chat/lib/constants'
import { phoneAssistantInstalled } from '@/modules/ai-agent-for-live-chat/lib/copy-from-phone'
import { getSettings, updateSettings } from '@/modules/ai-agent-for-live-chat/lib/settings'
import {
  ASSISTANT_NAME_MAX,
  BUSINESS_NAME_MAX,
  EXTRA_INSTRUCTIONS_MAX,
  HANDOVER_WAIT_MAX_SECONDS,
  HANDOVER_WAIT_MIN_SECONDS,
  EMAIL_SIGNATURE_MAX,
  LANGUAGE_CHOICES,
  MODEL_CHOICES,
} from '@/modules/ai-agent-for-live-chat/lib/settings-model'

async function currentState() {
  const [settings, phoneAvailable] = await Promise.all([getSettings(), phoneAssistantInstalled().catch(() => false)])
  return {
    mode: settings.mode,
    aiFirst: settings.aiFirst,
    assistantName: settings.assistantName,
    businessName: settings.businessName,
    extraInstructions: settings.extraInstructions,
    emailSignature: settings.emailSignature,
    language: settings.language,
    handoverWaitSeconds: settings.handoverWaitSeconds,
    model: settings.model,
    // The key itself never goes back to the browser - only whether there is one.
    hasOpenaiApiKey: !!settings.openaiApiKey,
    openaiApiKeyFromEnv: settings.openaiApiKeyFromEnv,
    hasSavedKey: settings.hasSavedKey,
    phoneAvailable,
    copiedFromPhoneAt: settings.copiedFromPhoneAt ? settings.copiedFromPhoneAt.toISOString() : null,
    messageLabel: MESSAGE_LABEL,
    models: MODEL_CHOICES,
    languages: LANGUAGE_CHOICES,
    handoverWaitMinSeconds: HANDOVER_WAIT_MIN_SECONDS,
    handoverWaitMaxSeconds: HANDOVER_WAIT_MAX_SECONDS,
    assistantNameMax: ASSISTANT_NAME_MAX,
    extraInstructionsMax: EXTRA_INSTRUCTIONS_MAX,
    emailSignatureMax: EMAIL_SIGNATURE_MAX,
  }
}

export async function GET() {
  const auth = await requirePermission(PERM_MANAGE)
  if ('response' in auth) return auth.response
  return NextResponse.json(await currentState(), { headers: { 'Cache-Control': 'no-store' } })
}

const FIELD_LABELS: Record<string, string> = {
  mode: 'Mode',
  aiFirst: 'Assistant first',
  assistantName: 'Assistant name',
  businessName: 'Business name',
  extraInstructions: 'Extra instructions',
  emailSignature: 'Email signature',
  language: 'Language',
  handoverWaitSeconds: 'Hand-over wait',
  model: 'Thinking model',
  openaiApiKey: 'OpenAI API key',
  clearOpenaiApiKey: 'Clear OpenAI API key',
}

/** Spells out which field failed and why, instead of a blanket "did not make sense". */
function describeIssue(issue: z.ZodIssue): string {
  const key = String(issue.path[0] ?? '')
  const label = FIELD_LABELS[key] ?? (key || 'Settings')
  switch (issue.code) {
    case 'too_big':
      return issue.type === 'string' ? `${label} is too long (${issue.maximum} characters at most).` : `${label} must be ${issue.maximum} or less.`
    case 'too_small':
      return issue.type === 'string' ? `${label} cannot be empty.` : `${label} must be ${issue.minimum} or more.`
    case 'invalid_type':
      return issue.received === 'undefined' || issue.received === 'null' ? `${label} is missing.` : `${label} is the wrong kind of value.`
    default:
      return `${label}: ${issue.message}`
  }
}

const Body = z.object({
  mode: z.enum(MODES).optional(),
  aiFirst: z.boolean().optional(),
  assistantName: z.string().trim().min(1).max(ASSISTANT_NAME_MAX).optional(),
  businessName: z.string().trim().max(BUSINESS_NAME_MAX).optional(),
  extraInstructions: z.string().max(EXTRA_INSTRUCTIONS_MAX).optional(),
  emailSignature: z.string().max(EMAIL_SIGNATURE_MAX).optional(),
  language: z.string().trim().min(1).max(10).optional(),
  handoverWaitSeconds: z.number().int().min(HANDOVER_WAIT_MIN_SECONDS).max(HANDOVER_WAIT_MAX_SECONDS).optional(),
  model: z.string().trim().min(1).max(100).optional(),
  openaiApiKey: z.string().trim().min(1).max(500).optional(),
  clearOpenaiApiKey: z.boolean().optional(),
}).strict()

export async function PATCH(request: NextRequest) {
  const auth = await requirePermission(PERM_MANAGE)
  if ('response' in auth) return auth.response

  const raw = await request.json().catch(() => null)
  if (raw === null || typeof raw !== 'object') return errorResponse('The save request arrived empty or unreadable. Reload the page and try again.')
  const parsed = Body.safeParse(raw)
  if (!parsed.success) {
    const problems = [...new Set(parsed.error.issues.map(describeIssue))]
    return errorResponse(`Could not save: ${problems.join(' ')}`)
  }

  try {
    await updateSettings(parsed.data)
  } catch (cause) {
    console.error('[ai-agent-for-live-chat] could not save settings', cause)
    return errorResponse('Could not save those settings. Check that this site has an encryption key set up.', 500)
  }
  return NextResponse.json(await currentState())
}
