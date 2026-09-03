import { NavLink, Outlet, useNavigate, useLocation } from 'react-router-dom'
import { useState, useEffect, useRef, useMemo, Suspense } from 'react'
import { useAuth } from '../context/AuthContext'
import { useSettings } from '../context/SettingsContext'
import { supabase } from '../supabaseClient'
import { getSubStatus } from '../utils/subscription'
import RailTip from './RailTip'
import RouteFallback from './RouteFallback'
import CommandPalette from './CommandPalette'
import AppErrorBoundary from './AppErrorBoundary'
// Aliased — `Calculator` is already taken in this file by the lucide icon used for the HR
// Calculation nav entry.
import QuickCalculator from './Calculator'
import { usePosIdleLock } from '../modules/pos/usePosIdleLock'
import { useNavBadgeCounts } from '../shared/hooks/useNavBadgeCounts'
import { useScopedDb } from '../shared/hooks/useScopedDb'
import { BS_MONTHS } from '../utils/bsCalendar'
import { colorTint } from '../data/pricingPlans'
import {
  Activity, ArrowRightLeft, ArrowUpDown, Banknote, BarChart3, BookUser, Boxes, Briefcase,
  Building2, Calculator, CalendarClock, CalendarDays, CalendarHeart, CalendarRange,
  CalendarX2, ChefHat, ChevronDown, ClipboardCheck, ClipboardList, Clock, Coins, Combine,
  ConciergeBell, Contact, CreditCard, Crown, FileBarChart, FileCheck2, FileDigit,
  FileSignature, FileStack, Gift, GitCompare, HandCoins, Handshake, HelpCircle, Hexagon,
  History, Hourglass, IdCardLanyard, Landmark, LayoutDashboard, LayoutGrid, LineChart,
  LogOut, Network, Package, PackageMinus, PackageOpen, PackageX, Palmtree, PanelLeftClose,
  PanelLeftOpen, ParkingSquare, PartyPopper, Percent, PieChart, PiggyBank, Printer, QrCode,
  Receipt, ReceiptText, RefreshCw, Scale, ScrollText, Search, Settings, Settings2,
  ShieldCheck, ShoppingCart, Sigma, SlidersHorizontal, Store, Tag, Tags, Target, Timer,
  Trash2, TrendingUp, TriangleAlert, Trophy, Truck, Undo2, UserCheck, Users, Users2,
  Utensils, UtensilsCrossed, Wallet, Warehouse,
} from 'lucide-react'
import './Layout.css'

// minPlan: 'growth' | 'pro' — used for lock icon and tier badge
// minHrRole: 'staff' | 'supervisor' | 'manager' — HR staff-role gate (S430), same shape as IMS's
// minImsRole: 'staff' | 'supervisor' | 'manager' — IMS staff-role gate (S417), same shape as POS's
// minPosRole. Every IMS item now carries one EXPLICITLY, including the floor-tier ones. Leaving it
// absent used to mean "floor tier", but absent and 'staff' are not the same test: isItemVisible()
// skips the check entirely when the tag is missing, so an untagged item passed for an account with
// no ims_role at all. That was survivable here only because imsVisible already requires an
// imsRole to render the IMS section — but the five untagged items also had no route guard, which
// is what actually left them reachable by URL. Tag new items; don't rely on the default.
const NAV = [
  { to: '/dashboard',        label: 'Dashboard',        icon: LayoutDashboard },
  { to: '/periods',          label: 'Periods',           icon: CalendarRange, minImsRole: 'supervisor' },
  { to: '/items',            label: 'Item Master',       icon: Package, minImsRole: 'supervisor' },
  { to: '/vendors',          label: 'Vendors',           icon: Truck, minImsRole: 'supervisor' },
  { to: '/purchases',        label: 'Purchases',         icon: ShoppingCart, minImsRole: 'staff' },
  { to: '/gate-passes',      label: 'Gate Passes',       icon: IdCardLanyard, minImsRole: 'staff' },
  { to: '/sales',            label: 'Sales Entry',       icon: TrendingUp, featureKey: 'sales_entry',     minPlan: 'starter', minImsRole: 'staff' },
  { to: '/purchase-orders',  label: 'Purchase Orders',   icon: ClipboardList, featureKey: 'purchase_orders', minPlan: 'growth', minImsRole: 'supervisor' },
  { to: '/stock',            label: 'Stock Count',       icon: ClipboardCheck, minImsRole: 'staff' },
  { to: '/requisitions',     label: 'Requisitions',      icon: ArrowRightLeft, featureKey: 'requisitions',    minPlan: 'growth', minImsRole: 'staff' },
  { to: '/recipes',          label: 'Recipe Costing',    icon: ChefHat, featureKey: 'recipe_costing',  minPlan: 'growth', minImsRole: 'supervisor' },
  { to: '/menu-pricing',     label: 'Menu Pricing',      icon: Tag, featureKey: 'menu_pricing',    minPlan: 'starter', minImsRole: 'manager' },
  { to: '/menu-engineering', label: 'Menu Engineering',  icon: PieChart, featureKey: 'menu_engineering',minPlan: 'pro', minImsRole: 'manager' },
  { to: '/overheads',        label: 'Overheads',         icon: Receipt, featureKey: 'overheads',       minPlan: 'growth', minImsRole: 'manager' },
]

// cat: which characteristic report-group the item renders under in the sidebar
const REPORTS = [
  // Summaries & planning
  { to: '/summary',              label: 'Monthly Summary',      icon: FileBarChart, featureKey: 'monthly_summary',   cat: 'summary', minImsRole: 'supervisor' },
  { to: '/annual-summary',       label: 'Annual Summary',       icon: CalendarDays, featureKey: 'annual_summary',    cat: 'summary', minImsRole: 'supervisor' },
  { to: '/period-comparison',    label: 'Period Comparison',    icon: GitCompare, featureKey: 'period_comparison', cat: 'summary', minPlan: 'pro', minImsRole: 'supervisor' },
  { to: '/budget',               label: 'Budget vs Actual',     icon: Target, featureKey: 'budget_vs_actual',  cat: 'summary', minPlan: 'growth', minImsRole: 'supervisor' },
  // Stock & variance
  { to: '/stock-report',         label: 'Stock Report',         icon: Boxes, featureKey: 'stock_report',         cat: 'stock', minPlan: 'growth', minImsRole: 'supervisor' },
  { to: '/reorder',              label: 'Reorder Report',       icon: RefreshCw, featureKey: 'reorder_report',       cat: 'stock', minPlan: 'growth', minImsRole: 'supervisor' },
  { to: '/stock-movements',      label: 'Stock Movements',      icon: PackageOpen, featureKey: 'stock_movement_log',  cat: 'stock', minPlan: 'growth', minImsRole: 'supervisor' },
  { to: '/wastage-report',       label: 'Wastage Report',       icon: Trash2, featureKey: 'wastage_report',       cat: 'stock', minImsRole: 'supervisor' },
  { to: '/dead-stock',           label: 'Dead Stock',           icon: PackageX, featureKey: 'dead_stock',           cat: 'stock', minPlan: 'growth', minImsRole: 'supervisor' },
  { to: '/variance',             label: 'Variance Report',      icon: ArrowUpDown, featureKey: 'variance_report',      cat: 'stock', minPlan: 'growth', minImsRole: 'supervisor' },
  { to: '/fifo',                 label: 'FIFO / Expiry',        icon: CalendarX2, featureKey: 'fifo_report',           cat: 'stock', minPlan: 'pro', minImsRole: 'supervisor' },
  { to: '/stock-ageing',         label: 'Stock Ageing',         icon: Hourglass, featureKey: 'stock_ageing',          cat: 'stock', minPlan: 'pro', minImsRole: 'supervisor' },
  { to: '/theoretical-variance', label: 'Theoretical Variance', icon: Sigma, featureKey: 'theoretical_variance', cat: 'stock', minPlan: 'pro', minImsRole: 'supervisor' },
  { to: '/shrinkage',            label: 'Shrinkage Report',     icon: PackageMinus, featureKey: 'shrinkage_report',     cat: 'stock', minPlan: 'pro', minImsRole: 'supervisor' },
  // Money & tax
  { to: '/vat-report',           label: 'VAT Report',           icon: Percent, featureKey: 'vat_report',           cat: 'money', minImsRole: 'manager' },
  { to: '/non-vat-report',      label: 'Non-VAT Report',       icon: ReceiptText, featureKey: 'non_vat_report',       cat: 'money', minImsRole: 'manager' },
  { to: '/payments',             label: 'Payment Summary',      icon: Wallet, featureKey: 'payment_summary',      cat: 'money', minPlan: 'starter', minImsRole: 'manager' },
  { to: '/payables',             label: 'Outstanding Payables', icon: HandCoins, featureKey: 'outstanding_payables', cat: 'money', minImsRole: 'manager' },
  { to: '/purchase-one-lakh-report', label: 'Purchase 1L+ Report', icon: FileDigit, featureKey: 'vat_report',       cat: 'money', minImsRole: 'manager' },
  // Finance, not Menu & Vendors (S612 IA fix): this is an IRD Annexure 13 balance letter — an
  // accountant filing artifact like the VAT reports beside it, not a menu/vendor analysis.
  { to: '/vendor-balance-confirmation', label: 'Vendor Balance Confirmation', icon: FileSignature, featureKey: 'vendor_balance_confirmation', cat: 'money', minImsRole: 'manager' },
  // Menu & vendors
  { to: '/best-sellers',         label: 'Best & Worst Sellers', icon: Trophy, featureKey: 'best_sellers',   cat: 'menu', minPlan: 'growth', minImsRole: 'manager' },
  { to: '/recipe-margin',        label: 'Recipe Margin',        icon: PiggyBank, featureKey: 'recipe_margin',  cat: 'menu', minPlan: 'growth', minImsRole: 'manager' },
  { to: '/combo-builder',        label: 'Combo Builder',        icon: Combine, featureKey: 'combo_builder',  cat: 'menu', minPlan: 'growth', minImsRole: 'manager' },
  { to: '/menu-repricing',       label: 'Menu Repricing',       icon: Tags, featureKey: 'menu_repricing', cat: 'menu', minPlan: 'growth', minImsRole: 'manager' },
  { to: '/supplier-prices',      label: 'Price Tracker',        icon: Activity, featureKey: 'price_tracker',  cat: 'menu', minPlan: 'pro', minImsRole: 'manager' },
  { to: '/vendors-report',       label: 'Vendor Report',        icon: BookUser, featureKey: 'vendor_report',  cat: 'menu', minPlan: 'pro', minImsRole: 'manager' },
  { to: '/supplier-contribution', label: 'Supplier Contribution', icon: Handshake, featureKey: 'supplier_contribution', cat: 'menu', minPlan: 'pro', minImsRole: 'manager' },
]

