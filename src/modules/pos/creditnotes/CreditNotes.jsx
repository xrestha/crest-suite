import { useState, useEffect, useCallback } from 'react'
import { Navigate } from 'react-router-dom'
import * as XLSX from 'xlsx'
import { useAuth } from '../../../context/AuthContext'
import { supabase } from '../../../supabaseClient'
import { useScopedDb } from '../../../shared/hooks/useScopedDb'
import Tip from '../../../components/Tip'
import BsCalendarPicker from '../../../components/BsCalendarPicker'
import { adToBs, formatAd, BS_MONTHS } from '../../../utils/bsCalendar'
import { printCreditNote } from './creditNoteHtml'
import IssueCreditNoteModal from './IssueCreditNoteModal'

const fmtNpr = n => `NPR ${Math.round(n).toLocaleString()}`

export default function CreditNotes() {
  const { clientId, hasPosAccess } = useAuth()
  const { scopedFrom } = useScopedDb()

  const [tab, setTab] = useState('issue') // 'issue' | 'book'
  const [fromIso, setFromIso] = useState(formatAd(new Date()))
  const [toIso,   setToIso]   = useState(formatAd(new Date()))
  const [invoiceSearch, setInvoiceSearch] = useState('')

  const [candidates, setCandidates] = useState([])
  const [candLoading, setCandLoading] = useState(false)
  const [pickedOrder, setPickedOrder] = useState(null)

  const [notes, setNotes] = useState([])
  const [notesLoading, setNotesLoading] = useState(false)
  const [staffNames, setStaffNames] = useState({})
  const [billingSettings, setBillingSettings] = useState({ is_vat_registered: true, invoice_prefix: '', vat_number: '', property_address: '', property_phone: '' })
  const [outletName, setOutletName] = useState('')

  const loadCandidates = useCallback(async () => {
    if (!clientId) return
    setCandLoading(true)
    const fromTs = new Date(fromIso + 'T00:00:00').toISOString()
    const toTs   = new Date(toIso + 'T23:59:59.999').toISOString()
    const { data } = await scopedFrom('pos_orders', 'id, table_name, order_no, invoice_no, invoice_fy, close_type, paid_amount, closed_at, buyer_name, buyer_address, buyer_pan, buyer_phone, discount_amount, credit_note_id')
      .eq('status', 'billed').eq('close_type', 'paid')
      .is('credit_note_id', null)
      .gte('closed_at', fromTs).lte('closed_at', toTs)
      .order('closed_at', { ascending: false })
    let list = data || []
    const n = parseInt(invoiceSearch.trim(), 10)
    if (invoiceSearch.trim() && !isNaN(n)) list = list.filter(o => o.invoice_no === n)
    setCandidates(list)
    setCandLoading(false)
  }, [clientId, fromIso, toIso, invoiceSearch, scopedFrom])

  const loadNotes = useCallback(async () => {
    if (!clientId) return
    setNotesLoading(true)
    const fromTs = new Date(fromIso + 'T00:00:00').toISOString()
    const toTs   = new Date(toIso + 'T23:59:59.999').toISOString()
    const [{ data: cn }, { data: profs }, { data: settings }, { data: cl }] = await Promise.all([
      scopedFrom('pos_credit_notes')
        .gte('created_at', fromTs).lte('created_at', toTs).order('created_at', { ascending: false }),
      // Raw `profiles` reads are RLS-limited to the caller's own row (id = auth.uid() OR admin) —
      // resolving OTHER staff members' names needs get_client_profile_names(), a SECURITY
      // DEFINER RPC. A raw query here silently showed "—" for every staff member except
      // whoever was logged in.
      supabase.rpc('get_client_profile_names', { p_client_id: clientId }),
      supabase.from('settings').select('is_vat_registered, invoice_prefix, vat_number, property_address, property_phone').eq('client_id', clientId).maybeSingle(),
      supabase.from('clients').select('name').eq('id', clientId).single(),
    ])
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
  }, [clientId, fromIso, toIso, scopedFrom])

  useEffect(() => { if (tab === 'issue') loadCandidates() }, [tab, loadCandidates])
  useEffect(() => { if (tab === 'book') loadNotes() }, [tab, loadNotes])

  if (!hasPosAccess('manager')) return <Navigate to="/pos" replace />

  async function reprintNote(note) {
    const { data: items } = await scopedFrom('pos_order_items', 'recipe_id, name, qty, unit_price, vat_rate, comped').eq('order_id', note.order_id)
    // Same exclusion as the original issuance (IssueCreditNoteModal.jsx) — item-level comps were
    // never billed, so they were never on this Credit Note in the first place.
    const payableItems = (items || []).filter(i => !i.comped)
    const recipeIds = [...new Set(payableItems.map(i => i.recipe_id).filter(Boolean))]
    let hscMap = {}
    if (recipeIds.length > 0) {
      const { data } = await scopedFrom('recipes', 'id, hsc_code').in('id', recipeIds)
      hscMap = Object.fromEntries((data || []).map(r => [r.id, r.hsc_code]))
    }
    await printCreditNote(clientId, note, payableItems, billingSettings, outletName, hscMap)
    setNotes(prev => prev.map(n => n.id === note.id ? { ...n, print_count: (n.print_count || 0) + 1 } : n))
  }

  function exportExcel() {
    const ws = XLSX.utils.json_to_sheet(notes.map(n => {
      const bs = adToBs(new Date(n.created_at))
      return {
        'CN No': `CN${n.credit_note_no}-${billingSettings.invoice_prefix}${billingSettings.invoice_prefix ? '-' : ''}${n.invoice_fy}`,
        'Ref Invoice No': n.original_invoice_label,
        'Date (BS)': `${bs.day} ${BS_MONTHS[bs.month - 1]} ${bs.year}`,
        'Buyer': n.buyer_name || 'CASH SALES',
        'Reason': n.reason,
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
    <div style={{ padding: '24px 28px', maxWidth: 1100 }}>
      <div style={{ marginBottom: 16 }}>
        <h2 style={{ margin: 0, color: 'var(--theme-text1)', fontSize: 20 }}>
          Credit Notes <Tip text="Formal Credit Notes for correcting an already-billed order — required by Nepal VAT Rules 2053, Rule 20, whenever the value of billed goods/services changes.">ⓘ</Tip>
        </h2>
        <p style={{ margin: '4px 0 0', fontSize: 13, color: 'var(--theme-text3)' }}>
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
              <label style={{ fontSize: 11, color: 'var(--theme-text3)', display: 'block', marginBottom: 4 }}>From (BS)</label>
              <BsCalendarPicker value={fromIso} onChange={setFromIso} />
            </div>
            <div>
              <label style={{ fontSize: 11, color: 'var(--theme-text3)', display: 'block', marginBottom: 4 }}>To (BS)</label>
              <BsCalendarPicker value={toIso} onChange={setToIso} />
            </div>
            <div>
              <label style={{ fontSize: 11, color: 'var(--theme-text3)', display: 'block', marginBottom: 4 }}>Invoice No.</label>
              <input className="form-select" style={{ width: 140 }} placeholder="e.g. 2238" value={invoiceSearch}
                onChange={e => setInvoiceSearch(e.target.value)} />
            </div>
          </div>

          {candLoading ? (
            <p style={{ color: 'var(--theme-text3)', fontSize: 13 }}>Loading…</p>
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
                    const bs = adToBs(new Date(o.closed_at))
                    return (
                      <tr key={o.id}>
                        <td>{bs.day} {BS_MONTHS[bs.month - 1]}</td>
                        <td style={{ fontWeight: 600, color: 'var(--theme-text1)' }}>{o.invoice_no}</td>
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
              <label style={{ fontSize: 11, color: 'var(--theme-text3)', display: 'block', marginBottom: 4 }}>From (BS)</label>
              <BsCalendarPicker value={fromIso} onChange={setFromIso} />
            </div>
            <div>
              <label style={{ fontSize: 11, color: 'var(--theme-text3)', display: 'block', marginBottom: 4 }}>To (BS)</label>
              <BsCalendarPicker value={toIso} onChange={setToIso} />
            </div>
            <button className="btn btn-ghost" style={{ marginLeft: 'auto' }} onClick={exportExcel} disabled={notes.length === 0}>⬇ Excel</button>
          </div>

          {notesLoading ? (
            <p style={{ color: 'var(--theme-text3)', fontSize: 13 }}>Loading…</p>
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
                    <th style={{ textAlign: 'right' }}>Gross</th><th style={{ textAlign: 'right' }}>VAT</th><th style={{ textAlign: 'right' }}>Net</th>
                    <th>Issued By</th><th></th>
                  </tr>
                </thead>
                <tbody>
                  {notes.map(n => {
                    const bs = adToBs(new Date(n.created_at))
                    const cnNo = `CN${n.credit_note_no}-${billingSettings.invoice_prefix}${billingSettings.invoice_prefix ? '-' : ''}${n.invoice_fy}`
                    return (
                      <tr key={n.id}>
                        <td style={{ fontWeight: 600, color: 'var(--theme-text1)' }}>{cnNo}</td>
                        <td>{n.original_invoice_label}</td>
                        <td>{bs.day} {BS_MONTHS[bs.month - 1]}</td>
                        <td>{n.buyer_name || 'CASH SALES'}</td>
                        <td>{n.reason}</td>
                        <td style={{ textAlign: 'right' }}>{fmtNpr(n.gross_amount)}</td>
                        <td style={{ textAlign: 'right' }}>{fmtNpr(n.vat_amount)}</td>
                        <td style={{ textAlign: 'right', fontWeight: 600 }}>{fmtNpr(n.net_amount)}</td>
                        <td>{staffNames[n.issued_by] || '—'}</td>
                        <td style={{ textAlign: 'right' }}>
                          <button className="btn btn-ghost" style={{ fontSize: 12, padding: '5px 10px' }} onClick={() => reprintNote(n)}>Reprint</button>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
                <tfoot>
                  <tr style={{ fontWeight: 700 }}>
                    <td colSpan={5}>TOTAL</td>
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
