import { NavLink, Outlet, useNavigate } from 'react-router-dom'
import { useState, useEffect, useRef } from 'react'
import { useAuth } from '../context/AuthContext'
import { useSettings } from '../context/SettingsContext'
import { supabase } from '../supabaseClient'
import { getSubStatus } from '../utils/subscription'
import logo from '../assets/logo.png'
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
  { to: '/menu-engineering', label: 'Menu Engineering',  icon: '◈', featureKey: 'menu_engineering',minPlan: 'pro' },
  { to: '/overheads',        label: 'Overheads',         icon: '₿', featureKey: 'overheads',       minPlan: 'pro' },
]

const REPORTS = [
  // Starter — all plans
  { to: '/summary',              label: 'Monthly Summary',      icon: '◻', featureKey: 'monthly_summary'    },
  { to: '/annual-summary',       label: 'Annual Summary',       icon: '◫', featureKey: 'annual_summary'     },
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
  { to: '/payables',             label: 'Outstanding Payables', icon: '₨', featureKey: 'outstanding_payables', minPlan: 'growth' },
  // Pro
  { to: '/vendors-report',       label: 'Vendor Report',        icon: '⊙', featureKey: 'vendor_report',        minPlan: 'pro' },
  { to: '/fifo',                 label: 'FIFO / Expiry',        icon: '◷', featureKey: 'fifo_report',          minPlan: 'pro' },
  { to: '/supplier-prices',      label: 'Price Tracker',        icon: '₨', featureKey: 'price_tracker',        minPlan: 'pro' },
  { to: '/theoretical-variance', label: 'Theoretical Variance', icon: '⊿', featureKey: 'theoretical_variance', minPlan: 'pro' },
  { to: '/period-comparison',    label: 'Period Comparison',    icon: '⇄', featureKey: 'period_comparison',    minPlan: 'pro' },
  { to: '/shrinkage',            label: 'Shrinkage Report',     icon: '⚠', featureKey: 'shrinkage_report',    minPlan: 'pro' },
]

export default function Layout() {
  const { profile, isAdmin, plan, hasFeature, imsEnabled, hrEnabled, signOut, adminViewClientId, switchAdminClient } = useAuth()
  const { settings } = useSettings()
  const navigate = useNavigate()
  const clientName = profile?.clients?.name
  const [collapsed, setCollapsed] = useState(false)
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false)
  const [allClients, setAllClients] = useState([])
  const [clientDropdownOpen, setClientDropdownOpen] = useState(false)
  const dropdownRef = useRef(null)

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
    supabase.from('clients').select('id, name, trial_ends_at, subscription_ends_at').order('name').then(({ data }) => setAllClients(data || []))
  }, [isAdmin]) // eslint-disable-line react-hooks/exhaustive-deps

  async function handleSignOut() {
    await signOut()
    navigate('/login')
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
            : <img src={logo} alt="Crest" style={{ width: 32, height: 32, objectFit: 'contain', flexShrink: 0 }} />
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
                title={collapsed ? 'Clients' : undefined}
                onClick={() => setMobileSidebarOpen(false)}>
                <span className="sidebar-icon">⊛</span>
                {!collapsed && 'Clients'}
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

          {imsEnabled && (!isAdmin || adminViewClientId) && (
            <>
              {unlockedItems(NAV.slice(1)).map(renderNavItem)}

              <div className="sidebar-divider" />
              {!collapsed && <div className="sidebar-section-label">Reports</div>}
              {unlockedItems(REPORTS).map(renderNavItem)}

              {renderUpgradeTeaser()}

              {!isAdmin && hasFeature('settings') && (
                <>
                  <div className="sidebar-divider" />
                  {renderNavItem({ to: '/settings', label: 'Settings', icon: '⚙' })}
                </>
              )}
            </>
          )}

          {hrEnabled && (!isAdmin || adminViewClientId) && (
            <>
              <div className="sidebar-divider" />
              {!collapsed && <div className="sidebar-section-label">Human Resources</div>}
              {[
                { to: '/hr/employees', label: 'Employees', icon: '👤' },
              ].map(renderNavItem)}
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
                <div className="sidebar-user-role">{isAdmin ? 'Admin' : 'Client'}</div>
              </div>
            )}
            <button onClick={handleSignOut} className="sidebar-signout" title="Sign out">⎋</button>
          </div>
        </div>
      </aside>

      <main className={`main-content${collapsed ? ' main-content--collapsed' : ''}`}>
        <button className="mobile-hamburger" onClick={() => setMobileSidebarOpen(true)}>☰</button>
        <Outlet />
      </main>
    </div>
  )
}
