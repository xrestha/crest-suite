import { NavLink, Outlet, useNavigate, useLocation } from 'react-router-dom'
import { useState, useEffect, useRef } from 'react'
import { useAuth } from '../context/AuthContext'
import { useSettings } from '../context/SettingsContext'
import { supabase } from '../supabaseClient'
import { getSubStatus } from '../utils/subscription'
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

const REPORTS = [
  // Starter — all plans
  { to: '/summary',              label: 'Monthly Summary',      icon: '◻', featureKey: 'monthly_summary'    },
  { to: '/annual-summary',       label: 'Annual Summary',       icon: '◫', featureKey: 'annual_summary'     },
  { to: '/stock-report',         label: 'Stock Report',         icon: '▤', featureKey: 'stock_report'       },
  { to: '/reorder',              label: 'Reorder Report',       icon: '↻', featureKey: 'reorder_report'     },
  { to: '/vat-report',           label: 'VAT Report',           icon: '₨', featureKey: 'vat_report'         },
  { to: '/non-vat-report',      label: 'Non-VAT Report',       icon: '₨', featureKey: 'non_vat_report'     },
  { to: '/wastage-report',       label: 'Wastage Report',       icon: '⚠', featureKey: 'wastage_report'     },
  // Growth
  { to: '/payments',             label: 'Payment Summary',      icon: '⊕', featureKey: 'payment_summary',   minPlan: 'starter' },
  { to: '/variance',             label: 'Variance Report',      icon: '△', featureKey: 'variance_report',   minPlan: 'growth' },
  { to: '/budget',               label: 'Budget vs Actual',     icon: '◎', featureKey: 'budget_vs_actual',  minPlan: 'growth' },
  { to: '/best-sellers',         label: 'Best & Worst Sellers', icon: '▲', featureKey: 'best_sellers',      minPlan: 'growth' },
  { to: '/dead-stock',           label: 'Dead Stock',           icon: '⊘', featureKey: 'dead_stock',        minPlan: 'growth' },
  { to: '/recipe-margin',        label: 'Recipe Margin',        icon: '◈', featureKey: 'recipe_margin',     minPlan: 'growth' },
  { to: '/menu-repricing',       label: 'Menu Repricing',       icon: '↗', featureKey: 'menu_repricing',    minPlan: 'growth' },
  { to: '/payables',             label: 'Outstanding Payables', icon: '₨', featureKey: 'outstanding_payables', minPlan: 'growth' },
  // Pro
  { to: '/vendors-report',       label: 'Vendor Report',        icon: '⊙', featureKey: 'vendor_report',        minPlan: 'pro' },
  { to: '/fifo',                 label: 'FIFO / Expiry',        icon: '◷', featureKey: 'fifo_report',          minPlan: 'pro' },
  { to: '/supplier-prices',      label: 'Price Tracker',        icon: '₨', featureKey: 'price_tracker',        minPlan: 'pro' },
  { to: '/theoretical-variance', label: 'Theoretical Variance', icon: '⊿', featureKey: 'theoretical_variance', minPlan: 'pro' },
  { to: '/period-comparison',    label: 'Period Comparison',    icon: '⇄', featureKey: 'period_comparison',    minPlan: 'pro' },
  { to: '/shrinkage',            label: 'Shrinkage Report',     icon: '⚠', featureKey: 'shrinkage_report',    minPlan: 'pro' },
]

// Collapsible nav groups for the IMS sidebar (Dashboard stays pinned above; Settings below).
const IMS_GROUPS = [
  { key: 'ops',     label: 'Operations', items: NAV.slice(1, 9) }, // Periods … Sales Entry
  { key: 'costing', label: 'Costing',    items: NAV.slice(9) },    // Recipe Costing, Menu Eng, Overheads
  { key: 'reports', label: 'Reports',    items: REPORTS },
]
const HR_DASHBOARD = { to: '/hr/dashboard', label: 'HR Dashboard', icon: '▦' }