// Collapsible nav groups for the IMS sidebar (Dashboard stays pinned above; Settings below).
// ── Crest Suite Pro — every Suite feature, in one list ───────────────────────────────────────
//
// Suite is the owner layer sold ON TOP of the modules, so this renders as its own group on every
// panel rather than living inside any one module's lists. S638 gave the three owner pages that
// group; Demand Forecast and Fixed Assets stayed behind in NAV/REPORTS and were marked with a PRO
// chip in place, which left the section telling only part of the truth about what Suite contains.
// They are here now, and the reason they could not simply move before is solved by `ownerOnly`
// below rather than by leaving them out.
//
// TWO different gates live in this one list, and that is the point:
//   * `ownerOnly` — the four owner-altitude pages. Owner or Crest admin, nobody else.
//   * `minImsRole` — Demand Forecast and Fixed Assets are Suite-billed but IMS-shaped, and an IMS
//     supervisor uses them. Gating the GROUP on owner-or-admin would have revoked them from every
//     supervisor who has them today, so the gate is per item and the group renders whatever the
//     viewer can actually reach (renderGroup returns null when that is nothing).
//
// No featureKey on any of them, deliberately: one would make the row DISAPPEAR instead of
// upselling, and SuiteGate's whole design is an inline upsell in place. Entitlement is carried by
// the group header's PRO chip instead.
//
// `longLabel` is what the command palette shows — it is searched by typing a full name, while the
// sidebar has 240px. The palette builds from THIS list, so the two can no longer disagree about
// who may see a Suite destination (they did, and it was an S617-shaped bug found in S638).
//
// Note these routes are deliberately absent from the panel-resolution list further down: a Suite
// page keeps whatever panel you were on, because the group is on all of them.
const SUITE_NAV = [
  { to: '/owner-dashboard', label: 'Owner Dashboard', icon: Crown,      ownerOnly: true },
  { to: '/owner-report',    label: 'Owner Report',    icon: ScrollText, ownerOnly: true, longLabel: 'Monthly Owner/Manager Report' },
  { to: '/pnl',             label: 'Profit & Loss',   icon: Scale,      ownerOnly: true, longLabel: 'Consolidated Profit & Loss' },
  // Gated on having a group as well, not on Suite: a single-outlet client has nothing to roll up.
  { to: '/group-dashboard', label: 'Group Console',   icon: Network,    ownerOnly: true, needsGroup: true },
  { to: '/demand-forecast', label: 'Demand Forecast', icon: LineChart,  minImsRole: 'supervisor' },
  { to: '/fixed-assets',    label: 'Fixed Assets',    icon: Landmark,   minImsRole: 'supervisor' },
]

// Reports are split by characteristic instead of one 20+-item list — open just the slice you need.
const IMS_GROUPS = [
  { key: 'ops',             label: 'Operations',       items: NAV.slice(1, 10) }, // Periods … Requisitions
  { key: 'costing',         label: 'Costing',          items: NAV.slice(10) },    // Recipe Costing … Overheads
  { key: 'reports-summary', label: 'Summary Reports',  items: REPORTS.filter(r => r.cat === 'summary') },
  { key: 'reports-stock',   label: 'Stock Reports',    items: REPORTS.filter(r => r.cat === 'stock') },
  { key: 'reports-money',   label: 'Finance Reports',  items: REPORTS.filter(r => r.cat === 'money') },
  { key: 'reports-menu',    label: 'Menu & Vendors',   items: REPORTS.filter(r => r.cat === 'menu') },
  { key: 'ims-admin',       label: 'Admin',            items: [
    { to: '/ims/staff', label: 'IMS Staff', icon: Users2, minImsRole: 'manager' },
  ]},
]
const HR_DASHBOARD = { to: '/hr/dashboard', label: 'HR Dashboard', icon: LayoutDashboard, minHrRole: 'supervisor' }

const POS_GROUPS = [
  { key: 'pos-setup', label: null, items: [
    { to: '/pos', label: 'POS Setup', icon: Settings2, minPosRole: 'manager' },
  ]},
  { key: 'pos-floor', label: 'Floor', items: [
    { to: '/pos/orders', label: 'Orders', icon: ConciergeBell, minPosRole: 'staff' },
    { to: '/pos/kds', label: 'Kitchen Display', icon: Utensils, minPosRole: 'staff' },
    { to: '/pos/parking', label: 'Parking Slips', icon: ParkingSquare, minPosRole: 'staff' },
    { to: '/pos/tables', label: 'Tables', icon: LayoutGrid, minPosRole: 'manager' },
    { to: '/pos/customers', label: 'Customers', icon: Contact, minPosRole: 'supervisor' },
    { to: '/pos/shifts', label: 'Shifts', icon: Clock, minPosRole: 'supervisor' },
  ]},
  { key: 'pos-menu', label: 'Menu', items: [
    { to: '/menu-pricing', label: 'Menu Pricing', icon: Tag, featureKey: 'menu_pricing', minPlan: 'starter', minPosRole: 'manager' },
  ]},
  { key: 'pos-reports', label: 'Reports', items: [
    { to: '/pos/exceptions', label: 'Exceptions', icon: TriangleAlert, minPosRole: 'manager' },
    { to: '/pos/credit-notes', label: 'Credit Notes', icon: Undo2, minPosRole: 'manager' },
    { to: '/pos/sales-report', label: 'Sales Report', icon: BarChart3, minPosRole: 'manager' },
    { to: '/pos/kot-log', label: 'KOT Log', icon: Printer, minPosRole: 'manager' },
    { to: '/pos/covers-report', label: 'Covers Report', icon: UtensilsCrossed, minPosRole: 'manager' },
  ]},
  { key: 'pos-admin', label: 'Admin', items: [
    { to: '/pos/staff', label: 'POS Staff', icon: Users2, minPosRole: 'manager' },
  ]},
]
// A 'kitchen'/'bar' pos_team account (S431) has no use for anything front-of-house — Orders,
// Parking Slips, Tables, Customers, Shifts, Menu Pricing, Reports, POS Staff admin — regardless
// of its pos_role rank. Explicit allowlist rather than tagging every other item: fail-closed, so
// a future new POS page is hidden from kitchen/bar by default until someone deliberately adds it
// here, matching this codebase's established fail-closed convention elsewhere (scopedDb, RLS).
const KITCHEN_TEAM_ALLOWED_PATHS = ['/pos/kds']

