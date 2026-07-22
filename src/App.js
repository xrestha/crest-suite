import { lazy, Suspense } from 'react'
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { AuthProvider } from './context/AuthContext'
import { SettingsProvider } from './context/SettingsContext'
import { ThemeProvider } from './context/ThemeContext'
// Structural pieces stay eagerly imported — they render on every route (Layout, the guards,
// ProtectedRoute) so lazy-loading them would only add a spinner with no payload win. Every page
// component below is lazy-loaded (React.lazy) so each route ships as its own chunk instead of
// one ~930 kB monolith; the <Suspense> boundaries (top-level here + around Layout's <Outlet />)
// render RouteFallback while a chunk is fetched.
import ProtectedRoute from './components/ProtectedRoute'
import Layout from './components/Layout'
import PremiumGate from './components/PremiumGate'
import ModuleGate from './components/ModuleGate'
import RouteFallback from './components/RouteFallback'
import './components/Layout.css'
const Login = lazy(() => import('./pages/Login'))
const Dashboard = lazy(() => import('./pages/Dashboard'))
const OwnerDashboard = lazy(() => import('./pages/dashboard/OwnerDashboard'))
const MonthlyOwnerReport = lazy(() => import('./pages/dashboard/MonthlyOwnerReport'))
const Periods = lazy(() => import('./pages/Periods'))
const Items = lazy(() => import('./modules/ims/items/Items'))
const Vendors = lazy(() => import('./modules/ims/vendors/Vendors'))
const GatePasses = lazy(() => import('./modules/ims/gatepasses/GatePasses'))
const Purchases = lazy(() => import('./modules/ims/purchases/Purchases'))
const PurchaseOrders = lazy(() => import('./modules/ims/purchases/PurchaseOrders'))
const Stock = lazy(() => import('./modules/ims/stockcount/Stock'))
const Recipes = lazy(() => import('./modules/ims/recipes/Recipes'))
const Sales = lazy(() => import('./modules/ims/sales/Sales'))
const Variance = lazy(() => import('./modules/ims/variance/Variance'))
const MonthlySummary = lazy(() => import('./modules/ims/reports/MonthlySummary'))
const FifoReport = lazy(() => import('./modules/ims/reports/FifoReport'))
const PaymentReport = lazy(() => import('./modules/ims/reports/PaymentReport'))
const Help = lazy(() => import('./pages/Help'))
const VendorReport = lazy(() => import('./modules/ims/reports/VendorReport'))
const ReorderReport = lazy(() => import('./modules/ims/stockcount/ReorderReport'))
const StockMovements = lazy(() => import('./modules/ims/stockcount/StockMovements'))
const SupplierPriceTracker = lazy(() => import('./modules/ims/purchases/SupplierPriceTracker'))
const MenuEngineering = lazy(() => import('./modules/ims/recipes/MenuEngineering'))
const AdminClients = lazy(() => import('./pages/AdminClients'))
const AuditLog = lazy(() => import('./pages/AuditLog'))
const AdminGuestMenu = lazy(() => import('./pages/AdminGuestMenu'))
const Overheads = lazy(() => import('./modules/ims/reports/Overheads'))
const BudgetVsActual = lazy(() => import('./modules/ims/reports/BudgetVsActual'))
const BestSellers = lazy(() => import('./modules/ims/reports/BestSellers'))
const VatReport = lazy(() => import('./modules/ims/reports/VatReport'))
const NonVatReport = lazy(() => import('./modules/ims/reports/NonVatReport'))
const Settings = lazy(() => import('./pages/Settings'))
const Pricing = lazy(() => import('./pages/Pricing'))
const TheoreticalVariance = lazy(() => import('./modules/ims/variance/TheoreticalVariance'))
const Requisitions = lazy(() => import('./modules/ims/sales/Requisitions'))
const WastageReport = lazy(() => import('./modules/ims/variance/WastageReport'))
const StockReport = lazy(() => import('./modules/ims/stockcount/StockReport'))
const DemandForecast = lazy(() => import('./modules/ims/stockcount/DemandForecast'))
const ComboBuilder = lazy(() => import('./modules/ims/recipes/ComboBuilder'))
const DeadStock = lazy(() => import('./modules/ims/stockcount/DeadStock'))
const RecipeMargin = lazy(() => import('./modules/ims/recipes/RecipeMargin'))
const MenuRepricing = lazy(() => import('./modules/ims/recipes/MenuRepricing'))
const MenuPricing = lazy(() => import('./modules/ims/recipes/MenuPricing'))
const PeriodComparison = lazy(() => import('./modules/ims/reports/PeriodComparison'))
const AnnualSummary = lazy(() => import('./modules/ims/reports/AnnualSummary'))
const OutstandingPayables = lazy(() => import('./modules/ims/reports/OutstandingPayables'))
const ShrinkageReport = lazy(() => import('./modules/ims/variance/ShrinkageReport'))
const ImsStaff = lazy(() => import('./modules/ims/staff/ImsStaff'))
const HrStaff = lazy(() => import('./modules/hr/staff/HrStaff'))
const EmployeeList = lazy(() => import('./modules/hr/employees/EmployeeList'))
const PaySetup = lazy(() => import('./modules/hr/pay/PaySetup'))
const AttendanceSheet = lazy(() => import('./modules/hr/attendance/AttendanceSheet'))
const PayrollRun = lazy(() => import('./modules/hr/payroll/PayrollRun'))
const PayrollCalculation = lazy(() => import('./modules/hr/payroll/PayrollCalculation'))
const HrReports = lazy(() => import('./modules/hr/reports/HrReports'))
const FestivalAllowance = lazy(() => import('./modules/hr/festival/FestivalAllowance'))
const LeaveManagement = lazy(() => import('./modules/hr/leave/LeaveManagement'))
const Advances = lazy(() => import('./modules/hr/advances/Advances'))
const GratuityTracker = lazy(() => import('./modules/hr/gratuity/GratuityTracker'))
const FinalSettlement = lazy(() => import('./modules/hr/settlement/FinalSettlement'))
const Roster = lazy(() => import('./modules/hr/roster/Roster'))
const HolidayCalendar = lazy(() => import('./modules/hr/holidays/HolidayCalendar'))
const Overtime = lazy(() => import('./modules/hr/overtime/Overtime'))
const TadaClaims = lazy(() => import('./modules/hr/tada/TadaClaims'))
const IncentiveRun = lazy(() => import('./modules/hr/incentives/IncentiveRun'))
const SelfServiceLogin = lazy(() => import('./modules/hr/selfservice/SelfServiceLogin'))
const SelfServiceHome = lazy(() => import('./modules/hr/selfservice/SelfServiceHome'))
const HrDashboard = lazy(() => import('./modules/hr/dashboard/HrDashboard'))
const Pos = lazy(() => import('./modules/pos/Pos'))
const PosOrders = lazy(() => import('./modules/pos/orders/PosOrders'))
const PosTableManagement = lazy(() => import('./modules/pos/tables/PosTableManagement'))
const PosStaff = lazy(() => import('./modules/pos/staff/PosStaff'))
const PosCustomers = lazy(() => import('./modules/pos/customers/PosCustomers'))
const PosParkingSlips = lazy(() => import('./modules/pos/parking/PosParkingSlips'))
const PosExceptionReport = lazy(() => import('./modules/pos/reports/PosExceptionReport'))
const PosShifts = lazy(() => import('./modules/pos/shifts/PosShifts'))
const CreditNotes = lazy(() => import('./modules/pos/creditnotes/CreditNotes'))
const SalesReport = lazy(() => import('./modules/pos/reports/SalesReport'))
const KotLog = lazy(() => import('./modules/pos/reports/KotLog'))
const CoversReport = lazy(() => import('./modules/pos/reports/CoversReport'))
const PurchaseOneLakhAboveReport = lazy(() => import('./modules/ims/reports/PurchaseOneLakhAboveReport'))
const PosLogin = lazy(() => import('./modules/pos/login/PosLogin'))
const GuestMenu = lazy(() => import('./modules/pos/guestmenu/GuestMenu'))
const KitchenDisplay = lazy(() => import('./modules/pos/kds/KitchenDisplay'))

