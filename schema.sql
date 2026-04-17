-- Shaarei Avodah weekly schedule app — D1 schema.
--
-- We only persist what CAN'T be recomputed from the rules engine:
--   * per-span overrides (manual time edits for a specific week/holiday span)
--   * publish status
--   * announcements (scheduled ahead; automatically surface on matching weeks)
--
-- Rule-derived times and zmanim are always freshly computed at read time, so
-- editing rules-seed.js propagates to every un-edited cell automatically.

CREATE TABLE IF NOT EXISTS schedule_overrides (
  start_date    TEXT NOT NULL,   -- 'YYYY-MM-DD', span start
  end_date      TEXT NOT NULL,   -- 'YYYY-MM-DD', span end
  overrides_json TEXT NOT NULL DEFAULT '{}',
  -- Shape: { "2026-04-24": { "mincha": "18:30" }, "2026-04-25": { "shacharis": "09:00" } }
  -- Keys are ISO dates within the span; values are { minyan_name: "HH:MM" }.
  status        TEXT NOT NULL DEFAULT 'draft',  -- draft | published | sent
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  PRIMARY KEY (start_date, end_date)
);

CREATE TABLE IF NOT EXISTS announcements (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  show_from     TEXT NOT NULL,     -- 'YYYY-MM-DD' inclusive
  show_until    TEXT NOT NULL,     -- 'YYYY-MM-DD' inclusive
  kind          TEXT NOT NULL,     -- mazel_tov | kiddush | bar_mitzvah | yahrzeit | general
  text          TEXT NOT NULL,     -- may be empty string when attachment_id is set
  attachment_id INTEGER,           -- FK into attachments.id; NULL = no attachment
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_announcements_range
  ON announcements(show_from, show_until);

CREATE TABLE IF NOT EXISTS subscribers (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  email       TEXT UNIQUE,          -- null if SMS-only subscriber
  phone       TEXT UNIQUE,          -- E.164 format, e.g. +13135551234; null if email-only
  first_name  TEXT,
  last_name   TEXT,
  tags        TEXT NOT NULL DEFAULT '',  -- CSV, e.g. "Weekly,Events". Query with (','||tags||',') LIKE '%,Weekly,%'
  token       TEXT NOT NULL,        -- random token for unsubscribe link
  subscribed_at  TEXT NOT NULL,
  unsubscribed_at TEXT              -- null = active (global opt-out — separate from tag membership)
);

-- Migration for DBs created before the first_name/last_name/tags split.
-- Safe to re-run: ALTER TABLE ADD COLUMN is idempotent via IF NOT EXISTS only in newer SQLite,
-- so run these individually and ignore "duplicate column" errors on re-runs.
--   ALTER TABLE subscribers ADD COLUMN first_name TEXT;
--   ALTER TABLE subscribers ADD COLUMN last_name TEXT;
--   ALTER TABLE subscribers ADD COLUMN tags TEXT NOT NULL DEFAULT '';
--   UPDATE subscribers SET tags = 'Weekly' WHERE unsubscribed_at IS NULL AND (tags = '' OR tags IS NULL);
--   UPDATE subscribers
--     SET first_name = TRIM(substr(name, 1, CASE WHEN instr(name,' ')=0 THEN length(name) ELSE instr(name,' ')-1 END)),
--         last_name  = TRIM(substr(name, CASE WHEN instr(name,' ')=0 THEN length(name)+1 ELSE instr(name,' ')+1 END))
--     WHERE name IS NOT NULL AND first_name IS NULL;

CREATE TABLE IF NOT EXISTS send_log (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  start_date    TEXT NOT NULL,
  end_date      TEXT NOT NULL,
  sent_at       TEXT NOT NULL,
  recipient_count INTEGER NOT NULL,
  test_only     INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS attachments (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  token       TEXT NOT NULL UNIQUE,    -- random token used in the public URL Twilio fetches
  filename    TEXT NOT NULL,
  mime_type   TEXT NOT NULL,
  data        BLOB NOT NULL,
  created_at  TEXT NOT NULL
);
