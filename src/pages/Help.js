import { lazy, Suspense, useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate, useLocation } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import { useSettings } from '../context/SettingsContext'
import { MODULE_COLORS, MODULE_INK, colorTint } from '../data/pricingPlans'
import SupportContactLine from '../components/SupportContactLine'
import SetupGuideCard from '../components/SetupGuideCard'
import ActionError, { asActionError } from '../components/ActionError'
import { suiteAccess } from '../components/SuiteGate'
import { suiteLive } from '../utils/subscription'
import { recoverFromChunkError } from '../shared/chunkReload'
import { prefetchAllowed } from '../shared/prefetchHrPages'
import { loadHelpFeatures, loadedHelpFeatures } from './help/loadHelpFeatures'
// The Help sections a URL may open directly: /help?section=support is the sidebar's Support
// button (S683) — before it, "where is support?" had no answer a link could give, because the
// section lived only in component state. Anything else falls back to the guide.
const HELP_SECTIONS = ['guide', 'modules', 'glossary', 'faq', 'pricing', 'support', 'legal']
const sectionFromSearch = search => {
  const s = new URLSearchParams(search).get('section')
  return HELP_SECTIONS.includes(s) ? s : null
}


// Lazy for the same reason Settings lazy-loads its Guides tab: this one runs a query and carries
// its own table, and every other tab would otherwise pay for it on first paint of /help.
const LegalTab = lazy(() => import('./help/LegalTab'))

// The Module Guide's feature lists (IMS, Suite, HR, POS, Admin) are not in this file. They were
// ~430 KB of its ~538 KB and the tab /help opens on uses none of them, so they live in
// ./help/*Features.js and arrive through loadHelpFeatures() (PERF-9, S876). A new page's Help
// entry goes in its module's file there.

// ── Tier unlock logic ─────────────────────────────────────────────────────────
function isTierUnlocked(tier, plan, isAdmin) {
  if (isAdmin) return true
  if (tier === 'core' || tier === 'starter') return true
  if (tier === 'growth') return plan === 'growth' || plan === 'pro'
  if (tier === 'pro')    return plan === 'pro'
  return false
}

// ── Glossary ──────────────────────────────────────────────────────────────────
const GLOSSARY = [
  { term: 'Food Cost %',      def: 'What you USED ÷ what you sold × 100: COGS (Opening Stock + Net Purchases − Wastage − Staff Meals − Closing Stock) ÷ Revenue. The primary profitability metric for F&B operations. Industry benchmark: 28–35%. It needs the month-end stock count to know what was used, so only a closed month has a Food Cost %; the month you are in shows Spend % so far instead (see below). Monthly Summary, P&L, Annual Summary, Period Comparison, the Dashboard\'s trend chart, the Group Console and the Monthly Owner Report all mean this one figure by it. Overheads does not use it: its first P&L line is Purchases (what you bought), shown as Spend %. The Food Cost % — Monthly Trend chart on the Dashboard plots each closed month; a month closed with an incomplete stock count is a grey dot on a faded line, shown with the range its real figure lies in but not judged. The current month appears as its Spend % so far at the end of a dashed line, held off the line for its first 9 days. The Average, Best month and Highest month count fully counted closed months only — never a grey month, never the current one — and Best and Highest wait for two of them. That Average is blended (total stock used ÷ total revenue across those months), not the mean of the monthly percentages, so a quiet month cannot outweigh a busy one. The Good/Watch/High bands follow your own Warning/Critical values from Settings → Thresholds. Monthly Owner Reports made before this change froze purchases ÷ sales instead, and say "Food Cost % (on purchases)".' },
  { term: 'Spend % so far',   def: 'What you have SPENT on stock this month ÷ what you have sold so far — Net Purchases ÷ Revenue × 100. The Dashboard, Owner Dashboard and Group Console show it for a month that is still running, because Food Cost % needs the month-end count. It ignores opening and closing stock: buy a month of rice in one go and it jumps (an early-month reading can be well over 100%, so the dashboards show it in plain grey for the first days rather than as a red warning); cook from last month\'s stock and it drops. Monthly Summary shows the same ratio for a closed month as "Spend %", beside Food Cost % — a big gap between the two means stock built up or ran down over the month. Overheads uses it too, for its Purchases line.' },
  { term: 'COGS',             def: 'Cost of Goods Sold. Opening Stock + Net Purchases − Wastage − Staff Meals − Closing Stock. The actual cost of ingredients consumed in the period, and the top half of Food Cost %. An item you have since hidden still counts in the months it was bought and counted.' },
  { term: 'Per UOM Rate',     def: 'Cost per single unit of measure. If 1 KG of chicken costs NPR 700, the per UOM rate is NPR 0.70 per gram.' },
  { term: 'Theoretical Usage', def: 'What should have been used based on qty sold × recipe ingredient qty. Calculated from sales entries and recipes.' },
  { term: 'Actual Usage',     def: 'What was actually used: Opening Stock + Purchases − Closing Stock − Wastage.' },
  { term: 'Variance',         def: 'Actual Usage − Theoretical Usage. Positive variance = more used than expected. Indicates waste, theft, or over-portioning.' },
  { term: 'Variance Tolerance', def: 'The percentage a figure may differ by before Crest flags it, set per client in Settings → Thresholds → Variance Flag (default 10%). One number drives the colour, the mark and the flag badge on both variance reports.' },
  { term: 'Immaterial (≈)',   def: 'A variance that is outside your tolerance in percentage terms but worth under NPR 500 — shown in muted type with a ≈ mark rather than red, so small rupee amounts do not bury the rows that actually cost money.' },
  { term: 'FIFO',             def: 'First In, First Out. Use oldest stock before newer stock. Critical for perishables to minimise expiry waste.' },
  { term: 'Opening Stock',    def: 'Quantity of each ingredient at the start of the period (carried over from previous month closing stock).' },
  { term: 'Closing Stock',    def: 'Physical count of each ingredient at the end of the period.' },
  { term: 'Conversion Factor', def: 'How many base units are in one purchase unit. E.g. 1 case = 24 bottles → conversion factor = 24.' },
  { term: 'BS Calendar',      def: 'Bikram Sambat calendar used in Nepal. The system works natively in BS months.' },
  { term: 'Par Level',        def: 'Minimum stock quantity you want on hand. An item is flagged for reorder when its stock falls BELOW par — sitting exactly at par is fine. One rule everywhere it appears: Reorder Report, Stock Report, the Dashboard panel, the Owner Dashboard tile and the Monthly Owner Report.' },
  { term: 'Prime Cost',       def: 'Food Cost % + Labor Cost % — the two controllable costs combined, as a % of revenue. The single figure most restaurant operators benchmark against directly (industry standard ≈60–65%). Shown on Owner Dashboard, where the running month uses Spend % so far for the food half, since that month has not been counted yet.' },
  { term: 'Book Stock',       def: 'Live stock figure fed by the depletion ledger — decremented automatically on every POS sale/comp close and every saved manual Sales Entry day, shown in the Reorder Report. The physical stock count remains the source of truth. See Stock Movements for the itemised ledger.' },
  { term: 'SSF',              def: 'Social Security Fund (सामाजिक सुरक्षा कोष). Nepal mandatory contribution: 11% employee + 20% employer of basic salary.' },
  // — Crest HR —
  { term: 'TDS',              def: 'Tax Deducted at Source. Nepal\'s monthly income tax withholding on salary, computed via year-to-date cumulative projection against the current fiscal year\'s tax slabs.' },
  { term: 'Gratuity',         def: 'A lump-sum retirement/severance benefit under Nepal\'s Labour Act, accrued per year of service and paid at final settlement — separate from SSF.' },
  { term: 'CTC',              def: 'Cost to Company. Gross salary + Employer SSF contribution (20% of basic) — the employer\'s true monthly outlay, not the employee\'s take-home pay.' },
  { term: 'Dearness Allowance', def: 'महँगी भत्ता — a statutory monthly allowance separate from basic salary. Minimum NPR 7,380/month (set FY 2082/83, unchanged through FY 2083/84 — next review due Shrawan 2084). SSF is not computed on it.' },
  { term: 'Shift Type',       def: 'A named work-shift template (e.g. Morning, Evening, Split) with a colour and start/end time, defined in Roster → Shift Types and assigned to staff on the Roster Board.' },
  { term: 'Roster',           def: 'The weekly/monthly staff shift schedule. Planning-only — Attendance is the official record that feeds Payroll, though Attendance can be pre-filled from Roster via Generate from Roster.' },
  { term: 'Final Settlement', def: 'The full-and-final payment when an employee leaves — the final month\'s salary, unpaid travel claims, leave encashment, gratuity and notice pay, minus advances and tax.' },
  { term: 'Festival Allowance', def: 'A statutory bonus (commonly tied to Dashain) of up to one month\'s basic salary, shared out by the months a person has worked, and paid either with that month\'s salary or separately, as each run chooses. Its income tax is worked out on the person\'s whole year of income and is deposited with the tax for the month it is paid in.' },
  { term: 'Overtime (OT)',    def: 'Extra hours worked beyond the standard shift, paid at 1.5× the normal hourly rate on weekdays and 2× on public holidays.' },
  // — Crest POS —
  { term: 'KOT / BOT',        def: 'Kitchen Order Ticket / Bar Order Ticket — the printed slip sent to the kitchen or bar when an order item is sent, listing items and quantities to prepare.' },
  { term: 'X-Report / Z-Report', def: 'End-of-shift sales summaries. X-Report is a read-only mid-shift snapshot; Z-Report closes the shift and resets running totals for the next one.' },
  { term: 'Credit Note',      def: 'A document that reverses a billed sale (VAT Rules 2053, Rule 20) instead of deleting the original invoice — used whenever a paid bill needs correcting or refunding.' },
  { term: '1L+ Report',       def: 'The "One Lakh and above" compliance report (Annexure 13) — lists every party whose cumulative sales or purchases in a fiscal year come to ABOVE NPR 1,00,000, as required for VAT recordkeeping. On the purchase side a vendor is flagged on either the ex-VAT net or the invoiced total, whichever crosses first.' },
  // — Crest IMS (Growth/Pro) —
  { term: 'Dead Stock',       def: 'Items with zero usage over the period (Slow Movers = used less than 20% of available stock) — ingredients tying up money without turning over. Measured from the closing count, so an item that was never counted cannot be judged either way.' },
  { term: 'Shrinkage',        def: 'Recurring unexplained stock loss seen consistently across multiple periods — distinguished from a one-off Variance by checking period-over-period consistency.' },
  { term: 'Menu Engineering', def: 'Classifies menu items by popularity and profitability into four quadrants — Star (both high), Puzzle (popular but low-margin), Plowhorse (profitable but unpopular), Dog (both low) — to guide menu and pricing decisions. Note: this app\'s Plowhorse/Puzzle swap the traditional restaurant-industry meaning of those two words; the definitions here match what this app actually computes.' },
  { term: 'Demand Forecast',  def: 'A prediction of plates per dish, revenue and (with POS) covers for upcoming days (7/30-day horizon), exploded into the raw ingredients it will consume. Feeds the Roster\'s Labor Forecast and purchasing.' },
  { term: 'Requisition',      def: 'An internal stock transfer from the main store to a department (e.g. kitchen, bar), tracked separately from external purchases.' },
  { term: 'Stock Transfer',   def: 'Stock sent from one outlet of your group to another (Stock Transfers page). It counts at the receiving outlet like a purchase once they press Received, and at the sending outlet like a return to the supplier, at the sender\'s price. Not the same as a Requisition, which moves stock inside one outlet.' },
  { term: 'Crest Suite Pro',  def: 'The owner add-on priced per outlet, on top of your modules: Owner Dashboard, Monthly Owner Report, Profit & Loss, Group Console, Demand Forecast and Fixed Assets. It needs Crest IMS (Owner Dashboard also needs Crest HR) and is not an IMS plan upgrade.' },
]

// MODULE_COLORS comes from ../data/pricingPlans — the single source of truth shared with
// Pricing.js and ClientDrawer.js. The PRICES no longer come from there directly (S701): this tab
// reads `useSettings().pricing`, so an admin's Settings > Plan Pricing edit shows up here and on
// the public page together. Importing the constants was what let the two disagree.

