import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { supabase } from '../../../supabaseClient'
import { useAuth } from '../../../context/AuthContext'
import { useScopedDb } from '../../../shared/hooks/useScopedDb'
import Tabs, { TabPanel } from '../../../components/Tabs'
import Tip from '../../../components/Tip'
import RowDisclosure from '../../../components/RowDisclosure'
import ReportLoadError from '../../../components/ReportLoadError'
import ActionError, { asActionError } from '../../../components/ActionError'
import BsCalendarPicker from '../../../components/BsCalendarPicker'
import RangePresets from '../reports/RangePresets'
import { bsMonthRangeIso, bsSlash, nepalDayEndTs, nepalDayStartTs, todayNepalAdIso } from '../reports/reportRange'
import { useLatestRequest } from '../../../shared/hooks/useLatestRequest'
import { settleWithin } from '../../../utils/withTimeout'
import { fetchAllRows, fetchAllRowsChunked } from '../../../shared/fetchAllRows'
import { profileNamesRpc, namesMapOf, fillMissingNames } from '../../../shared/profileNames'
import { sheetWithLetterhead } from '../../../shared/excelLetterhead'
import { npr, npr2, nprExact } from '../../../shared/nepalMoney'
import { nepalTime } from '../../../shared/nepalTime'
import { IDENTITY_BADGE } from '../posSignals'
import {
  AGE_BUCKETS, ageingByParty, collectedRows, creditBillLabel, fromPaisa, groupByParty, legacySettlements,
  nepalDaysBetween, receiptNoLabel, toPaisa,
} from './creditLedger'
import { SETTLE_READ_MS, recordCreditReceipt, recordOutcome } from './settleCredit'
import { bsDay, buildAgeingHtml, closeQuietly, openPrintWindow, writeAndPrint } from './creditReceiptHtml'
import { printCreditReceipt } from './creditReceiptPrint'
import ReceivePaymentModal from './ReceivePaymentModal'
import CancelReceiptModal from './CancelReceiptModal'
import CreditStatementModal from './CreditStatementModal'

// Customers → Credit (S843). Customer credit (udharo) takes part payments: who owes what, by party; a
// payment spread over their bills (Receive payment), each one a numbered money receipt; the statement;
// who owes by age; and what was collected in a date range, with Cancel and Reprint. Supervisor and
// above, as the tab always was (PosCustomers' guard, and record_credit_receipt's own rank check).
//
// The figures are the server's: pos_credit_open_bills is the one definition of what a bill still owes,
// and this page only groups, sums and ages it (creditLedger.js). A failed read is the error card, never
// "nobody owes anything" (report-pages.md), and the KPI strip waits for the read it summarises.

const LIST_READ_MS = 20000
const READ_MS = SETTLE_READ_MS
const RECEIPT_COLS = 'id, invoice_fy, receipt_no, party_key, party_name, party_phone, method, reference, amount, commission_total, note, shift_id, received_by, received_at, print_count, cancelled_at, cancelled_by, cancel_reason'
const LEGACY_COLS = 'id, order_no, invoice_no, invoice_fy, invoice_prefix, closed_at, paid_amount, commission_amount, buyer_name, buyer_phone, delivery_partner, credit_settled_at, credit_settled_by, credit_settled_method, vat_registered'
const rpcCall = (name, args, signal) => (signal ? supabase.rpc(name, args).abortSignal(signal) : supabase.rpc(name, args))
const days = d => (d == null ? '—' : d === 0 ? 'today' : `${d} day${d === 1 ? '' : 's'}`)

