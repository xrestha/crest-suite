---
paths:
  - "src/pages/Settings.js"
  - "src/pages/settings/**"
  - "src/context/SettingsContext.js"
  - "src/pages/adminClients/ClientDrawer.js"
  - "src/modules/pos/tables/PosTableManagement.jsx"
  - "src/modules/pos/reports/CoversReport.jsx"
  - "src/modules/pos/customers/LoyaltyTab.jsx"
  - "src/modules/hr/tada/TadaSettingsModal.js"
  - "src/modules/ims/stockcount/StockCountSettings.jsx"
  # Added S770: the text below names these four as writers of the settings row, and the rule did
  # not load on any of them.
  - "src/modules/ims/staff/ImsStaff.jsx"
  - "src/modules/hr/staff/HrStaff.jsx"
  - "src/modules/pos/staff/PosStaff.jsx"
  - "src/modules/ims/recipes/ComboBuilder.js"
# Started S739. The rule below was written in S730 and lived in ims-figures.md, whose `paths:` has
# never matched `src/pages/Settings.js` — so the rule most about that file did not load when anyone
# opened it, and S739 then re-found two of the same shapes on the admin half of the page and a third
# in the admin drawer. check-rules-globs cannot catch this: every glob over there matched real
# files, so nothing ever reported that the set was missing the page the rule is named after. The
# CLAUDE.md warning is about a glob scoped to the WRONG file, and this is what that looks like.
---

# The `settings` row, and the seven admin tabs that write it

## The `settings` row is written by nine pages, so a save sends a PATCH, never the row (S730)

`settings` is one row per client, and it is the junk drawer: `Settings.js` owns the thresholds and
code prefixes, `PosTableManagement` owns discount reasons / note presets / ticket routing /
reservation settings / delivery partners, `CoversReport` the opening hours, `TadaSettingsModal` the
TADA rates, `ImsStaff`/`HrStaff`/`PosStaff` the three custom-role schemes, `ComboBuilder` the combo
discount, and the admin drawer the branding. Every one of them reads the row, edits its part, and
writes. **A page that writes the whole row writes every other page's columns as they stood when it
loaded** — and nothing fails: the write succeeds, the toast says saved, and a manager's change on the
till from ten minutes ago is gone. `Settings.js`'s page-level Save did exactly this until S730 (S701
had found the mirror image on the same page, a platform price landing on the client row, and fixed
that one tab).

Three rules:

- **Send only the columns the screen edits, as a diff against the row it loaded** — `PAGE_FIELDS`
  and `pagePatch()` in `Settings.js` are the reference; `saveSettings()` in the context accepts a
  partial and always has. `{ ...settings, one_column: x }` is the same defect wearing a fresher
  snapshot.
- **A re-read after a save must not reseed a form wholesale.** `loadSettings()` runs after every
  save, and a form keyed on `settings` that copies the row over itself wipes whatever was typed on
  another tab. Keep the values that differ from the *previous* seed; replace everything only when
  the row belongs to a different client (`settings.client_id` changes).
- **A threshold with a `|| default` reader cannot store 0.** `fcThresholds`, `varianceFlagPct` and
  FIFO's `expiry_warning_days || 7` all read 0 as "use the default", so a box showing 0 and a report
  banding at 35 are the same stored value. Refuse 0 at the form, store a cleared box as NULL (never
  `''` — Postgres refuses it for `numeric` and `integer`), show the default as the placeholder, and
  check the pair (critical > warning) — `validateThresholds()` is exported for exactly that.

## What a page SAVES must be scoped to the tabs that viewer HAS (S739)

S730 fixed the whole-row write with a flat `PAGE_FIELDS` list. That list is the page's union, and
using it as the save scope produced two further defects on the admin half of the same page:

- **A column with a tab and no entry in the list is a card that writes nothing and says it saved.**
  The Support tab's lower card edits `contact_phone`/`contact_email`/`contact_website` — the
  per-client consultant read by Help → Support, `PremiumGate`'s upsell and `SubscriptionLock` — and
  those three were never added to `PAGE_FIELDS`. `pagePatch()` walks the list, so the patch was
  always empty, `if (Object.keys(patch).length)` skipped the write, and the button still reported
  "✓ Saved". **An allow-list is a better default than a deny-list and it fails in the opposite
  direction**: forgetting a column is silent omission instead of silent leakage, which is safer and
  just as invisible.
