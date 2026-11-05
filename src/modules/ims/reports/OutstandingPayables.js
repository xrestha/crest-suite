import { Fragment, useEffect, useMemo, useRef, useState } from 'react'
import { useAuth } from '../../../context/AuthContext'
import { useScopedDb } from '../../../shared/hooks/useScopedDb'
import { fetchAllRows, fetchAllRowsChunked, runChunkedByIds } from '../../../shared/fetchAllRows'
import { useLatestRequest } from '../../../shared/hooks/useLatestRequest'
import RowDisclosure from '../../../components/RowDisclosure'
import ReportLoadError from '../../../components/ReportLoadError'
import ActionError, { asActionError } from '../../../components/ActionError'
import FieldError, { fieldAria } from '../../../components/FieldError'
import { invalidStyle } from '../../../shared/inlineFieldState'
import ConfirmModal from '../../../components/ConfirmModal'
import { supabase } from '../../../supabaseClient'
import { BS_MONTHS, adToBsSafe, formatAd } from '../../../utils/bsCalendar'
import { nepalCivilDate } from '../../../shared/nepalTime'
import {
  EPS, SUPPLIER_CREDIT_MODE, isCreditRow, valueBillLines, groupIntoBills, allocatePayment,
  planSupplierLumpSum, supplierCreditSlots, billPaymentProblems, planBillPayment,
  expandCreditPartners, linesToReopen, linesToCloseByReturns, paymentsMovedSince, paymentsMovedText,
  paymentRecordArgs, planWriteOff,
} from './payablesAllocation'
import { isWriteOff, recordedByOf, clearableAmount, WRITE_OFF_MAX_NPR } from './writeOff'
import { billStatus, billBalance, vendorGroups, payablesScopeLine, payablesSheetRows, payablesSheetNotes } from './payablesView'
import { payTermsLabel, parsePayTerms, DEFAULT_PAY_WITHIN_DAYS, MAX_PAY_WITHIN_DAYS } from '../vendors/payTerms'
import { useBizInfo } from '../../../shared/hooks/useBizInfo'
import { useConfirm } from '../../../shared/hooks/useConfirm'
import { sheetWithLetterhead } from '../../../shared/excelLetterhead'
import LetterheadButton from '../../../components/LetterheadButton'
import { printWithTitle } from '../../../utils/printTitle'
import { fmtLineRate } from '../purchases/purchaseLines'
import { unitRateCell } from '../../../shared/unitRate'
import { withTimeout, isTimeout } from '../../../utils/withTimeout'
import { isNetworkError } from '../../../shared/errorText'
import Tip from '../../../components/Tip'
import BsCalendarPicker from '../../../components/BsCalendarPicker'
import Modal from '../../../components/Modal'
import { Navigate } from 'react-router-dom'
import Tabs from '../../../components/Tabs'

// Today in NEPAL, evaluated when it is asked for. This was a module-level
// `new Date().toISOString().split('T')[0]`, which is wrong twice over (S723): `.toISOString()` is
// UTC, so between midnight and 05:45 NPT it returns YESTERDAY — the hours a restaurant actually
// closes its books — and a module constant never changes for the life of the tab, which on an
// installed PWA left open across a service is longer than a day. It is the default `paid_at` on
// every payment recorded here, so a settlement could be dated a day early, and a payment slipping
// across Shrawan 1 lands in the wrong fiscal year on the Vendor Balance Confirmation letter.
// Same helper PosReservations already uses.
const todayIso = () => formatAd(nepalCivilDate(new Date()))

// One column list for both purchase_entries reads — the seed read and the sibling-completion read
// below must return identically shaped rows, or a line pulled in from the other tab is missing
// whatever the seed selected and reads as a blank item on an expanded bill.
const BILL_COLUMNS = 'id, created_at, bs_day, qty, rate, invoice_ref, paid_at, vat_inclusive, discount_amount, purchase_group_id, monthly_periods!inner(client_id, bs_year, bs_month), items(name, uom, categories(name)), vendors(id, name)'

// paid_at is stored as a plain AD `date` column (Postgres has no BS type), but every date shown
// to the user elsewhere in the app is BS — this page's own Payment History/Settled On columns were
// the one place still rendering the raw AD string. Found live (S511): a payment made on 2026-07-24
// displayed as "2026-07-24" here while the exact same paid_at showed correctly as "8 Shrawan 2083"
// on the Vendor Balance Confirmation letter, an inconsistency the user caught only by noticing the
// figures didn't look like the BS dates used everywhere else in the app.
function fmtBsDate(adIso) {
  if (!adIso) return null
  const bs = adToBsSafe(new Date(adIso))
  if (!bs) return `${String(adIso).slice(0, 10)} (AD)`
  return `${bs.day} ${BS_MONTHS[bs.month - 1]} ${bs.year}`
}
// How a Credit bill's settlement was actually paid — distinct from purchase_entries.payment_method
// (Cash/Credit/FonePay), which describes the ORIGINAL purchase, not its later settlement.
// 'Supplier credit' and 'Write-off' (S885) are deliberately absent: each is written only by its own
// action, and the database refuses a change of mode into or out of either.
const PAYMENT_MODES = ['Cash', 'FonePay', 'Bank Transfer', 'Cheque']

const INPUT = {
  background: 'var(--theme-input-bg, var(--theme-card))',
  border: '1px solid var(--theme-border)',
  borderRadius: 'var(--radius-sm)', padding: '7px 10px', fontSize: 13,
  color: 'var(--theme-text1)', outline: 'none',
}

