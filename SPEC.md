# HOUSE TASKS — WEB APP BUILD SPECIFICATION V3

> V3 changelog (vs V2): resolved 7 ambiguities found during review — see inline **[V3]** markers.
> 1. Added explicit reactivation cooldown to close a point-farming loophole.
> 2. Clarified that claiming a volunteer task does NOT lock out the originally scheduled person.
> 3. Stated explicitly that streaks are per-user, global across all areas (matches the DB model).
> 4. Removed the dangling "explicit missed-task rule" — missed/skipped tracking is deferred to V2 of the app.
> 5. Split cleaning-area status into computed (passive) vs stored (explicit activation) state.
> 6. Weekly/monthly points are derived from the ledger, not stored as mutable counters.
> 7. Added an explicit week-boundary/timezone setting.

## 1. PROJECT OVERVIEW

Build a modern, mobile-first shared web application for managing household cleaning responsibilities among six people living in the same house.

The application should feel like a polished consumer app rather than a corporate task manager.

The core concept is:

> **Cleaning Rotations + Suggested Cleaning Intervals + Fair Responsibility + Volunteering + Friendly Competition**

This is NOT a strict daily or weekly chore scheduler.

The house is cleaned when something actually needs cleaning.

The application helps the household know:

1. What was cleaned last?
2. Who is next in line to clean it?
3. Approximately when might it need cleaning again?
4. Has it likely become due?
5. Who actually completed the cleaning?
6. Who is leading the house competition?

All users must see shared, live data.

---

# 2. HOUSE MEMBERS

There are six household members:

1. Thomas
2. Vinil
3. Akshay
4. Stebin
5. Jesvin
6. Albert

The app should support adding/removing/renaming members later through an admin panel.

---

# 3. CLEANING AREAS

Initial cleaning rotations:

### Common rotations

These rotate among all six members:

* Clean Kitchen
* Clean Sink
* Clean Hall

### Bathroom rotations

There are two bathrooms.

Each bathroom is used by three people.

Example:

Bathroom A:

* Thomas
* Vinil
* Albert

Bathroom B:

* Stebin
* Jesvin
* Akshay

These groups must be configurable by an admin and should not be permanently hardcoded.

Each cleaning area has its own independent rotation.

**[V3 note]** Bathrooms are not a special case in the data model — they are ordinary cleaning areas whose rotation membership happens to be a subset of the six users. No bathroom-specific tables are needed.

---

# 4. IMPORTANT CONCEPT: CLEANING IS NEED-BASED

Do NOT treat every task as a strict deadline.

The house members clean an area when it actually needs cleaning.

For example:

The Hall may usually need cleaning approximately every 7 days.

The Sink may usually need cleaning approximately every 14 days.

The Kitchen may need cleaning every 7–14 days depending on how dirty it becomes.

Therefore, each cleaning area should have:

* A suggested minimum interval
* An expected interval
* Optionally a maximum reminder interval

These are guidelines, not strict deadlines.

Example:

## Hall

Last cleaned:
September 1

Suggested interval:
7 days

Status on September 5:
🟢 Recently cleaned

Status around September 8:
🟡 Probably due

Status on September 12:
🔴 Needs attention

However, users can still clean the Hall earlier or later.

The app must not automatically mark someone as having failed simply because an estimated date has passed.

---

# 5. TASK / CLEANING STATUS

Each cleaning rotation should have a calculated status.

Suggested statuses:

### 🟢 Fresh

The area was cleaned recently.

Example:

"Cleaned 3 days ago"

"Probably does not need cleaning yet."

---

### 🟡 Due Soon

The expected cleaning interval is approaching.

Example:

"Last cleaned 6 days ago"

"Hall may need cleaning soon."

---

### 🟠 Ready for Cleaning

The suggested interval has passed.

Example:

"Last cleaned 8 days ago"

"Check whether the Hall needs cleaning."

The app should NOT assume it is definitely dirty.

---

### 🔴 Needs Attention

The area has gone significantly beyond its usual cleaning interval.

Example:

"Last cleaned 15 days ago"

"Kitchen likely needs cleaning."

Again, this should be a strong reminder, not an automatic punishment.

**[V3 note]** These four statuses are *computed on read* from `last_cleaned_at` and the area's interval configuration — they are never written to the database (see section 29/30). This guarantees the displayed status can never go stale relative to its inputs.

---

# 6. HUMAN JUDGMENT: MARK AS NEEDS CLEANING

This is an important feature.

Any household member should be able to indicate that an area currently needs cleaning.

Example:

Vinil notices the kitchen is dirty.

He opens the Kitchen card and clicks:

[ 🧹 Needs Cleaning ]

The Kitchen becomes active.

