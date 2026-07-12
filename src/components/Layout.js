import { NavLink, Outlet, useNavigate, useLocation } from 'react-router-dom'
import { useState, useEffect, useRef, useMemo } from 'react'
import { useAuth } from '../context/AuthContext'
import { useSettings } from '../context/SettingsContext'
import { supabase } from '../supabaseClient'
import { getSubStatus } from '../utils/subscription'
import RailTip from './RailTip'
import CommandPalette from './CommandPalette'
import { useNavBadgeCounts } from '../shared/hooks/useNavBadgeCounts'
import './Layout.css'

// minPlan: 'growth' | 'pro' — used for lock icon and tier badge
const NAV = [
  { to: '/dashboard',        label: 'Dashboard',        icon: '▦' },
  { to: '/periods',          label: 'Periods',           icon: '◷' },
  { to: '/items',            label: 'Item Master',       icon: '≡' },
  { to: '/vendors',          label: 'Vendors',           icon: '⊙' },
  { to: '/purchases',        label: 'Purchases',         icon: '↓' },
  { to: '/purchase-orders',  label: 'Purchase Orders',   icon: '◫', featureKey: 'purchase_orders', minPlan: 'growth' },
  { to: '/stock',            label: 'Stock Count',       icon: '⊞' },
  { to: '/requisitions',     label: 'Requisitions',      icon: '↔', featureKey: 'requisitions',    minPlan: 'growth' },
  { to: '/sales',            label: 'Sales Entry',       icon: '↑', featureKey: 'sales_entry',     minPlan: 'starter' },
  { to: '/recipes',          label: 'Recipe Costing',    icon: '◈', featureKey: 'recipe_costing',  minPlan: 'growth' },
  { to: '/menu-pricing',     label: 'Menu Pricing',      icon: '₨', featureKey: 'menu_pricing',    minPlan: 'starter' },
  { to: '/menu-engineering', label: 'Menu Engineering',  icon: '◈', featureKey: 'menu_engineering',minPlan: 'pro' },
  { to: '/overheads',        label: 'Overheads',         icon: '₿', featureKey: 'overheads',       minPlan: 'pro' },
]

// cat: which characteristic report-group the item renders under in the sidebar
const REPORTS = [
  // Summaries & planning
  { to: '/summary',              label: 'Monthly Summary',      icon: '◻', featureKey: 'monthly_summary',   cat: 'summary' },
  { to: '/annual-summary',       label: 'Annual Summary',       icon: '◫', featureKey: 'annual_summary',    cat: 'summary' },
  { to: '/period-comparison',    label: 'Period Comparison',    icon: '⇄', featureKey: 'period_comparison', cat: 'summary', minPlan: 'pro' },
  { to: '/budget',               label: 'Budget vs Actual',     icon: '◎', featureKey: 'budget_vs_actual',  cat: 'summary', minPlan: 'growth' },
  // Stock & variance
  { to: '/stock-report',         label: 'Stock Report',         icon: '▤', featureKey: 'stock_report',         cat: 'stock' },
  { to: '/reorder',              label: 'Reorder Report',       icon: '↻', featureKey: 'reorder_report',       cat: 'stock' },
  { to: '/demand-forecast',      label: 'Demand Forecast',      icon: '↗', featureKey: 'demand_forecast',      cat: 'stock', minPlan: 'pro' },
  { to: '/wastage-report',       label: 'Wastage Report',       icon: '⚠', featureKey: 'wastage_report',       cat: 'stock' },
  { to: '/dead-stock',           label: 'Dead Stock',           icon: '⊘', featureKey: 'dead_stock',           cat: 'stock', minPlan: 'growth' },
  { to: '/variance',             label: 'Variance Report',      icon: '△', featureKey: 'variance_report',      cat: 'stock', minPlan: 'growth' },
  { to: '/fifo',                 label: 'FIFO / Expiry',        icon: '◷', featureKey: 'fifo_report',           cat: 'stock', minPlan: 'pro' },
  { to: '/theoretical-variance', label: 'Theoretical Variance', icon: '⊿', featureKey: 'theoretical_variance', cat: 'stock', minPlan: 'pro' },
  { to: '/shrinkage',            label: 'Shrinkage Report',     icon: '⚠', featureKey: 'shrinkage_report',     cat: 'stock', minPlan: 'pro' },
  // Money & tax
  { to: '/vat-report',           label: 'VAT Report',           icon: '₨', featureKey: 'vat_report',           cat: 'money' },
  { to: '/non-vat-report',      label: 'Non-VAT Report',       icon: '₨', featureKey: 'non_vat_report',       cat: 'money' },
  { to: '/payments',             label: 'Payment Summary',      icon: '⊕', featureKey: 'payment_summary',      cat: 'money', minPlan: 'starter' },
  { to: '/payables',             label: 'Outstanding Payables', icon: '₨', featureKey: 'outstanding_payables', cat: 'money', minPlan: 'growth' },
  { to: '/purchase-one-lakh-report', label: 'Purchase 1L+ Report', icon: '⚑', featureKey: 'vat_report',       cat: 'money' },
  // Menu & vendors
  { to: '/best-sellers',         label: 'Best & Worst Sellers', icon: '▲', featureKey: 'best_sellers',   cat: 'menu', minPlan: 'growth' },
  { to: '/recipe-margin',        label: 'Recipe Margin',        icon: '◈', featureKey: 'recipe_margin',  cat: 'menu', minPlan: 'growth' },
  { to: '/combo-builder',        label: 'Combo Builder',        icon: '⋈', featureKey: 'combo_builder',  cat: 'menu', minPlan: 'growth' },
  { to: '/menu-repricing',       label: 'Menu Repricing',       icon: '↗', featureKey: 'menu_repricing', cat: 'menu', minPlan: 'growth' },
  { to: '/supplier-prices',      label: 'Price Tracker',        icon: '₨', featureKey: 'price_tracker',  cat: 'menu', minPlan: 'pro' },
  { to: '/vendors-report',       label: 'Vendor Report',        icon: '⊙', featureKey: 'vendor_report',  cat: 'menu', minPlan: 'pro' },
]

