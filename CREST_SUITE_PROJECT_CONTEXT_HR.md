# CREST SUITE — PROJECT CONTEXT DOCUMENT
### For Claude Code Reference
**Crest Hospitality (Pvt. Ltd.) | Kathmandu, Nepal | Confidential**

---

## 1. COMPANY OVERVIEW

**Company:** Crest Hospitality (Pvt. Ltd.)
**Location:** Kathmandu, Nepal
**Type:** Hospitality Technology and Services Company
**Stage:** Early Revenue — Pilot client live (Casa Acai Café)
**Vision:** Nepal's first integrated hospitality management platform

---

## 2. THE PRODUCT — CREST SUITE

Crest Suite is a single React + Supabase web application that serves as a complete hospitality operating system. It is **not** three separate apps. It is **one codebase** with **feature flags** that control what each client sees based on their subscription.

### Three Core Modules

| Module | Full Name | Purpose |
|---|---|---|
| Crest IMS | Inventory Management System | BOH cost control, purchasing, recipes, stock |
| Crest POS | Point of Sale | FOH order taking, billing, payments, shifts |
| Crest HR | Human Resource Management | Employees, payroll, rostering, SSF, TDS |

### Architecture Principle
> One codebase. One database. Feature flags per client. Three modules. Sell separately or as a bundle.

---

## 3. TECH STACK

| Layer | Technology | Notes |
|---|---|---|
| Frontend | React (Create React App) | Single codebase for all three modules |
| Backend / Database | Supabase (PostgreSQL) | One Supabase project — all modules share same DB |
| Hosting | Vercel | Single deployment |
| Mobile | PWA (Progressive Web App) | Offline-first via service worker + IndexedDB |
| Auth | Supabase Auth + PIN | Email login for setup, 4-digit PIN for floor use |
| Offline Storage | IndexedDB | Queues transactions when offline |
| Background Sync | Service Worker | Auto-syncs to Supabase on reconnection |
| Excel Export | SheetJS | Owners and accountants want Excel output |
| Receipt Printing | ESC/POS protocol | 80mm thermal printers |

### Nepal-Specific Requirements (CRITICAL)
- **Calendar:** Bikram Sambat (BS) — all dates, periods, and reports in BS with AD conversion
- **Currency:** NPR (Nepalese Rupees) — no other currency
- **VAT:** 13% — configurable per item (some items exempt)
- **SSF:** Social Security Fund — employer 20% + employee 11% of basic salary
- **Income Tax:** Nepal slab-based TDS (see HR module)
- **Payment Gateways:** eSewa, Khalti, FonePay, ConnectIPS, cash, card
- **Language:** English UI — Nepali number formatting where required

---

## 4. SUBSCRIPTION AND FEATURE FLAGS

### The clients Table — Master Control

```javascript
{
  id: "uuid",
  name: "Casa Acai Café",

  // Module switches — the on/off toggles
  ims_enabled: true,
  pos_enabled: true,
  hr_enabled: true,

  // Plan per module — "starter" | "growth" | "pro" | null
  ims_plan: "growth",
  pos_plan: "growth",
  hr_plan: "growth",

  // Billing
  subscription_plan: "suite_growth",   // see pricing section
  billing_cycle: "monthly",            // "monthly" | "annual"
  monthly_rate: 22000,
  annual_rate: 16500,                  // monthly equivalent at 25% discount
  discount_pct: 0,                     // 0 for monthly, 25 for annual

  active: true,
  created_at: "timestamp"
}
```

### How Feature Flags Work in React

```javascript
// Global context — loaded once on login
const { ims_enabled, ims_plan, pos_enabled, pos_plan, hr_enabled, hr_plan } = useClientFeatures();

// Module-level check — hides entire module if disabled
{ims_enabled && <NavItem to="/inventory" label="Inventory" />}
{pos_enabled && <NavItem to="/pos" label="Point of Sale" />}
{hr_enabled && <NavItem to="/hr" label="Human Resources" />}

// Plan-level check — hides features within a module based on plan
{hr_enabled && hr_plan !== "starter" && (
  <NavItem to="/hr/roster" label="Staff Rostering" />
)}

{hr_enabled && hr_plan === "pro" && (
  <NavItem to="/hr/analytics" label="Labour Analytics" />
)}
```

### Locked Feature UI
Features on higher plans show a lock badge — not hidden, but upgrade-prompted:
```
[ Staff Rostering  🔒 Upgrade to Growth — NPR 3,000/month more ]
```

### Row Level Security (Supabase RLS)
Database-level enforcement — even if someone bypasses the frontend, they cannot query disabled module tables:
```sql
CREATE POLICY "ims_access" ON ims_purchases
  FOR ALL USING (
    EXISTS (
      SELECT 1 FROM shared_clients
      WHERE id = auth.jwt()->>'client_id'
      AND ims_enabled = true
    )
  );
```

### Upgrading a Client
Two SQL field updates — effective on next login. No migration, no redeployment:
```sql
UPDATE shared_clients
SET pos_enabled = true,
    ims_enabled = true,
    pos_plan = 'growth',
    ims_plan = 'growth',
    subscription_plan = 'suite_growth',
    monthly_rate = 22000,
    annual_rate = 16500
WHERE id = 'client-uuid';
```

---

## 5. PRICING

### Plan Name Convention
| Old Name | Confirmed Name |
|---|---|
| Basic | **Starter** |
| Standard | **Growth** |
| Premium | **Pro** |

---

### Individual Module Pricing
All three modules — Crest IMS, Crest POS, Crest HR — have identical pricing across all tiers.

| Plan | Monthly | Annual /month | Annual Total | Saving/year |
|---|---|---|---|---|
| **Starter** | NPR 5,000 | NPR 3,750 | NPR 45,000 | NPR 15,000 |
| **Growth** | NPR 8,000 | NPR 6,000 | NPR 72,000 | NPR 24,000 |
| **Pro** | NPR 12,000 | NPR 9,000 | NPR 1,08,000 | NPR 36,000 |

Annual discount: **25% off monthly rate**

---

### Suite Bundle Pricing
Suite = all three modules (IMS + POS + HR) at the same plan tier.

| Suite Plan | Monthly | Annual /month | Annual Total | Saving/year |
|---|---|---|---|---|
| **Suite Starter** | NPR 12,000 | NPR 9,000 | NPR 1,08,000 | NPR 36,000 |
| **Suite Growth** | NPR 22,000 | NPR 16,500 | NPR 1,98,000 | NPR 66,000 |
| **Suite Pro** | NPR 32,000 | NPR 24,000 | NPR 2,88,000 | NPR 96,000 |

Suite saving vs buying three modules separately:
- Suite Starter saves NPR 3,000/month
- Suite Growth saves NPR 2,000/month
- Suite Pro saves NPR 4,000/month

---

### Plan Feature Gates — Per Module

