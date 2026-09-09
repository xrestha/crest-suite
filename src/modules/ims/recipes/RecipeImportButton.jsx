import { useState } from 'react'
import { supabase } from '../../../supabaseClient'
import Tip from '../../../components/Tip'
import Modal from '../../../components/Modal'
import { convertQty } from '../../../utils/nutrition'
import { calcRecipeCost, calcSubRecipeCostPerUnit } from './recipeCostCalc'
import { asActionError } from '../../../components/ActionError'

const IMPORT_COLS = ['Menu Item (Recipe)', 'Category', 'Selling Price', 'Yield', 'Ingredient (name or code)', 'Qty', 'Unit']

// Parse + validate an uploaded sheet against the current items/sub-recipes.
function parseImportRows(rows, items, subRecipes, recipes) {
  const norm = s => String(s ?? '').trim()
  const lc = s => norm(s).toLowerCase()
  const itemByName = new Map(items.map(i => [lc(i.name), i]))
  const itemByCode = new Map(items.filter(i => i.item_code).map(i => [lc(i.item_code), i]))
  const subByName = new Map(subRecipes.map(s => [lc(s.name), s]))
  const existingRecipeNames = new Set(recipes.filter(r => r.category !== 'Sub-Recipe').map(r => lc(r.name)))

  const out = []
  let current = null
  for (const row of rows) {
    const name = norm(row[0])
    const ingName = norm(row[4])
    if (name) {
      current = {
        name,
        category: norm(row[1]) || 'Food',
        selling_price: row[2] === '' || row[2] == null ? null : parseFloat(row[2]),
        yield_qty: row[3] === '' || row[3] == null ? 1 : (parseFloat(row[3]) || 1),
        lines: [],
        duplicate: existingRecipeNames.has(lc(name)),
        isSub: lc(norm(row[1])) === 'sub-recipe',
      }
      out.push(current)
    }
    if (!ingName) continue
    if (!current) continue
    const qty = parseFloat(row[5])
    const unit = norm(row[6])
    const key = lc(ingName)
    let match = itemByCode.get(key) || itemByName.get(key)
    let type = match ? 'item' : null
    let sub = null
    if (!match) { sub = subByName.get(key); if (sub) type = 'sub_recipe' }
    let warning = ''
    let finalQty = qty
    if (match && unit) {
      const itemUom = (match.uom || '').toUpperCase()
      if (unit.toUpperCase() !== itemUom) {
        const conv = convertQty(qty, unit, itemUom)
        if (conv === qty && unit.toUpperCase() !== itemUom) warning = `unit "${unit}" ≠ item unit "${itemUom}" — qty used as-is`
        else finalQty = conv
      }
    }
    current.lines.push({
      ingName, qty: finalQty, rawQty: qty, unit,
      matched: !!type, type,
      item_id: type === 'item' ? match.id : null,
      sub_recipe_id: type === 'sub_recipe' ? sub.id : null,
      reason: !type ? 'no matching item or sub-recipe' : (!(qty > 0) ? 'qty missing/invalid' : ''),
      warning,
    })
  }
  // A line is importable only if matched AND qty > 0
  out.forEach(r => {
    r.matchedLines = r.lines.filter(l => l.matched && l.qty > 0)
    r.badLines = r.lines.filter(l => !(l.matched && l.qty > 0))
    // THE SAME GUARD save() APPLIES, WHICH THIS PATH NEVER HAD (S714).
    //
    // `recipe_ingredients` has UNIQUE (recipe_id, item_id), so two lines naming one item make the
    // insert below fail outright with 21000 — after the recipe row has already been written,
    // leaving an ingredient-less recipe that costs 0 and wears a green food-cost tick. Two lines
    // naming one SUB-RECIPE fail at nothing at all: item_id is NULL there, so it never matches
    // that conflict target, both rows insert, and the recipe silently costs the prep item twice.
    // The silent half is the worse half, and neither was detectable in the preview.
    //
    // Refused rather than summed, exactly as save() refuses it: 200g and 50g of one item is as
    // likely a typo in one of the two rows, and quietly writing 250g would be this importer
    // deciding which. The whole recipe is held back so nothing lands half-right.
    const seen = new Set()
    r.duplicateIngredient = null
    for (const l of r.matchedLines) {
      const key = l.type === 'item' ? `i:${l.item_id}` : `s:${l.sub_recipe_id}`
      if (seen.has(key)) { r.duplicateIngredient = l.ingName; break }
      seen.add(key)
    }
    r.willImport = !r.duplicate && !r.isSub && !r.duplicateIngredient && r.matchedLines.length > 0
  })
  return out
}

