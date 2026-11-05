import { useRef, useState } from 'react'
import Tip from '../../../components/Tip'
import Modal from '../../../components/Modal'
import ActionError, { asActionError } from '../../../components/ActionError'
import { useScopedDb } from '../../../shared/hooks/useScopedDb'
import { fetchAllRows } from '../../../shared/fetchAllRows'
import { settleWithin } from '../../../utils/withTimeout'
import { sheetRows, pickSheet, insertInChunks, partialImportText, IMPORT_TIMEOUT_MS } from '../items/sheetImport'
import ImportSkippedList from '../items/ImportSkippedList'
import { VENDOR_SHEET_NAME, VENDOR_IMPORT_COLUMNS, parseVendorRows, planVendorImport, vendorInsertRow } from './vendorImportPlan'
import { payTermsLabel, DEFAULT_PAY_WITHIN_DAYS, MAX_PAY_WITHIN_DAYS } from './payTerms'

// Vendors' Excel import (S885, owner decision 1). The same shape as Item Master's: template, file
// pick, a preview of what is added and what is skipped and why, then the write in chunks of 200.
// A supplier already on file (any capitals, archived ones included) is skipped and never changed;
// an odd or shared PAN imports with a warning. The plan is made against a fresh read for the
// preview and again at Import, so a supplier added in another tab since is skipped, not doubled.
const READ_TIMEOUT_MS = 20000

const EXAMPLES = [
  ['Himalayan Traders', 'Ram Shrestha', '9841000000', 'Balaju, Kathmandu', '601234567', 30, 'Cheque on the 5th'],
  ['Valley Fresh Vegetables', '', '9800000000', 'Kalimati', '', '', 'COD'],
  ['City Dairy', 'Sita', '014400000', 'Lalitpur', '609876543', 15, ''],
]

