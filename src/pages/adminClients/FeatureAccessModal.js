import { useEffect, useState } from 'react'
import { useSettings } from '../../context/SettingsContext'
import Modal from '../../components/Modal'
import { colorTint } from '../../data/pricingPlans'

// null = no override (plan decides), true = explicit grant.
//
// There is NO explicit-revoke value, despite what this comment used to claim. hasFeature() in
// AuthContext.js only tests `flagVal === true`; null, undefined and false all fall through to the
// plan check identically, and toggleFeat() below only ever writes true or null. A `false` sitting
// in the table is therefore a no-op, not a revoke — any left over from earlier data are inert.
// Believing otherwise cost a round: the S548 grandfather sweep used COALESCE(flag, true) to
// "preserve" those falses and so under-granted three clients, fixed in 20260812180000.
const DEFAULT_FLAGS = {
  sales_entry: null, monthly_summary: null, payment_summary: null,
  vendor_report: null, vendor_balance_confirmation: null, variance_report: null, fifo_report: null,
  supplier_contribution: null,
  consolidated_pnl: null,
  reorder_report: null, price_tracker: null, recipe_costing: null,
  menu_engineering: null, overheads: null, budget_vs_actual: null,
  best_sellers: null, vat_report: null, non_vat_report: null,
  purchase_orders: null, requisitions: null, wastage_report: null,
  dead_stock: null, recipe_margin: null, period_comparison: null,
  theoretical_variance: null, annual_summary: null,
  outstanding_payables: null, shrinkage_report: null,
  staff_meals: null, settings: null,
  nutrition_facts: null, stock_report: null, stock_ageing: null,
  menu_pricing: null,
  menu_repricing: null,
  demand_forecast: null,
  combo_builder: null,
  guest_ordering: null,
  loyalty: null,
  owner_dashboard: null,
  monthly_owner_report: null,
  stock_movement_log: null,
  fixed_asset_register: null,
  multi_outlet: null,
}

