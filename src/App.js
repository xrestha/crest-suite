import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { AuthProvider } from './context/AuthContext'
import { SettingsProvider } from './context/SettingsContext'
import { ThemeProvider } from './context/ThemeContext'
import ProtectedRoute from './components/ProtectedRoute'
import Layout from './components/Layout'
import Login from './pages/Login'
import Dashboard from './pages/Dashboard'
import Periods from './pages/Periods'
import Items from './pages/Items'
import Vendors from './pages/Vendors'
import Purchases from './pages/Purchases'
import PurchaseOrders from './pages/PurchaseOrders'
import Stock from './pages/Stock'
import Recipes from './pages/Recipes'
import Sales from './pages/Sales'
import Variance from './pages/Variance'
import MonthlySummary from './pages/MonthlySummary'
import FifoReport from './pages/FifoReport'
import PaymentReport from './pages/PaymentReport'
import Help from './pages/Help'
import VendorReport from './pages/VendorReport'
import ReorderReport from './pages/ReorderReport'
import SupplierPriceTracker from './pages/SupplierPriceTracker'
import MenuEngineering from './pages/MenuEngineering'
import AdminClients from './pages/AdminClients'
import AuditLog from './pages/AuditLog'
import PremiumGate from './components/PremiumGate'
import ModuleGate from './components/ModuleGate'
import Overheads from './pages/Overheads'
import BudgetVsActual from './pages/BudgetVsActual'
import BestSellers from './pages/BestSellers'
import VatReport from './pages/VatReport'
import NonVatReport from './pages/NonVatReport'
import Settings from './pages/Settings'
import Pricing from './pages/Pricing'
import TheoreticalVariance from './pages/TheoreticalVariance'
import Requisitions from './pages/Requisitions'
import WastageReport from './pages/WastageReport'
import StockReport from './pages/StockReport'
import DeadStock from './pages/DeadStock'
import RecipeMargin from './pages/RecipeMargin'
import MenuRepricing from './pages/MenuRepricing'
import MenuPricing from './pages/MenuPricing'
import PeriodComparison from './pages/PeriodComparison'
import AnnualSummary from './pages/AnnualSummary'
import OutstandingPayables from './pages/OutstandingPayables'
import ShrinkageReport from './pages/ShrinkageReport'
import EmployeeList from './modules/hr/employees/EmployeeList'
import PaySetup from './modules/hr/pay/PaySetup'
import AttendanceSheet from './modules/hr/attendance/AttendanceSheet'
import PayrollRun from './modules/hr/payroll/PayrollRun'
import HrReports from './modules/hr/reports/HrReports'
import FestivalAllowance from './modules/hr/festival/FestivalAllowance'
import LeaveManagement from './modules/hr/leave/LeaveManagement'
import Advances from './modules/hr/advances/Advances'
import GratuityTracker from './modules/hr/gratuity/GratuityTracker'
import FinalSettlement from './modules/hr/settlement/FinalSettlement'
import Roster from './modules/hr/roster/Roster'
import HolidayCalendar from './modules/hr/holidays/HolidayCalendar'
import Overtime from './modules/hr/overtime/Overtime'
import HrDashboard from './modules/hr/dashboard/HrDashboard'
import Pos from './modules/pos/Pos'
import PosOrders from './modules/pos/orders/PosOrders'
import PosTableManagement from './modules/pos/tables/PosTableManagement'
import PosStaff from './modules/pos/staff/PosStaff'
import PosCustomers from './modules/pos/customers/PosCustomers'
import PosExceptionReport from './modules/pos/reports/PosExceptionReport'
import PosShifts from './modules/pos/shifts/PosShifts'
import PosLogin from './modules/pos/login/PosLogin'
import './components/Layout.css'

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
          <Routes>
            <Route path="/login"     element={<Login />} />
            <Route path="/pricing"   element={<Pricing />} />
            <Route path="/pos/login" element={<PosLogin />} />
            <Route path="/" element={<RootRedirect />} />
            <Route element={<ProtectedRoute><Layout /></ProtectedRoute>}>

              {/* Universal — all authenticated users regardless of module */}
              <Route path="/dashboard"  element={<Dashboard />} />
              <Route path="/periods"    element={<Periods />} />
              <Route path="/help"       element={<Help />} />

              {/* Crest IMS — gated on ims_enabled */}
              <Route path="/items"     element={<ModuleGate module="ims"><Items /></ModuleGate>} />
              <Route path="/vendors"   element={<ModuleGate module="ims"><Vendors /></ModuleGate>} />
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
              <Route path="/vat-report"
                element={<ModuleGate module="ims"><PremiumGate featureKey="vat_report" minPlan="starter"><VatReport /></PremiumGate></ModuleGate>} />
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

              {/* Crest HR — gated on hr_enabled */}
              <Route path="/hr/dashboard" element={<ModuleGate module="hr"><HrDashboard /></ModuleGate>} />
              <Route path="/hr/employees" element={<ModuleGate module="hr"><EmployeeList /></ModuleGate>} />
              <Route path="/hr/pay-setup" element={<ModuleGate module="hr"><PaySetup /></ModuleGate>} />
              <Route path="/hr/attendance" element={<ModuleGate module="hr"><AttendanceSheet /></ModuleGate>} />
              <Route path="/hr/leave"      element={<ModuleGate module="hr"><LeaveManagement /></ModuleGate>} />
              <Route path="/hr/payroll"    element={<ModuleGate module="hr"><PayrollRun /></ModuleGate>} />
              <Route path="/hr/reports"    element={<ModuleGate module="hr"><HrReports /></ModuleGate>} />
              <Route path="/hr/festival"   element={<ModuleGate module="hr"><FestivalAllowance /></ModuleGate>} />
              <Route path="/hr/advances"   element={<ModuleGate module="hr"><Advances /></ModuleGate>} />
              <Route path="/hr/gratuity"   element={<ModuleGate module="hr"><GratuityTracker /></ModuleGate>} />
              <Route path="/hr/settlement" element={<ModuleGate module="hr"><FinalSettlement /></ModuleGate>} />
              <Route path="/hr/roster"     element={<ModuleGate module="hr"><Roster /></ModuleGate>} />
              <Route path="/hr/holidays"   element={<ModuleGate module="hr"><HolidayCalendar /></ModuleGate>} />
              <Route path="/hr/overtime"   element={<ModuleGate module="hr"><Overtime /></ModuleGate>} />

              {/* Crest POS — gated on pos_enabled */}
              <Route path="/pos"        element={<ModuleGate module="pos"><Pos /></ModuleGate>} />
              <Route path="/pos/orders" element={<ModuleGate module="pos"><PosOrders /></ModuleGate>} />
              <Route path="/pos/tables" element={<ModuleGate module="pos"><PosTableManagement /></ModuleGate>} />
              <Route path="/pos/customers" element={<ModuleGate module="pos"><PosCustomers /></ModuleGate>} />
              <Route path="/pos/shifts" element={<ModuleGate module="pos"><PosShifts /></ModuleGate>} />
              <Route path="/pos/exceptions" element={<ModuleGate module="pos"><PosExceptionReport /></ModuleGate>} />
              <Route path="/pos/staff"  element={<ModuleGate module="pos"><PosStaff /></ModuleGate>} />

              {/* Admin only */}
              <Route path="/admin/clients"
                element={<ProtectedRoute adminOnly><AdminClients /></ProtectedRoute>} />
              <Route path="/admin/audit"
                element={<ProtectedRoute adminOnly><AuditLog /></ProtectedRoute>} />
            </Route>
          </Routes>
        </BrowserRouter>
      </SettingsProvider>
    </AuthProvider>
    </ThemeProvider>
  )
}