export default function CreditTab({ vatReg = true, prefix = '', deliveryPartners = [], settingsRead = null, onOwedCount }) {
  const { clientId, profile, isAdmin } = useAuth()
  // S843: a payment or a cancel acts for the signed-in login's own outlet (record_credit_receipt /
  // cancel_credit_receipt use my_client_id()), and Crest support's view of an outlet is a browser
  // setting, so the server would refuse it. Say so before anything is sent.
  const operatorNoMoney = 'Customer payments are recorded from the outlet\'s own login (the Owner or a POS supervisor), so the receipt names who took the money. Crest support can read this page but not record or cancel a payment here.'
  const { scopedFrom, scopedUpdate } = useScopedDb()
  const [view, setView] = useState('owed')

  // Who owes: every unpaid Credit bill, each bill's VAT stamp beside it, and the credit limits.
  const [owed, setOwed] = useState({ loading: true, bills: [], vatById: {}, limits: null, limitsError: null, error: null })
  const owedReq = useLatestRequest()
  const owedSeq = useRef(0)
  // The outlet's name, address and phone for the papers (and the workbook's letterhead).
  const [outlet, setOutlet] = useState({ info: null, error: null })
  const [expanded, setExpanded] = useState(null)

  // What the last action did, as one line at the top of the tab; and a payment whose answer was lost.
  const [outcome, setOutcome] = useState(null)
  const outcomeRef = useRef(null)
  const [unknownPress, setUnknownPress] = useState(null)
  const [checking, setChecking] = useState(false)

  const [receiveFor, setReceiveFor] = useState(null)
  const [statementFor, setStatementFor] = useState(null)
  const [cancelFor, setCancelFor] = useState(null)
  const [reprinting, setReprinting] = useState(null)

  // Collected: receipts in the range, and bills paid whole before receipts existed.
  const [range, setRange] = useState(() => bsMonthRangeIso(0))
  const [collected, setCollected] = useState({ loaded: false, loading: false, receipts: [], legacy: [], billsByReceipt: {}, error: null })
  const collReq = useLatestRequest()
  const collSeq = useRef(0)
  const [names, setNames] = useState({ map: {}, failed: false })

  const loadOwed = useCallback(async () => {
    const key = owedReq.begin(`${clientId}#${++owedSeq.current}`) // before any await
    setOwed(o => ({ ...o, loading: true }))
    const [bills, stamps, limits] = await Promise.all([
      settleWithin(fetchAllRows(() => supabase.rpc('pos_credit_open_bills', { p_client_id: clientId }).order('closed_at').order('order_id')), LIST_READ_MS, 'Reading who owes'),
      settleWithin(fetchAllRows(() => scopedFrom('pos_orders', 'id, vat_registered').eq('payment_method', 'Credit').eq('status', 'billed')
        .is('credit_settled_at', null).is('credit_note_id', null).order('id')), LIST_READ_MS, "Reading the bills' VAT stamps"),
      settleWithin(fetchAllRows(() => scopedFrom('pos_customers', 'id, phone_canonical, credit_limit').not('credit_limit', 'is', null).order('id')),
        LIST_READ_MS, 'Reading credit limits'),
    ])
    if (!owedReq.isCurrent(key)) return // a newer load owns the tab
    if (bills.error) {
      setOwed(o => ({ ...o, loading: false, error: bills.error }))
      onOwedCount?.(null)
      return
    }
    // A stamp read failing only costs a label its own TI/PB (today's flag is used); never a figure.
    if (stamps.error) console.error('credit bills: VAT stamps not read, labels use today\'s setting:', stamps.error)
    const vatById = Object.fromEntries((stamps.data || []).map(o => [o.id, o.vat_registered]))
    let limitMap = null
    if (limits.error) console.error('credit limits not read:', limits.error)
    else {
      limitMap = {}
      for (const c of limits.data || []) if (c.phone_canonical) limitMap[`phone:${c.phone_canonical}`] = Number(c.credit_limit)
    }
    setOwed({ loading: false, bills: bills.data || [], vatById, limits: limitMap, limitsError: limits.error || null, error: null })
    onOwedCount?.((bills.data || []).length)
  }, [clientId, scopedFrom, owedReq, onOwedCount])

  useEffect(() => {
    if (!clientId) return undefined
    let gone = false
    loadOwed()
    Promise.all([
      settleWithin(supabase.from('settings').select('vat_number, is_vat_registered, property_address, property_phone').eq('client_id', clientId).maybeSingle(),
        READ_MS, "Reading the outlet's address"),
      settleWithin(supabase.from('clients').select('name').eq('id', clientId).maybeSingle(), READ_MS, "Reading the outlet's name"),
    ]).then(([s, c]) => {
      if (gone) return
      const err = s.error || c.error
      if (err) { console.error('outlet details not read, papers will not print:', err); setOutlet({ info: null, error: err }); return }
      setOutlet({
        info: {
          name: c.data?.name || '', address: s.data?.property_address || '', phone: s.data?.property_phone || '',
          vat: s.data?.vat_number || '', vatReg: s.data?.is_vat_registered ?? true,
        },
        error: null,
      })
    })
    return () => { gone = true }
  }, [clientId]) // eslint-disable-line react-hooks/exhaustive-deps

  const loadCollected = useCallback(async r => {
    const key = collReq.begin(`${r.from}|${r.to}|${++collSeq.current}`) // before any await
    setCollected(c => ({ ...c, loading: true }))
    const start = nepalDayStartTs(r.from)
    const end = nepalDayEndTs(r.to)
    const wave1 = await Promise.all([
      settleWithin(fetchAllRows(() => scopedFrom('pos_credit_receipts', RECEIPT_COLS).gte('received_at', start).lte('received_at', end)
        .order('received_at', { ascending: false }).order('id')), LIST_READ_MS, 'Reading the payments received'),
      settleWithin(fetchAllRows(() => scopedFrom('pos_orders', LEGACY_COLS).eq('payment_method', 'Credit').eq('status', 'billed')
        .gte('credit_settled_at', start).lte('credit_settled_at', end).order('credit_settled_at', { ascending: false }).order('id')),
      LIST_READ_MS, 'Reading the bills paid whole'),
      settleWithin(profileNamesRpc(supabase, clientId), READ_MS, 'Reading staff names'),
    ])
    if (!collReq.isCurrent(key)) return
    const failed = wave1[0].error || wave1[1].error
    if (failed) { setCollected(c => ({ ...c, loading: false, error: failed })); return }
    const receipts = wave1[0].data || []
    const settledBills = wave1[1].data || []
    // A bill paid in full by receipts is stamped settled too: it is listed through its receipts, so
    // the old whole-bill settlements are the settled bills with no receipt line at all.
    const wave2 = await Promise.all([
      settleWithin(fetchAllRowsChunked(settledBills.map(b => b.id), ids => scopedFrom('pos_credit_receipt_lines', 'id, order_id').in('order_id', ids).order('id')),
        LIST_READ_MS, "Reading the bills' payments"),
      settleWithin(fetchAllRowsChunked(receipts.map(x => x.id), ids => scopedFrom('pos_credit_receipt_lines', 'id, receipt_id, order_id').in('receipt_id', ids).order('id')),
        LIST_READ_MS, "Reading the receipts' bills"),
    ])
    if (!collReq.isCurrent(key)) return
    const failed2 = wave2.find(x => x.error)?.error
    if (failed2) { setCollected(c => ({ ...c, loading: false, error: failed2 })); return }
    const legacy = legacySettlements(settledBills, new Set((wave2[0].data || []).map(l => l.order_id)))
    const billsByReceipt = {}
    for (const l of wave2[1].data || []) billsByReceipt[l.receipt_id] = (billsByReceipt[l.receipt_id] || 0) + 1
    const namesFailed = !!wave1[2].error
    if (namesFailed) console.error('staff names not read, By shows ?:', wave1[2].error)
    const first = namesFailed ? {} : namesMapOf(wave1[2].data)
    setNames({ map: first, failed: namesFailed })
    setCollected({ loaded: true, loading: false, receipts, legacy, billsByReceipt, error: null })
    // S840: a login the first read did not name (Crest support) is asked for by id; it holds nothing up.
    if (!namesFailed) {
      const ids = [...receipts.flatMap(x => [x.received_by, x.cancelled_by]), ...legacy.map(b => b.credit_settled_by)]
      void fillMissingNames(supabase, clientId, first, ids, { ms: READ_MS }).then(filled => {
        if (!collReq.isCurrent(key)) return
        if (filled.error) { console.error('some staff names not read:', filled.error); setNames(n => ({ ...n, failed: true })); return }
        if (filled.map !== first) setNames({ map: filled.map, failed: false })
      })
    }
  }, [clientId, scopedFrom, collReq])

  useEffect(() => {
    if (view === 'collected' && clientId) loadCollected(range)
  }, [view, range, clientId, loadCollected])

  // An outcome line that outlives a dialog takes focus once the dialog has gone, if focus went nowhere.
  useEffect(() => {
    if (!outcome || receiveFor || cancelFor || statementFor) return
    const at = document.activeElement
    if (!at || at === document.body) outcomeRef.current?.focus()
  }, [outcome, receiveFor, cancelFor, statementFor])

  const parties = useMemo(() => groupByParty(owed.bills, { limits: owed.limits }), [owed.bills, owed.limits])
  const ageing = useMemo(() => ageingByParty(owed.bills), [owed.bills])
  const list = useMemo(() => collectedRows(collected.receipts, collected.legacy), [collected.receipts, collected.legacy])
  const totals = useMemo(() => {
    let received = 0
    let commission = 0
    let count = 0
    let cancelled = 0
    for (const r of collected.receipts) {
      if (r.cancelled_at) { cancelled += 1; continue }
      received += toPaisa(r.amount)
      commission += toPaisa(r.commission_total)
      count += 1
    }
    for (const b of collected.legacy) {
      received += toPaisa(b.paid_amount) - toPaisa(b.commission_amount)
      commission += toPaisa(b.commission_amount)
      count += 1
    }
    return { received: fromPaisa(received), commission: fromPaisa(commission), count, cancelled }
  }, [collected.receipts, collected.legacy])

  const label = b => creditBillLabel({ ...b, vat_registered: b.vat_registered ?? owed.vatById[b.order_id ?? b.id] }, vatReg, prefix)
  const nameOf = id => {
    if (!id) return ''
    if (profile?.id === id && profile?.full_name) return profile.full_name
    return Object.prototype.hasOwnProperty.call(names.map, id) ? (names.map[id] || '') : null
  }

  // ── Printing a receipt ─────────────────────────────────────────────────────────────────────────
  const printDb = {
    receipt: id => scopedFrom('pos_credit_receipts', RECEIPT_COLS).eq('id', id).maybeSingle(),
    receiptLines: id => scopedFrom('pos_credit_receipt_lines', 'id, order_id, amount, commission').eq('receipt_id', id).order('id'),
    partyEvents: key => supabase.rpc('pos_credit_party_events', { p_party_key: key, p_client_id: clientId }).order('event_at').order('kind').order('order_id').order('receipt_id'),
    partyReceipts: key => scopedFrom('pos_credit_receipts', 'id, received_at, cancelled_at').eq('party_key', key).order('id'),
    billsByIds: ids => scopedFrom('pos_orders', 'id, order_no, invoice_no, invoice_fy, invoice_prefix, closed_at, paid_amount, vat_registered').in('id', ids).order('id'),
    linesByOrders: ids => scopedFrom('pos_credit_receipt_lines', 'id, receipt_id, order_id, amount, commission').in('order_id', ids).order('id'),
    bumpPrintCount: (id, count) => scopedUpdate('pos_credit_receipts', { print_count: count }).eq('id', id).select('print_count').maybeSingle(),
  }
  async function printReceipt(w, receiptId, partyKey) {
    try {
      return await printCreditReceipt({
        w, db: printDb, receiptId, partyKey, outlet: outlet.info, receivedByName: nameOf,
        label: b => creditBillLabel(b, vatReg, prefix),
      })
    } catch (err) {
      console.error('printing a receipt failed unexpectedly:', err)
      closeQuietly(w)
      return { printed: false, error: err, countError: null }
    }
  }
  const printNote = p => {
    if (!p) return null
    if (p.printed) return { ok: true, text: 'The receipt went to the printer.', countError: p.countError }
    return { ok: false, text: `The receipt did not print: ${p.error?.message && !p.error?.code ? p.error.message : asActionError(p.error).text} Press Reprint beside it under Collected.`, detail: p.error?.code ? asActionError(p.error).detail : '' }
  }

  // ── Recording a payment ────────────────────────────────────────────────────────────────────────
  async function finishRecord({ result, press, w }) {
    setReceiveFor(null)
    const out = recordOutcome(result, press)
    if (result.status === 'unknown') {
      closeQuietly(w)
      setUnknownPress(press)
      setOutcome({ ...out, detail: result.error ? asActionError(result.error).detail : '' })
      return
    }
    setUnknownPress(null)
    setOutcome({ ...out, detail: '', print: 'printing' })
    void loadOwed()
    if (collected.loaded) void loadCollected(range)
    const p = await printReceipt(w, result.receipt.receipt_id, press.partyKey)
    setOutcome(o => (o && o.text === out.text ? { ...o, print: p } : o))
  }

  async function checkAgain() {
    if (!unknownPress || checking) return
    const press = unknownPress
    const w = openPrintWindow()
    setChecking(true)
    let result
    try {
      result = await recordCreditReceipt({ rpc: rpcCall, ...press, priorLost: true })
    } catch (err) {
      console.error('checking a payment failed unexpectedly:', err)
      result = { status: 'unknown', error: err }
    }
    setChecking(false)
    if (result.status === 'refused') {
      closeQuietly(w)
      setUnknownPress(null)
      const out = recordOutcome(result, press)
      setOutcome({ ...out, detail: asActionError(result.error).detail })
      void loadOwed()
      return
    }
    await finishRecord({ result, press, w })
  }

  function openReceive(party) {
    if (isAdmin) { setOutcome({ kind: 'warn', text: operatorNoMoney, detail: '' }); return }
    if (unknownPress?.partyKey === party.key) {
      setOutcome({ kind: 'warn', text: `An earlier payment from ${party.name} has no answer yet. Press Check again first, so it is never recorded twice.`, detail: '' })
      return
    }
    setOutcome(null)
    setReceiveFor(party)
  }

  // ── Reprint and cancel ─────────────────────────────────────────────────────────────────────────
  async function reprint(r) {
    if (reprinting) return
    const w = openPrintWindow()
    setReprinting(r.id)
    const p = await printReceipt(w, r.id, r.party_key)
    setReprinting(null)
    const note = printNote(p)
    setOutcome(note.ok
      ? { kind: 'ok', text: `Receipt ${receiptNoLabel(r)} (${r.invoice_fy}) reprinted as a copy.`, detail: '', print: null, countError: p.countError }
      : { kind: 'error', text: note.text, detail: note.detail })
  }

  function finishCancel({ result, outcome: out }) {
    setCancelFor(null)
    setOutcome({ ...out, detail: result.error ? asActionError(result.error).detail : '' })
    void loadOwed()
    void loadCollected(range)
  }

  // ── Who owes, by age: the paper and the workbook ───────────────────────────────────────────────
  const owedReady = !owed.loading && !owed.error
  function printAgeing() {
    if (!owedReady) return
    if (!outlet.info) { setOutcome({ kind: 'error', text: "The outlet's name and address could not be read, so this list cannot be printed. Reload the page and try again.", detail: outlet.error ? asActionError(outlet.error).detail : '' }); return }
    const w = openPrintWindow({ wide: true })
    if (!w) { setOutcome({ kind: 'error', text: 'The print window was blocked. Allow pop-ups for this site, then press Print again.', detail: '' }); return }
    writeAndPrint(w, buildAgeingHtml({ outlet: outlet.info, ageing }))
  }
  async function exportAgeing() {
    if (!owedReady) return
    if (!outlet.info) { setOutcome({ kind: 'error', text: "The outlet's name could not be read, so the workbook would have no letterhead. Reload the page and try again.", detail: outlet.error ? asActionError(outlet.error).detail : '' }); return }
    const XLSX = await import('xlsx')
    const asAt = todayNepalAdIso()
    const money = n => Math.round(n * 100) / 100
    const rows = ageing.rows.map(r => ({
      'Customer or partner': r.name, Kind: r.kind === 'partner' ? 'Delivery partner' : 'Customer', Phone: r.phone || '', 'Unpaid bills': r.billCount,
      ...Object.fromEntries(AGE_BUCKETS.map(b => [`${b.label} (NPR)`, money(r.buckets[b.key])])),
      'Total (NPR)': money(r.total),
    }))
    rows.push({
      'Customer or partner': 'TOTAL', Kind: '', Phone: '', 'Unpaid bills': owed.bills.length,
      ...Object.fromEntries(AGE_BUCKETS.map(b => [`${b.label} (NPR)`, money(ageing.totals[b.key])])),
      'Total (NPR)': money(ageing.total),
    })
    const ws = sheetWithLetterhead(XLSX, {
      title: 'Who owes, by age', biz: outlet.info, rows,
      scopeLine: `Unpaid Credit bills as at ${bsSlash(asAt)} (BS), aged in Nepal days since each bill was closed`,
    })
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, ws, 'By age')
    XLSX.writeFile(wb, `who-owes-by-age-${asAt}.xlsx`)
  }

  // ── Render ─────────────────────────────────────────────────────────────────────────────────────
  const pn = outcome && outcome.print && outcome.print !== 'printing' ? printNote(outcome.print) : null
  const outcomeEl = outcome && (
    <div ref={outcomeRef} tabIndex={-1} style={{ outline: 'none', marginBottom: 14 }}>
      {outcome.kind === 'ok' ? (
        <p role="status" style={{ margin: 0, fontSize: 13, color: 'var(--theme-green-text)' }}>✓ {outcome.text}</p>
      ) : outcome.kind === 'warn' ? (
        <div role="alert" style={{ fontSize: 13, color: 'var(--theme-amber-text)' }}>
          <span aria-hidden="true">△ </span>{outcome.text}
          {outcome.detail && <div className="action-error-detail">{outcome.detail}</div>}
        </div>
      ) : (
        <ActionError error={{ text: outcome.text, detail: outcome.detail }} className="action-error--top" />
      )}
      {outcome.print === 'printing' && <p role="status" style={{ margin: '4px 0 0', fontSize: 12, color: 'var(--theme-text2)' }}>Preparing the receipt to print…</p>}
      {pn && (pn.ok
        ? <p role="status" style={{ margin: '4px 0 0', fontSize: 12, color: 'var(--theme-text2)' }}>{pn.text}</p>
        : <ActionError error={{ text: pn.text, detail: pn.detail }} />)}
      {(pn?.countError || outcome.countError) && (
        <p style={{ margin: '4px 0 0', fontSize: 12, color: 'var(--theme-text2)' }}>This print could not be counted, so the next print may not say COPY.</p>
      )}
    </div>
  )

  const unknownEl = unknownPress && (
    <div role="alert" className="card" style={{ padding: '12px 16px', marginBottom: 14, display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between' }}>
      <span style={{ fontSize: 13, color: 'var(--theme-amber-text)' }}>
        <span aria-hidden="true">△ </span>Not known yet: NPR {npr2(unknownPress.amount)} from {unknownPress.partyName} by {unknownPress.method}.
        Do not take or hand back money for it until this says recorded or not.
      </span>
      <button type="button" className="btn btn-primary" onClick={checkAgain} aria-busy={checking || undefined}>
        {checking ? 'Checking…' : 'Check again'}
      </button>
    </div>
  )

  // `sm` in a table row (the product's in-table tier); full size on the phone list, a 44px thumb target.
  const actionButtons = (p, sm = true) => {
    const waiting = unknownPress?.partyKey === p.key
    return (
      <>
        {/* On every row, so ghost like Statement beside it (S846): one accent fill per row was a
            column of red buttons on Modernist Light. The receipt dialog's own commit is the primary. */}
        <button type="button" className={`btn btn-ghost${sm ? ' btn-sm' : ''}`} onClick={() => openReceive(p)}
          aria-disabled={waiting ? true : undefined} aria-label={`Receive payment from ${p.name}`}>Receive payment</button>
        <button type="button" className={`btn btn-ghost${sm ? ' btn-sm' : ''}`} onClick={() => setStatementFor(p)}
          aria-label={`Statement for ${p.name}`}>Statement</button>
      </>
    )
  }
  const partyBadges = p => (
    <>
      {p.kind === 'partner' && <span className={IDENTITY_BADGE} style={{ marginLeft: 6 }}>Delivery partner</span>}
      {p.overLimit && (
        <Tip text={`Owes ${npr(p.owed)}, above the credit limit of ${npr(p.limit)} set for this customer. The till warns before another Credit bill.`} width={260}
          style={{ display: 'inline-flex', borderBottom: 'none', cursor: 'default', marginLeft: 6 }}>
          <span className="badge badge-amber">△ Over limit</span>
        </Tip>
      )}
    </>
  )

  const owedView = owed.loading ? (
    <p role="status" style={{ color: 'var(--theme-text3)', fontSize: 13 }}>Loading…</p>
  ) : owed.error ? (
    <ReportLoadError error={owed.error} />
  ) : (
    <>
      <div className="stat-grid" style={{ marginBottom: 16 }}>
        <div className="stat-card">
          <div className="stat-label"><Tip text="Everything still owed on unpaid Credit bills, after any part payments and partner commission. Bills with a credit note are not owed." width={260}>Owed now</Tip></div>
          <div className="stat-value">{nprExact(ageing.total)}</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">Customers and partners</div>
          <div className="stat-value">{parties.length}</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">Unpaid bills</div>
          <div className="stat-value">{owed.bills.length}</div>
        </div>
        <div className="stat-card">
          <div className="stat-label"><Tip text="Owed on bills closed more than 90 days ago, counted in Nepal days." width={240}>Over 90 days</Tip></div>
          <div className="stat-value" style={{ color: ageing.totals.over90 > 0 ? 'var(--theme-amber-text)' : undefined }}>{nprExact(ageing.totals.over90)}</div>
        </div>
      </div>
      {owed.limitsError && (
        <p role="note" style={{ margin: '0 0 12px', fontSize: 12, color: 'var(--theme-amber-text)' }}>
          Credit limits could not be read, so nobody is marked over their limit here.
        </p>
      )}
      {parties.length === 0 ? (
        <div className="card" style={{ padding: 32, textAlign: 'center', color: 'var(--theme-text2)', fontSize: 13 }}>
          Nobody owes anything on Credit now.
        </div>
      ) : (
        <>
          <div className="table-wrap phone-hide" style={{ marginBottom: 8 }}>
            <table className="data-table">
              <thead>
                <tr>
                  <th>Customer or partner</th>
                  <th>Phone</th>
                  <th style={{ textAlign: 'right' }}>Bills</th>
                  <th><Tip text="How long the oldest unpaid bill has been owed, in Nepal days." width={220}>Oldest</Tip></th>
                  <th style={{ textAlign: 'right' }}><Tip text="The most this customer may owe, set by a manager on the customer's record. Blank: no limit." width={240}>Limit</Tip></th>
                  <th style={{ textAlign: 'right' }}><Tip text="All figures in NPR." width={160}>Owed</Tip></th>
                  <th><span className="sr-only">Actions</span></th>
                </tr>
              </thead>
              <tbody>
                {parties.map(p => (
                  <Fragment key={p.key}>
                    <tr>
                      <td style={{ fontWeight: 600, color: 'var(--theme-text1)' }}>
                        <RowDisclosure expanded={expanded === p.key} onToggle={() => setExpanded(e => (e === p.key ? null : p.key))}
                          label={`Unpaid bills of ${p.name}`} /> {p.name}{partyBadges(p)}
                      </td>
                      <td style={{ whiteSpace: 'nowrap' }}>{p.kind === 'partner' ? '—' : p.phone || '—'}</td>
                      <td style={{ textAlign: 'right' }}>{p.billCount}</td>
                      <td style={{ whiteSpace: 'nowrap' }}>{days(p.oldestDays)}</td>
                      <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>{p.limit != null ? npr(p.limit) : owed.limitsError && p.kind === 'customer' ? '?' : '—'}</td>
                      <td style={{ textAlign: 'right', fontWeight: 700, whiteSpace: 'nowrap' }}>{npr2(p.owed)}</td>
                      <td style={{ textAlign: 'right' }}>
                        <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end', flexWrap: 'wrap' }}>{actionButtons(p)}</div>
                      </td>
                    </tr>
                    {expanded === p.key && (
                      <tr>
                        <td colSpan={7} style={{ background: 'var(--theme-bg)', padding: '10px 18px' }}>
                          <table className="data-table" style={{ fontSize: 12 }}>
                            <thead><tr><th>Bill</th><th>Date</th><th>Age</th><th style={{ textAlign: 'right' }}>Bill total</th><th style={{ textAlign: 'right' }}>Paid so far</th><th style={{ textAlign: 'right' }}>Owes</th></tr></thead>
                            <tbody>
                              {p.bills.map(b => (
                                <tr key={b.order_id}>
                                  <td style={{ whiteSpace: 'nowrap', fontWeight: 600 }}>{label(b)}</td>
                                  <td style={{ whiteSpace: 'nowrap' }}>{bsDay(b.closed_at)}</td>
                                  <td style={{ whiteSpace: 'nowrap' }}>{days(nepalDaysBetween(b.closed_at))}</td>
                                  <td style={{ textAlign: 'right' }}>{npr2(b.paid_amount)}</td>
                                  <td style={{ textAlign: 'right' }}>{Number(b.received) + Number(b.commission) > 0 ? npr2(Number(b.received) + Number(b.commission)) : '—'}</td>
                                  <td style={{ textAlign: 'right', fontWeight: 600 }}>{npr2(b.owed)}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <td>Total</td><td></td>
                  <td style={{ textAlign: 'right' }}>{owed.bills.length}</td>
                  <td></td><td></td>
                  <td style={{ textAlign: 'right' }}>{npr2(ageing.total)}</td>
                  <td></td>
                </tr>
              </tfoot>
            </table>
          </div>
          <ul className="phone-cards phone-only">
            {parties.map(p => (
              <li key={p.key} className="phone-card">
                <div className="phone-card__top">
                  <span className="phone-card__title">{p.name}{partyBadges(p)}</span>
                  <span className="phone-card__figure">{npr2(p.owed)}</span>
                </div>
                <div className="phone-card__meta">
                  {p.kind === 'partner' ? 'Delivery partner' : p.phone || 'No phone'} · {p.billCount} bill{p.billCount === 1 ? '' : 's'} · oldest {days(p.oldestDays)}
                  {p.limit != null && <> · limit {npr(p.limit)}</>}
                </div>
                <div className="phone-card__actions">{actionButtons(p, false)}</div>
              </li>
            ))}
          </ul>
          <p className="page-footnote">
            Every unpaid Credit bill, not a date range. What a delivery partner kept against the agreed rate is in Sales Report → Delivery Partners.
          </p>
        </>
      )}
    </>
  )

  const ageView = owed.loading ? (
    <p role="status" style={{ color: 'var(--theme-text3)', fontSize: 13 }}>Loading…</p>
  ) : owed.error ? (
    <ReportLoadError error={owed.error} />
  ) : (
    <>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
        <p style={{ margin: 0, fontSize: 13, color: 'var(--theme-text2)' }}>
          As at {bsDay(new Date())}, by Nepal days since each unpaid bill was closed.
        </p>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button type="button" className="btn btn-ghost" onClick={printAgeing} aria-disabled={!outlet.info ? true : undefined}>Print</button>
          <button type="button" className="btn btn-ghost" onClick={exportAgeing} aria-disabled={!outlet.info ? true : undefined}>Excel</button>
        </div>
      </div>
      {ageing.rows.length === 0 ? (
        <div className="card" style={{ padding: 32, textAlign: 'center', color: 'var(--theme-text2)', fontSize: 13 }}>Nobody owes anything on Credit now.</div>
      ) : (
        <>
          <div className="table-wrap phone-hide">
            <table className="data-table">
              <thead>
                <tr>
                  <th><Tip text="All figures in NPR." width={160}>Customer or partner</Tip></th>
                  {AGE_BUCKETS.map(b => <th key={b.key} style={{ textAlign: 'right' }}>{b.label}</th>)}
                  <th style={{ textAlign: 'right' }}>Total</th>
                </tr>
              </thead>
              <tbody>
                {ageing.rows.map(r => (
                  <tr key={r.key}>
                    <td style={{ fontWeight: 600, color: 'var(--theme-text1)' }}>
                      {r.name}{r.kind === 'partner' && <span className={IDENTITY_BADGE} style={{ marginLeft: 6 }}>Delivery partner</span>}
                    </td>
                    {AGE_BUCKETS.map(b => (
                      <td key={b.key} style={{ textAlign: 'right', whiteSpace: 'nowrap', color: b.key === 'over90' && r.buckets[b.key] > 0 ? 'var(--theme-amber-text)' : undefined }}>
                        {r.buckets[b.key] ? npr2(r.buckets[b.key]) : '—'}
                      </td>
                    ))}
                    <td style={{ textAlign: 'right', fontWeight: 700, whiteSpace: 'nowrap' }}>{npr2(r.total)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <td>Total</td>
                  {AGE_BUCKETS.map(b => <td key={b.key} style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>{npr2(ageing.totals[b.key])}</td>)}
                  <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>{npr2(ageing.total)}</td>
                </tr>
              </tfoot>
            </table>
          </div>
          <ul className="phone-cards phone-only">
            {ageing.rows.map(r => (
              <li key={r.key} className="phone-card">
                <div className="phone-card__top">
                  <span className="phone-card__title">{r.name}</span>
                  <span className="phone-card__figure">{npr2(r.total)}</span>
                </div>
                <details className="phone-card__lines">
                  <summary>By age</summary>
                  {AGE_BUCKETS.map(b => <div key={b.key}>{b.label}: {r.buckets[b.key] ? npr2(r.buckets[b.key]) : '—'}</div>)}
                </details>
              </li>
            ))}
          </ul>
        </>
      )}
    </>
  )

  const receiptStatus = r => (r.cancelled_at ? (
    <div>
      <span className="badge badge-red">Cancelled</span>
      <div style={{ fontSize: 12, color: 'var(--theme-text2)', marginTop: 2 }}>
        {r.cancel_reason}{' '}· {bsDay(r.cancelled_at)}{nameOf(r.cancelled_by) ? ` · ${nameOf(r.cancelled_by)}` : ''}
      </div>
    </div>
  ) : null)
  const receiptActions = (r, sm = true) => {
    const size = sm ? ' btn-sm' : ''
    const reprintBtn = (
      <button type="button" className={`btn btn-ghost${size}`} onClick={() => reprint(r)} aria-busy={reprinting === r.id || undefined}
        aria-label={`Reprint receipt ${receiptNoLabel(r)}`}>{reprinting === r.id ? 'Printing…' : 'Reprint'}</button>
    )
    if (r.cancelled_at) return reprintBtn
    return (
      <>
        {reprintBtn}
        <button type="button" className={`btn btn-danger${size}`} onClick={() => { if (isAdmin) { setOutcome({ kind: 'warn', text: operatorNoMoney, detail: '' }); return } setOutcome(null); setCancelFor(r) }}
          aria-label={`Cancel receipt ${receiptNoLabel(r)}`}>Cancel</button>
      </>
    )
  }
  const byName = id => (nameOf(id) ?? (names.failed ? '?' : '—')) || '—'

  const collectedView = (
    <>
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-end', marginBottom: 14 }}>
        <RangePresets fromIso={range.from} toIso={range.to} onPick={r => setRange(r)} />
        <div>
          <label style={{ fontSize: 12, color: 'var(--theme-text2)', display: 'block', marginBottom: 4 }} htmlFor="collected-from">From (BS)</label>
          <BsCalendarPicker id="collected-from" value={range.from} onChange={v => setRange(r => ({ ...r, from: v }))} />
        </div>
        <div>
          <label style={{ fontSize: 12, color: 'var(--theme-text2)', display: 'block', marginBottom: 4 }} htmlFor="collected-to">To (BS)</label>
          <BsCalendarPicker id="collected-to" value={range.to} onChange={v => setRange(r => ({ ...r, to: v }))} />
        </div>
      </div>
      {collected.loading ? (
        <p role="status" style={{ color: 'var(--theme-text3)', fontSize: 13 }}>Loading…</p>
      ) : collected.error ? (
        <ReportLoadError error={collected.error} />
      ) : collected.loaded && (
        <>
          <div className="stat-grid" style={{ marginBottom: 16 }}>
            <div className="stat-card">
              <div className="stat-label"><Tip text="Money received in these dates, cancelled payments left out. A delivery partner's commission is not in it." width={260}>Received</Tip></div>
              <div className="stat-value">{nprExact(totals.received)}</div>
              <div className="stat-sub">{totals.count} payment{totals.count === 1 ? '' : 's'}</div>
            </div>
            <div className="stat-card">
              <div className="stat-label"><Tip text="What delivery partners kept on the bills they paid in these dates." width={240}>Commission kept</Tip></div>
              <div className="stat-value">{nprExact(totals.commission)}</div>
            </div>
            <div className="stat-card">
              <div className="stat-label">Cancelled</div>
              <div className="stat-value">{totals.cancelled}</div>
            </div>
          </div>
          {list.length === 0 ? (
            <div className="card" style={{ padding: 32, textAlign: 'center', color: 'var(--theme-text2)', fontSize: 13 }}>
              No payments were received in these dates.
            </div>
          ) : (
            <>
              <div className="table-wrap phone-hide">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>When</th>
                      <th><Tip text="The money receipt's number, or the bill for a bill paid whole before part payments existed." width={260}>Receipt</Tip></th>
                      <th>From</th>
                      <th>Paid by</th>
                      <th style={{ textAlign: 'right' }}><Tip text="All figures in NPR. The money received, after any commission." width={220}>Amount</Tip></th>
                      <th style={{ textAlign: 'right' }}><Tip text="Delivery partners only: what the platform kept on these bills." width={220}>Commission</Tip></th>
                      <th style={{ textAlign: 'right' }}>Bills</th>
                      <th><Tip text="The login that took the payment. A ? means the names could not be read; reload to see them." width={240}>By</Tip></th>
                      <th><span className="sr-only">Status and actions</span></th>
                    </tr>
                  </thead>
                  <tbody>
                    {list.map(x => (x.type === 'receipt' ? (
                      <tr key={x.id} style={x.row.cancelled_at ? { color: 'var(--theme-text2)' } : undefined}>
                        <td style={{ whiteSpace: 'nowrap' }}>{bsDay(x.row.received_at)}<div style={{ fontSize: 11, color: 'var(--theme-text2)' }}>{nepalTime(x.row.received_at)}</div></td>
                        <td style={{ whiteSpace: 'nowrap', fontWeight: 600 }}>{receiptNoLabel(x.row)} <span style={{ fontWeight: 400, color: 'var(--theme-text2)' }}>{x.row.invoice_fy}</span></td>
                        <td>{x.row.party_name}{x.row.party_key?.startsWith('partner:') && <span className={IDENTITY_BADGE} style={{ marginLeft: 6 }}>Partner</span>}</td>
                        <td>{x.row.method}{x.row.reference && <div style={{ fontSize: 11, color: 'var(--theme-text2)' }}>{x.row.reference}</div>}</td>
                        <td style={{ textAlign: 'right', fontWeight: 600, whiteSpace: 'nowrap', textDecoration: x.row.cancelled_at ? 'line-through' : undefined }}>{npr2(x.row.amount)}</td>
                        <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>{Number(x.row.commission_total) > 0 ? npr2(x.row.commission_total) : '—'}</td>
                        <td style={{ textAlign: 'right' }}>{collected.billsByReceipt[x.row.id] || '—'}</td>
                        <td>{byName(x.row.received_by)}</td>
                        <td>
                          {receiptStatus(x.row)}
                          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: x.row.cancelled_at ? 6 : 0 }}>{receiptActions(x.row)}</div>
                        </td>
                      </tr>
                    ) : (
                      <tr key={x.id}>
                        <td style={{ whiteSpace: 'nowrap' }}>{bsDay(x.row.credit_settled_at)}<div style={{ fontSize: 11, color: 'var(--theme-text2)' }}>{nepalTime(x.row.credit_settled_at)}</div></td>
                        <td style={{ whiteSpace: 'nowrap' }}>{label(x.row)}<div style={{ fontSize: 11, color: 'var(--theme-text2)' }}>paid whole</div></td>
                        <td>{x.row.delivery_partner || x.row.buyer_name || '—'}</td>
                        <td>{x.row.credit_settled_method}</td>
                        <td style={{ textAlign: 'right', fontWeight: 600, whiteSpace: 'nowrap' }}>{npr2(Number(x.row.paid_amount) - (Number(x.row.commission_amount) || 0))}</td>
                        <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>{Number(x.row.commission_amount) > 0 ? npr2(x.row.commission_amount) : '—'}</td>
                        <td style={{ textAlign: 'right' }}>1</td>
                        <td>{byName(x.row.credit_settled_by)}</td>
                        <td style={{ fontSize: 12, color: 'var(--theme-text2)' }}>No receipt: paid before part payments</td>
                      </tr>
                    )))}
                  </tbody>
                </table>
              </div>
              <ul className="phone-cards phone-only">
                {list.map(x => (x.type === 'receipt' ? (
                  <li key={x.id} className="phone-card">
                    <div className="phone-card__top">
                      <span className="phone-card__title">{x.row.party_name}</span>
                      <span className="phone-card__figure" style={{ textDecoration: x.row.cancelled_at ? 'line-through' : undefined }}>{npr2(x.row.amount)}</span>
                    </div>
                    <div className="phone-card__meta">{receiptNoLabel(x.row)} · {bsDay(x.row.received_at)} {nepalTime(x.row.received_at)} · {x.row.method}</div>
                    {receiptStatus(x.row)}
                    <div className="phone-card__actions">{receiptActions(x.row, false)}</div>
                  </li>
                ) : (
                  <li key={x.id} className="phone-card">
                    <div className="phone-card__top">
                      <span className="phone-card__title">{x.row.delivery_partner || x.row.buyer_name || '—'}</span>
                      <span className="phone-card__figure">{npr2(Number(x.row.paid_amount) - (Number(x.row.commission_amount) || 0))}</span>
                    </div>
                    <div className="phone-card__meta">{label(x.row)} paid whole · {bsDay(x.row.credit_settled_at)} · {x.row.credit_settled_method}</div>
                  </li>
                )))}
              </ul>
            </>
          )}
        </>
      )}
    </>
  )

  return (
    <div>
      <Tabs idBase="credit-views" label="Credit sections" variant="panel" active={view} onChange={setView} hasPanel style={{ marginBottom: 16 }}
        tabs={[
          { key: 'owed', label: 'Who owes', title: 'Each customer and delivery partner with unpaid Credit bills. Receive a payment or print a statement here.' },
          { key: 'age', label: 'By age', title: 'What is owed, split by how old the bills are. Printable, and as an Excel workbook.' },
          { key: 'collected', label: 'Collected', title: 'Payments received in a date range, with their receipts. Reprint or cancel one here.' },
        ]} />
      {unknownEl}
      {outcomeEl}
      <TabPanel idBase="credit-views" active={view}>
        {view === 'owed' ? owedView : view === 'age' ? ageView : view === 'collected' ? collectedView : null}
      </TabPanel>

      {receiveFor && (
        <ReceivePaymentModal party={receiveFor} vatReg={vatReg} prefix={prefix} deliveryPartners={deliveryPartners} settingsRead={settingsRead}
          onClose={() => setReceiveFor(null)} onAnswered={finishRecord} />
      )}
      {statementFor && (
        <CreditStatementModal party={statementFor} vatReg={vatReg} prefix={prefix} outlet={outlet.info} onClose={() => setStatementFor(null)} />
      )}
      {cancelFor && (
        <CancelReceiptModal receipt={cancelFor} onClose={() => setCancelFor(null)} onAnswered={finishCancel} />
      )}
    </div>
  )
}