const FAQ = [
  { q: 'How does the navigation work? I have a lot of pages.', a: 'On a computer the navigation is a bar across the top, in two rows. The top row is your session: the Crest logo, one button per module you have (Crest IMS, Crest HR, Crest POS, plus Crest Customization and Crest Suite if your property has those), which property and BS period you are looking at, search, the calculator, and your name. The second row is the pages of whichever module is selected — Dashboard on its own, then one menu per group (Operations, Costing, the report categories). Click a module button to switch panels; the bar also follows you automatically when you navigate, so opening a POS page selects POS. Star a page inside any menu and it joins a Pinned menu at the front of the row. Help, Support and Sign out live under your name. Sign out signs you out on that device only; your other devices stay signed in. On a phone the top bar is replaced by the ☰ button, which slides the same pages in from the left.' },
  { q: 'Why is my food cost % so high?', a: 'First check which figure you are looking at. During the month the dashboards show Spend % so far — what you have bought ÷ what you have sold — which jumps whenever you stock up and settles as the month goes on; it is not your food cost. Food Cost % (what you used ÷ what you sold) arrives once the month is closed, on Monthly Summary. If a closed month\'s Food Cost % is high, common causes: a missing or incomplete closing count (anything not counted reads as used — Monthly Summary names those items), over-portioning, wastage not recorded, theft, or supplier price increases not reflected in selling prices. Check the Variance Report to identify the biggest leaks.' },
  { q: 'What if I forgot to enter a purchase?', a: 'Go to Purchases, select the correct period, and add the entry with the correct day. The system recalculates everything automatically.' },
  { q: 'How do I correct a wrong entry?', a: 'Every entry has an Edit button. Click it, correct the values, and save. No need to delete and re-enter.' },
  { q: 'Why does my Variance Report show no theoretical usage?', a: 'Either you have not entered Sales Entries for the period, or the items have no Recipe built. Both are needed for theoretical usage to calculate.' },
  { q: 'Why did the Variance Report open on last month instead of this one?', a: 'Because variance can only be measured once the month\'s closing stock has been counted, which happens at month end. Mid-month there is no closing count, so everything still sitting on your shelves would be counted as "used" and every item would look over-consumed. The report therefore opens on the most recent closed month. You can still select the open month from the dropdown — it will tell you the count is missing and show the figures greyed out rather than flagging false losses.' },
  { q: 'What do the ✓ ▲ ▼ ≈ marks next to a variance figure mean?', a: 'They are the same verdict the colour gives, in a form that survives a photocopy, a greyscale print and colour blindness — worth knowing that red and amber are hard to tell apart for roughly 1 in 12 men, and those are exactly the two the variance reports use most. ✓ means the item is inside the tolerance you set in Settings → Thresholds. ▲ means more was used than your recipes and sales say should have been — waste, theft or over-portioning. ▼ means less was used than expected, usually under-portioning or a gap in the data. ≈ means the gap is too small in rupees to be worth chasing. The arrow always points the way the number actually went; the colour is the judgement about whether that is good or bad.' },
  { q: 'An item is 40% out but shows ≈ instead of red. Is that a bug?', a: 'No — it is under NPR 500 of value. A percentage on its own is misleading at the small end: a spice that should have used 50 GM and used 70 GM is 40% out and worth about NPR 20. If every one of those were painted red, the handful of rows that genuinely cost you money would be buried in them. The percentage is still printed, so you can see exactly what is being called immaterial rather than having it hidden from you.' },
  { q: 'What is the chip under a report title that says a month and Open or Closed?', a: 'It is the period the report covers. It used to be the last few words of the grey sentence under the title, which is easy to scan past — and it is the one thing worth checking before you trust any number on the page. Closed means the month is finished and its figures are final. Open means the month is still being entered; on a data-entry screen that is completely normal, but on a report whose figures depend on the closing stock count the chip is drawn with a dashed edge and a △ to say the numbers are provisional until the month is closed.' },
  { q: 'A report says it could not load. What happened?', a: 'Crest reads a big month in several pieces, up to a very high limit (1,00,000 rows for one list). If a piece does not arrive, or a list ever runs past that limit, the report now says it could not load — rather than showing a total that is quietly short. Reload the page once. If it still says so, tell Crest support which report and which month; a list past the limit needs support to raise it.' },
  { q: 'Two reports show a different COGS for the same month — which is right?', a: 'They agree now. COGS is Opening + Net Purchases − Wastage − Staff Meals − Closing everywhere in Crest, where Net Purchases means gross minus any bill-level discount minus vendor returns. Two things had to be fixed to make that true. Annual Summary used to leave staff meals out, so its COGS sat slightly BELOW Monthly Summary\'s for the same month (fixed 2026-08-13). And Annual Summary, Period Comparison and Budget vs Actual all left the bill DISCOUNT in, so their purchases and COGS sat ABOVE Monthly Summary\'s by exactly the discount (fixed 2026-09-09). The Dashboard, Owner Dashboard, Monthly Owner Report and Group Console had the same gap in their Food Cost % and were brought into line on 2026-09-14 — Owner Reports generated before that date keep the figures they were made with. Past months on those three pages will have moved as a result — they are right now. Those four pages also used to call purchases ÷ sales "Food Cost %", while Monthly Summary gave that name to stock used ÷ sales, so one month could read 50% on one page and 35% on the next. Now Food Cost % always means stock used ÷ sales for a closed month, and the running month on the dashboards is labelled "Spend % so far"; Owner Reports made before that change keep their purchases-based figure, labelled "(on purchases)". And hiding an item in Item Master no longer takes it out of any past month: its purchases and counts stay in that month\'s COGS on every page. The one difference that is deliberate: Stock Count\'s Summary counts sub-recipes as stock and Monthly Summary does not, so its COGS is higher by exactly the prep amount, and both pages say so.' },
  { q: 'On Purchases, the Total under the table does not match the Bill Total column. Why?', a: 'They are two different, both-correct figures, and both are now labelled. "Total goods value (ex-VAT)" is qty × rate before any bill discount and before VAT — that is what Stock Count and COGS use. "Total payable (incl. VAT)" is what actually leaves the bank, and that is what the Bill Total column adds up to. The difference is VAT minus discount.' },
  { q: 'Can two staff members enter data at the same time?', a: 'Yes. The system is cloud-based and supports multiple users simultaneously.' },
  { q: 'What happens to data when I close a period?', a: 'Closing a period locks it from further editing by every login except the account owner\'s, and freezes that month\'s Monthly Report — at the close when the account owner ends the month, or the first time the owner opens it when an inventory supervisor or manager did. All data is preserved permanently and you can view closed period reports at any time. If a purchase bill turns up afterwards, the account owner (or your Crest admin) can still enter it — Periods carries an "Add missing bills" action on every closed month that opens Purchases on that month. Afterwards, press Regenerate Snapshot on that month\'s Monthly Report so it includes the change.' },
  { q: 'How do I add a new menu item to recipe costing?', a: 'Go to Recipe Costing → New Recipe. Add ingredients from your Item Master with qty per portion. The system calculates food cost instantly.' },
  { q: 'Why is there no sales line on the Dashboard "Purchases vs Sales" chart?', a: 'The sales line only plots when sales are recorded day-by-day. In Sales, pick a specific day and enter that day\'s quantities (rather than one bulk monthly total). Once a few days are entered, the green sales line appears, with a dashed month-end forecast beside it. (When the POS module ships, it will feed daily sales automatically.)' },
  { q: 'Can I add many recipes at once instead of one line at a time?', a: 'Yes. In Recipe Costing, click ↓ Template to download a spreadsheet (one row per ingredient; recipe-level fields on the first row of each recipe). Fill it in Excel/Sheets — the template includes a "Your Items" sheet with your exact item names/codes/units to copy from — then click ↑ Import Excel. A preview shows what matched; unmatched ingredients are skipped (add those items to the Item Master first, then re-import). The ingredients must already exist as items because each item carries its own purchase rate and unit conversion. To copy a similar dish, use the Clone button on any recipe row.' },
  { q: 'Why won’t a vendor delete?', a: 'A vendor can only be deleted outright while nothing is recorded against it — no purchase entry, purchase order, vendor return or gate pass. That is because the vendor row is the only place its name is stored: every bill, return and report keeps a link to it rather than a copy of the name, so deleting the row is what would erase that supplier from your own history. For a vendor you have actually bought from, Deactivate it and then Archive it. Archiving takes it off the Vendors page and out of every dropdown, and because the row is kept and hidden rather than deleted, every past bill, Vendor Report, Outstanding Payables line and balance confirmation still names it. Archived vendors are listed under "Show archived" and can be restored at any time. All three actions are visible to Crest support only.' },
  { q: 'Why won’t an item delete?', a: 'An item can only be hard-deleted if nothing references it. If it appears in any purchase, stock count, wastage, staff meal, requisition, vendor return, or recipe — even a zero-quantity one — the delete is blocked and you’ll see why. The best option is Hide: it removes the item from all lists and dropdowns while keeping its history intact. Admins also get a Force Delete option that erases the item and every record referencing it (this recalculates affected past reports and cannot be undone) — use it only for true duplicates/mistakes. An item that has been sent or received between your outlets (Stock Transfers) can be hidden but never force-deleted, because both outlets keep the transfer on their books.' },
  { q: 'How do I quickly find an item in a long dropdown?', a: 'The item pickers in Purchases, Recipes, Stock’s Daily Wastage, and Requisitions are searchable — click the field and start typing to filter, then use ↑/↓ and Enter (or click) to choose. On Recipe Costing there is also a “Find ingredient in recipes” box that lists every recipe using a given ingredient, including ones where it’s inside a sub-recipe.' },
  // — Crest HR —
  { q: 'Why isn\'t SSF being deducted for an employee?', a: 'Check Pay Setup → Bank/SSF tab for that employee — the SSF Enrolled toggle must be switched on AND an SSF No. entered. The toggle is off by default for new employees. Until both are there, no 11%/20% SSF is computed anywhere, including Payroll — with the toggle on but no number, Payroll charges the 1% social security tax instead, and Pay Setup marks the row "⚠ SSF no. missing".' },
  { q: 'How does Payroll handle unpaid leave?', a: 'Mark the day Unpaid Leave in Attendance (or approve an unpaid leave request in Leave Management, which marks it automatically). Payroll deducts unpaid days from monthly-basis staff and simply doesn\'t pay for that day for daily/hourly staff.' },
  { q: 'Why can\'t I delete an employee?', a: 'Because they have history on file: finalized payslips, a finalized Final Settlement, finalized festival allowances, an advance or loan, a Self-Service login, or TADA claims, incentive/bonus records or shift-swap requests. That history is kept on purpose — it covers money paid and approvals given — so the delete is refused, by the database as well as the page. Use Deactivate in their Edit form instead: it removes them from payroll pickers, rosters and attendance while keeping everything. An employee with none of those on record (someone added by mistake, say) can still be deleted; if a Self-Service login is the only thing in the way, Remove it from the Employees list first.' },
  { q: 'How do I stop a former employee logging into Self-Service?', a: 'Two options, depending on whether it is temporary. To suspend access but keep the account, tick their row on Employees and click Deactivate (block login) — Activate (allow login) restores it, and neither affects payroll. (The Deactivate button inside the Edit form is a different thing: it takes them off payroll and does not block the login.) To remove the login for good, click Remove next to their ✓ Self-Service badge; their PIN stops working immediately and the login is deleted. Both keep the employee record, payslips and leave history, and you can Enable Self-Service again later with a new PIN.' },
  { q: 'What does the "OT: 2 sources" note in Payroll mean?', a: 'It means the same employee has overtime in both the Attendance sheet\'s OT column and an approved Overtime module entry for this period. They are not added together: on any day an approved entry exists it supersedes the attendance sheet, so nothing is paid twice. Days with no approved entry still pay their attendance OT at 1.5×.' },
  // — Crest POS —
  { q: 'What\'s the difference between Void and Complimentary?', a: 'Void cancels a bill entirely — no sale is recorded. Complimentary keeps the sale on record (for stock/COGS purposes) but zeroes the amount charged to the guest. Complimentary needs Supervisor+ access; Void is owner/admin-only by default, though a manager can grant "Allow Void" to a specific staff member in POS Staff. Both require a reason.' },
  { q: 'An item printed to the wrong station — or nothing printed at all. Why?', a: 'For the wrong station, check POS → POS Setup → Ticket Routing: you tick the categories that go to the BAR ticket, and every category you do not tick goes to the Kitchen. So an unrouted drinks category prints to the kitchen, not nowhere. If nothing printed at all, it is the browser, not the routing — a blocked pop-up stops the ticket opening (allow pop-ups for this site, then use Reprint last KOT/BOT on the order screen), or the item was never sent, which the amber "⚠ pending" pill on the floor is there to catch.' },
  { q: 'A report or a printed bill says "Crest support". What is that?', a: 'Something the Crest support team did in your POS while helping you — a bill closed, a void, a kitchen ticket, a shift or a credit note. It used to show as "—", the same mark a deleted login leaves. Support follows the same record rules as your own staff: a kitchen ticket only moves forward, and a parking slip is numbered and timed by the system. While your POS is switched off, support cannot open the till for you at all.' },
  { q: 'Can I edit or delete a bill after it\'s been paid/closed?', a: 'No — once billed, an order can\'t be edited or deleted directly, so the original record is always preserved for audit. To correct a paid bill, issue a Credit Note, which reverses it instead of altering history.' },
  { q: 'I signed up — why does it say you will call me?', a: 'Every Crest trial is switched on by a person. We call the number you gave within one working day, confirm you run a restaurant, café or hotel, and press Approve — your 7-day trial starts on that day, not on the day you signed up, so waiting costs you nothing. The trial runs at the Growth level with IMS, HR and POS all on, and the current BS month is already open for you when you first log in. If you have not heard from us in a working day, the Support button on the left has our number.' },
  { q: 'What happens if my subscription expires?', a: 'You get a 7-day grace period first — everything keeps working normally and a red banner at the top of every page counts down the days left. After that, Crest locks and shows a renewal screen instead of the app. Nothing is deleted: your data stays exactly as it was, and renewing restores full access immediately. Free trials lock on the day the trial ends rather than getting the grace period, but trial data is still kept for the retention window shown on that screen. A Crest Suite Pro or Customization add-on paid further ahead does not keep the account open: the lock follows your IMS, HR and POS dates. Each add-on also closes on its own: seven days after its own paid-up date its pages close (Suite), or the till and the QR menu stop offering choices and combos (Customization), while the rest of the account keeps working.' },
  { q: 'What happens when Crest Suite Pro ends?', a: 'In its last week the Owner sees a line under the top bar naming the day it ends and the Suite pages it covers, with Renew →. Through the 7-day grace after it, the line says the day those pages close. After that the Suite pages explain what Suite is instead of showing figures; the rest of Crest keeps working and nothing is deleted. In a group, an outlet whose Suite has ended also drops out of the Group Console and the group Profit & Loss after the grace, and the pages name it.' },
  { q: 'Can I get a copy of all my data?', a: 'Yes — ask us and we can export your entire account to an Excel workbook: purchases, sales, stock, recipes, vendors, payroll, POS orders, the lot. You get a readable .xlsx plus a .json file that can be restored back into Crest later. It works whether your subscription is active or not, and your data is never deleted without a backup being taken first.' },
]

