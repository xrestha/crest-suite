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

              {/* Basic — available to all authenticated users */}
              <Route path="/dashboard"  element={<Dashboard />} />
              <Route path="/periods"    element={<Periods />} />
              <Route path="/items"      element={<Items />} />
              <Route path="/vendors"    element={<Vendors />} />
              <Route path="/purchases"  element={<Purchases />} />
              <Route path="/purchase-orders"
                element={<PremiumGate featureKey="purchase_orders" minPlan="growth"><PurchaseOrders /></PremiumGate>} />
              <Route path="/stock"      element={<Stock />} />
              <Route path="/help"       element={<Help />} />

              {/* Growth plan — Sales, Recipes, core reports */}
              <Route path="/sales"
                element={<PremiumGate featureKey="sales_entry" minPlan="growth"><Sales /></PremiumGate>} />
              <Route path="/recipes"
                element={<PremiumGate featureKey="recipe_costing" minPlan="growth"><Recipes /></PremiumGate>} />
              <Route path="/variance"
                element={<PremiumGate featureKey="variance_report" minPlan="growth"><Variance /></PremiumGate>} />
              <Route path="/summary"
                element={<PremiumGate featureKey="monthly_summary" minPlan="starter"><MonthlySummary /></PremiumGate>} />
              <Route path="/payments"
                element={<PremiumGate featureKey="payment_summary" minPlan="growth"><PaymentReport /></PremiumGate>} />
              <Route path="/reorder"
                element={<PremiumGate featureKey="reorder_report" minPlan="starter"><ReorderReport /></PremiumGate>} />
              <Route path="/budget"
                element={<PremiumGate featureKey="budget_vs_actual" minPlan="growth"><BudgetVsActual /></PremiumGate>} />
              <Route path="/requisitions"
                element={<PremiumGate featureKey="requisitions" minPlan="growth"><Requisitions /></PremiumGate>} />
              <Route path="/wastage-report"
                element={<PremiumGate featureKey="wastage_report" minPlan="starter"><WastageReport /></PremiumGate>} />
              <Route path="/dead-stock"
                element={<PremiumGate featureKey="dead_stock" minPlan="growth"><DeadStock /></PremiumGate>} />
              <Route path="/recipe-margin"
                element={<PremiumGate featureKey="recipe_margin" minPlan="growth"><RecipeMargin /></PremiumGate>} />
              <Route path="/period-comparison"
                element={<PremiumGate featureKey="period_comparison" minPlan="pro"><PeriodComparison /></PremiumGate>} />
              <Route path="/best-sellers"
                element={<PremiumGate featureKey="best_sellers" minPlan="growth"><BestSellers /></PremiumGate>} />
              <Route path="/vat-report"
                element={<PremiumGate featureKey="vat_report" minPlan="starter"><VatReport /></PremiumGate>} />
              <Route path="/non-vat-report"
                element={<PremiumGate featureKey="non_vat_report" minPlan="starter"><NonVatReport /></PremiumGate>} />

              {/* Pro plan — Advanced analytics, engineering, settings */}
              <Route path="/menu-engineering"
                element={<PremiumGate featureKey="menu_engineering" minPlan="pro"><MenuEngineering /></PremiumGate>} />
              <Route path="/fifo"
                element={<PremiumGate featureKey="fifo_report" minPlan="pro"><FifoReport /></PremiumGate>} />
              <Route path="/vendors-report"
                element={<PremiumGate featureKey="vendor_report" minPlan="pro"><VendorReport /></PremiumGate>} />
              <Route path="/supplier-prices"
                element={<PremiumGate featureKey="price_tracker" minPlan="pro"><SupplierPriceTracker /></PremiumGate>} />
              <Route path="/overheads"
                element={<PremiumGate featureKey="overheads" minPlan="pro"><Overheads /></PremiumGate>} />
              <Route path="/theoretical-variance"
                element={<PremiumGate featureKey="theoretical_variance" minPlan="pro"><TheoreticalVariance /></PremiumGate>} />
              <Route path="/settings"
                element={<PremiumGate featureKey="settings" minPlan="pro"><Settings /></PremiumGate>} />

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
