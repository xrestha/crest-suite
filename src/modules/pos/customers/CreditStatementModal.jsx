import { useEffect, useMemo, useState } from 'react'
import { supabase } from '../../../supabaseClient'
import { useScopedDb } from '../../../shared/hooks/useScopedDb'
import Modal from '../../../components/Modal'
import Tip from '../../../components/Tip'
import ReportLoadError from '../../../components/ReportLoadError'
import ActionError from '../../../components/ActionError'
import BsCalendarPicker from '../../../components/BsCalendarPicker'
import RangePresets from '../reports/RangePresets'
import { nepalDayStartTs, nepalDayEndTs, todayNepalBs, todayNepalAdIso } from '../reports/reportRange'
import { settleWithin } from '../../../utils/withTimeout'
import { fetchAllRows, fetchAllRowsChunked } from '../../../shared/fetchAllRows'
import { bsToAd, formatAd, getBsFiscalYearStart, formatAdAsBs } from '../../../utils/bsCalendar'
import { npr2 } from '../../../shared/nepalMoney'
import { nepalTime } from '../../../shared/nepalTime'
import { AGE_BUCKETS, ageingOf, statementOf } from './creditLedger'
import { bsDay, buildStatementHtml, eventParticulars, openPrintWindow, writeAndPrint } from './creditReceiptHtml'

// A customer's or delivery partner's statement of account (S843): every Credit bill (charged), every
// payment, commission and credit note (paid), and a cancelled payment charged back on the day it was
// cancelled, with the running balance. The rows are pos_credit_party_events, whose Σ charged − Σ paid
// is the balance and equals what pos_credit_open_bills says is owed. Under it, what is owed today by
// age of bill. Printable on A4.
//
// The whole history is read once (paged: a busy partner has thousands of rows); the date range only
// chooses which rows show, so changing it never waits on the network.

const LIST_READ_MS = 20000

function fiscalYearStartIso() {
  const t = todayNepalBs()
  return formatAd(bsToAd(getBsFiscalYearStart(t.year, t.month), 4, 1))
}

