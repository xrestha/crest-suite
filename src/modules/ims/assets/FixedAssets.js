import { useEffect, useRef, useState } from 'react'
import { Navigate } from 'react-router-dom'
import { useAuth } from '../../../context/AuthContext'
import { useScopedDb } from '../../../shared/hooks/useScopedDb'
import SuiteGate from '../../../components/SuiteGate'
import AssetRegisterTab from './AssetRegisterTab'
import DepreciationRunTab from './DepreciationRunTab'
import ValuationReportTab from './ValuationReportTab'
import DisposalReportTab from './DisposalReportTab'
import TaxPoolTab from './TaxPoolTab'

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
  const [activeTab, setActiveTab] = useState('register')
  const [categories, setCategories] = useState([])
  const [assets, setAssets] = useState([])
  const [loading, setLoading] = useState(true)
  // Only the very first load shows the full-page "Loading…" skeleton. A reload triggered by a
  // child tab (e.g. after Add Asset or Post) must NOT unmount the tab tree — that would wipe the
  // triggering tab's own local state (DepreciationRunTab's period fields, its just-posted success
  // message, TaxPoolTab's in-progress preview) the instant the action that state belongs to
  // finishes. Found live (smoke test): posting a depreciation run cleared the period pickers and
  // hid the "Posted" confirmation before it could ever be read, even though the post itself had
  // already succeeded.
  const hasLoadedOnce = useRef(false)

  useEffect(() => { load() }, []) // eslint-disable-line react-hooks/exhaustive-deps

  async function load() {
    if (!hasLoadedOnce.current) setLoading(true)
    const [{ data: cats }, { data: rows }] = await Promise.all([
      scopedFrom('assets_categories').order('sort_order').order('name'),
      scopedFrom('assets_register', '*, assets_categories(name, tax_pool_hint)').order('created_at', { ascending: false }),
    ])
    setCategories(cats || [])
    setAssets(rows || [])
    setLoading(false)
    hasLoadedOnce.current = true
  }

  // Defensive route guard even though the nav item already hides for sub-supervisor accounts
  // (mirrors PayrollRun.jsx's convention of guarding the route itself, not just its nav entry).
  if (!hasImsAccess('supervisor')) return <Navigate to="/dashboard" replace />

  return (
    <div>
      <div className="page-header no-print">
        <div>
          <h1 className="page-title">Fixed Assets</h1>
          <p className="page-subtitle">Asset register, depreciation, valuation & disposal — book and Nepal statutory tax basis</p>
        </div>
      </div>

      <SuiteGate featureKey="fixed_asset_register" featureLabel="Fixed Assets" requireModules={['ims']}>
      <div className="tab-bar no-print" style={{ marginBottom: 16 }}>
        {TABS.map(t => (
          <button
            key={t.key}
            className={`tab-btn${activeTab === t.key ? ' tab-btn--active' : ''}`}
            onClick={() => setActiveTab(t.key)}
          >
            {t.label}
          </button>
        ))}
      </div>

      {loading ? (
        <div className="card"><p style={{ color: 'var(--theme-text2)', fontSize: 13, margin: 0 }}>Loading…</p></div>
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
            <TaxPoolTab assets={assets} categories={categories} />
          )}
        </>
      )}
      </SuiteGate>
    </div>
  )
}
