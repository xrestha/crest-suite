// Builds the whole Bloom demo in memory and writes it out as ordered SQL files.
//   node --import ./register.mjs build.mjs --out <dir> [--until 2026-10-09 --until-min 1020] [--profiles profiles.json]
// Nothing here touches the database; apply.mjs runs the files.
import fs from 'node:fs'
import path from 'node:path'
import { uid, ts, insertSql, nepalNowParts, round2, lit, uuidArr, textArr, rngFor } from './lib.mjs'
import { OUTLETS, OWNER_ID, KTM_MANAGER_PROFILE, GROUP_ID, BS_YEAR, ASSETS, CATEGORIES, BASE_CUTOFF } from './config.mjs'
import { buildDays, adOf, monthDays } from './calendar.mjs'
import { buildMaster } from './model.mjs'
import { simulatePos } from './pos.mjs'
import { simulateIms } from './ims.mjs'
import { buildHr, runPayroll, TILL } from './hr.mjs'

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d }
const now = nepalNowParts()
const cutoff = { ad: arg('--until', now.adDate), minutes: Number(arg('--until-min', now.minutes - 10)) }
const outDir = arg('--out', 'out')
const profilesFile = arg('--profiles', null)
const profilesIn = profilesFile && fs.existsSync(profilesFile) ? JSON.parse(fs.readFileSync(profilesFile, 'utf8')) : null
fs.mkdirSync(outDir, { recursive: true })
for (const f of fs.readdirSync(outDir)) if (f.endsWith('.sql')) fs.unlinkSync(path.join(outDir, f))

const days = buildDays(cutoff.ad)
const files = []
const write = (name, body) => {
  if (!body.trim()) return
  fs.writeFileSync(path.join(outDir, name), `BEGIN;\n${body}\nCOMMIT;\n`)
  files.push(name)
}
const sumBy = (arr, f) => arr.reduce((s, x) => s + f(x), 0)
// The final state of every row this build stands for, by table and id: the top-up diffs two of these.
const state = {}
const record = (table, rows) => {
  const t = state[table] || (state[table] = {})
  for (const r of rows) t[r.id] = Object.fromEntries(Object.entries(r).filter(([k]) => !k.startsWith('_')).map(([k, v]) => [k, v && v.sql ? { $raw: v.sql } : v]))
}
const patchState = (table, id, patch) => { if (state[table]?.[id]) Object.assign(state[table][id], patch) }
const ins = (table, rows) => { if (rows.length) record(table, rows); return insertSql(table, rows) }
const report = {}

const PARTNERS = [{ name: 'Foodmandu', phone: '9801907569', pct: 20 }, { name: 'Pathao', phone: '980000002', pct: 20 }]
const ktmCreated = ts('2026-07-14', 600)

const outlets = {}
for (const o of ['ktm', 'pkr']) {
  const outlet = OUTLETS[o]
  const M = buildMaster(outlet, { hqMaster: o === 'pkr', createdAt: o === 'ktm' ? ktmCreated : ts('2026-07-15', 600) })
  const periodIdOf = m => uid(o, 'period', m)
  const hr = buildHr({ outlet, days, cutoff, periodIdOf })
  const till = TILL[o]
  const profiles = profilesIn?.[o] || Object.fromEntries(Object.values(till).map(k => [k, uid('placeholder-profile', o, k)]))
  if (o === 'ktm') profiles.sita = KTM_MANAGER_PROFILE
  const staff = { ...till, profiles, onAt: hr.onAt, working: hr.working }
  const pos = simulatePos({ outlet, M, days, cutoff, staff, periodIdOf, partners: PARTNERS })
  const ims = simulateIms({ outlet, M, days, cutoff, posByDay: pos.byDay, headcountOf: hr.headcountOf, periodIdOf })
  outlets[o] = { outlet, M, hr, pos, ims, periodIdOf, profiles }
}