const POS_GROUPS = [
  { key: 'pos-setup', label: null, items: [
    { to: '/pos', label: 'POS Setup', icon: '⊡', minPosRole: 'manager' },
  ]},
  { key: 'pos-floor', label: 'Floor', items: [
    { to: '/pos/tables', label: 'Tables', icon: '⊞', minPosRole: 'supervisor' },
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
    { to: '/hr/payroll',    label: 'Payroll',            icon: '💵' },
    { to: '/hr/festival',   label: 'Festival Allowance', icon: '🎉' },
    { to: '/hr/advances',   label: 'Advances & Loans',   icon: '💳' },
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

  // Collapsible nav groups: defaults — Operations/Costing/HR open, Reports collapsed.
  const [openGroups, setOpenGroups] = useState(() => {
    try { return JSON.parse(localStorage.getItem('crest_nav_groups')) || {} } catch { return {} }
  })
  function groupOpen(key, state = openGroups) {
    if (state[key] !== undefined) return state[key]
    return key !== 'reports' // collapsed by default only for the long Reports list
  }
  function toggleGroup(key) {
    setOpenGroups(prev => {
      const next = { ...prev, [key]: !groupOpen(key, prev) }
      localStorage.setItem('crest_nav_groups', JSON.stringify(next))
      return next
    })
  }

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

  function unlockedItems(items) {
    return items.filter(item => !item.featureKey || hasFeature(item.featureKey))
  }

  function renderNavItem(item) {
    return (
      <NavLink key={item.to} to={item.to}
        className={({ isActive }) => `sidebar-link${isActive ? ' sidebar-link--active' : ''}`}
        title={collapsed ? item.label : undefined}
        onClick={() => setMobileSidebarOpen(false)}>
        <span className="sidebar-icon">{item.icon}</span>
        {!collapsed && item.label}
      </NavLink>
    )
  }

  // Collapsible group: header (label · count · chevron) + its items. The group containing
  // the current route is force-open so you always see where you are. In icon-collapsed mode
  // we skip headers and render items flat.
  function renderGroup(group) {
    const items = unlockedItems(group.items)
    if (items.length === 0) return null
    if (collapsed) return <div key={group.key}>{items.map(renderNavItem)}</div>
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
            color: 'var(--theme-text3)', fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em',
            fontFamily: 'inherit',
          }}
        >
          <span>{group.label}</span>
          <span style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
            <span style={{ fontSize: 10, color: 'var(--theme-text3)', fontWeight: 600 }}>{items.length}</span>
            <span style={{ fontSize: 9, color: 'var(--theme-text3)', display: 'inline-block', transform: open ? 'rotate(90deg)' : 'none', transition: 'transform 0.15s' }}>▶</span>
          </span>
        </button>
        {open && items.map(renderNavItem)}
      </div>
    )
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

    if (collapsed) {
      return (
        <div style={{ padding: '4px 6px', textAlign: 'center', marginTop: 4 }}>
          <div
            onClick={() => navigate('/pricing')}
            title={`Upgrade to ${tierLabel}`}
            style={{ fontSize: 9, fontWeight: 800, color: tierColor, background: `${tierColor}18`, border: `1px solid ${tierColor}40`, borderRadius: 4, padding: '4px 6px', cursor: 'pointer' }}
          >↑</div>
        </div>
      )
    }

    return (
      <div style={{ margin: '4px 8px 2px', border: `1px solid ${tierColor}25`, borderRadius: 7, padding: '10px 12px', background: `${tierColor}07` }}>
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

  return (
    <div className="layout-root">
      {mobileSidebarOpen && <div className="sidebar-overlay" onClick={() => setMobileSidebarOpen(false)} />}
      <aside className={`sidebar${collapsed ? ' sidebar--collapsed' : ''}${mobileSidebarOpen ? ' mobile-open' : ''}`}>

        {/* Brand + toggle button */}
        <div className="sidebar-brand">
          {settings?.logo_url
            ? <img src={settings.logo_url} alt="logo" style={{ width: 32, height: 32, objectFit: 'contain', borderRadius: 4, flexShrink: 0 }} />
            : <span aria-label="Crest" style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 32, height: 32, fontSize: 26, lineHeight: 1, color: 'var(--theme-accent)', flexShrink: 0 }}>⬢</span>
          }
          {!collapsed && (
            <div style={{ flex: 1 }}>
              <div className="sidebar-brand-name">{settings?.app_name || 'Crest'}</div>
              <div className="sidebar-brand-sub">Inventory</div>
            </div>
          )}
          <button
            className="sidebar-toggle"
            onClick={() => setCollapsed(c => !c)}
            title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          >
            {collapsed ? '›' : '‹'}
          </button>
        </div>

        {/* Role / client badge */}
        {!collapsed && (
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
        )}

        <nav className="sidebar-nav">
          {renderNavItem(NAV[0])}

          {isAdmin && (
            <>
              <NavLink to="/admin/clients"
                className={({ isActive }) => `sidebar-link${isActive ? ' sidebar-link--active' : ''}`}
                style={newTrialCount > 0 && pendingTrialCount === 0 ? {
                  borderLeft: '3px solid #f59e0b',
                  background: 'rgba(245,158,11,0.10)',
                  marginLeft: -3,
                } : {}}
                title={collapsed ? 'Clients' : undefined}
                onClick={() => setMobileSidebarOpen(false)}>
                <span className="sidebar-icon" style={{ position: 'relative' }}>
                  ⊛
                  {pendingTrialCount > 0 && (
                    <span style={{
                      position: 'absolute', top: -6, right: -8,
                      minWidth: 16, height: 16, borderRadius: 8,
                      background: '#f87171', color: '#fff',
                      fontSize: 10, fontWeight: 800,
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                      padding: '0 3px',
                      boxShadow: '0 0 0 2px var(--theme-sidebar)',
                      animation: 'pulse-dot 1.5s infinite',
                    }}>{pendingTrialCount}</span>
                  )}
                  {pendingTrialCount === 0 && newTrialCount > 0 && (
                    <span style={{
                      position: 'absolute', top: -6, right: -8,
                      minWidth: 16, height: 16, borderRadius: 8,
                      background: '#f59e0b', color: '#000',
                      fontSize: 10, fontWeight: 800,
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                      padding: '0 3px',
                      boxShadow: '0 0 0 2px var(--theme-sidebar)',
                      animation: 'pulse-dot 1.5s infinite',
                    }}>{newTrialCount}</span>
                  )}
                </span>
                {!collapsed && (
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
                )}
              </NavLink>
              <NavLink to="/periods"
                className={({ isActive }) => `sidebar-link${isActive ? ' sidebar-link--active' : ''}`}
                title={collapsed ? 'Periods' : undefined}
                onClick={() => setMobileSidebarOpen(false)}>
                <span className="sidebar-icon">◷</span>
                {!collapsed && 'Periods'}
              </NavLink>
              <NavLink to="/admin/audit"
                className={({ isActive }) => `sidebar-link${isActive ? ' sidebar-link--active' : ''}`}
                title={collapsed ? 'Audit Log' : undefined}
                onClick={() => setMobileSidebarOpen(false)}>
                <span className="sidebar-icon">◈</span>
                {!collapsed && 'Audit Log'}
              </NavLink>
              <NavLink to="/settings"
                className={({ isActive }) => `sidebar-link${isActive ? ' sidebar-link--active' : ''}`}
                title={collapsed ? 'Settings' : undefined}
                onClick={() => setMobileSidebarOpen(false)}>
                <span className="sidebar-icon">⚙</span>
                {!collapsed && 'Settings'}
              </NavLink>
              <div className="sidebar-divider" />
            </>
          )}

          {clientModules.ims && (!isAdmin || adminViewClientId) && (
            <>
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

          {clientModules.hr && (!isAdmin || adminViewClientId) && (
            <>
              <div className="sidebar-divider" />
              {renderNavItem(HR_DASHBOARD)}
              {HR_GROUPS.map(renderGroup)}
            </>
          )}

          {clientModules.pos && (!isAdmin || adminViewClientId) && (isAdmin || posRole || isOwner) && (
            <>
              <div className="sidebar-divider" />
              {POS_GROUPS.map(group => renderGroup({
                ...group,
                items: group.items.filter(item => !item.minPosRole || hasPosAccess(item.minPosRole)),
              }))}
            </>
          )}

          <div className="sidebar-divider" />
          <NavLink to="/help"
            className={({ isActive }) => `sidebar-link${isActive ? ' sidebar-link--active' : ''}`}
            title={collapsed ? 'Help' : undefined}
            onClick={() => setMobileSidebarOpen(false)}>
            <span className="sidebar-icon">?</span>
            {!collapsed && 'Help'}
          </NavLink>
        </nav>

        <div className="sidebar-footer">
          {!isAdmin && plan !== 'pro' && !collapsed && (
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
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            {!collapsed && (
              <div className="sidebar-user">
                <div className="sidebar-user-name">{profile?.full_name || 'User'}</div>
                <div className="sidebar-user-role">
                  {isAdmin ? 'Admin' : isOwner ? 'Owner' : posRole ? `POS · ${posRole.charAt(0).toUpperCase() + posRole.slice(1)}` : 'Client'}
                </div>
              </div>
            )}
            <button onClick={handleSignOut} className="sidebar-signout" title={posRole ? 'Lock POS' : 'Sign out'}>⎋</button>
          </div>
        </div>
      </aside>

      <main className={`main-content${collapsed ? ' main-content--collapsed' : ''}`}>
        <button className="mobile-hamburger" onClick={() => setMobileSidebarOpen(true)}>☰</button>

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
    </div>
  )
}