The app shows:

> Kitchen needs cleaning.

> Current responsibility: Thomas

Thomas is notified in the app (via the realtime subscription — this is an in-app highlight, not a push notification; push notifications are out of scope for V1, see section 47).

This is better than relying only on dates because the actual condition of the house matters.

**[V3] Reactivation cooldown (anti-farming):** An area cannot be marked "Needs Cleaning" again within a configurable cooldown window after its last completion (default: 4 hours, admin-configurable per area). This closes the loophole where a user could mark → clean → mark → clean in quick succession purely to farm points. The cooldown is enforced server-side; the UI should simply hide/disable the "Needs Cleaning" button and show "Recently cleaned — check back later" during the window.

---

# 7. CLEANING FLOW

Each cleaning area has:

* A rotation
* A current scheduled person
* A last cleaned date
* A suggested interval
* A current status

Example Kitchen rotation:

Thomas → Vinil → Akshay → Stebin → Jesvin → Albert → Thomas

Current scheduled person:

Thomas

Last cleaned:

September 1

On September 10, someone notices it needs cleaning.

They press:

[ NEEDS CLEANING ]

Kitchen now becomes:

### ACTIVE — NEEDS CLEANING

Responsible:

Thomas

Thomas sees prominently:

> 🍳 Kitchen

> It's your turn to clean.

> This area was last cleaned 9 days ago.

[ MARK AS DONE ]

---

# 8. COMPLETING A CLEANING TASK

When the scheduled person completes the cleaning:

1. They press MARK AS DONE.
2. Show a confirmation dialog.
3. Record the cleaning.
4. Award points.
5. Update the last cleaned timestamp.
6. Advance the rotation.
7. Set the cleaning area back to Fresh.
8. Clear the "Needs Cleaning" request.
9. Update all users in realtime.

Example confirmation:

> Mark Kitchen as cleaned?

> +10 points

> Next in rotation: Vinil

[ Cancel ] [ Complete ]

After completion:

> 🎉 Kitchen Cleaned!

> +10 points

> Next up: Vinil

The Kitchen then returns to:

🟢 Fresh

Last cleaned: Just now

Next person: Vinil

---

# 9. ROTATION LOGIC

Every cleaning area has an independent queue.

Example:

## Kitchen

Thomas → Vinil → Akshay → Stebin → Jesvin → Albert

## Hall

Akshay → Stebin → Albert → Thomas → Vinil → Jesvin

## Sink

Jesvin → Thomas → Vinil → Albert → Stebin → Akshay

The exact order can be configured.

When Kitchen is completed:

Only Kitchen advances.

Hall, Sink, Bathroom A, and Bathroom B must remain unchanged.

The next person becomes the next scheduled person only after the current cleaning is completed.

---

# 10. VOLUNTEERING / HELPING

If the scheduled person cannot or does not clean an area, another person can volunteer.

Example:

Kitchen needs cleaning.

Scheduled person:

Thomas

Vinil decides to help.

The app allows:

[ 🙋 Volunteer to Clean ]

After confirmation:

> You're volunteering to clean Kitchen.

> Thomas remains recorded as the scheduled person.

> You will receive Rescue Points when the cleaning is completed.

Vinil becomes the temporary performer.

Important:

The system must distinguish between:

### Scheduled person

The person whose turn it was.

### Actual cleaner

The person who actually cleaned it.

Example database record:

Scheduled person:
Thomas

Actual cleaner:
Vinil

Completion type:
Volunteer / Rescue

---

# 11. ROTATION AFTER A VOLUNTEER COMPLETES

A volunteer must NOT permanently break or unfairly alter the rotation.

Example rotation:

Thomas → Vinil → Akshay → Stebin → Jesvin → Albert

Current scheduled person:

Thomas

Vinil volunteers and cleans instead.

After completion:

The normal rotation advances from Thomas to Vinil.

Therefore:

Next scheduled person = Vinil

This means Thomas's turn is considered consumed because the household's cleaning requirement was fulfilled.

However, the history records:

> Kitchen

> Scheduled: Thomas

> Cleaned by: Vinil 🦸

This is simple, predictable, and fair.

The system should not try to automatically create complicated "Thomas still owes a turn" logic in V1.

---

# 12. VOLUNTEERING SHOULD BE COOPERATIVE, NOT EXPLOITABLE

A person should not be able to steal someone else's active task immediately just to earn points.

Recommended flow:

When an area becomes marked as Needs Cleaning:

### First stage

Only the scheduled person sees:

[ MARK AS DONE ]

Other users see:

"Thomas's turn."

### After a configurable grace period

Other users can see:

[ Volunteer to Clean ]

Default grace period:

24 hours