// Each group carries TWO colour keys — `color` drives fills (checkbox background, chip tint) and
// `textColor` drives every glyph and label. One key used to do both jobs, which is the documented
// S551 trap: the base tokens fail AA as text on the light presets (measured "Growth Plan" 3.30:1,
// "Pro Plan" 2.74:1 on Rosé Dawn), and darkening them to fix the text would wreck the fills.
const FEATURE_GROUPS = [
  { tier: 'core',    label: 'Core — All Plans', color: 'var(--theme-text2)', textColor: 'var(--theme-text2)', features: [
    { key: null, label: 'Dashboard' },
    { key: null, label: 'Periods' },
    { key: null, label: 'Item Master' },
    { key: null, label: 'Vendors' },
    { key: null, label: 'Purchases' },
    { key: null, label: 'Stock Count' },
  ]},
  // Starter sells Record & Comply. Note Reorder Report and Stock Movements are NOT here: both
  // derive their core figure from recipe explosion, and recipe_costing is Growth, so a Starter
  // client could never get a number out of either. Outstanding Payables and Vendor Balance
  // Confirmation moved down in exchange — the first is plain record-keeping, the second is
  // statutory (IRD Annexure 13), and statutory never gates above the base tier.
  { tier: 'starter', label: 'Starter Plan',     color: 'var(--theme-text3)', textColor: 'var(--theme-text2)', features: [
    { key: 'menu_pricing',    label: 'Menu Pricing' },
    { key: 'sales_entry',     label: 'Sales Entry' },
    { key: 'payment_summary', label: 'Payment Summary' },
    { key: 'monthly_summary', label: 'Monthly Summary' },
    { key: 'annual_summary',  label: 'Annual Summary' },
    { key: 'outstanding_payables', label: 'Outstanding Payables' },
    { key: 'vat_report',      label: 'VAT Report' },
    { key: 'non_vat_report',  label: 'Non-VAT Report' },
    { key: 'vendor_balance_confirmation', label: 'Vendor Balance Confirmation' },
    { key: 'wastage_report',  label: 'Wastage Report' },
    { key: 'settings',        label: 'Settings' },
    { key: 'staff_meals',     label: 'Staff Meals' },
  ]},
  // Growth sells Control — the recipe-driven cost loop. Overheads lives here rather than Pro
  // because it is the data-entry page behind Fixed Costs %/Est. Net Margin and Recipes' True
  // Cost allocation: a data-entry page must not sit above the tier of figures that consume it.
  { tier: 'growth',  label: 'Growth Plan',      color: 'var(--theme-green)', textColor: 'var(--theme-green-text)', features: [
    { key: 'recipe_costing',       label: 'Recipe Costing' },
    { key: 'purchase_orders',      label: 'Purchase Orders' },
    { key: 'requisitions',         label: 'Requisitions' },
    { key: 'variance_report',      label: 'Variance Report' },
    { key: 'reorder_report',       label: 'Reorder Report' },
    { key: 'stock_movement_log',   label: 'Stock Movements' },
    // stock_report moved Starter→Growth in the S551 retier (its On-hand figure subtracts a
    // recipe-explosion usage term, meaningless on Starter). AuthContext/App/Layout all moved
    // then; this grid lagged a session behind, which made the feature ungrantable to Starter
    // clients — the row rendered locked + pre-checked in the wrong column (phase 7, S574).
    { key: 'stock_report',         label: 'Stock Report' },
    { key: 'overheads',            label: 'Overheads' },
    { key: 'budget_vs_actual',     label: 'Budget vs Actual' },
    { key: 'best_sellers',         label: 'Best & Worst Sellers' },
    { key: 'dead_stock',           label: 'Dead Stock' },
    { key: 'recipe_margin',        label: 'Recipe Margin' },
    { key: 'nutrition_facts',      label: 'Nutrition Facts' },
    { key: 'menu_repricing',       label: 'Menu Repricing' },
    { key: 'combo_builder',        label: 'Combo Builder' },
  ]},
  // Pro sells Strategy. Demand Forecast and Fixed Assets left this tier for Crest Suite Pro (see
  // the Suite band below) — the first is genuinely cross-module, the second is owner/finance
  // altitude and self-contained.
  { tier: 'pro',     label: 'Pro Plan',         color: 'var(--theme-accent)', textColor: 'var(--theme-accent-ink)', features: [
    { key: 'menu_engineering',     label: 'Menu Engineering' },
    { key: 'vendor_report',        label: 'Vendor Report' },
    { key: 'fifo_report',          label: 'FIFO / Expiry' },
    { key: 'stock_ageing',         label: 'Stock Ageing' },
    { key: 'price_tracker',        label: 'Price Tracker' },
    { key: 'theoretical_variance', label: 'Theoretical Variance' },
    { key: 'period_comparison',    label: 'Period Comparison' },
    { key: 'shrinkage_report',     label: 'Shrinkage Report' },
    { key: 'supplier_contribution', label: 'Supplier Contribution' },
  ]},
  // POS is flat — no tiers — so its features unlock with the module itself. guest_ordering used
  // to sit in the Pro column above, which gated a POS feature on the IMS plan: a POS client on
  // IMS Starter could not buy it at any price, even though it already declared planSource: 'pos'.
  { tier: 'pos',     label: 'Crest POS Module', color: 'var(--theme-purple)', textColor: 'var(--theme-purple-text)', features: [
    { key: 'guest_ordering',       label: 'Guest QR Self-Ordering', planSource: 'pos' },
    { key: 'loyalty',              label: 'Loyalty & Rewards', planSource: 'pos' },
  ]},
]

// Returns true if the plan naturally includes this tier's features.
// 'pos' is not an IMS tier — POS is flat, so its features are included whenever the module is on;
// the caller passes client.pos_enabled through as clientPlan for that row.
function isPlanIncluded(tier, clientPlan, posEnabled) {
  if (tier === 'core') return true
  if (tier === 'starter') return true
  if (tier === 'growth') return clientPlan === 'growth' || clientPlan === 'pro'
  if (tier === 'pro') return clientPlan === 'pro'
  if (tier === 'pos') return !!posEnabled
  return false
}