- **A validation over the union refuses a save the viewer cannot fix.** `save()` ran
  `validateThresholds(form)` on every save, against the STORED row — so an admin, who has no
  Thresholds tab, was refused a branding save for any client whose row still held a `0` or a
  critical level at or below its warning level (both saveable before S730). It then called
  `setActiveTab('Thresholds')`, a tab absent from `ADMIN_TABS`: no tab rendered as selected,
  `aria-labelledby` pointed at a missing id, and the panel appeared with nothing above it.

The shape that fixes both is **`TAB_FIELDS`, keyed by tab**, with the page-level button writing the
union over the VISIBLE tabs and each card with its own Save passing its own subset. Validation then
runs only when the field it judges is in scope, which needs no per-viewer special case. A dev-only
assertion checks every tab's columns appear in `PAGE_FIELDS`, because that list is separately what
keeps an unsaved edit alive across a reseed — a column missing from it reverts under the typist.

## Whose row is this? — not the same question as "is the viewer an admin" (S739)

`settings` is one row per client **plus** one platform row (`client_id IS NULL`), and an admin
reaches either depending on whether a client is selected in the top bar. Three tabs got this wrong
by branching on `isAdmin`:

- **Branding labelled a client's own white-label brand "App Name", placeholder "Crest Suite".** With
  a client selected, `app_name` is that client's brand — their sidebar, their top bar, their recipe
  cost cards (`Layout.js` says so in a comment) — so an admin reading that label and typing the
  product name renamed the property. Branch on `!!clientId`, and name the client on screen.
- **Property Details with no client selected wrote a row nothing reads.** Every reader of those six
  columns filters `.eq('client_id', cid)`, so the write landed on the platform row and was never
  read again — S701's shape a fourth time. The tab now says to pick a client, the way the Support
  tab's lower card already did, and the page-level Save does not render there.
- **The page subtitle claimed all seven tabs were "for the client you are viewing".** Plan Pricing
  is the platform's one price list, Theme is this browser, Guides is prose. A subtitle that
  mis-states scope is how a price came to be written onto a client's row in the first place.

## A field whose value is resolved at PRINT time reaches documents already issued (S739)

`pos_orders` stores only `invoice_no` and `invoice_fy`. The printed document number and the bill
TYPE are both assembled when a bill is printed, from the settings row current at that moment
(`posOrderPrintHtml.js`: `${vatReg ? 'TI' : 'PB'}${invoice_no}-${prefix}-${fy}`). So two ordinary
fields on the Property tab are retroactive:

- **`invoice_prefix`** — change CAC to CASA and every past invoice reprints as `TI2238-CASA-82/83`.
- **`is_vat_registered`** — switch it off and past Tax Invoices reprint as PAN bills, prefix changed
  and VAT breakdown gone.

Both are legitimate edits (a client registers for VAT; the code was typed wrong on day one), so the
answer is a confirmation naming the consequence, not a refusal. **The general test is whether the
stored value is rendered at write time or at read time** — anything resolved at read time is a
change to history, and an IRD-relevant document number is the worst case of it. The Monthly Owner
Report is the counter-example done right: it snapshots `is_vat_registered` at generation.

**Since S754 the database decides who may write them** (`settings_guard_staff_roles`, migration
`20260916110000`, applied live 2026-09-14). Before that, any same-client login could PATCH them
over REST, a POS PIN waiter included, and `payment_qr_data` is the merchant QR a guest pays into.
- **Owner only** (admin exempt): `is_vat_registered`, `invoice_prefix`, `vat_number`,
  `property_address`, `property_phone`, `payment_qr_data`. Every one is resolved at print time on
  bills and credit notes.
- **POS manager or Owner:** the till-setup columns `pos_bot_categories`, `pos_note_presets`,
  `pos_discount_reasons`, `pos_delivery_partners`, `pos_reservation_settings`, `pos_open_time`,
  `pos_close_time`, `pos_loyalty_point_value`.
