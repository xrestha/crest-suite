// Help's Module Guide entries for Crest admin tools (shown to the Crest operator only), in a chunk
// of their own (PERF-9, S876). loadHelpFeatures.js fetches this file with the other four module lists.

export const ADMIN_FEATURES = [
                {
                  icon: '🔑', name: 'Staff Login (per client)',
                  guide: 'Every client card in Admin → Clients carries a "Staff Login ↗" button that opens that company\'s employee PIN login — the Crest Staff app — in a new tab. It is the same link the client\'s own manager shares with their team from HR → Employees → Copy Self-Service Link, but reachable without switching into the client first, without HR being enabled, and without holding a manager role. Right-click → Copy link address to send it on to a client.',
                  tips: [
                    'Signing in there with an employee PIN REPLACES your admin session in that browser — open a private window if you need to stay signed in as admin',
                    'The button is on every client, including ones with HR off; the tooltip says so, and the page shows an empty staff picker until someone is given a Self-Service login',
                    'Employees get their login from HR → Employees → Enable Self-Service, which sets their initial PIN',
                    'It opens in a new tab, so middle-click and ctrl-click work the way they do on any link',
                  ],
                },
                {
                  icon: '📱', name: 'Guest Menu Preview',
                  guide: 'Preview the currently-viewed client\'s guest QR menu without needing a printed QR code or asking the client for one. Pick a client in the top-bar switcher first, then pick one of that client\'s tables — the page embeds the exact live page a guest sees after scanning that table\'s QR (GuestMenu.jsx), including guest ordering if the client has that Pro-tier feature enabled.',
                  tips: [
                    'This is the real, live guest page, not a mockup — but Place Order is switched off inside the preview, so nothing added there reaches the client\'s staff. Open in New Tab is the real page, where an order is a genuine pending order in POS Orders',
                    'Copy Link or Open in New Tab if you want to test on an actual phone instead of the embedded preview',
                    'The page says why a guest menu looks the way it does: POS switched off (no menu at all), dishes switched on for POS with no selling price (left off the guest menu until priced), tables marked inactive (listed as "(inactive)" — their QR still shows the menu, but guests cannot order from it), and a menu that still opens with the account name or no logo (the Owner sets both in POS Setup → Guest Menu)',
                    'If the client has no tables set up yet, add one in POS Setup first',
                  ],
                },
                {
                  icon: '◷', name: 'Audit Log',
                  guide: 'A full event log of every significant action in the system — creates, updates, deletes, period opens/closes, payroll runs, POS order voids/discounts/invoices, and admin client/feature changes. Every changed field is shown as old value → new value automatically, not just a hand-picked few, so a newly added field is covered the moment it exists. Filter by client, area, time range, or user, or search free text across all of those plus record IDs.',
                  tips: [
                    'Open a row\'s details (the ▸ button, or click the Details cell) to see every field that changed, not just the first three shown inline',
                    'Times are the BS date and Nepal time, whatever timezone the viewing computer is in',
                    'Since S849 it also records Outlet Access changes, outlet groups and their HQ outlet, asset repairs and categories, depreciation lines, tax pool opening corrections, and stock transfers (each transfer and its lines)',
                    'Filter by "Area" to narrow down to IMS, HR, POS, Fixed Assets, Staff PIN reveals or Admin actions',
                    'Filter by "User" or type into the search box to trace all actions by a specific person — these two only look through the entries loaded so far, so load more to search further back',
                    '"System" in the User column means a server process made the change with no signed-in user — an admin operation run through the server, or the trial purge job',
                    'A POS Order only logs meaningful transitions — void, discount, close, invoice — not every item added while the bill is still open',
                    '⬇ Export downloads the loaded, filtered rows as an Excel file, with a Scope sheet naming the filters',
                    '🗑 Delete old entries removes entries older than 90 days, 6 months, 1 year or 2 years (for one client or all). Recent history cannot be deleted, and every deletion is itself recorded in the log as "Purged"',
                  ],
                },
                {
                  icon: '🧾', name: 'POS Billing Setup',
                  guide: 'Per-client invoice settings, set in Manage Clients → a client → Settings tab. VAT Registered controls whether new POS bills print as a Tax Invoice with a VAT breakdown or a plain Bill with PAN only. Invoice Prefix is the short client code used in invoice numbers (e.g. TI2238-CAC-82/83). It is never filled in for you: left blank, bills print without one (TI2238-82/83). Setting a code for the first time, or changing it, asks first — every bill already issued reprints with the new code, because the number is put together when a bill is printed. The client\'s scan-to-pay merchant QR payload is a separate QR tab in the same drawer.',
                  tips: [
                    'Turn VAT Registered off for clients billing on PAN only (not yet VAT-registered with IRD) — the bill header switches from "TAX INVOICE" to "BILL" and drops the VAT line. Bills already issued keep the type they were charged as, so the switch changes new bills only. A till open at that moment stops its next Charge once and asks the cashier to check the new total, then charge again',
                    'Invoice numbers reset to 1 at the start of each Nepal fiscal year (Shrawan) automatically — no manual reset needed',
                    'Payment QR: paste the client\'s raw merchant QR text (scanned off their physical FonePay/NepalPay/eSewa standee with any QR-reader app) into the QR tab — it live-validates and previews before saving, and every POS bill then carries a dynamic per-bill QR with the exact amount pre-filled',
                    'Invoice Prefix is uppercased automatically; keep it short (3–5 letters) so it fits the 80mm receipt width',
                  ],
                },
]
