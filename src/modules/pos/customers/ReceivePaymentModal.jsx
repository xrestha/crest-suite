import { useEffect, useMemo, useRef, useState } from 'react'
import { supabase } from '../../../supabaseClient'
import { useScopedDb } from '../../../shared/hooks/useScopedDb'
import Modal from '../../../components/Modal'
import Tip from '../../../components/Tip'
import FieldError, { fieldAria } from '../../../components/FieldError'
import ActionError, { asActionError } from '../../../components/ActionError'
import ReportLoadError from '../../../components/ReportLoadError'
import { settleWithin } from '../../../utils/withTimeout'
import { fetchAllRows, fetchAllRowsChunked } from '../../../shared/fetchAllRows'
import { randomUUID } from '../../../utils/uuid'
import { npr2 } from '../../../shared/nepalMoney'
import { computeOrderAmounts, billVatRegistered } from '../../../utils/posBillingMath'
import {
  allocatePayment, parseAmount, toPaisa, fromPaisa, suggestedCommission, creditBillLabel, nepalDaysBetween,
} from './creditLedger'
import { RECEIPT_METHODS, SETTLE_READ_MS, recordCreditReceipt, paymentSummary, recordOutcome } from './settleCredit'
import { bsDay, openPrintWindow, closeQuietly } from './creditReceiptHtml'

// Receive payment (S843): one customer's or delivery partner's money, spread over their unpaid Credit
// bills. Replaces the whole-bill Settle. Owner decisions: any amount up to what is owed and never more
// (no advances); the oldest bills fill first as the amount is typed, and the cashier may untick a bill,
// tick another, or set a bill's amount by hand; a partner's bill also carries the commission it keeps.
//
// The dialog writes nothing until Record, and Record is ONE call (record_credit_receipt), which checks
// every line again under the bills' locks. Its answer goes back to the tab (`onAnswered`), which prints
// the receipt and says what happened; only a refusal stays here, because the form is still worth fixing.

const LIST_READ_MS = 20000
const READ_MS = SETTLE_READ_MS
// How long the payment summary must stay unchanged before it is announced (S852).
export const SUMMARY_SETTLE_MS = 800
const money = n => `NPR ${npr2(n)}`

