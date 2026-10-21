import { supabase } from '../supabaseClient'
import { scopedFrom } from '../shared/scopedDb'
import { buildBillHtml, buildCompSlipHtml } from '../modules/pos/orders/posOrderPrintHtml'
import { posLineCosts, buildYourOwnAmong, LINE_CHOICE_STOCK } from '../modules/pos/orders/posRecipeBook'
import { withTimeout, settleWithin } from './withTimeout'
import { readHscMap, staffNameFor, REPRINT_READ_MS } from '../modules/pos/orders/billReprintData'

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

// A Complimentary Slip prints what each comped dish cost in ingredients, which the till's recipe book
// shows only to a POS Supervisor or above (S828 5d). One line for anyone else, never a slip at NPR 0.
function writeCostsRefused(w) {
  if (!w) return
  w.document.open()
  w.document.write('<p style="font-family:sans-serif;color:#555;padding:24px">This Complimentary Slip shows what the food cost, which only a POS supervisor, a POS manager or the Owner can see. Ask one of them to open it.</p>')
  w.document.close()
}

// Every read is bounded (S809.4): a hung request left the tab on "Loading…" for ever, with nothing
// saying the bill would not come. A timeout is a failed read like any other.
const within = (call, label) => settleWithin(call, REPRINT_READ_MS, label)

