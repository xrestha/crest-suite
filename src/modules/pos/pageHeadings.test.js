/**
 * 2026-10-15 POS audit leftovers, read from the source (the S675 technique): a page title's accessible
 * name is only its text, an emoji is never the icon, and a heading never skips a level.
 *
 * - A `Tip` inside an `<h1>` put its trigger ("ⓘ") into the heading's name, so a screen reader's
 *   heading list read "Credit Notes circled latin small letter i". The Tip now sits beside the h1.
 * - 🎉 / ⬇ / 🔔 / 💬 rendered as icons are read out by name ("speech balloon") or not at all; a lucide
 *   icon with aria-hidden sits beside real words instead.
 * - The Customers page's tabs render under its h1, so a tab's sections are h2; a dialog's title is
 *   Modal's h3, so a section inside one is h4.
 */
const fs = require('fs')
const path = require('path')

const read = rel => fs.readFileSync(path.join(__dirname, rel), 'utf8')

const PAGES = [
  'creditnotes/CreditNotes.jsx',
  'reservations/PosReservations.jsx',
  'customers/PosCustomers.jsx',
  'parking/PosParkingSlips.jsx',
]

test.each(PAGES)('%s: no Tip inside the page title', rel => {
  const src = read(rel)
  const h1s = src.match(/<h1\b[\s\S]*?<\/h1>/g) || []
  expect(h1s.length).toBeGreaterThan(0)
  for (const h1 of h1s) expect(h1).not.toMatch(/<Tip\b|ⓘ/)
})

const EMOJI_ICONS = /[🎉🔔💬⬇]/u
test.each([
  ...PAGES,
  'creditnotes/IssueCreditNoteModal.jsx',
  'customers/LoyaltyTab.jsx',
  'customers/AdjustPointsModal.jsx',
  'parking/NewParkingSlipModal.jsx',
])('%s: no emoji used as an icon', rel => {
  expect(read(rel)).not.toMatch(EMOJI_ICONS)
})

test('Loyalty tab sections sit one level under the page title', () => {
  const src = read('customers/LoyaltyTab.jsx')
  expect(src).not.toMatch(/<h[13-6]\b/)
  expect(src).toMatch(/<h2\b[^>]*>Schemes<\/h2>/)
  expect(src).toMatch(/<h2\b[^>]*>Who is enrolled<\/h2>/)
})

test('a section inside the Adjust points dialog sits under the dialog title (h3), as h4', () => {
  const src = read('customers/AdjustPointsModal.jsx')
  expect(src).not.toMatch(/<h[1-3]\b/)
  expect(src).toMatch(/<h4\b/)
})

test('money in the loyalty screens goes through nprPoints, never a hand-built NPR string', () => {
  for (const rel of ['customers/LoyaltyTab.jsx', 'customers/AdjustPointsModal.jsx']) {
    expect(read(rel)).not.toMatch(/NPR \$\{/)
  }
})
