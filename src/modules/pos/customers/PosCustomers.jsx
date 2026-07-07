import { Fragment, useState, useEffect } from 'react'
import { Navigate } from 'react-router-dom'
import { useAuth } from '../../../context/AuthContext'
import { supabase } from '../../../supabaseClient'
import { useScopedDb } from '../../../shared/hooks/useScopedDb'
import Tip from '../../../components/Tip'
import { computeOrderAmounts } from '../../../utils/posBillingMath'

// Cheque + Bank Transfer are settlement-only (how a receivable is remitted) — not counter-payment
// methods, so they're not in PAYMENT_METHODS. Foodmandu/Pathao typically remit by Bank Transfer.
const SETTLE_METHODS = ['Cash', 'Card', 'eSewa', 'Khalti', 'FonePay', 'Cheque', 'Bank Transfer']
const fmtNpr = n => `NPR ${Math.round(n).toLocaleString()}`

function invoiceLabel(order, vatReg, prefix) {
  if (order.invoice_no == null) return `#${order.order_no ?? ''}`
  if (order.close_type === 'writeoff') return `NC-${String(order.invoice_no).padStart(2, '0')}`
  return `${vatReg ? 'TI' : 'PB'}${order.invoice_no}-${prefix}${prefix ? '-' : ''}${order.invoice_fy || ''}`
}

function daysAgo(iso) {
  const d = Math.floor((Date.now() - new Date(iso).getTime()) / 86400000)
  return d <= 0 ? 'today' : d === 1 ? '1 day' : `${d} days`
}

