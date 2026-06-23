import { useEffect, useState, useCallback, useMemo } from 'react'
import { useAuth } from '../context/AuthContext'
import { useSettings } from '../context/SettingsContext'
import { supabase } from '../supabaseClient'
import Tip from '../components/Tip'
import Fab from '../components/Fab'
import Modal from '../components/Modal'
import SearchableSelect from '../components/SearchableSelect'
import { NUTRIENTS, EMPTY_NUTRITION, calcRecipeNutrition, calcLiveNutrition, hasNutrition, buildNutritionPayload, defaultBasisUnit } from '../utils/nutrition'
import { suggestSeeds } from '../data/nutritionSeed'

const UNITS = ['GM', 'ML', 'KG', 'LTR', 'PCS', 'PKT', 'BTL', 'BOX', 'ROLL', 'BUNCH', 'JAR', 'CTN', 'BAG', 'TIN', 'SACHET']

const RECIPE_CATS = ['Food', 'Beverage', 'Dessert', 'Snack', 'Sub-Recipe', 'Other']

// Format one nutrient value for display, e.g. "130 kcal", "2.7 g".
function fmtNutrient(def, value) {
  const v = Number(value) || 0
  return `${v.toFixed(def.dp)} ${def.unit}`
}
const EMPTY_RECIPE = { name: '', category: 'Food', selling_price: '', vat_rate: '0.13', yield_qty: '1', yield_uom: 'portion', target_fc_pct: '30' }

