import { BS_MONTHS, adToBs } from '../../../utils/bsCalendar'
import { numberToWordsNpr } from '../../../utils/numberToWords'

// Vendor Balance Confirmation letter + supporting schedule — external audit evidence per NSA 17
// (Nepal Standard on Auditing 17, adapting ISA 505 External Confirmations) and feeding Nepal IRD
// VAT/income-tax Annexure 13 (अनुसूची १३) disclosure, which requires Opening/Purchases/Payments/
// Closing balance + counterparty PAN whenever any figure exceeds NPR 1,00,000 in a fiscal year.
// Same Georgia-serif print voucher family as PurchaseBillPrint.jsx, extended with a letter/
// salutation section and a running-balance schedule instead of a single itemized bill.
function fmtBs(date) {
  const { year, month, day } = adToBs(date)
  return `${day} ${BS_MONTHS[month - 1]} ${year}`
}

const fmt = n => (Math.round(n * 100) / 100).toLocaleString('en-NP', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

const EVENT_LABEL = { opening: 'Opening Balance', bill: 'Purchase', payment: 'Payment', return: 'Return' }

export default function VendorBalanceConfirmationPrint({ bizInfo, vendor, fyLabel, fyStart, fyEnd, openingBalance, schedule, totals, closingBalance }) {
  const isAdvance = closingBalance < -0.01
  const balanceLabel = isAdvance ? 'Advance / Credit Balance' : 'Balance Payable'
  const todayStr = fmtBs(new Date())

  return (
    // White "paper" background — this renders as a persistent on-screen preview (not just at
    // print time), and the letter's black text below vanishes against the app's dark theme
    // without an explicit light backdrop behind it. The shadow/rounded-corner "card" look is
    // for that on-screen preview only — Layout.css strips it under @media print, same as every
    // other .card on paper (S498).
    <div className="vbc-paper" style={{ background: '#fff', borderRadius: 8, boxShadow: '0 1px 4px rgba(0,0,0,0.3)' }}>
    <div style={{ fontFamily: 'Georgia, serif', color: '#000', padding: '20px 24px', maxWidth: 760, margin: '0 auto' }}>
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', borderBottom: '2px solid #000', paddingBottom: 10, marginBottom: 14 }}>
        <div>
          <div style={{ fontSize: 16, fontWeight: 700, color: '#000' }}>{bizInfo?.name || 'Crest Suite'}</div>
          {bizInfo?.address && <div style={{ fontSize: 11, color: '#000', marginTop: 2 }}>{bizInfo.address}</div>}
          {bizInfo?.pan && <div style={{ fontSize: 11, color: '#000', marginTop: 2 }}>{bizInfo.panLabel || 'PAN No'}: {bizInfo.pan}</div>}
        </div>
        <div style={{ textAlign: 'right' }}>
          <div style={{ fontSize: 9, color: '#000', textTransform: 'uppercase', letterSpacing: '0.1em' }}>Vendor Balance Confirmation</div>
          <div style={{ fontSize: 11, color: '#000', marginTop: 4 }}>FY {fyLabel} · Date: {todayStr} (BS)</div>
        </div>
      </div>

      {/* Letter / salutation */}
      <div style={{ fontSize: 12.5, lineHeight: 1.6, marginBottom: 18 }}>
        <div style={{ marginBottom: 10 }}>
          <strong>To,</strong><br />
          {vendor?.name}<br />
          {vendor?.address && <>{vendor.address}<br /></>}
          {vendor?.pan_vat_no && <>PAN/VAT No: {vendor.pan_vat_no}<br /></>}
        </div>
        <p style={{ margin: '0 0 10px' }}>Dear Sir/Madam,</p>
        <p style={{ margin: '0 0 10px' }}>
          As per our books of accounts, your {isAdvance ? 'advance / credit balance' : 'balance payable'} as of{' '}
          <strong>{fmtBs(fyEnd)} (BS)</strong> is <strong>NPR {fmt(Math.abs(closingBalance))}</strong> ({numberToWordsNpr(Math.abs(closingBalance))} only).
        </p>
        <p style={{ margin: '0 0 10px' }}>
          Opening Balance NPR {fmt(openingBalance)} + Purchases NPR {fmt(totals.totalPurchasesFy)} − Payments/Returns NPR {fmt(totals.totalPaymentsFy + totals.totalReturnsFy)} = {balanceLabel} NPR {fmt(Math.abs(closingBalance))}.
        </p>
        <p style={{ margin: 0 }}>
          Kindly confirm the above balance by signing and returning a copy of this letter within 7 days. Please inform us in writing of any discrepancy.
        </p>
      </div>

      {/* Headline figures */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 10, marginBottom: 18, fontSize: 12 }}>
        {[
          ['Opening Balance', openingBalance],
          ['Purchases (FY)', totals.totalPurchasesFy],
          ['Payments + Returns (FY)', totals.totalPaymentsFy + totals.totalReturnsFy],
          [balanceLabel, Math.abs(closingBalance)],
        ].map(([label, val]) => (
          <div key={label} style={{ border: '1px solid #ccc', borderRadius: 4, padding: '8px 10px' }}>
            <div style={{ fontSize: 9, color: '#000', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 4 }}>{label}</div>
            <div style={{ fontWeight: 700, fontSize: 13 }}>{fmt(val)}</div>
          </div>
        ))}
      </div>

      {/* Schedule / annexure */}
      <div style={{ fontSize: 10, color: '#000', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 6 }}>
        Supporting Schedule — FY {fyLabel}
      </div>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11 }}>
        <thead>
          <tr style={{ borderBottom: '1px solid #000' }}>
            {['Date', 'Particulars', 'Ref', 'Method', 'Amount (NPR)', 'Balance (NPR)'].map((h, i) => (
              <th key={h} style={{ textAlign: i >= 4 ? 'right' : 'left', padding: '4px 6px', fontWeight: 700, fontSize: 10, color: '#000', textTransform: 'uppercase', letterSpacing: '0.06em' }}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {schedule.map((e, idx) => {
            const signedAmount = e.type === 'opening' ? null
              : e.type === 'bill' && e.method === 'Credit' ? e.amount
              : e.type === 'bill' ? 0
              : -e.amount
            return (
              <tr key={idx} style={{ borderBottom: '1px solid #ddd' }}>
                <td style={{ padding: '5px 6px 5px 0' }}>{fmtBs(e.date)}</td>
                <td style={{ padding: '5px 6px' }}>
                  {EVENT_LABEL[e.type]}{e.type === 'bill' && e.method !== 'Credit' ? ` (${e.method})` : ''}
                </td>
                <td style={{ padding: '5px 6px' }}>{e.ref || '—'}</td>
                <td style={{ padding: '5px 6px' }}>{e.type === 'bill' ? e.method : '—'}</td>
                <td style={{ padding: '5px 6px', textAlign: 'right' }}>
                  {signedAmount === null ? '—' : `${signedAmount < 0 ? '− ' : ''}${fmt(Math.abs(signedAmount))}`}
                </td>
                <td style={{ padding: '5px 0 5px 6px', textAlign: 'right', fontWeight: 600 }}>{fmt(e.runningBalance)}</td>
              </tr>
            )
          })}
        </tbody>
        <tfoot>
          <tr>
            <td colSpan={5} style={{ padding: '8px 6px 0', textAlign: 'right', fontWeight: 700 }}>Closing Balance</td>
            <td style={{ padding: '8px 0 0 6px', textAlign: 'right', fontWeight: 700, borderTop: '1px solid #000' }}>NPR {fmt(closingBalance)}</td>
          </tr>
        </tfoot>
      </table>

      {/* Signature strip — 2-party confirmation, not the 3-role internal-approval strip. Extra
          marginTop (vs. PurchaseBillPrint.jsx's 64) leaves room for a physical company stamp
          above each line, not just a pen signature. */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 40, marginTop: 110, fontSize: 11 }}>
        {[`For ${bizInfo?.name || 'us'}`, `For ${vendor?.name || 'vendor'} (Signature & Stamp)`].map(label => (
          <div key={label} style={{ textAlign: 'center' }}>
            <div style={{ borderTop: '1px solid #000', paddingTop: 4, color: '#000' }}>{label}</div>
          </div>
        ))}
      </div>
    </div>
    </div>
  )
}
