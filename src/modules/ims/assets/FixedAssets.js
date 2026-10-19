import { useEffect, useRef, useState } from 'react'
import { Navigate } from 'react-router-dom'
import { useAuth } from '../../../context/AuthContext'
import { useScopedDb } from '../../../shared/hooks/useScopedDb'
import SuiteGate, { useSuiteAccess, SUITE_PAGES } from '../../../components/SuiteGate'
import AssetRegisterTab from './AssetRegisterTab'
import DepreciationRunTab from './DepreciationRunTab'
import ValuationReportTab from './ValuationReportTab'
import DisposalReportTab from './DisposalReportTab'
import TaxPoolTab from './TaxPoolTab'
import ReportLoadError from '../../../components/ReportLoadError'
import { settleWithin } from '../../../utils/withTimeout'
import Tabs, { TabPanel } from '../../../components/Tabs'
import { readRegister, ASSET_CALL_MS } from './assetReads'

const TABS = [
  { key: 'register',   label: 'Register' },
  { key: 'depreciation', label: 'Depreciation Runs' },
  { key: 'valuation',   label: 'Valuation Report' },
  { key: 'disposal',    label: 'Disposal Report' },
  { key: 'tax',         label: 'Tax Depreciation (IRD)' },
]

// Single tabbed page, one nav entry, one feature flag — matches OutstandingPayables.js's
// activeTab + tab-bar pattern rather than 4-5 separate routes, since all sub-views share the
// same category/asset data loaded once here.
export default function FixedAssets() {
  const { hasImsAccess } = useAuth()
  const { scopedFrom } = useScopedDb()
  // S849 (ASSETS-13): nothing is read until both gates pass — the IMS supervisor rank the page and
  // the database both require, and Crest Suite Pro for this outlet. The same SUITE_PAGES entry
  // drives the gate below, so the card and the loads cannot disagree (ACCESS's shared pattern).
  const suite = useSuiteAccess(SUITE_PAGES.fixedAssets)
  const canView = hasImsAccess('supervisor')
  const canLoad = suite.allowed && canView
  const [activeTab, setActiveTab] = useState('register')
  const [categories, setCategories] = useState([])
  const [assets, setAssets] = useState([])
  const [loading, setLoading] = useState(true)
  // A failed read is not an empty register (S756). Both reads dropped their error, so a dead
  // connection rendered "No assets", a Valuation of NPR 0 and — the one that writes — a Tax Pool
  // preview with no additions and no disposals that a manager could POST as the year's locked
  // schedule. While this is set the whole tab tree is withheld, and with it both Post buttons.
  const [loadError, setLoadError] = useState(null)
  // Only the very first load shows the full-page "Loading…" skeleton. A reload triggered by a
  // child tab (e.g. after Add Asset or Post) must NOT unmount the tab tree — that would wipe the
  // triggering tab's own local state (DepreciationRunTab's period fields, its just-posted success
  // message, TaxPoolTab's in-progress preview) the instant the action that state belongs to
  // finishes. Found live (smoke test): posting a depreciation run cleared the period pickers and
  // hid the "Posted" confirmation before it could ever be read, even though the post itself had
  // already succeeded.
  const hasLoadedOnce = useRef(false)
  // Two reloads in a row (a save, then a close) must not let the slower, older one win.
  const loadSeq = useRef(0)

  useEffect(() => { if (canLoad) load() }, [canLoad]) // eslint-disable-line react-hooks/exhaustive-deps

  async function load() {
    if (!canLoad) return
    const seq = ++loadSeq.current
    if (!hasLoadedOnce.current) setLoading(true)
    // Bounded (ASSETS-15): a hung read used to hold the page on "Loading…" for good. The register
    // is paged, so a client past 1,000 assets is read whole.
    const results = await Promise.all([
      settleWithin(scopedFrom('assets_categories').order('sort_order').order('name').order('id'), ASSET_CALL_MS, 'Reading the asset categories'),
      settleWithin(readRegister(scopedFrom), ASSET_CALL_MS, 'Reading the asset register'),
    ])
    if (seq !== loadSeq.current) return
    // The error OBJECT, so ReportLoadError keeps its code in the fine print.
    const failed = results.find(r => r.error)?.error || null
    if (failed) {
      setLoadError(failed)
      setLoading(false)
      return
    }
    setLoadError(null)
    const [{ data: cats }, { data: rows }] = results
    setCategories(cats || [])
    setAssets(rows || [])
    setLoading(false)
    hasLoadedOnce.current = true
  }

  // Defensive route guard even though the nav item already hides for sub-supervisor accounts
  // (mirrors PayrollRun.jsx's convention of guarding the route itself, not just its nav entry).
  if (!canView) return <Navigate to="/dashboard" replace />

  return (
    <div>
      <div className="page-header no-print">
        <div>
          <h1 className="page-title">Fixed Assets</h1>
          <p className="page-subtitle">Asset register, depreciation, valuation & disposal — book and Nepal statutory tax basis</p>
        </div>
      </div>

      <SuiteGate page={SUITE_PAGES.fixedAssets}>
      {/* S765: five real sub-views with no tab semantics at all — no tablist, no tabpanel, and
          five separate Tab stops. */}
      <Tabs
        idBase="fixed-assets"
        hasPanel
        label="Fixed asset sections"
        className="no-print"
        style={{ marginBottom: 16 }}
        tabs={TABS}
        active={activeTab}
        onChange={setActiveTab}
      />

      <TabPanel idBase="fixed-assets" active={activeTab}>
      {loading ? (
        <div className="card"><p style={{ color: 'var(--theme-text2)', fontSize: 13, margin: 0 }}>Loading…</p></div>
      ) : loadError ? (
        <>
          <ReportLoadError error={loadError} />
          <button className="btn btn-ghost" style={{ marginTop: 12 }} onClick={load}>Try again</button>
        </>
      ) : (
        <>
          {activeTab === 'register' && (
            <AssetRegisterTab categories={categories} assets={assets} onReload={load} />
          )}
          {activeTab === 'depreciation' && (
            <DepreciationRunTab assets={assets} onReload={load} />
          )}
          {activeTab === 'valuation' && (
            <ValuationReportTab assets={assets} />
          )}
          {activeTab === 'disposal' && (
            <DisposalReportTab assets={assets} />
          )}
          {activeTab === 'tax' && (
            <TaxPoolTab />
          )}
        </>
      )}
      </TabPanel>
      </SuiteGate>
    </div>
  )
}