// ── Getting Started — Crest HR ────────────────────────────────────────────────
const HR_SETUP_STEPS = [
  { step: 1, title: 'Add your Employees', desc: 'Go to Employees → add each staff member with a name, join date, employment type and status. Designation, department and the rest are optional.', why: 'Every attendance mark and payslip is tied to an employee record here.' },
  { step: 2, title: 'Set up their Pay', desc: 'Go to Pay Setup → enter pay basis (monthly, daily, or hourly), basic salary, allowances, SSF enrollment with the SSF number, and bank details for each employee.', why: 'Payroll can\'t compute anything until basic salary — and, if applicable, SSF enrollment plus the SSF number — is set. The setup guide ticks this step only when nobody on payroll is left with no pay, and says how many are left.' },
  { step: 3, title: 'Build your Roster', desc: 'Go to Staff Roster → assign shifts for the month. Optional, but unlocks ⚡ Generate from Roster in Attendance.', why: 'Without a roster, every day for every employee has to be marked by hand in Attendance.' },
  { step: 4, title: 'Mark Attendance', desc: 'Go to Attendance → click ⚡ Generate from Roster to pre-fill the month from what you scheduled, then adjust leave, offs, and OT by hand.', why: 'Payroll reads attendance directly — an incomplete month means an incomplete payslip.' },
  { step: 5, title: 'Run your first Payroll', desc: 'Go to Payroll → Generate Payroll for the period → review each payslip → Finalize. Then pay your staff and press Mark everyone paid.', why: 'Finalizing locks the payslips; Mark paid records that the money went out. Finalizing sends no money.' },
]
const HR_WORKFLOW_STEPS = [
  { step: 1, title: 'Confirm the period is open', desc: 'The current BS month should already be open — there is nothing to create. Crest opens your first month when your account is set up, and each later month opens when the one before is closed (with Crest IMS, press "End <month> & Start <next>" on the Dashboard banner once the month has ended). If the month you need is not open, contact Crest support.' },
  { step: 2, title: 'Update the Roster', desc: 'Staff Roster → adjust shifts for the month ahead as staffing changes.' },
  { step: 3, title: 'Mark / Generate Attendance', desc: 'Attendance → Generate from Roster, then handle leave, unscheduled offs, and OT day by day as the month goes.' },
  { step: 4, title: 'Approve Leave & Overtime requests', desc: 'Leave and Overtime → approve or reject pending requests before running payroll.' },
  { step: 5, title: 'Run Payroll', desc: 'Payroll → Generate → review TDS/SSF/deductions per employee → Finalize.' },
  { step: 6, title: 'Pay staff, then record it', desc: 'Pay everyone (the Bank Transfer sheet in HR Reports lists what each person is still owed), then Payroll → Mark everyone paid with the date and how: bank, cash, eSewa/Khalti or cheque. Finalizing sends no money — this is what puts "Paid on" on each person\'s payslip in Crest Staff.' },
  { step: 7, title: 'Handle Advances & Festival Allowance', desc: 'Advances & Loans and Festival Allowance → process anything due this month. Advance cuts come off the next payroll, and the salary cuts are recorded automatically when you Finalize it — don\'t enter them by hand; use Record Repayment only for cash an employee paid back. A festival allowance or bonus finalized to be paid with the salary is added to that month\'s payslips — finalize it before you finalize payroll, or Regenerate payroll after. A finalized festival allowance is counted in later months\' income tax.' },
]
const HR_MISTAKES = [
  'Finalizing payroll before attendance, leave, and OT are fully settled for the period — Finalize locks the month, so anything entered late won\'t be reflected.',
  'Forgetting to switch on SSF Enrolled and enter the SSF No. per employee in Pay Setup — the switch is off by default, and until both are there, no SSF is deducted or contributed for that employee anywhere, including Payroll.',
  'Assuming attendance-sheet OT and an approved Overtime entry add together — they do not: the approved entry supersedes the sheet for that day, and only the Overtime module can pay the holiday 2× rate.',
  'Finalizing months out of BS-calendar order — TDS is a year-to-date cumulative projection, so skipping ahead throws off the tax calculation for every month after it.',
]

// ── Getting Started — Crest POS ───────────────────────────────────────────────
const POS_SETUP_STEPS = [
  { step: 1, title: 'Set up your Tables', desc: 'Go to POS → Admin → POS Setup → ⚡ Quick Setup to batch-generate a floor plan in one click.', why: 'Orders and billing are organised by table — there\'s nothing to bill against without them.' },
  { step: 2, title: 'Add Staff & PINs', desc: 'Go to POS Staff → add each team member with a role (Staff / Supervisor / Manager) and a 4–6 digit PIN.', why: 'Only staff with a role assigned appear on the POS login screen at all.' },
  { step: 3, title: 'Configure your Menu', desc: 'Go to Menu Pricing → add items with a menu price (and cost price, if you\'re not also running IMS Recipe Costing).', why: 'The order screen only shows items that exist here with On POS checked.' },
  { step: 4, title: 'Activate each till tablet', desc: 'On the tablet itself, sign in with your email and go to POS → Admin → Till Devices → give it a name ("Front counter", "Bar") → Activate. Then press Sign out and open the PIN screen: your own login is signed out on that tablet only (your phone and laptop stay signed in) and the tablet shows the staff PIN screen. If it ever opens on the email sign-in page instead, press Staff Login there.', why: 'The activation is saved on that tablet only, so it has to be done on the tablet itself. A tablet that has never been activated shows no staff list at /pos/login, so nobody can sign in with a PIN. Each tablet gets its own key, so a lost one can be revoked on its own.' },
  { step: 5, title: 'Set up Silent Printing', desc: 'One-time device setup on a dedicated till — see the Silent Printing Setup guide below. Skip this if staff are fine using the normal browser print dialog.', why: 'Without it, every KOT/bill print pops a print dialog staff have to click through manually.' },
  { step: 6, title: 'Open your first Shift', desc: 'Go to Shifts → Open Shift → count the starting cash drawer — do this before the first bill of the day.', why: 'No shift open means no charging: Crest refuses a Charge (Cash, QR, Split, Credit) or a Complimentary until a shift is open, so every bill lands on a drawer count and a Z-report. Only a Void is allowed without one.' },
]
const POS_WORKFLOW_STEPS = [
  { step: 1, title: 'Open Shift', desc: 'Shifts → Open Shift → count the starting cash drawer at the start of the day.' },
  { step: 2, title: 'Take Orders', desc: 'Orders → seat guests, add items, press Send: food goes to the kitchen and drinks to the bar.' },
  { step: 3, title: 'Bill & Close', desc: 'Charge the order when the guest is ready to pay — apply any discount or mark Complimentary, always with a reason.' },
  { step: 4, title: 'Close Shift', desc: 'Shifts → Close Shift at the end of the day → reconcile the counted cash against the system total → review the Z-report.' },
  { step: 5, title: 'Check the Sales Report', desc: 'Sales Report → review Bills & payments → Payment Summary and Menu → Category Wise periodically, not just at shift close.' },
]
const POS_MISTAKES = [
  'Leaving the shift closed at the start of service — Pay and Complimentary are both refused until one is open, so the first guest of the day cannot be charged. Only one shift can be open at a time, so close the old one before opening the new.',
  'Confusing Void with Complimentary — Void cancels the sale entirely (nothing recorded); Complimentary keeps the sale on record for stock/COGS but zeroes what the guest pays.',
  'Forgetting to configure Ticket Routing — only the categories you assign go to the Bar ticket, and everything else goes to the Kitchen. A drinks category you never routed prints to the kitchen instead of the bar, where nobody is watching for it.',
  'Letting staff share PINs — it breaks the per-staff accountability that Sales Exceptions and the audit trail depend on.',
]

