import { NUTRIENTS, calcRecipeNutrition } from '../../../utils/nutrition'
import { calcRecipeCost, calcSubRecipeCostPerUnit, vatOf, fmtNutrient, allocateOverhead } from './recipeCostCalc'

// The A4 print-only Recipe Cost Card. Previously duplicated verbatim in two places in
// Recipes.js — the detail view's "🖶 Print" and the list rows' 🖶 button — which had drifted
// only in trivial whitespace. Now one component both call. Renders inside a `.print-only`
// wrapper the caller supplies (so the caller controls when it's in the DOM).
export default function RecipeCostCardPrint({ recipe, recipes, settings, overheadData, showNutrition }) {
  const isSubRec = recipe.category === 'Sub-Recipe'
  const cost = calcRecipeCost(recipe, recipes)
  const price = parseFloat(recipe.selling_price) || 0
  const vat = vatOf(recipe)
  const fcPct = price > 0 ? (cost / price) * 100 : null
  const yieldQty = parseFloat(recipe.yield_qty) || 1
  const costPerUnit = cost / yieldQty
  const nutri = showNutrition ? calcRecipeNutrition(recipe, recipes) : null
  const nutriLabel = isSubRec ? 'total batch' : 'per portion'
  const nutriValues = nutri ? nutri.perPortion : null

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
          <div style={{ fontSize: 11, color: '#555', marginTop: 4 }}>{new Date().toLocaleDateString('en-NP')}</div>
        </div>
      </div>

      {/* Summary strip */}
      <div style={{ display: 'grid', gridTemplateColumns: isSubRec ? '1fr 1fr 1fr' : 'repeat(5, 1fr)', gap: 12, marginBottom: 18, padding: '10px 0', borderBottom: '1px solid #ddd' }}>
        {(isSubRec ? [
          { label: 'Total Batch Cost', value: `NPR ${cost.toFixed(2)}` },
          { label: `Cost per ${recipe.yield_uom}`, value: `NPR ${costPerUnit.toFixed(2)}` },
          { label: 'Yield', value: `${recipe.yield_qty} ${recipe.yield_uom}` },
        ] : [
          { label: 'Food Cost', value: `NPR ${cost.toFixed(2)}` },
          { label: 'Selling Price (ex-VAT)', value: price ? `NPR ${price.toFixed(2)}` : '—' },
          { label: `Menu Price (incl. ${(vat * 100).toFixed(0)}% VAT)`, value: price ? `NPR ${(price * (1 + vat)).toFixed(0)}` : '—' },
          { label: 'Food Cost %', value: fcPct != null ? `${fcPct.toFixed(1)}%` : '—' },
          { label: 'Gross Margin %', value: fcPct != null ? `${(100 - fcPct).toFixed(1)}%` : '—' },
        ]).map(m => (
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
        const trueCost = cost + ohPer
        const trueMargin = price > 0 ? ((price - trueCost) / price) * 100 : null
        // Targets a 30% true margin (true cost = 70% of price) — matches Recipes.js's detail view.
        const suggested = Math.ceil(((trueCost / 0.70) * (1 + vat)) / 5) * 5
        return (
          <div style={{ marginTop: 16, padding: '10px 12px', border: '1px solid #ccc', borderRadius: 3 }}>
            <div style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.1em', color: '#555', marginBottom: 8 }}>True Cost with Overheads</div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12 }}>
              {[
                { label: 'Overhead / Portion', value: `NPR ${ohPer.toFixed(2)}` },
                { label: 'True Cost / Portion', value: `NPR ${trueCost.toFixed(2)}` },
                { label: 'True Net Margin %', value: trueMargin != null ? `${trueMargin.toFixed(1)}%` : '—' },
                { label: 'Suggested @ 30% Margin', value: `NPR ${suggested}` },
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
        <span>Generated by Crest Suite · {new Date().toLocaleDateString('en-NP')}</span>
      </div>
    </div>
  )
}
