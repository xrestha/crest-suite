import { useRef, useState } from 'react'
import Tip from '../../../components/Tip'
import Modal from '../../../components/Modal'
import ActionError, { asActionError } from '../../../components/ActionError'
import { useScopedDb } from '../../../shared/hooks/useScopedDb'
import { fetchAllRows } from '../../../shared/fetchAllRows'
import { settleWithin } from '../../../utils/withTimeout'
import { unitRateCell } from '../../../shared/unitRate'
import { UNITS } from './itemFormRules'
import {
  ITEM_SHEET_NAME, itemImportColumns, itemPriceBasisText, parseItemRows, planItemImport, itemInsertRow, findCategory,
} from './itemImportPlan'
import { cleanCategoryName, nextSortOrder } from './categoryManage'
import { sheetRows, pickSheet, insertInChunks, partialImportText, outcomeUnknown, IMPORT_TIMEOUT_MS } from './sheetImport'
import ImportSkippedList from './ImportSkippedList'

// Item Master's Excel import (S885, owner decision 1). Template, file pick, a preview that says
// which rows will be added and which skipped and why, then the write: new categories first, then
// the items in chunks of 200. Nothing already on file is ever changed. The plan is made twice,
// against a fresh read each time: once for the preview and again at Import, so a name added in
// another tab since the preview is skipped rather than doubled (the unique index backs that up).
const READ_TIMEOUT_MS = 20000

const EXAMPLES = [
  ['CHICKEN BREAST', 'Meats & Poultry', 'GM', 0.65, '', '', 'KG', 1000, 100],
  ['BASMATI RICE', 'Groceries', 'GM', '', 1000, 180, 'BAG', 25000, 100],
  ['COCA COLA 250ML', 'Beverage', 'BTL', 45, '', '', 'CTN', 24, 100],
  ['WHOLE CHICKEN', 'Meats & Poultry', 'KG', 420, '', '', '', '', 70],
]