// ── Payroll: Shrawan (paid) and Bhadra (finalized, not paid) ──
for (const o of ['ktm', 'pkr']) {
  const X = outlets[o]
  const per = m => ({ id: X.periodIdOf(m), bs_year: BS_YEAR, bs_month: m })
  const s = runPayroll({ outlet: X.outlet, hr: X.hr, period: per(4), monthAd: { start: adOf(4, 1), end: adOf(4, monthDays(4)) },
    prior: { payslips: [], repayments: [] }, createdAt: ts(adOf(5, 1), 630), finalizedAt: ts(adOf(5, 2), 680), runId: uid(o, 'run', 4) })
  const b = runPayroll({ outlet: X.outlet, hr: X.hr, period: per(5), monthAd: { start: adOf(5, 1), end: adOf(5, monthDays(5)) },
    prior: { payslips: s.embedded, repayments: s.repayments }, createdAt: ts(adOf(6, 1), 630), finalizedAt: ts(adOf(6, 2), 690), runId: uid(o, 'run', 5) })
  const emp = id => X.hr.employees.find(e => e.id === id)
  const salaryPayments = s.payslips.filter(p => p.net_pay > 0).map(p => ({
    id: uid(o, 'salpay', p.id), client_id: X.outlet.clientId, run_id: s.run.id, employee_id: p.employee_id, amount: p.net_pay,
    paid_on: adOf(5, 4), method: emp(p.employee_id).bank_account_no ? 'bank' : 'cash',
    reference: emp(p.employee_id).bank_account_no ? 'Shrawan salary — bulk transfer' : 'Paid in cash', paid_by: OWNER_ID, created_at: ts(adOf(5, 4), 720),
  }))
  X.payroll = { s, b, salaryPayments }
  // A top-up past Kartik 3: Ashoj's payroll is finalized (waiting to be paid) and Bhadra's is paid.
  if (cutoff.ad >= adOf(7, 3)) {
    const a = runPayroll({ outlet: X.outlet, hr: X.hr, period: per(6), monthAd: { start: adOf(6, 1), end: adOf(6, monthDays(6)) },
      prior: { payslips: [...s.embedded, ...b.embedded], repayments: [...s.repayments, ...b.repayments] }, createdAt: ts(adOf(7, 2), 630), finalizedAt: ts(adOf(7, 3), 690), runId: uid(o, 'run', 6) })
    const bhadraPaid = b.payslips.filter(p => p.net_pay > 0).map(p => ({
      id: uid(o, 'salpay', p.id), client_id: X.outlet.clientId, run_id: b.run.id, employee_id: p.employee_id, amount: p.net_pay,
      paid_on: adOf(7, 3), method: emp(p.employee_id).bank_account_no ? 'bank' : 'cash',
      reference: emp(p.employee_id).bank_account_no ? 'Bhadra salary - bulk transfer' : 'Paid in cash', paid_by: OWNER_ID, created_at: ts(adOf(7, 3), 720),
    }))
    X.payroll.a = a
    X.payroll.bhadraPaid = bhadraPaid
  }
}

// ── 00 Account setup ──
{
  const k = OUTLETS.ktm.clientId, p = OUTLETS.pkr.clientId
  const sets = (cid, f) => `UPDATE public.settings SET ${Object.entries(f).map(([c, v]) => `${c} = ${lit(v)}`).join(', ')}, updated_at = now() WHERE client_id = '${cid}';\n`
  const common = {
    is_vat_registered: true, vat_number: '609874215',
    pos_discount_reasons: textArr(['Regular guest', 'Corporate', 'Manager approval', 'Staff meal']),
    tada_purpose_options: ['Purchase', 'Delivery', 'Branch visit', 'Training'],
    pos_loyalty_point_value: 1, pos_delivery_partners: PARTNERS.map(x => ({ name: x.name, phone: x.phone, commission_pct: x.pct })),
    pos_note_presets: textArr(['Less spicy', 'No onion', 'Extra hot', 'Pack separately']),
    tada_start_points: ['Cafe', 'Office'], tada_vehicle_rates: { '2w': 10, '4w': 25, ev: 3 },
  }
  let sql = ''
  sql += sets(k, { ...common, app_tagline: null, property_address: 'Jhamsikhel Road, Lalitpur-3', property_phone: '01-5550123',
    payment_qr_data: 'BLOOM-CAFE-DEMO|This is a sample QR for demonstrations only — it cannot take payments',
    weather_city: 'kathmandu', weather_lat: 27.72, weather_lon: 85.32, guest_menu_name: 'Bloom Café', invoice_prefix: 'BC' })
  sql += sets(p, { ...common, property_address: 'Lakeside-6, Pokhara', property_phone: '061-555012', invoice_prefix: 'BP',
    pos_open_time: '08:00', pos_close_time: '21:00', guest_menu_name: 'Bloom Café Lakeside',
    payment_qr_data: 'BLOOM-CAFE-PKR-DEMO|This is a sample QR for demonstrations only — it cannot take payments',
    pos_reservation_settings: { arrival_grace_minutes: 20, closed_dates: [], closed_weekdays: [], duration_by_band: { '1-2': 60, '3-4': 90, '5-6': 105, '7+': 120 }, max_party_online: 6, public_booking: true } })
  sql += `UPDATE public.clients SET legal_name = 'Bloom Hospitality Pvt. Ltd.', pan_no = '609874215', registered_address = 'Jhamsikhel Road, Lalitpur-3' WHERE id IN ('${k}', '${p}');\n`
  sql += `UPDATE public.clients c SET plan = 'pro', pos_plan = 'pro', ims_ends_at = k.ims_ends_at, hr_ends_at = k.hr_ends_at, pos_ends_at = k.pos_ends_at, suite_ends_at = k.suite_ends_at FROM public.clients k WHERE c.id = '${p}' AND k.id = '${k}';\n`
  sql += `UPDATE public.client_groups SET name = 'Bloom Cafe Group' WHERE id = '${GROUP_ID}';\n`
  sql += `INSERT INTO public.onboarding_progress (user_id, client_id, step_key, state) SELECT '${OWNER_ID}', '${p}', 'card', 'dismissed' WHERE NOT EXISTS (SELECT 1 FROM public.onboarding_progress WHERE user_id = '${OWNER_ID}' AND client_id = '${p}' AND step_key = 'card');\n`
  write('00_setup.sql', sql)
}