export default function CreditStatementModal({ party, vatReg, prefix, outlet, onClose }) {
  const { scopedFrom, clientId } = useScopedDb()
  const [fromIso, setFromIso] = useState(fiscalYearStartIso)
  const [toIso, setToIso] = useState(todayNepalAdIso)
  const [data, setData] = useState({ loading: true, events: [], bills: [], vatById: {}, error: null })
  const [printMsg, setPrintMsg] = useState(null)

  useEffect(() => {
    let gone = false
    ;(async () => {
      const results = await Promise.all([
        settleWithin(fetchAllRows(() => supabase.rpc('pos_credit_party_events', { p_party_key: party.key, p_client_id: clientId })
          .order('event_at').order('kind').order('order_id').order('receipt_id')), LIST_READ_MS, "Reading the customer's account"),
        settleWithin(fetchAllRows(() => supabase.rpc('pos_credit_open_bills', { p_party_key: party.key, p_client_id: clientId }).order('closed_at').order('order_id')),
          LIST_READ_MS, 'Reading the unpaid bills'),
      ])
      if (gone) return
      const failed = results.find(r => r.error)
      if (failed) { setData({ loading: false, events: [], bills: [], vatById: {}, error: failed.error }); return }
      const [{ data: events }, { data: bills }] = results
      // Each bill's own VAT stamp, so a bill reads TI or PB as it was issued (S809 2c).
      const ids = [...new Set((events || []).filter(e => e.order_id && (e.kind === 'bill' || e.kind === 'settled')).map(e => e.order_id))]
      const stamps = await settleWithin(fetchAllRowsChunked(ids, part => scopedFrom('pos_orders', 'id, vat_registered').in('id', part).order('id')),
        LIST_READ_MS, 'Reading the bills')
      if (gone) return
      if (stamps.error) { setData({ loading: false, events: [], bills: [], vatById: {}, error: stamps.error }); return }
      const vatById = Object.fromEntries((stamps.data || []).map(o => [o.id, o.vat_registered]))
      setData({ loading: false, events: events || [], bills: bills || [], vatById, error: null })
    })()
    return () => { gone = true }
  }, [party.key]) // eslint-disable-line react-hooks/exhaustive-deps

  const badRange = fromIso && toIso && fromIso > toIso
  const statement = useMemo(() => (data.loading || data.error || badRange ? null
    : statementOf(data.events, { fromTs: fromIso ? nepalDayStartTs(fromIso) : null, toTs: toIso ? nepalDayEndTs(toIso) : null })),
  [data, fromIso, toIso, badRange])
  const ageing = useMemo(() => ageingOf(data.bills), [data.bills])
  const particulars = e => eventParticulars(e, { vatReg, prefix, vatById: data.vatById })
  const ready = !!statement

  function print() {
    if (!ready) return
    if (!outlet) { setPrintMsg("The outlet's name and address could not be read, so the statement cannot be printed. Reload the page and try again."); return }
    const w = openPrintWindow({ wide: true })
    if (!w) { setPrintMsg('The print window was blocked. Allow pop-ups for this site, then press Print again.'); return }
    setPrintMsg(null)
    writeAndPrint(w, buildStatementHtml({
      outlet, party, fromLabel: formatAdAsBs(fromIso), toLabel: formatAdAsBs(toIso), statement, ageing, particulars,
    }))
  }

  return (
    <Modal title={`Statement — ${party.name}`} onClose={onClose} maxWidth={960}>
      <p style={{ margin: '0 0 12px', fontSize: 13, color: 'var(--theme-text2)' }}>
        {party.kind === 'partner' ? 'Delivery partner' : party.phone || 'No phone on the bills'}
      </p>
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-end', marginBottom: 12 }}>
        <RangePresets fromIso={fromIso} toIso={toIso} onPick={r => { setFromIso(r.from); setToIso(r.to) }} />
        <div>
          <label style={{ fontSize: 12, color: 'var(--theme-text2)', display: 'block', marginBottom: 4 }} htmlFor="stmt-from">From (BS)</label>
          <BsCalendarPicker id="stmt-from" value={fromIso} onChange={setFromIso} />
        </div>
        <div>
          <label style={{ fontSize: 12, color: 'var(--theme-text2)', display: 'block', marginBottom: 4 }} htmlFor="stmt-to">To (BS)</label>
          <BsCalendarPicker id="stmt-to" value={toIso} onChange={setToIso} />
        </div>
        <button type="button" className="btn btn-ghost" onClick={print} disabled={!ready} aria-disabled={!outlet ? true : undefined}>
          Print
        </button>
      </div>
      {badRange && <ActionError error="The From date is after the To date." />}
      {printMsg && <ActionError error={printMsg} />}

      {data.loading ? (
        <p role="status" style={{ fontSize: 13, color: 'var(--theme-text3)' }}>Reading the account…</p>
      ) : data.error ? (
        <ReportLoadError error={data.error} />
      ) : statement && (
        <>
          <div className="table-wrap" style={{ marginBottom: 16 }}>
            <table className="data-table">
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Particulars</th>
                  <th style={{ textAlign: 'right' }}><Tip text="A Credit bill, or a cancelled payment charged back. All figures in NPR." width={240}>Charged</Tip></th>
                  <th style={{ textAlign: 'right' }}><Tip text="A payment received, the commission a delivery partner kept, a bill paid whole before part payments existed, or a credit note." width={280}>Paid</Tip></th>
                  <th style={{ textAlign: 'right' }}><Tip text="What was owed after this line." width={200}>Balance</Tip></th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td style={{ whiteSpace: 'nowrap' }}>{formatAdAsBs(fromIso)}</td>
                  <td style={{ fontWeight: 600 }}>Balance brought forward</td>
                  <td></td><td></td>
                  <td style={{ textAlign: 'right', fontWeight: 600 }}>{npr2(statement.opening)}</td>
                </tr>
                {statement.rows.map((r, i) => (
                  <tr key={`${r.kind}-${r.order_id || ''}-${r.receipt_id || ''}-${i}`}>
                    <td style={{ whiteSpace: 'nowrap' }}>{bsDay(r.event_at)}<div style={{ fontSize: 11, color: 'var(--theme-text2)' }}>{nepalTime(r.event_at)}</div></td>
                    <td>{particulars(r)}</td>
                    <td style={{ textAlign: 'right' }}>{Number(r.debit) ? npr2(r.debit) : ''}</td>
                    <td style={{ textAlign: 'right' }}>{Number(r.credit) ? npr2(r.credit) : ''}</td>
                    <td style={{ textAlign: 'right' }}>{npr2(r.balance)}</td>
                  </tr>
                ))}
                {statement.rows.length === 0 && (
                  <tr><td colSpan={5} style={{ color: 'var(--theme-text2)' }}>Nothing was charged or paid in these dates.</td></tr>
                )}
              </tbody>
              <tfoot>
                <tr>
                  <td></td>
                  <td>Balance at {formatAdAsBs(toIso)}</td>
                  <td style={{ textAlign: 'right' }}>{npr2(statement.totalDebit)}</td>
                  <td style={{ textAlign: 'right' }}>{npr2(statement.totalCredit)}</td>
                  <td style={{ textAlign: 'right' }}>{npr2(statement.closing)}</td>
                </tr>
              </tfoot>
            </table>
          </div>
          <h4 style={{ margin: '0 0 6px', fontSize: 13, fontWeight: 700, color: 'var(--theme-text1)' }}>
            <Tip text="Counted today, by Nepal days since each unpaid bill was closed. It is today's position whatever dates are chosen above." width={300}>
              Still owed today, by age of bill
            </Tip>
          </h4>
          <div className="table-wrap">
            <table className="data-table">
              <thead><tr>{AGE_BUCKETS.map(b => <th key={b.key} style={{ textAlign: 'right' }}>{b.label}</th>)}<th style={{ textAlign: 'right' }}>Total</th></tr></thead>
              <tbody>
                <tr>
                  {AGE_BUCKETS.map(b => <td key={b.key} style={{ textAlign: 'right' }}>{npr2(ageing.buckets[b.key])}</td>)}
                  <td style={{ textAlign: 'right', fontWeight: 700 }}>{npr2(ageing.total)}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </>
      )}
      <div style={{ display: 'flex', justifyContent: 'flex-end', margin: '12px 0 4px' }}>
        <button type="button" className="btn btn-ghost" onClick={onClose}>Close</button>
      </div>
    </Modal>
  )
}