**Crest IMS**
| Feature | Starter | Growth | Pro |
|---|---|---|---|
| Item Master with unit conversion | ✓ | ✓ | ✓ |
| Vendor Management | ✓ | ✓ | ✓ |
| Purchases + Vendor Returns | ✓ | ✓ | ✓ |
| Stock Count (opening / closing / wastage) | ✓ | ✓ | ✓ |
| BS Calendar Periods | ✓ | ✓ | ✓ |
| Dashboard and KPI Overview | ✓ | ✓ | ✓ |
| Basic Reports | ✓ | ✓ | ✓ |
| Sales Entry | ✗ | ✓ | ✓ |
| Recipe Costing + live food cost % | ✗ | ✓ | ✓ |
| Sub-recipe support | ✗ | ✓ | ✓ |
| Variance Report | ✗ | ✓ | ✓ |
| Monthly Summary (COGS) | ✗ | ✓ | ✓ |
| Payment Summary (Cash / Credit / FonePay) | ✗ | ✓ | ✓ |
| Reorder Report and Par Levels | ✗ | ✓ | ✓ |
| Mobile Stock Count PWA (offline) | ✗ | ✓ | ✓ |
| Reorder Push Alerts | ✗ | ✓ | ✓ |
| Menu Engineering (Star / Puzzle / Dog) | ✗ | ✗ | ✓ |
| FIFO / Expiry Tracking | ✗ | ✗ | ✓ |
| Vendor Spend Report | ✗ | ✗ | ✓ |
| Supplier Price Tracker | ✗ | ✗ | ✓ |
| Overheads and True Margin Analysis | ✗ | ✗ | ✓ |
| Custom Branding and Settings | ✗ | ✗ | ✓ |
| Multi-property | ✗ | ✗ | ✓ |
| API Access | ✗ | ✗ | ✓ |

**Crest POS**
| Feature | Starter | Growth | Pro |
|---|---|---|---|
| Table Management and Floor Plan | ✓ | ✓ | ✓ |
| Order Taking with Modifiers | ✓ | ✓ | ✓ |
| KOT Printing | ✓ | ✓ | ✓ |
| Billing with VAT (13%) and Service Charge | ✓ | ✓ | ✓ |
| Cash Payment | ✓ | ✓ | ✓ |
| Basic Z-Report | ✓ | ✓ | ✓ |
| User Roles and PIN Auth | ✓ | ✓ | ✓ |
| QR Payments (eSewa / Khalti / FonePay / ConnectIPS) | ✗ | ✓ | ✓ |
| Card Payment Integration | ✗ | ✓ | ✓ |
| Bill Splitting (equal or item-based) | ✗ | ✓ | ✓ |
| Discount Controls with Manager PIN | ✗ | ✓ | ✓ |
| Void Management with Audit Log | ✗ | ✓ | ✓ |
| Offline Mode (IndexedDB + auto-sync) | ✗ | ✓ | ✓ |
| Happy Hour Pricing (auto time-based) | ✗ | ✓ | ✓ |
| Multiple Printer Routing | ✗ | ✓ | ✓ |
| Shift Management (X-report / Z-report) | ✗ | ✓ | ✓ |
| PWA Order Taking on Phone / Tablet | ✗ | ✓ | ✓ |
| Course Firing (fine dining) | ✗ | ✗ | ✓ |
| Reservation Integration (Crest OTA) | ✗ | ✗ | ✓ |
| Advanced Reports (waiter performance, hourly trend) | ✗ | ✗ | ✓ |
| Full Audit Trail | ✗ | ✗ | ✓ |
| Multi-property | ✗ | ✗ | ✓ |
| API Access | ✗ | ✗ | ✓ |

**Crest HR**
| Feature | Starter | Growth | Pro |
|---|---|---|---|
| Employee Master | ✓ | ✓ | ✓ |
| Leave Management (apply / approve / balance) | ✓ | ✓ | ✓ |
| Attendance (manual entry) | ✓ | ✓ | ✓ |
| Payslip Generation | ✓ | ✓ | ✓ |
| Employee PWA (own payslip / leave / shifts) | ✓ | ✓ | ✓ |
| SSF Computation (11% + 20%) | ✗ | ✓ | ✓ |
| Income Tax TDS (Nepal slab-based) | ✗ | ✓ | ✓ |
| Staff Rostering (weekly roster board) | ✗ | ✓ | ✓ |
| Shift Templates and Coverage Alerts | ✗ | ✓ | ✓ |
| Labour Act Compliance (rest day enforcement) | ✗ | ✓ | ✓ |
| OT Management (1.5x / 2x) | ✗ | ✓ | ✓ |
| Festival Allowance (Dashain) | ✗ | ✓ | ✓ |
| Staff Advances and Repayment Tracking | ✗ | ✓ | ✓ |
| Full Payroll Run | ✗ | ✓ | ✓ |
| Bank Transfer List | ✗ | ✓ | ✓ |
| SSF Monthly Challan | ✗ | ✓ | ✓ |
| Roster Publish + Push Notifications | ✗ | ✓ | ✓ |
| Shift Swap (employee requests, manager approves) | ✗ | ✓ | ✓ |
| Labour Cost Forecast on Roster | ✗ | ✓ | ✓ |
| Labour Cost Dashboard (% of revenue) | ✗ | ✗ | ✓ |
| TDS Annual Certificate | ✗ | ✗ | ✓ |
| SSF Annual Contribution Statement | ✗ | ✗ | ✓ |
| Full HR Compliance Reports Pack | ✗ | ✗ | ✓ |
| Biometric Integration | ✗ | ✗ | ✓ |
| Advanced HR Analytics | ✗ | ✗ | ✓ |
| Multi-property Rostering | ✗ | ✗ | ✓ |
| API Access | ✗ | ✗ | ✓ |

---

### Suite Plan Feature Summary

**Suite Starter — NPR 12,000/month**
- IMS Starter + POS Starter + HR Starter
- Core operations only — purchasing, stock, order taking, billing, employee management, leave, payslip
- Cash payments only
- No recipe costing, no variance, no SSF/TDS, no rostering, no QR payments
- No cross-module integration
- Best for: very small cafés or businesses just getting started with systems

**Suite Growth — NPR 22,000/month**
- IMS Growth + POS Growth + HR Growth
- Everything in Starter plus:
- Recipe costing, variance, menu engineering foundation, mobile stock count PWA
- QR payments, bill splitting, discount/void controls, offline mode
- SSF, TDS, full payroll run, staff rostering, OT, festival allowance
- **Cross-module integration unlocked:**
  - POS sale → automatic IMS stock deduction via recipe linkage
  - POS shifts → HR attendance pre-fill (FOH staff only)
  - IMS staff meals → HR payroll deduction
- Best for: established cafés and restaurants wanting full cost control and compliance

**Suite Pro — NPR 32,000/month**
- IMS Pro + POS Pro + HR Pro
- Everything in Growth plus:
- Menu engineering (Star / Puzzle / Dog), FIFO tracking, vendor spend and price tracker, true margin analysis
- Course firing, reservation integration, advanced POS reports, full audit trail
- Labour cost dashboard, TDS/SSF annual certificates, biometric integration, full compliance pack
- **Multi-property unlocked** — one login, multiple branches
- Cross-property staff rostering
- API access for all three modules
- Custom branding and settings
- Best for: hotel F&B, multi-branch operations, high-volume establishments

---

## 6. DATABASE SCHEMA STRUCTURE

### Schema Separation Convention
All tables prefixed by module to avoid naming conflicts:

```
shared_*    — clients, users, roles, properties (all modules read/write)
ims_*       — IMS-specific tables
pos_*       — POS-specific tables
hr_*        — HR-specific tables
admin_*     — Crest internal admin tables (super admin only)
```

### Shared Tables (All Modules)
```sql
shared_clients          -- the business using Crest Suite
shared_properties       -- physical locations (one client, multiple branches)
shared_users            -- all users across all modules
shared_roles            -- owner, manager, supervisor, staff, cashier, kitchen
shared_user_roles       -- which user has which role at which property
```

### IMS Tables
```sql
ims_item_master
ims_item_categories
ims_vendors
ims_purchases
ims_purchase_items
ims_stock_counts
ims_stock_count_items
ims_recipes
ims_recipe_ingredients
ims_sales_entries
ims_sale_items
ims_periods              -- BS month periods (Baisakh, Jestha etc.)
ims_variance_reports
ims_vendor_returns
ims_staff_meals          -- consumed by HR for payroll deductions
ims_reorder_alerts
```

### POS Tables
```sql
pos_tables
pos_table_sections       -- indoor, outdoor, bar, rooftop
pos_menu_items
pos_menu_categories
pos_modifiers
pos_modifier_groups
pos_orders
pos_order_items
pos_order_item_modifiers
pos_kot_tickets
pos_bills
pos_bill_items
pos_payments
pos_shifts               -- read by HR for attendance (FOH Growth+)
pos_shift_sessions       -- individual staff shift open/close
pos_void_logs
pos_discount_logs
pos_reservations
```

### HR Tables
```sql
hr_employees
hr_salary_structures
hr_salary_components
hr_leave_types
hr_leave_applications
hr_leave_balances
hr_attendance            -- includes source field: pos_shift | manual | leave
hr_rosters
hr_roster_shifts
hr_shift_templates       -- Morning, Afternoon, Evening, Split, Full Day, Night
hr_overtime_entries
hr_payroll_runs
hr_payslips
hr_payslip_items
hr_ssf_challans
hr_tds_entries
hr_advances
hr_advance_repayments
hr_festival_allowances
hr_tada_claims           -- travel and daily allowance per trip
hr_incentives            -- performance, attendance, sales, discretionary
hr_incentive_configs     -- recurring incentive rules per employee/department
hr_holiday_calendar      -- client-specific holiday list per fiscal year
```

> Note: hr_service_charge_dist removed — service charge distribution is illegal per Nepal court ruling.

### Admin Tables (Crest Internal Only)
```sql
admin_support_flags       -- id, client_id, title, description, severity, status, opened_by, opened_at, resolved_at, notes
admin_onboarding_progress -- id, client_id, module, step_key, completed, completed_at
admin_billing_log         -- id, client_id, amount, period_bs, due_date, paid_date, payment_method, status
admin_notes               -- id, client_id, note, created_by, created_at
admin_holiday_templates   -- master Nepal public holiday list per fiscal year, copied to client on year start
```

---

## 7. MODULE INTEGRATIONS — HOW DATA FLOWS

### POS → IMS (Sale triggers stock deduction)
```
POS confirms bill
  → Writes to: pos_bills, pos_bill_items
  → Supabase trigger fires
  → Reads recipe from: ims_recipes, ims_recipe_ingredients
  → Deducts from: ims_stock_counts (current period)
  → Updates: ims_variance_reports
```
Method: Supabase database trigger — zero latency, no API call
Unlocked on: Suite Growth and above

### POS → HR (Shift data feeds attendance — FOH only)
```
POS cashier/waiter opens shift → writes to pos_shift_sessions
  → HR reads pos_shift_sessions for that employee
  → Pre-fills attendance record (employee was present)
  → Manager confirms or adjusts in HR attendance module
```
Applies to: FOH staff only (waiters, cashiers). BOH staff use manual entry.
Unlocked on: Suite Growth and above

### IMS → HR (Staff meal deduction)
```
Manager logs staff meal in IMS → writes to ims_staff_meals
  → Monthly payroll run reads ims_staff_meals
  → Deducts total from employee net salary automatically
```
Standalone HR fallback: manager enters meal deduction manually in payroll run form.
Unlocked on: Suite Growth and above

---

## 8. USER ROLES AND ACCESS

### Roles (stored in shared_roles)
| Role | Code | Access Level |
|---|---|---|
| Owner | owner | Full access to all enabled modules |
| Manager | manager | All operational functions, all reports |
| Supervisor | supervisor | Department-level — own team only |
| Staff / Waiter | staff | Order taking, own attendance, own payslip |
| Cashier | cashier | Payment processing, shift management |
| Kitchen | kitchen | KOT view only (future KDS module) |
| Super Admin | super_admin | Crest internal only — Admin Dashboard access |

### Authentication
- **Login:** Email + password via Supabase Auth
- **Floor Use:** 4-digit PIN per staff member (faster during service)
- **Manager Override PIN:** Separate PIN for approving voids, discounts, refunds
- **Session Timeout:** Auto-lock after 2 minutes inactivity

### Role Access Matrix — IMS
| Feature | Owner | Manager | Supervisor | Staff |
|---|---|---|---|---|
| Item Master | Full | Full | View | No |
| Vendors | Full | Full | No | No |
| Purchases | Full | Full | View | No |
| Stock Count | Full | Full | Own dept | Enter only |
| Recipes | Full | Full | View | No |
| Reports | Full | Full | No | No |

### Role Access Matrix — POS
| Feature | Owner | Manager | Supervisor | Cashier | Staff |
|---|---|---|---|---|---|
| Floor plan | View | Full | Full | Full | Full |
| Order taking | No | Full | Full | No | Full |
| Bill generation | No | Full | Full | Full | Request only |
| Void (after send) | Approve | Approve | No | No | No |
| Discounts above threshold | Approve | Approve | No | No | No |
| Shift open/close | No | Yes | No | Yes | No |
| Reports | Full | Full | No | Own shift | No |

### Role Access Matrix — HR
| Feature | Owner | Manager | Supervisor | Staff |
|---|---|---|---|---|
| Employee Master (all) | Full | Full | Own dept | Own profile |
| Salary structures | Full | Full | No | Own only |
| Payroll run | Approve | Prepare | No | No |
| Payslip | All staff | All staff | No | Own only |
| Leave approve | Yes | Yes | Own team | No |
| Roster build | No | Yes | Draft own dept | No |
| Roster view | All | All | Own dept | Own shifts |
| OT approve | Yes | Yes | No | No |
| SSF / TDS | Yes | Yes | No | No |

---

## 9. PWA ARCHITECTURE

### Service Worker Caching Strategy
| Data Type | Strategy | Reason |
|---|---|---|
| React app shell | Cache first | Never changes between sessions |
| Item Master / Menu | Cache + background sync | Needed offline for stock count / orders |
| Supabase API calls | Network first, fallback cache | Always want fresh data if possible |
| Offline transactions | IndexedDB queue | Core offline use case |