export default function VendorImportButton({ codePrefix, onImported }) {
  const { clientId, scopedFrom, scopedInsert } = useScopedDb()
  const fileRef = useRef(null)
  const [view, setView] = useState(null)
  const busy = view?.stage === 'reading' || view?.stage === 'importing'

  async function downloadTemplate() {
    const XLSX = await import('xlsx')
    const cols = VENDOR_IMPORT_COLUMNS
    const ws = XLSX.utils.aoa_to_sheet([cols])
    ws['!cols'] = [{ wch: 28 }, { wch: 18 }, { wch: 14 }, { wch: 26 }, { wch: 14 }, { wch: 14 }, { wch: 26 }]
    const guide = [
      ['How to fill the Suppliers sheet: one supplier per row, under the header. Then use Import Suppliers on Vendors.'],
      [],
      ['Column', 'What to type'],
      [cols[0], 'The name as it should read on Vendors and on every bill. A name already on file, in any capitals and archived suppliers included, is skipped and listed after the import. Nothing already on file is changed.'],
      [cols[1], 'The sales rep or account manager, if any.'],
      [cols[2], 'Format the column as Text in Excel so a leading 0 is kept.'],
      [cols[3], 'Where they are.'],
      [cols[4], 'Their PAN or VAT number, 9 digits, as printed on their bill. A PAN that is not 9 digits, or one another supplier already has, still imports, with a warning in the preview.'],
      [cols[5], `How many days you have to pay their bills before one counts as overdue: whole days from 0 to ${MAX_PAY_WITHIN_DAYS}, 0 for cash on delivery. Leave it blank for the usual ${DEFAULT_PAY_WITHIN_DAYS} days. If it is blank and the terms note says something like Net 30 or COD, that is used.`],
      [cols[6], 'Anything else agreed, like 50% advance. Shown on the supplier list.'],
      [],
      ['Examples (copy the shape, not the details)'],
      cols,
      ...EXAMPLES,
    ]
    const wsGuide = XLSX.utils.aoa_to_sheet(guide)
    wsGuide['!cols'] = [{ wch: 22 }, { wch: 110 }]
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, ws, VENDOR_SHEET_NAME)
    XLSX.utils.book_append_sheet(wb, wsGuide, 'Instructions')
    XLSX.writeFile(wb, 'Supplier-Import-Template.xlsx')
  }

  // Every supplier on file, archived ones included, read fresh rather than from the page.
  async function readOnFile() {
    const res = await settleWithin(
      fetchAllRows(() => scopedFrom('vendors', 'id, name, vendor_code, pan_vat_no, is_active, archived_at').order('id')),
      READ_TIMEOUT_MS, 'Reading suppliers')
    return res.error ? { error: res.error } : { vendors: res.data || [] }
  }

  async function handleFile(e) {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    if (!clientId) { setView({ stage: 'error', error: 'No client selected. Pick a client in the top-left switcher first.' }); return }
    setView({ stage: 'reading' })
    let parsed
    try {
      const buf = await file.arrayBuffer()
      const XLSX = await import('xlsx')
      const wb = XLSX.read(new Uint8Array(buf), { type: 'array' })
      parsed = parseVendorRows(sheetRows(XLSX, pickSheet(wb, VENDOR_SHEET_NAME)))
    } catch (err) {
      setView({ stage: 'error', error: { text: 'Crest could not read this file. Save it as an Excel workbook (.xlsx), ideally from the template, and pick it again.', detail: err?.message || '' } })
      return
    }
    if (parsed.length === 0) {
      setView({ stage: 'error', error: 'No suppliers were found in the sheet. Use the template: one supplier per row under the header, on the sheet called Suppliers.' })
      return
    }
    const onFile = await readOnFile()
    if (onFile.error) {
      const a = asActionError(onFile.error)
      setView({ stage: 'error', error: { text: `Nothing was imported. Crest could not read the suppliers already on file, so it cannot tell which rows are new. ${a.text}`, detail: a.detail } })
      return
    }
    setView({ stage: 'preview', fileName: file.name, parsed, plan: planVendorImport(parsed, { ...onFile, prefix: codePrefix }) })
  }

  async function runImport() {
    if (view?.stage !== 'preview') return
    const { parsed, fileName } = view
    setView(v => ({ ...v, stage: 'importing', done: 0 }))
    const finish = result => { setView({ stage: 'result', fileName, ...result }); onImported?.() }

    const onFile = await readOnFile()
    if (onFile.error) {
      const a = asActionError(onFile.error)
      finish({ imported: 0, skipped: [], warned: 0, failure: { text: `Nothing was imported. Crest could not read the suppliers again just before writing, so no row was sent. ${a.text}`, detail: a.detail } })
      return
    }
    const plan = planVendorImport(parsed, { ...onFile, prefix: codePrefix })
    const res = await insertInChunks(plan.ready,
      chunk => settleWithin(scopedInsert('vendors', chunk.map(vendorInsertRow)), IMPORT_TIMEOUT_MS, 'Import'),
      { onProgress: n => setView(v => (v?.stage === 'importing' ? { ...v, done: n } : v)) })
    const clashed = res.clashed.map(r => ({ rowNo: r.rowNo, name: r.name, reason: 'The database refused this row as a duplicate. Nothing already on file was changed.' }))
    let failure = null
    if (res.failure) {
      const a = asActionError(res.failure.error)
      failure = { text: `${partialImportText(res.failure, res.inserted.length, 'suppliers')} ${a.text}`, detail: a.detail }
    }
    finish({
      imported: res.inserted.length,
      warned: res.inserted.filter(r => r.warnings.length > 0).length,
      skipped: [...plan.skipped, ...clashed].sort((x, y) => (x.rowNo || 0) - (y.rowNo || 0)),
      failure,
    })
  }

  function close() {
    if (busy) return
    setView(null)
  }

  const preview = view?.stage === 'preview' || view?.stage === 'importing' ? view : null
  const sendCount = preview?.plan.ready.length || 0
  const warnCount = preview ? preview.plan.ready.filter(r => r.warnings.length > 0).length : 0

  return (
    <>
      <Tip width={320} text={`Add many suppliers at once from a spreadsheet. Download the template, fill one supplier per row and import it. A supplier already on file is skipped and listed afterwards, and nothing already on file is changed. Pay within is whole days, blank for ${DEFAULT_PAY_WITHIN_DAYS}.`}>
        <button type="button" className="btn btn-ghost" onClick={downloadTemplate}>↓ Supplier Template</button>
      </Tip>
      <button type="button" className="btn btn-ghost" onClick={() => fileRef.current?.click()} disabled={busy}>
        ↑ Import Suppliers
      </button>
      <input ref={fileRef} type="file" accept=".xlsx,.xls" className="visually-hidden" tabIndex={-1} aria-hidden="true"
        onChange={handleFile} />

      {view && (
        <Modal onClose={close} maxWidth={900}
          title={view.stage === 'result' ? 'Import Suppliers: Result' : view.stage === 'error' ? 'Import Suppliers' : 'Import Suppliers: Preview'}>
          {view.stage === 'reading' && (
            <p role="status" style={{ margin: 0, fontSize: 13, color: 'var(--theme-text2)' }}>Reading the file and checking it against your suppliers…</p>
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
                {warnCount > 0 && <> · <strong style={{ color: 'var(--theme-amber-text)' }}>{warnCount}</strong> with a PAN to check (still imported)</>}
                {preview.fileName ? <> · from {preview.fileName}</> : null}
              </p>
              <ImportSkippedList rows={preview.plan.skipped} />
              {sendCount > 0 && (
                <div className="table-wrap" style={{ maxHeight: 340, overflowY: 'auto' }}>
                  <table className="data-table">
                    <thead>
                      <tr>
                        <th>Row</th>
                        <th>Supplier</th>
                        <th>Phone</th>
                        <th>PAN / VAT</th>
                        <th><Tip width={260} text={`How long before a bill from them counts as overdue. (default) means the cell was blank, so the usual ${DEFAULT_PAY_WITHIN_DAYS} days apply.`}>Payment terms</Tip></th>
                      </tr>
                    </thead>
                    <tbody>
                      {preview.plan.ready.map(r => (
                        <tr key={r.rowNo}>
                          <td style={{ color: 'var(--theme-text2)', whiteSpace: 'nowrap' }}>{r.rowNo}</td>
                          <td style={{ fontWeight: 600, color: 'var(--theme-text1)' }}>
                            {r.name}
                            {r.contact_person && <span className="cell-sub">{r.contact_person}</span>}
                          </td>
                          <td style={{ whiteSpace: 'nowrap' }}>{r.phone || <span style={{ color: 'var(--theme-text3)' }}>—</span>}</td>
                          <td>
                            <span style={{ whiteSpace: 'nowrap' }}>{r.pan_vat_no || <span style={{ color: 'var(--theme-text3)' }}>—</span>}</span>
                            {r.warnings.map((w, i) => (
                              <span key={i} className="cell-sub" style={{ color: 'var(--theme-amber-text)' }}>△ {w}</span>
                            ))}
                          </td>
                          <td>
                            <span style={{ whiteSpace: 'nowrap' }}>{payTermsLabel(r)}</span>
                            {r.payFromNote && <span className="cell-sub">read from the terms note</span>}
                            {r.payment_terms && <span className="cell-sub">{r.payment_terms}</span>}
                          </td>
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
                    {view.stage === 'importing' ? 'Importing…' : `Import ${sendCount} supplier${sendCount === 1 ? '' : 's'}`}
                  </button>
                </div>
              </div>
            </>
          )}

          {view.stage === 'result' && (
            <>
              <p role="status" style={{ margin: '0 0 10px', fontSize: 14, color: 'var(--theme-text1)' }}>
                <strong>Imported {view.imported} supplier{view.imported === 1 ? '' : 's'}.</strong>
                {view.warned > 0 && <> {view.warned} of them have a PAN worth checking on Vendors.</>}
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
