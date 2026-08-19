import { useState, useEffect } from 'react'
import { useAuth } from '../../../context/AuthContext'
import { supabase } from '../../../supabaseClient'
import { useScopedDb } from '../../../shared/hooks/useScopedDb'
import { getBsToday, getBsFiscalYear, adToBs, BS_MONTHS } from '../../../utils/bsCalendar'
import { computeOrderAmounts } from '../../../utils/posBillingMath'
import { printCreditNote } from './creditNoteHtml'

// A credit note here always credits the WHOLE bill (decision 2026-08-18 — partial credits are not
// supported). 'Price correction' and 'Billing error' were removed from these chips because both
// describe a partial adjustment: offering them invited staff to reach for a credit note to fix one
// wrong line and silently credit the entire invoice instead. The remaining three are all
// whole-bill situations by nature.
const REASON_CHIPS = ['Wrong customer', 'Tax correction', 'Duplicate bill']

const fmtNpr = n => `NPR ${Math.round(n).toLocaleString()}`

function invoiceLabel(order, vatReg, prefix) {
  return `${vatReg ? 'TI' : 'PB'}${order.invoice_no}-${prefix}${prefix ? '-' : ''}${order.invoice_fy || ''}`
}

// Shared by two entry points — the Recent Bills "Credit Note" quick action (same-day) and the
// standalone /pos/credit-notes "Issue New" search (any date). Self-contained: fetches its own
// settings/outlet/HSC data rather than depending on the caller's cached state, so it works
// identically from either page.
export default function IssueCreditNoteModal({ order, onClose, onIssued }) {
  const { clientId, profile, hasPosAccess } = useAuth()
  const { scopedFrom, scopedInsert, scopedUpdate } = useScopedDb()

  // Escape-to-close — matches the existing backdrop-click behavior below (no in-progress guard,
  // since neither render path below guards its own backdrop-click on `submitting` either).
  useEffect(() => {
    function onKeyDown(e) { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [onClose])

  const [items, setItems] = useState([])
  const [settings, setSettings] = useState({ is_vat_registered: true, invoice_prefix: '', vat_number: '', property_address: '', property_phone: '' })
  const [outletName, setOutletName] = useState('')
  const [hscMap, setHscMap] = useState({})
  const [loading, setLoading] = useState(true)

  const [reason, setReason] = useState('')
  const [buyerName, setBuyerName] = useState(order.buyer_name || '')
  const [buyerAddress, setBuyerAddress] = useState(order.buyer_address || '')
  const [buyerPan, setBuyerPan] = useState(order.buyer_pan || '')
  const [buyerPhone, setBuyerPhone] = useState(order.buyer_phone || '')
  const [submitting, setSubmitting] = useState(false)
  const [msg, setMsg] = useState('')

  useEffect(() => {
    if (!clientId) return
    Promise.all([
      scopedFrom('pos_order_items', 'recipe_id, name, qty, unit_price, vat_rate, comped').eq('order_id', order.id),
      supabase.from('settings').select('is_vat_registered, invoice_prefix, vat_number, property_address, property_phone').eq('client_id', clientId).maybeSingle(),
      supabase.from('clients').select('name').eq('id', clientId).single(),
    ]).then(([{ data: its }, { data: st }, { data: cl }]) => {
      setItems(its || [])
      setSettings({
        is_vat_registered: st?.is_vat_registered ?? true,
        invoice_prefix: st?.invoice_prefix || '',
        vat_number: st?.vat_number || '',
        property_address: st?.property_address || '',
        property_phone: st?.property_phone || '',
      })
      setOutletName(cl?.name || '')
      const recipeIds = [...new Set((its || []).map(i => i.recipe_id).filter(Boolean))]
      if (recipeIds.length > 0) {
        scopedFrom('recipes', 'id, hsc_code').in('id', recipeIds).then(({ data }) => {
          setHscMap(Object.fromEntries((data || []).map(r => [r.id, r.hsc_code])))
        })
      }
      setLoading(false)
    })
  }, [clientId, order.id, scopedFrom])

  if (!hasPosAccess('manager')) {
    return (
      <div style={overlayStyle} onClick={e => { if (e.target === e.currentTarget) onClose() }}>
        <div style={cardStyle}>
          <p style={{ color: 'var(--theme-text2)', fontSize: 13 }}>Issuing a Credit Note requires Manager access or above.</p>
          <button className="btn btn-ghost" onClick={onClose}>Close</button>
        </div>
      </div>
    )
  }

  const vatReg = settings.is_vat_registered
  // Item-level comps were never billed at menu price (they printed on their own Complimentary
  // Slip — see PosOrders.jsx), so a Credit Note correcting this bill's revenue must exclude them
  // too, or its face value overstates what the party actually paid. The sales_entries reversal
  // below now uses this same payableItems list — a comped item was posted as source='pos_comp',
  // never 'pos', so reversing it too under 'pos_credit' would create a negative entry with no
  // matching positive one to offset, wrongly understating that recipe's revenue.
  const payableItems = items.filter(i => !i.comped)
  const amounts = !loading ? computeOrderAmounts(order, payableItems, vatReg) : null

  async function handleConfirm() {
    if (!reason.trim()) { setMsg('error:Enter a reason for this Credit Note.'); return }
    setSubmitting(true); setMsg('')

    const bs = adToBs(new Date(order.closed_at))
    const original_invoice_date_bs = `${bs.day} ${BS_MONTHS[bs.month - 1]} ${bs.year}`
    const original_invoice_label = invoiceLabel(order, vatReg, settings.invoice_prefix)
    // The CN's own invoice_fy (which drives its sequential credit_note_no via
    // assign_pos_credit_note_no) is the fiscal year it's actually issued in — matching the
    // revenue-reversal logic below ("the period the correction is discovered in"), not the
    // original bill's period. A CN issued after a fiscal-year rollover would otherwise number
    // itself into that old, already-closed FY's sequence. The original bill stays fully
    // traceable regardless via original_invoice_no/original_invoice_label/original_invoice_date_bs.
    const today = getBsToday()
    const issuance_fy = getBsFiscalYear(today.year, today.month)

    const payload = {
      order_id: order.id,
      invoice_fy: issuance_fy,
      original_invoice_no: order.invoice_no,
      original_invoice_label,
      original_invoice_date_bs,
      reason: reason.trim(),
      gross_amount: amounts.grossAmt,
      discount_amount: amounts.discount,
      taxable_amount: amounts.taxableBase,
      non_taxable_amount: amounts.nonTaxableBase,
      vat_amount: amounts.vatAmt,
      net_amount: amounts.net,
      buyer_name: buyerName.trim() || null,
      buyer_address: buyerAddress.trim() || null,
      buyer_pan: buyerPan.trim() || null,
      buyer_phone: buyerPhone.trim() || null,
      issued_by: profile?.id || null,
    }

    const { data: created, error } = await scopedInsert('pos_credit_notes', payload, { single: true })
    if (error) { setMsg('error:' + error.message); setSubmitting(false); return }

    // This link is what stops the same bill being credited twice — CreditNotes.jsx offers only
    // orders with `credit_note_id IS NULL`. Its error used to go unchecked, so a failed write left
    // a real credit note issued against a bill the list still presented as un-credited.
    const { error: linkErr } = await scopedUpdate('pos_orders', { credit_note_id: created.id }).eq('id', order.id)
    if (linkErr) {
      setMsg(`error:Credit note ${created.credit_note_no ?? ''} was created, but linking it to the bill failed (${linkErr.message}). Do NOT issue another one for this bill — contact support to link it, or the same bill can be credited twice.`)
      setSubmitting(false)
      return
    }

    // Best-effort revenue correction — mirrors writeSalesEntries' own bail/error-swallow pattern in
    // PosOrders.jsx: post negative sales_entries into TODAY's open period (the period the
    // correction is discovered in), not the original bill's period. Stock/ingredient depletion is
    // deliberately NOT reversed — the food was already served; this corrects billing/tax, not stock.
    try {
      const { data: periods } = await scopedFrom('monthly_periods')
        .order('bs_year', { ascending: false }).order('bs_month', { ascending: false })
      const open = (periods || []).find(p => p.status === 'open')
      if (open && today.year === open.bs_year && today.month === open.bs_month) {
        const rows = payableItems.filter(i => i.recipe_id).map(i => ({
          period_id: open.id, recipe_id: i.recipe_id, bs_day: today.day, qty_sold: -i.qty, source: 'pos_credit',
          unit_price: i.unit_price, vat_rate: i.vat_rate,
        }))
        if (rows.length > 0) await supabase.from('sales_entries').insert(rows)
      }
    } catch (err) {
      console.error('credit note sales_entries reversal failed:', err)
    }

    await printCreditNote(clientId, created, payableItems, settings, outletName, hscMap)

    setSubmitting(false)
    onIssued?.(created)
  }

  return (
    <div style={overlayStyle} onClick={e => { if (e.target === e.currentTarget) onClose() }}>
      <div style={{ ...cardStyle, width: 'min(520px, 96vw)' }}>
        <h3 style={{ margin: '0 0 4px', fontSize: 16, color: 'var(--theme-text1)' }}>Issue Credit Note</h3>
        <p style={{ margin: '0 0 14px', fontSize: 12, color: 'var(--theme-text3)' }}>
          Corrects {order.invoice_no != null ? invoiceLabel(order, vatReg, settings.invoice_prefix) : `Order #${order.order_no}`}. This is a formal VAT-Rules Credit Note — it reduces revenue for this fiscal month but does not touch stock.
        </p>

        {loading ? <p style={{ color: 'var(--theme-text3)', fontSize: 13 }}>Loading bill…</p> : (
          <>
            <div className="table-wrap" style={{ maxHeight: 160, overflowY: 'auto', border: '1px solid var(--theme-border)', borderRadius: 8, marginBottom: 12 }}>
              <table className="data-table" style={{ fontSize: 12 }}>
                <thead><tr><th>Item</th><th>Qty</th><th>Amount</th></tr></thead>
                <tbody>
                  {payableItems.map((i, idx) => (
                    <tr key={idx}><td>{i.name}</td><td>{i.qty}</td><td>{fmtNpr(i.qty * i.unit_price)}</td></tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--theme-accent)', marginBottom: 14 }}>
              Net amount to credit: {fmtNpr(amounts.net)}
            </div>

            <label style={labelStyle} htmlFor="icn-reason">Reason <span style={{ color: 'var(--theme-red)' }}>*</span></label>
            <div role="group" aria-label="Common reasons" style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 6 }}>
              {REASON_CHIPS.map(r => (
                <button key={r} type="button" className="tab-btn" onClick={() => setReason(r)}
                  style={{ fontSize: 11, padding: '4px 10px' }}>{r}</button>
              ))}
            </div>
            <textarea id="icn-reason" value={reason} onChange={e => setReason(e.target.value)} rows={2}
              placeholder="e.g. Billing error — wrong item charged"
              style={{ ...inputStyle, width: '100%', resize: 'vertical', marginBottom: 12 }} />

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 12 }}>
              <div><label style={labelStyle} htmlFor="issue-credit-note-modal-buyer-name">Buyer Name</label><input id="issue-credit-note-modal-buyer-name" style={inputStyle} value={buyerName} onChange={e => setBuyerName(e.target.value)} /></div>
              <div><label style={labelStyle} htmlFor="issue-credit-note-modal-buyer-pan">Buyer PAN</label><input id="issue-credit-note-modal-buyer-pan" style={inputStyle} value={buyerPan} onChange={e => setBuyerPan(e.target.value)} /></div>
              <div><label style={labelStyle} htmlFor="issue-credit-note-modal-address">Address</label><input id="issue-credit-note-modal-address" style={inputStyle} value={buyerAddress} onChange={e => setBuyerAddress(e.target.value)} /></div>
              <div><label style={labelStyle} htmlFor="issue-credit-note-modal-phone">Phone</label><input id="issue-credit-note-modal-phone" style={inputStyle} value={buyerPhone} onChange={e => setBuyerPhone(e.target.value)} /></div>
            </div>

            {msg && <p role="alert" style={{ color: msg.startsWith('error:') ? 'var(--theme-red)' : 'var(--theme-green)', fontSize: 12, marginBottom: 8 }}>{msg.replace('error:', '')}</p>}

            {/* The irreversibility warning was previously only inside a Tip on the button — and
                this page runs on a tablet, where hover does not exist, so it was invisible at the
                one moment it mattered. It is body copy now. */}
            <p style={{ fontSize: 12, color: 'var(--theme-amber-text)', margin: '0 0 10px', lineHeight: 1.6 }}>
              This credits the <strong>whole bill</strong> and cannot be undone. A sequentially-numbered
              Credit Note is issued and printed, and this month's revenue is reduced by the credited amount.
            </p>

            <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
              <button className="btn btn-ghost" onClick={onClose} disabled={submitting}>Cancel</button>
              <button className="btn btn-primary" onClick={handleConfirm} disabled={submitting}>
                {submitting ? 'Issuing…' : 'Issue & Print'}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}

const overlayStyle = { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 400 }
const cardStyle = { background: 'var(--theme-card)', border: '1px solid var(--theme-border)', borderRadius: 14, maxHeight: '86vh', overflowY: 'auto', padding: '24px 28px', boxShadow: '0 16px 48px rgba(0,0,0,0.4)' }
const labelStyle = { display: 'block', fontSize: 11, color: 'var(--theme-text3)', marginBottom: 4 }
const inputStyle = { background: 'var(--theme-input-bg)', border: '1px solid var(--theme-border)', borderRadius: 6, padding: '7px 10px', fontSize: 13, color: 'var(--theme-text1)', outline: 'none', width: '100%' }
