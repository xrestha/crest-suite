// Combos on paper (S839, docs/pos-combos.md → "On paper and on screens"): the one rule for turning a
// bill's lines into the rows a printed document shows. The bill, the credit note and the
// Complimentary Slip all print through groupComboLines, so a combo reads the same on all three.
//
// Each dish of a combo is a real order line. On paper, the dishes of one combo (one combo_line_id)
// become ONE row, at the position of the combo's first dish: the combo's name, its quantity, and the
// sum of its dishes' amounts. The dishes are listed under it, unpriced, in the order of their picks.
// Every other line is its own row, in its own place, exactly as before. Nothing here changes a total.

// A combo dish's '@<combo_line_id>/<combo_group_id>' key tail, for a line read without its tag columns.
const keyTail = i => {
  const key = String(i?.selection_key || '')
  const at = key.indexOf('@')
  if (at < 0) return null
  const [line, group] = key.slice(at + 1).split('/')
  return { line: line || null, group: group || null }
}

// A cart line may still hold its combo as the save payload's `combo` object (posOrdersConstants'
// comboFieldsOf reads both shapes); a stored line has the columns.
/** The combo a line belongs to (its combo_line_id, else its key's tail), or null for any other line. */
export const comboLineIdOf = i => i?.combo_line_id || i?.combo?.line_id || keyTail(i)?.line || null

const comboGroupIdOf = i => i?.combo_group_id || i?.combo?.group_id || keyTail(i)?.group || null
const comboNameOf = i => String(i?.combo_name ?? i?.combo?.name ?? '').trim()

// One dish as the paper lists it: the same dish twice in one pick (a comped part and the rest, both
// on a whole-bill Complimentary Slip) is listed once.
const dishKey = i => `${comboGroupIdOf(i) || ''}|${i?.recipe_id || ''}|${i?.selection_key || ''}|${i?.name || ''}`

const sortOf = i => {
  const s = i?.combo_sort ?? i?.combo?.sort
  return s == null || s === '' ? Infinity : Number(s)
}

/**
 * The rows a printed document shows for these lines, in order:
 *   { combo: false, item }  — an ordinary line, printed as itself;
 *   { combo: true, id, name, qty, amount, rate, dishes, lines } — one combo: `lines` are all its
 *     order lines (for sums such as a food cost), `dishes` the distinct dishes to list under it.
 * The combo's quantity is what each of its picks adds up to. When its picks disagree (a combo not
 * whole, which the server never stores), its dishes print as ordinary lines instead, so the paper
 * never shows a quantity that is not true.
 */
export function groupComboLines(items) {
  const list = Array.isArray(items) ? items : []
  const combos = new Map()
  for (const i of list) {
    const id = comboLineIdOf(i)
    if (!id) continue
    if (!combos.has(id)) combos.set(id, [])
    combos.get(id).push(i)
  }
  if (combos.size === 0) return list.map(item => ({ combo: false, item }))

  const rowOf = new Map()
  for (const [id, lines] of combos) {
    const perPick = new Map()
    lines.forEach((l, n) => {
      const pick = comboGroupIdOf(l) || `#${n}`
      perPick.set(pick, (perPick.get(pick) || 0) + (Number(l.qty) || 0))
    })
    const qtys = [...perPick.values()]
    if (qtys.some(q => q !== qtys[0])) continue // not whole: printed line by line
    const qty = qtys[0]
    const amount = lines.reduce((s, l) => s + (Number(l.qty) || 0) * (Number(l.unit_price) || 0), 0)
    const seen = new Map()
    lines.forEach((l, n) => { if (!seen.has(dishKey(l))) seen.set(dishKey(l), { l, n }) })
    const dishes = [...seen.values()]
      .sort((a, b) => (sortOf(a.l) - sortOf(b.l)) || (a.n - b.n))
      .map(d => d.l)
    const name = lines.map(comboNameOf).find(Boolean) || 'Combo'
    rowOf.set(id, { combo: true, id, name, qty, amount, rate: qty ? amount / qty : 0, dishes, lines })
  }

  const rows = []
  const placed = new Set()
  for (const item of list) {
    const id = comboLineIdOf(item)
    const row = id ? rowOf.get(id) : null
    if (!row) { rows.push({ combo: false, item }); continue }
    if (placed.has(id)) continue
    placed.add(id)
    rows.push(row)
  }
  return rows
}