export default function ItemImportButton({ categories, vatMode, codePrefix, extraCodes, onImported }) {
  const { clientId, scopedFrom, scopedInsert, scopedUpsert } = useScopedDb()
  const fileRef = useRef(null)
  // null, or { stage: 'reading' | 'preview' | 'importing' | 'result' | 'error', ... }
  const [view, setView] = useState(null)
  const busy = view?.stage === 'reading' || view?.stage === 'importing'

  async function downloadTemplate() {
    const XLSX = await import('xlsx')
    const cols = itemImportColumns(vatMode)
    const wsItems = XLSX.utils.aoa_to_sheet([cols])
    wsItems['!cols'] = [{ wch: 28 }, { wch: 18 }, { wch: 8 }, { wch: 22 }, { wch: 12 }, { wch: 12 }, { wch: 12 }, { wch: 14 }, { wch: 8 }]
    const guide = [
      ['How to fill the Items sheet: one item per row, under the header. Then use Import Items on Item Master.'],
      [],
      ['Column', 'What to type'],
      [cols[0], 'The name as it should read in Item Master. It is saved in capitals. A name Item Master already has, in any capitals and hidden items included, is skipped and listed after the import. Nothing already on file is changed.'],
      [cols[1], 'One of your categories (see the Your Categories sheet). A name that does not exist yet is created. Leave it blank for no category. Sub-Recipes cannot be used.'],
      [cols[2], `The unit you count and cost it in: ${UNITS.join(', ')}.`],
      [cols[3], `What ONE unit costs: 0.65 for a GM of chicken at NPR 650 a KG. ${itemPriceBasisText(vatMode)}`],
      [`${cols[4]} and ${cols[5]}`, 'Instead of the price per unit: how much you bought and what it cost, like 500 and 388.50 for a 500 GM bottle at NPR 388.50. Crest divides them, as Bought a pack? on the form does. If you fill the price too, the two must agree.'],
      [`${cols[6]} and ${cols[7]}`, 'Only when you buy in a bigger unit than you count in: CTN and 24 for a carton of 24 bottles. Fill both or neither.'],
      [cols[8], 'The usable percentage after trim, from 1 to 100. Leave it blank for 100 (no loss). Type 70 for seventy percent, not 0.7.'],
      [],
      ['Examples (copy the shape, not the figures)'],
      cols,
      ...EXAMPLES,
    ]
    const wsGuide = XLSX.utils.aoa_to_sheet(guide)
    wsGuide['!cols'] = [{ wch: 34 }, { wch: 110 }]
    const wsCats = XLSX.utils.aoa_to_sheet([['Your Categories'], ...(categories || []).map(c => [c.name])])
    wsCats['!cols'] = [{ wch: 30 }]
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, wsItems, ITEM_SHEET_NAME)
    XLSX.utils.book_append_sheet(wb, wsGuide, 'Instructions')
    XLSX.utils.book_append_sheet(wb, wsCats, 'Your Categories')
    XLSX.writeFile(wb, 'Item-Import-Template.xlsx')
  }

  // The whole item book (hidden items and sub-recipe mirrors included, which is what the unique
  // name index covers) and every category, Sub-Recipes included. Read fresh, never from the page.
  async function readOnFile() {
    const [bookRes, catRes] = await Promise.all([
      settleWithin(fetchAllRows(() => scopedFrom('items', 'id, name, item_code, is_sub_recipe, is_active').order('id')), READ_TIMEOUT_MS, 'Reading Item Master'),
      settleWithin(scopedFrom('categories', 'id, name, sort_order').order('sort_order').order('id'), READ_TIMEOUT_MS, 'Reading categories'),
    ])
    const error = bookRes.error || catRes.error
    if (error) return { error }
    return { book: bookRes.data || [], categories: catRes.data || [] }
  }

  async function handleFile(e) {
    const file = e.target.files?.[0]
    e.target.value = '' // the same file can be picked again after fixing it
    if (!file) return
    if (!clientId) { setView({ stage: 'error', error: 'No client selected. Pick a client in the top-left switcher first.' }); return }
    setView({ stage: 'reading' })
    let parsed
    try {
      const buf = await file.arrayBuffer()
      const XLSX = await import('xlsx')
      const wb = XLSX.read(new Uint8Array(buf), { type: 'array' })
      parsed = parseItemRows(sheetRows(XLSX, pickSheet(wb, ITEM_SHEET_NAME)))
    } catch (err) {
      setView({ stage: 'error', error: { text: 'Crest could not read this file. Save it as an Excel workbook (.xlsx), ideally from the template, and pick it again.', detail: err?.message || '' } })
      return
    }
    if (parsed.length === 0) {
      setView({ stage: 'error', error: 'No items were found in the sheet. Use the template: one item per row under the header, on the sheet called Items.' })
      return
    }
    const onFile = await readOnFile()
    if (onFile.error) {
      const a = asActionError(onFile.error)
      setView({ stage: 'error', error: { text: `Nothing was imported. Crest could not read the items and categories already on file, so it cannot tell which rows are new. ${a.text}`, detail: a.detail } })
      return
    }
    const plan = planItemImport(parsed, { ...onFile, prefix: codePrefix, extraCodes: extraCodes?.() || [] })
    setView({ stage: 'preview', fileName: file.name, parsed, plan })
  }

  async function runImport() {
    if (view?.stage !== 'preview') return
    const { parsed, fileName } = view
    setView(v => ({ ...v, stage: 'importing', done: 0 }))
    const finish = result => {
      setView({ stage: 'result', fileName, ...result })
      onImported?.({ codes: result.codesSent || [] })
    }

    const onFile = await readOnFile()
    if (onFile.error) {
      const a = asActionError(onFile.error)
      finish({ imported: 0, created: [], skipped: [], failure: { text: `Nothing was imported. Crest could not read Item Master again just before writing, so no row was sent. ${a.text}`, detail: a.detail } })
      return
    }
    const plan = planItemImport(parsed, { ...onFile, prefix: codePrefix, extraCodes: extraCodes?.() || [] })

    // 1. The categories the file names that do not exist yet. One statement; a name another tab
    //    created meanwhile is left alone (ignoreDuplicates), then the list is read back for ids.
    let cats = onFile.categories
    let created = []
    if (plan.newCategories.length > 0) {
      const base = nextSortOrder(cats)
      const rows = plan.newCategories.map((name, i) => ({ name: cleanCategoryName(name), sort_order: base + i }))
      const up = await settleWithin(
        scopedUpsert('categories', rows, { onConflict: 'client_id,name', ignoreDuplicates: true }), IMPORT_TIMEOUT_MS, 'Import')
      const names = plan.newCategories.map(n => `"${cleanCategoryName(n)}"`).join(', ')
      if (up.error) {
        const a = asActionError(up.error)
        finish({
          imported: 0, created: [], skipped: plan.skipped, codesSent: [],
          failure: {
            text: outcomeUnknown(up.error)
              ? `No items were sent. Crest did not hear back about creating the new categories (${names}), so they may or may not exist now. Open Manage categories to check, then import the same file again. ${a.text}`
              : `No items were sent: the new categories (${names}) could not be created. ${a.text}`,
            detail: a.detail,
          },
        })
        return
      }
      created = (up.data || []).map(c => c.name)
      const reread = await settleWithin(scopedFrom('categories', 'id, name, sort_order'), READ_TIMEOUT_MS, 'Reading categories')
      if (reread.error) {
        const a = asActionError(reread.error)
        finish({
          imported: 0, created, skipped: plan.skipped, codesSent: [],
          failure: { text: `The new categories were created, but the list could not be read back to file items under them, so no items were sent. Import the same file again: the categories now exist and are used. ${a.text}`, detail: a.detail },
        })
        return
      }
      cats = reread.data || []
    }

    // 2. Every ready row against a category id.
    const toSend = []
    const unfiled = []
    plan.ready.forEach(r => {
      let catId = r.category_id
      if (r.newCategory) {
        const found = findCategory(r.newCategory, cats)
        if (!found) { unfiled.push({ rowNo: r.rowNo, name: r.name, reason: `The category "${r.newCategory}" could not be found after it was created. Nothing was saved for this row.` }); return }
        catId = found.id
      }
      toSend.push({ ...r, payload: itemInsertRow(r, catId) })
    })

    // 3. The items, 200 a request. A name taken since the read costs only its own row.
    const res = await insertInChunks(toSend,
      chunk => settleWithin(scopedInsert('items', chunk.map(r => r.payload)), IMPORT_TIMEOUT_MS, 'Import'),
      { onProgress: n => setView(v => (v?.stage === 'importing' ? { ...v, done: n } : v)) })
    const clashed = res.clashed.map(r => ({ rowNo: r.rowNo, name: r.name, reason: 'Another item with this name was saved after the preview was read. Nothing about it was changed.' }))
    let failure = null
    if (res.failure) {
      const a = asActionError(res.failure.error)
      failure = { text: `${partialImportText(res.failure, res.inserted.length, 'items')} ${a.text}`, detail: a.detail }
    }
    finish({
      imported: res.inserted.length, created,
      skipped: [...plan.skipped, ...unfiled, ...clashed].sort((x, y) => (x.rowNo || 0) - (y.rowNo || 0)),
      failure,
      // Every code handed out, landed or not: a code kept back costs one skipped number, a code
      // reused is two items sharing it (item_code has no unique index).
      codesSent: toSend.map(r => r.item_code),
    })
  }

  function close() {
    if (busy) return
    setView(null)
  }

  const preview = view?.stage === 'preview' || view?.stage === 'importing' ? view : null
  const sendCount = preview?.plan.ready.length || 0

  return (
    <>
      <Tip width={320} text={`Add many items at once from a spreadsheet. Download the template, fill one item per row with the same boxes as Add Item, and import it. A name already in Item Master is skipped and listed afterwards, and nothing already on file is changed. ${itemPriceBasisText(vatMode)}`}>
        <button type="button" className="btn btn-ghost" onClick={downloadTemplate}>↓ Item Template</button>
      </Tip>
      {/* A real button with the visually-hidden input beside it (S803): display:none inside a
          label took the import out of the tab order. */}
      <button type="button" className="btn btn-ghost" onClick={() => fileRef.current?.click()} disabled={busy}>
        ↑ Import Items
      </button>
      <input ref={fileRef} type="file" accept=".xlsx,.xls" className="visually-hidden" tabIndex={-1} aria-hidden="true"
        onChange={handleFile} />

      {view && (
        <Modal onClose={close} maxWidth={900}
          title={view.stage === 'result' ? 'Import Items: Result' : view.stage === 'error' ? 'Import Items' : 'Import Items: Preview'}>
          {view.stage === 'reading' && (
            <p role="status" style={{ margin: 0, fontSize: 13, color: 'var(--theme-text2)' }}>Reading the file and checking it against Item Master…</p>
          )}

          {view.stage === 'error' && (
            <>
              <ActionError error={view.error} />
              <div className="form-actions"><button type="button" className="btn btn-ghost" onClick={close}>Close</button></div>
            </>
          )}

          {preview && (
            <>
              <p role="status" style={{ margin: '0 0 10px', fontSize: 13, color: 'var(--theme-text2)' }}>
                <strong style={{ color: 'var(--theme-text1)' }}>{sendCount}</strong> of {preview.parsed.length} rows ready to add
                {preview.plan.skipped.length > 0 && <> · <strong style={{ color: 'var(--theme-text1)' }}>{preview.plan.skipped.length}</strong> skipped</>}
                {preview.plan.newCategories.length > 0 && <> · new {preview.plan.newCategories.length === 1 ? 'category' : 'categories'}: {preview.plan.newCategories.join(', ')}</>}
                {preview.fileName ? <> · from {preview.fileName}</> : null}
              </p>
              <p className="note-banner" style={{ margin: '0 0 12px', fontSize: 12 }}>
                {itemPriceBasisText(vatMode)} Each price below also shows per KG or LTR where it applies, so a price typed against the wrong unit stands out. Item codes are given out when the rows are saved.
              </p>
              <ImportSkippedList rows={preview.plan.skipped} />
              {sendCount > 0 && (
                <div className="table-wrap" style={{ maxHeight: 340, overflowY: 'auto' }}>
                  <table className="data-table">
                    <thead>
                      <tr>
                        <th>Row</th>
                        <th>Item</th>
                        <th>Category</th>
                        <th>Unit</th>
                        <th style={{ textAlign: 'right' }}><Tip width={240} text="The price of one counted unit, as it will be saved. All figures in NPR.">Price</Tip></th>
                        <th>Bought in</th>
                        <th style={{ textAlign: 'right' }}>Yield</th>
                      </tr>
                    </thead>
                    <tbody>
                      {preview.plan.ready.map(r => (
                        <tr key={r.rowNo}>
                          <td style={{ color: 'var(--theme-text2)', whiteSpace: 'nowrap' }}>{r.rowNo}</td>
                          <td style={{ fontWeight: 600, color: 'var(--theme-text1)' }}>
                            {r.name}
                            {r.notes.length > 0 && <span className="cell-sub">{r.notes.join('; ')}</span>}
                          </td>
                          <td>
                            {r.newCategory ? <>{r.newCategory} <span className="badge badge-gray">new</span></>
                              : r.categoryResolved || <span style={{ color: 'var(--theme-text3)' }}>—</span>}
                          </td>
                          <td>{r.uom}</td>
                          <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>{unitRateCell(r.rate, r.uom)}</td>
                          <td style={{ whiteSpace: 'nowrap' }}>
                            {r.purchase_unit ? `1 ${r.purchase_unit} = ${r.conversion_factor} ${r.uom}` : <span style={{ color: 'var(--theme-text3)' }}>—</span>}
                          </td>
                          <td style={{ textAlign: 'right' }}>{r.yield_pct}%</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              <div className="form-actions" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
                <span role="status" style={{ fontSize: 12, color: 'var(--theme-text2)' }}>
                  {view.stage === 'importing' ? `Importing… ${view.done || 0} of ${sendCount}` : ''}
                </span>
                <div style={{ display: 'flex', gap: 8 }}>
                  <button type="button" className="btn btn-ghost" onClick={close} disabled={busy}>Cancel</button>
                  <button type="button" className="btn btn-primary" onClick={runImport} disabled={busy || sendCount === 0}>
                    {view.stage === 'importing' ? 'Importing…' : `Import ${sendCount} item${sendCount === 1 ? '' : 's'}`}
                  </button>
                </div>
              </div>
            </>
          )}

          {view.stage === 'result' && (
            <>
              <p role="status" style={{ margin: '0 0 10px', fontSize: 14, color: 'var(--theme-text1)' }}>
                <strong>Imported {view.imported} item{view.imported === 1 ? '' : 's'}.</strong>
                {view.created.length > 0 && <> Created {view.created.length === 1 ? 'the category' : `${view.created.length} categories:`} {view.created.join(', ')}.</>}
                {view.skipped.length > 0 && <> Skipped {view.skipped.length} row{view.skipped.length === 1 ? '' : 's'}, listed below.</>}
              </p>
              {view.failure && <ActionError error={view.failure} />}
              <ImportSkippedList rows={view.skipped} />
              <div className="form-actions"><button type="button" className="btn btn-primary" onClick={close}>Close</button></div>
            </>
          )}
        </Modal>
      )}
    </>
  )
}