- **Owner only, since S767** (`20260921100000`, hint `guest_menu_brand_rank`, admin exempt):
  `guest_menu_name`, `guest_menu_logo_url` — the restaurant name and logo every guest sees on every
  table's QR menu. POS Setup → Guest Menu shows them read-only to a POS manager rather than offering a
  Save the database refuses. `recipe_categories` is NOT guarded: its order is also the guest menu's
  section order, and a POS manager may move it from that same tab.

On INSERT a column counts as set only when it differs from its column DEFAULT (`c_insert_base`).
The old body compared against NULL, so a POS manager writing a trial client's FIRST settings row
tripped the role-list check on `pos_custom_roles`' `'[]'` default. **A new guarded column with a
non-NULL default must join that baseline**; the migration's assertion block checks it against the
live defaults. A write that screen scopes as a PATCH (the rule above) is what lets a manager save
one of their tabs without touching an Owner column.

## The weather columns: three editors, one helper, and a rank in the database (S786)

`weather_city` / `weather_lat` / `weather_lon` are written by Settings → Weather (Owner), POS Setup →
Weather and the dashboards' "Set your city" box. All three go through `cityPatch()` in
`src/modules/dashboard/weatherSettings.js`, and the last two are one component, `WeatherCityPicker`,
which saves with `saveSettings(cityPatch(key))` so the context re-reads the row and the dashboard strip
sees the city at once. POS Setup's other tabs write through raw `supabase.from('settings')`; a weather
save that did would leave the context stale until a reload. **`settings_guard_staff_roles` fences
them since `20260923130000`**: the city to the Owner, admin or a manager of any module
(`weather_city_rank`, never an IMS count PIN), `rain_sales_pct` to the Owner or admin
(`weather_rain_rank`). `canEditWeatherCity()` is the browser's copy of the city rule and tests the RAW
role columns, as the guard does. S784 had left all four unguarded; anyone except HR Self-Service could
PATCH them.

## The second editor for the same columns is where the fix did not reach (S739)

`Admin → Clients → Manage → Settings` edits the same Branding / Property / consultant columns as the
admin tabs on `Settings.js`, plus the payment QR (and, until S744, Thresholds) — and it was still
sending `clientSettings` whole, from a `select('*')` load, on all four of its Save buttons. S730's fix had
been applied to one of the two screens. `DRAWER_SETTINGS_FIELDS` now scopes each button, and
`saveClientSettings()` strips `id`/`client_id`/`created_at`/`plan_prices` the way `saveSettings()`
always has.

Its two logo handlers had the other half of the S730 fix missing too: `await saveClientSettings(...)`
with no catch, and it **throws** — so a refused write left "Uploading…" on the button permanently,
reported nothing, and never reached `setLogoUploading(false)`.

**When a defect is fixed on a screen, grep for the other screen that edits the same columns.** The
tell here was a field the drawer called "Upgrade Contact" and `Settings.js` called "this client's
consultant": two names for one column set is usually two editors, and the second one is rarely
carrying the same fixes.

**The drawer no longer edits thresholds at all (S744).** Its Thresholds tab (from the June v2 build)
was the one admin surface for `fc_warning_pct`/`fc_critical_pct`/`expiry_warning_days`/
`variance_flag_pct` — 4 of the 6 columns, with no `validateThresholds()`, so it could store a 0
the readers treat as the default while the box showed 35, or an inverted warning/critical pair. It
was removed rather than brought up to date: thresholds are the client's operating preference, the
Owner edits them in Settings → Thresholds, and `Settings.js`'s admin tab set had already excluded
them as "not theirs to fix". **Do not add an admin editor for them back**; an operator helping a
client talks the Owner through their own tab.

## A logo at a stable path keeps serving the old image (S739)

Both upload handlers `upsert: true` to `<client>/logo.<ext>` and store `getPublicUrl(path)` — the
same URL for the new file as for the old one. With Storage's default one-hour `cacheControl` a
replaced logo goes on rendering the previous image, so the second upload looks like it did nothing.
Store `${publicUrl}?v=${Date.now()}`; that also makes a long cache life correct rather than risky.
Two related details: derive the extension from `file.type` rather than `file.name.split('.').pop()`
(a file with no dot in its name wrote `logo.mylogo`), and a Remove that only clears the column
leaves the file publicly readable at its own URL.

