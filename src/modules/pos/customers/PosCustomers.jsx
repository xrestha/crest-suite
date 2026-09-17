import { npr } from '../../../shared/nepalMoney'
import { Fragment, useState, useEffect, useMemo } from 'react'
import { Navigate } from 'react-router-dom'
import { useAuth } from '../../../context/AuthContext'
import { supabase } from '../../../supabaseClient'
import { useScopedDb } from '../../../shared/hooks/useScopedDb'
import { fetchAllRows } from '../../../shared/fetchAllRows'
import Tip from '../../../components/Tip'
import RowDisclosure from '../../../components/RowDisclosure'
import { computeOrderAmounts } from '../../../utils/posBillingMath'
import LoyaltyTab from './LoyaltyTab'
import { IDENTITY_BADGE } from '../posSignals'
import { normalizePhone } from '../../../utils/phone'
import { errorText } from '../../../shared/errorText'
import ReportLoadError from '../../../components/ReportLoadError'
import { BS_MONTHS } from '../../../utils/bsCalendar'
import { nepalBs, nepalDateAd } from '../../../shared/nepalTime'

// Cheque + Bank Transfer are settlement-only (how a receivable is remitted) — not counter-payment
// methods, so they're not in PAYMENT_METHODS. Foodmandu/Pathao typically remit by Bank Transfer.
const SETTLE_METHODS = ['Cash', 'Card', 'eSewa', 'Khalti', 'FonePay', 'Cheque', 'Bank Transfer']
const fmtNpr = npr

function invoiceLabel(order, vatReg, prefix) {
  if (order.invoice_no == null) return `#${order.order_no ?? ''}`
  if (order.close_type === 'writeoff') return `NC-${String(order.invoice_no).padStart(2, '0')}`
  return `${vatReg ? 'TI' : 'PB'}${order.invoice_no}-${prefix}${prefix ? '-' : ''}${order.invoice_fy || ''}`
}

// S754: these dates were `new Date(ts).toLocaleDateString()` — AD, in the VIEWER's locale and
// timezone (so 9/4/2026 or 04.09.2026, and the previous day for an operator abroad). BS as read in
// Nepal, like every other POS page; AD only past the verified BS table.
function bsDate(ts) {
  if (!ts) return '—'
  const bs = nepalBs(ts)
  return bs ? `${bs.day} ${BS_MONTHS[bs.month - 1]} ${bs.year}` : `${nepalDateAd(ts)} (AD)`
}

function daysAgo(iso) {
  const d = Math.floor((Date.now() - new Date(iso).getTime()) / 86400000)
  return d <= 0 ? 'today' : d === 1 ? '1 day' : `${d} days`
}

