-- ════════════════════════════════════════════════════════════════════════════════════════════
-- S860 (2026-10-23): write down the table grants the live database holds today.
--
-- From 2026-10-30 Supabase stops granting Data API access on new tables in public automatically,
-- for every project, and that includes a schema rebuilt from these files (a new project, a preview
-- branch, a local `supabase db reset`). The 52 tables in 20260705074838_baseline_schema.sql and
-- monthly_owner_reports (20260721010000) were created with no GRANT at all: they hold their access
-- on the live project only because the old defaults handed it out. Rebuilt after 2026-10-30, they
-- would start locked, and every page would read "permission denied".
--
-- This file lists every grant that anon, authenticated and service_role hold on a public table,
-- view or sequence, read from the live catalog on 2026-10-23 (aclexplode over pg_class.relacl:
-- 233 grants on 122 objects; PUBLIC holds none), and grants each one again.
--   - On the live project it changes nothing: every grant below is already held.
--   - It never REVOKEs. Least privilege is set by the files that made each table and by S821
--     (20261012150000); this file only restores what a rebuild would lose.
--   - An object a rebuild does not have is skipped with a NOTICE, not an error: some live changes
--     were never saved as files (S753), so a rebuild comes out usable, not identical.
--   - anon holds exactly one grant, SELECT on settings: the pre-login app_name read
--     (supabase-sql.md). audit_logs_id_seq holds no grant on live, so it gets none here.
--   - A table added after 2026-10-23 carries its own GRANTs in its own file (apply-migration).
-- Reverse: nothing to reverse on live. On a rebuilt copy, REVOKE the listed grants.
-- ════════════════════════════════════════════════════════════════════════════════════════════

DO $$
DECLARE
  g       record;
  rel     regclass;
  p       text;
  missing text[] := '{}';
  failed  text[] := '{}';
