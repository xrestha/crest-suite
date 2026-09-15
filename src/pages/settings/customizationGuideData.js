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
          'Sold flat, per client, at the price saved on Admin → Settings → Plan Pricing (NPR 2,000 a month is the shipped default). Admin switches it on from Admin → Clients; a trial gets it on with every other module. Switching POS off switches it off too — nothing here exists without a till.',
          'Setup, in order: build a few shared groups on Custom → Option Groups (Size, Extras, Spice), add each group\'s options, then PUT EACH GROUP ON ITS DISHES. A group that is on no dish offers nothing, and the page says so in amber until it is.',
          'Service: a dish with choices either adds in one tap (when its pre-selected defaults already satisfy every rule) or opens the choice window; the guest menu shows the same choices on a phone sheet. The server prices every line from the option ids alone.',
          'Reading it back: Custom → Customization Report — what the extras earned, what sizes took off, what is most added, how often each dish is customized, the most common "No …" requests, and (with IMS) whether a paid choice earns more than its stock lines cost.',
        ],
        fields: [
          { label: 'Who can edit', desc: 'Admin, the Owner, a POS manager or an IMS manager — the same set that may set a menu price, tested on the raw pos_role / ims_role columns because the database (caller_can_set_menu_price) tests the same. A POS supervisor or waiter is sent to the dashboard by URL as well as by nav.' },
          { label: 'Group, option, attachment', desc: 'A GROUP is a question ("Size?", "Extras?") with a pick rule. An OPTION is one answer with a price, a kitchen name, a diet mark, allergens and (with IMS) stock lines. An ATTACHMENT is a group put on one dish, carrying that dish\'s own overrides — a stricter min/max and a pre-selected option for that dish only.' },
          { label: 'Three kinds', desc: 'Size — the guest picks exactly one and each size sets the whole dish price. Add-ons — the guest can pick several and each can add to the price (a "No onion" is an add-on marked as TAKING SOMETHING OFF, always free, printed as NO onion). Choice — a pick from a list, usually free (Mild / Medium / Hot). Only Size behaves differently in the editor: its price is entered as the full menu price of that size.' },
          { label: 'Where the money is decided', desc: 'Nowhere on a tablet. The till and the guest sheet show a price computed by the browser twin of the server\'s pricer (optionPricing.js), and save_pos_order_items prices the line from the option ids — selling price + Σ price_delta, with each group\'s first N picks free — and writes a snapshot of every choice (pos_order_item_options) that no later edit of the menu can change.' },
        ],
        formulas: [
          'Line price = dish selling price + Σ price_delta of the picked options, with the first included_count picks of each group free — "first" meaning earliest in the group\'s display order among what was picked, not the cheapest.',
          'A line\'s identity = recipe + selection: "Momo, Half + cheese" and "Momo" are two lines on the same bill and never merge. A line with no picks keys exactly as a plain dish did before the module existed.',
        ],
        gotchas: [
          'Order is a fact the owner sets. Options move within a group and groups move on the page (Move up / Move down), and a dish\'s groups reorder in its Choices dialog. Guests see options in that order, and it is also what decides which picks are free under a first-N deal.',
          'A choice with no stock lines changes NOTHING in stock or food cost. Fine for spice level; wrong for "Extra cheese". Option Groups flags every such option in amber under the Stock column.',
          'Nothing is clamped. "No onion" on a dish whose recipe has no onion still takes onion off in the ledger; a negative usage is a data-entry problem the Stock Movements page shows, not one the module hides.',
          'A dish already sent to the kitchen cannot have its choices changed — remove it (with a reason, recorded as a pulled item) and add it again, which prints a fresh ticket. Change exists only on an unsent line.',
          'Deleting a group or an option is refused nowhere and regretted often: bills already rung keep what was chosen (the snapshot), but the option is gone from every dish in its group. Hide is the safe verb — it keeps everything and offers nothing.',
        ],
        connections: 'Reads recipes (the dishes and, with IMS, sub-recipes as stock lines) and items. Writes four tables of its own (pos_option_groups, pos_options, pos_recipe_option_groups, pos_option_ingredients) plus the per-line snapshot on every bill. Feeds POS billing, the KOT/BOT tickets and the Kitchen Display, the guest menu, and — through sales_entries.ingredient_deltas — every IMS usage reader: Stock Report, Reorder, Variance, Shrinkage, FIFO, Stock Ageing, Dead Stock and the Monthly Owner Report.',
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
        title: 'Option Groups — Groups tab',
        route: '/customization/groups',
        plan: 'Owner, POS manager, IMS manager, admin',
        summary:
          'One card per group: its name, kind, pick rule, how many dishes it is on, and its options as a table in display order. Every card has ONE next step visible (+ Option), the attach button (Put it on dishes), and everything else under ⋯ — Edit, Move up / down, Hide, Delete. Every option row has Edit visible and Hide / Delete under ⋯, with ↑↓ to reorder.',
        workflow: [
          '+ New Group → name it as guests will read it ("Extras", "Choose your size"), pick the kind, and for anything but a size build the rule from two dropdowns: "Guests may skip this and can pick up to 3". The dialog previews the sentence guests will see.',
          '+ Option on the card → name, whether it adds something or takes something off, the price, then More details (kitchen ticket name, veg/egg/non-veg, allergens, pre-selected, shown) and — with IMS — Stock per plate: item first, then the amount in THAT item\'s unit.',
          'Put it on dishes → tick every dish that offers the group, with a select-all per category and a search box. One save. The card\'s "On N dishes" updates; the amber "Not on any dish" disappears.',
          'Move up / Move down (groups, under ⋯) and ↑↓ (options, first column) set the order guests see. Under any first-N-free group the card says which picks are the free ones and why the order matters.',
          'Build-your-own template (S760) → pick the dish and, if you like, a shorter name for its groups. One save creates "<dish> · Size" (Small 0.75, Medium, Large 1.5), "· Base" (pick 1, uses more at a bigger size), "· Sauces" (up to 2, uses more) and "· Toppings" (any number, uses more and costs more), puts them on the dish in that order and marks it build-your-own. Nothing is priced: add the bases, sauces and toppings with + Option and set every price. If groups with those names already exist, nothing is created.',
        ],
        fields: [
          { label: 'Price (Size on same-priced dishes)', desc: 'Typed as the full menu price of that size — "Half 150, Full 250" — because every dish this group is on currently costs the same, so the difference from the dish is worked out for you. The moment the group is on two dishes with different prices the field flips to a DIFFERENCE from the dish price and shows each dish\'s result underneath.' },
          { label: 'Price (Add-ons / Choice)', desc: 'What the option adds to the dish, as the guest pays it (including VAT when the outlet is VAT-registered; stored before VAT). Blank or 0 = free. A "takes something off" option is always free and the price box is not shown.' },
          { label: 'Free picks before charging', desc: 'Add-on groups only. "First 2 free" makes the earliest-listed two of a guest\'s picks free and charges for the rest. Put the options you are happy to give away at the top of the list. The till and guest sheet mark a free pick as Included and count "1 of 2 free picks used".' },
          { label: 'Pre-selected', desc: 'Ticked when the choice window or guest sheet opens, on every dish this group is on (a dish can override it with its own default in its Choices dialog). A dish whose required groups all have a pre-selected option adds in ONE TAP on the till — the window never opens unless something still has to be chosen.' },
          { label: 'Shown on the till and guest menu', desc: 'Unticked = Hidden: kept, on its dishes, offered nowhere. The same switch as Hide on the card. Use it for "out of cheese today".' },
          { label: 'Stock per plate (IMS)', desc: 'Signed lines: "Extra cheese" ADDS 30 g of SMK Cheese; "No onion" TAKES OFF 20 g of onion; a Half size TAKES OFF 5 pcs of momo. Per one plate, in the item\'s own unit, and a sub-recipe can be a line. These are frozen onto every bill line as ingredient_deltas and consumed by every IMS usage reader.' },
          { label: 'Portion (Size options)', desc: 'How big this size is against a regular plate: Small 0.75, Medium blank (1), Large 1.5. It does nothing on its own; groups set to scale with the size use it. A Size group whose sizes carry a portion cannot be changed to another kind until the portions are cleared.' },
          { label: 'When a bigger size is picked (other groups)', desc: 'Same at every size (a spice level, a free sauce) · Scale stock only (a base: a Large bowl gets more acai puree at the same price) · Scale stock and price (paid toppings: chicken popcorn on a Large bowl uses 1.5× and charges 1.5×). The scaled amount is what the bill line freezes and IMS deducts.' },
          { label: 'Changing a live group\'s kind', desc: 'Resets the pick rule for every dish the group is on the moment you save — the dialog says so in amber before you do. Bills already rung are not affected.' },
          { label: 'A price edit and open orders', desc: 'A new price applies to the next dish ordered. Dishes already on a table keep the price they were ordered at — the field says so.' },
        ],
        formulas: [
          'Hide vs Delete: Hide keeps the row, its stock lines, its dishes and its history, and offers it nowhere. Delete removes the option (or the group with all of its options and stock lines) from every dish; bills already rung keep their snapshot.',
        ],
        gotchas: [
          'A group with options and no dish offers NOTHING. Saving a group\'s first option on such a group flashes "not on any dish yet, so nothing offers it" with the button that fixes it. This is the step owners missed in the first release.',
          'The kind cards say what each kind DOES, not just how many the guest picks: Size sets the dish price, Add-ons can add to it, Choice is usually free. Only Size changes the price editor; an add-on with min 1 / max 1 behaves like a choice.',
          'Options and groups created before ordering existed all carry sort 0. The first Move renumbers the whole list to its on-screen order before swapping, so the move you see is the move that saves.',
          'The page notice (green line under the tabs) stays until the next action rather than vanishing on a timer — a flash that disappears in six seconds while you are reading it is not a notice.',
          'Admin can prepare groups on a client whose module is off; an amber banner says nothing is offered until it is switched on in Admin → Clients.',
        ],
        connections: 'Writes pos_option_groups, pos_options, pos_option_ingredients and (via Put it on dishes) pos_recipe_option_groups. Reads recipes for the dish list and, with IMS, items and sub-recipes for stock lines. Everything the till, the guest sheet and the report read starts here.',
      },
      {
        id: 'option-groups-dishes',
        title: 'Option Groups — Dishes tab, and Choices on Menu Pricing',
        route: '/customization/groups',
        plan: 'Owner, POS manager, IMS manager, admin',
        summary:
          'The dish → groups view: every active dish with its price and the groups it offers as chips, in the order the picker shows them, and a Choices… / Add choices button that opens the dish\'s Choices dialog. The same dialog opens from Menu Pricing, where each row\'s link now reads the attached group names in accent ("Size · Extras") or "Add choices". "N of M dishes offer choices" is the count above the table; the rest order exactly as before.',
        workflow: [
          'Choices… on a dish → tick the groups it offers, in the order guests should see them (↑↓ on each ticked row). Per group, optionally set a stricter Must pick / At most for THIS dish only, and a pre-selected option for this dish that overrides the group\'s own.',
          'Save writes a diff: ticked groups first, unticked removed after, so a failure part-way leaves more attached rather than less. The page flashes "X now offers 2 groups" or "now orders with no choices".',
          'From Menu Pricing (either branch): the Choices link on the row opens the same dialog; the label reloads on save so the menu says which dishes are customized without opening anything.',
        ],
        fields: [
          { label: 'Must pick / At most (this dish)', desc: 'Blank = the group\'s own rule. Set to require a pick on this dish only, or to cap it lower. Not shown for a Size group, which is always pick-exactly-one. Minimum above maximum is refused inline, and Save takes the cursor to the field.' },
          { label: 'Pre-selected on this dish', desc: '"Group default" uses whichever options are marked pre-selected in the group; naming one option here overrides that for this dish alone — "Full" on the momo, "Half" on the thali.' },
          { label: 'Order number', desc: 'The small 1. 2. 3. beside a ticked group is the order the picker and the guest sheet show them. The dish\'s order wins over the group\'s page order.' },
        ],
        formulas: [
          'Effective rule for a dish = the dish\'s override where set, else the group\'s own — for min, for max, and for the pre-selected option.',
        ],
        gotchas: [
          'A hidden group that is still on a dish stays listed in the dialog, ticked and badged Hidden, so it can be unticked; it is offered nowhere until shown again.',
          'A group with no options in it can be ticked but offers nothing — the till and guest menu skip any group with nothing to pick, so it can never make a dish unorderable.',
          'The Dishes tab search matches name or category; the count above it is of ALL dishes, not the filtered list.',
          'Build-your-own (S760): ⋯ on a dish → Mark as build-your-own / Make it an ordinary dish. A marked dish wears a Build-your-own badge, always opens its choices on the till, walks the guest through steps on the QR menu, and is costed as a range. A marked dish with no groups says so in amber, because guests would have nothing to build.',
        ],
        connections: 'Writes pos_recipe_option_groups (recipe_id, group_id, min_override, max_override, default_option_id, sort). Menu Pricing reads the attachments only for its row labels; the till and guest RPCs read them to decide what a dish offers.',
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
          'Tapping a dish that has choices does one of two things. If every required group already has a pre-selected default, the dish is added in ONE TAP with those defaults (a Full momo goes on at once). If something still has to be chosen — a size with no default — the choice window opens: one section per group in the dish\'s order, chips for the options, a running price, a quantity stepper, Cancel and Add pinned at the bottom. Either way the cart line shows the choices under the dish name with a Choices / Change button.',
        workflow: [
          'Tap the dish. One-tap add, or pick in the window: a group that allows one pick behaves as a radio (a new pick replaces the old), a group that allows several as checkboxes that stop at the maximum and say "Max 3" on the rest.',
          'Set the quantity with − / + in the footer (4 Full momo is one line of 4), press Add. "Same as last: Half · cheese" at the top restores what this dish was last added with on this till.',
          'Press Add while a group is short and the button does not go dead: the window names the group, scrolls to it and puts the cursor on its first chip.',
          'On an unsent cart line, Choices (a one-tap default line) or Change (a line with picks) reopens the window with the line\'s picks and quantity. Once the line has gone to the kitchen the button is gone — remove and re-add.',
          'Send Order / KOT / BOT print each choice under the dish: "+ Extra cheese", and "NO onion" in bold; the Kitchen Display shows the same. The bill prints the choices under the line at the combined price.',
        ],
        fields: [
          { label: 'Included', desc: 'A pick that is free under the group\'s first-N deal shows "Included" with its list price struck through, and the group line counts "1 of 2 free picks used". Before S759 the window printed "+NPR 50" on a pick that was not charged.' },
          { label: 'The price in the footer', desc: 'The browser\'s twin of the server pricer, shown so the waiter can quote it. The bill is priced by the server from the option ids; the tablet never sends a price.' },
          { label: '"No" prefix', desc: 'A takes-something-off option that is not already named "No …" wears a small grey No chip. It used to be a red ✕ — the same hue as Void, and read aloud as "multiplication sign".' },
          { label: 'Kitchen note', desc: 'The free-text note under the line is for what options cannot say ("serve after starters"). It no longer suggests "no onion" — a note reaches the kitchen but not the bill, stock or any report; the option does all four.' },
        ],
        formulas: [
          'One tap adds when selectionProblems(defaultSelection(groups)) is empty; the window opens otherwise. A dish with only optional groups therefore always adds in one tap, and Choices on the cart line is where its extras are added.',
          'Same choices tapped again add to the same line; different choices are a new line; Change on a line replaces it (or folds it into an identical line already on the order).',
        ],
        gotchas: [
          'If the option catalog cannot be read, the whole menu reads as failed — deliberately. Without it a dish that must have a size could go on plain, which the server accepts because it validates only rows that send options.',
          'Offline works for order-taking as for everything else on the till: the picks are queued as option ids and priced by the server on sync.',
          'A stale menu on another tablet (a price changed mid-service) changes nothing on a line already saved — an existing line keeps its price and its snapshot.',
          'Keyboard: one Tab stop per group, arrows move between chips, Escape cancels the window. Every chip has a visible focus ring now.',
        ],
        connections: 'save_pos_order_items validates the picks against the live menu and the dish\'s rules, prices the line and writes pos_order_item_options. Closing the bill reads that snapshot — never the cart — for stock: sales_entries.ingredient_deltas carries each choice\'s stock lines per plate.',
      },
      {
        id: 'guest-choices',
        title: 'On the QR guest menu',
        route: '/pos/menu/:tableId',
        plan: 'Public, while pos_enabled and guest ordering are on',
        summary:
          'A dish with sizes shows "From NPR x" on its card. Tapping a dish with choices opens a phone sheet: the dish name pinned at the top, one group per section with a Required pill and a plain rule ("Pick 1", "Pick up to 3"), 48px chips with the same veg / non-veg square the menu card uses and any allergens, and the running price on the Add button pinned at the bottom.',
        workflow: [
          'Guest taps the dish, picks, presses "Add to order · NPR 260". A short group is named beside the button, scrolled to and focused; the button stays pressable so the tap can explain itself.',
          'A build-your-own dish (S760) is a stepper instead: "Step 1 of 5 · Size" with a progress bar, one group per step with the size first, Next (which names what is short) or Skip on an optional step with nothing picked, then Review — every group with its picks and a Change button — and Add to order. Changing the size re-prices every pick already made.',
          'Edit choices on a line in the order before sending it reopens the sheet with the line\'s picks.',
          'Send → the request lands on the floor tile as a guest order; Accept → Send on the till re-prices it on the server (pos_price_selection) and writes the snapshot, so a guest\'s phone can never set what they pay.',
        ],
        fields: [
          { label: 'Included / free picks', desc: 'Same as the till: a free pick reads Included with the list price struck through, and the group line counts "1 of 2 free picks used · then +NPR 50 each".' },
          { label: 'Backdrop tap', desc: 'Once anything has been picked, tapping the dim area outside the sheet does NOT close it — the sheet\'s Close button and the phone\'s back gesture do. A thumb brushing the backdrop was discarding a half-built order.' },
          { label: 'Max reached', desc: 'A chip that cannot be picked because the group is at its maximum reads "Max 3" rather than only fading.' },
        ],
        formulas: [
          '"From NPR x" = the dish price plus the cheapest valid pick of each REQUIRED group (a Half at −NPR 100 lowers it; optional extras never do).',
        ],
        gotchas: [
          'The guest RPC (get_guest_menu_options) is public to anon; the pricer (pos_price_selection) is callable by NO client role — it runs only inside the accept path.',
          'Prices on the sheet apply VAT only when the outlet is VAT-registered, the same rule the menu card uses.',
          'The sheet has its own scoped palette and shape language (rounded chips, the guest bone/pine tokens) on purpose — it is the one surface in the product a stranger sees.',
        ],
        connections: 'get_guest_menu_options beside get_guest_menu; submit_guest_order carries option ids; the accept path on the till prices and snapshots. The Customization Report counts guest-picked choices exactly like waiter-picked ones.',
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
        plan: 'Owner, POS manager, IMS manager, admin',
        summary:
          'Four questions an owner asks of their choices, over a date range that opens on this BS month with Today / This month / Last month / Last 3 months presets: which choices are picked (Popular choices), how often guests customize at all (How often customized), what the "No …" requests are, and — with IMS — whether a paid choice earns more than it costs (Choice margin). Every column sorts; Export Excel writes every tab with the range and basis on each sheet.',
        workflow: [
          'Pick a preset or a custom range. Read the five tiles, then the tab you came for.',
          'Popular choices: times picked (in plates), what it charged, and the first three dishes it was picked on (+N more on hover).',
          '"No …" requests, by dish: a request on most plates of a dish means the recipe should probably change — the share column says so.',
          'Choice margin (IMS only): charged per plate against the cost of the choice\'s stock lines at today\'s item rates. A negative margin on a PRICED extra is red with ▼; a free-by-design choice is grey, with a tip — its cost is part of the dish\'s food cost, not a loss on an upsell.',
        ],
        fields: [
          { label: 'Plates of customizable dishes', desc: 'Plates (qty on paid bills, a line of 3 is three plates) of dishes that have a group attached today or sold with a choice in the range.' },
          { label: 'With a choice picked', desc: 'Of those plates, the share carrying at least one choice. A pre-selected size counts, so a dish whose size is always chosen reads as 100% — the tip says so.' },
          { label: 'Extras earned', desc: 'What paid add-ons added to bills: Σ positive price × plates, ex-VAT, before bill discounts. Comped plates add nothing.' },
          { label: 'Size adjustments', desc: 'What sizes priced below the dish took off (Σ negative), shown as −NPR. Kept apart from Extras earned — the old single "Charged for choices" netted the two and could read negative.' },
          { label: 'Most added', desc: 'The most picked option that is not a size and not a "No …" — the old "Most picked" always named the default size, which tells an owner nothing. Reads "—" with "Only sizes were picked" when that is the case.' },
          { label: 'Charged / plate (Margin tab)', desc: 'Average price the choice added per paid plate. Lower than its list price when some picks were free under a first-N deal — the row says "incl. free picks".' },
          { label: 'Cost / plate', desc: 'The choice\'s stock lines AS FROZEN ON THE BILL, valued at TODAY\'s item rates — the lines are what was on the plate; the rate is the only one available and moves with purchases.' },
        ],
        formulas: [
          'Basis, stated on the page, the footnote and every export sheet: paid bills closed in the range; choice prices ex-VAT and before bill discounts; credit notes are not netted off.',
          'Share customized (per dish) = plates with at least one choice ÷ plates sold.',
        ],
        gotchas: [
          'A failed read is a failed report: the tiles and tables do not render over a read that did not complete, and the Margin tab can fail alone (stock lines or item rates unreadable) while the three sales tabs stand.',
          'The Margin tab appears only on a client WITH IMS — an admin viewing a POS-only client does not see it.',
          'The report reads the snapshot on each bill line, so a choice renamed or deleted since still appears under the name it was sold as.',
        ],
        connections: 'Reads pos_orders (paid, closed in range), pos_order_items, pos_order_item_options, pos_recipe_option_groups (who is customizable today), and the option catalog (kind and list price per option). With IMS, the ingredient explosion and items.per_uom_rate for cost.',
      },
    ],
  },
]
