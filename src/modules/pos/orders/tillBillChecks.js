import { npr } from '../../../shared/nepalMoney'

// The rules behind three of closeBlocker's refusals and the till's settings read (S809 2a), lifted
// out of PosOrders.jsx so they can be tested without React. Pure: no state, no Supabase.

// ── The till's settings read (ORDER-FLOW-1 / CHECKOUT-9) ─────────────────────────────────────────
// The settings row decides what a printed bill IS: TAX INVOICE or BILL, the seller's VAT/PAN number,
// the invoice prefix, the address, the payment QR. It also decides which station a drink's ticket
// prints at. A failed or stalled read used to fall back to defaults in silence (every outlet a VAT
// outlet, no number, no prefix) and then overwrite the till's good offline copy with that empty result.

// Bounds each of the two reads. A supabase call can hang with no error at all (withTimeout.js).
export const TILL_SETTINGS_READ_MS = 15000
// How often a till whose read failed asks again, on any screen, until one lands.
export const TILL_SETTINGS_RETRY_MS = 15000

// `settingsRes` / `clientRes` are the `{ data, error }` of the settings and clients reads (a timeout
// arrives as `error`). A settings read that answers with no row is a real answer: the defaults are
// what the database itself assumes (`is_vat_registered` defaults to true). A missing clients row is
// not, since every client has one.
export function tillSettingsReadOutcome(settingsRes, clientRes) {
  const error = settingsRes?.error || clientRes?.error || null
  if (error) return { ok: false, error }
  if (!clientRes?.data) return { ok: false, error: new Error('The outlet record did not come back.') }
  return { ok: true, settings: settingsRes?.data || null, outletName: clientRes.data.name || '' }
}

// Whether an offline copy carries the outlet's ticket routing. A copy written from a read that
// answered holds every selected column, `pos_bot_categories` included even when it is null; one
// written by a till older than S809 2a after a FAILED read holds only `outlet_name` (`{ ...null }`).
// So does the copy of a client with no settings row at all, whose routing is the default anyway.
export function cacheCarriesRouting(cached) {
  return !!cached && typeof cached === 'object' && 'pos_bot_categories' in cached
}

export const TILL_SETTINGS_FAILED = "Till settings could not be loaded — bills can't be charged until they are."
const TILL_SETTINGS_LOADING = "Till settings are still loading — bills can be charged once they have."

// The standing notice on the floor and the order screen. Without a usable offline copy the till
// routes tickets on its built-in default, which sends only the Beverage category to the bar.
export function tillSettingsNotice({ cachedRouting } = {}) {
  return cachedRouting
    ? TILL_SETTINGS_FAILED
    : `${TILL_SETTINGS_FAILED} Until then, only Beverage items print on the bar ticket.`
}

// Why Payment (or the Billing station's Bill) is refused while no read has landed in this visit.
export function tillSettingsBlockText(failed) {
  return failed ? TILL_SETTINGS_FAILED : TILL_SETTINGS_LOADING
}

// Why a Recent Bills reprint is refused in the same state.
export function tillSettingsReprintText(failed) {
  return `${failed ? "Till settings could not be loaded" : 'Till settings are still loading'}, so this bill was not reprinted — ` +
    "it would print without the outlet's VAT/PAN number, address and the right bill heading. Try again in a moment."
}

// ── What stops a Charge or a Complimentary before anything else is checked ────────────────────────
// `settingsLoaded`: a settings read answered in this visit (ORDER-FLOW-1). A cached copy does not
// count: it can be days old, and a till older than S809 2a may have cached the very empty result
// this fixes. Billing needs a live connection anyway, so a fresh read is always possible when a
// bill is. Void prints nothing and is not held back.
//
// `itemCount`: the cart's lines (CHECKOUT-1, owner decision Q8 a, 2026-10-09). An order emptied on
// screen used to close at NPR 0 and print an empty, numbered Tax Invoice while the stored bill kept
// every line, so Sales Report counted food the drawer never saw. Void is left alone: there the
// stored lines are the record of what was voided.
export function closeStartRefusal({ closeType, settingsLoaded, settingsFailed, itemCount, canVoid }) {
  if (closeType !== 'paid' && closeType !== 'writeoff') return null
  if (!settingsLoaded) return { text: tillSettingsBlockText(settingsFailed), label: 'Till settings not loaded yet' }
  if (itemCount > 0) return null
  return canVoid
    ? { text: 'Nothing is on this bill — void it from the Void tab, or add the items back.', label: 'Nothing on this bill — void it instead' }
    : { text: 'Nothing is on this bill. Ask someone who can void bills to void it, or add the items back.', label: 'Nothing on this bill — ask someone with Void' }
}

// ── A full Tax Invoice names its buyer (CHECKOUT-5, owner decision Q9 a, 2026-10-09) ────────────────
// IRD: a VAT-registered seller may issue an ABBREVIATED tax invoice, with no buyer details, only up
// to this amount. Above it the bill is a full Tax Invoice, which must carry the buyer's name and
// address. PAN stays optional. A PAN-bill outlet (not VAT-registered) is not affected. The Buyer
// details Tip on the payment window reads this constant, so the two cannot disagree.
export const ABBREVIATED_INVOICE_LIMIT = 10000

export function fullInvoiceRequired({ vatReg, payTotal }) {
  return !!vatReg && Number(payTotal) > ABBREVIATED_INVOICE_LIMIT
}

// The refusal, with the first empty field's input id (the S776 focus pattern), or null.
export function fullInvoiceRefusal({ vatReg, payTotal, buyerName, buyerAddress }) {
  if (!fullInvoiceRequired({ vatReg, payTotal })) return null
  const field = !String(buyerName || '').trim() ? 'pos-orders-buyer-name'
    : !String(buyerAddress || '').trim() ? 'pos-orders-buyer-address' : null
  if (!field) return null
  return {
    text: `This bill is over ${npr(ABBREVIATED_INVOICE_LIMIT)}, so it must be a full Tax Invoice with the buyer's name and address — ask the guest and enter them.`,
    label: "Enter the buyer's name and address first",
    field,
  }
}

// The Tip on "Buyer details (optional)".
export function optionalBuyerTip(vatReg) {
  return vatReg
    ? `Optional up to ${npr(ABBREVIATED_INVOICE_LIMIT)}: the IRD lets a VAT bill that size go out as an abbreviated invoice. Above it the till asks for the buyer's name and address. Add the PAN if the customer wants to claim the VAT.`
    : "Optional. Fill in if the customer wants their name or PAN on the bill."
}

// The Tip on the "required" heading when the bill is over the limit.
export const FULL_INVOICE_TIP =
  `A VAT bill above ${npr(ABBREVIATED_INVOICE_LIMIT)} is a full Tax Invoice, which must carry the buyer's name and address. PAN is optional.`
