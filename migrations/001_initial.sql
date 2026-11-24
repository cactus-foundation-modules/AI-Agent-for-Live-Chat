-- AI Agent for Live Chat - initial migration
-- Table prefix: aichat_
-- Applied once by the Cactus module migration runner during build. Every
-- statement is idempotent, so running it again on top of itself does nothing.

-- ---------------------------------------------------------------------------
-- Settings (singleton). Who the assistant is, when it answers, and the OpenAI
-- key it thinks with.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "aichat_settings" (
    "id"                       TEXT         NOT NULL DEFAULT 'singleton',
    --   off   - Live Chat behaves exactly as though this module were not here
    --   staff - only a signed-in colleague's own test chats are answered
    --   on    - visitors are answered, by the rules in lib/routing.ts
    "mode"                     TEXT         NOT NULL DEFAULT 'off',
    -- The "<name> first" switch beside Live Chat's Online switch. On: the
    -- assistant answers new messages even while colleagues are online.
    "ai_first"                 BOOLEAN      NOT NULL DEFAULT false,
    -- What visitors see it called. It only ever calls itself a digital
    -- assistant, whatever the name.
    "assistant_name"           TEXT         NOT NULL DEFAULT 'Assistant',
    "business_name"            TEXT         NOT NULL DEFAULT '',
    -- Owner's own rules, appended to the built-in instructions.
    "extra_instructions"       TEXT         NOT NULL DEFAULT '',
    "language"                 TEXT         NOT NULL DEFAULT 'en',
    -- How long a chat handed to a colleague waits for one before the
    -- assistant comes back, apologises and takes a name and email.
    "handover_wait_seconds"    INTEGER      NOT NULL DEFAULT 180,
    -- A plain string rather than a CHECK: OpenAI names a new model every few
    -- months and a site should not wait for a release to use it.
    "model"                    TEXT         NOT NULL DEFAULT 'gpt-6-luna',
    -- AES-GCM ciphertext (lib/crypto/secrets). Null while the key comes from
    -- the OPENAI_API_KEY env var instead, or there is none.
    "openai_api_key_encrypted" TEXT,
    -- When "Copy from phone assistant" was last pressed. A one-off copy: the
    -- two assistants are independent afterwards.
    "copied_from_phone_at"     TIMESTAMP(3),
    "updated_at"               TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "aichat_settings_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "aichat_settings_mode_check" CHECK ("mode" IN ('off', 'staff', 'on'))
);

INSERT INTO "aichat_settings" ("id") VALUES ('singleton') ON CONFLICT ("id") DO NOTHING;

-- ---------------------------------------------------------------------------
-- One row per Live Chat conversation the assistant has had anything to do
-- with: who is answering it, and the bookkeeping of answering it. Goes when
-- the chat goes.
--
-- state (see lib/routing.ts for every move between them):
--   auto        - follows the site rules (Online switch, "<name> first")
--   assistant   - a colleague handed it to the assistant
--   colleague   - a colleague took over; the assistant stays out of it
--   waiting     - the assistant asked for a colleague and is waiting
--   not_genuine - spam or time-wasting spotted; asking for name and email
--   quiet       - the assistant has stepped back from this chat for good
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "aichat_conversations" (
    "conversation_id"        TEXT         NOT NULL,
    "state"                  TEXT         NOT NULL DEFAULT 'auto',
    -- The visitor is owed an apology and a request for their details: set when
    -- a hand-over ran out, and passed to the model on its next turn.
    "callback_wanted"        BOOLEAN      NOT NULL DEFAULT false,
    -- Recorded when the message is offered, because only that request knows:
    -- whether the sender is a signed-in colleague testing (Staff only mode),
    -- and which signed-in member they are, if any.
    "staff"                  BOOLEAN      NOT NULL DEFAULT false,
    "member_id"              TEXT,
    "member_email"           TEXT,
    -- Live Chat's Online switch as it stood at the newest offer.
    "colleagues_online"      BOOLEAN      NOT NULL DEFAULT false,
    -- chat_messages ids. Taken = the newest visitor message the assistant
    -- agreed to answer; handled = the newest it has answered. A turn runs
    -- while taken is ahead of handled.
    "last_taken_message_id"  BIGINT       NOT NULL DEFAULT 0,
    "last_handled_message_id" BIGINT      NOT NULL DEFAULT 0,
    -- One turn at a time per chat. A claim is a lease: a crashed turn frees
    -- the chat when it runs out. Pending = a message arrived mid-turn.
    "processing_until"       TIMESTAMP(3),
    "pending"                BOOLEAN      NOT NULL DEFAULT false,
    -- The not-genuine flow: how many times the visitor has been asked for a
    -- name and email (three at most), and why the chat was flagged.
    "not_genuine_asks"       INTEGER      NOT NULL DEFAULT 0,
    "not_genuine_reason"     TEXT,
    -- While waiting for a colleague: since when, and until when.
    "waiting_since"          TIMESTAMP(3),
    "waiting_until"          TIMESTAMP(3),
    -- {"input": n, "cached": n, "output": n, "turns": n} - OpenAI tokens spent.
    "usage"                  JSONB        NOT NULL DEFAULT '{}'::jsonb,
    -- [{tool, at, ms, args, ok}] - what the assistant did in this chat.
    "tool_log"               JSONB        NOT NULL DEFAULT '[]'::jsonb,
    -- Orders the visitor has proved are theirs in this chat (order numbers),
    -- by the postcode check or as the signed-in member they belong to. Only
    -- these may be talked about, emailed about or have a request raised.
    "verified_orders"        JSONB        NOT NULL DEFAULT '[]'::jsonb,
    -- Order checks in this chat that did not match. Three and it stops trying.
    "failed_order_checks"    INTEGER      NOT NULL DEFAULT 0,
    -- Emails this chat has sent (order links, notes of the chat, quotes).
    "emails_sent"            INTEGER      NOT NULL DEFAULT 0,
    -- A written overview for colleagues, made when Notes is opened, and the
    -- newest chat_messages id it covered: reused until a newer message comes.
    "overview"               TEXT         NOT NULL DEFAULT '',
    "overview_message_id"    BIGINT       NOT NULL DEFAULT 0,
    "created_at"             TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"             TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "aichat_conversations_pkey" PRIMARY KEY ("conversation_id"),
    CONSTRAINT "aichat_conversations_chat_fkey" FOREIGN KEY ("conversation_id") REFERENCES "chat_conversations"("id") ON DELETE CASCADE,
    CONSTRAINT "aichat_conversations_state_check" CHECK ("state" IN ('auto', 'assistant', 'colleague', 'waiting', 'not_genuine', 'quiet'))
);

