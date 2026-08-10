// Dead/Slow Stock — mirrors DeadStock.js's exact thresholds: SLOW_THRESHOLD=0.2,
// used = max(available - wasted - closing, 0), status Dead when used===0, Slow when
// available>0 && used/available<0.2. Items with no stock presence at all (available<=0 &&
// closing<=0) are skipped entirely, same as the source page.
import { supabase } from '../../supabaseClient'
import { scopedFrom } from '../../shared/scopedDb'
import { fetchAllRows } from '../../shared/fetchAllRows'

const SLOW_THRESHOLD = 0.2

export async function computeInventoryDeadStock(clientId, period) {
  const [{ data: opening }, { data: purchases }, { data: returns }, { data: wastages }, { data: closing }, { data: items }] = await Promise.all([
    supabase.from('opening_stock').select('item_id, qty').eq('period_id', period.id),
    fetchAllRows(() => supabase.from('purchase_entries').select('item_id, qty').eq('period_id', period.id).order('id')),
    supabase.from('vendor_returns').select('item_id, qty').eq('period_id', period.id),
    supabase.from('wastages').select('item_id, qty').eq('period_id', period.id),
    supabase.from('closing_stock').select('item_id, physical_qty').eq('period_id', period.id),
    scopedFrom('items', clientId, 'id, name, category_id, per_uom_rate, is_active, is_sub_recipe').eq('is_active', true),
  ])

  const sum = (rows, key) => { const m = {}; (rows || []).forEach(r => { m[r.item_id] = (m[r.item_id] || 0) + (parseFloat(r[key]) || 0) }); return m }
  const openMap = sum(opening, 'qty'), purchMap = sum(purchases, 'qty'), retMap = sum(returns, 'qty')
  const wasteMap = sum(wastages, 'qty'), closeMap = sum(closing, 'physical_qty')

  let deadCount = 0, slowCount = 0, totalValueAtRisk = 0
  const flagged = []
  ;(items || []).forEach(i => {
    const opening_ = openMap[i.id] || 0, purchased = purchMap[i.id] || 0, returned = retMap[i.id] || 0
    const wasted = wasteMap[i.id] || 0, closing_ = closeMap[i.id] || 0
    const available = opening_ + purchased - returned
    if (available <= 0 && closing_ <= 0) return
    const used = Math.max(available - wasted - closing_, 0)
    const status = used === 0 ? 'Dead' : (available > 0 && used / available < SLOW_THRESHOLD ? 'Slow' : null)
    if (!status) return
    const rate = parseFloat(i.per_uom_rate || 0)
    const valueAtRisk = closing_ * rate
    if (status === 'Dead') deadCount += 1; else slowCount += 1
    totalValueAtRisk += valueAtRisk
    flagged.push({ itemId: i.id, name: i.name, opening: opening_, purchased, returned, wasted, used, closing: closing_, valueAtRisk, status })
  })

  return { deadCount, slowCount, totalValueAtRisk, items: flagged.sort((a, b) => b.valueAtRisk - a.valueAtRisk) }
}
