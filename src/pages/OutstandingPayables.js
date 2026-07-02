import { Fragment, useEffect, useState } from 'react'
import { useAuth } from '../context/AuthContext'
import { supabase } from '../supabaseClient'
import { bsToAd } from '../utils/bsCalendar'
import Tip from '../components/Tip'
import BsCalendarPicker from '../components/BsCalendarPicker'

const BS_MONTHS = ['Baisakh','Jestha','Ashadh','Shrawan','Bhadra','Ashwin','Kartik','Mangsir','Poush','Magh','Falgun','Chaitra']
const TODAY = new Date().toISOString().split('T')[0]
const EPS = 0.001

const INPUT = {
  background: 'var(--theme-input-bg, var(--theme-card))',
  border: '1px solid var(--theme-border, var(--theme-border))',
  borderRadius: 6, padding: '7px 10px', fontSize: 13,
  color: 'var(--theme-text, var(--theme-text1))', outline: 'none',
}

function aging(days) {
  if (days <= 30) return { label: 'Current',    color: 'var(--theme-green)' }
  if (days <= 60) return { label: '31–60 days', color: 'var(--theme-accent)' }
  if (days <= 90) return { label: '61–90 days', color: '#f97316' }
  return                 { label: '90+ days',   color: 'var(--theme-red)' }
}

