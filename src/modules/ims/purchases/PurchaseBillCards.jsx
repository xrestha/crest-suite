import { formatBsDay } from '../../../utils/bsCalendar'
import { npr2 } from '../../../shared/nepalMoney'
import { getCf, methodOf } from './purchasesHelpers'
import { fmtLineRate } from './purchaseLines'

// The Purchases bill list on a phone (S796). The desktop table is 745px wide, so in a 298px phone
// column the Bill Total — the figure an owner opens this page for — sat past the right edge behind a
// sideways scroll they may not know exists. Each bill is one card here: supplier and total on the
// first line, the day, bill number, item count and payment on the second, the lines one tap away.
//
// It renders the SAME `byDay` and `billTotals` the table does, so the two cannot disagree: the
// total is the whole bill's (billTotalsByKey), never a sum of the lines a filter left showing.
// `.phone-only` (Layout.css) shows it below 600px, where the table is hidden.
export default function PurchaseBillCards({ byDay, billTotals, bsMonth, isLocked, onEdit, onDelete, goodsValue, payable }) {
  const days = Object.keys(byDay).sort((a, b) => a - b)
  return (
    <ul className="phone-cards phone-only" aria-label="Bills">
      {days.map(day => (
        <li key={day}>
          <div className="phone-cards__day">{formatBsDay(day, bsMonth)}</div>
          <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
            {Object.entries(byDay[day]).map(([gid, entries]) => {
              const first = entries[0]
              const whole = billTotals.get(gid)
              const total = whole?.grandTotal || 0
              const lineCount = whole?.lineCount || entries.length
              const vendor = first.vendors?.name || 'No vendor'
              const billName = `${vendor}${first.invoice_ref ? ` #${first.invoice_ref}` : ''}`
              return (
                <li key={gid} className="phone-card">
                  <div className="phone-card__top">
                    <span className="phone-card__title">{vendor}</span>
                    <span className="phone-card__figure">NPR {npr2(total)}</span>
                  </div>
                  <div className="phone-card__meta">
                    {first.invoice_ref ? `#${first.invoice_ref} · ` : ''}
                    {entries.length < lineCount ? `${entries.length} of ${lineCount} items shown` : `${lineCount} item${lineCount === 1 ? '' : 's'}`}
                    {' · '}{methodOf(first)}
                    {whole?.vatTotal > 0 ? ` · incl. VAT ${npr2(whole.vatTotal)}` : ''}
                    {whole?.discount > 0 ? ` · after ${npr2(whole.discount)} discount` : ''}
                  </div>
                  {whole?.invoiceCheck?.mismatch && (
                    <div style={{ marginTop: 6 }}><span className="badge badge-amber">△ ≠ supplier bill</span></div>
                  )}
                  <details className="phone-card__lines">
                    <summary>Show {entries.length === 1 ? 'the item' : `the ${entries.length} items`}</summary>
                    <ul>
                      {entries.map(e => {
                        const cf = getCf(e.items)
                        const qty = cf > 1 ? e.qty / cf : e.qty
                        const unit = cf > 1 ? e.items.purchase_unit : e.items?.uom
                        const rate = cf > 1 ? e.rate * cf : e.rate
                        return (
                          <li key={e.id}>
                            <span>{e.items?.name} — {Number(qty).toLocaleString('en-IN', { maximumFractionDigits: 3 })} {unit} × {fmtLineRate(rate)}</span>
                            <span>{npr2(e.qty * e.rate)}</span>
                          </li>
                        )
                      })}
                    </ul>
                  </details>
                  {!isLocked && (
                    <div className="phone-card__actions">
                      <button type="button" className="btn btn-ghost" onClick={() => onEdit(gid)} aria-label={`Edit bill from ${billName}`}>Edit</button>
                      <button type="button" className="btn btn-danger" onClick={() => onDelete(gid)} aria-label={`Delete bill from ${billName}`}>Delete</button>
                    </div>
                  )}
                </li>
              )
            })}
          </ul>
        </li>
      ))}
      <li className="phone-card__meta" style={{ padding: '6px 2px' }}>
        Total payable (incl. VAT): <strong style={{ color: 'var(--theme-text1)' }}>NPR {npr2(payable)}</strong>
        <span style={{ display: 'block' }}>Goods value of the lines shown (ex-VAT, before discounts): NPR {npr2(goodsValue)}</span>
      </li>
    </ul>
  )
}