// ── 01 Staff records (needed before the till logins are made) ──
{
  let sql = ''
  for (const o of ['ktm', 'pkr']) {
    const { hr } = outlets[o]
    sql += ins('hr_shift_types', hr.shiftTypes)
    sql += ins('hr_leave_types', hr.leaveTypes)
    sql += ins('hr_holiday_calendar', hr.holidays)
    sql += ins('hr_employees', hr.employees)
    for (const l of hr.supervisorLinks) {
      sql += `UPDATE public.hr_employees SET supervisor_id = '${l.supervisor_id}' WHERE id = '${l.id}';\n`
      patchState('hr_employees', l.id, { supervisor_id: l.supervisor_id })
    }
    sql += ins('hr_salary_components', hr.components)
  }
  sql += `UPDATE public.profiles SET full_name = 'Sita Shrestha', pos_job_title = 'Manager', pos_allow_void = true, hr_employee_id = '${outlets.ktm.hr.empId('sita')}' WHERE id = '${KTM_MANAGER_PROFILE}';\n`
  write('01_staff.sql', sql)
}

// ── 02 Master data, months, opening stock, the HR calendar ──
{
  let sql = ''
  for (const o of ['ktm', 'pkr']) {
    const { M, hr, pos, ims, periodIdOf, outlet } = outlets[o]
    const cid = outlet.clientId
    sql += ins('categories', M.categories)
    sql += ins('vendors', M.vendors)
    sql += ins('items', M.items)
    sql += ins('recipes', M.recipes)
    for (const sr of Object.values(M.subByCode)) {
      sql += `UPDATE public.recipes SET linked_item_id = '${sr.mirrorId}' WHERE id = '${sr.id}';\n`
      patchState('recipes', sr.id, { linked_item_id: sr.mirrorId })
    }
    sql += ins('recipe_ingredients', M.recipeIngredients)
    sql += ins('pos_option_groups', M.optionGroups)
    sql += ins('pos_options', M.options)
    sql += ins('pos_option_ingredients', M.optionIngredients)
    sql += ins('pos_recipe_option_groups', M.recipeOptionGroups)
    sql += ins('pos_tables', M.tables)
    sql += ins('pos_loyalty_schemes', pos.schemes)
    sql += ins('pos_customers', pos.customers)
    sql += ins('monthly_periods', [
      { id: periodIdOf(4), client_id: cid, bs_year: BS_YEAR, bs_month: 4, status: 'closed', created_at: ts(adOf(4, 1), 420) },
      { id: periodIdOf(5), client_id: cid, bs_year: BS_YEAR, bs_month: 5, status: 'open', created_at: ts(adOf(5, 1), 425) },
    ])
    sql += ins('opening_stock', Object.entries(ims.opening[4]).map(([code, qty]) => ({ id: uid(o, 'open', 4, code), period_id: periodIdOf(4), item_id: M.itemByCode[code].id, qty, created_at: ts(adOf(4, 1), 430) })))
    sql += ins('par_levels', ims.pars)
    // Budgets: each stock category's month, set a little above what it usually spends.
    const budgetRows = []
    for (const m of [4, 5, 6]) {
      for (const cat of CATEGORIES) {
        const spend = sumBy(ims.purchases.filter(r => r.period_id === periodIdOf(m) && M.itemByCode[r._code].cat === cat), r => r.qty * r.rate)
        // From what the first build had bought, so a top-up never moves a budget already set.
        const typical = sumBy(ims.purchases.filter(r => !r._late && M.itemByCode[r._code].cat === cat), r => r.qty * r.rate) / 2.75
        if (typical > 0) budgetRows.push({ id: uid(o, 'budget', m, cat), client_id: cid, period_id: periodIdOf(m), category_id: M.catId[cat], amount: Math.round(typical * 1.03 / 1000) * 1000, _m: m, _spend: spend })
      }
    }
    sql += ins('budgets', budgetRows.filter(b => b._m < 6))
    outlets[o].ashojBudgets = budgetRows.filter(b => b._m === 6)
    // Fixed assets.
    const cats = [], regs = []
    let n = 0
    for (const [name, pool, life, list] of ASSETS[o]) {
      const catId = uid(o, 'asset-cat', name)
      cats.push({ id: catId, client_id: cid, name, default_useful_life_years: life, tax_pool_hint: pool, sort_order: cats.length + 1, created_at: ktmCreated })
      for (const [aname, qty, unit, acq] of list) {
        n += 1
        const years = (Date.parse('2026-07-16') - Date.parse(acq)) / (365.25 * 86400000)
        const accum = Math.round(qty * unit * Math.min(1, years / life))
        regs.push({ id: uid(o, 'asset', n), client_id: cid, category_id: catId, asset_code: `FA-${String(n).padStart(3, '0')}`, name: aname,
          location: o === 'ktm' ? 'Jhamsikhel' : 'Lakeside', quantity: qty, unit_cost: unit, acquisition_date: acq, useful_life_years: life, salvage_value: 0,
          depreciation_method: 'straight_line', tax_pool: pool, personal_use_percent: 0, status: 'active', created_by: OWNER_ID,
          opening_accumulated_depreciation: accum, opening_as_of: accum > 0 ? '2026-07-16' : null, created_at: ktmCreated, updated_at: ktmCreated })
      }
    }
    sql += ins('assets_categories', cats)
    sql += ins('assets_register', regs)
    // HR calendar pieces that span the whole window.
    sql += ins('hr_roster', hr.roster)
    sql += ins('hr_roster_publish_state', hr.publishState)
    sql += ins('hr_advances', hr.advances)
    sql += ins('hr_tada_claims', hr.tada)
    sql += ins('hr_tada_claim_items', hr.tadaItems)
    sql += ins('hr_shift_swap_requests', hr.swaps)
  }
  write('02_master.sql', sql)
}