export default function Recipes() {
  const { clientId, isAdmin, hasFeature } = useAuth()
  const showNutrition = hasFeature('nutrition_facts')
  const { settings } = useSettings()
  const [recipes, setRecipes] = useState([])
  const [overheadData, setOverheadData] = useState(null) // { totalOverheads, totalCovers, openPeriodId } | null
  const [items, setItems] = useState([])
  const [loading, setLoading] = useState(true)
  const [view, setView] = useState('list') // list | edit | detail
  const [selectedRecipe, setSelectedRecipe] = useState(null)
  const [recipeForm, setRecipeForm] = useState(EMPTY_RECIPE)
  const [ingredients, setIngredients] = useState([{ _key: Date.now(), item_id: '', sub_recipe_id: '', qty_per_portion: '', type: 'item' }])
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [search, setSearch] = useState('')
  const [ingSearch, setIngSearch] = useState('')
  const [printRecipe, setPrintRecipe] = useState(null)
  const filterCat = 'all' // no active UI to change this; filter always passes through

  // ── Inline per-ingredient nutrition editor (saves to items.nutrition) ──
  const [nutriItemId, setNutriItemId] = useState(null)
  const [nutriForm, setNutriForm] = useState({ ...EMPTY_NUTRITION })
  const [nutriMatches, setNutriMatches] = useState([])
  const [nutriSaving, setNutriSaving] = useState(false)
  const [nutriError, setNutriError] = useState('')
  // Open Food Facts lookup (branded/packaged products)
  const [offQuery, setOffQuery] = useState('')
  const [offResults, setOffResults] = useState([])
  const [offBusy, setOffBusy] = useState(false)
  const [offError, setOffError] = useState('')
  const [autoFillBusy, setAutoFillBusy] = useState(false)

  const init = useCallback(async () => {
    if (!clientId) return
    setLoading(true)
    const [{ data: r }, { data: i }] = await Promise.all([
      supabase.from('recipes').select('*').eq('client_id', clientId).order('name'),
      supabase.from('items').select('*').eq('client_id', clientId).eq('is_active', true).eq('is_sub_recipe', false).order('name')
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
    const { data: periods } = await supabase
      .from('monthly_periods')
      .select('id')
      .eq('client_id', clientId)
      .eq('status', 'open')
      .limit(1)
    const openPeriodId = periods?.[0]?.id || null

    if (openPeriodId) {
      const [{ data: ohRows }, { data: salesRows }] = await Promise.all([
        supabase.from('overheads').select('amount').eq('client_id', clientId).eq('period_id', openPeriodId).eq('bucket', 'overhead'),
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
  }, [clientId])

  useEffect(() => { if (clientId) init() }, [clientId, init])

  useEffect(() => {
    if (!printRecipe) return
    const t = setTimeout(() => { window.print(); setPrintRecipe(null) }, 80)
    return () => clearTimeout(t)
  }, [printRecipe])

  // ── Cost calculation (recursive) ──────────────────────────────
  function calcSubRecipeCostPerUnit(subRecipe, allRecipes) {
    if (!subRecipe) return 0
    const ings = subRecipe.recipe_ingredients || []
    let total = 0
    ings.forEach(ri => {
      if (ri.item_id && ri.items) {
        const yieldFactor = (parseFloat(ri.items.yield_pct) || 100) / 100
        total += (parseFloat(ri.qty_per_portion) / yieldFactor) * parseFloat(ri.items.per_uom_rate || 0)
      } else if (ri.sub_recipe_id) {
        const nested = allRecipes.find(r => r.id === ri.sub_recipe_id)
        if (nested) {
          const nestedCostPerUnit = calcSubRecipeCostPerUnit(nested, allRecipes)
          total += parseFloat(ri.qty_per_portion) * nestedCostPerUnit
        }
      }
    })
    const yieldQty = parseFloat(subRecipe.yield_qty) || 1
    return total / yieldQty
  }

  function calcRecipeCost(recipe, allRecipes) {
    return (recipe.recipe_ingredients || []).reduce((sum, ri) => {
      if (ri.item_id && ri.items) {
        const yieldFactor = (parseFloat(ri.items.yield_pct) || 100) / 100
        return sum + (parseFloat(ri.qty_per_portion) / yieldFactor) * parseFloat(ri.items.per_uom_rate || 0)
      } else if (ri.sub_recipe_id && ri.sub_recipe) {
        const costPerUnit = calcSubRecipeCostPerUnit(ri.sub_recipe, allRecipes)
        return sum + parseFloat(ri.qty_per_portion) * costPerUnit
      }
      return sum
    }, 0)
  }

  // Live cost in edit mode
  function calcLiveCost(ingList, itemsList, allRecipes) {
    return ingList.reduce((sum, ing) => {
      if (ing.type === 'item') {
        const item = itemsList.find(i => i.id === ing.item_id)
        if (!item || !ing.qty_per_portion) return sum
        const yieldFactor = (parseFloat(item.yield_pct) || 100) / 100
        return sum + (parseFloat(ing.qty_per_portion) / yieldFactor) * parseFloat(item.per_uom_rate || 0)
      } else {
        const sr = allRecipes.find(r => r.id === ing.sub_recipe_id)
        if (!sr || !ing.qty_per_portion) return sum
        const costPerUnit = calcSubRecipeCostPerUnit(sr, allRecipes)
        return sum + parseFloat(ing.qty_per_portion) * costPerUnit
      }
    }, 0)
  }

  function getSuggestedPrice(cost, vatRate = 0.13, targetFcPct = 0.30) {
    const basePrice = cost / targetFcPct
    return Math.ceil((basePrice * (1 + vatRate)) / 5) * 5
  }

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
    setError('')
    setView('edit')
  }

  function openEdit(recipe) {
    setSelectedRecipe(recipe)
    setRecipeForm({
      name: recipe.name,
      category: recipe.category || 'Food',
      selling_price: recipe.selling_price || '',
      vat_rate: recipe.vat_rate || '0.13',
      yield_qty: recipe.yield_qty || '1',
      yield_uom: recipe.yield_uom || 'portion',
      target_fc_pct: recipe.target_fc_pct ? String(recipe.target_fc_pct) : '30'
    })
    const ings = (recipe.recipe_ingredients || []).map(ri => ({
      _key: ri.id,
      item_id: ri.item_id || '',
      sub_recipe_id: ri.sub_recipe_id || '',
      qty_per_portion: ri.qty_per_portion,
      type: ri.sub_recipe_id ? 'sub_recipe' : 'item'
    }))
    setIngredients(ings.length > 0 ? ings : [{ _key: Date.now(), item_id: '', sub_recipe_id: '', qty_per_portion: '', type: 'item' }])
    setError('')
    setView('edit')
  }

  function openDetail(recipe) {
    setSelectedRecipe(recipe)
    setView('detail')
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

  // ── Nutrition editor handlers ─────────────────────────────────
  const nutriItem = items.find(i => i.id === nutriItemId) || null

  function openNutriEditor(itemId) {
    const it = items.find(i => i.id === itemId)
    if (!it) return
    const n = it.nutrition || {}
    const form = {
      basis_qty: n.basis_qty != null ? n.basis_qty : 100,
      // Default to GM/ML for mass/volume items so per-100g table values drop in directly;
      // the engine converts the recipe qty (e.g. 0.009 KG) into this unit automatically.
      basis_unit: n.basis_unit || defaultBasisUnit(it.uom),
      allergens: n.allergens || '',
      source: n.source || '',
    }
    NUTRIENTS.forEach(d => { form[d.key] = n[d.key] != null ? n[d.key] : '' })
    setNutriForm(form)
    setNutriMatches([])
    setNutriError('')
    setOffQuery('')
    setOffResults([])
    setOffError('')
    setNutriItemId(itemId)
  }

  function setNF(val) { setNutriForm(prev => ({ ...prev, ...val })) }

  function findNutriSeeds() {
    const matches = suggestSeeds(nutriItem?.name || '')
    setNutriMatches(matches)
    setNutriError(matches.length === 0 ? `No library match for "${nutriItem?.name}". Enter values manually.` : '')
  }

  function applyNutriSeed(seed) {
    setNutriError('')
    setNutriMatches([])
    setNutriForm(prev => ({
      ...prev,
      basis_qty: 100,
      basis_unit: seed.unit || nutriItem?.uom || 'GM',
      energy_kcal: seed.energy_kcal, protein_g: seed.protein_g, carbs_g: seed.carbs_g,
      fat_g: seed.fat_g, sugar_g: seed.sugar_g, sodium_mg: seed.sodium_mg,
      allergens: seed.allergens || '', source: seed.source || '',
    }))
  }

  // ── Open Food Facts lookup (per 100 g; branded/packaged products) ──
  function mapOffProduct(p) {
    const n = p.nutriments || {}
    const num = v => { const x = parseFloat(v); return Number.isFinite(x) ? x : null }
    const r0 = v => v == null ? null : Math.round(v)
    const r1 = v => v == null ? null : Math.round(v * 10) / 10

    let kcal = num(n['energy-kcal_100g'])
    if (kcal == null && num(n['energy_100g']) != null) kcal = num(n['energy_100g']) / 4.184 // kJ → kcal
    let sodiumMg = null
    if (num(n['sodium_100g']) != null) sodiumMg = num(n['sodium_100g']) * 1000
    else if (num(n['salt_100g']) != null) sodiumMg = (num(n['salt_100g']) / 2.5) * 1000 // salt ≈ 2.5 × sodium

    const vals = {
      energy_kcal: r0(kcal),
      protein_g: r1(num(n['proteins_100g'])),
      carbs_g: r1(num(n['carbohydrates_100g'])),
      fat_g: r1(num(n['fat_100g'])),
      sugar_g: r1(num(n['sugars_100g'])),
      sodium_mg: r0(sodiumMg),
    }
    if ([vals.energy_kcal, vals.protein_g, vals.carbs_g, vals.fat_g].every(v => v == null)) return null

    const allergens = (p.allergens_tags || []).map(t => String(t).replace(/^[a-z]{2}:/, '')).join(', ')
    const name = [p.product_name, p.brands].filter(Boolean).join(' · ') || `Barcode ${p.code || ''}`.trim()
    return { name, code: p.code, unit: 'GM', source: 'Open Food Facts', allergens, ...vals }
  }

  async function fetchFromOFF() {
    const q = offQuery.trim()
    if (!q) return
    setOffBusy(true); setOffError(''); setOffResults([])
    const FIELDS = 'product_name,brands,code,nutriments,allergens_tags'
    try {
      const isBarcode = /^\d{6,14}$/.test(q)
      let products = []
      if (isBarcode) {
        const res = await fetch(`https://world.openfoodfacts.org/api/v2/product/${q}.json?fields=${FIELDS}`)
        const j = await res.json()
        if (j.status === 1 && j.product) products = [j.product]
      } else {
        const url = `https://world.openfoodfacts.org/cgi/search.pl?search_terms=${encodeURIComponent(q)}&search_simple=1&action=process&json=1&page_size=6&fields=${FIELDS}`
        const res = await fetch(url)
        const j = await res.json()
        products = j.products || []
      }
      const mapped = products.map(mapOffProduct).filter(Boolean)
      setOffResults(mapped)
      if (mapped.length === 0) setOffError('No products with usable nutrition found on Open Food Facts.')
    } catch (e) {
      setOffError('Could not reach Open Food Facts — check the connection and try again.')
    }
    setOffBusy(false)
  }

  function applyOffResult(row) {
    setOffError(''); setOffResults([])
    setNutriForm(prev => ({
      ...prev,
      basis_qty: 100, basis_unit: 'GM',
      energy_kcal: row.energy_kcal ?? '', protein_g: row.protein_g ?? '', carbs_g: row.carbs_g ?? '',
      fat_g: row.fat_g ?? '', sugar_g: row.sugar_g ?? '', sodium_mg: row.sodium_mg ?? '',
      allergens: row.allergens || '', source: 'Open Food Facts',
    }))
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

  async function autoFillNutrition() {
    const seen = new Set()
    const targets = []
    const unmatched = []
    ingredients.forEach(ing => {
      if (ing.type !== 'item' || !ing.item_id || seen.has(ing.item_id)) return
      seen.add(ing.item_id)
      const it = items.find(i => i.id === ing.item_id)
      if (!it || hasNutrition(it.nutrition)) return // already has data → leave it
      const best = suggestSeeds(it.name)[0]
      if (best) targets.push({ it, payload: seedToNutrition(best, it.uom) })
      else unmatched.push(it.name)
    })

    if (targets.length === 0) {
      window.alert(unmatched.length
        ? `No library matches found. Add these manually: ${unmatched.join(', ')}`
        : 'All ingredients already have nutrition data.')
      return
    }
    const msg = `Auto-fill nutrition for ${targets.length} ingredient(s) from the library (best regional match)?`
      + (unmatched.length ? `\n\n${unmatched.length} have no library match and will be skipped: ${unmatched.join(', ')}` : '')
      + `\n\nValues are reference estimates — you can edit any afterward.`
    if (!window.confirm(msg)) return

    setAutoFillBusy(true)
    const results = await Promise.all(
      targets.map(t => supabase.from('items').update({ nutrition: t.payload }).eq('id', t.it.id).then(r => ({ id: t.it.id, payload: t.payload, error: r.error })))
    )
    const okMap = {}
    let failed = 0
    results.forEach(r => { if (r.error) failed++; else okMap[r.id] = r.payload })

    // Reflect immediately so the label + coverage recompute.
    setItems(prev => prev.map(i => okMap[i.id] ? { ...i, nutrition: okMap[i.id] } : i))
    setRecipes(prev => prev.map(r => ({
      ...r,
      recipe_ingredients: (r.recipe_ingredients || []).map(ri =>
        ri.item_id && okMap[ri.item_id] && ri.items ? { ...ri, items: { ...ri.items, nutrition: okMap[ri.item_id] } } : ri)
    })))
    setAutoFillBusy(false)

    window.alert(`Filled ${Object.keys(okMap).length} ingredient(s) from the library.`
      + (failed ? ` ${failed} failed to save.` : '')
      + (unmatched.length ? `\n\nStill need manual entry (no match): ${unmatched.join(', ')}` : ''))
  }

  async function saveNutri() {
    if (!nutriItemId) return
    setNutriSaving(true)
    setNutriError('')
    const payload = buildNutritionPayload(nutriForm, nutriForm.basis_unit)
    const { error } = await supabase.from('items').update({ nutrition: payload }).eq('id', nutriItemId)
    if (error) { setNutriError(error.message); setNutriSaving(false); return }
    // Reflect immediately in local state so the live label + detail panel recompute.
    setItems(prev => prev.map(i => i.id === nutriItemId ? { ...i, nutrition: payload } : i))
    setRecipes(prev => prev.map(r => ({
      ...r,
      recipe_ingredients: (r.recipe_ingredients || []).map(ri =>
        ri.item_id === nutriItemId && ri.items ? { ...ri, items: { ...ri.items, nutrition: payload } } : ri)
    })))
    setNutriSaving(false)
    setNutriItemId(null)
  }

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
    if (!recipeForm.name.trim()) { setError('Recipe name is required.'); return }
    const validIngs = ingredients.filter(i =>
      (i.type === 'item' ? i.item_id : i.sub_recipe_id) && parseFloat(i.qty_per_portion) > 0
    )
    if (validIngs.length === 0) { setError('Add at least one ingredient with qty.'); return }

    setSaving(true)
    setError('')

    const isSubRecipe = recipeForm.category === 'Sub-Recipe'
    const payload = {
      client_id: clientId,
      name: recipeForm.name.trim(),
      category: recipeForm.category,
      selling_price: !isSubRecipe && recipeForm.selling_price ? parseFloat(recipeForm.selling_price) : null,
      vat_rate: parseFloat(recipeForm.vat_rate) || 0.13,
      yield_qty: parseFloat(recipeForm.yield_qty) || 1,
      yield_uom: recipeForm.yield_uom || 'portion',
      target_fc_pct: parseFloat(recipeForm.target_fc_pct) || 30,
      is_active: true
    }

    let recipeId
    if (selectedRecipe) {
      const { error } = await supabase.from('recipes').update(payload).eq('id', selectedRecipe.id)
      if (error) { setError(error.message); setSaving(false); return }
      recipeId = selectedRecipe.id
      await supabase.from('recipe_ingredients').delete().eq('recipe_id', recipeId)
    } else {
      if (isSubRecipe) payload.recipe_code = getNextSubRecipeCode()
      const { data, error } = await supabase.from('recipes').insert(payload).select().single()
      if (error) { setError(error.message); setSaving(false); return }
      recipeId = data.id
    }

    const ingPayload = validIngs.map(ing => ({
      recipe_id: recipeId,
      item_id: ing.type === 'item' ? ing.item_id : null,
      sub_recipe_id: ing.type === 'sub_recipe' ? ing.sub_recipe_id : null,
      qty_per_portion: parseFloat(ing.qty_per_portion)
    }))

    const { error: ingError } = await supabase.from('recipe_ingredients').insert(ingPayload)
    if (ingError) { setError(ingError.message); setSaving(false); return }

    if (isSubRecipe) {
      const cpu = liveCost / (parseFloat(recipeForm.yield_qty) || 1)
      const uom = recipeForm.yield_uom || 'portion'
      // Ensure "Sub-Recipes" category exists
      let srCategoryId = null
      const { data: existingCat } = await supabase
        .from('categories').select('id').eq('client_id', clientId).eq('name', 'Sub-Recipes').maybeSingle()
      if (existingCat) {
        srCategoryId = existingCat.id
      } else {
        const { data: newCat, error: catErr } = await supabase
          .from('categories').insert({ client_id: clientId, name: 'Sub-Recipes', sort_order: 999 }).select().single()
        if (catErr) { setError('SR sync — category create failed: ' + catErr.message); setSaving(false); return }
        srCategoryId = newCat?.id || null
      }

      const itemPayload = {
        client_id: clientId,
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
        const { error: updateErr } = await supabase.from('items').update(itemPayload).eq('id', existingLinkedId)
        if (updateErr) { setError('SR sync — item update failed: ' + updateErr.message); setSaving(false); return }
      } else {
        itemPayload.item_code = payload.recipe_code || selectedRecipe?.recipe_code || null
        const { data: newItem, error: insertErr } = await supabase.from('items').insert(itemPayload).select().single()
        if (insertErr) { setError('SR sync — item insert failed: ' + insertErr.message); setSaving(false); return }
        linkedItemId = newItem?.id
      }
      if (linkedItemId) {
        await supabase.from('recipes').update({ linked_item_id: linkedItemId }).eq('id', recipeId)
      }
    }

    setSaving(false)
    setView('list')
    init()
  }

  async function deleteRecipe(recipe) {
    if (!window.confirm(`Delete "${recipe.name}"?`)) return
    await supabase.from('recipe_ingredients').delete().eq('recipe_id', recipe.id)
    if (recipe.linked_item_id) {
      await supabase.from('items').update({ is_active: false }).eq('id', recipe.linked_item_id)
    }
    await supabase.from('recipes').delete().eq('id', recipe.id)
    init()
  }

  // ── Derived values for edit form ──────────────────────────────
  const isSubRecipeForm = recipeForm.category === 'Sub-Recipe'
  const liveCost = calcLiveCost(ingredients, items, recipes)
  const livePrice = parseFloat(recipeForm.selling_price) || 0
  const liveVat = parseFloat(recipeForm.vat_rate) || 0.13
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
  // True if a recipe contains an ingredient (item or nested sub-recipe) matching `q`.
  function recipeHasIngredient(recipe, q, allRecipes, seen = new Set()) {
    if (!recipe || seen.has(recipe.id)) return false
    seen.add(recipe.id)
    return (recipe.recipe_ingredients || []).some(ri => {
      if (ri.item_id && ri.items) return ri.items.name.toLowerCase().includes(q)
      if (ri.sub_recipe_id) {
        const sr = ri.sub_recipe || allRecipes.find(r => r.id === ri.sub_recipe_id)
        if (sr?.name?.toLowerCase().includes(q)) return true
        return recipeHasIngredient(sr, q, allRecipes, new Set(seen))
      }
      return false
    })
  }

  const ingQ = ingSearch.trim().toLowerCase()
  const filtered = recipes.filter(r => {
    const matchSearch = r.name.toLowerCase().includes(search.toLowerCase())
    const matchCat = filterCat === 'all' || r.category === filterCat
    const matchIngredient = !ingQ || recipeHasIngredient(r, ingQ, recipes)
    return matchSearch && matchCat && matchIngredient
  })

  const regularRecipes = filtered.filter(r => r.category !== 'Sub-Recipe')
  const subRecipeList = filtered.filter(r => r.category === 'Sub-Recipe')

  // Build tab list dynamically from categories present in recipes
  const presentCats = RECIPE_CATS.filter(c => c !== 'Sub-Recipe' && recipes.some(r => r.category === c))
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
              style={{ background: '#181c27', border: '1px solid #2a2f3d', borderRadius: 6, padding: '8px 12px', fontSize: 13, color: '#e8e0d0', outline: 'none', width: 240 }}
              placeholder="Search recipes…" value={search} onChange={e => setSearch(e.target.value)} />
            <div style={{ marginLeft: 'auto', position: 'relative' }}>
              <input
                style={{ background: '#181c27', border: `1px solid ${ingQ ? 'rgba(201,168,76,0.5)' : '#2a2f3d'}`, borderRadius: 6, padding: '8px 12px 8px 30px', fontSize: 13, color: '#e8e0d0', outline: 'none', width: 260 }}
                placeholder="Find ingredient in recipes…" value={ingSearch} onChange={e => setIngSearch(e.target.value)} />
              <span style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', fontSize: 13, color: '#6b7280', pointerEvents: 'none' }}>🔍</span>
              {ingSearch && (
                <button onClick={() => setIngSearch('')} title="Clear"
                  style={{ position: 'absolute', right: 6, top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', color: '#9ca3af', cursor: 'pointer', fontSize: 15, lineHeight: 1, padding: '0 4px' }}>×</button>
              )}
            </div>
          </div>
          {ingQ && (
            <div style={{ fontSize: 12, color: '#c9a84c', margin: '-8px 0 14px' }}>
              Showing recipes that use an ingredient matching "<strong>{ingSearch}</strong>" ({filtered.length} found).
            </div>
          )}

          {/* Tab bar */}
          <div style={{ display: 'flex', gap: 2, marginBottom: 0, borderBottom: '1px solid #2a2f3d' }}>
            {tabs.map(tab => {
              const isActive = activeTab === tab.key
              const isSubTab = tab.key === 'sub-recipes'
              return (
                <button
                  key={tab.key}
                  onClick={() => setActiveTab(tab.key)}
                  style={{
                    background: isActive ? '#2a2f3d' : 'transparent',
                    border: 'none',
                    borderBottom: isActive
                      ? `2px solid ${isSubTab ? '#c9a84c' : '#6366f1'}`
                      : '2px solid transparent',
                    padding: '10px 16px',
                    fontSize: 13,
                    fontWeight: isActive ? 600 : 400,
                    color: isActive
                      ? (isSubTab ? '#c9a84c' : '#e8e0d0')
                      : '#6b7280',
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
                    background: isActive ? (isSubTab ? 'rgba(201,168,76,0.15)' : 'rgba(99,102,241,0.15)') : '#2a2f3d',
                    color: isActive ? (isSubTab ? '#c9a84c' : '#818cf8') : '#9ca3af',
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
              <p style={{ color: '#6b7280', fontSize: 13 }}>Loading…</p>
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
                          <td style={{ color: '#c9a84c', fontFamily: 'monospace', fontSize: 12, whiteSpace: 'nowrap' }}>
                            {recipe.recipe_code || '—'}
                          </td>
                          <td style={{ fontWeight: 600, color: '#c9a84c', cursor: 'pointer' }} onClick={() => openDetail(recipe)}>
                            ⚙ {recipe.name}
                          </td>
                          <td style={{ color: '#6b7280' }}>{(recipe.recipe_ingredients || []).length} items</td>
                          <td style={{ textAlign: 'right', color: '#c9a84c' }}>NPR {cost.toFixed(2)}</td>
                          <td style={{ textAlign: 'right', color: '#6b7280' }}>{recipe.yield_qty} {recipe.yield_uom}</td>
                          <td style={{ textAlign: 'right', fontWeight: 700, color: '#e8e0d0' }}>
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
                      const fcColor = fcPct == null ? '#6b7280' : fcPct <= 30 ? '#34d399' : fcPct <= 38 ? '#c9a84c' : '#f87171'
                      const subIngCount = (recipe.recipe_ingredients || []).filter(ri => ri.sub_recipe_id).length
                      return (
                        <tr key={recipe.id}>
                          <td style={{ fontWeight: 600, color: '#e8e0d0', cursor: 'pointer' }} onClick={() => openDetail(recipe)}>
                            {recipe.name}
                            {subIngCount > 0 && <span style={{ fontSize: 10, color: '#c9a84c', marginLeft: 6 }}>⚙ {subIngCount} sub</span>}
                          </td>
                          {activeTab === 'all' && <td><span className="badge badge-yellow">{recipe.category}</span></td>}
                          <td style={{ color: '#6b7280' }}>{(recipe.recipe_ingredients || []).length} items</td>
                          <td style={{ textAlign: 'right', color: '#c9a84c' }}>NPR {cost.toFixed(2)}</td>
                          <td style={{ textAlign: 'right' }}>
                            {recipe.selling_price ? `NPR ${Number(recipe.selling_price).toFixed(2)}` : <span style={{ color: '#9ca3af' }}>—</span>}
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
            <h3 style={{ margin: '0 0 18px', fontSize: 14, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.08em' }}>Recipe Details</h3>
            <div style={{ display: 'grid', gridTemplateColumns: isSubRecipeForm ? '2fr 1fr 1fr 1fr' : '2fr 1fr 1fr 1fr', gap: 16 }}>
              <div className="form-field">
                <label>Recipe / Dish Name *</label>
                <input value={recipeForm.name} onChange={e => setRecipeForm(f => ({ ...f, name: e.target.value }))} placeholder="e.g. Mango Sticky Rice" autoFocus />
              </div>
              <div className="form-field">
                <label>Category</label>
                <select value={recipeForm.category} onChange={e => setRecipeForm(f => ({ ...f, category: e.target.value }))}>
                  {RECIPE_CATS.map(c => <option key={c} value={c}>{c === 'Sub-Recipe' ? '⚙ Sub-Recipe / Prep Item' : c}</option>)}
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
                    <label><Tip text="Enter the VAT-inclusive menu price. The system strips VAT and stores the ex-VAT price for accurate food cost calculation." width={280}>Menu Price (NPR, incl. 13% VAT)</Tip></label>
                    <div style={{ position: 'relative' }}>
                      <input
                        type="number"
                        key={recipeForm.selling_price ? 'has-price' : 'no-price'}
                        defaultValue={recipeForm.selling_price ? (parseFloat(recipeForm.selling_price) * (1 + (parseFloat(recipeForm.vat_rate) || 0.13))).toFixed(2) : ''}
                        onBlur={e => {
                          const rawPrice = parseFloat(e.target.value) || 0
                          const menuPrice = rawPrice > 0 ? Math.round(rawPrice) : 0
                          if (menuPrice !== rawPrice && e.target) e.target.value = menuPrice || ''
                          const vatRate = parseFloat(recipeForm.vat_rate) || 0.13
                          const exVat = menuPrice > 0 ? (menuPrice / (1 + vatRate)).toFixed(4) : ''
                          setRecipeForm(f => ({ ...f, selling_price: exVat }))
                        }}
                        placeholder="e.g. 500"
                      />
                      {recipeForm.selling_price && (
                        <div style={{ fontSize: 11, color: '#6b7280', marginTop: 4 }}>
                          Ex-VAT stored: NPR {parseFloat(recipeForm.selling_price).toFixed(2)}
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
                  {isAdmin && (
                    <div className="form-field">
                      <label><Tip text="Target food cost % for this recipe. Used to compute the suggested menu price. Nepal F&B average: 28–35%." width={260}>Target FC % 🔒</Tip></label>
                      <input
                        type="number" min="1" max="100"
                        value={recipeForm.target_fc_pct}
                        onChange={e => setRecipeForm(f => ({ ...f, target_fc_pct: e.target.value }))}
                        placeholder="30"
                      />
                      {recipeForm.target_fc_pct && (
                        <div style={{ fontSize: 11, color: '#6b7280', marginTop: 4 }}>
                          Suggested price targets {recipeForm.target_fc_pct}% food cost
                        </div>
                      )}
                    </div>
                  )}
                </>
              )}
            </div>
          </div>

          {/* Live cost panel */}
          {liveCost > 0 && (
            <div style={{
              background: 'rgba(201,168,76,0.06)', border: '1px solid rgba(201,168,76,0.2)',
              borderRadius: 8, padding: '16px 20px', marginBottom: 20,
              display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px,1fr))', gap: 16
            }}>
              <div>
                <div style={{ fontSize: 11, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: 4 }}>
                  {isSubRecipeForm ? 'Total Batch Cost' : 'Food Cost'}
                </div>
                <div style={{ fontSize: 20, fontWeight: 700, color: '#c9a84c' }}>NPR {liveCost.toFixed(2)}</div>
              </div>
              {isSubRecipeForm && liveCostPerUnit != null && (
                <div>
                  <div style={{ fontSize: 11, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: 4 }}>Cost per {recipeForm.yield_uom || 'unit'}</div>
                  <div style={{ fontSize: 20, fontWeight: 700, color: '#34d399' }}>NPR {liveCostPerUnit.toFixed(2)}</div>
                  <div style={{ fontSize: 11, color: '#6b7280', marginTop: 2 }}>Yield: {recipeForm.yield_qty} {recipeForm.yield_uom}</div>
                </div>
              )}
              {!isSubRecipeForm && livePrice > 0 && (
                <div>
                  <div style={{ fontSize: 11, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: 4 }}>Food Cost %</div>
                  <div style={{ fontSize: 20, fontWeight: 700, color: liveFcPct <= 30 ? '#34d399' : liveFcPct <= 38 ? '#c9a84c' : '#f87171' }}>
                    {liveFcPct?.toFixed(1)}%
                  </div>
                  <div style={{ fontSize: 11, color: '#6b7280', marginTop: 2 }}>
                    {liveFcPct <= 30 ? '✓ Good' : liveFcPct <= 38 ? '⚠ Acceptable' : '✗ Too high'}
                  </div>
                </div>
              )}
              {!isSubRecipeForm && livePrice > 0 && (
                <div>
                  <div style={{ fontSize: 11, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: 4 }}>Menu Price (incl. VAT)</div>
                  <div style={{ fontSize: 20, fontWeight: 700, color: '#e8e0d0' }}>NPR {livePriceWithVat.toFixed(0)}</div>
                </div>
              )}
              {suggestedPrice && (
                <div>
                  <div style={{ fontSize: 11, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: 4 }}>Suggested @ {recipeForm.target_fc_pct || 30}% FC</div>
                  <div style={{ fontSize: 20, fontWeight: 700, color: '#34d399' }}>NPR {suggestedPrice}</div>
                  <div style={{ fontSize: 11, color: '#6b7280', marginTop: 2 }}>incl. {(liveVat*100).toFixed(0)}% VAT, rounded</div>
                </div>
              )}
            </div>
          )}

          {/* Live nutrition line */}
          {liveNutri && liveNutri.coverage.total > 0 && (
            <div style={{
              background: 'rgba(99,102,241,0.05)', border: '1px solid rgba(99,102,241,0.18)',
              borderRadius: 8, padding: '10px 16px', marginBottom: 20,
              display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap', fontSize: 13
            }}>
              <span style={{ color: '#818cf8', fontWeight: 600, fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.08em' }}>
                🍽 {isSubRecipeForm ? 'total batch' : 'per portion'}
              </span>
              {NUTRIENTS.map(def => (
                <span key={def.key} style={{ color: '#e8e0d0' }}>{def.label} <strong>{fmtNutrient(def, liveNutri.perPortion[def.key])}</strong></span>
              ))}
              <span style={{ color: liveNutri.coverage.have < liveNutri.coverage.total ? '#c9a84c' : '#6b7280', fontSize: 12 }}>
                · data {liveNutri.coverage.have}/{liveNutri.coverage.total}
              </span>
            </div>
          )}

          {/* Ingredients */}
          <div className="card" style={{ marginBottom: 20 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 18 }}>
              <h3 style={{ margin: 0, fontSize: 14, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.08em' }}>Ingredients</h3>
              <div style={{ display: 'flex', gap: 8 }}>
                {showNutrition && (
                  <button className="btn btn-ghost" style={{ fontSize: 12, padding: '5px 12px', color: '#818cf8', borderColor: 'rgba(99,102,241,0.3)' }} onClick={autoFillNutrition} disabled={autoFillBusy}>
                    <Tip width={280} text="Fills every ingredient that's missing nutrition with its best match from the library (USDA / IFCT / Nepal), in one step. Branded items (Open Food Facts) and unmatched items are left for you to add manually. You can edit any afterward.">
                      {autoFillBusy ? 'Filling…' : '⚡ Auto-fill nutrition'}
                    </Tip>
                  </button>
                )}
                <button className="btn btn-ghost" style={{ fontSize: 12, padding: '5px 12px' }} onClick={addRow}>+ Add Row</button>
              </div>
            </div>

            <div className="table-wrap">
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr>
                  <th style={{ textAlign: 'left', fontSize: 11, color: '#6b7280', padding: '0 0 10px', letterSpacing: '0.08em', textTransform: 'uppercase', width: 100 }}>Type</th>
                  <th style={{ textAlign: 'left', fontSize: 11, color: '#6b7280', padding: '0 12px 10px 8px', letterSpacing: '0.08em', textTransform: 'uppercase' }}>Ingredient</th>
                  <th style={{ textAlign: 'right', fontSize: 11, color: '#6b7280', padding: '0 12px 10px', letterSpacing: '0.08em', textTransform: 'uppercase', width: 130 }}>Qty per Portion</th>
                  <th style={{ textAlign: 'left', fontSize: 11, color: '#6b7280', padding: '0 12px 10px', letterSpacing: '0.08em', textTransform: 'uppercase', width: 70 }}>UOM</th>
                  <th style={{ textAlign: 'right', fontSize: 11, color: '#6b7280', padding: '0 12px 10px', letterSpacing: '0.08em', textTransform: 'uppercase', width: 110 }}>Cost</th>
                  {showNutrition && <th style={{ textAlign: 'center', fontSize: 11, color: '#6b7280', padding: '0 12px 10px', letterSpacing: '0.08em', textTransform: 'uppercase', width: 90 }}>Nutrition</th>}
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
                          style={{ background: '#0f1117', border: '1px solid #2a2f3d', borderRadius: 5, padding: '7px 8px', fontSize: 12, color: ing.type === 'sub_recipe' ? '#c9a84c' : '#6b7280', outline: 'none', width: 95 }}
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
                          style={{ background: '#0f1117', border: '1px solid #2a2f3d', borderRadius: 5, padding: '7px 10px', fontSize: 13, color: '#e8e0d0', outline: 'none', width: 100, textAlign: 'right' }} />
                      </td>
                      <td style={{ padding: '6px 12px', color: ing.type === 'sub_recipe' ? '#c9a84c' : '#6b7280', fontSize: 13 }}>{uomLabel}</td>
                      <td style={{ padding: '6px 12px', textAlign: 'right', color: '#c9a84c', fontSize: 13, fontWeight: 600 }}>
                        {cost != null ? `NPR ${cost.toFixed(2)}` : '—'}
                      </td>
                      {showNutrition && (
                        <td style={{ padding: '6px 8px', textAlign: 'center' }}>
                          {ing.type === 'item' && ing.item_id ? (() => {
                            const it = items.find(i => i.id === ing.item_id)
                            const has = hasNutrition(it?.nutrition)
                            return (
                              <button onClick={() => openNutriEditor(ing.item_id)}
                                style={{ background: 'none', border: `1px solid ${has ? 'rgba(52,211,153,0.4)' : '#2a2f3d'}`, borderRadius: 5, padding: '4px 8px', fontSize: 11, color: has ? '#34d399' : '#6b7280', cursor: 'pointer', whiteSpace: 'nowrap' }}>
                                {has ? '● Edit' : '+ Add'}
                              </button>
                            )
                          })() : (
                            <span style={{ color: '#6b7280', fontSize: 11 }}>{ing.type === 'sub_recipe' ? 'auto' : '—'}</span>
                          )}
                        </td>
                      )}
                      <td style={{ padding: '6px 0', textAlign: 'right' }}>
                        <button onClick={() => removeRow(ing._key)}
                          style={{ background: 'none', border: 'none', color: '#9ca3af', cursor: 'pointer', fontSize: 16, padding: '0 4px' }}>×</button>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
            </div>
          </div>

          {error && <p style={{ color: '#f87171', fontSize: 13, margin: '0 0 16px' }}>{error}</p>}
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
        const vat = parseFloat(selectedRecipe.vat_rate) || 0.13
        const fcPct = price > 0 ? (cost / price) * 100 : null
        const yieldQty = parseFloat(selectedRecipe.yield_qty) || 1
        const costPerUnit = cost / yieldQty
        const fcColor = fcPct == null ? '#6b7280' : fcPct <= 30 ? '#34d399' : fcPct <= 38 ? '#c9a84c' : '#f87171'
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
              <div style={{ background: 'rgba(201,168,76,0.06)', border: '1px solid rgba(201,168,76,0.2)', borderRadius: 8, padding: '12px 16px', marginBottom: 20, fontSize: 13, color: '#c9a84c' }}>
                ⚙ Sub-Recipe — Yield: {selectedRecipe.yield_qty} {selectedRecipe.yield_uom} · Cost per {selectedRecipe.yield_uom}: NPR {costPerUnit.toFixed(2)}
              </div>
            )}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px,1fr))', gap: 14, marginBottom: 24 }}>
              {(isSubRec ? [
                { label: 'Total Batch Cost', value: `NPR ${cost.toFixed(2)}`, color: '#c9a84c' },
                { label: `Cost per ${selectedRecipe.yield_uom}`, value: `NPR ${costPerUnit.toFixed(2)}`, color: '#34d399' },
                { label: 'Yield', value: `${selectedRecipe.yield_qty} ${selectedRecipe.yield_uom}`, color: '#e8e0d0' },
              ] : [
                { label: 'Food Cost', value: `NPR ${cost.toFixed(2)}`, color: '#c9a84c' },
                { label: 'Food Cost %', value: fcPct != null ? `${fcPct.toFixed(1)}%` : '—', color: fcColor },
                { label: 'Selling Price (ex. VAT)', value: price ? `NPR ${price.toFixed(2)}` : '—', color: '#e8e0d0' },
                { label: `Menu Price (incl. ${(vat*100).toFixed(0)}% VAT)`, value: price ? `NPR ${(price*(1+vat)).toFixed(0)}` : '—', color: '#e8e0d0' },
                { label: `Suggested @ ${selectedRecipe.target_fc_pct || 30}% FC`, value: `NPR ${getSuggestedPrice(cost, vat, (parseFloat(selectedRecipe.target_fc_pct) || 30) / 100)}`, color: '#34d399' },
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
              const vat = parseFloat(selectedRecipe.vat_rate) || 0.13
              const suggestedRaw = trueCost / 0.20
              const suggestedVat = Math.ceil((suggestedRaw * (1 + vat)) / 5) * 5
              return (
                <div style={{
                  background: 'rgba(52,211,153,0.06)', border: '1px solid rgba(52,211,153,0.2)',
                  borderRadius: 8, padding: '16px 20px', marginBottom: 20
                }}>
                  <div style={{ fontSize: 11, color: '#34d399', textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: 14, fontWeight: 600 }}>
                    ⚖ True Cost with Overheads
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px,1fr))', gap: 16 }}>
                    <div>
                      <div style={{ fontSize: 11, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 4 }}>Overhead / Portion</div>
                      <div style={{ fontSize: 18, fontWeight: 700, color: '#34d399' }}>NPR {ohPerPortion.toFixed(2)}</div>
                      <div style={{ fontSize: 11, color: '#6b7280', marginTop: 2 }}>NPR {overheadData.totalOverheads.toLocaleString()} ÷ {overheadData.totalCovers} covers</div>
                    </div>
                    <div>
                      <div style={{ fontSize: 11, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 4 }}>True Cost / Portion</div>
                      <div style={{ fontSize: 18, fontWeight: 700, color: '#c9a84c' }}>NPR {trueCost.toFixed(2)}</div>
                      <div style={{ fontSize: 11, color: '#6b7280', marginTop: 2 }}>Food + Overhead</div>
                    </div>
                    <div>
                      <div style={{ fontSize: 11, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 4 }}>True Net Margin %</div>
                      <div style={{ fontSize: 18, fontWeight: 700, color: trueNetMargin >= 20 ? '#34d399' : '#f87171' }}>
                        {trueNetMargin != null ? `${trueNetMargin.toFixed(1)}%` : '—'}
                      </div>
                      <div style={{ fontSize: 11, color: '#6b7280', marginTop: 2 }}>{trueNetMargin >= 20 ? '✓ Healthy' : '✗ Below 20%'}</div>
                    </div>
                    <div>
                      <div style={{ fontSize: 11, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 4 }}>Suggested Price @ 20% margin</div>
                      <div style={{ fontSize: 18, fontWeight: 700, color: '#34d399' }}>NPR {suggestedVat}</div>
                      <div style={{ fontSize: 11, color: '#6b7280', marginTop: 2 }}>incl. {(vat*100).toFixed(0)}% VAT, rounded to ÷5</div>
                    </div>
                  </div>
                </div>
              )
            })()}

            {/* Nutrition panel (per portion) */}
            {nutri && (
              <div style={{
                background: 'rgba(99,102,241,0.06)', border: '1px solid rgba(99,102,241,0.2)',
                borderRadius: 8, padding: '16px 20px', marginBottom: 20
              }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 14, flexWrap: 'wrap', gap: 8 }}>
                  <div style={{ fontSize: 11, color: '#818cf8', textTransform: 'uppercase', letterSpacing: '0.1em', fontWeight: 600 }}>
                    🍽 Nutrition ({nutriLabel})
                  </div>
                  <div style={{ fontSize: 11, color: nutri.coverage.have < nutri.coverage.total ? '#c9a84c' : '#6b7280' }}>
                    <Tip width={260} text="How many ingredients have nutrition data entered. Missing ingredients contribute 0, so values below 100% are underestimates. Add data on each item's Nutrition tab.">
                      Data: {nutri.coverage.have}/{nutri.coverage.total} ingredients
                    </Tip>
                  </div>
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(110px,1fr))', gap: 16 }}>
                  {NUTRIENTS.map(def => (
                    <div key={def.key}>
                      <div style={{ fontSize: 11, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 4 }}>{def.label}</div>
                      <div style={{ fontSize: 18, fontWeight: 700, color: '#e8e0d0' }}>{fmtNutrient(def, nutriValues[def.key])}</div>
                    </div>
                  ))}
                </div>
                <div style={{ marginTop: 14, display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                  <span style={{ fontSize: 11, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.08em' }}>Allergens</span>
                  {nutri.allergens.length > 0
                    ? nutri.allergens.map(a => (
                        <span key={a} className="badge" style={{ background: 'rgba(248,113,113,0.12)', color: '#f87171', textTransform: 'capitalize' }}>{a}</span>
                      ))
                    : <span style={{ fontSize: 12, color: '#6b7280' }}>None tagged</span>}
                </div>
                {nutri.coverage.have < nutri.coverage.total && (
                  <div style={{ fontSize: 11, color: '#c9a84c', marginTop: 10 }}>
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
                        <td style={{ fontWeight: 600, color: ri.sub_recipe_id ? '#c9a84c' : '#e8e0d0' }}>
                          {ri.items?.item_code && (
                            <span style={{ fontSize: 10, fontFamily: 'monospace', color: '#c9a84c', marginRight: 7, fontWeight: 400 }}>{ri.items.item_code}</span>
                          )}
                          {ri.sub_recipe?.recipe_code && (
                            <span style={{ fontSize: 10, fontFamily: 'monospace', color: '#c9a84c', marginRight: 7, fontWeight: 400 }}>{ri.sub_recipe.recipe_code}</span>
                          )}
                          {name}
                        </td>
                        <td><span className={`badge ${ri.sub_recipe_id ? 'badge-yellow' : 'badge-gray'}`}>{ri.sub_recipe_id ? 'Sub-Recipe' : 'Item'}</span></td>
                        <td style={{ textAlign: 'right' }}>{ri.qty_per_portion}</td>
                        <td style={{ color: '#6b7280' }}>{uom}</td>
                        <td style={{ textAlign: 'right', color: yieldPct != null && yieldPct < 100 ? '#f87171' : '#6b7280' }}>
                          {yieldPct != null ? `${yieldPct.toFixed(0)}%` : '—'}
                        </td>
                        <td style={{ textAlign: 'right', color: '#6b7280' }}>NPR {unitRate.toFixed(2)}</td>
                        <td style={{ textAlign: 'right', color: '#c9a84c', fontWeight: 600 }}>NPR {itemCost.toFixed(2)}</td>
                        <td style={{ textAlign: 'right' }}>
                          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 8 }}>
                            <div style={{ width: 60, height: 4, background: '#2a2f3d', borderRadius: 2 }}>
                              <div style={{ width: `${Math.min(pctOfDish,100)}%`, height: '100%', background: '#c9a84c', borderRadius: 2 }} />
                            </div>
                            <span style={{ fontSize: 12, color: '#6b7280', minWidth: 36 }}>{pctOfDish.toFixed(1)}%</span>
                          </div>
                        </td>
                      </tr>
                    )
                  })}
                  <tr style={{ borderTop: '2px solid #2a2f3d' }}>
                    <td colSpan={6} style={{ fontWeight: 700, color: '#6b7280', paddingTop: 12 }}>Total</td>
                    <td style={{ textAlign: 'right', fontWeight: 700, color: '#c9a84c', fontSize: 15, paddingTop: 12 }}>NPR {cost.toFixed(2)}</td>
                    <td></td>
                  </tr>
                </tbody>
              </table>
              </div>
            </div>
            <div style={{ marginTop: 16, display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
              <button className="btn btn-ghost" onClick={() => setView('list')}>← Back</button>
              <button className="btn btn-ghost" style={{ fontSize: 12 }} onClick={() => window.print()}>🖶 Print Cost Card</button>
              <button className="btn btn-ghost" onClick={() => openEdit(selectedRecipe)}>Edit Recipe</button>
            </div>
          </div>
          </div>

          {/* ── PRINT-ONLY COST CARD ── */}
          <div className="print-only">
            <div style={{ fontFamily: 'Georgia, serif', color: '#000', padding: '20px 24px', maxWidth: 680, margin: '0 auto' }}>

              {/* Header */}
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', borderBottom: '2px solid #000', paddingBottom: 10, marginBottom: 14 }}>
                <div>
                  <div style={{ fontSize: 10, letterSpacing: '0.12em', textTransform: 'uppercase', color: '#555', marginBottom: 2 }}>
                    {settings?.app_name || 'Crest Inventory'}
                  </div>
                  <div style={{ fontSize: 22, fontWeight: 700, color: '#000' }}>{selectedRecipe.name}</div>
                  <div style={{ fontSize: 12, color: '#555', marginTop: 3 }}>
                    {isSubRec
                      ? `Sub-Recipe · Yield: ${selectedRecipe.yield_qty} ${selectedRecipe.yield_uom}`
                      : `Category: ${selectedRecipe.category}`}
                  </div>
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
                  { label: `Cost per ${selectedRecipe.yield_uom}`, value: `NPR ${costPerUnit.toFixed(2)}` },
                  { label: 'Yield', value: `${selectedRecipe.yield_qty} ${selectedRecipe.yield_uom}` },
                ] : [
                  { label: 'Food Cost', value: `NPR ${cost.toFixed(2)}` },
                  { label: `Selling Price (ex-VAT)`, value: price ? `NPR ${price.toFixed(2)}` : '—' },
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
                      <th key={h} style={{ textAlign: i === 0 ? 'left' : i === 2 ? 'left' : 'right', padding: '4px 6px', fontWeight: 700, fontSize: 10, color: '#555', textTransform: 'uppercase', letterSpacing: '0.06em', paddingLeft: i === 0 ? 0 : 6, paddingRight: i === 5 ? 0 : 6 }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {(selectedRecipe.recipe_ingredients || []).map((ri, idx) => {
                    let ingName, ingUom, ingRate, ingCost
                    if (ri.item_id && ri.items) {
                      ingName = ri.items.name
                      ingUom = ri.items.uom
                      ingRate = parseFloat(ri.items.per_uom_rate || 0)
                      ingCost = parseFloat(ri.qty_per_portion) * ingRate
                    } else if (ri.sub_recipe_id && ri.sub_recipe) {
                      const cpu = calcSubRecipeCostPerUnit(ri.sub_recipe, recipes)
                      ingName = `⚙ ${ri.sub_recipe.name}`
                      ingUom = ri.sub_recipe.yield_uom
                      ingRate = cpu
                      ingCost = parseFloat(ri.qty_per_portion) * cpu
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

              {/* Nutrition strip (print) */}
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
                const ohPerPortion2 = overheadData.totalOverheads / overheadData.totalCovers
                const trueCost2 = cost + ohPerPortion2
                const trueMargin2 = price > 0 ? ((price - trueCost2) / price) * 100 : null
                const suggestedVat2 = Math.ceil(((trueCost2 / 0.20) * (1 + vat)) / 5) * 5
                return (
                  <div style={{ marginTop: 16, padding: '10px 12px', border: '1px solid #ccc', borderRadius: 3 }}>
                    <div style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.1em', color: '#555', marginBottom: 8 }}>True Cost with Overheads</div>
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12 }}>
                      {[
                        { label: 'Overhead / Portion', value: `NPR ${ohPerPortion2.toFixed(2)}` },
                        { label: 'True Cost / Portion', value: `NPR ${trueCost2.toFixed(2)}` },
                        { label: 'True Net Margin %', value: trueMargin2 != null ? `${trueMargin2.toFixed(1)}%` : '—' },
                        { label: 'Suggested @ 20% Margin', value: `NPR ${suggestedVat2}` },
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
                <span>Generated by Crest Inventory · {new Date().toLocaleDateString('en-NP')}</span>
              </div>
            </div>
          </div>
          </>
        )
      })()}

      {/* ── LIST-VIEW PRINT CARD (fires when 🖶 clicked from list) ── */}
      {printRecipe && (() => {
        const r = printRecipe
        const isSubRec = r.category === 'Sub-Recipe'
        const cost = calcRecipeCost(r, recipes)
        const price = parseFloat(r.selling_price) || 0
        const vat = parseFloat(r.vat_rate) || 0.13
        const fcPct = price > 0 ? (cost / price) * 100 : null
        const yieldQty = parseFloat(r.yield_qty) || 1
        const costPerUnit = cost / yieldQty
        const nutri = showNutrition ? calcRecipeNutrition(r, recipes) : null
        const nutriLabel = isSubRec ? 'total batch' : 'per portion'
        const nutriValues = nutri ? nutri.perPortion : null
        return (
          <div className="print-only">
            <div style={{ fontFamily: 'Georgia, serif', color: '#000', padding: '20px 24px', maxWidth: 680, margin: '0 auto' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', borderBottom: '2px solid #000', paddingBottom: 10, marginBottom: 14 }}>
                <div>
                  <div style={{ fontSize: 10, letterSpacing: '0.12em', textTransform: 'uppercase', color: '#555', marginBottom: 2 }}>{settings?.app_name || 'Crest Inventory'}</div>
                  <div style={{ fontSize: 22, fontWeight: 700, color: '#000' }}>{r.name}</div>
                  <div style={{ fontSize: 12, color: '#555', marginTop: 3 }}>{isSubRec ? `Sub-Recipe · Yield: ${r.yield_qty} ${r.yield_uom}` : `Category: ${r.category}`}</div>
                </div>
                <div style={{ textAlign: 'right' }}>
                  <div style={{ fontSize: 9, color: '#777', textTransform: 'uppercase', letterSpacing: '0.1em' }}>Recipe Cost Card</div>
                  <div style={{ fontSize: 11, color: '#555', marginTop: 4 }}>{new Date().toLocaleDateString('en-NP')}</div>
                </div>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: isSubRec ? '1fr 1fr 1fr' : 'repeat(5, 1fr)', gap: 12, marginBottom: 18, padding: '10px 0', borderBottom: '1px solid #ddd' }}>
                {(isSubRec ? [
                  { label: 'Total Batch Cost', value: `NPR ${cost.toFixed(2)}` },
                  { label: `Cost per ${r.yield_uom}`, value: `NPR ${costPerUnit.toFixed(2)}` },
                  { label: 'Yield', value: `${r.yield_qty} ${r.yield_uom}` },
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
              <div style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.1em', color: '#555', marginBottom: 6 }}>Ingredients</div>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11 }}>
                <thead>
                  <tr style={{ borderBottom: '1px solid #000' }}>
                    {['Ingredient', 'Qty', 'UOM', 'Rate (NPR)', 'Cost (NPR)', '% of Dish'].map((h, i) => (
                      <th key={h} style={{ textAlign: i === 0 || i === 2 ? 'left' : 'right', padding: '4px 6px', fontWeight: 700, fontSize: 10, color: '#555', textTransform: 'uppercase', letterSpacing: '0.06em', paddingLeft: i === 0 ? 0 : 6, paddingRight: i === 5 ? 0 : 6 }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {(r.recipe_ingredients || []).map((ri, idx) => {
                    let ingName, ingUom, ingRate, ingCost
                    if (ri.item_id && ri.items) {
                      ingName = ri.items.name; ingUom = ri.items.uom
                      ingRate = parseFloat(ri.items.per_uom_rate || 0)
                      ingCost = parseFloat(ri.qty_per_portion) * ingRate
                    } else if (ri.sub_recipe_id && ri.sub_recipe) {
                      const cpu = calcSubRecipeCostPerUnit(ri.sub_recipe, recipes)
                      ingName = `⚙ ${ri.sub_recipe.name}`; ingUom = ri.sub_recipe.yield_uom
                      ingRate = cpu; ingCost = parseFloat(ri.qty_per_portion) * cpu
                    } else return null
                    const pct = cost > 0 ? (ingCost / cost) * 100 : 0
                    return (
                      <tr key={ri.id || idx} style={{ borderBottom: '1px solid #eee' }}>
                        <td style={{ padding: '5px 6px 5px 0' }}>{ingName}</td>
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
              {!isSubRec && overheadData && price > 0 && (() => {
                const ohPer = overheadData.totalOverheads / overheadData.totalCovers
                const trueCost = cost + ohPer
                const trueMargin = price > 0 ? ((price - trueCost) / price) * 100 : null
                const suggested = Math.ceil(((trueCost / 0.20) * (1 + vat)) / 5) * 5
                return (
                  <div style={{ marginTop: 16, padding: '10px 12px', border: '1px solid #ccc', borderRadius: 3 }}>
                    <div style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.1em', color: '#555', marginBottom: 8 }}>True Cost with Overheads</div>
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12 }}>
                      {[
                        { label: 'Overhead / Portion', value: `NPR ${ohPer.toFixed(2)}` },
                        { label: 'True Cost / Portion', value: `NPR ${trueCost.toFixed(2)}` },
                        { label: 'True Net Margin %', value: trueMargin != null ? `${trueMargin.toFixed(1)}%` : '—' },
                        { label: 'Suggested @ 20% Margin', value: `NPR ${suggested}` },
                      ].map(m => (
                        <div key={m.label}>
                          <div style={{ fontSize: 9, color: '#777', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 3 }}>{m.label}</div>
                          <div style={{ fontSize: 13, fontWeight: 700 }}>{m.value}</div>
                        </div>
                      ))}
                    </div>
                  </div>
                )
              })()}
              <div style={{ marginTop: 20, paddingTop: 8, borderTop: '1px solid #ddd', display: 'flex', justifyContent: 'space-between', fontSize: 9, color: '#999' }}>
                <span>CONFIDENTIAL — Internal use only</span>
                <span>Generated by Crest Inventory · {new Date().toLocaleDateString('en-NP')}</span>
              </div>
            </div>
          </div>
        )
      })()}

      {/* ── INLINE NUTRITION EDITOR (per ingredient) ── */}
      {nutriItemId && nutriItem && (
        <Modal onClose={() => setNutriItemId(null)} title={`Nutrition — ${nutriItem.name}`} maxWidth={640}>
          <p style={{ fontSize: 13, color: '#6b7280', margin: '0 0 18px' }}>
            Enter values <strong style={{ color: '#e8e0d0' }}>per the reference quantity below</strong> (e.g. per {nutriForm.basis_qty} {nutriForm.basis_unit}).
            {defaultBasisUnit(nutriItem.uom) !== (nutriItem.uom || '').toUpperCase() && (
              <> This item is used in <strong style={{ color: '#e8e0d0' }}>{nutriItem.uom}</strong> in recipes — that's fine, the conversion to {nutriForm.basis_unit} is automatic.</>
            )}
            {' '}Saved to the ingredient, so it fills <strong style={{ color: '#e8e0d0' }}>every recipe</strong> that uses it.
          </p>

          <div style={{ display: 'flex', alignItems: 'flex-end', gap: 16, flexWrap: 'wrap', marginBottom: 16 }}>
            <div className="form-field" style={{ width: 110 }}>
              <label><Tip width={240} text="Reference amount these values describe. Food tables use 100 (per 100 GM/ML). For counted items use 1 (per piece).">Per (qty)</Tip></label>
              <input type="number" min="0" step="any" value={nutriForm.basis_qty}
                onChange={e => setNF({ basis_qty: e.target.value })} placeholder="100" />
            </div>
            <div className="form-field" style={{ width: 120 }}>
              <label>Per (unit)</label>
              <select value={nutriForm.basis_unit} onChange={e => setNF({ basis_unit: e.target.value })}>
                {UNITS.map(u => <option key={u} value={u}>{u}</option>)}
              </select>
            </div>
            <button className="btn btn-ghost" style={{ fontSize: 12, marginBottom: 4 }} onClick={findNutriSeeds}>
              ⚡ Suggest from library
            </button>
            {nutriForm.source && (
              <span style={{ fontSize: 11, color: '#34d399', marginBottom: 8 }}>Source: {nutriForm.source}</span>
            )}
          </div>

          {nutriMatches.length > 0 && (
            <div style={{ marginBottom: 16, padding: '10px 14px', background: 'rgba(99,102,241,0.06)', border: '1px solid rgba(99,102,241,0.2)', borderRadius: 8 }}>
              <div style={{ fontSize: 11, color: '#818cf8', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 8 }}>
                {nutriMatches.length} match{nutriMatches.length > 1 ? 'es' : ''} — choose a source to fill
              </div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                {nutriMatches.map((s, i) => (
                  <button key={i} className="btn btn-ghost" style={{ fontSize: 12, textAlign: 'left', padding: '7px 11px', lineHeight: 1.35 }} onClick={() => applyNutriSeed(s)}>
                    <span style={{ display: 'block', color: '#e8e0d0', fontWeight: 600 }}>{s.name}</span>
                    <span style={{ display: 'block', color: '#6b7280', fontSize: 11 }}>
                      <span style={{ color: s.source === 'DFTQC Nepal' ? '#34d399' : s.source === 'IFCT 2017' ? '#c9a84c' : '#9ca3af' }}>{s.source}</span>
                      {' · '}{s.energy_kcal} kcal · P{s.protein_g} C{s.carbs_g} F{s.fat_g} /100{s.unit}
                    </span>
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Open Food Facts — branded / packaged products */}
          <div style={{ marginBottom: 16, padding: '12px 14px', background: 'rgba(52,211,153,0.05)', border: '1px solid rgba(52,211,153,0.18)', borderRadius: 8 }}>
            <div style={{ fontSize: 11, color: '#34d399', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 8 }}>
              <Tip width={280} text="For branded / packaged goods (sauces, drinks, snacks). Search by product name or paste a barcode. Pulls nutrition per 100 g from the Open Food Facts database.">Fetch from Open Food Facts</Tip>
            </div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <input
                value={offQuery}
                onChange={e => setOffQuery(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); fetchFromOFF() } }}
                placeholder="Product name or barcode…"
                style={{ flex: 1, minWidth: 180, background: '#0f1117', border: '1px solid #2a2f3d', borderRadius: 5, padding: '7px 10px', fontSize: 13, color: '#e8e0d0', outline: 'none' }}
              />
              <button className="btn btn-ghost" style={{ fontSize: 12 }} onClick={fetchFromOFF} disabled={offBusy || !offQuery.trim()}>
                {offBusy ? 'Searching…' : '🔍 Fetch'}
              </button>
            </div>
            {offError && <p style={{ color: '#c9a84c', fontSize: 12, margin: '8px 0 0' }}>{offError}</p>}
            {offResults.length > 0 && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 10 }}>
                {offResults.map((r, i) => (
                  <button key={i} className="btn btn-ghost" style={{ fontSize: 12, textAlign: 'left', padding: '7px 11px', lineHeight: 1.35 }} onClick={() => applyOffResult(r)}>
                    <span style={{ display: 'block', color: '#e8e0d0', fontWeight: 600 }}>{r.name}</span>
                    <span style={{ display: 'block', color: '#6b7280', fontSize: 11 }}>
                      {r.energy_kcal ?? '–'} kcal · P{r.protein_g ?? '–'} C{r.carbs_g ?? '–'} F{r.fat_g ?? '–'} /100g
                      {r.allergens ? ` · ${r.allergens}` : ''}
                    </span>
                  </button>
                ))}
                <span style={{ fontSize: 10, color: '#6b7280', marginTop: 2 }}>Data from Open Food Facts (ODbL). Crowd-sourced — verify before relying on it.</span>
              </div>
            )}
          </div>

          <div className="form-grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 14 }}>
            {NUTRIENTS.map(def => (
              <div className="form-field" key={def.key}>
                <label>
                  {def.key === 'sodium_mg'
                    ? <Tip width={220} text="Sodium is in milligrams (mg), not grams. 1 g salt ≈ 388 mg sodium.">{def.label} ({def.unit})</Tip>
                    : `${def.label} (${def.unit})`}
                </label>
                <input type="number" min="0" step="any" value={nutriForm[def.key]}
                  onChange={e => setNF({ [def.key]: e.target.value })} placeholder="0" />
              </div>
            ))}
            <div className="form-field" style={{ gridColumn: 'span 2' }}>
              <label><Tip width={240} text="Comma-separated allergen tags (e.g. dairy, gluten, nuts). Aggregated across the recipe's ingredients.">Allergens</Tip></label>
              <input value={nutriForm.allergens} onChange={e => setNF({ allergens: e.target.value })} placeholder="e.g. dairy, gluten" />
            </div>
          </div>

          <p style={{ fontSize: 11, color: '#9ca3af', margin: '12px 0 0' }}>
            Library values are reference estimates — verify for branded or prepared items.
          </p>
          {nutriError && <p style={{ color: '#f87171', fontSize: 13, margin: '10px 0 0' }}>{nutriError}</p>}
          <div className="form-actions" style={{ marginTop: 16, display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
            <button className="btn btn-ghost" onClick={() => setNutriItemId(null)}>Cancel</button>
            <button className="btn btn-primary" onClick={saveNutri} disabled={nutriSaving}>
              {nutriSaving ? 'Saving…' : 'Save Nutrition'}
            </button>
          </div>
        </Modal>
      )}

      <Fab onClick={openNew} label="+ New Recipe" show={view === 'list'} />
    </div>
  )
}
