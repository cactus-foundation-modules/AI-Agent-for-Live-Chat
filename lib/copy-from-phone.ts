import { prisma } from '@/lib/db/prisma'
import { encryptSecret, tryDecryptSecret } from '@/lib/crypto/secrets'
import { getModuleMailSettings, setModuleCopyInbox, setModuleSender } from '@/modules/unified-inbox/lib/module-senders'
import { MODULE_NAME } from './constants'
import { saveCopiedSettings } from './settings'

// ---------------------------------------------------------------------------
// "Copy from phone assistant": a site that already set up the AI Call
// Answering module copies its business name, extra instructions, email
// signature, OpenAI key and sending address across in one go. Once - the two are independent
// afterwards, so changing one never changes the other.
//
// Nothing of the phone module is imported. Whether it is here is a question
// for the database (does acall_settings exist?), and its row is read with one
// plain SELECT, so this module builds and runs exactly the same on a site
// without it.
// ---------------------------------------------------------------------------

const PHONE_MODULE = 'ai-call-answering'

/** Whether the phone assistant's settings table is on this site. */
export async function phoneAssistantInstalled(): Promise<boolean> {
  const rows = await prisma.$queryRaw<Array<{ present: boolean }>>`
    SELECT to_regclass('public.acall_settings') IS NOT NULL AS "present"
  `
  return rows[0]?.present === true
}

type PhoneRow = { business_name: unknown; extra_instructions: unknown; openai_api_key_encrypted: unknown; email_signature: unknown }

export type CopyResult = { copied: true; key: boolean; sender: boolean } | { copied: false; reason: string }

export async function copyFromPhoneAssistant(): Promise<CopyResult> {
  if (!(await phoneAssistantInstalled())) return { copied: false, reason: 'The phone assistant is not installed on this site.' }
  // to_jsonb, so a phone module old enough to have no signature column reads
  // as none rather than failing the whole copy.
  const rows = await prisma.$queryRaw<PhoneRow[]>`
    SELECT "business_name", "extra_instructions", "openai_api_key_encrypted", to_jsonb(s) ->> 'email_signature' AS "email_signature"
    FROM "acall_settings" s WHERE "id" = 'singleton' LIMIT 1
  `
  const row = rows[0]
  if (!row) return { copied: false, reason: 'The phone assistant has not been set up yet, so there is nothing to copy.' }

  // Decrypted and encrypted again rather than copied as it stands, so the copy
  // is ours and a later change of format on the phone side cannot reach it.
  const key = tryDecryptSecret(typeof row.openai_api_key_encrypted === 'string' ? row.openai_api_key_encrypted : null)
  await saveCopiedSettings({
    businessName: typeof row.business_name === 'string' ? row.business_name : '',
    extraInstructions: typeof row.extra_instructions === 'string' ? row.extra_instructions : '',
    emailSignature: typeof row.email_signature === 'string' ? row.email_signature : null,
    encryptedKey: key ? encryptSecret(key) : null,
  })

  // The sending address lives with the Unified Inbox, one setting per module.
  const mail = await getModuleMailSettings(PHONE_MODULE)
  if (mail.inboxId) await setModuleSender(MODULE_NAME, mail.inboxId)
  if (mail.copyInboxId) await setModuleCopyInbox(MODULE_NAME, mail.copyInboxId)

  return { copied: true, key: !!key, sender: !!(mail.inboxId || mail.copyInboxId) }
}
