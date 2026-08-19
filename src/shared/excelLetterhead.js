/**
 * The printable-statutory-document header every Crest Excel export carries.
 *
 * WHY (S594): three hand-written copies of this already existed — SalesReport.jsx,
 * CoversReport.jsx and monthlyReportExcel.js — and the three report pages written the week of
 * 2026-08-17 had none, so they exported a bare `json_to_sheet`. An exported ageing schedule with
 * no client name, no as-of date and no period is not a document an accountant can file, and a
 * fourth hand-written copy is how the three that exist would have drifted from each other.
 *
 * `biz` is `{ name, vat, address, vatReg }` — the shape `useBizInfo()` returns.
 * `scopeLine` is the one line that says WHAT the sheet covers: a period, a date range, an as-of
 * date. It is required rather than optional on purpose; a sheet that does not state its own
 * scope cannot be reconciled a month later even by the person who made it.
 */
export function sheetWithLetterhead(XLSX, { title, biz, scopeLine, rows, notes = [] }) {
  const b = biz || {}
  const aoa = [
    [title],
    [`CompanyName : ${b.name || ''}`],
    [`${b.vatReg === false ? 'PAN No' : 'VATNO'} : ${b.vat || ''}`],
    [`ADDRESS : ${b.address || ''}`],
    [],
    [scopeLine],
    ...notes.map(n => [n]),
    [],
  ]
  const ws = XLSX.utils.aoa_to_sheet(aoa)
  XLSX.utils.sheet_add_json(ws, rows, { origin: -1 })
  return ws
}