-- The hand-over sweep looks for waiting chats past their deadline.
CREATE INDEX IF NOT EXISTS "aichat_conversations_waiting_idx"
    ON "aichat_conversations" ("waiting_until") WHERE "state" = 'waiting';

-- ---------------------------------------------------------------------------
-- Visitors who asked to be got back to. Kept even when the chat is deleted,
-- because the callback is still owed.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "aichat_callbacks" (
    "id"              TEXT         NOT NULL DEFAULT gen_random_uuid()::text,
    "conversation_id" TEXT,
    "name"            TEXT         NOT NULL DEFAULT '',
    "email"           TEXT         NOT NULL,
    "about"           TEXT         NOT NULL DEFAULT '',
    -- tool (the model took the details) | not_genuine (the fixed-text flow)
    "source"          TEXT         NOT NULL DEFAULT 'tool',
    "handled"         BOOLEAN      NOT NULL DEFAULT false,
    "created_at"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "aichat_callbacks_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "aichat_callbacks_created_idx" ON "aichat_callbacks" ("created_at" DESC);

-- ---------------------------------------------------------------------------
-- Questions the assistant had no answer for: the FAQs and pages worth adding.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "aichat_unanswered" (
    "id"              TEXT         NOT NULL DEFAULT gen_random_uuid()::text,
    "conversation_id" TEXT,
    "question"        TEXT         NOT NULL,
    "resolved"        BOOLEAN      NOT NULL DEFAULT false,
    "created_at"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "aichat_unanswered_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "aichat_unanswered_created_idx" ON "aichat_unanswered" ("created_at" DESC);

-- ---------------------------------------------------------------------------
-- What one visitor has done in the last hour, across all their chats: failed
-- order checks and emails sent, so opening a fresh chat does not reset the
-- limits. Keyed on Live Chat's visitor id when the chat has one, otherwise on
-- the chat itself ("visitor:<id>" / "chat:<id>"). Rows older than a day are
-- pruned as new ones are written; nothing here outlives the hour it counts.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "aichat_rate_events" (
    "id"          TEXT         NOT NULL DEFAULT gen_random_uuid()::text,
    "visitor_key" TEXT         NOT NULL,
    --   failed_check - an order check that did not match
    --   email        - an email sent to the visitor
    "kind"        TEXT         NOT NULL,
    "created_at"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "aichat_rate_events_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "aichat_rate_events_kind_check" CHECK ("kind" IN ('failed_check', 'email'))
);

CREATE INDEX IF NOT EXISTS "aichat_rate_events_lookup_idx"
    ON "aichat_rate_events" ("visitor_key", "kind", "created_at");
