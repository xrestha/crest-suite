import { npr } from '../../../shared/nepalMoney'
import { Fragment, memo, useCallback, useDeferredValue, useState, useEffect, useMemo, useRef } from 'react'
import { Navigate } from 'react-router-dom'
import { useAuth } from '../../../context/AuthContext'
import { supabase } from '../../../supabaseClient'
import { useScopedDb } from '../../../shared/hooks/useScopedDb'
import { fetchAllRows } from '../../../shared/fetchAllRows'
import Tip from '../../../components/Tip'
import Tabs from '../../../components/Tabs'
import RowDisclosure from '../../../components/RowDisclosure'
import { billVatRegistered } from '../../../utils/posBillingMath'
import LoyaltyTab from './LoyaltyTab'
import CreditTab from './CreditTab'
import { normalizePhone, phoneMatchesSearch } from '../../../utils/phone'
import ReportLoadError from '../../../components/ReportLoadError'
import ActionError, { asActionError } from '../../../components/ActionError'
import { BS_MONTHS } from '../../../utils/bsCalendar'
import { nepalBs, nepalDateAd } from '../../../shared/nepalTime'
import { useLatestRequest } from '../../../shared/hooks/useLatestRequest'
import { settleWithin } from '../../../utils/withTimeout'
import { SETTLE_READ_MS } from './settleCredit'
import { customerBookAfterRead } from './customerBook'
import { invoiceCodeOf } from '../../../shared/invoiceCode'
import MembershipTab, { CardBadge } from './MembershipTab'
import CustomerEditModal from './CustomerEditModal'
import { useMembershipTypes } from './useMembershipTypes'
import { customerIdsWithOccasion } from './occasions'
import { todayNepalIso } from '../orders/memberDiscount'
import { isPartPaid, owedOn, readReceiptLines, receiptTotalsByBill } from '../creditOwed'

const fmtNpr = npr

// S833 (S809.4 3l): how long this page's reads wait before they count as failed. The customer book
// is paged (every customer ever), so it gets Parking's list limit; the settings row and one
// customer's last 50 bills get the shorter read limit. The Credit tab bounds its own (CreditTab.jsx).
const LIST_READ_MS = 20000
const ROW_READ_MS = SETTLE_READ_MS

// TI or PB as the bill was issued (S809 2c): its own stamp, today's flag only for a bill with none.
function invoiceLabel(order, vatReg, current) {
  const prefix = invoiceCodeOf(order, current) // S834 (D35): the bill's own code
  if (order.invoice_no == null) return `#${order.order_no ?? ''}`
  if (order.close_type === 'writeoff') return `NC-${String(order.invoice_no).padStart(2, '0')}`
  return `${billVatRegistered(order, vatReg) ? 'TI' : 'PB'}${order.invoice_no}-${prefix}${prefix ? '-' : ''}${order.invoice_fy || ''}`
}

// S754: these dates were `new Date(ts).toLocaleDateString()` — AD, in the VIEWER's locale and
// timezone (so 9/4/2026 or 04.09.2026, and the previous day for an operator abroad). BS as read in
// Nepal, like every other POS page; AD only past the verified BS table.
function bsDate(ts) {
  if (!ts) return '—'
  const bs = nepalBs(ts)
  return bs ? `${bs.day} ${BS_MONTHS[bs.month - 1]} ${bs.year}` : `${nepalDateAd(ts)} (AD)`
}

const NO_ROWS = []

