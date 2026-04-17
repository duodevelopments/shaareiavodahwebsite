-- Migration 001 — split subscribers.name into first_name/last_name, add tags CSV.
--
-- Run against live D1 (once):
--   wrangler d1 execute shaarei-avodah --remote --file=migrations/001_subscriber_names_tags.sql
-- Local:
--   wrangler d1 execute shaarei-avodah --local --file=migrations/001_subscriber_names_tags.sql
--
-- SQLite has no "ADD COLUMN IF NOT EXISTS". If you're re-running after a partial
-- apply, comment out lines that have already succeeded.

ALTER TABLE subscribers ADD COLUMN first_name TEXT;
ALTER TABLE subscribers ADD COLUMN last_name TEXT;
ALTER TABLE subscribers ADD COLUMN tags TEXT NOT NULL DEFAULT '';

-- Backfill: everyone still active was signed up for the weekly email.
UPDATE subscribers
  SET tags = 'Weekly'
  WHERE unsubscribed_at IS NULL
    AND (tags = '' OR tags IS NULL);

-- Best-effort split of the legacy single `name` field on the first space.
-- Fix edge cases (middle names, etc.) by hand in the admin UI afterward.
UPDATE subscribers
  SET first_name = TRIM(
        substr(
          name,
          1,
          CASE WHEN instr(name, ' ') = 0 THEN length(name) ELSE instr(name, ' ') - 1 END
        )
      ),
      last_name = TRIM(
        substr(
          name,
          CASE WHEN instr(name, ' ') = 0 THEN length(name) + 1 ELSE instr(name, ' ') + 1 END
        )
      )
  WHERE name IS NOT NULL
    AND first_name IS NULL;