BEGIN
  FOR g IN
    SELECT * FROM (VALUES
      ('app_secrets',                             'r', 'authenticated', 'DELETE,INSERT,SELECT,UPDATE'),
      ('app_secrets',                             'r', 'service_role',  'DELETE,INSERT,MAINTAIN,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE'),
      ('assets_categories',                       'r', 'authenticated', 'DELETE,INSERT,SELECT,UPDATE'),
      ('assets_categories',                       'r', 'service_role',  'DELETE,INSERT,MAINTAIN,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE'),
      ('assets_depreciation_runs',                'r', 'authenticated', 'DELETE,INSERT,SELECT,UPDATE'),
      ('assets_depreciation_runs',                'r', 'service_role',  'DELETE,INSERT,MAINTAIN,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE'),
      ('assets_depreciation_schedule',            'r', 'authenticated', 'DELETE,INSERT,SELECT,UPDATE'),
      ('assets_depreciation_schedule',            'r', 'service_role',  'DELETE,INSERT,MAINTAIN,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE'),
      ('assets_register',                         'r', 'authenticated', 'DELETE,INSERT,SELECT,UPDATE'),
      ('assets_register',                         'r', 'service_role',  'DELETE,INSERT,MAINTAIN,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE'),
      ('assets_repair_expenses',                  'r', 'authenticated', 'DELETE,INSERT,SELECT,UPDATE'),
      ('assets_repair_expenses',                  'r', 'service_role',  'DELETE,INSERT,MAINTAIN,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE'),
      ('assets_tax_pool_lines',                   'r', 'authenticated', 'DELETE,INSERT,SELECT,UPDATE'),
      ('assets_tax_pool_lines',                   'r', 'service_role',  'DELETE,INSERT,MAINTAIN,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE'),
      ('assets_tax_pool_opening_corrections',     'r', 'authenticated', 'INSERT,SELECT'),
      ('assets_tax_pool_opening_corrections',     'r', 'service_role',  'DELETE,INSERT,MAINTAIN,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE'),
      ('assets_tax_pool_openings',                'r', 'authenticated', 'DELETE,INSERT,SELECT,UPDATE'),
      ('assets_tax_pool_openings',                'r', 'service_role',  'DELETE,INSERT,MAINTAIN,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE'),
      ('assets_tax_pool_runs',                    'r', 'authenticated', 'DELETE,INSERT,SELECT,UPDATE'),
      ('assets_tax_pool_runs',                    'r', 'service_role',  'DELETE,INSERT,MAINTAIN,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE'),
      ('audit_logs',                              'r', 'authenticated', 'SELECT'),
      ('audit_logs',                              'r', 'service_role',  'DELETE,INSERT,MAINTAIN,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE'),
      ('bs_months',                               'r', 'authenticated', 'SELECT'),
      ('bs_months',                               'r', 'service_role',  'DELETE,INSERT,MAINTAIN,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE'),
      ('budgets',                                 'r', 'authenticated', 'DELETE,INSERT,SELECT,UPDATE'),
      ('budgets',                                 'r', 'service_role',  'DELETE,INSERT,MAINTAIN,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE'),
      ('categories',                              'r', 'authenticated', 'DELETE,INSERT,SELECT,UPDATE'),
      ('categories',                              'r', 'service_role',  'DELETE,INSERT,MAINTAIN,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE'),
      ('client_groups',                           'r', 'authenticated', 'DELETE,INSERT,SELECT,UPDATE'),
      ('client_groups',                           'r', 'service_role',  'DELETE,INSERT,MAINTAIN,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE'),
      ('client_secrets',                          'r', 'authenticated', 'DELETE,INSERT,SELECT,UPDATE'),
      ('client_secrets',                          'r', 'service_role',  'DELETE,INSERT,MAINTAIN,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE'),
      ('clients',                                 'r', 'authenticated', 'DELETE,INSERT,SELECT,UPDATE'),
      ('clients',                                 'r', 'service_role',  'DELETE,INSERT,MAINTAIN,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE'),
      ('closing_stock',                           'r', 'authenticated', 'DELETE,INSERT,SELECT,UPDATE'),
      ('closing_stock',                           'r', 'service_role',  'DELETE,INSERT,MAINTAIN,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE'),
      ('demand_forecast_daily',                   'r', 'authenticated', 'DELETE,INSERT,SELECT,UPDATE'),
      ('demand_forecast_daily',                   'r', 'service_role',  'DELETE,INSERT,MAINTAIN,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE'),
      ('demand_forecast_run_log',                 'r', 'authenticated', 'DELETE,INSERT,SELECT,UPDATE'),
      ('demand_forecast_run_log',                 'r', 'service_role',  'DELETE,INSERT,MAINTAIN,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE'),
      ('feature_flags',                           'r', 'authenticated', 'DELETE,INSERT,SELECT,UPDATE'),
      ('feature_flags',                           'r', 'service_role',  'DELETE,INSERT,MAINTAIN,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE'),
      ('hr_advance_repayments',                   'r', 'authenticated', 'DELETE,INSERT,SELECT,UPDATE'),
      ('hr_advance_repayments',                   'r', 'service_role',  'DELETE,INSERT,MAINTAIN,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE'),
      ('hr_advances',                             'r', 'authenticated', 'DELETE,INSERT,SELECT,UPDATE'),
      ('hr_advances',                             'r', 'service_role',  'DELETE,INSERT,MAINTAIN,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE'),
      ('hr_attendance',                           'r', 'authenticated', 'DELETE,INSERT,SELECT,UPDATE'),
      ('hr_attendance',                           'r', 'service_role',  'DELETE,INSERT,MAINTAIN,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE'),
      ('hr_employees',                            'r', 'authenticated', 'DELETE,INSERT,SELECT,UPDATE'),
      ('hr_employees',                            'r', 'service_role',  'DELETE,INSERT,MAINTAIN,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE'),
      ('hr_festival_allowances',                  'r', 'authenticated', 'DELETE,INSERT,SELECT,UPDATE'),
      ('hr_festival_allowances',                  'r', 'service_role',  'DELETE,INSERT,MAINTAIN,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE'),
      ('hr_final_settlements',                    'r', 'authenticated', 'DELETE,INSERT,SELECT,UPDATE'),
      ('hr_final_settlements',                    'r', 'service_role',  'DELETE,INSERT,MAINTAIN,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE'),
      ('hr_holiday_calendar',                     'r', 'authenticated', 'DELETE,INSERT,SELECT,UPDATE'),
      ('hr_holiday_calendar',                     'r', 'service_role',  'DELETE,INSERT,MAINTAIN,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE'),
      ('hr_incentive_configs',                    'r', 'authenticated', 'DELETE,INSERT,SELECT,UPDATE'),
      ('hr_incentive_configs',                    'r', 'service_role',  'DELETE,INSERT,MAINTAIN,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE'),
      ('hr_incentives',                           'r', 'authenticated', 'DELETE,INSERT,SELECT,UPDATE'),
      ('hr_incentives',                           'r', 'service_role',  'DELETE,INSERT,MAINTAIN,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE'),
      ('hr_leave_requests',                       'r', 'authenticated', 'DELETE,INSERT,SELECT,UPDATE'),
      ('hr_leave_requests',                       'r', 'service_role',  'DELETE,INSERT,MAINTAIN,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE'),
      ('hr_leave_types',                          'r', 'authenticated', 'DELETE,INSERT,SELECT,UPDATE'),
      ('hr_leave_types',                          'r', 'service_role',  'DELETE,INSERT,MAINTAIN,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE'),
      ('hr_overtime_entries',                     'r', 'authenticated', 'DELETE,INSERT,SELECT,UPDATE'),
      ('hr_overtime_entries',                     'r', 'service_role',  'DELETE,INSERT,MAINTAIN,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE'),
      ('hr_payroll_runs',                         'r', 'authenticated', 'DELETE,INSERT,SELECT,UPDATE'),
      ('hr_payroll_runs',                         'r', 'service_role',  'DELETE,INSERT,MAINTAIN,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE'),
      ('hr_payslips',                             'r', 'authenticated', 'DELETE,INSERT,SELECT,UPDATE'),
      ('hr_payslips',                             'r', 'service_role',  'DELETE,INSERT,MAINTAIN,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE'),
      ('hr_roster',                               'r', 'authenticated', 'DELETE,INSERT,SELECT,UPDATE'),
      ('hr_roster',                               'r', 'service_role',  'DELETE,INSERT,MAINTAIN,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE'),
      ('hr_roster_publish_state',                 'r', 'authenticated', 'DELETE,INSERT,SELECT,UPDATE'),
      ('hr_roster_publish_state',                 'r', 'service_role',  'DELETE,INSERT,MAINTAIN,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE'),
      ('hr_salary_components',                    'r', 'authenticated', 'DELETE,INSERT,SELECT,UPDATE'),
      ('hr_salary_components',                    'r', 'service_role',  'DELETE,INSERT,MAINTAIN,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE'),
      ('hr_salary_payments',                      'r', 'authenticated', 'DELETE,INSERT,SELECT,UPDATE'),
      ('hr_salary_payments',                      'r', 'service_role',  'DELETE,INSERT,MAINTAIN,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE'),
      ('hr_shift_swap_requests',                  'r', 'authenticated', 'DELETE,INSERT,SELECT,UPDATE'),
      ('hr_shift_swap_requests',                  'r', 'service_role',  'DELETE,INSERT,MAINTAIN,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE'),
      ('hr_shift_types',                          'r', 'authenticated', 'DELETE,INSERT,SELECT,UPDATE'),
      ('hr_shift_types',                          'r', 'service_role',  'DELETE,INSERT,MAINTAIN,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE'),
      ('hr_tada_claim_items',                     'r', 'authenticated', 'DELETE,INSERT,SELECT,UPDATE'),
      ('hr_tada_claim_items',                     'r', 'service_role',  'DELETE,INSERT,MAINTAIN,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE'),
      ('hr_tada_claims',                          'r', 'authenticated', 'DELETE,INSERT,SELECT,UPDATE'),
      ('hr_tada_claims',                          'r', 'service_role',  'DELETE,INSERT,MAINTAIN,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE'),
      ('ims_count_assignments',                   'r', 'authenticated', 'DELETE,INSERT,SELECT,UPDATE'),
      ('ims_count_assignments',                   'r', 'service_role',  'DELETE,INSERT,MAINTAIN,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE'),
      ('ims_gate_passes',                         'r', 'authenticated', 'INSERT,SELECT,UPDATE'),
      ('ims_gate_passes',                         'r', 'service_role',  'DELETE,INSERT,MAINTAIN,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE'),
      ('ims_stock_transfer_lines',                'r', 'authenticated', 'INSERT,SELECT'),
      ('ims_stock_transfer_lines',                'r', 'service_role',  'DELETE,INSERT,MAINTAIN,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE'),
      ('ims_stock_transfers',                     'r', 'authenticated', 'INSERT,SELECT'),
      ('ims_stock_transfers',                     'r', 'service_role',  'DELETE,INSERT,MAINTAIN,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE'),
      ('inventory_summary',                       'v', 'authenticated', 'DELETE,INSERT,SELECT,UPDATE'),
      ('inventory_summary',                       'v', 'service_role',  'DELETE,INSERT,MAINTAIN,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE'),
      ('items',                                   'r', 'authenticated', 'DELETE,INSERT,SELECT,UPDATE'),
      ('items',                                   'r', 'service_role',  'DELETE,INSERT,MAINTAIN,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE'),
      ('legal_acceptances',                       'r', 'authenticated', 'SELECT'),
      ('legal_acceptances',                       'r', 'service_role',  'DELETE,INSERT,MAINTAIN,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE'),
      ('monthly_owner_reports',                   'r', 'authenticated', 'INSERT,SELECT,UPDATE'),
      ('monthly_owner_reports',                   'r', 'service_role',  'DELETE,INSERT,MAINTAIN,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE'),
      ('monthly_periods',                         'r', 'authenticated', 'DELETE,INSERT,SELECT,UPDATE'),
      ('monthly_periods',                         'r', 'service_role',  'DELETE,INSERT,MAINTAIN,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE'),
      ('onboarding_progress',                     'r', 'authenticated', 'DELETE,INSERT,SELECT,UPDATE'),
      ('onboarding_progress',                     'r', 'service_role',  'DELETE,INSERT,MAINTAIN,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE'),
      ('opening_stock',                           'r', 'authenticated', 'DELETE,INSERT,SELECT,UPDATE'),
      ('opening_stock',                           'r', 'service_role',  'DELETE,INSERT,MAINTAIN,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE'),
      ('overheads',                               'r', 'authenticated', 'DELETE,INSERT,SELECT,UPDATE'),
      ('overheads',                               'r', 'service_role',  'DELETE,INSERT,MAINTAIN,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE'),
      ('par_levels',                              'r', 'authenticated', 'DELETE,INSERT,SELECT,UPDATE'),
      ('par_levels',                              'r', 'service_role',  'DELETE,INSERT,MAINTAIN,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE'),
      ('payable_payments',                        'r', 'authenticated', 'DELETE,INSERT,SELECT,UPDATE'),
      ('payable_payments',                        'r', 'service_role',  'DELETE,INSERT,MAINTAIN,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE'),
      ('pos_booking_deposits',                    'r', 'authenticated', 'INSERT,SELECT'),
      ('pos_booking_deposits',                    'r', 'service_role',  'DELETE,INSERT,MAINTAIN,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE'),
      ('pos_cash_movements',                      'r', 'authenticated', 'DELETE,INSERT,SELECT,UPDATE'),
      ('pos_cash_movements',                      'r', 'service_role',  'DELETE,INSERT,MAINTAIN,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE'),
      ('pos_combo_groups',                        'r', 'authenticated', 'DELETE,INSERT,SELECT,UPDATE'),
      ('pos_combo_groups',                        'r', 'service_role',  'DELETE,INSERT,MAINTAIN,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE'),
      ('pos_combo_items',                         'r', 'authenticated', 'DELETE,INSERT,SELECT,UPDATE'),
      ('pos_combo_items',                         'r', 'service_role',  'DELETE,INSERT,MAINTAIN,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE'),
      ('pos_combos',                              'r', 'authenticated', 'DELETE,INSERT,SELECT,UPDATE'),
      ('pos_combos',                              'r', 'service_role',  'DELETE,INSERT,MAINTAIN,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE'),
      ('pos_credit_notes',                        'r', 'authenticated', 'DELETE,INSERT,SELECT,UPDATE'),
      ('pos_credit_notes',                        'r', 'service_role',  'DELETE,INSERT,MAINTAIN,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE'),
      ('pos_credit_receipt_lines',                'r', 'authenticated', 'INSERT,SELECT'),
      ('pos_credit_receipt_lines',                'r', 'service_role',  'DELETE,INSERT,MAINTAIN,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE'),
      ('pos_credit_receipts',                     'r', 'authenticated', 'INSERT,SELECT,UPDATE'),
      ('pos_credit_receipts',                     'r', 'service_role',  'DELETE,INSERT,MAINTAIN,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE'),
      ('pos_customers',                           'r', 'authenticated', 'DELETE,INSERT,SELECT,UPDATE'),
      ('pos_customers',                           'r', 'service_role',  'DELETE,INSERT,MAINTAIN,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE'),
      ('pos_device_sessions',                     'r', 'service_role',  'DELETE,INSERT,MAINTAIN,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE'),
      ('pos_devices',                             'r', 'service_role',  'DELETE,INSERT,MAINTAIN,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE'),
      ('pos_guest_order_requests',                'r', 'authenticated', 'SELECT,UPDATE'),
      ('pos_guest_order_requests',                'r', 'service_role',  'DELETE,INSERT,MAINTAIN,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE'),
      ('pos_kot_log',                             'r', 'authenticated', 'INSERT,SELECT,UPDATE'),
      ('pos_kot_log',                             'r', 'service_role',  'DELETE,INSERT,MAINTAIN,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE'),
      ('pos_kot_removals',                        'r', 'authenticated', 'INSERT,SELECT'),
      ('pos_kot_removals',                        'r', 'service_role',  'DELETE,INSERT,MAINTAIN,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE'),
      ('pos_loyalty_ledger',                      'r', 'authenticated', 'INSERT,SELECT'),
      ('pos_loyalty_ledger',                      'r', 'service_role',  'DELETE,INSERT,MAINTAIN,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE'),
      ('pos_loyalty_schemes',                     'r', 'authenticated', 'DELETE,INSERT,SELECT,UPDATE'),
      ('pos_loyalty_schemes',                     'r', 'service_role',  'DELETE,INSERT,MAINTAIN,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE'),
      ('pos_membership_types',                    'r', 'authenticated', 'DELETE,INSERT,SELECT,UPDATE'),
      ('pos_membership_types',                    'r', 'service_role',  'DELETE,INSERT,MAINTAIN,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE'),
      ('pos_option_groups',                       'r', 'authenticated', 'DELETE,INSERT,SELECT,UPDATE'),
      ('pos_option_groups',                       'r', 'service_role',  'DELETE,INSERT,MAINTAIN,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE'),
      ('pos_option_ingredients',                  'r', 'authenticated', 'DELETE,INSERT,SELECT,UPDATE'),
      ('pos_option_ingredients',                  'r', 'service_role',  'DELETE,INSERT,MAINTAIN,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE'),
      ('pos_options',                             'r', 'authenticated', 'DELETE,INSERT,SELECT,UPDATE'),
      ('pos_options',                             'r', 'service_role',  'DELETE,INSERT,MAINTAIN,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE'),
      ('pos_order_item_options',                  'r', 'authenticated', 'DELETE,INSERT,SELECT,UPDATE'),
      ('pos_order_item_options',                  'r', 'service_role',  'DELETE,INSERT,MAINTAIN,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE'),
      ('pos_order_items',                         'r', 'authenticated', 'DELETE,INSERT,SELECT,UPDATE'),
      ('pos_order_items',                         'r', 'service_role',  'DELETE,INSERT,MAINTAIN,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE'),
      ('pos_order_payments',                      'r', 'authenticated', 'DELETE,INSERT,SELECT,UPDATE'),
      ('pos_order_payments',                      'r', 'service_role',  'DELETE,INSERT,MAINTAIN,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE'),
      ('pos_orders',                              'r', 'authenticated', 'DELETE,INSERT,SELECT,UPDATE'),
      ('pos_orders',                              'r', 'service_role',  'DELETE,INSERT,MAINTAIN,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE'),
      ('pos_parking_slips',                       'r', 'authenticated', 'INSERT,SELECT,UPDATE'),
      ('pos_parking_slips',                       'r', 'service_role',  'DELETE,INSERT,MAINTAIN,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE'),
      ('pos_payment_confirmations',               'r', 'authenticated', 'SELECT,UPDATE'),
      ('pos_payment_confirmations',               'r', 'service_role',  'DELETE,INSERT,MAINTAIN,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE'),
      ('pos_print_devices',                       'r', 'service_role',  'DELETE,INSERT,MAINTAIN,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE'),
      ('pos_print_jobs',                          'r', 'service_role',  'DELETE,INSERT,MAINTAIN,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE'),
      ('pos_print_pair_attempts',                 'r', 'service_role',  'DELETE,INSERT,MAINTAIN,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE'),
      ('pos_recipe_option_groups',                'r', 'authenticated', 'DELETE,INSERT,SELECT,UPDATE'),
      ('pos_recipe_option_groups',                'r', 'service_role',  'DELETE,INSERT,MAINTAIN,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE'),
      ('pos_reservation_request_attempts',        'r', 'service_role',  'DELETE,INSERT,MAINTAIN,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE'),
      ('pos_reservation_request_attempts_id_seq', 'S', 'service_role',  'SELECT,USAGE'),
      ('pos_reservation_tables',                  'r', 'authenticated', 'DELETE,INSERT,SELECT,UPDATE'),
      ('pos_reservation_tables',                  'r', 'service_role',  'DELETE,INSERT,MAINTAIN,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE'),
      ('pos_reservations',                        'r', 'authenticated', 'DELETE,INSERT,SELECT,UPDATE'),
      ('pos_reservations',                        'r', 'service_role',  'DELETE,INSERT,MAINTAIN,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE'),
      ('pos_shifts',                              'r', 'authenticated', 'DELETE,INSERT,SELECT,UPDATE'),
      ('pos_shifts',                              'r', 'service_role',  'DELETE,INSERT,MAINTAIN,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE'),
      ('pos_table_joins',                         'r', 'authenticated', 'INSERT,SELECT'),
      ('pos_table_joins',                         'r', 'service_role',  'DELETE,INSERT,MAINTAIN,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE'),
      ('pos_table_moves',                         'r', 'authenticated', 'INSERT,SELECT'),
      ('pos_table_moves',                         'r', 'service_role',  'DELETE,INSERT,MAINTAIN,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE'),
      ('pos_tables',                              'r', 'authenticated', 'DELETE,INSERT,SELECT,UPDATE'),
      ('pos_tables',                              'r', 'service_role',  'DELETE,INSERT,MAINTAIN,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE'),
      ('pos_waitlist',                            'r', 'authenticated', 'INSERT,SELECT,UPDATE'),
      ('pos_waitlist',                            'r', 'service_role',  'DELETE,INSERT,MAINTAIN,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE'),
      ('profile_employee_links',                  'r', 'authenticated', 'SELECT'),
      ('profile_employee_links',                  'r', 'service_role',  'DELETE,INSERT,MAINTAIN,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE'),
      ('profile_outlet_access',                   'r', 'authenticated', 'SELECT'),
      ('profile_outlet_access',                   'r', 'service_role',  'DELETE,INSERT,MAINTAIN,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE'),
      ('profiles',                                'r', 'authenticated', 'DELETE,INSERT,SELECT,UPDATE'),
      ('profiles',                                'r', 'service_role',  'DELETE,INSERT,MAINTAIN,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE'),
      ('purchase_entries',                        'r', 'authenticated', 'DELETE,INSERT,SELECT,UPDATE'),
      ('purchase_entries',                        'r', 'service_role',  'DELETE,INSERT,MAINTAIN,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE'),
      ('purchase_order_items',                    'r', 'authenticated', 'DELETE,INSERT,SELECT,UPDATE'),
      ('purchase_order_items',                    'r', 'service_role',  'DELETE,INSERT,MAINTAIN,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE'),
      ('purchase_orders',                         'r', 'authenticated', 'DELETE,INSERT,SELECT,UPDATE'),
      ('purchase_orders',                         'r', 'service_role',  'DELETE,INSERT,MAINTAIN,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE'),
      ('push_subscriptions',                      'r', 'authenticated', 'DELETE,INSERT,SELECT,UPDATE'),
      ('push_subscriptions',                      'r', 'service_role',  'DELETE,INSERT,MAINTAIN,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE'),
      ('recipe_ingredients',                      'r', 'authenticated', 'DELETE,INSERT,SELECT,UPDATE'),
      ('recipe_ingredients',                      'r', 'service_role',  'DELETE,INSERT,MAINTAIN,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE'),
      ('recipe_suggestions',                      'r', 'authenticated', 'DELETE,INSERT,SELECT,UPDATE'),
      ('recipe_suggestions',                      'r', 'service_role',  'DELETE,INSERT,MAINTAIN,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE'),
      ('recipes',                                 'r', 'authenticated', 'DELETE,INSERT,SELECT,UPDATE'),
      ('recipes',                                 'r', 'service_role',  'DELETE,INSERT,MAINTAIN,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE'),
      ('requisition_lines',                       'r', 'authenticated', 'DELETE,INSERT,SELECT,UPDATE'),
      ('requisition_lines',                       'r', 'service_role',  'DELETE,INSERT,MAINTAIN,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE'),
      ('requisitions',                            'r', 'authenticated', 'DELETE,INSERT,SELECT,UPDATE'),
      ('requisitions',                            'r', 'service_role',  'DELETE,INSERT,MAINTAIN,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE'),
      ('sales_entries',                           'r', 'authenticated', 'DELETE,INSERT,SELECT,UPDATE'),
      ('sales_entries',                           'r', 'service_role',  'DELETE,INSERT,MAINTAIN,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE'),
      ('settings',                                'r', 'anon',          'SELECT'),
      ('settings',                                'r', 'authenticated', 'DELETE,INSERT,SELECT,UPDATE'),
      ('settings',                                'r', 'service_role',  'DELETE,INSERT,MAINTAIN,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE'),
      ('staff_meals',                             'r', 'authenticated', 'DELETE,INSERT,SELECT,UPDATE'),
      ('staff_meals',                             'r', 'service_role',  'DELETE,INSERT,MAINTAIN,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE'),
      ('staff_pin_vault',                         'r', 'authenticated', 'DELETE,INSERT,SELECT,UPDATE'),
      ('staff_pin_vault',                         'r', 'service_role',  'DELETE,INSERT,MAINTAIN,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE'),
      ('stock_movements',                         'r', 'authenticated', 'DELETE,INSERT,SELECT,UPDATE'),
      ('stock_movements',                         'r', 'service_role',  'DELETE,INSERT,MAINTAIN,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE'),
      ('trial_purge_log',                         'r', 'authenticated', 'SELECT'),
      ('trial_purge_log',                         'r', 'service_role',  'DELETE,INSERT,MAINTAIN,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE'),
      ('trial_purge_log_id_seq',                  'S', 'service_role',  'SELECT,USAGE'),
      ('trial_signup_attempts',                   'r', 'service_role',  'DELETE,INSERT,MAINTAIN,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE'),
      ('trial_signup_attempts_id_seq',            'S', 'service_role',  'SELECT,USAGE'),
      ('vendor_returns',                          'r', 'authenticated', 'DELETE,INSERT,SELECT,UPDATE'),
      ('vendor_returns',                          'r', 'service_role',  'DELETE,INSERT,MAINTAIN,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE'),
      ('vendors',                                 'r', 'authenticated', 'DELETE,INSERT,SELECT,UPDATE'),
      ('vendors',                                 'r', 'service_role',  'DELETE,INSERT,MAINTAIN,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE'),
      ('wastages',                                'r', 'authenticated', 'DELETE,INSERT,SELECT,UPDATE'),
      ('wastages',                                'r', 'service_role',  'DELETE,INSERT,MAINTAIN,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE'),
      ('weather_daily',                           'r', 'service_role',  'DELETE,INSERT,MAINTAIN,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE'),
      ('weather_locations',                       'r', 'service_role',  'DELETE,INSERT,MAINTAIN,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE')
    ) AS t(obj, kind, grantee, privs)
  LOOP
    rel := to_regclass(format('public.%I', g.obj));
    IF rel IS NULL THEN
      missing := array_append(missing, g.obj);
      CONTINUE;
    END IF;

    IF g.kind = 'S' THEN
      EXECUTE format('GRANT %s ON SEQUENCE public.%I TO %I', replace(g.privs, ',', ', '), g.obj, g.grantee);
    ELSE
      EXECUTE format('GRANT %s ON TABLE public.%I TO %I', replace(g.privs, ',', ', '), g.obj, g.grantee);
    END IF;

    -- Self-check: read each privilege back rather than trusting the GRANT.
    FOREACH p IN ARRAY string_to_array(g.privs, ',') LOOP
      IF NOT COALESCE(CASE WHEN g.kind = 'S'
                           THEN has_sequence_privilege(g.grantee, rel, p)
                           ELSE has_table_privilege(g.grantee, rel, p) END, false) THEN
        failed := array_append(failed, format('%s %s %s', g.obj, g.grantee, p));
      END IF;
    END LOOP;
  END LOOP;

  IF cardinality(missing) > 0 THEN
    RAISE NOTICE 'S860: % object(s) not in this database, skipped: %',
      cardinality(missing), array_to_string(ARRAY(SELECT DISTINCT unnest(missing) ORDER BY 1), ', ');
  END IF;
  IF cardinality(failed) > 0 THEN
    RAISE EXCEPTION 'S860: % grant(s) did not take: %', cardinality(failed), array_to_string(failed, '; ');
  END IF;
END
$$;

NOTIFY pgrst, 'reload schema';
