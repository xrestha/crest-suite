import { npr } from '../../../shared/nepalMoney'
import { outletHasIms } from '../orders/posImsWaiting'
import { billCountsForIms } from '../orders/inventorySince'
import { useState, useEffect, useCallback } from 'react'
import { Navigate } from 'react-router-dom'
import { useAuth } from '../../../context/AuthContext'
import { supabase } from '../../../supabaseClient'
import { useScopedDb } from '../../../shared/hooks/useScopedDb'
import { fetchAllRows } from '../../../shared/fetchAllRows'
import Tip from '../../../components/Tip'
import BsCalendarPicker from '../../../components/BsCalendarPicker'
import { getBsFiscalYear, formatAd } from '../../../utils/bsCalendar'
import { nepalBsLong, nepalCivilDate } from '../../../shared/nepalTime'
import { nepalDayStartTs, nepalDayEndTs, todayNepalAdIso, todayNepalBs } from '../reports/reportRange'
import { settleWithin } from '../../../utils/withTimeout'
import { readHscMap, REPRINT_READ_MS } from '../orders/billReprintData'
import { printCreditNote } from './creditNoteHtml'
import IssueCreditNoteModal from './IssueCreditNoteModal'
import ReportLoadError from '../../../components/ReportLoadError'
import ActionError, { asActionError } from '../../../components/ActionError'
import { useLatestRequest } from '../../../shared/hooks/useLatestRequest'

const fmtNpr = npr

// pos_credit_notes.refund_method (S755). NULL on notes issued before it existed.
const REFUND_LABEL = { cash: 'Cash', other: 'Card / QR / bank', none: 'None' }
// pos_credit_notes.restock (S809 2e, Q10 a): the note said the bill's food was not served on it, so
// the food went back into Inventory. false on every note issued before the question was asked — and
// for those the food did stay used, so "Used" is what happened to their stock.
const stockLabel = n => (n.restock === true ? 'Put back' : 'Used')

// A date as Nepal reads it (S809 4c, CREDIT-NOTES-9): `adToBsSafe(new Date(ts))` read the viewer's
// clock zone, so an Owner abroad saw a note issued after 18:45 Nepal time dated the next day.
// The Book's Date cell carries its year too (S833), as the Sales Report's bill register dates a row:
// day and month alone could not tell this Ashwin's note from last Ashwin's on a range crossing a
// year. The AD fallback is Nepal's civil day too, never the timestamp's UTC slice.
const bsDayMonthYear = ts => {
  const long = nepalBsLong(ts)
  if (long) return long
  const civil = nepalCivilDate(ts)
  return civil ? `${formatAd(civil)} (AD)` : '—'
}

// The invoice-number search lists that number from every fiscal year, because numbers restart each
// Shrawan (S809 4c, CREDIT-NOTES-7): typing 45 found this year's #45 and last year's, told apart only
// by the amount. Each row names its year, and this year's comes first (a stable sort, so each year
// keeps its newest-first order).
function currentYearFirst(rows, currentFy) {
  return [...rows].sort((a, b) => (b.invoice_fy === currentFy) - (a.invoice_fy === currentFy))
}

