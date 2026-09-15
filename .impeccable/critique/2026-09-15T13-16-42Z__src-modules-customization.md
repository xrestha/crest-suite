---
target: crest customization
total_score: 25
max_score: 40
na_heuristics: 
p0_count: 0
p1_count: 3
timestamp: 2026-09-15T13-16-42Z
slug: src-modules-customization
---
## Design Health Score

Method: dual-agent (A: design review · B: detector + browser). Browser evidence unavailable (no logged-in dev server; nothing typed or touched). Detector: 0 findings on src/modules/customization and GuestOptionSheet.jsx — weak evidence, the module is 179 inline style blocks with no CSS file.

| # | Heuristic | Score | Key Issue |
|---|-----------|-------|-----------|
| 1 | Visibility of System Status | 3 | Add on till picker / guest sheet is only `aria-disabled`, no visual rule anywhere (OptionPickerModal.jsx:118, GuestOptionSheet.jsx:135). Menu Pricing Customize dialog closes with no confirmation/count (MenuPricing.js:629). |
| 2 | Match System / Real World | 3 | "Marks" column; before-VAT sentence (OptionModal.jsx:233); "Charged for choices" can go negative. |
| 3 | User Control and Freedom | 2 | No reordering anywhere (OptionModal.jsx:361, AttachGroupsModal.jsx:70) yet "first N free" is list order. Guest sheet backdrop tap discards picks (Modal.js markDirty only sees onInput/onChange). |
| 4 | Consistency and Standards | 2 | Choose groups / Customize / Custom; Hide / Hidden / Not offered / Offer this option; red ✕ on till, nothing on guest sheet; opacity-dimmed rows (OptionGroups.jsx:268,308); tabs lack roving tabIndex/aria-controls/tabpanel. |
| 5 | Error Prevention | 2 | Changing a live group's kind resets pick rule silently (OptionGroupModal.jsx:60); price edits say nothing about open orders; cart note placeholder "(e.g. no onion)" invites free-text removal. |
| 6 | Recognition Rather Than Recall | 3 | Menu Pricing Customize link is 11px text3 with no count, unlike "2 pairings". |
| 7 | Flexibility and Efficiency | 1 | No bulk attach, duplicate, picker search, quantity; picker resets per tap; no report date presets. |
| 8 | Aesthetic and Minimalist Design | 3 | 4 buttons per group header, 3 per option row (2 danger) — RowMenu rule. |
| 9 | Error Recovery | 3 | Guest error lowercases proper group names (GuestOptionSheet.jsx:129); till short-group error not scrolled to. |
| 10 | Help and Documentation | 3 | Attach step lives only in a tooltip. |
| **Total** | | **25/40** | **Acceptable** |

## Design Specificity Verdict

Copy is authored for this product (pick rule as a sentence, sizes as menu price, "No ingredients" marker). Structures are interchangeable: generic card-and-table CRUD stack, plain chip-grid picker with no repeat-order answer, "Most picked" tile that names the default size.

## Priority Issues

**[P1] "First N free" depends on an order nobody can set or see.** Free picks are "first in the list"; list order is creation order, unchangeable; till and guest sheet still print "+NPR 50" on picks that will be free. Fix: ↑↓/drag reordering for options and dish groups; "Free 1/Free 2" slots in the option table; "1 of 2 free picks used" and *included* pricing in picker/sheet. → clarify, harden.

**[P1] Attaching is the hidden step, no bulk path.** Post-create flash says "add options", nothing says "attach"; Menu Pricing link is 11px grey with no count/no save feedback (MenuPricing.js:565, 629); 40 dishes = 40 dialogs. Fix: "Attach to dishes…" on each group card with category select-all; attached names in Menu Pricing in accent-ink; "Now attach it →" flash with button; one action name everywhere. → onboard, distill.

**[P1] Till speed on repeat/bulk orders.** Picker opens on every tap and resets (OptionPickerModal.jsx:22); no qty, no sticky footer, no visual disabled, no scroll-to on refused Add. Fix: qty stepper in footer; sticky footer; "Same as last"; scroll+focus first short group; `.btn[aria-disabled="true"]` rule in Layout.css. → optimize, adapt.

**[P2] Cart row choice UI inline-styled, fights touch floor.** "Change" is an unclassed 10px button (PosOrders.jsx ~3786) forced to 44px under pointer:coarse inside a wrapping row — likely cause of the S758 filed squeeze; × has title only. Fix: summary on own line; Change as btn btn-ghost btn-sm; aria-label on ×; change note placeholder. → layout, polish.

**[P2] Report headline figures mislead.** "Most picked" = default size; "Charged for choices" nets Half discounts, can be negative; free-by-deal rows painted red ▼; range defaults to today; unsortable; "Picked on" unbounded. Fix: "Extras earned" + "Size mix"; exclude defaults / rename "Most added"; "Included in price" not red; default current BS month + presets; sort; top 3 + "+N more". → clarify.

## Persona Red Flags

- Alex (owner, 40 dishes): no bulk attach/duplicate/reorder; no category filter/select-all; stock lines type=number not QtyInput; size preview truncates at 6 (OptionModal.jsx:226); kind change resets rules silently.
- Sam (keyboard/SR): unclassed inline chips/kind cards — UA outline only, no arrow roving in radiogroups (20 options = 20 Tab stops); tabs lack roving tabIndex/aria-controls/tabpanel (OptionGroups.jsx:235, CustomizationReport.jsx:180); ✕ read literally; "Change" no per-line accessible context; opacity rows below AA.
- Casey (guest): backdrop tap loses picks; "+NPR 50" on free picks; veg/egg words vs menu-card squares; lowercased names in error; rule casing inconsistent; max-reached chips dim with no explanation; "Required" 12px text3.
- Bishal (waiter, PIN, mid-rush): picker every tap, resets, no qty; Add scrolls off tablet; note placeholder says "no onion"; sent line can't be changed and the Tip that explains it is on a hidden button; red ✕ shares hue with Void.

## Minor Observations

- Three mental models for removal (Add-ons example / "Remove" group in Help & empty state / option-level toggle).
- "Choice" and "Size" both "Guest picks one"; price-mode difference not on card.
- Success notice (OptionGroups.jsx:249) vanishes at 6s, unrecoverable.
- AttachGroupsModal override error shown inline and as ActionError — two channels.
- Report `imsOn = clientModules.ims || isAdmin` shows Margin tab to admin on non-IMS client.
- "Customized" tip counts default size as customized.
- Stock-line unit before item select, blank until chosen.
- Filed already: report footnote `page-subtitle` `<p>` margin 0, flush under table.

## Questions to Consider

1. Picker on every tap, or only when a required group has no default?
2. Is "kind" worth asking? Size is the only kind with behaviour.
3. Free picks as explicit "included" ticks rather than list order?
4. Should the report lead with "which 'No …' request is on most plates?"
