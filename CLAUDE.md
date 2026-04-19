# Shaarei Avodah — project notes

## CRITICAL: Admin path convention

**Every admin-only UI page or API endpoint MUST live under one of these prefixes:**

- `admin/*` — for HTML pages (e.g. `admin/newpage.html`)
- `functions/api/admin/*` — for Pages Functions APIs (e.g. `functions/api/admin/reports.js` → served at `/api/admin/reports`)

Anything under these prefixes is automatically gated by:

1. **Cloudflare Access** at the edge — the Access Application has include rules for `admin/*` and `api/admin/*` on both `shaareiavodah.org` and `shaareiavodah.pages.dev`. **Do NOT add new paths to the Access app for every new admin endpoint** — just put the endpoint under `/api/admin/`.
2. **[functions/_middleware.js](functions/_middleware.js)** — verifies the `Cf-Access-Jwt-Assertion` JWT on those same prefixes as defense-in-depth.

**If you put an admin endpoint outside these prefixes, it will be publicly accessible.** This is a security bug, not a feature.

### Public endpoints (intentionally outside the gated prefixes)

- `/api/subscribe` — public signup form
- `/api/unsubscribe` — email unsubscribe link (token-authenticated)
- `/api/create-checkout` — Stripe donation flow
- `/api/cron/*` — protected by `X-Cron-Secret` header, called by the external `cron-worker`
- `/api/attachment/:token` — serves uploaded MMS media to Twilio (token-authenticated, same pattern as unsubscribe)

Do not add anything else at the top level of `functions/api/` unless it is genuinely public.

## Env / secrets

Local dev: copy `.dev.vars.example` → `.dev.vars`. If `CF_ACCESS_TEAM_DOMAIN` / `CF_ACCESS_AUD` are blank, the middleware logs a one-time warning and bypasses JWT verification — admin pages work locally without Access setup.

Production: set secrets via `wrangler pages secret put` (see the Access setup section below).

## Local dev against production D1

`wrangler pages dev` in wrangler 4 does **not** support remote D1 bindings — it always uses a local SQLite file under `.wrangler/state/v3/d1/`. The old `wrangler pages dev --remote` flag was removed.

To run locally against real production data, snapshot prod into the local SQLite, then run dev normally:

```bash
npm run db:pull-prod   # exports remote D1 → loads into local SQLite
npm run dev
```

Notes:

- This is a **snapshot** — writes made during local dev stay local, and production changes after the pull won't show up until you re-pull.
- `db:pull-prod` loads schema + data, so re-running against an already-populated local DB fails with "table already exists". To refresh, delete `.wrangler/state/v3/d1/` first and re-run.
- The `attachments` table is loaded **schema-only** — MMS image blobs exceed D1's per-statement size limit when re-inserted via `wrangler d1 execute`. Local dev doesn't need the bytes (the MMS flow isn't exercised locally); if a new table is added to prod, add it to the `--table` list in the `db:pull-prod` script.
- Dumps live at `.wrangler/prod-dump.sql` and `.wrangler/prod-dump-schema.sql` (gitignored).
- For testing against live bindings without local snapshotting, deploy to a preview branch instead — Cloudflare builds a preview URL that uses real production bindings.

## Auto-send (Friday weekly + erev YT)

The cron-worker (`cron-worker/`) drives two automatic sends to the `Weekly` tag:

- **Friday weekly send** — fires at the daily 17:00 UTC trigger when `dayOfWeek === 5` (= 1pm EDT / 12pm EST).
- **Erev Yom Tov send** — fires whenever today (America/Detroit) is tagged `erev_yom_tov` by the rules engine, i.e. yom tov begins tonight. Runs from the same daily 17:00 UTC trigger; detection is via `POST /api/cron/holiday-check`.

Both use chunked sends through `POST /api/cron/send-chunk` (10 recipients per chunk). Idempotency is enforced by `send_log` — if a non-test row already exists for the span, subsequent triggers no-op. Friday + erev YT colliding on the same span is safe.

### Kill switch — `AUTO_SEND_ENABLED`

A single env var on the **cron-worker** (not the Pages site) disables BOTH auto-sends. Anything other than the literal string `'false'` (including unset) leaves auto-send enabled.

**To disable:**

```bash
cd cron-worker
wrangler secret put AUTO_SEND_ENABLED
# When prompted, type:  false
```

**To re-enable** — either set it to anything else, or delete the secret:

```bash
cd cron-worker
wrangler secret put AUTO_SEND_ENABLED   # then type: true
# ...or...
wrangler secret delete AUTO_SEND_ENABLED
```

**To check current state:**

```bash
cd cron-worker
wrangler secret list
```

Note: the kill switch only blocks the cron-driven auto-sends. The manual "Send to Tag" button in `/admin/week` still works regardless of this flag — useful for sending after disabling auto-send and wanting to do it by hand instead.

### Manual one-off send

`/admin/week` → "Send to Tag" runs the same chunked send through `POST /api/admin/schedules/send` (gated by Cloudflare Access). Browser drives the loop; progress shown inline. Subject to the same `send_log` idempotency — if you already sent for the span, a second attempt no-ops with an "Already sent" toast.