## Plan Pricing: 0 is a real price, so a cleared box must not become one (S739)

`withMonthly()` and `clientMrr.js` both keep a stored `0` deliberately — a tier priced at 0 is a
live configuration. The field therefore cannot validate 0 away, and `'' → 0` meant select-all-delete
published a free plan on the public pricing page and zeroed every MRR figure, while the placeholder
advertising the shipped default was unreachable. A blank box now **removes the key**, which
`resolvePricing()` already falls back from per field, and an explicit 0 is confirmed before it is
published.

That change needed one fix underneath it: `clientMrrBreakdown` read `imsPrices[c.plan] || 0`, so an
absent tier counted as free — `??` per tier, the way `resolvePricing` falls back per field, keeps a
deliberate 0 and falls back on absent. **A "0 survives on purpose" contract has to hold at every
reader, or the field that relies on it is only safe on the ones that were checked.**

## S747: the save scope is the ACTIVE tab, a code is never invented, and a failed read is not a form

Three rules from the Admin Settings re-analysis, each decided with Aashish. **The first supersedes the
"union over the VISIBLE tabs" shape described in the S739 section above** — that section's diagnosis
still stands; its remedy was one step short.

- **Save Changes writes `TAB_FIELDS[activeTab]` and nothing else.** The union put a consultant
  number half-typed on Support into a Branding save, through the one button the Support card's own
  Save exists to keep it away from. `TAB_FIELDS` is still the map; `PAGE_FIELDS` is still what keeps
  an unsaved edit alive across a reseed. A card with its own Save passes `scope` so its saving /
  saved / error state renders beside that card and not on the header button.
- **Never fill a column the user did not type.** Both admin editors seeded a blank `invoice_prefix`
  from the property name, which made the form differ from the row, which made the next save commit
  it — past the renumbering warning, because that only fired when an OLD code existed. A FIRST code
  is as retroactive as a change (a code-less bill reprints with the new code in its number), so
  `retroWarnings` / `retroBillWarnings` fire on any difference. The general test: a derived default
  belongs in a placeholder, never in state a save diffs against the row.
- **`settingsLoadError`, `platformLoadError`, `platformLoaded` (SettingsContext) are for EDITORS.**
  The app stays fail-soft on a failed settings read — the login page still renders on defaults — but
  a screen that SAVES from those values must not offer them: `savePlatformPlanPrices` and
  `savePlatformSupport` write whole objects, so one edited field over a failed read reverted every
  other price or contact slot for every client. `Settings.js` gates on `ROW_TABS` / `platformReady`.
  The provider is also the ONLY loader now (`wantedCidRef` + a sequence discard superseded
  responses) — a page calling `loadSettings` on the same client switch doubles the read and races it.

**A storage bucket written with `upsert: true` or `remove()` needs a SELECT policy for the writer
(S756, `20260918160000`).** Supabase Storage runs an upsert as `INSERT … ON CONFLICT DO UPDATE …
RETURNING *` and a remove as `DELETE … RETURNING` in the caller's session, and Postgres applies
SELECT policies to RETURNING — so with no SELECT policy the upsert raises 42501 however permissive
the INSERT policy is, and the remove matches nothing and reports success. `20260914140100` left
Logos with admin INSERT/UPDATE/DELETE and no SELECT, which broke replacing and removing a logo;
`logos_select_admin` restores it. Public reads never consult RLS, so the policy is invisible to
viewers. The reverted `hr_employee_photo` bucket failed the same way. `dish-photos`
(`20260918150000`) uploads without upsert and carries a scoped SELECT policy.

**The Logos bucket is admin-write-only** (`20260914140100`). Its dashboard-made policies let any
signed-in account of any client overwrite or delete any object, including `admin/logo.*`, Crest's own
login-page mark. Only admins upload logos (Settings → Branding, ClientDrawer). **A storage bucket's
policies live in `storage.objects` and were never in a migration** — read `pg_policies` live before
trusting a bucket, the way `multi-outlet.md` says to audit table policies.