export default function OutstandingPayables() {
  const { clientId, profile, loading: authLoading } = useAuth()
  const effectiveClientId = clientId || profile?.client_id

  const [entries, setEntries]           = useState([])
  const [paymentsMap, setPaymentsMap]   = useState({})
  const [loading, setLoading]           = useState(true)
  const [setupNeeded, setSetupNeeded]   = useState(false)
  const [filterVendor, setFilterVendor] = useState('all')
  const [filterAging, setFilterAging]   = useState('all')
  const [activeTab, setActiveTab]       = useState('outstanding')
  const [expandedBill, setExpandedBill] = useState(null)
  const [payForm, setPayForm]           = useState({ amount: '', paid_at: TODAY, note: '' })
  const [savingPayment, setSavingPayment] = useState(false)
  const [payError, setPayError]           = useState('')

  useEffect(() => { if (!authLoading && effectiveClientId) load(activeTab) }, [effectiveClientId]) // eslint-disable-line

  async function load(tab = activeTab) {
    setLoading(true)
    setFilterVendor('all')
    setFilterAging('all')
    setExpandedBill(null)

    let query = supabase
      .from('purchase_entries')
      .select('id, bs_day, qty, rate, invoice_ref, paid_at, monthly_periods!inner(client_id, bs_year, bs_month), items(name, uom, categories(name)), vendors(name)')
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
      const { data: pmts } = await supabase
        .from('payable_payments')
        .select('*')
        .in('purchase_entry_id', ids)
        .order('paid_at', { ascending: true })
      ;(pmts || []).forEach(p => {
        if (!pmtMap[p.purchase_entry_id]) pmtMap[p.purchase_entry_id] = []
        pmtMap[p.purchase_entry_id].push(p)
      })
    }
    setPaymentsMap(pmtMap)

    const enriched = (data || []).map(e => {
      const pr = e.monthly_periods
      const adDate = bsToAd(pr.bs_year, pr.bs_month, e.bs_day || 1)
      const daysOld = Math.max(0, Math.floor((today - adDate) / (1000 * 60 * 60 * 24)))
      const value = parseFloat(e.qty) * parseFloat(e.rate)
      const paidTotal = (pmtMap[e.id] || []).reduce((s, p) => s + parseFloat(p.amount), 0)
      const remaining = Math.max(0, value - paidTotal)
      return { ...e, period: pr, value, paidTotal, remaining, daysOld, aging: aging(daysOld) }
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
      rows.push({ purchase_entry_id: e.id, client_id: effectiveClientId, amount: alloc, paid_at: date, note })
      left -= alloc
      if (e.paidTotal + alloc >= e.value - EPS) settleIds.push(e.id)
    }
    if (rows.length === 0) { setSavingPayment(false); return }

    const { error: insErr } = await supabase.from('payable_payments').insert(rows)
    if (insErr) { setPayError(insErr.message || 'Failed to save payment.'); setSavingPayment(false); return }
    if (settleIds.length > 0) {
      await supabase.from('purchase_entries').update({ paid_at: date }).in('id', settleIds)
    }
    setSavingPayment(false)
    load(activeTab)
  }

  function fmt(v) { return `NPR ${Number(v).toLocaleString('en-NP', { maximumFractionDigits: 0 })}` }

  // ── Group line entries into BILLS (vendor + invoice + period + day) ──
  const vendors = [...new Map(entries.map(e => [e.vendors?.name, e.vendors])).values()].filter(Boolean)
  const AGING_LABELS = ['Current', '31–60 days', '61–90 days', '90+ days']

  const billMap = {}
  entries.forEach(e => {
    const vName = e.vendors?.name || 'Unknown'
    const key = `${vName}|${e.invoice_ref || 'noinv'}|${e.period.bs_year}-${e.period.bs_month}-${e.bs_day || 0}`
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

  const filteredBills = bills.filter(b => {
    const matchV = filterVendor === 'all' || b.vendorName === filterVendor
    const matchA = filterAging  === 'all' || b.aging.label === filterAging
    return matchV && matchA
  })

  const byVendor = {}
  filteredBills.forEach(b => { (byVendor[b.vendorName] = byVendor[b.vendorName] || []).push(b) })

  const totalRemaining = filteredBills.reduce((s, b) => s + (activeTab === 'outstanding' ? b.remaining : b.total), 0)
  const overdueBills   = filteredBills.filter(b => b.daysOld > 60).length
  const urgentValue    = filteredBills.filter(b => b.daysOld > 90).reduce((s, b) => s + b.remaining, 0)

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
            <div className="stat-label"><Tip text="Total remaining balance across all outstanding credit bills." width={220}>Total Remaining</Tip></div>
            <div className="stat-value" style={{ fontSize: 18, color: totalRemaining > 0 ? 'var(--theme-red)' : 'var(--theme-text2)' }}>{fmt(totalRemaining)}</div>
            <div className="stat-sub">{filteredBills.length} bill{filteredBills.length !== 1 ? 's' : ''} · {Object.keys(byVendor).length} vendor{Object.keys(byVendor).length !== 1 ? 's' : ''}</div>
          </div>
          <div className="stat-card">
            <div className="stat-label"><Tip text="Bills with a remaining balance older than 60 days." width={230}>Overdue Bills</Tip></div>
            <div className="stat-value" style={{ color: overdueBills > 0 ? '#f97316' : 'var(--theme-text2)' }}>{overdueBills}</div>
            <div className="stat-sub">&gt;60 days outstanding</div>
          </div>
          <div className="stat-card">
            <div className="stat-label"><Tip text="Remaining value on bills over 90 days old. Urgent settlement needed." width={240}>90+ Day Value</Tip></div>
            <div className="stat-value" style={{ fontSize: 16, color: urgentValue > 0 ? 'var(--theme-red)' : 'var(--theme-text2)' }}>{urgentValue > 0 ? fmt(urgentValue) : '—'}</div>
            <div className="stat-sub">Urgent settlement</div>
          </div>
        </>) : (<>
          <div className="stat-card">
            <div className="stat-label"><Tip text="Total value of all fully settled credit bills." width={220}>Total Paid</Tip></div>
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
        <button className="btn btn-ghost" style={{ fontSize: 13 }} onClick={() => load(activeTab)}>↻ Refresh</button>
      </div>

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
            const cols = activeTab === 'outstanding' ? 9 : 6
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
                        <th>Invoice</th>
                        <th>Period</th>
                        <th style={{ textAlign: 'right' }}>Items</th>
                        <th style={{ textAlign: 'right' }}>Bill Total</th>
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
                            <tr style={{ cursor: 'pointer' }} onClick={() => toggleBill(b.key)}>
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
                                    ? <span style={{ fontSize: 11, fontWeight: 700, color: '#818cf8', background: 'rgba(129,140,248,0.1)', border: '1px solid rgba(129,140,248,0.3)', borderRadius: 4, padding: '2px 8px', whiteSpace: 'nowrap' }}>Partial</span>
                                    : <span style={{ fontSize: 11, fontWeight: 700, color: b.aging.color, background: `${b.aging.color}18`, border: `1px solid ${b.aging.color}40`, borderRadius: 4, padding: '2px 8px', whiteSpace: 'nowrap' }}>{b.aging.label}</span>
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
                                                <td style={{ padding: '5px 0 5px 16px', color: 'var(--theme-text3)' }}>{p.note || '—'}</td>
                                              </tr>
                                            ))}
                                            <tr style={{ borderTop: '1px solid var(--theme-border)' }}>
                                              <td style={{ padding: '5px 16px 5px 0', color: 'var(--theme-text2)', fontSize: 11 }}>Total paid</td>
                                              <td style={{ padding: '5px 16px', textAlign: 'right', fontWeight: 700, color: 'var(--theme-green)' }}>{fmt(b.paid)}</td>
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
