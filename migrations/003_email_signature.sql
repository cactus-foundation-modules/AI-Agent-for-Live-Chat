-- AI Agent for Live Chat - the assistant's own email signature.
-- Existing installs ran 001 before this column was in it; a fresh install
-- already has it from 001, so the ALTER does nothing there.
-- Idempotent: safe to run again on top of itself.

-- The sign-off on the notes the assistant emails, as the phone assistant has.
ALTER TABLE "aichat_settings" ADD COLUMN IF NOT EXISTS "email_signature" TEXT NOT NULL DEFAULT '';

-- A site that already signs the phone assistant's emails starts with the same
-- signature here, once: only while this one is still empty, and only where the
-- phone assistant's table and column exist. Read from the database, never by
-- importing the other module, so a site without it is untouched.
DO $$
BEGIN
  IF to_regclass('public.acall_settings') IS NOT NULL
     AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'acall_settings' AND column_name = 'email_signature') THEN
    EXECUTE $sql$
      UPDATE "aichat_settings" a
      SET "email_signature" = p."email_signature", "updated_at" = CURRENT_TIMESTAMP
      FROM "acall_settings" p
      WHERE a."id" = 'singleton' AND p."id" = 'singleton'
        AND a."email_signature" = '' AND p."email_signature" <> ''
    $sql$;
  END IF;
END
$$;