export default function ReceivePaymentModal({ party, vatReg, prefix, deliveryPartners = [], settingsRead, onClose, onAnswered }) {
  const { scopedFrom, clientId } = useScopedDb()
  const isPartner = party.kind === 'partner'
  const [load, setLoad] = useState({ loading: true, bills: [], error: null })
  const [meta, setMeta] = useState({ loading: true, vatById: {}, baseById: null, error: null })
  const [shift, setShift] = useState({ open: null, error: null })
  const [method, setMethod] = useState('')
  const [totalText, setTotalText] = useState('')
  const [excluded, setExcluded] = useState([])
  const [pinnedText, setPinnedText] = useState({})
  const [commissionText, setCommissionText] = useState({})
  const [reference, setReference] = useState('')
  const [note, setNote] = useState('')
  const [showErrors, setShowErrors] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const touched = useRef(false)

  // The party's bills as the server sees them NOW (the tab's list may be minutes old), and the drawer.
  useEffect(() => {
    let gone = false
    ;(async () => {
      const [bills, sh] = await Promise.all([
        settleWithin(fetchAllRows(() => supabase.rpc('pos_credit_open_bills', { p_party_key: party.key, p_client_id: clientId }).order('closed_at').order('order_id')),
          LIST_READ_MS, "Reading this customer's unpaid bills"),
        settleWithin(scopedFrom('pos_shifts', 'id').eq('status', 'open').limit(1), READ_MS, 'Checking for an open shift'),
      ])
      if (gone) return
      setShift(sh.error ? { open: null, error: sh.error } : { open: (sh.data || []).length > 0, error: null })
      if (bills.error) { setLoad({ loading: false, bills: [], error: bills.error }); return }
      const rows = bills.data || []
      setLoad({ loading: false, bills: rows, error: null })
      // Each bill's own VAT stamp (TI or PB as issued) and, for a partner, the ex-VAT base the agreed
      // commission is worked on (S596: post-discount, comped lines left out, never paid_amount).
      const ids = rows.map(b => b.order_id)
      const reads = [settleWithin(fetchAllRowsChunked(ids, part => scopedFrom('pos_orders', 'id, discount_amount, vat_registered').in('id', part).order('id')), LIST_READ_MS, 'Reading the bills')]
      if (isPartner) {
        reads.push(settleWithin(fetchAllRowsChunked(ids, part => scopedFrom('pos_order_items', 'id, order_id, qty, unit_price, vat_rate, comped, selection_key').in('order_id', part).order('id')),
          LIST_READ_MS, "Reading the bills' lines"))
      }
      const [orders, items] = await Promise.all(reads)
      if (gone) return
      const err = orders.error || items?.error || null
      const vatById = {}
      for (const o of orders.data || []) vatById[o.id] = o.vat_registered
      let baseById = null
      if (isPartner && !err) {
        const linesBy = new Map()
        for (const i of items.data || []) {
          if (i.comped) continue
          if (!linesBy.has(i.order_id)) linesBy.set(i.order_id, [])
          linesBy.get(i.order_id).push(i)
        }
        baseById = {}
        for (const o of orders.data || []) {
          const a = computeOrderAmounts(o, linesBy.get(o.id) || [], billVatRegistered(o, vatReg))
          baseById[o.id] = a.taxableBase + a.nonTaxableBase
        }
      }
      setMeta({ loading: false, vatById, baseById, error: err })
    })()
    return () => { gone = true }
  }, [party.key]) // eslint-disable-line react-hooks/exhaustive-deps

  // The agreed rate from POS Setup → Delivery Partners, the settle flow's pre-fill (S596). Only a rate
  // that was read: the defaults are a guess, so a failed settings read leaves the boxes for the cashier.
  const pct = useMemo(() => {
    if (!isPartner || settingsRead !== true) return null
    const name = String(party.partner || party.name || '').trim().toLowerCase()
    const p = (deliveryPartners || []).find(d => String(d?.name || '').trim().toLowerCase() === name)
    return p?.commission_pct ?? null
  }, [isPartner, settingsRead, deliveryPartners, party.partner, party.name])

  // Pre-fill each bill's commission once its base is known, unless the cashier has typed one.
  useEffect(() => {
    if (!isPartner || !meta.baseById || pct == null) return
    setCommissionText(prev => {
      const next = { ...prev }
      for (const b of load.bills) {
        if (next[b.order_id] !== undefined) continue
        const s = suggestedCommission({ base: meta.baseById[b.order_id], pct, alreadyKept: b.commission, owed: b.owed })
        if (s != null) next[b.order_id] = String(s)
      }
      return next
    })
  }, [isPartner, meta.baseById, pct, load.bills])

  const label = b => creditBillLabel({ ...b, vat_registered: meta.vatById[b.order_id] }, vatReg, prefix)

  // Every box parsed once per keystroke; the allocation is a pure function of them (creditLedger).
  const parsed = useMemo(() => {
    const total = parseAmount(totalText)
    const pinned = {}
    const comm = {}
    const fieldErrors = {}
    for (const [id, text] of Object.entries(pinnedText)) {
      const p = parseAmount(text)
      if (p.error) fieldErrors[`amt-${id}`] = p.error
      else if (p.paisa != null) pinned[id] = p.paisa
    }
    if (isPartner) {
      for (const [id, text] of Object.entries(commissionText)) {
        const p = parseAmount(text)
        if (p.error) fieldErrors[`comm-${id}`] = p.error
        else if (p.paisa != null) comm[id] = p.paisa
      }
    }
    return { total, pinned, comm, fieldErrors }
  }, [totalText, pinnedText, commissionText, isPartner])

  const alloc = useMemo(() => allocatePayment({
    bills: load.bills, total: parsed.total.paisa, excluded, pinned: parsed.pinned, commission: parsed.comm,
  }), [load.bills, parsed, excluded])

  const rowProblem = {}
  for (const p of alloc.problems) if (p.orderId && !rowProblem[p.orderId]) rowProblem[p.orderId] = p.text
  const formProblem = alloc.problems.find(p => !p.orderId)
  const anyFieldError = Object.keys(parsed.fieldErrors).length > 0 || Object.keys(rowProblem).length > 0
  const blocker = load.loading || load.error ? { label: 'Record payment', focus: null, quiet: true }
    : !method ? { label: 'Choose how they paid', focus: 'rp-method' }
      : parsed.total.error ? { label: 'Check the amount', focus: 'rp-total' }
        : anyFieldError ? { label: 'Check the bills', focus: null }
          : !alloc.ok ? { label: formProblem?.empty ? 'Type the amount' : 'Check the amount', focus: 'rp-total' }
            : null
  const shown = showErrors || touched.current
  const totalMsg = parsed.total.error || (shown && formProblem ? formProblem.text : '')
  const dirty = totalText !== '' || method !== '' || reference !== '' || note !== '' || excluded.length > 0 || Object.keys(pinnedText).length > 0

  function setTotal(text) {
    touched.current = true
    setTotalText(text)
  }
  function payAll() {
    const room = alloc.rows.reduce((s, r) => s + r.room, 0)
    touched.current = true
    setExcluded([])
    setPinnedText({})
    setTotalText(String(fromPaisa(room)))
  }
  function toggle(row) {
    touched.current = true
    if (row.ticked) {
      setExcluded(x => [...new Set([...x, row.orderId])])
      setPinnedText(p => { const n = { ...p }; delete n[row.orderId]; return n })
    } else {
      setExcluded(x => x.filter(id => id !== row.orderId))
      // A tick pays the bill in full, after its commission; the cashier can lower it.
      setPinnedText(p => ({ ...p, [row.orderId]: String(fromPaisa(row.room)) }))
    }
  }
  function setRowAmount(row, text) {
    touched.current = true
    if (text.trim() === '') {
      setPinnedText(p => { const n = { ...p }; delete n[row.orderId]; return n })
      return
    }
    setExcluded(x => x.filter(id => id !== row.orderId))
    setPinnedText(p => ({ ...p, [row.orderId]: text }))
  }

  async function record() {
    if (busy) return
    if (blocker) {
      setShowErrors(true)
      if (blocker.focus) document.getElementById(blocker.focus)?.focus()
      return
    }
    // Opened on the press, before anything is awaited, so the browser lets it open (the receipt goes
    // into it once the payment is recorded; it closes again if nothing is).
    const w = openPrintWindow()
    const press = {
      requestId: randomUUID(), partyKey: party.key, partyName: party.name, method,
      amount: fromPaisa(alloc.total), lines: alloc.lines, reference: method === 'Cash' ? '' : reference, note,
    }
    setBusy(true)
    setError(null)
    let result
    try {
      result = await recordCreditReceipt({
        rpc: (name, args, signal) => (signal ? supabase.rpc(name, args).abortSignal(signal) : supabase.rpc(name, args)),
        ...press,
      })
    } catch (err) {
      console.error('recording a payment failed unexpectedly:', err)
      result = { status: 'unknown', error: err }
    }
    setBusy(false)
    if (result.status === 'refused') {
      closeQuietly(w)
      const o = recordOutcome(result, press)
      setError({ text: o.text, detail: asActionError(result.error, 'operator').detail })
      return
    }
    onAnswered({ result, press, w })
  }

  const summary = alloc.ok && method
    ? paymentSummary({
      partyName: party.name, partner: isPartner, method, total: alloc.total, commissionTotal: alloc.commissionTotal,
      rows: alloc.rows, label, shiftOpen: shift.open,
    })
    : null
  const owedTotal = load.bills.reduce((s, b) => s + toPaisa(b.owed), 0)

  // S852: the summary re-words itself on every keystroke of an amount, and as a live region it was
  // read out per digit. It is shown at once, and announced only once it has stood still for a moment.
  const summaryText = summary ? summary.join(' ') : ''
  const [announced, setAnnounced] = useState('')
  useEffect(() => {
    const t = setTimeout(() => setAnnounced(summaryText), SUMMARY_SETTLE_MS)
    return () => clearTimeout(t)
  }, [summaryText])

  return (
    <Modal title={`Receive payment — ${party.name}`} onClose={() => { if (!busy) onClose() }} maxWidth={860} dirty={dirty}>
      <p style={{ margin: '0 0 12px', fontSize: 13, color: 'var(--theme-text2)' }}>
        {isPartner ? 'Delivery partner' : party.phone || 'No phone on the bills'}
        {!load.loading && !load.error && <> · owes <strong style={{ color: 'var(--theme-text1)' }}>{money(fromPaisa(owedTotal))}</strong> on {load.bills.length} bill{load.bills.length === 1 ? '' : 's'}</>}
        {party.limit != null && <> · credit limit {money(party.limit)}</>}
      </p>

      {load.loading ? (
        <p role="status" style={{ fontSize: 13, color: 'var(--theme-text3)' }}>Reading the unpaid bills…</p>
      ) : load.error ? (
        <ReportLoadError error={load.error} />
      ) : load.bills.length === 0 ? (
        <p className="note-banner" style={{ margin: '0 0 12px' }}>Nothing is owed on this account now: its bills were paid or credited since the list was read. Close this to see the list again.</p>
      ) : (
        <fieldset disabled={busy} style={{ border: 'none', padding: 0, margin: 0, minWidth: 0 }}>
          <div className="field-grid" style={{ marginBottom: 12 }}>
            <div className="form-field">
              <label htmlFor="rp-total">
                <Tip text="What they are handing over now. The oldest bills fill first as you type. It can be any amount up to what they owe, never more: an extra amount cannot be taken as an advance." width={300}>
                  Amount received
                </Tip>
              </label>
              <input id="rp-total" className="form-input" inputMode="decimal" autoComplete="off" value={totalText}
                placeholder={money(fromPaisa(owedTotal))} onChange={e => setTotal(e.target.value)}
                {...fieldAria('rp-total', totalMsg)} />
              <FieldError id="rp-total" message={totalMsg} />
              <button type="button" className="btn btn-ghost" style={{ marginTop: 6 }} onClick={payAll}>
                Whole balance ({money(fromPaisa(alloc.rows.reduce((s, r) => s + r.room, 0)))})
              </button>
            </div>
            <div className="form-field">
              <label htmlFor="rp-method">
                <Tip text="How the money really came. Only Cash goes on the open shift's drawer count; the rest are recorded for the books." width={260}>
                  Paid by
                </Tip>
              </label>
              <select id="rp-method" className="form-select" value={method} onChange={e => { setMethod(e.target.value); touched.current = true }}
                {...fieldAria('rp-method', showErrors && !method ? 'Choose how they paid.' : '')}>
                <option value="">Choose…</option>
                {RECEIPT_METHODS.map(m => <option key={m} value={m}>{m}</option>)}
              </select>
              <FieldError id="rp-method" message={showErrors && !method ? 'Choose how they paid.' : ''} />
            </div>
            {method && method !== 'Cash' && (
              <div className="form-field">
                <label htmlFor="rp-ref">
                  <Tip text="The cheque number, or the transaction ID from the wallet or the bank. It prints on the receipt so the payment can be traced. Optional." width={280}>
                    Reference
                  </Tip>
                </label>
                <input id="rp-ref" className="form-input" maxLength={60} autoComplete="off" value={reference}
                  onChange={e => setReference(e.target.value)} placeholder={method === 'Cheque' ? 'Cheque no.' : 'Transaction ID'} />
              </div>
            )}
          </div>

          {method === 'Cash' && shift.open === false && (
            <p role="alert" style={{ margin: '0 0 12px', fontSize: 13, color: 'var(--theme-amber-text)' }}>
              <span aria-hidden="true">△ </span><strong>No shift is open.</strong> Cash cannot be recorded without one, because the
              money would have no drawer to go in. Open a shift in Shifts first, or pick how they really paid if it was not cash.
            </p>
          )}
          {method === 'Cash' && shift.error && (
            <p role="note" style={{ margin: '0 0 12px', fontSize: 12, color: 'var(--theme-amber-text)' }}>
              Could not check whether a shift is open. A Cash payment is refused if none is.
            </p>
          )}
          {isPartner && (meta.error || (!meta.loading && pct == null)) && (
            <p role="note" style={{ margin: '0 0 12px', fontSize: 12, color: 'var(--theme-amber-text)' }}>
              {meta.error
                ? "The bills' lines could not be read, so the commission was not worked out. Type each bill's commission from the platform's statement."
                : settingsRead !== true
                  ? "This outlet's delivery-partner rates could not be read, so the commission was not worked out. Type each bill's commission from the platform's statement."
                  : `No agreed commission rate was found for ${party.name} in POS Setup, so the commission boxes are empty. Type each bill's commission from the platform's statement.`}
            </p>
          )}

          <div className="table-wrap" style={{ marginBottom: 12 }}>
            <table className="data-table table-stack">
              <thead>
                <tr>
                  <th><span className="sr-only">Paying</span></th>
                  <th><Tip text="Oldest first. All figures in NPR." width={200}>Bill</Tip></th>
                  <th style={{ textAlign: 'right' }}><Tip text="What the bill still owes now, after any earlier part payments." width={240}>Owes</Tip></th>
                  {isPartner && <th style={{ textAlign: 'right' }}><Tip text="What the platform keeps on this bill, from its remittance statement. It clears that much of the bill without reaching you. Pre-filled from the agreed rate in POS Setup on the bill before VAT; check it against the statement." width={320}>Commission kept</Tip></th>}
                  <th style={{ textAlign: 'right' }}>Paying now</th>
                  <th style={{ textAlign: 'right' }}><Tip text="What this bill will still owe once this payment is recorded." width={220}>Still owed</Tip></th>
                </tr>
              </thead>
              <tbody>
                {alloc.rows.map(row => {
                  const b = row.bill
                  const days = nepalDaysBetween(b.closed_at)
                  const amtId = `rp-amt-${row.orderId}`
                  const commId = `rp-comm-${row.orderId}`
                  const amtMsg = parsed.fieldErrors[`amt-${row.orderId}`] || rowProblem[row.orderId] || ''
                  const commMsg = parsed.fieldErrors[`comm-${row.orderId}`] || ''
                  return (
                    <tr key={row.orderId}>
                      <td className="stack-end">
                        <label style={{ display: 'inline-flex', alignItems: 'center', minHeight: 44, minWidth: 44, justifyContent: 'center', cursor: 'pointer' }}>
                          <input type="checkbox" checked={row.ticked} onChange={() => toggle(row)}
                            aria-label={`Pay bill ${label(b)}`} />
                        </label>
                      </td>
                      <td className="stack-main">
                        <span style={{ fontWeight: 600, color: 'var(--theme-text1)', whiteSpace: 'nowrap' }}>{label(b)}</span>
                        <div style={{ fontSize: 12, color: 'var(--theme-text2)' }}>
                          <span style={{ whiteSpace: 'nowrap' }}>{bsDay(b.closed_at)}</span>
                          {days != null && <> · {days === 0 ? 'today' : `${days} day${days === 1 ? '' : 's'}`}</>}
                          {Number(b.received) > 0 && <> · {money(b.received)} paid earlier</>}
                        </div>
                      </td>
                      <td data-label="Owes" className="stack-third" style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>{npr2(b.owed)}</td>
                      {isPartner && (
                        <td data-label="Commission kept" className="stack-third" style={{ textAlign: 'right' }}>
                          <input id={commId} className="form-input" inputMode="decimal" autoComplete="off" style={{ width: 110, textAlign: 'right' }}
                            value={commissionText[row.orderId] ?? ''} placeholder="0"
                            onChange={e => { touched.current = true; const v = e.target.value; setCommissionText(c => ({ ...c, [row.orderId]: v })) }}
                            aria-label={`Commission kept on bill ${label(b)}`} {...fieldAria(commId, commMsg)} />
                          <FieldError id={commId} message={commMsg} />
                        </td>
                      )}
                      <td data-label="Paying now" className="stack-third" style={{ textAlign: 'right' }}>
                        <input id={amtId} className="form-input" inputMode="decimal" autoComplete="off" style={{ width: 120, textAlign: 'right' }}
                          value={pinnedText[row.orderId] ?? (row.amount ? String(fromPaisa(row.amount)) : '')}
                          placeholder="0" onChange={e => setRowAmount(row, e.target.value)}
                          aria-label={`Paying now on bill ${label(b)}`} {...fieldAria(amtId, amtMsg)} />
                        <FieldError id={amtId} message={amtMsg} />
                      </td>
                      <td data-label="Still owed" className="stack-third" style={{ textAlign: 'right', whiteSpace: 'nowrap', color: row.owedAfter === 0 && row.ticked ? 'var(--theme-green-text)' : 'var(--theme-text1)' }}>
                        {row.ticked && row.owedAfter === 0 ? 'Paid' : npr2(fromPaisa(row.owedAfter))}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>

          <div className="form-field" style={{ marginBottom: 12 }}>
            <label htmlFor="rp-note">
              <Tip text="Anything worth keeping with this payment, such as who brought it. Prints on the receipt. Optional." width={260}>
                Note
              </Tip>
            </label>
            <input id="rp-note" className="form-input" maxLength={300} autoComplete="off" value={note} onChange={e => setNote(e.target.value)} />
          </div>

          {summary && (
            <div style={{ margin: '0 0 12px', fontSize: 13, color: 'var(--theme-text1)' }}>
              {summary.map((line, i) => <p key={i} style={{ margin: i ? '6px 0 0' : 0 }}>{line}</p>)}
            </div>
          )}
        </fieldset>
      )}
      {/* Mounted before it has anything to say, so a screen reader hears the first summary too. */}
      <p role="status" className="sr-only">{announced}</p>

      <ActionError error={error} />

      <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', flexWrap: 'wrap', margin: '12px 0 4px' }}>
        <button type="button" className="btn btn-ghost" onClick={onClose} disabled={busy}>Cancel</button>
        {!load.loading && !load.error && load.bills.length > 0 && (
          // aria-disabled, not disabled (the S759 pattern): a press says what is missing and moves to it.
          <button type="button" className="btn btn-primary" onClick={record} aria-busy={busy || undefined}
            aria-disabled={!busy && blocker ? true : undefined}>
            {busy ? 'Recording…' : blocker ? blocker.label : `Record ${money(fromPaisa(alloc.total))}`}
          </button>
        )}
      </div>
    </Modal>
  )
}