// Collapsible nav groups for the IMS sidebar (Dashboard stays pinned above; Settings below).
// Reports are split by characteristic instead of one 20+-item list — open just the slice you need.
const IMS_GROUPS = [
  { key: 'ops',             label: 'Operations',       items: NAV.slice(1, 9) }, // Periods … Sales Entry
  { key: 'costing',         label: 'Costing',          items: NAV.slice(9) },    // Recipe Costing … Overheads
  { key: 'reports-summary', label: 'Summary Reports',  items: REPORTS.filter(r => r.cat === 'summary') },
  { key: 'reports-stock',   label: 'Stock Reports',    items: REPORTS.filter(r => r.cat === 'stock') },
  { key: 'reports-money',   label: 'Finance Reports',  items: REPORTS.filter(r => r.cat === 'money') },
  { key: 'reports-menu',    label: 'Menu & Vendors',   items: REPORTS.filter(r => r.cat === 'menu') },
]
const HR_DASHBOARD = { to: '/hr/dashboard', label: 'HR Dashboard', icon: '▦' }

const POS_GROUPS = [
  { key: 'pos-setup', label: null, items: [
    { to: '/pos', label: 'POS Setup', icon: '⊡', minPosRole: 'manager' },
  ]},
  { key: 'pos-floor', label: 'Floor', items: [
    { to: '/pos/orders', label: 'Orders', icon: '◉', minPosRole: 'staff' },
    { to: '/pos/kds', label: 'Kitchen Display', icon: '▥', minPosRole: 'staff' },
    { to: '/pos/tables', label: 'Tables', icon: '⊞', minPosRole: 'supervisor' },
    { to: '/pos/customers', label: 'Customers', icon: '👤', minPosRole: 'supervisor' },
    { to: '/pos/shifts', label: 'Shifts', icon: '⏱', minPosRole: 'supervisor' },
  ]},
  { key: 'pos-menu', label: 'Menu', items: [
    { to: '/menu-pricing', label: 'Menu Pricing', icon: '₨', featureKey: 'menu_pricing', minPlan: 'starter', minPosRole: 'manager' },
  ]},
  { key: 'pos-reports', label: 'Reports', items: [
    { to: '/pos/exceptions', label: 'Exceptions', icon: '⚠', minPosRole: 'manager' },
    { to: '/pos/credit-notes', label: 'Credit Notes', icon: '↩', minPosRole: 'manager' },
    { to: '/pos/sales-report', label: 'Sales Report', icon: '▤', minPosRole: 'manager' },
    { to: '/pos/kot-log', label: 'KOT Log', icon: '🧾', minPosRole: 'manager' },
    { to: '/pos/covers-report', label: 'Covers Report', icon: '🍽', minPosRole: 'manager' },
  ]},
  { key: 'pos-admin', label: 'Admin', items: [
    { to: '/pos/staff', label: 'POS Staff', icon: '👥', minPosRole: 'manager' },
  ]},
]

const HR_GROUPS = [
  { key: 'hr-people', label: 'People', items: [
    { to: '/hr/employees',  label: 'Employees',        icon: '👤' },
    { to: '/hr/pay-setup',  label: 'Pay Setup',        icon: '⚙'  },
    { to: '/hr/holidays',   label: 'Holiday Calendar', icon: '📆' },
  ]},
  { key: 'hr-attendance', label: 'Attendance', items: [
    { to: '/hr/roster',     label: 'Staff Roster',     icon: '📅' },
    { to: '/hr/attendance', label: 'Attendance',       icon: '🗓️' },
    { to: '/hr/leave',      label: 'Leave',            icon: '🏖️' },
    { to: '/hr/overtime',   label: 'Overtime',         icon: '⏱'  },
  ]},
  { key: 'hr-payroll', label: 'Payroll', items: [
    { to: '/hr/calculation', label: 'Calculation',       icon: '🧮' },
    { to: '/hr/payroll',    label: 'Payroll',            icon: '💵' },
    { to: '/hr/festival',   label: 'Festival Allowance', icon: '🎉' },
    { to: '/hr/incentives', label: 'Incentives / Bonus', icon: '🎁' },
    { to: '/hr/advances',   label: 'Advances & Loans',   icon: '💳' },
    { to: '/hr/tada',       label: 'TADA Claims',        icon: '🧳' },
  ]},
  { key: 'hr-reports', label: 'Reports', items: [
    { to: '/hr/reports',    label: 'HR Reports',       icon: '📊' },
    { to: '/hr/gratuity',   label: 'Gratuity',         icon: '💰' },
    { to: '/hr/settlement', label: 'Final Settlement', icon: '🧾' },
  ]},
]

