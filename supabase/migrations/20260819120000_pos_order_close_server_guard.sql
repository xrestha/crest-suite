-- ════════════════════════════════════════════════════════════════════════════════════════════
-- S577 — the POS discount cap and the void permission were enforced ONLY in the browser.
--
-- `pos_orders_client` is a plain same-client `FOR ALL` policy, so a Staff-rank till JWT holds
-- UPDATE on every one of its own client's orders. Everything that decides whether a till operator
-- may void a bill or how much they may discount lived in PosOrders.jsx:
--
--   discountCapPct = (!isAdmin && !isOwner) ? profile?.pos_discount_limit : null
--   {(isAdmin || isOwner || profile?.pos_allow_void) && ( ...Void tab... )}
--
-- Both are React. A single PATCH to /rest/v1/pos_orders?id=eq.<uuid> with
-- {"close_type":"void","status":"voided"} or {"discount_amount":<anything>} walked straight past
-- them, from the same session the till already holds. This is privilege invariant #3 ("a lockout
-- the client calls around an operation is not a lockout") in its POS form — the same shape as the
-- PIN lockout that was fixed by moving the check inside pos-staff-login.
--
-- WHY A TRIGGER AND NOT THE `close_pos_order(...)` RPC THE PHASE-6 CRITIQUE PROPOSED.
-- An RPC only protects the callers that choose to use it; the open UPDATE policy that made the
-- bypass possible would still be there, so the fix would be one more thing the browser calls
-- rather than something the browser cannot avoid. A BEFORE UPDATE trigger is enforcement: it sees
-- every write to the table, through PostgREST or anywhere else, now and for any path added later.
-- This is exactly the reasoning already recorded in 20260810120000 for
-- guard_profiles_privileged_columns(), and the same seam is reused here — see below.
--
-- WHAT IS DELIBERATELY *NOT* ENFORCED HERE: `paid_amount`.
-- Re-deriving the bill total in SQL would mean a second copy of the VAT-on-discounted-base
-- arithmetic and the round-to-the-rupee rule that PosOrders.jsx owns — a second definition of a
-- figure the product is sold on, which is the exact failure this codebase keeps writing rules
-- against (imsFormulas.js, expectedCashOf). A drifted copy here would not misreport a number, it
-- would REJECT real bills mid-service. The two checks below are pure authorisation and need no
-- money formula: "may this account void" and "is this discount within the cap the manager set".
-- The subtotal the cap is measured against is a plain SUM(qty * unit_price) over the order's own
-- lines — no VAT, no rounding, no discount — which is byte-for-byte what `paySubEx` is.
-- ════════════════════════════════════════════════════════════════════════════════════════════

-- Deliberately SECURITY INVOKER (note the absence of SECURITY DEFINER), for the same reason
-- guard_profiles_privileged_columns() is: current_user is the seam that lets legitimate
-- privileged writers through, and under SECURITY DEFINER it would be the function owner every
-- time and the check would never fire.
--
--   'authenticated'/'anon'  a direct PostgREST write from a browser session  -> GUARDED
--   'service_role'          admin-user-ops (Danger Zone, client archive)     -> allowed
--   'postgres'              the body of any SECURITY DEFINER function        -> allowed
CREATE OR REPLACE FUNCTION public.guard_pos_order_close()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $$
DECLARE
  v_allow_void    boolean;
  v_discount_cap  numeric;
  v_subtotal      numeric;
  v_max_discount  numeric;
