import { useState } from 'react'
import { supabase } from '../../../supabaseClient'
import Tip from '../../../components/Tip'
import Modal from '../../../components/Modal'
import AllergenTicks from '../../../components/AllergenTicks'
import { NUTRIENTS, EMPTY_NUTRITION, buildNutritionPayload, defaultBasisUnit, pieceToBasisDim } from '../../../utils/nutrition'
import { normaliseAllergens, allergenLabel } from '../../../shared/constants/allergens'
import { suggestSeedsForSource } from '../../../data/nutritionSeed'
import { UNITS } from '../recipes/recipeCostCalc'
import ActionError, { asActionError } from '../../../components/ActionError'

const LIBRARIES = ['DFTQC Nepal', 'IFCT 2017', 'USDA']

// The form keeps allergens as an array of words (the ticked keys, then any unmatched word).
function allergenWords(raw) {
  const { keys, other } = normaliseAllergens(raw)
  return [...keys, ...other]
}
// A library or Open Food Facts pick adds its allergens to what is already ticked, never replaces it.
function withAllergens(current, added) {
  return allergenWords([...(current || []), ...allergenWords(added)])
}

// Builds the initial form from an item's saved nutrition (or sensible defaults). `initialAllergens`
// (the Check allergens list's guess) are ticked on top of what the item already carries.
function initFormFromItem(item, initialAllergens) {
  const n = item?.nutrition || {}
  const form = {
    basis_qty: n.basis_qty != null ? n.basis_qty : 100,
    // Default to GM/ML for mass/volume items so per-100g table values drop in directly;
    // the engine converts the recipe qty (e.g. 0.009 KG) into this unit automatically.
    basis_unit: n.basis_unit || defaultBasisUnit(item?.uom),
    allergens: initialAllergens ? withAllergens(allergenWords(n.allergens), initialAllergens) : allergenWords(n.allergens),
    not_food: n.not_food === true,
    grams_per_unit: n.grams_per_unit != null ? n.grams_per_unit : '',
    source: n.source || '',
  }
  NUTRIENTS.forEach(d => { form[d.key] = n[d.key] != null ? n[d.key] : '' })
  return form
}

