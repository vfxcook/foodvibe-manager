# FoodVibe Manager

The team dashboard for **FoodVibe** (FOODVIBE.md §15): overview stats,
signups chart, live seller map with user-area density, users & sellers
tables, a reports moderation queue, a manual push composer, and admin
management — as a **static website**, not a second mobile app.

**Live site:** https://vfxcook.github.io/foodvibe-manager/

## Security model

- The browser holds **only the Supabase anon key + the signed-in admin's
  own session**. There is **no service-role key in the browser, ever.**
- Every read and action goes through security-definer RPCs created by
  `supabase/migration_005_admin.sql`. Each one first checks
  `is_admin()` — true only when the caller's auth email is in the
  `admins` allowlist table — and raises `not authorized` otherwise.
- Manual pushes go through the `admin-push` Edge Function, which
  verifies the caller's JWT, re-checks the `admins` table with the
  service role **inside the function**, and only then sends via FCM.

## How admin access works

- Admins are an **email allowlist** (table `admins`). The seeded root
  admin is **itsvfxcook@gmail.com** (Frame).
- When a person signs in (app or dashboard) with an approved email,
  they are an admin immediately — `is_admin()` checks the signed-in
  email live, and `profiles.is_admin` is kept in sync by triggers as a
  mirror flag.
- Only an existing admin can add/remove admin emails, from the
  dashboard's **Admins** page. Removing an email revokes access at once.
- Two guards can never be bypassed: the **root admin cannot be
  removed**, and the **last remaining admin cannot be removed** — the
  dashboard can never lock everyone out.
- Sign-in uses the same providers as the app: **Google** and
  **email code** (Supabase Auth). A signed-in non-admin sees a clear
  "not an admin" page, nothing else.

## Setup (one-time, in this order)

1. **Apply migration 006** (route sellers — from the app repo,
   `foodvibe/supabase/migration_006_route_sellers.sql`) if not already
   applied.
2. **Apply `supabase/migration_005_admin.sql`** from this repo in the
   Supabase SQL editor (project `foodvibe`, ref
   `rpkuqyxeyelvsylrytvk`). It creates the `admins` table + root seed,
   `is_admin()`, `profiles.is_admin` sync, `sellers.suspended`,
   `reports.status`, the suspension-aware `nearby_sellers`, and all
   `admin_*` RPCs. Idempotent — safe to re-run.
3. **Deploy the `admin-push` Edge Function** from
   `supabase/functions/admin-push/index.ts` (dashboard: Edge Functions
   → Deploy a new function → name it exactly `admin-push`, paste the
   source, deploy with the default *Verify JWT* **ON**). It reuses the
   `FCM_SERVICE_ACCOUNT_JSON` secret already set for `push-notify`.
   Until this is deployed, every other dashboard feature works; only
   the Push tab will report a 404.
4. **Auth redirect:** GitHub Pages origin
   `https://vfxcook.github.io` must be allowed for Google sign-in —
   Supabase Auth → URL Configuration → Redirect URLs should include
   `https://vfxcook.github.io/foodvibe-manager/` (site URL / wildcard
   `https://vfxcook.github.io/**` also works).
5. Open the live site, sign in as the root admin, add the team's
   emails under **Admins**.

## What's inside

| Path | What |
|---|---|
| `index.html`, `app.js`, `style.css` | The dashboard (no build step; supabase-js v2 + Leaflet via CDN, OpenStreetMap tiles) |
| `assets/app_icon.png` | FoodVibe icon (favicon + header logo) |
| `supabase/migration_005_admin.sql` | Admins, suspension, RPCs — **file only in this repo; applied by hand in the SQL editor** |
| `supabase/functions/admin-push/index.ts` | Manual-push Edge Function — **source only; deployed by hand** |

## Dashboard tour

- **Overview** — total users, signups today / last 7 days, sellers
  live now, total purchases, average rating, open reports, and a
  30-day signups bar chart (`admin_overview`, `admin_signups_by_day`).
  "Today" is Asia/Kolkata.
- **Live map** — pins for sellers live right now, plus soft heat
  circles for user density. Density comes from `admin_area_density`,
  which aggregates buyers' (already ~1 km-rounded) alert areas into
  ~2.5 km grid cells — **individual buyers are never mapped**
  (FOODVIBE.md §13 privacy rule).
- **Users / Sellers** — full tables; sellers can be **Suspended** /
  **Reinstated**. A suspended seller instantly disappears from the
  app's Explore (`nearby_sellers` honours `sellers.suspended`).
- **Reports** — the moderation queue (fraud / wrong information / bad
  behaviour / other, with the reporter's note). Actions: **Dismiss**,
  **Suspend seller** (marks the report actioned), **Reinstate seller**.
- **Push** — send a manual notification to **all opted-in users**,
  opted-in users in **one area** (lat/lng + radius around their saved
  alert area), or **one seller**. Shows matched / sent / failed counts
  returned by `admin-push`.
- **Admins** — list, add by email, remove (root/last-admin guards
  surface as clear messages).

## Local development

No build step. Serve the folder with any static server, e.g.
`python3 -m http.server 8080`, and open `http://localhost:8080`
(add that origin to Supabase Auth redirect URLs if you sign in locally).
