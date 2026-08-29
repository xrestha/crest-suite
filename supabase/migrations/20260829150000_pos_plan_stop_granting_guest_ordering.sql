-- ════════════════════════════════════════════════════════════════════════════════════════════
-- `pos_plan` is not vestigial, and has been silently granting a Pro feature since 2026-07-07.
--
-- S548 retired `hr_plan`/`pos_plan` as plan-raisers and CLAUDE.md has said ever since that they
-- are "no longer read or written anywhere". That was only ever true of the frontend. S548 swept
-- JS and never touched SQL, where two functions still gate Guest QR Ordering on it:
--
--     submit_guest_order:  IF NOT (v_guest_ordering_flag OR v_pos_plan = 'pro') THEN RAISE ...
--     get_guest_menu:      v_guest_ordering_enabled := v_guest_ordering_flag OR (v_pos_plan = 'pro');
--
-- So a client carrying a stale `pos_plan = 'pro'` has had guest ordering without the
-- `guest_ordering` flag: off a column nothing writes, no admin screen displays, and no MRR
-- figure prices. That is the exact plan-raiser shape S548 and S574 existed to remove -- the same
-- reason `is_premium` was retired, one axis over.
--
-- ── The sweep runs FIRST, and it grants rather than revokes ─────────────────────────────────
-- CLAUDE.md's rule is that moving a feature between tiers needs a grandfather sweep in the same
-- deploy, and S574's precedent is to fold the raiser into an explicit column so that no
-- entitlement changes. Same here: every client currently relying on the `pos_plan` clause gets
-- `feature_flags.guest_ordering = true` written **before** the clause is removed, so nobody is
-- without access at any instant and no live guest menu goes dark mid-transaction.
--
-- The point is not to keep giving the feature away -- it is that the grant becomes VISIBLE.
-- Afterwards it is an ordinary flag on Admin -> Feature Access, which an operator can see and
-- revoke deliberately, priced or not. An invisible grant cannot be revoked because nobody knows
-- it exists. The final SELECT below reports exactly who was touched; revoking one afterwards is
-- a single flag toggle on that screen.
--
-- `false` in feature_flags is inert, not a revoke (hasFeature only tests === true), so the sweep
-- must write true and never rely on an existing false meaning anything.
-- ════════════════════════════════════════════════════════════════════════════════════════════

BEGIN;

-- ── 1. Grandfather, before anything else changes ────────────────────────────────────────────
-- Which clients the sweep actually touches has to be captured as it runs. Deriving it afterwards
-- from `pos_plan = 'pro'` would be wrong in the direction that matters: once the sweep completes,
-- a client who BOUGHT guest ordering is indistinguishable from one who was riding the implicit
-- grant, and the report would accuse both.
CREATE TEMP TABLE _pos_plan_sweep (client_id uuid PRIMARY KEY) ON COMMIT PRESERVE ROWS;

DO $sweep$
DECLARE
  r RECORD;
  n integer := 0;
BEGIN
  FOR r IN
    SELECT c.id, c.name
    FROM clients c
    LEFT JOIN feature_flags f ON f.client_id = c.id
    WHERE c.pos_plan = 'pro'
      AND COALESCE(f.guest_ordering, false) IS DISTINCT FROM true
  LOOP
    INSERT INTO feature_flags (client_id, guest_ordering)
    VALUES (r.id, true)
    ON CONFLICT (client_id) DO UPDATE SET guest_ordering = true;
    INSERT INTO _pos_plan_sweep (client_id) VALUES (r.id);
    RAISE NOTICE 'grandfathered guest_ordering: % (%)', r.name, r.id;
    n := n + 1;
  END LOOP;
  RAISE NOTICE 'pos_plan sweep: % client(s) were relying on the implicit grant', n;
END
$sweep$;

-- ── 2. Remove the clause from both readers ──────────────────────────────────────────────────
-- Bodies below are the current deployed definitions with three surgical edits each: the
-- v_pos_plan declaration dropped, pos_plan removed from the clients SELECT, and the OR clause
-- removed. Nothing else differs -- verified by diffing against the extracted originals.
--
-- get_guest_menu is CREATE **OR REPLACE** deliberately. Its previous migration used DROP +
-- CREATE because it changed the output columns, and had to re-issue the grant afterwards since
-- DROP discards them. Only the body changes here, so replacing in place keeps anon's EXECUTE
-- intact -- asserted below rather than assumed.

CREATE OR REPLACE FUNCTION public.submit_guest_order(
    p_table_id uuid, p_items jsonb, p_notes text DEFAULT NULL, p_covers integer DEFAULT 1
) RETURNS uuid
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  v_client_id uuid;
  v_pos_enabled boolean;
  v_guest_ordering_flag boolean;
  v_request_id uuid;
  v_snapshot jsonb := '[]'::jsonb;
  r RECORD;
  item RECORD;
  v_qty numeric;
  v_note text;
