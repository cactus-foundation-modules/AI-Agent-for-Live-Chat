-- AI Agent for Live Chat - the products a chat was about, and texts.
-- Existing installs ran 001 before these columns were in it; a fresh install
-- already has them from 001, so every statement here does nothing there.
-- Idempotent: safe to run again on top of itself.

-- The products and variations a chat has been about ([{id, url, parentId}],
-- newest last, ten at most): what a note of the chat or a text lists when the
-- model does not say which.
ALTER TABLE "aichat_conversations" ADD COLUMN IF NOT EXISTS "discussed_products" JSONB NOT NULL DEFAULT '[]'::jsonb;

-- Texts this chat has sent, capped like its emails.
ALTER TABLE "aichat_conversations" ADD COLUMN IF NOT EXISTS "texts_sent" INTEGER NOT NULL DEFAULT 0;

-- The hourly limits now count texts as well as failed order checks and emails.
ALTER TABLE "aichat_rate_events" DROP CONSTRAINT IF EXISTS "aichat_rate_events_kind_check";
ALTER TABLE "aichat_rate_events" ADD CONSTRAINT "aichat_rate_events_kind_check" CHECK ("kind" IN ('failed_check', 'email', 'text'));