// The customer book's table (S842). Memoized and fed the DEFERRED search, so a keystroke repaints the
// box at once and the rows only when React has a moment: every character used to redraw the whole book.
// `onToggle` is a stable callback, so a keystroke changes none of these props.
// S843: each row also carries its membership card (as the till sees it today), a 🎂 when a birthday or
// anniversary falls in the next 7 days (Nepal's today), and Edit for the card, credit limit and dates.
const CustomerBookTable = memo(function CustomerBookTable({ rows, expandedId, historyMap, noShowByPhone, vatReg, prefix, onToggle, typesById, onEdit }) {
  const today = todayNepalIso()
  const soon = useMemo(() => customerIdsWithOccasion(rows, 7), [rows, today]) // eslint-disable-line react-hooks/exhaustive-deps
  return (
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
            <th><span className="sr-only">Edit</span></th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {rows.map(c => (
            <Fragment key={c.id}>
              <tr onClick={() => onToggle(c)} style={{ cursor: 'pointer' }}>
                {/* RowDisclosure is the keyboard/SR path to the expansion — the row
                    onClick stays as the mouse convenience, never role="button" on the
                    tr, which would strip the row out of the table's structure. */}
                <td style={{ fontWeight: 600, color: 'var(--theme-text1)' }}>
                  <RowDisclosure
                    expanded={expandedId === c.id}
                    onToggle={() => onToggle(c)}
                    label={`Order history for ${c.name}`}
                  /> {c.name}
                  {c.membership_type_id && <> <CardBadge customer={c} typesById={typesById} todayIso={today} /></>}
                  {soon.has(c.id) && (
                    <> <Tip text="A birthday or anniversary falls in the next 7 days. Customers → Membership lists them with a WhatsApp wish." width={260}>
                      <span role="img" aria-label="Birthday or anniversary in the next 7 days">🎂</span>
                    </Tip></>
                  )}
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
                <td style={{ textAlign: 'right' }}>
                  {/* Its own press, never the row's: the row's click opens the order history. */}
                  <button type="button" className="btn btn-ghost" aria-label={`Edit ${c.name}'s card, credit limit and dates`}
                    onClick={e => { e.stopPropagation(); onEdit(c) }}>Edit</button>
                </td>
                {/* Mouse affordance only — the RowDisclosure carries aria-expanded, so
                    this duplicate hint stays out of the accessibility tree. */}
                <td aria-hidden="true" style={{ textAlign: 'right', color: 'var(--theme-text3)', fontSize: 12 }}>
                  {expandedId === c.id ? '▲ hide orders' : '▼ orders'}
                </td>
              </tr>
              {expandedId === c.id && (
                <tr>
                  <td colSpan={8} style={{ background: 'var(--theme-bg)', padding: '10px 18px' }}>
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
                                  // S843: paid off in part by receipts; only when their read answered.
                                  : o.part_owed != null
                                    ? <span className="badge-amber" style={{ fontSize: 10 }}>Part paid · {fmtNpr(o.part_owed)} owed</span>
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
  )
})

export default function PosCustomers() {
  const { clientId, hasPosAccess, hasFeature } = useAuth()
  const { scopedFrom } = useScopedDb()

  // 'customers' | 'credit' | 'membership' | 'loyalty'. S843: the POS Dashboard's birthdays card links
  // to ?tab=membership.
  const [mainTab, setMainTab] = useState(() => (new URLSearchParams(window.location.search).get('tab') === 'membership' ? 'membership' : 'customers'))
  // What one point is worth, held here rather than inside LoyaltyTab because the tab is
  // unmounted whenever another tab is open and would re-read it on every visit.
  const [pointValue, setPointValue] = useState(1)

  // Customers. S833 (S809.4 3l): the book as last read, and for which outlet (customerBook.js). A
  // failed first read is the error card (S754); a reload that fails keeps the list and says it may be
  // out of date. A load is keyed on its outlet plus a counter, so only the newest one lands.
  const [book, setBook] = useState({ clientId: null, rows: null, error: null, stale: null })
  const custReq = useLatestRequest()
  const custSeq = useRef(0)
  // phone_canonical → no-show count from the reservations book (S677). null until read, so a
  // failed read renders as "unknown" rather than as a clean record for everyone.
  const [noShowByPhone, setNoShowByPhone] = useState(null)
  const [search, setSearch] = useState('')
  // S842: the list follows a deferred copy of the box, so typing never waits on the whole book.
  const deferredSearch = useDeferredValue(search)
  const [expandedId, setExpandedId] = useState(null)
  const [historyMap, setHistoryMap] = useState({})   // { customerId: orders[] | 'loading' }
  // The memoized table's row toggle: stable, reading the newest toggleHistory (set before the return).
  const toggleRef = useRef(null)
  const onToggleHistory = useCallback(c => toggleRef.current?.(c), [])

  // S843: membership card types (for the book's badges, the Membership tab and the edit dialog), and the
  // customer whose card, credit limit and dates are open for editing from the book.
  const typesState = useMembershipTypes()
  const [editing, setEditing] = useState(null)
  const [savedMsg, setSavedMsg] = useState('')
  const onEditCustomer = useCallback(c => { setSavedMsg(''); setEditing(c) }, [])
  // A save reads its row back; the book's copy takes what was stored.
  const onCustomerSaved = useCallback(row => {
    setBook(prev => (prev.rows ? { ...prev, rows: prev.rows.map(r => (r.id === row.id ? { ...r, ...row } : r)) } : prev))
  }, [])

  // Credit (S843: CreditTab.jsx). Only the count of unpaid bills lives here, for the tab's badge;
  // null until the tab has read it, and after a failed read.
  const [creditCount, setCreditCount] = useState(null)

  const [billingSettings, setBillingSettings] = useState({
    is_vat_registered: true, invoice_prefix: '', delivery_partners: [],
  })
  // S754: whether the settings row above was actually read. The defaults are a guess — the partners'
  // contracted rates pre-fill a delivery partner's commission in Receive payment (S843), and the flag
  // says TI or PB on a bill with no stamp of its own — so the Credit tab pre-fills only from a real
  // read. null = still loading, true = read, an error object = the read failed.
  const [settingsRead, setSettingsRead] = useState(null)

  useEffect(() => {
    if (!clientId) return
    let cancelled = false
    loadCustomers()
    // S833 (S809.4 3l): bounded. A hung read used to leave settingsRead null for ever, so the Credit tab
    // waited on it and Loyalty's point value waited with no end; a timeout is now the failed read
    // both already word. `cancelled`: an answer for an earlier run of this effect never lands.
    settleWithin(
      supabase.from('settings')
        .select('is_vat_registered, invoice_prefix, pos_delivery_partners, pos_loyalty_point_value')
        .eq('client_id', clientId).maybeSingle(),
      ROW_READ_MS, "Reading this outlet's billing settings",
    )
      .then(({ data, error }) => {
        if (cancelled) return
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
    return () => { cancelled = true }
  }, [clientId]) // eslint-disable-line

  // S842: filtered once per deferred search or book read, not per render.
  const customers = book.rows || NO_ROWS
  const q = deferredSearch.trim().toLowerCase()
  const filteredCustomers = useMemo(() => (q
    // S815 4g: a phone matches by its digits, so "+977 984…" finds the regular stored as 984….
    ? customers.filter(c => (c.name || '').toLowerCase().includes(q) || (c.phone || '').includes(q) || phoneMatchesSearch(c.phone, q))
    : customers), [customers, q])

  if (!hasPosAccess('supervisor')) return <Navigate to="/pos" replace />

  async function loadCustomers() {
    const forClient = clientId
    const key = custReq.begin(`${forClient}#${++custSeq.current}`) // before any await
    // Paged. The customer book grows forever — a row per unique phone that has ever been on a
    // bill — so it is one of the few POS tables with no period to bound it, and a bare select
    // would quietly stop at 1000 with no error: the missing regulars simply would not be found
    // by the search box, and nothing on screen would say why. S833: each read is bounded, so a hung
    // one is a failed read rather than "Loading…" for ever.
    const [{ data, error: custErr }, { data: noShows, error: nsErr }] = await Promise.all([
      settleWithin(fetchAllRows(() => scopedFrom('pos_customers').order('name').order('id')), LIST_READ_MS, 'Reading the customer book'),
      // One row per no-show ever recorded — unbounded like the book itself, so paged too.
      settleWithin(fetchAllRows(() => scopedFrom('pos_reservations', 'id, phone_canonical').eq('status', 'no_show').order('id')), LIST_READ_MS, 'Reading the no-shows'),
    ])
    if (!custReq.isCurrent(key)) return // a newer load owns the page
    // S754: a failed book read rendered "No customers yet — the book fills automatically…", a
    // confident statement about a customer book the page never read.
    if (custErr) console.error('customer book read failed:', custErr)
    setBook(prev => customerBookAfterRead(prev, forClient, { data, error: custErr }))
    if (nsErr) { console.error('no-show read failed, column shows unknown:', nsErr); setNoShowByPhone(null) }
    else {
      const m = {}
      for (const r of noShows || []) { if (r.phone_canonical) m[r.phone_canonical] = (m[r.phone_canonical] || 0) + 1 }
      setNoShowByPhone(m)
    }
  }

  async function toggleHistory(cust) {
    if (expandedId === cust.id) { setExpandedId(null); return }
    setExpandedId(cust.id)
    // A cached failure is not a result — re-expanding retries it (S754).
    if (historyMap[cust.id] && !historyMap[cust.id].error) return
    setHistoryMap(m => ({ ...m, [cust.id]: 'loading' }))
    // S815 4g: the stored phone and the number it is, so a bill an older till stored as typed
    // ("+977 98…") is listed beside the ones stored as the number since S809 3k.
    const phones = [...new Set([cust.phone, normalizePhone(cust.phone)].filter(Boolean))]
    // S833 (S809.4 3l): bounded, so a hung read is the row's error card (re-expanding retries it), not
    // "Loading order history…" for ever. Two reads for one row cannot overlap: while this one runs the
    // row holds 'loading', which the check above returns on, and a late answer past the limit is dropped.
    const { data, error } = await settleWithin(
      scopedFrom('pos_orders', 'id, order_no, invoice_no, invoice_fy, invoice_prefix, close_type, payment_method, paid_amount, closed_at, credit_settled_at, credit_note_id, vat_registered')
        .eq('status', 'billed').in('buyer_phone', phones)
        .order('closed_at', { ascending: false }).limit(50),
      ROW_READ_MS, "Reading this customer's bills",
    )
    // S843: an unpaid Credit bill may be paid off in part by receipts. Their read decides "Part paid";
    // when it fails the bills keep their plain label, never one that claims a payment.
    let orders = data || []
    const open = error ? [] : orders.filter(o => o.payment_method === 'Credit' && !o.credit_settled_at && !o.credit_note_id)
    if (open.length) {
      const lines = await settleWithin(readReceiptLines(scopedFrom, open.map(o => o.id)), ROW_READ_MS, "Reading this customer's payments")
      if (lines.error) console.error('receipt lines read failed, Credit bills keep their plain label:', lines.error)
      else {
        const totals = receiptTotalsByBill(lines.data)
        orders = orders.map(o => (open.includes(o) && isPartPaid(o.paid_amount, totals[o.id]) ? { ...o, part_owed: owedOn(o.paid_amount, totals[o.id]) } : o))
      }
    }
    // S754: a failed read said "No billed orders found for this phone number".
    setHistoryMap(m => ({ ...m, [cust.id]: error ? { error } : orders }))
  }

  const vatReg = billingSettings.is_vat_registered
  const prefix = billingSettings.invoice_prefix

  // S833: still loading until a read has landed for this outlet.
  const custLoading = !clientId || book.clientId !== clientId
  const custError = book.error
  toggleRef.current = toggleHistory

  return (
    <div>

      <div className="page-header">
        <h1 className="page-title">Customers</h1>
        <p className="page-subtitle">
          Customer book built automatically from billed orders, and Credit: who owes, payments received and their receipts.
        </p>
      </div>

      {/* `Tabs` since S841, so the open section is announced rather than shown by its tint alone.
          A section's hint rides as its tab's `title`: a Tip around a tab is not the tab. */}
      <Tabs idBase="pos-customers" label="Customers sections" active={mainTab} style={{ marginBottom: 24 }}
        onChange={setMainTab}
        tabs={[
          { key: 'customers', label: 'Customers', title: 'Every bill closed with buyer Name + Phone (any discount or Credit sale requires them) adds or updates a customer here automatically — no manual entry needed' },
          {
            key: 'credit',
            title: 'Credit bills not yet paid, by customer and delivery partner. Receive a payment here (any part of what is owed), print its receipt or a statement, and see what was collected',
            label: (
              <>
                Credit
                {creditCount > 0 && (
                  <span className="badge-amber" style={{ marginLeft: 6, fontSize: 11, padding: '1px 7px', borderRadius: 0 }}>{creditCount}</span>
                )}
              </>
            ),
          },
          // S843: supervisor and up, as the page itself is; what each rank may change is the tab's.
          { key: 'membership', label: 'Membership', title: "Membership card types and who holds a card, credit limits, and customers' birthdays and anniversaries coming up" },
          ...(hasFeature('loyalty') ? [{ key: 'loyalty', label: 'Loyalty', title: "Points schemes, who is enrolled, and each member's balance. Points are earned automatically on any bill closed with a name and phone, and are spent at the till like a gift card" }] : []),
        ]} />

      {/* ══ LOYALTY TAB ══ */}
      {mainTab === 'loyalty' && hasFeature('loyalty') && (
        <LoyaltyTab
          // S809 2g (CUSTOMERS-PARKING-3): only a value that was read. On a failed read the tab showed 1,
          // so balances read at a tenth of their worth, and a Save would have written 1 over the real value.
          pointValue={settingsRead === true ? pointValue : null}
          pointValueError={settingsRead && settingsRead !== true ? settingsRead : null}
          // S754 (owner decision): schemes, the point value and enrolment are a POS manager's or the
          // Owner's. hasPosAccess resolves admin and the Owner to manager, so this one test is the
          // pos_loyalty_schemes_guard / pos_customers_guard_loyalty / settings guard rank.
          canManage={hasPosAccess('manager')}
          // S809 3k: a partner's row is shown as a partner, never offered for enrolment or added points.
          deliveryPartners={billingSettings.delivery_partners}
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

          {savedMsg && <p role="status" style={{ margin: '0 0 12px', fontSize: 13, color: 'var(--theme-green-text)' }}>✓ {savedMsg}</p>}

          {/* S833: a reload that failed keeps the list it had, and says so. */}
          {!custLoading && book.stale && (() => {
            const why = asActionError(book.stale, 'operator')
            return <ActionError error={{ text: `The customer book could not be read again, so this is the list as it was last read. Reload the page to try again. ${why.text}`, detail: why.detail }} />
          })()}

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
            <>
              {/* S842: a narrowed list says how much of the book it shows (page-layout.md's N of M). */}
              {q && (
                <p role="status" style={{ margin: '0 0 8px', fontSize: 12, color: 'var(--theme-text2)' }}>
                  Showing {filteredCustomers.length} of {customers.length}.
                </p>
              )}
              <CustomerBookTable rows={filteredCustomers} expandedId={expandedId} historyMap={historyMap}
                noShowByPhone={noShowByPhone} vatReg={vatReg} prefix={prefix} onToggle={onToggleHistory}
                typesById={typesState.byId} onEdit={onEditCustomer} />
            </>
          )}
        </>
      )}

      {/* ══ MEMBERSHIP TAB (S843) ══ */}
      {mainTab === 'membership' && (
        <MembershipTab
          book={{ rows: book.rows, loading: custLoading, error: custError, stale: custLoading ? null : book.stale }}
          typesState={typesState}
          // hasPosAccess resolves admin and the Owner to manager: the database's card and type rank.
          canManage={hasPosAccess('manager')}
          onCustomerSaved={onCustomerSaved}
        />
      )}

      {/* ══ CREDIT TAB (S843) ══ */}
      {mainTab === 'credit' && (
        <CreditTab vatReg={vatReg} prefix={prefix} deliveryPartners={billingSettings.delivery_partners}
          settingsRead={settingsRead} onOwedCount={setCreditCount} />
      )}

      {editing && (
        <CustomerEditModal
          customer={editing}
          types={typesState.types}
          typesError={typesState.error}
          canManage={hasPosAccess('manager')}
          onClose={() => setEditing(null)}
          onSaved={row => { onCustomerSaved(row); setSavedMsg(`${editing.name}'s details saved.`); setEditing(null) }}
        />
      )}
    </div>
  )
}