export default function Help() {
  const auth = useAuth()
  const { imsEnabled, hrEnabled, posEnabled, plan, isAdmin, outlets } = auth
  const location = useLocation()
  const [activeSection, setActiveSection]         = useState(() => sectionFromSearch(location.search) || 'guide')
  // Clicking the rail's Support button while already on /help changes only the query string, so
  // the initializer above does not rerun — follow the URL when it names a section.
  useEffect(() => { const s = sectionFromSearch(location.search); if (s) setActiveSection(s) }, [location.search])
  const [expandedModule, setExpandedModule]       = useState(null)
  const [expandedFaq, setExpandedFaq]             = useState(null)
  const [pricingAnnual, setPricingAnnual]         = useState(false)
  const [searchQuery, setSearchQuery]             = useState('')
  const { settings, pricing } = useSettings()
  const navigate = useNavigate()
  const phone   = settings?.contact_phone   || ''
  const email   = settings?.contact_email   || ''
  const website = settings?.contact_website || ''

  // Per-module (IMS/HR/POS) collapse on the Module Guide tab — defaults *closed* (same
  // rolled-up-until-chosen pattern as the Getting Started tab's openGS below), so a Suite client
  // sees three clickable module headings instead of every feature card unrolled on first load.
  const [openModules, setOpenModules] = useState(() => {
    try { return JSON.parse(localStorage.getItem('crest_help_modules')) || {} } catch { return {} }
  })
  function moduleOpen(key, state = openModules) {
    return state[key] === true
  }
  function toggleModule(key) {
    setOpenModules(prev => {
      const next = { ...prev, [key]: !moduleOpen(key, prev) }
      localStorage.setItem('crest_help_modules', JSON.stringify(next))
      return next
    })
  }

  // Same pattern, but for the Getting Started tab's per-module sections — these default
  // *closed* (unlike Module Guide) so a Suite client sees three clickable topics instead of a
  // 12-card wall on first load, and picks the one they're actually onboarding right now.
  const [openGS, setOpenGS] = useState(() => {
    try { return JSON.parse(localStorage.getItem('crest_help_gs')) || {} } catch { return {} }
  })
  // The Getting-Started headers are real disclosure buttons inside their <h2> (the same shape as
  // the feature accordion and the FAQ further down). They were <div onClick> until S682, which
  // closed the onboarding walkthrough to every keyboard and screen-reader user.
  const GS_TOGGLE_STYLE = {
    display: 'flex', justifyContent: 'space-between', alignItems: 'center', width: '100%',
    background: 'none', border: 'none', padding: 0, cursor: 'pointer', textAlign: 'left',
    font: 'inherit', color: 'inherit',
  }
  function gsOpen(key, state = openGS) {
    return state[key] === true
  }
  function toggleGS(key) {
    setOpenGS(prev => {
      const next = { ...prev, [key]: !gsOpen(key, prev) }
      localStorage.setItem('crest_help_gs', JSON.stringify(next))
      return next
    })
  }

  // Shared expandable card used for unlocked features
  function FeatureCard({ feat, moduleKey }) {
    const key = `${moduleKey}:${feat.name}`
    const isOpen = expandedModule === key
    return (
      <div className="card" style={{ padding: 0, marginBottom: 6 }}>
        {/* A real <button> with aria-expanded/aria-controls, not a <div onClick>. This page is a
            Read surface whose entire structure is disclosure, and every accordion on it used to be
            unreachable by keyboard — a keyboard or screen-reader user could tab to the search box
            and nothing else, so the product's whole documentation was closed to them. The chevron
            is aria-hidden: the expanded state is now exposed properly, so reading out "▼" adds
            nothing. */}
        <button
          type="button"
          aria-expanded={isOpen}
          aria-controls={`feat-panel-${key}`}
          onClick={() => setExpandedModule(isOpen ? null : key)}
          style={{
            display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '14px 18px',
            width: '100%', background: 'none', border: 'none', cursor: 'pointer', textAlign: 'left',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span aria-hidden="true" style={{ fontSize: 15, width: 22, textAlign: 'center', flexShrink: 0 }}>{feat.icon}</span>
            <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--theme-text1)' }}>{feat.name}</span>
          </div>
          <span aria-hidden="true" style={{ color: 'var(--theme-text3)', fontSize: 13 }}>{isOpen ? '▲' : '▼'}</span>
        </button>
        {isOpen && (
          <div id={`feat-panel-${key}`} role="region" style={{ padding: '0 18px 16px', borderTop: '1px solid var(--theme-border)' }}>
            <p style={{ fontSize: 13, color: 'var(--theme-text2)', marginTop: 14, lineHeight: 1.75 }}>{feat.guide || feat.desc}</p>
            {feat.tips?.length > 0 && (
              <div style={{ marginTop: 12 }}>
                <p style={{ fontSize: 10, color: 'var(--theme-text3)', textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: 8 }}>Tips</p>
                {feat.tips.map((tip, i) => (
                  <div key={i} style={{ display: 'flex', gap: 8, marginBottom: 6 }}>
                    <span style={{ color: 'var(--theme-accent-ink)', fontSize: 11, marginTop: 2, flexShrink: 0 }}>→</span>
                    <span style={{ fontSize: 12, color: 'var(--theme-text2)', lineHeight: 1.6 }}>{tip}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    )
  }

  // ── Module Guide data (PERF-9, S876) ──────────────────────────────────────────────────────────
  // The five feature lists arrive in chunks of their own (./help/loadHelpFeatures.js). Until they
  // do, `helpFeatures` is null and every reader below takes an empty list: the Module Guide shows a
  // loading line, and search shows its glossary and FAQ matches and says the guides are still being
  // searched. A failed fetch is said plainly with a Try again, never shown as an empty guide.
  const [helpFeatures, setHelpFeatures] = useState(() => loadedHelpFeatures())
  const [featuresError, setFeaturesError] = useState(null)
  // `quiet` is the idle fetch below: nobody has asked for the guides yet, so its failure is not
  // shown, and the next real request asks again (the loader drops a failed promise).
  const requestFeatures = useCallback((quiet = false) => {
    const ready = loadedHelpFeatures()
    if (ready) { setHelpFeatures(ready); return }
    if (!quiet) setFeaturesError(null)
    loadHelpFeatures().then(setHelpFeatures, err => {
      if (quiet) return
      // A deploy that replaced the files while this tab sat open: reload onto the new build, as a
      // lazy route does. Offline it does not reload, and the message below is what the reader gets.
      if (recoverFromChunkError(err)) return
      setFeaturesError(asActionError(err, 'operator'))
    })
  }, [])
  // The Module Guide asks the moment it is the open tab: a click, the arrow keys, or a link to
  // /help?section=modules.
  useEffect(() => { if (activeSection === 'modules') requestFeatures() }, [activeSection, requestFeatures])
  // Otherwise the lists are fetched once the browser is idle after the first paint, so the guide and
  // the search are usually ready before anyone asks. Not on Data Saver or a 2G-class link, where the
  // download costs more than the wait it saves (prefetchHrPages.js).
  useEffect(() => {
    if (!prefetchAllowed(navigator.connection)) return undefined
    if (window.requestIdleCallback) {
      const id = window.requestIdleCallback(() => requestFeatures(true), { timeout: 5000 })
      return () => window.cancelIdleCallback(id)
    }
    const id = setTimeout(() => requestFeatures(true), 500)
    return () => clearTimeout(id)
  }, [requestFeatures])
  const {
    IMS_FEATURE_TIERS = [], SUITE_FEATURES = [], HR_FEATURES = [], POS_FEATURES = [], ADMIN_FEATURES = [],
  } = helpFeatures || {}

  // A failed fetch of the guides and its Try again, on the Module Guide tab and in search results. A
  // plain function returning JSX, not a component, so a re-render (each keystroke in the search box)
  // updates the alert in place instead of mounting a new one to be announced again.
  function guidesFailed(text) {
    return (
      <div style={{ marginBottom: 24 }}>
        <ActionError error={{ text, detail: featuresError.detail }} className="action-error--top" />
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => requestFeatures()}>Try again</button>
      </div>
    )
  }

  // Flat, searchable index built once from the same data every tab already renders from — a
  // module guide feature is covered by search the moment it exists in IMS_FEATURES /
  // SUITE_FEATURES / HR_FEATURES / POS_FEATURES / ADMIN_FEATURES (./help/*Features.js), with no separate list to keep in sync. Tier
  // locking is deliberately not applied here (unlike the Module Guide tab's LockedRow) — showing
  // a locked feature's full guide text in a search result is closer to how Pricing already
  // advertises locked features openly than something that needs gating. Empty until the lists arrive.
  const searchIndex = useMemo(() => {
    const items = []
    if (!helpFeatures) return items
    helpFeatures.IMS_FEATURES.forEach(f => items.push({ feat: f, moduleKey: 'ims', module: 'IMS' }))
    helpFeatures.SUITE_FEATURES.forEach(f => items.push({ feat: f, moduleKey: 'suite', module: 'Suite' }))
    helpFeatures.HR_FEATURES.forEach(f => items.push({ feat: f, moduleKey: 'hr', module: 'HR' }))
    helpFeatures.POS_FEATURES.forEach(f => items.push({ feat: f, moduleKey: 'pos', module: 'POS' }))
    helpFeatures.ADMIN_FEATURES.forEach(f => items.push({ feat: f, moduleKey: 'admin', module: 'Admin' }))
    return items
  }, [helpFeatures])

  const searchQ = searchQuery.trim().toLowerCase()
  const searching = searchQ.length > 0
  const matchedFeatures = searching ? searchIndex.filter(({ feat }) =>
    feat.name.toLowerCase().includes(searchQ) ||
    (feat.guide || feat.desc || '').toLowerCase().includes(searchQ) ||
    (feat.tips || []).some(t => t.toLowerCase().includes(searchQ))
  ) : []
  const matchedGlossary = searching ? GLOSSARY.filter(g =>
    g.term.toLowerCase().includes(searchQ) || g.def.toLowerCase().includes(searchQ)
  ) : []
  const matchedFaq = searching ? FAQ.filter(f =>
    f.q.toLowerCase().includes(searchQ) || f.a.toLowerCase().includes(searchQ)
  ) : []
  const searchResultCount = matchedFeatures.length + matchedGlossary.length + matchedFaq.length

  // A Suite page is open by SuiteGate's own answer (suiteAccess), minus the module floor: the guide is
  // worth reading before HR is switched on. The Group Console also opens from a branch without Suite
  // once any outlet of its group has it (ACCESS-7). A client row that did not load is not "no Suite"
  // (ACCESS-11), so the guide stays readable then rather than showing a paying Owner a lock.
  const groupHasSuite = (outlets || []).some(o => suiteLive(o))
  function suiteOpen(feat) {
    const a = suiteAccess(auth, { featureKey: feat.featureKey, requireModules: [] },
      { entitled: feat.featureKey === 'multi_outlet' && groupHasSuite })
    return a.allowed || a.reason === 'unknown'
  }
  // 0 until the guides arrive: SUITE_FEATURES is an empty list until then.
  const suiteLocked = SUITE_FEATURES.filter(f => !suiteOpen(f)).length

  // Locked feature row — compact, non-expandable
  function LockedRow({ feat, note = 'Not on your plan' }) {
    return (
      <div style={{
        display: 'flex', alignItems: 'center', gap: 10, padding: '10px 18px',
        background: 'var(--theme-card)', border: '1px solid var(--theme-border-lt)', borderRadius: 'var(--radius-sm)', marginBottom: 4,
      }}>
        {/* Label the state, never dim the row: opacity multiplies through the text colour and took
            these below AA — on the names of the features an owner would upgrade FOR (S682). */}
        <span aria-hidden="true" style={{ fontSize: 14, width: 22, textAlign: 'center', flexShrink: 0 }}>{feat.icon}</span>
        <span style={{ fontSize: 13, color: 'var(--theme-text3)' }}>{feat.name}</span>
        <span className="badge badge-gray" style={{ marginLeft: 'auto', flexShrink: 0 }}>{note}</span>
      </div>
    )
  }

  return (
    <div>
      <div className="page-header">
        <h1 className="page-title">Help & Guide</h1>
        <p className="page-subtitle">How to use every feature — glossary, FAQ, and tips</p>
      </div>

      {/* Visible on every tab without a click, not just the Support one below (S673) — the guide
          answers "how", this answers "who do I ask when the guide doesn't". */}
      <div className="no-print" style={{ marginBottom: 16, fontSize: 12, color: 'var(--theme-text3)' }}>
        Need help? <SupportContactLine variant="inline" />
      </div>

      {/* Section tabs */}
      <div role="tablist" aria-label="Help sections" style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginBottom: 28, borderBottom: '1px solid var(--theme-border)' }}>
        {[
          { id: 'guide',   label: 'Getting Started' },
          { id: 'modules', label: 'Module Guide' },
          { id: 'glossary', label: 'Glossary' },
          { id: 'faq',     label: 'FAQ' },
          { id: 'pricing', label: '💎 Pricing' },
          { id: 'support', label: 'Support' },
          { id: 'legal',   label: 'Legal' },
        ].map((s, i, arr) => (
          /* .panel-tab is the underline-tab family DESIGN.md added for exactly this shape, and it
             brings the hover state and the coarse-pointer 44px floor an inline style cannot carry.
             Roving tabIndex + arrow keys so the whole row is ONE stop in the page's tab order
             rather than five — per DESIGN.md's Tabs rule. */
          <button
            key={s.id}
            role="tab"
            id={`help-tab-${s.id}`}
            aria-selected={activeSection === s.id}
            aria-controls="help-tabpanel"
            tabIndex={activeSection === s.id ? 0 : -1}
            onClick={() => setActiveSection(s.id)}
            onKeyDown={e => {
              const dir = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0
              if (dir) {
                e.preventDefault()
                const next = arr[(i + dir + arr.length) % arr.length]
                setActiveSection(next.id)
                document.getElementById(`help-tab-${next.id}`)?.focus()
              } else if (e.key === 'Home') {
                e.preventDefault(); setActiveSection(arr[0].id); document.getElementById(`help-tab-${arr[0].id}`)?.focus()
              } else if (e.key === 'End') {
                e.preventDefault(); setActiveSection(arr[arr.length - 1].id); document.getElementById(`help-tab-${arr[arr.length - 1].id}`)?.focus()
              }
            }}
            className={`panel-tab${activeSection === s.id ? ' panel-tab--active' : ''}`}
          >{s.label}</button>
        ))}
      </div>

      {/* Search — spans every tab's content (Module Guide, Glossary, FAQ) from one box, since
          a client has no way to know which of 5 tabs an answer lives in otherwise. */}
      <div style={{ marginBottom: 24 }}>
        {/* Was an unlabeled input carrying .form-select — a <select> class on a text box, with a
            placeholder standing in for a label (DESIGN.md forbids exactly that). */}
        <label htmlFor="help-search" className="sr-only">Search help</label>
        <input
          id="help-search"
          type="search"
          value={searchQuery}
          // The guides are fetched on focus, and on the first keystroke for a box filled without
          // one (autofill). The query is plain state, so nothing typed is lost while they arrive.
          onFocus={() => requestFeatures()}
          onChange={e => {
            setSearchQuery(e.target.value)
            if (!helpFeatures && !featuresError) requestFeatures()
          }}
          placeholder="Search features, glossary terms, and FAQs…"
          className="form-input"
          style={{ width: '100%', maxWidth: 480 }}
        />
      </div>

      {searching && (
        <div style={{ marginBottom: 28 }}>
          {/* role="status" so the count is announced as it changes — a sighted user watches the
              list shrink while typing; without this a screen-reader user gets nothing. */}
          <p role="status" aria-live="polite" style={{ fontSize: 13, color: 'var(--theme-text2)', marginBottom: 16 }}>
            {searchResultCount} result{searchResultCount === 1 ? '' : 's'} for "{searchQuery}"
          </p>
          {/* Until the guides arrive the results hold glossary and FAQ matches only, and say so;
              the count above updates (and is announced) when the guide matches join them. */}
          {!helpFeatures && (featuresError
            ? guidesFailed('The module guides could not load, so these results cover the glossary and FAQ only. Check your connection, then try again.')
            : <p style={{ fontSize: 13, color: 'var(--theme-text3)', marginBottom: 24 }}>Searching the module guides…</p>)}
          {matchedFeatures.length > 0 && (
            <div style={{ marginBottom: 24 }}>
              <p style={{ fontSize: 11, fontWeight: 700, color: 'var(--theme-text3)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 8 }}>Module Guide</p>
              {matchedFeatures.map(({ feat, moduleKey, module }) => (
                <div key={`${moduleKey}:${feat.name}`} style={{ display: 'flex', alignItems: 'flex-start', gap: 10, marginBottom: 6 }}>
                  <span style={{ fontSize: 10, fontWeight: 700, color: 'var(--theme-accent-ink)', width: 34, flexShrink: 0, marginTop: 14, textTransform: 'uppercase' }}>{module}</span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <FeatureCard feat={feat} moduleKey={`search-${moduleKey}`} />
                  </div>
                </div>
              ))}
            </div>
          )}
          {matchedGlossary.length > 0 && (
            <div style={{ marginBottom: 24 }}>
              <p style={{ fontSize: 11, fontWeight: 700, color: 'var(--theme-text3)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 8 }}>Glossary</p>
              {matchedGlossary.map(g => (
                <div key={g.term} className="card" style={{ padding: '12px 18px', marginBottom: 6 }}>
                  <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--theme-text1)', marginBottom: 4 }}>{g.term}</div>
                  <div style={{ fontSize: 12, color: 'var(--theme-text2)', lineHeight: 1.6 }}>{g.def}</div>
                </div>
              ))}
            </div>
          )}
          {matchedFaq.length > 0 && (
            <div>
              <p style={{ fontSize: 11, fontWeight: 700, color: 'var(--theme-text3)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 8 }}>FAQ</p>
              {matchedFaq.map((item, i) => (
                <div key={i} className="card" style={{ padding: '12px 18px', marginBottom: 6 }}>
                  <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--theme-text1)', marginBottom: 4 }}>{item.q}</div>
                  <div style={{ fontSize: 12, color: 'var(--theme-text2)', lineHeight: 1.6 }}>{item.a}</div>
                </div>
              ))}
            </div>
          )}
          {searchResultCount === 0 && helpFeatures && (
            <div className="empty-state">No results for "{searchQuery}". Try a different term, or clear the search to browse the tabs above.</div>
          )}
        </div>
      )}

      {/* One tabpanel wrapping all five section bodies — aria-labelledby points at whichever tab
          is currently selected, so the panel is announced with its own section's name. */}
      <div id="help-tabpanel" role="tabpanel" aria-labelledby={`help-tab-${activeSection}`} tabIndex={-1}>

      {!searching && <>

      {/* GETTING STARTED */}
      {activeSection === 'guide' && (
        <div>
          {/* Your own setup guide (S790), always in full here — the same list the dashboard card
              shows, with its ticks, and the way back to the dashboard after hiding it. Renders
              nothing for a login that gets no guide (staff rank, PIN logins). */}
          <SetupGuideCard surface="help" />
          {imsEnabled && (
          <div>
          <div className="card" style={{ marginBottom: 16, background: 'color-mix(in srgb, var(--theme-accent) 3%, transparent)', borderColor: 'color-mix(in srgb, var(--theme-accent) 20%, transparent)' }}>
            <div style={{ display: 'flex', gap: 16, alignItems: 'flex-start' }}>
              <span aria-hidden="true" style={{ fontSize: 32, lineHeight: 1, flexShrink: 0 }}>⬢</span>
              <div style={{ flex: 1 }}>
                <h2 style={{ margin: '0 0 8px', fontSize: 15, color: 'var(--theme-text1)' }}>
                  <button type="button" aria-expanded={gsOpen('ims')} onClick={() => toggleGS('ims')} style={GS_TOGGLE_STYLE}>
                    <span>Welcome to Crest Suite</span>
                    <span aria-hidden="true" style={{ color: 'var(--theme-text3)', fontSize: 13, fontWeight: 400 }}>{gsOpen('ims') ? '▲' : '▼'}</span>
                  </button>
                </h2>
                {!gsOpen('ims') && (
                  <p style={{ margin: 0, fontSize: 13, color: 'var(--theme-text3)' }}>Click to see first-time setup, monthly workflow, and common mistakes to avoid.</p>
                )}
                {gsOpen('ims') && (
                  <>
                    <p style={{ margin: '0 0 8px', fontSize: 13, color: 'var(--theme-text2)', lineHeight: 1.75 }}>
                      Crest tracks your ingredient purchases, stock levels, and food cost in real time. The core idea is simple:
                    </p>
                    <div style={{ background: 'var(--theme-bg)', border: '1px solid var(--theme-border)', borderRadius: 0, padding: '10px 16px', display: 'inline-block', marginBottom: 8 }}>
                      <span style={{ fontSize: 13, color: 'var(--theme-accent-ink)', fontWeight: 600 }}>Opening Stock + Purchases − Wastage − Closing Stock = COGS (what you actually used)</span>
                    </div>
                    <p style={{ margin: 0, fontSize: 13, color: 'var(--theme-text2)', lineHeight: 1.75 }}>
                      Follow the steps below to get set up. First-time setup takes about 30–60 minutes. After that, the monthly routine takes 15–20 minutes of admin at month end.
                    </p>
                  </>
                )}
              </div>
            </div>
          </div>

          {gsOpen('ims') && (
          <>
          <div className="card" style={{ marginBottom: 16 }}>
            <h3 style={{ margin: '0 0 6px', fontSize: 15, color: 'var(--theme-text1)' }}>First-Time Setup</h3>
            <p style={{ margin: '0 0 20px', fontSize: 12, color: 'var(--theme-text2)' }}>Do this once when you first log in. Takes 30–60 minutes.</p>
            {[
              { step: 1, title: 'Add your Ingredients', desc: 'Go to Item Master → add every ingredient you buy. Each item needs a name, category, unit of measure (UOM) and one price: what ONE unit costs. Use the smallest unit you actually cook with — sauce in ML, salt in GM. Only know the pack price? Use the "Bought a pack?" line (500 GM for NPR 388.50) and Crest works out the per-unit price for you.', why: 'Every purchase, stock count and recipe cost is priced off this per-unit rate. You cannot enter purchases without items.' },
              { step: 2, title: 'Add your Vendors', desc: 'Go to Vendors → add all your suppliers.', why: 'A purchase can be saved without a vendor, but then it shows with no supplier name in the vendor reports and in Outstanding Payables, and Crest cannot warn you when the same bill is entered twice. Add your suppliers before entering purchases.' },
              { step: 3, title: 'Check your first Period is open', desc: 'Go to Periods — the current BS month is already there, marked open. Crest opens your first month when your account is set up, so there is nothing to create. If no month is open, contact Crest support.', why: 'All purchases, stock, and sales live inside a period (one BS month). Nothing can be entered without an open period.' },
              { step: 4, title: 'Enter Opening Stock', desc: 'Go to Stock Count → Opening Stock tab → enter the quantity of each ingredient you have right now.', why: 'COGS calculation starts from opening stock. Skip this and your food cost % will be wrong for the first month.' },
              { step: 5, title: 'Build your Recipes', desc: 'Go to Recipe Costing → New Recipe → add each menu item with its ingredients and selling price.', why: 'Required for the Variance Report and food cost % per dish. Skip this step if you are on the Starter plan.', plan: 'Growth+' },
            ].map((s, i, arr) => (
              <div key={s.step} style={{ display: 'flex', gap: 16, marginBottom: 16, paddingBottom: 16, borderBottom: i < arr.length - 1 ? '1px solid var(--theme-border)' : 'none' }}>
                <div style={{ width: 32, height: 32, borderRadius: 0, background: 'color-mix(in srgb, var(--theme-accent) 12%, transparent)', border: '1px solid color-mix(in srgb, var(--theme-accent) 30%, transparent)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 13, fontWeight: 700, color: 'var(--theme-accent-ink)', flexShrink: 0 }}>{s.step}</div>
                <div style={{ flex: 1 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                    <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--theme-text1)' }}>{s.title}</span>
                    {s.plan && <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--theme-green-text)', background: 'color-mix(in srgb, var(--theme-green) 10%, transparent)', border: '1px solid color-mix(in srgb, var(--theme-green) 20%, transparent)', padding: '1px 7px', borderRadius: 0 }}>{s.plan}</span>}
                  </div>
                  <div style={{ fontSize: 13, color: 'var(--theme-text3)', marginBottom: 6 }}>{s.desc}</div>
                  <div style={{ display: 'flex', gap: 6, alignItems: 'flex-start' }}>
                    <span style={{ color: 'var(--theme-accent-ink)', fontSize: 11, marginTop: 1, flexShrink: 0 }}>Why:</span>
                    <span style={{ fontSize: 12, color: 'var(--theme-text2)' }}>{s.why}</span>
                  </div>
                </div>
              </div>
            ))}
          </div>

          <div className="card" style={{ marginBottom: 16 }}>
            <h3 style={{ margin: '0 0 6px', fontSize: 15, color: 'var(--theme-text1)' }}>Monthly Workflow</h3>
            <p style={{ margin: '0 0 20px', fontSize: 12, color: 'var(--theme-text2)' }}>Repeat this every BS month. Steps 1–4 are ongoing during the month; steps 5–9 happen at month end.</p>
            {[
              { step: 1, title: 'Check the new Period is open',    desc: 'Nothing to create: closing last month (step 9) opened this one. Check Periods shows the current BS month as open. If no month is open, contact Crest support.' },
              { step: 2, title: 'Enter Opening Stock',              desc: 'Stock Count → Opening Stock tab → enter qty for each item. For month 2 onward, this auto-carries from last month\'s closing.' },
              { step: 3, title: 'Record Purchases as they arrive',  desc: 'Purchases → Add Purchase opens a full-page bill screen — enter vendor, item, qty, rate, payment method, then Save to return to the list. Enter each bill on the day it arrives.' },
              { step: 4, title: 'Record Wastage as it happens',     desc: 'Stock Count → Wastage tab → log any spoilage or discards on the day.' },
              { step: 5, title: 'Enter Sales',                      desc: 'Sales Entry → enter qty sold per menu item. Use Bulk Entry for a month-end tally. Running Crest POS? Skip this step entirely — the till posts sales for you, and both entry tabs are locked.', plan: 'Starter+' },
              { step: 6, title: 'Physical Stock Count',             desc: 'On the last day: print the Stock Count Sheet (Stock → Print Sheet), do a physical walk of your storeroom, enter counts in Stock Count → Closing Stock.' },
              { step: 7, title: 'Review Monthly Summary',           desc: 'Monthly Summary → check COGS per category and revenue. Food cost % appears once the month is closed (step 9) — until then it reads "Needs closing count", or "Shown when the month closes" once every item is counted. Export the closed month to Excel for management.' },
              { step: 8, title: 'Review Variance Report',           desc: 'Variance → the flagged rows are listed first, biggest NPR value on top → investigate every row marked ▲. High variance = waste, theft, or over-portioning. The threshold is yours (Settings → Thresholds → Variance Flag, default 10%).', plan: 'Growth+' },
              { step: 9, title: 'Close the Period',                 desc: 'Once the month has ended, press "End <month> & Start <next>" on the Dashboard banner (or on Periods) → confirm. This locks the month for staff (the account owner can still correct it) and opens the next one. Closing stock automatically becomes opening stock for next month.' },
            ].map((s, i, arr) => (
              <div key={s.step} style={{ display: 'flex', gap: 14, marginBottom: 12, paddingBottom: 12, borderBottom: i < arr.length - 1 ? '1px solid var(--theme-border-lt)' : 'none' }}>
                <div style={{ width: 26, height: 26, borderRadius: 0, background: 'var(--theme-bg)', border: '1px solid var(--theme-border)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 11, fontWeight: 700, color: 'var(--theme-accent-ink)', flexShrink: 0 }}>{s.step}</div>
                <div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 3 }}>
                    <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--theme-text1)' }}>{s.title}</span>
                    {s.plan && <span style={{ fontSize: 11, fontWeight: 700, color: s.plan === 'Growth+' ? 'var(--theme-green-text)' : 'var(--theme-text3)', background: s.plan === 'Growth+' ? 'color-mix(in srgb, var(--theme-green) 10%, transparent)' : 'rgba(156,163,175,0.1)', border: `1px solid ${s.plan === 'Growth+' ? 'color-mix(in srgb, var(--theme-green) 20%, transparent)' : 'rgba(156,163,175,0.2)'}`, padding: '1px 7px', borderRadius: 0 }}>{s.plan}</span>}
                  </div>
                  <div style={{ fontSize: 12, color: 'var(--theme-text2)' }}>{s.desc}</div>
                </div>
              </div>
            ))}
          </div>

          <div className="card" style={{ borderColor: 'color-mix(in srgb, var(--theme-red) 15%, transparent)' }}>
            <h3 style={{ margin: '0 0 16px', fontSize: 15, color: 'var(--theme-text1)' }}>Common Mistakes to Avoid</h3>
            {[
              'Closing a period before entering closing stock — your COGS will be inflated with no closing offset.',
              'Skipping opening stock in month 1 — your food cost % will be artificially high.',
              'Entering all purchases at month end from memory — enter them daily from the actual invoice for an accurate rate and vendor record.',
              'Ignoring the Variance Report — if you don\'t check it, waste and over-portioning go undetected for months.',
              'Using estimated closing stock — always do a physical count. Estimated numbers make every report inaccurate.',
            ].map((text, i, arr) => (
              <div key={i} style={{ display: 'flex', gap: 10, marginBottom: i < arr.length - 1 ? 10 : 0 }}>
                <span style={{ color: 'var(--theme-red-text)', fontSize: 12, flexShrink: 0, marginTop: 1 }}>✕</span>
                <span style={{ fontSize: 13, color: 'var(--theme-text2)', lineHeight: 1.6 }}>{text}</span>
              </div>
            ))}
          </div>
          </>
          )}
          </div>
          )}

          {hrEnabled && (
          <div>
            <div className="card" style={{ marginBottom: 16, background: 'color-mix(in srgb, var(--theme-accent) 3%, transparent)', borderColor: 'color-mix(in srgb, var(--theme-accent) 20%, transparent)' }}>
              <div style={{ display: 'flex', gap: 16, alignItems: 'flex-start' }}>
                <span aria-hidden="true" style={{ fontSize: 32, lineHeight: 1, flexShrink: 0 }}>👤</span>
                <div style={{ flex: 1 }}>
                  <h2 style={{ margin: '0 0 8px', fontSize: 15, color: 'var(--theme-text1)' }}>
                    <button type="button" aria-expanded={gsOpen('hr')} onClick={() => toggleGS('hr')} style={GS_TOGGLE_STYLE}>
                      <span>Welcome to Crest HR</span>
                      <span aria-hidden="true" style={{ color: 'var(--theme-text3)', fontSize: 13, fontWeight: 400 }}>{gsOpen('hr') ? '▲' : '▼'}</span>
                    </button>
                  </h2>
                  {!gsOpen('hr') && (
                    <p style={{ margin: 0, fontSize: 13, color: 'var(--theme-text3)' }}>Click to see first-time setup, monthly workflow, and common mistakes to avoid.</p>
                  )}
                  {gsOpen('hr') && (
                    <>
                      <p style={{ margin: '0 0 8px', fontSize: 13, color: 'var(--theme-text2)', lineHeight: 1.75 }}>
                        Crest HR runs payroll, attendance, and Nepal-compliant SSF/TDS deductions for your staff. The core idea is simple:
                      </p>
                      <div style={{ background: 'var(--theme-bg)', border: '1px solid var(--theme-border)', borderRadius: 0, padding: '10px 16px', display: 'inline-block', marginBottom: 8 }}>
                        <span style={{ fontSize: 13, color: 'var(--theme-green-text)', fontWeight: 600 }}>Attendance → Payroll: what you mark each day becomes what people get paid</span>
                      </div>
                    </>
                  )}
                </div>
              </div>
            </div>

            {gsOpen('hr') && (
            <>
            <div className="card" style={{ marginBottom: 16 }}>
              <h3 style={{ margin: '0 0 6px', fontSize: 15, color: 'var(--theme-text1)' }}>First-Time Setup</h3>
              <p style={{ margin: '0 0 20px', fontSize: 12, color: 'var(--theme-text2)' }}>Do this once when you first turn on Crest HR.</p>
              {HR_SETUP_STEPS.map((s, i, arr) => (
                <div key={s.step} style={{ display: 'flex', gap: 16, marginBottom: 16, paddingBottom: 16, borderBottom: i < arr.length - 1 ? '1px solid var(--theme-border)' : 'none' }}>
                  <div style={{ width: 32, height: 32, borderRadius: 0, background: 'color-mix(in srgb, var(--theme-accent) 12%, transparent)', border: '1px solid color-mix(in srgb, var(--theme-accent) 30%, transparent)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 13, fontWeight: 700, color: 'var(--theme-accent-ink)', flexShrink: 0 }}>{s.step}</div>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--theme-text1)', marginBottom: 4 }}>{s.title}</div>
                    <div style={{ fontSize: 13, color: 'var(--theme-text3)', marginBottom: 6 }}>{s.desc}</div>
                    <div style={{ display: 'flex', gap: 6, alignItems: 'flex-start' }}>
                      <span style={{ color: 'var(--theme-accent-ink)', fontSize: 11, marginTop: 1, flexShrink: 0 }}>Why:</span>
                      <span style={{ fontSize: 12, color: 'var(--theme-text2)' }}>{s.why}</span>
                    </div>
                  </div>
                </div>
              ))}
            </div>

            <div className="card" style={{ marginBottom: 16 }}>
              <h3 style={{ margin: '0 0 6px', fontSize: 15, color: 'var(--theme-text1)' }}>Monthly Workflow</h3>
              <p style={{ margin: '0 0 20px', fontSize: 12, color: 'var(--theme-text2)' }}>Repeat this every BS month.</p>
              {HR_WORKFLOW_STEPS.map((s, i, arr) => (
                <div key={s.step} style={{ display: 'flex', gap: 14, marginBottom: 12, paddingBottom: 12, borderBottom: i < arr.length - 1 ? '1px solid var(--theme-border-lt)' : 'none' }}>
                  <div style={{ width: 26, height: 26, borderRadius: 0, background: 'var(--theme-bg)', border: '1px solid var(--theme-border)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 11, fontWeight: 700, color: 'var(--theme-accent-ink)', flexShrink: 0 }}>{s.step}</div>
                  <div>
                    <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--theme-text1)', marginBottom: 3 }}>{s.title}</div>
                    <div style={{ fontSize: 12, color: 'var(--theme-text2)' }}>{s.desc}</div>
                  </div>
                </div>
              ))}
            </div>

            <div className="card" style={{ borderColor: 'color-mix(in srgb, var(--theme-red) 15%, transparent)' }}>
              <h3 style={{ margin: '0 0 16px', fontSize: 15, color: 'var(--theme-text1)' }}>Common Mistakes to Avoid</h3>
              {HR_MISTAKES.map((text, i, arr) => (
                <div key={i} style={{ display: 'flex', gap: 10, marginBottom: i < arr.length - 1 ? 10 : 0 }}>
                  <span style={{ color: 'var(--theme-red-text)', fontSize: 12, flexShrink: 0, marginTop: 1 }}>✕</span>
                  <span style={{ fontSize: 13, color: 'var(--theme-text2)', lineHeight: 1.6 }}>{text}</span>
                </div>
              ))}
            </div>
            </>
            )}
          </div>
          )}

          {posEnabled && (
          <div>
            <div className="card" style={{ marginBottom: 16, background: 'color-mix(in srgb, var(--theme-accent) 3%, transparent)', borderColor: 'color-mix(in srgb, var(--theme-accent) 20%, transparent)' }}>
              <div style={{ display: 'flex', gap: 16, alignItems: 'flex-start' }}>
                <span aria-hidden="true" style={{ fontSize: 32, lineHeight: 1, flexShrink: 0 }}>⊕</span>
                <div style={{ flex: 1 }}>
                  <h2 style={{ margin: gsOpen('pos') ? '0 0 8px' : 0, fontSize: 15, color: 'var(--theme-text1)' }}>
                    <button type="button" aria-expanded={gsOpen('pos')} onClick={() => toggleGS('pos')} style={GS_TOGGLE_STYLE}>
                      <span>Welcome to Crest POS</span>
                      <span aria-hidden="true" style={{ color: 'var(--theme-text3)', fontSize: 13, fontWeight: 400 }}>{gsOpen('pos') ? '▲' : '▼'}</span>
                    </button>
                  </h2>
                  {!gsOpen('pos') && (
                    <p style={{ margin: 0, fontSize: 13, color: 'var(--theme-text3)' }}>Click to see first-time setup, daily workflow, and common mistakes to avoid.</p>
                  )}
                  {gsOpen('pos') && (
                    <>
                      <p style={{ margin: '0 0 8px', fontSize: 13, color: 'var(--theme-text2)', lineHeight: 1.75 }}>
                        Crest POS runs your floor — tables, orders, billing, and shift reconciliation. The core idea is simple:
                      </p>
                      <div style={{ background: 'var(--theme-bg)', border: '1px solid var(--theme-border)', borderRadius: 0, padding: '10px 16px', display: 'inline-block' }}>
                        <span style={{ fontSize: 13, color: 'var(--theme-purple-text)', fontWeight: 600 }}>Order → Bill → Shift Close: every sale reconciles back to the cash drawer at day's end</span>
                      </div>
                    </>
                  )}
                </div>
              </div>
            </div>

            {gsOpen('pos') && (
            <>
            <div className="card" style={{ marginBottom: 16 }}>
              <h3 style={{ margin: '0 0 6px', fontSize: 15, color: 'var(--theme-text1)' }}>First-Time Setup</h3>
              <p style={{ margin: '0 0 20px', fontSize: 12, color: 'var(--theme-text2)' }}>Do this once when you first turn on Crest POS.</p>
              {POS_SETUP_STEPS.map((s, i, arr) => (
                <div key={s.step} style={{ display: 'flex', gap: 16, marginBottom: 16, paddingBottom: 16, borderBottom: i < arr.length - 1 ? '1px solid var(--theme-border)' : 'none' }}>
                  <div style={{ width: 32, height: 32, borderRadius: 0, background: 'color-mix(in srgb, var(--theme-accent) 12%, transparent)', border: '1px solid color-mix(in srgb, var(--theme-accent) 30%, transparent)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 13, fontWeight: 700, color: 'var(--theme-accent-ink)', flexShrink: 0 }}>{s.step}</div>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--theme-text1)', marginBottom: 4 }}>{s.title}</div>
                    <div style={{ fontSize: 13, color: 'var(--theme-text3)', marginBottom: 6 }}>{s.desc}</div>
                    <div style={{ display: 'flex', gap: 6, alignItems: 'flex-start' }}>
                      <span style={{ color: 'var(--theme-accent-ink)', fontSize: 11, marginTop: 1, flexShrink: 0 }}>Why:</span>
                      <span style={{ fontSize: 12, color: 'var(--theme-text2)' }}>{s.why}</span>
                    </div>
                  </div>
                </div>
              ))}
            </div>

            <div className="card" style={{ marginBottom: 16 }}>
              <h3 style={{ margin: '0 0 6px', fontSize: 15, color: 'var(--theme-text1)' }}>Daily Workflow</h3>
              <p style={{ margin: '0 0 20px', fontSize: 12, color: 'var(--theme-text2)' }}>Repeat this every shift/day the floor is open.</p>
              {POS_WORKFLOW_STEPS.map((s, i, arr) => (
                <div key={s.step} style={{ display: 'flex', gap: 14, marginBottom: 12, paddingBottom: 12, borderBottom: i < arr.length - 1 ? '1px solid var(--theme-border-lt)' : 'none' }}>
                  <div style={{ width: 26, height: 26, borderRadius: 0, background: 'var(--theme-bg)', border: '1px solid var(--theme-border)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 11, fontWeight: 700, color: 'var(--theme-accent-ink)', flexShrink: 0 }}>{s.step}</div>
                  <div>
                    <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--theme-text1)', marginBottom: 3 }}>{s.title}</div>
                    <div style={{ fontSize: 12, color: 'var(--theme-text2)' }}>{s.desc}</div>
                  </div>
                </div>
              ))}
            </div>

            <div className="card" style={{ borderColor: 'color-mix(in srgb, var(--theme-red) 15%, transparent)' }}>
              <h3 style={{ margin: '0 0 16px', fontSize: 15, color: 'var(--theme-text1)' }}>Common Mistakes to Avoid</h3>
              {POS_MISTAKES.map((text, i, arr) => (
                <div key={i} style={{ display: 'flex', gap: 10, marginBottom: i < arr.length - 1 ? 10 : 0 }}>
                  <span style={{ color: 'var(--theme-red-text)', fontSize: 12, flexShrink: 0, marginTop: 1 }}>✕</span>
                  <span style={{ fontSize: 13, color: 'var(--theme-text2)', lineHeight: 1.6 }}>{text}</span>
                </div>
              ))}
            </div>
            </>
            )}
          </div>
          )}
        </div>
      )}

      {/* MODULE GUIDE */}
      {activeSection === 'modules' && (
        <div>
          {/* The module headings need no data and show at once; what sits under an open one waits
              for the feature lists (PERF-9), and this line says why it is empty meanwhile. */}
          {!helpFeatures && (featuresError
            ? guidesFailed('The module guides could not load. Check your connection, then try again.')
            : <p style={{ fontSize: 13, color: 'var(--theme-text3)', marginBottom: 16 }}>Loading the module guides…</p>)}

          {/* ── Crest IMS ── */}
          {imsEnabled && (
            <div style={{ marginBottom: 32 }}>
              {/* Module header — rolled up by default; click to reveal this module's topic list. A real
                  button since S852, as the Suite header below already was: the IMS, HR and POS
                  headers were a div with onClick, so a keyboard could not open their guides. */}
              <button
                type="button"
                aria-expanded={moduleOpen('ims')}
                onClick={() => toggleModule('ims')}
                style={{ ...GS_TOGGLE_STYLE, justifyContent: 'flex-start', gap: 10, marginBottom: 16, paddingBottom: 12, borderBottom: '2px solid color-mix(in srgb, var(--theme-accent) 20%, transparent)' }}
              >
                <span aria-hidden="true" style={{ fontSize: 18, color: 'var(--theme-accent-ink)' }}>▦</span>
                <span style={{ fontSize: 15, fontWeight: 700, color: 'var(--theme-text1)' }}>Crest IMS</span>
                <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--theme-green-text)', background: 'color-mix(in srgb, var(--theme-green) 10%, transparent)', border: '1px solid color-mix(in srgb, var(--theme-green) 20%, transparent)', padding: '2px 8px', borderRadius: 0 }}>Active</span>
                {!isAdmin && (
                  <span style={{ fontSize: 11, color: 'var(--theme-text2)', marginLeft: 4 }}>
                    {plan === 'pro' ? 'Pro Plan' : plan === 'growth' ? 'Growth Plan' : 'Starter Plan'}
                  </span>
                )}
                <span aria-hidden="true" style={{ marginLeft: 'auto', color: 'var(--theme-text3)', fontSize: 13 }}>{moduleOpen('ims') ? '▲' : '▼'}</span>
              </button>

              {moduleOpen('ims') && IMS_FEATURE_TIERS.map(tier => {
                const unlocked = isTierUnlocked(tier.tier, plan, isAdmin)
                return (
                  <div key={tier.tier} style={{ marginBottom: 20 }}>
                    {/* Tier label row. A plan is a category, so it is named in words in one neutral
                        treatment (S852): the chips had a hue per plan, which put Growth in the
                        verdict green, sat Starter's text3 on a tint of itself below AA on Light
                        (4.1:1), and set the lock count in 9px. */}
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8, flexWrap: 'wrap' }}>
                      <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--theme-text2)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>
                        {tier.label}
                      </span>
                      {!unlocked && (
                        <span className="badge-gray badge-sentence">
                          🔒 {tier.features.length} features locked
                        </span>
                      )}
                    </div>

                    {/* Features */}
                    {tier.features.map(feat =>
                      unlocked
                        ? <FeatureCard key={feat.name} feat={feat} moduleKey="ims" />
                        : <LockedRow key={feat.name} feat={feat} />
                    )}

                    {/* Upgrade nudge for locked tiers */}
                    {!unlocked && (
                      <div style={{
                        marginTop: 8, padding: '10px 14px',
                        border: '1px dashed var(--theme-border)',
                        borderRadius: 0, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap'
                      }}>
                        <span style={{ fontSize: 12, color: 'var(--theme-text2)' }}>
                          Upgrade to <strong style={{ color: 'var(--theme-text1)' }}>{tier.planLabel}</strong> to unlock {tier.features.length} features
                        </span>
                        <button type="button" className="btn btn-ghost btn-sm" onClick={() => navigate('/pricing')} style={{ whiteSpace: 'nowrap' }}>
                          View plans →
                        </button>
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          )}

          {/* ── Crest HR ── */}
          {hrEnabled && (
            <div style={{ marginBottom: 32 }}>
              <button
                type="button"
                aria-expanded={moduleOpen('hr')}
                onClick={() => toggleModule('hr')}
                style={{ ...GS_TOGGLE_STYLE, justifyContent: 'flex-start', gap: 10, marginBottom: 16, paddingBottom: 12, borderBottom: '2px solid color-mix(in srgb, var(--theme-accent) 20%, transparent)' }}
              >
                <span aria-hidden="true" style={{ fontSize: 18, color: 'var(--theme-accent-ink)' }}>👤</span>
                <span style={{ fontSize: 15, fontWeight: 700, color: 'var(--theme-text1)' }}>Crest HR</span>
                <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--theme-green-text)', background: 'color-mix(in srgb, var(--theme-green) 10%, transparent)', border: '1px solid color-mix(in srgb, var(--theme-green) 20%, transparent)', padding: '2px 8px', borderRadius: 0 }}>Active</span>
                <span aria-hidden="true" style={{ marginLeft: 'auto', color: 'var(--theme-text3)', fontSize: 13 }}>{moduleOpen('hr') ? '▲' : '▼'}</span>
              </button>
              {moduleOpen('hr') && helpFeatures && (
                <>
                  <div style={{ marginBottom: 8 }}>
                    <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--theme-text2)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>Human Resources</span>
                  </div>
                  {HR_FEATURES.map(feat => (
                    <FeatureCard key={feat.name} feat={feat} moduleKey="hr" />
                  ))}
                </>
              )}
            </div>
          )}

          {/* ── Crest POS ── */}
          {posEnabled && (
            <div style={{ marginBottom: 32 }}>
              <button
                type="button"
                aria-expanded={moduleOpen('pos')}
                onClick={() => toggleModule('pos')}
                style={{ ...GS_TOGGLE_STYLE, justifyContent: 'flex-start', gap: 10, marginBottom: 16, paddingBottom: 12, borderBottom: '2px solid color-mix(in srgb, var(--theme-accent) 20%, transparent)' }}
              >
                <span aria-hidden="true" style={{ fontSize: 18, color: 'var(--theme-accent-ink)' }}>⊕</span>
                <span style={{ fontSize: 15, fontWeight: 700, color: 'var(--theme-text1)' }}>Crest POS</span>
                <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--theme-green-text)', background: 'color-mix(in srgb, var(--theme-green) 10%, transparent)', border: '1px solid color-mix(in srgb, var(--theme-green) 20%, transparent)', padding: '2px 8px', borderRadius: 0 }}>Active</span>
                <span aria-hidden="true" style={{ marginLeft: 'auto', color: 'var(--theme-text3)', fontSize: 13 }}>{moduleOpen('pos') ? '▲' : '▼'}</span>
              </button>
              {moduleOpen('pos') && helpFeatures && (
                <>
                  <div style={{ marginBottom: 8 }}>
                    <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--theme-text2)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>Point of Sale</span>
                  </div>
                  {POS_FEATURES.map(feat => (
                <FeatureCard key={feat.name} feat={feat} moduleKey="pos" />
                  ))}
                </>
              )}
            </div>
          )}

          {/* ── Crest Suite Pro ── an add-on priced per outlet, not an IMS plan. Every Suite page needs
              Crest IMS, so the block shows wherever IMS does. */}
          {(imsEnabled || isAdmin) && (
            <div style={{ marginBottom: 32 }}>
              <button
                type="button"
                aria-expanded={moduleOpen('suite')}
                onClick={() => toggleModule('suite')}
                style={{ ...GS_TOGGLE_STYLE, justifyContent: 'flex-start', gap: 10, marginBottom: 16, paddingBottom: 12, borderBottom: '2px solid color-mix(in srgb, var(--theme-accent) 20%, transparent)' }}
              >
                <span aria-hidden="true" style={{ fontSize: 18, color: 'var(--theme-accent-ink)' }}>★</span>
                <span style={{ fontSize: 15, fontWeight: 700, color: 'var(--theme-text1)' }}>Crest Suite Pro</span>
                <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--theme-accent-ink)', background: 'color-mix(in srgb, var(--theme-accent) 10%, transparent)', border: '1px solid color-mix(in srgb, var(--theme-accent) 20%, transparent)', padding: '2px 8px', borderRadius: 0 }}>Add-on · per outlet</span>
                <span aria-hidden="true" style={{ marginLeft: 'auto', color: 'var(--theme-text3)', fontSize: 13 }}>{moduleOpen('suite') ? '▲' : '▼'}</span>
              </button>
              {moduleOpen('suite') && helpFeatures && (
                <>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                    <span style={{ fontSize: 10, fontWeight: 700, color: 'var(--theme-accent-ink)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>Owner pages across your modules and outlets</span>
                    {suiteLocked > 0 && (
                      <span className="badge-gray badge-sentence">
                        🔒 {suiteLocked} features locked
                      </span>
                    )}
                  </div>
                  {SUITE_FEATURES.map(feat =>
                    suiteOpen(feat)
                      ? <FeatureCard key={feat.name} feat={feat} moduleKey="suite" />
                      : <LockedRow key={feat.name} feat={feat} note="Add-on" />
                  )}
                  {suiteLocked > 0 && (
                    <div style={{
                      marginTop: 8, padding: '10px 14px',
                      background: colorTint('var(--theme-accent)', 3), border: `1px dashed ${colorTint('var(--theme-accent)', 19)}`,
                      borderRadius: 0, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12
                    }}>
                      <span style={{ fontSize: 12, color: 'var(--theme-text2)' }}>
                        Add <strong style={{ color: 'var(--theme-accent-ink)' }}>Crest Suite Pro</strong> to unlock {suiteLocked} features. It is an add-on priced per outlet, on top of your modules, not an IMS plan upgrade.
                      </span>
                      <button type="button" className="btn btn-ghost btn-sm" onClick={() => navigate('/pricing')} style={{ whiteSpace: 'nowrap' }}>
                        View plans →
                      </button>
                    </div>
                  )}
                </>
              )}
            </div>
          )}

          {/* ── Admin Tools ── */}
          {isAdmin && (
            <div style={{ marginBottom: 32 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16, paddingBottom: 12, borderBottom: '2px solid color-mix(in srgb, var(--theme-red) 20%, transparent)' }}>
                <span style={{ fontSize: 18, color: 'var(--theme-red-text)' }}>⚙</span>
                <span style={{ fontSize: 15, fontWeight: 700, color: 'var(--theme-text1)' }}>Admin Tools</span>
                <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--theme-red-text)', background: 'color-mix(in srgb, var(--theme-red) 10%, transparent)', border: '1px solid color-mix(in srgb, var(--theme-red) 20%, transparent)', padding: '2px 8px', borderRadius: 0 }}>Crest Admin Only</span>
              </div>
              {ADMIN_FEATURES.map(feat => (
                <FeatureCard key={feat.name} feat={feat} moduleKey="admin" />
              ))}
            </div>
          )}

          {/* Neither module active */}
          {!imsEnabled && !hrEnabled && !posEnabled && (
            <div className="card" style={{ textAlign: 'center', padding: '40px 24px', borderColor: 'var(--theme-border)' }}>
              <div style={{ fontSize: 24, marginBottom: 12 }}>⊘</div>
              <div style={{ fontSize: 14, color: 'var(--theme-text2)', marginBottom: 6 }}>No modules are currently active</div>
              <div style={{ fontSize: 12, color: 'var(--theme-text3)' }}>Contact your Crest consultant to activate your subscription.</div>
            </div>
          )}
        </div>
      )}

      {/* GLOSSARY */}
      {activeSection === 'glossary' && (
        <div className="card">
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th style={{ width: '30%' }}>Term</th>
                  <th>Definition</th>
                </tr>
              </thead>
              <tbody>
                {GLOSSARY.map(g => (
                  <tr key={g.term}>
                    <td style={{ fontWeight: 700, color: 'var(--theme-accent-ink)' }}>{g.term}</td>
                    <td style={{ color: 'var(--theme-text2)', lineHeight: 1.6 }}>{g.def}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* PRICING */}
      {activeSection === 'pricing' && (
        <div>
          <div style={{ textAlign: 'center', marginBottom: 28 }}>
            <div style={{ display: 'flex', justifyContent: 'center', gap: 7, marginBottom: 10 }}>
              <span style={{ width: 8, height: 8, borderRadius: 0, background: MODULE_COLORS.ims }} />
              <span style={{ width: 8, height: 8, borderRadius: 0, background: MODULE_COLORS.hr }} />
              <span style={{ width: 8, height: 8, borderRadius: 0, background: MODULE_COLORS.pos }} />
            </div>
            <h2 style={{ fontSize: 24, fontWeight: 800, margin: '0 0 8px', color: 'var(--theme-text1)' }}>Plans & Pricing</h2>
            <p style={{ fontSize: 13, color: 'var(--theme-text2)', margin: '0 0 20px' }}>One system for IMS, HR, and POS — pick a module or bundle them all</p>
            <div style={{ display: 'inline-flex', background: 'var(--theme-bg)', border: '1px solid var(--theme-border)', borderRadius: 0, padding: 3, gap: 2 }}>
              <button onClick={() => setPricingAnnual(false)} style={{ background: !pricingAnnual ? 'color-mix(in srgb, var(--theme-accent) 15%, transparent)' : 'none', border: !pricingAnnual ? '1px solid color-mix(in srgb, var(--theme-accent) 30%, transparent)' : '1px solid transparent', color: !pricingAnnual ? 'var(--theme-accent-ink)' : 'var(--theme-text2)', padding: '6px 18px', borderRadius: 0, cursor: 'pointer', fontSize: 12, fontWeight: 600 }}>Monthly</button>
              <button onClick={() => setPricingAnnual(true)}  style={{ background:  pricingAnnual ? 'color-mix(in srgb, var(--theme-accent) 15%, transparent)' : 'none', border:  pricingAnnual ? '1px solid color-mix(in srgb, var(--theme-accent) 30%, transparent)' : '1px solid transparent', color:  pricingAnnual ? 'var(--theme-accent-ink)' : 'var(--theme-text2)', padding: '6px 18px', borderRadius: 0, cursor: 'pointer', fontSize: 12, fontWeight: 600, display: 'flex', alignItems: 'center', gap: 6 }}>
                Annual <span style={{ background: 'color-mix(in srgb, var(--theme-green) 12%, transparent)', border: '1px solid color-mix(in srgb, var(--theme-green) 25%, transparent)', color: 'var(--theme-green-text)', fontSize: 11, padding: '2px 7px', borderRadius: 0, fontWeight: 700 }}>Save 25%</span>
              </button>
            </div>
          </div>

          {/* Crest IMS — 3 tiers */}
          <p style={{ fontSize: 11, color: MODULE_INK.ims, textTransform: 'uppercase', letterSpacing: '0.08em', fontWeight: 700, marginBottom: 10 }}>Crest IMS</p>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 16, marginBottom: 24 }}>
            {pricing.imsTiers.map(plan => {
              const highlight = plan.key === 'growth'
              const price = pricingAnnual ? plan.annual : plan.monthly
              return (
                <div key={plan.key} className="card" style={{ border: highlight ? `1px solid ${colorTint(MODULE_COLORS.ims, 44)}` : '1px solid var(--theme-border)', position: 'relative', display: 'flex', flexDirection: 'column', padding: '32px 22px 22px', boxShadow: highlight ? `0 4px 32px ${colorTint(MODULE_COLORS.ims, 9)}` : 'none' }}>
                  {highlight && (
                    <div style={{ position: 'absolute', top: -12, left: '50%', transform: 'translateX(-50%)', background: MODULE_COLORS.ims, color: 'var(--theme-accent-text)', fontSize: 11, fontWeight: 800, padding: '3px 12px', borderRadius: 0, letterSpacing: '0.08em', textTransform: 'uppercase', whiteSpace: 'nowrap' }}>
                      Most Popular
                    </div>
                  )}
                  <div style={{ marginBottom: 6, display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                    <span style={{ fontSize: 16, fontWeight: 700, color: MODULE_INK.ims }}>{plan.label}</span>
                    {highlight && (
                      <span style={{ fontSize: 11, fontStyle: 'italic', fontWeight: 800, color: MODULE_INK.ims, background: colorTint(MODULE_COLORS.ims, 8), border: `1px solid ${colorTint(MODULE_COLORS.ims, 25)}`, padding: '2px 6px', borderRadius: 0, letterSpacing: '0.05em' }}>
                        TRIALS RUN HERE
                      </span>
                    )}
                  </div>
                  <div style={{ marginBottom: 16, paddingBottom: 16, borderBottom: '1px solid var(--theme-border)' }}>
                    <div style={{ fontSize: 20, fontWeight: 800, color: 'var(--theme-text1)' }}>NPR {price.toLocaleString('en-IN')}<span style={{ fontSize: 12, fontWeight: 400, color: 'var(--theme-text2)' }}>/month</span></div>
                    {pricingAnnual && <div style={{ fontSize: 11, color: 'var(--theme-text3)', marginTop: 4 }}>Billed annually · NPR {(price * 12).toLocaleString('en-IN')}/year</div>}
                  </div>
                  {plan.includesLabel && (
                    <div style={{ fontSize: 10, color: 'var(--theme-text3)', marginBottom: 10, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase' }}>
                      {plan.includesLabel}
                    </div>
                  )}
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 7, flex: 1 }}>
                    {plan.features.map((f, i) => (
                      <div key={i} style={{ display: 'flex', alignItems: 'flex-start', gap: 7 }}>
                        <span style={{ color: MODULE_INK.ims, fontSize: 12, flexShrink: 0, marginTop: 1 }}>✓</span>
                        <span style={{ fontSize: 12, color: 'var(--theme-text2)', lineHeight: 1.4 }}>{f}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )
            })}
          </div>

          {/* Crest HR + Crest POS + Crest Customization — flat modules */}
          <p style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.08em', fontWeight: 700, marginBottom: 10 }}>
            <span style={{ color: MODULE_INK.hr }}>Crest HR</span>
            <span style={{ color: 'var(--theme-text3)' }}>, </span>
            <span style={{ color: MODULE_INK.pos }}>Crest POS</span>
            <span style={{ color: 'var(--theme-text3)' }}> &amp; </span>
            <span style={{ color: MODULE_INK.customization }}>Crest Customization</span>
          </p>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: 16, marginBottom: 24 }}>
            {[
              { key: 'hr',  name: 'Crest HR',  color: MODULE_INK.hr,  pricing: pricing.hr },
              { key: 'pos', name: 'Crest POS', color: MODULE_INK.pos, pricing: pricing.pos },
              { key: 'customization', name: 'Crest Customization', color: MODULE_INK.customization, pricing: pricing.customization },
            ].map(mod => {
              const price = pricingAnnual ? mod.pricing.annual : mod.pricing.monthly
              return (
                <div key={mod.key} className="card" style={{ display: 'flex', flexDirection: 'column', padding: '32px 22px 22px' }}>
                  <div style={{ marginBottom: 6 }}>
                    <span style={{ fontSize: 16, fontWeight: 700, color: mod.color }}>{mod.name}</span>
                  </div>
                  <div style={{ marginBottom: 16, paddingBottom: 16, borderBottom: '1px solid var(--theme-border)' }}>
                    <div style={{ fontSize: 20, fontWeight: 800, color: 'var(--theme-text1)' }}>NPR {price.toLocaleString('en-IN')}<span style={{ fontSize: 12, fontWeight: 400, color: 'var(--theme-text2)' }}>/month</span></div>
                    {pricingAnnual && <div style={{ fontSize: 11, color: 'var(--theme-text3)', marginTop: 4 }}>Billed annually · NPR {(price * 12).toLocaleString('en-IN')}/year</div>}
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 7, flex: 1 }}>
                    {mod.pricing.features.map((f, i) => (
                      <div key={i} style={{ display: 'flex', alignItems: 'flex-start', gap: 7 }}>
                        <span style={{ color: mod.color, fontSize: 12, flexShrink: 0, marginTop: 1 }}>✓</span>
                        <span style={{ fontSize: 12, color: 'var(--theme-text2)', lineHeight: 1.4 }}>{f}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )
            })}
          </div>

          {/* Crest Suite Pro — an add-on on top of the modules above, not a bundle containing them */}
          <p style={{ fontSize: 11, color: 'var(--theme-accent-ink)', textTransform: 'uppercase', letterSpacing: '0.08em', fontWeight: 700, marginBottom: 10 }}>Crest Suite Pro — the owner layer, added on top</p>
          <div className="card" style={{ marginBottom: 24, borderColor: 'color-mix(in srgb, var(--theme-accent) 20%, transparent)' }}>
            <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap', alignItems: 'flex-start' }}>
              <div style={{ minWidth: 180 }}>
                <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--theme-text1)', marginBottom: 8 }}>{pricing.suite.label}</div>
                <div style={{ fontSize: 20, fontWeight: 800, color: 'var(--theme-text1)' }}>
                  +NPR {(pricingAnnual ? pricing.suite.annual : pricing.suite.monthly).toLocaleString('en-IN')}
                  <span style={{ fontSize: 11, fontWeight: 400, color: 'var(--theme-text2)' }}>/month per outlet</span>
                </div>
                <div style={{ fontSize: 11, color: 'var(--theme-text2)', marginTop: 6 }}>{pricing.suite.requiresLabel}</div>
              </div>
              <ul style={{ margin: 0, paddingLeft: 18, flex: 1, minWidth: 240 }}>
                {pricing.suite.features.map(f => (
                  <li key={f} style={{ fontSize: 12, color: 'var(--theme-text2)', marginBottom: 5, lineHeight: 1.5 }}>{f}</li>
                ))}
              </ul>
            </div>
          </div>

          <div className="card" style={{ borderColor: 'color-mix(in srgb, var(--theme-accent) 20%, transparent)' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 16 }}>
              <div>
                <h3 style={{ margin: '0 0 4px', fontSize: 15, color: 'var(--theme-text1)' }}>Ready to upgrade?</h3>
                <p style={{ margin: 0, fontSize: 13, color: 'var(--theme-text2)' }}>Contact your Crest consultant to change your plan.</p>
              </div>
              <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
                {phone   && <a href={`tel:${phone}`}    style={{ color: 'var(--theme-accent-ink)', fontSize: 13, textDecoration: 'none', display: 'flex', alignItems: 'center', gap: 5 }}>📞 {phone}</a>}
                {email   && <a href={`mailto:${email}`} style={{ color: 'var(--theme-accent-ink)', fontSize: 13, textDecoration: 'none', display: 'flex', alignItems: 'center', gap: 5 }}>✉ {email}</a>}
                {website && <a href={website.startsWith('http') ? website : `https://${website}`} target="_blank" rel="noopener noreferrer" style={{ color: 'var(--theme-accent-ink)', fontSize: 13, textDecoration: 'none', display: 'flex', alignItems: 'center', gap: 5 }}>🌐 {website}</a>}
                {!phone && !email && !website && <span style={{ fontSize: 13, color: 'var(--theme-text3)' }}>Contact your Crest consultant to upgrade.</span>}
                <button onClick={() => navigate('/pricing')} style={{ background: 'color-mix(in srgb, var(--theme-accent) 10%, transparent)', border: '1px solid color-mix(in srgb, var(--theme-accent) 30%, transparent)', color: 'var(--theme-accent-ink)', padding: '8px 16px', borderRadius: 0, cursor: 'pointer', fontSize: 12, fontWeight: 600 }}>
                  View full pricing page →
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* FAQ */}
      {activeSection === 'faq' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {FAQ.map((item, i) => (
            <div key={i} className="card" style={{ padding: 0 }}>
              <button
                type="button"
                aria-expanded={expandedFaq === i}
                aria-controls={`faq-panel-${i}`}
                onClick={() => setExpandedFaq(expandedFaq === i ? null : i)}
                style={{ padding: '16px 20px', display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                         width: '100%', background: 'none', border: 'none', cursor: 'pointer', textAlign: 'left' }}>
                <span style={{ fontSize: 14, fontWeight: 500, color: 'var(--theme-text1)' }}>{item.q}</span>
                <span aria-hidden="true" style={{ color: 'var(--theme-text3)', fontSize: 14 }}>{expandedFaq === i ? '▲' : '▼'}</span>
              </button>
              {expandedFaq === i && (
                <div id={`faq-panel-${i}`} role="region" style={{ padding: '0 20px 16px', borderTop: '1px solid var(--theme-border)' }}>
                  <p style={{ fontSize: 13, color: 'var(--theme-text2)', marginTop: 12, lineHeight: 1.7 }}>{item.a}</p>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Support (S673) */}
      {activeSection === 'support' && (
        <div style={{ maxWidth: 560 }}>
          <div className="card">
            <h2 style={{ margin: '0 0 8px', fontSize: 14, color: 'var(--theme-text2)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>Get in touch</h2>
            <p style={{ fontSize: 13, color: 'var(--theme-text2)', margin: '0 0 20px' }}>
              For anything the guide above doesn't answer — a bug, a question, or your outlet is down.
            </p>
            {/* Hours and the outlet-down promise come from the block itself (S683): both are now
                admin-edited in Settings → Support, so a hardcoded gloss here would drift from them. */}
            <SupportContactLine variant="block" />
          </div>
        </div>
      )}

      {activeSection === 'legal' && (
        <Suspense fallback={<p style={{ fontSize: 13, color: 'var(--theme-text3)' }}>Loading…</p>}>
          <LegalTab />
        </Suspense>
      )}

      </>}
      </div>
    </div>
  )
}
