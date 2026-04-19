-- Migration 002 — add layout_json column to schedule_overrides for the
-- compact (multi-section) PDF layout.
--
-- Run against live D1 (once):
--   wrangler d1 execute shaareiavodah --remote --file=migrations/002_schedule_layout.sql
-- Local:
--   wrangler d1 execute DB --local --file=migrations/002_schedule_layout.sql
--
-- Shape (when set):
--   {
--     "mode": "compact",
--     "title": "חג הפסח",                 -- replaces the parsha/label title
--     "sections": [
--       { "title": "...", "subtitle": "...", "startDate": "YYYY-MM-DD", "endDate": "YYYY-MM-DD" },
--       ...
--     ]
--   }
-- Null/absent → use the default (single-page, full-width) layout.

ALTER TABLE schedule_overrides ADD COLUMN layout_json TEXT;