function RootRedirect() {
  if (localStorage.getItem('pos_device_client_id')) return <Navigate to="/pos/login" replace />
  return <Navigate to="/dashboard" replace />
}

export default function App() {
  return (
    <ThemeProvider>
    <AuthProvider>
      <SettingsProvider>
        <BrowserRouter>
          <Suspense fallback={<RouteFallback />}>
          <Routes>
            <Route path="/login"     element={<Login />} />
            <Route path="/pricing"   element={<Pricing />} />
            <Route path="/pos/login" element={<PosLogin />} />
            <Route path="/pos/menu/:tableId" element={<GuestMenu />} />
            <Route path="/hr/self-service/login/:clientId" element={<SelfServiceLogin />} />
            <Route path="/hr/self-service" element={<SelfServiceHome />} />
            <Route path="/" element={<RootRedirect />} />
            <Route element={<ProtectedRoute><Layout /></ProtectedRoute>}>

              {/* Universal — all authenticated users regardless of module */}
              <Route path="/dashboard"        element={<Dashboard />} />
              <Route path="/owner-dashboard"  element={<OwnerDashboard />} />
              <Route path="/owner-report"     element={<MonthlyOwnerReport />} />
              <Route path="/periods"          element={<Periods />} />
              <Route path="/help"       element={<Help />} />

              {/* Crest IMS — gated on ims_enabled */}
              <Route path="/items"     element={<ModuleGate module="ims"><Items /></ModuleGate>} />
              <Route path="/vendors"   element={<ModuleGate module="ims"><Vendors /></ModuleGate>} />
              <Route path="/gate-passes" element={<ModuleGate module="ims"><GatePasses /></ModuleGate>} />
              <Route path="/purchases" element={<ModuleGate module="ims"><Purchases /></ModuleGate>} />
              <Route path="/stock"     element={<ModuleGate module="ims"><Stock /></ModuleGate>} />

              {/* IMS Starter */}
              <Route path="/sales"
                element={<ModuleGate module="ims"><PremiumGate featureKey="sales_entry" minPlan="starter"><Sales /></PremiumGate></ModuleGate>} />
              <Route path="/payments"
                element={<ModuleGate module="ims"><PremiumGate featureKey="payment_summary" minPlan="starter"><PaymentReport /></PremiumGate></ModuleGate>} />
              <Route path="/summary"
                element={<ModuleGate module="ims"><PremiumGate featureKey="monthly_summary" minPlan="starter"><MonthlySummary /></PremiumGate></ModuleGate>} />
              <Route path="/annual-summary"
                element={<ModuleGate module="ims"><PremiumGate featureKey="annual_summary" minPlan="starter"><AnnualSummary /></PremiumGate></ModuleGate>} />
              <Route path="/reorder"
                element={<ModuleGate module="ims"><PremiumGate featureKey="reorder_report" minPlan="starter"><ReorderReport /></PremiumGate></ModuleGate>} />
              <Route path="/stock-movements"
                element={<ModuleGate module="ims"><PremiumGate featureKey="stock_movement_log" minPlan="starter"><StockMovements /></PremiumGate></ModuleGate>} />
              <Route path="/vat-report"
                element={<ModuleGate module="ims"><PremiumGate featureKey="vat_report" minPlan="starter"><VatReport /></PremiumGate></ModuleGate>} />
              <Route path="/purchase-one-lakh-report"
                element={<ModuleGate module="ims"><PremiumGate featureKey="vat_report" minPlan="starter"><PurchaseOneLakhAboveReport /></PremiumGate></ModuleGate>} />
              <Route path="/non-vat-report"
                element={<ModuleGate module="ims"><PremiumGate featureKey="non_vat_report" minPlan="starter"><NonVatReport /></PremiumGate></ModuleGate>} />
              <Route path="/wastage-report"
                element={<ModuleGate module="ims"><PremiumGate featureKey="wastage_report" minPlan="starter"><WastageReport /></PremiumGate></ModuleGate>} />
              <Route path="/stock-report"
                element={<ModuleGate module="ims"><PremiumGate featureKey="stock_report" minPlan="starter"><StockReport /></PremiumGate></ModuleGate>} />
              <Route path="/settings"
                element={<ModuleGate module="ims"><PremiumGate featureKey="settings" minPlan="starter"><Settings /></PremiumGate></ModuleGate>} />

              {/* IMS Growth */}
              <Route path="/recipes"
                element={<ModuleGate module="ims"><PremiumGate featureKey="recipe_costing" minPlan="growth"><Recipes /></PremiumGate></ModuleGate>} />
              <Route path="/variance"
                element={<ModuleGate module="ims"><PremiumGate featureKey="variance_report" minPlan="growth"><Variance /></PremiumGate></ModuleGate>} />
              <Route path="/payables"
                element={<ModuleGate module="ims"><PremiumGate featureKey="outstanding_payables" minPlan="growth"><OutstandingPayables /></PremiumGate></ModuleGate>} />
              <Route path="/budget"
                element={<ModuleGate module="ims"><PremiumGate featureKey="budget_vs_actual" minPlan="growth"><BudgetVsActual /></PremiumGate></ModuleGate>} />
              <Route path="/demand-forecast"
                element={<ModuleGate module="ims"><PremiumGate featureKey="demand_forecast" minPlan="pro"><DemandForecast /></PremiumGate></ModuleGate>} />
              <Route path="/combo-builder"
                element={<ModuleGate module="ims"><PremiumGate featureKey="combo_builder" minPlan="growth"><ComboBuilder /></PremiumGate></ModuleGate>} />
              <Route path="/requisitions"
                element={<ModuleGate module="ims"><PremiumGate featureKey="requisitions" minPlan="growth"><Requisitions /></PremiumGate></ModuleGate>} />
              <Route path="/dead-stock"
                element={<ModuleGate module="ims"><PremiumGate featureKey="dead_stock" minPlan="growth"><DeadStock /></PremiumGate></ModuleGate>} />
              <Route path="/recipe-margin"
                element={<ModuleGate module="ims"><PremiumGate featureKey="recipe_margin" minPlan="growth"><RecipeMargin /></PremiumGate></ModuleGate>} />
              <Route path="/menu-pricing"
                element={<PremiumGate featureKey="menu_pricing" minPlan="starter"><MenuPricing /></PremiumGate>} />
              <Route path="/menu-repricing"
                element={<ModuleGate module="ims"><PremiumGate featureKey="menu_repricing" minPlan="growth"><MenuRepricing /></PremiumGate></ModuleGate>} />
              <Route path="/best-sellers"
                element={<ModuleGate module="ims"><PremiumGate featureKey="best_sellers" minPlan="growth"><BestSellers /></PremiumGate></ModuleGate>} />
              <Route path="/purchase-orders"
                element={<ModuleGate module="ims"><PremiumGate featureKey="purchase_orders" minPlan="growth"><PurchaseOrders /></PremiumGate></ModuleGate>} />

              {/* IMS Pro */}
              <Route path="/period-comparison"
                element={<ModuleGate module="ims"><PremiumGate featureKey="period_comparison" minPlan="pro"><PeriodComparison /></PremiumGate></ModuleGate>} />
              <Route path="/shrinkage"
                element={<ModuleGate module="ims"><PremiumGate featureKey="shrinkage_report" minPlan="pro"><ShrinkageReport /></PremiumGate></ModuleGate>} />
              <Route path="/menu-engineering"
                element={<ModuleGate module="ims"><PremiumGate featureKey="menu_engineering" minPlan="pro"><MenuEngineering /></PremiumGate></ModuleGate>} />
              <Route path="/fifo"
                element={<ModuleGate module="ims"><PremiumGate featureKey="fifo_report" minPlan="pro"><FifoReport /></PremiumGate></ModuleGate>} />
              <Route path="/vendors-report"
                element={<ModuleGate module="ims"><PremiumGate featureKey="vendor_report" minPlan="pro"><VendorReport /></PremiumGate></ModuleGate>} />
              <Route path="/supplier-prices"
                element={<ModuleGate module="ims"><PremiumGate featureKey="price_tracker" minPlan="pro"><SupplierPriceTracker /></PremiumGate></ModuleGate>} />
              <Route path="/overheads"
                element={<ModuleGate module="ims"><PremiumGate featureKey="overheads" minPlan="pro"><Overheads /></PremiumGate></ModuleGate>} />
              <Route path="/theoretical-variance"
                element={<ModuleGate module="ims"><PremiumGate featureKey="theoretical_variance" minPlan="pro"><TheoreticalVariance /></PremiumGate></ModuleGate>} />
              <Route path="/ims/staff" element={<ModuleGate module="ims"><ImsStaff /></ModuleGate>} />

              {/* Crest HR — gated on hr_enabled */}
              <Route path="/hr/dashboard" element={<ModuleGate module="hr"><HrDashboard /></ModuleGate>} />
              <Route path="/hr/employees" element={<ModuleGate module="hr"><EmployeeList /></ModuleGate>} />
              <Route path="/hr/pay-setup" element={<ModuleGate module="hr"><PaySetup /></ModuleGate>} />
              <Route path="/hr/attendance" element={<ModuleGate module="hr"><AttendanceSheet /></ModuleGate>} />
              <Route path="/hr/leave"      element={<ModuleGate module="hr"><LeaveManagement /></ModuleGate>} />
              <Route path="/hr/payroll"    element={<ModuleGate module="hr"><PayrollRun /></ModuleGate>} />
              <Route path="/hr/calculation" element={<ModuleGate module="hr"><PayrollCalculation /></ModuleGate>} />
              <Route path="/hr/reports"    element={<ModuleGate module="hr"><HrReports /></ModuleGate>} />
              <Route path="/hr/festival"   element={<ModuleGate module="hr"><FestivalAllowance /></ModuleGate>} />
              <Route path="/hr/advances"   element={<ModuleGate module="hr"><Advances /></ModuleGate>} />
              <Route path="/hr/tada"       element={<ModuleGate module="hr"><TadaClaims /></ModuleGate>} />
              <Route path="/hr/incentives" element={<ModuleGate module="hr"><IncentiveRun /></ModuleGate>} />
              <Route path="/hr/gratuity"   element={<ModuleGate module="hr"><GratuityTracker /></ModuleGate>} />
              <Route path="/hr/settlement" element={<ModuleGate module="hr"><FinalSettlement /></ModuleGate>} />
              <Route path="/hr/roster"     element={<ModuleGate module="hr"><Roster /></ModuleGate>} />
              <Route path="/hr/holidays"   element={<ModuleGate module="hr"><HolidayCalendar /></ModuleGate>} />
              <Route path="/hr/overtime"   element={<ModuleGate module="hr"><Overtime /></ModuleGate>} />
              <Route path="/hr/staff"      element={<ModuleGate module="hr"><HrStaff /></ModuleGate>} />

              {/* Crest POS — gated on pos_enabled */}
              <Route path="/pos"        element={<ModuleGate module="pos"><Pos /></ModuleGate>} />
              <Route path="/pos/orders" element={<ModuleGate module="pos"><PosOrders /></ModuleGate>} />
              <Route path="/pos/tables" element={<ModuleGate module="pos"><PosTableManagement /></ModuleGate>} />
              <Route path="/pos/customers" element={<ModuleGate module="pos"><PosCustomers /></ModuleGate>} />
              <Route path="/pos/parking" element={<ModuleGate module="pos"><PosParkingSlips /></ModuleGate>} />
              <Route path="/pos/shifts" element={<ModuleGate module="pos"><PosShifts /></ModuleGate>} />
              <Route path="/pos/exceptions" element={<ModuleGate module="pos"><PosExceptionReport /></ModuleGate>} />
              <Route path="/pos/credit-notes" element={<ModuleGate module="pos"><CreditNotes /></ModuleGate>} />
              <Route path="/pos/sales-report" element={<ModuleGate module="pos"><SalesReport /></ModuleGate>} />
              <Route path="/pos/kot-log" element={<ModuleGate module="pos"><KotLog /></ModuleGate>} />
              <Route path="/pos/covers-report" element={<ModuleGate module="pos"><CoversReport /></ModuleGate>} />
              <Route path="/pos/kds" element={<ModuleGate module="pos"><KitchenDisplay /></ModuleGate>} />
              <Route path="/pos/staff"  element={<ModuleGate module="pos"><PosStaff /></ModuleGate>} />

              {/* Admin only */}
              <Route path="/admin/clients"
                element={<ProtectedRoute adminOnly><AdminClients /></ProtectedRoute>} />
              <Route path="/admin/audit"
                element={<ProtectedRoute adminOnly><AuditLog /></ProtectedRoute>} />
              <Route path="/admin/guest-menu"
                element={<ProtectedRoute adminOnly><AdminGuestMenu /></ProtectedRoute>} />
            </Route>
          </Routes>
          </Suspense>
        </BrowserRouter>
      </SettingsProvider>
    </AuthProvider>
    </ThemeProvider>
  )
}
