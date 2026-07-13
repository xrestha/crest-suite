import { useEffect, useState, useCallback, useMemo } from 'react'
import { useAuth } from '../../../context/AuthContext'
import { useSettings } from '../../../context/SettingsContext'
import { useScopedDb } from '../../../shared/hooks/useScopedDb'
import { supabase } from '../../../supabaseClient'
import Tip from '../../../components/Tip'
import Fab from '../../../components/Fab'
import SearchableSelect from '../../../components/SearchableSelect'
import { NUTRIENTS, calcRecipeNutrition, calcLiveNutrition, hasNutrition } from '../../../utils/nutrition'
import { getSuggestedPrice } from '../../../utils/recipeCost'
import { printWithTitle } from '../../../utils/printTitle'
import { suggestSeeds } from '../../../data/nutritionSeed'
import { fetchUsdaNutrition } from '../../../utils/usdaNutrition'
import { EMPTY_RECIPE, fmtNutrient, vatOf, calcSubRecipeCostPerUnit, calcRecipeCost, calcLiveCost, recipeHasIngredient } from './recipeCostCalc'
import RecipeCostCardPrint from './RecipeCostCardPrint'
import RecipeImportButton from './RecipeImportButton'
import NutritionEditorModal from './NutritionEditorModal'

export default function Recipes() {
  const { clientId, hasFeature, isAdmin } = useAuth()
  const showNutrition = hasFeature('nutrition_facts')
  const { settings, recipeCategories } = useSettings()
  const { scopedFrom, scopedInsert, scopedUpdate, scopedDelete } = useScopedDb()
  const [recipes, setRecipes] = useState([])
  const [overheadData, setOverheadData] = useState(null) // { totalOverheads, totalCovers, openPeriodId } | null
  const [items, setItems] = useState([])
  const [loading, setLoading] = useState(true)
  const [view, setView] = useState('list') // list | edit | detail
  const [selectedRecipe, setSelectedRecipe] = useState(null)
  const [recipeForm, setRecipeForm] = useState(EMPTY_RECIPE)
  const [ingredients, setIngredients] = useState([{ _key: Date.now(), item_id: '', sub_recipe_id: '', qty_per_portion: '', type: 'item' }])
  const [saving, setSaving] = useState(false)
  const [fcPctSaved, setFcPctSaved] = useState(null) // null = new recipe; string = DB value
  const [fcPctSaving, setFcPctSaving] = useState(false)
  const [error, setError] = useState('')
  const [search, setSearch] = useState('')
  const [ingSearch, setIngSearch] = useState('')
  const [printRecipe, setPrintRecipe] = useState(null)
  const filterCat = 'all' // no active UI to change this; filter always passes through
  const [fcFilter, setFcFilter] = useState('all')

  // ── Inline per-ingredient nutrition editor (saves to items.nutrition) ──
  const [nutriItemId, setNutriItemId] = useState(null)
  const [autoFillBusy, setAutoFillBusy] = useState(false)
  // Ingredients with no match in the regional library after the last Auto-fill run — USDA
  // FoodData Central is a live, US-sourced API and deliberately NOT queried automatically;
  // it's offered as a separate, explicit action once the user sees exactly which items missed.
  const [usdaCandidates, setUsdaCandidates] = useState([])
  const [usdaFillBusy, setUsdaFillBusy] = useState(false)
  const [nutriStatus, setNutriStatus] = useState(null) // { text } | null — result banner for auto-fill runs

  const init = useCallback(async () => {
    if (!clientId) return
    setLoading(true)
    const [{ data: r }, { data: i }] = await Promise.all([
      scopedFrom('recipes').order('name'),
      scopedFrom('items').eq('is_active', true).eq('is_sub_recipe', false).order('name')
    ])

    // Fetch ingredients separately — scoped to this client's recipe IDs
    const recipeIds = (r || []).map(x => x.id)
    const { data: ings } = recipeIds.length > 0
      ? await supabase.from('recipe_ingredients').select('*, items(name, uom, per_uom_rate, item_code, yield_pct, nutrition)').in('recipe_id', recipeIds)
      : { data: [] }

    // Attach ingredients to recipes
    const allRecipes = (r || []).map(recipe => ({
      ...recipe,
      recipe_ingredients: (ings || []).filter(ri => ri.recipe_id === recipe.id)
    }))

    // Manually attach sub_recipe data to each ingredient
    allRecipes.forEach(recipe => {
      (recipe.recipe_ingredients || []).forEach(ri => {
        if (ri.sub_recipe_id) {
          const sr = allRecipes.find(x => x.id === ri.sub_recipe_id)
          ri.sub_recipe = sr || null
        }
      })
    })

    setRecipes(allRecipes)
    setItems(i || [])

    // Fetch overhead + sales data for open period to power overhead panel
    const { data: periods } = await scopedFrom('monthly_periods', 'id')
      .eq('status', 'open')
      .limit(1)
    const openPeriodId = periods?.[0]?.id || null

    if (openPeriodId) {
      const [{ data: ohRows }, { data: salesRows }] = await Promise.all([
        scopedFrom('overheads', 'amount').eq('period_id', openPeriodId).eq('bucket', 'overhead'),
        supabase.from('sales_entries').select('qty_sold').eq('period_id', openPeriodId)
      ])
      const totalOverheads = (ohRows || []).reduce((s, o) => s + parseFloat(o.amount || 0), 0)
      const totalCovers = (salesRows || []).reduce((s, se) => s + parseFloat(se.qty_sold || 0), 0)
      if (totalOverheads > 0 && totalCovers > 0) {
        setOverheadData({ totalOverheads, totalCovers, openPeriodId })
      } else {
        setOverheadData(null)
      }
    } else {
      setOverheadData(null)
    }

    setLoading(false)
  }, [clientId, scopedFrom])

  useEffect(() => { if (clientId) init() }, [clientId, init])

  useEffect(() => {
    if (!printRecipe) return
    const t = setTimeout(() => { printWithTitle(`Recipe Cost Card - ${printRecipe.name}`); setPrintRecipe(null) }, 80)
    return () => clearTimeout(t)
  }, [printRecipe])

  // Sub-recipes available as ingredients (all recipes with category Sub-Recipe)
  const subRecipes = recipes.filter(r => r.category === 'Sub-Recipe')

  // Options for the searchable ingredient/sub-recipe pickers
  const itemOptions = useMemo(() => items.map(i => ({ value: i.id, label: i.name })), [items])
  const subRecipeOptions = useMemo(
    () => subRecipes.filter(sr => sr.id !== selectedRecipe?.id).map(sr => ({ value: sr.id, label: `⚙ ${sr.name} (${sr.yield_qty} ${sr.yield_uom})` })),
    [subRecipes, selectedRecipe]
  )

  // ── Form helpers ──────────────────────────────────────────────
  function openNew() {
    setSelectedRecipe(null)
    setRecipeForm(EMPTY_RECIPE)
    setIngredients([{ _key: Date.now(), item_id: '', sub_recipe_id: '', qty_per_portion: '', type: 'item' }])
    setFcPctSaved(null)
    setUsdaCandidates([])
    setError('')
    setView('edit')
  }

  function openEdit(recipe) {
    setSelectedRecipe(recipe)
    const fcVal = recipe.target_fc_pct ? String(recipe.target_fc_pct) : '30'
    setRecipeForm({
      name: recipe.name,
      category: recipe.category || 'Food',
      selling_price: recipe.selling_price || '',
      vat_rate: (recipe.vat_rate === null || recipe.vat_rate === undefined) ? '0.13' : String(recipe.vat_rate),
      yield_qty: recipe.yield_qty || '1',
      yield_uom: recipe.yield_uom || 'portion',
      target_fc_pct: fcVal,
      description: recipe.description || '',
      image_url: recipe.image_url || '',
      is_veg: recipe.is_veg === true ? 'veg' : recipe.is_veg === false ? 'non_veg' : ''
    })
    setFcPctSaved(fcVal)
    const ings = (recipe.recipe_ingredients || []).map(ri => ({
      _key: ri.id,
      item_id: ri.item_id || '',
      sub_recipe_id: ri.sub_recipe_id || '',
      qty_per_portion: ri.qty_per_portion,
      type: ri.sub_recipe_id ? 'sub_recipe' : 'item'
    }))
    setIngredients(ings.length > 0 ? ings : [{ _key: Date.now(), item_id: '', sub_recipe_id: '', qty_per_portion: '', type: 'item' }])
    setUsdaCandidates([])
    setError('')
    setView('edit')
  }

  function openDetail(recipe) {
    setSelectedRecipe(recipe)
    setView('detail')
  }

  async function saveFcPct() {
    if (!selectedRecipe?.id) return
    setFcPctSaving(true)
    const newVal = parseFloat(recipeForm.target_fc_pct) || 30
    const { error } = await scopedUpdate('recipes', { target_fc_pct: newVal })
      .eq('id', selectedRecipe.id)
    if (!error) {
      const strVal = String(newVal)
      setFcPctSaved(strVal)
      setSelectedRecipe(r => ({ ...r, target_fc_pct: newVal }))
      setRecipes(rs => rs.map(r => r.id === selectedRecipe.id ? { ...r, target_fc_pct: newVal } : r))
    }
    setFcPctSaving(false)
  }

  function addRow() {
    setIngredients(prev => [...prev, { _key: Date.now(), item_id: '', sub_recipe_id: '', qty_per_portion: '', type: 'item' }])
  }

  function removeRow(key) {
    setIngredients(prev => prev.filter(r => r._key !== key))
  }

  function updateIng(key, field, value) {
    setIngredients(prev => prev.map(r => r._key === key ? { ...r, [field]: value } : r))
  }

  function setIngType(key, type) {
    setIngredients(prev => prev.map(r => r._key === key ? { ...r, type, item_id: '', sub_recipe_id: '', qty_per_portion: '' } : r))
  }

  // ── Nutrition editor (per-ingredient modal, see NutritionEditorModal.jsx) ──
  const nutriItem = items.find(i => i.id === nutriItemId) || null

  function handleNutriSaved(itemId, payload) {
    // Reflect immediately in local state so the live label + detail panel recompute.
    setItems(prev => prev.map(i => i.id === itemId ? { ...i, nutrition: payload } : i))
    setRecipes(prev => prev.map(r => ({
      ...r,
      recipe_ingredients: (r.recipe_ingredients || []).map(ri =>
        ri.item_id === itemId && ri.items ? { ...ri, items: { ...ri.items, nutrition: payload } } : ri)
    })))
    setNutriItemId(null)
  }

  // ── Auto-fill all ingredients' nutrition from the static library (best match) ──
  function seedToNutrition(seed, uom) {
    const out = {
      basis_qty: 100, basis_unit: seed.unit || uom || 'GM',
      energy_kcal: seed.energy_kcal, protein_g: seed.protein_g, carbs_g: seed.carbs_g,
      fat_g: seed.fat_g, sugar_g: seed.sugar_g, sodium_mg: seed.sodium_mg,
      source: seed.source,
    }
    if (seed.allergens) out.allergens = seed.allergens
    return out
  }

  // Applies a set of { it, payload } targets to items.nutrition and reflects the change
  // into local items/recipes state so the live label + coverage recompute immediately.
  async function saveNutritionTargets(targets) {
    const results = await Promise.all(
      targets.map(t => supabase.from('items').update({ nutrition: t.payload }).eq('id', t.it.id).then(r => ({ id: t.it.id, payload: t.payload, error: r.error })))
    )
    const okMap = {}
    let failed = 0
    results.forEach(r => { if (r.error) failed++; else okMap[r.id] = r.payload })

    setItems(prev => prev.map(i => okMap[i.id] ? { ...i, nutrition: okMap[i.id] } : i))
    setRecipes(prev => prev.map(r => ({
      ...r,
      recipe_ingredients: (r.recipe_ingredients || []).map(ri =>
        ri.item_id && okMap[ri.item_id] && ri.items ? { ...ri, items: { ...ri.items, nutrition: okMap[ri.item_id] } } : ri)
    })))
    return { filled: Object.keys(okMap).length, failed }
  }

  // Regional library only (DFTQC Nepal / IFCT 2017 / USDA rows already in NUTRITION_SEED).
  // Deliberately does NOT reach for the live USDA FoodData Central API on a miss — that's a
  // separate, explicit action (fillFromUsda) once the user sees exactly which items missed.
  async function autoFillNutrition() {
    setAutoFillBusy(true)

    const seen = new Set()
    const seedTargets = []
    const unmatchedItems = []
    ingredients.forEach(ing => {
      if (ing.type !== 'item' || !ing.item_id || seen.has(ing.item_id)) return
      seen.add(ing.item_id)
      const it = items.find(i => i.id === ing.item_id)
      if (!it || hasNutrition(it.nutrition)) return
      const best = suggestSeeds(it.name)[0]
      if (best) seedTargets.push({ it, payload: seedToNutrition(best, it.uom) })
      else unmatchedItems.push(it)
    })

    setAutoFillBusy(false)
    setUsdaCandidates(unmatchedItems)

    if (seedTargets.length === 0) {
      setNutriStatus({ text: unmatchedItems.length
        ? `No regional library match for ${unmatchedItems.length} ingredient(s): ${unmatchedItems.map(i => i.name).join(', ')}. Try USDA FoodData Central below, or add nutrition manually.`
        : 'All ingredients already have nutrition data.' })
      return
    }

    const msg = `Auto-fill nutrition for ${seedTargets.length} ingredient(s) from the regional library (DFTQC Nepal / IFCT 2017 / USDA)?`
      + (unmatchedItems.length ? `\n\n${unmatchedItems.length} have no local match: ${unmatchedItems.map(i => i.name).join(', ')}. Left for manual entry or a separate USDA lookup.` : '')
      + `\n\nValues are reference estimates — you can edit any afterward.`
    if (!window.confirm(msg)) return

    setAutoFillBusy(true)
    const { filled, failed } = await saveNutritionTargets(seedTargets)
    setAutoFillBusy(false)

    setNutriStatus({ text: `Filled ${filled} ingredient(s) from the regional library.`
      + (failed ? ` ${failed} failed to save.` : '')
      + (unmatchedItems.length ? ` ${unmatchedItems.length} still need nutrition data (no local match): ${unmatchedItems.map(i => i.name).join(', ')}.` : '') })
  }

  // Explicit, separate step — a live call to USDA FoodData Central, only for ingredients the
  // regional library missed, and only when the user asks for it (never automatic).
  async function fillFromUsda() {
    if (usdaCandidates.length === 0) return
    setUsdaFillBusy(true)
    const results = await Promise.all(
      usdaCandidates.map(async it => ({ it, payload: await fetchUsdaNutrition(it.name) }))
    )
    const usdaTargets = results.filter(r => r.payload)
    const stillUnmatched = results.filter(r => !r.payload).map(r => r.it.name)
    setUsdaFillBusy(false)

    if (usdaTargets.length === 0) {
      setNutriStatus({ text: `No USDA FoodData Central match found for: ${stillUnmatched.join(', ')}. Add these manually.` })
      setUsdaCandidates([])
      return
    }

    const msg = `Fetch nutrition from USDA FoodData Central for ${usdaTargets.length} ingredient(s)?\n${usdaTargets.map(t => t.it.name).join(', ')}`
      + (stillUnmatched.length ? `\n\nNo USDA match for: ${stillUnmatched.join(', ')} — add these manually.` : '')
      + `\n\nUSDA values are US-sourced estimates — verify against a regional source for local dishes if possible.`
    if (!window.confirm(msg)) return

    setUsdaFillBusy(true)
    const { filled, failed } = await saveNutritionTargets(usdaTargets)
    setUsdaFillBusy(false)
    setUsdaCandidates([])

    setNutriStatus({ text: `Filled ${filled} ingredient(s) from USDA FoodData Central.` + (failed ? ` ${failed} failed to save.` : '') })
  }

  function dismissUsdaCandidates() { setUsdaCandidates([]) }

  function getNextSubRecipeCode() {
    const SRC_PREFIX = (settings?.sub_recipe_code_prefix || 'SRC').toUpperCase()
    let maxNum = 0
    recipes.filter(r => r.category === 'Sub-Recipe').forEach(r => {
      const match = (r.recipe_code || '').match(new RegExp(`^${SRC_PREFIX}-(\\d+)$`))
      if (match) maxNum = Math.max(maxNum, parseInt(match[1], 10))
    })
    return `${SRC_PREFIX}-${String(maxNum + 1).padStart(3, '0')}`
  }

  async function save() {
    // Guard: never persist a recipe without a client — a null client_id makes the
    // recipe invisible (the list query filters by client_id). This previously happened
    // when an admin saved before the viewed client had hydrated from localStorage.
    if (!clientId) { setError('No client selected. Pick a client in the top-left switcher before saving.'); return }
    if (!recipeForm.name.trim()) { setError('Recipe name is required.'); return }
    const validIngs = ingredients.filter(i =>
      (i.type === 'item' ? i.item_id : i.sub_recipe_id) && parseFloat(i.qty_per_portion) > 0
    )
    if (validIngs.length === 0) { setError('Add at least one ingredient with qty.'); return }

    // Cycle check — only possible when editing an EXISTING sub-recipe (a brand-new one can't yet
    // be referenced by anything else). The ingredient picker already blocks a sub-recipe from
    // listing itself directly (see subRecipeOptions above), but nothing stopped an INDIRECT cycle
    // (A contains B, then B is edited to contain A) — both edits individually looked fine, but
    // together they made every cost calculation over that pair recurse forever. Caught here at
    // save time instead of just surviving it at cost-calc time (calcSubRecipeCostPerUnit).
    if (selectedRecipe && recipeForm.category === 'Sub-Recipe') {
      const wouldCreateCycle = (targetId, subRecipeId, seen = new Set()) => {
        if (subRecipeId === targetId) return true
        if (seen.has(subRecipeId)) return false
        seen.add(subRecipeId)
        const sr = recipes.find(r => r.id === subRecipeId)
        return (sr?.recipe_ingredients || []).some(ri => ri.sub_recipe_id && wouldCreateCycle(targetId, ri.sub_recipe_id, seen))
      }
      const cyclic = validIngs.some(i => i.type === 'sub_recipe' && wouldCreateCycle(selectedRecipe.id, i.sub_recipe_id))
      if (cyclic) {
        setError('This would create a circular reference (this sub-recipe would end up containing itself through another sub-recipe). Remove that ingredient.')
        return
      }
    }

    setSaving(true)
    setError('')

    const isSubRecipe = recipeForm.category === 'Sub-Recipe'
    const payload = {
      name: recipeForm.name.trim(),
      category: recipeForm.category,
      selling_price: !isSubRecipe && recipeForm.selling_price ? parseFloat(recipeForm.selling_price) : null,
      vat_rate: (recipeForm.vat_rate === '' || recipeForm.vat_rate == null) ? 0.13 : parseFloat(recipeForm.vat_rate),
      yield_qty: parseFloat(recipeForm.yield_qty) || 1,
      yield_uom: recipeForm.yield_uom || 'portion',
      target_fc_pct: parseFloat(recipeForm.target_fc_pct) || 30,
      is_active: true,
      // Guest-facing QR menu fields — all optional, blank means "not shown" on that page.
      description: recipeForm.description.trim() || null,
      image_url: recipeForm.image_url.trim() || null,
      is_veg: recipeForm.is_veg === 'veg' ? true : recipeForm.is_veg === 'non_veg' ? false : null
    }

    let recipeId
    if (selectedRecipe) {
      const { error } = await scopedUpdate('recipes', payload).eq('id', selectedRecipe.id)
      if (error) { setError(error.message); setSaving(false); return }
      recipeId = selectedRecipe.id
    } else if (isSubRecipe) {
      // getNextSubRecipeCode() computes from in-memory state, not a DB sequence — a genuine
      // collision (two tabs, a fast double-click) is now caught by a per-client unique index on
      // recipe_code instead of silently succeeding twice. Retry with a freshly recomputed code a
      // few times before giving up, rather than surfacing a raw constraint-violation error.
      let data, error
      for (let attempt = 0; attempt < 3; attempt++) {
        payload.recipe_code = getNextSubRecipeCode()
        ;({ data, error } = await scopedInsert('recipes', payload, { single: true }))
        if (!error || error.code !== '23505') break
      }
      if (error) { setError(error.message); setSaving(false); return }
      recipeId = data.id
    } else {
      const { data, error } = await scopedInsert('recipes', payload, { single: true })
      if (error) { setError(error.message); setSaving(false); return }
      recipeId = data.id
    }

    const ingPayload = validIngs.map(ing => ({
      recipe_id: recipeId,
      item_id: ing.type === 'item' ? ing.item_id : null,
      sub_recipe_id: ing.type === 'sub_recipe' ? ing.sub_recipe_id : null,
      qty_per_portion: parseFloat(ing.qty_per_portion)
    }))

    // Insert the new ingredient rows BEFORE removing the old ones (not delete-then-insert) — if
    // the insert fails partway (network blip, an ingredient's item/sub-recipe deleted mid-edit),
    // the recipe keeps its previous, still-valid ingredient list instead of being left with zero.
    const { data: insertedIngs, error: ingError } = await supabase.from('recipe_ingredients').insert(ingPayload).select('id')
    if (ingError) { setError(ingError.message); setSaving(false); return }
    if (selectedRecipe) {
      const newIds = (insertedIngs || []).map(r => r.id)
      await supabase.from('recipe_ingredients').delete().eq('recipe_id', recipeId).not('id', 'in', `(${newIds.join(',')})`)
    }

    if (isSubRecipe) {
      const cpu = liveCost / (parseFloat(recipeForm.yield_qty) || 1)
      const uom = recipeForm.yield_uom || 'portion'
      // Ensure "Sub-Recipes" category exists
      let srCategoryId = null
      const { data: existingCat } = await scopedFrom('categories', 'id').eq('name', 'Sub-Recipes').maybeSingle()
      if (existingCat) {
        srCategoryId = existingCat.id
      } else {
        const { data: newCat, error: catErr } = await scopedInsert('categories', { name: 'Sub-Recipes', sort_order: 999 }, { single: true })
        if (catErr) { setError('SR sync — category create failed: ' + catErr.message); setSaving(false); return }
        srCategoryId = newCat?.id || null
      }

      const itemPayload = {
        name: recipeForm.name.trim().toUpperCase(),
        uom,
        category_id: srCategoryId,
        purchase_qty: 1,
        rate: parseFloat(cpu.toFixed(4)),
        is_active: true,
        is_sub_recipe: true,
      }

      const existingLinkedId = selectedRecipe?.linked_item_id
      let linkedItemId = existingLinkedId
      if (existingLinkedId) {
        const { error: updateErr } = await scopedUpdate('items', itemPayload).eq('id', existingLinkedId)
        if (updateErr) { setError('SR sync — item update failed: ' + updateErr.message); setSaving(false); return }
      } else {
        itemPayload.item_code = payload.recipe_code || selectedRecipe?.recipe_code || null
        const { data: newItem, error: insertErr } = await scopedInsert('items', itemPayload, { single: true })
        if (insertErr) { setError('SR sync — item insert failed: ' + insertErr.message); setSaving(false); return }
        linkedItemId = newItem?.id
      }
      if (linkedItemId) {
        await scopedUpdate('recipes', { linked_item_id: linkedItemId }).eq('id', recipeId)
      }
    } else if (selectedRecipe?.linked_item_id) {
      // This recipe WAS a sub-recipe (had a mirror item) but its category was just changed away
      // from "Sub-Recipe" — the sync block above only ever runs `if (isSubRecipe)`, so without
      // this the mirror row in `items` stayed is_active/is_sub_recipe=true forever, frozen at its
      // last cost, orphaned from the recipe that used to own it.
      await scopedUpdate('items', { is_active: false }).eq('id', selectedRecipe.linked_item_id)
      await scopedUpdate('recipes', { linked_item_id: null }).eq('id', recipeId)
    }

    await init()
    setSaving(false)
    setView('list')
  }

  async function deleteRecipe(recipe) {
    // A sub-recipe can be an ingredient of other recipes (recipe_ingredients.sub_recipe_id) —
    // deleting it without checking left those rows pointing at a now-gone id; init()'s join
    // resolves ri.sub_recipe to null for them, and calcRecipeCost/calcSubRecipeCostPerUnit
    // silently skip any ingredient row where sub_recipe_id is set but sub_recipe isn't — the
    // parent recipe's food cost quietly dropped with no warning. Block the delete instead.
    const { data: referencing } = await supabase
      .from('recipe_ingredients')
      .select('recipe_id, recipes!recipe_ingredients_recipe_id_fkey(name)')
      .eq('sub_recipe_id', recipe.id)
    const usedByNames = [...new Set((referencing || []).map(r => r.recipes?.name).filter(Boolean))]
    if (usedByNames.length > 0) {
      setError(`Can't delete "${recipe.name}" — it's used as an ingredient in: ${usedByNames.join(', ')}. Remove it from those recipes first.`)
      return
    }

    if (!window.confirm(`Delete "${recipe.name}"?`)) return
    await supabase.from('recipe_ingredients').delete().eq('recipe_id', recipe.id)
    if (recipe.linked_item_id) {
      await scopedUpdate('items', { is_active: false }).eq('id', recipe.linked_item_id)
    }
    const { error } = await scopedDelete('recipes').eq('id', recipe.id)
    if (error) { setError('Delete failed — ' + error.message); return }
    init()
  }

  // ── Derived values for edit form ──────────────────────────────
  const isSubRecipeForm = recipeForm.category === 'Sub-Recipe'
  const liveCost = calcLiveCost(ingredients, items, recipes)
  const livePrice = parseFloat(recipeForm.selling_price) || 0
  const liveVat = (recipeForm.vat_rate === '' || recipeForm.vat_rate == null) ? 0.13 : parseFloat(recipeForm.vat_rate)
  const liveFcPct = livePrice > 0 ? (liveCost / livePrice) * 100 : null
  const livePriceWithVat = livePrice * (1 + liveVat)
  const liveFcTarget = (parseFloat(recipeForm.target_fc_pct) || 30) / 100
  const suggestedPrice = liveCost > 0 && !isSubRecipeForm ? getSuggestedPrice(liveCost, liveVat, liveFcTarget) : null
  const liveYieldQty = parseFloat(recipeForm.yield_qty) || 1
  const liveCostPerUnit = isSubRecipeForm && liveYieldQty > 0 ? liveCost / liveYieldQty : null
  const liveNutri = showNutrition ? calcLiveNutrition(ingredients, items, recipes) : null

  // ── Tab state ─────────────────────────────────────────────────
  const [activeTab, setActiveTab] = useState('all')

  // ── Filtered list ─────────────────────────────────────────────
  const fcWarn = settings.fc_warning_pct || 35
  const fcCrit = settings.fc_critical_pct || 45
  const ingQ = ingSearch.trim().toLowerCase()
  const filtered = recipes.filter(r => {
    const matchSearch = r.name.toLowerCase().includes(search.toLowerCase())
    const matchCat = filterCat === 'all' || r.category === filterCat
    const matchIngredient = !ingQ || recipeHasIngredient(r, ingQ, recipes)
    const matchFC = (() => {
      if (fcFilter === 'all') return true
      const cost = calcRecipeCost(r, recipes)
      const price = parseFloat(r.selling_price) || 0
      const fcPct = price > 0 ? (cost / price) * 100 : null
      if (fcPct == null) return false
      if (fcFilter === 'good')  return fcPct <= fcWarn
      if (fcFilter === 'watch') return fcPct > fcWarn && fcPct <= fcCrit
      if (fcFilter === 'high')  return fcPct > fcCrit
      return true
    })()
    return matchSearch && matchCat && matchIngredient && matchFC
  })

  const regularRecipes = filtered.filter(r => r.category !== 'Sub-Recipe')
  const subRecipeList = filtered.filter(r => r.category === 'Sub-Recipe')

  // Build tab list: user-defined order first, then any orphaned categories (recipes tagged with a removed category)
  const usedCats = [...new Set(recipes.filter(r => r.category !== 'Sub-Recipe').map(r => r.category))]
  const presentCats = [
    ...recipeCategories.filter(c => usedCats.includes(c)),
    ...usedCats.filter(c => !recipeCategories.includes(c)),
  ]
  const tabs = [
    { key: 'all', label: 'All Recipes', count: regularRecipes.length },
    ...presentCats.map(c => ({
      key: c,
      label: c,
      count: filtered.filter(r => r.category === c).length
    })),
    { key: 'sub-recipes', label: '⚙ Sub-Recipes', count: subRecipeList.length },
  ]

  const tabFiltered = activeTab === 'all'
    ? regularRecipes
    : activeTab === 'sub-recipes'
      ? subRecipeList
      : filtered.filter(r => r.category === activeTab)

  return (
    <div>
      {/* Header */}
      <div className={`page-header${(view === 'detail' || printRecipe) ? ' no-print' : ''}`} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <div>
          <h1 className="page-title">Recipe Costing</h1>
          <p className="page-subtitle">
            {view === 'list' && `${recipes.filter(r=>r.category!=='Sub-Recipe').length} recipes · ${subRecipes.length} sub-recipes`}
            {view === 'edit' && (selectedRecipe ? `Editing: ${selectedRecipe.name}` : 'New Recipe')}
            {view === 'detail' && selectedRecipe?.name}
          </p>
        </div>
        <div style={{ display: 'flex', gap: 10 }}>
          {view === 'edit' && <button className="btn btn-ghost" onClick={() => setView('list')}>← Back</button>}
        </div>
      </div>

      {/* ── LIST VIEW ── */}
      {view === 'list' && (
        <div className={printRecipe ? 'no-print' : ''}>
          {/* Search bar */}
          <div style={{ display: 'flex', gap: 12, marginBottom: 16, alignItems: 'center' }}>
            <input
              style={{ background: 'var(--theme-card)', border: '1px solid var(--theme-border)', borderRadius: 6, padding: '8px 12px', fontSize: 13, color: 'var(--theme-text1)', outline: 'none', width: 240 }}
              placeholder="Search recipes…" value={search} onChange={e => setSearch(e.target.value)} />
            <RecipeImportButton items={items} subRecipes={subRecipes} recipes={recipes} clientId={clientId} scopedInsert={scopedInsert} onImported={init} isAdmin={isAdmin} />
            <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 6 }}>
              <Tip text="Find every recipe that uses an ingredient — e.g. type 'milk' to list all dishes containing it. Also matches ingredients hidden inside sub-recipes (e.g. 'coffee' finds a Flat White via its Doppio)." width={300}>
                <span style={{ fontSize: 13, color: 'var(--theme-text2)' }}>ⓘ</span>
              </Tip>
              <div style={{ position: 'relative' }}>
                <input
                  style={{ background: 'var(--theme-card)', border: `1px solid ${ingQ ? 'rgba(201,168,76,0.5)' : 'var(--theme-border)'}`, borderRadius: 6, padding: '8px 12px 8px 30px', fontSize: 13, color: 'var(--theme-text1)', outline: 'none', width: 260 }}
                  placeholder="Find ingredient in recipes…" value={ingSearch} onChange={e => setIngSearch(e.target.value)} />
                <span style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', fontSize: 13, color: 'var(--theme-text2)', pointerEvents: 'none' }}>🔍</span>
                {ingSearch && (
                  <button onClick={() => setIngSearch('')} title="Clear"
                    style={{ position: 'absolute', right: 6, top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', color: 'var(--theme-text3)', cursor: 'pointer', fontSize: 15, lineHeight: 1, padding: '0 4px' }}>×</button>
                )}
              </div>
            </div>
          </div>
          {ingQ && (
            <div style={{ fontSize: 12, color: 'var(--theme-accent)', margin: '-8px 0 14px' }}>
              Showing recipes that use an ingredient matching "<strong>{ingSearch}</strong>" ({filtered.length} found).
            </div>
          )}

          {/* FC% filter pills */}
          <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginBottom: 14 }}>
            <span style={{ fontSize: 11, color: 'var(--theme-text3)', textTransform: 'uppercase', letterSpacing: '0.08em', marginRight: 2, flexShrink: 0 }}>FC %</span>
            {[
              { key: 'all',   label: 'All',                                  color: null },
              { key: 'good',  label: `✓  ≤${fcWarn}%`,                      color: 'var(--theme-green)' },
              { key: 'watch', label: `⚠  ${fcWarn}–${fcCrit}%`,             color: 'var(--theme-accent)' },
              { key: 'high',  label: `✗  >${fcCrit}%`,                      color: 'var(--theme-red)' },
            ].map(pill => (
              <button
                key={pill.key}
                onClick={() => setFcFilter(pill.key)}
                className={`tab-btn${fcFilter === pill.key ? ' tab-btn--active' : ''}`}
                style={fcFilter === pill.key && pill.color ? { color: pill.color, borderColor: pill.color } : {}}
              >
                {pill.label}
              </button>
            ))}
          </div>

          {/* Tab bar */}
          <div style={{ display: 'flex', gap: 2, marginBottom: 0, borderBottom: '1px solid var(--theme-border)' }}>
            {tabs.map(tab => {
              const isActive = activeTab === tab.key
              const isSubTab = tab.key === 'sub-recipes'
              return (
                <button
                  key={tab.key}
                  onClick={() => setActiveTab(tab.key)}
                  style={{
                    background: isActive ? 'var(--theme-border)' : 'transparent',
                    border: 'none',
                    borderBottom: isActive
                      ? `2px solid ${isSubTab ? 'var(--theme-accent)' : 'var(--theme-purple)'}`
                      : '2px solid transparent',
                    padding: '10px 16px',
                    fontSize: 13,
                    fontWeight: isActive ? 600 : 400,
                    color: isActive
                      ? (isSubTab ? 'var(--theme-accent)' : 'var(--theme-text1)')
                      : 'var(--theme-text2)',
                    cursor: 'pointer',
                    display: 'flex',
                    alignItems: 'center',
                    gap: 7,
                    transition: 'color 0.15s',
                    borderRadius: '6px 6px 0 0',
                    marginBottom: -1,
                  }}
                >
                  {tab.label}
                  <span style={{
                    background: isActive ? (isSubTab ? 'rgba(201,168,76,0.15)' : 'color-mix(in srgb, var(--theme-purple) 15%, transparent)') : 'var(--theme-border)',
                    color: isActive ? (isSubTab ? 'var(--theme-accent)' : 'var(--theme-purple)') : 'var(--theme-text3)',
                    borderRadius: 10,
                    fontSize: 11,
                    fontWeight: 600,
                    padding: '1px 7px',
                    minWidth: 20,
                    textAlign: 'center',
                  }}>
                    {tab.count}
                  </span>
                </button>
              )
            })}
          </div>

          {/* Tab content */}
          <div className="card" style={{ borderRadius: '0 6px 6px 6px', marginTop: 0 }}>
            {loading ? (
              <p style={{ color: 'var(--theme-text2)', fontSize: 13 }}>Loading…</p>
            ) : tabFiltered.length === 0 ? (
              <div className="empty-state">
                <div className="empty-state-icon">◈</div>
                <p className="empty-state-text">
                  {search
                    ? `No results for "${search}" in this tab.`
                    : activeTab === 'sub-recipes'
                      ? 'No sub-recipes yet. Create one by setting category to ⚙ Sub-Recipe.'
                      : 'No recipes yet. Click + New Recipe to build your first costed dish.'}
                </p>
              </div>
            ) : activeTab === 'sub-recipes' ? (
              /* ── Sub-recipes tab ── */
              <div className="table-wrap">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Code</th>
                      <th>Sub-Recipe</th>
                      <th>Ingredients</th>
                      <th style={{ textAlign: 'right' }}>Total Cost</th>
                      <th style={{ textAlign: 'right' }}>Yield</th>
                      <th style={{ textAlign: 'right' }}>Cost per Unit</th>
                      <th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {tabFiltered.map(recipe => {
                      const cost = calcRecipeCost(recipe, recipes)
                      const yieldQty = parseFloat(recipe.yield_qty) || 1
                      const costPerUnit = cost / yieldQty
                      return (
                        <tr key={recipe.id}>
                          <td style={{ color: 'var(--theme-accent)', fontFamily: 'monospace', fontSize: 12, whiteSpace: 'nowrap' }}>
                            {recipe.recipe_code || '—'}
                          </td>
                          <td style={{ fontWeight: 600, color: 'var(--theme-accent)', cursor: 'pointer' }} onClick={() => openDetail(recipe)}>
                            ⚙ {recipe.name}
                          </td>
                          <td style={{ color: 'var(--theme-text2)' }}>{(recipe.recipe_ingredients || []).length} items</td>
                          <td style={{ textAlign: 'right', color: 'var(--theme-accent)' }}>NPR {cost.toFixed(2)}</td>
                          <td style={{ textAlign: 'right', color: 'var(--theme-text2)' }}>{recipe.yield_qty} {recipe.yield_uom}</td>
                          <td style={{ textAlign: 'right', fontWeight: 700, color: 'var(--theme-text1)' }}>
                            NPR {costPerUnit.toFixed(2)} / {recipe.yield_uom}
                          </td>
                          <td style={{ textAlign: 'right' }}>
                            <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
                              <button className="btn btn-ghost" style={{ fontSize: 11, padding: '4px 8px' }} onClick={() => setPrintRecipe(recipe)}>🖶</button>
                              <button className="btn btn-ghost" style={{ fontSize: 11, padding: '4px 8px' }} onClick={() => openEdit(recipe)}>Edit</button>
                              <button className="btn btn-danger" style={{ fontSize: 11, padding: '4px 8px' }} onClick={() => deleteRecipe(recipe)}>Del</button>
                            </div>
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            ) : (
              /* ── Regular recipes tab (All / per-category) ── */
              <div className="table-wrap">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Recipe</th>
                      {activeTab === 'all' && <th>Category</th>}
                      <th>Ingredients</th>
                      <th style={{ textAlign: 'right' }}>Food Cost</th>
                      <th style={{ textAlign: 'right' }}><Tip text="Menu price ex-VAT (stored without VAT). VAT-inclusive price = selling price × (1 + VAT rate)." width={240}>Selling Price</Tip></th>
                      <th style={{ textAlign: 'right' }}><Tip text="Food Cost % = ingredient cost ÷ selling price. ≤30% excellent, 31–38% acceptable, >38% too high. Nepal F&B target: 28–35%." width={280}>FC %</Tip></th>
                      <th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {tabFiltered.map(recipe => {
                      const cost = calcRecipeCost(recipe, recipes)
                      const price = parseFloat(recipe.selling_price) || 0
                      const fcPct = price > 0 ? (cost / price) * 100 : null
                      const fcColor = fcPct == null ? 'var(--theme-text2)' : fcPct <= 30 ? 'var(--theme-green)' : fcPct <= 38 ? 'var(--theme-accent)' : 'var(--theme-red)'
                      const subIngCount = (recipe.recipe_ingredients || []).filter(ri => ri.sub_recipe_id).length
                      return (
                        <tr key={recipe.id}>
                          <td style={{ fontWeight: 600, color: 'var(--theme-text1)', cursor: 'pointer' }} onClick={() => openDetail(recipe)}>
                            {recipe.name}
                            {subIngCount > 0 && <span style={{ fontSize: 10, color: 'var(--theme-accent)', marginLeft: 6 }}>⚙ {subIngCount} sub</span>}
                          </td>
                          {activeTab === 'all' && <td><span className="badge badge-yellow">{recipe.category}</span></td>}
                          <td style={{ color: 'var(--theme-text2)' }}>{(recipe.recipe_ingredients || []).length} items</td>
                          <td style={{ textAlign: 'right', color: 'var(--theme-accent)' }}>NPR {cost.toFixed(2)}</td>
                          <td style={{ textAlign: 'right' }}>
                            {recipe.selling_price ? `NPR ${Number(recipe.selling_price).toFixed(2)}` : <span style={{ color: 'var(--theme-text3)' }}>—</span>}
                          </td>
                          <td style={{ textAlign: 'right', fontWeight: 700, color: fcColor }}>
                            {fcPct != null ? `${fcPct.toFixed(1)}%` : '—'}
                          </td>
                          <td style={{ textAlign: 'right' }}>
                            <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
                              <button className="btn btn-ghost" style={{ fontSize: 11, padding: '4px 8px' }} onClick={() => setPrintRecipe(recipe)}>🖶</button>
                              <button className="btn btn-ghost" style={{ fontSize: 11, padding: '4px 8px' }} onClick={() => openEdit(recipe)}>Edit</button>
                              <button className="btn btn-danger" style={{ fontSize: 11, padding: '4px 8px' }} onClick={() => deleteRecipe(recipe)}>Del</button>
                            </div>
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      )}

      {/* ── EDIT VIEW ── */}
      {view === 'edit' && (
        <div>
          {/* Recipe details */}
          <div className="card" style={{ marginBottom: 20 }}>
            <h3 style={{ margin: '0 0 18px', fontSize: 14, color: 'var(--theme-text2)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>Recipe Details</h3>
            <div style={{ display: 'grid', gridTemplateColumns: isSubRecipeForm ? '2fr 1fr 1fr 1fr' : '2fr 1fr 1fr 1fr', gap: 16 }}>
              <div className="form-field">
                <label>Recipe / Dish Name *</label>
                <input value={recipeForm.name} onChange={e => setRecipeForm(f => ({ ...f, name: e.target.value }))} placeholder="e.g. Mango Sticky Rice" autoFocus />
              </div>
              <div className="form-field">
                <label>Category</label>
                <select value={recipeForm.category} onChange={e => setRecipeForm(f => ({ ...f, category: e.target.value }))}>
                  {[...recipeCategories, 'Sub-Recipe'].map(c => <option key={c} value={c}>{c === 'Sub-Recipe' ? '⚙ Sub-Recipe / Prep Item' : c}</option>)}
                </select>
              </div>
              {isSubRecipeForm ? (
                <>
                  <div className="form-field">
                    <label><Tip text="How many units this batch produces (e.g. 1000 for 1L of sauce). Cost per unit = total cost ÷ yield qty." width={240}>Yield Quantity *</Tip></label>
                    <input type="number" value={recipeForm.yield_qty} onChange={e => setRecipeForm(f => ({ ...f, yield_qty: e.target.value }))} placeholder="e.g. 1000" />
                  </div>
                  <div className="form-field">
                    <label><Tip text="Unit for the batch output, e.g. ML, GM, PCS. Used when this sub-recipe is added as an ingredient elsewhere." width={260}>Yield UOM *</Tip></label>
                    <input value={recipeForm.yield_uom} onChange={e => setRecipeForm(f => ({ ...f, yield_uom: e.target.value }))} placeholder="e.g. ML, GM, PCS" />
                  </div>
                </>
              ) : (
                <>
                  <div className="form-field">
                    <label><Tip text="Enter the menu price. The system strips VAT and stores the ex-VAT price for accurate food cost calculation." width={280}>Menu Price (NPR{liveVat > 0 ? `, incl. ${(liveVat * 100).toFixed(0)}% VAT` : ', no VAT'})</Tip></label>
                    <div style={{ position: 'relative' }}>
                      <input
                        type="number"
                        key={`${recipeForm.selling_price ? 'has-price' : 'no-price'}-vat${recipeForm.vat_rate}`}
                        defaultValue={recipeForm.selling_price ? (parseFloat(recipeForm.selling_price) * (1 + liveVat)).toFixed(2) : ''}
                        onBlur={e => {
                          const rawPrice = parseFloat(e.target.value) || 0
                          const menuPrice = rawPrice > 0 ? Math.round(rawPrice) : 0
                          if (menuPrice !== rawPrice && e.target) e.target.value = menuPrice || ''
                          const vatRate = (recipeForm.vat_rate === '' || recipeForm.vat_rate == null) ? 0.13 : parseFloat(recipeForm.vat_rate)
                          const exVat = menuPrice > 0 ? (menuPrice / (1 + vatRate)).toFixed(4) : ''
                          setRecipeForm(f => ({ ...f, selling_price: exVat }))
                        }}
                        placeholder="e.g. 500"
                      />
                      {recipeForm.selling_price && (
                        <div style={{ fontSize: 11, color: 'var(--theme-text2)', marginTop: 4 }}>
                          {liveVat > 0 ? 'Ex-VAT stored' : 'Stored'}: NPR {parseFloat(recipeForm.selling_price).toFixed(2)}
                        </div>
                      )}
                    </div>
                  </div>
                  <div className="form-field">
                    <label><Tip text="Standard Nepal VAT is 13%. Set to 0% for VAT-exempt dishes (some raw food items).">VAT Rate</Tip></label>
                    <select value={recipeForm.vat_rate} onChange={e => setRecipeForm(f => ({ ...f, vat_rate: e.target.value }))}>
                      <option value="0.13">13% (VAT)</option>
                      <option value="0">0% (No VAT)</option>
                    </select>
                  </div>
                  <div className="form-field">
                    <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <Tip text="Target food cost % for this recipe. Used to compute the suggested menu price. Nepal F&B average: 28–35%." width={260}>Target FC %</Tip>
                      {fcPctSaved !== null && (
                        <span style={{ fontSize: 10, color: recipeForm.target_fc_pct !== fcPctSaved ? 'var(--theme-amber)' : 'var(--theme-green)', lineHeight: 1 }}>●</span>
                      )}
                    </label>
                    <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                      <input
                        type="number" min="1" max="100"
                        style={{ flex: 1 }}
                        value={recipeForm.target_fc_pct}
                        onChange={e => setRecipeForm(f => ({ ...f, target_fc_pct: e.target.value }))}
                        placeholder="30"
                      />
                      {fcPctSaved !== null && (
                        <button
                          onClick={saveFcPct}
                          disabled={recipeForm.target_fc_pct === fcPctSaved || fcPctSaving}
                          className="btn btn-ghost"
                          style={{ fontSize: 11, padding: '4px 10px', whiteSpace: 'nowrap' }}
                        >
                          {fcPctSaving ? 'Saving…' : 'Save'}
                        </button>
                      )}
                    </div>
                    {recipeForm.target_fc_pct && (
                      <div style={{ fontSize: 11, color: 'var(--theme-text2)', marginTop: 4 }}>
                        Suggested price targets {recipeForm.target_fc_pct}% food cost
                      </div>
                    )}
                  </div>
                </>
              )}
            </div>
            {!isSubRecipeForm && (
              <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 1fr', gap: 16, marginTop: 16 }}>
                <div className="form-field">
                  <label><Tip text="Optional — shown on the guest-facing QR menu (Table Management → Print QR). Leave blank to omit." width={280}>Description (guest menu)</Tip></label>
                  <input value={recipeForm.description} onChange={e => setRecipeForm(f => ({ ...f, description: e.target.value }))} placeholder="e.g. Grilled chicken breast, herb butter, seasonal veg" />
                </div>
                <div className="form-field">
                  <label><Tip text="Optional — a public image URL shown on the guest-facing QR menu. Paste a link to an already-hosted photo." width={280}>Photo URL (guest menu)</Tip></label>
                  <input value={recipeForm.image_url} onChange={e => setRecipeForm(f => ({ ...f, image_url: e.target.value }))} placeholder="https://..." />
                </div>
                <div className="form-field">
                  <label><Tip text="Optional — shows a veg/non-veg badge on the guest-facing QR menu. Leave unset to hide the badge for this item.">Veg / Non-Veg</Tip></label>
                  <select value={recipeForm.is_veg} onChange={e => setRecipeForm(f => ({ ...f, is_veg: e.target.value }))}>
                    <option value="">— Not set —</option>
                    <option value="veg">Veg</option>
                    <option value="non_veg">Non-Veg</option>
                  </select>
                </div>
              </div>
            )}
          </div>

          {/* Live cost panel */}
          {liveCost > 0 && (
            <div style={{
              background: 'rgba(201,168,76,0.06)', border: '1px solid rgba(201,168,76,0.2)',
              borderRadius: 8, padding: '16px 20px', marginBottom: 20,
              display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px,1fr))', gap: 16
            }}>
              <div>
                <div style={{ fontSize: 11, color: 'var(--theme-text2)', textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: 4 }}>
                  {isSubRecipeForm ? 'Total Batch Cost' : 'Food Cost'}
                </div>
                <div style={{ fontSize: 20, fontWeight: 700, color: 'var(--theme-accent)' }}>NPR {liveCost.toFixed(2)}</div>
              </div>
              {isSubRecipeForm && liveCostPerUnit != null && (
                <div>
                  <div style={{ fontSize: 11, color: 'var(--theme-text2)', textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: 4 }}>Cost per {recipeForm.yield_uom || 'unit'}</div>
                  <div style={{ fontSize: 20, fontWeight: 700, color: 'var(--theme-green)' }}>NPR {liveCostPerUnit.toFixed(2)}</div>
                  <div style={{ fontSize: 11, color: 'var(--theme-text2)', marginTop: 2 }}>Yield: {recipeForm.yield_qty} {recipeForm.yield_uom}</div>
                </div>
              )}
              {!isSubRecipeForm && livePrice > 0 && (
                <div>
                  <div style={{ fontSize: 11, color: 'var(--theme-text2)', textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: 4 }}>Food Cost %</div>
                  <div style={{ fontSize: 20, fontWeight: 700, color: liveFcPct <= 30 ? 'var(--theme-green)' : liveFcPct <= 38 ? 'var(--theme-accent)' : 'var(--theme-red)' }}>
                    {liveFcPct?.toFixed(1)}%
                  </div>
                  <div style={{ fontSize: 11, color: 'var(--theme-text2)', marginTop: 2 }}>
                    {liveFcPct <= 30 ? '✓ Good' : liveFcPct <= 38 ? '⚠ Acceptable' : '✗ Too high'}
                  </div>
                </div>
              )}
              {!isSubRecipeForm && livePrice > 0 && (
                <div>
                  <div style={{ fontSize: 11, color: 'var(--theme-text2)', textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: 4 }}>Menu Price (incl. VAT)</div>
                  <div style={{ fontSize: 20, fontWeight: 700, color: 'var(--theme-text1)' }}>NPR {livePriceWithVat.toFixed(0)}</div>
                </div>
              )}
              {suggestedPrice && (
                <div>
                  <div style={{ fontSize: 11, color: 'var(--theme-text2)', textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: 4 }}>Suggested @ {recipeForm.target_fc_pct || 30}% FC</div>
                  <div style={{ fontSize: 20, fontWeight: 700, color: 'var(--theme-green)' }}>NPR {suggestedPrice}</div>
                  <div style={{ fontSize: 11, color: 'var(--theme-text2)', marginTop: 2 }}>{liveVat > 0 ? `incl. ${(liveVat*100).toFixed(0)}% VAT, ` : ''}rounded</div>
                </div>
              )}
            </div>
          )}

          {/* Live nutrition line */}
          {liveNutri && liveNutri.coverage.total > 0 && (
            <div style={{
              background: 'color-mix(in srgb, var(--theme-purple) 5%, transparent)', border: '1px solid color-mix(in srgb, var(--theme-purple) 18%, transparent)',
              borderRadius: 8, padding: '10px 16px', marginBottom: 20,
              display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap', fontSize: 13
            }}>
              <span style={{ color: 'var(--theme-purple)', fontWeight: 600, fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.08em' }}>
                🍽 {isSubRecipeForm ? 'total batch' : 'per portion'}
              </span>
              {NUTRIENTS.map(def => (
                <span key={def.key} style={{ color: 'var(--theme-text1)' }}>{def.label} <strong>{fmtNutrient(def, liveNutri.perPortion[def.key])}</strong></span>
              ))}
              <span style={{ color: liveNutri.coverage.have < liveNutri.coverage.total ? 'var(--theme-accent)' : 'var(--theme-text2)', fontSize: 12 }}>
                · data {liveNutri.coverage.have}/{liveNutri.coverage.total}
              </span>
            </div>
          )}

          {/* Ingredients */}
          <div className="card" style={{ marginBottom: 20 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 18 }}>
              <h3 style={{ margin: 0, fontSize: 14, color: 'var(--theme-text2)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>Ingredients</h3>
              <div style={{ display: 'flex', gap: 8 }}>
                {showNutrition && (
                  <button className="btn btn-ghost" style={{ fontSize: 12, padding: '5px 12px', color: 'var(--theme-purple)', borderColor: 'color-mix(in srgb, var(--theme-purple) 30%, transparent)' }} onClick={autoFillNutrition} disabled={autoFillBusy}>
                    <Tip width={290} text="Fills every ingredient that's missing nutrition with its best match from the regional library (DFTQC Nepal / IFCT 2017 / USDA), in one step. Doesn't reach for the live USDA FoodData Central API on a miss — that's offered separately below so USDA is never a silent default. Branded items (Open Food Facts) and unmatched items are left for you to add manually.">
                      {autoFillBusy ? 'Filling…' : '⚡ Auto-fill nutrition'}
                    </Tip>
                  </button>
                )}
                <button className="btn btn-ghost" style={{ fontSize: 12, padding: '5px 12px' }} onClick={addRow}>+ Add Row</button>
              </div>
            </div>

            {nutriStatus && (
              <div role="status" aria-live="polite" style={{
                display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 10, fontSize: 12,
                background: 'color-mix(in srgb, var(--theme-accent) 8%, transparent)', border: '1px solid color-mix(in srgb, var(--theme-accent) 25%, transparent)',
                borderRadius: 8, padding: '8px 12px', marginBottom: 14,
              }}>
                <span style={{ color: 'var(--theme-text1)' }}>{nutriStatus.text}</span>
                <button onClick={() => setNutriStatus(null)} aria-label="Dismiss"
                  style={{ background: 'none', border: 'none', color: 'var(--theme-text3)', cursor: 'pointer', fontSize: 14, padding: '4px 6px', flexShrink: 0 }}>×</button>
              </div>
            )}

            {showNutrition && usdaCandidates.length > 0 && (
              <div style={{
                display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', fontSize: 12,
                background: 'rgba(96,165,250,0.08)', border: '1px solid rgba(96,165,250,0.25)',
                borderRadius: 8, padding: '8px 12px', marginBottom: 18,
              }}>
                <span style={{ color: 'var(--theme-text2)' }}>
                  {usdaCandidates.length} ingredient{usdaCandidates.length > 1 ? 's' : ''} not in the regional library: {usdaCandidates.map(i => i.name).join(', ')}
                </span>
                <button className="btn btn-ghost" style={{ fontSize: 11, padding: '3px 10px', color: 'var(--theme-purple)', borderColor: 'color-mix(in srgb, var(--theme-purple) 30%, transparent)' }} onClick={fillFromUsda} disabled={usdaFillBusy}>
                  {usdaFillBusy ? 'Fetching…' : '🔍 Try USDA FoodData Central'}
                </button>
                <button style={{ background: 'none', border: 'none', color: 'var(--theme-text3)', cursor: 'pointer', fontSize: 14, padding: 8 }} onClick={dismissUsdaCandidates} title="Dismiss" aria-label="Dismiss USDA suggestion">✕</button>
              </div>
            )}

            <div className="table-wrap">
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr>
                  <th style={{ textAlign: 'left', fontSize: 11, color: 'var(--theme-text2)', padding: '0 0 10px', letterSpacing: '0.08em', textTransform: 'uppercase', width: 100 }}>Type</th>
                  <th style={{ textAlign: 'left', fontSize: 11, color: 'var(--theme-text2)', padding: '0 12px 10px 8px', letterSpacing: '0.08em', textTransform: 'uppercase' }}>Ingredient</th>
                  <th style={{ textAlign: 'right', fontSize: 11, color: 'var(--theme-text2)', padding: '0 12px 10px', letterSpacing: '0.08em', textTransform: 'uppercase', width: 130 }}>Qty per Portion</th>
                  <th style={{ textAlign: 'left', fontSize: 11, color: 'var(--theme-text2)', padding: '0 12px 10px', letterSpacing: '0.08em', textTransform: 'uppercase', width: 70 }}>UOM</th>
                  <th style={{ textAlign: 'right', fontSize: 11, color: 'var(--theme-text2)', padding: '0 12px 10px', letterSpacing: '0.08em', textTransform: 'uppercase', width: 110 }}>Cost</th>
                  <th style={{ textAlign: 'right', fontSize: 11, color: 'var(--theme-text2)', padding: '0 12px 10px', letterSpacing: '0.08em', textTransform: 'uppercase', width: 70 }}>% of Total</th>
                  {showNutrition && <th style={{ textAlign: 'center', fontSize: 11, color: 'var(--theme-text2)', padding: '0 12px 10px', letterSpacing: '0.08em', textTransform: 'uppercase', width: 90 }}>Nutrition</th>}
                  <th style={{ width: 36 }}></th>
                </tr>
              </thead>
              <tbody>
                {ingredients.map(ing => {
                  let cost = null
                  let uomLabel = '—'

                  if (ing.type === 'item') {
                    const item = items.find(i => i.id === ing.item_id)
                    if (item && ing.qty_per_portion) {
                      const yieldFactor = (parseFloat(item.yield_pct) || 100) / 100
                      cost = (parseFloat(ing.qty_per_portion) / yieldFactor) * parseFloat(item.per_uom_rate || 0)
                      uomLabel = item.uom
                    }
                  } else {
                    const sr = recipes.find(r => r.id === ing.sub_recipe_id)
                    if (sr && ing.qty_per_portion) {
                      const cpu = calcSubRecipeCostPerUnit(sr, recipes)
                      cost = parseFloat(ing.qty_per_portion) * cpu
                      uomLabel = sr.yield_uom
                    }
                  }

                  return (
                    <tr key={ing._key}>
                      <td style={{ padding: '6px 0' }}>
                        <select
                          value={ing.type}
                          onChange={e => setIngType(ing._key, e.target.value)}
                          style={{ background: 'var(--theme-bg)', border: '1px solid var(--theme-border)', borderRadius: 5, padding: '7px 8px', fontSize: 12, color: ing.type === 'sub_recipe' ? 'var(--theme-accent)' : 'var(--theme-text2)', outline: 'none', width: 95 }}
                        >
                          <option value="item">Item</option>
                          <option value="sub_recipe">⚙ Sub-Recipe</option>
                        </select>
                      </td>
                      <td style={{ padding: '6px 8px' }}>
                        {ing.type === 'item' ? (
                          <SearchableSelect
                            value={ing.item_id}
                            onChange={v => updateIng(ing._key, 'item_id', v)}
                            options={itemOptions}
                            placeholder="— Select ingredient —"
                          />
                        ) : (
                          <SearchableSelect
                            value={ing.sub_recipe_id}
                            onChange={v => updateIng(ing._key, 'sub_recipe_id', v)}
                            options={subRecipeOptions}
                            placeholder="— Select sub-recipe —"
                          />
                        )}
                      </td>
                      <td style={{ padding: '6px 12px', textAlign: 'right' }}>
                        <input type="number" min="0" value={ing.qty_per_portion}
                          onChange={e => updateIng(ing._key, 'qty_per_portion', e.target.value)}
                          placeholder="0"
                          style={{ background: 'var(--theme-bg)', border: '1px solid var(--theme-border)', borderRadius: 5, padding: '7px 10px', fontSize: 13, color: 'var(--theme-text1)', outline: 'none', width: 100, textAlign: 'right' }} />
                      </td>
                      <td style={{ padding: '6px 12px', color: ing.type === 'sub_recipe' ? 'var(--theme-accent)' : 'var(--theme-text2)', fontSize: 13 }}>{uomLabel}</td>
                      <td style={{ padding: '6px 12px', textAlign: 'right', color: 'var(--theme-accent)', fontSize: 13, fontWeight: 600 }}>
                        {cost != null ? `NPR ${cost.toFixed(2)}` : '—'}
                      </td>
                      <td style={{ padding: '6px 12px', textAlign: 'right', color: 'var(--theme-text2)', fontSize: 12 }}>
                        {cost != null && liveCost > 0 ? `${((cost / liveCost) * 100).toFixed(1)}%` : '—'}
                      </td>
                      {showNutrition && (
                        <td style={{ padding: '6px 8px', textAlign: 'center' }}>
                          {ing.type === 'item' && ing.item_id ? (() => {
                            const it = items.find(i => i.id === ing.item_id)
                            const has = hasNutrition(it?.nutrition)
                            return (
                              <button onClick={() => setNutriItemId(ing.item_id)}
                                style={{ background: 'none', border: `1px solid ${has ? 'rgba(52,211,153,0.4)' : 'var(--theme-border)'}`, borderRadius: 5, padding: '4px 8px', fontSize: 11, color: has ? 'var(--theme-green)' : 'var(--theme-text2)', cursor: 'pointer', whiteSpace: 'nowrap' }}>
                                {has ? '● Edit' : '+ Add'}
                              </button>
                            )
                          })() : (
                            <span style={{ color: 'var(--theme-text2)', fontSize: 11 }}>{ing.type === 'sub_recipe' ? 'auto' : '—'}</span>
                          )}
                        </td>
                      )}
                      <td style={{ padding: '6px 0', textAlign: 'right' }}>
                        <button onClick={() => removeRow(ing._key)} aria-label="Remove ingredient"
                          style={{ background: 'none', border: 'none', color: 'var(--theme-text3)', cursor: 'pointer', fontSize: 16, padding: '8px' }}>×</button>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
            </div>
          </div>

          {error && <p style={{ color: 'var(--theme-red)', fontSize: 13, margin: '0 0 16px' }}>{error}</p>}
          <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
            <button className="btn btn-ghost" onClick={() => setView('list')}>Cancel</button>
            <button className="btn btn-primary" onClick={save} disabled={saving}>
              {saving ? 'Saving…' : selectedRecipe ? 'Update Recipe' : 'Save Recipe'}
            </button>
          </div>
        </div>
      )}

      {/* ── DETAIL VIEW ── */}
      {view === 'detail' && selectedRecipe && (() => {
        const isSubRec = selectedRecipe.category === 'Sub-Recipe'
        const cost = calcRecipeCost(selectedRecipe, recipes)
        const price = parseFloat(selectedRecipe.selling_price) || 0
        const vat = vatOf(selectedRecipe)
        const fcPct = price > 0 ? (cost / price) * 100 : null
        const yieldQty = parseFloat(selectedRecipe.yield_qty) || 1
        const costPerUnit = cost / yieldQty
        const fcColor = fcPct == null ? 'var(--theme-text2)' : fcPct <= 30 ? 'var(--theme-green)' : fcPct <= 38 ? 'var(--theme-accent)' : 'var(--theme-red)'
        const nutri = showNutrition ? calcRecipeNutrition(selectedRecipe, recipes) : null
        // Sub-recipes show the whole batch (mirrors "Total Batch Cost"); the per-unit value
        // still rolls up into parent recipes via calcSubRecipeNutritionPerUnit.
        const nutriLabel = isSubRec ? 'total batch' : 'per portion'
        const nutriValues = nutri ? nutri.perPortion : null

        return (
          <>
          <div className="no-print">
          <div>
            {isSubRec && (
              <div style={{ background: 'rgba(201,168,76,0.06)', border: '1px solid rgba(201,168,76,0.2)', borderRadius: 8, padding: '12px 16px', marginBottom: 20, fontSize: 13, color: 'var(--theme-accent)' }}>
                ⚙ Sub-Recipe — Yield: {selectedRecipe.yield_qty} {selectedRecipe.yield_uom} · Cost per {selectedRecipe.yield_uom}: NPR {costPerUnit.toFixed(2)}
              </div>
            )}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px,1fr))', gap: 14, marginBottom: 24 }}>
              {(isSubRec ? [
                { label: 'Total Batch Cost', value: `NPR ${cost.toFixed(2)}`, color: 'var(--theme-accent)' },
                { label: `Cost per ${selectedRecipe.yield_uom}`, value: `NPR ${costPerUnit.toFixed(2)}`, color: 'var(--theme-green)' },
                { label: 'Yield', value: `${selectedRecipe.yield_qty} ${selectedRecipe.yield_uom}`, color: 'var(--theme-text1)' },
              ] : [
                { label: 'Food Cost', value: `NPR ${cost.toFixed(2)}`, color: 'var(--theme-accent)' },
                { label: 'Food Cost %', value: fcPct != null ? `${fcPct.toFixed(1)}%` : '—', color: fcColor },
                { label: 'Selling Price (ex. VAT)', value: price ? `NPR ${price.toFixed(2)}` : '—', color: 'var(--theme-text1)' },
                { label: `Menu Price (incl. ${(vat*100).toFixed(0)}% VAT)`, value: price ? `NPR ${(price*(1+vat)).toFixed(0)}` : '—', color: 'var(--theme-text1)' },
                { label: `Suggested @ ${selectedRecipe.target_fc_pct || 30}% FC`, value: `NPR ${getSuggestedPrice(cost, vat, (parseFloat(selectedRecipe.target_fc_pct) || 30) / 100)}`, color: 'var(--theme-green)' },
              ]).map(s => (
                <div key={s.label} className="stat-card">
                  <div className="stat-label">{s.label}</div>
                  <div className="stat-value" style={{ fontSize: 18, color: s.color }}>{s.value}</div>
                </div>
              ))}
            </div>

            {/* Overhead panel — shown when overheads + sales exist for open period */}
            {!isSubRec && overheadData && price > 0 && (() => {
              const ohPerPortion = overheadData.totalOverheads / overheadData.totalCovers
              const trueCost = cost + ohPerPortion
              const trueNetMargin = price > 0 ? ((price - trueCost) / price) * 100 : null
              const vat = vatOf(selectedRecipe)
              const suggestedRaw = trueCost / 0.20
              const suggestedVat = Math.ceil((suggestedRaw * (1 + vat)) / 5) * 5
              return (
                <div style={{
                  background: 'rgba(52,211,153,0.06)', border: '1px solid rgba(52,211,153,0.2)',
                  borderRadius: 8, padding: '16px 20px', marginBottom: 20
                }}>
                  <div style={{ fontSize: 11, color: 'var(--theme-green)', textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: 14, fontWeight: 600 }}>
                    ⚖ True Cost with Overheads
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px,1fr))', gap: 16 }}>
                    <div>
                      <div style={{ fontSize: 11, color: 'var(--theme-text2)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 4 }}>Overhead / Portion</div>
                      <div style={{ fontSize: 18, fontWeight: 700, color: 'var(--theme-green)' }}>NPR {ohPerPortion.toFixed(2)}</div>
                      <div style={{ fontSize: 11, color: 'var(--theme-text2)', marginTop: 2 }}>NPR {overheadData.totalOverheads.toLocaleString()} ÷ {overheadData.totalCovers} covers</div>
                    </div>
                    <div>
                      <div style={{ fontSize: 11, color: 'var(--theme-text2)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 4 }}>True Cost / Portion</div>
                      <div style={{ fontSize: 18, fontWeight: 700, color: 'var(--theme-accent)' }}>NPR {trueCost.toFixed(2)}</div>
                      <div style={{ fontSize: 11, color: 'var(--theme-text2)', marginTop: 2 }}>Food + Overhead</div>
                    </div>
                    <div>
                      <div style={{ fontSize: 11, color: 'var(--theme-text2)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 4 }}>True Net Margin %</div>
                      <div style={{ fontSize: 18, fontWeight: 700, color: trueNetMargin >= 20 ? 'var(--theme-green)' : 'var(--theme-red)' }}>
                        {trueNetMargin != null ? `${trueNetMargin.toFixed(1)}%` : '—'}
                      </div>
                      <div style={{ fontSize: 11, color: 'var(--theme-text2)', marginTop: 2 }}>{trueNetMargin >= 20 ? '✓ Healthy' : '✗ Below 20%'}</div>
                    </div>
                    <div>
                      <div style={{ fontSize: 11, color: 'var(--theme-text2)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 4 }}>Suggested Price @ 20% margin</div>
                      <div style={{ fontSize: 18, fontWeight: 700, color: 'var(--theme-green)' }}>NPR {suggestedVat}</div>
                      <div style={{ fontSize: 11, color: 'var(--theme-text2)', marginTop: 2 }}>incl. {(vat*100).toFixed(0)}% VAT, rounded to ÷5</div>
                    </div>
                  </div>
                </div>
              )
            })()}

            {/* Nutrition panel (per portion) */}
            {nutri && (
              <div style={{
                background: 'color-mix(in srgb, var(--theme-purple) 6%, transparent)', border: '1px solid color-mix(in srgb, var(--theme-purple) 20%, transparent)',
                borderRadius: 8, padding: '16px 20px', marginBottom: 20
              }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 14, flexWrap: 'wrap', gap: 8 }}>
                  <div style={{ fontSize: 11, color: 'var(--theme-purple)', textTransform: 'uppercase', letterSpacing: '0.1em', fontWeight: 600 }}>
                    🍽 Nutrition ({nutriLabel})
                  </div>
                  <div style={{ fontSize: 11, color: nutri.coverage.have < nutri.coverage.total ? 'var(--theme-accent)' : 'var(--theme-text2)' }}>
                    <Tip width={260} text="How many ingredients have nutrition data entered. Missing ingredients contribute 0, so values below 100% are underestimates. Add data on each item's Nutrition tab.">
                      Data: {nutri.coverage.have}/{nutri.coverage.total} ingredients
                    </Tip>
                  </div>
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(110px,1fr))', gap: 16 }}>
                  {NUTRIENTS.map(def => (
                    <div key={def.key}>
                      <div style={{ fontSize: 11, color: 'var(--theme-text2)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 4 }}>{def.label}</div>
                      <div style={{ fontSize: 18, fontWeight: 700, color: 'var(--theme-text1)' }}>{fmtNutrient(def, nutriValues[def.key])}</div>
                    </div>
                  ))}
                </div>
                <div style={{ marginTop: 14, display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                  <span style={{ fontSize: 11, color: 'var(--theme-text2)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>Allergens</span>
                  {nutri.allergens.length > 0
                    ? nutri.allergens.map(a => (
                        <span key={a} className="badge" style={{ background: 'rgba(248,113,113,0.12)', color: 'var(--theme-red)', textTransform: 'capitalize' }}>{a}</span>
                      ))
                    : <span style={{ fontSize: 12, color: 'var(--theme-text2)' }}>None tagged</span>}
                </div>
                {nutri.coverage.have < nutri.coverage.total && (
                  <div style={{ fontSize: 11, color: 'var(--theme-accent)', marginTop: 10 }}>
                    ⚠ {nutri.coverage.total - nutri.coverage.have} ingredient(s) missing nutrition data — values are estimates.
                  </div>
                )}
              </div>
            )}

            <div className="card">
              <div className="table-wrap">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Ingredient</th>
                    <th>Type</th>
                    <th style={{ textAlign: 'right' }}>Qty per Portion</th>
                    <th>UOM</th>
                    <th style={{ textAlign: 'right' }}>Yield %</th>
                    <th style={{ textAlign: 'right' }}>Unit Rate</th>
                    <th style={{ textAlign: 'right' }}>Cost</th>
                    <th style={{ textAlign: 'right' }}>% of Dish</th>
                  </tr>
                </thead>
                <tbody>
                  {(selectedRecipe.recipe_ingredients || []).map(ri => {
                    let name, uom, unitRate, itemCost, yieldPct
                    if (ri.item_id && ri.items) {
                      name = ri.items.name
                      uom = ri.items.uom
                      yieldPct = parseFloat(ri.items.yield_pct) || 100
                      const yieldFactor = yieldPct / 100
                      unitRate = parseFloat(ri.items.per_uom_rate || 0)
                      itemCost = (parseFloat(ri.qty_per_portion) / yieldFactor) * unitRate
                    } else if (ri.sub_recipe_id && ri.sub_recipe) {
                      const cpu = calcSubRecipeCostPerUnit(ri.sub_recipe, recipes)
                      name = `⚙ ${ri.sub_recipe.name}`
                      uom = ri.sub_recipe.yield_uom
                      unitRate = cpu
                      itemCost = parseFloat(ri.qty_per_portion) * cpu
                      yieldPct = null
                    } else return null
                    const pctOfDish = cost > 0 ? (itemCost / cost) * 100 : 0
                    return (
                      <tr key={ri.id}>
                        <td style={{ fontWeight: 600, color: ri.sub_recipe_id ? 'var(--theme-accent)' : 'var(--theme-text1)' }}>
                          {ri.items?.item_code && (
                            <span style={{ fontSize: 10, fontFamily: 'monospace', color: 'var(--theme-accent)', marginRight: 7, fontWeight: 400 }}>{ri.items.item_code}</span>
                          )}
                          {ri.sub_recipe?.recipe_code && (
                            <span style={{ fontSize: 10, fontFamily: 'monospace', color: 'var(--theme-accent)', marginRight: 7, fontWeight: 400 }}>{ri.sub_recipe.recipe_code}</span>
                          )}
                          {name}
                        </td>
                        <td><span className={`badge ${ri.sub_recipe_id ? 'badge-yellow' : 'badge-gray'}`}>{ri.sub_recipe_id ? 'Sub-Recipe' : 'Item'}</span></td>
                        <td style={{ textAlign: 'right' }}>{ri.qty_per_portion}</td>
                        <td style={{ color: 'var(--theme-text2)' }}>{uom}</td>
                        <td style={{ textAlign: 'right', color: yieldPct != null && yieldPct < 100 ? 'var(--theme-red)' : 'var(--theme-text2)' }}>
                          {yieldPct != null ? `${yieldPct.toFixed(0)}%` : '—'}
                        </td>
                        <td style={{ textAlign: 'right', color: 'var(--theme-text2)' }}>NPR {unitRate.toFixed(2)}</td>
                        <td style={{ textAlign: 'right', color: 'var(--theme-accent)', fontWeight: 600 }}>NPR {itemCost.toFixed(2)}</td>
                        <td style={{ textAlign: 'right' }}>
                          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 8 }}>
                            <div style={{ width: 60, height: 4, background: 'var(--theme-border)', borderRadius: 2 }}>
                              <div style={{ width: `${Math.min(pctOfDish,100)}%`, height: '100%', background: 'var(--theme-accent)', borderRadius: 2 }} />
                            </div>
                            <span style={{ fontSize: 12, color: 'var(--theme-text2)', minWidth: 36 }}>{pctOfDish.toFixed(1)}%</span>
                          </div>
                        </td>
                      </tr>
                    )
                  })}
                  <tr style={{ borderTop: '2px solid var(--theme-border)' }}>
                    <td colSpan={6} style={{ fontWeight: 700, color: 'var(--theme-text2)', paddingTop: 12 }}>Total</td>
                    <td style={{ textAlign: 'right', fontWeight: 700, color: 'var(--theme-accent)', fontSize: 15, paddingTop: 12 }}>NPR {cost.toFixed(2)}</td>
                    <td></td>
                  </tr>
                </tbody>
              </table>
              </div>
            </div>
            <div style={{ marginTop: 16, display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
              <button className="btn btn-ghost" onClick={() => setView('list')}>← Back</button>
              <button className="btn btn-ghost" style={{ fontSize: 12 }} onClick={() => printWithTitle(`Recipe Cost Card - ${selectedRecipe.name}`)}>🖶 Print Cost Card</button>
              <button className="btn btn-ghost" onClick={() => openEdit(selectedRecipe)}>Edit Recipe</button>
            </div>
          </div>
          </div>

          {/* ── PRINT-ONLY COST CARD ── */}
          <div className="print-only">
            <RecipeCostCardPrint recipe={selectedRecipe} recipes={recipes} settings={settings} overheadData={overheadData} showNutrition={showNutrition} />
          </div>
          </>
        )
      })()}

      {/* ── LIST-VIEW PRINT CARD (fires when 🖶 clicked from list) ── */}
      {printRecipe && (
        <div className="print-only">
          <RecipeCostCardPrint recipe={printRecipe} recipes={recipes} settings={settings} overheadData={overheadData} showNutrition={showNutrition} />
        </div>
      )}

      {/* ── INLINE NUTRITION EDITOR (per ingredient) ── */}
      {nutriItemId && nutriItem && (
        <NutritionEditorModal item={nutriItem} onClose={() => setNutriItemId(null)} onSaved={handleNutriSaved} />
      )}

      <Fab onClick={openNew} label="+ New Recipe" show={view === 'list'} />
    </div>
  )
}