Admin can configure this.

**[V3] The scheduled person can always complete the task themselves — at any time, before or after the grace period, and even after another user has claimed it as a volunteer.** Claiming a volunteer slot only prevents *other* users from also volunteering; it never locks out the person whose turn it actually is. (Rationale: if Thomas is standing in the kitchen with cleaning supplies the moment Vinil's claim lands, Thomas should not be blocked from finishing what he already started. If Thomas completes it after Vinil claimed, the completion is recorded as a normal completion by Thomas, and Vinil's claim is simply cleared with no rescue points awarded.)

---

# 13. VOLUNTEER CLAIMING

Prevent multiple people from volunteering simultaneously.

Example:

Vinil clicks Volunteer.

The server atomically claims the task.

The task now displays:

> 🙋 Vinil volunteered to clean this.

Other users cannot also claim it.

Vinil can:

[ MARK AS DONE ]

Optionally, a volunteer can release the task if they claimed it accidentally.

Example:

[ Cancel Volunteer ]

This should return responsibility to the original scheduled person.

**[V3 implementation note]** The claim must be a single atomic conditional write — e.g. a Postgres function performing `UPDATE cleaning_area_state SET volunteer_user_id = :user, volunteer_claimed_at = now() WHERE cleaning_area_id = :area AND volunteer_user_id IS NULL RETURNING id`. If Vinil and Albert click at the same instant, exactly one `UPDATE` affects a row; the other returns zero rows and the client shows "already claimed by someone else." Do not implement this as a client-side check-then-write (a `SELECT` followed by a separate `UPDATE`) — that has a race window.

---

# 14. POINTS AND GAMIFICATION

The application should make cleaning feel rewarding and mildly competitive.

However, the cleaning system must remain useful without gamification.

Gamification should be a secondary layer.

Every user should have:

* Total points
* Weekly points
* Monthly points
* Current streak
* Tasks completed
* Tasks rescued
* ~~Tasks missed/skipped, if explicitly recorded~~ **[V3] Deferred to V2** — see section 31.

---

# 15. RECOMMENDED POINT SYSTEM

Initial configurable values:

### Complete your scheduled cleaning

+10 points

### Clean an area before the suggested interval

Optional bonus:
+2 points

Only award this if the area was explicitly marked Needs Cleaning, to prevent people from repeatedly cleaning unnecessarily for points.

### Volunteer / Rescue another person's task

+12 points

Volunteering should be worth slightly more than a normal completion because the person helped the household.

### Streak bonus

Complete several of your scheduled turns successfully.

Example:

3 consecutive scheduled tasks:
+3 bonus

5 consecutive:
+5 bonus

10 consecutive:
Achievement + bonus

**[V3 note]** The streak is per-user and global across all cleaning areas combined (not per-area) — see section 19.

### Marking an area as Needs Cleaning

0 points

Users must never earn points simply for marking things dirty.

---

# 16. IMPORTANT ANTI-POINT-FARMING RULES

Prevent users from gaming the system.

A user must NOT be able to:

* Mark a task as Needs Cleaning repeatedly.
* Earn points for repeatedly cleaning the same area immediately.
* Volunteer before the grace period.
* Claim multiple people's tasks just to farm points.
* Award themselves arbitrary points.
* Edit their own score.

Suggested safeguards:

* Each area can only be completed once while active.
* After completion, the area returns to Fresh.
* It must become active again before another completion earns points.
* **[V3]** An area cannot be reactivated ("Needs Cleaning") within a configurable cooldown window after its last completion — default 4 hours, admin-configurable per area (see section 6).
* All points are calculated server-side.
* The frontend must never send arbitrary points values.

---

# 17. COMPETITION

Create a leaderboard to make the app interesting.

Default leaderboard:

## THIS WEEK

🥇 Thomas — 84 pts
🥈 Vinil — 72 pts
🥉 Albert — 66 pts
4. Akshay — 58 pts
5. Jesvin — 51 pts
6. Stebin — 43 pts

Allow switching between:

* This Week
* This Month
* All Time

Weekly points should be the main competition.

Why?

All-time points can become impossible to catch up with.

Weekly competition gives everyone a fresh chance to win.

**[V3]** "This Week," "This Month," and "All Time" are all computed by summing `user_points_ledger` rows over the relevant date window (see section 29) — none of them are stored as a mutable running total. This keeps a single source of truth and avoids drift between the ledger (the audit trail) and any displayed number.

---

# 18. WEEKLY WINNER

At the end of each week:

The person with the highest weekly score receives:

🏆 Weekly House Champion

This can be stored in their achievements/history.

The next week begins with a fresh weekly leaderboard.

All-time points remain preserved separately.

Potential UI:

