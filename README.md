# ChoreWars

Shared house-cleaning rotations, volunteering and a friendly weekly league for a six-person house. Built from `spec.md` (V3).

**Stack:** React 19 + TypeScript + Vite + Tailwind v4 · Supabase (Postgres, Auth, Realtime) · PWA · Vercel.

All rules that matter (points, rotation advancement, volunteer claiming, streaks, achievements, cooldowns) live in Postgres functions in `supabase/migrations`. The browser never sends a points value; it only calls RPCs like `complete_cleaning(area_id)`.

---

## 1. One-time setup

### Create the Supabase project
1. Go to <https://supabase.com/dashboard> → **New project** (free tier is fine). Pick a region close to the house.
2. Note the **Project ref** (in the URL: `https://supabase.com/dashboard/project/<ref>`).
3. In **Project Settings → API**, copy the **Project URL** and the **anon public** key.

### Configure the app
```bash
cp .env.example .env         # then paste the URL + anon key into .env (not into .env.example)
npm install
```
`VITE_SUPABASE_URL` must be the **API URL** shown under Project Settings → API (`https://<ref>.supabase.co`), not the dashboard link.

### Apply the database (schema, functions, RLS, realtime, seed)
```bash
npx supabase login           # opens the browser once
npx supabase link --project-ref <ref>
npx supabase db push --include-seed
```
The seed creates:
- House "Our House" (timezone `Asia/Kolkata`, week starts Monday, 4-hour re-flag cooldown)
- Members Thomas (admin), Vinil, Akshay, Stebin, Jesvin, Albert
- Areas Kitchen, Sink, Hall, Bathroom A (Thomas/Vinil/Albert), Bathroom B (Stebin/Jesvin/Akshay) with the rotations from the spec

**Logins:** every seeded member signs in as `<firstname>@house.local` with password `chorewars`. Everyone should change it from **Profile → Change password** on first login.

> If `db push --include-seed` complains about `auth.users`, run the contents of `supabase/seed.sql` in the dashboard **SQL Editor** instead — it is idempotent.

### Enable realtime (usually already on)
The migration adds the tables to the `supabase_realtime` publication. If live updates don't arrive, check **Database → Replication** and make sure the publication includes `cleaning_area_state` etc.

---

## 2. Run locally
```bash
npm run dev          # http://localhost:5173
npm run typecheck
npm run build        # production build in dist/
```

---

## 3. Deploy to Vercel
1. Push this repo to GitHub.
2. Vercel → **New Project** → import the repo. Framework preset: **Vite**.
3. Add environment variables `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY`.
4. Deploy. `vercel.json` already rewrites all routes to `index.html` for client-side routing.
5. In Supabase → **Authentication → URL Configuration**, add the Vercel URL to **Site URL** / **Redirect URLs**.

Open the Vercel URL on a phone and "Add to Home Screen" — it installs as a PWA.

---

## 4. Everyday admin tasks

| Task | Where |
|---|---|
| Add a new housemate | Supabase → Authentication → Users → **Add user** (email + password), then app → Admin → Members → Add member (same email) |
| Change rotation order / who's up | Admin → Areas → tap area → drag order with arrows, tap a number to set current turn |
| Change intervals, points, grace, cooldown | Admin → Areas → tap area |
| Timezone / week start / bonuses | Admin → Settings |
| Remove an area | Admin → Areas → tap area → Remove (history is kept; it can be restored) |

---

## 5. How the rules map to code

| Spec | Implementation |
|---|---|
| Fresh / Due Soon / Ready / Attention computed on read | `src/lib/status.ts` (`computeStatus`) — pure function of `last_cleaned_at` + thresholds; nothing stored |
| Needs Cleaning + 4h reactivation cooldown | `mark_needs_cleaning()` |
| Atomic volunteer claim after grace period | `claim_volunteer()` — single conditional `UPDATE … WHERE activation_state='active' AND volunteer_user_id IS NULL AND now() >= activated_at + grace RETURNING` |
| Scheduled person can always complete (even after a claim) | `complete_cleaning()` — scheduled user → `normal`; volunteer → `volunteer`; claim simply cleared |
| Points ledger, weekly/monthly/all-time derived | `user_points_ledger` + `get_leaderboard(period)`, `get_user_stats()` sum over the house-week/month window |
| Week boundary in house timezone | `house_week_start()` reads `house_settings.timezone` and `week_start_day` |
| Weekly champion snapshot | `award_weekly_champions()` — idempotent; called lazily by the leaderboard RPC and hourly by pg_cron when available |
| Streak: per-user, global, only broken by a rescue | inside `complete_cleaning()` (`user_streaks`) |
| Achievements evaluated in the same transaction | `evaluate_achievements()` called from `complete_cleaning()` |
| RLS: members read, nobody writes directly | `20260913000003_rls_realtime.sql` |

---

## 6. Test checklist (spec §45)
Run these by hand with two browsers signed in as different people:

- [ ] Normal cleaning: Thomas flags Kitchen, marks done → completion recorded, +10, Kitchen Fresh, Vinil next, other areas unchanged.
- [ ] Early activation: flag an area cleaned yesterday → becomes active immediately; completion allowed.
- [ ] No automatic failure: let an area pass its expected interval → status changes, nobody loses anything.
- [ ] Volunteer eligibility: before grace the button is hidden and the RPC rejects (`grace_period`); after grace it works. (Temporarily set grace to 0 hours on an area to test quickly.)
- [ ] Volunteer race: two people tap Volunteer at once → exactly one wins, the other sees "Someone else just volunteered".
- [ ] Volunteer completion: Vinil rescues Thomas's task → scheduled=Thomas, cleaner=Vinil, +12 to Vinil, Thomas's streak reset, rotation advances to Vinil.
- [ ] Scheduled completes after claim: Thomas marks done after Vinil claimed → normal completion by Thomas, Vinil's claim cleared, no points to Vinil.
- [ ] Reactivation cooldown: complete at 9:00, try to flag at 10:00 → rejected until 13:00.
- [ ] Duplicate completion: two tabs tap Complete → one succeeds, the other gets `not_active`.
- [ ] Realtime: complete in one browser, the other updates without refresh.
- [ ] Point security: calling `supabase.from('user_points_ledger').insert(...)` from the console → RLS rejects.
