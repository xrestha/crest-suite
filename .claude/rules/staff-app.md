---
paths:
  - "src/modules/hr/selfservice/**"
  - "src/utils/deviceEnv.js"
  - "src/utils/installPrompt.js"
  - "src/utils/webPush.js"
  - "public/staff.webmanifest"
  - "public/service-worker.js"
---

# Crest Staff — the employee app (`/hr/self-service`)

> Added S599 (2026-08-22), when the portal was rebuilt from a desktop page shape into a phone app.
> Root CLAUDE.md keeps the universal invariants; this loads when working on the portal itself.

## What it is

A second **installable app** served from the same origin as Crest Suite. An employee has no login
for the admin app and should never see its icon on their phone, so the portal points the browser at
its **own manifest** (`public/staff.webmanifest`: name "Crest Staff", `start_url`/`scope`
`/hr/self-service`, its own gold-hexagon-with-a-person icons). `index.html` can carry only one
`<link rel="manifest">`, so `useStaffAppManifest()` swaps that tag plus `apple-touch-icon`,
`apple-mobile-web-app-title` and `theme-color` **at runtime** — both Chrome's install flow and
iOS's Share → Add to Home Screen read the live DOM at the moment the user acts — and restores them
on unmount so an admin opening the route does not install the staff app. Call it at the **top level
of a portal page**, never from inside a dialog, or the identity is only correct while that dialog
is open (which is how the first draft shipped it).

`SelfServiceLogin` remembers its `:clientId` (`staffClient.js` → localStorage), and the portal's
unauthenticated redirect goes to **that** PIN pad rather than `/login`, because the installed app's
`start_url` is a fixed string and the company id exists nowhere else on the device.

## The shape, and why

- **`SelfServiceShell.jsx`** — a 56px header and a fixed bottom tab bar (Home · Roster · Requests ·
  Pay), replacing ~200px of stacked chrome on a screen where an in-app browser has already taken
  ~150px. Navigation is bottom-anchored because the bottom third of a phone measures ~96% tap
  accuracy against ~61% in the top stretch zone.
- **One `TABS` array drives the bar, the content switch and the `sr-only` `<h1>`.** The old tab bar
  defaulted to `payslip` while Payslip rendered fourth — the array order and the render order were
  free to disagree, and did.
- **Leave + TADA are one destination** ("I'm asking for something"), so four tabs stay legible at
  390px where five crowd.
- The shell renders **no content**: `tab`/`onTab` are controlled and `SelfServiceHome` owns every
  fetch. Each screen (`SelfServiceToday`, `RosterWeek`) is pure and takes props, which is what makes
  them testable with no mocks at all.
- **Sign out lives in the `⋯` account sheet**, with the notification state and the install offer.
- The tab is in the URL (`?tab=roster`) so the phone's Back gesture moves between destinations
  instead of leaving the app.

## Rules that cost something to learn

- **A day with no shift and a day whose month is unpublished are identical in the data and must
  never look identical on screen.** `get_my_roster` only returns published days, so the *absence* of
  a row means either. `todayView()` separates them (`unpublished` / `not-scheduled`), and the week
  renders every calendar day rather than the rows the RPC returned.
- **A failed read is not an empty period.** `employeeError.js` turns a Supabase/PostgREST code into
  one honest sentence, and each area holds its own message (`errs` map) so a failed payslip read
  cannot blank a roster that loaded fine. The old portal had one shared string and rendered a failed
  `get_my_hr_payslips` as "No finalized payslips yet." As of S619 the rule table itself lives in
  `src/shared/errorText.js` — the same failures reach IMS and POS screens — and `employeeError.js`
  is a four-line delegate pinning the **`'staff'`** audience. Keep it: the name is what tells every
  call site in this module which reader it is speaking to, and the staff wording ("tell your
  manager") is wrong for the Owner-facing wording on the other side of the same table.
- **Next shift skips days off** — "next shift: Day Off" answers a question nobody asked — and Home
  loads **this week and next**, so the answer on a Saturday is Monday rather than silence.
- **Only offer a notification button in the two states where pressing it can do something.**
  `pushEnvironment.js` is capability-first, not UA sniffing, and checks `ios && !standalone`
  **before** capability: on iOS a tab genuinely has no `PushManager`, and "your browser doesn't
  support notifications" is both wrong and a dead end when the same phone works once installed.
  `isPushSubscribed()` verifies the **DB row**, not just the browser subscription — a subscription
  belongs to the browser, not the account, so on a shared phone one employee's made the next one's
  portal claim notifications were on.
- **16px on every field, 44px on every control**, scoped to `.self-service` so admin density is
  untouched. 16px is the threshold below which iOS Safari zooms the viewport on focus and never
  zooms back; the viewport is deliberately **not** pinned with `maximum-scale`. `BsCalendarPicker`
  and `SearchableSelect` size themselves **inline**, which no media query can reach, so both take an
  opt-in `touch` prop — used only here.
- **`viewport-fit=cover` in `index.html` is what makes every `env(safe-area-inset-*)` rule real.**
  Without it they all resolve to 0 and the bottom bar sits under the home indicator.
- **A portaled control must swallow Escape.** `Modal` listens on `document`, so a date picker or
  combobox that lets Escape bubble closes the whole dialog behind it — a half-filled TADA claim
  disappearing because someone dismissed a calendar. Both pickers now `stopPropagation()`.
- **A confirmation must outlive the sheet that produced it** (`done` state on the list behind), or
  it vanishes with the thing the employee was looking at when they tapped Send.
- The **`visibilitychange` / `pageshow(e.persisted)` refetch must survive any rewrite**: an
  installed iOS PWA is frozen rather than reloaded, so it resumes with stale in-memory state.

## Theme

`SYSTEM_KEY` in `ThemeContext.js` resolves `prefers-color-scheme`, tracks the OS live while (and
only while) the mode is `system`, and persists **the key only** — storing resolved colours would
replay the last scheme instead of re-asking the device. The pair is `dark` ↔ `light` deliberately
(the same design in two schemes, both gold-accented); pairing with another light preset would swap
the accent hue at sunset and read as a different app. `system` is **not** a member of `PRESETS`,
which stays a map of real hex palettes. It is the default **only** for a session with no stored
preference on a `/hr/self-service` path — the admin app keeps `dark`.

## No backend

Every figure comes from an RPC the portal already called: `get_my_hr_payslips`,
`get_my_leave_types`, `get_my_leave_requests`, `submit_my_leave_request`, `get_my_roster`,
`get_my_roster_publish_status`, `get_coworker_roster`, `request_shift_swap`, `respond_shift_swap`,
`get_my_swap_requests`, `get_my_tada_claims`, `submit_my_tada_claim`, `get_my_client_vendors`.
**Keep it that way where possible** — the whole rebuild carried no migration and no Edge Function
deploy, which is why it could not break the admin side.

## A day is named, not numbered (S614)

The swap flow used to say "Day 3" — in the target-day picker and in both pending-swap lines. An
employee reads the roster by date, not by ordinal position in a month, and the shift-swap screen is
the one place two people have to agree on *which* day before either of them commits. Those now use
`formatBsDay(cd.bs_day, swapDay.bsMonth)` ("3rd Bhadra") where the month is not already on screen
and `bsDayOrdinal(...)` where it is — both from `src/utils/bsCalendar.js`. Same helpers the roster
and HR Dashboard use, so the two sides of a swap request can never describe the day differently.
