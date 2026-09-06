import { supabase } from '../supabaseClient'
import { scopedFrom } from '../shared/scopedDb'
import { buildBillHtml, buildCompSlipHtml } from '../modules/pos/orders/posOrderPrintHtml'
import { computeRecipeCosts } from './recipeCost'

// Read-only, full-fidelity drill-down — opens the exact same Tax Invoice/Bill or Complimentary
// Slip layout used for the real print (same buildBillHtml/buildCompSlipHtml builders from
// PosOrders.jsx), in a new tab, without ever calling window.print(). Used by row-click
// drill-down from Sales Exceptions and Sales Report (Bill Register). Not a component — does its
// own data fetching so callers only need to pass what identifies the row.
//
// `row` shapes handled:
//   - a normal order row: { id: <pos_orders.id> }                       → Tax Invoice/Bill
//   - a whole-order Complimentary row: { id, close_type: 'writeoff' }   → Complimentary Slip
//   - an item-level comp row: { isItemComp: true, parentOrderId, compNo } → mini Complimentary
//     Slip for just the comped item(s) sharing that compNo
// A failed read must not become a blank "VIEW ONLY" invoice: an items read that fails yields zero
// lines and NPR 0, a payments read that fails yields a Split bill with no breakdown, and both are
// indistinguishable from a real empty bill (S682). One line in the popup instead of a document.
function writeLoadFailure(w) {
  if (!w) return
  w.document.open()
  w.document.write('<p style="font-family:sans-serif;color:#c00;padding:24px">Couldn\'t load this bill. Close this tab and open it again from the report.</p>')
  w.document.close()
}

export async function viewPosBill(clientId, row) {
  const orderId = row.isItemComp ? row.parentOrderId : row.id
  if (!clientId || !orderId) return

  // Opened synchronously, before any await — the click's transient user-activation is gone by
  // the time the Supabase queries below resolve, so opening it after them gets silently
  // popup-blocked on Safari/iPad (no gesture left to point to) and often on Chrome too on a
  // slow connection. A tab open on a blank/loading page beats no tab at all.
  const w = window.open('', '_blank')
  if (w) w.document.write('<p style="font-family:sans-serif;color:#666;padding:24px">Loading…</p>')

  const [{ data: order, error: orderErr }, { data: settings }, { data: client }] = await Promise.all([
    scopedFrom('pos_orders', clientId).eq('id', orderId).single(),
    supabase.from('settings').select('is_vat_registered, invoice_prefix, vat_number, property_address, property_phone').eq('client_id', clientId).maybeSingle(),
    supabase.from('clients').select('name').eq('id', clientId).single(),
  ])
  if (orderErr || !order) {
    writeLoadFailure(w)
    return
  }

  const billingSettings = {
    is_vat_registered: settings?.is_vat_registered ?? true,
    invoice_prefix: settings?.invoice_prefix || '',
    vat_number: settings?.vat_number || '',
    property_address: settings?.property_address || '',
    property_phone: settings?.property_phone || '',
  }
  const outletName = client?.name || ''
  const tableName = order.table_name || 'Takeaway'

  const { data: allItems, error: itemsErr } = await scopedFrom('pos_order_items', clientId).eq('order_id', orderId)
  if (itemsErr) { writeLoadFailure(w); return }
  const items = allItems || []

  // Whichever staff member actually acted — comped_by for an item-level comp, closed_by for
  // everything else (whole-order Complimentary, Pay, Void) — was missing entirely before; the
  // real print always shows it (authorizedBy/cashierName), so the drill-down should too.
  const compedItemsForStaff = row.isItemComp ? items.filter(i => i.comped && i.comp_no === row.compNo) : null
  const staffId = row.isItemComp ? compedItemsForStaff[0]?.comped_by : order.closed_by
  // A raw `profiles` query only ever returns the CALLER's own row under RLS
  // (profiles_select: id = auth.uid() OR admin) — resolving another staff member's name
  // needs get_client_profile_names(), a SECURITY DEFINER RPC.
  let staffName = ''
  if (staffId) {
    const { data: staffList } = await supabase.rpc('get_client_profile_names', { p_client_id: clientId })
    staffName = (staffList || []).find(s => s.id === staffId)?.full_name || ''
  }

  let html
  if (row.isItemComp) {
    const compedItems = compedItemsForStaff
    const recipeIds = compedItems.map(i => i.recipe_id).filter(Boolean)
    const costMap = recipeIds.length > 0 ? await computeRecipeCosts(supabase, recipeIds) : {}
    html = buildCompSlipHtml({
      order: { ...order, invoice_no: row.compNo, close_reason: compedItems[0]?.comp_reason || '', bill_remarks: '' },
      items: compedItems, costMap, copyLabel: 'VIEW ONLY',
      outletName, tableName, authorizedBy: staffName,
    })
  } else if (order.close_type === 'writeoff') {
    const recipeIds = items.map(i => i.recipe_id).filter(Boolean)
    const costMap = recipeIds.length > 0 ? await computeRecipeCosts(supabase, recipeIds) : {}
    html = buildCompSlipHtml({
      order, items, costMap, copyLabel: 'VIEW ONLY',
      outletName, tableName, authorizedBy: staffName,
    })
  } else {
    // Pay (with or without discount) or Void — same Tax Invoice/Bill layout either way. A Void
    // never actually got a real invoice_no (buildBillHtml already shows a "(on confirm)"
    // placeholder for a null one), but the item composition is still the truest record of what
    // was rung up. Comped lines are excluded — they were never on this bill either (see closeOrder).
    const payableItems = items.filter(i => !i.comped)
    const recipeIds = payableItems.map(i => i.recipe_id).filter(Boolean)
    let hscMap = {}
    if (recipeIds.length > 0) {
      const { data: recipes, error: recErr } = await scopedFrom('recipes', clientId, 'id, hsc_code').in('id', recipeIds)
      if (recErr) { writeLoadFailure(w); return }
      hscMap = Object.fromEntries((recipes || []).map(r => [r.id, r.hsc_code]))
    }
    let payments
    if (order.payment_method === 'Split') {
      const { data, error: payErr } = await scopedFrom('pos_order_payments', clientId, 'payment_method, amount').eq('order_id', orderId).order('recorded_at')
      if (payErr) { writeLoadFailure(w); return }
      payments = (data || []).map(p => ({ method: p.payment_method, amount: p.amount }))
    }
    html = buildBillHtml({
      order, items: payableItems, copyLabel: 'VIEW ONLY', qrUrl: '', payments,
      outletName, billingSettings, hscMap, tableName, cashierName: staffName,
    })
  }

  if (!w) return
  // .open() clears the "Loading…" placeholder written above — without it, document.write()
  // on a still-open document APPENDS rather than replaces, leaving the placeholder in place
  // above the real bill.
  w.document.open()
  w.document.write(html)
  w.document.close()
}
