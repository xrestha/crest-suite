import { useEffect, useState } from 'react'
import { useSettings } from '../../context/SettingsContext'

// null = no override (plan decides), true = explicit grant, false = explicit revoke
const DEFAULT_FLAGS = {
  sales_entry: null, monthly_summary: null, payment_summary: null,
  vendor_report: null, variance_report: null, fifo_report: null,
  reorder_report: null, price_tracker: null, recipe_costing: null,
  menu_engineering: null, overheads: null, budget_vs_actual: null,
  best_sellers: null, vat_report: null, non_vat_report: null,
  purchase_orders: null, requisitions: null, wastage_report: null,
  dead_stock: null, recipe_margin: null, period_comparison: null,
  theoretical_variance: null, annual_summary: null,
  outstanding_payables: null, shrinkage_report: null,
  staff_meals: null, settings: null,
  nutrition_facts: null, stock_report: null,
  menu_pricing: null,
  menu_repricing: null,
  demand_forecast: null,
  combo_builder: null,
  guest_ordering: null,
  owner_dashboard: null,
  monthly_owner_report: null,
  stock_movement_log: null,
}

const FEATURE_GROUPS = [
  { tier: 'core',    label: 'Core — All Plans', color: 'var(--theme-text2)', features: [
    { key: null, label: 'Dashboard' },
    { key: null, label: 'Periods' },
    { key: null, label: 'Item Master' },
    { key: null, label: 'Vendors' },
    { key: null, label: 'Purchases' },
    { key: null, label: 'Stock Count' },
  ]},
  { tier: 'starter', label: 'Starter Plan',     color: 'var(--theme-text3)', features: [
    { key: 'menu_pricing',    label: 'Menu Pricing' },
    { key: 'sales_entry',     label: 'Sales Entry' },
    { key: 'payment_summary', label: 'Payment Summary' },
    { key: 'monthly_summary', label: 'Monthly Summary' },
    { key: 'annual_summary',  label: 'Annual Summary' },
    { key: 'reorder_report',  label: 'Reorder Report' },
    { key: 'stock_movement_log', label: 'Stock Movements' },
    { key: 'vat_report',      label: 'VAT Report' },
    { key: 'non_vat_report',  label: 'Non-VAT Report' },
    { key: 'wastage_report',  label: 'Wastage Report' },
    { key: 'stock_report',    label: 'Stock Report' },
    { key: 'settings',        label: 'Settings' },
    { key: 'staff_meals',     label: 'Staff Meals' },
  ]},
  { tier: 'growth',  label: 'Growth Plan',      color: 'var(--theme-green)', features: [
    { key: 'recipe_costing',       label: 'Recipe Costing' },
    { key: 'purchase_orders',      label: 'Purchase Orders' },
    { key: 'requisitions',         label: 'Requisitions' },
    { key: 'variance_report',      label: 'Variance Report' },
    { key: 'budget_vs_actual',     label: 'Budget vs Actual' },
    { key: 'best_sellers',         label: 'Best & Worst Sellers' },
    { key: 'dead_stock',           label: 'Dead Stock' },
    { key: 'recipe_margin',        label: 'Recipe Margin' },
    { key: 'outstanding_payables', label: 'Outstanding Payables' },
    { key: 'nutrition_facts',      label: 'Nutrition Facts' },
    { key: 'menu_repricing',       label: 'Menu Repricing' },
    { key: 'combo_builder',        label: 'Combo Builder' },
  ]},
  { tier: 'pro',     label: 'Pro Plan',         color: 'var(--theme-accent)', features: [
    { key: 'menu_engineering',     label: 'Menu Engineering' },
    { key: 'overheads',            label: 'Overheads' },
    { key: 'vendor_report',        label: 'Vendor Report' },
    { key: 'fifo_report',          label: 'FIFO / Expiry' },
    { key: 'price_tracker',        label: 'Price Tracker' },
    { key: 'theoretical_variance', label: 'Theoretical Variance' },
    { key: 'period_comparison',    label: 'Period Comparison' },
    { key: 'shrinkage_report',     label: 'Shrinkage Report' },
    { key: 'demand_forecast',      label: 'Demand Forecast' },
    // A POS feature, not an IMS one — its "included in plan" check below uses client.pos_plan,
    // not clientPlan (the IMS plan), so it doesn't incorrectly key off IMS/POS plan mismatches.
    { key: 'guest_ordering',       label: 'Guest QR Self-Ordering', planSource: 'pos' },
  ]},
]

