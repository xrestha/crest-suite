import { Fragment, useEffect, useState } from 'react'
import { useAuth } from '../../../context/AuthContext'
import { useScopedDb } from '../../../shared/hooks/useScopedDb'
import { fetchAllRows } from '../../../shared/fetchAllRows'
import RowDisclosure from '../../../components/RowDisclosure'
import ReportLoadError from '../../../components/ReportLoadError'
import { supabase } from '../../../supabaseClient'
import { bsToAd, adToBs } from '../../../utils/bsCalendar'
import { calcBillTotals, billKeyOf, aging } from '../purchases/purchasesHelpers'
import Tip from '../../../components/Tip'
import BsCalendarPicker from '../../../components/BsCalendarPicker'
import Modal from '../../../components/Modal'
import { Navigate } from 'react-router-dom'

const BS_MONTHS = ['Baisakh','Jestha','Ashadh','Shrawan','Bhadra','Ashwin','Kartik','Mangsir','Poush','Magh','Falgun','Chaitra']
const TODAY = new Date().toISOString().split('T')[0]
const EPS = 0.001

// paid_at is stored as a plain AD `date` column (Postgres has no BS type), but every date shown
// to the user elsewhere in the app is BS — this page's own Payment History/Settled On columns were
// the one place still rendering the raw AD string. Found live (S511): a payment made on 2026-07-24
// displayed as "2026-07-24" here while the exact same paid_at showed correctly as "8 Shrawan 2083"
// on the Vendor Balance Confirmation letter, an inconsistency the user caught only by noticing the
// figures didn't look like the BS dates used everywhere else in the app.
function fmtBsDate(adIso) {
  if (!adIso) return null
  const { year, month, day } = adToBs(new Date(adIso))
  return `${day} ${BS_MONTHS[month - 1]} ${year}`
}
// How a Credit bill's settlement was actually paid — distinct from purchase_entries.payment_method
// (Cash/Credit/FonePay), which describes the ORIGINAL purchase, not its later settlement.
const PAYMENT_MODES = ['Cash', 'FonePay', 'Bank Transfer', 'Cheque']

const INPUT = {
  background: 'var(--theme-input-bg, var(--theme-card))',
  border: '1px solid var(--theme-border, var(--theme-border))',
  borderRadius: 'var(--radius-sm)', padding: '7px 10px', fontSize: 13,
  color: 'var(--theme-text, var(--theme-text1))', outline: 'none',
}