export default function OutstandingPayables() {
  const { clientId, profile, loading: authLoading, hasImsAccess } = useAuth()
  const effectiveClientId = clientId || profile?.client_id
  const { scopedFrom, scopedDelete, scopedUpdate } = useScopedDb()
  const biz = useBizInfo()
  const { ask: askConfirm, confirmEl } = useConfirm()

  const [entries, setEntries]           = useState([])
  const [paymentsMap, setPaymentsMap]   = useState({})
  const [loading, setLoading]           = useState(true)
  const [loadError, setLoadError]       = useState(null)
  const [setupNeeded, setSetupNeeded]   = useState(false)
  const [filterVendor, setFilterVendor] = useState('all')
  const [filterAging, setFilterAging]   = useState('all')
  const [filterPeriod, setFilterPeriod] = useState('all')
  const [activeTab, setActiveTab]       = useState('outstanding')
  const [expandedBill, setExpandedBill] = useState(null)
  const [payForm, setPayForm]           = useState({ amount: '', credit: '', paid_at: todayIso(), note: '', payment_mode: 'Cash' })
  const [savingPayment, setSavingPayment] = useState(false)
  const [payError, setPayError]           = useState(null)
  // The amount box's own message — an overpayment is refused under the box, by name (S756).
  const [payAmountErr, setPayAmountErr]   = useState('')
  // The supplier-credit box's own message, and each vendor's credit read on demand (S756 D11):
  // { [vendorId]: { status: 'loading' | 'ready' | 'error', available, creditBills, slots, error } }.
  // creditGenRef drops a credit read that lands after load() has moved the page on.
  const [payCreditErr, setPayCreditErr]   = useState('')
  const [vendorCredit, setVendorCredit]   = useState({})
  const creditGenRef = useRef(0)

  // One lump sum against one supplier's unpaid bills, oldest first (S756 D9). `lumpVendor` is the
  // vendor NAME the page groups by; null when the dialog is closed.
  const [lumpVendor, setLumpVendor]       = useState(null)
  const [lumpForm, setLumpForm]           = useState({ amount: '', paid_at: todayIso(), note: '', payment_mode: 'Cash' })
  const [lumpAmountErr, setLumpAmountErr] = useState('')
  const [lumpError, setLumpError]         = useState(null)
  const [lumpSaving, setLumpSaving]       = useState(false)
  // The second write of each two-write sequence (stamping/clearing purchase_entries.paid_at after
  // the payment rows have committed) can fail on its own. The payment is real at that point, so
  // this is not a refusal — it names the state the bill is now in. Page-level because load()
  // collapses the expanded row the pay form (and its own error slot) lives in (S682).
  const [settleWarn, setSettleWarn]       = useState(null)
  // The bill being closed because it has nothing left to pay (S792, PURCHASES-8); null otherwise.
  const [closingKey, setClosingKey]       = useState(null)
  const [pendingConfirm, setPendingConfirm] = useState(null)
  const [confirmBusy, setConfirmBusy]     = useState(false)
  const tabReq = useLatestRequest()

  // Bulk "pay several bills at once" — for a monthly credit run across many invoices.
  const [selectedBills, setSelectedBills] = useState(new Set())
  const [bulkForm, setBulkForm]           = useState({ paid_at: todayIso(), note: '', payment_mode: 'Cash' })
  const [bulkSaving, setBulkSaving]       = useState(false)
  const [bulkError, setBulkError]         = useState('')

  // Bulk "select several payment-history rows and delete them at once" — one-by-one deletion
  // (each a click + native confirm dialog round trip) is slow when correcting a batch of
  // mis-entered payments, same reasoning as bulk-pay above.
  const [selectedPayments, setSelectedPayments] = useState(new Set())

  // Per-vendor payment terms — quick-editable right from this page's vendor group header instead of
  // only via the Vendors page: `{ [vendorId]: { payment_terms, pay_within_days } }`. Since S885
  // pay_within_days decides which bills are overdue (owner decision 2: NULL = the 60-day default,
  // 0 = due on delivery); payment_terms stays a free-text note. A failed read of it is a failed
  // page now, never every supplier silently on the default (load()).
  const [vendorTerms, setVendorTerms]         = useState({})
  const [editingTermsVendor, setEditingTermsVendor] = useState(null)
  const [termsForm, setTermsForm]             = useState({ days: '', note: '' })
  const [termsDaysErr, setTermsDaysErr]       = useState('')
  const [termsSaving, setTermsSaving]         = useState(false)
  const [termsError, setTermsError]           = useState('')

  // Bulk-edit a note across selected Payment History rows (Paid History tab) — see
  // openEditNote()/saveNoteForSelected() below for why this only overwrites checked rows.
  const [editingNotePayments, setEditingNotePayments] = useState(null)
  const [noteForm, setNoteForm]     = useState('')
  const [noteSaving, setNoteSaving] = useState(false)
  const [noteError, setNoteError]   = useState('')

  // Same pattern as the note bulk-edit above, for payment_mode — mainly for tagging historical
  // payments recorded before this column existed, so past bills can also show a real Payment Mode
  // on the Vendor Balance Confirmation letter instead of a blank one.
  const [editingModePayments, setEditingModePayments] = useState(null)
  const [modeForm, setModeForm]     = useState(PAYMENT_MODES[0])
  const [modeSaving, setModeSaving] = useState(false)
  const [modeError, setModeError]   = useState('')

  useEffect(() => { if (!authLoading && effectiveClientId) load(activeTab) }, [effectiveClientId]) // eslint-disable-line

  async function load(tab = activeTab) {
    tabReq.begin(tab)
    setLoading(true)
    setLoadError(null)
    setFilterVendor('all')
    setFilterAging('all')
    setFilterPeriod('all')
    setExpandedBill(null)
    setSelectedBills(new Set())
    setBulkForm(f => ({ ...f, paid_at: todayIso() }))
    // Every reload follows a write that can move a supplier's credit, so the cached reads go.
    creditGenRef.current += 1
    setVendorCredit({})

    // A factory, not a single builder: fetchAllRows needs a fresh query per page (a supabase-js
    // builder is a one-shot thenable). This read is unbounded by period — it spans every credit
    // bill this client has ever recorded — so it is the single most likely place in the app to
    // cross PostgREST's silent 1000-row cap, and it gets likelier the longer the system is used.
    // A truncated read here would hide genuinely outstanding bills from the payables list (S529).
    const buildQuery = () => {
      let q = supabase
        .from('purchase_entries')
        .select(BILL_COLUMNS)
        .eq('monthly_periods.client_id', effectiveClientId)
        .eq('payment_method', 'Credit')

      if (tab === 'outstanding') {
        q = q.is('paid_at', null).order('created_at', { ascending: true })
      } else {
        q = q.not('paid_at', 'is', null).order('paid_at', { ascending: false })
      }
      // Unique tiebreaker — created_at/paid_at are not unique, and paging a non-unique sort can
      // repeat a bill on one page and skip another on the next.
      return q.order('id')
    }

    const { data: seed, error } = await fetchAllRows(buildQuery)
    if (!tabReq.isCurrent(tab)) return

    if (error) {
      // 42703 is the real "migration not applied yet" setup state; anything else is a failed read
      // and must say so — an empty payables list is a claim that nothing is owed (S612).
      if (error.code === '42703' || error.message?.includes('paid_at')) setSetupNeeded(true)
      else { setLoadError(error); setEntries([]); setPaymentsMap({}) }
      setLoading(false)
      return
    }

    // ── Complete every bill the tab filter cut in half (S723) ──────────────────────────────────
    //
    // `paid_at` is stamped PER LINE, and allocatePayment settles a bill's lines oldest-first — so
    // a partial payment on a multi-line bill stamps some lines and not others, and the tab filter
    // above then returns half a bill to each tab. That is not merely a display split: the bill's
    // grand total is recomputed below from whichever lines arrived, and `calcBillTotals` is not
    // linear in the BILL-LEVEL discount, so each half re-applies the whole discount to itself.
    // Measured: a 2-line VAT-inclusive bill of 2,034 carrying a 200 discount, part-paid 1,017,
    // showed Bill Total 904 / Remaining 904 on Outstanding — 113 short of what is actually owed —
    // with the Paid column empty and the payment missing from that bill's history, while the same
    // bill sat in Paid History at 904 as a settled one.
    //
    // So the tab filter now only SELECTS which bills to show; the figures are always computed over
    // the whole bill. This second read is bounded by the tab's own bill count rather than by the
    // client's history, which is why it is a group-id refetch rather than dropping the filter.
    const groupIds = [...new Set((seed || []).map(e => e.purchase_group_id).filter(Boolean))]
    const { data: siblings, error: sibErr } = await fetchAllRowsChunked(groupIds, gids => supabase
      .from('purchase_entries')
      .select(BILL_COLUMNS)
      .eq('monthly_periods.client_id', effectiveClientId)
      .eq('payment_method', 'Credit')
      .in('purchase_group_id', gids)
      .order('id'))
    if (!tabReq.isCurrent(tab)) return
    if (sibErr) { setLoadError(sibErr); setEntries([]); setPaymentsMap({}); setLoading(false); return }

    // Rows written before purchase_group_id existed carry NULL and cannot be refetched by group;
    // they are their own bill under billKeyOf's fallback, so the seed row IS the whole bill.
    const byId = new Map()
    ;(siblings || []).forEach(e => byId.set(e.id, e))
    ;(seed || []).forEach(e => { if (!byId.has(e.id)) byId.set(e.id, e) })
    const data = [...byId.values()]

    const vendorIds = [...new Set(data.map(e => e.vendors?.id).filter(Boolean))]
    const today = new Date()
    const ids = data.map(e => e.id)

    // The three follow-up reads all derive their filter from the bills read above (a genuine
    // dependency) but are mutually independent — awaiting them one by one cost three serial round
    // trips on every load, and this page reloads after every recorded payment.
    const [vtRes, pmtRes, retRes] = await Promise.all([
      vendorIds.length > 0
        ? supabase.from('vendors').select('id, payment_terms, pay_within_days').in('id', vendorIds)
        : Promise.resolve({ data: null, error: null }),
      // Paged and chunked (S723). The bills read above is carefully paged, with a comment saying
      // this page is the likeliest in the app to cross PostgREST's silent 1000-row cap — and the
      // two reads that hang off it were bare. payable_payments holds one row per LINE per
      // settlement, so it grows faster than the bills do; a truncated payments read renders paid
      // bills as unpaid and inflates Total Remaining, and a truncated returns read overstates what
      // is owed on every returned bill. Neither returns an error, so no guard here would fire. The
      // id list also rides in the URL, and on the Paid History tab it is every settled credit line
      // this client has ever recorded (S629).
      fetchAllRowsChunked(ids, chunk => scopedFrom('payable_payments')
        .in('purchase_entry_id', chunk).order('paid_at', { ascending: true }).order('id')),
      fetchAllRowsChunked(ids, chunk => scopedFrom('vendor_returns', 'purchase_entry_id, qty, rate')
        .in('purchase_entry_id', chunk).order('id')),
    ])
    if (!tabReq.isCurrent(tab)) return

    // S885: a supplier's payment days decide which bills are overdue, so this read now fails the
    // page like the two beside it. It used to be skipped quietly (only a missing payment_terms
    // column was named), which today would put every supplier on the 60-day default with nothing
    // to say so.
    if (vtRes.error) { setLoadError(vtRes.error); setEntries([]); setPaymentsMap({}); setLoading(false); return }
    const termsMap = {}
    ;(vtRes.data || []).forEach(v => { termsMap[v.id] = { payment_terms: v.payment_terms, pay_within_days: v.pay_within_days } })
    setVendorTerms(termsMap)

    // A failed payments read would render every credit bill as fully unpaid (S612).
    if (pmtRes.error) { setLoadError(pmtRes.error); setEntries([]); setPaymentsMap({}); setLoading(false); return }
    let pmtMap = {}
    ;(pmtRes.data || []).forEach(p => {
      if (!pmtMap[p.purchase_entry_id]) pmtMap[p.purchase_entry_id] = []
      pmtMap[p.purchase_entry_id].push(p)
    })
    setPaymentsMap(pmtMap)

    // Goods sent back reduce what's owed. ReturnsTab always writes purchase_entry_id (it refuses
    // to save without one) and copies the linked purchase's payment_method, so a return against a
    // Credit bill is always attributable to the exact line it cancels — no allocation guesswork.
    // A failed returns read would overstate what's owed on every returned bill (S612).
    if (retRes.error) { setLoadError(retRes.error); setEntries([]); setPaymentsMap({}); setLoading(false); return }
    let returnedByEntry = {}
    ;(retRes.data || []).forEach(r => {
      returnedByEntry[r.purchase_entry_id] =
        (returnedByEntry[r.purchase_entry_id] || 0) + parseFloat(r.qty || 0) * parseFloat(r.rate || 0)
    })

    // The valuation itself — returns netted per line, the one bill discount, VAT, the grand total
    // spread back across lines to the paisa, a negative remaining kept as a credit — lives in
    // payablesAllocation.js (S756 stage 3) so the supplier-credit lookup values a bill with the same
    // arithmetic as this table. Its comments carry the S510/S723/S747 history that used to sit here.
    // `returnedByEntry` is at LIST rate on purpose: since S792 (owner decision D33) the helper
    // credits each return at its bill's discounted price, so the discount is applied once, there.
    const enriched = valueBillLines(data || [], pmtMap, returnedByEntry, today)
    const byBill = {}
    enriched.forEach(e => { (byBill[e.billKey] = byBill[e.billKey] || []).push(e) })

    // Which TAB a bill belongs to is a property of the whole bill, not of a line: it is
    // outstanding while any line of it is still unsettled. Keyed on `paid_at` rather than on
    // `remaining > EPS` on purpose — a bill settled before payable_payments existed carries the
    // stamp and no payment rows, so a remaining-based test would drag every one of those back into
    // Outstanding as a full balance owed.
    const visible = Object.values(byBill)
      .filter(lines => (tab === 'outstanding') === lines.some(l => !l.paid_at))
      .flat()

    setEntries(visible)
    setLoading(false)
  }

  function switchTab(tab) { setActiveTab(tab); load(tab) }

  function toggleBill(key, bill) {
    const opening = expandedBill !== key
    setExpandedBill(prev => prev === key ? null : key)
    setPayForm({ amount: '', credit: '', paid_at: todayIso(), note: '', payment_mode: 'Cash' })
    setPayError('')
    setPayAmountErr('')
    setPayCreditErr('')
    // Only an unpaid bill can take supplier credit, and only its own supplier's (S756 D11).
    if (opening && activeTab === 'outstanding' && bill && bill.remaining > EPS && bill.vendorId && !vendorCredit[bill.vendorId]) {
      loadVendorCredit(bill.vendorId)
    }
  }

  // allocatePayment — one payment spread across a bill's lines with running-cumulative rounding
  // (S505) — lives in payablesAllocation.js now, beside the lump-sum and supplier-credit planners
  // that build on it, so the three cannot drift apart on the paisa.

  // ── Supplier credit available to one vendor (S756 D11) ─────────────────────────────────────────
  //
  // A credit usually sits on a bill that was SETTLED and then had goods returned, so it lives on
  // the Paid History tab and is not in `entries` while the reader is on Outstanding. It is read on
  // demand, per vendor, over that vendor's WHOLE credit-bill history — complete bills, valued by the
  // same valueBillLines/groupIntoBills the table uses, so the credit offered here is exactly the
  // "cr" figure the other tab shows. Paged and chunked for the same reasons load() is (S723).
  async function loadVendorCredit(vendorId) {
    if (!vendorId || !effectiveClientId) return
    const gen = creditGenRef.current
    setVendorCredit(m => ({ ...m, [vendorId]: { status: 'loading' } }))
    const fail = error => {
      if (gen !== creditGenRef.current) return
      setVendorCredit(m => ({ ...m, [vendorId]: { status: 'error', error } }))
    }

    const { data: rows, error } = await fetchAllRows(() => supabase
      .from('purchase_entries')
      .select(BILL_COLUMNS)
      .eq('monthly_periods.client_id', effectiveClientId)
      .eq('payment_method', 'Credit')
      .eq('vendor_id', vendorId)
      .order('id'))
    if (gen !== creditGenRef.current) return
    if (error) { fail(error); return }

    const ids = (rows || []).map(e => e.id)
    const [pmtRes, retRes] = await Promise.all([
      fetchAllRowsChunked(ids, chunk => scopedFrom('payable_payments')
        .in('purchase_entry_id', chunk).order('paid_at', { ascending: true }).order('id')),
      fetchAllRowsChunked(ids, chunk => scopedFrom('vendor_returns', 'purchase_entry_id, qty, rate')
        .in('purchase_entry_id', chunk).order('id')),
    ])
    if (gen !== creditGenRef.current) return
    // A failed read is not "no credit": the box stays hidden and the reason is named.
    if (pmtRes.error || retRes.error) { fail(pmtRes.error || retRes.error); return }

    const pmtMap = {}
    ;(pmtRes.data || []).forEach(p => { (pmtMap[p.purchase_entry_id] = pmtMap[p.purchase_entry_id] || []).push(p) })
    const retMap = {}
    ;(retRes.data || []).forEach(r => {
      retMap[r.purchase_entry_id] = (retMap[r.purchase_entry_id] || 0) + parseFloat(r.qty || 0) * parseFloat(r.rate || 0)
    })
    const vendorBills = groupIntoBills(valueBillLines(rows || [], pmtMap, retMap), pmtMap)
    const { available, bills: creditBills, slots } = supplierCreditSlots(vendorBills)
    setVendorCredit(m => ({ ...m, [vendorId]: { status: 'ready', available, creditBills, slots } }))
  }

  // S877: ONE server step records a payment (`record_payable_payments`). It locks every line of the
  // bills the payment touches, refuses (HINT payables_moved) when a payment on them is no longer one
  // this page loaded, then writes the rows and the paid_at stamps in one transaction. Two screens
  // paying one bill in the same second used to both land, because the re-read below and the insert
  // were two requests; and a payment could land on a bill whose stamp then failed. paymentsMovedCheck
  // still runs first, because it words the refusal bill by bill; the server is what makes it true.
  // Every row goes in one statement, so both halves of a supplier-credit pair commit together and the
  // database's end-of-transaction pair check (20260918120000) sees both.
  //
  // Returns null when the payment landed, else { text, detail } for the caller's slot. A refusal the
  // server raised rolled the whole transaction back, so it may say nothing was recorded; no answer
  // (a timeout or a dropped connection) proves nothing either way (S619), so it says to reload first.
  // `writeOff` words the two general failures for clearing a leftover (S885), which is not a payment.
  async function recordPayments(bills, rows, settleIds, date, paying, { writeOff = false } = {}) {
    let res
    try {
      res = await withTimeout(supabase.rpc('record_payable_payments',
        paymentRecordArgs(effectiveClientId, bills, rows, settleIds, date)), 30000, 'Recording the payment')
    } catch (err) {
      res = { error: err }
    }
    const err = res?.error
    if (!err) return null
    const many = bills.length !== 1
    if (err.hint === 'payables_moved') {
      const moved = await paymentsMovedCheck(bills, paying)
      return moved || {
        text: `Nothing was recorded. A payment on ${many ? 'these bills' : 'this bill'} was recorded or removed on another screen a moment ago. Reload the page to see what is owed now, then enter the payment again.`,
        detail: 'record_payable_payments · payables_moved',
      }
    }
    const { text, detail } = asActionError(err)
    if (err.hint === 'payables_settle_short' || err.hint === 'payables_lines_unreadable') {
      return { text: `Nothing was recorded. Crest could not mark every line of ${many ? 'these bills' : 'this bill'} as paid, and this login may not be allowed to change some of them. ${text}`, detail }
    }
    if (isTimeout(err) || isNetworkError(err) || !err.code) {
      if (writeOff) return { text: `Crest could not confirm the leftover was cleared. Reload the page before trying again: if it reached the server before the connection dropped, the bill already shows under Paid History. ${text}`, detail }
      return { text: `The payment could not be confirmed as saved. Reload the page before trying again: if it reached the server before the connection dropped, it already shows against ${many ? 'these bills' : 'the bill'}, and saving again would record it twice. ${text}`, detail }
    }
    if (writeOff) return { text: `The leftover was not cleared, so this bill still shows what it owed before. ${text}`, detail }
    return { text: `The payment was not recorded, so ${many ? 'these bills still show' : 'this bill still shows'} what was owed before. ${text}`, detail }
  }

  // The second write of every pay/unpay sequence: stamp or clear purchase_entries.paid_at on the
  // lines just settled or reopened. Returns null when every line was written, else the { text,
  // detail } of what went wrong, for the caller to fold into a sentence naming the bill's state.
  //
  // `.select('id')` is the point (S756). An UPDATE a policy filters down to fewer rows — or to
  // none — returns `error: null`, so a bill whose payment landed and whose stamp did not read as
  // settled here and stayed under Outstanding after the reload, with nothing to say why. PostgREST
  // returns the rows it actually changed, so a short count is proof and may be named. A refusal
  // raised by the database (the S756 `ims_rank` / `period_closed` guards) arrives as `error` and
  // is worded by asActionError. paid_at-only updates pass the closed-month guard by design.
  //
  // Chunked (S756 stage 3): a bulk or lump-sum payment can settle hundreds of lines and the id list
  // rides in the URL. Chunks run in turn and are not atomic, which every caller's wording allows for
  // — they name the state the bills are in, never claim nothing was stamped.
  async function writePaidAt(ids, paidAt) {
    const want = new Set(ids).size
    let n = 0
    const { error } = await runChunkedByIds(ids, async chunk => {
      const res = await supabase.from('purchase_entries').update({ paid_at: paidAt }).in('id', chunk).select('id')
      n += res.data?.length || 0
      return res
    })
    if (error) return asActionError(error)
    if (n < want) {
      return {
        text: `Only ${n} of the ${want} bill line${want === 1 ? '' : 's'} could be updated; this login may not be allowed to change the rest.`,
        detail: `purchase_entries paid_at update matched ${n} of ${want} rows`,
      }
    }
    return null
  }

  // What is recorded against these bills, re-read just before a payment is written (S792,
  // PURCHASES-10). There is no server-side guard against paying a bill twice, so two managers — or
  // one lump sum typed on a page opened before someone else paid — both landed and the bill read as
  // a Credit. Returns null when nothing moved, else the { text, detail } that stops the write; the
  // rules are paymentsMovedSince's. A check that could not run has not passed (S613): a failed or
  // timed-out read refuses the payment and says so rather than waving it through.
  async function paymentsMovedCheck(bills, paying) {
    const ids = [...new Set(bills.flatMap(b => (b.entries || []).map(e => e.id)))]
    let res
    try {
      res = await withTimeout(fetchAllRowsChunked(ids, chunk => scopedFrom('payable_payments', 'id, purchase_entry_id, amount')
        .in('purchase_entry_id', chunk).order('id')), 20000, 'Payment check')
    } catch (err) {
      res = { error: err }
    }
    if (res.error) {
      const { text, detail } = asActionError(res.error)
      return { text: `Nothing was recorded. Crest re-checks what is already paid on ${bills.length === 1 ? 'the bill' : 'these bills'} just before it records a payment, and that check could not run. ${text}`, detail }
    }
    const stops = paymentsMovedSince(bills, res.data || [], paying)
    return stops.length > 0 ? { text: paymentsMovedText(stops, fmt2) } : null
  }

  // One payment for a whole bill — distributed across its unpaid line items (oldest first) — made
  // of money, supplier credit, or both (S756 D11).
  async function payBill(bill) {
    if (!effectiveClientId) { setPayError('No client selected. Pick a client in the top-left switcher before saving.'); return }
    const credit = vendorCredit[bill.vendorId]
    const available = credit?.status === 'ready' ? credit.available : 0
    // An overpayment is REFUSED, never quietly shrunk (S756). This was `Math.min(amount,
    // bill.remaining)`: typing 5,000 against a 4,200 balance recorded 4,200 and said nothing, so
    // the payment history disagreed with the cheque the reader was holding. The half-paisa
    // tolerance inside billPaymentProblems is not a rupee — `remaining` is a sum of per-line 2dp
    // figures and can carry float noise below "Pay in full"'s .toFixed(2), and only that noise is
    // absorbed by planBillPayment's cap (the S510 stuck-settlement layer: the payment must reach,
    // not fall a hair short of, the unrounded balance). Credit gets the same refusal: never more
    // than the supplier has, never more than this bill still owes.
    const problems = billPaymentProblems({ cash: payForm.amount, credit: payForm.credit, remaining: bill.remaining, available, fmt: fmt2 })
    setPayAmountErr(problems.cash)
    setPayCreditErr(problems.credit)
    if (problems.cash || problems.credit) return
    const cash = Number(payForm.amount) || 0
    const creditAmt = Number(payForm.credit) || 0
    if (cash <= 0 && creditAmt <= 0) return

    setSavingPayment(true)
    setPayError('')
    setSettleWarn(null)
    const date = payForm.paid_at || todayIso()
    const note = payForm.note || null

    const { rows, settleIds, creditPairs } = planBillPayment(bill, {
      cash, credit: creditAmt, date, note, paymentMode: payForm.payment_mode,
      creditSlots: creditAmt > 0 ? (credit?.slots || []) : [],
    })
    if (rows.length === 0) { setSavingPayment(false); return }

    // Fresh read first (S792, PURCHASES-10): this bill, and every bill a supplier credit is being
    // taken from — the same credit used twice from two screens is the credit version of paying twice.
    const sources = [...new Map(creditPairs.map(p => [p.fromBill.key, p.fromBill])).values()]
    const moved = await paymentsMovedCheck([bill, ...sources], { [bill.key]: cash + creditAmt })
    if (moved) { setPayError(moved); setSavingPayment(false); return }

    const fail = await recordPayments([bill, ...sources], rows, settleIds, date, { [bill.key]: cash + creditAmt })
    if (fail) { setPayError(fail); setSavingPayment(false); return }
    setSavingPayment(false)
    load(activeTab)
  }

  // S792 (PURCHASES-8). A Credit bill with nothing left to pay — every item on it went back, or a
  // return left the supplier owing US — can take no payment, and only a payment ever stamped
  // `paid_at`, so it sat on this tab for ever under a red "90+ days" chip with no control that could
  // close it. Closing stamps its unstamped lines with today's date (Nepal), which moves it to Paid
  // History; a credit on it stays usable from there, since the supplier-credit read covers every
  // bill the supplier has. Offered only when nothing is owed (linesToCloseByReturns), so it cannot
  // close a bill that still has money on it.
  async function closeSettledByReturns(bill) {
    const ids = linesToCloseByReturns(bill)
    if (ids.length === 0 || closingKey) return
    setClosingKey(bill.key)
    setSettleWarn(null)
    const fail = await writePaidAt(ids, todayIso())
    setClosingKey(null)
    if (fail) {
      // Chunks are not atomic, so name where the bill may be rather than claiming nothing changed.
      setSettleWarn({ ...fail, text: `Bill #${bill.invoice_ref || '—'} could not be fully closed. It may still show under Outstanding with nothing to pay; reload the page and close it again if it is still listed. ${fail.text}` })
    }
    load(activeTab)
  }

  // ── S885 (owner decision 3): clear a leftover of NPR 10 or less without paying it ─────────────
  //
  // The page is manager-gated, so this is the Owner or an IMS manager. The amount is spread over the
  // bill's open lines exactly as "Pay in full" spreads a payment (planWriteOff → allocatePayment) and
  // recorded by the same server step, so the bill settles and moves to Paid History. The rows carry
  // payment_mode 'Write-off': the balance letter and Vendor Report show them as written off, never
  // as money paid, and they never become supplier credit. The NPR 10 cap is per bill and the server
  // holds it too (write_off_over_cap); the button is offered only inside it (clearableAmount).
  function askClearLeftover(bill) {
    const amount = clearableAmount(bill)
    if (amount == null) return
    setPayError('')
    askConfirm({
      title: `Clear ${fmt2(amount)} without paying`,
      confirmLabel: `Clear ${fmt2(amount)}`,
      busyLabel: 'Clearing…',
      body: (
        <>
          <p style={{ margin: '0 0 8px' }}>
            Bill #{bill.invoice_ref || '—'} from {bill.vendorName} has <strong>{fmt2(amount)}</strong> left to pay. Clearing it records {fmt2(amount)} as written off, dated today, and the bill moves to Paid History.
          </p>
          <p style={{ margin: 0 }}>
            This is not money paid. It shows as written off on the balance letter and in Vendor Report, it can never be changed into a payment, and it is never counted as supplier credit. To undo it, delete the written off entry from the payment history of the bill.
          </p>
        </>
      ),
      run: () => clearLeftover(bill),
    })
  }

  async function clearLeftover(bill) {
    if (!effectiveClientId) { setPayError('No client selected. Pick a client in the top-left switcher before saving.'); return }
    const date = todayIso()
    const plan = planWriteOff(bill, date)
    if (!plan) {
      setPayError(`Only a leftover of ${fmt2(WRITE_OFF_MAX_NPR)} or less on a bill can be cleared, so this bill was not changed.`)
      return
    }
    setSettleWarn(null)
    const paying = { [bill.key]: plan.amount }
    // The same fresh read and the same server step every payment takes (S792, S877).
    const moved = await paymentsMovedCheck([bill], paying)
    if (moved) { setPayError(moved); return }
    const fail = await recordPayments([bill], plan.rows, plan.settleIds, date, paying, { writeOff: true })
    if (fail) { setPayError(fail); return }
    load(activeTab)
  }

  // ── D9: one lump sum for a supplier, oldest bill first ─────────────────────────────────────────
  //
  // A manager paying a supplier "40,000 against what we owe" used to have to work out by hand which
  // bills that covered and type each one in. planSupplierLumpSum does that split with the same
  // per-line allocation a single bill uses, and the modal shows it before anything is written.
  function openLumpSum(vName) {
    setLumpVendor(vName)
    setLumpForm({ amount: '', paid_at: todayIso(), note: '', payment_mode: 'Cash' })
    setLumpAmountErr('')
    setLumpError('')
  }

  async function saveLumpSum(plan) {
    if (!effectiveClientId) { setLumpError('No client selected. Pick a client in the top-left switcher before saving.'); return }
    if (plan.error === 'over') {
      setLumpAmountErr(`${lumpVendor} is owed ${fmt2(plan.total)} across these bills. Enter that or less — if you paid them more, record ${fmt2(plan.total)} here and the rest against their next bill.`)
      return
    }
    if (plan.error || plan.rows.length === 0) { setLumpAmountErr('Enter the amount you paid this supplier.'); return }
    setLumpSaving(true)
    setLumpError('')
    setSettleWarn(null)
    const date = lumpForm.paid_at || todayIso()

    // Every bill this sum reaches, re-read before anything is written (S792, PURCHASES-10). The
    // oldest-first split was planned from what this page loaded; if another screen has paid one of
    // those bills since, this sum would land on it again.
    const reached = plan.split.filter(s => s.pay > 0)
    const moved = await paymentsMovedCheck(reached.map(s => s.bill), Object.fromEntries(reached.map(s => [s.bill.key, s.pay])))
    if (moved) { setLumpError(moved); setLumpSaving(false); return }

    const fail = await recordPayments(reached.map(s => s.bill), plan.rows, plan.settleIds, date,
      Object.fromEntries(reached.map(s => [s.bill.key, s.pay])))
    if (fail) { setLumpError(fail); setLumpSaving(false); return }
    setLumpSaving(false)
    setLumpVendor(null)
    load(activeTab)
  }

  function openEditTerms(vendor) {
    const t = vendorTerms[vendor.id] || {}
    setEditingTermsVendor(vendor)
    setTermsForm({ days: Number.isInteger(t.pay_within_days) ? String(t.pay_within_days) : '', note: t.payment_terms || '' })
    setTermsDaysErr('')
    setTermsError('')
  }

  // S885: the number of days decides what is overdue; the note is kept as it was. Blank days is the
  // 60-day default (NULL), 0 is due on delivery. Writing vendors needs IMS supervisor or above, so
  // this manager-gated page always may; the database still decides.
  async function saveTerms() {
    if (!editingTermsVendor) return
    const raw = String(termsForm.days ?? '').trim()
    let days = null
    if (raw !== '') {
      const n = Number(raw)
      if (!Number.isInteger(n) || n < 0 || n > MAX_PAY_WITHIN_DAYS) {
        setTermsDaysErr(`Enter a whole number of days from 0 to ${MAX_PAY_WITHIN_DAYS}, or leave it blank for ${DEFAULT_PAY_WITHIN_DAYS} days.`)
        return
      }
      days = n
    }
    setTermsDaysErr('')
    setTermsSaving(true)
    setTermsError('')
    const note = String(termsForm.note ?? '').trim() || null
    // `.select('id')` (S756): zero rows back with no error is a save that did not land.
    let res
    try {
      res = await withTimeout(scopedUpdate('vendors', { payment_terms: note, pay_within_days: days }).eq('id', editingTermsVendor.id).select('id'), 20000, 'Saving payment terms')
    } catch (err) {
      res = { error: err }
    }
    setTermsSaving(false)
    if (res.error) {
      const { text, detail } = asActionError(res.error)
      setTermsError({ text: `${editingTermsVendor.name} may still show its previous payment terms. ${text}`, detail })
      return
    }
    if (!res.data?.length) {
      setTermsError(`The payment terms were not saved, so ${editingTermsVendor.name} still shows its previous terms. This login may not be allowed to change suppliers; ask your manager or the Owner.`)
      return
    }
    setVendorTerms(prev => ({ ...prev, [editingTermsVendor.id]: { payment_terms: note, pay_within_days: days } }))
    setEditingTermsVendor(null)
  }

  function toggleSelectPayment(id) {
    setSelectedPayments(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id); else next.add(id)
      return next
    })
  }

  function toggleSelectPayments(ids) {
    setSelectedPayments(prev => {
      const allSelected = ids.every(id => prev.has(id))
      const next = new Set(prev)
      ids.forEach(id => allSelected ? next.delete(id) : next.add(id))
      return next
    })
  }

  // Removes whichever payment rows are checked — the only delete path now (the old per-row
  // "Delete" button was dropped once bulk-select could already handle a single row via the same
  // one confirm dialog + one DELETE call this uses, so keeping both was pure duplication).
  // Previously there was no way to correct a mis-entered payment anywhere in the app at all.
  // Found live: a vendor's payment history contained the bill's raw pre-discount/pre-VAT line
  // amounts instead of what was actually paid, inflating the bill's paid total well past its real
  // value with no way to fix it short of writing SQL by hand.
  function deleteSelectedPayments(bill) {
    const toDelete = bill.payments.filter(p => selectedPayments.has(p.id))
    if (toDelete.length === 0) return
    const total = toDelete.reduce((s, p) => s + parseFloat(p.amount), 0)
    const n = toDelete.length
    // A supplier-credit entry is half of a pair; its other half sits on another bill, often one not
    // on screen. Deleting one without the other leaves money on one bill that came from nowhere, so
    // the pair goes together and the dialog says so (S756 D11). The database refuses a lone half.
    const { ids, linkIds } = expandCreditPartners(toDelete)
    const creditRows = toDelete.filter(isCreditRow)
    // A cleared leftover (S885) is not a payment: deleting one puts that amount back on the bill.
    const writeOffRows = toDelete.filter(isWriteOff)
    const writeOffTotal = writeOffRows.reduce((s, p) => s + parseFloat(p.amount), 0)
    setPendingConfirm({
      title: `Delete ${n} payment${n === 1 ? '' : 's'}`,
      confirmLabel: 'Delete',
      danger: true,
      body: (
        <>
          <p style={{ margin: '0 0 8px' }}>
            Removes {n} payment{n === 1 ? '' : 's'} totaling <strong>{fmt(total)}</strong> from the history of bill #{bill.invoice_ref || '—'} ({bill.vendorName}).
          </p>
          {writeOffRows.length > 0 && (
            <p style={{ margin: '0 0 8px' }}>
              {writeOffRows.length === 1 ? 'One of these is' : `${writeOffRows.length} of these are`} a leftover cleared without paying (written off), not money paid. Deleting {writeOffRows.length === 1 ? 'it' : 'them'} puts {fmt2(writeOffTotal)} back on the bill as owed.
            </p>
          )}
          {creditRows.length > 0 && (
            <p style={{ margin: '0 0 8px' }}>
              {creditRows.length === 1 ? 'One of these is' : `${creditRows.length} of these are`} supplier credit. Each also removes its matching entry on the other bill ({creditRows.map(p => p.note).filter(Boolean).join('; ')}), so the credit goes back to the bill it came from and the bill it was used on owes that amount again.
            </p>
          )}
          <p style={{ margin: 0 }}>
            {total >= 0
              ? `The bill's paid total drops by that amount${activeTab === 'paid' ? ' and it returns to Outstanding' : ''}.`
              : 'The credit goes back onto this bill.'} This cannot be undone.
          </p>
        </>
      ),
      run: async () => {
        setSettleWarn(null)
        // `.select(...)` (S756). payable_payments writes below IMS manager are refused by the
        // database since S756, and a policy that FILTERS a delete rather than raising returns
        // `error: null` with nothing removed — which went on to clear paid_at and reload, so the
        // payments "came back" with no explanation. Only what was actually removed is acted on.
        // One statement for the rows and their credit partners, so a pair cannot be split by a
        // failure between two requests.
        let del = scopedDelete('payable_payments')
        del = linkIds.length > 0
          ? del.or(`id.in.(${ids.join(',')}),credit_link_id.in.(${linkIds.join(',')})`)
          : del.in('id', ids)
        const { data: removedRows, error } = await del.select('id, purchase_entry_id, amount')
        if (error) {
          const { text, detail } = asActionError(error)
          setPayError({ text: `${n === 1 ? 'That payment is' : 'Those payments are'} still recorded against this bill — nothing was removed. ${text}`, detail })
          return
        }
        const removedIds = new Set((removedRows || []).map(r => r.id))
        if (removedIds.size === 0) {
          setPayError(`${n === 1 ? 'That payment is' : 'Those payments are'} still recorded against this bill — nothing was removed. This login may not be allowed to delete payments; ask your manager or the Owner.`)
          return
        }
        const actuallyRemoved = toDelete.filter(p => removedIds.has(p.id))
        if (actuallyRemoved.length < n) {
          setSettleWarn(`Only ${actuallyRemoved.length} of the ${n} selected payments were removed; the other ${n - actuallyRemoved.length} are still recorded. Reload and check the bill's payment history.`)
        }
        // Always clear paid_at on any affected line rather than re-checking against entry.value —
        // that field is a proportional split of the bill's grand total across whichever lines are
        // CURRENTLY still marked paid, which becomes unreliable (even negative) once a bill-level
        // fixed discount is left dividing an ever-shrinking subset of lines mid-cleanup. A false
        // "still fully paid" after this is always safe to re-settle with Pay Bill; silently leaving a
        // $0-paid line marked paid is not.
        //
        // Measured over EVERY removed row, credit partners included (S756 D11): the line a credit
        // was used on lost money and reopens even when its bill is not on screen (clearing a stamp
        // that is already clear is harmless); the line the credit came from got it back and stays
        // settled, which linesToReopen decides by the sign of what was removed from it.
        const affectedEntryIds = linesToReopen(removedRows)
          .filter(id => { const e = entries.find(x => x.id === id); return e ? !!e.paid_at : true })
        if (affectedEntryIds.length > 0) {
          const reopenFail = await writePaidAt(affectedEntryIds, null)
          if (reopenFail) {
            // The payment rows are already gone; what the reader needs is where the bill sits now.
            const removedTotal = actuallyRemoved.reduce((s, p) => s + Math.max(0, parseFloat(p.amount)), 0)
            const m = actuallyRemoved.length
            setSettleWarn({ ...reopenFail, text: `The payment${m === 1 ? ' was' : 's were'} removed, but the bill could not be reopened — it still shows under Paid History even though ${fmt(removedTotal)} of it is now unpaid. Reload the page; if it is still listed as settled, send the detail below to support. ${reopenFail.text}` })
          }
        }
        setSelectedPayments(new Set())
        load(activeTab)
      },
    })
  }

  // Bulk-set one note across whichever payment rows are checked — lets a settlement that was
  // recorded without a note (or with the wrong one) be corrected after the fact so it reads
  // cleanly on the Vendor Balance Confirmation letter, which groups payments into one ledger line
  // per (bill, date, note) and only merges rows that share the same note.
  function openEditNote(bill) {
    const targets = bill.payments.filter(p => selectedPayments.has(p.id))
    if (targets.length === 0) return
    setEditingNotePayments({ ids: targets.map(p => p.id), count: targets.length })
    setNoteForm(targets[0].note || '')
    setNoteError('')
  }

  async function saveNoteForSelected() {
    if (!editingNotePayments) return
    setNoteSaving(true)
    setNoteError('')
    const trimmed = noteForm.trim() || null
    // `.select('id')` (S756): a policy-filtered update is `error: null`; count what actually changed.
    const { data: updated, error } = await scopedUpdate('payable_payments', { note: trimmed }).in('id', editingNotePayments.ids).select('id')
    setNoteSaving(false)
    if (error) { setNoteError(asActionError(error)); return }
    const want = editingNotePayments.ids.length
    if ((updated?.length || 0) < want) {
      setNoteError(`${updated?.length ? `Only ${updated.length} of the ${want} payments were updated` : 'The note was not saved on any of these payments'} — the rest still show their previous note. This login may not be allowed to change payments; ask your manager or the Owner.`)
      return
    }
    setEditingNotePayments(null)
    setSelectedPayments(new Set())
    load(activeTab)
  }

  // Bulk-set one Payment Mode across whichever payment rows are checked — same shape as
  // openEditNote()/saveNoteForSelected() above, mainly for tagging historical settlements that
  // predate the payment_mode column so they show a real value on the Vendor Balance Confirmation
  // letter instead of a blank Payment Mode cell.
  function openEditMode(bill) {
    // A supplier-credit entry's mode is what marks it as half of a pair — the database refuses a
    // change to it — so it is left out rather than offered and then refused (S756 D11). A written
    // off entry is the same (S885): its mode is what says it is not money paid, and the database
    // refuses a change into or out of it (write_off_mode_locked).
    const targets = bill.payments.filter(p => selectedPayments.has(p.id) && !isCreditRow(p) && !isWriteOff(p))
    if (targets.length === 0) {
      setPayError('Supplier credit and written off entries keep their own payment mode, so neither can be changed here. Select an ordinary payment to change its mode.')
      return
    }
    setEditingModePayments({ ids: targets.map(p => p.id), count: targets.length })
    setModeForm(targets[0].payment_mode || PAYMENT_MODES[0])
    setModeError('')
  }

  async function saveModeForSelected() {
    if (!editingModePayments) return
    setModeSaving(true)
    setModeError('')
    const { data: updated, error } = await scopedUpdate('payable_payments', { payment_mode: modeForm }).in('id', editingModePayments.ids).select('id')
    setModeSaving(false)
    if (error) { setModeError(asActionError(error)); return }
    const want = editingModePayments.ids.length
    if ((updated?.length || 0) < want) {
      setModeError(`${updated?.length ? `Only ${updated.length} of the ${want} payments were updated` : 'The payment mode was not saved on any of these payments'} — the rest still show their previous mode. This login may not be allowed to change payments; ask your manager or the Owner.`)
      return
    }
    setEditingModePayments(null)
    setSelectedPayments(new Set())
    load(activeTab)
  }

  function toggleSelectBill(key) {
    setSelectedBills(prev => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  function toggleSelectKeys(keys) {
    setSelectedBills(prev => {
      const allSelected = keys.every(k => prev.has(k))
      const next = new Set(prev)
      keys.forEach(k => allSelected ? next.delete(k) : next.add(k))
      return next
    })
  }

  // Pay every selected bill in full with one shared date/note — same per-entry allocation
  // payBill uses, just batched across bills so a monthly credit run doesn't need opening
  // and saving each invoice one at a time.
  async function paySelectedBills(targets) {
    if (targets.length === 0) return
    if (!effectiveClientId) { setBulkError('No client selected. Pick a client in the top-left switcher before saving.'); return }
    setBulkSaving(true)
    setBulkError('')
    setSettleWarn(null)
    const date = bulkForm.paid_at || todayIso()
    const note = bulkForm.note || null

    const rows = []
    const settleIds = []
    targets.forEach(bill => {
      const alloc = allocatePayment(bill.entries, bill.remaining, date, note, bulkForm.payment_mode)
      rows.push(...alloc.rows)
      settleIds.push(...alloc.settleIds)
    })
    if (rows.length === 0) { setBulkSaving(false); return }

    // The same fresh read the single-bill and lump-sum paths make (S792, PURCHASES-10): "pay in
    // full" from a page opened before someone else paid would pay those bills a second time.
    const moved = await paymentsMovedCheck(targets, Object.fromEntries(targets.map(b => [b.key, b.remaining])))
    if (moved) { setBulkError(moved); setBulkSaving(false); return }

    const fail = await recordPayments(targets, rows, settleIds, date, Object.fromEntries(targets.map(b => [b.key, b.remaining])))
    if (fail) { setBulkError(fail); setBulkSaving(false); return }
    setBulkSaving(false)
    setBulkForm({ paid_at: todayIso(), note: '', payment_mode: 'Cash' })
    load(activeTab)
  }

  function fmt(v) { return `NPR ${Number(v).toLocaleString('en-IN', { maximumFractionDigits: 0 })}` }
  // To the paisa, for a sentence the reader types a figure back from — `fmt` rounds to the rupee.
  function fmt2(v) { return `NPR ${Number(v).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` }

  const AGING_LABELS = ['Current', '31–60 days', '61–90 days', '90+ days']

  // ── Group line entries into BILLS (vendor + invoice + period + day) ──
  // Memoized: this rebuilds and re-sorts the whole bill ledger (every credit line, unbounded by
  // period), and it used to re-run on every keystroke of the payment-amount and note boxes —
  // exactly while someone is entering money.
  const { vendors, vendorByName, bills, periodOptions, filteredBills, groups, totalRemaining, overdueBills, urgentValue, creditValue, lastSettled } = useMemo(() => {
    const vendors = [...new Map(entries.map(e => [e.vendors?.name, e.vendors])).values()].filter(Boolean)
    const vendorByName = Object.fromEntries(vendors.map(v => [v.name, v]))

    // e.billKey is stamped in load() by the same billKeyOf() the grand-total pass grouped on —
    // reusing it here is what guarantees bill.total equals the total that was actually computed.
    // groupIntoBills (payablesAllocation.js) also flags `isCredit` — over-settled, because a return
    // landed after the bill was paid, so the vendor owes that back (S723) — and totals the supplier
    // credit a bill received (`creditIn`) or gave (`creditOut`) through D11 pairs.
    const bills = groupIntoBills(entries, paymentsMap)

    // Period (BS month) options — lets a monthly credit run be narrowed to "this month's bills"
    // before selecting/bulk-paying, on top of the existing Vendor/Aging filters.
    const periodKey = b => `${b.period.bs_year}-${b.period.bs_month}`
    const periodOptions = [...new Map(bills.map(b => [periodKey(b), b.period])).entries()]
      .map(([key, p]) => ({ key, label: `${BS_MONTHS[(p.bs_month || 1) - 1]} ${p.bs_year}`, y: p.bs_year, m: p.bs_month }))
      .sort((a, b) => (b.y - a.y) || (b.m - a.m))

    const filteredBills = bills.filter(b => {
      const matchV = filterVendor === 'all' || b.vendorName === filterVendor
      const matchA = filterAging  === 'all' || b.aging.label === filterAging
      const matchP = filterPeriod === 'all' || periodKey(b) === filterPeriod
      return matchV && matchA && matchP
    })

    // Supplier by supplier, in the order the page draws them; the Print and the Excel export read
    // the same list, so the workbook is the table on screen (payablesView.js, S885).
    const groups = vendorGroups(filteredBills, activeTab)

    const totalRemaining = filteredBills.reduce((s, b) => s + (activeTab === 'outstanding' ? billBalance(b) : b.total), 0)
    // S885 (owner decision 2): overdue follows each supplier's own payment days, 60 when none is
    // set and 0 for due on delivery. The age buckets below still describe age, not lateness.
    const overdueBills   = filteredBills.filter(b => billStatus(b, vendorTerms[b.vendorId]).key === 'overdue').length
    const urgentValue    = filteredBills.filter(b => b.daysOld > 90).reduce((s, b) => s + Math.max(0, b.remaining), 0)
    // Vendor credits, shown as a positive amount owed back to us — money only, never a cleared
    // leftover (groupIntoBills' `credit`, S885).
    const creditValue    = filteredBills.filter(b => b.isCredit).reduce((s, b) => s + b.credit, 0)
    // Explicit max rather than "the first bill in fetch order" — that only held while `entries`
    // arrived in paid_at-descending order, which stopped being true once a bill's lines are
    // merged from two reads (S723).
    const lastSettled    = filteredBills.reduce((best, b) =>
      (b.settledOn && (!best || b.settledOn > best.settledOn) ? b : best), null)

    return { vendors, vendorByName, bills, periodOptions, filteredBills, groups, totalRemaining, overdueBills, urgentValue, creditValue, lastSettled }
  }, [entries, paymentsMap, filterVendor, filterAging, filterPeriod, activeTab, vendorTerms])

  // What a printed or exported copy covers, every filter on the page stated (S885, S725's rule).
  const monthFilterLabel = filterPeriod === 'all' ? null : (periodOptions.find(o => o.key === filterPeriod)?.label || null)
  const scopeLine = payablesScopeLine({
    tab: activeTab, vendor: filterVendor, aging: filterAging, monthLabel: monthFilterLabel, asOf: fmtBsDate(todayIso()),
  })

  async function exportExcel() {
    const XLSX = await import('xlsx')
    const outstanding = activeTab === 'outstanding'
    const rows = payablesSheetRows(groups, {
      tab: activeTab,
      vendorOf: id => vendorTerms[id] || null,
      settledLabel: iso => fmtBsDate(iso) || '',
    })
    const ws = sheetWithLetterhead(XLSX, {
      title: outstanding ? 'Outstanding Payables' : 'Outstanding Payables: Paid History',
      biz,
      scopeLine,
      rows,
      notes: payablesSheetNotes(activeTab),
    })
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, ws, outstanding ? 'Outstanding' : 'Paid History')
    XLSX.writeFile(wb, `outstanding-payables-${outstanding ? 'unpaid' : 'paid'}-${todayIso()}.xlsx`)
  }

  const selectedBillObjs = bills.filter(b => selectedBills.has(b.key) && b.remaining > EPS)
  const selectedTotal    = selectedBillObjs.reduce((s, b) => s + b.remaining, 0)

  if (!hasImsAccess('manager')) return <Navigate to="/dashboard" replace />

  return (
    <div>
      <div className="page-header page-header--split">
        <div>
          <h1 className="page-title">Outstanding Payables</h1>
          <p className="page-subtitle">
            {activeTab === 'outstanding' ? 'Unpaid credit bills — pay the whole invoice in one go' : 'Settled credit bills — payment history'}
          </p>
        </div>
        {/* S885 (owner decision 1): Print and Excel of the bills on screen, gated on the load like
            every report export (S728), Excel also on the business name (LetterheadButton, S877). */}
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <button className="btn btn-ghost" style={{ fontSize: 12 }}
            disabled={loading || !!loadError || setupNeeded || filteredBills.length === 0}
            onClick={() => printWithTitle(`Outstanding Payables — ${scopeLine}`)}>🖨 Print</button>
          <LetterheadButton ready={biz.ready} error={biz.error} style={{ fontSize: 12 }} onClick={exportExcel}
            disabled={loading || !!loadError || setupNeeded || filteredBills.length === 0}>↓ Export Excel</LetterheadButton>
        </div>
      </div>
      {/* The filters are no-print, so what the printed copy covers prints here. */}
      <p className="print-only" style={{ fontSize: 12, margin: '0 0 12px' }}>{scopeLine}</p>
      {biz.error && (
        <p role="alert" className="no-print" style={{ margin: '0 0 16px', fontSize: 12, color: 'var(--theme-amber-text)' }}>
          The name of this outlet could not be loaded, so Excel is switched off rather than exporting a sheet with a blank company name. The list below is unaffected. Reload the page to try again.
        </p>
      )}

      <Tabs
        idBase="payables"
        label="Payables views"
        style={{ marginBottom: 24 }}
        tabs={[{ key: 'outstanding', label: 'Outstanding' }, { key: 'paid', label: 'Paid History' }]}
        active={activeTab}
        onChange={switchTab}
      />

      {settleWarn && <ActionError error={settleWarn} className="action-error--top" />}

      {/* A failed read renders as a failure — an empty payables list claims nothing is owed (S612). */}
      {loadError && <ReportLoadError error={loadError} onRetry={() => load(activeTab)} />}

      {setupNeeded && (
        <div style={{ background: 'color-mix(in srgb, var(--theme-red) 8%, transparent)', border: '1px solid color-mix(in srgb, var(--theme-red) 30%, transparent)', borderRadius: 'var(--radius-sm)', padding: '16px 20px', marginBottom: 24, fontSize: 13 }}>
          <div style={{ fontWeight: 700, color: 'var(--theme-red-text)', marginBottom: 8 }}>⚠ One-time setup required</div>
          <div style={{ color: 'var(--theme-text3)', marginBottom: 10 }}>Run this SQL in Supabase → SQL Editor, then refresh:</div>
          <code style={{ display: 'block', background: 'var(--theme-bg)', padding: '10px 14px', borderRadius: 'var(--radius-sm)', color: 'var(--theme-text1)', fontSize: 12, userSelect: 'all' }}>
            ALTER TABLE purchase_entries ADD COLUMN IF NOT EXISTS paid_at date;
          </code>
        </div>
      )}

      {!loadError && !loading && (
      <div className="stat-grid stat-grid--pair">
        {activeTab === 'outstanding' ? (<>
          <div className="stat-card">
            <div className="stat-label"><Tip text="Total remaining balance across all outstanding credit bills, less any payments already recorded. Bill amounts match the vendor's invoice: less any bill discount, less goods returned at the discounted price the supplier charged for them, plus 13% VAT on VAT-inclusive lines. A bill over-settled by a late return counts against this as a credit." width={280}>Total Remaining</Tip></div>
            <div className="stat-value" style={{ fontSize: 18, color: totalRemaining > 0 ? 'var(--theme-text1)' : 'var(--theme-text2)' }}>{fmt(totalRemaining)}</div>
            <div className="stat-sub">{filteredBills.length} bill{filteredBills.length !== 1 ? 's' : ''} · {groups.length} vendor{groups.length !== 1 ? 's' : ''}</div>
          </div>
          <div className="stat-card">
            <div className="stat-label"><Tip text={`Bills with money still owed that are older than the number of days their supplier gives to pay, counted from the bill date. A supplier with no days set gets ${DEFAULT_PAY_WITHIN_DAYS} days, and 0 days means due on delivery. Set them with Edit Terms on each supplier.`} width={290}>Overdue Bills</Tip></div>
            <div className="stat-value" style={{ color: overdueBills > 0 ? 'var(--theme-amber-text)' : 'var(--theme-text2)' }}>{overdueBills}</div>
            <div className="stat-sub">Past their supplier payment days</div>
          </div>
          <div className="stat-card">
            <div className="stat-label"><Tip text="Remaining value on bills over 90 days old, counted from the bill date whatever the supplier payment days are. Urgent settlement needed." width={260}>90+ Day Value</Tip></div>
            <div className="stat-value" style={{ fontSize: 16, color: urgentValue > 0 ? 'var(--theme-red-text)' : 'var(--theme-text2)' }}>{urgentValue > 0 ? fmt(urgentValue) : '—'}</div>
            <div className="stat-sub">Urgent settlement</div>
          </div>
        </>) : (<>
          <div className="stat-card">
            <div className="stat-label"><Tip text="Total invoiced value of all fully settled credit bills — net of returns and discount, including VAT where applicable. A small leftover cleared without paying (written off) is part of it." width={260}>Total Paid</Tip></div>
            <div className="stat-value" style={{ fontSize: 18, color: 'var(--theme-text1)' }}>{fmt(totalRemaining)}</div>
            <div className="stat-sub">{filteredBills.length} settled bill{filteredBills.length !== 1 ? 's' : ''}</div>
          </div>
          <div className="stat-card">
            <div className="stat-label">Vendors Paid</div>
            <div className="stat-value">{groups.length}</div>
            <div className="stat-sub">Unique vendors settled</div>
          </div>
          <div className="stat-card">
            <div className="stat-label"><Tip text="Most recently settled bill date." width={200}>Last Settlement</Tip></div>
            <div className="stat-value" style={{ fontSize: 14 }}>{(lastSettled && fmtBsDate(lastSettled.settledOn)) || '—'}</div>
            <div className="stat-sub">{lastSettled?.vendorName || ''}</div>
          </div>
          {/* Only rendered when there is one — a card reading "NPR 0 owed back" every month would
              train the reader to stop looking at the one month it is not zero. */}
          {creditValue > EPS && (
            <div className="stat-card">
              <div className="stat-label"><Tip text="Goods returned against bills that were already settled, so the supplier owes this back. To use it, open another unpaid bill from the same supplier on the Outstanding tab and fill in Use supplier credit — or ask the supplier for a credit note. It is not a payable." width={280}>Vendor Credits</Tip></div>
              <div className="stat-value" style={{ fontSize: 16, color: 'var(--theme-text1)' }}>{fmt(creditValue)}</div>
              <div className="stat-sub">Owed back to you</div>
            </div>
          )}
        </>)}
      </div>
      )}

      {!loadError && (
      <div className="no-print" style={{ display: 'flex', gap: 20, marginBottom: 20, flexWrap: 'wrap', alignItems: 'center' }}>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          <select aria-label="Filter by vendor" className="form-select" value={filterVendor} onChange={e => setFilterVendor(e.target.value)}>
            <option value="all">All Vendors</option>
            {vendors.map(v => <option key={v.name} value={v.name}>{v.name}</option>)}
          </select>
          {activeTab === 'outstanding' && (
            <select aria-label="Filter by age" className="form-select" value={filterAging} onChange={e => setFilterAging(e.target.value)}>
              <option value="all">All Ages</option>
              {AGING_LABELS.map(a => <option key={a} value={a}>{a}</option>)}
            </select>
          )}
          <select aria-label="Filter by month" className="form-select" value={filterPeriod} onChange={e => setFilterPeriod(e.target.value)}>
            <option value="all">All Months</option>
            {periodOptions.map(p => <option key={p.key} value={p.key}>{p.label}</option>)}
          </select>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <button className="btn btn-ghost" style={{ fontSize: 13 }} onClick={() => load(activeTab)}>↻ Refresh</button>
          {activeTab === 'outstanding' && filteredBills.length > 0 && (
            <button className="btn btn-ghost" style={{ fontSize: 13 }}
              onClick={() => toggleSelectKeys(filteredBills.map(b => b.key))}>
              {filteredBills.every(b => selectedBills.has(b.key)) ? 'Deselect All Filtered' : `Select All Filtered (${filteredBills.length})`}
            </button>
          )}
        </div>
      </div>
      )}

      {!loadError && activeTab === 'outstanding' && selectedBills.size > 0 && (
        <div className="card no-print" style={{
          marginBottom: 20, padding: '14px 20px', display: 'flex', gap: 14, alignItems: 'flex-end', flexWrap: 'wrap',
          border: '1px solid color-mix(in srgb, var(--theme-accent) 40%, transparent)',
          background: 'color-mix(in srgb, var(--theme-accent) 6%, transparent)',
        }}>
          <div>
            <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--theme-text1)' }}>
              {selectedBillObjs.length} bill{selectedBillObjs.length !== 1 ? 's' : ''} selected
            </div>
            <div style={{ fontSize: 13, color: 'var(--theme-text1)', fontWeight: 700 }}>{fmt(selectedTotal)} total</div>
          </div>
          <div>
            <div style={{ fontSize: 11, color: 'var(--theme-text2)', marginBottom: 4 }}>Payment Date</div>
            <BsCalendarPicker value={bulkForm.paid_at} onChange={v => setBulkForm(f => ({ ...f, paid_at: v }))} placeholder="Pick date" />
          </div>
          <div>
            <div style={{ fontSize: 11, color: 'var(--theme-text2)', marginBottom: 4 }}>Payment Mode</div>
            <select aria-label="Payment mode" className="form-select" style={{ ...INPUT }}
              value={bulkForm.payment_mode} onChange={ev => setBulkForm(f => ({ ...f, payment_mode: ev.target.value }))}>
              {PAYMENT_MODES.map(m => <option key={m} value={m}>{m}</option>)}
            </select>
          </div>
          <div style={{ flex: 1, minWidth: 180 }}>
            <div style={{ fontSize: 11, color: 'var(--theme-text2)', marginBottom: 4 }}>Note (optional)</div>
            <input aria-label="Payment note" type="text" style={{ ...INPUT, width: '100%' }} placeholder="e.g. Monthly batch payment"
              value={bulkForm.note} onChange={ev => setBulkForm(f => ({ ...f, note: ev.target.value }))} />
          </div>
          <button className="btn btn-ghost" style={{ padding: '8px 14px', fontSize: 12 }} onClick={() => setSelectedBills(new Set())}>Clear</button>
          <button className="btn btn-primary" style={{ padding: '8px 18px', fontSize: 13 }}
            disabled={bulkSaving || selectedBillObjs.length === 0}
            onClick={() => paySelectedBills(selectedBillObjs)}>
            {bulkSaving ? '…' : `Pay ${selectedBillObjs.length} Bill${selectedBillObjs.length !== 1 ? 's' : ''} in Full`}
          </button>
          {bulkError && <div style={{ width: '100%' }}><ActionError error={bulkError} /></div>}
        </div>
      )}

      {loading ? (
        <div className="card"><p style={{ color: 'var(--theme-text2)', fontSize: 13 }}>Loading payables…</p></div>
      ) : loadError ? null : setupNeeded ? null : filteredBills.length === 0 ? (
        <div className="card">
          <div className="empty-state">
            <div className="empty-state-icon">✓</div>
            <p className="empty-state-text">
              {bills.length === 0 ? 'No outstanding credit payables.' : 'No bills match the current filters.'}
            </p>
          </div>
        </div>
      ) : (
        // Supplier groups in the page's order (vendorGroups: owed most first; Paid History reads
        // newest-settled first, since the fetch order no longer survives merging a bill's lines
        // from two reads, S723). The Print and the Excel export read the same list.
        groups.map(({ vName, bills: sorted }) => {
            const vendorTotal = sorted.reduce((s, b) => s + (activeTab === 'outstanding' ? billBalance(b) : b.total), 0)
            const cols = activeTab === 'outstanding' ? 10 : 6
            const vKeys = sorted.map(b => b.key)
            const vBillTotal = sorted.reduce((s, b) => s + b.total, 0)
            const vPaidTotal = sorted.reduce((s, b) => s + b.paid, 0)
            const vRemainingTotal = sorted.reduce((s, b) => s + billBalance(b), 0)
            const vTerms = vendorByName[vName] ? vendorTerms[vendorByName[vName].id] : null
            return (
              <div key={vName} className="card" style={{ marginBottom: 16 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16, paddingBottom: 12, borderBottom: '1px solid var(--theme-border)' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    <span style={{ fontWeight: 700, fontSize: 14, color: 'var(--theme-text1)' }}>{vName}</span>
                    {vendorByName[vName] && (<>
                      {/* S885: the days decide what is overdue on this card; the note is kept. */}
                      <span style={{ fontSize: 12, color: 'var(--theme-text3)' }}>
                        {payTermsLabel(vTerms)}{vTerms?.payment_terms ? ` · Note: ${vTerms.payment_terms}` : ''}
                      </span>
                      <button className="btn btn-ghost btn-sm"
                        onClick={() => openEditTerms(vendorByName[vName])}>
                        Edit Terms
                      </button>
                      {activeTab === 'outstanding' && bills.some(x => x.vendorName === vName && x.remaining > EPS) && (
                        <Tip text={`Enter one amount you paid ${vName}. Crest pays their oldest unpaid bill first, then the next, and shows you exactly how it splits before anything is saved.`} width={280}>
                          <button className="btn btn-ghost btn-sm"
                            onClick={() => openLumpSum(vName)}>
                            Pay supplier…
                          </button>
                        </Tip>
                      )}
                    </>)}
                  </div>
                  <span style={{ fontSize: 14, fontWeight: 700, color: activeTab === 'outstanding' ? 'var(--theme-text1)' : 'var(--theme-text1)' }}>{fmt(vendorTotal)}</span>
                </div>
                <div className="table-wrap">
                  <table className="data-table">
                    <thead>
                      <tr>
                        {activeTab === 'outstanding' && (
                          <th className="no-print" style={{ width: 28 }}>
                            <input type="checkbox"
                              checked={vKeys.length > 0 && vKeys.every(k => selectedBills.has(k))}
                              onChange={() => toggleSelectKeys(vKeys)}
                              aria-label={`Select all bills for ${vName}`} />
                          </th>
                        )}
                        <th>Invoice</th>
                        <th>Period</th>
                        <th style={{ textAlign: 'right' }}>Items</th>
                        <th style={{ textAlign: 'right' }}><Tip text="What the vendor actually invoiced, computed the same way as the printed purchase voucher: line values net of any goods returned, minus the bill discount, plus 13% VAT on VAT-inclusive lines." width={290}>Bill Total</Tip></th>
                        {activeTab === 'outstanding' ? (<>
                          <th style={{ textAlign: 'right' }}><Tip text="Money paid and supplier credit used on this bill, plus any small leftover cleared without paying (written off), which is named under the figure." width={260}>Paid</Tip></th>
                          <th style={{ textAlign: 'right' }}>Remaining</th>
                          <th style={{ textAlign: 'right' }}><Tip text="Calendar days since the bill date." width={180}>Days</Tip></th>
                          <th><Tip text={`Overdue once a bill is older than the days its supplier gives to pay (${DEFAULT_PAY_WITHIN_DAYS} when none is set, 0 for due on delivery). Partial means some of it is paid and it is not overdue yet.`} width={280}>Status</Tip></th>
                          <th className="no-print"></th>
                        </>) : (<>
                          <th>Settled On</th>
                          <th className="no-print"></th>
                        </>)}
                      </tr>
                    </thead>
                    <tbody>
                      {sorted.map(b => {
                        const isExpanded = expandedBill === b.key
                        // Not when the amount is more than is owed — that is refused on Save, and
                        // "this will fully settle" beside it would be the opposite claim (S756).
                        // Money and supplier credit count together toward what is owed (S756 D11).
                        const vc = vendorCredit[b.vendorId]
                        const creditAvail = vc?.status === 'ready' ? vc.available : 0
                        const typedCash = Number(payForm.amount) || 0
                        const typedCredit = Number(payForm.credit) || 0
                        const overpaid = typedCash + typedCredit > b.remaining + 0.005 || typedCredit > creditAvail + 0.005
                        const willSettle = typedCash + typedCredit > 0 && !overpaid && typedCash + typedCredit + b.paid >= b.total - EPS
                        return (
                          <Fragment key={b.key}>
                            {/* The <tr> keeps its implicit `row` role: role="button" on a row takes it out of the
                                table's structure and its cells stop being associated with their column headers.
                                The control lives in a cell instead — see components/RowDisclosure.jsx (S595). */}
                            <tr style={{ cursor: 'pointer' }} onClick={() => toggleBill(b.key, b)}>
                              {activeTab === 'outstanding' && (
                                <td className="no-print" onClick={ev => ev.stopPropagation()}>
                                  <input type="checkbox" checked={selectedBills.has(b.key)} onChange={() => toggleSelectBill(b.key)}
                                    aria-label={`Select bill ${b.invoice_ref || ''}`} />
                                </td>
                              )}
                              <td style={{ fontWeight: 600, color: 'var(--theme-text1)' }}>
                                <RowDisclosure
                                  expanded={isExpanded}
                                  onToggle={() => toggleBill(b.key, b)}
                                  controls={`bill-detail-${b.key}`}
                                  label={`Bill ${b.invoice_ref || 'without an invoice number'} — ${isExpanded ? 'hide' : 'show'} line items and payment history`}
                                />{' '}
                                #{b.invoice_ref || '—'}
                              </td>
                              <td style={{ color: 'var(--theme-text2)' }}>{BS_MONTHS[(b.period.bs_month || 1) - 1]} {b.period.bs_year}</td>
                              <td style={{ textAlign: 'right', color: 'var(--theme-text2)' }}>{b.entries.length}</td>
                              <td style={{ textAlign: 'right', fontWeight: 600, color: 'var(--theme-text1)' }}>{fmt(b.total)}</td>
                              {activeTab === 'outstanding' ? (<>
                                <td style={{ textAlign: 'right', color: b.paid > 0 ? 'var(--theme-text1)' : 'var(--theme-text2)' }}>
                                  {b.paid > 0 ? fmt(b.paid) : '—'}
                                  {/* Supplier credit is part of Paid, but it is not money that left the
                                      bank, so the cell says how much of it was (S756 D11). */}
                                  {b.creditIn > EPS && <span style={{ display: 'block', fontSize: 11, color: 'var(--theme-text2)', whiteSpace: 'nowrap' }}>incl. {fmt(b.creditIn)} credit</span>}
                                  {/* A cleared leftover is in Paid because it lowers what is owed, and
                                      it is not money paid, so the cell names it (S885). */}
                                  {b.writtenOff > EPS && <span style={{ display: 'block', fontSize: 11, color: 'var(--theme-text2)', whiteSpace: 'nowrap' }}>incl. {fmt2(b.writtenOff)} written off</span>}
                                </td>
                                <td style={{ textAlign: 'right', fontWeight: 700, color: 'var(--theme-text1)' }}>
                                  {b.isCredit ? `${fmt(b.credit)} cr` : fmt(billBalance(b))}
                                </td>
                                <td style={{ textAlign: 'right', fontWeight: 700, color: b.aging.color }}>{b.daysOld}</td>
                                <td>
                                  {/* Supplier credit is a state the word names, not a verdict (S796): grey, as
                                      Vendor Report shows the same Credit in plain ink. Not an aging chip on
                                      a bill owing nothing (S792, PURCHASES-8). Since S885 an unpaid bill
                                      is judged against its supplier payment days, not a fixed 60. */}
                                  {(() => {
                                    const st = billStatus(b, vendorTerms[b.vendorId])
                                    const chip = { whiteSpace: 'nowrap' }
                                    const tipStyle = { display: 'inline-flex', borderBottom: 'none', cursor: 'default' }
                                    const tip = `${payTermsLabel(vendorTerms[b.vendorId])}. This bill is ${b.daysOld} day${b.daysOld === 1 ? '' : 's'} old.`
                                    if (st.key === 'credit' || st.key === 'nothing') return <span className="badge badge-gray" style={chip}>{st.label}</span>
                                    if (st.key === 'overdue') return <Tip text={tip} width={240} style={tipStyle}><span className="badge badge-amber" style={chip}>{st.label}</span></Tip>
                                    if (st.key === 'partial') return <Tip text={`${tip} ${st.dueIn === 0 ? 'The rest is due today.' : `The rest is due in ${st.dueIn} day${st.dueIn === 1 ? '' : 's'}.`}`} width={240} style={tipStyle}><span style={{ fontSize: 11, fontWeight: 700, color: 'var(--theme-amber-text)', background: 'color-mix(in srgb, var(--theme-amber) 12%, transparent)', border: '1px solid color-mix(in srgb, var(--theme-amber) 40%, transparent)', borderRadius: 'var(--radius-xs)', padding: '2px 8px', whiteSpace: 'nowrap' }}>Partial</span></Tip>
                                    return <Tip text={tip} width={240} style={tipStyle}><span className="badge badge-gray" style={chip}>{st.label}</span></Tip>
                                  })()}
                                </td>
                                <td className="no-print" style={{ color: 'var(--theme-accent-ink)', fontSize: 12, whiteSpace: 'nowrap' }}>{isExpanded ? '▲ Hide' : b.remaining <= EPS ? '▼ Details' : '＋ Pay Bill'}</td>
                              </>) : (<>
                                <td style={{ color: 'var(--theme-text2)', fontWeight: 600, fontSize: 13 }}>
                                  {fmtBsDate(b.settledOn) || '—'}
                                  {b.isCredit && <span className="badge badge-gray" style={{ marginLeft: 8, whiteSpace: 'nowrap' }}>{fmt(b.credit)} credit</span>}
                                  {b.writtenOff > EPS && <Tip text="A small leftover on this bill was cleared without paying it. It is not money paid; the payment history shows who cleared it." width={260} style={{ display: 'inline-flex', borderBottom: 'none', cursor: 'default' }}><span className="badge badge-gray" style={{ marginLeft: 8, whiteSpace: 'nowrap' }}>{fmt2(b.writtenOff)} written off</span></Tip>}
                                  {b.creditOut > EPS && <Tip text={`${fmt(b.creditOut)} of this bill's credit has been used to pay other bills from ${b.vendorName}. See the Supplier credit entries in its payment history.`} width={260} style={{ display: 'inline-flex', borderBottom: 'none', cursor: 'default' }}><span className="badge badge-gray" style={{ marginLeft: 8, whiteSpace: 'nowrap' }}>{fmt(b.creditOut)} credit used</span></Tip>}
                                </td>
                                <td className="no-print" style={{ color: 'var(--theme-text3)', fontSize: 12, whiteSpace: 'nowrap' }}>{isExpanded ? '▲ Hide' : '▼ Details'}</td>
                              </>)}
                            </tr>

                            {isExpanded && (
                              <tr id={`bill-detail-${b.key}`}>
                                {/* S765: was a frozen rgba(10,12,18,0.7) — a near-black overlay
                                    filled with var(--theme-text1)/text2/text3. On Modernist Light
                                    that composites to ~#4D4E53 and puts the ink at ~2.0:1, on the
                                    ACCOUNTANT's screen, in the panel holding the item lines, rates,
                                    totals and payment history. Its near-identical twin in
                                    VendorReport.js has always used the token. */}
                                <td colSpan={cols} style={{ padding: 0, background: 'var(--theme-bg)' }}>
                                  <div style={{ padding: '16px 20px' }}>

                                    {/* Line items in this bill */}
                                    <div style={{ fontSize: 11, color: 'var(--theme-text3)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 10 }}>Items in this bill ({b.entries.length})</div>
                                    <table style={{ borderCollapse: 'collapse', fontSize: 13, width: '100%', maxWidth: 620, marginBottom: 20 }}>
                                      <thead>
                                        <tr>
                                          <th style={{ textAlign: 'left', padding: '4px 16px 4px 0', color: 'var(--theme-text2)', fontWeight: 600, fontSize: 11 }}>Item</th>
                                          <th style={{ textAlign: 'right', padding: '4px 16px', color: 'var(--theme-text2)', fontWeight: 600, fontSize: 11 }}>Qty</th>
                                          <th style={{ textAlign: 'right', padding: '4px 16px', color: 'var(--theme-text2)', fontWeight: 600, fontSize: 11 }}>Rate</th>
                                          <th style={{ textAlign: 'right', padding: '4px 0 4px 16px', color: 'var(--theme-text2)', fontWeight: 600, fontSize: 11 }}>Total</th>
                                        </tr>
                                      </thead>
                                      <tbody>
                                        {b.entries.map(e => (
                                          <tr key={e.id}>
                                            <td style={{ padding: '4px 16px 4px 0', color: 'var(--theme-text1)' }}>{e.items?.name}</td>
                                            <td style={{ padding: '4px 16px', textAlign: 'right', color: 'var(--theme-text2)' }}>{parseFloat(e.qty).toLocaleString('en-IN')} {e.items?.uom}</td>
                                            {/* Per the unit in the Qty cell; a GM / ML rate reads per KG / LTR first, the
                                                per-gram figure beside it (S797). A 0 is a free line. */}
                                            <td style={{ padding: '4px 16px', textAlign: 'right', color: 'var(--theme-text2)' }}>{Number(e.rate) === 0 ? fmtLineRate(e.rate) : unitRateCell(e.rate, e.items?.uom)}</td>
                                            <td style={{ padding: '4px 0 4px 16px', textAlign: 'right', color: 'var(--theme-text1)', fontWeight: 600 }}>{fmt(e.value)}</td>
                                          </tr>
                                        ))}
                                      </tbody>
                                    </table>

                                    {/* Payment history (across the whole bill) */}
                                    {b.payments.length > 0 && (() => {
                                      const paymentIds = b.payments.map(p => p.id)
                                      const selectedHere = paymentIds.filter(id => selectedPayments.has(id))
                                      return (
                                      <div style={{ marginBottom: activeTab === 'outstanding' ? 20 : 0 }}>
                                        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 10 }}>
                                          <div style={{ fontSize: 11, color: 'var(--theme-text3)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>Payment History</div>
                                          {selectedHere.length > 0 && (<>
                                            <button className="btn btn-ghost btn-sm"
                                              onClick={ev => { ev.stopPropagation(); openEditMode(b) }}>
                                              Edit Payment Mode ({selectedHere.length})
                                            </button>
                                            <button className="btn btn-ghost btn-sm"
                                              onClick={ev => { ev.stopPropagation(); openEditNote(b) }}>
                                              Edit Note ({selectedHere.length})
                                            </button>
                                            <button className="btn btn-danger btn-sm"
                                              onClick={ev => { ev.stopPropagation(); deleteSelectedPayments(b) }}>
                                              Delete Selected ({selectedHere.length})
                                            </button>
                                          </>)}
                                        </div>
                                        {/* The pay form below (and the message slot inside it) only
                                            renders on the Outstanding tab, so a failed delete on the
                                            Settled tab had nowhere to appear at all. */}
                                        {activeTab !== 'outstanding' && <ActionError error={payError} />}
                                        <table style={{ borderCollapse: 'collapse', fontSize: 13, minWidth: 400 }}>
                                          <thead>
                                            <tr>
                                              <th className="no-print" style={{ padding: '0 16px 5px 0' }}>
                                                <input type="checkbox" checked={selectedHere.length === paymentIds.length}
                                                  onChange={ev => { ev.stopPropagation(); toggleSelectPayments(paymentIds) }}
                                                  onClick={ev => ev.stopPropagation()} aria-label="Select all payments in this bill" title="Select all payments in this bill" />
                                              </th>
                                              <th /><th /><th /><th /><th />
                                            </tr>
                                          </thead>
                                          <tbody>
                                            {b.payments.map(p => (
                                              <tr key={p.id}>
                                                <td className="no-print" style={{ padding: '5px 16px 5px 0' }}>
                                                  <input type="checkbox" checked={selectedPayments.has(p.id)}
                                                    onChange={ev => { ev.stopPropagation(); toggleSelectPayment(p.id) }}
                                                    onClick={ev => ev.stopPropagation()} aria-label={`Select payment of ${fmt(p.amount)} on ${fmtBsDate(p.paid_at) || p.paid_at}`} />
                                                </td>
                                                <td style={{ padding: '5px 16px 5px 0', color: 'var(--theme-text2)' }}>{fmtBsDate(p.paid_at)}</td>
                                                <td style={{ padding: '5px 16px', textAlign: 'right', color: parseFloat(p.amount) < 0 ? 'var(--theme-text1)' : 'var(--theme-text1)', fontWeight: 600, whiteSpace: 'nowrap' }}>
                                                  {parseFloat(p.amount) < 0 ? `−${fmt(-parseFloat(p.amount))}` : fmt(p.amount)}
                                                </td>
                                                <td style={{ padding: '5px 16px', color: 'var(--theme-text3)' }}>
                                                  {isCreditRow(p)
                                                    ? <Tip text={parseFloat(p.amount) < 0
                                                        ? 'Credit this bill was holding (goods returned after it was paid), used to pay another bill from the same supplier. It is not money paid out. Deleting it also deletes the matching entry on that bill.'
                                                        : 'Paid with credit the supplier owed from another bill, not with money. Deleting it also deletes the matching entry on the bill the credit came from.'}
                                                        width={280} style={{ display: 'inline-flex', borderBottom: 'none', cursor: 'default' }}>
                                                        <span className="badge badge-gray" style={{ whiteSpace: 'nowrap' }}>{SUPPLIER_CREDIT_MODE}</span>
                                                      </Tip>
                                                    : isWriteOff(p)
                                                    // S885: a cleared leftover, never shown as a payment mode.
                                                    ? <Tip text="A small leftover cleared without paying it. It lowers what the bill owes but it is not money paid, so it never counts as a payment or as supplier credit, and its mode cannot be changed. Delete it to put the amount back on the bill."
                                                        width={280} style={{ display: 'inline-flex', borderBottom: 'none', cursor: 'default' }}>
                                                        <span className="badge badge-gray" style={{ whiteSpace: 'nowrap' }}>Written off</span>
                                                      </Tip>
                                                    : (p.payment_mode || '—')}
                                                </td>
                                                <td style={{ padding: '5px 16px', color: 'var(--theme-text3)' }}>{p.note || '—'}</td>
                                                {/* Who recorded it, stamped by the server since S885; older rows have no name. */}
                                                <td style={{ padding: '5px 0 5px 16px', color: 'var(--theme-text3)', whiteSpace: 'nowrap' }}>{recordedByOf(p) ? `by ${recordedByOf(p)}` : ''}</td>
                                              </tr>
                                            ))}
                                            {/* Money paid and supplier credit, then what was cleared, on its own line:
                                                a written off amount is not money paid (S885). */}
                                            <tr style={{ borderTop: '1px solid var(--theme-border)' }}>
                                              <td className="no-print" />
                                              <td style={{ padding: '5px 16px 5px 0', color: 'var(--theme-text2)', fontSize: 11 }}>Total paid</td>
                                              <td style={{ padding: '5px 16px', textAlign: 'right', fontWeight: 700, color: 'var(--theme-text1)' }}>{fmt2(b.paid - b.writtenOff)}</td>
                                              <td />
                                              <td />
                                              <td />
                                            </tr>
                                            {b.writtenOff > EPS && (
                                              <tr>
                                                <td className="no-print" />
                                                <td style={{ padding: '5px 16px 5px 0', color: 'var(--theme-text2)', fontSize: 11 }}>Written off</td>
                                                <td style={{ padding: '5px 16px', textAlign: 'right', fontWeight: 700, color: 'var(--theme-text1)' }}>{fmt2(b.writtenOff)}</td>
                                                <td />
                                                <td />
                                                <td />
                                              </tr>
                                            )}
                                          </tbody>
                                        </table>
                                      </div>
                                      )
                                    })()}

                                    {/* Record one payment for the whole bill — outstanding only */}
                                    {/* A bill with nothing left to pay has no form: `Pay in full`
                                        would prefill a negative and Save would be a button that
                                        does nothing silently, since allocatePayment skips every
                                        line at or under EPS. Say which of the two states it is. */}
                                    {activeTab === 'outstanding' && b.remaining <= EPS && (
                                      <div className="no-print" style={{ fontSize: 12, color: 'var(--theme-text2)' }}>
                                        {b.isCredit
                                          ? `Over-settled by ${fmt(b.credit)} — goods were returned after this bill was paid, so the supplier owes that back. There is nothing to pay here. To use the credit, open another unpaid bill from ${b.vendorName} and fill in "Use supplier credit", or ask the supplier for a credit note.`
                                          : 'Nothing left to pay on this bill — the goods on it were returned, or what was paid already covers what is owed.'}
                                        {/* S792 (PURCHASES-8): no payment can ever close a bill like this,
                                            so it gets its own way off this tab. */}
                                        {linesToCloseByReturns(b).length > 0 && (
                                          <div style={{ marginTop: 10, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                                            <Tip text={b.isCredit
                                              ? "Moves this bill to Paid History, dated today. The supplier's credit on it stays: it is still offered as \"Use supplier credit\" on their other unpaid bills."
                                              : 'Moves this bill to Paid History, dated today. Nothing is paid and no payment is recorded — there is nothing left to pay on it.'} width={280}>
                                              <button className="btn btn-ghost" style={{ padding: '6px 14px', fontSize: 12 }}
                                                onClick={() => closeSettledByReturns(b)}
                                                disabled={closingKey != null}>
                                                {closingKey === b.key ? 'Closing…' : 'Close this bill'}
                                              </button>
                                            </Tip>
                                          </div>
                                        )}
                                      </div>
                                    )}

                                    {activeTab === 'outstanding' && b.remaining > EPS && (
                                      <div className="no-print">
                                        <div style={{ fontSize: 11, color: 'var(--theme-text3)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 10 }}>
                                          {b.payments.length === 0 ? 'Pay this bill' : 'Add payment'}
                                          <span style={{ textTransform: 'none', letterSpacing: 0, color: 'var(--theme-text2)', marginLeft: 8 }}>· applied across all {b.entries.length} item{b.entries.length !== 1 ? 's' : ''}</span>
                                        </div>
                                        <div style={{ display: 'flex', gap: 10, alignItems: 'flex-end', flexWrap: 'wrap' }}>
                                          <div>
                                            <div style={{ fontSize: 11, color: 'var(--theme-text2)', marginBottom: 4 }}>Amount (NPR)</div>
                                            <input id={`pay-amount-${b.key}`} type="number" style={invalidStyle({ ...INPUT, width: 150 }, payAmountErr)} placeholder={`full: ${fmt(b.remaining)}`}
                                              aria-label={`Payment amount in NPR for ${b.vendorName}'s bill`}
                                              {...fieldAria(`pay-amount-${b.key}`, payAmountErr)}
                                              value={payForm.amount}
                                              onChange={ev => { setPayAmountErr(''); setPayForm(f => ({ ...f, amount: ev.target.value })) }}
                                              onClick={ev => ev.stopPropagation()} />
                                          </div>
                                          <div>
                                            <div style={{ fontSize: 11, color: 'var(--theme-text2)', marginBottom: 4 }}>Date</div>
                                            <div onClick={ev => ev.stopPropagation()}>
                                              <BsCalendarPicker
                                                value={payForm.paid_at}
                                                onChange={v => setPayForm(f => ({ ...f, paid_at: v }))}
                                                placeholder="Pick date" />
                                            </div>
                                          </div>
                                          <div>
                                            <div style={{ fontSize: 11, color: 'var(--theme-text2)', marginBottom: 4 }}>Payment Mode</div>
                                            <select aria-label="Payment mode" className="form-select" style={{ ...INPUT }}
                                              value={payForm.payment_mode}
                                              onChange={ev => setPayForm(f => ({ ...f, payment_mode: ev.target.value }))}
                                              onClick={ev => ev.stopPropagation()}>
                                              {PAYMENT_MODES.map(m => <option key={m} value={m}>{m}</option>)}
                                            </select>
                                          </div>
                                          <div style={{ flex: 1, minWidth: 180 }}>
                                            <div style={{ fontSize: 11, color: 'var(--theme-text2)', marginBottom: 4 }}>Note (optional)</div>
                                            <input aria-label="Payment reference" type="text" style={{ ...INPUT, width: '100%' }} placeholder="e.g. Cheque #1234"
                                              value={payForm.note}
                                              onChange={ev => setPayForm(f => ({ ...f, note: ev.target.value }))}
                                              onClick={ev => ev.stopPropagation()} />
                                          </div>
                                          <Tip text="Fills in what is left to pay on this bill, after any supplier credit you have entered below." width={240}>
                                            <button className="btn btn-ghost" style={{ padding: '8px 14px', fontSize: 12 }}
                                              onClick={ev => { ev.stopPropagation(); setPayAmountErr(''); setPayForm(f => ({ ...f, amount: String(Number(Math.max(0, b.remaining - (Number(f.credit) || 0)).toFixed(2))) })) }}>
                                              Pay in full
                                            </button>
                                          </Tip>
                                          {/* S885 (owner decision 3): a leftover of NPR 10 or less, within what this
                                              bill may still have cleared, can be cleared without paying. */}
                                          {clearableAmount(b) != null && (
                                            <Tip text={`Clears the last ${fmt2(clearableAmount(b))} on this bill without paying it, for a leftover the supplier will not collect. It is recorded as written off, not as money paid, and the bill moves to Paid History. At most ${fmt2(WRITE_OFF_MAX_NPR)} a bill.`} width={300}>
                                              <button className="btn btn-ghost" style={{ padding: '8px 14px', fontSize: 12 }}
                                                disabled={savingPayment}
                                                onClick={ev => { ev.stopPropagation(); askClearLeftover(b) }}>
                                                Clear {fmt2(clearableAmount(b))}
                                              </button>
                                            </Tip>
                                          )}
                                          <button className="btn btn-primary" style={{ padding: '8px 18px', fontSize: 13 }}
                                            disabled={!(typedCash > 0 || typedCredit > 0) || savingPayment}
                                            onClick={ev => { ev.stopPropagation(); payBill(b) }}>
                                            {savingPayment ? '…' : 'Save'}
                                          </button>
                                        </div>
                                        <FieldError id={`pay-amount-${b.key}`} message={payAmountErr} />

                                        {/* Settle using supplier credit (S756 D11). Shown only when the
                                            supplier's credit could be read: a failed read says so, and
                                            "no credit" and "could not check" never look alike. */}
                                        {b.vendorId && vc?.status === 'loading' && (
                                          <div style={{ marginTop: 10, fontSize: 12, color: 'var(--theme-text3)' }}>Checking whether {b.vendorName} owes you any credit…</div>
                                        )}
                                        {b.vendorId && vc?.status === 'error' && (() => {
                                          const { text, detail } = asActionError(vc.error)
                                          return <ActionError error={{ text: `Could not check whether ${b.vendorName} owes you any credit from returned goods, so it cannot be used on this bill right now. You can still pay the bill; reload to check again. ${text}`, detail }} />
                                        })()}
                                        {vc?.status === 'ready' && vc.available > EPS && (
                                          <div onClick={ev => ev.stopPropagation()} style={{
                                            marginTop: 14, padding: '10px 14px', maxWidth: 720,
                                            border: '1px solid var(--theme-border)',
                                            background: 'color-mix(in srgb, var(--theme-text2) 6%, transparent)',
                                          }}>
                                            <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--theme-text1)', marginBottom: 4 }}>
                                              <Tip text="When you returned goods after a bill from this supplier was already paid, they owe you that money back. Using it here takes that amount off this bill and off the credit on the older bill, in one step — both bills' payment history shows it, and so does the Vendor Balance Confirmation letter. No money changes hands." width={320}>
                                                {b.vendorName} owes you {fmt2(vc.available)} in credit
                                              </Tip>
                                            </div>
                                            <div style={{ fontSize: 12, color: 'var(--theme-text2)', marginBottom: 8 }}>
                                              From goods returned after these bills were paid: {vc.creditBills.map(c => `#${c.bill.invoice_ref || '—'} (${BS_MONTHS[(c.bill.period?.bs_month || 1) - 1]} ${c.bill.period?.bs_year}) ${fmt2(c.credit)}`).join('; ')}.
                                            </div>
                                            <div style={{ display: 'flex', gap: 10, alignItems: 'flex-end', flexWrap: 'wrap' }}>
                                              <div>
                                                <label htmlFor={`pay-credit-${b.key}`} style={{ display: 'block', fontSize: 11, color: 'var(--theme-text2)', marginBottom: 4 }}>Use supplier credit (NPR)</label>
                                                <input id={`pay-credit-${b.key}`} type="number" min="0" style={invalidStyle({ ...INPUT, width: 150 }, payCreditErr)}
                                                  placeholder={`up to ${fmt(Math.min(vc.available, b.remaining))}`}
                                                  {...fieldAria(`pay-credit-${b.key}`, payCreditErr)}
                                                  value={payForm.credit}
                                                  onChange={ev => { setPayCreditErr(''); setPayAmountErr(''); setPayForm(f => ({ ...f, credit: ev.target.value })) }} />
                                              </div>
                                              <Tip text="Fills in as much of the supplier's credit as this bill can take — all of it, or what the bill still owes if that is less." width={240}>
                                                <button className="btn btn-ghost" style={{ padding: '8px 14px', fontSize: 12 }}
                                                  onClick={() => { setPayCreditErr(''); setPayAmountErr(''); setPayForm(f => ({ ...f, credit: String(Number(Math.min(vc.available, b.remaining).toFixed(2))) })) }}>
                                                  Use {fmt2(Math.min(vc.available, b.remaining))}
                                                </button>
                                              </Tip>
                                            </div>
                                            <FieldError id={`pay-credit-${b.key}`} message={payCreditErr} />
                                            {typedCredit > 0 && !payCreditErr && !overpaid && (
                                              <div style={{ marginTop: 6, fontSize: 12, color: 'var(--theme-text2)' }}>
                                                {fmt2(typedCredit)} comes off this bill and off the supplier's credit{typedCash > 0 ? `, and ${fmt2(typedCash)} is paid by ${payForm.payment_mode}` : ''}.
                                                {' '}{b.remaining - typedCredit - typedCash > 0.005 ? `${fmt2(b.remaining - typedCredit - typedCash)} will still be owed on this bill.` : ''}
                                              </div>
                                            )}
                                          </div>
                                        )}
                                        <ActionError error={payError} />
                                        {willSettle && !payError && <div style={{ marginTop: 8, fontSize: 12, color: 'var(--theme-green-text)' }}>✓ This will fully settle the bill</div>}
                                      </div>
                                    )}

                                  </div>
                                </td>
                              </tr>
                            )}
                          </Fragment>
                        )
                      })}
                      <tr style={{ borderTop: '2px solid var(--theme-border)' }}>
                        {/* The checkbox and action columns do not print, so their cells are their
                            own here and the printed totals stay under their columns (S885). */}
                        {activeTab === 'outstanding' ? (<>
                          <td className="no-print" style={{ paddingTop: 12 }} />
                          <td colSpan={3} style={{ fontWeight: 700, color: 'var(--theme-text2)', paddingTop: 12 }}>Total</td>
                          <td style={{ textAlign: 'right', fontWeight: 700, color: 'var(--theme-text1)', paddingTop: 12 }}>{fmt(vBillTotal)}</td>
                          <td style={{ textAlign: 'right', fontWeight: 700, color: 'var(--theme-text1)', paddingTop: 12 }}>{vPaidTotal > 0 ? fmt(vPaidTotal) : '—'}</td>
                          <td style={{ textAlign: 'right', fontWeight: 700, color: 'var(--theme-text1)', paddingTop: 12 }}>{fmt(vRemainingTotal)}</td>
                          <td colSpan={2} style={{ paddingTop: 12 }}></td>
                          <td className="no-print" style={{ paddingTop: 12 }} />
                        </>) : (<>
                          <td colSpan={3} style={{ fontWeight: 700, color: 'var(--theme-text2)', paddingTop: 12 }}>Total</td>
                          <td style={{ textAlign: 'right', fontWeight: 700, color: 'var(--theme-text1)', paddingTop: 12 }}>{fmt(vBillTotal)}</td>
                          <td style={{ paddingTop: 12 }}></td>
                          <td className="no-print" style={{ paddingTop: 12 }} />
                        </>)}
                      </tr>
                    </tbody>
                  </table>
                </div>
              </div>
            )
          })
      )}

      {lumpVendor && (() => {
        // Every unpaid bill from this supplier on this tab — NOT the filtered view: the filters
        // decide what is on screen, never which bills a payment lands on (vendor-payables.md, S723).
        const vendorBills = bills.filter(x => x.vendorName === lumpVendor)
        const plan = planSupplierLumpSum(vendorBills, lumpForm.amount === '' ? 0 : lumpForm.amount, {
          date: lumpForm.paid_at || todayIso(), note: lumpForm.note || null, paymentMode: lumpForm.payment_mode,
        })
        const typed = lumpForm.amount !== '' && Number(lumpForm.amount) > 0
        const unpaidCount = vendorBills.filter(x => x.remaining > EPS).length
        const hiddenByFilter = vendorBills.filter(x => x.remaining > EPS && !filteredBills.includes(x)).length
        return (
          <Modal onClose={() => { if (!lumpSaving) setLumpVendor(null) }} title={`Pay ${lumpVendor}`}>
            <p style={{ fontSize: 13, color: 'var(--theme-text2)', margin: '0 0 12px' }}>
              {lumpVendor} is owed <strong style={{ color: 'var(--theme-text1)' }}>{fmt2(plan.total)}</strong> across {unpaidCount} unpaid bill{unpaidCount === 1 ? '' : 's'}. The amount goes to the oldest bill first.
              {hiddenByFilter > 0 && ` ${hiddenByFilter} of these bills are hidden by the filters on the page; they are included here.`}
            </p>
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'flex-end' }}>
              <div className="form-field" style={{ margin: 0 }}>
                <label htmlFor="lump-amount"><Tip text="The total you paid this supplier in one go — a cheque, a transfer or cash." width={220}>Amount paid (NPR)</Tip></label>
                <input id="lump-amount" type="number" min="0" style={invalidStyle({ ...INPUT, width: 160 }, lumpAmountErr)}
                  {...fieldAria('lump-amount', lumpAmountErr)}
                  placeholder={`up to ${fmt(plan.total)}`}
                  value={lumpForm.amount} autoFocus
                  onChange={ev => { setLumpAmountErr(''); setLumpForm(f => ({ ...f, amount: ev.target.value })) }} />
              </div>
              <div>
                <div style={{ fontSize: 12, color: 'var(--theme-text2)', marginBottom: 4 }}>Date</div>
                <BsCalendarPicker value={lumpForm.paid_at} onChange={v => setLumpForm(f => ({ ...f, paid_at: v }))} placeholder="Pick date" />
              </div>
              <div className="form-field" style={{ margin: 0 }}>
                <label htmlFor="lump-mode">Payment Mode</label>
                <select id="lump-mode" className="form-select" style={{ ...INPUT }}
                  value={lumpForm.payment_mode} onChange={ev => setLumpForm(f => ({ ...f, payment_mode: ev.target.value }))}>
                  {PAYMENT_MODES.map(m => <option key={m} value={m}>{m}</option>)}
                </select>
              </div>
              <div className="form-field" style={{ margin: 0, flex: 1, minWidth: 160 }}>
                <label htmlFor="lump-note">Note (optional)</label>
                <input id="lump-note" type="text" style={{ ...INPUT, width: '100%' }} placeholder="e.g. Cheque #1234"
                  value={lumpForm.note} onChange={ev => setLumpForm(f => ({ ...f, note: ev.target.value }))} />
              </div>
            </div>
            <FieldError id="lump-amount" message={lumpAmountErr || (typed && plan.error === 'over' ? `${lumpVendor} is owed ${fmt2(plan.total)} in total. Enter that or less — if you paid them more, record ${fmt2(plan.total)} here and the rest against their next bill.` : '')} />

            {typed && !plan.error && (
              <div className="table-wrap" style={{ marginTop: 14 }}>
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Bill</th>
                      <th style={{ textAlign: 'right' }}>Owed now</th>
                      <th style={{ textAlign: 'right' }}><Tip text="How much of this payment goes to each bill, oldest bill first." width={200}>This payment</Tip></th>
                      <th style={{ textAlign: 'right' }}>Still owed</th>
                      <th>Result</th>
                    </tr>
                  </thead>
                  <tbody>
                    {plan.split.map(s => (
                      <tr key={s.bill.key}>
                        <td style={{ whiteSpace: 'nowrap' }}>#{s.bill.invoice_ref || '—'} <span style={{ color: 'var(--theme-text3)' }}>· {BS_MONTHS[(s.bill.period?.bs_month || 1) - 1]} {s.bill.period?.bs_year}</span></td>
                        <td style={{ textAlign: 'right' }}>{fmt2(s.bill.remaining)}</td>
                        <td style={{ textAlign: 'right', fontWeight: 600 }}>{s.pay > 0 ? fmt2(s.pay) : '—'}</td>
                        <td style={{ textAlign: 'right' }}>{fmt2(s.after)}</td>
                        <td>{s.pay <= 0
                          ? <span className="badge badge-gray">Not reached</span>
                          : s.settles ? <span className="badge badge-green">Paid in full</span> : <span className="badge badge-amber">Part paid</span>}</td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr>
                      <td>Total</td>
                      <td style={{ textAlign: 'right' }}>{fmt2(plan.total)}</td>
                      <td style={{ textAlign: 'right' }}>{fmt2(plan.amount)}</td>
                      <td style={{ textAlign: 'right' }}>{fmt2(Math.max(0, plan.total - plan.amount))}</td>
                      <td>Nothing left over</td>
                    </tr>
                  </tfoot>
                </table>
              </div>
            )}
            <ActionError error={lumpError} />
            <div className="form-actions">
              <button className="btn btn-ghost" onClick={() => setLumpVendor(null)} disabled={lumpSaving}>Cancel</button>
              <button className="btn btn-primary" onClick={() => saveLumpSum(plan)}
                disabled={lumpSaving || !typed || !!plan.error} aria-busy={lumpSaving ? 'true' : undefined}>
                {lumpSaving ? 'Saving…' : typed && !plan.error ? `Record ${fmt2(plan.amount)}` : 'Record payment'}
              </button>
            </div>
          </Modal>
        )
      })()}

      {editingTermsVendor && (() => {
        // A number read from the note ("Net 30", "COD"), offered while the days box is blank; the
        // same reading the supplier form and the Excel import use (parsePayTerms, S885).
        const rawDays = String(termsForm.days ?? '').trim()
        const suggested = rawDays === '' ? parsePayTerms(termsForm.note) : null
        const typedDays = rawDays === '' ? null : Number(rawDays)
        const previewOk = typedDays === null || (Number.isInteger(typedDays) && typedDays >= 0 && typedDays <= MAX_PAY_WITHIN_DAYS)
        return (
        <Modal onClose={() => { if (!termsSaving) setEditingTermsVendor(null) }} title={`Payment Terms — ${editingTermsVendor.name}`}>
          <div className="form-field">
            <label htmlFor="outsta-days"><Tip text={`How many days ${editingTermsVendor.name} gives you to pay a bill, counted from the bill date. A bill older than that shows as overdue. Leave it blank for ${DEFAULT_PAY_WITHIN_DAYS} days; enter 0 if bills are due on delivery.`} width={280}>Pay within (days)</Tip></label>
            <input id="outsta-days" type="number" min="0" max={MAX_PAY_WITHIN_DAYS} step="1" inputMode="numeric"
              value={termsForm.days}
              onChange={e => { setTermsDaysErr(''); setTermsForm(f => ({ ...f, days: e.target.value })) }}
              placeholder={`Blank = ${DEFAULT_PAY_WITHIN_DAYS} days`}
              autoFocus
              {...fieldAria('outsta-days', termsDaysErr)}
              style={invalidStyle({ ...INPUT, width: '100%' }, termsDaysErr)}
            />
            <FieldError id="outsta-days" message={termsDaysErr} />
            {suggested != null && (
              <button type="button" className="btn btn-ghost btn-sm" style={{ marginTop: 6 }}
                onClick={() => { setTermsDaysErr(''); setTermsForm(f => ({ ...f, days: String(suggested) })) }}>
                {suggested === 0 ? 'Use 0 days (due on delivery) from the note' : `Use ${suggested} days from the note`}
              </button>
            )}
          </div>
          <div className="form-field">
            <label htmlFor="outsta-f1"><Tip text="A free-text note kept with the supplier, such as Net 30 or 50% advance. Only the number of days above decides what is overdue." width={260}>Note (optional)</Tip></label>
            <input id="outsta-f1"
              value={termsForm.note}
              onChange={e => setTermsForm(f => ({ ...f, note: e.target.value }))}
              placeholder="e.g. Net 30, COD, 50% Advance"
              style={{ ...INPUT, width: '100%' }}
            />
          </div>
          {previewOk && (
            <p style={{ fontSize: 12, color: 'var(--theme-text3)', margin: '4px 0 0' }}>
              Bills from {editingTermsVendor.name} will read: {payTermsLabel({ pay_within_days: typedDays })}.
            </p>
          )}
          <ActionError error={termsError} />
          <div className="form-actions">
            <button className="btn btn-ghost" onClick={() => setEditingTermsVendor(null)} disabled={termsSaving}>Cancel</button>
            <button className="btn btn-primary" onClick={saveTerms} disabled={termsSaving}>
              {termsSaving ? 'Saving…' : 'Save'}
            </button>
          </div>
        </Modal>
        )
      })()}

      {editingNotePayments && (
        <Modal onClose={() => setEditingNotePayments(null)} title={`Edit Note — ${editingNotePayments.count} payment${editingNotePayments.count === 1 ? '' : 's'}`}>
          <div className="form-field">
            <label htmlFor="outsta-f2">Note</label>
            <input id="outsta-f2"
              value={noteForm}
              onChange={e => setNoteForm(e.target.value)}
              placeholder="e.g. Cheque #1234, Siddhartha Bank"
              autoFocus
              style={{ ...INPUT, width: '100%' }}
            />
          </div>
          <p style={{ fontSize: 12, color: 'var(--theme-text3)', margin: '10px 0 0' }}>
            Replaces the note on all {editingNotePayments.count} selected row{editingNotePayments.count === 1 ? '' : 's'} — rows sharing the same note merge into one line on the Vendor Balance Confirmation letter.
          </p>
          <ActionError error={noteError} />
          <div className="form-actions">
            <button className="btn btn-ghost" onClick={() => setEditingNotePayments(null)}>Cancel</button>
            <button className="btn btn-primary" onClick={saveNoteForSelected} disabled={noteSaving}>
              {noteSaving ? 'Saving…' : 'Save'}
            </button>
          </div>
        </Modal>
      )}

      {editingModePayments && (
        <Modal onClose={() => setEditingModePayments(null)} title={`Edit Payment Mode — ${editingModePayments.count} payment${editingModePayments.count === 1 ? '' : 's'}`}>
          <div className="form-field">
            <label htmlFor="outsta-f3">Payment Mode</label>
            <select id="outsta-f3" className="form-select" style={{ ...INPUT, width: '100%' }}
              value={modeForm} onChange={e => setModeForm(e.target.value)}>
              {PAYMENT_MODES.map(m => <option key={m} value={m}>{m}</option>)}
            </select>
          </div>
          <p style={{ fontSize: 12, color: 'var(--theme-text3)', margin: '10px 0 0' }}>
            Sets the Payment Mode on all {editingModePayments.count} selected row{editingModePayments.count === 1 ? '' : 's'} — useful for tagging historical settlements recorded before this column existed, so they show a real value on the Vendor Balance Confirmation letter.
          </p>
          <ActionError error={modeError} />
          <div className="form-actions">
            <button className="btn btn-ghost" onClick={() => setEditingModePayments(null)}>Cancel</button>
            <button className="btn btn-primary" onClick={saveModeForSelected} disabled={modeSaving}>
              {modeSaving ? 'Saving…' : 'Save'}
            </button>
          </div>
        </Modal>
      )}

      {pendingConfirm && (
        <ConfirmModal
          title={pendingConfirm.title}
          confirmLabel={pendingConfirm.confirmLabel}
          danger={pendingConfirm.danger}
          busy={confirmBusy}
          busyLabel="Deleting…"
          onCancel={() => setPendingConfirm(null)}
          onConfirm={async () => {
            setConfirmBusy(true)
            try { await pendingConfirm.run() } finally { setConfirmBusy(false); setPendingConfirm(null) }
          }}
        >
          {pendingConfirm.body}
        </ConfirmModal>
      )}
      {confirmEl}
    </div>
  )
}