// ── Day files ──
function dayFile(o, day) {
  const { M, hr, pos, ims } = outlets[o]
  const d = pos.byDay[day.key]
  let sql = ''
  const bills = ims.bills.filter(b => b.day.key === day.key)
  const poIds = new Set(bills.flatMap(b => b.rows.map(r => r.po_id)).filter(Boolean))
  sql += ins('purchase_orders', ims.pos.filter(p => poIds.has(p.id)))
  sql += ins('purchase_order_items', ims.poItems.filter(p => poIds.has(p.po_id)))
  const rows = bills.flatMap(b => b.rows)
  sql += ins('purchase_entries', rows)
  const rowIds = new Set(rows.map(r => r.id))
  sql += ins('payable_payments', ims.payments.filter(p => rowIds.has(p.purchase_entry_id)))
  sql += ins('vendor_returns', ims.returns.filter(r => r.bs_day === day.d && r.period_id === outlets[o].periodIdOf(day.m)))
  sql += ins('wastages', ims.wastages.filter(w => w.bs_day === day.d && w.period_id === outlets[o].periodIdOf(day.m)))
  sql += ins('pos_shifts', [d.shift])
  sql += ins('pos_orders', d.orders)
  sql += ins('pos_order_items', d.items)
  sql += ins('pos_order_item_options', d.itemOptions)
  sql += ins('pos_order_payments', d.payments)
  sql += ins('pos_kot_log', d.kot)
  sql += ins('pos_kot_removals', d.removals)
  sql += ins('pos_loyalty_ledger', d.ledger)
  sql += ins('sales_entries', d.sales)
  sql += ins('stock_movements', d.moves)
  for (const cn of d.notes) sql += ins('pos_credit_notes', [cn])
  sql += ins('pos_cash_movements', d.cashMoves)
  sql += ins('sales_entries', d.creditSales)
  const res = pos.reservations.filter(r => r.reserved_for.startsWith(day.ad))
  sql += ins('pos_reservations', res)
  const resIds = new Set(res.map(r => r.id))
  sql += ins('pos_reservation_tables', pos.resTables.filter(t => resIds.has(t.reservation_id)))
  sql += ins('hr_attendance', hr.attendance.filter(a => a.bs_day === day.d && a.period_id === outlets[o].periodIdOf(day.m)))
  sql += ins('hr_overtime_entries', hr.otEntries.filter(x => x.bs_month === day.m && x.bs_day === day.d))
  return sql
}

