// Crest Customization — deep per-page reference for Admin Settings → Guides → Crest Customization.
// Same shape and voice as posGuideData.js: every section defines all 10 keys (ModuleGuideTab
// renders `.length` with no null guards).
//
// Why a FIFTH guide (S759): the module shipped in S758 with a Help entry and no guide at all, and
// the S759 critique pass changed how the till, the guest sheet and the report behave. A guide that
// describes one page's mechanics is where the "why does the picker not open?" support question
// gets answered, and the four existing guides each belong to a different module.
//
// The `plan` chip carries the RANK gate. Customization is sold FLAT — clients.customization_enabled
// on or off, one monthly price, no tiers — and it exists only on a client with POS.
//
// S867: the words follow the owner's list. What a guest taps is a CHOICE (an "option" in the code
// and in pos_options), a set of them is a CHOICE GROUP (the page is Choice Groups), the kind stored
// as 'choice' reads Preference, a combo slot is a PART, and the top tab is Choices. "Pick" stays
// only as a verb for what a guest does.

export const CUSTOMIZATION_GUIDE_GROUPS = [
  // ───────────────────────────── Overview ─────────────────────────────
  {
    key: 'cust-overview',
    label: 'Overview',
    sections: [
      {
        id: 'cust-overview',
        title: 'What Crest Customization is',
        route: null,
        plan: null,
        summary:
          'A paid add-on to Crest POS that lets a guest or a waiter choose a dish\'s size, extras, "No …" requests and spice or cooking choices, with the bill, the kitchen ticket, stock and the reports all following the choice. Before it, the only lever was a free-text note that changed nothing on the bill, in stock or in any report. The dish itself stays where it always was — Recipe Costing, or Menu Pricing on a POS-only plan; this module adds the CHOICES around it.',
        workflow: [
          'Sold flat, per client, at the price saved on Admin → Settings → Plan Pricing (NPR 2,000 a month is the shipped default). Admin switches it on from Admin → Clients; a trial gets it on with every other module. Switching POS off switches it off too — nothing here exists without a till. It has its own end date (Manage → Billing): seven days after that date the till, the QR menu and these pages stop offering choices and combos, while bills already open keep the dishes on them (S862, owner decision). With no end date it stays on and is not billed, and Admin → Clients marks it "no end date".',
          'Setup, in order: build a few shared choice groups on Choices → Choice Groups (Size, Extras, Spice), then follow the one highlighted button on each group card (S867). A SIZE group goes on its dishes first, then gets its sizes; every other group gets its choices first, then goes on its dishes. A group that is on no dish offers nothing, and its card says "Not on any dish" in amber until it is.',
          'Service: a dish with choices either adds in one tap (when its pre-selected defaults already satisfy every rule) or opens the choice window; the guest menu shows the same choices on a phone sheet. The server prices every line from the ids of the choices alone.',
          'Build-your-own dishes (S760): an acai bowl, a pizza, a salad — a dish the guest assembles. Tick Build-your-own on the dish (Recipe Costing, or ⋯ on the Dishes tab), or let the Build-your-own template create its Size, Base, Sauces and Toppings in one go. The till always opens its choices, the QR menu walks the guest through one step at a time, and with IMS the dish is costed as a RANGE rather than from its few fixed ingredients.',
          'Reading it back: Choices → Customization Report — what the extras earned, what sizes took off, what is most added, how often each dish is customized, the most common "No …" requests, and (with IMS) whether a paid choice earns more than its stock lines cost.',
        ],
        fields: [
          { label: 'Build-your-own (S760)', desc: 'A MARK on the dish (recipes.is_build_your_own), never a category — an acai bowl stays Food, so kitchen/bar ticket routing, its product code and every category split are untouched. It changes three things: the till always opens the choice window (no one-tap default), the guest sheet becomes a stepper, and Recipe Costing / Menu Pricing cost the dish as a range. A marked dish with no groups is flagged in amber — guests would have nothing to build.' },
          { label: 'Portion and size scaling (S760)', desc: 'A Size choice carries a Portion (Small 0.75, Medium 1, Large 1.5), and every OTHER group says what a bigger size does to its choices: nothing, more stock, or more stock and a higher price. So one topping row serves all three sizes: chicken popcorn at 60 g and +NPR 120 becomes 90 g and +NPR 180 on a Large. A size\'s own stock lines are never scaled — they are the size\'s own adjustment. Both settings are for build-your-own dishes, so since S867 the dialogs show them only on a client that has one, or where a group already scales or a choice already has a portion.' },
          { label: 'Who can edit', desc: 'Admin, the Owner, a POS manager or an IMS manager — the same set that may set a menu price, tested on the raw pos_role / ims_role columns because the database (caller_can_set_menu_price) tests the same. A POS supervisor or waiter is sent to the dashboard by URL as well as by nav.' },
          { label: 'Choice group, choice, attachment', desc: 'A CHOICE GROUP is a question ("Size?", "Extras?") with a pick rule. A CHOICE is one answer with a price, a kitchen name, a diet mark, allergens (ticked from the same list of 14 that ingredients use, S870) and (with IMS) stock lines. An ATTACHMENT is a group put on one dish, carrying that dish\'s own overrides — a stricter min/max and a pre-selected choice for that dish only. Until S867 the screens said "option" and "option group"; the code and the tables still do (pos_options, pos_option_groups).' },
          { label: 'Three kinds', desc: 'Size — the guest picks exactly one, and each size is stored as a difference from the dish\'s price, so it follows the dish: raise Veg Momo by NPR 30 on Menu Pricing and every size rises by NPR 30 (Menu Pricing shows what each size becomes before you save). Add-ons — the guest can pick several and each can add to the price (a "No onion" is an add-on marked as TAKING SOMETHING OFF, always free, printed as NO onion; it never uses up a free choice or a place under the group\'s maximum, but it does answer a group that must be picked). Preference — one from a list, usually free (Mild / Medium / Hot); it was labelled Choice until S867 and is still stored as choice. Only Size behaves differently in the editor: once the group is on dishes that cost the same, its price is entered as the full menu price of that size; while it is on no dish, as the difference from the dish price (S867).' },
          { label: 'Where the money is decided', desc: 'Nowhere on a tablet. The till and the guest sheet show a price computed by the browser twin of the server\'s pricer (optionPricing.js), and save_pos_order_items prices the line from the ids of the choices — selling price + Σ price_delta, with each group\'s first N choices free — and writes a snapshot of every choice (pos_order_item_options) that no later edit of the menu can change.' },
        ],
        formulas: [
          'Line price = dish selling price + Σ price_delta of the choices picked, with the first included_count choices of each group free — "first" meaning earliest in the group\'s display order among what was picked, not the cheapest. A "No …" removal is never one of them and does not count toward the maximum, though it does count toward the minimum (S809 4h, Q20). A new line priced below zero is refused (option_price_below_zero).',
          'Size factor = the product of the Portion of each Size choice picked (blank = 1). A choice in a scaling group is then charged round(price × factor, 2) and consumes qty × factor. The free-choices rule runs FIRST, so a choice that is free stays free at every size. One rule in three places: the till RPC, the guest pricer and optionPricing.js.',
          'A line\'s identity = recipe + selection: "Momo, Half + cheese" and "Momo" are two lines on the same bill and never merge. A line with no choices keys exactly as a plain dish did before the module existed.',
        ],
        gotchas: [
          'Order is a fact the owner sets. Choices move within a group and groups move on the page (Move up / Move down), and a dish\'s groups reorder in its Choices dialog. Guests see choices in that order, and it is also what decides which choices are free under a first-N deal.',
          'The scaled amount is frozen onto the bill line when it is saved, so no report multiplies anything later and editing a Portion never rewrites a sale already rung. Change a Portion and only NEW lines follow it.',
          'A choice with no stock lines changes NOTHING in stock or food cost. Fine for spice level; wrong for "Extra cheese". Choice Groups flags such a choice in amber under the Stock column when it adds to the price.',
          'Nothing is clamped. "No onion" on a dish whose recipe has no onion still takes onion off in the ledger; a negative usage is a data-entry problem the Stock Movements page shows, not one the module hides.',
          'A dish already sent to the kitchen cannot have its choices changed — remove it (with a reason, recorded as a pulled item) and add it again, which prints a fresh ticket. Change exists only on an unsent line.',
          'Deleting a group or a choice is refused nowhere and regretted often: bills already rung keep what was chosen (the snapshot), but the choice is gone from every dish in its group. Hide is the safe verb — it keeps everything and offers nothing.',
        ],
        connections: 'Reads recipes (the dishes and, with IMS, sub-recipes as stock lines) and items. Writes seven tables of its own (pos_option_groups, pos_options, pos_recipe_option_groups, pos_option_ingredients, and for combos pos_combos, pos_combo_groups and pos_combo_items) plus the per-line snapshot on every bill. Feeds POS billing, the KOT/BOT tickets and the Kitchen Display, the guest menu, and — through sales_entries.ingredient_deltas — every IMS usage reader: Stock Report, Reorder, Variance, Shrinkage, FIFO, Stock Ageing, Dead Stock and the Monthly Owner Report.',
      },
    ],
  },

  // ───────────────────────────── Setup ─────────────────────────────
  {
    key: 'cust-setup',
    label: 'Setup',
    sections: [
      {
        id: 'option-groups',
        title: 'Choice Groups — Groups tab',
        route: '/customization/groups',
        plan: 'Owner, POS manager, IMS manager, admin',
        summary:
          'One card per choice group: its name, kind, pick rule, how many dishes it is on (or an amber "Not on any dish" badge beside the name), and its choices as a table in display order. Every card has two buttons, + Choice and Put it on dishes, and the one the group needs next is the highlighted one (S867); everything else is under ⋯ — Edit, Move up / down, Hide, Delete. Every choice row has Edit visible and Hide / Delete under ⋯, with ↑↓ to reorder. (The page was called Option Groups until S867; the address is the same.)',
        workflow: [
          '+ New Group (the floating button on a phone) opens "New choice group" → name it as guests will read it ("Extras", "Choose your size"), pick the kind (Size, Add-ons or Preference; the Size card says to put the group on its dishes before adding the sizes), and for anything but a size build the rule from two dropdowns: "Guests may skip this and can pick up to 3". The dialog previews the sentence guests will see.',
          'Next, press the highlighted button on the card (S867). On a SIZE group that is on no dish it is "Put it on dishes"; the message after creating a Size group says the same ("Put it on its dishes first, so each size takes its full menu price.") with a "Put it on dishes →" button. On a group with no choices it is "+ Choice", and on a finished group nothing is highlighted. The reason for the Size order is the price box: it asks for the full menu price only once the group is on dishes that cost the same. Before that, it asks for the difference from the dish price, so a menu price typed there is counted twice.',
          '+ Choice on the card (the dialog is "New choice in <group>", saved with Add choice; Edit on a row opens the same dialog, saved with Save choice) → name, whether it adds something or takes something off, the price, then More details (kitchen ticket name, veg/egg/non-veg, allergens, pre-selected, shown) and — with IMS — Stock per plate: item first, then the amount in THAT item\'s unit.',
          'Put it on dishes → tick every dish that offers the group, with a select-all per category and a search box. While a search is typed, Select all ticks only the dishes it shows and says how many ("Select all 6 shown"); with no search it ticks every dish (S863). For a Size group, each ticked dish lists what its sizes will cost ("Half NPR 200 · Full NPR 500") before you save (S867). One save. The card\'s "On N dishes" updates; the amber "Not on any dish" disappears.',
          'Move up / Move down (groups, under ⋯) and ↑↓ (choices, first column) set the order guests see. On a first-N-free group, the rule text beside the group name has a Tip saying which choices are the free ones and why the order matters (a paragraph on the card until S867). The arrow you pressed keeps your place while the move saves, and the list cannot be moved again until it has saved (S863). The new order shows as soon as the save answers, and Hide or Show again shows at once the same way; the page then re-checks the list quietly behind it, keeping what is on screen if that re-check fails (S869).',
          'Build-your-own template (S760) → pick the dish and, if you like, a shorter name for its groups. One save creates "<dish> · Size" (Small 0.75, Medium, Large 1.5), "· Base" (pick 1, uses more at a bigger size), "· Sauces" (up to 2, uses more) and "· Toppings" (any number, uses more and costs more), puts them on the dish in that order and marks it build-your-own. Nothing is priced: add the bases, sauces and toppings with + Choice and set every price. If groups with those names already exist, nothing is created.',
        ],
        fields: [
          { label: 'Price (Size on same-priced dishes)', desc: 'Typed as the full menu price of that size — "Half 150, Full 250" — because every dish this group is on currently costs the same, so the difference from the dish is worked out for you. What is stored is that difference, so the size follows the dish when its price changes. The moment the group is on two dishes with different prices the field flips to a DIFFERENCE from the dish price and shows each dish\'s result underneath. A price that would put any of those dishes below zero is refused, naming the dish, because the till refuses such a line. Since S835 the check is the whole dish, not one choice at a time (its cheapest valid set of choices across every group it offers, free choices and size scaling included), so two money-off choices that only go below zero together are refused too, and so is Show again on a hidden group or choice that would do it.' },
          { label: 'Price (Size on no dish yet)', desc: 'A Size group that is on no dish has no dish price to start from, so its price box is "Price difference from the dish (incl. VAT), not the menu price". An amber △ line under it says so with a worked example (S867): for Full at NPR 400 on a NPR 250 dish, type 150. Typing the menu price here counts it twice: 400 would be stored as +400, and a Full on that dish would bill NPR 650. Put the group on its dishes first and the box asks for the full menu price instead.' },
          { label: 'Price (Add-ons / Preference)', desc: 'What the choice adds to the dish, as the guest pays it (including VAT when the outlet is VAT-registered; stored before VAT). Blank or 0 = free. A "takes something off" choice is always free and the price box is not shown.' },
          { label: 'Free choices before charging', desc: 'Add-on groups only, under More settings in the group dialog ("None — every choice is charged" by default). "First 2 free" makes the earliest-listed two of the choices a guest picks free and charges for the rest. Put the choices you are happy to give away at the top of the list. A "No …" choice is never a free choice, wherever it is listed. The till and guest sheet mark a free choice as Included and count how many free choices are used. On the card, the Tip on the rule text explains the same (S867).' },
          { label: 'Pre-selected', desc: 'Ticked when the choice window or guest sheet opens, on every dish this group is on (a dish can override it with its own default in its Choices dialog). A dish whose required groups all have a pre-selected choice adds in ONE TAP on the till — the window never opens unless something still has to be chosen.' },
          { label: 'Shown on the till and guest menu', desc: 'Unticked = Hidden: kept, on its dishes, offered nowhere. The same switch as Hide on the card. Use it for "out of cheese today".' },
          { label: 'Stock per plate (IMS)', desc: 'Signed lines: "Extra cheese" ADDS 30 g of SMK Cheese; "No onion" TAKES OFF 20 g of onion; a Half size TAKES OFF 5 pcs of momo. Per one plate, in the item\'s own unit, and a sub-recipe can be a line. These are frozen onto every bill line as ingredient_deltas and consumed by every IMS usage reader.' },
          { label: 'Portion (Size choices)', desc: 'How big this size is against a regular plate: Small 0.75, Medium blank (1), Large 1.5. It does nothing on its own; groups set to scale with the size use it. A Size group whose sizes carry a portion cannot be changed to another kind until the portions are cleared. Since S867 the choice dialog shows Portion only when the client has a build-your-own dish, a group already scales with the size, or this choice already has a portion.' },
          { label: 'When a bigger size is picked (other groups)', desc: 'Same at every size (a spice level, a free sauce) · Scale stock only (a base: a Large bowl gets more acai puree at the same price) · Scale stock and price (paid toppings: chicken popcorn on a Large bowl uses 1.5× and charges 1.5×). The scaled amount is what the bill line freezes and IMS deducts. Since S867 the group dialog shows this only when the client has a build-your-own dish, or the group already scales.' },
          { label: 'Changing a live group\'s kind', desc: 'Resets the pick rule for every dish the group is on the moment you save, including any rule a dish had of its own — the dialog says so in amber before you do, and the database clears those per-dish rules in the same save. Bills already rung are not affected.' },
          { label: 'A price edit and open orders', desc: 'A new price applies to the next dish ordered. Dishes already on a table keep the price they were ordered at — the field says so.' },
        ],
        formulas: [
          'Hide vs Delete: Hide keeps the row, its stock lines, its dishes and its history, and offers it nowhere. Delete removes the choice (or the group with all of its choices and stock lines) from every dish; bills already rung keep their snapshot. Before either, the page says when it would leave a dish with fewer choices than it must pick (that dish can no longer be ordered) or with nothing left to pick in the group (the dish is then ordered without it), and a group card names any dish already in the first state (S809 4h, CUSTOMIZATION-8).',
        ],
        gotchas: [
          'A group with choices and no dish offers NOTHING. Saving the first choice in such a group flashes "not on any dish yet, so nothing offers it" with the button that fixes it, and the card keeps an amber "Not on any dish" badge beside its name until it is on one. This is the step owners missed in the first release.',
          'The kind cards say what each kind DOES, not just how many the guest picks: Size prices the dish and moves with it, Add-ons can add to it, Preference is usually free. Only Size changes the price editor; an add-on with min 1 / max 1 behaves like a preference.',
          'Choices and groups created before ordering existed all carry sort 0. The first Move renumbers the whole list to its on-screen order before swapping, so the move you see is the move that saves.',
          'The page notice (green line under the tabs) stays until the next action rather than vanishing on a timer — a flash that disappears in six seconds while you are reading it is not a notice.',
          'Admin can prepare groups on a client whose module is off by typing /customization/groups: the Choices tab at the top, its command palette entries and the Choices links on Menu Pricing appear only once it is switched on. An amber banner there says nothing is offered until it is switched on in Admin → Clients.',
          'In the Crest admin view with no client picked, the page says to pick a client in the top-left switcher instead of loading forever (S867). Combos and the Customization Report do the same.',
          'A button that cannot be used yet (Build-your-own template or Put it on dishes before any dish is made, Save with nothing changed) stays pressable and says what to do first, instead of sitting grey with the reason in a tooltip a tablet never shows (S863). A Save stays pressable while it saves and shows Saving…; a second press does nothing until the first answers.',
          'In the choice dialog, "Adds or changes something" and "Takes something off" are two cards: one Tab stop, arrow keys to switch. Each stock line says under its own box whether the item or the amount needs fixing (S863).',
          'Stock per plate "none" is flagged amber with △ only on a choice that adds to the price ("Extra cheese" with no cheese taken off stock). A free choice, a "No …" and a size that scales the portion are fine with no lines, and say so in grey (S863).',
          'A client with no groups yet sees "No choice groups yet." with the reminder to put a Size group on its dishes before adding its sizes, and a + New Group button (S867).',
          'A kitchen ticket name that only repeats the choice name ("Regular" under "Regular") is no longer shown under it in the table (S867).',
          'On a phone the table of choices shows the name, the price, Edit and ⋯; Shown as, Diet & allergens and Stock are on a wider screen, and the Hidden / Pre-selected / Takes off marks sit under the name (S863).',
          'S852: the Choice Groups load and every save on it and in its dialogs give up after 20 s. A load shows the error card with Try again; a save gives the button back and says it may have landed. Put it on dishes removes the group from dishes in chunks, so a large menu works, and a stop part-way lists which dishes came off and which still offer the group.',
        ],
        connections: 'Writes pos_option_groups, pos_options, pos_option_ingredients and (via Put it on dishes) pos_recipe_option_groups. Reads recipes for the dish list and, with IMS, items and sub-recipes for stock lines. Everything the till, the guest sheet and the report read starts here.',
      },
      {
        id: 'option-groups-dishes',
        title: 'Choice Groups — Dishes tab, and Choices on Menu Pricing',
        route: '/customization/groups',
        plan: 'Owner, POS manager, IMS manager, admin',
        summary:
          'The dish → groups view: every active dish with its price and the groups it offers as chips, in the order the picker shows them, and a Choices… / Add choices button that opens the dish\'s Choices dialog. The same dialog opens from Menu Pricing, where each row\'s link now reads the attached group names in accent ("Size · Extras") or "Add choices". "N of M dishes offer choices" is the count above the table; the rest order exactly as before.',
        workflow: [
          'Choices… on a dish → it opens at once from the list the page already holds, with no wait (S869; from Menu Pricing it reads the groups first). Tick the groups it offers, in the order guests should see them (↑↓ on each ticked row). Per group, optionally set a stricter Must pick / At most for THIS dish only, and a pre-selected choice for this dish that overrides the group\'s own.',
          'Save writes a diff: ticked groups first, unticked removed after, so a failure part-way leaves more attached rather than less. The page flashes "X now offers 2 groups" or "now orders with no choices".',
          'From Menu Pricing (either branch): the Choices link on the row opens the same dialog; the label reloads on save so the menu says which dishes are customized without opening anything. With no choice groups made yet, the dialog says to create one on the Choice Groups page first, with a link to it (S867).',
        ],
        fields: [
          { label: 'Must pick / At most (this dish)', desc: 'Blank = the group\'s own rule. Set to require a choice on this dish only, or to cap it lower. Not shown for a Size group, which is always pick-exactly-one. Minimum above maximum is refused under the box that is wrong, and Save takes the cursor to that box (S863).' },
          { label: 'Pre-selected on this dish', desc: '"Group default" uses whichever choices are marked pre-selected in the group; naming one choice here overrides that for this dish alone — "Full" on the momo, "Half" on the thali.' },
          { label: 'Order number', desc: 'The small 1. 2. 3. beside a ticked group is the order the picker and the guest sheet show them. The dish\'s order wins over the group\'s page order.' },
        ],
        formulas: [
          'Effective rule for a dish = the dish\'s override where set, else the group\'s own — for min, for max, and for the pre-selected choice.',
        ],
        gotchas: [
          'A hidden group that is still on a dish stays listed in the dialog, ticked and badged Hidden, so it can be unticked; it is offered nowhere until shown again.',
          'Below zero, whole dish (S835): ticking or unticking a group in the Choices dialog, or in Put it on dishes, is refused when it lets the dish be ordered below zero, naming the choices that get it there. A dish that can ALREADY go below zero, and that this save does not make worse, is named with a △ warning instead of a refusal: the fix is a price in Choice Groups. On Menu Pricing and Recipe Costing (S862), a price is checked against the dish\'s choices the same way; if the choices cannot be read the row says "Choices not checked — couldn\'t read them" (while they are still loading, "Checking choices…") and the price still saves (owner decision), since the till refuses a below-zero line anyway. The check uses the exact stored figure, as the till does: a choice may bring a dish to exactly NPR 0.00, and a few paisa below that is refused (S862, owner decision).',
          'A group with no choices in it can be ticked but offers nothing — the till and guest menu skip any group with nothing to pick, so it can never make a dish unorderable.',
          'The Dishes tab search matches name or category; the count above it is of ALL dishes, not the filtered list.',
          'Build-your-own (S760): ⋯ on a dish → Mark as build-your-own / Make it an ordinary dish. A marked dish wears a Build-your-own badge, always opens its choices on the till, walks the guest through steps on the QR menu, and is costed as a range. A marked dish with no groups says so in amber, because guests would have nothing to build. Its "typical build" is the most-picked build on bills PAID in the last 30 days, dated by when the bill closed; voided, still-open and written-off bills do not count (S792 stage 3, RECIPES-10). A typical build a guest could not order (a required choice left empty) is costed as the cheapest build instead, and its tip says so (S856).',
        ],
        connections: 'Writes pos_recipe_option_groups (recipe_id, group_id, min_override, max_override, default_option_id, sort). Menu Pricing reads the attachments only for its row labels; the till and guest RPCs read them to decide what a dish offers.',
      },
      {
        id: 'combos',
        title: 'Combos — set meals and pick-your-own deals',
        route: '/customization/combos',
        plan: 'Owner, POS manager, IMS manager, admin',
        summary:
          'A combo is sold at one price ("Momo Combo, NPR 350") and is made of PARTS ("Momo", "Drink"; called picks until S867). A part is one dish from a short list, and each dish can carry an extra charge ("Chicken +50"). A part with one dish is included automatically, so a combo whose every part has one dish is a SET MEAL the till adds in one tap; a PICK-YOUR-OWN deal asks one question per part. The page lists every combo with its price, its parts ("Momo (3) · Drink (2)"), whether it is on the till and the QR menu, and Edit; Hide, the QR-menu switch and Delete sit under ⋯.',
        workflow: [
          '+ New combo → a name, the price the guest pays (VAT included on a VAT outlet), an optional description for the guest menu, and whether it is on sale and on the QR guest menu.',
          '+ Add a part → under the Parts heading, each part has a name box labelled Part 1, Part 2 and so on. Name it as guests will read it ("Drink"), then + Add dishes: every active dish under its category with a search box. Tick one dish for a fixed part of a set meal, several to let the guest choose. Long dish names wrap rather than being cut short (S867). A dish that is not On POS can still be in a combo and is marked "not sold alone" (a side that only comes in combos).',
          'For each dish in a part: an Extra charge (blank = none) and, when the part has several dishes, which one is the Default (or "No default — the guest chooses"). ↑↓ reorder the parts and the dishes in them; that order is the order the till and the guest menu show.',
          'Read the split: each part shows "about NPR x of the price" — what its dish will be recorded at on the bill — before you save. Then Create combo.',
          'Read the verdict under the price (S867). The editor compares the combo with the cheapest dish of every part ordered on its own. When the combo is cheaper it says "A guest who takes the cheapest dish in every part saves NPR X against ordering them on their own." When it costs more, it says in amber "△ A guest who takes the cheapest dish in every part pays NPR X more than ordering them on their own.": lower the price or change the parts. When every part has one dish, it also says "Set meal: every part has one dish, so the till adds the whole combo in one tap."',
          'From Combo Builder (IMS): on a client with Customization, Create as combo on a pairing opens a new combo here with one part per dish (named after the dish\'s category), called after the two dishes, at the suggested price.',
        ],
        fields: [
          { label: 'Price the guest pays', desc: 'The one price for the whole combo, as the guest pays it: VAT included on a VAT-registered outlet, the price itself on a PAN-bill outlet. Stored as typed. A dish\'s extra charge is added on top when the guest picks it.' },
          { label: 'Part', desc: 'One dish the guest gets, chosen from the dishes listed in it (called a pick until S867). Every part needs a name, because guests see it, and names are unique within a combo: Save names the part that is missing one or repeats another. A part with exactly one dish is included automatically and nothing is asked.' },
          { label: 'Extra charge', desc: 'What a dish adds to the combo price when it is picked, as the guest pays it — "Chicken Momo +50" in a part whose cheapest momo is Veg. 0 or more.' },
          { label: 'Default', desc: 'The dish ticked for the guest when the combo opens, on the till and the QR menu. At most one per part; the guest can still pick another.' },
          { label: 'On sale / On the QR guest menu', desc: 'Unticking On sale hides the combo from the till and the guest menu without deleting it (the same as Hide on the list). On the QR guest menu lets guests order it from the table, while it is on sale.' },
          { label: 'Who can edit', desc: 'The same set as Choice Groups: admin, the Owner, a POS manager or an IMS manager. A combo is saved whole, parts and dishes together, through two database functions; Hide and the QR-menu switch write the combo row directly. The database refuses any write to the combo tables below that rank.' },
        ],
        formulas: [
          'Each part\'s share of the combo price = price × (its cheapest dish\'s menu price ÷ the sum of every part\'s cheapest dish\'s menu price), rounded half up to the paisa, with the HEAVIEST part (then the first in the list) taking the remainder so the shares add up to the price exactly and a part that weighs 0 is exactly 0 (S862). Menu price = selling price + VAT on a VAT outlet (13% when the dish has no rate), the selling price on a PAN outlet, to the paisa; an unpriced dish weighs 0, and if every part weighs 0 the parts share equally.',
          'A combo dish\'s bill line = (its part\'s share + its extra charge) ÷ (1 + its own VAT rate), ex-VAT, plus any of its own choices (sizes, add-ons) priced as usual on top.',
          'Because the share follows the CHEAPEST dish of the part, not the dish picked, swapping a dish within its part never moves the other dishes\' prices.',
          'The verdict (S867) = the menu prices of the cheapest dish in every part, added up, less (the combo price + the extra charges on those dishes), to the paisa, on the same VAT basis as the price box. Above zero, the guest saves that much; below zero, the amber △ names what the guest pays extra; exactly zero says "Same price as ordering the cheapest dish in every part on its own." It is shown once a price is typed and every part has a priced dish.',
        ],
        gotchas: [
          'The bill prints ONE line for the combo — its name, the quantity and the total — with its dishes listed under it, unpriced. The kitchen and bar tickets and the Kitchen Display show each dish at its own station with "↳ <combo name>" under it.',
          'Each dish is a real line of its own recipe: it takes its own stock, keeps its own VAT rate and counts as that dish sold, at its share, in every dish report. The Customization Report\'s Combos tab counts the combos.',
          'A bill discount never touches a combo: it spreads over the other dishes only, a percentage is of the non-combo dishes, and a bill of combos alone offers no discount.',
          'Comps and moves take the whole combo: comping, splitting or moving one dish of a combo moves or comps every dish of it, by the same quantity. A whole-bill Complimentary, a Void and a Credit Note take every line anyway.',
          'A guest (or waiter) can swap a dish for another dish of the same part; dropping a dish without a replacement is not allowed — remove the whole combo instead. A dish inside a combo can take its own choices (a size, add-ons), charged on top. Adding a second identical combo makes the first one qty 2 only while none of it has been sent; after a Send it is a combo of its own.',
          'A new combo whose Save gets no answer, or is refused as a name already taken, re-reads the list behind the dialog and says whether a combo of that name is there now, so it is checked rather than saved again under another name (S862).',
          'A dish taken off the menu (made inactive) after it was put in a combo is flagged in amber on the combo\'s card, and the combo cannot be saved again until it is taken out. Deleting a combo leaves bills already rung exactly as they were sold; Hide keeps it for later.',
          'Changing a combo\'s price or dishes applies to the next combo ordered. One already on a table keeps the price and the dishes it was ordered with, even when a dish in it is swapped or its choices changed: the new dish takes the share its part was rung at, plus its own extra charge (S862, owner decision).',
          'In the Crest admin view with no client picked, the page says to pick a client instead of loading forever (S867).',
        ],
        connections: 'Writes pos_combos, pos_combo_groups and pos_combo_items through save_pos_combo / delete_pos_combo (Hide and the QR-menu switch update pos_combos directly); reads recipes for the dish list. The till and the guest menu read the three tables for their menus; save_pos_order_items and submit_guest_order price each combo dish from the split (pos_combo_shares) and tag its bill line with the combo, which the bill, the tickets, comps, moves, the discount rule and the reports all follow.',
      },
    ],
  },

  // ───────────────────────────── Service ─────────────────────────────
  {
    key: 'cust-service',
    label: 'Service',
    sections: [
      {
        id: 'till-choices',
        title: 'On the till — the choice window and the cart',
        route: '/pos/orders',
        plan: 'Any POS login taking orders',
        summary:
          'Tapping a dish that has choices does one of two things. If every required group already has a pre-selected default, the dish is added in ONE TAP with those defaults (a Full momo goes on at once). If something still has to be chosen — a size with no default — the choice window opens: one section per group in the dish\'s order, chips for its choices, a running price, a quantity stepper, Cancel and Add pinned at the bottom. Either way the cart line shows the choices under the dish name with a Choices / Change button.',
        workflow: [
          'A BUILD-YOUR-OWN dish (S760) always opens the window, even when its defaults would cover every rule — building it is the order. Every chip price reads at the size picked so far, so a topping shows its Large price once Large is chosen.',
          'Tap the dish. One-tap add, or pick in the window: a group that allows one behaves as a radio (a new choice replaces the old), a group that allows several as checkboxes that stop at the maximum and say "Max 3" on the rest. A full chip still answers a press (S867): it says "Up to 3 from Toppings. Untick one to choose another." instead of doing nothing.',
          'Set the quantity with − / + in the footer (4 Full momo is one line of 4), press Add. "Same as last: Half · cheese" at the top shows the whole of what this dish was last added with on this till, and restores it.',
          'A tap outside the window does not close it once a choice or the quantity has changed, so a thumb resting on the screen cannot lose the order; Cancel, × or Escape close it (S863).',
          'Combos: picking a dish that needs a choice with no default opens its choices at once. In the combo window, a dish that has choices of its own says "Has choices", and its button is "Change choices" (S867). Swapping a dish in a combo ordered more than once changes it in every one; the window says so ("Both (×2) get this dish") and shows the total for all of them (S863). That total is the bill\'s: the other dishes keep the prices they were rung at, and the new dish takes the old one\'s share plus its own extra charge and choices (S864).',
          'Press Add while a group is short and the button does not go dead: the window names the group, scrolls to it and puts the cursor on its first chip.',
          'On an unsent cart line, Choices (a one-tap default line) or Change (a line with choices picked) reopens the window with the line\'s choices and quantity. Once the line has gone to the kitchen the button is gone — remove and re-add. Only the choices the dish still offers come back into the window (S809 3o, offeredPicks). One hidden or deleted since is taken off and named at the top ("Taken off, no longer offered: Granola"); with no group left, Update dish makes the line plain. "Same as last" restores offered choices only.',
          'While Send is on its way, Change waits for it; a choice changed on a dish just sent goes on as a dish of its own, with a line saying so (S862). A dish already made whose choice was hidden since (printed while the internet was down and put back as already sent) has no Change: its red line says to turn the choice back on in Choice Groups to bill it as made, or take the dish off (S862, owner decision). Changing a line to the choices of another line of that dish joins them, each note kept with its count.',
          'If Customization is switched on or off for the outlet (or stops after its paid-up date) while a till is open, the till reads its menu again at its next sign-in or screen wake, and a save refused for that reason says so and reads the menu again (S862).',
          'Send Order / KOT / BOT print each choice under the dish: "+ Extra cheese", and "NO onion" in bold; the Kitchen Display shows the same. The bill prints the choices under the line at the combined price.',
        ],
        fields: [
          { label: 'Included', desc: 'A choice that is free under the group\'s first-N deal shows "Included" with its list price struck through, and the group line counts "1 of 2 free choices used". Before S759 the window printed "+NPR 50" on a choice that was not charged.' },
          { label: 'The price in the footer', desc: 'The browser\'s twin of the server pricer, shown so the waiter can quote it. The bill is priced by the server from the ids of the choices; the tablet never sends a price. Until every required group has a choice it reads "Choose a size" (or "Choose from <group>") instead of a total. Inside a combo it says what the choices add ("No extra charge", "Choices add NPR 50"), because the combo prices the dish (S863).' },
          { label: 'Size prices', desc: 'A size shows the whole dish price at that size ("Half · NPR 160"), as the guest menu does, never a difference from a price the window does not show (S863, owner decision). Inside a combo a size shows its extra charge, since the combo sets the dish price.' },
          { label: '"No" prefix', desc: 'A takes-something-off choice that is not already named "No …" wears a small grey No chip. It used to be a red ✕ — the same hue as Void, and read aloud as "multiplication sign".' },
          { label: 'Kitchen note', desc: 'The free-text note under the line is for what choices cannot say ("serve after starters"). It no longer suggests "no onion" — a note reaches the kitchen but not the bill, stock or any report; the choice does all four.' },
        ],
        formulas: [
          'One tap adds when the dish is NOT build-your-own and selectionProblems(defaultSelection(groups)) is empty; the window opens otherwise. A dish with only optional groups therefore always adds in one tap, and Choices on the cart line is where its extras are added.',
          'Same choices tapped again add to the same line; different choices are a new line; Change on a line replaces it (or folds it into an identical line already on the order).',
        ],
        gotchas: [
          'If the list of choices cannot be read, the whole menu reads as failed — deliberately. Without it a dish that must have a size could be added plain. Since S809 2h the server refuses that too: save_pos_order_items counts every new line of a customizable dish while Customization is live, choices sent or not, as submit_guest_order does (option_count). A line already on the order keeps its exemption, so a dish that gains a required group mid-meal does not lock a running order.',
          'An unsaved line whose choice is no longer offered, or whose choices no longer fit, is marked in red on the cart (lineChoiceTrouble, S809 3o); a saved line keeps its exemption and, while it is still unsent, gets a grey "Granola is no longer offered" that blocks nothing (savedLineGoneNote, S809 4h). A choices refusal (option_not_on_menu, option_count, option_price_below_zero) names the dish(es) the server names (choiceRefusal.js), and the menu is re-read so the marks appear; "The menu has been reloaded" is added only once that re-read has landed.',
          'Offline works for order-taking as for everything else on the till: the choices are queued by their ids and priced by the server on sync.',
          'A stale menu on another tablet (a price changed mid-service) changes nothing on a line already saved — an existing line keeps its price and its snapshot.',
          'Keyboard: a group where only one can be picked is one Tab stop, with the arrows moving between its chips; in a group where several can be picked each chip is its own Tab stop. Escape cancels the window. Every chip has a visible focus ring now.',
        ],
        connections: 'save_pos_order_items validates the choices against the live menu and the dish\'s rules, prices the line and writes pos_order_item_options. Closing the bill reads that snapshot — never the cart — for stock: sales_entries.ingredient_deltas carries each choice\'s stock lines per plate.',
      },
      {
        id: 'guest-choices',
        title: 'On the QR guest menu',
        route: '/pos/menu/:tableId',
        plan: 'Public, while POS is on, the account is open, Customization is on (to its end date and seven days after) and the table is not Inactive',
        summary:
          'A dish with sizes shows "From NPR x" on its card. Tapping a dish with choices opens a phone sheet: the dish name pinned at the top, one group per section with a Required pill and a plain rule ("Pick 1", "Pick up to 3"), 48px chips with the same veg / non-veg square the menu card uses and any allergens, and the running price on the Add button pinned at the bottom.',
        workflow: [
          'Guest taps the dish, picks, presses "Add to order · NPR 260". A short group is named beside the button, scrolled to and focused; the button stays pressable so the tap can explain itself.',
          'A build-your-own dish (S760) is a stepper instead: "Step 1 of 5 · Size" with a progress bar, one group per step with the size first, Next (which names what is short) or Skip on an optional step with nothing picked, then Review — every group with its choices and a Change button — and Add to order. Changing the size re-prices every choice already made.',
          'Edit choices on a line in the order before sending it reopens the sheet with the line\'s choices.',
          'Send → the server prices the request as it is submitted (submit_guest_order) and it lands on the floor tile as a guest order; Accept → Send on the till prices each line again as it is saved (save_pos_order_items) and writes the snapshot, so a guest\'s phone can never set what they pay.',
        ],
        fields: [
          { label: 'Included / free choices', desc: 'Same as the till: a free choice reads Included with the list price struck through, and the group line counts how many of its free choices are used and says that each one after them adds its price.' },
          { label: 'Backdrop tap', desc: 'Once anything has been picked, tapping the dim area outside the sheet does NOT close it — the sheet\'s Close button and the phone\'s back gesture do. A thumb brushing the backdrop was discarding a half-built order.' },
          { label: 'Max reached', desc: 'A chip that cannot be picked because the group is at its maximum reads "Max 3" rather than only fading.' },
        ],
        formulas: [
          '"From NPR x" = the dish price plus the cheapest valid choice of each REQUIRED group (a Half at −NPR 100 lowers it; optional extras never do). Free choices follow the till\'s rule, the earliest-listed ones free, not the cheapest (S792 stage 3, RECIPES-4): "pick 3, first 2 free" listed Banana +30, Granola +20, Honey +10, Nutella +50 is From +10, not +30. Recipe Costing\'s "Cheapest build" comes from the same search, so the two always agree.',
        ],
        gotchas: [
          'The guest RPC (get_guest_menu_options) is public to anon; the pricer (pos_price_selection) is callable by NO client role — it runs only inside submit_guest_order, which prices the guest\'s request; the till\'s save prices the line itself (save_pos_order_items).',
          'Prices on the sheet apply VAT only when the outlet is VAT-registered, the same rule the menu card uses.',
          'A guest whose choices would price a dish below zero is told "<dish> can\'t be ordered with those choices — pick different ones or ask a staff member" (S835), and the menu is re-read. Nothing is taken off the order, because the choices are still offered.',
          'Each time the guest menu reads the choices (opening the page, Try again, a refused order), the order in progress is checked against them (S862): a choice no longer offered comes off its dish, a dish or combo that then no longer fits comes off the order, and a note at the top names them, for example “A choice on Cafe Latte is no longer offered, so it was taken off. The price in your order is the new one.” Change choices opens on the offered choices only, and “Put it back in my order” on a turned-away order goes through the same check.',
          'Since S767 the sheet wears the app\'s default theme (Modernist Night) with square corners, like the rest of the guest menu (the bone-and-pine palette ran from S604 to S767) — it is the one surface in the product a stranger sees.',
        ],
        connections: 'get_guest_menu_options beside get_guest_menu; submit_guest_order carries the ids of the choices; the accept path on the till prices and snapshots. The Customization Report counts guest-picked choices exactly like waiter-picked ones.',
      },
    ],
  },

  // ───────────────────────────── Reports ─────────────────────────────
  {
    key: 'cust-reports',
    label: 'Reports',
    sections: [
      {
        id: 'customization-report',
        title: 'Customization Report',
        route: '/customization/report',
        plan: 'Owner, POS manager, admin',
        summary:
          'Four questions an owner asks of their choices, over a date range that opens on this BS month with Today / This month / Last month / Last 3 months presets: which choices are picked (Popular choices), how often guests customize at all (How often customized), what the "No …" requests are, and — with IMS — whether a paid choice earns more than it costs (Choice margin). Every column sorts; Export Excel writes every tab with the range and basis on each sheet.',
        workflow: [
          'Pick a preset or a custom range. Read the tiles, then the tab you came for. The range and Export sit at the top beside the title and stay there while the report loads or after it fails to load, so a slow range can be shortened and Try again pressed without reloading the page (S863). A To date before the From date is refused under To, and nothing is shown until it is fixed.',
          'S800 — this is the page the Choices tab opens (the Custom tab until S867). "With a choice picked" and "Extras earned" compare with the same number of days just before the range (one read covers both; sliceByOrders splits them), through the shared compareFigures verdict: ▲/▼ is the direction, green/red whether it is good, ≈ inside 5% or 2 share points / NPR 100. "Most removed" is the top "No …" request. For a range of two weeks or more, a chart shows each of the five busiest customizable dishes\' share customized week by week (weeklyDishShares; a week under 5 plates of a dish is a gap, never 0%), and a dish that fell 10 points or more last week against the week before is named under it. The weeks along the bottom of the chart are named by BS day ("17th Kartik"), and touching or hovering a point says "Week ending 17 Kartik 2083" (S867).',
          'On a phone the summary tiles sit two across, and From / To and Export sit behind a "Dates and export" button, so the figures come first (S867). A count of one reads "1 plate", never "1 plates".',
          'Popular choices: times picked (in plates), what it charged, and the first three dishes it was picked on (+N more on hover).',
          '"No …" requests, by dish: a request on most plates of a dish means the recipe should probably change — the share column says so.',
          'Choice margin (IMS only): charged per plate against the cost of each plate\'s own stock lines as frozen on its bill (a Large bowl\'s scaled topping as a Large\'s), at today\'s item rates (S809 3o, REPORTS-4). A negative margin on a PRICED extra is red with ▼; a choice billed at a list price of 0 on every plate is grey, with a tip — its cost is part of the dish\'s food cost, not a loss on an upsell. A choice made free since keeps its loss in red (REPORTS-12). A SIZE priced below the dish is grey too, its cost being part of the dish cost; any other choice priced below the dish keeps its red ▼ when it loses money (S862).',
        ],
        fields: [
          { label: 'Plates of customizable dishes', desc: 'Plates (qty on paid bills, a line of 3 is three plates) of dishes that have a group attached today or sold with a choice in the range.' },
          { label: 'With a choice picked', desc: 'Of those plates, the share carrying at least one choice. A pre-selected size counts, so a dish whose size is always chosen reads as 100% — the tip says so.' },
          { label: 'Extras earned', desc: 'What paid add-ons and larger sizes added to bills: Σ positive price × plates (a Large at +NPR 40 counts here), ex-VAT, before bill discounts. Comped plates add nothing.' },
          { label: 'Size adjustments', desc: 'What sizes priced below the dish took off (Σ negative), shown as −NPR. Kept apart from Extras earned — the old single "Charged for choices" netted the two and could read negative. Sizes only (S862): a choice that is not a size, priced below the dish, is its own "Cheaper choices" line under the tiles, shown only when there is one.' },
          { label: 'Most added', desc: 'The most picked choice that is not a size and not a "No …" — the old "Most picked" always named the default size, which tells an owner nothing. Reads "—" with "Only sizes were picked" when that is the case. Kind is as billed (the snapshot\'s group_kind, S809 3o), so a size deleted since never wins.' },
          { label: 'Charged / plate (Margin tab)', desc: 'Average price the choice added per plate, at each bill\'s own price. Below its billed list price only when some plates were free under a first-N deal ("incl. free choices") or comped ("incl. comped plates"), and its Tip says how many; a later price change never reads as free choices.' },
          { label: 'Cost / plate', desc: 'Each plate\'s own stock lines AS FROZEN ON ITS BILL (scaled to its size for a scaling topping), at TODAY\'s item rates, averaged over the plates — the rate is the only one available and moves with purchases. Plates billed before the choice had stock lines are left out ("over N of M plates").' },
        ],
        formulas: [
          'Basis, stated on the page, the footnote and every export sheet: paid bills closed in the range; choice prices ex-VAT and before bill discounts; credit notes are not netted off.',
          'Share customized (per dish) = plates with at least one choice ÷ plates sold.',
        ],
        gotchas: [
          'POS managers, the Owner and admin only (S835, owner decision D42). An Inventory-only manager could open it until then, but an Inventory login cannot read till bills, so it always said no choices were picked. Choice Groups and Menu Pricing stay open to an IMS manager.',
          'In the Crest admin view with no client picked, the report says to pick a client instead of loading forever (S867).',
          'Choice margin shows Charged, Cost and Margin per plate to the paisa, and Margin is the shown Charged minus the shown Cost, so the three always add up; red with ▼ only when the margin shown is a loss (S863). On a phone the tab is a list with the margin first. The weekly chart, expanded, shows the same figures as a table.',
          'The workbook (S863) carries a Summary sheet with the tile figures and the period before, a Weekly sheet, the Choice margin sheet even when costs could not be read (it then says so), and a "Combo parts" sheet with a row per dish under its "Part" and its "Share of the part" (S867). Percentages and money are real numbers; a "No …" request leaves Extra charged blank. The file name and every sheet state the range in BS first.',
          'A failed read is a failed report: the tiles and tables do not render over a read that did not complete, and the Margin tab can fail alone (stock lines or item rates unreadable) while the three sales tabs stand.',
          'The Margin tab appears only on a client WITH IMS — an admin viewing a POS-only client does not see it.',
          'The Margin tab costs each choice through the till\'s own recipe book (S828), so a POS manager signed in with a PIN sees the same costs as the Owner. It used to read the item list directly, which a PIN login cannot, and every choice then cost NPR 0.',
          'The report reads the snapshot on each bill line, so a choice renamed or deleted since still appears under the name it was sold as.',
          'Extras earned and Cost / plate are already at the size that was sold (S760): a topping picked on a Large bowl contributes its scaled price and its scaled stock, because both were frozen on the line. There is no separate by-size tab — Recipe Costing\'s cost range is where a dish is compared size by size.',
        ],
        connections: 'Reads pos_orders (paid, closed in range), pos_order_items, pos_order_item_options, pos_recipe_option_groups (who is customizable today), pos_order_item_options with group_kind, list_price_delta and included (as billed), and the catalog of choices only for a snapshot row that has none. With IMS, the ingredient explosion and items.per_uom_rate for cost.',
      },
    ],
  },
]
