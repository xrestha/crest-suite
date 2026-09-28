import { useState } from 'react'
import { supabase } from '../../../supabaseClient'
import Tip from '../../../components/Tip'
import Modal from '../../../components/Modal'
import { calcRecipeCost, calcSubRecipeCostPerUnit } from './recipeCostCalc'
import { BYO_STATUS, BYO_TIP } from './buildYourOwnRating'
import { asActionError } from '../../../components/ActionError'
import { recipeCostOf, menuFcPct } from '../../../shared/imsFormulas'
import { parseImportRows } from './recipeImportParse'
import { PAN_LABEL, VAT_MODE_UNKNOWN_TEXT } from './menuPriceVat'

// The price column is EX-VAT, and its header says so (S756). It is written straight to
// `recipes.selling_price`, which is stored ex-VAT, while every other place a price is typed — the
// recipe form, Menu Pricing's + Add Item — takes the menu (incl-VAT) price and divides it. Headed
// just "Selling Price", a client naturally typed the menu price, and every imported dish then sold
// 13% above it. The template's own example (433.63 → NPR 490 on the menu) shows ex-VAT was always
// meant. Parsing is POSITIONAL and a header row is recognised by its first cell only, so a sheet
// saved under the old "Selling Price" header still imports unchanged.
//
// On a PAN-bill outlet (S792, D31) there is no VAT to take off: the till charges `selling_price`
// exactly, so the same column IS the menu price, the header says so, and the dish is written with
// vat_rate 0 rather than 0.13. `vatMode` comes from the page (menuPriceVat.js); while it is unknown
// nothing is imported, because either basis could be the wrong one.
const IMPORT_VAT_RATE = 0.13
const importCols = vatMode => ['Menu Item (Recipe)', 'Category',
  vatMode === 'pan' ? 'Menu Price (no VAT, PAN bill)' : 'Selling Price (ex-VAT)',
  'Yield', 'Ingredient (name or code)', 'Qty', 'Unit']