export default function Layout() {
  const { profile, isAdmin, plan, hasFeature, clientModules, signOut, adminViewClientId, switchAdminClient,
          isTrial, trialExpired, trialDaysLeft, trialPurgeInDays, subscribeRequested, requestSubscription,
          hasPosAccess, posRole, isOwner } = useAuth()
  const { settings } = useSettings()
  const navigate = useNavigate()
  const clientName = profile?.clients?.name
  const [collapsed, setCollapsed] = useState(false)
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false)
  const [allClients, setAllClients] = useState([])
  const [clientDropdownOpen, setClientDropdownOpen] = useState(false)
  const [pendingTrialCount, setPendingTrialCount] = useState(0)
  const [newTrialCount, setNewTrialCount] = useState(0)
  const [subscribing, setSubscribing] = useState(false)
  const dropdownRef = useRef(null)
  const location = useLocation()

  // Collapsible nav groups: defaults — Operations/Costing/HR open, report groups collapsed.
  const [openGroups, setOpenGroups] = useState(() => {
    try { return JSON.parse(localStorage.getItem('crest_nav_groups')) || {} } catch { return {} }
  })

  // Pinned favorites — an array of `to` paths, same read/try-catch localStorage pattern as
  // openGroups above. Capped at MAX_PINS so the "Pinned" section can't itself grow into the kind
  // of long list it exists to shortcut.
  const [pins, setPins] = useState(() => {
    try { return JSON.parse(localStorage.getItem('crest_nav_pins')) || [] } catch { return [] }
  })
  function groupOpen(key, state = openGroups) {
    if (state[key] !== undefined) return state[key]
    return !key.startsWith('reports') // report groups start collapsed
  }
  function toggleGroup(key) {
    setOpenGroups(prev => {
      const next = { ...prev, [key]: !groupOpen(key, prev) }
      localStorage.setItem('crest_nav_groups', JSON.stringify(next))
      return next
    })
  }

  // Rail + flyout panel: the icon rail shows one button per module; the 220px panel shows only
  // the selected module's links. The panel follows the route (navigating into /hr selects the HR
  // panel), but a rail click switches panels without navigating.
  const [activePanel, setActivePanel] = useState(null) // resolved against module visibility below
  useEffect(() => {
    const p = location.pathname
    if (p === '/menu-pricing') { setActivePanel(prev => prev === 'pos' ? 'pos' : 'ims'); return } // shared IMS/POS route — don't yank a POS user over to IMS
    if (p.startsWith('/pos')) setActivePanel('pos')
    else if (p.startsWith('/hr')) setActivePanel('hr')
    else if (p.startsWith('/admin')) setActivePanel('admin')
    else if ([...NAV, ...REPORTS].some(i => p === i.to || p.startsWith(i.to + '/')) || p === '/settings') {
      // /periods and /settings also live in the admin panel — don't switch away from it
      setActivePanel(prev => (prev === 'admin' && (p === '/periods' || p === '/settings')) ? 'admin' : 'ims')
    }
    // any other route (/help, /pricing, …) keeps the current panel
  }, [location.pathname])

  useEffect(() => {
    if (!clientDropdownOpen) return
    function handleOutsideClick(e) {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target)) {
        setClientDropdownOpen(false)
      }
    }
    document.addEventListener('mousedown', handleOutsideClick)
    return () => document.removeEventListener('mousedown', handleOutsideClick)
  }, [clientDropdownOpen])

  useEffect(() => {
    if (!isAdmin) return
    supabase.from('clients')
      .select('id, name, trial_ends_at, subscription_ends_at, ims_ends_at, hr_ends_at, pos_ends_at, is_trial, trial_expires_at, trial_start_date, subscribe_requested')
      .order('name')
      .then(({ data }) => {
        setAllClients(data || [])
        setPendingTrialCount((data || []).filter(c => c.subscribe_requested).length)
        const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()
        setNewTrialCount((data || []).filter(c => c.is_trial && c.trial_start_date && c.trial_start_date >= sevenDaysAgo).length)
      })
  }, [isAdmin]) // eslint-disable-line react-hooks/exhaustive-deps

  async function handleSignOut() {
    const isPosDevice = !!localStorage.getItem('pos_device_client_id')
    await signOut()
    navigate(isPosDevice && posRole ? '/pos/login' : '/login')
  }

  // Single source of truth for "can this user see this destination" — used by the rendered nav,
  // the command palette's search index, and pinned favorites, so gating can never drift between
  // them as new items get added later.
  function isItemVisible(item) {
    if (item.featureKey && !hasFeature(item.featureKey)) return false
    if (item.minPosRole && !hasPosAccess(item.minPosRole)) return false
    return true
  }

  function unlockedItems(items) {
    return items.filter(isItemVisible)
  }

  const MAX_PINS = 8
  function togglePin(e, to) {
    e.preventDefault()
    e.stopPropagation()
    setPins(prev => {
      const isPinned = prev.includes(to)
      const next = isPinned ? prev.filter(p => p !== to) : (prev.length >= MAX_PINS ? prev : [...prev, to])
      localStorage.setItem('crest_nav_pins', JSON.stringify(next))
      return next
    })
  }

  function renderNavItem(item, { pinnable = true } = {}) {
    const isPinned = pins.includes(item.to)
    return (
      <NavLink key={item.to} to={item.to}
        className={({ isActive }) => `sidebar-link${isActive ? ' sidebar-link--active' : ''}`}
        onClick={() => setMobileSidebarOpen(false)}>
        <span className="sidebar-icon">{item.icon}</span>
        <span style={{ flex: 1 }}>{item.label}</span>
        {pinnable && (
          <span
            className={`sidebar-pin${isPinned ? ' sidebar-pin--active' : ''}`}
            onClick={e => togglePin(e, item.to)}
            title={isPinned ? 'Unpin' : 'Pin to top'}
          >
            {isPinned ? '★' : '☆'}
          </span>
        )}
      </NavLink>
    )
  }

  // Collapsible group: header (label · count · chevron) + its items. The group containing
  // the current route is force-open so you always see where you are.
  function renderGroup(group) {
    const items = unlockedItems(group.items)
    if (items.length === 0) return null
    if (!group.label) return <div key={group.key}>{items.map(renderNavItem)}</div> // unlabeled groups render flat, no header
    const hasActive = items.some(i => location.pathname === i.to || location.pathname.startsWith(i.to + '/'))
    const open = groupOpen(group.key) || hasActive
    return (
      <div key={group.key}>
        <button
          onClick={() => toggleGroup(group.key)}
          className="sidebar-group-header"
          style={{
            display: 'flex', alignItems: 'center', justifyContent: 'space-between', width: '100%',
            background: 'none', border: 'none', cursor: 'pointer', padding: '9px 14px 5px',
            color: 'var(--theme-text3)', fontSize: 'var(--font-size-group-label)', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em',
            fontFamily: 'inherit',
          }}
        >
          <span>{group.label}</span>
          <span style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
            <span style={{ fontSize: 'var(--font-size-micro)', color: 'var(--theme-text3)', fontWeight: 600 }}>{items.length}</span>
            <span style={{ fontSize: 'var(--font-size-chevron)', color: 'var(--theme-text3)', display: 'inline-block', transform: open ? 'rotate(90deg)' : 'none', transition: 'transform var(--motion-fast) var(--ease-standard)' }}>▶</span>
          </span>
        </button>
        {open && items.map(renderNavItem)}
      </div>
    )
  }

  // Which module panels exist for this user, and which one is showing.
  // activePanel (route-synced) is resolved against visibility — if it points at a module this
  // user can't see (or nothing is selected yet), fall back to the first available panel.
  // IMS and HR are owner/admin-only panels — a POS PIN staff login (posRole set, not owner)
  // works the floor, and RLS blocks it from the IMS/HR tables anyway; don't show nav to pages
  // that would render empty.
  const imsVisible = clientModules.ims && (!isAdmin || adminViewClientId) && (isAdmin || isOwner)
  const hrVisible  = clientModules.hr  && (!isAdmin || adminViewClientId) && (isAdmin || isOwner)
  const posVisible = clientModules.pos && (!isAdmin || adminViewClientId) && (isAdmin || posRole || isOwner)
  const panelOrder = [
    isAdmin && 'admin',
    imsVisible && 'ims',
    hrVisible && 'hr',
    posVisible && 'pos',
  ].filter(Boolean)
  const panel = panelOrder.includes(activePanel) ? activePanel : panelOrder[0]
  const PANEL_TITLES = { admin: 'Admin', ims: 'Crest IMS', hr: 'Crest HR', pos: 'Crest POS' }
  const { hrPending, posPending } = useNavBadgeCounts(hrVisible, posVisible)

  // Top "Dashboard" nav label — mirrors ClientDashboard.jsx's own dashTitle exactly (admin always
  // sees "Admin Dashboard"; a real client with 2-3 modules sees generic "Dashboard"; a client with
  // exactly one module sees that module's own title) so the sidebar link never promises a
  // different page than the one it actually opens.
  const dashModuleCount = [clientModules.ims, clientModules.hr, clientModules.pos].filter(Boolean).length
  const dashLabel = isAdmin ? 'Admin Dashboard'
    : dashModuleCount > 1 ? 'Dashboard'
    : clientModules.ims ? 'Inventory Dashboard'
    : clientModules.hr  ? 'HR Overview'
    : clientModules.pos ? 'POS Dashboard'
    : 'Dashboard'
  const dashNavItem = { ...NAV[0], label: dashLabel }

  // ── Command palette — flat search across every destination, gated by the exact same
  // isItemVisible() predicate the rendered nav uses (defined below; hoisted, safe to reference
  // here). Rebuilds only when what this user can see changes, not on every render/keystroke —
  // the palette component itself does the query filtering. Panel-switching after navigating is
  // already handled by the existing location.pathname effect above, so items don't need a
  // 'panel' tag.
  const [paletteOpen, setPaletteOpen] = useState(false)
  const paletteItems = useMemo(() => {
    const all = [
      dashNavItem,
      { to: '/owner-dashboard', label: 'Owner Dashboard', icon: '◆' },
      ...NAV.slice(1),
      ...REPORTS,
      ...(hrVisible ? [HR_DASHBOARD, ...HR_GROUPS.flatMap(g => g.items)] : []),
      ...(posVisible ? POS_GROUPS.flatMap(g => g.items) : []),
      ...(isAdmin ? [
        { to: '/admin/clients', label: 'Clients', icon: '⊛' },
        { to: '/admin/audit', label: 'Audit Log', icon: '◈' },
      ] : []),
      { to: '/settings', label: 'Settings', icon: '⚙' },
    ]
    const seen = new Set()
    return all.filter(item => isItemVisible(item) && !seen.has(item.to) && seen.add(item.to))
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hrVisible, posVisible, isAdmin, plan, dashLabel])

  useEffect(() => {
    function onKeyDown(e) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setPaletteOpen(o => !o)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  function handlePaletteSelect(item) {
    setPaletteOpen(false)
    setMobileSidebarOpen(false)
    navigate(item.to)
  }

  // Pinned items resolved against paletteItems (already isItemVisible-filtered) rather than
  // rendered fresh from `pins` alone — so a pin whose underlying page has since been locked by a
  // plan downgrade silently drops out instead of rendering a dead link.
  const pinnedItems = pins.map(to => paletteItems.find(i => i.to === to)).filter(Boolean)
  function renderPinnedGroup() {
    if (pinnedItems.length === 0) return null
    return (
      <div>
        <div style={{
          padding: '9px 14px 5px', color: 'var(--theme-text3)', fontSize: 'var(--font-size-group-label)',
          fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em',
        }}>
          Pinned
        </div>
        {pinnedItems.map(item => renderNavItem(item))}
      </div>
    )
  }

  function openPanel(key) {
    setActivePanel(key)
    setCollapsed(false)
  }

  function renderUpgradeTeaser() {
    if (isAdmin || plan === 'pro') return null
    const nextTier  = plan === 'growth' ? 'pro' : 'growth'
    const tierLabel = nextTier === 'growth' ? 'Growth' : 'Pro'
    const tierColor = nextTier === 'growth' ? '#34d399' : '#c9a84c'
    const locked = [...NAV.slice(1), ...REPORTS].filter(
      item => item.featureKey && !hasFeature(item.featureKey) && item.minPlan === nextTier
    )
    if (locked.length === 0) return null
    const shown = locked.slice(0, 5)
    const more  = locked.length - shown.length

    return (
      <div style={{ margin: '4px 8px 2px', border: `1px solid ${tierColor}25`, borderRadius: 'var(--radius-lg)', padding: '10px 12px', background: `${tierColor}07` }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 7 }}>
          <span style={{ fontSize: 9, fontWeight: 800, color: tierColor, letterSpacing: '0.08em', textTransform: 'uppercase' }}>{tierLabel} Plan</span>
          <span style={{ fontSize: 9, color: '#4b5563' }}>{locked.length} features</span>
        </div>
        {shown.map(item => (
          <div key={item.to} style={{ fontSize: 11, color: '#6b7280', display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
            <span style={{ color: tierColor, fontSize: 10, fontWeight: 700 }}>+</span>
            <span>{item.label}</span>
          </div>
        ))}
        {more > 0 && <div style={{ fontSize: 11, color: '#4b5563', marginTop: 2, paddingLeft: 16 }}>and {more} more…</div>}
        <button
          onClick={() => navigate('/pricing')}
          style={{ marginTop: 10, width: '100%', fontSize: 10, fontWeight: 700, color: tierColor, background: `${tierColor}15`, border: `1px solid ${tierColor}35`, borderRadius: 5, padding: '5px 0', cursor: 'pointer', letterSpacing: '0.04em' }}
        >
          Upgrade to {tierLabel} ↑
        </button>
      </div>
    )
  }

  // Module switcher tabs — one entry per module this user can see. Rendered as a horizontal pill
  // row when expanded, an icon column when collapsed (CSS flex-direction flip, same buttons).
  const moduleTabs = [
    isAdmin && {
      key: 'admin', label: 'Admin', icon: '⊛', tip: 'Admin',
      dot: pendingTrialCount > 0 ? '#f87171' : newTrialCount > 0 ? '#f59e0b' : null,
    },
    imsVisible && { key: 'ims', label: 'IMS', icon: '▤', tip: 'Crest IMS', dot: null },
    hrVisible && {
      key: 'hr', label: 'HR', icon: '👥', dot: hrPending > 0 ? 'var(--theme-amber)' : null,
      tip: hrPending > 0 ? `Crest HR — ${hrPending} pending` : 'Crest HR',
    },
    posVisible && {
      key: 'pos', label: 'POS', icon: '◉', dot: posPending > 0 ? 'var(--theme-amber)' : null,
      tip: posPending > 0 ? `Crest POS — ${posPending} pending` : 'Crest POS',
    },
  ].filter(Boolean)

  return (
    <div className="layout-root">
      {mobileSidebarOpen && <div className="sidebar-overlay" onClick={() => setMobileSidebarOpen(false)} />}
      <div className={`sidebar-wrap${mobileSidebarOpen ? ' mobile-open' : ''}${collapsed ? ' sidebar-wrap--collapsed' : ''}`}>
        <div className="sidebar-shell">

          {/* Brand — logo + wordmark + search trigger. Always visible; text hides when collapsed
              (CSS), same effect as today's rail-only collapsed state without unmounting anything. */}
          <div className="sidebar-brand">
            <div className="sidebar-brand-icon" title={settings?.app_name || 'Crest'}>
              {settings?.logo_url
                ? <img src={settings.logo_url} alt="logo" style={{ width: 28, height: 28, objectFit: 'contain', borderRadius: 4 }} />
                : <span aria-label="Crest" style={{ fontSize: 22, lineHeight: 1, color: 'var(--theme-accent)' }}>⬢</span>}
            </div>
            <div className="sidebar-brand-text">
              <div className="sidebar-brand-name">{settings?.app_name || 'Crest'}</div>
              <div className="sidebar-brand-sub">{PANEL_TITLES[panel] || 'Crest Inventory'}</div>
            </div>
            <button className="sidebar-search-btn" onClick={() => setPaletteOpen(true)} title="Search pages (Ctrl+K)">
              <span style={{ fontSize: 13 }}>⌕</span>
              <span className="sidebar-search-label">Ctrl K</span>
            </button>
          </div>

          {/* Module switcher — hidden entirely for a single-module user (one pill reads as broken
              UI, same case where today's rail just shows that one module's icon alone). */}
          {moduleTabs.length > 1 && (
            <div className="module-switcher">
              {moduleTabs.map(t => (
                <RailTip key={t.key} label={t.tip}>
                  <button
                    className={`module-tab${panel === t.key && !collapsed ? ' module-tab--active' : ''}`}
                    onClick={() => openPanel(t.key)}
                  >
                    <span className="module-tab-icon" style={{ position: 'relative' }}>
                      {t.icon}
                      {t.dot && (
                        <span style={{
                          position: 'absolute', top: -3, right: -5, width: 9, height: 9, borderRadius: '50%',
                          background: t.dot, boxShadow: '0 0 0 2px var(--theme-sidebar)', animation: 'pulse-dot 1.5s infinite',
                        }} />
                      )}
                    </span>
                    <span className="module-tab-label">{t.label}</span>
                  </button>
                </RailTip>
              ))}
            </div>
          )}

        {/* Everything below hides when collapsed (CSS) — client badge, nav, footer. Kept mounted
            rather than conditionally rendered so scroll position / dropdown state survive a
            collapse/expand toggle instead of resetting. */}
        <div className="sidebar-content">

        {/* Role / client badge */}
        {(() => (
          isAdmin ? (
            <div className="sidebar-client" ref={dropdownRef}>
              <span className="sidebar-client-label">{adminViewClientId ? 'Viewing' : 'Admin View'}</span>

              {/* Custom dropdown trigger */}
              <button
                className="sidebar-dropdown-trigger"
                onClick={() => setClientDropdownOpen(o => !o)}
              >
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>
                  {allClients.find(c => c.id === adminViewClientId)?.name || 'Crest Admin'}
                </span>
                <span className={`sidebar-dropdown-arrow${clientDropdownOpen ? ' sidebar-dropdown-arrow--open' : ''}`}>▼</span>
              </button>

              {/* Subscription badge for selected client */}
              {!clientDropdownOpen && (() => {
                const viewed = allClients.find(c => c.id === adminViewClientId)
                if (!viewed) return null
                const s = getSubStatus(viewed)
                if (!s.label) return null
                return (
                  <span style={{
                    fontSize: 10, fontWeight: 700, padding: '1px 6px', borderRadius: 3,
                    marginTop: 5, display: 'inline-block',
                    color: s.color, background: s.bg, border: `1px solid ${s.border}`
                  }}>
                    {s.label}
                  </span>
                )
              })()}

              {/* Dropdown panel */}
              {clientDropdownOpen && (
                <div className="sidebar-dropdown-panel">
                  <button
                    className={`sidebar-dropdown-item${!adminViewClientId ? ' sidebar-dropdown-item--active' : ''}`}
                    onClick={() => { switchAdminClient(null, ''); setClientDropdownOpen(false) }}
                  >
                    <span>Crest Admin</span>
                  </button>
                  {allClients.map(c => {
                    const s = getSubStatus(c)
                    return (
                      <button
                        key={c.id}
                        className={`sidebar-dropdown-item${c.id === adminViewClientId ? ' sidebar-dropdown-item--active' : ''}`}
                        onClick={() => { switchAdminClient(c.id, c.name); setClientDropdownOpen(false) }}
                      >
                        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.name}</span>
                        {s.label && (
                          <span style={{
                            fontSize: 10, fontWeight: 700, padding: '1px 5px', borderRadius: 3, flexShrink: 0,
                            color: s.color, background: s.bg, border: `1px solid ${s.border}`
                          }}>
                            {s.label}
                          </span>
                        )}
                      </button>
                    )
                  })}
                </div>
              )}
            </div>
          ) : clientName ? (
            <div className="sidebar-client">
              <span className="sidebar-client-label">
                Property ·{' '}
                <span style={{ color: plan === 'pro' ? '#c9a84c' : plan === 'growth' ? '#34d399' : '#6b7280', fontWeight: 700 }}>
                  {plan === 'pro' ? 'Pro' : plan === 'growth' ? 'Growth' : 'Starter'}
                </span>
              </span>
              <span className="sidebar-client-name">{clientName}</span>
              {(() => {
                const s = getSubStatus(profile?.clients)
                if (!s.label) return null
                return (
                  <span style={{
                    fontSize: 10, fontWeight: 700, padding: '1px 6px', borderRadius: 3,
                    marginTop: 5, display: 'inline-block',
                    color: s.color, background: s.bg, border: `1px solid ${s.border}`
                  }}>
                    {s.label}
                  </span>
                )
              })()}
            </div>
          ) : null
        ))()}

        <nav className="sidebar-nav">
          {/* Cross-module — renders regardless of which panel (ims/hr/pos/admin) is active,
              unlike everything below. SuiteGate inside the page itself handles the
              ineligible-viewer upsell, so this link is never hidden or gated here. */}
          {(isAdmin || isOwner) && renderNavItem({ to: '/owner-dashboard', label: 'Owner Dashboard', icon: '◆' })}

          {panel === 'admin' && isAdmin && (
            <>
              {renderNavItem(dashNavItem)}
              {renderPinnedGroup()}
              <NavLink to="/admin/clients"
                className={({ isActive }) => `sidebar-link${isActive ? ' sidebar-link--active' : ''}`}
                style={newTrialCount > 0 && pendingTrialCount === 0 ? {
                  borderLeft: '3px solid #f59e0b',
                  background: 'rgba(245,158,11,0.10)',
                  marginLeft: -3,
                } : {}}
                onClick={() => setMobileSidebarOpen(false)}>
                <span className="sidebar-icon">⊛</span>
                <span style={{ display: 'flex', alignItems: 'center', gap: 6, flex: 1 }}>
                  Clients
                  {pendingTrialCount > 0 && (
                    <span style={{ fontSize: 11, fontWeight: 800, background: '#f87171', color: '#fff', borderRadius: 10, padding: '2px 8px', lineHeight: 1.4 }}
                      title="Clients requesting to subscribe">
                      {pendingTrialCount} want to sub
                    </span>
                  )}
                  {newTrialCount > 0 && (
                    <span style={{ fontSize: 11, fontWeight: 800, background: '#f59e0b', color: '#000', borderRadius: 10, padding: '2px 8px', lineHeight: 1.4 }}
                      title="New trial signups in the last 7 days">
                      {newTrialCount} NEW
                    </span>
                  )}
                </span>
              </NavLink>
              {renderNavItem({ to: '/periods', label: 'Periods', icon: '◷' })}
              {renderNavItem({ to: '/admin/guest-menu', label: 'Guest Menu', icon: '📱' })}
              {renderNavItem({ to: '/admin/audit', label: 'Audit Log', icon: '◈' })}
              {renderNavItem({ to: '/settings', label: 'Settings', icon: '⚙' })}
            </>
          )}

          {panel === 'ims' && imsVisible && (
            <>
              {renderNavItem(dashNavItem)}
              {renderPinnedGroup()}
              {IMS_GROUPS.map(renderGroup)}

              {renderUpgradeTeaser()}

              {!isAdmin && hasFeature('settings') && (
                <>
                  <div className="sidebar-divider" />
                  {renderNavItem({ to: '/settings', label: 'Settings', icon: '⚙' })}
                </>
              )}
            </>
          )}

          {panel === 'hr' && hrVisible && (
            <>
              {renderNavItem(dashNavItem)}
              {renderPinnedGroup()}
              {renderNavItem(HR_DASHBOARD)}
              {HR_GROUPS.map(renderGroup)}
            </>
          )}

          {panel === 'pos' && posVisible && (
            <>
              {renderNavItem(dashNavItem)}
              {renderPinnedGroup()}
              {POS_GROUPS.map(group => renderGroup({ ...group, items: group.items.filter(isItemVisible) }))}
            </>
          )}
        </nav>

        <div className="sidebar-footer">
          {!isAdmin && plan !== 'pro' && (
            <button
              onClick={() => navigate('/pricing')}
              style={{
                width: '100%', fontSize: 10, fontWeight: 700, letterSpacing: '0.04em',
                color: plan === 'growth' ? '#c9a84c' : '#34d399',
                background: plan === 'growth' ? 'rgba(201,168,76,0.1)' : 'rgba(52,211,153,0.1)',
                border: `1px solid ${plan === 'growth' ? 'rgba(201,168,76,0.25)' : 'rgba(52,211,153,0.25)'}`,
                borderRadius: 4, padding: '4px 8px', cursor: 'pointer', marginBottom: 8, display: 'block'
              }}
            >
              {plan === 'growth' ? 'Growth' : 'Starter'} · Upgrade ↑
            </button>
          )}
          <div className="sidebar-user">
            <div className="sidebar-user-name">{profile?.full_name || 'User'}</div>
            <div className="sidebar-user-role">
              {isAdmin ? 'Admin' : isOwner ? 'Owner' : posRole ? `POS · ${posRole.charAt(0).toUpperCase() + posRole.slice(1)}` : 'Client'}
            </div>
          </div>
        </div>
        </div>{/* /sidebar-content */}

        {/* Bottom-anchored, icon-only, always visible regardless of collapsed state — same three
            actions today's rail always kept visible at its bottom. */}
        <div className="sidebar-bottom">
          <RailTip label="Help">
            <NavLink to="/help" title="Help"
              className={({ isActive }) => `rail-btn${isActive ? ' rail-btn--active' : ''}`}
              onClick={() => setMobileSidebarOpen(false)}>?</NavLink>
          </RailTip>
          <RailTip label={collapsed ? 'Show menu' : 'Hide menu'}>
            <button className="rail-btn" title={collapsed ? 'Show menu' : 'Hide menu'}
              onClick={() => setCollapsed(c => !c)}>{collapsed ? '›' : '‹'}</button>
          </RailTip>
          <RailTip label={posRole ? 'Lock POS' : 'Sign out'}>
            <button className="rail-btn rail-btn--signout" title={posRole ? 'Lock POS' : 'Sign out'}
              onClick={handleSignOut}>⎋</button>
          </RailTip>
        </div>
        </div>{/* /sidebar-shell */}
      </div>

      <main className={`main-content${collapsed ? ' main-content--collapsed' : ''}`}>
        <button className="mobile-hamburger" onClick={() => { setMobileSidebarOpen(true); setCollapsed(false) }}>☰</button>

        {/* Trial banners — shown from day 4 onwards and after expiry */}
        {isTrial && !trialExpired && trialDaysLeft <= 4 && (
          <div style={{
            background: 'rgba(245,158,11,0.1)', border: '1px solid rgba(245,158,11,0.35)',
            borderRadius: 8, padding: '12px 16px', marginBottom: 20,
            display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap',
          }}>
            <div>
              <span style={{ fontSize: 13, fontWeight: 700, color: '#f59e0b' }}>
                ⏳ {trialDaysLeft} day{trialDaysLeft !== 1 ? 's' : ''} left in your free trial
              </span>
              <span style={{ fontSize: 12, color: 'var(--theme-text2)', marginLeft: 10 }}>
                Subscribe to keep your data after the trial ends.
              </span>
            </div>
            {!subscribeRequested ? (
              <button
                onClick={async () => { setSubscribing(true); await requestSubscription(); setSubscribing(false) }}
                disabled={subscribing}
                style={{ background: '#f59e0b', border: 'none', color: '#0f1117', padding: '7px 18px', borderRadius: 6, cursor: 'pointer', fontSize: 12, fontWeight: 800, whiteSpace: 'nowrap' }}>
                {subscribing ? 'Sending…' : 'I Want to Subscribe →'}
              </button>
            ) : (
              <span style={{ fontSize: 12, color: '#f59e0b', fontWeight: 600 }}>✓ Request sent — we'll be in touch</span>
            )}
          </div>
        )}

        {isTrial && trialExpired && trialPurgeInDays !== null && trialPurgeInDays > 0 && (
          <div style={{
            background: 'rgba(248,113,113,0.1)', border: '1px solid rgba(248,113,113,0.4)',
            borderRadius: 8, padding: '12px 16px', marginBottom: 20,
            display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap',
          }}>
            <div>
              <span style={{ fontSize: 13, fontWeight: 700, color: '#f87171' }}>
                🔒 Trial ended — your data is retained for {trialPurgeInDays} more day{trialPurgeInDays !== 1 ? 's' : ''}
              </span>
              <span style={{ fontSize: 12, color: 'var(--theme-text2)', marginLeft: 10 }}>
                Subscribe before the deadline to keep your data permanently.
              </span>
            </div>
            {!subscribeRequested ? (
              <button
                onClick={async () => { setSubscribing(true); await requestSubscription(); setSubscribing(false) }}
                disabled={subscribing}
                style={{ background: '#f87171', border: 'none', color: '#fff', padding: '7px 18px', borderRadius: 6, cursor: 'pointer', fontSize: 12, fontWeight: 800, whiteSpace: 'nowrap' }}>
                {subscribing ? 'Sending…' : 'Subscribe Now →'}
              </button>
            ) : (
              <span style={{ fontSize: 12, color: '#f87171', fontWeight: 600 }}>✓ Request sent — we'll be in touch</span>
            )}
          </div>
        )}

        {isTrial && trialExpired && (trialPurgeInDays === null || trialPurgeInDays <= 0) && (
          <div style={{
            background: 'rgba(248,113,113,0.12)', border: '1px solid rgba(248,113,113,0.5)',
            borderRadius: 8, padding: '14px 18px', marginBottom: 20,
            textAlign: 'center',
          }}>
            <div style={{ fontSize: 14, fontWeight: 700, color: '#f87171', marginBottom: 4 }}>
              Your free trial has ended and the data retention period has expired.
            </div>
            <div style={{ fontSize: 12, color: 'var(--theme-text2)' }}>
              Contact us to discuss reactivation.
            </div>
          </div>
        )}

        <Outlet />
      </main>

      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        items={paletteItems}
        onSelect={handlePaletteSelect}
      />
    </div>
  )
}
