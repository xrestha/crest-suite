import { NUTRIENTS, calcRecipeNutrition } from '../../../utils/nutrition'
import { calcRecipeCost, calcSubRecipeCostPerUnit, vatOf, fmtNutrient, allocateOverhead } from './recipeCostCalc'
import { recipeCostOf, menuFcPct } from '../../../shared/imsFormulas'
import { BYO_STATUS } from './buildYourOwnRating'
import { guestVatRate, PAN_LABEL } from './menuPriceVat'
import { costRangeText } from '../../customization/BuildCostDetail'
import { nepalBsLong, nepalDateLong } from '../../../shared/nepalTime'

// The day the card was printed, in BS with the AD date beside it — "12 Ashwin 2083 BS · 28 September
// 2026" (S792, RECIPES-6). It printed `new Date().toLocaleDateString('en-IN')`, a browser-locale AD
// date ("28/9/2026") on a BS product's document, read off the runtime's own clock rather than
// Nepal's (GatePassPrint's S756 twin). AD alone outside the verified BS table, never a wrong BS date.
export function printedOnLabel(now = new Date()) {
  const bs = nepalBsLong(now)
  const ad = nepalDateLong(now)
  return bs ? `${bs} BS · ${ad}` : ad
}

// The A4 print-only Recipe Cost Card. Previously duplicated verbatim in two places in
// Recipes.js — the detail view's "🖶 Print" and the list rows' 🖶 button — which had drifted
// only in trivial whitespace. Now one component both call. Renders inside a `.print-only`
// wrapper the caller supplies (so the caller controls when it's in the DOM).
//
// S792. `buildYourOwn` (isCostedByBuild, from the page) prints a build-your-own dish as "Not rated —
// costed by build": its recipe is the bowl and the spoon, and the card used to print FC 2.7% and
// Gross Margin 97.3% for it (RECIPES-1). `byoRange` is its cost range when the page has one.
// `vatMode` ('vat' | 'pan' | null, menuPriceVat.js) decides what the menu price means: on a PAN-bill
// outlet the till adds no VAT, so the card prints one menu price with no VAT in it (RECIPES-2, D31).
export default function RecipeCostCardPrint({ recipe, recipes, settings, overheadData, showNutrition, buildYourOwn = false, byoRange = null, vatMode = 'vat' }) {
  const isSubRec = recipe.category === 'Sub-Recipe'
  // `cost` is the ingredient total the TOTAL FOOD COST row sums to. `dishCost` is what the dish
  // costs for pricing: the manual cost when there are no costed ingredients, else null — never 0
  // (S756). A dish with neither printed "Food Cost % 0.0%" and "Gross Margin % 100.0%" on a sheet
  // someone prices a menu from; both read "—" now.
  const cost = calcRecipeCost(recipe, recipes)
  const byBuild = buildYourOwn && !isSubRec
  const dishCost = byBuild ? null : recipeCostOf({ [recipe.id]: cost }, recipe)
  const manualCost = dishCost != null && !(cost > 0)
  const price = parseFloat(recipe.selling_price) || 0
  // The VAT the till adds on top of the stored price — none on a PAN bill.
  const vat = guestVatRate(vatOf(recipe), vatMode)
  const pan = vatMode === 'pan'
  const fcPct = menuFcPct(dishCost, price)
  const yieldQty = parseFloat(recipe.yield_qty) || 1
  const costPerUnit = cost / yieldQty
  const nutri = showNutrition ? calcRecipeNutrition(recipe, recipes) : null
  const nutriLabel = isSubRec ? 'total batch' : 'per portion'
  const nutriValues = nutri ? nutri.perPortion : null
  const printedOn = printedOnLabel()

  const priceTiles = pan
    ? [{ label: `Menu Price (${PAN_LABEL})`, value: price ? `NPR ${price.toFixed(0)}` : '—' }]
    : [
        { label: 'Selling Price (ex-VAT)', value: price ? `NPR ${price.toFixed(2)}` : '—' },
        { label: `Menu Price (incl. ${(vat * 100).toFixed(0)}% VAT)`, value: price ? `NPR ${(price * (1 + vat)).toFixed(0)}` : '—' },
      ]
  const summary = isSubRec ? [
    { label: 'Total Batch Cost', value: `NPR ${cost.toFixed(2)}` },
    { label: `Cost per ${recipe.yield_uom}`, value: `NPR ${costPerUnit.toFixed(2)}` },
    { label: 'Yield', value: `${recipe.yield_qty} ${recipe.yield_uom}` },
  ] : byBuild ? [
    { label: 'Food Cost (by build)', value: byoRange && !byoRange.empty ? costRangeText(byoRange) : '— costed by build' },
    ...priceTiles,
    { label: 'Food Cost %', value: BYO_STATUS },
    { label: 'Gross Margin %', value: BYO_STATUS },
  ] : [
    { label: manualCost ? 'Food Cost (manual)' : 'Food Cost', value: dishCost != null ? `NPR ${dishCost.toFixed(2)}` : '— not costed' },
    ...priceTiles,
    { label: 'Food Cost %', value: fcPct != null ? `${fcPct.toFixed(1)}%` : '—' },
    { label: 'Gross Margin %', value: fcPct != null ? `${(100 - fcPct).toFixed(1)}%` : '—' },
  ]

  return (
    <div style={{ fontFamily: 'Georgia, serif', color: '#000', padding: '20px 24px', maxWidth: 680, margin: '0 auto' }}>
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', borderBottom: '2px solid #000', paddingBottom: 10, marginBottom: 14 }}>
        <div>
          <div style={{ fontSize: 10, letterSpacing: '0.12em', textTransform: 'uppercase', color: '#555', marginBottom: 2 }}>{settings?.app_name || 'Crest Suite'}</div>
          <div style={{ fontSize: 22, fontWeight: 700, color: '#000' }}>{recipe.name}</div>
          <div style={{ fontSize: 12, color: '#555', marginTop: 3 }}>{isSubRec ? `Sub-Recipe · Yield: ${recipe.yield_qty} ${recipe.yield_uom}` : `Category: ${recipe.category}`}</div>
        </div>
        <div style={{ textAlign: 'right' }}>
          <div style={{ fontSize: 9, color: '#777', textTransform: 'uppercase', letterSpacing: '0.1em' }}>Recipe Cost Card</div>
          <div style={{ fontSize: 11, color: '#555', marginTop: 4 }}>{printedOn}</div>
        </div>
      </div>

      {/* Summary strip */}
      <div style={{ display: 'grid', gridTemplateColumns: `repeat(${summary.length}, 1fr)`, gap: 12, marginBottom: 18, padding: '10px 0', borderBottom: '1px solid #ddd' }}>
        {summary.map(m => (
          <div key={m.label}>
            <div style={{ fontSize: 9, textTransform: 'uppercase', letterSpacing: '0.08em', color: '#777', marginBottom: 3 }}>{m.label}</div>
            <div style={{ fontSize: 14, fontWeight: 700, color: '#000' }}>{m.value}</div>
          </div>
        ))}
      </div>

      {/* Ingredients label */}
      <div style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.1em', color: '#555', marginBottom: 6 }}>Ingredients</div>

      {/* Ingredient table */}
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11 }}>
        <thead>
          <tr style={{ borderBottom: '1px solid #000' }}>
            {['Ingredient', 'Qty', 'UOM', 'Rate (NPR)', 'Cost (NPR)', '% of Dish'].map((h, i) => (
              <th key={h} style={{ textAlign: i === 0 || i === 2 ? 'left' : 'right', padding: '4px 6px', fontWeight: 700, fontSize: 10, color: '#555', textTransform: 'uppercase', letterSpacing: '0.06em', paddingLeft: i === 0 ? 0 : 6, paddingRight: i === 5 ? 0 : 6 }}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {(recipe.recipe_ingredients || []).map((ri, idx) => {
            let ingName, ingUom, ingRate, ingCost
            if (ri.item_id && ri.items) {
              ingName = ri.items.name; ingUom = ri.items.uom
              ingRate = parseFloat(ri.items.per_uom_rate || 0)
              // Previously omitted yield_pct (trim/prep loss) — the TOTAL FOOD COST row below
              // (calcRecipeCost) already applies it, so line items didn't sum to the printed total.
              const yieldFactor = (parseFloat(ri.items.yield_pct) || 100) / 100
              ingCost = (parseFloat(ri.qty_per_portion) / yieldFactor) * ingRate
            } else if (ri.sub_recipe_id && ri.sub_recipe) {
              const cpu = calcSubRecipeCostPerUnit(ri.sub_recipe, recipes)
              ingName = `⚙ ${ri.sub_recipe.name}`; ingUom = ri.sub_recipe.yield_uom
              ingRate = cpu; ingCost = parseFloat(ri.qty_per_portion) * cpu
            } else return null
            const pct = cost > 0 ? (ingCost / cost) * 100 : 0
            return (
              <tr key={ri.id || idx} style={{ borderBottom: '1px solid #eee' }}>
                <td style={{ padding: '5px 6px 5px 0', color: '#000' }}>{ingName}</td>
                <td style={{ padding: '5px 6px', textAlign: 'right' }}>{ri.qty_per_portion}</td>
                <td style={{ padding: '5px 6px', color: '#555' }}>{ingUom}</td>
                <td style={{ padding: '5px 6px', textAlign: 'right', color: '#555' }}>{ingRate.toFixed(2)}</td>
                <td style={{ padding: '5px 6px', textAlign: 'right', fontWeight: 600 }}>{ingCost.toFixed(2)}</td>
                <td style={{ padding: '5px 0 5px 6px', textAlign: 'right', color: '#555' }}>{pct.toFixed(1)}%</td>
              </tr>
            )
          })}
          <tr style={{ borderTop: '2px solid #000' }}>
            <td colSpan={4} style={{ padding: '7px 6px 7px 0', fontWeight: 700, fontSize: 12 }}>TOTAL FOOD COST</td>
            <td style={{ padding: '7px 6px', textAlign: 'right', fontWeight: 700, fontSize: 12 }}>NPR {cost.toFixed(2)}</td>
            <td></td>
          </tr>
        </tbody>
      </table>

      {/* Nutrition strip */}
      {nutri && (
        <div style={{ marginTop: 16, padding: '10px 12px', border: '1px solid #ccc', borderRadius: 3 }}>
          <div style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.1em', color: '#555', marginBottom: 8 }}>
            Nutrition ({nutriLabel}){nutri.coverage.have < nutri.coverage.total ? ` — estimate, ${nutri.coverage.have}/${nutri.coverage.total} ingredients` : ''}
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(6, 1fr)', gap: 10 }}>
            {NUTRIENTS.map(def => (
              <div key={def.key}>
                <div style={{ fontSize: 9, color: '#777', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 2 }}>{def.label}</div>
                <div style={{ fontSize: 12, fontWeight: 700, color: '#000' }}>{fmtNutrient(def, nutriValues[def.key])}</div>
              </div>
            ))}
          </div>
          {nutri.allergens.length > 0 && (
            <div style={{ fontSize: 10, color: '#555', marginTop: 8, textTransform: 'capitalize' }}>
              Allergens: {nutri.allergens.join(', ')}
            </div>
          )}
        </div>
      )}

      {/* Overhead section */}
      {!isSubRec && overheadData && price > 0 && (() => {
        const { ohPerPortion: ohPer } = allocateOverhead(recipe.id, overheadData)
        // Unknown food cost → unknown true cost, margin and suggestion (S756), as on screen. A
        // build-your-own dish's food cost is a range, so it is unknown here too (S792).
        const trueCost = dishCost != null ? dishCost + ohPer : null
        const trueMargin = trueCost != null && price > 0 ? ((price - trueCost) / price) * 100 : null
        // Targets a 30% true margin (true cost = 70% of price) — matches Recipes.js's detail view.
        const suggested = trueCost != null ? Math.ceil(((trueCost / 0.70) * (1 + vat)) / 5) * 5 : null
        return (
          <div style={{ marginTop: 16, padding: '10px 12px', border: '1px solid #ccc', borderRadius: 3 }}>
            <div style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.1em', color: '#555', marginBottom: 8 }}>True Cost with Overheads</div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12 }}>
              {[
                { label: 'Overhead / Portion', value: `NPR ${ohPer.toFixed(2)}` },
                { label: 'True Cost / Portion', value: trueCost != null ? `NPR ${trueCost.toFixed(2)}` : byBuild ? BYO_STATUS : '—' },
                { label: 'True Net Margin %', value: trueMargin != null ? `${trueMargin.toFixed(1)}%` : byBuild ? BYO_STATUS : '—' },
                // Says "incl. VAT" for the same reason the on-screen tiles do (S711): this is a
                // printed sheet someone prices a menu from, and the figure is VAT-inclusive and
                // rounded up to NPR 5, unlike the ex-VAT Selling Price above it. On a PAN-bill
                // outlet there is no VAT in it, and the label says that instead (S792, D31).
                { label: `Suggested @ 30% Margin (${pan ? PAN_LABEL : `incl. ${(vat * 100).toFixed(0)}% VAT`})`, value: suggested != null ? `NPR ${suggested}` : '—' },
              ].map(m => (
                <div key={m.label}>
                  <div style={{ fontSize: 9, color: '#777', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 3 }}>{m.label}</div>
                  <div style={{ fontSize: 13, fontWeight: 700, color: '#000' }}>{m.value}</div>
                </div>
              ))}
            </div>
          </div>
        )
      })()}

      {/* Footer */}
      <div style={{ marginTop: 20, paddingTop: 8, borderTop: '1px solid #ddd', display: 'flex', justifyContent: 'space-between', fontSize: 9, color: '#999' }}>
        <span>CONFIDENTIAL — Internal use only</span>
        <span>Generated by Crest Suite · {printedOn}</span>
      </div>
    </div>
  )
}
