// Menu Engineering Matrix — the quadrants this report freezes must always agree with what the
// live Menu Engineering page shows for the same period.
//
// It used to say so in a comment and then keep its OWN copy of `classify()`, `median()` and
// `FC_CUTOFF`, "mirrored verbatim". S715 replaced the copy with the real thing: both files import
// `shared/menuEngineering.js`, so the two cannot drift — which matters more here than anywhere,
// because this section is FROZEN. A quadrant snapshotted wrong stays wrong for good, and nothing
// in the artifact says which of the two definitions produced it.
//
// Still read-only: deliberately does NOT port MenuEngineering.js's recipes.me_class write-back (a
// live POS-suggestion-engine side effect) — a report generator run on an arbitrary historical
// period must never overwrite the CURRENT live classification with whatever period happens to be
// regenerated last. The live page now applies that same rule to itself (it writes only from the
// open/latest period), which is where this reasoning came from in the first place.
import { supabase } from '../../supabaseClient'
import { scopedFrom } from '../../shared/scopedDb'
import { fetchAllRows } from '../../shared/fetchAllRows'
import { throwFirstError } from '../../shared/queryError'
import { computeRecipeCosts } from '../../utils/recipeCost'
import {
  FC_CUTOFF, classify, median, menuFcPct, unratedReason, emptyQuadrantCounts,
} from '../../shared/menuEngineering'
import { recipeCostOf } from '../../shared/imsFormulas'
import { isCostedByBuild, BYO_REASON } from '../ims/recipes/buildYourOwnRating'

// RECIPES-1 (S792, settled by precedent): a build-your-own dish is "Not rated — costed by build".
// Its recipe holds only the fixed part (the bowl and the spoon); the plate is the guest's choices,
// priced as a range on Recipe Costing (buildCost.js). Rated on the fixed part, an acai bowl at
// NPR 8 against NPR 300 read 2.7% food cost and froze into the snapshot as a Star — "keep, feature
// prominently" — on a plate that really costs about half its price. The rule is the live menu
// reports' own (`isCostedByBuild`, buildYourOwnRating.js): only while Crest Customization is on,
// since with it off the till sells the dish plain and Recipe Costing costs it like any other. The
// dish is listed, unrated, with that file's reason, and stays in the popularity median like every
// other unrated dish.

export async function computeMenuEngineeringSection(clientId, period) {
  const results = await Promise.all([
    // Is Crest Customization on for this client — the gate on the build-your-own rule. The CLIENT's
    // flags, not the viewer's: the live page's `customizationEnabled` is also true for any admin,
    // and a frozen report must not depend on who generated it. `clients` stays on raw supabase.from
    // (CLAUDE.md), and `.single()` so a failed or empty read fails the section rather than
    // defaulting to "off" and freezing bowls as Stars.
    supabase.from('clients').select('pos_enabled, customization_enabled').eq('id', clientId).single(),
    // Both NULL-safe (S714). Both columns are nullable and a server-side .neq drops NULL rows,
    // so an uncategorised dish was absent from the matrix — and this section is FROZEN into the
    // monthly snapshot, so it was absent permanently, with no way to tell from the artifact.
    scopedFrom('recipes', clientId, 'id, name, category, selling_price, cost_price, is_build_your_own')
      .not('is_active', 'is', false).or('category.is.null,category.neq.Sub-Recipe'),
    // `source` is selected and comps are dropped in JS (S792, FIGURES-8). A server-side
    // `.neq('source', 'pos_comp')` also dropped every legacy NULL-source row, and this qty map sets
    // the period's MEDIAN — the popularity line — so a dropped row could move any dish into another
    // quadrant, permanently, in a frozen snapshot. The live page left the `.neq` in S715.
    fetchAllRows(() => supabase.from('sales_entries').select('recipe_id, qty_sold, unit_price, discount, source').eq('period_id', period.id).order('id')),
  ])
  // Throw on a failed read so runSection() names this section as failed instead of freezing a
  // matrix of all-Dogs into the immutable snapshot (S612).
  throwFirstError(results)
  const [{ data: client }, { data: recipes }, { data: sales }] = results
  // AuthContext's rule for the client's own module flag: Customization is sold on top of POS.
  const customizationEnabled = !!client?.pos_enabled && !!client?.customization_enabled

  const recipeIds = (recipes || []).map(r => r.id)
  const costMap = recipeIds.length > 0 ? await computeRecipeCosts(supabase, recipeIds) : {}

  return buildMenuEngineeringSection({ recipes, sales, costMap, customizationEnabled })
}