for (const day of days.filter(x => x.m < 6)) {
  write(`03_day_${String(day.m).padStart(2, '0')}_${String(day.d).padStart(2, '0')}.sql`, dayFile('ktm', day) + dayFile('pkr', day))
}

// ── 04 Shrawan and Bhadra month end ──
{
  let sql = ''
  for (const o of ['ktm', 'pkr']) {
    const { M, ims, hr, periodIdOf, payroll, outlet } = outlets[o]
    const counter = o === 'ktm' ? 'Sita Shrestha' : 'Rajan Adhikari'
    for (const m of [4, 5]) {
      sql += ins('closing_stock', Object.entries(ims.closings[m]).map(([code, qty]) => ({ id: uid(o, 'close', m, code), period_id: periodIdOf(m),
        item_id: M.itemByCode[code].id, physical_qty: qty, counted_by: null, counted_by_name: counter, counted_at: ts(adOf(m, monthDays(m)), 1250) })))
      sql += ins('staff_meals', ims.mealRows.filter(r => r.period_id === periodIdOf(m)))
      sql += ins('overheads', ims.overheads.filter(r => r.period_id === periodIdOf(m)))
    }
    sql += ins('opening_stock', Object.entries(ims.opening[5]).map(([code, qty]) => ({ id: uid(o, 'open', 5, code), period_id: periodIdOf(5), item_id: M.itemByCode[code].id, qty, created_at: ts(adOf(5, 1), 430) })))
    sql += ins('hr_leave_requests', hr.leaveRequests)
    const { s, b, salaryPayments } = payroll
    sql += ins('hr_payroll_runs', [s.run])
    sql += ins('hr_payslips', s.payslips.map(p => ({ ...p, tada_claim_ids: uuidArr(p.tada_claim_ids || []) })))
    sql += ins('hr_advance_repayments', s.repayments)
    sql += ins('hr_salary_payments', salaryPayments)
    sql += ins('hr_payroll_runs', [b.run])
    sql += ins('hr_payslips', b.payslips.map(p => ({ ...p, tada_claim_ids: uuidArr(p.tada_claim_ids || []) })))
    sql += ins('hr_advance_repayments', b.repayments)
  }
  write('04_monthend.sql', sql)
}

// ── 05 Bhadra closes, Ashoj opens ──
{
  let sql = ''
  for (const o of ['ktm', 'pkr']) {
    const { M, ims, periodIdOf, outlet } = outlets[o]
    sql += `UPDATE public.monthly_periods SET status = 'closed' WHERE id = '${periodIdOf(5)}';\n`
    patchState('monthly_periods', periodIdOf(5), { status: 'closed' })
    sql += ins('monthly_periods', [{ id: periodIdOf(6), client_id: outlet.clientId, bs_year: BS_YEAR, bs_month: 6, status: 'open', created_at: ts(adOf(6, 1), 425) }])
    sql += ins('opening_stock', Object.entries(ims.opening[6]).map(([code, qty]) => ({ id: uid(o, 'open', 6, code), period_id: periodIdOf(6), item_id: M.itemByCode[code].id, qty, created_at: ts(adOf(6, 1), 430) })))
    sql += ins('budgets', outlets[o].ashojBudgets)
    sql += ins('overheads', ims.overheads.filter(r => r.period_id === periodIdOf(6)))
  }
  write('05_ashoj_open.sql', sql)
}
for (const day of days.filter(x => x.m === 6)) {
  write(`06_day_${String(day.m).padStart(2, '0')}_${String(day.d).padStart(2, '0')}.sql`, dayFile('ktm', day) + dayFile('pkr', day))
}