### Offline Queue (IndexedDB)
```javascript
{
  id: "local_001",
  type: "stock_count_entry",
  period_id: "83-baisakh",
  item_id: "uuid",
  item_name: "Oat Milk",
  physical_count: 3.5,
  unit: "litre",
  entered_by: "user_uuid",
  entered_at: "2026-06-18T10:30:00",
  synced: false
}
// On reconnection: service worker fires background sync
// All synced: false records push to Supabase, marked synced: true
```

### PWA Features by Role
| Role | PWA Use Cases |
|---|---|
| Owner | Financial dashboard, payroll approval |
| Manager | Roster build and publish, leave approvals, OT approval, stock alerts |
| Supervisor | Department roster, team leave approvals, attendance entry |
| Chef | Flag low stock, upload new recipes, view production list |
| Purchase Manager | Reorder alerts, raise POs, approve deliveries |
| Waiter / FOH | Order taking on tablet, table status, own shifts |
| Cashier | Payment processing, shift open/close |
| Employee | Own payslip, leave application, own shifts, own attendance |

---

## 10. DASHBOARD ARCHITECTURE

### Principle
Each module has its own dashboard. There is no shared or owner dashboard at this stage.

### IMS Dashboard (built)
- Food cost % this period
- Stock value on hand
- Top variance items
- Pending purchase orders
- Reorder alerts
- COGS this month

### HR Dashboard (build in Session 1)
`src/modules/hr/HRDashboard.jsx`
- Total headcount
- Staff present today vs rostered
- Pending leave approvals
- Upcoming payroll run date
- SSF challan due date
- Labour Act violations flagged on current roster

### POS Dashboard (build when POS starts)
`src/modules/pos/POSDashboard.jsx`
- Revenue today / this week / this month
- Covers served
- Average transaction value (ATV)
- Top selling items
- Payment mode breakdown
- Current open tables
- Active shift status

### Navigation Structure
```
App
├── IMS Module
│   ├── IMS Dashboard
│   └── (IMS features)
├── POS Module
│   ├── POS Dashboard
│   └── (POS features)
├── HR Module
│   ├── HR Dashboard
│   └── (HR features)
└── /admin (Super Admin only)
    └── Admin Dashboard
```

### Standalone Client Behaviour
- IMS only client: sees IMS Dashboard only
- HR only client: sees HR Dashboard only
- Suite client: sees all three module dashboards via nav

---

## 11. CREST IMS — CURRENT STATE (PILOT LIVE)

### Live Modules
- Item Master (with categories and units)
- Vendor Management
- Purchase Entry with FIFO cost tracking
- Stock Count (physical count per period)
- Recipe Costing (with sub-recipe support)
- Sales Entry (manual — will be replaced by POS integration)
- Variance Report (theoretical vs actual stock)
- Monthly Summary Report
- Payment Summary (vendor payments)
- Vendor Returns

### Pilot Client
- **Casa Acai Café**, Kathmandu
- Data from Jestha 2083 active
- Key finding: ~NPR 97,617 data entry error inflating closing stock
- Corrected food cost: ~61% vs as-reported ~41%
- Dead stock identified: Bacon, Salami, Prawns
- Loss-making items: Orange Juice, Peri Peri Wings, Cold Brew

