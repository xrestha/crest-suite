---
target: the customization module
total_score: 25
max_score: 40
na_heuristics: 
p0_count: 0
p1_count: 2
timestamp: 2026-11-03T03-05-29Z
slug: src-modules-customization
---
Method: dual-agent (A: design-review sub-agent · B: detector and browser sub-agent)

Target: src/modules/customization/ (Option Groups, Combos, Customization Report, eight owner dialogs, the two till pickers). Mode: Operate.

## Design Health Score

| # | Heuristic | Score | Key Issue |
|---|-----------|-------|-----------|
| 1 | Visibility of System Status | 3 | Strong live readbacks ("Guests will see: …", "Save (3 changes)"). Deleting an option gives no notice; deleting a group does (OptionGroups.jsx:397-403 vs :346). |
| 2 | Match System / Real World | 2 | "Option", "choice", "pick" and "group" overlap; one group kind is called "Choice"; the top tab says "Custom" (Layout.js:1383). |
| 3 | User Control and Freedom | 3 | Hide-instead-of-Delete everywhere, unsaved-change guards. × on a combo pick removes it in one tap with no undo (ComboEditorModal.jsx:237). |
| 4 | Consistency and Standards | 2 | 8 accent buttons on one screen; Combos uses the Fab, Option Groups a plain button; till chips use `disabled` against the house rule. |
| 5 | Error Prevention | 3 | Below-zero, shortfall and kind-change checks run before the till hits them. Nothing catches a size typed as a full price, or a combo priced above its dishes. |
| 6 | Recognition Rather Than Recall | 2 | What a size's price box means depends on an earlier step; "first N free" means earliest in the list, which the owner must remember. |
| 7 | Flexibility and Efficiency | 2 | Bulk attach is good. No "Save and add another", no Duplicate group, reordering is one press (and one save) per step. |
| 8 | Aesthetic and Minimalist Design | 2 | Paragraph-length amber/red sentences inside cards; on a phone the report spends ~880px on header and KPIs before the first table. |
| 9 | Error Recovery | 3 | Refusals name the dish, the cause and the fix; many run past 40 words. |
| 10 | Help and Documentation | 3 | Tips everywhere, empty states with examples. No setup-guide step for Customization (src/shared/onboarding/); the Help entry is ~11.5k characters of long sentences. |
| **Total** | | **25/40** | **Acceptable** |

## Design Specificity Verdict

