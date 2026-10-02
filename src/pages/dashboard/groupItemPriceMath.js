// The Group Console's "Same item, different price" comparison (S800), over the raw rows
// get_group_item_prices returns: per linked item and outlet, the quantity bought in the month and
// what it cost before VAT, after the bill's discount. The per-unit price and the comparison are
// worked out here so the SQL stays a set of sums.
//
// An item counts only where two or more outlets paid a real price for it in the SAME unit. Units
// that differ (one outlet counts KG, another GM) are listed but never compared; a zero-value line
// (a free sample) is not a price and cannot be "the cheapest".

const EPS = 1e-9

// rows: [{ item_key, client_id, client_name, item_name, uom, qty, net_value, lines }]
// → { items: [{ key, name, otherNames, uom, unitsDiffer, outlets, minRate, maxRate, spreadPct,
//      extra }], totalExtra, comparable }
// outlets: [{ clientId, clientName, name, uom, qty, value, lines, rate, cheapest }]
// extra = Σ (outlet rate − lowest rate) × outlet qty: what the group paid above its own lowest
// price for that item that month. Items are ranked by it, units-differ items last.
export function compareItemPrices(rows) {
  const byKey = new Map()
  for (const r of rows || []) {
    const qty = Number(r.qty) || 0
    const value = Number(r.net_value) || 0
    const o = {
      clientId: r.client_id,
      clientName: r.client_name || '',
      name: r.item_name || '',
      uom: r.uom || '',
      qty,
      value,
      lines: Number(r.lines) || 0,
      rate: qty > 0 && value > 0 ? value / qty : null,
      cheapest: false,
    }
    if (!byKey.has(r.item_key)) byKey.set(r.item_key, [])
    byKey.get(r.item_key).push(o)
  }

  const items = []
  for (const [key, outlets] of byKey) {
    outlets.sort((x, y) => x.clientName.localeCompare(y.clientName))
    const names = [...new Set(outlets.map(o => o.name).filter(Boolean))]
    const name = names[0] || ''
    const uoms = new Set(outlets.map(o => o.uom.toUpperCase()))
    const base = { key, name, otherNames: names.slice(1), outlets }
    if (uoms.size > 1) {
      items.push({ ...base, uom: null, unitsDiffer: true, minRate: null, maxRate: null, spreadPct: null, extra: null })
      continue
    }
    const priced = outlets.filter(o => o.rate != null)
    if (new Set(priced.map(o => o.clientId)).size < 2) continue
    const minRate = Math.min(...priced.map(o => o.rate))
    const maxRate = Math.max(...priced.map(o => o.rate))
    const tol = EPS * Math.max(1, minRate)
    const spread = maxRate - minRate > tol
    if (spread) for (const o of priced) o.cheapest = o.rate - minRate <= tol
    const extra = spread ? priced.reduce((t, o) => t + (o.rate - minRate) * o.qty, 0) : 0
    items.push({
      ...base,
      uom: outlets[0].uom,
      unitsDiffer: false,
      minRate,
      maxRate,
      spreadPct: minRate > 0 ? ((maxRate - minRate) / minRate) * 100 : null,
      extra,
    })
  }

  items.sort((x, y) => {
    if (x.unitsDiffer !== y.unitsDiffer) return x.unitsDiffer ? 1 : -1
    if (!x.unitsDiffer && y.extra !== x.extra) return y.extra - x.extra
    return x.name.localeCompare(y.name)
  })
  const compared = items.filter(i => !i.unitsDiffer)
  return {
    items,
    comparable: compared.length,
    totalExtra: compared.reduce((t, i) => t + i.extra, 0),
  }
}