// Template download + Excel upload + parse/preview/run — the whole bulk recipe import feature,
// self-contained. Renders the two toolbar buttons and (once a file is parsed) the preview modal.
// The parent only needs to hand over its current items/subRecipes/recipes (for ingredient
// matching and duplicate detection) and get an onImported() callback to reload its recipe list.
// `costedByBuild(r)` (S792, RECIPES-1) marks a build-your-own dish, whose export row gets no food
// cost or FC % — its fixed ingredients are not its plate.
export default function RecipeImportButton({ items, subRecipes, recipes, exportRecipes, clientId, scopedInsert, scopedDelete, onImported, isAdmin, vatMode, costedByBuild = () => false }) {
  const [importPreview, setImportPreview] = useState(null) // { recipes:[...], summary } | null
  const [importBusy, setImportBusy] = useState(false)
  const [importError, setImportError] = useState('')
  // The success state of a bulk import, shown in the page rather than in an OS dialog (S765).
  const [importDone, setImportDone] = useState('')

  async function downloadRecipeTemplate() {
    const XLSX = await import('xlsx')
    // The example prices follow the outlet: ex-VAT on a VAT outlet (433.63 → NPR 490 on the menu),
    // the menu price itself on a PAN-bill one (S792, D31).
    const pan = vatMode === 'pan'
    const example = [
      ['Avocado Toast', 'Food', pan ? 490 : 433.63, 1, items[0]?.name || 'Sourdough Bread', 80, items[0]?.uom || 'GM'],
      ['', '', '', '', items[1]?.name || 'Avocado', 100, items[1]?.uom || 'GM'],
      ['Peri Peri Wings', 'Food', pan ? 650 : 575.22, 1, items[2]?.name || 'Chicken Wings', 250, items[2]?.uom || 'GM'],
    ]
    const wsRecipes = XLSX.utils.aoa_to_sheet([importCols(vatMode), ...example])
    wsRecipes['!cols'] = [{ wch: 24 }, { wch: 12 }, { wch: 20 }, { wch: 7 }, { wch: 26 }, { wch: 8 }, { wch: 8 }]

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
      // Recipe Food Cost / FC% use the dish cost — manual cost when there are no costed
      // ingredients, blank when neither exists. This sheet leaves the building and gets priced
      // against, so an unknown is a blank cell, never "0.00" and "0.0" (S756, the S724 rule).
      // A build-your-own dish's fixed ingredients are not its plate (S792, RECIPES-1): its Recipe
      // Food Cost and FC % are blank, and the Note column says why. Its ingredient lines still
      // export, since they are what a re-import rebuilds.
      const byBuild = costedByBuild(r)
      const dishCost = r.category === 'Sub-Recipe' ? cost : byBuild ? null : recipeCostOf({ [r.id]: cost }, r)
      const price = parseFloat(r.selling_price) || 0
      const fcPct = menuFcPct(dishCost, price)
      const dishCostCell = dishCost != null ? dishCost.toFixed(2) : ''
      const noteCell = byBuild ? `${BYO_STATUS}. ${BYO_TIP}` : ''
      const ings = (r.recipe_ingredients || []).filter(ri => (ri.item_id && ri.items) || (ri.sub_recipe_id && ri.sub_recipe))
      if (ings.length === 0) {
        rows.push([r.name, r.category, r.selling_price ?? '', r.yield_qty, '', '', '', '', '', dishCostCell, fcPct != null ? fcPct.toFixed(1) : '', noteCell])
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
          isFirst ? dishCostCell : '',
          isFirst ? (fcPct != null ? fcPct.toFixed(1) : '') : '',
          isFirst ? noteCell : '',
        ])
      })
    })
    const header = [...importCols(vatMode), 'Ingredient Rate (NPR)', 'Ingredient Cost (NPR)', 'Recipe Food Cost (NPR)', 'Recipe FC%', 'Note']
    const ws = XLSX.utils.aoa_to_sheet([header, ...rows])
    ws['!cols'] = [{ wch: 24 }, { wch: 12 }, { wch: 20 }, { wch: 7 }, { wch: 26 }, { wch: 8 }, { wch: 8 }, { wch: 14 }, { wch: 14 }, { wch: 16 }, { wch: 10 }, { wch: 40 }]
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, ws, 'Recipes')
    XLSX.writeFile(wb, 'Recipe-Export.xlsx')
  }

  function handleImportFile(e) {
    setImportError(''); setImportDone('')
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
          ambiguousCodes: parsed.filter(r => r.ambiguousIngredient).length,
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
    // Which basis the price column is on depends on the outlet (S792, D31); unknown, nothing is
    // written, because either guess stores some dishes at the wrong price.
    if (vatMode == null) { setImportError(`Nothing was imported. ${VAT_MODE_UNKNOWN_TEXT}`); return }
    setImportBusy(true)
    setImportError('')
    let created = 0
    try {
      for (const r of toCreate) {
        const { data: rec, error: recErr } = await scopedInsert('recipes', {
          name: r.name,
          category: r.category || 'Food',
          selling_price: r.selling_price != null && !isNaN(r.selling_price) ? r.selling_price : null,
          vat_rate: vatMode === 'pan' ? 0 : IMPORT_VAT_RATE,
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
        // S765: was alert(). You have just imported your whole recipe book and the celebration was
        // an OS dialog you have to dismiss before you can look at what landed — and on a tablet it
        // reads as "crest-suite.vercel.app says…", which is the shape of a security warning. The
        // page has a notice slot; the result belongs in it, next to the thing that changed.
        setImportDone(`Imported ${created} recipe${created !== 1 ? 's' : ''}.`)
      }
    }
  }

  return (
    <>
      <Tip text={`Bulk-add recipes from a spreadsheet. Download the template, fill one row per ingredient (Menu Item on the recipe's first row, then its ingredients below), and upload. ${vatMode === 'pan'
        ? 'This outlet gives PAN bills, so the price column is the menu price itself: type what the guest pays (NPR 500 is NPR 500).'
        : 'Selling Price is EX-VAT: for a NPR 500 menu price at 13% VAT, enter 442.48 — the preview shows the menu price each row will produce.'} Ingredients are matched to your Item Master by name or code, and the preview shows which item each one matched; unmatched ones are listed so you can fix them.`} width={320}>
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
      {importDone && <span role="status" style={{ fontSize: 11, color: 'var(--theme-green-text)', fontWeight: 600 }}>✓ {importDone}</span>}

      {importPreview && (
        <Modal onClose={() => { if (!importBusy) { setImportPreview(null); setImportError('') } }} title="Import Recipes — Preview" maxWidth={760}>
          <div style={{ marginBottom: 12, fontSize: 13, color: 'var(--theme-text2)' }}>
            <strong style={{ color: 'var(--theme-text1)' }}>{importPreview.summary.willImport}</strong> of {importPreview.summary.totalRecipes} recipes ready ·{' '}
            <strong style={{ color: 'var(--theme-green-text)' }}>{importPreview.summary.matchedLines}</strong> ingredients matched
            {importPreview.summary.badLines > 0 && <> · <strong style={{ color: 'var(--theme-red-text)' }}>{importPreview.summary.badLines}</strong> unmatched (skipped)</>}
            {importPreview.summary.duplicates > 0 && <> · {importPreview.summary.duplicates} already exist (skipped)</>}
            {importPreview.summary.dupIngredients > 0 && <> · <strong style={{ color: 'var(--theme-red-text)' }}>{importPreview.summary.dupIngredients}</strong> with an ingredient listed twice (skipped — combine the rows in the sheet)</>}
            {importPreview.summary.ambiguousCodes > 0 && <> · <strong style={{ color: 'var(--theme-red-text)' }}>{importPreview.summary.ambiguousCodes}</strong> naming an item code two items share (skipped — type the item's name instead)</>}
            {importPreview.summary.subs > 0 && <> · {importPreview.summary.subs} sub-recipes (create in app)</>}
          </div>

          <div style={{ maxHeight: 360, overflowY: 'auto', border: '1px solid var(--theme-border)', borderRadius: 'var(--radius-sm)' }}>
            {importPreview.recipes.map((r, idx) => {
              const status = r.willImport ? { t: 'Will import', c: 'var(--theme-green)' }
                : r.duplicate ? { t: 'Already exists — skipped', c: 'var(--theme-amber)' }
                : r.isSub ? { t: 'Sub-recipe — create in app', c: 'var(--theme-text3)' }
                : r.duplicateIngredient ? { t: `"${r.duplicateIngredient}" listed twice — skipped`, c: 'var(--theme-red)' }
                : r.ambiguousIngredient ? { t: `Code "${r.ambiguousIngredient}" is on two items — skipped`, c: 'var(--theme-red)' }
                : { t: 'No matched ingredients — skipped', c: 'var(--theme-red)' }
              return (
                <div key={idx} style={{ padding: '10px 14px', borderBottom: idx < importPreview.recipes.length - 1 ? '1px solid var(--theme-border-lt)' : 'none', opacity: r.willImport ? 1 : 0.75 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10 }}>
                    <div style={{ fontWeight: 600, color: 'var(--theme-text1)' }}>
                      {r.name} <span style={{ fontSize: 11, color: 'var(--theme-text3)', fontWeight: 400 }}>· {r.category} · {r.matchedLines.length}/{r.lines.length} ingredients</span>
                      {/* The column is ex-VAT; the guest price it produces is what a reader can check
                          against the menu, so it is shown before anything is written (S756). On a
                          PAN-bill outlet the two are the same figure (S792, D31). */}
                      {!r.isSub && (
                        <div style={{ fontSize: 11, color: 'var(--theme-text2)', fontWeight: 400, marginTop: 2 }}>
                          {!(r.selling_price > 0)
                            ? 'No selling price — set one in Menu Pricing after import'
                            : vatMode === 'pan'
                              ? `Guests pay NPR ${r.selling_price.toFixed(0)} (${PAN_LABEL})`
                              : `NPR ${r.selling_price.toFixed(2)} ex-VAT → menu price NPR ${(r.selling_price * (1 + IMPORT_VAT_RATE)).toFixed(0)} incl. ${(IMPORT_VAT_RATE * 100).toFixed(0)}% VAT`}
                        </div>
                      )}
                    </div>
                    <span style={{ fontSize: 11, fontWeight: 600, color: status.c, whiteSpace: 'nowrap' }}>{status.t}</span>
                  </div>
                  {r.badLines.length > 0 && (
                    <div style={{ marginTop: 6, fontSize: 11, color: 'var(--theme-red-text)' }}>
                      {r.badLines.map((l, i) => <div key={i}>✗ {l.ingName || '(blank)'} — {l.reason}</div>)}
                    </div>
                  )}
                  {/* What each item CODE resolved to (S792, MASTER-5). The preview used to print only
                      the text typed, so "ITM-010" linking the wrong one of two items was invisible
                      until the recipe cost came out wrong. A name resolves to itself. */}
                  {r.matchedLines.some(l => l.byCode) && (
                    <div style={{ marginTop: 4, fontSize: 11, color: 'var(--theme-text2)' }}>
                      {r.matchedLines.filter(l => l.byCode).map((l, i) => <div key={i}>✓ {l.ingName} → {l.resolvedName}</div>)}
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