export default function CreditNotes() {
  const { clientId, hasPosAccess, isAdmin, imsEnabled: imsRoute, clientModules } = useAuth()
  // The outlet's own Inventory module, the operator included (outletHasIms, S814).
  const imsEnabled = outletHasIms({ isAdmin, imsEnabled: imsRoute, clientModules })
  // When the outlet's Inventory began (S831 5f-3, Q31 a): a note on an earlier bill is never sent.
  const imsSince = clientModules?.imsSince || null
  const { scopedFrom } = useScopedDb()

  const [tab, setTab] = useState('issue') // 'issue' | 'book'
  // Nepal's today, not the viewer's (S809 4c, CREDIT-NOTES-9).
  const [fromIso, setFromIso] = useState(todayNepalAdIso)
  const [toIso,   setToIso]   = useState(todayNepalAdIso)
  const [invoiceSearch, setInvoiceSearch] = useState('')

  // S754: the search box drove a full reload on every keystroke ("2", "22", "223", "2238" — four
  // concurrent paged reads) and whichever landed last won the list. Debounced here, and each load
  // is keyed so a superseded one cannot write its result over the current one.
  const [debouncedSearch, setDebouncedSearch] = useState('')
  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(invoiceSearch), 300)
    return () => clearTimeout(t)
  }, [invoiceSearch])
  const candReq = useLatestRequest()
  const notesReq = useLatestRequest()

  const [candidates, setCandidates] = useState([])
  const [candLoading, setCandLoading] = useState(false)
  const [candError, setCandError] = useState(null)
  const [pickedOrder, setPickedOrder] = useState(null)

  const [notes, setNotes] = useState([])
  const [notesLoading, setNotesLoading] = useState(false)
  const [notesError, setNotesError] = useState(null)
  // S754: a reprint that could not read its lines or whose pop-up was blocked said nothing.
  const [bookMsg, setBookMsg] = useState(null)
  const [staffNames, setStaffNames] = useState({})
  const [billingSettings, setBillingSettings] = useState({ is_vat_registered: true, invoice_prefix: '', vat_number: '', property_address: '', property_phone: '' })
  const [outletName, setOutletName] = useState('')

  const loadCandidates = useCallback(async () => {
    if (!clientId) return
    const key = candReq.begin(`${clientId}|${fromIso}|${toIso}|${debouncedSearch.trim()}`)
    setCandLoading(true)
    setCandError(null)
    // The picked days' first and last instants in Nepal, not in the viewer's clock zone (S809 4c).
    const fromTs = nepalDayStartTs(fromIso)
    const toTs   = nepalDayEndTs(toIso)
    // An invoice number is a direct lookup, so it deliberately ignores the date range: both
    // pickers default to today, and the single most common real trigger — "a customer came back
    // with a bill from last week" — used to return "No un-credited bills in this range" with
    // nothing saying the date range was the reason.
    const searchNo = parseInt(debouncedSearch.trim(), 10)
    const byInvoiceNo = debouncedSearch.trim() !== '' && !isNaN(searchNo)
    // A FUNCTION returning a fresh builder, not one builder reused: a supabase-js builder is a
    // one-shot thenable, so paging a shared one silently returns the first page every time.
    const makeQuery = () => {
      const q = scopedFrom('pos_orders', 'id, table_name, order_no, invoice_no, invoice_fy, close_type, paid_amount, closed_at, buyer_name, buyer_address, buyer_pan, buyer_phone, discount_amount, credit_note_id')
        .eq('status', 'billed').eq('close_type', 'paid')
        .is('credit_note_id', null)
      return (byInvoiceNo
        ? q.eq('invoice_no', searchNo)
        : q.gte('closed_at', fromTs).lte('closed_at', toTs)
      ).order('closed_at', { ascending: false }).order('id')
    }
    // Paged: the range is whatever the two pickers are set to, so a widened window at a busy
    // outlet passes 1000 bills — and the truncation would drop the bill the customer is standing
    // there holding, indistinguishably from it having already been credited.
    const { data, error } = await fetchAllRows(makeQuery)
    if (!candReq.isCurrent(key)) return
    setCandLoading(false)
    // S754: a failed read rendered "No un-credited bills in this range" — i.e. told a manager the
    // bill in the customer's hand had already been credited.
    if (error) { setCandError(error); setCandidates([]); return }
    const today = todayNepalBs()
    setCandidates(byInvoiceNo && today ? currentYearFirst(data || [], getBsFiscalYear(today.year, today.month)) : (data || []))
  }, [clientId, fromIso, toIso, debouncedSearch, scopedFrom, candReq])

  const loadNotes = useCallback(async () => {
    if (!clientId) return
    const key = notesReq.begin(`${clientId}|${fromIso}|${toIso}`)
    setNotesLoading(true)
    setNotesError(null)
    const fromTs = nepalDayStartTs(fromIso)
    const toTs   = nepalDayEndTs(toIso)
    const results = await Promise.all([
      // The bill's close rides along (the hinted embed: pos_orders also points back at the note), so a
      // note on a bill from before the outlet's Inventory began is not badged as waiting (S831 5f-3).
      scopedFrom('pos_credit_notes', '*, pos_orders!pos_credit_notes_order_id_fkey(closed_at)')
        .gte('created_at', fromTs).lte('created_at', toTs).order('created_at', { ascending: false }),
      // Raw `profiles` reads are RLS-limited to the caller's own row (id = auth.uid() OR admin) —
      // resolving OTHER staff members' names needs get_client_profile_names(), a SECURITY
      // DEFINER RPC. A raw query here silently showed "—" for every staff member except
      // whoever was logged in.
      supabase.rpc('get_client_profile_names', { p_client_id: clientId }),
      supabase.from('settings').select('is_vat_registered, invoice_prefix, vat_number, property_address, property_phone').eq('client_id', clientId).maybeSingle(),
      supabase.from('clients').select('name').eq('id', clientId).single(),
    ])
    if (!notesReq.isCurrent(key)) return
    // S754: every one of these dropped `error`. A failed notes read showed "No Credit Notes issued"
    // and let the Excel register export EMPTY for the range; a failed settings read fell to the
    // `?? true` default and labelled a PAN-bill client's notes and reprints as VAT.
    const failed = results.find(r => r.error)
    if (failed) { setNotesError(failed.error); setNotes([]); setNotesLoading(false); return }
    const [{ data: cn }, { data: profs }, { data: settings }, { data: cl }] = results
    setStaffNames(Object.fromEntries((profs || []).map(p => [p.id, p.full_name])))
    setBillingSettings({
      is_vat_registered: settings?.is_vat_registered ?? true,
      invoice_prefix: settings?.invoice_prefix || '',
      vat_number: settings?.vat_number || '',
      property_address: settings?.property_address || '',
      property_phone: settings?.property_phone || '',
    })
    setOutletName(cl?.name || '')
    setNotes(cn || [])
    setNotesLoading(false)
  }, [clientId, fromIso, toIso, scopedFrom, notesReq])

  useEffect(() => { if (tab === 'issue') loadCandidates() }, [tab, loadCandidates])
  useEffect(() => { if (tab === 'book') loadNotes() }, [tab, loadNotes])

  if (!hasPosAccess('manager')) return <Navigate to="/pos" replace />

  async function reprintNote(note) {
    setBookMsg(null)
    // With the lines (and their choices, S809 4c, CREDIT-NOTES-8), the credited bill's own tax status
    // (S809 2c, CREDIT-NOTES-5): the note reprints as a Tax Invoice or a PAN bill correction because
    // its bill was one, not by today's setting. The copy label is the server's count from the print's
    // own write (S828 5d), so no count is read here. Bounded: the pop-up opens only after these, and a
    // hung read left the press doing nothing.
    const [{ data: items, error: itemsErr }, { data: bill, error: billErr }] = await Promise.all([
      settleWithin(scopedFrom('pos_order_items', 'recipe_id, name, qty, unit_price, vat_rate, comped, option_summary, pos_order_item_options(option_name, price_delta, sort)').eq('order_id', note.order_id), REPRINT_READ_MS, 'Reading the note lines'),
      settleWithin(scopedFrom('pos_orders', 'vat_registered').eq('id', note.order_id).maybeSingle(), REPRINT_READ_MS, 'Reading the bill'),
    ])
    // S754: a failed read here printed a numbered Credit Note with no lines on it, and still
    // advanced its copy counter. Refuse instead — nothing has printed, so a retry is safe.
    const readErr = itemsErr || billErr
    if (readErr) { setBookMsg(asActionError(readErr, 'operator')); return }
    // Same exclusion as the original issuance (IssueCreditNoteModal.jsx) — item-level comps were
    // never billed, so they were never on this Credit Note in the first place.
    const payableItems = (items || []).filter(i => !i.comped)
    const { map: hscMap, error: hscErr } = await readHscMap(scopedFrom, payableItems.map(i => i.recipe_id))
    if (hscErr) { setBookMsg(asActionError(hscErr, 'operator')); return }
    const { printed, newCount, countError } = await printCreditNote(clientId, note, payableItems, billingSettings, outletName, hscMap, bill?.vat_registered ?? null)
    if (!printed) {
      setBookMsg(`The print window for CN${note.credit_note_no} was blocked by the browser, or closed before the note went into it, so nothing printed. Allow pop-ups for this site and press Reprint again.`)
      return
    }
    if (countError) {
      // Printed, but the counter did not move — the next reprint will carry this same copy label.
      setBookMsg({ text: `CN${note.credit_note_no} printed, but its reprint count could not be saved, so the next reprint will carry the same copy label as this one.`, detail: asActionError(countError, 'operator').detail })
      return
    }
    setNotes(prev => prev.map(n => n.id === note.id ? { ...n, print_count: newCount } : n))
  }

  async function exportExcel() {
    const XLSX = await import('xlsx')
    const ws = XLSX.utils.json_to_sheet(notes.map(n => {
      return {
        'CN No': `CN${n.credit_note_no}-${billingSettings.invoice_prefix}${billingSettings.invoice_prefix ? '-' : ''}${n.invoice_fy}`,
        'Ref Invoice No': n.original_invoice_label,
        'Date (BS)': bsDayMonthYear(n.created_at),
        'Buyer': n.buyer_name || 'CASH SALES',
        'Reason': n.reason,
        'Money Back': REFUND_LABEL[n.refund_method] || 'Not recorded',
        ...(imsEnabled ? { 'Food (Inventory)': stockLabel(n) } : {}),
        'Gross (NPR)': Math.round(n.gross_amount * 100) / 100,
        'VAT (NPR)': Math.round(n.vat_amount * 100) / 100,
        'Net (NPR)': Math.round(n.net_amount * 100) / 100,
        'Issued By': staffNames[n.issued_by] || '—',
      }
    }))
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, ws, 'Credit Notes')
    XLSX.writeFile(wb, `credit-note-book-${fromIso}-to-${toIso}.xlsx`)
  }

  const totals = notes.reduce((s, n) => ({ gross: s.gross + n.gross_amount, vat: s.vat + n.vat_amount, net: s.net + n.net_amount }), { gross: 0, vat: 0, net: 0 })

  return (
    <div>
      <div className="page-header">
        <h1 className="page-title">
          Credit Notes <Tip text="Formal Credit Notes for correcting an already-billed order — required by Nepal VAT Rules 2053, Rule 20, whenever the value of billed goods/services changes.">ⓘ</Tip>
        </h1>
        <p className="page-subtitle">
          Issue a Credit Note against a past bill, or review the monthly Credit Note register.
        </p>
      </div>

      <div className="tab-bar" style={{ marginBottom: 20 }}>
        <button className={`tab-btn${tab === 'issue' ? ' tab-btn--active' : ''}`} onClick={() => setTab('issue')}>Issue New</button>
        <button className={`tab-btn${tab === 'book' ? ' tab-btn--active' : ''}`} onClick={() => setTab('book')}>Credit Note Book</button>
      </div>

      {tab === 'issue' && (
        <>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 14, alignItems: 'flex-end', marginBottom: 20 }}>
            <div>
              <label style={{ fontSize: 11, color: 'var(--theme-text3)', display: 'block', marginBottom: 4 }} htmlFor="credit-notes-from-bs">From (BS)</label>
              <BsCalendarPicker id="credit-notes-from-bs" value={fromIso} onChange={setFromIso} />
            </div>
            <div>
              <label style={{ fontSize: 11, color: 'var(--theme-text3)', display: 'block', marginBottom: 4 }} htmlFor="credit-notes-to-bs">To (BS)</label>
              <BsCalendarPicker id="credit-notes-to-bs" value={toIso} onChange={setToIso} />
            </div>
            <div>
              <label style={{ fontSize: 11, color: 'var(--theme-text3)', display: 'block', marginBottom: 4 }} htmlFor="credit-notes-invoice-no">Invoice No.</label>
              <input id="credit-notes-invoice-no" className="form-input" style={{ width: 140 }} placeholder="e.g. 2238" value={invoiceSearch}
                onChange={e => setInvoiceSearch(e.target.value)} />
            </div>
          </div>

          {candLoading ? (
            <p style={{ color: 'var(--theme-text3)', fontSize: 13 }}>Loading…</p>
          ) : candError ? (
            <ReportLoadError error={candError} />
          ) : candidates.length === 0 ? (
            <div className="card" style={{ padding: 32, textAlign: 'center', color: 'var(--theme-text3)', fontSize: 13 }}>
              No un-credited bills in this range.
            </div>
          ) : (
            <div className="table-wrap">
              <table className="data-table">
                <thead>
                  <tr><th>Date</th><th>Invoice No</th><th>Table</th><th>Buyer</th><th style={{ textAlign: 'right' }}>Amount</th><th></th></tr>
                </thead>
                <tbody>
                  {candidates.map(o => {
                    return (
                      <tr key={o.id}>
                        {/* With its year and its fiscal year (S809 4c, CREDIT-NOTES-7): an invoice
                            number restarts every Shrawan, so the bare "45" named two bills. */}
                        <td style={{ whiteSpace: 'nowrap' }}>{bsDayMonthYear(o.closed_at)}</td>
                        <td style={{ fontWeight: 600, color: 'var(--theme-text1)', whiteSpace: 'nowrap' }}>
                          {o.invoice_no}{o.invoice_fy ? <span style={{ fontWeight: 400, color: 'var(--theme-text2)' }}> · FY {o.invoice_fy}</span> : null}
                        </td>
                        <td>{o.table_name || 'Takeaway'}</td>
                        <td>{o.buyer_name || 'CASH SALES'}</td>
                        <td style={{ textAlign: 'right' }}>{fmtNpr(o.paid_amount)}</td>
                        <td style={{ textAlign: 'right' }}>
                          <button className="btn btn-primary" style={{ fontSize: 12, padding: '5px 12px' }} onClick={() => setPickedOrder(o)}>Credit Note</button>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}

      {tab === 'book' && (
        <>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 14, alignItems: 'flex-end', marginBottom: 20 }}>
            <div>
              <label style={{ fontSize: 11, color: 'var(--theme-text3)', display: 'block', marginBottom: 4 }} htmlFor="credit-notes-from-bs-2">From (BS)</label>
              <BsCalendarPicker id="credit-notes-from-bs-2" value={fromIso} onChange={setFromIso} />
            </div>
            <div>
              <label style={{ fontSize: 11, color: 'var(--theme-text3)', display: 'block', marginBottom: 4 }} htmlFor="credit-notes-to-bs-2">To (BS)</label>
              <BsCalendarPicker id="credit-notes-to-bs-2" value={toIso} onChange={setToIso} />
            </div>
            {/* Gated on loading and the error too (S754): the workbook is named for the pickers'
                range, so exporting mid-load or after a failed read wrote an empty or stale
                register under the new range's filename. */}
            <button className="btn btn-ghost" style={{ marginLeft: 'auto' }} onClick={exportExcel} disabled={notesLoading || !!notesError || notes.length === 0}>⬇ Excel</button>
          </div>

          <ActionError error={bookMsg} className="action-error--top" />

          {notesLoading ? (
            <p style={{ color: 'var(--theme-text3)', fontSize: 13 }}>Loading…</p>
          ) : notesError ? (
            <ReportLoadError error={notesError} />
          ) : notes.length === 0 ? (
            <div className="card" style={{ padding: 32, textAlign: 'center', color: 'var(--theme-text3)', fontSize: 13 }}>
              No Credit Notes issued in this range.
            </div>
          ) : (
            <div className="table-wrap">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>CN No</th><th>Ref Invoice No</th><th>Date</th><th>Buyer</th><th>Reason</th>
                    <th>
                      <Tip width={300} text="How money went back to the customer when the note was issued. Cash was paid out of the till and recorded as a Refund on the shift; Card / QR / bank and None took nothing off the drawer. Kept with the note, never printed on it. Notes issued before this was recorded show Not recorded.">
                        Money Back
                      </Tip>
                    </th>
                    {imsEnabled && (
                      <th>
                        <Tip width={300} text="What the note did to Inventory. Used = the food was served, so it stays counted as used. Put back = the bill was billed again on a new bill or was a duplicate, so its food went back into Inventory and is not counted twice. Notes issued before this question was asked show Used.">
                          Food
                        </Tip>
                      </th>
                    )}
                    <th style={{ textAlign: 'right' }}>Gross</th><th style={{ textAlign: 'right' }}>VAT</th><th style={{ textAlign: 'right' }}>Net</th>
                    <th>Issued By</th><th></th>
                  </tr>
                </thead>
                <tbody>
                  {notes.map(n => {
                    const cnNo = `CN${n.credit_note_no}-${billingSettings.invoice_prefix}${billingSettings.invoice_prefix ? '-' : ''}${n.invoice_fy}`
                    return (
                      <tr key={n.id}>
                        <td style={{ fontWeight: 600, color: 'var(--theme-text1)' }}>
                          <span style={{ whiteSpace: 'nowrap' }}>{cnNo}</span>
                          {/* `in n` so a bundle deployed ahead of migration 20260914140200 (no such
                              column, select('*')) marks nothing rather than every note (S747). An
                              outlet without Inventory owes it nothing, so nothing waits (S809 4e, D7), and
                              nor does a note on a bill from before its Inventory began (S831 5f-3, Q31 a). */}
                          {imsEnabled && 'ims_posted_at' in n && n.ims_posted_at == null && billCountsForIms(n.pos_orders?.closed_at, imsSince) && (
                            <Tip width={320} style={{ display: 'inline-flex', borderBottom: 'none', cursor: 'default', marginLeft: 6 }}
                              text="This note has not yet taken its bill's revenue back out of Inventory, for one of four reasons: its month had not been started in Inventory, its month was already closed, its bill was not in Inventory yet (the note waits for it), or the save failed. While its month is open, a POS manager or the Owner presses Post to Inventory on the Orders floor (it posts the bill first, then the note). A closed month only the Owner (or Crest support) can post into, from Periods → Post POS bills to Inventory.">
                              <span className="badge-amber">Not in Inventory</span>
                            </Tip>
                          )}
                        </td>
                        <td>{n.original_invoice_label}</td>
                        <td><span style={{ whiteSpace: 'nowrap' }}>{bsDayMonthYear(n.created_at)}</span></td>
                        <td>{n.buyer_name || 'CASH SALES'}</td>
                        <td>{n.reason}</td>
                        <td>
                          {/* S755: its own column, off the printed note (it used to be appended to the reason). */}
                          {REFUND_LABEL[n.refund_method]
                            ? <span className="badge-gray" style={{ whiteSpace: 'nowrap' }}>{REFUND_LABEL[n.refund_method]}</span>
                            : <span style={{ color: 'var(--theme-text3)', whiteSpace: 'nowrap' }}>Not recorded</span>}
                        </td>
                        {imsEnabled && <td><span className="badge-gray" style={{ whiteSpace: 'nowrap' }}>{stockLabel(n)}</span></td>}
                        <td style={{ textAlign: 'right' }}>{fmtNpr(n.gross_amount)}</td>
                        <td style={{ textAlign: 'right' }}>{fmtNpr(n.vat_amount)}</td>
                        <td style={{ textAlign: 'right', fontWeight: 600 }}>{fmtNpr(n.net_amount)}</td>
                        <td>{staffNames[n.issued_by] || '—'}</td>
                        <td style={{ textAlign: 'right' }}>
                          {/* S809 2e (CREDIT-NOTES-2): a note that never printed (the connection dropped
                              after it was issued, or the pop-up was blocked) prints its original here. */}
                          {(Number(n.print_count) || 0) > 0
                            ? <button className="btn btn-ghost" style={{ fontSize: 12, padding: '5px 10px' }} onClick={() => reprintNote(n)}>Reprint</button>
                            : (
                              <Tip width={260} style={{ display: 'inline-flex', borderBottom: 'none' }}
                                text="This note was issued but has never been printed — the connection dropped or the pop-up was blocked. Print gives the original; everything else about the note is already done.">
                                <button className="btn btn-primary" style={{ fontSize: 12, padding: '5px 10px' }} onClick={() => reprintNote(n)}>Print</button>
                              </Tip>
                            )}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
                <tfoot>
                  <tr style={{ fontWeight: 700 }}>
                    <td colSpan={imsEnabled ? 7 : 6}>TOTAL</td>
                    <td style={{ textAlign: 'right' }}>{fmtNpr(totals.gross)}</td>
                    <td style={{ textAlign: 'right' }}>{fmtNpr(totals.vat)}</td>
                    <td style={{ textAlign: 'right' }}>{fmtNpr(totals.net)}</td>
                    <td></td><td></td>
                  </tr>
                </tfoot>
              </table>
            </div>
          )}
        </>
      )}

      {pickedOrder && (
        <IssueCreditNoteModal
          order={pickedOrder}
          onClose={() => setPickedOrder(null)}
          onIssued={() => {
            setPickedOrder(null)
            loadCandidates()
          }}
        />
      )}
    </div>
  )
}