export async function viewPosBill(clientId, row) {
  const orderId = row.isItemComp ? row.parentOrderId : row.id
  if (!clientId || !orderId) return

  // Opened synchronously, before any await — the click's transient user-activation is gone by
  // the time the Supabase queries below resolve, so opening it after them gets silently
  // popup-blocked on Safari/iPad (no gesture left to point to) and often on Chrome too on a
  // slow connection. A tab open on a blank/loading page beats no tab at all.
  const w = window.open('', '_blank')
  if (w) w.document.write('<p style="font-family:sans-serif;color:#555;padding:24px">Loading…</p>')

  const [{ data: order, error: orderErr }, { data: settings, error: settingsErr }, { data: client, error: clientErr }] = await Promise.all([
    within(scopedFrom('pos_orders', clientId).eq('id', orderId).single(), 'Reading the bill'),
    within(supabase.from('settings').select('is_vat_registered, invoice_prefix, vat_number, property_address, property_phone').eq('client_id', clientId).maybeSingle(), 'Reading the billing settings'),
    // The module switches too: whether a comp is costed with its choices' stock (the outlet has Crest
    // IMS) and which dishes are costed by their build (Customization on) — as AuthContext reads them.
    within(supabase.from('clients').select('name, ims_enabled, pos_enabled, customization_enabled').eq('id', clientId).single(), 'Reading the outlet'),
  ])
  // The settings decide the document itself — TAX INVOICE or BILL, the seller's VAT/PAN number, the
  // prefix, the address — so a failed read of them is a failed read of the bill (S809 2a, CHECKOUT-9).
  // Before this, it fell back to "VAT-registered, no number" and showed a PAN outlet a Tax Invoice.
  if (orderErr || !order || settingsErr || clientErr) {
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

  // With each line's choices' stock lines, which a Complimentary Slip is costed from (posLineCosts).
  // `*` carries the combo columns (S839): the bill, its discount maths and both slips print a combo's
  // dishes as one row by combo_line_id, so a narrowed select must keep combo_line_id, combo_name,
  // combo_sort and selection_key.
  const { data: allItems, error: itemsErr } = await within(scopedFrom('pos_order_items', clientId, `*, ${LINE_CHOICE_STOCK}`).eq('order_id', orderId), 'Reading the bill lines')
  if (itemsErr) { writeLoadFailure(w); return }
  const items = allItems || []

  // Whichever staff member actually acted — comped_by for an item-level comp, closed_by for
  // everything else (whole-order Complimentary, Pay, Void) — was missing entirely before; the
  // real print always shows it (authorizedBy/cashierName), so the drill-down should too.
  const compedItemsForStaff = row.isItemComp ? items.filter(i => i.comped && i.comp_no === row.compNo) : null
  const staffId = row.isItemComp ? compedItemsForStaff[0]?.comped_by : order.closed_by
  // A raw `profiles` query only ever returns the CALLER's own row under RLS
  // (profiles_select: id = auth.uid() OR admin) — resolving another staff member's name
  // needs get_client_profile_names(), a SECURITY DEFINER RPC. Its error used to be dropped, so a
  // failed read showed the bill with a blank Cashier as though nobody had closed it (S809.4).
  const { name: staffName, error: staffErr } = await staffNameFor(supabase, clientId, staffId)
  if (staffErr) { writeLoadFailure(w); return }

  // Food costs through the till's recipe book (S828 5d), as the till's own Complimentary Slip and the
  // Sales Report's comp cost read them: a POS manager on a PIN cannot read `items`, so the direct walk
  // costed every comp at its typed Cost Price, usually NPR 0. The book answers a POS Supervisor or
  // above, the Owner and the operator; a Staff login (Parking's View bill) is refused and told so.
  // It THROWS on a failed read, which used to leave the tab on "Loading…" with an unhandled
  // rejection. A slip valued at zero would be a wrong document. Each dish is costed with its choices
  // (posLineCosts), as the till's own slip is: the client's switches, not the viewer's, decide how.
  const inventory = client?.ims_enabled !== false
  const customization = !!client?.pos_enabled && !!client?.customization_enabled
  const slipCosts = async lines => {
    try {
      const buildYourOwn = inventory && customization
        ? buildYourOwnAmong((t, sel) => scopedFrom(t, clientId, sel), lines.map(i => i.recipe_id)) : []
      return await withTimeout(posLineCosts(supabase, clientId, lines, { inventory, buildYourOwn }), REPRINT_READ_MS, 'Reading food costs')
    } catch (e) {
      console.error('viewPosBill: food costs could not be read:', e)
      return e?.hint === 'rank_required' ? 'rank' : null
    }
  }
  const costsMissing = costing => {
    if (costing === 'rank') { writeCostsRefused(w); return true }
    if (!costing) { writeLoadFailure(w); return true }
    return false
  }

  let html
  if (row.isItemComp) {
    const compedItems = compedItemsForStaff
    const costing = await slipCosts(compedItems)
    if (costsMissing(costing)) return
    html = buildCompSlipHtml({
      order: { ...order, invoice_no: row.compNo, close_reason: compedItems[0]?.comp_reason || '', bill_remarks: '' },
      items: compedItems, plateCostOf: costing.costOf, copyLabel: 'VIEW ONLY',
      outletName, tableName, authorizedBy: staffName,
    })
  } else if (order.close_type === 'writeoff') {
    const costing = await slipCosts(items)
    if (costsMissing(costing)) return
    html = buildCompSlipHtml({
      order, items, plateCostOf: costing.costOf, copyLabel: 'VIEW ONLY',
      outletName, tableName, authorizedBy: staffName,
    })
  } else {
    // Pay (with or without discount) or Void — same Tax Invoice/Bill layout either way. A Void
    // never actually got a real invoice_no (buildBillHtml already shows a "(on confirm)"
    // placeholder for a null one), but the item composition is still the truest record of what
    // was rung up. Comped lines are excluded — they were never on this bill either (see closeOrder).
    const payableItems = items.filter(i => !i.comped)
    const { map: hscMap, error: recErr } = await readHscMap((t, sel) => scopedFrom(t, clientId, sel), payableItems.map(i => i.recipe_id))
    if (recErr) { writeLoadFailure(w); return }
    let payments
    if (order.payment_method === 'Split') {
      const { data, error: payErr } = await within(scopedFrom('pos_order_payments', clientId, 'payment_method, amount').eq('order_id', orderId).order('recorded_at'), 'Reading the payments')
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
