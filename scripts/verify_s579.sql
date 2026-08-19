-- S579 verification — item-level comp enforced server-side.
-- Every row should read PASS. "Success. No rows returned" from the migration proves the statements
-- ran, not that they took effect; this proves the latter.

SELECT '1. trigger BEFORE INSERT OR UPDATE on pos_order_items' AS check,
       CASE WHEN t.tgtype & 2 = 2                        -- BEFORE
             AND t.tgtype & 4 = 4                        -- INSERT
             AND t.tgtype & 16 = 16                      -- UPDATE
            THEN 'PASS' ELSE 'FAIL' END AS result,
       t.tgname AS detail
  FROM pg_trigger t
 WHERE t.tgrelid = 'public.pos_order_items'::regclass
   AND t.tgname = 'guard_pos_item_comp'
UNION ALL
-- Under SECURITY DEFINER, current_user would be the owner on every call and the guard would never
-- fire — it would look installed and enforce nothing.
SELECT '2. guard_pos_item_comp is SECURITY INVOKER',
       CASE WHEN NOT p.prosecdef THEN 'PASS' ELSE 'FAIL — DEFINER means it never fires' END, p.proname
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname = 'public' AND p.proname = 'guard_pos_item_comp'
UNION ALL
-- The inverse: apply_pos_item_comps MUST stay SECURITY DEFINER, or the guard above blocks the one
-- legitimate write path and item-level comp stops working entirely.
SELECT '3. apply_pos_item_comps is still SECURITY DEFINER',
       CASE WHEN p.prosecdef THEN 'PASS' ELSE 'FAIL — the only legitimate comp path is now blocked' END,
       pg_get_function_identity_arguments(p.oid)
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname = 'public' AND p.proname = 'apply_pos_item_comps'
UNION ALL
-- Signature unchanged means the EXECUTE grant carried over and a stale bundle still binds.
SELECT '4. apply_pos_item_comps has exactly 1 signature, still granted',
       CASE WHEN count(*) = 1
             AND bool_and(has_function_privilege('authenticated', p.oid, 'EXECUTE'))
             AND NOT bool_or(has_function_privilege('anon', p.oid, 'EXECUTE'))
            THEN 'PASS' ELSE 'FAIL — ' || count(*) || ' overload(s), or wrong grants' END,
       string_agg(pg_get_function_identity_arguments(p.oid), ' | ')
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname = 'public' AND p.proname = 'apply_pos_item_comps'
UNION ALL
-- The rank check and the derived attribution both have to be present in the deployed body — read
-- it back rather than trusting that the migration you pasted is the one that ran.
SELECT '5. deployed body checks rank and derives comped_by',
       CASE WHEN pg_get_functiondef(p.oid) LIKE '%require Supervisor access or above%'
             AND pg_get_functiondef(p.oid) LIKE '%v_comped_by%'
             AND pg_get_functiondef(p.oid) NOT LIKE '%comped_by = p_comped_by%'
            THEN 'PASS' ELSE 'FAIL — old body still deployed' END,
       'read back with pg_get_functiondef, not assumed'
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname = 'public' AND p.proname = 'apply_pos_item_comps'
UNION ALL
-- Both NULL-guards present. Without them a caller with no profiles row, or with pos_role unset,
-- makes the condition NULL and `IF NOT NULL THEN` never fires — the check falls open for exactly
-- the caller it is least sure about.
SELECT '6. both authorisation checks are COALESCE-wrapped (no NULL fail-open)',
       CASE WHEN (length(pg_get_functiondef(p.oid))
                  - length(replace(pg_get_functiondef(p.oid), 'IF NOT COALESCE(', ''))) / 16 = 2
            THEN 'PASS' ELSE 'FAIL — a NULL condition would fall through' END,
       'client check + rank check'
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname = 'public' AND p.proname = 'apply_pos_item_comps';
