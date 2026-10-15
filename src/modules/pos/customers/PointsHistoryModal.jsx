import { useCallback, useEffect, useState } from 'react'
import { supabase } from '../../../supabaseClient'
import { useScopedDb } from '../../../shared/hooks/useScopedDb'
import { fetchAllRows, fetchAllRowsChunked } from '../../../shared/fetchAllRows'
import Modal from '../../../components/Modal'
import Tip from '../../../components/Tip'
import ActionError, { asActionError } from '../../../components/ActionError'
import { settleWithin, isTimeout } from '../../../utils/withTimeout'
import { isNetworkError } from '../../../shared/errorText'
import { profileNamesRpc, namesMapOf, fillMissingNames } from '../../../shared/profileNames'
import { normalizePhone } from '../../../utils/phone'
import { nepalBsLong, nepalDateLong, nepalTime } from '../../../shared/nepalTime'
import { pointsValue, describeLedgerRow, billLabel, billsMissingPoints, nprPoints } from './loyaltyPoints'

// A customer's whole points history, and the one-tap "add the points this bill earned" (S815 4g).
//
// Adjust shows the latest 10 rows; nothing showed them all, so "did Bill 1234's points ever land?" had
// no answer once a regular had a dozen visits (S809.4, found in 3k). Every row is here, newest first,
// with who wrote it.
//
// Owner addition (2026-10-09): a bill whose award did not land (the till said the points were not
// added) is listed under "Bills with no points", with its points worked out from its stored lines and
// the customer's scheme, and the Owner or a POS manager adds them in one tap. That calls
// award_loyalty_points, so the row is an ordinary earn on the bill and a Credit Note on it takes the
// points back like any other. Only bills since the customer joined their scheme are offered (D13): one
// from before earned nothing on purpose, and the server refuses it.

const CALL_MS = 20000

