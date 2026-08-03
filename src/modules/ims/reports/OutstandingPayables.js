import { Fragment, useEffect, useState } from 'react'
import { useAuth } from '../../../context/AuthContext'
import { useScopedDb } from '../../../shared/hooks/useScopedDb'
import { supabase } from '../../../supabaseClient'
import { bsToAd } from '../../../utils/bsCalendar'
import { calcBillTotals, billKeyOf, aging } from '../purchases/purchasesHelpers'
import Tip from '../../../components/Tip'
import BsCalendarPicker from '../../../components/BsCalendarPicker'
import { Navigate } from 'react-router-dom'

const BS_MONTHS = ['Baisakh','Jestha','Ashadh','Shrawan','Bhadra','Ashwin','Kartik','Mangsir','Poush','Magh','Falgun','Chaitra']
const TODAY = new Date().toISOString().split('T')[0]
const EPS = 0.001

const INPUT = {
  background: 'var(--theme-input-bg, var(--theme-card))',
  border: '1px solid var(--theme-border, var(--theme-border))',
  borderRadius: 6, padding: '7px 10px', fontSize: 13,
  color: 'var(--theme-text, var(--theme-text1))', outline: 'none',
}

export default function OutstandingPayables() {
  const { clientId, profile, loading: authLoading, hasImsAccess } = useAuth()
  const effectiveClientId = clientId || profile?.client_id
  const { scopedFrom, scopedInsert, scopedDelete } = useScopedDb()

  const [entries, setEntries]           = useState([])
  const [paymentsMap, setPaymentsMap]   = useState({})
  const [loading, setLoading]           = useState(true)
  const [setupNeeded, setSetupNeeded]   = useState(false)
  const [filterVendor, setFilterVendor] = useState('all')
  const [filterAging, setFilterAging]   = useState('all')
  const [filterPeriod, setFilterPeriod] = useState('all')
  const [activeTab, setActiveTab]       = useState('outstanding')
  const [expandedBill, setExpandedBill] = useState(null)
  const [payForm, setPayForm]           = useState({ amount: '', paid_at: TODAY, note: '' })
  const [savingPayment, setSavingPayment] = useState(false)
  const [payError, setPayError]           = useState('')

  // Bulk "pay several bills at once" — for a monthly credit run across many invoices.
  const [selectedBills, setSelectedBills] = useState(new Set())
  const [bulkForm, setBulkForm]           = useState({ paid_at: TODAY, note: '' })
  const [bulkSaving, setBulkSaving]       = useState(false)
  const [bulkError, setBulkError]         = useState('')

  useEffect(() => { if (!authLoading && effectiveClientId) load(activeTab) }, [effectiveClientId]) // eslint-disable-line

  async function load(tab = activeTab) {
    setLoading(true)
    setFilterVendor('all')
    setFilterAging('all')
    setFilterPeriod('all')
    setExpandedBill(null)
    setSelectedBills(new Set())

    let query = supabase
      .from('purchase_entries')
      .select('id, bs_day, qty, rate, invoice_ref, paid_at, vat_inclusive, discount_amount, purchase_group_id, monthly_periods!inner(client_id, bs_year, bs_month), items(name, uom, categories(name)), vendors(name)')
      .eq('monthly_periods.client_id', effectiveClientId)
      .eq('payment_method', 'Credit')

    if (tab === 'outstanding') {
      query = query.is('paid_at', null).order('created_at', { ascending: true })
    } else {
      query = query.not('paid_at', 'is', null).order('paid_at', { ascending: false })
    }

    const { data, error } = await query

    if (error) {
      if (error.code === '42703' || error.message?.includes('paid_at')) setSetupNeeded(true)
      setLoading(false)
      return
    }

    const today = new Date()
    const ids = (data || []).map(e => e.id)

    let pmtMap = {}
    if (ids.length > 0) {
      const { data: pmts } = await scopedFrom('payable_payments')
        .in('purchase_entry_id', ids)
        .order('paid_at', { ascending: true })
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
      const { data: rets } = await scopedFrom('vendor_returns', 'purchase_entry_id, qty, rate')
        .in('purchase_entry_id', ids)
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
      const netSum = lines.reduce((s, l) => s + l.netLine, 0)
      lines.forEach(l => {
        l.value = netSum > 0 ? l.netLine * (grandTotal / netSum) : 0
        l.remaining = Math.max(0, l.value - l.paidTotal)
      })
    })
    setEntries(enriched)
    setLoading(false)
  }

  function switchTab(tab) { setActiveTab(tab); load(tab) }

  function toggleBill(key) {
    setExpandedBill(prev => prev === key ? null : key)
    setPayForm({ amount: '', paid_at: TODAY, note: '' })
    setPayError('')
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

    let left = amount
    const rows = []
    const settleIds = []
    for (const e of bill.entries) {
      if (left <= EPS) break
      if (e.remaining <= EPS) continue
      const alloc = Math.min(e.remaining, left)
      rows.push({ purchase_entry_id: e.id, amount: alloc, paid_at: date, note })
      left -= alloc
      if (e.paidTotal + alloc >= e.value - EPS) settleIds.push(e.id)
    }
    if (rows.length === 0) { setSavingPayment(false); return }

    const { error: insErr } = await scopedInsert('payable_payments', rows)
    if (insErr) { setPayError(insErr.message || 'Failed to save payment.'); setSavingPayment(false); return }
    if (settleIds.length > 0) {
      await supabase.from('purchase_entries').update({ paid_at: date }).in('id', settleIds)
    }
    setSavingPayment(false)
    load(activeTab)
  }

  // Removes a mis-entered payment — there was previously no way to correct one anywhere in the
  // app (only "add", never "delete"/"edit"). Found live: a vendor's payment history contained the
  // bill's raw pre-discount/pre-VAT line amounts instead of what was actually paid, inflating the
  // bill's paid total well past its real value with no way to fix it short of writing SQL by hand.
  async function deletePayment(payment) {
    if (!window.confirm(`Delete this payment of ${fmt(payment.amount)} dated ${payment.paid_at}? This cannot be undone.`)) return
    const { error } = await scopedDelete('payable_payments').eq('id', payment.id)
    if (error) { alert(error.message || 'Failed to delete payment.'); return }
    // If this payment had settled its line (purchase_entries.paid_at stamped by payBill's
    // settleIds logic above), always clear paid_at rather than re-checking against entry.value —
    // that field is a proportional split of the bill's grand total across whichever lines are
    // CURRENTLY still marked paid, which becomes unreliable (even negative) once a bill-level
    // fixed discount is left dividing an ever-shrinking subset of lines mid-cleanup. Found live:
    // deleting one of several payments on a line left it stuck "paid" with zero payments recorded
    // against it, because the stale comparison against a distorted entry.value never triggered.
    // A false "still fully paid" after this is always safe to re-settle with Pay Bill; silently
    // leaving a $0-paid line marked paid is not.
    const entry = entries.find(e => e.id === payment.purchase_entry_id)
    if (entry?.paid_at) {
      await supabase.from('purchase_entries').update({ paid_at: null }).eq('id', payment.purchase_entry_id)
    }
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
      let left = bill.remaining
      for (const e of bill.entries) {
        if (left <= EPS) break
        if (e.remaining <= EPS) continue
        const alloc = Math.min(e.remaining, left)
        rows.push({ purchase_entry_id: e.id, amount: alloc, paid_at: date, note })
        left -= alloc
        if (e.paidTotal + alloc >= e.value - EPS) settleIds.push(e.id)
      }
    })
    if (rows.length === 0) { setBulkSaving(false); return }

    const { error: insErr } = await scopedInsert('payable_payments', rows)
    if (insErr) { setBulkError(insErr.message || 'Failed to save payments.'); setBulkSaving(false); return }
    if (settleIds.length > 0) {
      await supabase.from('purchase_entries').update({ paid_at: date }).in('id', settleIds)
    }
    setBulkSaving(false)
    setBulkForm({ paid_at: TODAY, note: '' })
    load(activeTab)
  }

  function fmt(v) { return `NPR ${Number(v).toLocaleString('en-NP', { maximumFractionDigits: 0 })}` }

  // ── Group line entries into BILLS (vendor + invoice + period + day) ──
  const vendors = [...new Map(entries.map(e => [e.vendors?.name, e.vendors])).values()].filter(Boolean)
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

      {setupNeeded && (
        <div style={{ background: 'rgba(248,113,113,0.08)', border: '1px solid rgba(248,113,113,0.3)', borderRadius: 8, padding: '16px 20px', marginBottom: 24, fontSize: 13 }}>
          <div style={{ fontWeight: 700, color: 'var(--theme-red)', marginBottom: 8 }}>⚠ One-time setup required</div>
          <div style={{ color: 'var(--theme-text3)', marginBottom: 10 }}>Run this SQL in Supabase → SQL Editor, then refresh:</div>
          <code style={{ display: 'block', background: 'var(--theme-bg)', padding: '10px 14px', borderRadius: 6, color: 'var(--theme-accent)', fontSize: 12, userSelect: 'all' }}>
            ALTER TABLE purchase_entries ADD COLUMN IF NOT EXISTS paid_at date;
          </code>
        </div>
      )}

      <div className="stat-grid" style={{ gridTemplateColumns: 'repeat(3,1fr)', marginBottom: 24 }}>
        {activeTab === 'outstanding' ? (<>
          <div className="stat-card">
            <div className="stat-label"><Tip text="Total remaining balance across all outstanding credit bills, less any payments already recorded. Bill amounts match the vendor's invoice: net of goods returned and any bill discount, plus 13% VAT on VAT-inclusive lines." width={280}>Total Remaining</Tip></div>
            <div className="stat-value" style={{ fontSize: 18, color: totalRemaining > 0 ? 'var(--theme-red)' : 'var(--theme-text2)' }}>{fmt(totalRemaining)}</div>
            <div className="stat-sub">{filteredBills.length} bill{filteredBills.length !== 1 ? 's' : ''} · {Object.keys(byVendor).length} vendor{Object.keys(byVendor).length !== 1 ? 's' : ''}</div>
          </div>
          <div className="stat-card">
            <div className="stat-label"><Tip text="Bills with a remaining balance older than 60 days." width={230}>Overdue Bills</Tip></div>
            <div className="stat-value" style={{ color: overdueBills > 0 ? 'var(--theme-amber)' : 'var(--theme-text2)' }}>{overdueBills}</div>
            <div className="stat-sub">&gt;60 days outstanding</div>
          </div>
          <div className="stat-card">
            <div className="stat-label"><Tip text="Remaining value on bills over 90 days old. Urgent settlement needed." width={240}>90+ Day Value</Tip></div>
            <div className="stat-value" style={{ fontSize: 16, color: urgentValue > 0 ? 'var(--theme-red)' : 'var(--theme-text2)' }}>{urgentValue > 0 ? fmt(urgentValue) : '—'}</div>
            <div className="stat-sub">Urgent settlement</div>
          </div>
        </>) : (<>
          <div className="stat-card">
            <div className="stat-label"><Tip text="Total invoiced value of all fully settled credit bills — net of returns and discount, including VAT where applicable." width={260}>Total Paid</Tip></div>
            <div className="stat-value" style={{ fontSize: 18, color: 'var(--theme-green)' }}>{fmt(totalRemaining)}</div>
            <div className="stat-sub">{filteredBills.length} settled bill{filteredBills.length !== 1 ? 's' : ''}</div>
          </div>
          <div className="stat-card">
            <div className="stat-label">Vendors Paid</div>
            <div className="stat-value">{Object.keys(byVendor).length}</div>
            <div className="stat-sub">Unique vendors settled</div>
          </div>
          <div className="stat-card">
            <div className="stat-label"><Tip text="Most recently settled bill date." width={200}>Last Settlement</Tip></div>
            <div className="stat-value" style={{ fontSize: 14 }}>{filteredBills.length > 0 ? (filteredBills[0].settledOn || '—') : '—'}</div>
            <div className="stat-sub">{filteredBills.length > 0 ? filteredBills[0].vendorName : ''}</div>
          </div>
        </>)}
      </div>

      <div style={{ display: 'flex', gap: 12, marginBottom: 20, flexWrap: 'wrap', alignItems: 'center' }}>
        <select className="form-select" value={filterVendor} onChange={e => setFilterVendor(e.target.value)}>
          <option value="all">All Vendors</option>
          {vendors.map(v => <option key={v.name} value={v.name}>{v.name}</option>)}
        </select>
        {activeTab === 'outstanding' && (
          <select className="form-select" value={filterAging} onChange={e => setFilterAging(e.target.value)}>
            <option value="all">All Ages</option>
            {AGING_LABELS.map(a => <option key={a} value={a}>{a}</option>)}
          </select>
        )}
        <select className="form-select" value={filterPeriod} onChange={e => setFilterPeriod(e.target.value)}>
          <option value="all">All Months</option>
          {periodOptions.map(p => <option key={p.key} value={p.key}>{p.label}</option>)}
        </select>
        <button className="btn btn-ghost" style={{ fontSize: 13 }} onClick={() => load(activeTab)}>↻ Refresh</button>
        {activeTab === 'outstanding' && filteredBills.length > 0 && (
          <button className="btn btn-ghost" style={{ fontSize: 13 }}
            onClick={() => toggleSelectKeys(filteredBills.map(b => b.key))}>
            {filteredBills.every(b => selectedBills.has(b.key)) ? 'Deselect All Filtered' : `Select All Filtered (${filteredBills.length})`}
          </button>
        )}
      </div>

      {activeTab === 'outstanding' && selectedBills.size > 0 && (
        <div className="card" style={{
          marginBottom: 20, padding: '14px 20px', display: 'flex', gap: 14, alignItems: 'flex-end', flexWrap: 'wrap',
          border: '1px solid color-mix(in srgb, var(--theme-accent) 40%, transparent)',
          background: 'color-mix(in srgb, var(--theme-accent) 6%, transparent)',
        }}>
          <div>
            <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--theme-text1)' }}>
              {selectedBillObjs.length} bill{selectedBillObjs.length !== 1 ? 's' : ''} selected
            </div>
            <div style={{ fontSize: 13, color: 'var(--theme-accent)', fontWeight: 700 }}>{fmt(selectedTotal)} total</div>
          </div>
          <div>
            <div style={{ fontSize: 11, color: 'var(--theme-text2)', marginBottom: 4 }}>Payment Date</div>
            <BsCalendarPicker value={bulkForm.paid_at} onChange={v => setBulkForm(f => ({ ...f, paid_at: v }))} placeholder="Pick date" />
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
          {bulkError && <div style={{ width: '100%', fontSize: 12, color: 'var(--theme-red)' }}>⚠ {bulkError}</div>}
        </div>
      )}

      {loading ? (
        <div className="card"><p style={{ color: 'var(--theme-text2)', fontSize: 13 }}>Loading payables…</p></div>
      ) : setupNeeded ? null : filteredBills.length === 0 ? (
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
                  <span style={{ fontWeight: 700, fontSize: 15, color: 'var(--theme-text1)' }}>{vName}</span>
                  <span style={{ fontSize: 15, fontWeight: 700, color: activeTab === 'outstanding' ? 'var(--theme-red)' : 'var(--theme-green)' }}>{fmt(vendorTotal)}</span>
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
                            <tr
                              style={{ cursor: 'pointer' }}
                              onClick={() => toggleBill(b.key)}
                              role="button"
                              tabIndex={0}
                              aria-expanded={isExpanded}
                              onKeyDown={e => {
                                if (e.key === 'Enter' || e.key === ' ') {
                                  e.preventDefault()
                                  toggleBill(b.key)
                                }
                              }}
                            >
                              {activeTab === 'outstanding' && (
                                <td onClick={ev => ev.stopPropagation()}>
                                  <input type="checkbox" checked={selectedBills.has(b.key)} onChange={() => toggleSelectBill(b.key)}
                                    aria-label={`Select bill ${b.invoice_ref || ''}`} />
                                </td>
                              )}
                              <td style={{ fontWeight: 600, color: 'var(--theme-text1)' }}>#{b.invoice_ref || '—'}</td>
                              <td style={{ color: 'var(--theme-text2)' }}>{BS_MONTHS[(b.period.bs_month || 1) - 1]} {b.period.bs_year}</td>
                              <td style={{ textAlign: 'right', color: 'var(--theme-text2)' }}>{b.entries.length}</td>
                              <td style={{ textAlign: 'right', fontWeight: 600, color: 'var(--theme-accent)' }}>{fmt(b.total)}</td>
                              {activeTab === 'outstanding' ? (<>
                                <td style={{ textAlign: 'right', color: b.paid > 0 ? 'var(--theme-green)' : 'var(--theme-text2)' }}>{b.paid > 0 ? fmt(b.paid) : '—'}</td>
                                <td style={{ textAlign: 'right', fontWeight: 700, color: 'var(--theme-red)' }}>{fmt(b.remaining)}</td>
                                <td style={{ textAlign: 'right', fontWeight: 700, color: b.aging.color }}>{b.daysOld}</td>
                                <td>
                                  {b.isPartial
                                    ? <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--theme-purple)', background: 'color-mix(in srgb, var(--theme-purple) 12%, transparent)', border: '1px solid color-mix(in srgb, var(--theme-purple) 40%, transparent)', borderRadius: 4, padding: '2px 8px', whiteSpace: 'nowrap' }}>Partial</span>
                                    : <span style={{ fontSize: 11, fontWeight: 700, color: b.aging.color, background: `color-mix(in srgb, ${b.aging.color} 12%, transparent)`, border: `1px solid color-mix(in srgb, ${b.aging.color} 40%, transparent)`, borderRadius: 4, padding: '2px 8px', whiteSpace: 'nowrap' }}>{b.aging.label}</span>
                                  }
                                </td>
                                <td style={{ color: 'var(--theme-accent)', fontSize: 12, whiteSpace: 'nowrap' }}>{isExpanded ? '▲ Close' : '＋ Pay Bill'}</td>
                              </>) : (<>
                                <td style={{ color: 'var(--theme-green)', fontWeight: 600, fontSize: 13 }}>{b.settledOn || '—'}</td>
                                <td style={{ color: 'var(--theme-text3)', fontSize: 12, whiteSpace: 'nowrap' }}>{isExpanded ? '▲ Hide' : '▼ Details'}</td>
                              </>)}
                            </tr>

                            {isExpanded && (
                              <tr>
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
                                            <td style={{ padding: '4px 0 4px 16px', textAlign: 'right', color: 'var(--theme-accent)', fontWeight: 600 }}>{fmt(e.value)}</td>
                                          </tr>
                                        ))}
                                      </tbody>
                                    </table>

                                    {/* Payment history (across the whole bill) */}
                                    {b.payments.length > 0 && (
                                      <div style={{ marginBottom: activeTab === 'outstanding' ? 20 : 0 }}>
                                        <div style={{ fontSize: 11, color: 'var(--theme-text3)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 10 }}>Payment History</div>
                                        <table style={{ borderCollapse: 'collapse', fontSize: 13, minWidth: 400 }}>
                                          <tbody>
                                            {b.payments.map(p => (
                                              <tr key={p.id}>
                                                <td style={{ padding: '5px 16px 5px 0', color: 'var(--theme-green)' }}>{p.paid_at}</td>
                                                <td style={{ padding: '5px 16px', textAlign: 'right', color: 'var(--theme-text1)', fontWeight: 600 }}>{fmt(p.amount)}</td>
                                                <td style={{ padding: '5px 16px', color: 'var(--theme-text3)' }}>{p.note || '—'}</td>
                                                <td style={{ padding: '5px 0 5px 16px' }}>
                                                  <button className="btn btn-ghost" style={{ fontSize: 11, padding: '2px 8px', color: 'var(--theme-red)' }}
                                                    onClick={ev => { ev.stopPropagation(); deletePayment(p) }} title="Delete this payment">
                                                    Delete
                                                  </button>
                                                </td>
                                              </tr>
                                            ))}
                                            <tr style={{ borderTop: '1px solid var(--theme-border)' }}>
                                              <td style={{ padding: '5px 16px 5px 0', color: 'var(--theme-text2)', fontSize: 11 }}>Total paid</td>
                                              <td style={{ padding: '5px 16px', textAlign: 'right', fontWeight: 700, color: 'var(--theme-green)' }}>{fmt(b.paid)}</td>
                                              <td />
                                              <td />
                                            </tr>
                                          </tbody>
                                        </table>
                                      </div>
                                    )}

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
                                        {payError && <div style={{ marginTop: 8, fontSize: 12, color: 'var(--theme-red)' }}>⚠ {payError}</div>}
                                        {willSettle && !payError && <div style={{ marginTop: 8, fontSize: 12, color: 'var(--theme-green)' }}>✓ This will fully settle the bill</div>}
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
                          <td style={{ textAlign: 'right', fontWeight: 700, color: 'var(--theme-accent)', paddingTop: 12 }}>{fmt(vBillTotal)}</td>
                          <td style={{ textAlign: 'right', fontWeight: 700, color: 'var(--theme-green)', paddingTop: 12 }}>{vPaidTotal > 0 ? fmt(vPaidTotal) : '—'}</td>
                          <td style={{ textAlign: 'right', fontWeight: 700, color: 'var(--theme-red)', paddingTop: 12 }}>{fmt(vRemainingTotal)}</td>
                          <td colSpan={3} style={{ paddingTop: 12 }}></td>
                        </>) : (<>
                          <td colSpan={3} style={{ fontWeight: 700, color: 'var(--theme-text2)', paddingTop: 12 }}>Total</td>
                          <td style={{ textAlign: 'right', fontWeight: 700, color: 'var(--theme-green)', paddingTop: 12 }}>{fmt(vBillTotal)}</td>
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
    </div>
  )
}