BEGIN
  SELECT t.client_id INTO v_client_id FROM pos_tables t WHERE t.id = p_table_id;
  IF v_client_id IS NULL THEN RAISE EXCEPTION 'Table not found'; END IF;

  SELECT c.pos_enabled INTO v_pos_enabled FROM clients c WHERE c.id = v_client_id;
  IF NOT COALESCE(v_pos_enabled, false) THEN RAISE EXCEPTION 'POS not enabled for this restaurant'; END IF;

  SELECT COALESCE(f.guest_ordering, false) INTO v_guest_ordering_flag FROM feature_flags f WHERE f.client_id = v_client_id;
  IF NOT v_guest_ordering_flag THEN
    RAISE EXCEPTION 'Guest ordering is not enabled for this restaurant';
  END IF;

  IF p_items IS NULL OR jsonb_array_length(p_items) = 0 THEN RAISE EXCEPTION 'Order is empty'; END IF;
  IF jsonb_array_length(p_items) > 30 THEN RAISE EXCEPTION 'Too many items in one order'; END IF;

  FOR item IN SELECT * FROM jsonb_to_recordset(p_items) AS x(recipe_id uuid, qty numeric, note text)
  LOOP
    IF item.recipe_id IS NULL THEN CONTINUE; END IF;
    v_qty := LEAST(GREATEST(COALESCE(item.qty, 0), 0), 50);
    IF v_qty <= 0 THEN CONTINUE; END IF;
    v_note := NULLIF(left(COALESCE(item.note, ''), 200), '');

    SELECT rc.id, rc.name, rc.category, rc.selling_price, rc.vat_rate INTO r
    FROM recipes rc
    WHERE rc.id = item.recipe_id AND rc.client_id = v_client_id AND rc.is_active = true
      AND rc.pos_enabled = true AND rc.category IS DISTINCT FROM 'Sub-Recipe';
    IF r.id IS NULL THEN CONTINUE; END IF;

    v_snapshot := v_snapshot || jsonb_build_object(
      'recipe_id', r.id, 'name', r.name, 'category', r.category,
      'unit_price', r.selling_price, 'vat_rate', r.vat_rate,
      'qty', v_qty, 'note', v_note
    );
  END LOOP;

  IF jsonb_array_length(v_snapshot) = 0 THEN RAISE EXCEPTION 'No valid items in order'; END IF;

  BEGIN
    INSERT INTO pos_guest_order_requests (client_id, table_id, items, guest_notes, covers)
    VALUES (
      v_client_id, p_table_id, v_snapshot, NULLIF(left(COALESCE(p_notes, ''), 500), ''),
      LEAST(GREATEST(COALESCE(p_covers, 1), 1), 50)
    )
    RETURNING id INTO v_request_id;
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION 'This table already has an order request waiting for staff — please wait for it to be reviewed before sending another.';
  END;

  RETURN v_request_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.get_guest_menu(p_table_id uuid) RETURNS TABLE(
    outlet_name text, table_name text,
    recipe_id uuid, name text, category text, selling_price numeric, vat_rate numeric,
    description text, image_url text, is_veg boolean,
    nutrition_enabled boolean, has_nutrition boolean,
    energy_kcal numeric, protein_g numeric, carbs_g numeric, fat_g numeric, sugar_g numeric, sodium_mg numeric,
    allergens jsonb, guest_ordering_enabled boolean,
    is_vat_registered boolean
) LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  v_client_id uuid;
  v_table_name text;
  v_outlet_name text;
  v_pos_enabled boolean;
  v_nutrition_enabled boolean;
  v_guest_ordering_flag boolean;
  v_guest_ordering_enabled boolean;
  v_vat_registered boolean;
  r RECORD;
  roll jsonb;