// ── 07 Today's state, prices, what is waiting ──
{
  let sql = ''
  for (const o of ['ktm', 'pkr']) {
    const { M, ims, pos, periodIdOf, outlet } = outlets[o]
    sql += ins('staff_meals', ims.mealRows.filter(r => r.period_id === periodIdOf(6)))
    for (const [code, rate] of Object.entries(ims.lastRate)) {
      sql += `UPDATE public.items SET rate = ${rate} WHERE id = '${M.itemByCode[code].id}';\n`
      patchState('items', M.itemByCode[code].id, { rate })
    }
    for (const tid of pos.openTableIds) if (tid) patchState('pos_tables', tid, { status: 'occupied' })
    if (pos.openTableIds.size) sql += `UPDATE public.pos_tables SET status = 'occupied' WHERE id IN (${[...pos.openTableIds].filter(Boolean).map(i => `'${i}'`).join(',')});\n`
    // Bookings for the coming days.
    const ahead = o === 'ktm'
      ? [[6, 24, 1140, 4, 'G1', 'confirmed', 'Birthday'], [6, 24, 780, 2, 'T5', 'booked', null], [6, 26, 1110, 6, 'G3', 'confirmed', 'Office team dinner'], [6, 27, 750, 3, 'T6', 'booked', null]]
      : [[6, 24, 1170, 4, 'R1', 'confirmed', null], [6, 26, 780, 2, 'L2', 'booked', 'Anniversary']]
    const regs = pos.regulars
    ahead.forEach(([m, d, t, n, table, status, occasion], i) => {
      const r = regs[(i * 7 + 3) % regs.length]
      const rid = uid(o, 'res-ahead', i)
      const made = ts(BASE_CUTOFF.ad, Math.max(480, BASE_CUTOFF.minutes - 200 + i * 30))
      const dur = n <= 2 ? 60 : n <= 4 ? 90 : 105
      const passed = adOf(m, d) < cutoff.ad
      sql += ins('pos_reservations', [{ id: rid, client_id: outlet.clientId, customer_name: r.name, phone: r.phone, party_size: n, reserved_for: ts(adOf(m, d), t),
        duration_minutes: dur, status: passed ? 'completed' : status, source: i % 2 ? 'phone' : 'whatsapp', occasion, notes: null, cancel_reason: null, order_id: null,
        confirmed_at: status === 'confirmed' || passed ? made : null, created_by: OWNER_ID, created_at: made, updated_at: passed ? ts(adOf(m, d), t + dur) : made,
        ...(passed ? { arrived_at: ts(adOf(m, d), t - 3), completed_at: ts(adOf(m, d), t + dur) } : {}) }])
      sql += ins('pos_reservation_tables', [{ id: uid(o, 'res-ahead-t', i), client_id: outlet.clientId, reservation_id: rid, table_id: M.tables.find(x => x.name === table).id }])
    })
    // An order already sent to the dry-goods supplier for this Sunday.
    if (o === 'ktm') {
      const poId = uid(o, 'po-open')
      const n = ims.pos.filter(p => !p._late).length + 1
      const overdue = cutoff.ad > adOf(6, 26)
      sql += ins('purchase_orders', [{ id: poId, client_id: outlet.clientId, vendor_id: M.vendorByKey.grocery.id, period_id: periodIdOf(6), po_number: `PO-${String(n).padStart(3, '0')}`,
        status: overdue ? 'cancelled' : 'sent', notes: overdue ? 'Weekly dry goods order — stock up before Dashain (merged into the Sunday delivery)' : 'Weekly dry goods order — stock up before Dashain',
        expected_date: adOf(6, 26), created_at: ts(BASE_CUTOFF.ad, Math.max(500, BASE_CUTOFF.minutes - 120)) }])
      sql += ins('purchase_order_items', [['ITM-028', 10000], ['ITM-029', 15000], ['ITM-031', 6000], ['ITM-032', 10000], ['ITM-034', 10000]].map(([code, qty]) => ({
        id: uid(o, 'po-open', code), po_id: poId, item_id: M.itemByCode[code].id, qty_ordered: qty, unit_price: ims.lastRate[code] || M.itemByCode[code].baseRate, qty_received: 0 })))
    }
  }
  write('07_today.sql', sql)
}

