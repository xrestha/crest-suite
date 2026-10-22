import { nprOrDash } from '../../shared/nepalMoney'
import { useState, useEffect, useCallback, useRef } from 'react'
import { Navigate, Link, useSearchParams } from 'react-router-dom'
import { TriangleAlert, Check } from 'lucide-react'
import { useAuth } from '../../context/AuthContext'
import { supabase } from '../../supabaseClient'
import { useScopedDb } from '../../shared/hooks/useScopedDb'
import { useSettings } from '../../context/SettingsContext'
import { useBizInfo } from '../../shared/hooks/useBizInfo'
import { fcThresholds, varianceBand, COGS_FORMULA } from '../../shared/imsFormulas'
import { FEATURE_TIER } from '../../shared/featureCatalog'
import { gapHeadline } from '../../shared/uncountedItems'
import { descendingBand, lcBand, pcBand, nmBand } from '../../shared/operatingBands'
import { BS_MONTHS } from '../../utils/bsCalendar'
import { withTimeout, settleWithin, isTimeout } from '../../utils/withTimeout'
import SuiteGate, { SUITE_PAGES, useSuiteAccess } from '../../components/SuiteGate'
import Tip from '../../components/Tip'
import ConfirmModal from '../../components/ConfirmModal'
import ActionError, { asActionError } from '../../components/ActionError'
import ReportLoadError from '../../components/ReportLoadError'
import MonthStepper, { neighboursOf } from '../../components/MonthStepper'
import { printWithTitle } from '../../utils/printTitle'
import { useLatestRequest } from '../../shared/hooks/useLatestRequest'
import { generateMonthlyReport, saveGeneratedReport, regenerateReport } from '../../modules/ownerReport/generateMonthlyReport'
import { buildExecutiveSummary } from '../../modules/ownerReport/reportNarrative'
import { reportMadeText } from '../../modules/ownerReport/reportMadeLine'
import { failedSectionKeys, sectionLabel, sectionList, newlyMissingSections, trendUnavailableText, priorFailedSections } from '../../modules/ownerReport/sectionNames'
import { lastMonthFigures } from '../../modules/ownerReport/lastMonthFigures'
import { loadProfileNames } from '../../shared/profileNames'
import './MonthlyOwnerReport.css'

const fmt = nprOrDash
const pct = n => (n == null ? '—' : `${n.toFixed(1)}%`)
const num = n => (n == null ? '—' : Math.round(n).toLocaleString('en-IN'))

// How long the page waits (S849, OWNER-REPORT-6). A read that blocks the page gets 20 s; making the
// report reads a whole month across three modules, so it gets 90 s, the close's own limit.
const READ_MS = 20000
const MAKE_MS = 90000

// A printed qualifier under a figure or a table (a Tip does not print).
const noteStyle = { fontSize: 12, color: 'var(--theme-text2)', margin: '8px 0 0', lineHeight: 1.5 }
const warnNoteStyle = { ...noteStyle, color: 'var(--theme-amber-text)' }
const subStyle = { display: 'block', fontSize: 11, fontWeight: 500, color: 'var(--theme-text3)', whiteSpace: 'normal' }

// The printed page: A4, and the running footer drawn in its bottom margin boxes (see the <style>
// where this is rendered). The label is a business name, so it is escaped into a CSS string. The
// greys are the print block's own literals; a margin box is outside the element tree the theme
// tokens resolve in.
const cssString = s => `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/[\r\n]+/g, ' ')}"`
function pageFooterCss(label) {
  const box = 'font-family: Archivo, sans-serif; font-size: 9px; color: #555; border-top: 1px solid #ccc; vertical-align: top; padding-top: 3mm;'
  return `@page { size: A4 portrait; margin: 16mm 14mm 20mm; `
    + `@bottom-left { content: ${cssString(label)}; ${box} } `
    + `@bottom-right { content: "Page " counter(page) " of " counter(pages); ${box} } }`
}

// A two-column "Label ... Value" line item — the document convention used throughout this
// report instead of dashboard-style KPI tiles (see CLAUDE.md's Monthly Owner/Manager Report
// section for why: a frozen artifact meant to be read/printed as a report, not glanced at live).
function Row({ label, value, tip, color }) {
  return (
    <tr>
      <td style={{ color: 'var(--theme-text2)' }}>{tip ? <Tip text={tip} width={260}>{label}</Tip> : label}</td>
      <td style={{ textAlign: 'right', fontWeight: 600, color: color || 'var(--theme-text1)' }}>{value}</td>
    </tr>
  )
}

// Direction, spelled out.
//
// Colour is the ONLY encoding these delta cells had, and it does not survive printing: Layout.css's
// print block sets `th, td { color: black !important }`, which beats every inline colour in this
// file. So the primary deliverable — the document an owner is handed — showed "+2.3pp" with
// nothing to say whether that was good or bad, and the reader has to know that up is bad for a
// cost metric and good for margin. On screen it was a WCAG 1.4.1 (Use of Color) failure for the
// same reason. A glyph plus a word survives both the print override and a screen reader.
// `rose` is which way the number actually moved; `good` is whether that is the direction you want.
// They come apart on Net Margin %, where up is good, while for every cost metric up is bad — so
// the arrow tracks the movement and the word carries the judgement. Deriving the arrow from `good`
// alone would print a down-arrow next to a margin that had risen.
function DirectionMark({ good, rose }) {
  if (good == null) return null
  return (
    <span style={{ fontWeight: 500, whiteSpace: 'nowrap' }}>
      {' '}{rose ? '▲' : '▼'} {good ? 'better' : 'worse'}
    </span>
  )
}

// The Financial Summary's Last month cell (S857): the figure frozen in this report's own Trend copy
// of last month (lastMonthFigures), or a dash whose Tip says why. Plain text and no band: the verdict
// belongs to this month's figure, and nothing in a cell is a button, so it prints whole.
function LastMonthCell({ cell, show }) {
  if (cell?.value != null) return <td className="owner-report-last">{show(cell.value)}</td>
  return <td className="owner-report-last">{cell?.why ? <Tip text={cell.why} width={260}>—</Tip> : '—'}</td>
}

// Trend row for a money-basis metric — `delta` is the {absoluteChange, pctChange} shape
// computeMonthlyReport.js's buildDeltas() returns, or null if either side is missing.
// Only used for Revenue and POS Net Sales, where up is unambiguously good.
function TrendRow({ label, cur, prior, delta, fmtFn }) {
  const good = delta == null || delta.absoluteChange === 0 ? null : delta.absoluteChange > 0
  const color = good == null ? undefined : good ? 'var(--theme-green-text)' : 'var(--theme-red-text)'
  return (
    <tr>
      <td style={{ color: 'var(--theme-text2)' }}>{label}</td>
      <td style={{ textAlign: 'right', fontWeight: 600 }}>{fmtFn(cur)}</td>
      <td style={{ textAlign: 'right', color: 'var(--theme-text3)' }}>{fmtFn(prior)}</td>
      <td style={{ textAlign: 'right', fontWeight: 600, color }}>
        {delta == null ? '—' : <>
          {`${delta.absoluteChange >= 0 ? '+' : ''}${fmtFn(delta.absoluteChange)}${delta.pctChange != null ? ` (${delta.pctChange >= 0 ? '+' : ''}${delta.pctChange.toFixed(1)}%)` : ''}`}
          {/* Revenue up is better, so the arrow points the way the money went, not the way the
              cost metrics below read it. */}
          {good != null && <span style={{ fontWeight: 500, whiteSpace: 'nowrap' }}>{' '}{good ? '▲' : '▼'} {good ? 'better' : 'worse'}</span>}
        </>}
      </td>
    </tr>
  )
}

// Trend row for a percentage-point metric (Food Cost %, Labor Cost %, etc.) — `delta` here is a
// plain number (percentage-POINT change), not the {absoluteChange,pctChange} money shape. Printed
// as "points", never "pp" (S857): the Change header's Tip says once what a point is.
// `higherIsBetter` flips the color logic for Net Margin % (up = good), vs the default (down =
// good) for cost metrics like Food/Labor/Prime Cost %. `unjudged` (S849, OWNER-REPORT-12): page 1
// withholds the verdict on this figure for one of the two months, so the change is shown with no
// better/worse word and no colour.
function TrendPctRow({ label, cur, prior, delta, higherIsBetter = false, unjudged = false }) {
  const good = unjudged || delta == null || delta === 0 ? null : higherIsBetter ? delta > 0 : delta < 0
  const color = good == null ? undefined : good ? 'var(--theme-green-text)' : 'var(--theme-red-text)'
  return (
    <tr>
      <td style={{ color: 'var(--theme-text2)' }}>{label}</td>
      <td style={{ textAlign: 'right', fontWeight: 600 }}>{cur == null ? '—' : `${cur.toFixed(1)}%`}</td>
      <td style={{ textAlign: 'right', color: 'var(--theme-text3)' }}>{prior == null ? '—' : `${prior.toFixed(1)}%`}</td>
      <td style={{ textAlign: 'right', fontWeight: 600, color }}>
        {delta == null ? '—' : <><span className="owner-report-nowrap">{`${delta >= 0 ? '+' : ''}${delta.toFixed(1)} points`}</span><DirectionMark good={good} rose={delta > 0} /></>}
      </td>
    </tr>
  )
}

// The frozen, exportable artifact version of Owner Dashboard's live KPIs — one snapshot per
// closed period, generated at close time (see Periods.js) or lazily on first view for a
// pre-existing closed period. Sections render per the SNAPSHOT's own recorded modules_included,
// not live clientModules — a historical report never grows a section retroactively just because
// a module got enabled later. See CLAUDE.md's Monthly Owner/Manager Report section.
//
// S849 (OWNER-REPORT-17, GAPS-2, ACCESS's Suite-page pattern): two components in one file. This
// outer one holds only the role guard, the header and SuiteGate; every read and write lives in
// `MonthlyOwnerReportBody`, which SuiteGate mounts (render prop) only once the gate passes, so an
// Owner without Crest Suite Pro no longer mints a report behind the upsell card. The body is keyed
// on the outlet, so an outlet switch (in this tab or another) remounts it with empty state and no
// load of the old outlet can land on the new one.
export default function MonthlyOwnerReport() {
  const { clientId, isAdmin, isOwner } = useAuth()

  // RLS already blocks every staff-account type from monthly_owner_reports (see migration
  // 20260721010000) — this guard just keeps a staff account from landing on a page that would
  // otherwise show nothing but load errors, and matches Layout.js's own (isAdmin || isOwner)
  // visibility condition for the Owner Dashboard nav link.
  if (!isAdmin && !isOwner) return <Navigate to="/dashboard" replace />

  return (
    <div>
      <div className="page-header owner-report-page-header">
        {/* S857: one name for the page (the nav, SuiteGate and the palette say "Monthly Owner Report"
            too; only the Owner and Crest support open it), and the subtitle states its tense. */}
        <h1 className="page-title">Monthly Owner Report</h1>
        <p className="page-subtitle">Last month as it stood when it closed, frozen to print and keep. Crest IMS, HR and POS together.</p>
      </div>
      <SuiteGate page={SUITE_PAGES.ownerReport}>
        {() => <MonthlyOwnerReportBody key={clientId || 'none'} />}
      </SuiteGate>
    </div>
  )
}

