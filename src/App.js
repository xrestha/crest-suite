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
import DeadStock from './pages/DeadStock'
import RecipeMargin from './pages/RecipeMargin'
import PeriodComparison from './pages/PeriodComparison'
import AnnualSummary from './pages/AnnualSummary'
import OutstandingPayables from './pages/OutstandingPayables'
import ShrinkageReport from './pages/ShrinkageReport'
import EmployeeList from './modules/hr/employees/EmployeeList'
import SalaryList from './modules/hr/salary/SalaryList'
import AttendanceSheet from './modules/hr/attendance/AttendanceSheet'
import PayrollRun from './modules/hr/payroll/PayrollRun'
import HrReports from './modules/hr/reports/HrReports'
import FestivalAllowance from './modules/hr/festival/FestivalAllowance'
import LeaveManagement from './modules/hr/leave/LeaveManagement'
import './components/Layout.css'

export default function App() {
  return (
    <ThemeProvider>
    <AuthProvider>
      <SettingsProvider>
        <BrowserRouter>
          <Routes>
            <Route path="/login"   element={<Login />} />
            <Route path="/pricing" element={<Pricing />} />
            <Route path="/" element={<Navigate to="/dashboard" replace />} />
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
              <Route path="/hr/employees" element={<ModuleGate module="hr"><EmployeeList /></ModuleGate>} />
              <Route path="/hr/salary"     element={<ModuleGate module="hr"><SalaryList /></ModuleGate>} />
              <Route path="/hr/attendance" element={<ModuleGate module="hr"><AttendanceSheet /></ModuleGate>} />
              <Route path="/hr/leave"      element={<ModuleGate module="hr"><LeaveManagement /></ModuleGate>} />
              <Route path="/hr/payroll"    element={<ModuleGate module="hr"><PayrollRun /></ModuleGate>} />
              <Route path="/hr/reports"    element={<ModuleGate module="hr"><HrReports /></ModuleGate>} />
              <Route path="/hr/festival"   element={<ModuleGate module="hr"><FestivalAllowance /></ModuleGate>} />

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
