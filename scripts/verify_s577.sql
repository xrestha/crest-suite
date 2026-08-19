-- S577 verification. Every row returned should read PASS. Anything FAIL means the object exists
-- under the right name but not with the properties the fix depends on — the exact gap the
-- anon-revoke lesson (a REVOKE that reported success and changed nothing) exists to catch.

-- 1. The trigger is attached, and it is BEFORE UPDATE (an AFTER trigger cannot refuse a write).
SELECT '1. trigger BEFORE UPDATE on pos_orders' AS check,
       CASE WHEN t.tgtype & 2 = 2 AND t.tgtype & 16 = 16 THEN 'PASS' ELSE 'FAIL' END AS result,
       t.tgname
  FROM pg_trigger t
 WHERE t.tgrelid = 'public.pos_orders'::regclass
   AND t.tgname = 'guard_pos_order_close'
UNION ALL
-- 2. The guard is SECURITY INVOKER. Under DEFINER, current_user would be the owner every time and
--    the anon/authenticated check would never fire — i.e. the guard would silently allow everything.
SELECT '2. guard_pos_order_close is SECURITY INVOKER',
       CASE WHEN NOT p.prosecdef THEN 'PASS' ELSE 'FAIL — it is DEFINER, the guard never fires' END,
       p.proname
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname = 'public' AND p.proname = 'guard_pos_order_close'
UNION ALL
-- 3. EXACTLY ONE save_pos_order_items signature. Two would make every {p_order_id, p_rows} call
--    ambiguous ("function is not unique") and break saving on every device.
SELECT '3. save_pos_order_items has exactly 1 signature',
       CASE WHEN count(*) = 1 THEN 'PASS' ELSE 'FAIL — ' || count(*) || ' overloads, saves will 300' END,
       string_agg(pg_get_function_identity_arguments(p.oid), ' | ')
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname = 'public' AND p.proname = 'save_pos_order_items'
UNION ALL
-- 4. RLS is ON. A table with policies but RLS disabled is wide open and reads as configured.
SELECT '4. pos_kot_removals RLS enabled',
       CASE WHEN c.relrowsecurity THEN 'PASS' ELSE 'FAIL' END, c.relname
  FROM pg_class c WHERE c.oid = 'public.pos_kot_removals'::regclass
UNION ALL
-- 5. All four policies present (1 permissive + 3 restrictive staff-isolation).
SELECT '5. pos_kot_removals has 4 policies',
       CASE WHEN count(*) = 4 THEN 'PASS' ELSE 'FAIL — ' || count(*) END,
       string_agg(policyname, ', ' ORDER BY policyname)
  FROM pg_policies WHERE schemaname = 'public' AND tablename = 'pos_kot_removals'
UNION ALL
-- 6. authenticated may SELECT and INSERT but NOT update or delete. An audit record a till session
--    can rewrite is not an audit record.
SELECT '6. authenticated: SELECT+INSERT only on pos_kot_removals',
       CASE WHEN has_table_privilege('authenticated', 'public.pos_kot_removals', 'SELECT')
             AND has_table_privilege('authenticated', 'public.pos_kot_removals', 'INSERT')
             AND NOT has_table_privilege('authenticated', 'public.pos_kot_removals', 'UPDATE')
             AND NOT has_table_privilege('authenticated', 'public.pos_kot_removals', 'DELETE')
            THEN 'PASS' ELSE 'FAIL' END,
       'raw-SQL tables get no grants by default here'
UNION ALL
-- 7. The RPC is callable by a browser session, and NOT by anon (the per-signature grant trap: a
--    new arity is created carrying Postgres's default GRANT TO PUBLIC).
SELECT '7. save_pos_order_items: authenticated yes, anon no',
       CASE WHEN has_function_privilege('authenticated', 'public.save_pos_order_items(uuid, jsonb, text)', 'EXECUTE')
             AND NOT has_function_privilege('anon', 'public.save_pos_order_items(uuid, jsonb, text)', 'EXECUTE')
            THEN 'PASS' ELSE 'FAIL' END,
       'per-signature, not per-name'
UNION ALL
-- 8. Both indexes exist AND lead with the column the queries filter on — verify by leading column,
--    never by index name (CREATE INDEX IF NOT EXISTS reports success whether or not it did anything).
SELECT '8. pos_kot_removals indexes lead on order_id and client_id',
       CASE WHEN count(*) FILTER (WHERE a.attname = 'order_id')  > 0
             AND count(*) FILTER (WHERE a.attname = 'client_id') > 0
            THEN 'PASS' ELSE 'FAIL' END,
       string_agg(a.attname, ', ')
  FROM pg_index i
  JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = i.indkey[0]
 WHERE i.indrelid = 'public.pos_kot_removals'::regclass;