/**
 * Pure: the section from already-read rows, exported so the classification is tested without a
 * database. `sales` rows must carry `source` — comps are dropped here, in JS. `recipes` rows must
 * carry `is_build_your_own` and `category` for the build-your-own rule.
 */
export function buildMenuEngineeringSection({ recipes, sales, costMap, customizationEnabled = false }) {
  const salesData = (sales || []).filter(s => s.source !== 'pos_comp')

  const qtyMap = {}, revenueMap = {}
  ;(salesData || []).forEach(s => {
    qtyMap[s.recipe_id] = (qtyMap[s.recipe_id] || 0) + parseFloat(s.qty_sold || 0)
    const price = s.unit_price != null ? parseFloat(s.unit_price) : null
    if (price != null) revenueMap[s.recipe_id] = (revenueMap[s.recipe_id] || 0) + parseFloat(s.qty_sold || 0) * price - (parseFloat(s.discount) || 0)
  })

  const enriched = (recipes || []).map(r => {
    const sellingPrice = parseFloat(r.selling_price) || 0
    // `recipeCostOf` — the manual cost_price counts as a cost here exactly as it does on the
    // live page, or the same dish freezes as Unrated in the snapshot while Menu Engineering
    // rates it (S724). These two must never diverge; see MenuEngineering.js.
    const ingredientCost = recipeCostOf(costMap, r) || 0
    const qtySold = qtyMap[r.id] || 0
    // House style: prefer the row's own historical unit_price when present — same basis
    // computeImsSection.revenueTotal already uses. The live page reads this way too as of S715.
    const revenue = revenueMap[r.id] != null ? revenueMap[r.id] : qtySold * sellingPrice
    // A build-your-own dish's fixed cost is not its plate's cost (RECIPES-1): no food cost %, no
    // contribution, no quadrant. Its revenue and qty are real and stay.
    if (isCostedByBuild(r, customizationEnabled)) {
      return {
        recipeId: r.id, name: r.name, category: r.category, sellingPrice, ingredientCost, fcPct: null,
        byo: true, unrated: BYO_REASON,
        qtySold, revenue, contributionMargin: null, totalContribution: null,
      }
    }
    // null, not 0, when the dish has no price or no costed ingredients — a 0 here passed the
    // ≤35% test and froze an uncosted dish into the snapshot as a Star (S715).
    const fcPct = menuFcPct(ingredientCost, sellingPrice)
    const contributionMargin = sellingPrice - ingredientCost
    return {
      recipeId: r.id, name: r.name, category: r.category, sellingPrice, ingredientCost, fcPct,
      unrated: unratedReason(ingredientCost, sellingPrice),
      qtySold, revenue, contributionMargin, totalContribution: contributionMargin * qtySold,
    }
  })

  // The median spans every dish, rated or not, sold or not (S715) — build-your-own included.
  const medianQty = median(enriched.map(r => r.qtySold))
  // A BYO dish never reaches classify(): its fcPct is null, so it could only come back null anyway,
  // and saying so here keeps the rule from resting on that.
  const items = enriched.map(r => ({ ...r, quadrant: r.byo ? null : classify(r.fcPct, r.qtySold, medianQty) }))

  const quadrantCounts = emptyQuadrantCounts()
  items.forEach(i => { quadrantCounts[i.quadrant == null ? 'Unrated' : i.quadrant] += 1 })

  const topByRevenue = [...items].sort((a, b) => b.revenue - a.revenue).slice(0, 10)
  // A contribution computed on the bowl-and-spoon cost is nearly the whole price; keep BYO out.
  const topByContribution = items.filter(i => i.totalContribution != null)
    .sort((a, b) => b.totalContribution - a.totalContribution).slice(0, 10)
  const dogs = items.filter(i => i.quadrant === 'Dog').sort((a, b) => a.totalContribution - b.totalContribution).slice(0, 10)
  // Listed by name so the report can say which dishes it did not rate and why (schema v9).
  const byoItems = items.filter(i => i.byo).map(i => ({ recipeId: i.recipeId, name: i.name, qtySold: i.qtySold, revenue: i.revenue }))

  return { fcCutoffPct: FC_CUTOFF, medianQty, quadrantCounts, items, topByRevenue, topByContribution, dogs, byoCount: byoItems.length, byoItems }
}