**LLM assessment:** The words are Crest's; the layout is not. Copy and behaviour are unmistakably a Nepali F&B tool: Half/Full momo, a dal-rice-tarkari thali, a NPR 350 Momo Combo, VAT vs PAN bill, BS date ranges, "NO onion" in bold on the kitchen ticket, below-zero refusals that name the dish. The till picker is built for service: 48px chips that don't reflow, Add that stays pressable and says what is missing, "Same as last". The owner screens are a generic product-variants admin: a card per group, a header row of badges and buttons, a table of options. Any shop app could use them unchanged. The Modernist idea (rule weight and one rationed accent organising the page) is not what organises these screens; the accent is spent on every card instead. (A's note on the card drop shadow was dropped in synthesis: the shadow is the uniform `--theme-card-shadow` policy in DESIGN.md, not module drift.)

**Deterministic scan:** detect.mjs over the module: exit 0, zero findings. Controls: a planted JSX file triggered 2 findings, and a scan over all of src found 3 elsewhere (ModuleGuideTab.jsx:276 design-system-color, :290 design-system-radius; viewPosBill.js:25 design-system-color), so the rules are live and the module genuinely passes them. Only hex: CustomizationReport.jsx:84 chart tick colour (allowed). Supplementary greps clean: no unnamed icon buttons, no clickable divs, no window.confirm, no raw error text, every input labelled. Not flagged by the detector: 298 inline `style={{` across 13 files (OptionGroups 58, ComboEditorModal 36, OptionModal 35, CustomizationReport 30). The detector and the design review agree the craft layer is clean; every priority issue below is about flow, wording and emphasis.

**Visual overlays:** Injection succeeded on groups, combos and report. Each logged 6 `undersized-ui-text`, all in the app shell (sidebar/topbar "Admin", "Admin View", "crest-v478" at 10px; Layout.css:535, 609, 1041, 1055, 1265), none in module content. False positives for this system: DESIGN.md documents 10px `micro` as a real token and 10px is the house floor. The scan ran in admin view with no client selected, so the pages stopped at "Loading…" and the overlay saw no list or table. The design review saw real data (BLOOM CAFE: 7 groups, 1 combo, report data) via the admin view switcher. Screenshots timed out after the first; 390px was measured through the DOM; tablet width and the till pickers (PIN sign-in) were reviewed from source only.

## Overall Impression

The guards underneath are the best in the product: money is checked to the paisa before the till can be surprised. The setup experience on top is less forgiving: the one mistake that costs money (a size price typed the wrong way) passes every check, and every group gets the same weight, so an owner can't see what's left to do. Biggest opportunity: turn Option Groups into a to-do list that walks the owner from "new group" to "on the till", in the order that keeps prices right.

## What's Working

1. Money guarded before service, not during it (optionChecks.js:76-184): below-zero, shortfall and kind-change checks name the affected dishes on Hide, Show again, Delete, Edit and Attach.
2. Rules read back in the guest's words: "Guests will see: Pick exactly 1" (OptionGroupModal.jsx:257), "Dish price NPR 271 → this size NPR 316", the combo per-pick split.
3. The till picker survives interruption: 48px chips, Add stays pressable then jumps to and focuses the group still short (OptionPickerModal.jsx:143-156), no total before a size is picked, a stray backdrop tap doesn't lose picks.

## Priority Issues

**[P1] A size's price means two different things, and the page teaches the order that gets it wrong**
- What: Until a Size group is on a dish the price box reads "Price difference from the dish"; once it is, "Price of this size" (OptionModal.jsx:313-317, :383-384). The post-create flash says "now add its options with + Option" (OptionGroups.jsx:765) and the empty state says to put groups on dishes afterwards (:523).
- Why: An owner copying "Full 250" off the menu stores +250 and Full rings at dish + 250. Putting the group on dishes shows no resulting prices (AttachToDishesModal.jsx warns only below zero), so nothing flags it until a bill does.
- Fix: For a Size group, ask "Which dishes?" in New Group, or make "Put it on dishes" the next step after create. When putting a Size group on dishes, show each dish's resulting size prices.
- Command: /impeccable shape, then /impeccable clarify

**[P1] Overlapping words for a second-language reader**
- What: "Option Groups" with an "Option" column; a dish has "Add choices" and "Choices…"; one kind is "Choice" (customizationData.js:128); "Pick" is a combo slot (ComboEditorModal.jsx:194), a rule and an allowance; the tab says "Custom" (Layout.js:1383).
- Why: PRODUCT.md asks that owner, staff and support say the same words.
- Fix: One glossary applied everywhere including Help: choice / choice group; rename the "Choice" kind; combo picks become parts; tab says "Choices".
- Command: /impeccable clarify

**[P2] The accent is on every card, so the group that needs work doesn't stand out**
- What: Every card's "+ Option" is btn-primary (OptionGroups.jsx:547), plus "+ New Group": 8 accent buttons on BLOOM CAFE. "Not on any dish" is 12px amber text.
- Why: DESIGN.md rations the accent to what can be pressed or is current.
- Fix: Card actions ghost; only an unfinished group's next step primary; "Not on any dish" becomes an amber badge.
- Command: /impeccable quieter

**[P2] New Group opens with the hardest idea, and its Create button falls off a phone screen**
- What: Default kind Add-ons (OptionGroupModal.jsx:64) shows the "When a bigger size is picked" chooser on every new group; every Size option shows "Portion". At 390px the dialog is 888px tall in an 844px viewport, Create at y=869, no scrolling body or pinned footer.
- Why: The owner new to computers meets build-your-own scaling first and can't find the save button.
- Fix: Show size scaling and Portion only for a client with a build-your-own dish, or under "More options"; give the dialog OptionModal's scrolling panel.
- Command: /impeccable distill, then /impeccable adapt

**[P2] The combo editor shows the price comparison but never says whether it's a deal**
- What: "Test Combo" NPR 500; "the cheapest dish of every pick comes to NPR 497" in grey (ComboEditorModal.jsx:166-170), no verdict.
- Why: Highest-stakes number on the screen; the module guards paisa elsewhere.
- Fix: "Guests save NPR 47" when it's a deal; "△ Guests pay NPR 3 more than ordering these separately" in amber when not.
- Command: /impeccable clarify

## Persona Red Flags

- Owner new to computers, on a phone: "Custom" tab; empty state with no button; new group isn't Size yet shows size scaling; Create below the fold; then the size-difference trap; 3 dialogs and 4 saves, next steps only as small green text; no setup-guide step.
- Waiter on the shared till: "Choices" tile cue 10px text3 (MenuGrid.jsx:86); one tap silently adds the default (Full); combo picker opens a second window over the first for a dish with a required choice.
- Alex: no "Save and add another" (OptionGroups.jsx:788-798); no Duplicate group; 7 presses (7 saves) to move the 8th option to the top.
- Sam: 4 Tab stops per option row (60+ for 7 groups); full till chips use `disabled` (OptionPickerModal.jsx:241) so "Max 2" is never announced.
- Casey: btn-sm 32px on touch; ↑/↓ 30×30 and 2px apart (OptionGroups.jsx:614-620); combo extra-charge boxes 73×28 at 390px.

## Minor Observations

- "1 plates" (CustomizationReport.jsx:774, :781).
- Chart axis "10/07/2083" vs footer "17 Kartik 2083" (:810).
- Report at 390px: header 290px, 6 KPI tiles stack to 590px (not stat-grid--pair), tabs at y=1361, Popular table 403px in 348px.
- "Ticket: Regular" prints even when ticket name equals option name (OptionGroups.jsx:625).
- 50-word "first N free" paragraph in the card (OptionGroups.jsx:568) belongs in a Tip.
- "+ New Group" plain button vs "+ New combo" Fab (OptionGroups.jsx:460, Combos.jsx:227).
- Admin view, no client: "off for this client" over a never-ending "Loading…" on all three pages (OptionGroups.jsx:90/119, Combos.jsx:57/72, CustomizationReport.jsx:360/377). Found independently by both assessments.
- "Options cannot be saved right now" flashes on client switch before settings resolve.
- ComboDishPicker.jsx:83 truncates names; AttachToDishesModal fixed this in S863.
- AttachGroupsModal names Option Groups without linking (:259).
- "Includes VAT · how a no-VAT dish charges it" (OptionModal.jsx:395) is a cryptic Tip trigger.

## Questions to Consider

- Should a size be two price boxes on the dish in Menu Pricing, leaving Option Groups for extras?
- Would an owner think in "groups", or by dish ("Chicken Momo: Size, Extras")?
- How many Half plates ring as Full because one tap adds the default silently?
- The module refuses one paisa below zero but lets a combo cost more than its dishes. Which costs more?
