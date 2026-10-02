// A figure against an earlier one, as the verdict a tile shows (S800). One definition for every
// "vs last week / vs the period before" mark: the POS Dashboard and the Customization Report.
//
// Shape is the fact and colour is the verdict (design-system.md, S634): the glyph says which way
// the figure moved, `good` whether that is the direction this metric wants (more sales is good;
// more discount is not). Inside the dead zone the direction is noise, so the mark is ≈ with no
// verdict (S644): within `pct` percent OR `floor` units, whichever is more forgiving. With nothing
// to compare against there is no comparison at all, never a 100% rise.
export function compareFigures(now, then, { goodDirection = 1, pct = 5, floor = 0 } = {}) {
  if (now == null || then == null || !(then > 0)) return null
  const gap = now - then
  const gapPct = Math.abs(gap / then) * 100
  const flat = Math.abs(gap) <= Math.max(then * (pct / 100), floor)
  if (flat) return { glyph: '≈', gapPct, good: null }
  const up = gap > 0
  return { glyph: up ? '▲' : '▼', gapPct, good: (up ? 1 : -1) === goodDirection }
}