BEGIN
  SELECT t.client_id, t.name INTO v_client_id, v_table_name FROM pos_tables t WHERE t.id = p_table_id;
  IF v_client_id IS NULL THEN RETURN; END IF;

  SELECT c.name, c.pos_enabled INTO v_outlet_name, v_pos_enabled FROM clients c WHERE c.id = v_client_id;
  IF NOT COALESCE(v_pos_enabled, false) THEN RETURN; END IF;

  SELECT COALESCE(f.nutrition_facts, false), COALESCE(f.guest_ordering, false)
    INTO v_nutrition_enabled, v_guest_ordering_flag
  FROM feature_flags f WHERE f.client_id = v_client_id;

  -- Fails OPEN to true: no settings row means the client has never been configured either way,
  -- and true is what the column defaults to and what every JS caller assumes.
  SELECT COALESCE(s.is_vat_registered, true) INTO v_vat_registered
  FROM settings s WHERE s.client_id = v_client_id;
  v_vat_registered := COALESCE(v_vat_registered, true);

  v_guest_ordering_enabled := v_guest_ordering_flag;

  FOR r IN
    SELECT rc.id, rc.name, rc.category, rc.selling_price, rc.vat_rate, rc.description, rc.image_url, rc.is_veg
    FROM recipes rc
    WHERE rc.client_id = v_client_id AND rc.is_active = true AND rc.pos_enabled = true
      AND rc.category IS DISTINCT FROM 'Sub-Recipe'
    ORDER BY rc.category NULLS LAST, rc.name
  LOOP
    IF v_nutrition_enabled THEN
      roll := public._nutrition_rollup(r.id);
    ELSE
      roll := NULL;
    END IF;

    outlet_name := v_outlet_name;
    table_name := v_table_name;
    recipe_id := r.id;
    name := r.name;
    category := r.category;
    selling_price := r.selling_price;
    vat_rate := r.vat_rate;
    description := r.description;
    image_url := r.image_url;
    is_veg := r.is_veg;
    nutrition_enabled := v_nutrition_enabled;
    has_nutrition := v_nutrition_enabled AND COALESCE((roll->>'covered')::boolean, false);
    energy_kcal := (roll->>'energy_kcal')::numeric;
    protein_g := (roll->>'protein_g')::numeric;
    carbs_g := (roll->>'carbs_g')::numeric;
    fat_g := (roll->>'fat_g')::numeric;
    sugar_g := (roll->>'sugar_g')::numeric;
    sodium_mg := (roll->>'sodium_mg')::numeric;
    allergens := COALESCE(roll->'allergens', '[]'::jsonb);
    guest_ordering_enabled := v_guest_ordering_enabled;
    is_vat_registered := v_vat_registered;
    RETURN NEXT;
  END LOOP;
END;
$$;

-- ── 3. Assertions ───────────────────────────────────────────────────────────────────────────
DO $guard$
DECLARE
  v_left integer;
BEGIN
  -- 3a. Nobody lost access. Every client that had the implicit grant now holds the explicit one.
  SELECT count(*) INTO v_left
  FROM clients c
  LEFT JOIN feature_flags f ON f.client_id = c.id
  WHERE c.pos_plan = 'pro'
    AND COALESCE(f.guest_ordering, false) IS DISTINCT FROM true;
  IF v_left > 0 THEN
    RAISE EXCEPTION 'sweep incomplete: % client(s) with pos_plan = pro still lack guest_ordering', v_left;
  END IF;

  -- 3b. The deployed bodies really no longer read pos_plan. Read back what is actually installed
  -- rather than trusting that CREATE OR REPLACE did what the file above says -- same discipline
  -- S518 used on log_audit().
  IF pg_get_functiondef('public.submit_guest_order(uuid, jsonb, text, integer)'::regprocedure) LIKE '%pos_plan%' THEN
    RAISE EXCEPTION 'submit_guest_order still references pos_plan';
  END IF;
  IF pg_get_functiondef('public.get_guest_menu(uuid)'::regprocedure) LIKE '%pos_plan%' THEN
    RAISE EXCEPTION 'get_guest_menu still references pos_plan';
  END IF;

  -- 3c. The guest surface is anonymous by design, so losing these grants takes every QR menu
  -- offline. CREATE OR REPLACE preserves them and DROP would not; assert rather than assume.
  IF NOT has_function_privilege('anon', 'public.get_guest_menu(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'anon lost EXECUTE on get_guest_menu -- every guest QR menu would be dead';
  END IF;
  IF NOT has_function_privilege('anon', 'public.submit_guest_order(uuid, jsonb, text, integer)', 'EXECUTE') THEN
    RAISE EXCEPTION 'anon lost EXECUTE on submit_guest_order -- guests could not place orders';
  END IF;
END
$guard$;

COMMIT;

NOTIFY pgrst, 'reload schema';

-- ── The report ──────────────────────────────────────────────────────────────────────────────
-- Who was carrying a pos_plan, and what their guest ordering now rests on.
--
-- `grandfathered_now = true` is the row that matters: that client had Guest QR Ordering without
-- anyone deciding to give it to them, and now holds an explicit flag instead. Revoking is one
-- toggle on Admin -> Feature Access -- a pricing decision, not a technical one. `false` means
-- they already held the flag on their own merits and nothing about them changed.
--
-- NO ROWS AT ALL is the good outcome: it means no client has a pos_plan, the clause was granting
-- nothing, and this migration changed no entitlement anywhere.
SELECT c.id, c.name, c.pos_plan, c.pos_enabled,
       COALESCE(f.guest_ordering, false)  AS guest_ordering_now,
       (s.client_id IS NOT NULL)          AS grandfathered_now
FROM clients c
LEFT JOIN feature_flags f    ON f.client_id = c.id
LEFT JOIN _pos_plan_sweep s  ON s.client_id = c.id
WHERE c.pos_plan IS NOT NULL
ORDER BY (s.client_id IS NOT NULL) DESC, c.name;

DROP TABLE IF EXISTS _pos_plan_sweep;