function MonthlyOwnerReportBody() {
  const { clientId, isAdmin, isOwner, hasFeature } = useAuth()
  const canOverheads = hasFeature('overheads')
  // Overheads is an IMS feature of one plan; the label names it (OWNER-REPORT-11).
  const overheadsTier = (t => (t ? t[0].toUpperCase() + t.slice(1) : ''))(FEATURE_TIER.overheads)
  const { scopedFrom } = useScopedDb()
  const periodReq = useLatestRequest()
  const { settings } = useSettings()
  // The letterhead (name, VAT/PAN, address) through the shared hook, with its read error and its
  // `ready` gate (S849, OWNER-REPORT-18): the hand-rolled read dropped both errors and printed a
  // blank business name into the workbook.
  const biz = useBizInfo()
  // The open month's way forward (S857): the Owner Dashboard shows the month so far, when this
  // outlet passes its gate (it needs Crest HR as well as IMS).
  const ownerDashboard = useSuiteAccess(SUITE_PAGES.ownerDashboard)
  const periodSelectRef = useRef(null)
  // The month on screen lives in the address too (S858), as HR's Payroll and Attendance keep theirs
  // (S804): a reload, Back or a link sent to the accountant opens the same month. Read once, for the
  // first pick; `replace` so stepping through months does not fill the Back button.
  const [searchParams, setSearchParams] = useSearchParams()
  const askedPeriodRef = useRef(searchParams.get('period'))

  const [periods, setPeriods] = useState([])
  const [periodsError, setPeriodsError] = useState(null)
  const [selectedPeriodId, setSelectedPeriodId] = useState(null)
  const [report, setReport] = useState(null)
  const [loading, setLoading] = useState(true)
  const [generating, setGenerating] = useState(false)
  const [regenerating, setRegenerating] = useState(false)
  const [confirmRegenerate, setConfirmRegenerate] = useState(false)
  const [generatorName, setGeneratorName] = useState('')
  // A failed READ (`{ kind: 'read', error }`, ReportLoadError) or a failed MAKE (`{ kind: 'make',
  // error: ActionError value }`). Never `error.message` raw.
  const [pageError, setPageError] = useState(null)
  // The operator never makes a report by browsing (GAPS-11): a closed month with none waits for "Make it now".
  const [needsMaking, setNeedsMaking] = useState(false)
  // Regeneration reports through the page's own notice, not window.alert — this is the only
  // native dialog left on a screen that already confirms this action through ConfirmModal, and
  // the one place the outcome of overwriting frozen figures gets announced. `{ tone: 'ok'|'warn',
  // text }` or `{ tone: 'error', error }` (an ActionError value).
  const [regenNotice, setRegenNotice] = useState(null)
  const [exportError, setExportError] = useState(null)

  // GAPS-2: a write that finishes after the page went away (outlet switch, navigation) must not
  // land, and Regenerate's result must land only on the month still on screen.
  const mountedRef = useRef(true)
  useEffect(() => { mountedRef.current = true; return () => { mountedRef.current = false } }, [])
  const selectedRef = useRef(null)
  useEffect(() => { selectedRef.current = selectedPeriodId }, [selectedPeriodId])
  // Whatever picked the month (the first load, the picker, ‹ ›, the open-month card), the address
  // follows it, so a link copied at any moment names the month on screen.
  useEffect(() => {
    if (!selectedPeriodId || searchParams.get('period') === selectedPeriodId) return
    setSearchParams(prev => { const next = new URLSearchParams(prev); next.set('period', selectedPeriodId); return next }, { replace: true })
  }, [selectedPeriodId]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!clientId) { setLoading(false); return }
    let cancelled = false
    ;(async () => {
      // `client_id` is read so the lazy generate can refuse a month that is not this outlet's (GAPS-2).
      const res = await settleWithin(scopedFrom('monthly_periods', 'id, client_id, bs_year, bs_month, status')
        .order('bs_year', { ascending: false }).order('bs_month', { ascending: false }), READ_MS, 'Loading the months')
      if (cancelled || !mountedRef.current) return
      // A failed read must not impersonate "no periods yet" (S612, the silent-zero class).
      if (res.error) { setPeriodsError(res.error); setLoading(false); return }
      const rows = res.data || []
      setPeriods(rows)
      // A month named in the address wins when it is one of this outlet's; else the latest closed one.
      const asked = askedPeriodRef.current && rows.find(p => p.id === askedPeriodRef.current)?.id
      const first = asked || rows.find(p => p.status === 'closed')?.id || rows[0]?.id || null
      setSelectedPeriodId(prev => prev || first)
      if (!first) setLoading(false)
    })()
    return () => { cancelled = true }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clientId])

  // Who made a report, for the header's "when it was made" line (D42), read the way a reload reads
  // it: from the row's `generated_by`, which the database stamps (S849, GAPS-11), so the operator
  // reads "Crest support" everywhere and a failed write never names its presser. A failed or empty
  // names read leaves the name out rather than printing a dash as if nobody made it, and it never
  // blocks the report already on screen. Bounded by the page's own READ_MS (S857, the critique
  // found it unbounded at the call site): loadProfileNames settles a timeout or a rejection into
  // `error`, so a hung read only drops the name from the "made by" line.
  async function makerName(id) {
    if (!id) return ''
    const { map: names, error: namesErr } = await loadProfileNames(supabase, clientId, [id], { ms: READ_MS, label: 'Reading who made the report' })
    if (namesErr) { console.error('Owner Report: could not read who made it', namesErr); return '' }
    return names[id] || ''
  }

  // Make and save the report for a closed month, then read it back (the lazy generate, and the
  // operator's "Make it now"). `key` is the request this belongs to.
  async function makeReport(period, key) {
    const label = `${BS_MONTHS[period.bs_month - 1]} ${period.bs_year}`
    // GAPS-2: the month must be this outlet's. The scoped read already filters by outlet, so this
    // fires only if the outlet changed under a stale list; the database refuses it too
    // (owner_report_1_same_client).
    if (period.client_id && period.client_id !== clientId) {
      setPageError({ kind: 'make', error: `No report was made: ${label} belongs to another outlet. Reload the page and pick the month again.` })
      setLoading(false)
      return
    }
    setGenerating(true)
    let stage = 'compute'
    try {
      const { snapshot, modulesIncluded } = await withTimeout(generateMonthlyReport({ clientId, period }), MAKE_MS, 'Making the monthly report')
      // GAPS-2: the figures took a while; write them only if this page is still this outlet's and this month's.
      if (!mountedRef.current || !periodReq.isCurrent(key)) return
      stage = 'save'
      await withTimeout(saveGeneratedReport({ clientId, period, snapshot, modulesIncluded, source: 'backfill' }), READ_MS, 'Saving the monthly report')
      stage = 'read'
      // Read back what is STORED: when another tab or the close saved first (23505), that row stands.
      const freshRes = await settleWithin(scopedFrom('monthly_owner_reports', '*').eq('period_id', period.id).maybeSingle(), READ_MS, 'Reading the report back')
      if (!mountedRef.current || !periodReq.isCurrent(key)) return
      if (freshRes.error || !freshRes.data) {
        setPageError({ kind: 'read', error: freshRes.error || { message: `The report for ${label} was saved, but it could not be read back to show you. Reload the page.` } })
        setReport(null)
        return
      }
      setReport(freshRes.data)
      setGeneratorName('')
      const name = await makerName(freshRes.data.generated_by)
      if (!mountedRef.current || !periodReq.isCurrent(key)) return
      setGeneratorName(name)
    } catch (e) {
      if (!mountedRef.current || !periodReq.isCurrent(key)) return
      console.error('Report generation failed:', e)
      const info = asActionError(e, 'operator')
      // A save we stopped waiting for may still land: never say it was not made.
      const text = isTimeout(e) && stage !== 'compute'
        ? `We stopped waiting for ${label}'s report to save, so it may have been made. Reload the page in a minute to see.`
        : isTimeout(e)
          ? `No report was made for ${label}: its figures took too long to read. Try again on a steadier connection.`
          : /^No report was made|^Only the Owner/.test(info.text) ? info.text
          : `No report was made for ${label}. ${info.text}`
      setPageError({ kind: 'make', error: { text, detail: info.detail } })
      setReport(null)
    } finally {
      // Only the request that is still current clears the flags (OWNER-REPORT-6).
      if (mountedRef.current && periodReq.isCurrent(key)) { setGenerating(false); setLoading(false) }
    }
  }

  const loadReport = useCallback(async () => {
    // Arrowing the period <select> starts one load per keypress and the last to land used to win
    // the figures while the label said another month (S601) — on the one report that is printed
    // and handed to an accountant, where the label is also the print title and the filename.
    // Claimed before anything can return (GAPS-2), so a superseded load never writes.
    const key = periodReq.begin(selectedPeriodId)
    const period = periods.find(p => p.id === selectedPeriodId)
    setGenerating(false)
    setNeedsMaking(false)
    setPageError(null)
    setExportError(null)
    if (!period) { setReport(null); setLoading(false); return }
    setLoading(true)

    const existingRes = await settleWithin(scopedFrom('monthly_owner_reports', '*').eq('period_id', period.id).maybeSingle(), READ_MS, 'Loading the report')
    if (!mountedRef.current || !periodReq.isCurrent(key)) return   // superseded by a newer period selection
    // A failed read here used to fall straight through to the lazy-generate path — treating
    // "could not read the snapshot" as "no snapshot exists" (S612). Refuse instead.
    if (existingRes.error) { setPageError({ kind: 'read', error: existingRes.error }); setReport(null); setLoading(false); return }
    const existing = existingRes.data
    if (existing) {
      setReport(existing)
      setGeneratorName('')   // never the previous month's maker under this month's report
      const name = await makerName(existing.generated_by)
      if (!mountedRef.current || !periodReq.isCurrent(key)) return   // superseded during the names read
      setGeneratorName(name)
      setLoading(false)
      return
    }

    setReport(null)
    if (period.status !== 'closed') { setLoading(false); return }

    // The operator browsing a client never freezes a report (GAPS-11): it is made by one deliberate press.
    if (isAdmin) { setNeedsMaking(true); setLoading(false); return }

    // Lazy-generate — a closed period from before this feature shipped, a close by someone who
    // cannot write the report (D42), or a report-gen call that failed at close time.
    await makeReport(period, key)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedPeriodId, periods, clientId, isAdmin])

  useEffect(() => { if (selectedPeriodId) loadReport() }, [selectedPeriodId, loadReport])

  function makeNow() {
    const period = periods.find(p => p.id === selectedPeriodId)
    if (!period) return
    const key = periodReq.begin(selectedPeriodId)
    setNeedsMaking(false)
    setPageError(null)
    setLoading(true)
    makeReport(period, key)
  }

  async function handleRegenerate() {
    // Confirmed through ConfirmModal (S575 rule — this overwrites frozen figures, the one
    // deliberate exception to the snapshot freeze). Rendered at the end of the body.
    const period = periods.find(p => p.id === selectedPeriodId)
    if (!period || !report) return
    const label = `${BS_MONTHS[period.bs_month - 1]} ${period.bs_year}`
    const stored = report.snapshot
    setConfirmRegenerate(false)
    setRegenerating(true)
    setRegenNotice(null)
    let stage = 'compute'
    try {
      const { snapshot, modulesIncluded } = await withTimeout(generateMonthlyReport({ clientId, period }), MAKE_MS, 'Regenerating the monthly report')
      if (!mountedRef.current) return
      // OWNER-REPORT-3: never swap a complete report for a partial one.
      const lost = newlyMissingSections(stored, snapshot)
      if (lost.length > 0) {
        setRegenNotice({ tone: 'error', error: `Not regenerated: ${sectionList(lost)} could not be read just now, and the stored report has ${lost.length === 1 ? 'it' : 'them'}. The stored figures still stand; try again on a steadier connection.` })
        return
      }
      stage = 'save'
      const { error, updated } = await withTimeout(regenerateReport({ clientId, periodId: period.id, snapshot, modulesIncluded }), READ_MS, 'Saving the regenerated report')
      if (!mountedRef.current) return
      // A refusal (the database guard: the month reopened, a login that may not regenerate) or zero
      // rows changed (PostgREST answers no error) is "not regenerated" — it used to say "Regenerated".
      if (error || !updated) {
        const info = error ? asActionError(error, 'operator') : null
        setRegenNotice({ tone: 'error', error: {
          text: `Not regenerated: the stored figures still stand. ${info ? info.text : 'No report row was changed — reload the page to check this month still has its report.'}`,
          detail: info?.detail || '',
        } })
        return
      }
      // Past this line the overwrite HAS landed. A failure reading the row back therefore must
      // not say "Regeneration failed" — the frozen figures really were replaced, and telling the
      // owner otherwise invites a second regeneration against figures that already moved. What is
      // wrong at that point is only what is on screen.
      stage = 'read'
      const freshRes = await settleWithin(scopedFrom('monthly_owner_reports', '*').eq('period_id', period.id).maybeSingle(), READ_MS, 'Reading the report back')
      if (!mountedRef.current) return
      if (freshRes.error || !freshRes.data) {
        const info = freshRes.error ? asActionError(freshRes.error, 'operator') : null
        setRegenNotice({ tone: 'warn', text: `The report was regenerated, but it could not be re-read to show you. Reload the page to see the new figures.${info ? ` (${info.text})` : ''}` })
        return
      }
      // Only onto the month still on screen (OWNER-REPORT-3): the <select> is held while this runs,
      // and this is the backstop.
      if (selectedRef.current === period.id) {
        setReport(freshRes.data)
        setGeneratorName('')
        const name = await makerName(freshRes.data.generated_by)
        if (mountedRef.current && selectedRef.current === period.id) setGeneratorName(name)
      }
      if (mountedRef.current) setRegenNotice({ tone: 'ok', text: `Regenerated from today's data — ${label}.` })
    } catch (e) {
      if (!mountedRef.current) return
      const info = asActionError(e, 'operator')
      setRegenNotice({ tone: 'error', error: {
        text: isTimeout(e) && stage !== 'compute'
          ? 'We stopped waiting for the save, so we cannot say whether the report was regenerated. Reload the page to see which figures are stored.'
          : isTimeout(e)
            ? `Not regenerated: ${label}'s figures took too long to read. The stored figures still stand; try again on a steadier connection.`
            : `Not regenerated: the stored figures still stand. ${info.text}`,
        detail: info.detail,
      } })
    } finally {
      if (mountedRef.current) setRegenerating(false)
    }
  }

  const selectedPeriod = periods.find(p => p.id === selectedPeriodId)
  const snapshot = report?.snapshot
  const periodLabel = report ? `${BS_MONTHS[report.bs_month - 1]} ${report.bs_year}` : ''
  // Export and Print emit a FILE, so they wait for every read they print from (OWNER-REPORT-18):
  // the letterhead's name, and no load in flight (S728's stale-workbook rule).
  const exportsReady = !!report && biz.ready && !loading && !generating && !regenerating

  // Food Cost thresholds: the ones frozen with the report (schema 18, OWNER-REPORT-5), else today's
  // Settings for an older report.
  const liveFcT = fcThresholds(settings)
  const fcFrozen = !!snapshot?.combined?.fcThresholds
  const fcT = snapshot?.combined?.fcThresholds || liveFcT
  // canOverheads: without the Overheads feature the page gives Net Margin no verdict, nor does the prose.
  const execSummary = snapshot ? buildExecutiveSummary(snapshot, periodLabel, { fcT: liveFcT, canOverheads }) : ''
  // The Financial Summary's Last month column (S857): the copy of last month this report froze in its
  // Trend entry, never re-read; a dash with its reason where the method changed.
  const lm = snapshot ? lastMonthFigures(snapshot) : null
  // When and how this snapshot was made, in BS and Nepal time (S792, D42) — and, when it was made
  // at the first view rather than at the close, a plain sentence saying what that means.
  const made = report ? reportMadeText({
    generatedAt: report.generated_at, source: report.generation_source, byName: generatorName, monthLabel: periodLabel,
  }) : null

  // The open month's two ways forward (S857): the latest closed month (the list is newest first, and
  // any closed month has a report or gets one on first view), and the Owner Dashboard for this one.
  const latestClosed = periods.find(p => p.status === 'closed') || null
  const periodName = p => (p ? `${BS_MONTHS[p.bs_month - 1]} ${p.bs_year}` : '')
  const selectPeriod = id => setSelectedPeriodId(id)
  const steps = neighboursOf(periods, selectedPeriodId, p => p.id, p => periodName(p))
  function showMonth(id) {
    selectPeriod(id)
    // The button that was pressed goes away with the open-month card; focus stays on the month picker.
    periodSelectRef.current?.focus()
  }

  async function handleExport() {
    setExportError(null)
    try {
      const { exportMonthlyReportExcel } = await import('../../modules/ownerReport/monthlyReportExcel')
      exportMonthlyReportExcel(report, { name: biz.name, vat: biz.vat, address: biz.address, vatReg: biz.vatReg, madeLine: made?.line })
    } catch (e) {
      // A chunk that no longer exists after a deploy is the likeliest cause: the reload fixes it.
      console.error('Owner Report: export failed', e)
      setExportError({ text: 'The workbook was not made. Reload the page and try again.', detail: asActionError(e, 'operator').detail })
    }
  }
  // The figures some rows describe changed meaning at a version (the S696 par rule at v4, the
  // Wastage item set at v10); a frozen row keeps its own, so its tip must describe its own.
  const schemaVersion = report?.schema_version ?? snapshot?.schemaVersion ?? 0
  // v15 (S809 3m): the till section counts seated guests and nets credit notes by issue month. Read
  // from the section's own marker, the way foodCostBasisOf reads the combined one.
  const posSeated = snapshot?.pos?.covers?.basis === 'seated'
  // v16 (S814 4d, owner decision D1): Comped Bills' potential value is before VAT, marked on the
  // figure itself (`compedBillsTotal.basis`); an older report's carries VAT.
  const compExVat = snapshot?.pos?.compedBillsTotal?.basis === 'ex_vat'
  // The sections that failed when it was made, Inventory Depth's sub-sections included (OWNER-REPORT-2/-1).
  const failedKeys = snapshot ? failedSectionKeys(snapshot) : []
  const subFailed = key => !!snapshot?.inventoryDepth?.sectionErrors && key in snapshot.inventoryDepth.sectionErrors

  // ── Labour (schema 18, GAPS-4 / OWNER-REPORT-9 / -10) ──
  // A v18 report froze the one labour rule's answer as `combined.labour`; an older one has only the
  // HR section, and no labour at all without Crest HR.
  const lab = snapshot?.combined?.labour || null
  const labourShown = !!lab || !!snapshot?.hr
  const labourEstimated = lab ? lab.source === 'estimate' : snapshot?.hr?.payrollSource === 'estimated'
  // No verdict on a labour figure that is incomplete or absent: pay not set for someone on payroll,
  // nobody on payroll, labour not read, or no labour entered without Crest HR.
  const labourUnjudged = !!lab && (lab.reason === 'nopay' || lab.reason === 'nostaff' || lab.source === 'failed' || lab.source === 'none')
  // The short words under Labor, Prime and Net Margin, so the basis prints (a Tip does not).
  const labourSub = lab?.source === 'overheads' ? 'from Overheads'
    : labourEstimated ? 'estimate — payroll not finalized'
    : lab?.source === 'failed' ? 'labour could not be read'
    : ''
  const labourNotJudgedSub = lab?.reason === 'nopay' ? `pay not set for ${num(lab.noPayCount)} staff — not judged`
    : lab?.reason === 'nostaff' ? 'nobody on payroll — not judged'
    : ''

  // Color bands match Owner Dashboard's live KPI cards exactly, so the same rough magnitude
  // never reads as a different "health" color depending on which page you're looking at.
  //
  // -text variants because every one of these lands on a <td> as type. And labour's green band is
  // 30, not 37: the Target cell printed in the same table row reads "25-30%", so a client at 34%
  // used to get a reassuring green number sitting immediately beside a target it fails by four
  // points.
  //
  // The band is never carried by colour alone (S608): each returns a ✓/△/▲ shape mark and a title,
  // the same vocabulary `fcBand()` uses; the shapes differ by FILL, not hue, so they survive a
  // monochrome print of this page too. Labour, prime and net margin come from `operatingBands.js`
  // (S660), which the Owner Dashboard and the Roster board read too. Food cost keeps this page's
  // accent-ink middle step while reading the client's own thresholds — since S849 the pair frozen
  // with the report (OWNER-REPORT-5), so a later change in Settings never re-judges an old month.
  const NONE = { color: undefined, mark: '', title: undefined }
  const asTitled = b => ({ color: b.color, mark: b.mark, title: b.key === 'none' ? undefined : b.label })
  const fcBandOf = v => v == null ? NONE
    : asTitled(descendingBand(v, fcT.warn, fcT.critical, fcFrozen ? ' — your thresholds when this report was made' : ' — your Settings thresholds'))
  const lcBandOf = v => (v == null || labourUnjudged) ? NONE : asTitled(lcBand(v))
  const pcBandOf = v => (v == null || labourUnjudged) ? NONE : asTitled(pcBand(v))
  // Net margin is the one inverted band on this page: higher is better. Its verdict needs
  // `canOverheads` (without Overheads this month's fixed costs may simply not be entered), and a
  // labour figure that can be judged.
  const nmBandOf = v => (!canOverheads || v == null || labourUnjudged) ? NONE : asTitled(nmBand(v))

  // S792 (D30, schema v9): Food Cost % is food USED (COGS) ÷ revenue. A snapshot generated before
  // that has no `foodCostBasis` and froze net purchases ÷ revenue — it keeps its figure, and the
  // label says which basis it is, because a Tip does not print.
  const cogsBasis = snapshot?.combined?.foodCostBasis === 'cogs'
  const basisOf = s => (s?.combined?.foodCostBasis === 'cogs' ? 'cogs' : 'purchases')
  // Since v12 (S798 2e, LABOUR-FIGURES-4) Net Margin also subtracts Tax & Fees.
  const taxFeesInNet = s => s?.combined?.netMarginTaxFees === true
  // Since v13 (S798 3c) labour is pay earned plus festival, incentive and final-settlement pay.
  const earnedLabour = s => s?.combined?.labourBasis === 'earned'
  // Since v18 (S849, GAPS-1) Net Margin also subtracts raw stock wasted, staff meals and delivery commission.
  const pnlCostsInNet = s => s?.combined?.netMarginPnlCosts === true
  const netMarginTip = (() => {
    const food = cogsBasis ? 'food used (COGS)' : 'net purchases'
    // One or two plain sentences each (S857); the full method is on the Help page.
    if (pnlCostsInNet(snapshot)) {
      return 'Revenue minus every recorded cost, as a % of revenue: food used, raw stock wasted, staff meals, delivery commission, labour, overheads, and tax and fees. As on Consolidated P&L.'
    }
    if (taxFeesInNet(snapshot)) {
      return `Revenue minus ${food}, labour, overheads, and tax and fees, as a % of revenue. Older rule: raw stock wasted, staff meals and delivery commission are not taken off, so it reads high.`
    }
    return `Revenue minus ${food}, labour and overheads, as a % of revenue. Older rule: tax and fees, raw stock wasted, staff meals and delivery commission are not taken off, so it reads high.`
  })()
  // Labor Cost %'s tip says what labour is in this report (OWNER-REPORT-10), in one or two sentences.
  const laborTip = lab?.source === 'overheads'
    ? 'The Overheads Labor tab for the month, as a % of revenue. This outlet had no Crest HR when the report was made.'
    : lab?.source === 'none'
      ? 'No labour was entered on the Overheads Labor tab, and this outlet had no Crest HR when the report was made.'
      : labourEstimated
        ? 'An estimate of wages from Crest HR, as a % of revenue, because payroll was not finalized. Finalize payroll, then Regenerate Snapshot, for the exact figure.'
        : earnedLabour(snapshot)
          ? 'Finalized payroll as a % of revenue: pay earned, overtime and employer SSF, plus festival, incentive and final-settlement pay finalized this month.'
          : 'Gross pay, overtime and employer SSF, as a % of revenue (the older rule this report was made under).'
  // COGS rests on the closing count: an item with stock and no count is counted as all used. While
  // that gap is material the three ratios that contain food cost are shown without a verdict, as on
  // Monthly Summary (S756, D6). Only a v9 snapshot carries the gap. A food cost at or below zero is
  // not judged either (OWNER-REPORT-5): it means a count or a bill is missing, not a fine month.
  const countGap = snapshot?.ims?.countGap
  const verdictWithheld = cogsBasis && !!countGap?.material
  const fcNotPositive = snapshot?.combined?.foodCostPct != null && snapshot.combined.foodCostPct <= 0
  const UNJUDGED = { color: undefined, mark: '', title: 'Not judged: the closing count is incomplete, so food cost reads high until every item with stock is counted.' }
  const UNJUDGED_ZERO = { color: undefined, mark: '', title: 'Not judged: a food cost at or below zero means a closing count or a purchase bill is missing.' }
  const withheld = bandOf => v => (v == null ? bandOf(v) : verdictWithheld ? UNJUDGED : fcNotPositive ? UNJUDGED_ZERO : bandOf(v))
  const fcCellOf = withheld(fcBandOf)
  const pcCellOf = withheld(pcBandOf)
  const nmCellOf = withheld(nmBandOf)
  const dc = snapshot?.deliveryCommission
  const hrInReport = !!snapshot?.hr || report?.modules_included?.hr === true

  return (
    <>
      <div className="no-print card" style={{ marginBottom: 16, display: 'flex', gap: 16, alignItems: 'center', flexWrap: 'wrap' }}>
        {/* Held while Regenerate runs (OWNER-REPORT-3), so its result cannot land under another month's label. */}
        <MonthStepper prev={steps.prev} next={steps.next} onStep={selectPeriod} busy={regenerating}>
          <select aria-label="Period" ref={periodSelectRef}
            className="form-select" style={{ maxWidth: 220 }}
            value={selectedPeriodId || ''} onChange={e => selectPeriod(e.target.value)}
            disabled={regenerating}
          >
            {periods.length === 0 && <option value="">No periods yet</option>}
            {periods.map(p => (
              <option key={p.id} value={p.id}>
                {BS_MONTHS[p.bs_month - 1]} {p.bs_year}{p.status === 'open' ? ' (Open)' : ''}
              </option>
            ))}
          </select>
        </MonthStepper>
        {report && (
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button className="btn btn-ghost" onClick={handleExport} disabled={!exportsReady}>Export Excel</button>
            <button
              className="btn btn-ghost" disabled={!exportsReady}
              onClick={() => printWithTitle(`Monthly Owner Report — ${periodLabel} — ${biz.name}`)}
            >
              Print / Save as PDF
            </button>
            {/* The Owner regenerates too (S756): they now edit closed months in place, and a
                frozen report that only an operator could refresh would lag every such fix. */}
            {(isAdmin || isOwner) && (
              <button className="btn btn-ghost" onClick={() => setConfirmRegenerate(true)} disabled={regenerating || loading || generating}>
                {regenerating ? 'Regenerating…' : 'Regenerate Snapshot'}
              </button>
            )}
          </div>
        )}
      </div>

      {/* The letterhead could not be read: Export and Print stay off rather than ship a blank
          business name (OWNER-REPORT-18, S754). Its own slot, so a later load cannot wipe it. */}
      {biz.error && report && (
        <div className="no-print" style={{ marginBottom: 16 }}>
          <ActionError error={{ text: 'Your business name could not be loaded, so Export and Print are off: the letterhead would print blank. Reload the page.', detail: asActionError(biz.error, 'operator').detail }} />
        </div>
      )}
      {exportError && <div className="no-print" style={{ marginBottom: 16 }}><ActionError error={exportError} /></div>}

      {regenNotice && regenNotice.tone === 'error' && (
        <div className="no-print" style={{ marginBottom: 16 }}><ActionError error={regenNotice.error} /></div>
      )}
      {regenNotice && regenNotice.tone !== 'error' && (
        <div
          className="card no-print" role={regenNotice.tone === 'ok' ? 'status' : 'alert'}
          style={{
            marginBottom: 16, display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12,
            borderColor: `color-mix(in srgb, var(--theme-${regenNotice.tone === 'ok' ? 'green' : 'amber'}) 25%, transparent)`,
            background: `color-mix(in srgb, var(--theme-${regenNotice.tone === 'ok' ? 'green' : 'amber'}) 8%, transparent)`,
          }}
        >
          <p style={{ margin: 0, fontSize: 13, lineHeight: 1.5, display: 'flex', alignItems: 'flex-start', gap: 6, color: `var(--theme-${regenNotice.tone === 'ok' ? 'green' : 'amber'}-text)` }}>
            {regenNotice.tone === 'ok'
              ? <Check size={14} aria-hidden="true" style={{ flexShrink: 0, marginTop: 2 }} />
              : <TriangleAlert size={14} aria-hidden="true" style={{ flexShrink: 0, marginTop: 2 }} />}
            {regenNotice.text}
          </p>
          <button
            className="btn btn-ghost" style={{ fontSize: 12, padding: '8px 12px', flexShrink: 0 }}
            onClick={() => setRegenNotice(null)} aria-label="Dismiss"
          >&times;</button>
        </div>
      )}

      {/* The months could not be read: never "no periods yet" (S612), and never the raw message. */}
      {periodsError && <ReportLoadError error={periodsError} />}

      {!periodsError && (loading || generating) && (
        <div className="card"><p style={{ color: 'var(--theme-text2)', fontSize: 13, margin: 0 }}>
          {generating ? 'Making the report for this month…' : 'Loading…'}
        </p></div>
      )}

      {!loading && !generating && pageError?.kind === 'read' && <ReportLoadError error={pageError.error} />}
      {!loading && !generating && pageError?.kind === 'make' && <ActionError error={pageError.error} />}

      {/* The operator browsing a client: nothing is frozen until one deliberate press (GAPS-11). */}
      {!loading && !generating && !pageError && needsMaking && selectedPeriod && (
        <div className="card" style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <p style={{ color: 'var(--theme-text2)', fontSize: 13, margin: 0 }}>
            No report has been made for {BS_MONTHS[selectedPeriod.bs_month - 1]} {selectedPeriod.bs_year} yet.
          </p>
          <Tip text="Makes and freezes this month's report from the data as it stands now, as the Owner's first visit would. It is stamped as made by Crest support.">
            <button className="btn btn-primary" onClick={makeNow}>Make it now</button>
          </Tip>
        </div>
      )}

      {/* An open month has no report yet (S857): it was a dead end. Name the month, then the two
          ways forward: the latest closed month report, and this month so far on the Owner Dashboard. */}
      {!loading && !generating && !pageError && !needsMaking && selectedPeriod && selectedPeriod.status !== 'closed' && !report && (
        <div className="card owner-report-open-month">
          <p>
            <strong>{periodName(selectedPeriod)} is still open.</strong> Its report is made when the month is closed, and keeps the figures as they were that day.
          </p>
          {(latestClosed || ownerDashboard.allowed) && (
            <div className="owner-report-open-month__actions">
              {latestClosed && (
                <button className="btn btn-primary" onClick={() => showMonth(latestClosed.id)}>
                  Show the {periodName(latestClosed)} report
                </button>
              )}
              {ownerDashboard.allowed && (
                <Link to="/owner-dashboard" className="btn btn-ghost">
                  See {BS_MONTHS[selectedPeriod.bs_month - 1]} so far on the Owner Dashboard
                </Link>
              )}
            </div>
          )}
        </div>
      )}

      {!loading && !generating && report && snapshot && (
        <div className="card owner-report-doc">
          {/* Running footer, so a sheet separated from page 1 still says which business and
              period it belongs to — and, since S778, which page of how many. It lives in the page's
              bottom MARGIN. It used to be a position: fixed div, and Chrome paints a table that runs
              to the foot of a page straight over a fixed element, so the footer vanished on exactly
              the pages a long list filled. A margin box sits outside the content area where nothing
              reaches it, and it can count pages. It is a <style> rendered here, not a rule in the
              .css file, because the text is this report's own and because an @page rule in a lazy
              chunk's stylesheet stays in the document after you leave, re-margining every later
              print in the session. Chromium (Chrome, Edge) draws margin boxes; a browser that does
              not prints the report without a footer. */}
          <style>{pageFooterCss(`${biz.name || '—'} · Monthly Owner Report · ${periodLabel}`)}</style>
          {/* Letterhead */}
          <div className="owner-report-letterhead" style={{ textAlign: 'center', marginBottom: 16, paddingBottom: 12, borderBottom: '2px solid var(--theme-border)' }}>
            <h2 style={{ margin: '0 0 3px', fontSize: 17, fontWeight: 800, letterSpacing: '0.02em' }}>{biz.name || '—'}</h2>
            <p style={{ margin: '0 0 8px', fontSize: 11, color: 'var(--theme-text2)' }}>
              {biz.vatReg ? 'VAT No' : 'PAN No'}: {biz.vat || '—'}{biz.address ? ` · ${biz.address}` : ''}
            </p>
            <div style={{ fontSize: 13, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.1em', margin: '0 0 4px' }}>
              Monthly Owner Report
            </div>
            {/* When it was made, as a BS date and Nepal time (S792, D42). It printed the viewer's
                clock and calendar and "Source: Backfill", which told nobody that a report made at
                the Owner's first view holds the month as it stood that day, not at the close. */}
            <p style={{ margin: 0, fontSize: 11, color: 'var(--theme-text3)' }}>
              Period: {periodLabel} &nbsp;|&nbsp; {made?.line}
            </p>
            {made?.note && (
              <p style={{ margin: '4px auto 0', maxWidth: 560, fontSize: 11, lineHeight: 1.5, color: 'var(--theme-text2)' }}>
                {made.note}
              </p>
            )}
            {/* The sections below render per the snapshot's own modules_included, so a module
                that was off when this was generated is simply absent — which a reader takes
                for "there was nothing to report". Name what is not here (S683). */}
            {report.modules_included && ['ims', 'hr', 'pos'].some(m => report.modules_included[m] === false) && (
              <p style={{ margin: '6px 0 0', fontSize: 11, color: 'var(--theme-amber-text)' }}>
                Not in this report: {['ims', 'hr', 'pos'].filter(m => report.modules_included[m] === false)
                  .map(m => ({
                    ims: 'Crest IMS',
                    // v18 (OWNER-REPORT-9, SU18): without Crest HR the Labor tab is the labour.
                    hr: lab?.source === 'overheads' ? 'Crest HR (labour is from the Overheads Labor tab)' : 'Crest HR (no payroll or labour figures)',
                    pos: 'Crest POS',
                  })[m]).join(', ')}
                {' '}— not enabled when it was generated.
              </p>
            )}
          </div>

          {/* A section that failed when the report was made, named in words, printed under the
              header, with the repair beside it (S849, OWNER-REPORT-2 / -1). It used to be a
              no-print note at the foot of the page naming code keys ("hr, laborAnalytics"), so a
              printed report with no payroll in it looked complete. Print hides the button. S857: the
              shared .amber-banner, not a hand-rolled rounded amber box. */}
          {failedKeys.length > 0 && (
            <div className="owner-report-section amber-banner owner-report-missing" role="note">
              <p>
                <strong>△ Not in this report:</strong> {sectionList(failedKeys)} could not be worked out when it was made, so
                {failedKeys.length === 1 ? ' its figures are' : ' their figures are'} missing here, not zero.
                {' '}Regenerate Snapshot makes the report again from the data as it is today.
              </p>
              {(isAdmin || isOwner) && (
                <button className="btn btn-ghost btn-sm" onClick={() => setConfirmRegenerate(true)} disabled={regenerating}>
                  Regenerate Snapshot
                </button>
              )}
            </div>
          )}

            {/* Executive Summary — the one narrative paragraph in the report; everything below
                this point is pure data tables, per the hybrid format chosen for this report. */}
            {execSummary && (
              <div className="owner-report-section">
                <h3 className="owner-report-section-title">Executive Summary</h3>
                <p style={{ fontSize: 13, lineHeight: 1.55, color: 'var(--theme-text1)', margin: 0 }}>{execSummary}</p>
              </div>
            )}

            {/* Financial Summary — Metric / This month / Last month / Target, the "KPI, actual,
                target" shape a real restaurant management report uses, not a KPI-tile dashboard.
                Last month sits beside this month since S857 (it was only in Trend, at the back). */}
            <div className="owner-report-section">
              <h3 className="owner-report-section-title">Financial Summary</h3>
              <div className="table-wrap">
                <table className="data-table owner-report-table">
                  <thead><tr>
                    <th>Metric</th>
                    <th style={{ textAlign: 'right' }}>This month<span style={subStyle}>{periodLabel}</span></th>
                    <th style={{ textAlign: 'right' }}>
                      {lm?.available ? 'Last month' : <Tip text={lm?.why || ''} width={260}>Last month</Tip>}
                      {lm?.label && <span style={subStyle}>{lm.label}</span>}
                    </th>
                    <th style={{ textAlign: 'right' }}>Target</th>
                  </tr></thead>
                  <tbody>
                    <tr>
                      <td>Revenue</td>
                      <td style={{ textAlign: 'right', fontWeight: 700 }}>{fmt(snapshot.combined?.revenueTotal)}</td>
                      <LastMonthCell cell={lm?.rows.revenue} show={fmt} />
                      <td style={{ textAlign: 'right', color: 'var(--theme-text3)' }}>—</td>
                    </tr>
                    {snapshot.ims && (
                      <tr>
                        <td>
                          <Tip
                            text={cogsBasis
                              ? `Food used (COGS) ÷ revenue × 100, as on Monthly Summary. Food used = ${COGS_FORMULA}.`
                              : 'Net purchases ÷ revenue × 100, the older rule this report was made under. Newer reports use food used (COGS), as Monthly Summary does.'}
                            width={280}
                          >
                            {cogsBasis ? 'Food Cost %' : 'Food Cost % (on purchases)'}
                          </Tip>
                        </td>
                        <td style={{ textAlign: 'right', fontWeight: 700, color: fcCellOf(snapshot.combined?.foodCostPct).color }} title={fcCellOf(snapshot.combined?.foodCostPct).title}>
                          {pct(snapshot.combined?.foodCostPct)} {fcCellOf(snapshot.combined?.foodCostPct).mark}
                          {fcNotPositive && <span style={subStyle}>not judged: a count or a bill is missing</span>}
                        </td>
                        <LastMonthCell cell={lm?.rows.foodCost} show={pct} />
                        {/* The client's own target (OWNER-REPORT-5): frozen with a v18 report, today's
                            Settings for an older one. It printed a fixed "28–35%". */}
                        <td style={{ textAlign: 'right', color: 'var(--theme-text3)' }}>
                          <Tip text={fcFrozen
                            ? `Your Food Cost target when this report was made: up to ${fcT.warn}% is on target, above ${fcT.critical}% is critical. Saved with the report, so changing Settings later does not re-judge it.`
                            : `Your Food Cost target in Settings today (up to ${fcT.warn}%, critical above ${fcT.critical}%). This report was made before the thresholds were saved with it.`} width={260}>
                            ≤ {fcT.warn}%
                          </Tip>
                        </td>
                      </tr>
                    )}
                    {/* Labour, Prime and Net Margin come from the one labour rule since v18
                        (combined.labour; GAPS-4, OWNER-REPORT-9): payroll or the HR estimate with Crest
                        HR, the Overheads Labor tab without it. An older report renders from its HR
                        section, and has none of the three without Crest HR. */}
                    {labourShown && (
                      <tr>
                        <td><Tip text={laborTip} width={280}>Labor Cost %</Tip></td>
                        <td style={{ textAlign: 'right', fontWeight: 700, color: lcBandOf(snapshot.combined?.laborCostPct).color }} title={lcBandOf(snapshot.combined?.laborCostPct).title}>
                          {pct(snapshot.combined?.laborCostPct)} {lcBandOf(snapshot.combined?.laborCostPct).mark}
                          {lab?.source === 'none' && <span style={subStyle}>no labour entered on Overheads</span>}
                          {labourSub && <span style={subStyle}>{labourSub}</span>}
                          {labourNotJudgedSub && <span style={subStyle}>{labourNotJudgedSub}</span>}
                        </td>
                        <LastMonthCell cell={lm?.rows.labour} show={pct} />
                        <td style={{ textAlign: 'right', color: 'var(--theme-text3)' }}>25–30%</td>
                      </tr>
                    )}
                    {snapshot.ims && labourShown && (
                      <tr>
                        <td><Tip text="Food Cost % + Labor Cost % — the number operators benchmark against." width={240}>Prime Cost %</Tip></td>
                        <td style={{ textAlign: 'right', fontWeight: 700, color: pcCellOf(snapshot.combined?.primeCostPct).color }} title={pcCellOf(snapshot.combined?.primeCostPct).title}>
                          {pct(snapshot.combined?.primeCostPct)} {pcCellOf(snapshot.combined?.primeCostPct).mark}
                          {snapshot.combined?.primeCostPct != null && labourSub && <span style={subStyle}>{labourSub}</span>}
                        </td>
                        <LastMonthCell cell={lm?.rows.prime} show={pct} />
                        <td style={{ textAlign: 'right', color: 'var(--theme-text3)' }}>≤60–65%</td>
                      </tr>
                    )}
                    {snapshot.ims && labourShown && (
                      <tr>
                        <td><Tip text={netMarginTip} width={280}>Net Margin %</Tip></td>
                        {/* A frozen Net Margin is shown whenever the report holds one; without the
                            Overheads feature only its verdict is withheld (OWNER-REPORT-11, DOCS-M6).
                            It said "Requires Overheads (Pro)", and Overheads is not a Pro feature. */}
                        <td style={{ textAlign: 'right', fontWeight: 700, color: nmCellOf(snapshot.combined?.netMarginPct).color }} title={nmCellOf(snapshot.combined?.netMarginPct).title}>
                          {snapshot.combined?.netMarginPct == null && !canOverheads
                            ? `Requires Overheads (${overheadsTier})`
                            : <>{pct(snapshot.combined?.netMarginPct)} {nmCellOf(snapshot.combined?.netMarginPct).mark}</>}
                          {snapshot.combined?.netMarginPct != null && <>
                            {lab?.source === 'none' && <span style={subStyle}>no labour entered on Overheads</span>}
                            {labourSub && <span style={subStyle}>{labourSub}</span>}
                            {!canOverheads && <span style={subStyle}>no verdict: Overheads ({overheadsTier}) is not on this plan</span>}
                          </>}
                          {snapshot.combined?.netMarginPct == null && snapshot.sectionErrors?.deliveryCommission && (
                            <span style={subStyle}>delivery commission could not be read</span>
                          )}
                        </td>
                        <LastMonthCell cell={lm?.rows.netMargin} show={pct} />
                        <td style={{ textAlign: 'right', color: 'var(--theme-text3)' }}>≥20%</td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
              {/* S857: a Tip does not print, so a dash left by a change of method is said once on paper. */}
              {lm?.available && [
                lm.rows.revenue,
                snapshot.ims && lm.rows.foodCost,
                labourShown && lm.rows.labour,
                snapshot.ims && labourShown && lm.rows.prime,
                snapshot.ims && labourShown && lm.rows.netMargin,
              ].some(c => c?.changed) && (
                <p style={noteStyle}>
                  Last month shows — where Crest changed how a figure is worked out between the two months. The Trend section says which.
                </p>
              )}
              {/* v18 (SU11): the Labor tab is never a second labour figure beside Crest HR. Named, printed. */}
              {lab?.laborTabNotCounted > 0 && (
                <p style={noteStyle}>
                  Overheads Labor tab {fmt(lab.laborTabNotCounted)} not counted: {lab.source === 'payroll' ? 'payroll' : 'Crest HR'} is this month's labour.
                </p>
              )}
              {lab?.reason === 'nopay' && (
                <p style={warnNoteStyle}>
                  △ Pay is not set for {num(lab.noPayCount)} staff on payroll, so their wages are not in labour, and Labor Cost, Prime Cost and Net Margin are shown without a verdict. Set their pay in Pay Setup, then Regenerate Snapshot.
                </p>
              )}
              {lab?.reason === 'nostaff' && (
                <p style={warnNoteStyle}>
                  △ Nobody was on payroll in Crest HR this month, so labour is not judged.
                </p>
              )}
              {/* The count COGS rests on, frozen with it (v9). Printed, not a hover: it qualifies
                  the three figures above on paper too. */}
              {snapshot.ims && cogsBasis && countGap?.uncountedCount > 0 && (
                <p style={{ fontSize: 12, color: 'var(--theme-amber-text)', margin: '8px 0 0', lineHeight: 1.5 }}>
                  △ {gapHeadline(countGap, periodLabel)}.
                  {verdictWithheld && ' Food Cost, Prime Cost and Net Margin are shown without a verdict until the count is complete.'}
                  {countGap.names?.length > 0 && ` Not counted: ${countGap.names.join(', ')}${countGap.uncountedCount > countGap.names.length ? ` and ${countGap.uncountedCount - countGap.names.length} more` : ''}.`}
                </p>
              )}
            </div>

            {snapshot.ims && (
              <div className="owner-report-section">
                <h3 className="owner-report-section-title">Crest IMS</h3>
                <div className="table-wrap">
                  <table className="data-table owner-report-table"><tbody>
                    <Row label="Opening Stock" value={fmt(snapshot.ims.openingStockValueTotal)}
                      tip="Value of stock on hand at the start of the period (qty × per-unit rate), carried forward from last period's closing count." />
                    <Row label="Purchases" value={fmt(snapshot.ims.purchaseTotal)}
                      tip={snapshot.ims.transferIn != null
                        ? 'Net purchases: bills less their discounts and supplier returns, plus stock received from your other outlets and less stock sent to them — as Monthly Summary counts them.'
                        : undefined} />
                    {/* v18 (PNL-8): stock moved between outlets, inside Purchases above. Shown only when there was any. */}
                    {(snapshot.ims.transferIn > 0 || snapshot.ims.transferOut > 0) && (
                      <Row label="Stock transfers in / out" value={`${fmt(snapshot.ims.transferIn)} / ${fmt(snapshot.ims.transferOut)}`}
                        tip="Stock received from and sent to your other outlets, at the sending outlet rate. Both are inside Purchases above, and neither is in Cash or Credit Purchases." />
                    )}
                    {/* What the figure counts depends on when it was frozen (S792, FIGURES-5): from v10
                        it is the Wastage Report's own total; before, active items only. */}
                    {/* Ink, not red above 0 (S852): wastage has no band, and any waste at all is not a
                        verdict. The Owner Dashboard shows the same figure in ink. */}
                    <Row label="Wastage Value" value={fmt(snapshot.ims.wastageValueTotal)}
                      tip={schemaVersion >= 10
                        ? 'Everything logged as waste this period, valued at each item\'s rate: raw items, prep (sub-recipes) and hidden items alike — the same total as the Wastage Report.'
                        : 'Waste logged this period on items that were active when this report was made (prep included), valued at each item\'s rate. Newer reports count hidden items too, as the Wastage Report does.'} />
                    {/* v9 (S792): the two figures Food Cost % is now built from. Absent on an older
                        snapshot, which froze no COGS — never rendered as NPR 0 there. */}
                    {snapshot.ims.staffMealsValueTotal != null && (
                      <Row label="Staff Meals" value={fmt(snapshot.ims.staffMealsValueTotal)}
                        tip={pnlCostsInNet(snapshot)
                          ? 'Food logged as staff meals, at each item rate. It is kept out of Food Used (COGS), and Net Margin takes it off as a cost, as Consolidated P&L does.'
                          : 'Food logged as staff meals, at each item rate, kept out of Food Used (COGS). This report was made before Net Margin took it off as a cost.'} />
                    )}
                    <Row label="Closing Stock" value={fmt(snapshot.ims.closingStockValueTotal)}
                      tip="Value of stock physically counted at period close (qty × per-unit rate) — becomes next period's Opening Stock." />
                    {snapshot.ims.cogsTotal != null && (
                      <Row label="Food Used (COGS)" value={fmt(snapshot.ims.cogsTotal)}
                        tip={`${COGS_FORMULA}, as on Monthly Summary. Prep (sub-recipes) is left out, so the rows above add up to it exactly only when no prep was counted.`} />
                    )}
                    <Row label="Cash Purchases" value={fmt(snapshot.ims.cashNet)} />
                    <Row label="Credit Purchases" value={fmt(snapshot.ims.creditNet)} />
                    {/* Strictly below since v4 (S696): an item exactly at par has what you want. */}
                    <Row label="Items Below Par (at close)" value={num(snapshot.ims.reorder?.count)}
                      tip={schemaVersion >= 4
                        ? 'Items whose stock at period close was below their par level — an item exactly at par is fine.'
                        : 'Items whose stock at period close was at or below par level (this report predates the rule that an item exactly at par is fine).'} />
                    {/* v18 (OWNER-REPORT-8): what is still owed per bill, as Outstanding Payables values it. */}
                    <Row label="Unpaid Credit (this period)" value={fmt(snapshot.ims.payables?.unpaidTotal)}
                      tip={snapshot.ims.payables?.basis === 'owed'
                        ? `Still owed on the credit bills of this month when the report was made (${num(snapshot.ims.payables?.unpaidCount)} bill${snapshot.ims.payables?.unpaidCount === 1 ? '' : 's'}), with VAT, discounts and returns counted. It does not change later.`
                        : 'Credit purchases of this month still unpaid when the report was made, at quantity × rate before VAT, discounts and returns (an older rule).'} />
                    {/* v12 (S798 2e): the two non-labour cost lines Net Margin subtracts, so the margin
                        can be traced. Absent on an older snapshot, which froze no Tax & Fees. */}
                    {canOverheads && snapshot.ims.taxFeesTotal != null && <>
                      <Row label="Overheads" value={fmt(snapshot.ims.overheadTotal)}
                        tip={hrInReport
                          ? "The Overheads page's fixed costs for the month (rent, utilities and the like). The Labor tab is not here: labour is payroll, in the Crest HR section."
                          : "The Overheads page's fixed costs for the month (rent, utilities and the like). The Labor tab is not here: without Crest HR, labour comes from the Labor tab, shown under Labor Cost %."} />
                      <Row label="Tax & Fees" value={fmt(snapshot.ims.taxFeesTotal)}
                        tip="The Overheads page's Tax & Fees tab for the month: card and bank fees, the accountant, licences and permits. Net Margin subtracts it, as Consolidated P&L does." />
                    </>}
                    {/* v18 (S849, GAPS-1 / PNL-1): the other costs Net Margin takes off, so it can be
                        traced. Absent on an older report, which did not subtract them. */}
                    {snapshot.ims.cogsWastageTotal != null && (
                      <Row label="Stock wasted (raw items)" value={fmt(snapshot.ims.cogsWastageTotal)}
                        tip="The raw-ingredient part of Wastage Value, which Net Margin takes off as a cost. Wasted prep is left out: its raw items are already in Food Used." />
                    )}
                    {dc && (
                      <Row label="Delivery commission" value={fmt(dc.amount)}
                        tip="What delivery partners such as Foodmandu or Pathao kept from bills sold this month. Net Margin takes it off; a bill not settled when the report was made has none in it." />
                    )}
                  </tbody></table>
                </div>
                {dc?.unsettledBills > 0 && (
                  <p style={warnNoteStyle}>
                    △ {num(dc.unsettledBills)} delivery bill{dc.unsettledBills === 1 ? '' : 's'} from {periodLabel} {dc.unsettledBills === 1 ? 'was' : 'were'} not settled with the partner when this report was made, so {dc.unsettledBills === 1 ? 'its' : 'their'} commission is not in Net Margin. Regenerate Snapshot after {dc.unsettledBills === 1 ? 'it is' : 'they are'} settled.
                  </p>
                )}
              </div>
            )}

            {snapshot.hr && (
              <div className="owner-report-section">
                <h3 className="owner-report-section-title">
                  Crest HR
                  {snapshot.hr.payrollSource && (
                    <span style={{ fontWeight: 500, textTransform: 'none', letterSpacing: 'normal', color: 'var(--theme-text3)', marginLeft: 8 }}>
                      {snapshot.hr.payrollSource === 'finalized' ? '· from finalized Payroll Run' : '· estimated — no payroll finalized for this period'}
                    </span>
                  )}
                </h3>
                <div className="table-wrap" style={{ marginBottom: snapshot.hr.leave?.length > 0 || snapshot.hr.headcount?.noEndDate > 0 ? 8 : 0 }}>
                  <table className="data-table owner-report-table"><tbody>
                    <Row label="Gross Payroll" value={fmt(snapshot.hr.payroll?.gross)} />
                    {/* v13 (S798 3c, H19): what was earned — the payroll sheet's Cost to business.
                        An estimate has no unpaid-day figure (null), so the row is not shown. */}
                    {snapshot.hr.payroll?.absenceDeduction != null && (
                      <Row label="Less unpaid days" value={`− ${fmt(snapshot.hr.payroll.absenceDeduction)}`}
                        tip="Days the payroll did not pay: unpaid leave, absent days, and days before joining or after leaving. Taken off so labour is what was earned." />
                    )}
                    <Row label="Overtime" value={`${num(snapshot.hr.payroll?.ot?.hours)} hrs — ${fmt(snapshot.hr.payroll?.ot?.amount)}`} />
                    <Row label="Employer SSF" value={fmt(snapshot.hr.payroll?.ssfEmployer)}
                      tip="What the business pays into the Social Security Fund for staff enrolled in it, on top of their pay. It counts as labour." />
                    {/* v13 (H18): pay finalized outside the monthly run, in the month it was paid. */}
                    {snapshot.hr.payroll?.other?.festival > 0 && (
                      <Row label={snapshot.hr.payroll.other.festivalName ? `${snapshot.hr.payroll.other.festivalName} Allowance` : 'Festival Allowance'}
                        value={fmt(snapshot.hr.payroll.other.festival)}
                        tip="Festival allowance finalized for this month on the Festival Allowance page, counted in full in the month it is paid." />
                    )}
                    {snapshot.hr.payroll?.other?.incentive > 0 && (
                      <Row label="Incentives" value={fmt(snapshot.hr.payroll.other.incentive)} tip="Incentive runs finalized for this month." />
                    )}
                    {snapshot.hr.payroll?.other?.settlement > 0 && (
                      <Row label="Leavers' Final Pay" value={fmt(snapshot.hr.payroll.other.settlement)}
                        tip="Final Settlements finalized this month: the last part-month of pay, leave encashment, gratuity and the rest. Travel claims are not counted." />
                    )}
                    <Row label={earnedLabour(snapshot) ? 'Total Labour Cost' : 'Total Payroll Cost'} value={fmt(snapshot.hr.payroll?.total)}
                      tip={earnedLabour(snapshot)
                        ? 'Pay earned, overtime and employer SSF, plus festival, incentive and final-settlement pay finalized this month. Labor Cost % is this divided by revenue.'
                        : 'Gross pay, overtime and employer SSF (an older rule). Unpaid days are not taken off, and festival, incentive and final-settlement pay are not counted.'} />
                    {/* v18 (OWNER-REPORT-7): employed at any time in the month, by join and End
                        Dates — not by today's status, which counted nobody who had left since. */}
                    {snapshot.hr.headcount?.basis === 'dates'
                      ? <Row label="Staff Employed" value={num(snapshot.hr.headcount.employed)}
                          tip="Everyone employed at any time in the month, joiners and leavers included, by their join and End Dates." />
                      : <Row label="Active Headcount" value={num(snapshot.hr.headcount?.active)}
                          tip="Staff active or on probation when the report was made (an older rule), so someone who left after the month is not counted." />}
                    <Row label="New Hires / Terminations" value={`${num(snapshot.hr.headcount?.newHires)} / ${num(snapshot.hr.headcount?.terminations)}`} />
                    {/* v18 (OWNER-REPORT-13): over the days staff were due to work. */}
                    <Row label="Attendance Rate" value={snapshot.hr.attendance?.rate != null ? pct(snapshot.hr.attendance.rate) : 'N/A'}
                      tip={snapshot.hr.attendance?.basis === 'working_days'
                        ? 'Days present ÷ days staff were due to work (weekly offs and holidays left out); paid leave counts as present. Useful only with the daily Attendance Sheet.'
                        : 'An older rule that counts weekly offs and holidays as days to work, so it reads low. Useful only with the daily Attendance Sheet.'} />
                  </tbody></table>
                </div>
                {snapshot.hr.headcount?.noEndDate > 0 && (
                  <p style={{ ...warnNoteStyle, margin: '0 0 8px' }}>
                    △ {num(snapshot.hr.headcount.noEndDate)} former staff {snapshot.hr.headcount.noEndDate === 1 ? 'has' : 'have'} no End Date, so {snapshot.hr.headcount.noEndDate === 1 ? 'is' : 'are'} not counted. Enter their last working day in Employees, then Regenerate Snapshot.
                  </p>
                )}
                {snapshot.hr.leave?.length > 0 && (
                  <div className="table-wrap">
                    <table className="data-table owner-report-table">
                      {/* v18 (OWNER-REPORT-14): a leave crossing a month edge counts only its days here. */}
                      <thead><tr><th>Leave Type</th><th style={{ textAlign: 'right' }}>Requests</th><th style={{ textAlign: 'right' }}>
                        {snapshot.hr.leaveBasis === 'in_month'
                          ? <Tip text="Approved leave days falling in this month. A leave that crosses into the month before or after is shared out by calendar days, so each month counts only its own part." width={260}>Days in this month</Tip>
                          : <Tip text="Each approved leave touching this month, counted in full — the rule this report was made under, so a leave crossing a month edge is in both months." width={260}>Days (whole requests)</Tip>}
                      </th></tr></thead>
                      <tbody>
                        {snapshot.hr.leave.map((l, i) => (
                          <tr key={i}><td>{l.leaveTypeName}</td><td style={{ textAlign: 'right' }}>{l.requestCount}</td><td style={{ textAlign: 'right' }}>{l.days}</td></tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            )}

            {snapshot.pos && (
              <div className="owner-report-section">
                <h3 className="owner-report-section-title">Crest POS</h3>
                <div className="table-wrap" style={{ marginBottom: 8 }}>
                  <table className="data-table owner-report-table"><tbody>
                    <Row label="Net Sales" value={fmt(snapshot.pos.totalNetSales)}
                      tip="From the Bill Register. It will not match Revenue above exactly: Revenue comes from Sales Entries, rounded differently on discount and VAT." />
                    <Row label="Bills / Qty Sold" value={`${num(snapshot.pos.billCount)} / ${num(snapshot.pos.totalQty)}`} />
                    {/* v15 (S809 3m): the credit notes Net Sales is after. Absent on an older report. */}
                    {snapshot.pos.creditNotes?.count > 0 && (
                      <Row label="Credit Notes" value={`${num(snapshot.pos.creditNotes.count)} — ${fmt(snapshot.pos.creditNotes.net)}`}
                        tip="Credit notes issued this month, taken off Net Sales in the month they were issued. The bill each one cancels still counts in the month it was sold, as on the Sales Report." />
                    )}
                    <Row label="Discount Given" value={fmt(snapshot.pos.totalDiscount)} />
                    {/* v16 (S814 4d, owner decision D1): the potential value is menu price before VAT.
                        An older report keeps the figure it was frozen with, VAT included, and says so. */}
                    <Row label="Comped Bills"
                      value={`${num(snapshot.pos.compedBillsTotal?.count)} — ${fmt(snapshot.pos.compedBillsTotal?.potentialValue)} potential value${compExVat ? ', before VAT' : ', incl. VAT'}`}
                      tip={compExVat
                        ? 'Bills and dishes given free (staff meals, goodwill, promotions). Potential value is their menu price before VAT, as on Sales Exceptions.'
                        : 'Bills and dishes given free (staff meals, goodwill, promotions). Potential value here is the full price with VAT, an older rule; newer reports show it before VAT.'} />
                    <Row label="Voids / Write-offs" value={`${num(snapshot.pos.voidsWriteoffsTotal?.count)} — ${fmt(snapshot.pos.voidsWriteoffsTotal?.amount)}`}
                      color={snapshot.pos.voidsWriteoffsTotal?.count > 0 ? 'var(--theme-red-text)' : undefined}
                      tip="Void = cancelled before payment (e.g. a wrong order). Write-off = billed but never collected. Both are lost potential revenue." />
                    {/* v15 (S809 3m, owner decision 2026-10-10): covers are guests seated at tables. An
                        older report keeps its own count and its own tip, with the note below. */}
                    {posSeated && (
                      <Row label="Guests Seated" value={num(snapshot.pos.covers.totalCovers)}
                        tip="Guests seated at tables this month, as on the Covers Report. Takeaway and delivery are not counted; a bill later cancelled by a credit note still is." />
                    )}
                    <Row label="Avg Check / Cover" value={fmt(snapshot.pos.covers?.avgCheckPerCover)}
                      tip={posSeated
                        ? 'Average spend per seated guest: dine-in Net Sales (after any credit notes on dine-in bills) ÷ guests seated. Takeaway and delivery are left out of both, as on the Covers Report.'
                        : "Average spend per guest ('cover' = one seated diner), not per bill — a table of 4 sharing one bill counts as 4 covers."} />
                    <Row label="Avg Bill Value" value={fmt(snapshot.pos.covers?.avgBillValue)}
                      tip="Net Sales ÷ Bills: the average paid bill, takeaway and delivery included. It is per bill; Avg Check / Cover is per guest." />
                  </tbody></table>
                </div>
                {!posSeated && (
                  <p style={{ fontSize: 11, color: 'var(--theme-text3)', margin: '0 0 8px' }}>
                    This report was made before Crest changed how the till section counts. Its covers include
                    one for each takeaway and delivery bill, and a bill later cancelled by a credit note is left
                    out of the month altogether. Reports made since count only guests seated at tables, and
                    keep a cancelled bill in the month it was sold, taking its credit note off in the month it
                    was issued.
                  </p>
                )}

                {snapshot.pos.categoryBreakdown?.length > 0 && (
                  <div className="table-wrap" style={{ marginBottom: 8 }}>
                    <table className="data-table owner-report-table">
                      <thead><tr><th>Category</th><th style={{ textAlign: 'right' }}>Qty</th><th style={{ textAlign: 'right' }}>Net Sales</th></tr></thead>
                      <tbody>
                        {snapshot.pos.categoryBreakdown.map((c, i) => (
                          <tr key={i}><td>{c.category}</td><td style={{ textAlign: 'right' }}>{num(c.qty)}</td><td style={{ textAlign: 'right' }}>{fmt(c.net)}</td></tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}

                {snapshot.pos.paymentMix?.length > 0 && (
                  <div className="table-wrap">
                    <table className="data-table owner-report-table">
                      <thead><tr><th>Payment Method</th><th style={{ textAlign: 'right' }}>Net Sales</th><th style={{ textAlign: 'right' }}>% of Net</th></tr></thead>
                      <tbody>
                        {snapshot.pos.paymentMix.map((p, i) => (
                          <tr key={i}><td>{p.method}</td><td style={{ textAlign: 'right' }}>{fmt(p.net)}</td><td style={{ textAlign: 'right' }}>{pct(p.pctOfNet)}</td></tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            )}

            {snapshot.menuEngineering && (() => {
              const me = snapshot.menuEngineering
              // A quadrant is a category, so it takes no signal colour (S852): the name and the
              // Meaning column carry it. Green Star and red Dog read as good and bad dishes, and
              // amber Puzzle as a warning, which none of them is on its own.
              const quadrantStyle = { color: 'var(--theme-text1)', fontWeight: 700 }
              return (
                <div className="owner-report-section owner-report-page-break">
                  <h3 className="owner-report-section-title">Menu Engineering Matrix</h3>
                  <p style={{ fontSize: 11, color: 'var(--theme-text3)', margin: '0 0 8px' }}>
                    Classified by Food Cost % (≤{me.fcCutoffPct}% = high profit) × Qty Sold vs. the period's median ({num(me.medianQty)}).
                  </p>
                  <div className="table-wrap" style={{ marginBottom: 8 }}>
                    <table className="data-table owner-report-table">
                      <thead><tr><th>Quadrant</th><th style={{ textAlign: 'right' }}>Items</th><th>Meaning</th></tr></thead>
                      <tbody>
                        <tr><td style={quadrantStyle}>Star</td><td style={{ textAlign: 'right' }}>{me.quadrantCounts.Star}</td><td style={{ color: 'var(--theme-text3)' }}>High profit, high popularity — feature these</td></tr>
                        {/* Descriptions match this app's own classify() condition (mirrored verbatim from
                            MenuEngineering.js), not the traditional restaurant-industry meaning of these two
                            words — this app's "Plowhorse"/"Puzzle" mapping is swapped from convention (see
                            MenuEngineering.js's own quadrants, same swap). Found live 2026-07-28: these two
                            rows previously had the traditional-meaning text, which was backwards advice
                            against what quadrantCounts actually counts. */}
                        <tr><td style={quadrantStyle}>Plowhorse</td><td style={{ textAlign: 'right' }}>{me.quadrantCounts.Plowhorse}</td><td style={{ color: 'var(--theme-text3)' }}>Profitable, underselling — promote/reposition</td></tr>
                        <tr><td style={quadrantStyle}>Puzzle</td><td style={{ textAlign: 'right' }}>{me.quadrantCounts.Puzzle}</td><td style={{ color: 'var(--theme-text3)' }}>Popular, low profit — consider reprice/portion</td></tr>
                        <tr><td style={quadrantStyle}>Dog</td><td style={{ textAlign: 'right' }}>{me.quadrantCounts.Dog}</td><td style={{ color: 'var(--theme-text3)' }}>Low profit, low popularity — consider cutting</td></tr>
                        {/* Not a quadrant — the dishes with no selling price or no costed
                            ingredients, which have no food cost to be judged on (S715, schema v5).
                            Guarded because a snapshot frozen before v5 has no such key, and an
                            absent count must not render as a real 0. */}
                        {me.quadrantCounts.Unrated > 0 && (
                          <tr><td style={{ color: 'var(--theme-text2)', fontWeight: 700 }}>Not rated</td><td style={{ textAlign: 'right' }}>{me.quadrantCounts.Unrated}</td><td style={{ color: 'var(--theme-text3)' }}>{me.byoCount > 0 ? 'No selling price, no costed ingredients, or build-your-own (costed by build) — nothing to judge' : 'No selling price or no costed ingredients — nothing to judge'}</td></tr>
                        )}
                      </tbody>
                    </table>
                  </div>
                  {/* S792 (RECIPES-1, v9): named, so "not rated" is not read as "forgotten". A
                      snapshot from before has no byoItems and rated these dishes on their fixed cost. */}
                  {me.byoItems?.length > 0 && (
                    <p style={{ fontSize: 12, color: 'var(--theme-text2)', margin: '0 0 8px', lineHeight: 1.5 }}>
                      <strong>Build-your-own, not rated — costed by build:</strong> {me.byoItems.map(i => i.name).join(', ')}.
                      {' '}Each recipe holds only the fixed part (the bowl, the spoon), so one food-cost figure would be near zero; the real cost depends on what each guest picks. Recipe Costing shows the range.
                    </p>
                  )}
                  {me.dogs?.length > 0 && (
                    <div className="table-wrap">
                      <table className="data-table owner-report-table">
                        <thead><tr><th>Dogs (lowest contribution)</th><th style={{ textAlign: 'right' }}>Qty Sold</th><th style={{ textAlign: 'right' }}>Food Cost %</th><th style={{ textAlign: 'right' }}>
                          <Tip text="Selling price less ingredient cost, times the number sold: what the dish added towards your other costs and profit." width={260}>Total Contribution</Tip>
                        </th></tr></thead>
                        <tbody>
                          {me.dogs.map(i => (
                            <tr key={i.recipeId}><td>{i.name}</td><td style={{ textAlign: 'right' }}>{num(i.qtySold)}</td><td style={{ textAlign: 'right' }}>{pct(i.fcPct)}</td><td style={{ textAlign: 'right' }}>{fmt(i.totalContribution)}</td></tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              )
            })()}

            {snapshot.laborAnalytics && (
              <div className="owner-report-section">
                <h3 className="owner-report-section-title">Labor Analytics</h3>
                <div className="table-wrap">
                  <table className="data-table owner-report-table"><tbody>
                    <Row label="Actual Hours Worked" value={`${num(snapshot.laborAnalytics.actualHoursWorked)} hrs`}
                      tip="Hours entered in Attendance this month: typed or clocked times, Generate from Roster, or a machine import. A day marked Present with no times adds nothing here." />
                    {/* v12 (S798 2e, LABOUR-FIGURES-7 / H31): how many worked days carry hours, always
                        printed, so the hour figures can be judged. Absent on an older snapshot. */}
                    {snapshot.laborAnalytics.workingDays != null && (
                      <Row label="Days without clock times" value={`${num(snapshot.laborAnalytics.workingDaysWithoutHours)} of ${num(snapshot.laborAnalytics.workingDays)} worked days`}
                        color={snapshot.laborAnalytics.hoursWithheld ? 'var(--theme-amber-text)' : undefined}
                        tip="Days marked Present or half day with no start and end time, so they add no hours. If more than half are like this, Schedule Variance and Sales per Labor Hour are not shown." />
                    )}
                    <Row label="Scheduled Hours (Roster)" value={`${num(snapshot.laborAnalytics.scheduledHours)} hrs`} />
                    <Row label="Schedule Variance" value={snapshot.laborAnalytics.hoursWithheld ? 'Hours not recorded'
                      : `${snapshot.laborAnalytics.scheduleVarianceHours >= 0 ? '+' : ''}${num(snapshot.laborAnalytics.scheduleVarianceHours)} hrs${snapshot.laborAnalytics.scheduleVariancePct != null ? ` (${snapshot.laborAnalytics.scheduleVariancePct.toFixed(1)}%)` : ''}`}
                      tip="Actual hours worked minus scheduled hours — positive means more was worked than rostered." />
                    <Row label="Sales per Labor Hour" value={snapshot.laborAnalytics.hoursWithheld ? 'Hours not recorded' : snapshot.laborAnalytics.salesPerLaborHour != null ? fmt(snapshot.laborAnalytics.salesPerLaborHour) : 'N/A'}
                      tip="Revenue ÷ actual hours worked — a productivity benchmark." />
                    {snapshot.laborAnalytics.overtime && (
                      <Row label="Overtime (reference)" value={`${num(snapshot.laborAnalytics.overtime.hours)} hrs — ${fmt(snapshot.laborAnalytics.overtime.amount)}`}
                        tip="Same figure shown in the Crest HR section above." />
                    )}
                  </tbody></table>
                </div>
              </div>
            )}

            {snapshot.inventoryDepth && (() => {
              const inv = snapshot.inventoryDepth
              return (
                <div className="owner-report-section owner-report-page-break">
                  <h3 className="owner-report-section-title">Inventory Depth</h3>

                  {inv.turnover && (
                    <div className="table-wrap" style={{ marginBottom: 8 }}>
                      <table className="data-table owner-report-table"><tbody>
                        {/* v18 (OWNER-REPORT-15): COGS over the stock of the same items. */}
                        <Row label="Inventory Turnover Ratio (this period)" value={inv.turnover.turnoverRatio != null ? inv.turnover.turnoverRatio.toFixed(2) : '—'}
                          tip={inv.turnover.basis === 'cogs'
                            ? 'Food used (COGS) ÷ average stock of the same items (prep left out, as in COGS). Higher means stock is moving faster.'
                            : 'Stock consumed (waste included) ÷ average inventory value this period — the rule this report was made under. Higher means stock is moving faster.'} />
                        <Row label="Days on Hand" value={inv.turnover.daysOnHand != null ? `${inv.turnover.daysOnHand.toFixed(1)} days` : '—'}
                          tip="How many days your average inventory would last at this period's usage rate. Lower means you're restocking more often." />
                        <Row label="Average Inventory Value" value={fmt(inv.turnover.avgInventoryValue)}
                          tip="Opening stock plus closing stock, divided by 2. Turnover and Days on Hand are worked out from it." />
                      </tbody></table>
                    </div>
                  )}

                  {/* OWNER-REPORT-1: a sub-section that failed says so where it would be, never vanishes. */}
                  {subFailed('deadSlowStock') && (
                    <p style={{ ...warnNoteStyle, margin: '0 0 8px' }}>△ {sectionLabel('deadSlowStock')}: could not be worked out when this report was made.</p>
                  )}
                  {inv.deadSlowStock && (() => {
                    const ds = inv.deadSlowStock
                    // S756 (D20): a v7+ section carries `rule: 'streak'` (Dead = 3 counted months with
                    // no use). A v1–v6 snapshot was frozen under the one-month rule and has none of
                    // the new fields — say which rule it used, and never render its missing
                    // streak/next-step as 0 or blank.
                    const streak = ds.rule === 'streak'
                    const deadAfter = ds.deadAfterMonths || 3
                    const stillText = i => (i.stillMonths > 0
                      ? `${i.stillMonths}${i.atLeast ? '+' : ''} month${i.stillMonths === 1 && !i.atLeast ? '' : 's'}`
                      : 'Moving slowly')
                    return (
                    <>
                      <p style={{ fontSize: 12, color: 'var(--theme-text2)', margin: '0 0 8px', lineHeight: 1.5 }}>
                        {streak
                          ? <>Dead = nothing used for {deadAfter} or more counted months in a row. Slow = nothing used for 1–2 months, or less than 20% of what was available used.
                            {/* v9 (S792, PLANNING-4). A v7/v8 section judged staff rice as unused. */}
                            {ds.movement === 'staff_meals_count' && ' Staff meals count as use; wastage does not.'}
                            {' '}A month without a stock count for an item is not judged and restarts the run.
                            {ds.historyMonths != null && ds.historyMonths < deadAfter && <> Only {ds.historyMonths} month{ds.historyMonths === 1 ? '' : 's'} of records existed at generation, so nothing could be called Dead yet.</>}</>
                          : <>This snapshot was generated under the earlier one-month rule (Dead = no use in this month alone). Regenerate Snapshot to apply the current rule: Dead = {deadAfter} counted months in a row with no use.</>}
                      </p>
                      {streak && (ds.uncountedCount > 0 || ds.inconsistentCount > 0) && (
                        <p style={{ fontSize: 12, color: 'var(--theme-amber-text)', margin: '0 0 8px', lineHeight: 1.5 }}>
                          △ {num(ds.assessedCount)} of {num(ds.assessedCount + ds.uncountedCount + ds.inconsistentCount)} items with stock could be judged
                          {ds.uncountedCount > 0 && <> — {num(ds.uncountedCount)} had no closing count this month</>}
                          {ds.inconsistentCount > 0 && <>{ds.uncountedCount > 0 ? ', and' : ' —'} {num(ds.inconsistentCount)} {ds.inconsistentCount === 1 ? 'was' : 'were'} counted higher than the stock available (usually a missing purchase bill)</>}.
                        </p>
                      )}
                      <div className="table-wrap" style={{ marginBottom: 8 }}>
                        <table className="data-table owner-report-table"><tbody>
                          <Row label="Dead Stock Items" value={num(ds.deadCount)} color={ds.deadCount > 0 ? 'var(--theme-red-text)' : undefined}
                            tip={streak ? `Nothing used for ${deadAfter} or more counted months in a row, ending with this period.` : 'Zero usage this period despite stock on hand (the one-month rule this snapshot was generated under).'} />
                          <Row label="Slow Stock Items" value={num(ds.slowCount)} color={ds.slowCount > 0 ? 'var(--theme-amber-text)' : undefined}
                            tip={streak ? 'Nothing used for one or two counted months, or less than 20% of available stock used this period.' : 'Used less than 20% of available stock this period.'} />
                          <Row label="Total Value at Risk" value={fmt(ds.totalValueAtRisk)} color={ds.totalValueAtRisk > 0 ? 'var(--theme-red-text)' : undefined}
                            tip="The closing stock of every Dead and Slow item, at its rate: money sitting on the shelf that is not being used." />
                        </tbody></table>
                      </div>
                      {ds.items?.length > 0 && (
                        <div className="table-wrap" style={{ marginBottom: 8 }}>
                          <table className="data-table owner-report-table">
                            <thead><tr>
                              <th>Dead/Slow Item</th><th style={{ textAlign: 'right' }}>Status</th>
                              {streak && <th>Still For</th>}
                              <th style={{ textAlign: 'right' }}><Tip text="This item closing stock, at its rate." width={220}>Value at Risk</Tip></th>
                              {streak && <th>Suggested Next Step</th>}
                            </tr></thead>
                            <tbody>
                              {ds.items.slice(0, 10).map(i => (
                                <tr key={i.itemId}>
                                  <td>{i.name}</td>
                                  <td style={{ textAlign: 'right', color: i.status === 'Dead' ? 'var(--theme-red-text)' : 'var(--theme-amber-text)' }}>{i.status}</td>
                                  {streak && <td style={{ whiteSpace: 'nowrap' }}>{stillText(i)}</td>}
                                  <td style={{ textAlign: 'right' }}>{fmt(i.valueAtRisk)}</td>
                                  {streak && <td style={{ fontSize: 12 }}>{i.suggestion || '—'}</td>}
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      )}
                    </>
                    )
                  })()}

                  {subFailed('variance') && (
                    <p style={{ ...warnNoteStyle, margin: '0 0 8px' }}>△ {sectionLabel('variance')}: could not be worked out when this report was made.</p>
                  )}
                  {inv.variance && (() => {
                    const v = inv.variance
                    // v9 (S792, FIGURES-2): the live Variance page's arithmetic, with the tolerance and
                    // NPR floor it was judged at frozen in. An older section was a fixed ±10% with no
                    // floor, counted uncounted items as 0 and summed sales raw — it keeps its figures
                    // and its old label.
                    const judgedAtTol = v.tolerancePct != null
                    const nothingJudged = judgedAtTol && !(v.judgedCount > 0)
                    const frozenSettings = { variance_flag_pct: v.tolerancePct }
                    const totalBand = judgedAtTol && !nothingJudged
                      ? varianceBand(v.totalTheoreticalValue > 0 ? (v.totalVarianceValue / v.totalTheoreticalValue) * 100 : null,
                        v.totalVarianceValue, frozenSettings, { measured: true, floorValue: v.floorValue })
                      : null
                    const flaggedRows = (v.items || []).filter(i => i.flag === 'over' || i.flag === 'under')
                    return (
                    <>
                      {judgedAtTol && (v.uncountedCount > 0 || v.noRecipeCount > 0) && (
                        <p style={{ fontSize: 12, color: 'var(--theme-amber-text)', margin: '0 0 8px', lineHeight: 1.5 }}>
                          △ Not judged:
                          {v.uncountedCount > 0 && <> {num(v.uncountedCount)} item{v.uncountedCount === 1 ? '' : 's'} with stock had no closing count</>}
                          {v.uncountedCount > 0 && v.noRecipeCount > 0 && ';'}
                          {v.noRecipeCount > 0 && <> {num(v.noRecipeCount)} {v.noRecipeCount === 1 ? 'is' : 'are'} in no recipe (gas, foil, napkins…), so nothing sold explains {v.noRecipeCount === 1 ? 'it' : 'them'}</>}.
                          {' '}Neither is in the flagged count or the total below.
                        </p>
                      )}
                      <div className="table-wrap" style={{ marginBottom: 8 }}>
                        <table className="data-table owner-report-table"><tbody>
                          <Row label={judgedAtTol ? `Items Flagged (Theoretical vs Actual, ±${v.tolerancePct}%)` : 'Items Flagged (Theoretical vs Actual, ±10%)'}
                            value={nothingJudged ? '—' : num(v.flaggedCount)}
                            tip={judgedAtTol
                              ? `Items whose use differed from recipes × sales by more than ±${v.tolerancePct}% (your tolerance when the report was made) and by at least NPR ${num(v.floorValue)}.${nothingJudged ? ' No item had a closing count, so nothing was judged.' : ''}`
                              : 'Items where actual usage differed from recipe-theoretical usage by more than 10% (the rule this report was generated under).'} />
                          <Row label="Total Variance Value"
                            value={nothingJudged ? '—' : `${fmt(v.totalVarianceValue)}${totalBand?.mark ? ` ${totalBand.mark}` : ''}`}
                            color={totalBand ? totalBand.color : (!judgedAtTol && Math.abs(v.totalVarianceValue) > 0 ? 'var(--theme-amber-text)' : undefined)}
                            tip={judgedAtTol ? 'Over counted, recipe-linked items only. Positive = more used than recipes explain.' : undefined} />
                        </tbody></table>
                      </div>
                      {flaggedRows.length > 0 && (
                        <div className="table-wrap" style={{ marginBottom: 8 }}>
                          <table className="data-table owner-report-table">
                            <thead><tr>
                              <th>Item</th><th style={{ textAlign: 'right' }}>Actual</th>
                              <th style={{ textAlign: 'right' }}><Tip text="What your recipes say the dishes sold should have used. Actual is what the stock counts show was used." width={260}>Theoretical</Tip></th>
                              <th style={{ textAlign: 'right' }}><Tip text="(Actual − Theoretical) ÷ Theoretical. ▲ means more was used than recipes explain, ▼ less." width={260}>Variance %</Tip></th>
                              <th style={{ textAlign: 'right' }}>Value</th>
                            </tr></thead>
                            <tbody>
                              {flaggedRows.slice(0, 10).map(i => (
                                <tr key={i.itemId}>
                                  <td>{i.name}</td><td style={{ textAlign: 'right' }}>{i.actualUsed.toFixed(1)}</td><td style={{ textAlign: 'right' }}>{i.theoreticalUsed.toFixed(1)}</td>
                                  {/* ▲/▼ as well as colour: the print block turns every cell black. A
                                      no-sales row (D36, v9) has no percentage, only the stock that went. */}
                                  <td style={{ textAlign: 'right', color: i.flag === 'over' ? 'var(--theme-red-text)' : 'var(--theme-amber-text)' }}>
                                    {i.variancePct == null ? 'no sales' : `${i.variancePct >= 0 ? '+' : ''}${i.variancePct.toFixed(1)}%`} {i.flag === 'over' ? '▲' : '▼'}
                                  </td>
                                  <td style={{ textAlign: 'right' }}>{fmt(i.value)}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      )}
                    </>
                    )
                  })()}

                  {inv.shrinkageTrend ? (() => {
                    const sh = inv.shrinkageTrend
                    const judgedAtTol = sh.tolerancePct != null   // v9 (S792); older: any positive variance
                    return (
                    <>
                      {judgedAtTol && sh.uncountedItems > 0 && (
                        <p style={{ fontSize: 12, color: 'var(--theme-amber-text)', margin: '0 0 8px', lineHeight: 1.5 }}>
                          △ {num(sh.uncountedItems)} item{sh.uncountedItems === 1 ? '' : 's'} had {num(sh.uncountedItemPeriods)} month{sh.uncountedItemPeriods === 1 ? '' : 's'} without a closing count in this window; those months are not judged.
                        </p>
                      )}
                      <div className="table-wrap">
                        <table className="data-table owner-report-table"><tbody>
                          <Row label={`Shrinkage Trend (${sh.periodsAnalyzed}-period window)`} value={`${num(sh.consistentCount)} consistent, ${num(sh.anyFlaggedCount)} flagged`}
                            tip={judgedAtTol
                              ? `Items used beyond what recipes × sales explain, over the closed months up to this one. Consistent means in two-thirds or more of the months that could be judged.`
                              : 'Items with unexplained over-consumption across multiple closed periods ending at this one — distinct from a single period\'s Variance above.'} />
                          <Row label="Total Shrinkage Loss Value" value={fmt(sh.totalLossValue)} color={sh.totalLossValue > 0 ? 'var(--theme-red-text)' : undefined}
                            tip="The value of the stock used beyond what recipes explain, added up for every flagged item over the months in this window." />
                        </tbody></table>
                      </div>
                    </>
                    )
                  })() : subFailed('shrinkageTrend') ? (
                    <p style={{ ...warnNoteStyle, margin: 0 }}>△ {sectionLabel('shrinkageTrend')}: could not be worked out when this report was made.</p>
                  ) : (
                    <p style={{ fontSize: 11, color: 'var(--theme-text3)', margin: 0 }}>Not enough closed period history yet for a shrinkage trend.</p>
                  )}
                </div>
              )
            })()}

            {snapshot.vendorPurchasing && (() => {
              const vp = snapshot.vendorPurchasing
              // v19 (S855, owner decision): Cash / Credit / FonePay split the Net Spend itself (after the
              // bill discount, before VAT), so each row adds up to its Net Spend and the Total row carries
              // the month's split. An older report split the list price; its note below says so and its
              // Total row keeps those cells blank, since they would not add up.
              const splitNet = vp.splitBasis === 'net'
              const alignRight = { textAlign: 'right' }
              return (
                <div className="owner-report-section">
                  <h3 className="owner-report-section-title">Vendor &amp; Purchasing</h3>
                  <div className="table-wrap" style={{ marginBottom: 8 }}>
                    <table className="data-table owner-report-table">
                      <thead><tr>
                        <th>Vendor</th>
                        <th style={alignRight}>
                          <Tip width={280} text={splitNet
                            ? 'What each supplier cost this month after discounts and returns, before VAT, as on the Vendor Report. Cash, Credit and FonePay add up to it.'
                            : 'What each supplier cost this month after discounts and returns, before VAT. Cash, Credit and FonePay here are before the discount, so they can add up to more.'}>
                            Net Spend
                          </Tip>
                        </th>
                        <th style={alignRight}>Cash</th><th style={alignRight}>Credit</th><th style={alignRight}>FonePay</th>
                      </tr></thead>
                      <tbody>
                        {vp.vendors.slice(0, 12).map(v => (
                          <tr key={v.vendorId}><td>{v.name}</td><td style={alignRight}>{fmt(v.net)}</td><td style={alignRight}>{fmt(v.cash)}</td><td style={alignRight}>{fmt(v.credit)}</td><td style={alignRight}>{fmt(v.fonepay)}</td></tr>
                        ))}
                        <tr>
                          <td style={{ fontWeight: 700 }}>
                            <Tip width={260} text="The whole month: every supplier, including any past the twelve listed here, and bills with no supplier recorded.">Total</Tip>
                          </td>
                          <td style={{ ...alignRight, fontWeight: 700 }}>{fmt(vp.grandNet)}</td>
                          {splitNet ? (
                            <>
                              <td style={{ ...alignRight, fontWeight: 700 }}>{fmt(vp.grandCash)}</td>
                              <td style={{ ...alignRight, fontWeight: 700 }}>{fmt(vp.grandCredit)}</td>
                              <td style={{ ...alignRight, fontWeight: 700 }}>{fmt(vp.grandFonepay)}</td>
                            </>
                          ) : <><td /><td /><td /></>}
                        </tr>
                      </tbody>
                    </table>
                  </div>
                  {!splitNet && (
                    <p style={{ fontSize: 11, color: 'var(--theme-text3)', margin: '0 0 8px' }}>
                      Cash, Credit and FonePay on this report are before the bill discount, the rule it was made
                      under, so for a supplier with a discount they add up to more than its Net Spend. Reports
                      made since split the Net Spend itself.
                    </p>
                  )}
                  <div className="table-wrap">
                    <table className="data-table owner-report-table"><tbody>
                      {/* v18 (OWNER-REPORT-8): each bill at what is still owed on it. VAT included, so
                          it can be more than the Credit column above (S855). */}
                      <Row label="Unpaid Credit — Current (≤30d)" value={fmt(vp.billAging.current)}
                        tip={vp.billAging.basis === 'owed'
                          ? 'Still owed on the credit bills of this month, by bill age when the report was made. It includes VAT and the Credit column does not, so it can be more than Credit.'
                          : 'This month\'s credit lines at quantity × rate less payments (before VAT, discounts and returns) — the rule this report was made under — by how old each bill was when it was made.'} />
                      <Row label="Unpaid Credit — 31–60 days" value={fmt(vp.billAging.d31_60)} color={vp.billAging.d31_60 > 0 ? 'var(--theme-amber-text)' : undefined} />
                      <Row label="Unpaid Credit — 61–90 days" value={fmt(vp.billAging.d61_90)} color={vp.billAging.d61_90 > 0 ? 'var(--theme-amber-text)' : undefined} />
                      <Row label="Unpaid Credit — 90+ days" value={fmt(vp.billAging.d90plus)} color={vp.billAging.d90plus > 0 ? 'var(--theme-red-text)' : undefined}
                        tip="Bill age from the purchase date, as it was when the report was made. Crest does not record supplier payment terms, so an old bill is not always a late one." />
                    </tbody></table>
                  </div>
                </div>
              )
            })()}

            {snapshot.trend && (
              <div className="owner-report-section owner-report-page-break">
                <h3 className="owner-report-section-title">Trend</h3>
                {['vsLastPeriod', 'vsSameMonthLastYear'].map(key => {
                  const t = snapshot.trend[key]
                  const label = key === 'vsLastPeriod' ? 'vs Last Period' : 'vs Same Month Last Year'
                  const priorLabel = t?.period ? `${BS_MONTHS[t.period.bs_month - 1]} ${t.period.bs_year}` : '—'
                  const d = t?.deltas || {}
                  // v18: labour, Prime and Net Margin can exist without Crest HR (the Labor tab), so a
                  // row shows when either month has its figure.
                  const has = k => snapshot.combined?.[k] != null || t?.snapshot?.combined?.[k] != null
                  const showLabour = !!snapshot.hr || has('laborCostPct')
                  const showPrime = !!snapshot.ims && (!!snapshot.hr || has('primeCostPct'))
                  const showMargin = !!snapshot.ims && (!!snapshot.hr || has('netMarginPct'))
                  // OWNER-REPORT-12: a month whose closing count was materially incomplete has no
                  // food-cost verdict on page 1, so none here either.
                  const curGap = !!snapshot.ims?.countGap?.material && cogsBasis
                  const priorGap = t?.snapshot?.countGapMaterial === true
                  const unjudged = !!d.verdictWithheld || curGap || priorGap
                  // OWNER-REPORT-2: the prior froze without its Crest IMS section. Read through
                  // priorFailedSections (S857), which also takes the `{ key: message }` object a
                  // pre-v10 entry holds; `.includes` on that object threw.
                  const priorMissingIms = priorFailedSections(t?.snapshot).includes('ims')
                  return (
                    <div key={key} style={{ marginBottom: 14 }}>
                      <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--theme-text2)', marginBottom: 6 }}>{label}</div>
                      {!t?.available ? (
                        <p style={{ fontSize: 12, color: 'var(--theme-text3)', margin: 0 }}>{trendUnavailableText(t)}</p>
                      ) : (
                        <div className="table-wrap">
                          <table className="data-table owner-report-table">
                            <thead>
                              <tr>
                                <th>Metric</th><th style={{ textAlign: 'right' }}>This Period</th><th style={{ textAlign: 'right' }}>{priorLabel}</th>
                                <th style={{ textAlign: 'right' }}>
                                  <Tip text="For a % figure the change is in points: 30% to 32% is +2.0 points. For money it is the amount, then its % change." width={260}>Change</Tip>
                                </th>
                              </tr>
                            </thead>
                            <tbody>
                              <TrendRow label="Revenue" cur={snapshot.combined?.revenueTotal} prior={t.snapshot?.combined?.revenueTotal} delta={d.revenueTotal} fmtFn={fmt} />
                              {snapshot.ims && <TrendPctRow label="Food Cost %" cur={snapshot.combined?.foodCostPct} prior={t.snapshot?.combined?.foodCostPct} delta={d.foodCostPct} unjudged={unjudged} />}
                              {showLabour && <TrendPctRow label="Labor Cost %" cur={snapshot.combined?.laborCostPct} prior={t.snapshot?.combined?.laborCostPct} delta={d.laborCostPct} />}
                              {showPrime && <TrendPctRow label="Prime Cost %" cur={snapshot.combined?.primeCostPct} prior={t.snapshot?.combined?.primeCostPct} delta={d.primeCostPct} unjudged={unjudged} />}
                              {showMargin && <TrendPctRow label="Net Margin %" cur={snapshot.combined?.netMarginPct} prior={t.snapshot?.combined?.netMarginPct} delta={d.netMarginPct} higherIsBetter unjudged={unjudged || !canOverheads} />}
                              {snapshot.pos && t.snapshot?.pos && <TrendRow label="POS Net Sales" cur={snapshot.pos?.totalNetSales} prior={t.snapshot?.pos?.totalNetSales} delta={d.posNetSales} fmtFn={fmt} />}
                            </tbody>
                          </table>
                        </div>
                      )}
                      {t?.available && unjudged && snapshot.ims && (
                        <p style={{ fontSize: 12, color: 'var(--theme-text3)', margin: '6px 0 0', lineHeight: 1.5 }}>
                          Not judged: {curGap && priorGap ? `${periodLabel}'s and ${priorLabel}'s closing counts were` : `${curGap ? periodLabel : priorLabel}'s closing count was`} incomplete,
                          so Food Cost, Prime Cost and Net Margin show their change without better or worse.
                        </p>
                      )}
                      {t?.available && snapshot.ims && priorMissingIms && (
                        <p style={{ fontSize: 12, color: 'var(--theme-text3)', margin: '6px 0 0', lineHeight: 1.5 }}>
                          {priorLabel}'s report is missing its Crest IMS section, so Food Cost, Prime Cost and Net Margin are not compared.
                          Regenerate {priorLabel}'s snapshot and then this one to compare them.
                        </p>
                      )}
                      {/* S792 (D30): across the v8 → v9 line the two Food Cost % figures are two
                          formulas, so the three ratios containing it carry no change (buildDeltas
                          left them null). Say why, or the dashes read as missing data. */}
                      {t?.available && snapshot.ims && !priorMissingIms && basisOf(snapshot) !== basisOf(t.snapshot) && (
                        <p style={{ fontSize: 12, color: 'var(--theme-text3)', margin: '6px 0 0', lineHeight: 1.5 }}>
                          Food Cost, Prime Cost and Net Margin are not compared: {priorLabel} was generated
                          on {basisOf(t.snapshot) === 'cogs' ? 'food used (COGS)' : 'net purchases'} ÷ revenue and this
                          report on {basisOf(snapshot) === 'cogs' ? 'food used (COGS)' : 'net purchases'} ÷ revenue.
                          To compare them, regenerate {priorLabel}'s snapshot and then this one (this report keeps the copy of {priorLabel} it was made with).
                        </p>
                      )}
                      {/* S798 2e: across the v11 → v12 line Net Margin gained Tax & Fees, so its
                          change is left blank (buildDeltas). Same reason to say so. */}
                      {t?.available && showMargin && basisOf(snapshot) === basisOf(t.snapshot) && taxFeesInNet(snapshot) !== taxFeesInNet(t.snapshot) && (
                        <p style={{ fontSize: 12, color: 'var(--theme-text3)', margin: '6px 0 0', lineHeight: 1.5 }}>
                          Net Margin is not compared: {taxFeesInNet(snapshot) ? 'this report' : priorLabel} subtracts Tax &amp; Fees
                          and {taxFeesInNet(snapshot) ? priorLabel : 'this report'} was made before it did.
                          To compare them, regenerate {priorLabel}'s snapshot and then this one.
                        </p>
                      )}
                      {/* S849 (GAPS-1): across the v17 → v18 line Net Margin gained wasted stock,
                          staff meals and delivery commission (buildDeltas: netMarginCostsChanged). */}
                      {t?.available && showMargin && basisOf(snapshot) === basisOf(t.snapshot) && taxFeesInNet(snapshot) === taxFeesInNet(t.snapshot) && pnlCostsInNet(snapshot) !== pnlCostsInNet(t.snapshot) && (
                        <p style={{ fontSize: 12, color: 'var(--theme-text3)', margin: '6px 0 0', lineHeight: 1.5 }}>
                          Net Margin is not compared: {pnlCostsInNet(snapshot) ? 'this report' : priorLabel} also subtracts wasted stock,
                          staff meals and delivery commission, and {pnlCostsInNet(snapshot) ? priorLabel : 'this report'} was made before it did.
                          To compare them, regenerate {priorLabel}'s snapshot and then this one.
                        </p>
                      )}
                      {/* S798 3c: across the v12 → v13 line labour changed meaning (buildDeltas
                          leaves Labor, Prime and Net Margin blank). */}
                      {t?.available && showLabour && earnedLabour(snapshot) !== earnedLabour(t.snapshot) && (
                        <p style={{ fontSize: 12, color: 'var(--theme-text3)', margin: '6px 0 0', lineHeight: 1.5 }}>
                          Labor Cost, Prime Cost and Net Margin are not compared: {earnedLabour(snapshot) ? 'this report' : priorLabel} counts
                          labour as pay earned (unpaid days taken off) plus festival, incentive and final-settlement pay,
                          and {earnedLabour(snapshot) ? priorLabel : 'this report'} was made before it did.
                          To compare them, regenerate {priorLabel}'s snapshot and then this one.
                        </p>
                      )}
                    </div>
                  )
                })}
              </div>
            )}

          </div>
        )}
        {confirmRegenerate && selectedPeriod && (
          <ConfirmModal
            title="Regenerate this snapshot?"
            confirmLabel="Regenerate"
            danger
            onConfirm={handleRegenerate}
            onCancel={() => setConfirmRegenerate(false)}
          >
            The frozen figures for {BS_MONTHS[selectedPeriod.bs_month - 1]} {selectedPeriod.bs_year} are
            overwritten with a fresh computation from the data as it stands today. The original
            snapshot is not kept — if the underlying entries changed since it froze, the report's
            figures change with them.
          </ConfirmModal>
        )}
    </>
  )
}
