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