const HR_GROUPS = [
  { key: 'hr-people', label: 'People', items: [
    { to: '/hr/employees',  label: 'Employees',        icon: Users, minHrRole: 'manager' },
    { to: '/hr/pay-setup',  label: 'Pay Setup',        icon: SlidersHorizontal, minHrRole: 'manager' },
    { to: '/hr/holidays',   label: 'Holiday Calendar', icon: CalendarHeart, minHrRole: 'staff' },
  ]},
  { key: 'hr-attendance', label: 'Attendance', items: [
    { to: '/hr/roster',     label: 'Staff Roster',     icon: CalendarClock, minHrRole: 'supervisor' },
    { to: '/hr/attendance', label: 'Attendance',       icon: UserCheck, minHrRole: 'supervisor' },
    { to: '/hr/leave',      label: 'Leave',            icon: Palmtree, minHrRole: 'supervisor' },
    { to: '/hr/overtime',   label: 'Overtime',         icon: Timer, minHrRole: 'supervisor' },
  ]},
  { key: 'hr-payroll', label: 'Payroll', items: [
    { to: '/hr/calculation', label: 'Calculation',       icon: Calculator, minHrRole: 'manager' },
    { to: '/hr/payroll',    label: 'Payroll',            icon: Banknote, minHrRole: 'manager' },
    { to: '/hr/festival',   label: 'Festival Allowance', icon: PartyPopper, minHrRole: 'manager' },
    { to: '/hr/incentives', label: 'Incentives / Bonus', icon: Gift, minHrRole: 'manager' },
    { to: '/hr/advances',   label: 'Advances & Loans',   icon: CreditCard, minHrRole: 'manager' },
    { to: '/hr/tada',       label: 'TADA Claims',        icon: Briefcase, minHrRole: 'supervisor' },
  ]},
  { key: 'hr-reports', label: 'Reports', items: [
    { to: '/hr/reports',    label: 'HR Reports',       icon: FileStack, minHrRole: 'manager' },
    { to: '/hr/gratuity',   label: 'Gratuity',         icon: Coins, minHrRole: 'manager' },
    { to: '/hr/settlement', label: 'Final Settlement', icon: FileCheck2, minHrRole: 'manager' },
  ]},
  { key: 'hr-admin', label: 'Admin', items: [
    { to: '/hr/staff', label: 'HR Staff', icon: Users2, minHrRole: 'manager' },
  ]},
]