export default function PosCustomers() {
  const { clientId, profile, hasPosAccess } = useAuth()
  const { scopedFrom, scopedUpdate } = useScopedDb()

  const [mainTab, setMainTab] = useState('customers') // 'customers' | 'credit'

  // Customers
  const [customers, setCustomers] = useState([])
  const [custLoading, setCustLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [expandedId, setExpandedId] = useState(null)
  const [historyMap, setHistoryMap] = useState({})   // { customerId: orders[] | 'loading' }

  // Credit
  const [creditBills, setCreditBills] = useState([])
  const [creditLoading, setCreditLoading] = useState(false)
  const [creditLoaded, setCreditLoaded] = useState(false)
  const [settlingId, setSettlingId] = useState(null)  // order id with the method picker open
  const [settleBusy, setSettleBusy] = useState(false)
  const [settleMsg, setSettleMsg] = useState('')
  // Foodmandu/Pathao only — the platform's actual remittance statement is what should drive
  // this number, not the Charge-time guess (deliberately never computed at Charge — see
  // PosOrders.jsx). settleExVatBase is fetched once per Settle click (this order's ex-VAT,
  // post-discount value, same basis computeOrderAmounts already uses elsewhere), so the % just
  // typed can be turned into a live preview amount without a second network round trip per keystroke.
  const [settleCommissionPct, setSettleCommissionPct] = useState('')
  const [settleExVatBase, setSettleExVatBase] = useState(null)
  const [settleExVatLoading, setSettleExVatLoading] = useState(false)

  const [billingSettings, setBillingSettings] = useState({
    is_vat_registered: true, invoice_prefix: '', delivery_partners: [],
  })

  useEffect(() => {
    if (!clientId) return
    loadCustomers()
    supabase.from('settings')
      .select('is_vat_registered, invoice_prefix, pos_delivery_partners')
      .eq('client_id', clientId).maybeSingle()
      .then(({ data }) => setBillingSettings({
        is_vat_registered: data?.is_vat_registered ?? true,
        invoice_prefix: data?.invoice_prefix || '',
        delivery_partners: data?.pos_delivery_partners || [],
      }))
  }, [clientId]) // eslint-disable-line

  if (!hasPosAccess('supervisor')) return <Navigate to="/pos" replace />

  async function loadCustomers() {
    setCustLoading(true)
    const { data } = await scopedFrom('pos_customers').order('name')
    setCustomers(data || [])
    setCustLoading(false)
  }

  async function loadCredit() {
    setCreditLoading(true)
    const { data } = await scopedFrom('pos_orders', 'id, order_no, invoice_no, invoice_fy, close_type, paid_amount, discount_amount, buyer_name, buyer_phone, delivery_partner, commission_amount, closed_at, credit_settled_at, credit_settled_method')
      .eq('payment_method', 'Credit').eq('status', 'billed')
      .order('closed_at', { ascending: false })
    setCreditBills(data || [])
    setCreditLoading(false)
    setCreditLoaded(true)
  }

  function openCreditTab() {
    setMainTab('credit')
    if (!creditLoaded) loadCredit()
  }

  async function toggleHistory(cust) {
    if (expandedId === cust.id) { setExpandedId(null); return }
    setExpandedId(cust.id)
    if (historyMap[cust.id]) return
    setHistoryMap(m => ({ ...m, [cust.id]: 'loading' }))
    const { data } = await scopedFrom('pos_orders', 'id, order_no, invoice_no, invoice_fy, close_type, payment_method, paid_amount, closed_at, credit_settled_at')
      .eq('status', 'billed').eq('buyer_phone', cust.phone)
      .order('closed_at', { ascending: false }).limit(50)
    setHistoryMap(m => ({ ...m, [cust.id]: data || [] }))
  }

  // Opens the Settle panel — for a Foodmandu/Pathao bill, also fetches this order's own items to
  // compute its ex-VAT (post-discount) value, the basis both platforms actually calculate
  // commission on (confirmed with the client — not the final VAT-inclusive total), and pre-fills
  // the commission % from the client's configured rate so it's a starting point to confirm/adjust
  // against the platform's real remittance, not a silent default.
  async function openSettle(order) {
    setSettlingId(order.id)
    setSettleMsg('')
    setSettleCommissionPct('')
    setSettleExVatBase(null)
    if (!order.delivery_partner) return
    const partner = billingSettings.delivery_partners.find(p => p.name === order.delivery_partner)
    const defaultPct = partner?.commission_pct
    setSettleCommissionPct(defaultPct != null ? String(defaultPct) : '')
    setSettleExVatLoading(true)
    const { data: items } = await scopedFrom('pos_order_items', 'qty, unit_price, vat_rate').eq('order_id', order.id)
    const amounts = computeOrderAmounts(order, items || [], vatReg)
    setSettleExVatBase(amounts.taxableBase + amounts.nonTaxableBase)
    setSettleExVatLoading(false)
  }

  async function settleBill(order, method) {
    setSettleBusy(true); setSettleMsg('')
    const patch = {
      credit_settled_at:     new Date().toISOString(),
      credit_settled_by:     profile?.id || null,
      credit_settled_method: method,
    }
    if (order.delivery_partner && settleExVatBase != null) {
      const pct = parseFloat(settleCommissionPct) || 0
      patch.commission_amount = Math.round(settleExVatBase * pct / 100)
    }
    const { error } = await scopedUpdate('pos_orders', patch).eq('id', order.id)
    setSettleBusy(false)
    if (error) { setSettleMsg('error:' + error.message); return }
    setSettleMsg(`ok:${fmtNpr(order.paid_amount)} collected from ${order.buyer_name || 'customer'} via ${method}.`)
    setSettlingId(null)
    await loadCredit()
  }

  const vatReg = billingSettings.is_vat_registered
  const prefix = billingSettings.invoice_prefix
  const settleCommissionAmt = settleExVatBase != null ? Math.round(settleExVatBase * (parseFloat(settleCommissionPct) || 0) / 100) : 0

  const q = search.trim().toLowerCase()
  const filteredCustomers = q
    ? customers.filter(c => (c.name || '').toLowerCase().includes(q) || (c.phone || '').includes(q))
    : customers

  const unsettled = creditBills.filter(b => !b.credit_settled_at)
  const settled   = creditBills.filter(b => b.credit_settled_at)
  const outstandingTotal = unsettled.reduce((s, b) => s + (b.paid_amount || 0), 0)

  return (
    <div style={{ padding: '24px 28px', maxWidth: 1100 }}>

      <div style={{ marginBottom: 20 }}>
        <h2 style={{ margin: 0, color: 'var(--theme-text1)', fontSize: 20 }}>Customers</h2>
        <p style={{ margin: '4px 0 0', fontSize: 13, color: 'var(--theme-text3)' }}>
          Customer book built automatically from billed orders, and outstanding Credit bills awaiting collection.
        </p>
      </div>

      <div className="tab-bar" style={{ marginBottom: 24 }}>
        <Tip text="Every bill closed with buyer Name + Phone (any discount or Credit sale requires them) adds or updates a customer here automatically — no manual entry needed">
          <button
            className={`tab-btn${mainTab === 'customers' ? ' tab-btn--active' : ''}`}
            onClick={() => setMainTab('customers')}
          >Customers</button>
        </Tip>
        <Tip text="Credit bills closed at Charge but not yet collected. Settle one here when the customer pays — pick the payment method actually used">
          <button
            className={`tab-btn${mainTab === 'credit' ? ' tab-btn--active' : ''}`}
            onClick={openCreditTab}
          >
            Outstanding Credit
            {creditLoaded && unsettled.length > 0 && (
              <span className="badge-amber" style={{ marginLeft: 6, fontSize: 11, padding: '1px 7px', borderRadius: 8 }}>{unsettled.length}</span>
            )}
          </button>
        </Tip>
      </div>

      {/* ══ CUSTOMERS TAB ══ */}
      {mainTab === 'customers' && (
        <>
          <input
            className="form-select"
            style={{ width: 320, maxWidth: '100%', marginBottom: 16 }}
            placeholder="Search by name or phone…"
            value={search}
            onChange={e => setSearch(e.target.value)}
          />

          {custLoading ? (
            <p style={{ color: 'var(--theme-text3)', fontSize: 13 }}>Loading…</p>
          ) : filteredCustomers.length === 0 ? (
            <div className="card" style={{ padding: 32, textAlign: 'center', color: 'var(--theme-text3)', fontSize: 13 }}>
              {customers.length === 0
                ? 'No customers yet — the book fills automatically as bills are closed with buyer Name + Phone.'
                : 'No customers match your search.'}
            </div>
          ) : (
            <div className="table-wrap">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Phone</th>
                    <th>Address</th>
                    <th><Tip text="Customer's own PAN, if given for a full tax invoice" width={200}>PAN</Tip></th>
                    <th><Tip text="When this customer first appeared on a bill" width={200}>Since</Tip></th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {filteredCustomers.map(c => (
                    <Fragment key={c.id}>
                      <tr onClick={() => toggleHistory(c)} style={{ cursor: 'pointer' }}>
                        <td style={{ fontWeight: 600, color: 'var(--theme-text1)' }}>{c.name}</td>
                        <td>{c.phone}</td>
                        <td>{c.address || '—'}</td>
                        <td>{c.pan || '—'}</td>
                        <td>{c.created_at ? new Date(c.created_at).toLocaleDateString() : '—'}</td>
                        <td style={{ textAlign: 'right', color: 'var(--theme-text3)', fontSize: 12 }}>
                          {expandedId === c.id ? '▲ hide orders' : '▼ orders'}
                        </td>
                      </tr>
                      {expandedId === c.id && (
                        <tr>
                          <td colSpan={6} style={{ background: 'var(--theme-bg)', padding: '10px 18px' }}>
                            {historyMap[c.id] === 'loading' || !historyMap[c.id] ? (
                              <span style={{ fontSize: 12, color: 'var(--theme-text3)' }}>Loading order history…</span>
                            ) : historyMap[c.id].length === 0 ? (
                              <span style={{ fontSize: 12, color: 'var(--theme-text3)' }}>No billed orders found for this phone number.</span>
                            ) : (
                              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                                {historyMap[c.id].map(o => (
                                  <div key={o.id} style={{ display: 'flex', gap: 14, alignItems: 'baseline', fontSize: 12, color: 'var(--theme-text2)' }}>
                                    <span style={{ minWidth: 84 }}>{o.closed_at ? new Date(o.closed_at).toLocaleDateString() : ''}</span>
                                    <span style={{ minWidth: 120, fontWeight: 600, color: 'var(--theme-text1)' }}>{invoiceLabel(o, vatReg, prefix)}</span>
                                    <span style={{ minWidth: 70 }}>{o.close_type === 'writeoff' ? 'Comp' : o.payment_method}</span>
                                    <span style={{ minWidth: 90, fontWeight: 600 }}>{o.paid_amount != null ? fmtNpr(o.paid_amount) : '—'}</span>
                                    {o.payment_method === 'Credit' && (
                                      o.credit_settled_at
                                        ? <span className="badge-green" style={{ fontSize: 10 }}>Collected</span>
                                        : <span className="badge-amber" style={{ fontSize: 10 }}>Outstanding</span>
                                    )}
                                  </div>
                                ))}
                              </div>
                            )}
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}

      {/* ══ OUTSTANDING CREDIT TAB ══ */}
      {mainTab === 'credit' && (
        <>
          {creditLoading ? (
            <p style={{ color: 'var(--theme-text3)', fontSize: 13 }}>Loading…</p>
          ) : (
            <>
              <div className="stat-grid" style={{ marginBottom: 20 }}>
                <div className="card" style={{ padding: '14px 18px' }}>
                  <div style={{ fontSize: 11, color: 'var(--theme-text3)', textTransform: 'uppercase', letterSpacing: '0.07em' }}>
                    <Tip text="Total amount owed across all unsettled Credit bills" width={220}>Outstanding</Tip>
                  </div>
                  <div style={{ fontSize: 22, fontWeight: 700, color: unsettled.length > 0 ? 'var(--theme-amber)' : 'var(--theme-green)' }}>
                    {fmtNpr(outstandingTotal)}
                  </div>
                </div>
                <div className="card" style={{ padding: '14px 18px' }}>
                  <div style={{ fontSize: 11, color: 'var(--theme-text3)', textTransform: 'uppercase', letterSpacing: '0.07em' }}>Unsettled Bills</div>
                  <div style={{ fontSize: 22, fontWeight: 700, color: 'var(--theme-text1)' }}>{unsettled.length}</div>
                </div>
              </div>

              {settleMsg && (
                <p style={{ margin: '0 0 14px', fontSize: 13, color: settleMsg.startsWith('error:') ? 'var(--theme-red)' : 'var(--theme-green)' }}>
                  {settleMsg.replace(/^(error|ok):/, '')}
                </p>
              )}

              {unsettled.length === 0 ? (
                <div className="card" style={{ padding: 32, textAlign: 'center', color: 'var(--theme-text3)', fontSize: 13, marginBottom: 24 }}>
                  No outstanding credit — all Credit bills have been collected. 🎉
                </div>
              ) : (
                <div className="table-wrap" style={{ marginBottom: 24 }}>
                  <table className="data-table">
                    <thead>
                      <tr>
                        <th>Date</th>
                        <th>Bill No</th>
                        <th>Customer</th>
                        <th>Phone</th>
                        <th style={{ textAlign: 'right' }}>Amount</th>
                        <th><Tip text="How long this bill has been outstanding" width={200}>Age</Tip></th>
                        <th></th>
                      </tr>
                    </thead>
                    <tbody>
                      {unsettled.map(b => (
                        <Fragment key={b.id}>
                        <tr>
                          <td>{b.closed_at ? new Date(b.closed_at).toLocaleDateString() : '—'}</td>
                          <td style={{ fontWeight: 600, color: 'var(--theme-text1)' }}>{invoiceLabel(b, vatReg, prefix)}</td>
                          <td>
                            {b.buyer_name && b.buyer_name !== b.delivery_partner ? `${b.buyer_name} ` : ''}
                            {b.delivery_partner
                              ? <span style={{ color: 'var(--theme-amber)', fontWeight: 600 }}>{b.delivery_partner}</span>
                              : (b.buyer_name || '—')}
                          </td>
                          <td>{b.buyer_phone || '—'}</td>
                          <td style={{ textAlign: 'right', fontWeight: 700, color: 'var(--theme-amber)' }}>{fmtNpr(b.paid_amount || 0)}</td>
                          <td>{b.closed_at ? daysAgo(b.closed_at) : '—'}</td>
                          <td style={{ textAlign: 'right' }}>
                            {settlingId === b.id ? (
                              <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end', flexWrap: 'wrap' }}>
                                {SETTLE_METHODS.map(m => (
                                  <button key={m} className="btn btn-ghost" disabled={settleBusy}
                                    style={{ fontSize: 12, padding: '4px 10px' }}
                                    onClick={() => settleBill(b, m)}>{m}</button>
                                ))}
                                <button className="btn btn-ghost" disabled={settleBusy}
                                  style={{ fontSize: 12, padding: '4px 10px', color: 'var(--theme-text3)' }}
                                  onClick={() => setSettlingId(null)}>✕</button>
                              </div>
                            ) : (
                              <button className="btn btn-primary" style={{ fontSize: 12, padding: '5px 14px' }}
                                onClick={() => openSettle(b)}>
                                Settle
                              </button>
                            )}
                          </td>
                        </tr>
                        {settlingId === b.id && b.delivery_partner && (
                          <tr>
                            <td colSpan={7} style={{ background: 'var(--theme-bg)', padding: '10px 18px' }}>
                              <div style={{ display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap' }}>
                                <span style={{ fontSize: 12, color: 'var(--theme-text3)' }}>
                                  <Tip text="Confirm against the platform's actual remittance statement — this is a starting suggestion from Table Management → Delivery Partners, not a locked-in figure" width={280}>
                                    {b.delivery_partner} commission
                                  </Tip>
                                </span>
                                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                                  <input type="number" min="0" max="100" step="0.1" className="form-select" style={{ width: 80 }}
                                    value={settleCommissionPct} onChange={e => setSettleCommissionPct(e.target.value)} placeholder="%" />
                                  <span style={{ fontSize: 12, color: 'var(--theme-text3)' }}>%</span>
                                </div>
                                {settleExVatLoading ? (
                                  <span style={{ fontSize: 12, color: 'var(--theme-text3)' }}>Calculating…</span>
                                ) : settleExVatBase != null && (
                                  <span style={{ fontSize: 12, color: 'var(--theme-text2)' }}>
                                    = {fmtNpr(settleCommissionAmt)} commission → net {fmtNpr((b.paid_amount || 0) - settleCommissionAmt)}
                                  </span>
                                )}
                              </div>
                            </td>
                          </tr>
                        )}
                        </Fragment>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              {settled.length > 0 && (
                <>
                  <p style={{ fontSize: 11, color: 'var(--theme-text3)', textTransform: 'uppercase', letterSpacing: '0.07em', margin: '0 0 8px' }}>
                    Collected
                  </p>
                  <div className="table-wrap">
                    <table className="data-table">
                      <thead>
                        <tr>
                          <th>Billed</th>
                          <th>Bill No</th>
                          <th>Customer</th>
                          <th style={{ textAlign: 'right' }}>Amount</th>
                          <th style={{ textAlign: 'right' }}>
                            <Tip text="Foodmandu/Pathao only — confirmed at settlement against their actual remittance" width={240}>Commission</Tip>
                          </th>
                          <th style={{ textAlign: 'right' }}>Net Received</th>
                          <th>Collected</th>
                          <th>Via</th>
                        </tr>
                      </thead>
                      <tbody>
                        {settled.map(b => (
                          <tr key={b.id}>
                            <td>{b.closed_at ? new Date(b.closed_at).toLocaleDateString() : '—'}</td>
                            <td style={{ fontWeight: 600, color: 'var(--theme-text1)' }}>{invoiceLabel(b, vatReg, prefix)}</td>
                            <td>
                              {b.buyer_name && b.buyer_name !== b.delivery_partner ? `${b.buyer_name} ` : ''}
                              {b.delivery_partner
                                ? <span style={{ color: 'var(--theme-amber)', fontWeight: 600 }}>{b.delivery_partner}</span>
                                : (b.buyer_name || '—')}
                            </td>
                            <td style={{ textAlign: 'right', fontWeight: 600 }}>{fmtNpr(b.paid_amount || 0)}</td>
                            <td style={{ textAlign: 'right', color: 'var(--theme-text3)' }}>{b.delivery_partner ? fmtNpr(b.commission_amount || 0) : '—'}</td>
                            <td style={{ textAlign: 'right' }}>{b.delivery_partner ? fmtNpr((b.paid_amount || 0) - (b.commission_amount || 0)) : '—'}</td>
                            <td>{new Date(b.credit_settled_at).toLocaleDateString()}</td>
                            <td><span className="badge-green" style={{ fontSize: 11 }}>{b.credit_settled_method}</span></td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </>
              )}
            </>
          )}
        </>
      )}
    </div>
  )
}
