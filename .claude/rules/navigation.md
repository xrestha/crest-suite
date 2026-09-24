---
paths:
  - "src/components/Layout.js"
  - "src/components/Layout.css"
  - "src/components/CommandPalette.js"
---

# Navigation: the sidebar and the command palette

Split out of `.claude/rules/design-system.md` word for word (S770 context pass, 2026-09-17), so it loads where navigation is built rather than on every page.

### A nav item's visibility condition belongs on the ITEM, not at each render site (S638/S639)

The rendered nav is not the only thing that reads the nav model: the **command palette** flattens every
destination into one searchable list, and `isItemVisible()` is the predicate both go through. A
condition written *around* a render site is therefore applied to one consumer and not the other.

This has now produced the same bug three times. S617 found the palette offering `/group-dashboard`
on group membership alone while the sidebar required `isAdmin || isOwner` — and **fixed only that
one row**: Owner Dashboard and Owner Report kept the mismatch until S638, so any staff account could
search its way onto them. (`/pnl` was in neither list, so the Owner could not search for it at all.)

The fix is structural, not vigilance: put the flag on the item (`ownerOnly: true` alongside the
existing `featureKey`/`minPlan`/`minPosRole`/`minImsRole`/`minHrRole`), teach `isItemVisible()`
about it once, and have every consumer build from the same array. `SUITE_NAV` is the worked example
— the palette maps it through a `longLabel` swap (it is searched by typing a full name; the sidebar
has 240px) and re-states **no** visibility condition of its own.

Corollary: a group whose members have *different* gates must gate per item, never on the group.
Gating the Crest Suite group owner-only would have revoked Demand Forecast and Fixed Assets from
every IMS supervisor who has them; `renderGroup` already returns `null` when nothing inside is
reachable, so per-item gating degrades correctly on its own.

**A group rendered into EVERY panel is a panel (S763).** `renderBarGroup(suiteGroup())` was written
out five times, once per module panel, under a comment saying it renders everywhere — which is the
tell: a group that belongs in every panel belongs to none of them, and the top row is what "none of
them" looks like. Crest Suite is a top-row tab now for a client that has it, with its items as flat
pills (a `Crest Suite` disclosure *inside* the Crest Suite tab is a menu whose label repeats the tab
above it). **The entitlement split is the part worth copying**: the tab appears only for a client who
owns the thing, and the PRO-badged upsell group stays inside the module panels for everyone else —
promoting an upsell into the row that answers "where am I" advertises to every user on every screen
forever. Same question for the next add-on: does this belong to a panel, or does it keep having to be
copied into all of them?

### The top bar wraps between 768 and 1280px, and one page has one name (S776, S790)

- Below 1280px `.topbar-primary` and `.topbar-nav` WRAP (Layout.css, `max-width: 1279px`; it was 1119px until S790): account actions top-right, the context on its own line, pills on a second row. At 820 the context had collapsed to 2px and three nav menus sat past the edge of a scrollbar-less row. A new top-bar element must be checked at 820, 1024 and just above the wrap line by `scrollWidth`, not by eye.
- **Help is a labelled button in `.topbar-actions` (S790)**, riding on `.sidebar-search-btn` for its box and touch floor, because a first-time user never opens the account menu and Help is where a hidden setup guide comes back from. Its 74px is why the wrap line moved: the S790 review measured the context running under the actions from 1120 to ~1260px (63px in admin view-as at 1160).
- **The context shortens, it never runs under the actions (S790, owner decision).** A follow-up measurement found reachable layouts still overflowing from 1280 to ~1460px (a client with Customization, the Custom panel, a touch pointer) with ZERO page overflow — so a `scrollWidth` check on the page cannot see this failure; measure the context's content against the actions' left edge. `.topbar-context` is `overflow: hidden` (5px padding and matching negative margins keep the switcher's focus ring inside the clip), the client/outlet switchers pass `Dropdown`'s `shrink`, and the month and plan truncate with "…" and carry a `title`. The account menu also carries **Setup guide** (→ `/help?section=guide`) for a login `viewerOf` gives a guide to; `viewerOf` lives in `src/shared/onboarding/setupViewer.js` so this eager file never imports the step catalogue.
- `/pos/tables` is **POS Setup** (Admin group) and `/pos` is **Till Devices** (owner decision). The tables page had three names and "POS Setup" had meant both pages in the copy. A link or guide names a page by its nav label, and a new page's heading uses the same words.

### "You are here" is a longest-prefix match, not a prefix match (S763)

`NavLink`'s `isActive` prefix-matches by default. That is right for an item with sub-routes
(`/purchases` stays lit while `/purchases/new` is open) and wrong for an item that is a PARENT of
other nav destinations — and this model has exactly one: **`/pos` sits above `/pos/orders`,
`/pos/billing`, `/pos/kds` and eight more**, so POS Setup (now Till Devices) was highlighted on every POS page, with
`aria-current="page"` on it, since the module shipped. Nobody reported it for months; it was noticed
in a screenshot of a different change.

**`end` on every link is not the fix** — it breaks the legitimate case. `NAV_PARENT_PATHS` in
`Layout.js` is **derived from the nav model** (a path needs the exact test precisely when another
destination starts with it plus `/`), so no item carries a flag and a new sub-path is covered
automatically. `navEnd(to)` feeds `NavLink`'s `end`, which matters because it fixes `aria-current`
and not only the highlight; `navPathActive(pathname, to)` is the same rule for a group trigger that
has to decide for a whole list.

**Check both surfaces and both signals.** The bar pill, the drawer link and the group triggers each
decide this separately, and a visual fix that leaves `aria-current` on two links has told a screen
reader there are two current pages. Verified by reading `aria-current` per route, not by looking.

### A nav icon is unique per route, because the command palette flattens the modules (S606)

`CommandPalette.js:134` renders each nav item's `icon` and lists **every module's items in one
searchable list**. The nav shows one module panel at a time, so an icon shared by two routes in
different modules looks fine there and sits directly beside its twin in the palette. Sixteen such
collisions had accumulated — `Users` was Customers *and* Employees, `Banknote` was Purchase 1L+
Report *and* Payroll, `CalendarClock` was FIFO/Expiry *and* Staff Roster, `Building2` was three
things.

Audit by keying on `to:`, never on label — an item listed in two panels (Settings, Periods, Guest
Menu) shares one route and is **not** a collision. Resolve by keeping the icon on whichever route it
fits most literally and moving the other.

**Not every repetition is a collision.** `LayoutDashboard` (Dashboard / HR Dashboard) and `Users2`
(IMS / POS / HR Staff) are deliberately shared: they are one concept expressed once per module, and
the labels disambiguate. Splitting those makes the palette harder to scan.

Two related traps. **`AlertTriangle` is a deprecated alias of `TriangleAlert`** — in lucide-react
1.24.0 `alert-triangle.mjs` is literally `export { default } from './triangle-alert.mjs'`, so both
names render one SVG and a codebase using both looks inconsistent for no reason. And a **mirror-image
pair** (`ArrowLeftRight` / `ArrowRightLeft`) used for one concept is worse than an exact duplicate:
the reader cannot tell whether the difference is meaningful.

Before adding a nav entry, check its icon is not already on another route, and verify the export
exists (`node -e "process.exit(require('lucide-react').<Name> ? 0 : 1)"`, exit 0 means it exists;
never read `node_modules/`) — a misspelled icon name is a build failure, and a *wrong-but-real* one
is silent.
