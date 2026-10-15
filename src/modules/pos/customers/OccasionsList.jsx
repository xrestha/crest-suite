import { waLink } from '../reservations/whatsappLink'
import { daysAwayLabel, occasionDayLabel, occasionWhat, occasionWish } from './occasions'

// Birthdays and anniversaries coming up (S843), as rows: who, what (with the age or the years when
// the year is known), the day in BS with its weekday, how far away, and a WhatsApp button that opens
// a prefilled wish on the sender's own phone (a navigation, not a fetch: nothing for connect-src).
//
// Presentational only: the caller reads the customers and works out `items` (occasions.js), and owns
// the loading, failed and empty states, so "no birthdays" is never said over a read that failed.
// `variant` 'table' is the Membership tab's list; 'list' is the dashboard card's compact rows.

const KIND_MARK = { birthday: '🎂', anniversary: '💍' }

function WishButton({ item, outletName }) {
  const what = item.kind === 'anniversary' ? 'an anniversary' : 'a birthday'
  return (
    <a className="btn btn-ghost" style={{ whiteSpace: 'nowrap', color: 'var(--theme-text1)' }}
      href={waLink(item.phone, occasionWish(item, outletName))} target="_blank" rel="noopener noreferrer"
      aria-label={`Send ${item.name} ${what} wish on WhatsApp`}>
      WhatsApp
    </a>
  )
}

function When({ n }) {
  const text = daysAwayLabel(n)
  return n === 0
    ? <strong style={{ color: 'var(--theme-text1)', whiteSpace: 'nowrap' }}>{text}</strong>
    : <span style={{ whiteSpace: 'nowrap' }}>{text}</span>
}

export default function OccasionsList({ items, outletName = '', variant = 'table' }) {
  if (variant === 'list') {
    return (
      <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
        {items.map((it, i) => (
          <li key={it.key} style={{
            display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap',
            padding: '8px 0', borderTop: i ? '1px solid var(--theme-border)' : 'none',
          }}>
            <div style={{ minWidth: 0, flex: '1 1 200px' }}>
              <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--theme-text1)' }}>
                <span aria-hidden="true">{KIND_MARK[it.kind]} </span>{it.name}
              </div>
              <div style={{ fontSize: 12, color: 'var(--theme-text2)' }}>
                {occasionWhat(it)} · {occasionDayLabel(it)} · <When n={it.daysAway} />
              </div>
            </div>
            <WishButton item={it} outletName={outletName} />
          </li>
        ))}
      </ul>
    )
  }
  return (
    <div className="table-wrap">
      <table className="data-table">
        <thead>
          <tr>
            <th>Customer</th>
            <th>Occasion</th>
            <th>Day</th>
            <th>When</th>
            <th><span className="sr-only">WhatsApp</span></th>
          </tr>
        </thead>
        <tbody>
          {items.map(it => (
            <tr key={it.key}>
              <td>
                <div style={{ fontWeight: 600, color: 'var(--theme-text1)' }}>{it.name}</div>
                <div style={{ fontSize: 12, color: 'var(--theme-text2)', whiteSpace: 'nowrap' }}>{it.phone}</div>
              </td>
              <td><span aria-hidden="true">{KIND_MARK[it.kind]} </span>{occasionWhat(it)}</td>
              <td style={{ whiteSpace: 'nowrap' }}>{occasionDayLabel(it)}</td>
              <td><When n={it.daysAway} /></td>
              <td style={{ textAlign: 'right' }}><WishButton item={it} outletName={outletName} /></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
