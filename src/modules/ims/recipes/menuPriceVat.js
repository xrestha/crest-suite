// What a typed menu price means on THIS outlet, and what to store for it (S792, RECIPES-2 / D31).
//
// The till has always honoured `settings.is_vat_registered`: save_pos_order_items writes
// `unit_price = recipes.selling_price` and `vat_rate = v_vat_reg ? COALESCE(recipes.vat_rate, 0.13)
// : 0`, PosOrders adds VAT to the total only when vatReg, and the menu tile and the guest menu both
// show `selling_price × (1 + (vatReg ? vat : 0))`. So on a PAN-bill outlet (not VAT-registered) the
// guest pays `selling_price` exactly, whatever `vat_rate` says.
//
// The pricing screens never read the flag. They took the typed price as VAT-inclusive, divided it by
// 1.13 and stored that — so a cafe that typed NPR 500 on Recipe Costing had the till bill NPR 442,
// while Menu Pricing went on showing "Current Price NPR 500". D31 (the owner's decision): on a
// PAN-bill outlet the price the owner types IS the price the guest pays, stored whole with vat_rate 0.
//
// Pure — no React, no Supabase — so every screen that prices a dish does the same arithmetic, and
// menuPriceVat.test.js can pin it.

import { vatOf } from './recipeCostCalc'
import { getSuggestedPrice } from '../../../utils/recipeCost'

/** How a PAN-bill price is labelled wherever a VAT basis would otherwise be named. */
export const PAN_LABEL = 'no VAT — PAN bill'

/** Why a price box is disabled while the outlet's VAT status is unknown. */
export const VAT_MODE_UNKNOWN_TEXT =
  'Crest has not yet confirmed whether this outlet charges VAT, so a price cannot be set right now. ' +
  'Wait a moment; if this stays, reload the page.'

/**
 * 'vat' | 'pan' | null — how this outlet bills, or null when the page cannot know yet.
 *
 * Only an explicit `is_vat_registered === false` is a PAN-bill outlet. A NULL or missing flag, and a
 * client with no settings row at all, bill WITH VAT — the till reads `?? true` in every one of those
 * cases, and the pricing screens must agree with the till rather than with a guess.
 *
 * Null (unknown) while the settings row is still loading, when its read failed, or while the row on
 * screen belongs to another client (an admin mid-switch). A price typed in that state would be
 * stored on the wrong basis, so every caller refuses to SAVE a price while this is null.
 *
 * @param {object} ctx       the useSettings() value: { settings, loading, settingsLoadError, settingsClientId }
 * @param {string|null} clientId  the client the page is working on (useAuth().clientId)
 */
export function vatModeOf(ctx, clientId) {
  if (!ctx || !clientId) return null
  if (ctx.loading || ctx.settingsLoadError) return null
  if (ctx.settingsClientId !== clientId) return null
  return ctx.settings?.is_vat_registered === false ? 'pan' : 'vat'
}

/**
 * The VAT the till adds on top of a stored selling_price. A PAN-bill outlet adds none, whatever the
 * dish's own vat_rate says. With the mode unknown the stored rate is returned, for DISPLAY only —
 * no caller saves a price in that state.
 */
export function guestVatRate(storedVat, mode) {
  return mode === 'pan' ? 0 : storedVat
}

/** What the guest pays for one plate, before the bill's rupee rounding — or null with no price. */
export function guestPriceOf(recipe, mode) {
  const price = parseFloat(recipe?.selling_price)
  if (!(price > 0)) return null
  return price * (1 + guestVatRate(vatOf(recipe), mode))
}

/**
 * What to store for a typed menu price: `{ selling_price, vat_rate }`, or null when nothing may be
 * stored (no positive price, or the outlet's VAT status is unknown).
 *
 * VAT outlet: the typed price includes the dish's own VAT rate, which is taken off (4 dp, as every
 * pricing screen has always stored it). PAN-bill outlet (D31): the typed price is stored whole, with
 * vat_rate 0, so the till charges exactly what was typed and the dish says so on every screen.
 */
export function storedFromMenuPrice(menuPrice, storedVat, mode) {
  const typed = Number(menuPrice)
  if (mode == null || !(typed > 0)) return null
  if (mode === 'pan') return { selling_price: parseFloat(typed.toFixed(4)), vat_rate: 0 }
  // A missing rate is 13%, as vatOf() reads it — never Number(null), which is 0.
  const vat = storedVat == null || storedVat === '' || !(Number(storedVat) >= 0) ? 0.13 : Number(storedVat)
  return { selling_price: parseFloat((typed / (1 + vat)).toFixed(4)), vat_rate: vat }
}

/**
 * The dishes on a PAN-bill outlet whose stored price was de-VATed by the pricing screens before D31:
 * a price with a VAT rate above 0. Every screen showed the owner `selling_price × (1 + vat)` as the
 * menu price, while the till charges `selling_price`. Returned with both figures, rounded to the
 * rupee as the menu tile and the bill round them, so the owner can re-enter each one once.
 *
 * Active dishes only (a hidden dish is not on the till; if it is shown again it comes back onto this
 * list), never a sub-recipe (not sold). Nothing here rewrites a row — D31 leaves that to the owner.
 *
 * @returns {{ id, name, shownPrice: number, tillPrice: number }[]} sorted by name
 */
export function panPriceMismatches(recipes) {
  const out = []
  for (const r of recipes || []) {
    if (!r || r.category === 'Sub-Recipe' || r.is_active === false) continue
    const price = parseFloat(r.selling_price)
    const vat = vatOf(r)
    if (!(price > 0) || !(vat > 0)) continue
    out.push({ id: r.id, name: r.name, shownPrice: Math.round(price * (1 + vat)), tillPrice: Math.round(price) })
  }
  return out.sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')))
}

/**
 * Menu Repricing's suggestion for one dish: the menu price to charge to hit its target food cost,
 * rounded up to NPR 5 — including VAT on a VAT outlet, as it is on a PAN-bill one (none) — and the
 * gap and monthly opportunity measured against THAT rounded price, taken back to the stored basis
 * (S724: repricing to what the page says must capture exactly the opportunity it promises).
 *
 * All three are null when there is no cost to work back from, or the outlet's VAT status is unknown.
 */
export function repricingOf({ cost, price, targetPct, storedVat, qty }, mode) {
  if (cost == null || mode == null || !(targetPct > 0)) {
    return { suggestedMenuPrice: null, priceGap: null, monthlyOpportunity: null }
  }
  const vat = guestVatRate(storedVat, mode)
  const suggestedMenuPrice = getSuggestedPrice(cost, vat, targetPct / 100)
  const suggestedStored = suggestedMenuPrice / (1 + vat)
  const priceGap = Math.max(0, suggestedStored - (Number(price) || 0))
  // A Credit Note can push a period's net qty negative; only a positive gap on positive volume is
  // an opportunity (S724).
  return { suggestedMenuPrice, priceGap, monthlyOpportunity: Math.max(0, priceGap * (Number(qty) || 0)) }
}