### Reporting Style
- Professional Garamond-styled A4 .docx documents
- Cover page, color-coded tables, page numbers
- Crest Hospitality branding — navy (#1B2A4A) and gold (#C9A84C)
- All reports marked Confidential
- Currency: NPR, Dates: BS calendar

### Pending IMS Features
- Stock Register Report (running balance)
- Reorder alert system (PWA push notifications)
- Mobile stock count (PWA offline-first)
- POS integration (auto-deduction on sale)
- Menu Engineering (Star / Puzzle / Dog) — Pro plan
- FIFO / Expiry Tracking — Pro plan
- Vendor Spend Report + Supplier Price Tracker — Pro plan

---

## 12. CREST HR — BUILD PLAN

### Pre-Session Audit (Before Starting)
1. Open `src/modules/hr/` — list all existing files and folders
2. Check which `hr_*` tables exist in Supabase
3. Confirm `hr_enabled` and `hr_plan` are present in `shared_clients`

### Session-by-Session Plan

| Session | Module | Est. Hours | Plan Gate |
|---|---|---|---|
| 1 | Employee Master | 2–3h | All plans |
| 2 | Salary Structure | 1–2h | All / Growth |
| 3 | Leave Management | 2–3h | All plans |
| 4 | Staff Rostering | 3–4h | Growth+ |
| 5 | Attendance Management | 1–2h | All plans |
| 6 | Overtime Management | 1h | Growth+ |
| 7 | SSF Computation | 1h | Growth+ |
| 8 | Income Tax TDS | 1h | Growth+ |
| 9 | Payroll Processing | 2–3h | All / Growth |
| 10 | Festival Allowance + Advances | 1–2h | Growth+ |
| 11 | HR Reports | 1–2h | Growth+ / Pro |
| 12 | HR Dashboard Integration | 1h | All plans |

**Total estimate: 18–28 hours of focused build time.**

---

### Session 1 — Employee Master
Files: `hr/employees/EmployeeList.jsx`, `EmployeeForm.jsx`, `EmployeeProfile.jsx`
Table: `hr_employees`
Feature flag: none — all plans
Done when: Add, edit, view, deactivate an employee works end-to-end.

### Session 2 — Salary Structure
Files: `hr/salary/SalaryStructureForm.jsx`, `SalaryComponentList.jsx`
Tables: `hr_salary_structures`, `hr_salary_components`
Feature flag: Starter views own salary only. Growth+ builds/edits structures.
Done when: Employee has a configured salary structure with basic + components.

### Session 3 — Leave Management
Files: `hr/leave/LeaveTypeConfig.jsx`, `LeaveApplicationForm.jsx`, `LeaveApprovalQueue.jsx`, `LeaveBalanceDashboard.jsx`
Tables: `hr_leave_types`, `hr_leave_applications`, `hr_leave_balances`
Feature flag: all plans. Manager approval UI Growth+.
Done when: Employee applies → manager approves → balance deducts.

### Session 4 — Staff Rostering
Files: `hr/roster/RosterBoard.jsx`, `ShiftTemplateConfig.jsx`, `RosterPublish.jsx`
Tables: `hr_rosters`, `hr_roster_shifts`, `hr_shift_templates`
Feature flag: Growth+ only. Starter sees lock badge.
Done when: Manager builds a week, publishes, employees see shifts on PWA.

### Session 5 — Attendance Management
Files: `hr/attendance/AttendanceSheet.jsx`, `AttendanceEntry.jsx`
Table: `hr_attendance` (with source field: pos_shift | manual | leave)
Attendance input methods:
  - Manual entry by manager — all plans, all staff
  - POS pre-fill for FOH staff (waiters, cashiers) — Growth+, pulls from pos_shift_sessions
  - Leave auto-block — approved leave marks day as L automatically
  - No self check-in — manager enters all BOH attendance manually
Done when: Monthly attendance sheet is complete and reconciled.

### Session 6 — Overtime Management
Files: `hr/overtime/OTEntryForm.jsx`, `OTApprovalQueue.jsx`
Table: `hr_overtime_entries`
OT rate formula: `(basic / 26 / 8) × hours × rate multiplier`
Rate: 1.5x weekday, 2x public holiday
Feature flag: Growth+
Done when: Approved OT feeds into payroll run.

### Session 7 — SSF Computation
Files: `hr/ssf/SSFSummary.jsx`, `SSFChallan.jsx`
Utility: `shared/utils/ssfUtils.js`
Table: `hr_ssf_challans`
Feature flag: Growth+
Done when: Monthly challan exports to Excel correctly.

### Session 8 — Income Tax TDS
Files: `hr/tds/TDSComputation.jsx`
Utility: `shared/utils/tdsUtils.js`
Table: `hr_tds_entries`
Feature flag: Growth+. Annual TDS certificate Pro only.
Done when: Monthly TDS correctly computed per employee including female rebate.

### Session 9 — Payroll Processing
Files: `hr/payroll/PayrollRunForm.jsx`, `PayslipView.jsx`, `BankTransferList.jsx`
Tables: `hr_payroll_runs`, `hr_payslips`, `hr_payslip_items`
Feature flag: Starter gets basic payslip. Growth gets full run + bank list.
Done when: Payroll runs end-to-end, payslip downloads, bank list exports.

### Session 10 — Festival Allowance, Advances, TADA, Incentives
Files: `hr/festival/FestivalAllowanceRun.jsx`, `hr/advances/AdvanceRegister.jsx`, `hr/tada/TADAClaimForm.jsx`, `hr/tada/TADAApprovalQueue.jsx`, `hr/incentives/IncentiveConfig.jsx`, `hr/incentives/IncentiveApprovalQueue.jsx`
Tables: `hr_festival_allowances`, `hr_advances`, `hr_advance_repayments`, `hr_tada_claims`, `hr_incentives`, `hr_incentive_configs`
Feature flag: Growth+
Done when: All variable payroll components feed correctly into payroll run.

### Session 11 — HR Reports
Reports: Headcount, monthly payroll summary, leave summary, SSF challan, labour cost % (Pro), TDS annual certificate (Pro), SSF annual statement (Pro)
Feature flag: basic reports Growth+, compliance pack Pro.

### Session 12 — HR Dashboard
File: `src/modules/hr/HRDashboard.jsx`
Shows: headcount, present today vs rostered, pending leave approvals, payroll run due, SSF challan due, Labour Act violations
Feature flag: all plans

---

## 13. CREST HR — SALARY STRUCTURE

### Components

**Basic Salary**
Foundation of all computations. Set per employee.
- SSF computed on basic
- Festival allowance = 1 month basic
- OT daily rate derived from basic
- TDS computed on annualised gross

**Allowances (added to basic = Gross)**
| Allowance | Taxable |
|---|---|
| House Rent Allowance (HRA) | Yes |
| Food Allowance | Yes |
| Transport Allowance | Yes |
| Medical Allowance | Partial |
| Communication Allowance | Yes |
| Uniform Allowance | Configurable |

Allowances are configurable per employee — not every employee gets every allowance.

**Gross Salary**
```
Gross = Basic + All Allowances
```

**Statutory Deductions (auto-computed Growth+)**
| Deduction | Rate |
|---|---|
| SSF Employee | 11% of Basic |
| Income Tax TDS | Nepal slab on annualised gross |

**Operational Deductions**
| Deduction | Source |
|---|---|
| Staff Meal Deduction | IMS (Suite) or manual entry (Standalone HR) |
| Advance Repayment | HR Advances register |
| Absence Deduction | Attendance sheet — unpaid days × daily rate |

Daily rate formula:
```
Daily Rate = Basic Salary ÷ 26 working days
```

**Variable Components (added at payroll run time)**
| Component | When Added |
|---|---|
| Overtime Amount | Months with approved OT |
| TADA | Months with approved travel/daily allowance claims |
| Incentives | Monthly — all approved types summed |
| Festival Allowance | Dashain month only |
| Leave Encashment | Fiscal year end month only |

> Service charge distribution removed — declared illegal by Nepal courts.

### Net Salary Formula
```
Basic Salary
+ Allowances (HRA, Food, Transport etc.)
─────────────────────────────────────────
= Gross Salary

+ Overtime Amount
+ TADA (approved claims this month)
+ Incentives (all approved types this month)
+ Festival Allowance        ← Dashain month only
+ Leave Encashment          ← Year end only
─────────────────────────────────────────
= Total Earnings

- SSF Employee (11% of Basic)
- Income Tax TDS (slab on annualised Total Earnings)
- Staff Meal Deduction
- Advance Repayment
- Absence Deduction (unpaid days × daily rate)
─────────────────────────────────────────
= NET PAYABLE SALARY
```

### Minimum Wage
Nepal minimum wage: **NPR 19,550/month** (current rate, unskilled labour)
- Show red warning if gross falls below NPR 19,550
- Do not block save — warn only
- Warning text: "Gross salary is below Nepal minimum wage of NPR 19,550"

### Employer True Cost Display
Show on salary structure form:
```
Basic:                    NPR 13,000
Employee SSF deduction:   NPR 1,430   (11%)
Employer SSF cost:        NPR 2,600   (20%)
─────────────────────────────────────
True cost to employer:    NPR 27,600  (gross + employer SSF)
```

### Nepal Income Tax Slabs (FY 2082/83)
```
Up to NPR 5,00,000        →  1%
NPR 5,00,001–7,00,000     → 10%
NPR 7,00,001–10,00,000    → 20%
NPR 10,00,001–20,00,000   → 30%
Above NPR 20,00,000       → 36%
Female employee rebate: 10% on computed tax
```

### SSF Computation
```
Employee SSF = Basic Salary × 11%    (deducted from gross)
Employer SSF = Basic Salary × 20%    (additional employer cost)
Total SSF    = Basic Salary × 31%
```

---

## 14. CREST HR — STAFF ROSTERING

### What It Is
A weekly schedule telling every employee which days they work, what shift, and what time. Manager builds and publishes it. Staff see their own schedule on PWA.

### The Roster Board
Grid: employees (rows) × days of week (columns) × shift blocks (cells)

```
                MON      TUE      WED      THU      FRI      SAT      SUN
────────────────────────────────────────────────────────────────────────────
Ramesh (Cook)   MORN     MORN     OFF      MORN     MORN     AFT      OFF
Sita (Cashier)  AFT      AFT      AFT      OFF      AFT      AFT      MORN
Bikash (KH)     MORN     OFF      MORN     MORN     OFF      MORN     MORN
```

### Shift Templates
| Template | Code | Example Times |
|---|---|---|
| Morning | MORN | 07:00 → 15:00 |
| Afternoon | AFT | 12:00 → 20:00 |
| Evening | EVE | 15:00 → 23:00 |
| Full Day | FULL | 09:00 → 18:00 |
| Split | SPLIT | 09:00–13:00 + 17:00–21:00 |
| Night | NIGHT | 23:00 → 07:00 |
| Off | OFF | Rest day |

### Automatic Checks
| Check | Rule |
|---|---|
| Rest day | Flags 7 consecutive working days (Labour Act violation) |
| Leave conflict | Approved leave auto-blocks cell — cannot assign shift |
| OT warning | Flags if total weekly hours exceed threshold |
| Coverage alert | Warns if shift has fewer than minimum configured staff |

### Publish Flow
Manager hits Publish → push notification to all affected employees → they see their week on PWA.

### Shift Swap (Growth+)
Employee requests swap on PWA → colleague accepts → manager approves → roster updates.

### Roster Connections to Other HR Modules
| Connection | How |
|---|---|
| Attendance | Rostered = expected. Actual compared at month end |
| Overtime | Hours beyond rostered → OT entry raised |
| Leave | Approved leave auto-blocks roster cell |
| Payroll | Absence deduction = rostered days marked absent |
| Labour cost forecast | Roster hours × daily rate = estimated weekly wage bill |

### Nepal-Specific
- All dates and week labels in Bikram Sambat
- Minimum 1 rest day per 7-day period (Nepal Labour Act)
- Public holidays per Nepal fiscal year calendar
- OT on public holidays = 2x (vs 1.5x on working days)

---

## 15. CREST HR — STANDALONE PRODUCT

### How It Works Technically
Same codebase. Same deployment. Feature flags only:

```sql
-- Standalone HR client onboarding
INSERT INTO shared_clients (
  name,
  ims_enabled, pos_enabled, hr_enabled,
  hr_plan,
  subscription_plan,
  monthly_rate
) VALUES (
  'New HR Client',
  false, false, true,
  'growth',
  'hr_growth',
  8000
);
```

Client logs in and sees only HR. IMS and POS do not exist for them.

### Module Combinations Possible
| Client Type | ims_enabled | pos_enabled | hr_enabled |
|---|---|---|---|
| Suite (full) | ✓ | ✓ | ✓ |
| HR standalone | ✗ | ✗ | ✓ |
| IMS standalone | ✓ | ✗ | ✗ |
| IMS + HR | ✓ | ✗ | ✓ |

### Standalone HR Fallbacks
- **Staff meal deduction:** No IMS available → manager enters manually in payroll run form
- **Attendance:** Manual entry only (no POS pre-fill — no POS exists)

### Standalone HR Pricing
| Plan | Monthly | Annual /month |
|---|---|---|
| HR Starter | NPR 5,000 | NPR 3,750 |
| HR Growth | NPR 8,000 | NPR 6,000 |
| HR Pro | NPR 12,000 | NPR 9,000 |

### Target Segments
| Segment | Pain Point |
|---|---|
| Schools / NPABSON network | Teacher rostering, payroll, SSF challan |
| Clinics / hospitals | Nurse/doctor shift rostering |
| Retail chains | Multi-branch staff management |
| NGOs / offices | Leave management, payroll, TDS certificates |
| Hotels (non-F&B) | Housekeeping rosters, front desk shifts |

### Upgrade Path
One SQL update adds IMS or POS. No migration, no redeployment.

### Onboarding Question (on signup)
> "Do you use a POS system?"
> - Yes, we use Crest POS → upgrade path to Suite
> - Yes, we use another POS → note for future integration
> - No → standalone confirmed

---

## 16. CREST POS — FEATURE SPECIFICATION SUMMARY

### Core Modules to Build
1. **Table Management** — Floor plan, cover count, merge, transfer, reservations
2. **Order Management** — Menu display, search, modifiers, item notes, course firing, held orders
3. **KOT** — Auto-generation, multi-printer routing, reprint, void KOT
4. **Billing** — Preview, splitting, discounts, complimentary, VAT (13%)
5. **Payment Processing** — Cash, card, QR (eSewa/Khalti/FonePay/ConnectIPS), house account, split modes
6. **Void and Refund** — Item void, bill void, post-payment refund, void reason codes
7. **Shift Management** — Opening float, X-report, Z-report, multiple shifts per day
8. **Menu Management** — IMS recipe linkage, price levels, 86 management, daily specials, happy hour
9. **Reporting** — Daily sales, hourly trend, item sales, void/discount, waiter performance, payment mode
10. **User Management** — Role hierarchy, PIN auth, manager override PIN, session timeout
11. **Hardware** — ESC/POS thermal printers, cash drawer, card terminal, all via WiFi
12. **Offline Mode** — IndexedDB queue, auto-sync, conflict resolution
13. **Crest Suite Integration** — IMS stock deduction, HR attendance, owner dashboard

### Build Priority Sequence
1. Table Management + Order Taking (3–4 weeks)
2. KOT Printing (1–2 weeks)
3. Billing + VAT + Payment Modes (2–3 weeks)
4. Shift Management + Z-Report (1–2 weeks)
5. Crest IMS Integration (2–3 weeks)
6. Void and Discount Controls (1 week)
7. Offline Mode (2 weeks)
8. Reporting Suite (2 weeks)
9. User Roles and PIN Auth (1 week)
10. Hardware Integration (1–2 weeks)

---

## 17. CREST HR — FEATURE SPECIFICATION SUMMARY

### Core Modules to Build
1. **Employee Master** — Personal info, employment records, document tracking, bank/SSF/PAN details
2. **Leave Management** — Nepal Labour Act leave types, application flow, balance tracking, encashment
3. **Attendance Management** — Daily status codes, manual entry, monthly reconciliation
4. **Staff Rostering** — Weekly roster board, shift templates, coverage alerts, Labour Act compliance
5. **Overtime Management** — Three OT sources, Nepal rates (1.5x weekday, 2x holiday), approval flow
6. **Salary Structure** — Component-wise configuration, revision history
7. **SSF Computation** — Employee 11% + Employer 20% of basic, monthly challan, annual report
8. **Income Tax TDS** — Nepal slab-based, female rebate, monthly computation, TDS certificate
9. **Payroll Processing** — Full net salary formula, payroll run workflow, payslip, bank list
10. **Festival Allowance** — Dashain computation, pro-rata for new joiners, advance tracking
11. **Staff Advances** — Advance register, automatic repayment deduction
12. **HR Reports** — Operational and annual compliance reports

### Nepal Labour Act Compliance (CRITICAL)
- Minimum 1 rest day per 7-day working period (enforced in roster)
- OT rate: 1.5x on working days, 2x on rest/public holidays
- Festival allowance: 1 month basic salary (pro-rata if < 1 year service)
- Maternity leave: 98 days paid
- Annual leave: 18 days per year (1.5 days/month)
- Sick leave: 12 days per year
- Casual leave: 6 days per year
- Public holidays: 14 days paid for female employees, 13 days paid for male employees (per fiscal year, drawn from client holiday calendar)

---

---

## 16. CREST HR — TADA (TRAVEL & DAILY ALLOWANCE)

### What It Is
Out-of-station expense claims raised per trip or event. Not a fixed monthly component — variable, approval-based, pulled into payroll when approved.

### Claim Flow
```
Employee raises TADA claim (destination, purpose, travel amount, daily allowance, days out)
  → Manager reviews and approves
  → Approved TADA pulled into that month's payroll run
  → Added to Total Earnings → taxable under TDS
```

### DB Table
```sql
hr_tada_claims
  id
  employee_id
  claim_date_bs
  claim_date_ad
  destination
  purpose
  travel_amount          -- transport cost (bus/taxi/flight)
  daily_allowance        -- per diem rate
  days_out               -- number of days out-of-station
  total_amount           -- travel_amount + (daily_allowance × days_out)
  receipt_url            -- optional attachment
  status                 -- draft | submitted | approved | rejected
  submitted_at
  approved_by
  approved_at
  payroll_run_id         -- linked when pulled into payroll
  notes
```

### Tax Treatment
Taxable under TDS — added to Total Earnings before TDS is computed.

### Feature Flag
Growth+. Fits in Session 10 alongside Festival Allowance and Advances.

---

## 17. CREST HR — INCENTIVES

### Incentive Types
| Type | Trigger | Amount Basis |
|---|---|---|
| Performance | Manager sets target, employee hits it | Fixed amount |
| Attendance | Zero absences / zero lates in month | Fixed amount — auto-computed |
| Sales | Employee revenue vs target (POS data) | % of excess revenue |
| Discretionary | Manager free-form entry | Manual NPR amount |

### Automation Level
| Type | Auto-draft | Auto-compute | Needs Approval |
|---|---|---|---|
| Attendance | ✓ reads hr_attendance | ✓ Yes | Manager confirms |
| Sales | ✓ reads pos_bills (Suite) | ✓ Yes | Manager confirms |
| Performance | ✗ Manager drafts | ✗ Manual | Yes |
| Discretionary | ✗ Manager drafts | ✗ Manual | Yes |

Sales incentive auto-computation requires POS data — Suite Growth+ only. Standalone HR enters sales incentive manually.

### Multiple Incentives in One Month
All approved incentives summed as one payslip line:
```
Incentives:
  Attendance Bonus     NPR 1,000   ✓ Auto
  Sales Bonus          NPR 400     ✓ Approved
  Discretionary        NPR 2,000   ✓ Approved
  ───────────────────────────────
  Total Incentives     NPR 3,400
```

### Tax Treatment
All incentives taxable under TDS — added to Total Earnings.

### DB Tables
```sql
hr_incentives
  id, employee_id, month_bs, incentive_type, criteria_description,
  target_value, actual_value, amount, status, approved_by, approved_at,
  payroll_run_id, notes

hr_incentive_configs
  id, client_id, employee_id (null = all), department (null = all),
  incentive_type, criteria_description, target_value,
  amount_type (fixed | pct_salary | pct_revenue), amount_value, active
```

### Feature Flag
Growth+. Fits in Session 10.

---

## 18. CREST HR — HOLIDAY CALENDAR

### Core Principle
No hardcoded holiday list. Each client builds their own from a Crest-provided base template of Nepal public holidays per fiscal year.

### Management Flow
1. Crest seeds `admin_holiday_templates` with Nepal government holiday list for the fiscal year
2. At Baisakh 1 (fiscal year start), Supabase function copies template → `hr_holiday_calendar` per active client
3. Client manager reviews, accepts, removes, or adds custom holidays
4. List locked for the year — becomes source of truth for roster and OT

### Holiday Effects on the System

**OT Rate (2x)**
```
Employee works on a holiday → OT rate = 2x basic daily rate
Holiday OT = (Basic ÷ 26 ÷ 8) × hours worked × 2
```
System checks `hr_holiday_calendar` automatically when computing OT.

**Roster Blocking with Override**
Holiday cells highlighted on roster board (amber). Assigning a shift shows:
```
⚠ [Holiday Name] is a public holiday.
Assigning this shift will trigger 2x OT rate.
Confirm?  [ Yes, assign ]  [ Cancel ]
```
Manager can proceed — hospitality never closes for holidays.

**Attendance Status on Holidays**
| Code | Meaning |
|---|---|
| H | Holiday — not worked. Full pay, no deduction |
| H-W | Holiday — worked. Full pay + 2x OT |

### DB Tables
```sql
hr_holiday_calendar
  id, client_id, fiscal_year_bs, date_bs, date_ad,
  holiday_name, holiday_type (public | festival | company | regional),
  applicable_gender (all | female | male),
  is_paid, ot_multiplier (default 2.0), source (template | custom),
  created_by, notes

admin_holiday_templates
  id, fiscal_year_bs, date_bs, date_ad,
  holiday_name, holiday_type, is_paid, ot_multiplier
```

### Build Timing
Add as pre-session setup before Session 4 (Rostering). Sessions 4 and 6 (OT) read from `hr_holiday_calendar` — no extra work needed there.

### Feature Flag
Holiday calendar config — all plans. 2x OT computation from holidays — Growth+ (OT management is Growth+).

---

## 19. CREST HR — GENDER-BASED HOLIDAY ENTITLEMENT

### The Rule (Nepal Labour Act)
```
Female employees:  14 paid public holidays per year
Male employees:    13 paid public holidays per year
```
Both drawn from the same `hr_holiday_calendar`. The natural differentiator is **Teej** — a festival observed by women, tagged as female-only in the holiday calendar.

### How It Works
The holiday calendar is unified. Gender split is handled at the entitlement level via the `applicable_gender` field on each holiday:

```
Teej              → applicable_gender: female
All other holidays → applicable_gender: all
```

System enforces:
- Female employee + holiday tagged `female` or `all` → status `H` → paid
- Male employee + holiday tagged `female` → treated as regular working day
- Male employee + holiday tagged `all` → status `H` → paid

### Impact on Roster Board
Roster cells display differently per employee row based on gender:
```
            MON (Teej)    TUE      WED
Sita (F)    🟡 H          MORN     AFT    ← holiday, not rostered
Ramesh (M)  MORN          MORN     AFT    ← Teej not his holiday
```

Assigning Sita on Teej triggers the 2x OT warning.

### DB Changes
```sql
-- hr_holiday_calendar (already includes):
applicable_gender    -- 'all' | 'female' | 'male'

-- hr_employees (add):
gender               -- 'male' | 'female' | 'other'
holiday_entitlement  -- auto-set: 14 if female, 13 if male, configurable if other
```

### Complete Leave Entitlement Table
| Leave Type | Days | Gender | Paid | Source |
|---|---|---|---|---|
| Annual Leave | 18 | All | Yes | Labour Act |
| Sick Leave | 12 | All | Yes | Labour Act |
| Casual Leave | 6 | All | Yes | Labour Act |
| Maternity Leave | 98 | Female | Yes | Labour Act |
| Public Holidays | 14 | Female | Yes | Labour Act |
| Public Holidays | 13 | Male | Yes | Labour Act |

### Build Timing
- Session 3 (Leave Management): add gender-based entitlement logic to leave types
- Session 4 (Rostering): read `applicable_gender` to colour cells per employee row
- Session 5 (Attendance): apply `H` status based on gender entitlement match

---

## 20. ADMIN DASHBOARD — CREST INTERNAL ONLY

### What It Is
Crest Hospitality's internal command centre. No client ever sees this. Accessible only to super_admin role.

### Route Protection
```javascript
{isSuperAdmin && <Route path="/admin" component={AdminDashboard} />}
```

### File Structure
```
src/admin/
├── AdminDashboard.jsx        ← landing screen with top-level KPIs
├── ClientList.jsx            ← all clients table with filters
├── ClientDetail.jsx          ← drill into one client
├── BillingOverview.jsx       ← revenue across all clients
├── OnboardingTracker.jsx     ← new client pipeline
└── SupportFlags.jsx          ← issues and flags
```

### Screen 1 — Admin Dashboard (Landing)
```
Total Clients     8          Active: 7  |  Churned: 1
MRR               NPR 1,54,000
ARR (projected)   NPR 18,48,000
Avg Revenue       NPR 19,250
─────────────────────────────────────
Onboarding        2 clients in progress
Support Flags     3 open issues
Renewals Due      1 client — renews in 7 days
```

### Screen 2 — Client List
Columns: Client name, Modules enabled, Plan, MRR, Billing cycle, Status, Since (BS date)
Filters: by module, by plan, by billing cycle, by status
Click row → opens Client Detail

### Screen 3 — Client Detail
Shows: modules enabled, plan per module, MRR, billing status, last payment, next due, onboarding checklist progress, open support flags
Actions: edit subscription, toggle modules, add support flag, send payment reminder, log a note

### Screen 4 — Billing Overview
Shows: MRR breakdown by module, payment status this month (paid / overdue / due this week), annual vs monthly split

### Screen 5 — Onboarding Tracker
Progress bar per client through onboarding checklist steps.

IMS Onboarding Checklist:
- Account created and login sent
- Item master imported
- Vendors added
- Opening stock count done
- First purchase entry
- First variance report reviewed

HR Onboarding Checklist:
- Account created
- Employees added
- Salary structures configured
- First roster published
- First payroll run
- SSF challan generated

### Screen 6 — Support Flags
Columns: Client, Issue, Severity (High/Medium/Low), Opened (BS date), Status (Open/In Progress/Resolved)

### When to Build
Build when third client is signed. Until then, manage clients directly in Supabase. The `shared_clients` table structure should be kept clean now so the admin dashboard can read it without retrofitting.

---

## 21. PROJECT STRUCTURE

### Single Repository
```
crest-suite/
├── public/
│   ├── manifest.json
│   └── service-worker.js
├── src/
│   ├── modules/
│   │   ├── ims/
│   │   │   ├── items/
│   │   │   ├── vendors/
│   │   │   ├── purchases/
│   │   │   ├── stockcount/
│   │   │   ├── recipes/
│   │   │   ├── sales/
│   │   │   ├── variance/
│   │   │   └── reports/
│   │   ├── pos/
│   │   │   ├── tables/
│   │   │   ├── orders/
│   │   │   ├── kot/
│   │   │   ├── billing/
│   │   │   ├── payments/
│   │   │   ├── shifts/
│   │   │   ├── menu/
│   │   │   └── reports/
│   │   └── hr/
│   │       ├── employees/
│   │       ├── leave/
│   │       ├── attendance/
│   │       ├── roster/
│   │       ├── overtime/
│   │       ├── salary/
│   │       ├── ssf/
│   │       ├── tds/
│   │       ├── payroll/
│   │       ├── festival/
│   │       ├── advances/
│   │       ├── tada/
│   │       ├── incentives/
│   │       ├── calendar/        ← holiday config
│   │       └── reports/
│   ├── shared/
│   │   ├── components/
│   │   ├── hooks/             ← useClientFeatures, useAuth, useBS
│   │   ├── context/           ← AuthContext, ClientContext, FeatureContext
│   │   ├── utils/             ← BS/AD converters, currency formatters, ssfUtils, tdsUtils
│   │   └── constants/         ← leave types, shift types, tax slabs, SSF rates
│   ├── admin/                 ← Crest internal only, super_admin role
│   ├── auth/
│   └── App.jsx
├── supabase/
│   └── migrations/
├── .env.local
└── package.json
```

### Key Hooks
```javascript
// useClientFeatures
const useClientFeatures = () => {
  const { client } = useAuth();
  return {
    ims_enabled: client.ims_enabled,
    ims_plan: client.ims_plan,
    pos_enabled: client.pos_enabled,
    pos_plan: client.pos_plan,
    hr_enabled: client.hr_enabled,
    hr_plan: client.hr_plan,
  };
};

// useBS
const useBS = () => ({
  toBS: (adDate) => { /* convert AD to BS */ },
  toAD: (bsDate) => { /* convert BS to AD */ },
  currentBSMonth: () => { /* current BS month name and year */ },
  bsMonths: ["Baisakh","Jestha","Ashadh","Shrawan","Bhadra","Ashwin",
             "Kartik","Mangsir","Poush","Magh","Falgun","Chaitra"]
});
```

---

## 22. BRANDING AND DESIGN

| Element | Value |
|---|---|
| Primary colour | Navy — #1B2A4A |
| Accent colour | Gold — #C9A84C |
| Light gold | #F5EDD6 |
| Light grey | #F2F2F2 |
| Font (documents) | Garamond |
| Font (UI) | System font |
| Document style | A4, Garamond, navy/gold, professional |
| Report style | Cover page, colour-coded tables, confidential footer |

---

## 23. DEPLOYMENT

| Environment | URL | Platform |
|---|---|---|
| Production | app.cresthospitality.com | Vercel |
| Staging | staging.cresthospitality.com | Vercel |
| Database | Supabase (single project) | Supabase Cloud |

---

## 24. WHAT NOT TO BUILD YET

The following are planned future Crest divisions — do not build these now:
- Crest ATS (Applicant Tracking)
- Crest Academy (Training Platform)
- Crest Analytics (Industry Data)
- Crest Warehouse (B2B Supply)
- Crest Caterer (Lunchbox and Events)
- Crest Transport (Vehicle Hire)
- Crest OTA (Online Travel Agency)
- Crest DM (Digital Marketing)
- Crest Finance (Capital Facilitation)

**Current focus:** Crest IMS (enhance) + Crest POS (build) + Crest HR (build) — one codebase.

---

## 25. GLOSSARY

| Term | Meaning |
|---|---|
| BS | Bikram Sambat — Nepal's official calendar |
| AD | Anno Domini — Gregorian calendar |
| NPR | Nepalese Rupee |
| VAT | Value Added Tax — 13% in Nepal |
| SSF | Social Security Fund — Nepal |
| TDS | Tax Deducted at Source |
| IRD | Inland Revenue Department — Nepal's tax authority |
| BOH | Back of House — kitchen, stores, prep areas |
| FOH | Front of House — dining room, bar, reception |
| KOT | Kitchen Order Ticket |
| FIFO | First In First Out — stock cost methodology |
| COGS | Cost of Goods Sold |
| ATV | Average Transaction Value |
| OT | Overtime |
| PO | Purchase Order |
| RLS | Row Level Security (Supabase) |
| PWA | Progressive Web App |
| ESC/POS | Printer protocol standard for thermal printers |
| IMS | Inventory Management System |
| POS | Point of Sale |
| HR | Human Resources |
| CaaS | Controls as a Service (consulting retainer) |
| NPABSON | Nepal Private and Boarding Schools Organisation of Nepal |
| MRR | Monthly Recurring Revenue |
| ARR | Annual Recurring Revenue |
| TADA | Travel Allowance and Daily Allowance — out-of-station expense claim |

---

*Crest Hospitality (Pvt. Ltd.) | Kathmandu, Nepal | Confidential | June 2026*
