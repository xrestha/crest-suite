import { BS_MONTHS } from '../../../utils/bsCalendar'
import { getCf, calcBillTotals } from './purchasesHelpers'

// A4 print-only Purchase Entry Voucher — auto-printed right after a new bill is saved (Purchases.js)
// so it can be stapled to the vendor's physical bill for record-keeping/approval. Line items print
// in purchase units exactly as entered (the pre-conversion `lines` PurchaseBillForm hands back via
// onSaved), matching what's written on the vendor's bill rather than the base-unit values
// purchase_entries stores — see CLAUDE.md's "Purchases: qty/rate storage convention".
export default function PurchaseBillPrint({ header, lines, items, vendorName, period, bizInfo, enteredBy }) {
  const totals = calcBillTotals(lines, header.discount)
  const bsDateStr = period && header.bs_day ? `${header.bs_day} ${BS_MONTHS[period.bs_month - 1]} ${period.bs_year}` : ''
  const fmt = n => n.toLocaleString('en-NP', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

  return (
    <div style={{ fontFamily: 'Georgia, serif', color: '#000', padding: '20px 24px', maxWidth: 720, margin: '0 auto' }}>
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', borderBottom: '2px solid #000', paddingBottom: 10, marginBottom: 14 }}>
        <div>
          <div style={{ fontSize: 16, fontWeight: 700, color: '#000' }}>{bizInfo?.name || 'Crest Suite'}</div>
          {bizInfo?.address && <div style={{ fontSize: 11, color: '#555', marginTop: 2 }}>{bizInfo.address}</div>}
          {bizInfo?.vatNumber && <div style={{ fontSize: 11, color: '#555', marginTop: 2 }}>PAN/VAT No: {bizInfo.vatNumber}</div>}
        </div>
        <div style={{ textAlign: 'right' }}>
          <div style={{ fontSize: 9, color: '#777', textTransform: 'uppercase', letterSpacing: '0.1em' }}>Purchase Entry Voucher</div>
          <div style={{ fontSize: 11, color: '#555', marginTop: 4 }}>{bsDateStr} (BS)</div>
        </div>
      </div>

      {/* Bill meta */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6, fontSize: 12, marginBottom: 16 }}>
        <div><span style={{ color: '#777' }}>Vendor: </span><span style={{ fontWeight: 700 }}>{vendorName || '— None —'}</span></div>
        <div><span style={{ color: '#777' }}>Payment: </span><span style={{ fontWeight: 700 }}>{header.payment_method}</span></div>
        <div><span style={{ color: '#777' }}>Invoice Ref: </span><span style={{ fontWeight: 700 }}>{header.invoice_ref || '—'}</span></div>
        <div><span style={{ color: '#777' }}>Entered By: </span><span style={{ fontWeight: 700 }}>{enteredBy || '—'}</span></div>
      </div>

      {/* Line items */}
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11 }}>
        <thead>
          <tr style={{ borderBottom: '1px solid #000' }}>
            {['Item', 'Qty', 'Unit', 'Rate (NPR)', 'VAT', 'Amount (NPR)'].map((h, i) => (
              <th key={h} style={{ textAlign: i === 0 || i === 2 ? 'left' : 'right', padding: '4px 6px', fontWeight: 700, fontSize: 10, color: '#555', textTransform: 'uppercase', letterSpacing: '0.06em' }}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {lines.map((l, idx) => {
            const item = items.find(i => i.id === l.item_id)
            const cf = getCf(item)
            const unit = cf > 1 ? item?.purchase_unit : (item?.uom || '')
            const qty = parseFloat(l.qty) || 0
            const rate = parseFloat(l.rate) || 0
            const amount = l.vat_inclusive ? qty * rate * 1.13 : qty * rate
            return (
              <tr key={idx} style={{ borderBottom: '1px solid #ddd' }}>
                <td style={{ padding: '5px 6px 5px 0' }}>{item?.name || '—'}</td>
                <td style={{ padding: '5px 6px', textAlign: 'right' }}>{qty}</td>
                <td style={{ padding: '5px 6px' }}>{unit}</td>
                <td style={{ padding: '5px 6px', textAlign: 'right' }}>{rate.toFixed(2)}</td>
                <td style={{ padding: '5px 6px', textAlign: 'right' }}>{l.vat_inclusive ? '13%' : '—'}</td>
                <td style={{ padding: '5px 0 5px 6px', textAlign: 'right', fontWeight: 600 }}>{fmt(amount)}</td>
              </tr>
            )
          })}
        </tbody>
      </table>

      {/* Totals */}
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 12 }}>
        <div style={{ minWidth: 260, fontSize: 12 }}>
          {totals.taxableBase > 0 && (
            <div style={{ display: 'flex', justifyContent: 'space-between', padding: '3px 0' }}>
              <span style={{ color: '#777' }}>Taxable (ex-VAT)</span><span>{fmt(totals.taxableBase)}</span>
            </div>
          )}
          {totals.nonTaxableBase > 0 && (
            <div style={{ display: 'flex', justifyContent: 'space-between', padding: '3px 0' }}>
              <span style={{ color: '#777' }}>Non-taxable</span><span>{fmt(totals.nonTaxableBase)}</span>
            </div>
          )}
          {totals.discount > 0 && (
            <div style={{ display: 'flex', justifyContent: 'space-between', padding: '3px 0' }}>
              <span style={{ color: '#777' }}>Discount</span><span>− {fmt(totals.discount)}</span>
            </div>
          )}
          {totals.vatTotal > 0 && (
            <div style={{ display: 'flex', justifyContent: 'space-between', padding: '3px 0' }}>
              <span style={{ color: '#777' }}>VAT (13%)</span><span>{fmt(totals.vatTotal)}</span>
            </div>
          )}
          <div style={{ display: 'flex', justifyContent: 'space-between', padding: '6px 0', borderTop: '1px solid #000', marginTop: 4, fontWeight: 700, fontSize: 14 }}>
            <span>Grand Total</span><span>NPR {fmt(totals.grandTotal)}</span>
          </div>
        </div>
      </div>

      {/* Approval signature strip */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 24, marginTop: 64, fontSize: 11 }}>
        {['Prepared By', 'Checked By', 'Approved By'].map(label => (
          <div key={label} style={{ textAlign: 'center' }}>
            <div style={{ borderTop: '1px solid #000', paddingTop: 4, color: '#555' }}>{label}</div>
          </div>
        ))}
      </div>
    </div>
  )
}