BEGIN
  IF current_user NOT IN ('anon', 'authenticated') THEN
    RETURN NEW;
  END IF;

  -- Only the close decision is guarded. Every other UPDATE on this table stays untouched, which
  -- matters more than it looks: closeOrder() stamps ims_posted_at AFTER the close in a second
  -- write, credit-note issuance sets credit_note_id, reprints bump print_count, and the offline
  -- queue replays covers. None of those change the three columns below, so none of them pay for
  -- this guard.
  IF NEW.close_type      IS NOT DISTINCT FROM OLD.close_type
     AND NEW.status      IS NOT DISTINCT FROM OLD.status
     AND NEW.discount_amount IS NOT DISTINCT FROM OLD.discount_amount THEN
    RETURN NEW;
  END IF;

  -- is_admin() returns NULL when the caller has no profile row; `IF NULL THEN` is not true, so an
  -- unknown caller falls through into the guard rather than past it.
  IF public.is_admin() THEN
    RETURN NEW;
  END IF;

  -- The Owner is the ABSENCE of staff markers (is_client_owner(), the third copy of the negative
  -- test alongside AuthContext.isOwner and admin-user-ops' isCallerOwner). An Owner has no cap
  -- and no void restriction, which is what the frontend already assumes.
  IF public.is_client_owner() THEN
    RETURN NEW;
  END IF;

  SELECT COALESCE(pos_allow_void, false), pos_discount_limit
    INTO v_allow_void, v_discount_cap
    FROM profiles
   WHERE id = (SELECT auth.uid());

  -- ── Void ───────────────────────────────────────────────────────────────────────────────────
  -- A void writes off a bill that was rung up and, for anything already fired, food that was
  -- prepared. pos_allow_void is the per-staff flag a manager sets on /pos/staff; NULL/false means
  -- no. Rank alone never grants it — a Supervisor is not automatically allowed to void, which is
  -- the same rule PosOrders.jsx applies to the tab's visibility.
  IF NEW.close_type = 'void' AND COALESCE(v_allow_void, false) = false THEN
    RAISE EXCEPTION
      'pos_orders: this account is not permitted to void a bill — ask a manager to enable Allow Void for it on POS Staff'
      USING ERRCODE = '42501';
  END IF;

  -- ── Discount cap ───────────────────────────────────────────────────────────────────────────
  -- NULL cap = unlimited, matching hasFeature()'s and pos_discount_limit's own convention.
  IF NEW.discount_amount IS NOT NULL AND NEW.discount_amount > 0 AND v_discount_cap IS NOT NULL THEN
    SELECT COALESCE(SUM(qty * unit_price), 0)
      INTO v_subtotal
      FROM pos_order_items
     WHERE order_id = NEW.id
       AND COALESCE(comped, false) = false;

    -- No stored lines means nothing to measure a percentage against. Refusing here would block a
    -- close on an order whose lines this transaction cannot see; the cap is a spending limit, not
    -- the last line of defence, so it declines to guess. closeOrder() persists the lines through
    -- save_pos_order_items before billing precisely so this branch is not the normal path.
    IF v_subtotal > 0 THEN
      -- +0.01 absorbs the float round-trip through JSON: the browser computes the cap as
      -- paySubEx * (cap/100) in IEEE754 and sends the result as text, so an at-the-cap discount
      -- can land a fraction of a paisa above the numeric computed here.
      v_max_discount := v_subtotal * (v_discount_cap / 100.0) + 0.01;
      IF NEW.discount_amount > v_max_discount THEN
        -- RAISE treats % as a placeholder, so a literal percent sign would have to be %% and
        -- reads badly next to one; the cap is spelled out in words instead.
        RAISE EXCEPTION
          'pos_orders: a discount of % exceeds this account''s cap (% percent of the % subtotal, i.e. at most %)',
          ROUND(NEW.discount_amount, 2), v_discount_cap,
          ROUND(v_subtotal, 2), ROUND(v_max_discount, 2)
          USING ERRCODE = '42501';
      END IF;
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS guard_pos_order_close ON public.pos_orders;
CREATE TRIGGER guard_pos_order_close
  BEFORE UPDATE ON public.pos_orders
  FOR EACH ROW
  EXECUTE FUNCTION public.guard_pos_order_close();

-- The function is reached only as a trigger, never called directly, so it needs no EXECUTE grant
-- (triggers run with the table owner's rights to invoke the function). Left ungranted on purpose.
REVOKE ALL ON FUNCTION public.guard_pos_order_close() FROM PUBLIC;

NOTIFY pgrst, 'reload schema';