// Template download + Excel upload + parse/preview/run — the whole bulk recipe import feature,
// self-contained. Renders the two toolbar buttons and (once a file is parsed) the preview modal.
// The parent only needs to hand over its current items/subRecipes/recipes (for ingredient
// matching and duplicate detection) and get an onImported() callback to reload its recipe list.
export default function RecipeImportButton({ items, subRecipes, recipes, exportRecipes, clientId, scopedInsert, scopedDelete, onImported, isAdmin }) {
  const [importPreview, setImportPreview] = useState(null) // { recipes:[...], summary } | null
  const [importBusy, setImportBusy] = useState(false)
  const [importError, setImportError] = useState('')

  async function downloadRecipeTemplate() {
    const XLSX = await import('xlsx')
    const example = [
      ['Avocado Toast', 'Food', 433.63, 1, items[0]?.name || 'Sourdough Bread', 80, items[0]?.uom || 'GM'],
      ['', '', '', '', items[1]?.name || 'Avocado', 100, items[1]?.uom || 'GM'],
      ['Peri Peri Wings', 'Food', 575.22, 1, items[2]?.name || 'Chicken Wings', 250, items[2]?.uom || 'GM'],
    ]
    const wsRecipes = XLSX.utils.aoa_to_sheet([IMPORT_COLS, ...example])
    wsRecipes['!cols'] = [{ wch: 24 }, { wch: 12 }, { wch: 13 }, { wch: 7 }, { wch: 26 }, { wch: 8 }, { wch: 8 }]

    // Reference sheet: exact item + sub-recipe names/units to copy from
    const itemRows = items.map(i => [i.item_code || '', i.name, (i.uom || '').toUpperCase()])
    const wsItems = XLSX.utils.aoa_to_sheet([['Item Code', 'Item Name', 'Unit'], ...itemRows])
    wsItems['!cols'] = [{ wch: 12 }, { wch: 30 }, { wch: 8 }]
    const subRows = subRecipes.map(s => [s.name, `${s.yield_qty} ${s.yield_uom}`])
    const wsSubs = XLSX.utils.aoa_to_sheet([['Sub-Recipe Name', 'Yields'], ...subRows])
    wsSubs['!cols'] = [{ wch: 30 }, { wch: 14 }]

    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, wsRecipes, 'Recipes')
    XLSX.utils.book_append_sheet(wb, wsItems, 'Your Items')
    XLSX.utils.book_append_sheet(wb, wsSubs, 'Your Sub-Recipes')
    XLSX.writeFile(wb, 'Recipe-Import-Template.xlsx')
  }

  // Every current recipe + sub-recipe, one row per ingredient, in the same shape as the import
  // template (first 7 columns) plus reference-only cost columns appended after — so this file is
  // both a readable cost report AND re-importable as-is (parseImportRows reads positionally and
  // ignores anything past column 6). Portable across clients too: only names are written, never
  // item_id/recipe_id, so importing it into a different client matches against that client's own
  // Item Master instead of carrying over any client-specific identifiers.
  async function downloadRecipeExport() {
    const XLSX = await import('xlsx')
    const rows = []
    ;(exportRecipes || recipes).forEach(r => {
      const cost = calcRecipeCost(r, recipes)
      const price = parseFloat(r.selling_price) || 0
      const fcPct = price > 0 ? (cost / price) * 100 : null
      const ings = (r.recipe_ingredients || []).filter(ri => (ri.item_id && ri.items) || (ri.sub_recipe_id && ri.sub_recipe))
      if (ings.length === 0) {
        rows.push([r.name, r.category, r.selling_price ?? '', r.yield_qty, '', '', '', '', '', cost.toFixed(2), fcPct != null ? fcPct.toFixed(1) : ''])
        return
      }
      ings.forEach((ri, idx) => {
        const isFirst = idx === 0
        let ingName, ingUom, ingRate, yieldFactor = 1
        if (ri.item_id && ri.items) {
          ingName = ri.items.name
          ingUom = ri.items.uom
          ingRate = parseFloat(ri.items.per_uom_rate || 0)
          // Previously omitted here (matching Recipe Food Cost, which does apply it via
          // calcRecipeCost) — line items didn't sum to the printed/exported recipe total.
          yieldFactor = (parseFloat(ri.items.yield_pct) || 100) / 100
        } else {
          ingName = ri.sub_recipe.name
          ingUom = ri.sub_recipe.yield_uom
          ingRate = calcSubRecipeCostPerUnit(ri.sub_recipe, recipes)
        }
        const ingCost = (parseFloat(ri.qty_per_portion) / yieldFactor) * ingRate
        rows.push([
          isFirst ? r.name : '',
          isFirst ? r.category : '',
          isFirst ? (r.selling_price ?? '') : '',
          isFirst ? r.yield_qty : '',
          ingName, ri.qty_per_portion, ingUom,
          ingRate.toFixed(2), ingCost.toFixed(2),
          isFirst ? cost.toFixed(2) : '',
          isFirst ? (fcPct != null ? fcPct.toFixed(1) : '') : '',
        ])
      })
    })
    const header = [...IMPORT_COLS, 'Ingredient Rate (NPR)', 'Ingredient Cost (NPR)', 'Recipe Food Cost (NPR)', 'Recipe FC%']
    const ws = XLSX.utils.aoa_to_sheet([header, ...rows])
    ws['!cols'] = [{ wch: 24 }, { wch: 12 }, { wch: 13 }, { wch: 7 }, { wch: 26 }, { wch: 8 }, { wch: 8 }, { wch: 14 }, { wch: 14 }, { wch: 16 }, { wch: 10 }]
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, ws, 'Recipes')
    XLSX.writeFile(wb, 'Recipe-Export.xlsx')
  }

  function handleImportFile(e) {
    setImportError('')
    const file = e.target.files?.[0]
    e.target.value = '' // allow re-selecting the same file
    if (!file) return
    if (!clientId) { setImportError('No client selected. Pick a client in the top-left switcher first.'); return }
    const reader = new FileReader()
    reader.onload = async ev => {
      try {
        const XLSX = await import('xlsx')
        const wb = XLSX.read(new Uint8Array(ev.target.result), { type: 'array' })
        const wsName = wb.SheetNames.find(n => n.toLowerCase() === 'recipes') || wb.SheetNames[0]
        const ws = wb.Sheets[wsName]
        const aoa = XLSX.utils.sheet_to_json(ws, { header: 1, blankrows: false })
        // Drop a header row if the first cell matches the template header
        const body = aoa.length && String(aoa[0][0] || '').toLowerCase().startsWith('menu item') ? aoa.slice(1) : aoa
        const parsed = parseImportRows(body, items, subRecipes, recipes)
        if (parsed.length === 0) { setImportError('No recipes found in the sheet. Use the template format.'); return }
        const summary = {
          totalRecipes: parsed.length,
          willImport: parsed.filter(r => r.willImport).length,
          duplicates: parsed.filter(r => r.duplicate).length,
          dupIngredients: parsed.filter(r => r.duplicateIngredient).length,
          subs: parsed.filter(r => r.isSub).length,
          matchedLines: parsed.reduce((s, r) => s + r.matchedLines.length, 0),
          badLines: parsed.reduce((s, r) => s + r.badLines.length, 0),
        }
        setImportPreview({ recipes: parsed, summary })
      } catch (err) {
        setImportError('Could not read the file — make sure it is a valid .xlsx. (' + err.message + ')')
      }
    }
    reader.readAsArrayBuffer(file)
  }

  async function runImport() {
    if (!importPreview) return
    if (!clientId) { setImportError('No client selected.'); return }
    const toCreate = importPreview.recipes.filter(r => r.willImport)
    if (toCreate.length === 0) { setImportError('Nothing to import — no recipe has a matched ingredient.'); return }
    setImportBusy(true)
    setImportError('')
    let created = 0
    try {
      for (const r of toCreate) {
        const { data: rec, error: recErr } = await scopedInsert('recipes', {
          name: r.name,
          category: r.category || 'Food',
          selling_price: r.selling_price != null && !isNaN(r.selling_price) ? r.selling_price : null,
          vat_rate: 0.13,
          yield_qty: r.yield_qty || 1,
          yield_uom: 'portion',
          target_fc_pct: 30,
          is_active: true,
        }, { single: true })
        if (recErr) { setImportError(`Failed on "${r.name}"${created > 0 ? ` — the ${created} before it were imported` : ''}. ${asActionError(recErr).text}`); break }
        const ingPayload = r.matchedLines.map(l => ({
          recipe_id: rec.id,
          item_id: l.item_id,
          sub_recipe_id: l.sub_recipe_id,
          qty_per_portion: l.qty,
        }))
        const { error: ingErr } = await supabase.from('recipe_ingredients').insert(ingPayload)
        if (ingErr) {
          // The recipe row is already committed and its ingredients are not, so stopping here
          // would leave a recipe with an empty ingredient list — which costs 0 and reads as a
          // 0% food cost rather than as a failed import (S714). The two writes cannot be
          // reordered (the ingredients need the recipe's id), so the compensating delete is the
          // only way to leave the sheet re-importable. Safe to delete: this row is seconds old
          // and nothing can reference it yet.
          const { error: rollbackErr } = await scopedDelete('recipes').eq('id', rec.id)
          const a = asActionError(ingErr)
          setImportError(rollbackErr
            ? `Ingredients failed on "${r.name}", and the empty recipe left behind could not be removed — delete "${r.name}" in the list before importing this sheet again. ${a.text}`
            : `Ingredients failed on "${r.name}", so it was not imported${created > 0 ? ` (the ${created} before it were)` : ''}. Fix that row in the sheet and import again. ${a.text}`)
          break
        }
        created++
      }
    } finally {
      setImportBusy(false)
      if (created > 0) {
        setImportPreview(null)
        await onImported()
        alert(`Imported ${created} recipe${created !== 1 ? 's' : ''}.`)
      }
    }
  }

  return (
    <>
      <Tip text="Bulk-add recipes from a spreadsheet. Download the template, fill one row per ingredient (Menu Item on the recipe's first row, then its ingredients below), and upload. Ingredients are matched to your Item Master by name or code; unmatched ones are listed so you can fix them." width={320}>
        <button className="btn btn-ghost" style={{ fontSize: 12, padding: '8px 12px' }} onClick={downloadRecipeTemplate}>↓ Template</button>
      </Tip>
      <label className="btn btn-ghost" style={{ fontSize: 12, padding: '8px 12px', cursor: 'pointer', margin: 0 }}>
        ↑ Import Excel
        <input type="file" accept=".xlsx,.xls" style={{ display: 'none' }} onChange={handleImportFile} />
      </label>
      {isAdmin && (
        <Tip text="Crest Admin only. Downloads every current recipe and sub-recipe with its full ingredient breakdown and cost by default — a backup, an editable spreadsheet, or a file to hand to another location. Check specific rows in the list below first to export just those instead (works across tabs). Same format as ↓ Template, so it can be edited and re-imported (here, or into a different client)." width={330}>
          <button className="btn btn-ghost" style={{ fontSize: 12, padding: '8px 12px' }} onClick={downloadRecipeExport} disabled={(exportRecipes || recipes).length === 0}>Export Excel</button>
        </Tip>
      )}
      {importError && <span style={{ fontSize: 11, color: 'var(--theme-red-text)' }}>{importError}</span>}

      {importPreview && (
        <Modal onClose={() => { if (!importBusy) { setImportPreview(null); setImportError('') } }} title="Import Recipes — Preview" maxWidth={760}>
          <div style={{ marginBottom: 12, fontSize: 13, color: 'var(--theme-text2)' }}>
            <strong style={{ color: 'var(--theme-text1)' }}>{importPreview.summary.willImport}</strong> of {importPreview.summary.totalRecipes} recipes ready ·{' '}
            <strong style={{ color: 'var(--theme-green-text)' }}>{importPreview.summary.matchedLines}</strong> ingredients matched
            {importPreview.summary.badLines > 0 && <> · <strong style={{ color: 'var(--theme-red-text)' }}>{importPreview.summary.badLines}</strong> unmatched (skipped)</>}
            {importPreview.summary.duplicates > 0 && <> · {importPreview.summary.duplicates} already exist (skipped)</>}
            {importPreview.summary.dupIngredients > 0 && <> · <strong style={{ color: 'var(--theme-red-text)' }}>{importPreview.summary.dupIngredients}</strong> with an ingredient listed twice (skipped — combine the rows in the sheet)</>}
            {importPreview.summary.subs > 0 && <> · {importPreview.summary.subs} sub-recipes (create in app)</>}
          </div>

          <div style={{ maxHeight: 360, overflowY: 'auto', border: '1px solid var(--theme-border)', borderRadius: 'var(--radius-sm)' }}>
            {importPreview.recipes.map((r, idx) => {
              const status = r.willImport ? { t: 'Will import', c: 'var(--theme-green)' }
                : r.duplicate ? { t: 'Already exists — skipped', c: 'var(--theme-amber)' }
                : r.isSub ? { t: 'Sub-recipe — create in app', c: 'var(--theme-text3)' }
                : r.duplicateIngredient ? { t: `"${r.duplicateIngredient}" listed twice — skipped`, c: 'var(--theme-red)' }
                : { t: 'No matched ingredients — skipped', c: 'var(--theme-red)' }
              return (
                <div key={idx} style={{ padding: '10px 14px', borderBottom: idx < importPreview.recipes.length - 1 ? '1px solid var(--theme-border-lt)' : 'none', opacity: r.willImport ? 1 : 0.75 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10 }}>
                    <div style={{ fontWeight: 600, color: 'var(--theme-text1)' }}>
                      {r.name} <span style={{ fontSize: 11, color: 'var(--theme-text3)', fontWeight: 400 }}>· {r.category} · {r.matchedLines.length}/{r.lines.length} ingredients</span>
                    </div>
                    <span style={{ fontSize: 11, fontWeight: 600, color: status.c, whiteSpace: 'nowrap' }}>{status.t}</span>
                  </div>
                  {r.badLines.length > 0 && (
                    <div style={{ marginTop: 6, fontSize: 11, color: 'var(--theme-red-text)' }}>
                      {r.badLines.map((l, i) => <div key={i}>✗ {l.ingName || '(blank)'} — {l.reason}</div>)}
                    </div>
                  )}
                  {r.matchedLines.some(l => l.warning) && (
                    <div style={{ marginTop: 4, fontSize: 11, color: 'var(--theme-amber-text)' }}>
                      {r.matchedLines.filter(l => l.warning).map((l, i) => <div key={i}>⚠ {l.ingName}: {l.warning}</div>)}
                    </div>
                  )}
                </div>
              )
            })}
          </div>

          {importError && <p style={{ color: 'var(--theme-red-text)', fontSize: 12, marginTop: 10 }}>{importError}</p>}
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 16 }}>
            <button className="btn btn-ghost" onClick={() => { setImportPreview(null); setImportError('') }} disabled={importBusy}>Cancel</button>
            <button className="btn btn-primary" onClick={runImport} disabled={importBusy || importPreview.summary.willImport === 0}>
              {importBusy ? 'Importing…' : `Import ${importPreview.summary.willImport} recipe${importPreview.summary.willImport !== 1 ? 's' : ''}`}
            </button>
          </div>
        </Modal>
      )}
    </>
  )
}
