import { useMemo, useState } from 'react'
import Modal from '../../../components/Modal'
import Tip from '../../../components/Tip'
import ActionError from '../../../components/ActionError'
import { BS_MONTHS, formatBsDay, getBsToday } from '../../../utils/bsCalendar'
import { ATTENDANCE_STATUSES } from '../payrollConstants'
import { detectMapping, readAttendance, guessMatches, HEADER_SCAN_ROWS } from './attendanceImport'
import { planImport, SKIP } from './attendanceImportPlan'

// Import from machine (S775). Three steps — the file, who is who, what will change — and a fourth,
// "choose the columns", for a layout the reader in attendanceImport.js does not recognise. Nothing
// here writes: `onApply` hands the sheet its changes as unsaved marks, and the sheet's own Save
// writes them, so the lock, the unsaved-work banner and the one-upsert save all still apply.

const STATUS_LABEL = Object.fromEntries(ATTENDANCE_STATUSES.map(s => [s.key, s.label]))
// A text export (CSV, a machine's .dat log) is read as text. Read as a spreadsheet, SheetJS turns a
// BS "05-01" into 30 April 2001.
const TEXT_FILE = /\.(csv|tsv|txt|dat)$/i
const LAYOUTS = [
  { key: 'grid', label: 'One row per person, a column for each day' },
  { key: 'daily', label: 'One row per person for each day' },
  { key: 'punches', label: 'One row for each punch' },
]
const layoutLabel = key => LAYOUTS.find(l => l.key === key)?.label.toLowerCase() || ''
const calLabel = cal => (cal === 'ad' ? 'English (AD) dates' : 'Nepali (BS) dates')

const cellText = v => (v instanceof Date ? v.toLocaleDateString() : String(v ?? '')).replace(/\s+/g, ' ').trim()
const colLetter = c => { let s = '', n = c + 1; while (n > 0) { const r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = Math.floor((n - 1) / 26) } return s }

// Where a hand-picked layout starts: the header row is the row with the most filled cells.
function blankMapping(rows) {
  let headerRow = 0, most = 0
  rows.slice(0, HEADER_SCAN_ROWS).forEach((r, i) => {
    const n = (r || []).filter(c => cellText(c)).length
    if (n > most) { most = n; headerRow = i }
  })
  return { layout: 'grid', headerRow, nameCol: -1, lastNameCol: -1, idCol: -1, firstDayCol: -1, lastDayCol: -1, dateCol: -1, inCol: -1, outCol: -1, cellCol: -1, timeCol: -1 }
}

function readErrorText(r, periodLabel) {
  switch (r.error) {
    case 'wrong-month':
      return r.fileMonth
        ? `This file is for ${BS_MONTHS[r.fileMonth.month - 1]} ${r.fileMonth.year}, but the sheet is on ${periodLabel}. Switch the month at the top of the page, then import again. If the dates are being read the wrong way round, choose the date format under Choose columns.`
        : `None of the dates in this file fall in ${periodLabel}.`
    case 'no-dates': return 'No dates were found in this file under the columns chosen. Check which column holds the date, or pick the date format.'
    case 'no-people': return 'No staff names or machine IDs were found under the columns chosen.'
    case 'no-times': return 'No clock times or attendance marks were found in this file. It may be a summary of hours rather than the punches themselves — export the check-in and check-out report instead.'
    default: return "Crest couldn't tell how this file is laid out. Show it which columns hold what."
  }
}