// Returns true if the plan naturally includes this tier's features
function isPlanIncluded(tier, clientPlan) {
  if (tier === 'core') return true
  if (tier === 'starter') return true
  if (tier === 'growth') return clientPlan === 'growth' || clientPlan === 'pro'
  if (tier === 'pro') return clientPlan === 'pro'
  return false
}

export default function FeatureAccessModal({ client, onClose }) {
  const { loadClientFeatureFlags, saveFeatureFlags } = useSettings()
  const [flags, setFlags] = useState(DEFAULT_FLAGS)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [msg, setMsg] = useState('')

  // clientPlan drives the IMS feature grid (which tiers are auto-included) — always the IMS plan.
  const clientPlan = client.plan || 'starter'
  const planLabel  = clientPlan.charAt(0).toUpperCase() + clientPlan.slice(1)
  // These feature flags are all Crest IMS features. They only mean anything when IMS is
  // enabled for the client — ModuleGate blocks all IMS routes otherwise. Don't show the
  // IMS plan grid for an HR-only client.
  const imsEnabled = client.ims_enabled !== false
  const hrEnabled  = !!client.hr_enabled
  const posEnabled = !!client.pos_enabled
  // Header reflects the primary active module and plan.
  const activeModule = imsEnabled ? 'IMS' : (posEnabled ? 'POS' : (hrEnabled ? 'HR' : 'IMS'))
  const activePlan   = (imsEnabled ? client.plan : (posEnabled ? client.pos_plan : (hrEnabled ? client.hr_plan : client.plan))) || 'starter'
  const activeColor  = activePlan === 'pro' ? 'var(--theme-accent)' : activePlan === 'growth' ? 'var(--theme-green)' : 'var(--theme-text3)'
  const activeLabel  = activePlan.charAt(0).toUpperCase() + activePlan.slice(1)

  useEffect(() => {
    loadClientFeatureFlags(client.id).then(data => {
      setFlags({ ...DEFAULT_FLAGS, ...data })
      setLoading(false)
    })
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client.id])

  async function handleSave() {
    setSaving(true); setMsg('')
    try {
      await saveFeatureFlags(client.id, flags)
      setMsg('ok:Saved.')
    } catch (e) {
      setMsg('error:' + e.message)
    }
    setSaving(false)
  }

  function toggleFeat(key, currentIsOn) {
    // Plan features are not toggleable — only non-plan grants use true/null
    setFlags(f => ({ ...f, [key]: currentIsOn ? null : true }))
  }

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 300 }}
      onClick={e => { if (e.target === e.currentTarget) onClose() }}>
      <div style={{ background: 'var(--theme-card)', border: '1px solid var(--theme-border)', borderRadius: 12, width: 'min(1120px, 96vw)', maxHeight: '90vh', overflow: 'hidden', display: 'flex', flexDirection: 'column', boxShadow: '0 24px 64px rgba(0,0,0,0.4)' }}>

        {/* Header */}
        <div style={{ padding: '18px 24px 14px', borderBottom: '1px solid var(--theme-border)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexShrink: 0 }}>
          <div>
            <h3 style={{ margin: 0, fontSize: 15, color: 'var(--theme-text1)', fontFamily: 'Georgia, serif' }}>Feature Access · Crest {activeModule}</h3>
            <p style={{ margin: '3px 0 0', fontSize: 12, color: 'var(--theme-text2)' }}>
              {client.name} ·{' '}
              <span style={{ fontWeight: 700, color: activeColor }}>{activeModule} {activeLabel} Plan</span>
              {(imsEnabled || posEnabled) && <span style={{ marginLeft: 10, fontSize: 11, color: 'var(--theme-text3)' }}>Checkboxes override plan — check to grant, uncheck to revoke</span>}
            </p>
          </div>
          <button onClick={onClose} style={{ background: 'none', border: 'none', color: 'var(--theme-text2)', fontSize: 18, cursor: 'pointer', lineHeight: 1, padding: '2px 6px' }}>✕</button>
        </div>

        {/* Scrollable body — the header/footer above/below stay put; everything in between
            (the feature grid, now taller with the Crest Suite section) scrolls internally
            instead of pushing the Save/Close buttons off-screen on a short viewport. */}
        <div style={{ flex: 1, overflowY: 'auto', overflowX: 'auto', minHeight: 0 }}>

        {/* No active module — feature grants would be inert */}
        {!imsEnabled && !posEnabled ? (
          <div style={{ padding: '32px 24px', textAlign: 'center' }}>
            <p style={{ margin: 0, fontSize: 13, color: 'var(--theme-text1)', fontWeight: 600 }}>Enable a module to manage feature access</p>
            <p style={{ margin: '6px 0 0', fontSize: 12, color: 'var(--theme-text2)', lineHeight: 1.5 }}>
              {hrEnabled && <>This client is on <strong>Crest HR</strong> (<span style={{ color: activeColor, fontWeight: 700 }}>{activeLabel}</span>) — HR access is set by its plan tier in the Modules tab, not per-feature.<br/></>}
              Enable <strong>Crest IMS</strong> or <strong>Crest POS</strong> from the client card to manage feature access here.
            </p>
          </div>
        ) : !imsEnabled ? (
        /* POS-only client — just show POS feature flags */
        <div style={{ padding: '16px 24px 24px' }}>
          <p style={{ margin: '0 0 14px', fontSize: 12, color: 'var(--theme-text2)' }}>POS feature overrides — grant features above this client's POS plan tier.</p>
          {loading ? <p style={{ color: 'var(--theme-text2)', fontSize: 13 }}>Loading…</p>
            : [
                { key: 'menu_pricing',   label: 'Menu Pricing' },
                { key: 'guest_ordering', label: 'Guest QR Self-Ordering', tier: 'pro' },
              ].map(feat => {
                // Only guest_ordering declares a tier — menu_pricing keeps its original
                // always-a-toggle behavior (pre-existing, unrelated to this feature).
                const planIncluded = feat.tier ? isPlanIncluded(feat.tier, client.pos_plan || 'starter') : false
                const locked = planIncluded
                const isAdminGranted = !locked && flags[feat.key] === true
                const isOn = locked || isAdminGranted
                return (
                  <div key={feat.key}
                    onClick={() => !locked && toggleFeat(feat.key, isAdminGranted)}
                    style={{
                      display: 'flex', alignItems: 'center', gap: 10,
                      background: 'var(--theme-bg)', borderRadius: 6, padding: '6px 8px', maxWidth: 220,
                      border: `1px solid ${locked ? 'var(--theme-accent)22' : isAdminGranted ? 'var(--theme-accent)50' : 'var(--theme-border)'}`,
                      cursor: locked ? 'default' : 'pointer', transition: 'border-color 0.15s',
                    }}>
                    <div style={{
                      width: 16, height: 16, borderRadius: 3, flexShrink: 0,
                      background: isOn ? 'var(--theme-accent)' : 'transparent',
                      border: `2px solid ${isOn ? 'var(--theme-accent)' : 'var(--theme-text3)'}`,
                      display: 'flex', alignItems: 'center', justifyContent: 'center', transition: 'all 0.15s',
                    }}>
                      {isOn && <span style={{ color: '#000', fontSize: 10, fontWeight: 900, lineHeight: 1 }}>✓</span>}
                    </div>
                    <div style={{ flex: 1 }}>
                      <span style={{ fontSize: 12, color: isOn ? 'var(--theme-text1)' : 'var(--theme-text2)' }}>{feat.label}</span>
                      {locked && (
                        <span style={{
                          marginLeft: 6, fontSize: 9, fontWeight: 700, color: 'var(--theme-accent)',
                          background: 'var(--theme-accent)18', border: '1px solid var(--theme-accent)35',
                          borderRadius: 3, padding: '1px 4px', verticalAlign: 'middle',
                        }}>Plan</span>
                      )}
                      {isAdminGranted && (
                        <span style={{
                          marginLeft: 6, fontSize: 9, fontWeight: 700, color: 'var(--theme-accent)',
                          background: 'var(--theme-accent)18', border: '1px solid var(--theme-accent)35',
                          borderRadius: 3, padding: '1px 4px', verticalAlign: 'middle',
                        }}>Override</span>
                      )}
                    </div>
                  </div>
                )
              })
          }
        </div>
        ) : (
        /* IMS client (possibly also POS) — full feature grid.
           minmax(0, 1fr), not bare 1fr — a plain 1fr track's minimum width defaults to its
           content's min-content size, so a long unwrapping label (e.g. "Guest QR
           Self-Ordering") can force this grid (and the whole modal, since nothing above it
           constrains width otherwise) wider than the viewport instead of letting columns
           shrink. minmax(0, 1fr) lets each column actually shrink to fit. */
        <div style={{ padding: '16px 24px 8px', display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0, 1fr))', gap: '0 14px', alignItems: 'start' }}>
          {loading ? <p style={{ color: 'var(--theme-text2)', fontSize: 13, gridColumn: '1/-1' }}>Loading…</p> : FEATURE_GROUPS.map(group => {
            const planIncluded = isPlanIncluded(group.tier, clientPlan)
            return (
              <div key={group.tier} style={{ marginBottom: 16 }}>
                {/* Group header */}
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                  <span style={{ fontSize: 10, fontWeight: 800, color: group.color, textTransform: 'uppercase', letterSpacing: '0.08em' }}>{group.label}</span>
                  {planIncluded && group.tier !== 'core' && (
                    <span style={{ fontSize: 10, color: group.color, background: group.color + '15', border: `1px solid ${group.color}30`, borderRadius: 3, padding: '1px 6px' }}>
                      Included in {planLabel}
                    </span>
                  )}
                  {!planIncluded && (
                    <span style={{ fontSize: 10, color: 'var(--theme-text3)', background: 'var(--theme-card)', border: '1px solid var(--theme-text3)', borderRadius: 3, padding: '1px 6px' }}>
                      Not in plan — check to override
                    </span>
                  )}
                </div>

                {/* Feature list — single column, one per plan group column */}
                <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
                  {group.features.map(feat => {
                    const isCore = feat.key === null
                    // Most features check the IMS plan (planIncluded, computed once per group
                    // above); a feature with planSource: 'pos' checks the client's POS plan
                    // instead — see guest_ordering above.
                    const featPlanIncluded = feat.planSource === 'pos'
                      ? isPlanIncluded(group.tier, client.pos_plan || 'starter')
                      : planIncluded
                    const locked = isCore || featPlanIncluded  // plan features are always on, non-clickable
                    const isAdminGranted = !locked && flags[feat.key] === true
                    const isOn = locked || isAdminGranted

                    return (
                      <div
                        key={feat.key || feat.label}
                        onClick={() => !locked && feat.key && toggleFeat(feat.key, isAdminGranted)}
                        style={{
                          display: 'flex', alignItems: 'center', gap: 10,
                          background: 'var(--theme-bg)', borderRadius: 6, padding: '6px 8px',
                          border: `1px solid ${locked ? group.color + '22' : isAdminGranted ? 'var(--theme-accent)50' : 'var(--theme-border)'}`,
                          cursor: locked ? 'default' : 'pointer',
                          transition: 'border-color 0.15s',
                        }}
                      >
                        {/* Checkbox */}
                        <div style={{
                          width: 16, height: 16, borderRadius: 3, flexShrink: 0,
                          background: isOn ? (locked ? group.color : 'var(--theme-accent)') : 'transparent',
                          border: `2px solid ${isOn ? (locked ? group.color : 'var(--theme-accent)') : 'var(--theme-text3)'}`,
                          display: 'flex', alignItems: 'center', justifyContent: 'center',
                          transition: 'all 0.15s',
                          opacity: isCore ? 0.45 : 1,
                        }}>
                          {isOn && <span style={{ color: '#000', fontSize: 10, fontWeight: 900, lineHeight: 1 }}>✓</span>}
                        </div>

                        {/* Label + badge */}
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <span style={{ fontSize: 12, color: isOn ? 'var(--theme-text1)' : 'var(--theme-text2)' }}>{feat.label}</span>
                          {locked && !isCore && (
                            <span style={{
                              marginLeft: 6, fontSize: 9, fontWeight: 700, color: group.color,
                              background: group.color + '18', border: `1px solid ${group.color}35`,
                              borderRadius: 3, padding: '1px 4px', verticalAlign: 'middle',
                            }}>Plan</span>
                          )}
                          {isAdminGranted && (
                            <span style={{
                              marginLeft: 6, fontSize: 9, fontWeight: 700, color: 'var(--theme-accent)',
                              background: 'var(--theme-accent)18', border: '1px solid var(--theme-accent)35',
                              borderRadius: 3, padding: '1px 4px', verticalAlign: 'middle',
                            }}>Override</span>
                          )}
                        </div>
                      </div>
                    )
                  })}
                </div>
              </div>
            )
          })}
        </div>
        )}

        {/* Crest Suite — a separate gating axis (client.suite_plan) from the module plan grids
            above; only meaningful once both IMS and HR are enabled. Not part of FEATURE_GROUPS
            since it doesn't key off clientPlan/pos_plan's rank system. Two features live on this
            axis so far: Owner Dashboard (live KPIs) and its frozen-snapshot sibling, the Monthly
            Owner/Manager Report (added alongside monthly_owner_reports table). */}
        {imsEnabled && hrEnabled && (() => {
          const SUITE_RANK = { starter: 0, growth: 1, pro: 2 }
          const locked = (SUITE_RANK[client.suite_plan] ?? -1) >= SUITE_RANK.growth
          const suiteFeatures = [
            { key: 'owner_dashboard', label: 'Owner Dashboard' },
            { key: 'monthly_owner_report', label: 'Monthly Owner/Manager Report' },
          ]
          return (
            <div style={{ padding: '0 24px 16px' }}>
              <span style={{ fontSize: 10, fontWeight: 800, color: 'var(--theme-accent)', textTransform: 'uppercase', letterSpacing: '0.08em', display: 'block', marginBottom: 8 }}>
                Crest Suite
              </span>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {suiteFeatures.map(({ key, label }) => {
                  const isAdminGranted = !locked && flags[key] === true
                  const isOn = locked || isAdminGranted
                  return (
                    <div
                      key={key}
                      onClick={() => !locked && toggleFeat(key, isAdminGranted)}
                      style={{
                        display: 'flex', alignItems: 'center', gap: 10,
                        background: 'var(--theme-bg)', borderRadius: 6, padding: '6px 8px', maxWidth: 300,
                        border: `1px solid ${locked ? 'var(--theme-accent)22' : isAdminGranted ? 'var(--theme-accent)50' : 'var(--theme-border)'}`,
                        cursor: locked ? 'default' : 'pointer', transition: 'border-color 0.15s',
                      }}>
                      <div style={{
                        width: 16, height: 16, borderRadius: 3, flexShrink: 0,
                        background: isOn ? 'var(--theme-accent)' : 'transparent',
                        border: `2px solid ${isOn ? 'var(--theme-accent)' : 'var(--theme-text3)'}`,
                        display: 'flex', alignItems: 'center', justifyContent: 'center', transition: 'all 0.15s',
                      }}>
                        {isOn && <span style={{ color: '#000', fontSize: 10, fontWeight: 900, lineHeight: 1 }}>✓</span>}
                      </div>
                      <div style={{ flex: 1 }}>
                        <span style={{ fontSize: 12, color: isOn ? 'var(--theme-text1)' : 'var(--theme-text2)' }}>{label}</span>
                        {locked && (
                          <span style={{ marginLeft: 6, fontSize: 9, fontWeight: 700, color: 'var(--theme-accent)', background: 'var(--theme-accent)18', border: '1px solid var(--theme-accent)35', borderRadius: 3, padding: '1px 4px', verticalAlign: 'middle' }}>
                            Suite {client.suite_plan}
                          </span>
                        )}
                        {isAdminGranted && (
                          <span style={{ marginLeft: 6, fontSize: 9, fontWeight: 700, color: 'var(--theme-accent)', background: 'var(--theme-accent)18', border: '1px solid var(--theme-accent)35', borderRadius: 3, padding: '1px 4px', verticalAlign: 'middle' }}>
                            Override
                          </span>
                        )}
                        {!client.suite_plan && !isAdminGranted && (
                          <span style={{ marginLeft: 6, fontSize: 11, color: 'var(--theme-text3)' }}>Not subscribed to Suite</span>
                        )}
                      </div>
                    </div>
                  )
                })}
              </div>
            </div>
          )
        })()}

        </div>

        {/* Footer */}
        <div style={{ padding: '12px 24px', borderTop: '1px solid var(--theme-border)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexShrink: 0 }}>
          <span style={{ fontSize: 12, color: msg.startsWith('ok:') ? 'var(--theme-green)' : msg.startsWith('error:') ? 'var(--theme-red)' : 'transparent' }}>
            {msg.replace(/^(ok|error):/, '') || '·'}
          </span>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn btn-ghost" style={{ fontSize: 12, padding: '5px 14px' }} onClick={onClose}>Close</button>
            {(imsEnabled || posEnabled) && (
              <button className="btn btn-primary" style={{ fontSize: 12, padding: '5px 14px' }} onClick={handleSave} disabled={saving}>
                {saving ? 'Saving…' : 'Save'}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
