import { FilterChips } from '../../../components/Tabs'
import { bsMonthRangeIso } from './reportRange'

// BS-month range presets for a report's From/To pickers (S776).
//
// The four POS reports opened on today with two calendar pickers and nothing else, so "last month's
// sales" — the question an owner asks at every month end — cost two calendars and half a dozen taps.
// The Customization report had built these presets in S759 and kept them to itself. One copy now,
// used by all five.
//
// Each range is recomputed on render so the pressed chip follows the pickers: set the pickers by hand
// to a range a preset also names and that chip lights up, move them off it and none does.
export const RANGE_PRESETS = [
  { key: 'today', label: 'Today',         range: () => { const { to } = bsMonthRangeIso(0); return { from: to, to } } },
  { key: 'month', label: 'This month',    range: () => bsMonthRangeIso(0) },
  { key: 'last',  label: 'Last month',    range: () => bsMonthRangeIso(-1) },
  { key: 'three', label: 'Last 3 months', range: () => bsMonthRangeIso(-2, 0) },
]

export default function RangePresets({ fromIso, toIso, onPick, style }) {
  const active = RANGE_PRESETS.find(p => {
    const r = p.range()
    return r.from === fromIso && r.to === toIso
  })?.key ?? null
  return (
    <FilterChips
      label="Date range"
      options={RANGE_PRESETS.map(p => ({ key: p.key, label: p.label }))}
      active={active}
      onChange={key => onPick(RANGE_PRESETS.find(p => p.key === key).range())}
      style={{ marginBottom: 0, ...style }}
    />
  )
}