export default function AttendanceImportModal({
  period, periodLabel, employees, records, rosterByKey, shiftTypesById, autoHours, defaultBreak, onApply, onClose,
}) {
  const [step, setStep] = useState('file')
  const [reading, setReading] = useState(false)
  const [error, setError] = useState('')
  const [file, setFile] = useState(null)          // { name, sheets: [{ name, rows }] }
  const [sheetIndex, setSheetIndex] = useState(0)
  const [mapping, setMapping] = useState(null)
  const [forced, setForced] = useState({ cal: '', order: '' })
  const [result, setResult] = useState(null)
  const [guesses, setGuesses] = useState({})
  const [matches, setMatches] = useState({})
  const [breakMin, setBreakMin] = useState(defaultBreak)
  const [kept, setKept] = useState(() => new Set()) // `updated` changes the reader unticked
  const [today] = useState(getBsToday)

  const rows = file?.sheets[sheetIndex]?.rows || []
  const empById = useMemo(() => new Map(employees.map(e => [e.id, e])), [employees])

  function read(sheetRows, m, f) {
    const r = readAttendance(sheetRows, m, period, { forced: { cal: f.cal || undefined, order: f.order || undefined } })
    if (r.error) { setResult(null); setError(readErrorText(r, periodLabel)); return false }
    const g = guessMatches(r.people, employees)
    setResult(r)
    setGuesses(g)
    // A person with nothing in this month starts as Skip; everyone else must be confirmed —
    // a guess is filled in, but nobody is imported until the reader presses Continue.
    setMatches(Object.fromEntries(r.people.map(p => [p.key, g[p.key]?.employeeId || (p.dataDays === 0 ? SKIP : '')])))
    setKept(new Set())
    setError('')
    setStep('match')
    return true
  }

  async function pickFile(e) {
    const f = e.target.files?.[0]
    e.target.value = '' // the same file can be chosen again after fixing it
    if (!f) return
    setError('')
    if (/\.pdf$/i.test(f.name)) {
      setError('This is a PDF. Crest reads the Excel or CSV file the attendance machine\'s software exports — export the report as Excel from that software and choose that file instead.')
      return
    }
    setReading(true)
    try {
      const XLSX = await import('xlsx')
      const wb = XLSX.read(new Uint8Array(await f.arrayBuffer()), { type: 'array', cellDates: true, raw: TEXT_FILE.test(f.name) })
      const sheets = wb.SheetNames
        .map(name => ({ name, rows: XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, raw: true, defval: '', blankrows: false }) }))
        .filter(s => s.rows.length > 0)
      if (!sheets.length) { setError('This file has no rows in it.'); return }
      // A workbook often carries a summary sheet beside the punches; the first sheet whose layout
      // is recognised is the one read.
      let chosen = 0, found = null
      for (let i = 0; i < sheets.length && !found; i++) { found = detectMapping(sheets[i].rows); if (found) chosen = i }
      setFile({ name: f.name, sheets })
      setSheetIndex(chosen)
      setForced({ cal: '', order: '' })
      setMapping(found || blankMapping(sheets[chosen].rows))
      if (!found) { setError(readErrorText({ error: 'no-layout' }, periodLabel)); setStep('columns'); return }
      read(sheets[chosen].rows, found, { cal: '', order: '' })
    } catch (err) {
      setError({ text: 'This file could not be opened. Choose the Excel (.xlsx or .xls) or CSV file the machine exported.', detail: err?.message || String(err) })
    } finally {
      setReading(false)
    }
  }

  // ── Step 2: who is who ──────────────────────────────────────────────────────
  const undecided = result ? result.people.filter(p => !matches[p.key]).length : 0
  const pickedBy = useMemo(() => {
    const m = new Map()
    Object.entries(matches).forEach(([k, v]) => { if (v && v !== SKIP) m.set(v, k) })
    return m
  }, [matches])
  const notInFile = employees.filter(e => !pickedBy.has(e.id))

  // ── Step 3: what will change ────────────────────────────────────────────────
  const plan = useMemo(() => {
    if (!result || step !== 'review') return null
    return planImport({
      people: result.people, coverage: result.coverage, matches, employees, records, period,
      rosterByKey, shiftTypesById, autoHours, breakMinutes: breakMin, today,
    })
  }, [result, step, matches, employees, records, period, rosterByKey, shiftTypesById, autoHours, breakMin, today])
  const toApply = plan ? plan.changes.filter(c => !(c.kind === 'updated' && kept.has(c.key))) : []
  const updates = plan ? plan.changes.filter(c => c.kind === 'updated') : []
  const matchedIds = result ? [...new Set(result.people.map(p => matches[p.key]).filter(v => v && v !== SKIP))] : []
  const coverageText = result?.coverage.length
    ? `${formatBsDay(result.coverage[0], period.bs_month)} to ${formatBsDay(result.coverage[result.coverage.length - 1], period.bs_month)}`
    : ''

  function toggleKept(key) {
    setKept(prev => { const next = new Set(prev); if (next.has(key)) next.delete(key); else next.add(key); return next })
  }

  // ── Columns form ────────────────────────────────────────────────────────────
  const headerCells = mapping && mapping.headerRow >= 0 ? (rows[mapping.headerRow] || []) : (rows[0] || [])
  const width = Math.min(60, Math.max(0, ...rows.slice(0, HEADER_SCAN_ROWS + 5).map(r => (r || []).length)))
  const columnOptions = Array.from({ length: width }, (_, c) => ({ c, label: `${colLetter(c)} · ${cellText(headerCells[c]).slice(0, 28) || '(blank)'}` }))
  const setMap = patch => setMapping(m => ({ ...m, ...patch }))
  const columnSelect = (field, label, { required = false, tip } = {}) => (
    <label style={{ display: 'grid', gap: 4, fontSize: 12, color: 'var(--theme-text2)' }}>
      <span>{tip ? <Tip text={tip} width={240}>{label}</Tip> : label}{required ? ' *' : ''}</span>
      <select className="form-select" value={mapping[field] ?? -1} onChange={e => setMap({ [field]: parseInt(e.target.value, 10) })}>
        <option value={-1}>{required ? '— Choose —' : '— None —'}</option>
        {columnOptions.map(o => <option key={o.c} value={o.c}>{o.label}</option>)}
      </select>
    </label>
  )
  const mappingProblem = !mapping ? 'Choose a file first.'
    : mapping.layout === 'grid'
      ? (mapping.nameCol < 0 && mapping.idCol < 0 ? 'Choose the name or machine ID column.' : mapping.firstDayCol < 0 || mapping.lastDayCol < mapping.firstDayCol ? 'Choose the first and last day columns.' : '')
      : mapping.layout === 'daily'
        ? (mapping.nameCol < 0 && mapping.idCol < 0 ? 'Choose the name or machine ID column.' : mapping.dateCol < 0 ? 'Choose the date column.' : mapping.inCol < 0 && mapping.outCol < 0 && mapping.cellCol < 0 ? 'Choose the In and Out columns, or the column holding both.' : '')
        : (mapping.nameCol < 0 && mapping.idCol < 0 ? 'Choose the name or machine ID column.' : mapping.timeCol < 0 ? 'Choose the column holding the punch time.' : '')

  const previewRows = rows.slice(Math.max(0, mapping?.headerRow ?? 0), Math.max(0, mapping?.headerRow ?? 0) + 4)
  const previewWidth = Math.min(width, 12)

  const stepTitle = { file: 'Import from machine', columns: 'Choose the columns', match: 'Who is who', review: 'Check what will change' }[step]

  return (
    <Modal title={`${stepTitle} — ${periodLabel}`} onClose={reading ? () => {} : onClose} maxWidth={step === 'review' || step === 'columns' ? 960 : 720}>
      <div style={{ display: 'grid', gap: 14, fontSize: 13, color: 'var(--theme-text2)', lineHeight: 1.6 }}>

        {step === 'file' && (
          <>
            <p style={{ margin: 0 }}>
              Choose the attendance report your fingerprint or face machine exports — Excel (.xlsx, .xls) or CSV.
              Crest works out the layout itself: a month grid with a column for each day, one row per person per day,
              or a list of every punch. Nothing goes on the sheet until you have checked it, and nothing is saved until you press Save.
            </p>
            <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
              <label className="btn btn-primary" style={{ margin: 0, cursor: reading ? 'wait' : 'pointer' }}>
                {reading ? 'Reading…' : file ? 'Choose another file' : 'Choose file'}
                <input type="file" accept=".xlsx,.xls,.csv,.tsv,.txt,.dat,.pdf" style={{ display: 'none' }} onChange={pickFile} disabled={reading} />
              </label>
              {file && <span style={{ fontSize: 12 }}>{file.name}</span>}
              {file && mapping && (
                <button type="button" className="btn btn-ghost" onClick={() => { setError(''); setStep('columns') }}>Choose columns myself</button>
              )}
            </div>
            <ActionError error={error} />
          </>
        )}

        {step === 'columns' && mapping && (
          <>
            <ActionError error={error} />
            <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', alignItems: 'end' }}>
              {file.sheets.length > 1 && (
                <label style={{ display: 'grid', gap: 4, fontSize: 12 }}>
                  <span>Sheet</span>
                  <select className="form-select" value={sheetIndex} onChange={e => {
                    const i = parseInt(e.target.value, 10)
                    setSheetIndex(i)
                    setMapping(detectMapping(file.sheets[i].rows) || blankMapping(file.sheets[i].rows))
                  }}>
                    {file.sheets.map((s, i) => <option key={i} value={i}>{s.name}</option>)}
                  </select>
                </label>
              )}
              <label style={{ display: 'grid', gap: 4, fontSize: 12 }}>
                <span><Tip text="The row holding the column headings (Name, ID, Date, 05-01 …). Choose 'No heading row' for a machine log that starts straight with the punches." width={260}>Heading row</Tip></span>
                <select className="form-select" value={mapping.headerRow} onChange={e => setMap({ headerRow: parseInt(e.target.value, 10) })}>
                  <option value={-1}>No heading row</option>
                  {rows.slice(0, HEADER_SCAN_ROWS).map((r, i) => (
                    <option key={i} value={i}>Row {i + 1}: {(r || []).map(cellText).filter(Boolean).slice(0, 4).join(' · ').slice(0, 60) || '(blank)'}</option>
                  ))}
                </select>
              </label>
            </div>

            <fieldset style={{ border: 'none', padding: 0, margin: 0 }}>
              <legend style={{ fontSize: 12, marginBottom: 6 }}>How is the file laid out?</legend>
              <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
                {LAYOUTS.map(l => (
                  <label key={l.key} style={{ display: 'flex', gap: 6, alignItems: 'center', color: 'var(--theme-text1)' }}>
                    <input type="radio" name="att-import-layout" checked={mapping.layout === l.key} onChange={() => setMap({ layout: l.key })} />
                    {l.label}
                  </label>
                ))}
              </div>
            </fieldset>

            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 12 }}>
              {columnSelect('nameCol', 'Name')}
              {columnSelect('lastNameCol', 'Last name', { tip: 'Only when the machine keeps first and last names in separate columns.' })}
              {columnSelect('idCol', 'Machine ID', { tip: 'The number the machine knows each person by. Either a name or an ID is enough.' })}
              {mapping.layout === 'grid' && columnSelect('firstDayCol', 'First day column', { required: true })}
              {mapping.layout === 'grid' && columnSelect('lastDayCol', 'Last day column', { required: true })}
              {mapping.layout === 'daily' && columnSelect('dateCol', 'Date', { required: true })}
              {mapping.layout === 'daily' && columnSelect('inCol', 'In time')}
              {mapping.layout === 'daily' && columnSelect('outCol', 'Out time')}
              {mapping.layout === 'daily' && columnSelect('cellCol', 'In and out together', { tip: 'A single column holding both times, like "08:05-20:00".' })}
              {mapping.layout === 'punches' && columnSelect('timeCol', 'Punch time', { required: true, tip: 'The date and time of each punch, or just the time when the date has its own column.' })}
              {mapping.layout === 'punches' && columnSelect('dateCol', 'Date (if separate)')}
            </div>

            <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap' }}>
              <label style={{ display: 'grid', gap: 4, fontSize: 12 }}>
                <span><Tip text="Crest normally tells from the dates themselves. Choose one when a file for this month is being read as another month." width={260}>Dates are in</Tip></span>
                <select className="form-select" value={forced.cal} onChange={e => setForced(f => ({ ...f, cal: e.target.value }))}>
                  <option value="">Work it out</option>
                  <option value="bs">Nepali (BS)</option>
                  <option value="ad">English (AD)</option>
                </select>
              </label>
              <label style={{ display: 'grid', gap: 4, fontSize: 12 }}>
                <span>Date order</span>
                <select className="form-select" value={forced.order} onChange={e => setForced(f => ({ ...f, order: e.target.value }))}>
                  <option value="">Work it out</option>
                  <option value="md">Month first (05-17)</option>
                  <option value="dm">Day first (17-05)</option>
                </select>
              </label>
            </div>

            <div className="table-wrap">
              <table className="data-table" style={{ fontSize: 11 }}>
                <thead>
                  <tr>{Array.from({ length: previewWidth }, (_, c) => <th key={c}>{colLetter(c)}</th>)}</tr>
                </thead>
                <tbody>
                  {previewRows.map((r, i) => (
                    <tr key={i}>{Array.from({ length: previewWidth }, (_, c) => <td key={c} style={{ whiteSpace: 'nowrap' }}>{cellText((r || [])[c]).slice(0, 18)}</td>)}</tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', alignItems: 'center', flexWrap: 'wrap' }}>
              {mappingProblem && <span style={{ fontSize: 12 }}>{mappingProblem}</span>}
              <button type="button" className="btn btn-ghost" onClick={() => { setError(''); setStep('file') }}>Back</button>
              <button type="button" className="btn btn-primary" disabled={!!mappingProblem} onClick={() => read(rows, mapping, forced)}>Read the file</button>
            </div>
          </>
        )}

        {step === 'match' && result && (
          <>
            <p style={{ margin: 0 }}>
              <strong style={{ color: 'var(--theme-text1)' }}>{result.people.length}</strong> {result.people.length === 1 ? 'person' : 'people'} in {file.name} — {layoutLabel(result.layout)}, {calLabel(result.mode.cal)}.
              Pick the Crest employee each one is. Crest has guessed where the names fit; check every guess, because a wrong pair puts one person&apos;s days on someone else&apos;s pay.
            </p>
            <div className="table-wrap">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>On the machine</th>
                    <th style={{ textAlign: 'right' }}>
                      <Tip text={`Days in ${periodLabel} the file has times or a mark for.`} width={200}>Days</Tip>
                    </th>
                    <th style={{ width: '45%' }}>Crest employee</th>
                  </tr>
                </thead>
                <tbody>
                  {result.people.map(p => {
                    const value = matches[p.key] || ''
                    const guess = guesses[p.key]
                    return (
                      <tr key={p.key}>
                        <td>
                          <div style={{ fontWeight: 600, color: 'var(--theme-text1)' }}>{p.name}</div>
                          {p.id && <div style={{ fontSize: 11 }}>Machine ID {p.id}</div>}
                        </td>
                        <td style={{ textAlign: 'right' }}>{p.dataDays}</td>
                        <td>
                          <select className="form-select" style={{ width: '100%' }} aria-label={`Crest employee for ${p.name}`} value={value}
                            onChange={e => setMatches(m => ({ ...m, [p.key]: e.target.value }))}>
                            <option value="">— Choose —</option>
                            <option value={SKIP}>Skip — don&apos;t import</option>
                            {employees.map(e => {
                              const taken = pickedBy.has(e.id) && pickedBy.get(e.id) !== p.key
                              return <option key={e.id} value={e.id} disabled={taken}>{e.full_name}{e.employee_code ? ` (${e.employee_code})` : ''}{taken ? ' — already picked' : ''}</option>
                            })}
                          </select>
                          {guess && value === guess.employeeId && <div style={{ fontSize: 11, marginTop: 2 }}>Guessed from the {guess.how}</div>}
                          {p.dataDays === 0 && value === SKIP && <div style={{ fontSize: 11, marginTop: 2 }}>Nothing for {periodLabel} in the file</div>}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
            {notInFile.length > 0 && (
              <p style={{ margin: 0, fontSize: 12 }}>
                Not matched to anyone in the file: {notInFile.map(e => e.full_name).join(', ')}. Their days stay exactly as they are.
              </p>
            )}
            <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', alignItems: 'center', flexWrap: 'wrap' }}>
              {undecided > 0 && <span style={{ fontSize: 12 }}>Choose someone, or Skip, for {undecided} more {undecided === 1 ? 'person' : 'people'}.</span>}
              {undecided === 0 && matchedIds.length === 0 && <span style={{ fontSize: 12 }}>Everyone is set to Skip, so there is nothing to import.</span>}
              <button type="button" className="btn btn-ghost" onClick={() => setStep('columns')}>Choose columns</button>
              <button type="button" className="btn btn-ghost" onClick={() => setStep('file')}>Back</button>
              <button type="button" className="btn btn-primary" disabled={undecided > 0 || matchedIds.length === 0} onClick={() => setStep('review')}>Continue</button>
            </div>
          </>
        )}

        {step === 'review' && plan && (
          <>
            <div style={{ display: 'flex', gap: 16, alignItems: 'center', flexWrap: 'wrap' }}>
              <span>{periodLabel}, {coverageText} · {calLabel(result.mode.cal)}</span>
              <span style={{ flex: 1 }} />
              <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 12 }}>
                <Tip text="Taken off the hours of every day brought in with both an in and an out time, as the sheet's Default break is. A Present day already on the sheet with its own break keeps it. Overtime is worked out exactly as if the times had been typed." width={280}>Break</Tip>
                <input type="number" min="0" step="5" className="form-input form-input--auto" style={{ width: 64, textAlign: 'right' }}
                  value={breakMin} onChange={e => setBreakMin(parseInt(e.target.value, 10) || 0)} aria-label="Break minutes taken off each imported day" />
                min
              </label>
            </div>

            <div className="table-wrap">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Employee</th>
                    <th style={{ textAlign: 'right' }}><Tip text="Blank days with a full in and out on the machine — marked Present with those times, the break, and hours and overtime." width={240}>Worked</Tip></th>
                    <th style={{ textAlign: 'right' }}><Tip text="Days already marked Present that take the machine's in and out times instead. Untick any below to keep what is on the sheet." width={240}>New times</Tip></th>
                    <th style={{ textAlign: 'right' }}><Tip text="Only one punch, or in and out under an hour apart. Brought in as Present with the times the machine has and hours left blank, and shown in amber on the sheet until you fix them." width={260}>To check</Tip></th>
                    <th style={{ textAlign: 'right' }}><Tip text="No punch on a day the roster had them working." width={200}>Absent</Tip></th>
                    <th style={{ textAlign: 'right' }}><Tip text="No punch on a day the roster had them off — marked Off, or the leave or holiday the roster shift is named for." width={240}>Off / leave</Tip></th>
                    <th style={{ textAlign: 'right' }}><Tip text="Days the file marks with a letter or word instead of times, such as P, A, Off or Leave. A leave that does not say paid is marked Unpaid Leave." width={240}>Marked</Tip></th>
                    <th style={{ textAlign: 'right' }}><Tip text="No punch, and not on the roster that day, so nothing is marked. Mark these yourself — for daily- and hourly-paid staff a blank day pays nothing." width={260}>Left blank</Tip></th>
                    <th style={{ textAlign: 'right' }}><Tip text="Days already on the sheet — leave, off days, anything you marked — which stay exactly as they are." width={220}>Already marked</Tip></th>
                  </tr>
                </thead>
                <tbody>
                  {matchedIds.map(id => {
                    const c = plan.byEmployee[id] || {}
                    const n = v => v || <span style={{ color: 'var(--theme-text3)' }}>—</span>
                    return (
                      <tr key={id}>
                        <td style={{ fontWeight: 600, color: 'var(--theme-text1)' }}>{empById.get(id)?.full_name}</td>
                        <td style={{ textAlign: 'right' }}>{n(c.worked)}</td>
                        <td style={{ textAlign: 'right' }}>{n(c.updated)}</td>
                        <td style={{ textAlign: 'right', color: c.flagged ? 'var(--theme-amber-text)' : undefined, fontWeight: c.flagged ? 600 : undefined }}>{c.flagged ? `△ ${c.flagged}` : n(0)}</td>
                        <td style={{ textAlign: 'right' }}>{n(c.absent)}</td>
                        <td style={{ textAlign: 'right' }}>{n(c.off)}</td>
                        <td style={{ textAlign: 'right' }}>{n(c.marked)}</td>
                        <td style={{ textAlign: 'right' }}>{n(c.blank)}</td>
                        <td style={{ textAlign: 'right' }}>{n(c.kept)}</td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>

            {updates.length > 0 && (
              <details open={updates.length <= 12}>
                <summary style={{ cursor: 'pointer', color: 'var(--theme-text1)', fontWeight: 600 }}>
                  {updates.length} Present {updates.length === 1 ? 'day takes' : 'days take'} the machine&apos;s times — untick any to keep the sheet&apos;s
                </summary>
                <div style={{ display: 'grid', gap: 4, marginTop: 8 }}>
                  {updates.map(u => (
                    <label key={u.key} style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 12 }}>
                      <input type="checkbox" checked={!kept.has(u.key)} onChange={() => toggleKept(u.key)} />
                      <span>
                        <strong style={{ color: 'var(--theme-text1)' }}>{empById.get(u.employeeId)?.full_name}</strong> · {formatBsDay(u.day, period.bs_month)} ·{' '}
                        {u.before?.start_time || u.before?.end_time ? `${u.before.start_time || '—'}–${u.before.end_time || '—'}` : 'no times'} → {u.machine}
                      </span>
                    </label>
                  ))}
                </div>
              </details>
            )}

            {plan.conflicts.length > 0 && (
              <details>
                <summary style={{ cursor: 'pointer', color: 'var(--theme-amber-text)', fontWeight: 600 }}>
                  △ The file shows {plan.conflicts.length} {plan.conflicts.length === 1 ? 'day' : 'days'} differently from how {plan.conflicts.length === 1 ? 'it is' : 'they are'} marked — left as marked
                </summary>
                <ul style={{ margin: '8px 0 0 18px', padding: 0, fontSize: 12 }}>
                  {plan.conflicts.map(c => (
                    <li key={c.key}>
                      <strong style={{ color: 'var(--theme-text1)' }}>{empById.get(c.employeeId)?.full_name}</strong> · {formatBsDay(c.day, period.bs_month)} · marked {STATUS_LABEL[c.status] || c.status}, file says {STATUS_LABEL[c.machine] || c.machine}
                    </li>
                  ))}
                </ul>
                <p style={{ margin: '6px 0 0', fontSize: 12 }}>If someone worked on a day marked leave or off, change that day on the sheet yourself.</p>
              </details>
            )}

            {(plan.skipped.future > 0 || plan.skipped.notEmployed > 0 || result.outside > 0) && (
              <p style={{ margin: 0, fontSize: 12 }}>
                Not brought in:{' '}
                {[
                  plan.skipped.future > 0 && `${plan.skipped.future} day${plan.skipped.future === 1 ? '' : 's'} from today on with no punch yet, or after today`,
                  plan.skipped.notEmployed > 0 && `${plan.skipped.notEmployed} day${plan.skipped.notEmployed === 1 ? '' : 's'} before someone joined or after they left`,
                  result.outside > 0 && `${result.outside} day${result.outside === 1 ? '' : 's'} in the file outside ${periodLabel}`,
                ].filter(Boolean).join(' · ')}.
              </p>
            )}

            <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', alignItems: 'center', flexWrap: 'wrap' }}>
              {toApply.length === 0 && <span style={{ fontSize: 12 }}>Nothing to put on the sheet — every day in this file is already marked.</span>}
              <button type="button" className="btn btn-ghost" onClick={() => setStep('match')}>Back</button>
              <button type="button" className="btn btn-primary" disabled={toApply.length === 0} onClick={() => onApply(toApply)}>
                Put {toApply.length} day{toApply.length === 1 ? '' : 's'} on the sheet
              </button>
            </div>
            <p style={{ margin: 0, fontSize: 11, textAlign: 'right' }}>They arrive as unsaved marks. Check them on the sheet, then press Save.</p>
          </>
        )}
      </div>
    </Modal>
  )
}
