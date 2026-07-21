import { useFoodBeverageSplit } from './useFoodBeverageSplit'

const fmtNpr = n => `NPR ${Math.round(n).toLocaleString('en-NP')}`

const SEGMENTS = [
  { key: 'Food', color: 'var(--theme-green)' },
  { key: 'Beverage', color: 'var(--theme-purple)' },
  { key: 'Other', color: 'var(--theme-text3)' },
]

// Compact card summarizing this period's revenue as Food / Beverage / Other — combines whichever
// of the manual (sales_entries) and POS (pos_order_items) sources apply, so it reads as one total
// regardless of how many sales channels this client has active.
export default function FoodBeverageSplit({ activePeriod, includeManual, includePos }) {
  const { buckets, loading } = useFoodBeverageSplit({ activePeriod, includeManual, includePos })
  const total = buckets.Food + buckets.Beverage + buckets.Other

  if (loading) {
    return (
      <div className="card" style={{ padding: '14px 16px' }}>
        <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--theme-text2)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 10 }}>Food vs Beverage</div>
        <span className="skeleton" style={{ display: 'inline-block', width: '100%', height: '4em' }} />
      </div>
    )
  }

  if (total <= 0) return null

  return (
    <div className="card" style={{ padding: '14px 16px' }}>
      <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--theme-text2)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 12 }}>Food vs Beverage</div>
      <div style={{ display: 'flex', width: '100%', height: 8, borderRadius: 999, overflow: 'hidden', marginBottom: 12 }}>
        {SEGMENTS.map(seg => {
          const pct = (buckets[seg.key] / total) * 100
          if (pct <= 0) return null
          return <div key={seg.key} style={{ width: `${pct}%`, background: seg.color }} />
        })}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {SEGMENTS.map(seg => {
          const amount = buckets[seg.key]
          const pct = total > 0 ? (amount / total) * 100 : 0
          return (
            <div key={seg.key} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: 12.5 }}>
              <span style={{ display: 'flex', alignItems: 'center', gap: 7, color: 'var(--theme-text1)' }}>
                <span style={{ width: 8, height: 8, borderRadius: '50%', background: seg.color, flexShrink: 0 }} />
                {seg.key}
              </span>
              <span style={{ color: 'var(--theme-text2)' }}>{fmtNpr(amount)} · {pct.toFixed(0)}%</span>
            </div>
          )
        })}
      </div>
    </div>
  )
}