> 🏆 Last Week's Champion

> Thomas

> 92 points

**[V3] Week boundary:** the house has a single configured timezone and a week-start day (default Monday 00:00 in that timezone), stored in `house_settings`. All "this week" calculations use this boundary. This must be decided once at setup rather than left implicit, since it affects leaderboard cutovers and the weekly-champion job.

---

# 19. STREAKS

Track successful scheduled cleanings.

**[V3]** A user's streak is a single counter per user, spanning *all* cleaning areas combined — not tracked separately per area. Example:

Thomas successfully completes his scheduled turns:

Kitchen ✓
Hall ✓
Bathroom A ✓

Current streak:

🔥 3

It does not matter that these were three different areas — each successful scheduled completion (by that user, as the scheduled person, not as a volunteer) increments the same counter. This matches the `user_streaks` table in the data model, which has one row per user.

If Thomas's task is completed by a volunteer instead, Thomas's scheduled streak breaks (resets to 0). Only a volunteer-rescue of *his* scheduled task breaks it — the passage of time alone never breaks a streak, consistent with section 31.

However, do not make streaks overly punishing.

A missed or rescued task breaks the streak but does not erase other statistics.

---

# 20. ACHIEVEMENTS

Add lightweight achievements.

Examples:

### 🧹 First Clean

Complete your first cleaning.

### 🔥 On Fire

Reach a 5-task streak.

### 🦸 House Hero

Rescue 3 tasks.

### 💪 Reliable

Complete 20 scheduled tasks.

### 👑 Weekly Champion

Finish #1 for a week.

### ⚡ Quick Cleaner

Complete a task soon after it was marked Needs Cleaning.

### 🏠 House Legend

Complete 100 cleanings.

Achievements should be rewarding but not intrusive.

**[V3 implementation note]** Achievement criteria must be (re-)evaluated inside the same server-side transaction/RPC that records a completion, not as a separate async pass — otherwise two near-simultaneous completions could double-award (or race to award) the same achievement.

---

# 21. HOME SCREEN

The home screen is the most important screen.

It must immediately answer:

> What do I need to do?

Example:

---

🏠 HOUSE TASKS

Good afternoon, Thomas 👋

⭐ 84 points this week
🔥 4-task streak

## YOUR TURN

🍳 Kitchen

⚠️ Needs Cleaning

Last cleaned:
9 days ago

[ MARK AS DONE ]

## HOUSE STATUS

🧽 Hall
🟢 Fresh
Next: Akshay

🚰 Sink
🟡 Due Soon
Next: Jesvin

🚿 Bathroom A
🟠 Check Soon
Next: Vinil

🚿 Bathroom B
🔴 Needs Attention
Stebin's turn

🏆 THIS WEEK

🥇 Vinil — 92
🥈 Thomas — 84
🥉 Albert — 78

---

The user's active responsibility should always receive the most visual attention.

---

# 22. NO ACTIVE TASK STATE

If it is nobody's urgent responsibility:

Show:

> 🎉 You're all caught up!

> You don't currently have an active cleaning task.

Then show the house cleaning status.

Example:

Hall:
🟡 Due Soon

Sink:
🟢 Fresh

Kitchen:
🟠 Check Soon

The app should encourage someone to inspect the area rather than falsely claiming that it definitely needs cleaning.

---

# 23. MARK AS NEEDS CLEANING

Any authenticated household member can mark an area as requiring cleaning (subject to the reactivation cooldown in section 6).

Flow:

User opens Hall.

Clicks:

[ This Needs Cleaning ]

Show confirmation:

> Does the Hall currently need cleaning?

> Akshay is next in rotation.

[ Cancel ] [ Yes, Mark as Needed ]

After confirmation:

> 🧽 Hall needs cleaning.

> Akshay's turn.

The system records:

* Who marked it
* When it was marked
* Which person is scheduled
* The reason, optionally in future

Do not award points for marking a task as needed.

---

# 24. OPTIONAL "NOT DIRTY YET" ACTION

If a task is marked as Needs Cleaning accidentally, allow the scheduled person or admin to mark:

[ Looks Fine / Not Needed ]

This returns the task to its previous passive status without rotating.

This should be recorded in an audit/history log.

Do NOT award points.

---

# 25. TASK DETAIL SCREEN

Each cleaning area should have a detail screen or modal.

Example:

# 🍳 KITCHEN

Status:
🟡 Due Soon

Last cleaned:
11 days ago

Usual interval:
7–14 days

Next responsible:
Vinil

Rotation preview:
Vinil → Akshay → Stebin

Recent history:

Sep 2
Cleaned by Thomas
Normal turn
+10 pts