// One row = one feature. A real <button role="checkbox"> — these were <div onClick>s with no
// tabIndex, no role and no state, i.e. no keyboard path at all to grant a paid feature, on the
// screen whose whole job is granting them (phase 7, S574; same defect ClientDrawer's module
// switches had already fixed one file away).
//
// Colour logic, per the S549 tint pattern (a solid signal fill has no safe foreground except the
// accent's own paired token): a plan-included box paints an alpha TINT of the tier colour with the
// glyph in the tier's textColor; an admin-granted box is solid accent with the accent's paired
// accent-text glyph — so "came with the plan" and "granted as an exception" read differently at a
// glance, which the broken var()+hex concatenations had silently erased.
function FeatureRow({ label, locked, granted, isCore, chip, note, color, textColor, onToggle, style }) {
  const isOn = locked || granted
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={isOn}
      disabled={locked}
      onClick={onToggle}
      style={{
        display: 'flex', alignItems: 'center', gap: 10, width: '100%', textAlign: 'left',
        font: 'inherit', background: 'var(--theme-bg)', borderRadius: 'var(--radius-sm)', padding: '6px 8px',
        border: `1px solid ${locked ? colorTint(color, 15) : granted ? colorTint('var(--theme-accent)', 35) : 'var(--theme-border)'}`,
        cursor: locked ? 'default' : 'pointer', transition: 'border-color 0.15s',
        ...style,
      }}
    >
      <span aria-hidden="true" style={{
        width: 16, height: 16, borderRadius: 'var(--radius-xs)', flexShrink: 0,
        background: !isOn ? 'transparent' : locked ? colorTint(color, 22) : 'var(--theme-accent)',
        border: `2px solid ${!isOn ? 'var(--theme-text3)' : locked ? color : 'var(--theme-accent)'}`,
        display: 'flex', alignItems: 'center', justifyContent: 'center', transition: 'all 0.15s',
        opacity: isCore ? 0.45 : 1,
      }}>
        {isOn && (
          <span style={{ color: locked ? textColor : 'var(--theme-accent-text)', fontSize: 10, fontWeight: 900, lineHeight: 1 }}>✓</span>
        )}
      </span>
      <span style={{ flex: 1, minWidth: 0 }}>
        <span style={{ fontSize: 12, color: isOn ? 'var(--theme-text1)' : 'var(--theme-text2)' }}>{label}</span>
        {chip && (
          <span style={{
            marginLeft: 6, fontSize: 10, fontWeight: 700,
            color: chip.granted ? 'var(--theme-accent-ink)' : textColor,
            background: colorTint(chip.granted ? 'var(--theme-accent)' : color, 12),
            border: `1px solid ${colorTint(chip.granted ? 'var(--theme-accent)' : color, 30)}`,
            borderRadius: 'var(--radius-xs)', padding: '1px 5px', verticalAlign: 'middle', whiteSpace: 'nowrap',
          }}>{chip.label}</span>
        )}
        {note && <span style={{ marginLeft: 6, fontSize: 11, color: 'var(--theme-text3)' }}>{note}</span>}
      </span>
    </button>
  )
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
  // Only IMS has tiers, so the header always reflects clients.plan. It used to fall back to
  // pos_plan/hr_plan for module-only clients, which showed a tier neither module actually sells.
  const activePlan   = client.plan || 'starter'
  const activeColor  = activePlan === 'pro' ? 'var(--theme-accent-ink)' : activePlan === 'growth' ? 'var(--theme-green-text)' : 'var(--theme-text3)'
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
    <Modal onClose={onClose} title={`Feature Access · Crest ${activeModule}`} maxWidth={1120}>
      <p style={{ margin: '-10px 0 14px', fontSize: 12, color: 'var(--theme-text2)' }}>
        {client.name} ·{' '}
        <span style={{ fontWeight: 700, color: activeColor }}>{activeModule} {activeLabel} Plan</span>
        {(imsEnabled || posEnabled) && (
          // "uncheck to revoke" was a lie the data model cannot keep: toggleFeat only ever writes
          // true or null, and plan-included rows are not clickable at all. Say what it does.
          <span style={{ marginLeft: 10, fontSize: 11, color: 'var(--theme-text3)' }}>
            Check to grant a feature above this client's plan. Plan features are always on — change the plan in Billing to remove them.
          </span>
        )}
      </p>

      {/* Crest Suite Pro — a separate gating axis (client.suite_plan) from the module plan
          grids below. Not part of FEATURE_GROUPS since it doesn't key off clientPlan's rank
          system at all.

          Requires IMS only. It used to require IMS *and* HR, which made sense when Suite was a
          bundle containing all three modules; as an add-on it has an IMS floor and adapts to
          whatever else the client runs (SuiteGate's own requireModules varies per feature).

          Sits ABOVE the plan grid (2026-08-12): being last read as "least important" rather
          than "different axis". Leading with it states the distinction structurally —
          everything below is one plan ladder, this is not on that ladder. */}
      {imsEnabled && (() => {
        // One tier. suite_plan was starter|growth|pro, but both gates were minTier="growth",
        // so Suite Starter unlocked nothing and Suite Pro added nothing over Suite Growth.
        const locked = client.suite_plan === 'pro'
        const suiteFeatures = [
          { key: 'owner_dashboard', label: 'Owner Dashboard' },
          { key: 'monthly_owner_report', label: 'Monthly Owner/Manager Report' },
          { key: 'multi_outlet', label: 'Multi-Outlet Group Console' },
          { key: 'demand_forecast', label: 'Demand Forecast' },
          { key: 'fixed_asset_register', label: 'Fixed Assets' },
          { key: 'consolidated_pnl', label: 'Consolidated P&L' },
        ]
        return (
          <div style={{ marginBottom: 14 }}>
            {/* Flat accent wash + border, the same treatment ClientDrawer's Archive panel uses.
                No gradient — Cards rule. */}
            <div style={{
              background: 'rgba(201,168,76,0.05)', border: '1px solid rgba(201,168,76,0.25)',
              borderRadius: 'var(--radius-lg)', padding: '12px 14px',
            }}>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap', marginBottom: 9 }}>
                <span style={{ fontSize: 10, fontWeight: 800, color: 'var(--theme-accent-ink)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>
                  Crest Suite Pro
                </span>
                <span style={{ fontSize: 11, color: 'var(--theme-text2)' }}>
                  Sold as an add-on, not by IMS plan — a Pro client does <strong style={{ color: 'var(--theme-text1)' }}>not</strong> get these.
                  Switch it on in the Billing tab, or grant one here as an exception.
                </span>
              </div>
              {/* Side by side rather than stacked: a handful of items in a 1120px modal have no
                  reason to run down the left edge, and the row keeps the band shallow enough
                  that the plan grid still starts above the fold. */}
              <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                {suiteFeatures.map(({ key, label }) => {
                  const isAdminGranted = !locked && flags[key] === true
                  return (
                    <FeatureRow
                      key={key}
                      label={label}
                      locked={locked}
                      granted={isAdminGranted}
                      chip={locked ? { label: 'Suite Pro' } : isAdminGranted ? { label: 'Override', granted: true } : null}
                      note={!client.suite_plan && !isAdminGranted ? 'Not subscribed to Suite' : null}
                      color="var(--theme-accent)"
                      textColor="var(--theme-accent-ink)"
                      onToggle={() => !locked && toggleFeat(key, isAdminGranted)}
                      style={{ flex: '1 1 300px', maxWidth: 420, width: 'auto' }}
                    />
                  )
                })}
              </div>
            </div>
          </div>
        )
      })()}

      {/* No active module — feature grants would be inert */}
      {!imsEnabled && !posEnabled ? (
        <div style={{ padding: '32px 0', textAlign: 'center' }}>
          <p style={{ margin: 0, fontSize: 13, color: 'var(--theme-text1)', fontWeight: 600 }}>Enable a module to manage feature access</p>
          <p style={{ margin: '6px 0 0', fontSize: 12, color: 'var(--theme-text2)', lineHeight: 1.5 }}>
            {hrEnabled && <>This client is on <strong>Crest HR</strong> (<span style={{ color: activeColor, fontWeight: 700 }}>{activeLabel}</span>) — HR access is set by its plan tier in the Modules tab, not per-feature.<br/></>}
            Enable <strong>Crest IMS</strong> or <strong>Crest POS</strong> from the client card to manage feature access here.
          </p>
        </div>
      ) : !imsEnabled ? (
      /* POS-only client — just show POS feature flags */
      <div style={{ paddingBottom: 8 }}>
        <p style={{ margin: '0 0 14px', fontSize: 12, color: 'var(--theme-text2)' }}>POS features — included with the Crest POS module.</p>
        {loading ? <p style={{ color: 'var(--theme-text2)', fontSize: 13 }}>Loading…</p>
          : [
              { key: 'menu_pricing',   label: 'Menu Pricing' },
              { key: 'guest_ordering', label: 'Guest QR Self-Ordering', moduleIncluded: true },
              { key: 'loyalty',        label: 'Loyalty & Rewards', moduleIncluded: true },
            ].map(feat => {
              // POS has no tiers, so its features come with the module. guest_ordering used to
              // check pos_plan against a Pro tier POS never sold; menu_pricing keeps its
              // original always-a-toggle behavior (pre-existing, unrelated).
              const locked = !!feat.moduleIncluded && posEnabled
              const isAdminGranted = !locked && flags[feat.key] === true
              return (
                <FeatureRow
                  key={feat.key}
                  label={feat.label}
                  locked={locked}
                  granted={isAdminGranted}
                  chip={locked ? { label: 'Plan' } : isAdminGranted ? { label: 'Override', granted: true } : null}
                  color="var(--theme-purple)"
                  textColor="var(--theme-purple-text)"
                  onToggle={() => !locked && toggleFeat(feat.key, isAdminGranted)}
                  style={{ maxWidth: 260, width: 'auto', marginBottom: 5 }}
                />
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
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, minmax(0, 1fr))', gap: '0 14px', alignItems: 'start', overflowX: 'auto' }}>
        {loading ? <p style={{ color: 'var(--theme-text2)', fontSize: 13, gridColumn: '1/-1' }}>Loading…</p> : FEATURE_GROUPS.map(group => {
          const planIncluded = isPlanIncluded(group.tier, clientPlan, client.pos_enabled)
          return (
            <div key={group.tier} style={{ marginBottom: 16 }}>
              {/* Group header */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8, flexWrap: 'wrap' }}>
                <span style={{ fontSize: 10, fontWeight: 800, color: group.textColor, textTransform: 'uppercase', letterSpacing: '0.08em' }}>{group.label}</span>
                {/* The POS column is not on the IMS plan ladder, so it must not borrow the IMS
                    plan's label — it read "Included in Pro" for a client whose POS access has
                    nothing to do with their IMS tier. */}
                {planIncluded && group.tier !== 'core' && (
                  <span style={{ fontSize: 10, color: group.textColor, background: colorTint(group.color, 12), border: `1px solid ${colorTint(group.color, 30)}`, borderRadius: 'var(--radius-xs)', padding: '1px 6px' }}>
                    {group.tier === 'pos' ? 'Module enabled' : `Included in ${planLabel}`}
                  </span>
                )}
                {!planIncluded && (
                  <span style={{ fontSize: 10, color: 'var(--theme-text3)', background: 'var(--theme-card)', border: '1px solid var(--theme-text3)', borderRadius: 'var(--radius-xs)', padding: '1px 6px' }}>
                    {group.tier === 'pos' ? 'POS is off — check to override' : 'Not in plan — check to override'}
                  </span>
                )}
              </div>

              {/* Feature list — single column, one per plan group column */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
                {group.features.map(feat => {
                  const isCore = feat.key === null
                  // Most features check the IMS plan (planIncluded, computed once per group
                  // above); a feature with planSource: 'pos' checks the POS module instead.
                  // POS is flat, so that check is simply "is the module on".
                  const featPlanIncluded = feat.planSource === 'pos'
                    ? !!client.pos_enabled
                    : planIncluded
                  const locked = isCore || featPlanIncluded  // plan features are always on, non-clickable
                  const isAdminGranted = !locked && flags[feat.key] === true
                  return (
                    <FeatureRow
                      key={feat.key || feat.label}
                      label={feat.label}
                      locked={locked}
                      granted={isAdminGranted}
                      isCore={isCore}
                      chip={locked && !isCore ? { label: 'Plan' } : isAdminGranted ? { label: 'Override', granted: true } : null}
                      color={group.color}
                      textColor={group.textColor}
                      onToggle={() => !locked && feat.key && toggleFeat(feat.key, isAdminGranted)}
                    />
                  )
                })}
              </div>
            </div>
          )
        })}
      </div>
      )}

      {/* Footer */}
      <div style={{ paddingTop: 12, borderTop: '1px solid var(--theme-border)', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <span role={msg.startsWith('error:') ? 'alert' : 'status'}
          style={{ fontSize: 12, color: msg.startsWith('ok:') ? 'var(--theme-green-text)' : msg.startsWith('error:') ? 'var(--theme-red-text)' : 'transparent' }}>
          {msg.replace(/^(ok|error):/, '') || '·'}
        </span>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn btn-ghost" style={{ fontSize: 12 }} onClick={onClose}>Close</button>
          {(imsEnabled || posEnabled) && (
            <button className="btn btn-primary" style={{ fontSize: 12 }} onClick={handleSave} disabled={saving}>
              {saving ? 'Saving…' : 'Save'}
            </button>
          )}
        </div>
      </div>
    </Modal>
  )
}