export default function PointsHistoryModal({ customer, scheme, balance, held, pointValue, canManage = false, onClose, onChanged }) {
  const { clientId, scopedFrom } = useScopedDb()
  const [history, setHistory] = useState({ loading: true, rows: [], error: null })
  const [names, setNames] = useState({ map: {}, failed: false })
  const [missing, setMissing] = useState({ loading: true, rows: [], error: null })
  const [adding, setAdding] = useState(null)   // the order id being added
  const [msg, setMsg] = useState(null)         // { ok, text } or an ActionError value
  const [error, setError] = useState(null)

  const load = useCallback(async () => {
    setHistory(h => ({ ...h, loading: true, error: null }))
    setMissing(m => ({ ...m, loading: true, error: null }))
    const phones = [...new Set([customer.phone, normalizePhone(customer.phone)].filter(Boolean))]
    // S842: every read here is bounded like the names beside them, so a hung one is the section's own
    // error line rather than "Reading…" for ever.
    const [ledRes, nameRes, billRes] = await Promise.all([
      settleWithin(fetchAllRows(() => scopedFrom('pos_loyalty_ledger', 'id, kind, points, note, order_id, created_by, created_at, pos_orders(order_no, invoice_no)')
        .eq('customer_id', customer.id)
        .order('created_at', { ascending: false }).order('id', { ascending: false })), CALL_MS, 'Reading the points history'),
      settleWithin(profileNamesRpc(supabase, clientId), CALL_MS, 'Reading staff names'),
      // Bills that could be missing their points: only for a member, only since they joined (D13).
      scheme && scheme.is_active !== false
        ? settleWithin(fetchAllRows(() => {
          let q = scopedFrom('pos_orders', 'id, order_no, invoice_no, closed_at, close_type, payment_method, credit_note_id, delivery_partner, discount_amount')
            .eq('status', 'billed').in('buyer_phone', phones)
          if (customer.loyalty_enrolled_at) q = q.gte('closed_at', customer.loyalty_enrolled_at)
          return q.order('closed_at', { ascending: false }).order('id')
        }), CALL_MS, "Reading this customer's bills")
        : Promise.resolve({ data: [], error: null }),
    ])
    if (nameRes.error) { console.error('staff names read failed, By shows ?:', nameRes.error); setNames({ map: {}, failed: true }) }
    else {
      // S840: a row Crest support wrote is named only when its id is asked for, so the ids the first
      // read did not name are asked for beside the rest of the load (usually none, and then nothing
      // is sent). A failure there marks only those rows "?".
      const first = namesMapOf(nameRes.data)
      setNames({ map: first, failed: false })
      void fillMissingNames(supabase, clientId, first, (ledRes.data || []).map(r => r.created_by), { ms: CALL_MS })
        .then(filled => {
          if (filled.map === first && !filled.error) return
          if (filled.error) console.error('staff names for some rows could not be read, By shows ?:', filled.error)
          setNames({ map: filled.map, failed: !!filled.error })
        })
    }

    // A failed read keeps what is already shown rather than blanking it.
    if (ledRes.error) setHistory(h => ({ ...h, loading: false, error: ledRes.error }))
    else setHistory({ loading: false, rows: ledRes.data || [], error: null })

    // The missing-points list needs both the ledger and the bills; without either it says nothing at all,
    // because "no bills are missing points" from a failed read is the S594 wrong answer.
    if (ledRes.error || billRes.error) { setMissing({ loading: false, rows: [], error: billRes.error || ledRes.error }); return }
    const earnedIds = new Set((ledRes.data || []).filter(r => r.kind === 'earn' && r.order_id).map(r => r.order_id))
    const candidates = (billRes.data || []).filter(b => b.close_type === 'paid' && !b.credit_note_id && !b.delivery_partner && !earnedIds.has(b.id))
    const { data: items, error: itemErr } = await settleWithin(fetchAllRowsChunked(candidates.map(b => b.id), ids =>
      scopedFrom('pos_order_items', 'order_id, qty, unit_price, comped').in('order_id', ids).order('id')), CALL_MS, "Reading the bills' lines")
    if (itemErr) { setMissing({ loading: false, rows: [], error: itemErr }); return }
    const itemsByOrder = new Map()
    for (const i of items || []) {
      if (!itemsByOrder.has(i.order_id)) itemsByOrder.set(i.order_id, [])
      itemsByOrder.get(i.order_id).push(i)
    }
    setMissing({
      loading: false, error: null,
      rows: billsMissingPoints({ bills: candidates, earnedIds, itemsByOrder, scheme, joinedAt: customer.loyalty_enrolled_at }),
    })
  }, [scopedFrom, clientId, customer.id, customer.phone, customer.loyalty_enrolled_at, scheme])

  useEffect(() => { load() }, [load])

  async function addPoints(bill, expected) {
    if (adding) return
    setAdding(bill.id)
    setMsg(null)
    setError(null)
    const { data, error: err } = await settleWithin(
      supabase.rpc('award_loyalty_points', { p_order_id: bill.id }), CALL_MS, 'Adding the points')
    setAdding(null)
    if (err) {
      // A lost answer is not a refusal: the points may have landed. Read the history again so the
      // reader sees whether they are there before pressing again (the server never adds them twice).
      if (isTimeout(err) || isNetworkError(err)) {
        setError({
          text: `It is not known whether the points for ${billLabel(bill)} were added — the connection dropped before the answer came back. The history below was read again; if the bill is still listed, its points are not there yet.`,
          detail: asActionError(err, 'operator').detail,
        })
      } else {
        setError(asActionError(err, 'operator'))
      }
      await load()
      onChanged?.()
      return
    }
    const n = Number(data) || 0
    setMsg(n > 0
      ? { ok: true, text: `+${n.toLocaleString('en-IN')} point${n === 1 ? '' : 's'} added for ${billLabel(bill)}${n !== expected ? ` (worked out from the bill as it is stored, not the ${expected} shown)` : ''}.${bill.payment_method === 'Credit' ? ' They can be spent once this Credit bill is paid in full.' : ''}` }
      : { ok: false, text: `No points were added for ${billLabel(bill)}: it already has its points, or it no longer earns any (its scheme or the customer changed). The list was read again.` })
    await load()
    onChanged?.()
  }

  const fmt = n => Number(n).toLocaleString('en-IN')
  const when = ts => `${nepalBsLong(ts) || nepalDateLong(ts)} · ${nepalTime(ts)}`
  const spendable = Math.max(0, (balance || 0) - (held || 0))

  return (
    <Modal title={`Points history — ${customer.name}`} onClose={() => { if (!adding) onClose() }} maxWidth={640}>
      <p style={{ margin: '0 0 12px', fontSize: 13, color: 'var(--theme-text2)' }}>
        {customer.phone} · holds <strong style={{ color: 'var(--theme-text1)' }}>{fmt(balance || 0)} points</strong>
        {pointValue != null && balance > 0 ? ` (worth ${nprPoints(pointsValue(balance, pointValue))})` : ''}
        {held > 0 && <> · {fmt(spendable)} can be spent now, {fmt(held)} once its Credit bills are paid in full</>}
      </p>

      {msg && (
        <p role="status" style={{ margin: '0 0 12px', fontSize: 13, color: msg.ok ? 'var(--theme-green-text)' : 'var(--theme-text1)' }}>{msg.text}</p>
      )}
      <ActionError error={error} />

      {/* ── Bills with no points (the one-tap add) ── */}
      {scheme && scheme.is_active !== false && (
        <section style={{ marginBottom: 18 }}>
          <h3 style={{ margin: '0 0 6px', fontSize: 13, fontWeight: 700, color: 'var(--theme-text1)' }}>
            <Tip text="Bills closed since this customer joined their scheme that should have earned points and have none — usually because the till could not add them as the bill closed. The points are worked out from the bill's stored dishes and discount at the scheme's rate. A Credit Note on the bill later takes them back, like any other points it earned." width={340}>
              Bills with no points
            </Tip>
          </h3>
          {missing.error ? (
            <ActionError error={{ text: `Could not check this customer's bills for missing points, so none are listed. ${asActionError(missing.error, 'operator').text}`, detail: asActionError(missing.error, 'operator').detail }} />
          ) : missing.loading && missing.rows.length === 0 ? (
            <p role="status" style={{ fontSize: 12, color: 'var(--theme-text3)', margin: 0 }}>Checking bills…</p>
          ) : missing.rows.length === 0 ? (
            <p style={{ fontSize: 12, color: 'var(--theme-text3)', margin: 0 }}>
              Every bill since {customer.loyalty_enrolled_at ? `they joined on ${nepalBsLong(customer.loyalty_enrolled_at) || nepalDateLong(customer.loyalty_enrolled_at)}` : 'they joined'} has its points.
            </p>
          ) : (
            <>
              {!canManage && (
                <p role="note" style={{ fontSize: 12, margin: '0 0 6px', color: 'var(--theme-text2)' }}>
                  The Owner or a POS manager can add these points.
                </p>
              )}
              <div className="table-wrap">
                <table className="data-table" style={{ fontSize: 12 }}>
                  <thead>
                    <tr><th>Bill</th><th>Closed</th><th style={{ textAlign: 'right' }}>Earns</th>{canManage && <th aria-label="Add" />}</tr>
                  </thead>
                  <tbody>
                    {missing.rows.map(({ bill, points }) => (
                      <tr key={bill.id}>
                        <td style={{ whiteSpace: 'nowrap' }}>{billLabel(bill)}{bill.payment_method === 'Credit' ? ' · Credit' : ''}</td>
                        <td><span style={{ whiteSpace: 'nowrap' }}>{when(bill.closed_at)}</span></td>
                        <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>{fmt(points)} pts</td>
                        {canManage && (
                          <td style={{ textAlign: 'right' }}>
                            <button className="btn btn-ghost btn-sm" onClick={() => addPoints(bill, points)} disabled={!!adding}
                              aria-label={`Add ${points} points for ${billLabel(bill)}`}>
                              {adding === bill.id ? 'Adding…' : `Add ${fmt(points)} pts`}
                            </button>
                          </td>
                        )}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </section>
      )}

      {/* ── Every row ── */}
      <h3 style={{ margin: '0 0 6px', fontSize: 13, fontWeight: 700, color: 'var(--theme-text1)' }}>
        <Tip text="Every change to this customer's points, newest first: points earned and spent on bills, points handed back from an unfinished payment, credit-note reversals, hand corrections and moves between numbers, with who made each." width={320}>
          All points
        </Tip>
        {!history.error && history.rows.length > 0 && (
          <span style={{ fontWeight: 400, color: 'var(--theme-text3)' }}> · {fmt(history.rows.length)} entr{history.rows.length === 1 ? 'y' : 'ies'}</span>
        )}
      </h3>
      {history.error && (
        <ActionError error={{ text: `The points history could not be read, so it is not shown. ${asActionError(history.error, 'operator').text}`, detail: asActionError(history.error, 'operator').detail }} />
      )}
      {history.loading && history.rows.length === 0 ? (
        <p role="status" style={{ fontSize: 12, color: 'var(--theme-text3)', margin: 0 }}>Reading the points history…</p>
      ) : !history.error && history.rows.length === 0 ? (
        <p style={{ fontSize: 12, color: 'var(--theme-text3)', margin: 0 }}>No points earned or spent yet.</p>
      ) : history.rows.length > 0 && (
        <div className="table-wrap">
          <table className="data-table" style={{ fontSize: 12 }}>
            <thead>
              <tr><th>When</th><th>What</th><th>By</th><th style={{ textAlign: 'right' }}>Points</th></tr>
            </thead>
            <tbody>
              {history.rows.map(r => {
                const d = describeLedgerRow(r)
                return (
                  <tr key={r.id}>
                    <td><span style={{ whiteSpace: 'nowrap' }}>{when(r.created_at)}</span></td>
                    <td>{d.what}{d.bill ? ` · ${d.bill}` : ''}</td>
                    <td>{!r.created_by ? '—' : (names.map[r.created_by] || (names.failed ? '?' : '—'))}</td>
                    {/* A ledger line is a record, not an alarm: earned points take the loyalty purple the
                        balances use, a minus stays quiet (as in Adjust). */}
                    <td style={{ textAlign: 'right', fontWeight: 600, whiteSpace: 'nowrap', color: r.points > 0 ? 'var(--theme-purple-text)' : r.points < 0 ? 'var(--theme-text2)' : 'var(--theme-text3)' }}>
                      {r.points > 0 ? '+' : ''}{fmt(r.points)}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 16 }}>
        <button className="btn btn-ghost" onClick={onClose} disabled={!!adding}>Close</button>
      </div>
    </Modal>
  )
}
