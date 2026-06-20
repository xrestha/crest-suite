import { useEffect, useState } from 'react'
import { useAuth } from '../context/AuthContext'
import { supabase } from '../supabaseClient'
import { bsToAd } from '../utils/bsCalendar'
import Tip from '../components/Tip'

const BS_MONTHS = ['Baisakh','Jestha','Ashadh','Shrawan','Bhadra','Ashwin','Kartik','Mangsir','Poush','Magh','Falgun','Chaitra']

function aging(days) {
  if (days <= 30) return { label: 'Current',    color: '#34d399' }
  if (days <= 60) return { label: '31–60 days', color: '#c9a84c' }
  if (days <= 90) return { label: '61–90 days', color: '#f97316' }
  return                 { label: '90+ days',   color: '#f87171' }
}

export default function OutstandingPayables() {
  const { clientId, profile, loading: authLoading } = useAuth()
  const effectiveClientId = clientId || profile?.client_id

  const [entries, setEntries]       = useState([])
  const [loading, setLoading]       = useState(true)
  const [setupNeeded, setSetupNeeded] = useState(false)
  const [markingPaid, setMarkingPaid] = useState(null)
  const [filterVendor, setFilterVendor] = useState('all')
  const [filterAging, setFilterAging]   = useState('all')
  const [activeTab, setActiveTab]       = useState('outstanding')

  useEffect(() => { if (!authLoading && effectiveClientId) load(activeTab) }, [clientId]) // eslint-disable-line

  async function load(tab = activeTab) {
    setLoading(true)
    setFilterVendor('all')
    setFilterAging('all')
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
      // paid_at column not yet added — show setup banner
      if (error.code === '42703' || error.message?.includes('paid_at')) setSetupNeeded(true)
      setLoading(false)
      return
    }

    const today = new Date()
    const enriched = (data || []).map(e => {
      const p = e.monthly_periods
      const adDate = bsToAd(p.bs_year, p.bs_month, e.bs_day || 1)
      const daysOld = Math.max(0, Math.floor((today - adDate) / (1000 * 60 * 60 * 24)))
      return { ...e, period: p, value: parseFloat(e.qty) * parseFloat(e.rate), daysOld, aging: aging(daysOld) }
    })
    setEntries(enriched)
    setLoading(false)
  }

  function switchTab(tab) {
    setActiveTab(tab)
    load(tab)
  }

  async function markPaid(id) {
    setMarkingPaid(id)
    await supabase.from('purchase_entries')
      .update({ paid_at: new Date().toISOString().split('T')[0] })
      .eq('id', id)
    setEntries(prev => prev.filter(e => e.id !== id))
    setMarkingPaid(null)
  }

  const vendors = [...new Map(entries.map(e => [e.vendors?.name, e.vendors])).values()].filter(Boolean)

  const AGING_LABELS = ['Current', '31–60 days', '61–90 days', '90+ days']

  const filtered = entries.filter(e => {
    const matchV = filterVendor === 'all' || e.vendors?.name === filterVendor
    const matchA = filterAging  === 'all' || e.aging.label    === filterAging
    return matchV && matchA
  })

  // Group by vendor
  const byVendor = {}
  filtered.forEach(e => {
    const vName = e.vendors?.name || 'Unknown'
    if (!byVendor[vName]) byVendor[vName] = { vendor: e.vendors, rows: [] }
    byVendor[vName].rows.push(e)
  })

  const totalOutstanding = filtered.reduce((s, e) => s + e.value, 0)
  const overdueItems     = filtered.filter(e => e.daysOld > 60).length
  const urgentValue      = filtered.filter(e => e.daysOld > 90).reduce((s, e) => s + e.value, 0)

  function fmt(v) { return `NPR ${Number(v).toLocaleString('en-NP', { maximumFractionDigits: 0 })}` }

  return (
    <div>
      <div className="page-header">
        <div>
          <h1 className="page-title">Outstanding Payables</h1>
          <p className="page-subtitle">{activeTab === 'outstanding' ? 'Unpaid credit purchases by vendor — aging analysis' : 'Settled credit purchases — payment history'}</p>
        </div>
      </div>

      <div className="tab-bar" style={{ marginBottom: 24 }}>
        <button className={`tab-btn${activeTab === 'outstanding' ? ' tab-btn--active' : ''}`} onClick={() => switchTab('outstanding')}>Outstanding</button>
        <button className={`tab-btn${activeTab === 'paid' ? ' tab-btn--active' : ''}`} onClick={() => switchTab('paid')}>Paid History</button>
      </div>

      {setupNeeded && (
        <div style={{ background: 'rgba(248,113,113,0.08)', border: '1px solid rgba(248,113,113,0.3)', borderRadius: 8, padding: '16px 20px', marginBottom: 24, fontSize: 13 }}>
          <div style={{ fontWeight: 700, color: '#f87171', marginBottom: 8 }}>⚠ One-time setup required</div>
          <div style={{ color: '#9ca3af', marginBottom: 10 }}>
            Run this SQL in Supabase → SQL Editor to enable payment tracking, then refresh:
          </div>
          <code style={{ display: 'block', background: '#0f1117', padding: '10px 14px', borderRadius: 6, color: '#c9a84c', fontSize: 12, userSelect: 'all' }}>
            ALTER TABLE purchase_entries ADD COLUMN IF NOT EXISTS paid_at date;
          </code>
        </div>
      )}

      <div className="stat-grid" style={{ gridTemplateColumns: 'repeat(3,1fr)', marginBottom: 24 }}>
        {activeTab === 'outstanding' ? (<>
          <div className="stat-card">
            <div className="stat-label"><Tip text="Sum of all unpaid credit purchase amounts matching current filters." width={220}>Total Outstanding</Tip></div>
            <div className="stat-value" style={{ fontSize: 18, color: totalOutstanding > 0 ? '#f87171' : '#6b7280' }}>{fmt(totalOutstanding)}</div>
            <div className="stat-sub">{filtered.length} unpaid invoices · {Object.keys(byVendor).length} vendors</div>
          </div>
          <div className="stat-card">
            <div className="stat-label"><Tip text="Invoices older than 60 days still unpaid — vendors waiting longest." width={230}>Overdue Items</Tip></div>
            <div className="stat-value" style={{ color: overdueItems > 0 ? '#f97316' : '#6b7280' }}>{overdueItems}</div>
            <div className="stat-sub">&gt;60 days outstanding</div>
          </div>
          <div className="stat-card">
            <div className="stat-label"><Tip text="Value of invoices over 90 days old. These vendors need urgent settlement." width={240}>90+ Day Value</Tip></div>
            <div className="stat-value" style={{ fontSize: 16, color: urgentValue > 0 ? '#f87171' : '#6b7280' }}>{urgentValue > 0 ? fmt(urgentValue) : '—'}</div>
            <div className="stat-sub">Urgent settlement</div>
          </div>
        </>) : (<>
          <div className="stat-card">
            <div className="stat-label"><Tip text="Total value of all settled credit purchases matching current filters." width={220}>Total Paid</Tip></div>
            <div className="stat-value" style={{ fontSize: 18, color: '#34d399' }}>{fmt(totalOutstanding)}</div>
            <div className="stat-sub">{filtered.length} settled invoices</div>
          </div>
          <div className="stat-card">
            <div className="stat-label">Vendors Paid</div>
            <div className="stat-value">{Object.keys(byVendor).length}</div>
            <div className="stat-sub">Unique vendors settled</div>
          </div>
          <div className="stat-card">
            <div className="stat-label"><Tip text="Most recently settled invoice date." width={200}>Last Settlement</Tip></div>
            <div className="stat-value" style={{ fontSize: 14 }}>
              {filtered.length > 0 ? filtered[0].paid_at : '—'}
            </div>
            <div className="stat-sub">{filtered.length > 0 ? filtered[0].vendors?.name : ''}</div>
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
        <div className="card"><p style={{ color: '#6b7280', fontSize: 13 }}>Loading payables…</p></div>
      ) : setupNeeded ? null : filtered.length === 0 ? (
        <div className="card">
          <div className="empty-state">
            <div className="empty-state-icon">✓</div>
            <p className="empty-state-text">
              {entries.length === 0
                ? 'No outstanding credit payables. All credit purchases are settled or no credit entries exist.'
                : 'No items match the current filters.'}
            </p>
          </div>
        </div>
      ) : (
        Object.entries(byVendor)
          .sort(([, a], [, b]) => b.rows.reduce((s, e) => s + e.value, 0) - a.rows.reduce((s, e) => s + e.value, 0))
          .map(([vName, { vendor, rows: vRows }]) => {
            const vendorTotal = vRows.reduce((s, e) => s + e.value, 0)
            return (
              <div key={vName} className="card" style={{ marginBottom: 16 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16, paddingBottom: 12, borderBottom: '1px solid #2a2f3d' }}>
                  <span style={{ fontWeight: 700, fontSize: 15, color: '#e8e0d0' }}>{vName}</span>
                  <span style={{ fontSize: 15, fontWeight: 700, color: '#f87171' }}>{fmt(vendorTotal)}</span>
                </div>
                <div className="table-wrap">
                  <table className="data-table">
                    <thead>
                      <tr>
                        <th>Item</th>
                        <th>Category</th>
                        <th>Period</th>
                        <th>Invoice</th>
                        <th style={{ textAlign: 'right' }}>Qty</th>
                        <th style={{ textAlign: 'right' }}>Rate</th>
                        <th style={{ textAlign: 'right' }}>Amount</th>
                        {activeTab === 'outstanding' ? (<>
                          <th style={{ textAlign: 'right' }}>
                            <Tip text="Calendar days since this purchase was recorded in the system." width={200}>Days</Tip>
                          </th>
                          <th>Aging</th>
                          <th></th>
                        </>) : (
                          <th>Paid On</th>
                        )}
                      </tr>
                    </thead>
                    <tbody>
                      {(activeTab === 'outstanding' ? vRows.sort((a, b) => b.daysOld - a.daysOld) : vRows).map(e => (
                        <tr key={e.id}>
                          <td style={{ fontWeight: 600, color: '#e8e0d0' }}>{e.items?.name}</td>
                          <td><span className="badge badge-yellow">{e.items?.categories?.name || '—'}</span></td>
                          <td style={{ color: '#6b7280' }}>
                            {BS_MONTHS[(e.period.bs_month || 1) - 1]} {e.period.bs_year}
                          </td>
                          <td style={{ color: '#9ca3af', fontSize: 12 }}>{e.invoice_ref || '—'}</td>
                          <td style={{ textAlign: 'right', color: '#6b7280' }}>
                            {parseFloat(e.qty).toLocaleString()} {e.items?.uom}
                          </td>
                          <td style={{ textAlign: 'right', color: '#6b7280' }}>
                            NPR {parseFloat(e.rate).toLocaleString()}
                          </td>
                          <td style={{ textAlign: 'right', fontWeight: 600, color: '#c9a84c' }}>{fmt(e.value)}</td>
                          {activeTab === 'outstanding' ? (<>
                            <td style={{ textAlign: 'right', fontWeight: 700, color: e.aging.color }}>{e.daysOld}</td>
                            <td>
                              <span style={{
                                fontSize: 11, fontWeight: 700, color: e.aging.color,
                                background: `${e.aging.color}18`, border: `1px solid ${e.aging.color}40`,
                                borderRadius: 4, padding: '2px 8px', whiteSpace: 'nowrap'
                              }}>
                                {e.aging.label}
                              </span>
                            </td>
                            <td>
                              <button
                                className="btn btn-ghost"
                                style={{ fontSize: 11, padding: '4px 10px', color: '#34d399', borderColor: 'rgba(52,211,153,0.3)' }}
                                disabled={markingPaid === e.id}
                                onClick={() => markPaid(e.id)}
                              >
                                {markingPaid === e.id ? '…' : '✓ Mark Paid'}
                              </button>
                            </td>
                          </>) : (
                            <td style={{ color: '#34d399', fontWeight: 600, fontSize: 13 }}>{e.paid_at}</td>
                          )}
                        </tr>
                      ))}
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