// Per-ingredient nutrition and allergen editor — saves to items.nutrition. Self-contained: owns its
// form + library-suggestion + Open Food Facts lookup state; the parent passes the item being
// edited and gets onSaved(itemId, payload) so it can update its local items/recipes caches.
// Opened from a recipe's ingredient row and, since S870, from Item Master. Saving marks the
// ingredient checked for allergens (buildNutritionPayload), even with nothing ticked.
// `initialAllergens` and `guessNote` come from the Check allergens list (AllergenReviewModal): the
// form opens with Crest's guess ticked and says where it came from.
export default function NutritionEditorModal({ item, onClose, onSaved, initialAllergens = null, guessNote = '' }) {
  const [nutriForm, setNutriForm] = useState(() => item ? initFormFromItem(item, initialAllergens) : { ...EMPTY_NUTRITION, allergens: [] })
  const [nutriMatches, setNutriMatches] = useState([])
  const [nutriMatchSource, setNutriMatchSource] = useState('')
  const [nutriSaving, setNutriSaving] = useState(false)
  const [nutriError, setNutriError] = useState('')
  // Open Food Facts lookup (branded/packaged products)
  const [offQuery, setOffQuery] = useState('')
  const [offResults, setOffResults] = useState([])
  const [offBusy, setOffBusy] = useState(false)
  const [offError, setOffError] = useState('')

  function setNF(val) { setNutriForm(prev => ({ ...prev, ...val })) }

  function findNutriSeedsFor(source) {
    const matches = suggestSeedsForSource(item?.name || '', source)
    setNutriMatches(matches)
    setNutriMatchSource(source)
    setNutriError(matches.length === 0 ? `No ${source} entry for "${item?.name}". Try another library or enter manually.` : '')
  }

  function applyNutriSeed(seed) {
    setNutriError('')
    setNutriMatches([])
    setNutriMatchSource('')
    setNutriForm(prev => ({
      ...prev,
      basis_qty: 100,
      basis_unit: seed.unit || item?.uom || 'GM',
      energy_kcal: seed.energy_kcal, protein_g: seed.protein_g, carbs_g: seed.carbs_g,
      fat_g: seed.fat_g, sugar_g: seed.sugar_g, sodium_mg: seed.sodium_mg,
      allergens: withAllergens(prev.allergens, seed.allergens), source: seed.source || '',
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
      allergens: withAllergens(prev.allergens, row.allergens), source: 'Open Food Facts',
    }))
  }

  async function saveNutri() {
    if (!item?.id) return
    setNutriSaving(true)
    setNutriError('')
    const payload = buildNutritionPayload(nutriForm, nutriForm.basis_unit)
    const { error } = await supabase.from('items').update({ nutrition: payload }).eq('id', item.id)
    if (error) { const a = asActionError(error); setNutriError({ text: 'The nutrition and allergens were not saved. ' + a.text, detail: a.detail }); setNutriSaving(false); return }
    setNutriSaving(false)
    onSaved(item.id, payload)
  }

  if (!item) return null

  // S870: an item counted in pieces with figures per grams or ml needs what one piece weighs.
  const pieceDim = pieceToBasisDim(item.uom, nutriForm.basis_unit)
  const pieceUnit = pieceDim === 'vol' ? 'ml' : 'g'
  const weightMissing = pieceDim && !(parseFloat(nutriForm.grams_per_unit) > 0)
    && NUTRIENTS.some(d => parseFloat(nutriForm[d.key]) > 0)

  return (
    <Modal onClose={onClose} title={`Nutrition and allergens — ${item.name}`} maxWidth={640}>
      <p style={{ fontSize: 13, color: 'var(--theme-text2)', margin: '0 0 18px' }}>
        Enter values <strong style={{ color: 'var(--theme-text1)' }}>per the reference quantity below</strong> (e.g. per {nutriForm.basis_qty} {nutriForm.basis_unit}).
        {defaultBasisUnit(item.uom) !== (item.uom || '').toUpperCase() && (
          <> This item is used in <strong style={{ color: 'var(--theme-text1)' }}>{item.uom}</strong> in recipes — that's fine, the conversion to {nutriForm.basis_unit} is automatic.</>
        )}
        {' '}Saved to the ingredient, so it fills <strong style={{ color: 'var(--theme-text1)' }}>every recipe</strong> that uses it.
      </p>

      <label className="form-check" style={{ marginBottom: 12 }}>
        <input type="checkbox" checked={!!nutriForm.not_food} disabled={nutriSaving}
          onChange={e => setNF({ not_food: e.target.checked })} />
        <span>
          Not food
          <span style={{ display: 'block', fontSize: 11, color: 'var(--theme-text3)' }}>Cups, lids, packaging, cleaning supplies: no nutrition and no allergens, and never counted as missing data in a recipe.</span>
        </span>
      </label>
      {!nutriForm.not_food && (<>

      <div style={{ display: 'flex', alignItems: 'flex-end', gap: 16, flexWrap: 'wrap', marginBottom: 16 }}>
        <div className="form-field" style={{ width: 110 }}>
          <label htmlFor="nutrit-f1"><Tip width={240} text="Reference amount these values describe. Food tables use 100 (per 100 GM/ML). For counted items use 1 (per piece).">Per (qty)</Tip></label>
          <input id="nutrit-f1" type="number" min="0" step="any" value={nutriForm.basis_qty}
            onChange={e => setNF({ basis_qty: e.target.value })} placeholder="100" />
        </div>
        <div className="form-field" style={{ width: 120 }}>
          <label htmlFor="nutrit-f2">Per (unit)</label>
          <select id="nutrit-f2" value={nutriForm.basis_unit} onChange={e => setNF({ basis_unit: e.target.value })}>
            {UNITS.map(u => <option key={u} value={u}>{u}</option>)}
          </select>
        </div>
        {pieceDim && (
          <div className="form-field" style={{ width: 170 }}>
            <label htmlFor="nutrit-gpu">
              <Tip width={290} text={`The figures are per ${nutriForm.basis_unit}, but this item is counted in ${item.uom}. Crest needs what one ${item.uom} weighs to count it in a recipe: an egg is about 50 g, a burger bun about 60 g. Without it, this ingredient counts as missing nutrition data.`}>
                Weight of one {item.uom} ({pieceUnit})
              </Tip>
            </label>
            <input id="nutrit-gpu" type="number" min="0" step="any" value={nutriForm.grams_per_unit}
              onChange={e => setNF({ grams_per_unit: e.target.value })} placeholder="e.g. 50"
              aria-invalid={weightMissing || undefined} aria-describedby={weightMissing ? 'nutrit-gpu-note' : undefined} />
          </div>
        )}
        <div style={{ display: 'flex', gap: 6, marginBottom: 4 }}>
          {LIBRARIES.map(lib => (
            <button
              key={lib}
              className="btn btn-ghost"
              style={{
                fontSize: 12,
                color: nutriMatchSource === lib ? 'var(--theme-text1)' : undefined,
                borderColor: nutriMatchSource === lib ? 'currentColor' : undefined,
              }}
              onClick={() => findNutriSeedsFor(lib)}
            >
              {lib}
            </button>
          ))}
        </div>
        {nutriForm.source && (
          <span style={{ fontSize: 11, color: 'var(--theme-text2)', marginBottom: 8 }}>Source: {nutriForm.source}</span>
        )}
      </div>

      {weightMissing && (
        <p id="nutrit-gpu-note" style={{ fontSize: 12, color: 'var(--theme-amber-text)', margin: '-6px 0 14px' }}>
          △ Add the weight of one {item.uom}. Until then this ingredient counts as missing nutrition data in every recipe.
        </p>
      )}

      {nutriMatches.length > 0 && (
        <div style={{ marginBottom: 16, padding: '10px 14px', background: 'color-mix(in srgb, var(--theme-text2) 6%, transparent)', border: '1px solid var(--theme-border)', borderRadius: 'var(--radius-sm)' }}>
          <div style={{ fontSize: 11, color: 'var(--theme-text2)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 8 }}>
            {nutriMatches.length} match{nutriMatches.length > 1 ? 'es' : ''} from {nutriMatchSource}
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            {nutriMatches.map((s, i) => (
              <button key={i} className="btn btn-ghost" style={{ fontSize: 12, textAlign: 'left', padding: '7px 11px', lineHeight: 1.35 }} onClick={() => applyNutriSeed(s)}>
                <span style={{ display: 'block', color: 'var(--theme-text1)', fontWeight: 600 }}>{s.name}</span>
                <span style={{ display: 'block', color: 'var(--theme-text2)', fontSize: 11 }}>
                  {s.energy_kcal} kcal · P{s.protein_g} C{s.carbs_g} F{s.fat_g} /100{s.unit}
                </span>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Open Food Facts — branded / packaged products */}
      <div style={{ marginBottom: 16, padding: '12px 14px', background: 'color-mix(in srgb, var(--theme-green) 5%, transparent)', border: '1px solid color-mix(in srgb, var(--theme-green) 18%, transparent)', borderRadius: 'var(--radius-sm)' }}>
        <div style={{ fontSize: 11, color: 'var(--theme-text2)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 8 }}>
          <Tip width={280} text="For branded / packaged goods (sauces, drinks, snacks). Search by product name or paste a barcode. Pulls nutrition per 100 g from the Open Food Facts database.">Fetch from Open Food Facts</Tip>
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <input aria-label="Search Open Food Facts"
            value={offQuery}
            onChange={e => setOffQuery(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); fetchFromOFF() } }}
            placeholder="Product name or barcode…"
            style={{ flex: 1, minWidth: 180, background: 'var(--theme-bg)', border: '1px solid var(--theme-border)', borderRadius: 'var(--radius-sm)', padding: '7px 10px', fontSize: 13, color: 'var(--theme-text1)', outline: 'none' }}
          />
          <button className="btn btn-ghost" style={{ fontSize: 12 }} onClick={fetchFromOFF} disabled={offBusy || !offQuery.trim()}>
            {offBusy ? 'Searching…' : '🔍 Fetch'}
          </button>
        </div>
        {offError && <p role="alert" style={{ color: 'var(--theme-red-text)', fontSize: 12, margin: '8px 0 0' }}>{offError}</p>}
        {offResults.length > 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 10 }}>
            {offResults.map((r, i) => (
              <button key={i} className="btn btn-ghost" style={{ fontSize: 12, textAlign: 'left', padding: '7px 11px', lineHeight: 1.35 }} onClick={() => applyOffResult(r)}>
                <span style={{ display: 'block', color: 'var(--theme-text1)', fontWeight: 600 }}>{r.name}</span>
                <span style={{ display: 'block', color: 'var(--theme-text2)', fontSize: 11 }}>
                  {r.energy_kcal ?? '–'} kcal · P{r.protein_g ?? '–'} C{r.carbs_g ?? '–'} F{r.fat_g ?? '–'} /100g
                  {r.allergens ? ` · ${allergenWords(r.allergens).map(allergenLabel).join(', ')}` : ''}
                </span>
              </button>
            ))}
            <span style={{ fontSize: 10, color: 'var(--theme-text2)', marginTop: 2 }}>Data from Open Food Facts (ODbL). Crowd-sourced — verify before relying on it.</span>
          </div>
        )}
      </div>

      <div className="form-grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 14 }}>
        {NUTRIENTS.map(def => (
          <div className="form-field" key={def.key}>
            <label htmlFor={`nutrit-${def.key}`}>
              {def.key === 'sodium_mg'
                ? <Tip width={220} text="Sodium is in milligrams (mg), not grams. 1 g salt ≈ 388 mg sodium.">{def.label} ({def.unit})</Tip>
                : `${def.label} (${def.unit})`}
            </label>
            <input id={`nutrit-${def.key}`} type="number" min="0" step="any" value={nutriForm[def.key]}
              onChange={e => setNF({ [def.key]: e.target.value })} placeholder="0" />
          </div>
        ))}
      </div>

      <div className="form-field" style={{ marginTop: 18 }}>
        <span className="field-label" id="nutrit-allergens-label">
          <Tip width={300} text="Tick every allergen this ingredient contains. Saving marks the ingredient as checked, even with nothing ticked, and every dish using it carries what you tick. On the guest menu, a dish with an ingredient nobody checked asks the guest to check with staff.">Allergens it contains</Tip>
        </span>
        {guessNote && (
          <p role="note" style={{ fontSize: 12, color: 'var(--theme-text2)', margin: '0 0 6px' }}>{guessNote}</p>
        )}
        <AllergenTicks id="nutrit-allergens" value={nutriForm.allergens} onChange={allergens => setNF({ allergens })} disabled={nutriSaving} />
      </div>

      <p style={{ fontSize: 11, color: 'var(--theme-text3)', margin: '12px 0 0' }}>
        Library values are reference estimates — verify for branded or prepared items.
      </p>
      </>)}
      <ActionError error={nutriError} />
      <div className="form-actions" style={{ marginTop: 16, display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
        <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary" onClick={saveNutri} disabled={nutriSaving}>
          {nutriSaving ? 'Saving…' : 'Save'}
        </button>
      </div>
    </Modal>
  )
}