export default function PosCustomers() {
  const { clientId, profile, hasPosAccess, hasFeature } = useAuth()
  const { scopedFrom, scopedInsert, scopedUpdate } = useScopedDb()

  const [mainTab, setMainTab] = useState('customers') // 'customers' | 'credit' | 'loyalty'
  // What one point is worth, held here rather than inside LoyaltyTab because the tab is
  // unmounted whenever another tab is open and would re-read it on every visit.
  const [pointValue, setPointValue] = useState(1)

  // Customers
  const [customers, setCustomers] = useState([])
  const [custLoading, setCustLoading] = useState(true)
  const [custError, setCustError] = useState(null) // S754
  // phone_canonical → no-show count from the reservations book (S677). null until read, so a
  // failed read renders as "unknown" rather than as a clean record for everyone.
  const [noShowByPhone, setNoShowByPhone] = useState(null)
  const [search, setSearch] = useState('')
  const [expandedId, setExpandedId] = useState(null)
  const [historyMap, setHistoryMap] = useState({})   // { customerId: orders[] | 'loading' }

  // Credit
  const [creditBills, setCreditBills] = useState([])
  const [creditLoading, setCreditLoading] = useState(false)
  const [creditLoaded, setCreditLoaded] = useState(false)
  const [creditError, setCreditError] = useState(null) // S754
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
  // S754: whether the settings row above was actually read. The defaults are a guess —
  // `is_vat_registered: true` in particular changes the commission base openSettle computes (ex-VAT
  // vs VAT-inclusive, ~13 points on every partner bill) — so settling waits on a real read, and a
  // failed one blocks it. null = still loading, true = read, an error object = the read failed.
  const [settingsRead, setSettingsRead] = useState(null)

  useEffect(() => {
    if (!clientId) return
    loadCustomers()
    supabase.from('settings')
      .select('is_vat_registered, invoice_prefix, pos_delivery_partners, pos_loyalty_point_value')
      .eq('client_id', clientId).maybeSingle()
      .then(({ data, error }) => {
        if (error) { setSettingsRead(error); return }
        setSettingsRead(true)
        setBillingSettings({
          is_vat_registered: data?.is_vat_registered ?? true,
          invoice_prefix: data?.invoice_prefix || '',
          delivery_partners: data?.pos_delivery_partners || [],
        })
        // Defaults to 1 rather than 0 — a zero point value would silently make every balance
        // worth nothing at the till while the numbers still read fine on this page.
        setPointValue(Number(data?.pos_loyalty_point_value) || 1)
      })
  }, [clientId]) // eslint-disable-line

  // Memoized as one pass over creditBills — every Credit bill ever, so this is the array that
  // grows with the age of the account. Without it the whole rollup re-ran on every keystroke in
  // the Customers tab's search box, which has nothing to do with credit at all, and on every
  // field of the Settle panel. It sits above the access guard below because a hook must.
  const { unsettled, settled, outstandingTotal, creditByCounterparty, counterpartyTotals, creditNotedUnsettled } = useMemo(() => {
    // S754: a Credit bill with a credit note against it has been cancelled — the note already took
    // its revenue back — so it is no longer owed. It used to sit in Outstanding forever, inflating
    // the KPI and inviting someone to "collect" it. Dropped from every figure below together, so
    // the per-partner rollup still ties to the KPI card. A settled bill that was later
    // credit-noted stays in Collected: that money genuinely changed hands.
    const countable = creditBills.filter(b => !(b.credit_note_id && !b.credit_settled_at))
    const unsettledBillsList = countable.filter(b => !b.credit_settled_at)
    const settledBillsList   = countable.filter(b => b.credit_settled_at)

    // Both halves of this tab grouped by who actually owes the money — the same per-partner view
    // Sales Report → Delivery Partners now gives, mirrored here because this is the screen someone
    // is on when they chase Foodmandu for a remittance. Before it existed, neither screen grouped
    // by partner at all: the platform was a tag on a bill everywhere and never a subject with its
    // own total, so "what does Pathao owe me" meant reading down a column and adding it up.
    //
    // Non-partner Credit is kept as its own row rather than filtered out, so the Outstanding column
    // still ties to the KPI card directly above it — a rollup that doesn't reconcile with the total
    // beside it is worse than no rollup (S567).
    //
    // Deliberately NOT the same figures as the report's: this page is every Credit bill ever, that
    // one is a date range. The note under the table says so, because two screens showing the same
    // words and different numbers is a support call.
    const byCounterparty = Object.values(countable.reduce((acc, b) => {
      const key = b.delivery_partner || '__DIRECT__'
      const g = acc[key] = acc[key] || {
        key, label: b.delivery_partner || 'Direct customers', isPartner: !!b.delivery_partner,
        unsettledBills: 0, outstanding: 0, settledBills: 0, commission: 0, netReceived: 0,
      }
      const amt = b.paid_amount || 0
      if (b.credit_settled_at) {
        const comm = parseFloat(b.commission_amount) || 0
        g.settledBills += 1
        g.commission += comm
        g.netReceived += amt - comm
      } else {
        g.unsettledBills += 1
        g.outstanding += amt
      }
      return acc
    }, {})).sort((a, b) => (b.outstanding - a.outstanding) || (b.netReceived - a.netReceived))

    return {
      unsettled: unsettledBillsList,
      settled: settledBillsList,
      outstandingTotal: unsettledBillsList.reduce((s, b) => s + (b.paid_amount || 0), 0),
      creditByCounterparty: byCounterparty,
      counterpartyTotals: byCounterparty.reduce((s, g) => ({
        unsettledBills: s.unsettledBills + g.unsettledBills, outstanding: s.outstanding + g.outstanding,
        settledBills: s.settledBills + g.settledBills, commission: s.commission + g.commission,
        netReceived: s.netReceived + g.netReceived,
      }), { unsettledBills: 0, outstanding: 0, settledBills: 0, commission: 0, netReceived: 0 }),
      creditNotedUnsettled: creditBills.length - countable.length,
    }
  }, [creditBills])

  if (!hasPosAccess('supervisor')) return <Navigate to="/pos" replace />

  async function loadCustomers() {
    setCustLoading(true)
    // Paged. The customer book grows forever — a row per unique phone that has ever been on a
    // bill — so it is one of the few POS tables with no period to bound it, and a bare select
    // would quietly stop at 1000 with no error: the missing regulars simply would not be found
    // by the search box, and nothing on screen would say why.
    const [{ data, error: custErr }, { data: noShows, error: nsErr }] = await Promise.all([
      fetchAllRows(() => scopedFrom('pos_customers').order('name').order('id')),
      // One row per no-show ever recorded — unbounded like the book itself, so paged too.
      fetchAllRows(() => scopedFrom('pos_reservations', 'id, phone_canonical').eq('status', 'no_show').order('id')),
    ])
    // S754: a failed book read rendered "No customers yet — the book fills automatically…", a
    // confident statement about a customer book the page never read.
    setCustError(custErr || null)
    setCustomers(custErr ? [] : (data || []))
    if (nsErr) { console.error('no-show read failed, column shows unknown:', nsErr); setNoShowByPhone(null) }
    else {
      const m = {}
      for (const r of noShows || []) { if (r.phone_canonical) m[r.phone_canonical] = (m[r.phone_canonical] || 0) + 1 }
      setNoShowByPhone(m)
    }
    setCustLoading(false)
  }

  async function loadCredit() {
    setCreditLoading(true)
    // Paged: unbounded by date — every Credit bill ever — so this is the read that gets worse
    // the longer the system is used, and outstandingTotal below is the figure an owner chases.
    const { data, error } = await fetchAllRows(() => scopedFrom('pos_orders', 'id, order_no, invoice_no, invoice_fy, close_type, paid_amount, discount_amount, buyer_name, buyer_phone, delivery_partner, commission_amount, closed_at, credit_settled_at, credit_settled_method, credit_note_id')
      .eq('payment_method', 'Credit').eq('status', 'billed')
      .order('closed_at', { ascending: false }).order('id'))
    setCreditLoading(false)
    // S754: a failed read rendered NPR 0 outstanding and "all Credit bills have been collected 🎉".
    // The error card replaces the whole tab; left un-loaded so reopening the tab retries.
    if (error) { setCreditError(error); return }
    setCreditError(null)
    setCreditBills(data || [])
    setCreditLoaded(true)
  }

  function openCreditTab() {
    setMainTab('credit')
    if (!creditLoaded) loadCredit()
  }

  async function toggleHistory(cust) {
    if (expandedId === cust.id) { setExpandedId(null); return }
    setExpandedId(cust.id)
    // A cached failure is not a result — re-expanding retries it (S754).
    if (historyMap[cust.id] && !historyMap[cust.id].error) return
    setHistoryMap(m => ({ ...m, [cust.id]: 'loading' }))
    const { data, error } = await scopedFrom('pos_orders', 'id, order_no, invoice_no, invoice_fy, close_type, payment_method, paid_amount, closed_at, credit_settled_at, credit_note_id')
      .eq('status', 'billed').eq('buyer_phone', cust.phone)
      .order('closed_at', { ascending: false }).limit(50)
    // S754: a failed read said "No billed orders found for this phone number".
    setHistoryMap(m => ({ ...m, [cust.id]: error ? { error } : (data || []) }))
  }

  // S754: a settlement stores a commission and posts cash off figures that depend on settings, so
  // it must not run on the fallback defaults. Returns the refusal sentence, or '' when it may go.
  // Nothing is written before this check, so "nothing was settled" is true.
  function settingsBlockReason() {
    if (settingsRead === true) return ''
    if (settingsRead === null) return "error:This outlet's billing settings are still loading — nothing was settled. Try Settle again in a moment."
    return "error:Could not read this outlet's billing settings (VAT registration and delivery-partner rates), so the settlement cannot be worked out — nothing was settled. Reload the page and try again. " + errorText(settingsRead, 'operator')
  }

  // Opens the Settle panel — for a Foodmandu/Pathao bill, also fetches this order's own items to
  // compute its ex-VAT (post-discount) value, the basis both platforms actually calculate
  // commission on (confirmed with the client — not the final VAT-inclusive total), and pre-fills
  // the commission % from the client's configured rate so it's a starting point to confirm/adjust
  // against the platform's real remittance, not a silent default.
  async function openSettle(order) {
    setSettleMsg('')
    const blocked = settingsBlockReason()
    if (blocked) { setSettlingId(null); setSettleMsg(blocked); return }
    setSettlingId(order.id)
    setSettleCommissionPct('')
    setSettleExVatBase(null)
    if (!order.delivery_partner) return
    const partner = billingSettings.delivery_partners.find(p => p.name === order.delivery_partner)
    const defaultPct = partner?.commission_pct
    setSettleCommissionPct(defaultPct != null ? String(defaultPct) : '')
    setSettleExVatLoading(true)
    const { data: items, error: itemsErr } = await scopedFrom('pos_order_items', 'qty, unit_price, vat_rate, comped').eq('order_id', order.id)
    if (itemsErr) {
      // A dropped read here used to give an ex-VAT base of 0, and settleBill then STORED
      // commission_amount = 0 on the settlement with no warning (S682). settleBill refuses while
      // the base is unknown, and this says why.
      setSettleExVatLoading(false)
      setSettleMsg('error:Could not load this bill\'s lines, so the commission cannot be worked out — nothing was settled. Close this and try Settle again. ' + errorText(itemsErr, 'operator'))
      return
    }
    // Excludes comped items — commission has nothing to withhold on a line that was never
    // actually charged, same exclusion every other revenue calc in this codebase applies.
    const amounts = computeOrderAmounts(order, (items || []).filter(i => !i.comped), vatReg)
    setSettleExVatBase(amounts.taxableBase + amounts.nonTaxableBase)
    setSettleExVatLoading(false)
  }

  async function settleBill(order, method) {
    const blocked = settingsBlockReason()
    if (blocked) { setSettleMsg(blocked); return }
    if (order.delivery_partner && settleExVatBase == null) {
      setSettleMsg('error:This bill\'s commission base has not loaded, so it cannot be settled yet — close this and try Settle again.')
      return
    }
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
    // S754: `.is('credit_settled_at', null)` + `.select('id')` make a double-settle visible. Two
    // terminals (or a double tap) settling the same bill used to both "succeed" — the second
    // overwrote the first's method and commission and posted the cash to the drawer a second time.
    // Zero rows back is proof nothing was written, so it may say so.
    const { data: settledRows, error } = await scopedUpdate('pos_orders', patch)
      .eq('id', order.id).is('credit_settled_at', null).select('id')
    setSettleBusy(false)
    if (error) { setSettleMsg('error:The bill was not marked as settled. ' + errorText(error, 'operator')); return }
    if (!settledRows || settledRows.length === 0) {
      setSettleMsg('error:This bill had already been settled — nothing was changed and no cash was added to the drawer. The list below has been refreshed.')
      setSettlingId(null)
      await loadCredit()
      return
    }
    // What actually reached us. A delivery partner remits the bill LESS its commission, so a Cash
    // settlement puts paid_amount − commission in the drawer, not paid_amount — posting the gross
    // left every such shift reading "short" by the commission (S754). Direct customers have no
    // commission_amount on the patch and pay the whole bill.
    const collected = (order.paid_amount || 0) - (patch.commission_amount || 0)

    // A CASH settlement puts real money in the drawer, but the order's payment_method stays
    // 'Credit' forever — so the shift's cash bucket never saw it and the drawer read as "over"
    // by the settled amount, with no way for the supervisor to explain it (S573). Post it to the
    // open shift's cash ledger. Best-effort: a failed ledger write must not undo a settlement the
    // customer has already paid for, so it warns rather than rolling back.
    let ledgerWarning = ''
    if (method === 'Cash') {
      const { data: openShift, error: shiftErr } = await scopedFrom('pos_shifts', 'id').eq('status', 'open').maybeSingle()
      if (shiftErr) {
        // A failed read is not "no shift is open" — that instruction sent the operator to record
        // a Cash In next shift while a shift was in fact open (S682).
        ledgerWarning = ` Could not check whether a shift is open, so this cash may not be on the drawer count — check the current shift's Cash In entries. ${errorText(shiftErr, 'operator')}`
      } else if (!openShift) {
        ledgerWarning = ' No shift is open, so this cash is not on any drawer reconciliation — record it as a Cash In when you open the next shift.'
      } else {
        const { error: mErr } = await scopedInsert('pos_cash_movements', {
          shift_id: openShift.id,
          direction: 'in',
          kind: 'credit_settlement',
          amount: collected,
          reason: `Credit bill settled — ${order.buyer_name || 'customer'}`,
          order_id: order.id,
          created_by: profile?.id || null,
        })
        // S754: the sentence, not the raw Postgres message.
        if (mErr) ledgerWarning = ` Warning: it could not be added to the open shift's cash count, so the drawer will read short by this amount — add it as a Cash In on the shift. ${errorText(mErr, 'operator')}`
      }
    }

    setSettleMsg(`ok:${fmtNpr(collected)} collected from ${order.buyer_name || 'customer'} via ${method}.${ledgerWarning}`)
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

  return (
    <div>

      <div className="page-header">
        <h1 className="page-title">Customers</h1>
        <p className="page-subtitle">
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
            {creditLoaded && !creditError && unsettled.length > 0 && (
              <span className="badge-amber" style={{ marginLeft: 6, fontSize: 11, padding: '1px 7px', borderRadius: 0 }}>{unsettled.length}</span>
            )}
          </button>
        </Tip>
        {hasFeature('loyalty') && (
          <Tip text="Points schemes, who is enrolled, and each member's balance. Points are earned automatically on any bill closed with a name and phone, and are spent at the till like a gift card">
            <button
              className={`tab-btn${mainTab === 'loyalty' ? ' tab-btn--active' : ''}`}
              onClick={() => setMainTab('loyalty')}
            >Loyalty</button>
          </Tip>
        )}
      </div>

      {/* ══ LOYALTY TAB ══ */}
      {mainTab === 'loyalty' && hasFeature('loyalty') && (
        <LoyaltyTab
          pointValue={pointValue}
          // S754 (owner decision): schemes, the point value and enrolment are a POS manager's or the
          // Owner's. hasPosAccess resolves admin and the Owner to manager, so this one test is the
          // pos_loyalty_schemes_guard / pos_customers_guard_loyalty / settings guard rank.
          canManage={hasPosAccess('manager')}
          onPointValueSaved={async v => {
            // settings is nullable-client_id, so it stays on raw supabase rather than scopedDb.
            // `.select('id')`: a client with no settings row matches nothing and returns no error,
            // which used to report the value as saved (S738's zero-rows rule). Returns the error, so
            // a pos_setup_rank refusal reaches the tab as its own sentence (S754).
            const { data, error } = await supabase.from('settings')
              .update({ pos_loyalty_point_value: v }).eq('client_id', clientId).select('id')
            if (error) return error
            // A sentence we wrote is returned as a string, so the tab shows it as written.
            if (!data?.length) return 'No settings row exists for this outlet yet, so the point value was not saved. Save any setting in POS Setup first, then try again.'
            setPointValue(v)
            return null
          }}
        />
      )}

      {/* ══ CUSTOMERS TAB ══ */}
      {mainTab === 'customers' && (
        <>
          <input aria-label="Search customers"
            className="form-input"
            style={{ width: 320, maxWidth: '100%', marginBottom: 16 }}
            placeholder="Search by name or phone…"
            value={search}
            onChange={e => setSearch(e.target.value)}
          />

          {custLoading ? (
            <p style={{ color: 'var(--theme-text3)', fontSize: 13 }}>Loading…</p>
          ) : custError ? (
            <ReportLoadError error={custError} />
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
                    <th style={{ textAlign: 'right' }}><Tip text="Bookings under this phone number that were marked No-show on the Reservations page. Shown on the booking form when they book again." width={260}>No-shows</Tip></th>
                    <th><Tip text="When this customer first appeared on a bill" width={200}>Since</Tip></th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {filteredCustomers.map(c => (
                    <Fragment key={c.id}>
                      <tr onClick={() => toggleHistory(c)} style={{ cursor: 'pointer' }}>
                        {/* RowDisclosure is the keyboard/SR path to the expansion — the row
                            onClick stays as the mouse convenience, never role="button" on the
                            tr, which would strip the row out of the table's structure. */}
                        <td style={{ fontWeight: 600, color: 'var(--theme-text1)' }}>
                          <RowDisclosure
                            expanded={expandedId === c.id}
                            onToggle={() => toggleHistory(c)}
                            label={`Order history for ${c.name}`}
                          /> {c.name}
                        </td>
                        <td>{c.phone}</td>
                        <td>{c.address || '—'}</td>
                        <td>{c.pan || '—'}</td>
                        <td style={{ textAlign: 'right' }}>
                          {noShowByPhone === null
                            ? <span style={{ color: 'var(--theme-text3)' }} title="Could not read the reservations book">?</span>
                            : (noShowByPhone[normalizePhone(c.phone)] || 0) > 0
                              ? <span className="badge badge-red">{noShowByPhone[normalizePhone(c.phone)]}</span>
                              : <span style={{ color: 'var(--theme-text3)' }}>0</span>}
                        </td>
                        <td style={{ whiteSpace: 'nowrap' }}>{bsDate(c.created_at)}</td>
                        {/* Mouse affordance only — the RowDisclosure carries aria-expanded, so
                            this duplicate hint stays out of the accessibility tree. */}
                        <td aria-hidden="true" style={{ textAlign: 'right', color: 'var(--theme-text3)', fontSize: 12 }}>
                          {expandedId === c.id ? '▲ hide orders' : '▼ orders'}
                        </td>
                      </tr>
                      {expandedId === c.id && (
                        <tr>
                          <td colSpan={7} style={{ background: 'var(--theme-bg)', padding: '10px 18px' }}>
                            {historyMap[c.id] === 'loading' || !historyMap[c.id] ? (
                              <span style={{ fontSize: 12, color: 'var(--theme-text3)' }}>Loading order history…</span>
                            ) : historyMap[c.id].error ? (
                              <ReportLoadError error={historyMap[c.id].error} />
                            ) : historyMap[c.id].length === 0 ? (
                              <span style={{ fontSize: 12, color: 'var(--theme-text3)' }}>No billed orders found for this phone number.</span>
                            ) : (
                              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                                {historyMap[c.id].map(o => (
                                  <div key={o.id} style={{ display: 'flex', gap: 14, alignItems: 'baseline', fontSize: 12, color: 'var(--theme-text2)' }}>
                                    <span style={{ minWidth: 84 }}>{o.closed_at ? bsDate(o.closed_at) : ''}</span>
                                    <span style={{ minWidth: 120, fontWeight: 600, color: 'var(--theme-text1)' }}>{invoiceLabel(o, vatReg, prefix)}</span>
                                    <span style={{ minWidth: 70 }}>{o.close_type === 'writeoff' ? 'Comp' : o.payment_method}</span>
                                    <span style={{ minWidth: 90, fontWeight: 600 }}>{o.paid_amount != null ? fmtNpr(o.paid_amount) : '—'}</span>
                                    {o.payment_method === 'Credit' && (
                                      o.credit_settled_at
                                        ? <span className="badge-green" style={{ fontSize: 10 }}>Collected</span>
                                        // Same rule as the Outstanding Credit tab (S754): a credit-noted bill is not owed.
                                        : o.credit_note_id
                                          ? <span className="badge-gray" style={{ fontSize: 10 }}>Credit noted</span>
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
          ) : creditError ? (
            <>
              {/* A settle that succeeded and was followed by a failed refresh must still say it
                  succeeded — the message sits above the card, not inside the hidden list. */}
              {settleMsg && (
                <p style={{ margin: '0 0 14px', fontSize: 13, color: settleMsg.startsWith('error:') ? 'var(--theme-red-text)' : 'var(--theme-green-text)' }}>
                  {settleMsg.replace(/^(error|ok):/, '')}
                </p>
              )}
              <ReportLoadError error={creditError} />
            </>
          ) : (
            <>
              <div className="stat-grid" style={{ marginBottom: 20 }}>
                <div className="card" style={{ padding: '14px 18px' }}>
                  <div style={{ fontSize: 11, color: 'var(--theme-text3)', textTransform: 'uppercase', letterSpacing: '0.07em' }}>
                    <Tip text="Total amount owed across all unsettled Credit bills" width={220}>Outstanding</Tip>
                  </div>
                  <div style={{ fontSize: 22, fontWeight: 700, color: unsettled.length > 0 ? 'var(--theme-amber-text)' : 'var(--theme-green-text)' }}>
                    {fmtNpr(outstandingTotal)}
                  </div>
                </div>
                <div className="card" style={{ padding: '14px 18px' }}>
                  <div style={{ fontSize: 11, color: 'var(--theme-text3)', textTransform: 'uppercase', letterSpacing: '0.07em' }}>Unsettled Bills</div>
                  <div style={{ fontSize: 22, fontWeight: 700, color: 'var(--theme-text1)' }}>{unsettled.length}</div>
                </div>
              </div>
              {creditNotedUnsettled > 0 && (
                <p style={{ margin: '-8px 0 18px', fontSize: 12, color: 'var(--theme-text3)' }}>
                  {creditNotedUnsettled} unsettled Credit bill{creditNotedUnsettled === 1 ? ' has' : 's have'} a
                  Credit Note against {creditNotedUnsettled === 1 ? 'it' : 'them'} and {creditNotedUnsettled === 1 ? 'is' : 'are'} not
                  counted anywhere on this tab — the note cancelled the bill, so nothing is owed on it.
                </p>
              )}

              {creditBills.length > 0 && (
                <>
                  <p style={{ fontSize: 11, color: 'var(--theme-text3)', textTransform: 'uppercase', letterSpacing: '0.07em', margin: '0 0 8px' }}>
                    Who owes what
                  </p>
                  <div className="table-wrap" style={{ marginBottom: 8 }}>
                    <table className="data-table">
                      <thead>
                        <tr>
                          <th>Counterparty</th>
                          <th style={{ textAlign: 'right' }}>
                            <Tip text="Bills this counterparty has not settled yet" width={220}>Unsettled</Tip>
                          </th>
                          <th style={{ textAlign: 'right' }}>Outstanding</th>
                          <th style={{ textAlign: 'right' }}>
                            <Tip text="Foodmandu/Pathao only — commission withheld across their settled bills, as entered from each remittance statement" width={280}>Commission</Tip>
                          </th>
                          <th style={{ textAlign: 'right' }}>
                            <Tip text="What actually reached you on the bills already settled, after commission" width={250}>Net Received</Tip>
                          </th>
                        </tr>
                      </thead>
                      <tbody>
                        {creditByCounterparty.map(g => (
                          <tr key={g.key}>
                            <td>
                              {g.isPartner
                                ? <span className={IDENTITY_BADGE} style={{ fontSize: 10 }}>{g.label}</span>
                                : <span style={{ color: 'var(--theme-text2)' }}>{g.label}</span>}
                            </td>
                            <td style={{ textAlign: 'right' }}>{g.unsettledBills || '—'}</td>
                            <td style={{ textAlign: 'right', fontWeight: g.outstanding > 0 ? 700 : 400, color: g.outstanding > 0 ? 'var(--theme-amber-text)' : 'var(--theme-text3)' }}>
                              {g.outstanding > 0 ? fmtNpr(g.outstanding) : '—'}
                            </td>
                            <td style={{ textAlign: 'right', color: 'var(--theme-text3)' }}>
                              {g.isPartner && g.settledBills > 0 ? fmtNpr(g.commission) : '—'}
                            </td>
                            <td style={{ textAlign: 'right' }}>{g.settledBills > 0 ? fmtNpr(g.netReceived) : '—'}</td>
                          </tr>
                        ))}
                      </tbody>
                      <tfoot>
                        <tr style={{ fontWeight: 700 }}>
                          <td>TOTAL</td>
                          <td style={{ textAlign: 'right' }}>{counterpartyTotals.unsettledBills}</td>
                          <td style={{ textAlign: 'right' }}>{fmtNpr(counterpartyTotals.outstanding)}</td>
                          <td style={{ textAlign: 'right' }}>{fmtNpr(counterpartyTotals.commission)}</td>
                          <td style={{ textAlign: 'right' }}>{fmtNpr(counterpartyTotals.netReceived)}</td>
                        </tr>
                      </tfoot>
                    </table>
                  </div>
                  <p style={{ margin: '0 0 22px', fontSize: 12, color: 'var(--theme-text3)' }}>
                    Every Credit bill ever, settled and unsettled — not a date range. To check what a platform withheld against the rate you agreed with it, and to see the same figures for one month, use Sales Report → Delivery Partners.
                  </p>
                </>
              )}

              {settleMsg && (
                <p style={{ margin: '0 0 14px', fontSize: 13, color: settleMsg.startsWith('error:') ? 'var(--theme-red-text)' : 'var(--theme-green-text)' }}>
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
                          <td style={{ whiteSpace: 'nowrap' }}>{bsDate(b.closed_at)}</td>
                          <td style={{ fontWeight: 600, color: 'var(--theme-text1)' }}>{invoiceLabel(b, vatReg, prefix)}</td>
                          <td>
                            {b.buyer_name && b.buyer_name !== b.delivery_partner ? `${b.buyer_name} ` : ''}
                            {b.delivery_partner
                              ? <span style={{ color: 'var(--theme-text2)', fontWeight: 600 }}>{b.delivery_partner}</span>
                              : (b.buyer_name || '—')}
                          </td>
                          <td>{b.buyer_phone || '—'}</td>
                          <td style={{ textAlign: 'right', fontWeight: 700, color: 'var(--theme-amber-text)' }}>{fmtNpr(b.paid_amount || 0)}</td>
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
                                  <Tip text="Confirm against the platform's actual remittance statement — this is a starting suggestion from POS Setup → Delivery Partners, not a locked-in figure" width={280}>
                                    {b.delivery_partner} commission
                                  </Tip>
                                </span>
                                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                                  <input aria-label={`${b.delivery_partner} commission percent`} type="number" min="0" max="100" step="0.1" className="form-input" style={{ width: 80 }}
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
                            <td style={{ whiteSpace: 'nowrap' }}>{bsDate(b.closed_at)}</td>
                            <td style={{ fontWeight: 600, color: 'var(--theme-text1)' }}>{invoiceLabel(b, vatReg, prefix)}</td>
                            <td>
                              {b.buyer_name && b.buyer_name !== b.delivery_partner ? `${b.buyer_name} ` : ''}
                              {b.delivery_partner
                                ? <span style={{ color: 'var(--theme-text2)', fontWeight: 600 }}>{b.delivery_partner}</span>
                                : (b.buyer_name || '—')}
                            </td>
                            <td style={{ textAlign: 'right', fontWeight: 600 }}>{fmtNpr(b.paid_amount || 0)}</td>
                            <td style={{ textAlign: 'right', color: 'var(--theme-text3)' }}>{b.delivery_partner ? fmtNpr(b.commission_amount || 0) : '—'}</td>
                            <td style={{ textAlign: 'right' }}>{b.delivery_partner ? fmtNpr((b.paid_amount || 0) - (b.commission_amount || 0)) : '—'}</td>
                            <td style={{ whiteSpace: 'nowrap' }}>{bsDate(b.credit_settled_at)}</td>
                            <td><span className={IDENTITY_BADGE} style={{ fontSize: 11 }}>{b.credit_settled_method}</span></td>
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