// -- The rest of the state: anything a top-up past the first cut-off can reach --
// (Months that end, counts, overheads, budgets, payroll, new bookings. The SQL files above are the
// first build's; a top-up applies the difference between two of these states.)
{
  const lastMonth = days[days.length - 1].m
  for (const o of ['ktm', 'pkr']) {
    const { M, ims, hr, pos, periodIdOf, outlet, payroll } = outlets[o]
    const cid = outlet.clientId
    const monthsSeen = [...new Set(days.map(d => d.m))]
    record('monthly_periods', monthsSeen.map(m => ({ id: periodIdOf(m), client_id: cid, bs_year: BS_YEAR, bs_month: m,
      status: m < lastMonth ? 'closed' : 'open', created_at: ts(adOf(m, 1), m === 4 ? 420 : 425) })))
    for (const [m, map] of Object.entries(ims.opening)) {
      if (!monthsSeen.includes(Number(m))) continue
      record('opening_stock', Object.entries(map).map(([code, qty]) => ({ id: uid(o, 'open', m, code), period_id: periodIdOf(Number(m)), item_id: M.itemByCode[code].id, qty, created_at: ts(adOf(Number(m), 1), 430) })))
    }
    const counter = o === 'ktm' ? 'Sita Shrestha' : 'Rajan Adhikari'
    for (const [m, map] of Object.entries(ims.closings)) {
      record('closing_stock', Object.entries(map).map(([code, qty]) => ({ id: uid(o, 'close', m, code), period_id: periodIdOf(Number(m)),
        item_id: M.itemByCode[code].id, physical_qty: qty, counted_by: null, counted_by_name: counter, counted_at: ts(adOf(Number(m), monthDays(Number(m))), 1250) })))
    }
    record('staff_meals', ims.mealRows)
    record('overheads', ims.overheads)
    const budgetRows = []
    for (const m of monthsSeen) for (const cat of CATEGORIES) {
      const typical = sumBy(ims.purchases.filter(r => !r._late && M.itemByCode[r._code].cat === cat), r => r.qty * r.rate) / 2.75
      if (typical > 0) budgetRows.push({ id: uid(o, 'budget', m, cat), client_id: cid, period_id: periodIdOf(m), category_id: M.catId[cat], amount: Math.round(typical * 1.03 / 1000) * 1000 })
    }
    record('budgets', budgetRows)
    if (payroll.a) {
      record('hr_payroll_runs', [payroll.a.run])
      record('hr_payslips', payroll.a.payslips.map(p => ({ ...p, tada_claim_ids: uuidArr(p.tada_claim_ids || []) })))
      record('hr_advance_repayments', payroll.a.repayments)
      record('hr_salary_payments', payroll.bhadraPaid)
    }
    record('hr_tada_claims', hr.tada)
    record('hr_leave_requests', hr.leaveRequests)
    record('hr_overtime_entries', hr.otEntries)
    record('hr_shift_swap_requests', hr.swaps)
    record('hr_roster', hr.roster)
    record('hr_roster_publish_state', hr.publishState)
    // Bookings for the days after a later cut-off.
    if (cutoff.ad > BASE_CUTOFF.ad) {
      const Rr = rngFor(o, 'bookings-ahead', cutoff.ad)
      const ahead = []
      for (const m of [6, 7, 8]) for (let d = 1; d <= monthDays(m); d++) { const ad = adOf(m, d); if (ad > cutoff.ad && ahead.length < 4) ahead.push({ m, d, ad }) }
      for (const day of ahead) {
        const nB = Rr.int(0, o === 'ktm' ? 2 : 1)
        const used = new Set()
        for (let i = 0; i < nB; i++) {
          const r = Rr.pick(pos.regulars)
          const tb = Rr.pick(M.tables.filter(t => !used.has(t.id)))
          used.add(tb.id)
          const n = Math.min(tb.capacity, Rr.int(2, 6)), t = Rr.pick([750, 780, 1110, 1140, 1170])
          const rid = uid(o, 'res-next', day.ad, i)
          const made = ts(cutoff.ad, Math.max(480, cutoff.minutes - 60 * (i + 1)))
          record('pos_reservations', [{ id: rid, client_id: cid, customer_name: r.name, phone: r.phone, party_size: n, reserved_for: ts(day.ad, t),
            duration_minutes: n <= 2 ? 60 : n <= 4 ? 90 : 105, status: Rr.chance(0.6) ? 'confirmed' : 'booked', source: Rr.pick(['phone', 'whatsapp', 'instagram']),
            occasion: null, notes: null, cancel_reason: null, order_id: null, confirmed_at: made, created_by: OWNER_ID, created_at: made, updated_at: made }])
          record('pos_reservation_tables', [{ id: uid(o, 'res-next-t', day.ad, i), client_id: cid, reservation_id: rid, table_id: tb.id }])
        }
      }
    }
  }
}