Aug 21
Scheduled: Albert
Cleaned by Jesvin 🦸
Volunteer rescue
+12 pts

Actions:

[ Mark Needs Cleaning ]

If appropriate:

[ Mark as Done ]

[ Volunteer ]

---

# 26. CLEANING HISTORY

Provide a history screen.

Every completion should show:

* Cleaning area
* Date/time
* Scheduled person
* Actual cleaner
* Completion type
* Points awarded

Example:

September 13

🍳 Kitchen
Scheduled: Thomas
Cleaned by: Thomas
Normal
+10

September 10

🚰 Sink
Scheduled: Albert
Cleaned by: Vinil 🦸
Volunteer Rescue
+12

Allow filtering by:

* Person
* Cleaning area
* Date
* Completion type

---

# 27. USER PROFILE

Each user should have:

* Name
* Avatar or initials
* Weekly rank
* Weekly points
* Total points
* Current streak
* Scheduled tasks completed
* Volunteer rescues
* Achievements

Example:

# THOMAS

🏆 Rank #2 this week

⭐ 84 Weekly Points
💎 428 Total Points
🔥 4-Task Streak

CLEANING STATS

Normal completions: 31
Rescues: 5
Weekly wins: 2

ACHIEVEMENTS

🔥 On Fire
🦸 House Hero
👑 Weekly Champion

---

# 28. ADMIN PANEL

One or more users can be administrators.

Admin capabilities:

## Members

* Add person
* Remove person
* Rename person
* Manage roles
* Change admin

## Cleaning Areas

* Add area
* Remove area
* Rename area
* Change icon
* Configure rotation members
* Reorder rotation
* Change current scheduled person

## Bathroom Groups

* Configure Bathroom A members
* Configure Bathroom B members

## Suggested Intervals

For each area configure:

* Minimum expected interval
* Normal expected interval
* Attention threshold

Example Hall:

Fresh:
0–5 days

Due Soon:
6–7 days

Ready to Check:
8–10 days

Needs Attention:
11+ days

These should be configurable.

## Volunteer Rules

Configure:

* Grace period
* Whether volunteering is enabled
* Rescue point value

## Gamification

Configure:

* Normal completion points
* Rescue points
* Bonuses
* Streak rules

## House Settings **[V3, new]**

Configure:

* House timezone
* Week-start day (default Monday)
* Default reactivation cooldown (default 4 hours), overridable per area

---

# 29. DATABASE MODEL

Use a relational PostgreSQL schema.

Suggested model:

## users

* id
* name
* avatar_url
* created_at

## houses

* id
* name
* created_at

## house_members

* id
* house_id
* user_id
* role

## cleaning_areas

* id
* house_id
* name
* icon
* active
* normal_points
* rescue_points
* minimum_interval_hours
* expected_interval_hours
* attention_interval_hours
* volunteer_grace_hours
* **reactivation_cooldown_hours** *(new — default 4, admin-configurable; enforces section 6/16)*
* created_at

## cleaning_rotation_members

* id
* cleaning_area_id
* user_id
* position

## cleaning_area_state

* cleaning_area_id
* current_scheduled_user_id
* **activation_state** *(renamed from `status` — see note below)*
* last_cleaned_at
* activated_at
* activated_by_user_id
* volunteer_user_id
* volunteer_claimed_at
* updated_at

**[V3] `activation_state`** holds only the explicit, stored states that a user action causes:

* `passive` — nothing has been explicitly flagged (the *displayed* Fresh/Due Soon/Ready to Check/Needs Attention badge is computed on read from `last_cleaned_at` + the area's interval columns, and is never stored)
* `active` — someone marked it Needs Cleaning
* `volunteer_claimed` — a volunteer has atomically claimed the active task

This split matters: if the passive Fresh/Due Soon/etc. status were persisted as a column, it would need a background job to stay accurate as time passes, and could silently go stale. Computing it on every read from `last_cleaned_at` avoids that entire class of bug. Only `active` / `volunteer_claimed` are real events that need to be stored, because only a human action (not the passage of time) causes them.

## cleaning_completions

* id
* cleaning_area_id
* scheduled_user_id
* completed_by_user_id
* completion_type
* points_awarded
* activated_at
* completed_at

Completion type:

* normal
* volunteer

## user_points_ledger

Do not rely only on a mutable total.

Record point events.

Fields:

* id
* user_id
* cleaning_completion_id
* points
* reason
* created_at

Examples:

+10
normal_completion

+12
volunteer_rescue

+5
streak_bonus

This provides an audit trail. **[V3]** All-time, monthly, and weekly point totals are *derived* by summing this table over the relevant window (using the house's configured timezone/week-start from `house_settings`) — never stored as separate mutable columns.

## user_streaks

* user_id
* current_streak
* longest_streak
* updated_at

**[V3]** One row per user (not per user+area) — the streak is global across all cleaning areas, per section 19.

## achievements

* id
* name
* description
* icon

## user_achievements

* user_id
* achievement_id
* earned_at

## house_settings

* house_id
* key
* value

**[V3]** Includes at minimum: `timezone`, `week_start_day` (default `monday`), `default_reactivation_cooldown_hours` (default `4`).

---

# 30. STATUS CALCULATION

The app should calculate passive cleaning status using time since last cleaning.

Example configuration:

Expected interval:
7 days

Attention threshold:
12 days

Then:

0–5 days:
Fresh

6–7 days:
Due Soon

8–11 days:
Ready to Check

12+ days:
Needs Attention

However:

If someone explicitly marks the area as Needs Cleaning, it becomes ACTIVE regardless of the calculated interval.

Example:

Kitchen cleaned yesterday.

Normally it would show:

🟢 Fresh

But someone notices a major mess and marks:

[ Needs Cleaning ]

It immediately becomes:

⚠️ ACTIVE — NEEDS CLEANING

Thomas's turn.

This is the key behavior.

**[V3]** As noted in section 29, the passive Fresh/Due Soon/Ready to Check/Needs Attention badge is always computed at read time from `last_cleaned_at` and the area's interval thresholds — it is a pure function, never a stored value. The `active`/`volunteer_claimed` states in `cleaning_area_state.activation_state` always take visual precedence over the computed passive badge when set.

---

# 31. IMPORTANT: NO AUTOMATIC FAILURE BASED ONLY ON TIME

Do NOT automatically mark the scheduled person as having missed a task simply because:

Expected interval = 7 days

and

8 days have passed.

The house might simply not need cleaning yet.

**[V3]** In V1, a scheduled person's streak breaks in exactly one circumstance: their active, scheduled task was completed by a volunteer instead of by them (section 19). There is no other "missed task" state in V1 — no penalty, no missed/skipped tracking, and no time-based failure of any kind. A more general missed-task rule (e.g. a task that sits active past some threshold with no volunteer either) is an explicit **future feature**, deferred until the household has used V1 and decided whether it's actually wanted (consistent with section 47's philosophy). Do not build placeholder logic for it now.

---

# 32. VOLUNTEER FLOW

Example:

Kitchen:

Last cleaned:
10 days ago

Someone marks:

Needs Cleaning

Scheduled:
Thomas

Activated:
10:00 AM

Grace period:
24 hours

Until 10:00 AM tomorrow:

Thomas:
[ MARK AS DONE ]

Others:
"Thomas's turn."

After 24 hours:

Others can see:

[ 🙋 Volunteer ]

Vinil volunteers.

Task state:

Scheduled:
Thomas

Volunteer:
Vinil

**[V3]** Thomas can still tap [ MARK AS DONE ] himself at any point after Vinil's claim — see section 12. If he does, it's recorded as a normal completion by Thomas, his streak continues, and Vinil's claim is cleared with no rescue points paid out. The example below assumes Thomas does not do this and Vinil completes it instead:

Vinil completes it.

History:

Scheduled: Thomas
Completed by: Vinil
Type: Volunteer Rescue

Points:

Vinil +12

Thomas:
No completion points.

Thomas's streak:
Broken (per section 19 — this is the one and only streak-breaking event in V1).

Rotation advances normally:

Thomas → Vinil

Next scheduled:
Vinil

---

# 33. CONCURRENCY AND ATOMIC OPERATIONS

Critical operations must be atomic.

Examples:

### Completing a cleaning

1. Validate user permission.
2. Check current state.
3. Ensure cleaning is active.
4. Ensure task was not already completed.
5. Record completion.
6. Award points through server-side logic.
7. Update last_cleaned_at.
8. Advance rotation.
9. Clear active/volunteer state.
10. Update streaks/achievements.
11. Commit.

### Claiming a volunteer task

Only one user can successfully claim it.

If Vinil and Akshay click at the same time:

Exactly one succeeds.

**[V3]** Implement this as a single conditional `UPDATE ... WHERE volunteer_user_id IS NULL RETURNING id` inside a Postgres function (see section 13's implementation note) — not as a `SELECT` followed by a separate `UPDATE` from the client.

Use PostgreSQL transactions and/or Supabase RPC functions for critical state changes.

Do not rely on frontend-only checks.

---

# 34. REALTIME UPDATES

All six users should see updates without refreshing.

Example:

Thomas completes Hall.

Every connected user immediately sees:

Hall:
🟢 Fresh

Last cleaned:
Just now

Next:
Vinil

Use Supabase Realtime or equivalent.

---

# 35. AUTHENTICATION

Each person has an individual account.

Initial members:

* Thomas
* Vinil
* Akshay
* Stebin
* Jesvin
* Albert

Use persistent sessions.

After login:

The app should remember the user.

The user should not need to repeatedly choose their name.

---

# 36. SECURITY

Implement proper Row Level Security.

Normal users can:

* View their house data.
* Mark an area as needing cleaning.
* Complete an active task when authorized.
* Volunteer after eligibility.
* View history and leaderboard.

Normal users cannot:

* Arbitrarily change points.
* Modify rotations.
* Change another user's score.
* Access admin settings.

Admin permissions must be enforced server-side, not just hidden in the UI.

All points must be awarded by trusted backend/database logic.

---

# 37. UI / UX REQUIREMENTS

The application must be:

* Mobile-first
* Modern
* Fast
* Interactive
* Friendly
* Easy to understand
* Visually satisfying

Use:

* Clear cards
* Large touch targets
* Icons
* Subtle animations
* Smooth transitions
* Progress indicators
* Streak indicators
* Celebration feedback
* Responsive layouts

Avoid:

* Corporate dashboards
* Large complicated tables
* Excessive settings on the home screen
* Too much text
* Too many colors
* Childish design

The design should feel closer to a modern fitness or productivity app.

---

# 38. NAVIGATION

Recommended mobile navigation:

HOME | AREAS | LEADERBOARD | PROFILE

Admin users also have access to:

SETTINGS / ADMIN

Home should always prioritize the user's active cleaning responsibility.

---

# 39. COMPLETION CELEBRATION

When someone completes a cleaning:

Show a quick satisfying animation.

Example:

🎉

# Kitchen Cleaned!

+10 Points

🔥 4-task streak

Next up:
Vinil

Do not make this animation too long.

The user should be able to return to the app immediately.

---

# 40. VOLUNTEER CELEBRATION

When someone rescues another person's active task:

🦸

# House Hero!

You cleaned Kitchen when Thomas couldn't.

+12 Rescue Points

This should feel rewarding and encourage cooperation.

---

# 41. LEADERBOARD DESIGN

Make the leaderboard visually interesting.

Example:

# 🏆 HOUSE LEAGUE

THIS WEEK

🥇 Thomas
84 points
🔥 4 streak

🥈 Vinil
78 points

🥉 Albert
71 points

4. Akshay — 62
5. Jesvin — 54
6. Stebin — 48

Highlight the current user's position.

Example:

"You are #2 — 6 points behind Thomas."

This can motivate participation.

---

# 42. WEEKLY RESET

Weekly points should reset for the leaderboard only.

Do NOT delete historical points.

Maintain:

* Weekly points
* Monthly points
* All-time points

At the start of a new week:

Weekly leaderboard starts fresh.

Previous week's winner remains recorded.

**[V3]** Since weekly/monthly/all-time are all computed from the ledger (section 29), there is no actual "reset" operation to run — the weekly leaderboard query's date window simply rolls forward automatically at the house's configured week boundary (section 18). The only real scheduled job needed is: at the week boundary, snapshot whoever was #1 into a `weekly_champion` record (or as a row in `user_achievements`) before the display window moves on.

---

# 43. SUGGESTED V1 ACHIEVEMENTS

Implement only a small number initially:

* 🧹 First Clean — Complete first task
* 🔥 On Fire — 5-task streak
* 🦸 House Hero — Rescue 3 tasks
* 💪 Reliable — Complete 20 normal tasks
* 👑 Weekly Champion — Finish first for a week

Keep the achievement system extensible.

---

# 44. DEVELOPMENT ORDER

## STAGE 1 — FOUNDATION

Set up:

* React
* TypeScript
* Vite
* Tailwind CSS
* Supabase
* Authentication
* Routing

## STAGE 2 — DATABASE

Create schema and migrations.

Create initial house.

Create the six members.

Create:

* Kitchen
* Hall
* Sink
* Bathroom A
* Bathroom B

Configure rotations.

## STAGE 3 — CORE CLEANING SYSTEM

Implement:

* Area cards
* Last cleaned date
* Suggested intervals
* Calculated status
* Mark Needs Cleaning
* Mark as Done
* Rotation advancement
* History

Do not add gamification yet.

The core system must be reliable first.

## STAGE 4 — REALTIME

Add live synchronization.

Test multiple users simultaneously.

## STAGE 5 — VOLUNTEERING

Implement:

* Grace period
* Volunteer eligibility
* Atomic claiming
* Volunteer completion
* Rescue history

## STAGE 6 — POINTS

Add:

* Points ledger
* Normal completion points
* Rescue points
* Weekly points
* All-time points

## STAGE 7 — GAMIFICATION

Add:

* Leaderboard
* Streaks
* Weekly champions
* Achievements

## STAGE 8 — ADMIN

Implement configuration.

## STAGE 9 — MOBILE POLISH

Add:

* PWA
* Installability
* Responsive UI
* Loading states
* Error states
* Animations
* Completion celebration

## STAGE 10 — DEPLOYMENT

Deploy:

Frontend:
Vercel

Backend:
Supabase

Use the free deployment URL initially.

No custom domain is required.

---

# 45. REQUIRED TEST CASES

Test at minimum:

### Normal cleaning

Thomas completes Kitchen.

Expected:

* Completion recorded.
* Thomas receives points.
* Kitchen last_cleaned_at updates.
* Kitchen returns to Fresh.
* Vinil becomes next.
* Other rotations unchanged.

### Independent rotation

Kitchen completion does not change Hall.

### Early activation

Kitchen was cleaned yesterday.

Someone marks it Needs Cleaning.

Expected:

* It immediately becomes active.
* Scheduled user is responsible.
* Completion can occur despite short time since last cleaning.

### No automatic failure

Hall expected interval is 7 days.

8 days pass without activation.

Expected:

* Status may show Ready to Check.
* Nobody receives a missed-task penalty.

### Volunteer eligibility

Kitchen is activated.

Before 24-hour grace period:

Others cannot volunteer.

After grace period:

Others can volunteer.

### Volunteer race

Vinil and Albert volunteer simultaneously.

Expected:

Only one successfully claims the task.

### Volunteer completion

Thomas is scheduled.

Vinil volunteers and completes.

Expected:

* Scheduled user recorded as Thomas.
* Actual cleaner recorded as Vinil.
* Vinil receives rescue points.
* Rotation advances from Thomas to Vinil.

### Scheduled person completes after a volunteer has claimed **[V3, new]**

Thomas is scheduled. Vinil claims as volunteer. Before Vinil completes, Thomas taps Mark as Done.

Expected:

* Completion is recorded as normal, by Thomas.
* Thomas receives normal points and his streak continues.
* Vinil's claim is cleared.
* Vinil receives no points.

### Reactivation cooldown **[V3, new]**

Kitchen is completed at 9:00 AM. Cooldown is 4 hours.

At 10:00 AM, someone tries to mark Kitchen as Needs Cleaning again.

Expected:

* Request is rejected (or the button is disabled) until 1:00 PM.

### Duplicate completion

Two browser sessions attempt completion.

Expected:

Only one completion succeeds.

### Realtime

One user completes a task.

Other connected users update without refreshing.

### Point security

Attempt to send arbitrary points from frontend.

Expected:

Rejected or ignored.

---

# 46. TECHNOLOGY STACK

Preferred stack:

Frontend:

* React
* TypeScript
* Vite
* Tailwind CSS

Backend:

* Supabase
* PostgreSQL
* Supabase Auth
* Supabase Realtime

Hosting:

* Vercel

PWA:

Make the web application installable on mobile devices.

No paid domain is required.

---

# 47. FUTURE FEATURES — DO NOT BUILD IN INITIAL VERSION

Potential future additions:

* Push notifications
* "I can't do this turn" button
* Task swapping
* Temporary delegation
* Cleaning reminders
* Monthly challenges
* Team competitions
* Funny house titles
* Custom avatars
* Photo proof of cleaning
* Comments on cleaning requests
* House announcements
* Shared expenses
* Cleaning statistics
* AI-generated insights
* **[V3, new]** A general missed/skipped-task rule (time-based failure beyond simple streak-breaking on volunteer rescue — see section 31)

Do not build these until the core app is working and the household has actually used it.

---

# 48. FINAL PRODUCT PRINCIPLE

This application is NOT primarily a scheduler.

It is a:

# SHARED HOUSE CLEANING ROTATION SYSTEM

The logic is:

> Area gets dirty
>
> ↓
>
> Someone marks it as needing cleaning
>
> ↓
>
> The next person in the rotation is responsible
>
> ↓
>
> They clean it and complete the task
>
> OR
>
> After a grace period, someone volunteers
>
> ↓
>
> Completion is recorded
>
> ↓
>
> Points are awarded
>
> ↓
>
> The rotation advances
>
> ↓
>
> Area becomes Fresh again
>
> ↓
>
> The cycle repeats

The suggested cleaning intervals should provide useful context and reminders, but human judgment determines whether an area actually needs cleaning.

The app should make the process:

**Fair + Simple + Shared + Competitive + Cooperative + Fun.**

Prioritize reliability of rotation, completion, volunteering, and shared state before adding advanced gamification.