export default function OutstandingPayables() {
  const { clientId, profile, loading: authLoading, hasImsAccess } = useAuth()
  const effectiveClientId = clientId || profile?.client_id
  const { scopedFrom, scopedInsert, scopedDelete, scopedUpdate } = useScopedDb()

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
  const [payForm, setPayForm]           = useState({ amount: '', paid_at: TODAY, note: '', payment_mode: 'Cash' })
  const [savingPayment, setSavingPayment] = useState(false)
  const [payError, setPayError]           = useState('')

  // Bulk "pay several bills at once" — for a monthly credit run across many invoices.
  const [selectedBills, setSelectedBills] = useState(new Set())
  const [bulkForm, setBulkForm]           = useState({ paid_at: TODAY, note: '', payment_mode: 'Cash' })
  const [bulkSaving, setBulkSaving]       = useState(false)
  const [bulkError, setBulkError]         = useState('')

  // Bulk "select several payment-history rows and delete them at once" — one-by-one deletion
  // (each a click + native confirm dialog round trip) is slow when correcting a batch of
  // mis-entered payments, same reasoning as bulk-pay above.
  const [selectedPayments, setSelectedPayments] = useState(new Set())

  // Per-vendor payment terms (free text, e.g. "Net 30", "COD") — quick-editable right from this
  // page's vendor group header instead of only via the Vendors page. Fetched as its own small,
  // separately-erroring query (not folded into the main entries select) so a client whose DB
  // predates the payment_terms migration still gets a fully working Outstanding Payables page —
  // same reasoning as setupNeeded above, just scoped to this one optional column.
  const [vendorTerms, setVendorTerms]         = useState({})
  const [termsSetupNeeded, setTermsSetupNeeded] = useState(false)
  const [editingTermsVendor, setEditingTermsVendor] = useState(null)
  const [termsForm, setTermsForm]             = useState('')
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
    setLoading(true)
    setLoadError(null)
    setFilterVendor('all')
    setFilterAging('all')
    setFilterPeriod('all')
    setExpandedBill(null)
    setSelectedBills(new Set())

    // A factory, not a single builder: fetchAllRows needs a fresh query per page (a supabase-js
    // builder is a one-shot thenable). This read is unbounded by period — it spans every credit
    // bill this client has ever recorded — so it is the single most likely place in the app to
    // cross PostgREST's silent 1000-row cap, and it gets likelier the longer the system is used.
    // A truncated read here would hide genuinely outstanding bills from the payables list (S529).
    const buildQuery = () => {
      let q = supabase
        .from('purchase_entries')
        .select('id, bs_day, qty, rate, invoice_ref, paid_at, vat_inclusive, discount_amount, purchase_group_id, monthly_periods!inner(client_id, bs_year, bs_month), items(name, uom, categories(name)), vendors(id, name)')
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

    const { data, error } = await fetchAllRows(buildQuery)

    if (error) {
      // 42703 is the real "migration not applied yet" setup state; anything else is a failed read
      // and must say so — an empty payables list is a claim that nothing is owed (S612).
      if (error.code === '42703' || error.message?.includes('paid_at')) setSetupNeeded(true)
      else { setLoadError(error.message); setEntries([]); setPaymentsMap({}) }
      setLoading(false)
      return
    }

    const vendorIds = [...new Set((data || []).map(e => e.vendors?.id).filter(Boolean))]
    if (vendorIds.length > 0) {
      const { data: vt, error: vtErr } = await supabase.from('vendors').select('id, payment_terms').in('id', vendorIds)
      if (vtErr) {
        if (vtErr.code === '42703') setTermsSetupNeeded(true)
      } else {
        const map = {}
        vt.forEach(v => { map[v.id] = v.payment_terms })
        setVendorTerms(map)
        setTermsSetupNeeded(false)
      }
    }

    const today = new Date()
    const ids = (data || []).map(e => e.id)

    let pmtMap = {}
    if (ids.length > 0) {
      const { data: pmts, error: pmtErr } = await scopedFrom('payable_payments')
        .in('purchase_entry_id', ids)
        .order('paid_at', { ascending: true })
      // A failed payments read would render every credit bill as fully unpaid (S612).
      if (pmtErr) { setLoadError(pmtErr.message); setEntries([]); setPaymentsMap({}); setLoading(false); return }
      ;(pmts || []).forEach(p => {
        if (!pmtMap[p.purchase_entry_id]) pmtMap[p.purchase_entry_id] = []
        pmtMap[p.purchase_entry_id].push(p)
      })
    }
    setPaymentsMap(pmtMap)

    // Goods sent back reduce what's owed. ReturnsTab always writes purchase_entry_id (it refuses
    // to save without one) and copies the linked purchase's payment_method, so a return against a
    // Credit bill is always attributable to the exact line it cancels — no allocation guesswork.
    let returnedByEntry = {}
    if (ids.length > 0) {
      const { data: rets, error: retErr } = await scopedFrom('vendor_returns', 'purchase_entry_id, qty, rate')
        .in('purchase_entry_id', ids)
      // A failed returns read would overstate what's owed on every returned bill (S612).
      if (retErr) { setLoadError(retErr.message); setEntries([]); setPaymentsMap({}); setLoading(false); return }
      ;(rets || []).forEach(r => {
        returnedByEntry[r.purchase_entry_id] =
          (returnedByEntry[r.purchase_entry_id] || 0) + parseFloat(r.qty || 0) * parseFloat(r.rate || 0)
      })
    }

    const enriched = (data || []).map(e => {
      const pr = e.monthly_periods
      const adDate = bsToAd(pr.bs_year, pr.bs_month, e.bs_day || 1)
      const daysOld = Math.max(0, Math.floor((today - adDate) / (1000 * 60 * 60 * 24)))
      // Net of returns, still EXCLUDING bill-level discount and VAT — those are bill-level, not
      // line-level, so they're applied in the grouping pass below.
      const netLine = Math.max(0, parseFloat(e.qty) * parseFloat(e.rate) - (returnedByEntry[e.id] || 0))
      const paidTotal = (pmtMap[e.id] || []).reduce((s, p) => s + parseFloat(p.amount), 0)
      return { ...e, period: pr, netLine, paidTotal, daysOld, aging: aging(daysOld), billKey: billKeyOf(e, pr) }
    })

    // What this page shows must be what the vendor actually invoiced. `value` used to be a bare
    // qty × rate: no VAT, no bill discount, no returns — so a VAT-inclusive credit bill read ~13%
    // LOW and "Settle Bill" marked it fully paid at 88.5% of the real amount, while discounts and
    // returns pushed it the other way. calcBillTotals() is the same function PurchaseBillModal's
    // live total and the printed voucher use, so routing through it is what makes the three agree.
    //
    // The grand total is then spread back across the bill's lines in proportion to their net
    // value, because payments allocate per purchase_entry_id — keeping `value` per-line means the
    // existing payment/settle logic needs no changes at all.
    const byBill = {}
    enriched.forEach(e => { (byBill[e.billKey] = byBill[e.billKey] || []).push(e) })
    Object.values(byBill).forEach(lines => {
      // discount_amount is stored on every row of a bill but represents ONE bill-level discount,
      // so it's deduped per purchase_group_id before summing (same as VendorReport does).
      const discountByGroup = {}
      lines.forEach(l => { discountByGroup[l.purchase_group_id || l.id] = parseFloat(l.discount_amount || 0) })
      const billDiscount = Object.values(discountByGroup).reduce((s, d) => s + d, 0)
      // qty 1 × rate netLine: calcBillTotals only ever multiplies the two, and the returns
      // netting above already collapsed each line to a single net figure.
      const { grandTotal } = calcBillTotals(
        lines.map(l => ({ qty: 1, rate: l.netLine, vat_inclusive: l.vat_inclusive })),
        billDiscount
      )
      // Rounded to currency precision immediately — a per-line rate can carry 3+ decimals (e.g.
      // NPR/gram costing), so the bill's true net total can land sub-paisa (e.g. NPR 1400.00175)
      // even though every displayed figure shows only 2dp. Left unrounded, "Pay in full" (which
      // pre-fills the editable amount via `.toFixed(2)`) silently truncates that fraction, and
      // Math.min(amount, bill.remaining) then caps the actual payment a hair below the unrounded
      // bill.remaining — the shortfall lands entirely on whichever line allocatePayment() processes
      // last, since its written amount still rounds to a clean figure but the RAW allocation used
      // for the settle check falls just short of e.value, so that line quietly never gets marked
      // paid_at despite showing "fully paid" in the Payment History. Found live (S510): a 5-line
      // bill with two 3-decimal rates left its last line (a clean NPR 120) stuck unsettled after a
      // "Pay in full" that should have closed it. Same fix vendorBalanceHelpers.js's
      // billGrandTotal() already applies for the identical root cause.
      const netSum = lines.reduce((s, l) => s + l.netLine, 0)
      lines.forEach(l => {
        l.value = netSum > 0 ? Math.round(l.netLine * (grandTotal / netSum) * 100) / 100 : 0
        l.remaining = Math.max(0, Math.round((l.value - l.paidTotal) * 100) / 100)
      })
    })
    setEntries(enriched)
    setLoading(false)
  }

  function switchTab(tab) { setActiveTab(tab); load(tab) }

  function toggleBill(key) {
    setExpandedBill(prev => prev === key ? null : key)
    setPayForm({ amount: '', paid_at: TODAY, note: '', payment_mode: 'Cash' })
    setPayError('')
  }

  // Allocates a payment amount across a bill's unpaid lines, oldest-first, rounding each line's
  // share via a running-cumulative technique (round the cumulative allocated-so-far total at each
  // step, take the difference) instead of rounding each line's raw proportional share
  // independently. The naive per-line rounding can lose fractions of a paisa across several lines
  // — found live: a 10-line "Pay in full" landed a paisa short of the real bill total, leaving a
  // permanently uncollectable NPR 0.01 balance the UI has no way to ever fully clear. This
  // guarantees the inserted rows always sum to exactly the rounded payment amount. Shared by
  // payBill() and paySelectedBills() (bulk pay) so the two can't independently drift on this.
  function allocatePayment(entries, amount, date, note, paymentMode) {
    let left = amount
    let rawAllocatedSoFar = 0
    let roundedAllocatedSoFar = 0
    const rows = []
    const settleIds = []
    for (const e of entries) {
      if (left <= EPS) break
      if (e.remaining <= EPS) continue
      const rawAlloc = Math.min(e.remaining, left)
      rawAllocatedSoFar += rawAlloc
      const cumulativeRounded = Math.round(rawAllocatedSoFar * 100) / 100
      const alloc = Math.round((cumulativeRounded - roundedAllocatedSoFar) * 100) / 100
      roundedAllocatedSoFar = cumulativeRounded
      left -= rawAlloc
      if (alloc <= 0) continue
      rows.push({ purchase_entry_id: e.id, amount: alloc, paid_at: date, note, payment_mode: paymentMode || null })
      if (e.paidTotal + rawAlloc >= e.value - EPS) settleIds.push(e.id)
    }
    return { rows, settleIds }
  }

  // payment_mode may not exist on payable_payments yet if this client's DB predates the migration
  // (this project applies schema changes by hand in the dashboard) — retry once without it rather
  // than letting the whole Save fail, same tolerance persistSalesDay.js uses for its own RPC.
  // PostgREST validates INSERT columns against its own schema cache and reports a missing one as
  // PGRST204 ("Could not find the 'x' column ... in the schema cache"), NOT the raw Postgres 42703
  // undefined_column code — 42703 only surfaces on a SELECT that reaches Postgres itself. Confirmed
  // live: catching only 42703 here let this exact error reach the user instead of falling back.
  async function insertPayments(rows) {
    let { error } = await scopedInsert('payable_payments', rows)
    if (error?.code === 'PGRST204') {
      ;({ error } = await scopedInsert('payable_payments', rows.map(({ payment_mode, ...r }) => r)))
    }
    return { error }
  }

  // One payment for a whole bill — distributed across its unpaid line items (oldest first).
  async function payBill(bill) {
    let amount = parseFloat(payForm.amount)
    if (!amount || amount <= 0) return
    if (!effectiveClientId) { setPayError('No client selected. Pick a client in the top-left switcher before saving.'); return }
    amount = Math.min(amount, bill.remaining) // never over-pay the bill
    setSavingPayment(true)
    setPayError('')
    const date = payForm.paid_at || TODAY
    const note = payForm.note || null

    const { rows, settleIds } = allocatePayment(bill.entries, amount, date, note, payForm.payment_mode)
    if (rows.length === 0) { setSavingPayment(false); return }

    const { error: insErr } = await insertPayments(rows)
    if (insErr) { setPayError(insErr.message || 'Failed to save payment.'); setSavingPayment(false); return }
    if (settleIds.length > 0) {
      await supabase.from('purchase_entries').update({ paid_at: date }).in('id', settleIds)
    }
    setSavingPayment(false)
    load(activeTab)
  }

  function openEditTerms(vendor) {
    setEditingTermsVendor(vendor)
    setTermsForm(vendorTerms[vendor.id] || '')
    // Surface the one-time-setup message immediately on open (rather than only after a failed
    // save) when the payment_terms column isn't deployed yet — keeps the button itself always
    // visible/discoverable instead of hiding the whole feature until someone runs the migration.
    setTermsError(termsSetupNeeded
      ? 'Needs a one-time database setup. Run this in Supabase → SQL Editor, then try again: ALTER TABLE vendors ADD COLUMN IF NOT EXISTS payment_terms text;'
      : '')
  }

  async function saveTerms() {
    if (!editingTermsVendor) return
    setTermsSaving(true)
    setTermsError('')
    const trimmed = termsForm.trim() || null
    const { error } = await scopedUpdate('vendors', { payment_terms: trimmed }).eq('id', editingTermsVendor.id)
    setTermsSaving(false)
    if (error) {
      setTermsError(error.code === '42703'
        ? 'Needs a one-time database setup. Run this in Supabase → SQL Editor, then try again: ALTER TABLE vendors ADD COLUMN IF NOT EXISTS payment_terms text;'
        : (error.message || 'Failed to save payment terms.'))
      return
    }
    setVendorTerms(prev => ({ ...prev, [editingTermsVendor.id]: trimmed }))
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
  async function deleteSelectedPayments(bill) {
    const toDelete = bill.payments.filter(p => selectedPayments.has(p.id))
    if (toDelete.length === 0) return
    const total = toDelete.reduce((s, p) => s + parseFloat(p.amount), 0)
    if (!window.confirm(`Delete ${toDelete.length} selected payment${toDelete.length === 1 ? '' : 's'} totaling ${fmt(total)}? This cannot be undone.`)) return
    const ids = toDelete.map(p => p.id)
    const { error } = await scopedDelete('payable_payments').in('id', ids)
    if (error) { alert(error.message || 'Failed to delete payments.'); return }
    // Always clear paid_at on any affected line rather than re-checking against entry.value —
    // that field is a proportional split of the bill's grand total across whichever lines are
    // CURRENTLY still marked paid, which becomes unreliable (even negative) once a bill-level
    // fixed discount is left dividing an ever-shrinking subset of lines mid-cleanup. A false
    // "still fully paid" after this is always safe to re-settle with Pay Bill; silently leaving a
    // $0-paid line marked paid is not.
    const affectedEntryIds = [...new Set(toDelete.map(p => p.purchase_entry_id))]
      .filter(id => entries.find(e => e.id === id)?.paid_at)
    if (affectedEntryIds.length > 0) {
      await supabase.from('purchase_entries').update({ paid_at: null }).in('id', affectedEntryIds)
    }
    setSelectedPayments(new Set())
    load(activeTab)
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
    const { error } = await scopedUpdate('payable_payments', { note: trimmed }).in('id', editingNotePayments.ids)
    setNoteSaving(false)
    if (error) { setNoteError(error.message || 'Failed to save note.'); return }
    setEditingNotePayments(null)
    setSelectedPayments(new Set())
    load(activeTab)
  }

  // Bulk-set one Payment Mode across whichever payment rows are checked — same shape as
  // openEditNote()/saveNoteForSelected() above, mainly for tagging historical settlements that
  // predate the payment_mode column so they show a real value on the Vendor Balance Confirmation
  // letter instead of a blank Payment Mode cell.
  function openEditMode(bill) {
    const targets = bill.payments.filter(p => selectedPayments.has(p.id))
    if (targets.length === 0) return
    setEditingModePayments({ ids: targets.map(p => p.id), count: targets.length })
    setModeForm(targets[0].payment_mode || PAYMENT_MODES[0])
    setModeError('')
  }

  async function saveModeForSelected() {
    if (!editingModePayments) return
    setModeSaving(true)
    setModeError('')
    const { error } = await scopedUpdate('payable_payments', { payment_mode: modeForm }).in('id', editingModePayments.ids)
    setModeSaving(false)
    if (error) { setModeError(error.message || 'Failed to save payment mode.'); return }
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
    const date = bulkForm.paid_at || TODAY
    const note = bulkForm.note || null

    const rows = []
    const settleIds = []
    targets.forEach(bill => {
      const alloc = allocatePayment(bill.entries, bill.remaining, date, note, bulkForm.payment_mode)
      rows.push(...alloc.rows)
      settleIds.push(...alloc.settleIds)
    })
    if (rows.length === 0) { setBulkSaving(false); return }

    const { error: insErr } = await insertPayments(rows)
    if (insErr) { setBulkError(insErr.message || 'Failed to save payments.'); setBulkSaving(false); return }
    if (settleIds.length > 0) {
      await supabase.from('purchase_entries').update({ paid_at: date }).in('id', settleIds)
    }
    setBulkSaving(false)
    setBulkForm({ paid_at: TODAY, note: '', payment_mode: 'Cash' })
    load(activeTab)
  }

  function fmt(v) { return `NPR ${Number(v).toLocaleString('en-NP', { maximumFractionDigits: 0 })}` }

  // ── Group line entries into BILLS (vendor + invoice + period + day) ──
  const vendors = [...new Map(entries.map(e => [e.vendors?.name, e.vendors])).values()].filter(Boolean)
  const vendorByName = Object.fromEntries(vendors.map(v => [v.name, v]))
  const AGING_LABELS = ['Current', '31–60 days', '61–90 days', '90+ days']

  const billMap = {}
  entries.forEach(e => {
    const vName = e.vendors?.name || 'Unknown'
    // e.billKey is stamped in load() by the same billKeyOf() the grand-total pass grouped on —
    // reusing it here is what guarantees bill.total equals the total that was actually computed.
    const key = e.billKey
    if (!billMap[key]) billMap[key] = { key, vendorName: vName, invoice_ref: e.invoice_ref, period: e.period, bs_day: e.bs_day, entries: [] }
    billMap[key].entries.push(e)
  })
  const bills = Object.values(billMap).map(b => {
    const total     = b.entries.reduce((s, e) => s + e.value, 0)
    const paid      = b.entries.reduce((s, e) => s + e.paidTotal, 0)
    const remaining = b.entries.reduce((s, e) => s + e.remaining, 0)
    const daysOld   = Math.max(0, ...b.entries.map(e => e.daysOld))
    const payments  = b.entries.flatMap(e => (paymentsMap[e.id] || [])).sort((x, y) => (x.paid_at > y.paid_at ? 1 : -1))
    const settledOn = b.entries.map(e => e.paid_at).filter(Boolean).sort().slice(-1)[0] || null
    return { ...b, total, paid, remaining, daysOld, aging: aging(daysOld), isPartial: paid > EPS && remaining > EPS, payments, settledOn }
  })

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

  const byVendor = {}
  filteredBills.forEach(b => { (byVendor[b.vendorName] = byVendor[b.vendorName] || []).push(b) })

  const totalRemaining = filteredBills.reduce((s, b) => s + (activeTab === 'outstanding' ? b.remaining : b.total), 0)
  const overdueBills   = filteredBills.filter(b => b.daysOld > 60).length
  const urgentValue    = filteredBills.filter(b => b.daysOld > 90).reduce((s, b) => s + b.remaining, 0)

  const selectedBillObjs = bills.filter(b => selectedBills.has(b.key) && b.remaining > EPS)
  const selectedTotal    = selectedBillObjs.reduce((s, b) => s + b.remaining, 0)

  if (!hasImsAccess('manager')) return <Navigate to="/dashboard" replace />

  return (
    <div>
      <div className="page-header">
        <div>
          <h1 className="page-title">Outstanding Payables</h1>
          <p className="page-subtitle">
            {activeTab === 'outstanding' ? 'Unpaid credit bills — pay the whole invoice in one go' : 'Settled credit bills — payment history'}
          </p>
        </div>
      </div>

      <div className="tab-bar" style={{ marginBottom: 24 }}>
        <button className={`tab-btn${activeTab === 'outstanding' ? ' tab-btn--active' : ''}`} onClick={() => switchTab('outstanding')}>Outstanding</button>
        <button className={`tab-btn${activeTab === 'paid'        ? ' tab-btn--active' : ''}`} onClick={() => switchTab('paid')}>Paid History</button>
      </div>

      {/* A failed read renders as a failure — an empty payables list claims nothing is owed (S612). */}
      {loadError && <ReportLoadError error={loadError} />}

      {setupNeeded && (
        <div style={{ background: 'rgba(248,113,113,0.08)', border: '1px solid rgba(248,113,113,0.3)', borderRadius: 'var(--radius-sm)', padding: '16px 20px', marginBottom: 24, fontSize: 13 }}>
          <div style={{ fontWeight: 700, color: 'var(--theme-red-text)', marginBottom: 8 }}>⚠ One-time setup required</div>
          <div style={{ color: 'var(--theme-text3)', marginBottom: 10 }}>Run this SQL in Supabase → SQL Editor, then refresh:</div>
          <code style={{ display: 'block', background: 'var(--theme-bg)', padding: '10px 14px', borderRadius: 'var(--radius-sm)', color: 'var(--theme-accent-ink)', fontSize: 12, userSelect: 'all' }}>
            ALTER TABLE purchase_entries ADD COLUMN IF NOT EXISTS paid_at date;
          </code>
        </div>
      )}

      {!loadError && !loading && (
      <div className="stat-grid" style={{ marginBottom: 24 }}>
        {activeTab === 'outstanding' ? (<>
          <div className="stat-card">
            <div className="stat-label"><Tip text="Total remaining balance across all outstanding credit bills, less any payments already recorded. Bill amounts match the vendor's invoice: net of goods returned and any bill discount, plus 13% VAT on VAT-inclusive lines." width={280}>Total Remaining</Tip></div>
            <div className="stat-value" style={{ fontSize: 18, color: totalRemaining > 0 ? 'var(--theme-red-text)' : 'var(--theme-text2)' }}>{fmt(totalRemaining)}</div>
            <div className="stat-sub">{filteredBills.length} bill{filteredBills.length !== 1 ? 's' : ''} · {Object.keys(byVendor).length} vendor{Object.keys(byVendor).length !== 1 ? 's' : ''}</div>
          </div>
          <div className="stat-card">
            <div className="stat-label"><Tip text="Bills with a remaining balance older than 60 days." width={230}>Overdue Bills</Tip></div>
            <div className="stat-value" style={{ color: overdueBills > 0 ? 'var(--theme-amber-text)' : 'var(--theme-text2)' }}>{overdueBills}</div>
            <div className="stat-sub">&gt;60 days outstanding</div>
          </div>
          <div className="stat-card">
            <div className="stat-label"><Tip text="Remaining value on bills over 90 days old. Urgent settlement needed." width={240}>90+ Day Value</Tip></div>
            <div className="stat-value" style={{ fontSize: 16, color: urgentValue > 0 ? 'var(--theme-red-text)' : 'var(--theme-text2)' }}>{urgentValue > 0 ? fmt(urgentValue) : '—'}</div>
            <div className="stat-sub">Urgent settlement</div>
          </div>
        </>) : (<>
          <div className="stat-card">
            <div className="stat-label"><Tip text="Total invoiced value of all fully settled credit bills — net of returns and discount, including VAT where applicable." width={260}>Total Paid</Tip></div>
            <div className="stat-value" style={{ fontSize: 18, color: 'var(--theme-green-text)' }}>{fmt(totalRemaining)}</div>
            <div className="stat-sub">{filteredBills.length} settled bill{filteredBills.length !== 1 ? 's' : ''}</div>
          </div>
          <div className="stat-card">
            <div className="stat-label">Vendors Paid</div>
            <div className="stat-value">{Object.keys(byVendor).length}</div>
            <div className="stat-sub">Unique vendors settled</div>
          </div>
          <div className="stat-card">
            <div className="stat-label"><Tip text="Most recently settled bill date." width={200}>Last Settlement</Tip></div>
            <div className="stat-value" style={{ fontSize: 14 }}>{filteredBills.length > 0 ? (fmtBsDate(filteredBills[0].settledOn) || '—') : '—'}</div>
            <div className="stat-sub">{filteredBills.length > 0 ? filteredBills[0].vendorName : ''}</div>
          </div>
        </>)}
      </div>
      )}

      {!loadError && (
      <div style={{ display: 'flex', gap: 20, marginBottom: 20, flexWrap: 'wrap', alignItems: 'center' }}>
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
        <div className="card" style={{
          marginBottom: 20, padding: '14px 20px', display: 'flex', gap: 14, alignItems: 'flex-end', flexWrap: 'wrap',
          border: '1px solid color-mix(in srgb, var(--theme-accent) 40%, transparent)',
          background: 'color-mix(in srgb, var(--theme-accent) 6%, transparent)',
        }}>
          <div>
            <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--theme-text1)' }}>
              {selectedBillObjs.length} bill{selectedBillObjs.length !== 1 ? 's' : ''} selected
            </div>
            <div style={{ fontSize: 13, color: 'var(--theme-accent-ink)', fontWeight: 700 }}>{fmt(selectedTotal)} total</div>
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
            <input type="text" style={{ ...INPUT, width: '100%' }} placeholder="e.g. Monthly batch payment"
              value={bulkForm.note} onChange={ev => setBulkForm(f => ({ ...f, note: ev.target.value }))} />
          </div>
          <button className="btn btn-ghost" style={{ padding: '8px 14px', fontSize: 12 }} onClick={() => setSelectedBills(new Set())}>Clear</button>
          <button className="btn btn-primary" style={{ padding: '8px 18px', fontSize: 13 }}
            disabled={bulkSaving || selectedBillObjs.length === 0}
            onClick={() => paySelectedBills(selectedBillObjs)}>
            {bulkSaving ? '…' : `Pay ${selectedBillObjs.length} Bill${selectedBillObjs.length !== 1 ? 's' : ''} in Full`}
          </button>
          {bulkError && <div style={{ width: '100%', fontSize: 12, color: 'var(--theme-red-text)' }}>⚠ {bulkError}</div>}
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
        Object.entries(byVendor)
          .sort(([, a], [, b]) =>
            b.reduce((s, x) => s + x.remaining, 0) - a.reduce((s, x) => s + x.remaining, 0))
          .map(([vName, vBills]) => {
            const vendorTotal = vBills.reduce((s, b) => s + (activeTab === 'outstanding' ? b.remaining : b.total), 0)
            const sorted = activeTab === 'outstanding' ? [...vBills].sort((a, b) => b.daysOld - a.daysOld) : vBills
            const cols = activeTab === 'outstanding' ? 10 : 6
            const vKeys = sorted.map(b => b.key)
            const vBillTotal = sorted.reduce((s, b) => s + b.total, 0)
            const vPaidTotal = sorted.reduce((s, b) => s + b.paid, 0)
            const vRemainingTotal = sorted.reduce((s, b) => s + b.remaining, 0)
            return (
              <div key={vName} className="card" style={{ marginBottom: 16 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16, paddingBottom: 12, borderBottom: '1px solid var(--theme-border)' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    <span style={{ fontWeight: 700, fontSize: 14, color: 'var(--theme-text1)' }}>{vName}</span>
                    {vendorByName[vName] && (<>
                      {!termsSetupNeeded && (
                        <span style={{ fontSize: 12, color: 'var(--theme-text3)' }}>
                          {vendorTerms[vendorByName[vName].id] ? `Terms: ${vendorTerms[vendorByName[vName].id]}` : 'No payment terms set'}
                        </span>
                      )}
                      <button className="btn btn-ghost" style={{ fontSize: 11, padding: '3px 10px' }}
                        onClick={() => openEditTerms(vendorByName[vName])}>
                        Edit Terms
                      </button>
                    </>)}
                  </div>
                  <span style={{ fontSize: 14, fontWeight: 700, color: activeTab === 'outstanding' ? 'var(--theme-red-text)' : 'var(--theme-green-text)' }}>{fmt(vendorTotal)}</span>
                </div>
                <div className="table-wrap">
                  <table className="data-table">
                    <thead>
                      <tr>
                        {activeTab === 'outstanding' && (
                          <th style={{ width: 28 }}>
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
                          <th style={{ textAlign: 'right' }}>Paid</th>
                          <th style={{ textAlign: 'right' }}>Remaining</th>
                          <th style={{ textAlign: 'right' }}><Tip text="Calendar days since the bill date." width={180}>Days</Tip></th>
                          <th>Status</th>
                          <th></th>
                        </>) : (<>
                          <th>Settled On</th>
                          <th></th>
                        </>)}
                      </tr>
                    </thead>
                    <tbody>
                      {sorted.map(b => {
                        const isExpanded = expandedBill === b.key
                        const willSettle = payForm.amount && parseFloat(payForm.amount) + b.paid >= b.total - EPS
                        return (
                          <Fragment key={b.key}>
                            {/* The <tr> keeps its implicit `row` role: role="button" on a row takes it out of the
                                table's structure and its cells stop being associated with their column headers.
                                The control lives in a cell instead — see components/RowDisclosure.jsx (S595). */}
                            <tr style={{ cursor: 'pointer' }} onClick={() => toggleBill(b.key)}>
                              {activeTab === 'outstanding' && (
                                <td onClick={ev => ev.stopPropagation()}>
                                  <input type="checkbox" checked={selectedBills.has(b.key)} onChange={() => toggleSelectBill(b.key)}
                                    aria-label={`Select bill ${b.invoice_ref || ''}`} />
                                </td>
                              )}
                              <td style={{ fontWeight: 600, color: 'var(--theme-text1)' }}>
                                <RowDisclosure
                                  expanded={isExpanded}
                                  onToggle={() => toggleBill(b.key)}
                                  controls={`bill-detail-${b.key}`}
                                  label={`Bill ${b.invoice_ref || 'without an invoice number'} — ${isExpanded ? 'hide' : 'show'} line items and payment history`}
                                />{' '}
                                #{b.invoice_ref || '—'}
                              </td>
                              <td style={{ color: 'var(--theme-text2)' }}>{BS_MONTHS[(b.period.bs_month || 1) - 1]} {b.period.bs_year}</td>
                              <td style={{ textAlign: 'right', color: 'var(--theme-text2)' }}>{b.entries.length}</td>
                              <td style={{ textAlign: 'right', fontWeight: 600, color: 'var(--theme-accent-ink)' }}>{fmt(b.total)}</td>
                              {activeTab === 'outstanding' ? (<>
                                <td style={{ textAlign: 'right', color: b.paid > 0 ? 'var(--theme-green-text)' : 'var(--theme-text2)' }}>{b.paid > 0 ? fmt(b.paid) : '—'}</td>
                                <td style={{ textAlign: 'right', fontWeight: 700, color: 'var(--theme-red-text)' }}>{fmt(b.remaining)}</td>
                                <td style={{ textAlign: 'right', fontWeight: 700, color: b.aging.color }}>{b.daysOld}</td>
                                <td>
                                  {b.isPartial
                                    ? <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--theme-purple-text)', background: 'color-mix(in srgb, var(--theme-purple) 12%, transparent)', border: '1px solid color-mix(in srgb, var(--theme-purple) 40%, transparent)', borderRadius: 'var(--radius-xs)', padding: '2px 8px', whiteSpace: 'nowrap' }}>Partial</span>
                                    : <span style={{ fontSize: 11, fontWeight: 700, color: b.aging.color, background: `color-mix(in srgb, ${b.aging.color} 12%, transparent)`, border: `1px solid color-mix(in srgb, ${b.aging.color} 40%, transparent)`, borderRadius: 'var(--radius-xs)', padding: '2px 8px', whiteSpace: 'nowrap' }}>{b.aging.label}</span>
                                  }
                                </td>
                                <td style={{ color: 'var(--theme-accent-ink)', fontSize: 12, whiteSpace: 'nowrap' }}>{isExpanded ? '▲ Close' : '＋ Pay Bill'}</td>
                              </>) : (<>
                                <td style={{ color: 'var(--theme-green-text)', fontWeight: 600, fontSize: 13 }}>{fmtBsDate(b.settledOn) || '—'}</td>
                                <td style={{ color: 'var(--theme-text3)', fontSize: 12, whiteSpace: 'nowrap' }}>{isExpanded ? '▲ Hide' : '▼ Details'}</td>
                              </>)}
                            </tr>

                            {isExpanded && (
                              <tr id={`bill-detail-${b.key}`}>
                                <td colSpan={cols} style={{ padding: 0, background: 'rgba(10,12,18,0.7)' }}>
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
                                            <td style={{ padding: '4px 16px', textAlign: 'right', color: 'var(--theme-text2)' }}>{parseFloat(e.qty).toLocaleString()} {e.items?.uom}</td>
                                            <td style={{ padding: '4px 16px', textAlign: 'right', color: 'var(--theme-text2)' }}>{parseFloat(e.rate).toLocaleString()}</td>
                                            <td style={{ padding: '4px 0 4px 16px', textAlign: 'right', color: 'var(--theme-accent-ink)', fontWeight: 600 }}>{fmt(e.value)}</td>
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
                                            <button className="btn btn-ghost" style={{ fontSize: 11, padding: '2px 10px' }}
                                              onClick={ev => { ev.stopPropagation(); openEditMode(b) }}>
                                              Edit Payment Mode ({selectedHere.length})
                                            </button>
                                            <button className="btn btn-ghost" style={{ fontSize: 11, padding: '2px 10px' }}
                                              onClick={ev => { ev.stopPropagation(); openEditNote(b) }}>
                                              Edit Note ({selectedHere.length})
                                            </button>
                                            <button className="btn btn-danger" style={{ fontSize: 11, padding: '2px 10px' }}
                                              onClick={ev => { ev.stopPropagation(); deleteSelectedPayments(b) }}>
                                              Delete Selected ({selectedHere.length})
                                            </button>
                                          </>)}
                                        </div>
                                        <table style={{ borderCollapse: 'collapse', fontSize: 13, minWidth: 400 }}>
                                          <thead>
                                            <tr>
                                              <th style={{ padding: '0 16px 5px 0' }}>
                                                <input type="checkbox" checked={selectedHere.length === paymentIds.length}
                                                  onChange={ev => { ev.stopPropagation(); toggleSelectPayments(paymentIds) }}
                                                  onClick={ev => ev.stopPropagation()} title="Select all payments in this bill" />
                                              </th>
                                              <th /><th /><th /><th />
                                            </tr>
                                          </thead>
                                          <tbody>
                                            {b.payments.map(p => (
                                              <tr key={p.id}>
                                                <td style={{ padding: '5px 16px 5px 0' }}>
                                                  <input type="checkbox" checked={selectedPayments.has(p.id)}
                                                    onChange={ev => { ev.stopPropagation(); toggleSelectPayment(p.id) }}
                                                    onClick={ev => ev.stopPropagation()} />
                                                </td>
                                                <td style={{ padding: '5px 16px 5px 0', color: 'var(--theme-green-text)' }}>{fmtBsDate(p.paid_at)}</td>
                                                <td style={{ padding: '5px 16px', textAlign: 'right', color: 'var(--theme-text1)', fontWeight: 600 }}>{fmt(p.amount)}</td>
                                                <td style={{ padding: '5px 16px', color: 'var(--theme-text3)' }}>{p.payment_mode || '—'}</td>
                                                <td style={{ padding: '5px 0 5px 16px', color: 'var(--theme-text3)' }}>{p.note || '—'}</td>
                                              </tr>
                                            ))}
                                            <tr style={{ borderTop: '1px solid var(--theme-border)' }}>
                                              <td />
                                              <td style={{ padding: '5px 16px 5px 0', color: 'var(--theme-text2)', fontSize: 11 }}>Total paid</td>
                                              <td style={{ padding: '5px 16px', textAlign: 'right', fontWeight: 700, color: 'var(--theme-green-text)' }}>{fmt(b.paid)}</td>
                                              <td />
                                              <td />
                                            </tr>
                                          </tbody>
                                        </table>
                                      </div>
                                      )
                                    })()}

                                    {/* Record one payment for the whole bill — outstanding only */}
                                    {activeTab === 'outstanding' && (
                                      <div>
                                        <div style={{ fontSize: 11, color: 'var(--theme-text3)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 10 }}>
                                          {b.payments.length === 0 ? 'Pay this bill' : 'Add payment'}
                                          <span style={{ textTransform: 'none', letterSpacing: 0, color: 'var(--theme-text2)', marginLeft: 8 }}>· applied across all {b.entries.length} item{b.entries.length !== 1 ? 's' : ''}</span>
                                        </div>
                                        <div style={{ display: 'flex', gap: 10, alignItems: 'flex-end', flexWrap: 'wrap' }}>
                                          <div>
                                            <div style={{ fontSize: 11, color: 'var(--theme-text2)', marginBottom: 4 }}>Amount (NPR)</div>
                                            <input type="number" style={{ ...INPUT, width: 150 }} placeholder={`full: ${fmt(b.remaining)}`}
                                              value={payForm.amount}
                                              onChange={ev => setPayForm(f => ({ ...f, amount: ev.target.value }))}
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
                                            <input type="text" style={{ ...INPUT, width: '100%' }} placeholder="e.g. Cheque #1234"
                                              value={payForm.note}
                                              onChange={ev => setPayForm(f => ({ ...f, note: ev.target.value }))}
                                              onClick={ev => ev.stopPropagation()} />
                                          </div>
                                          <button className="btn btn-ghost" style={{ padding: '8px 14px', fontSize: 12 }}
                                            onClick={ev => { ev.stopPropagation(); setPayForm(f => ({ ...f, amount: String(Number(b.remaining.toFixed(2))) })) }}>
                                            Pay in full
                                          </button>
                                          <button className="btn btn-primary" style={{ padding: '8px 18px', fontSize: 13 }}
                                            disabled={!payForm.amount || parseFloat(payForm.amount) <= 0 || savingPayment}
                                            onClick={ev => { ev.stopPropagation(); payBill(b) }}>
                                            {savingPayment ? '…' : 'Save'}
                                          </button>
                                        </div>
                                        {payError && <div style={{ marginTop: 8, fontSize: 12, color: 'var(--theme-red-text)' }}>⚠ {payError}</div>}
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
                        {activeTab === 'outstanding' ? (<>
                          <td colSpan={4} style={{ fontWeight: 700, color: 'var(--theme-text2)', paddingTop: 12 }}>Total</td>
                          <td style={{ textAlign: 'right', fontWeight: 700, color: 'var(--theme-accent-ink)', paddingTop: 12 }}>{fmt(vBillTotal)}</td>
                          <td style={{ textAlign: 'right', fontWeight: 700, color: 'var(--theme-green-text)', paddingTop: 12 }}>{vPaidTotal > 0 ? fmt(vPaidTotal) : '—'}</td>
                          <td style={{ textAlign: 'right', fontWeight: 700, color: 'var(--theme-red-text)', paddingTop: 12 }}>{fmt(vRemainingTotal)}</td>
                          <td colSpan={3} style={{ paddingTop: 12 }}></td>
                        </>) : (<>
                          <td colSpan={3} style={{ fontWeight: 700, color: 'var(--theme-text2)', paddingTop: 12 }}>Total</td>
                          <td style={{ textAlign: 'right', fontWeight: 700, color: 'var(--theme-green-text)', paddingTop: 12 }}>{fmt(vBillTotal)}</td>
                          <td colSpan={2} style={{ paddingTop: 12 }}></td>
                        </>)}
                      </tr>
                    </tbody>
                  </table>
                </div>
              </div>
            )
          })
      )}

      {editingTermsVendor && (
        <Modal onClose={() => setEditingTermsVendor(null)} title={`Payment Terms — ${editingTermsVendor.name}`}>
          <div className="form-field">
            <label htmlFor="outsta-f1">Payment Terms</label>
            <input id="outsta-f1"
              value={termsForm}
              onChange={e => setTermsForm(e.target.value)}
              placeholder="e.g. Net 30, COD, 50% Advance"
              autoFocus
              style={{ ...INPUT, width: '100%' }}
            />
          </div>
          {termsError && <p style={{ color: 'var(--theme-red-text)', fontSize: 13, margin: '12px 0 0' }}>{termsError}</p>}
          <div className="form-actions">
            <button className="btn btn-ghost" onClick={() => setEditingTermsVendor(null)}>Cancel</button>
            <button className="btn btn-primary" onClick={saveTerms} disabled={termsSaving}>
              {termsSaving ? 'Saving…' : 'Save'}
            </button>
          </div>
        </Modal>
      )}

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
          {noteError && <p style={{ color: 'var(--theme-red-text)', fontSize: 13, margin: '12px 0 0' }}>{noteError}</p>}
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
          {modeError && <p style={{ color: 'var(--theme-red-text)', fontSize: 13, margin: '12px 0 0' }}>{modeError}</p>}
          <div className="form-actions">
            <button className="btn btn-ghost" onClick={() => setEditingModePayments(null)}>Cancel</button>
            <button className="btn btn-primary" onClick={saveModeForSelected} disabled={modeSaving}>
              {modeSaving ? 'Saving…' : 'Save'}
            </button>
          </div>
        </Modal>
      )}
    </div>
  )
}