export default function Layout() {
  const { profile, isAdmin, plan, hasFeature, clientModules, signOut, adminViewClientId, switchAdminClient,
          isTrial, trialExpired, trialDaysLeft, subscribeRequested, requestSubscription,
          accessReason, graceDaysLeft, clientId,
          outlets, switchableOutlets, canSwitchOutlet, switchOutlet,
          hasPosAccess, posRole, posTeam, hasImsAccess, imsRole, hasHrAccess, hrRole, isOwner,
          suitePlan } = useAuth()
  const { settings } = useSettings()
  const { scopedFrom } = useScopedDb()

  // ── Context bar ──────────────────────────────────────────────────────────────────────────────
  // Which tenant and which BS period the figures on screen belong to. The shell never stated
  // either: client/plan lived only inside .sidebar-content (display:none at 56px, behind a drawer
  // on mobile) and the period was printed by whichever page happened to print it — ClientDashboard
  // does, the ~35 report pages do not. Every IMS figure is period-scoped, an admin can be viewing
  // as another tenant, and an Owner can switch outlets: three independent ways to read a real
  // number off the wrong books, on a product whose thesis is trusting the number enough to act.
  // monthly_periods carries a partial unique index allowing at most one open period per client,
  // which is why this is a .limit(1) read rather than an ordered one.
  const [activePeriod, setActivePeriod] = useState(null)
  useEffect(() => {
    if (!clientId || !clientModules.ims) { setActivePeriod(null); return }
    let cancelled = false
    scopedFrom('monthly_periods', 'bs_year, bs_month, status')
      .eq('status', 'open').limit(1).maybeSingle()
      .then(({ data }) => { if (!cancelled) setActivePeriod(data || null) })
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clientId, clientModules.ims])
  const navigate = useNavigate()
  const clientName = profile?.clients?.name
  const [collapsed, setCollapsed] = useState(false)
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false)
  const [allClients, setAllClients] = useState([])
  const [clientDropdownOpen, setClientDropdownOpen] = useState(false)
  const [pendingTrialCount, setPendingTrialCount] = useState(0)
  const [newTrialCount, setNewTrialCount] = useState(0)
  const [subscribing, setSubscribing] = useState(false)
  const [outletDropdownOpen, setOutletDropdownOpen] = useState(false)
  const [switchingOutlet, setSwitchingOutlet] = useState(false)
  const [outletError, setOutletError] = useState('')
  const dropdownRef = useRef(null)
  const outletDropdownRef = useRef(null)
  const sidebarRef = useRef(null)
  const hamburgerRef = useRef(null)
  const location = useLocation()

  // On a phone the sidebar IS a modal drawer — it covers the page behind a 55% scrim — but it had
  // none of a modal's behavior: Escape did nothing, focus never entered it, and focus never came
  // back to the trigger on close. Modal.js solves all three; this is the same contract applied to
  // the one overlay that could not reuse it (the sidebar is always mounted, not portalled).
  // Deliberately NOT a full focus trap: the drawer is dismissed by Escape, by the scrim, and by
  // selecting any destination inside it, so the exit is never more than one key away.
  useEffect(() => {
    if (!mobileSidebarOpen) return
    const restoreTo = hamburgerRef.current
    // Land on the first control inside the drawer rather than leaving focus on the hamburger the
    // drawer now covers.
    sidebarRef.current?.querySelector('button, a[href]')?.focus()
    function onKeyDown(e) {
      if (e.key === 'Escape') {
        setMobileSidebarOpen(false)
        restoreTo?.focus()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [mobileSidebarOpen])

  // The drawer opens at whatever scroll position the nav was last left at — measured 642px in on a
  // real session, landing mid-list on the accountant's reports rather than at the top of the panel.
  useEffect(() => {
    if (mobileSidebarOpen && sidebarRef.current) {
      const nav = sidebarRef.current.querySelector('.sidebar-nav')
      if (nav) nav.scrollTop = 0
    }
  }, [mobileSidebarOpen])

  // Switching outlets re-points every scoped query at another tenant, so it must not happen while
  // the POS offline queue still holds unsynced orders — those would flush against the wrong
  // outlet. crest-offline is opened lazily here rather than imported at module scope so a client
  // without POS never touches IndexedDB for this check.
  async function handleSwitchOutlet(targetId) {
    if (targetId === clientId) { setOutletDropdownOpen(false); return }
    setOutletError('')
    setSwitchingOutlet(true)
    // The offline-queue guard lives inside switchOutlet so every entry point gets it.
    const { error } = await switchOutlet(targetId)
    setSwitchingOutlet(false)
    if (error) { setOutletError(error.message || 'Could not switch outlet.'); return }
    setOutletDropdownOpen(false)
    navigate('/dashboard')
  }

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
    else if ([...NAV, ...REPORTS, ...IMS_GROUPS.flatMap(g => g.items)].some(i => p === i.to || p.startsWith(i.to + '/')) || p === '/settings') {
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
    navigate(isPosDevice && isPinStaff ? '/pos/login' : '/login')
  }

  // ── POS idle lock ────────────────────────────────────────────────────────────────────────────
  // A shared till signs staff in by PIN, and every closed_by/comped_by/sent_by attribution —
  // plus Sales Exceptions' whole "By Staff Member" table — records whoever last typed one.
  // Without a lock that is only as accurate as a habit, so PIN-staff sessions on a bound POS
  // device return to the PIN screen after 3 idle minutes (see usePosIdleLock for the timing
  // rationale). Deliberately NOT enabled for Owner/admin sessions (no pos_role — they sign in
  // with email/password, not a PIN, even on the till) and not on the KDS, a screen meant to sit
  // untouched on a kitchen wall. handleSignOut already routes a bound device to /pos/login.
  // PIN till session = the RAW pos_role column, never the resolved posRole rank — that rank is
  // 'manager' for every admin/Owner, which is exactly who the idle lock, the Lock-POS button
  // label and the sign-out routing must exempt. Reading the rank here signed an admin out
  // after 3 idle minutes on any machine that had ever completed POS device binding (S583).
  const isPinStaff = !!profile?.pos_role
  const [idleLockSecs, setIdleLockSecs] = useState(null)
  const idleLockEnabled = isPinStaff && !!localStorage.getItem('pos_device_client_id') &&
    !location.pathname.startsWith('/pos/kds')
  usePosIdleLock(idleLockEnabled, setIdleLockSecs, handleSignOut)

  // Single source of truth for "can this user see this destination" — used by the rendered nav,
  // the command palette's search index, and pinned favorites, so gating can never drift between
  // them as new items get added later.
  function isItemVisible(item) {
    // Owner-altitude Suite pages. This lives here rather than as a wrapper at each render site so
    // the sidebar and the command palette cannot disagree about it — the palette filters through
    // this same predicate, and the one time that condition was duplicated by hand it was applied
    // to Group Console and not to its two siblings (S617/S638).
    if (item.ownerOnly && !isAdmin && !isOwner) return false
    if (item.featureKey && !hasFeature(item.featureKey)) return false
    if (item.minPosRole && !hasPosAccess(item.minPosRole)) return false
    // minPosRole is unique to POS nav items (IMS/HR use minImsRole/minHrRole), so this scopes
    // cleanly to POS without touching the other two modules' items.
    if (item.minPosRole && (posTeam === 'kitchen' || posTeam === 'bar') && !KITCHEN_TEAM_ALLOWED_PATHS.includes(item.to)) return false
    if (item.minImsRole && !hasImsAccess(item.minImsRole)) return false
    if (item.minHrRole && !hasHrAccess(item.minHrRole)) return false
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

  function renderNavItem(item, { pinnable = true, style } = {}) {
    const isPinned = pins.includes(item.to)
    return (
      <NavLink key={item.to} to={item.to}
        className={({ isActive }) => `sidebar-link${isActive ? ' sidebar-link--active' : ''}`}
        style={style}
        onClick={() => setMobileSidebarOpen(false)}>
        <span className="sidebar-icon"><item.icon size={16} strokeWidth={1.75} /></span>
        <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>{item.label}</span>
        {/* Pins are the shell's own answer to a 41-destination nav, so they cannot be mouse-only.
            role="button" + tabIndex rather than a real <button> because this sits inside the
            NavLink's <a>, where a nested <button> would be invalid HTML; togglePin already calls
            preventDefault/stopPropagation, so Space does not scroll and Enter does not navigate. */}
        {pinnable && (
          <span
            role="button"
            tabIndex={0}
            aria-pressed={isPinned}
            aria-label={isPinned ? `Unpin ${item.label}` : `Pin ${item.label} to top`}
            className={`sidebar-pin${isPinned ? ' sidebar-pin--active' : ''}`}
            onClick={e => togglePin(e, item.to)}
            onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') togglePin(e, item.to) }}
            title={isPinned ? 'Unpin' : 'Pin to top'}
          >
            {isPinned ? '★' : '☆'}
          </span>
        )}
      </NavLink>
    )
  }

  // These were a three-across compact row with one-word labels ("Owner" / "Report" / "Dashboard")
  // on the assumption that a single word fits a third of a 240px sidebar. Measured, it does not:
  // each label box came out at 27px against 39/39/68px of text, so all three truncated to two
  // characters — "Ow… / Re… / Da…" — and these are the owner's own primary destinations, two of
  // them the product's most expensive SKU. Full-width rows with their real names, matching every
  // other nav item.
  //
  // As of S638 only this panel's own Dashboard renders here; the four Suite destinations moved
  // into their own labelled group below. See renderSuiteGroup for why.
  function renderDashboardRow() {
    return renderNavItem(dashNavItem, { pinnable: false })
  }

  // ── Crest Suite reads as its own section ─────────────────────────────────────────────────────
  //
  // These four rows used to sit unlabelled at the top of every panel, visually identical to the
  // module features included in the plan. A Suite nav item deliberately carries no featureKey (one
  // would make the row DISAPPEAR rather than upsell, and SuiteGate's whole design is an inline
  // upsell in place) — but the consequence was that nothing on the sidebar ever said these are a
  // separate, paid add-on. The client's only route to that fact was clicking one and colliding
  // with the gate. The upgrade teaser could not fill the gap either: it filters on
  // `featureKey && minPlan === nextTier`, which no Suite item has, and it returns null outright at
  // IMS Pro — so an IMS Pro client without Suite saw no upsell anywhere in the shell at all.
  //
  // A labelled group with a PRO chip is the fix, and it is strictly better than the teaser would
  // have been: the section names the axis, the chip names the entitlement, and the rows stay
  // clickable so the existing in-place upsell still does the selling.
  //
  // Order note: the panel's own Dashboard renders ABOVE this group rather than inside it. A group
  // header sitting above an ungrouped row reads as though the row belongs to the group, and
  // collapsing the group would leave it visually orphaned.
  function suiteGroup() {
    return {
      key: 'suite',
      label: 'Crest Suite',
      // The chip is the entitlement, so it shows only when the viewer does not have it. An admin
      // is exempt from SuiteGate entirely, so an admin never sees it either.
      badge: (isAdmin || suitePlan === 'pro') ? null : 'PRO',
      // Not pinnable: this group renders on every panel already, so a pin would be a shortcut to
      // something that is never more than one glance away. Preserves the pre-S638 behaviour.
      pinnable: false,
      items: suiteNavItems,
    }
  }

  // No owner-or-admin wrapper here any more: the gate is per item now (ownerOnly / minImsRole),
  // so an IMS supervisor correctly sees a two-item Crest Suite group while an Owner sees all six,
  // and renderGroup returns null when the viewer can reach none of them.
  function renderSuiteGroup() {
    return renderGroup(suiteGroup())
  }

  // Collapsible group: header (label · count · chevron) + its items. The group containing
  // the current route is force-open so you always see where you are.
  function renderGroup(group) {
    const items = unlockedItems(group.items)
    if (items.length === 0) return null
    // Explicit arrow rather than `.map(renderNavItem)`: map passes the INDEX as the second
    // argument, which lands in renderNavItem's options slot. It happened to be harmless (a number
    // destructures to undefined, so every default applied), but it also meant a group could never
    // pass options through — which `pinnable` now needs.
    const renderItems = () => items.map(i => renderNavItem(i, { pinnable: group.pinnable !== false }))
    if (!group.label) return <div key={group.key}>{renderItems()}</div> // unlabeled groups render flat, no header
    const hasActive = items.some(i => location.pathname === i.to || location.pathname.startsWith(i.to + '/'))
    const open = groupOpen(group.key) || hasActive
    return (
      <div key={group.key}>
        {/* aria-expanded/aria-controls, so this announces as a disclosure rather than as a plain
            button whose only state cue is a CSS-rotated "▶" glyph. The chevron is aria-hidden for
            the same reason: a screen reader reading out the arrow character adds nothing once the
            expanded state is exposed properly. */}
        <button
          onClick={() => toggleGroup(group.key)}
          className="sidebar-group-header"
          aria-expanded={open}
          aria-controls={`navgroup-${group.key}`}
          style={{
            display: 'flex', alignItems: 'center', justifyContent: 'space-between', width: '100%',
            background: 'none', border: 'none', cursor: 'pointer', padding: '16px 14px 6px',
            color: 'var(--theme-text3)', fontSize: 'var(--font-size-group-label)', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em',
            fontFamily: 'inherit',
          }}
        >
          <span>{group.label}</span>
          <span style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
            {/* A badge REPLACES the count: "PRO" is what the reader needs from this header, and
                "4" alongside it just says how many things they cannot use yet. badge-yellow is the
                accent-tinted categorical tag (there is no badge-gold) — this is a tier label, not
                a warning, so badge-amber would be the wrong signal. */}
            {group.badge
              ? <span className="badge-yellow" style={{ fontSize: 9, letterSpacing: '0.06em' }}>{group.badge}</span>
              : <span style={{ fontSize: 'var(--font-size-micro)', color: 'var(--theme-text3)', fontWeight: 600 }}>{items.length}</span>}
            <span aria-hidden="true" style={{ fontSize: 'var(--font-size-chevron)', color: 'var(--theme-text3)', display: 'inline-block', transform: open ? 'rotate(90deg)' : 'none', transition: 'transform var(--motion-fast) var(--ease-standard)' }}>▶</span>
          </span>
        </button>
        <div id={`navgroup-${group.key}`}>{open && renderItems()}</div>
      </div>
    )
  }

  // Which module panels exist for this user, and which one is showing.
  // activePanel (route-synced) is resolved against visibility — if it points at a module this
  // user can't see (or nothing is selected yet), fall back to the first available panel.
  // IMS, HR, and POS are owner/admin-only panels unless the viewer has an explicit staff-role
  // grant on that module — a POS PIN staff login (posRole set, not owner) works the floor, and
  // RLS blocks it from the IMS/HR tables anyway; don't show nav to pages that would render empty.
  const imsVisible = clientModules.ims && (!isAdmin || adminViewClientId) && (isAdmin || imsRole || isOwner)
  const hrVisible  = clientModules.hr  && (!isAdmin || adminViewClientId) && (isAdmin || hrRole || isOwner)
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

  // Group Console is the one Suite row whose visibility depends on session state rather than on a
  // role, so it is dropped here rather than inside SUITE_NAV. Both the sidebar group and the
  // command palette read this, so neither can offer a console for a group that doesn't exist.
  const suiteNavItems = SUITE_NAV.filter(i => !i.needsGroup || outlets.length > 1)

  // ── Command palette — flat search across every destination, gated by the exact same
  // isItemVisible() predicate the rendered nav uses (defined below; hoisted, safe to reference
  // here). Rebuilds only when what this user can see changes, not on every render/keystroke —
  // the palette component itself does the query filtering. Panel-switching after navigating is
  // already handled by the existing location.pathname effect above, so items don't need a
  // 'panel' tag.
  const [paletteOpen, setPaletteOpen] = useState(false)
  const paletteItems = useMemo(() => {
    // Each source is tagged with the module it belongs to. CommandPalette has rendered a
    // right-hand `groupLabel` since it was written, but nothing ever set one — so searching
    // "report" returned Stock Report / Sales Report / HR Reports / Vendor Report with nothing
    // saying which module each came from.
    const tag = (groupLabel, arr) => arr.map(i => ({ groupLabel, ...i }))
    const all = [
      dashNavItem,
      // ONE source with the sidebar group, swapping in the longer search label where there is one.
      // Visibility is not re-stated here at all — every item carries its own ownerOnly/minImsRole
      // and isItemVisible below applies it, which is the whole reason those moved onto the items.
      // Hand-duplicating the condition is what produced the S617 bug, and S617 only fixed a third
      // of it: Group Console got the `isAdmin || isOwner` test while Owner Dashboard and Owner
      // Report never did, so any staff account could search its way onto them (they redirect at
      // the page per S601, so nothing leaked — but the product was advertising destinations the
      // sidebar deliberately withholds). Profit & Loss was missing from the palette outright.
      ...tag('Suite', suiteNavItems.map(i => (i.longLabel ? { ...i, label: i.longLabel } : i))),
      ...tag('IMS', NAV.slice(1)),
      ...tag('IMS', REPORTS),
      ...tag('IMS', IMS_GROUPS.find(g => g.key === 'ims-admin').items),
      ...(hrVisible ? tag('HR', [HR_DASHBOARD, ...HR_GROUPS.flatMap(g => g.items)]) : []),
      ...(posVisible ? tag('POS', POS_GROUPS.flatMap(g => g.items)) : []),
      ...(isAdmin ? tag('Admin', [
        { to: '/admin/clients', label: 'Clients', icon: Building2 },
        { to: '/admin/guest-menu', label: 'Guest Menu', icon: QrCode },
        { to: '/admin/audit', label: 'Audit Log', icon: History },
      ]) : []),
      { to: '/settings', label: 'Settings', icon: Settings, minImsRole: 'manager' },
    ]
    const seen = new Set()
    return all.filter(item => isItemVisible(item) && !seen.has(item.to) && seen.add(item.to))
  // isOwner and outlets gate the Suite block above; suitePlan is deliberately absent, because the
  // palette lists Suite destinations regardless of entitlement, exactly as the sidebar does.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hrVisible, posVisible, isAdmin, isOwner, outlets, plan, dashLabel])

  const [calcOpen, setCalcOpen] = useState(false)

  useEffect(() => {
    function onKeyDown(e) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setPaletteOpen(o => !o)
      }
      // Alt+C rather than Ctrl+Shift+C — the latter is Chrome's devtools element picker.
      if (e.altKey && !e.ctrlKey && !e.metaKey && e.key.toLowerCase() === 'c') {
        e.preventDefault()
        setCalcOpen(o => !o)
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
    // Tokens, not the Dark preset's own hex — this CTA was painting brass/green literals on all
    // ten presets. Text takes the *-text/-ink variants (the base tokens fail AA on the light
    // presets); the tints derive from the PRESET's own base token via colorTint, because the old
    // rgba literals were the DARK preset's green/brass frozen under every light theme (S612).
    const tierColor = nextTier === 'growth' ? 'var(--theme-green-text)' : 'var(--theme-accent-ink)'
    const tierTint  = pct => colorTint(nextTier === 'growth' ? 'var(--theme-green)' : 'var(--theme-accent)', pct)
    const locked = [...NAV.slice(1), ...REPORTS].filter(
      item => item.featureKey && !hasFeature(item.featureKey) && item.minPlan === nextTier
    )
    if (locked.length === 0) return null
    const shown = locked.slice(0, 5)
    const more  = locked.length - shown.length

    return (
      <div style={{ margin: '4px 8px 2px', border: `1px solid ${tierTint(15)}`, borderRadius: 'var(--radius-lg)', padding: '10px 12px', background: tierTint(4) }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 7 }}>
          <span style={{ fontSize: 9, fontWeight: 800, color: tierColor, letterSpacing: '0.08em', textTransform: 'uppercase' }}>{tierLabel} Plan</span>
          <span style={{ fontSize: 9, color: 'var(--theme-text3)' }}>{locked.length} features</span>
        </div>
        {shown.map(item => (
          <div key={item.to} style={{ fontSize: 11, color: 'var(--theme-text3)', display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
            <span style={{ color: tierColor, fontSize: 10, fontWeight: 700 }}>+</span>
            <span>{item.label}</span>
          </div>
        ))}
        {more > 0 && <div style={{ fontSize: 11, color: 'var(--theme-text3)', marginTop: 2, paddingLeft: 16 }}>and {more} more…</div>}
        <button
          onClick={() => navigate('/pricing')}
          style={{ marginTop: 10, width: '100%', fontSize: 12, fontWeight: 700, color: tierColor, background: tierTint(12), border: `1px solid ${tierTint(30)}`, borderRadius: 'var(--radius-md)', padding: '7px 0', cursor: 'pointer', letterSpacing: '0.04em' }}
        >
          Upgrade to {tierLabel} ↑
        </button>
      </div>
    )
  }

  // Module switcher tabs — one entry per module this user can see. Rendered as a horizontal pill
  // row when expanded, an icon column when collapsed (CSS flex-direction flip, same buttons).
  // Admin is kept in its own row, separate from the IMS/HR/POS row below it — it's a different
  // axis (which panel of the app, vs. which client module) and sharing one row made it look like
  // a 4th module competing for the same space (2026-07-14).
  // Tokens, not literals — #f59e0b in particular was a second amber sitting five lines from the
  // var(--theme-amber) the HR/POS dots below use for the identical "pending" semantic.
  const adminTab = isAdmin && {
    key: 'admin', label: 'Admin', icon: ShieldCheck,
    tip: pendingTrialCount > 0 ? `Admin — ${pendingTrialCount} want to subscribe`
      : newTrialCount > 0 ? `Admin — ${newTrialCount} new trial${newTrialCount !== 1 ? 's' : ''}`
      : 'Admin',
    dot: pendingTrialCount > 0 ? 'var(--theme-red)' : newTrialCount > 0 ? 'var(--theme-amber)' : null,
  }
  const moduleTabs = [
    imsVisible && { key: 'ims', label: 'IMS', icon: Warehouse, tip: 'Crest IMS', dot: null },
    hrVisible && {
      key: 'hr', label: 'HR', icon: Users2, dot: hrPending > 0 ? 'var(--theme-amber)' : null,
      tip: hrPending > 0 ? `Crest HR — ${hrPending} pending` : 'Crest HR',
    },
    posVisible && {
      key: 'pos', label: 'POS', icon: Store, dot: posPending > 0 ? 'var(--theme-amber)' : null,
      tip: posPending > 0 ? `Crest POS — ${posPending} pending` : 'Crest POS',
    },
  ].filter(Boolean)
  const totalTabCount = (adminTab ? 1 : 0) + moduleTabs.length

  function renderModuleTab(t) {
    return (
      <RailTip key={t.key} label={t.tip}>
        <button
          className={`module-tab${panel === t.key && !collapsed ? ' module-tab--active' : ''}`}
          onClick={() => openPanel(t.key)}
          aria-current={panel === t.key ? 'true' : undefined}
        >
          <span className="module-tab-icon" style={{ position: 'relative' }}>
            <t.icon size={18} strokeWidth={1.75} aria-hidden="true" />
            {/* The dot's colour drives both its fill and its pulse ring via currentColor. The
                animation lives in .module-tab-dot, not inline — an inline animation is unreachable
                by prefers-reduced-motion, and this is the only infinite one in the shell. */}
            {t.dot && <span className="module-tab-dot" style={{ color: t.dot }} />}
          </span>
          <span className="module-tab-label">{t.label}</span>
        </button>
      </RailTip>
    )
  }

  // Signed-in user's name/role — shown inline next to the client/property name (moved out of its
  // own footer section to reclaim vertical space; the empty space to the right of the client
  // name was otherwise unused).
  const userInfoBlock = (
    <div style={{ textAlign: 'right', flexShrink: 0, marginLeft: 8 }}>
      <div className="sidebar-user-name">{profile?.full_name || 'User'}</div>
      <div className="sidebar-user-role">
        {isAdmin ? 'Admin' : isOwner ? 'Owner' : posRole ? `POS · ${posRole.charAt(0).toUpperCase() + posRole.slice(1)}` : 'Client'}
      </div>
    </div>
  )

  return (
    <div className="layout-root">
      {/* WCAG 2.4.1 — 41 sidebar controls precede the first control in <main> on every route. */}
      <a href="#main-content" className="skip-link">Skip to content</a>
      {mobileSidebarOpen && <div className="sidebar-overlay" onClick={() => setMobileSidebarOpen(false)} />}
      <div ref={sidebarRef} className={`sidebar-wrap${mobileSidebarOpen ? ' mobile-open' : ''}${collapsed ? ' sidebar-wrap--collapsed' : ''}`}>
        <div className="sidebar-shell">

          {/* Brand — logo + wordmark + search trigger. Always visible; text hides when collapsed
              (CSS), same effect as today's rail-only collapsed state without unmounting anything. */}
          <div className="sidebar-brand">
            <div className="sidebar-brand-icon" title={settings?.app_name || 'Crest'}>
              {settings?.logo_url
                ? <img src={settings.logo_url} alt="logo" style={{ width: 28, height: 28, objectFit: 'contain', borderRadius: 4 }} />
                /* aria-hidden, not aria-label — the visible wordmark right next to it already
                   names the brand; a labeled icon plus adjacent text double-announces it. */
                : <Hexagon size={22} strokeWidth={2} aria-hidden="true" style={{ color: 'var(--theme-accent-ink)' }} />}
            </div>
            <div className="sidebar-brand-text">
              <div className="sidebar-brand-name" title={settings?.app_name || 'Crest'}>{settings?.app_name || 'Crest'}</div>
              <div className="sidebar-brand-sub">{PANEL_TITLES[panel] || 'Crest Suite'}</div>
            </div>
            {/* Icon-only, matching the calculator button beside it. The "Ctrl K" text label spent
                ~40px of a 239px row that the white-labeled client wordmark needed to render at all
                — the shortcut now lives in the tooltip (the same call, and the same reasoning, the
                calc button already documents) and in the palette's own footer hint. */}
            <button className="sidebar-search-btn" onClick={() => setPaletteOpen(true)} title="Search pages (Ctrl+K)" aria-label="Search pages">
              <Search size={13} strokeWidth={2} aria-hidden="true" />
            </button>
            {/* Icon-only (no shortcut label) — the brand row can't fit a second "Alt C" chip
                without squeezing the wordmark; the shortcut lives in the title tooltip. */}
            <button
              className="sidebar-search-btn sidebar-calc-btn"
              onClick={() => setCalcOpen(true)}
              title="Quick calculator (Alt+C)"
              aria-label="Open quick calculator"
            >
              <Calculator size={13} strokeWidth={2} aria-hidden="true" />
            </button>
          </div>

          {/* Module switcher — hidden entirely for a single-tab user (one pill reads as broken UI,
              same case where today's rail just shows that one module's icon alone). Admin gets its
              own row above IMS/HR/POS: it's a different axis (which panel of the app) from the
              module row (which client module), and sharing one row read as a 4th module. */}
          {/* Its own landmark: this is the primary mode switch of the entire product, and it
              previously sat outside every landmark on the page (the only two were the unlabeled
              sidebar nav and main), so it was unreachable by landmark navigation. */}
          {totalTabCount > 1 && (
            <nav aria-label="Modules">
              {adminTab && (
                <div className="module-switcher module-switcher--admin">
                  {renderModuleTab(adminTab)}
                </div>
              )}
              {moduleTabs.length > 0 && (
                <div className="module-switcher">
                  {moduleTabs.map(renderModuleTab)}
                </div>
              )}
            </nav>
          )}

        {/* Everything below hides when collapsed (CSS) — client badge, nav, footer. Kept mounted
            rather than conditionally rendered so scroll position / dropdown state survive a
            collapse/expand toggle instead of resetting. */}
        <div className="sidebar-content">

        {/* Role / client badge */}
        {(() => (
          isAdmin ? (
            <div className="sidebar-client" ref={dropdownRef}>
              <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 8 }}>
                <div style={{ minWidth: 0, flex: 1 }}>
                  <span className="sidebar-client-label">{adminViewClientId ? 'Viewing' : 'Admin View'}</span>

                  {/* Custom dropdown trigger */}
                  <button
                    className="sidebar-dropdown-trigger"
                    onClick={() => setClientDropdownOpen(o => !o)}
                    aria-haspopup="listbox"
                    aria-expanded={clientDropdownOpen}
                  >
                    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>
                      {allClients.find(c => c.id === adminViewClientId)?.name || 'Crest Admin'}
                    </span>
                    <ChevronDown size={13} strokeWidth={2.25} aria-hidden="true" className={`sidebar-dropdown-arrow${clientDropdownOpen ? ' sidebar-dropdown-arrow--open' : ''}`} />
                  </button>
                </div>
                {userInfoBlock}
              </div>

              {/* Subscription badge for selected client */}
              {!clientDropdownOpen && (() => {
                const viewed = allClients.find(c => c.id === adminViewClientId)
                if (!viewed) return null
                const s = getSubStatus(viewed)
                if (!s.label) return null
                return (
                  <span style={{
                    fontSize: 11, fontWeight: 700, padding: '2px 8px', borderRadius: 'var(--radius-sm)',
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
                            fontSize: 11, fontWeight: 700, padding: '2px 8px', borderRadius: 'var(--radius-sm)', flexShrink: 0,
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
              <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 8 }}>
                <div style={{ minWidth: 0, flex: 1 }}>
                  <span className="sidebar-client-label">
                    Property ·{' '}
                    <span style={{ color: plan === 'pro' ? 'var(--theme-accent-ink)' : plan === 'growth' ? 'var(--theme-green-text)' : 'var(--theme-text3)', fontWeight: 700 }}>
                      {plan === 'pro' ? 'Pro' : plan === 'growth' ? 'Growth' : 'Starter'}
                    </span>
                  </span>
                  {/* Multi-outlet: the same dropdown mechanic the admin switcher above uses, but
                      scoped to this owner's own group and written through set_active_outlet().
                      canSwitchOutlet is false for every staff account and for anyone with fewer
                      than two outlets, so an ungrouped client sees exactly what they see today. */}
                  {canSwitchOutlet ? (
                    <button
                      type="button"
                      className="sidebar-dropdown-trigger"
                      onClick={() => setOutletDropdownOpen(o => !o)}
                      aria-haspopup="listbox"
                      aria-expanded={outletDropdownOpen}
                      disabled={switchingOutlet}
                    >
                      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>
                        {switchingOutlet ? 'Switching…' : clientName}
                      </span>
                      <ChevronDown size={13} strokeWidth={2.25} aria-hidden="true" className={`sidebar-dropdown-arrow${outletDropdownOpen ? ' sidebar-dropdown-arrow--open' : ''}`} />
                    </button>
                  ) : (
                    <span className="sidebar-client-name">{clientName}</span>
                  )}
                </div>
                {userInfoBlock}
              </div>
              {!outletDropdownOpen && (() => {
                const s = getSubStatus(profile?.clients)
                if (!s.label) return null
                return (
                  <span style={{
                    fontSize: 11, fontWeight: 700, padding: '2px 8px', borderRadius: 'var(--radius-sm)',
                    marginTop: 5, display: 'inline-block',
                    color: s.color, background: s.bg, border: `1px solid ${s.border}`
                  }}>
                    {s.label}
                  </span>
                )
              })()}
              {outletDropdownOpen && canSwitchOutlet && (
                <div className="sidebar-dropdown-panel" ref={outletDropdownRef} role="listbox">
                  {/* switchableOutlets, not outlets: an allowlisted manager may reach two of the
                      group's five branches, and offering the other three would fail server-side
                      inside set_active_outlet() with an error rather than a closed door (S617). */}
                  {switchableOutlets.map(o => {
                    const s = getSubStatus(o)
                    const active = o.id === clientId
                    return (
                      <button
                        key={o.id}
                        role="option"
                        aria-selected={active}
                        className={`sidebar-dropdown-item${active ? ' sidebar-dropdown-item--active' : ''}`}
                        onClick={() => handleSwitchOutlet(o.id)}
                      >
                        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{o.name}</span>
                        {/* A lapsed outlet inside a healthy group locks only itself
                            (getAccessState/ProtectedRoute are per selected outlet), so the badge
                            is the only warning before someone switches into a locked app. */}
                        {s.label && (
                          <span style={{
                            fontSize: 11, fontWeight: 700, padding: '2px 8px', borderRadius: 'var(--radius-sm)', flexShrink: 0,
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
              {outletError && (
                <p role="alert" style={{ fontSize: 10, color: 'var(--theme-red-text)', margin: '6px 0 0' }}>{outletError}</p>
              )}
            </div>
          ) : null
        ))()}

        <nav className="sidebar-nav" id="sidebar-nav" aria-label={`${PANEL_TITLES[panel] || 'Crest'} pages`}>
          {/* Owner Dashboard (cross-module, renders regardless of active panel — SuiteGate inside
              the page itself handles the ineligible-viewer upsell) + this panel's own Dashboard,
              paired side by side by renderDashboardRow() below instead of two stacked rows. */}

          {panel === 'admin' && isAdmin && (
            <>
              {renderDashboardRow()}
              {renderPinnedGroup()}
              {/* Crest Suite renders LAST on this panel, unlike every other one. On a module
                  panel it sits high because it is the Owner's own primary destination; on the
                  admin panel it is a client-facing layer the operator is looking at from the
                  outside, and Clients / Periods / Guest Menu / Audit Log / Settings are the
                  actual work. Five Suite rows above them pushed the operator's daily tools
                  below the fold. */}
              <NavLink to="/admin/clients"
                className={({ isActive }) => `sidebar-link${isActive ? ' sidebar-link--active' : ''}`}
                style={newTrialCount > 0 && pendingTrialCount === 0 ? {
                  background: 'rgba(251,191,36,0.10)',
                  boxShadow: 'inset 0 0 0 1px rgba(251,191,36,0.35)',
                } : {}}
                onClick={() => setMobileSidebarOpen(false)}>
                <span className="sidebar-icon"><Building2 size={16} strokeWidth={1.75} /></span>
                <span style={{ display: 'flex', alignItems: 'center', gap: 6, flex: 1 }}>
                  Clients
                  {/* Both count badges use an alpha-tint fill + full-opacity signal text, per
                      DESIGN.md's badge spec — the previous solid fills paired hardcoded #fff /
                      #000 foregrounds that failed contrast on several presets. */}
                  {pendingTrialCount > 0 && (
                    <span style={{ fontSize: 11, fontWeight: 800, background: 'rgba(248,113,113,0.15)', color: 'var(--theme-red-text)', border: '1px solid rgba(248,113,113,0.35)', borderRadius: 10, padding: '2px 8px', lineHeight: 1.4 }}
                      title="Clients requesting to subscribe">
                      {pendingTrialCount} want to sub
                    </span>
                  )}
                  {newTrialCount > 0 && (
                    <span style={{ fontSize: 11, fontWeight: 800, background: 'rgba(251,191,36,0.15)', color: 'var(--theme-amber-text)', border: '1px solid rgba(251,191,36,0.35)', borderRadius: 10, padding: '2px 8px', lineHeight: 1.4 }}
                      title="New trial signups in the last 7 days">
                      {newTrialCount} NEW
                    </span>
                  )}
                </span>
              </NavLink>
              {renderNavItem({ to: '/periods', label: 'Periods', icon: CalendarRange })}
              {renderNavItem({ to: '/admin/guest-menu', label: 'Guest Menu', icon: QrCode })}
              {renderNavItem({ to: '/admin/audit', label: 'Audit Log', icon: History })}
              {renderNavItem({ to: '/settings', label: 'Settings', icon: Settings })}
              {renderSuiteGroup()}
            </>
          )}

          {panel === 'ims' && imsVisible && (
            <>
              {renderDashboardRow()}
              {renderSuiteGroup()}
              {renderPinnedGroup()}
              {IMS_GROUPS.map(renderGroup)}

              {renderUpgradeTeaser()}

              {!isAdmin && hasFeature('settings') && hasImsAccess('manager') && (
                <div style={{ marginTop: 8 }}>
                  {renderNavItem({ to: '/settings', label: 'Settings', icon: Settings })}
                </div>
              )}
            </>
          )}

          {panel === 'hr' && hrVisible && (
            <>
              {renderDashboardRow()}
              {renderSuiteGroup()}
              {renderPinnedGroup()}
              {isItemVisible(HR_DASHBOARD) && renderNavItem(HR_DASHBOARD)}
              {HR_GROUPS.map(renderGroup)}
            </>
          )}

          {panel === 'pos' && posVisible && (
            <>
              {renderDashboardRow()}
              {renderSuiteGroup()}
              {renderPinnedGroup()}
              {POS_GROUPS.map(group => renderGroup({ ...group, items: group.items.filter(isItemVisible) }))}
            </>
          )}
        </nav>

        {!isAdmin && plan !== 'pro' && (
          <div className="sidebar-footer">
            <button
              onClick={() => navigate('/pricing')}
              style={{
                width: '100%', fontSize: 12, fontWeight: 700, letterSpacing: '0.04em',
                color: plan === 'growth' ? 'var(--theme-accent-ink)' : 'var(--theme-green-text)',
                // Tint from the preset's own token — the old rgba literals froze the DARK
                // preset's green/brass under every light theme, and the chip measured 4.42:1
                // on Light (S612).
                background: colorTint(plan === 'growth' ? 'var(--theme-accent)' : 'var(--theme-green)', 10),
                border: `1px solid ${colorTint(plan === 'growth' ? 'var(--theme-accent)' : 'var(--theme-green)', 25)}`,
                borderRadius: 'var(--radius-md)', padding: '7px 8px', cursor: 'pointer', display: 'block'
              }}
            >
              {plan === 'growth' ? 'Growth' : 'Starter'} · Upgrade ↑
            </button>
          </div>
        )}
        </div>{/* /sidebar-content */}

        {/* Bottom-anchored, icon-only, always visible regardless of collapsed state — same three
            actions today's rail always kept visible at its bottom. */}
        <nav className="sidebar-bottom" aria-label="Help and account">
          <RailTip label="Help">
            <NavLink to="/help" title="Help"
              className={({ isActive }) => `rail-btn${isActive ? ' rail-btn--active' : ''}`}
              onClick={() => setMobileSidebarOpen(false)}><HelpCircle size={18} strokeWidth={1.75} /></NavLink>
          </RailTip>
          <RailTip label={collapsed ? 'Show menu' : 'Hide menu'}>
            <button className="rail-btn" title={collapsed ? 'Show menu' : 'Hide menu'}
              onClick={() => setCollapsed(c => !c)}>
              {collapsed ? <PanelLeftOpen size={18} strokeWidth={1.75} /> : <PanelLeftClose size={18} strokeWidth={1.75} />}
            </button>
          </RailTip>
          <RailTip label={isPinStaff ? 'Lock POS' : 'Sign out'}>
            <button className="rail-btn rail-btn--signout" title={isPinStaff ? 'Lock POS' : 'Sign out'}
              onClick={handleSignOut}><LogOut size={18} strokeWidth={1.75} /></button>
          </RailTip>
        </nav>
        </div>{/* /sidebar-shell */}
      </div>

      <main id="main-content" tabIndex={-1} className={`main-content${collapsed ? ' main-content--collapsed' : ''}`}>
        {/* "☰" is a glyph, not an accessible name — this button announced as the character itself,
            with no indication it opens anything or whether it is currently open. */}
        <button
          ref={hamburgerRef}
          className="mobile-hamburger"
          aria-label="Open navigation menu"
          aria-expanded={mobileSidebarOpen}
          aria-controls="sidebar-nav"
          onClick={() => { setMobileSidebarOpen(true); setCollapsed(false) }}
        >
          <span aria-hidden="true">☰</span>
        </button>

        {/* Grace period — the subscription end date has passed but access is not cut yet. This is
            the only warning a paying client gets before SubscriptionLock replaces the whole app,
            so it states the exact date access stops rather than just "expired". */}
        {accessReason === 'grace' && (
          <div style={{
            background: 'rgba(248,113,113,0.1)', border: '1px solid rgba(248,113,113,0.4)',
            borderRadius: 'var(--radius-sm)', padding: '12px 16px', marginBottom: 20,
            display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap',
          }} role="status">
            <div>
              <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--theme-red-text)' }}>
                ⚠️ Your subscription has expired — access ends in {graceDaysLeft} day{graceDaysLeft !== 1 ? 's' : ''}
              </span>
              <span style={{ fontSize: 12, color: 'var(--theme-text2)', marginLeft: 10 }}>
                Renew to keep using Crest. Your data stays exactly as it is.
              </span>
            </div>
            {!subscribeRequested ? (
              <button
                onClick={async () => { setSubscribing(true); await requestSubscription(); setSubscribing(false) }}
                disabled={subscribing}
                style={{ background: 'var(--theme-accent)', border: 'none', color: 'var(--theme-accent-text)', padding: '7px 18px', borderRadius: 'var(--radius-md)', cursor: 'pointer', fontSize: 12, fontWeight: 800, whiteSpace: 'nowrap' }}>
                {subscribing ? 'Sending…' : 'Renew Now →'}
              </button>
            ) : (
              <span style={{ fontSize: 12, color: 'var(--theme-red-text)', fontWeight: 600 }}>✓ Request sent — we'll be in touch</span>
            )}
          </div>
        )}

        {/* Trial banners — shown from day 4 onwards and after expiry */}
        {isTrial && !trialExpired && trialDaysLeft <= 4 && (
          <div style={{
            background: 'rgba(251,191,36,0.1)', border: '1px solid rgba(251,191,36,0.35)',
            borderRadius: 'var(--radius-sm)', padding: '12px 16px', marginBottom: 20,
            display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap',
          }} role="status">
            <div>
              <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--theme-amber-text)' }}>
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
                style={{ background: 'var(--theme-accent)', border: 'none', color: 'var(--theme-accent-text)', padding: '7px 18px', borderRadius: 'var(--radius-md)', cursor: 'pointer', fontSize: 12, fontWeight: 800, whiteSpace: 'nowrap' }}>
                {subscribing ? 'Sending…' : 'I Want to Subscribe →'}
              </button>
            ) : (
              <span style={{ fontSize: 12, color: 'var(--theme-amber-text)', fontWeight: 600 }}>✓ Request sent — we'll be in touch</span>
            )}
          </div>
        )}

        {/* The two post-expiry trial banners that used to sit here are gone: a trial-expired client
            is now locked out by ProtectedRoute and never renders Layout at all, so they were
            unreachable. Their copy — including the trial_purge_at retention countdown — moved into
            SubscriptionLock's `trial` case. */}

        {/* Renders on every route, at every width, in both collapse states — that is the whole
            point of it, so it deliberately does not hide on the dashboard that happens to repeat
            the same facts in its own subtitle. Quiet by construction: secondary text, one hairline,
            no card. The period is the emphasised token because it is the one that silently changes
            under you; POS/kitchen staff accounts and non-IMS clients simply get no period segment
            rather than an empty one. */}
        {clientName && (
          <div className="context-bar">
            <span className="context-bar-client">{clientName}</span>
            {adminViewClientId && <span className="context-bar-tag">Viewing as admin</span>}
            {activePeriod && (
              <>
                <span aria-hidden="true" className="context-bar-sep">·</span>
                <span className="context-bar-period">
                  {BS_MONTHS[activePeriod.bs_month - 1]} {activePeriod.bs_year}
                </span>
                <span className={`badge ${activePeriod.status === 'open' ? 'badge-green' : 'badge-gray'}`}>
                  {activePeriod.status === 'open' ? 'Open' : 'Closed'}
                </span>
              </>
            )}
            {!isAdmin && (
              <>
                <span aria-hidden="true" className="context-bar-sep">·</span>
                <span className="context-bar-plan">{plan === 'pro' ? 'Pro' : plan === 'growth' ? 'Growth' : 'Starter'}</span>
              </>
            )}
          </div>
        )}

        {/* Page scope (S673): wraps ONLY the Suspense/Outlet, not the whole <main> — a crash inside
            a page renders this fallback in place with the sidebar and header still standing;
            navigating away (resetKey = location.pathname) clears it automatically. Wrapping more
            than this would let a Layout render error be swallowed here instead of falling through
            to the app-scope boundary in App.js. */}
        <AppErrorBoundary resetKey={location.pathname} fullPage={false} route={location.pathname}>
          <Suspense fallback={<RouteFallback />}>
            <Outlet />
          </Suspense>
        </AppErrorBoundary>
      </main>

      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        items={paletteItems}
        onSelect={handlePaletteSelect}
      />

      <QuickCalculator open={calcOpen} onClose={() => setCalcOpen(false)} />

      {/* POS idle-lock warning — any deliberate input (pointerdown/keydown/touch/wheel) resets
          the timer, which is why the toast needs no button of its own. role="alert" so a screen
          reader hears the countdown start, not just the sudden return to the PIN screen. */}
      {idleLockSecs != null && (
        <div role="alert" className="no-print" style={{
          position: 'fixed', bottom: 20, left: '50%', transform: 'translateX(-50%)', zIndex: 400,
          background: 'var(--theme-card)', border: '1px solid var(--theme-amber)',
          borderRadius: 'var(--radius-md)', padding: '10px 18px', boxShadow: '0 6px 24px rgba(0,0,0,0.25)',
          fontSize: 13, color: 'var(--theme-text1)', maxWidth: 'calc(100vw - 32px)',
        }}>
          <strong style={{ color: 'var(--theme-amber-text)' }}>Locking in {idleLockSecs}s</strong>
          {' '}— touch the screen or press any key to stay signed in.
        </div>
      )}
    </div>
  )
}
