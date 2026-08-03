import { BS_MONTHS, adToBs } from '../../../utils/bsCalendar'
import { numberToWordsNpr } from '../../../utils/numberToWords'

// Vendor Balance Confirmation letter + supporting schedule — external audit evidence per NSA 17
// (Nepal Standard on Auditing 17, adapting ISA 505 External Confirmations) and feeding Nepal IRD
// VAT/income-tax Annexure 13 (अनुसूची १३) disclosure, which requires Opening/Purchases/Payments/
// Closing balance + counterparty PAN whenever any figure exceeds NPR 1,00,000 in a fiscal year.
// Uses the app's own body font (Poppins, per DESIGN.md) rather than PurchaseBillPrint.jsx's
// Georgia-serif voucher look — a signed confirmation letter reads better in the same face as the
// rest of the app than as a deliberately old-fashioned printed document. Extended with a letter/
// salutation section and a running-balance schedule instead of a single itemized bill.
function fmtBs(date) {
  const { year, month, day } = adToBs(date)
  return `${day} ${BS_MONTHS[month - 1]} ${year}`
}

const fmt = n => (Math.round(n * 100) / 100).toLocaleString('en-NP', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
// Same "− " (en dash + space) convention used everywhere a negative can appear in this letter —
// a bare locale minus sign reads inconsistently next to the styled amounts around it.
const fmtSigned = n => `${n < -0.005 ? '− ' : ''}${fmt(Math.abs(n))}`

const EVENT_LABEL = { opening: 'Opening Balance', bill: 'Purchase', payment: 'Payment', return: 'Return' }

export default function VendorBalanceConfirmationPrint({ bizInfo, vendor, fyLabel, fyStart, fyEnd, openingBalance, schedule, totals, closingBalance }) {
  const isAdvance = closingBalance < -0.01
  const balanceLabel = isAdvance ? 'Advance / Credit Balance' : 'Balance Payable'
  const todayStr = fmtBs(new Date())
  // numberToWordsNpr() only spells out whole rupees (it rounds internally) — stating it next to
  // the exact 2-decimal figure elsewhere in the letter made the two disagree by up to a rupee
  // (e.g. "NPR 97,823.77" read out as "...Twenty-Four", not "...Twenty-Three"). The one sentence
  // that pairs a figure with its words below states both as this same rounded whole rupee amount;
  // every other figure in the letter (headline boxes, schedule) keeps full paisa precision.
  const roundedClosingAbs = Math.round(Math.abs(closingBalance))

  // The Amount column shows each transaction's own value — a Cash/FonePay purchase is still a
  // real purchase for NPR X, even though it has zero NET EFFECT on the running balance (that's a
  // separate fact, reflected in the Balance column). Computed once here so the body rows and the
  // footer's Amount total agree by construction rather than two independent calculations drifting.
  const rows = schedule.map(e => ({
    ...e,
    signedAmount: e.type === 'opening' ? null : e.type === 'bill' ? e.amount : -e.amount,
  }))
  const amountTotal = rows.reduce((s, e) => s + (e.signedAmount || 0), 0)

  return (
    // White "paper" background — this renders as a persistent on-screen preview (not just at
    // print time), and the letter's black text below vanishes against the app's dark theme
    // without an explicit light backdrop behind it. The shadow/rounded-corner "card" look is
    // for that on-screen preview only — Layout.css strips it under @media print, same as every
    // other .card on paper (S498).
    <div className="vbc-paper" style={{ background: '#fff', borderRadius: 8, boxShadow: '0 1px 4px rgba(0,0,0,0.3)' }}>
    <div style={{ fontFamily: "'Poppins', -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Roboto', 'Oxygen', sans-serif", color: '#000', padding: '20px 24px', maxWidth: 760, margin: '0 auto' }}>
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
          <strong>{fmtBs(fyEnd)} (BS)</strong> is <strong>NPR {roundedClosingAbs.toLocaleString('en-NP')}</strong> ({numberToWordsNpr(roundedClosingAbs)} only).
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
            {['Date', 'Particulars', 'Ref', 'Payment Mode', 'Amount (NPR)', 'Balance (NPR)'].map((h, i) => (
              <th key={h} style={{ textAlign: i >= 4 ? 'right' : 'left', padding: '4px 6px', fontWeight: 700, fontSize: 10, color: '#000', textTransform: 'uppercase', letterSpacing: '0.06em' }}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((e, idx) => (
            <tr key={idx} style={{ borderBottom: '1px solid #ddd' }}>
              <td style={{ padding: '5px 6px 5px 0' }}>{fmtBs(e.date)}</td>
              <td style={{ padding: '5px 6px' }}>
                {EVENT_LABEL[e.type]}{e.type === 'bill' && e.method !== 'Credit' ? ` (${e.method})` : ''}
              </td>
              <td style={{ padding: '5px 6px' }}>
                {/* Invoice number bolded on its own line — a free-text payment note (e.g. "Fonepay
                    via Siddhartha Bank on 22 July 2026") used to be concatenated inline with it
                    ("3 — Fonepay via..."), which buried the actual invoice reference. */}
                {e.ref && <div style={{ fontWeight: 700 }}>{e.ref}</div>}
                {e.note && <div style={{ fontSize: 9.5, marginTop: e.ref ? 2 : 0 }}>{e.note}</div>}
                {!e.ref && !e.note && '—'}
              </td>
              <td style={{ padding: '5px 6px' }}>{e.type === 'bill' ? e.method : '—'}</td>
              <td style={{ padding: '5px 6px', textAlign: 'right' }}>
                {e.signedAmount === null ? '—' : fmtSigned(e.signedAmount)}
              </td>
              <td style={{ padding: '5px 0 5px 6px', textAlign: 'right', fontWeight: 600 }}>{fmtSigned(e.runningBalance)}</td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          {/* Both label cells span the same 4 columns (Date–Method) so "Total" and "Closing
              Balance" line up on the left, and each row's own figure lands in ITS column (Amount
              vs Balance) with the other column left blank — instead of the two labels landing at
              different right edges, which read as staggered/misaligned. */}
          <tr>
            <td colSpan={4} style={{ padding: '10px 6px 0', textAlign: 'right', fontWeight: 700, borderTop: '1px solid #000' }}>Total</td>
            <td style={{ padding: '10px 6px 0', textAlign: 'right', fontWeight: 700, borderTop: '1px solid #000' }}>
              {fmtSigned(amountTotal)}
            </td>
            <td style={{ padding: '10px 0 0 6px', borderTop: '1px solid #000' }} />
          </tr>
          <tr>
            {/* A negative closing balance carries the same "Advance / Credit" framing here as the
                letter body and headline box above — a bare "-17,602.53" with no context read as a
                formatting error sitting right below a box that had already explained it. */}
            <td colSpan={4} style={{ padding: '6px 6px 0', textAlign: 'right', fontWeight: 700 }}>
              {isAdvance ? 'Closing Balance (Advance / Credit)' : 'Closing Balance'}
            </td>
            <td style={{ padding: '6px 6px 0' }} />
            <td style={{ padding: '6px 0 0 6px', textAlign: 'right', fontWeight: 700 }}>NPR {fmtSigned(closingBalance)}</td>
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