// ── Report ──
for (const o of ['ktm', 'pkr']) {
  const { pos, ims, M, payroll, hr } = outlets[o]
  const r = report[o] = {}
  for (const m of [4, 5, 6]) {
    const ds = days.filter(x => x.m === m)
    const orders = ds.flatMap(x => pos.byDay[x.key].orders)
    const paid = orders.filter(x => x._kind === 'paid')
    const revInc = sumBy(paid, x => x.paid_amount)
    const revEx = sumBy(ds.flatMap(x => pos.byDay[x.key].sales.filter(s => s.source === 'pos')), s => s.qty_sold * s.unit_price)
      + sumBy(ds.flatMap(x => pos.byDay[x.key].creditSales), s => s.qty_sold * s.unit_price)
    const purchases = sumBy(ims.purchases.filter(p => p.period_id === outlets[o].periodIdOf(m)), p => p.qty * p.rate * (1 - (p.discount_amount || 0) / 1e9))
    const rate = code => ims.lastRate[code] || M.itemByCode[code].baseRate
    let cogs = null
    if (ims.closings[m]) {
      const val = map => sumBy(Object.entries(map), ([c, q]) => q * rate(c))
      const waste = sumBy(ims.wastages.filter(w => w.period_id === outlets[o].periodIdOf(m)), w => w.qty * rate(Object.keys(M.itemByCode).find(c => M.itemByCode[c].id === w.item_id)))
      const meals = sumBy(ims.mealRows.filter(w => w.period_id === outlets[o].periodIdOf(m)), w => w.qty * rate(Object.keys(M.itemByCode).find(c => M.itemByCode[c].id === w.item_id)))
      cogs = val(ims.opening[m]) + purchases - val(ims.closings[m]) - waste - meals
    }
    r[m] = { days: ds.length, bills: orders.length, paidBills: paid.length, perDay: Math.round(revInc / ds.length), avgBill: Math.round(revInc / paid.length),
      revenueIncVat: revInc, revenueExVat: Math.round(revEx), purchases: Math.round(purchases), foodCostPct: cogs ? round2(cogs / revEx * 100) : null,
      voids: orders.filter(x => x._kind === 'void').length, comps: orders.filter(x => x._kind === 'writeoff').length,
      discounts: paid.filter(x => x.discount_amount > 0).length, delivery: paid.filter(x => x._partner).length }
  }
  r.payroll = { shrawanNet: Math.round(sumBy(payroll.s.payslips, p => p.net_pay)), bhadraNet: Math.round(sumBy(payroll.b.payslips, p => p.net_pay)),
    shrawanGross: Math.round(sumBy(payroll.s.payslips, p => p.gross)), staff: hr.employees.length }
  r.openOrders = pos.allOrders.filter(x => x._kind === 'open').length
  r.customers = pos.customers.length
  r.reservations = pos.reservations.length
  r.creditNotes = pos.creditNotes.length
}
fs.writeFileSync(path.join(outDir, 'report.json'), JSON.stringify({ cutoff, files: files.length, report }, null, 2))
fs.writeFileSync(path.join(outDir, 'state.json'), JSON.stringify({ cutoff, state }))
console.log(JSON.stringify({ cutoff, files: files.length, report }, null, 1))
