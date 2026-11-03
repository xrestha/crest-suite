-- S868: the till's below-zero refusal names the page by its S867 name, Choice Groups.
--
-- S867 renamed Option Groups to Choice Groups on every screen. One server sentence still said the
-- old name: save_pos_order_items' option_price_below_zero refusal ("… ask a manager to fix the price
-- in Option Groups"). The till rewords it (choiceRefusal.js), but an operator sees the server's own
-- text as the fine print under the message (ActionError's detail line).
--
--   §1 public.save_pos_order_items(uuid,jsonb,text,integer,uuid)  REPLACED from its LIVE body, with
--        that one string changed and nothing else: the new body's md5 must equal the md5 of the old
--        body with the one replacement made, or the whole file rolls back. Same signature, still
--        SECURITY INVOKER, owner and grants kept (CREATE OR REPLACE keeps them).
--        The sentence up to "would cost less than nothing" is unchanged, so BELOW_ZERO_RE in
--        choiceRefusal.js and errorText's option_price_below_zero rule (keyed on the HINT) read it
--        exactly as before, and a till on an older build words it the same way.
--        Rollback: the same replace the other way round, from the live body.
--
-- Not changed: the other refusals that still say "option" (option_not_on_menu, order_options_off,
-- guard_pos_option_edit's five, guard_pos_item_option_write). errorText words each of them by its
-- code, so their server text shows only as fine print, and choiceRefusal's NOT_OFFERED_RE parses
-- "an option chosen for", so that one would need the till changed first.
--
-- No app deploy needed for it to work, no Edge Function, no till-floor raise, no API change.

DO $$
DECLARE
  v_fn     regprocedure := 'public.save_pos_order_items(uuid,jsonb,text,integer,uuid)'::regprocedure;
  v_old    text := 'ask a manager to fix the price in Option Groups';
  v_new    text := 'ask a manager to fix the price in Choice Groups';
  v_src    text;
  v_def    text;
  v_expect text;
BEGIN
  -- ── 0. The body this file rebuilds is the one it read (2026-11-03) ────────────────────────────
  SELECT p.prosrc INTO v_src FROM pg_proc p WHERE p.oid = v_fn;
  IF md5(v_src) IS DISTINCT FROM '51d4e9287584af597618aad6b531a84b' THEN
    RAISE EXCEPTION 'S868: % changed since this file was written; read the live body again', v_fn;
  END IF;
  IF (length(v_src) - length(replace(v_src, v_old, ''))) / length(v_old) <> 1 THEN
    RAISE EXCEPTION 'S868: expected the old sentence exactly once in %', v_fn;
  END IF;
  v_expect := md5(replace(v_src, v_old, v_new));

  -- ── 1. Rebuild from the live definition with the one sentence changed ─────────────────────────
  v_def := pg_get_functiondef(v_fn);
  EXECUTE replace(v_def, v_old, v_new);

  -- ── 2. Proof: exactly that change, and nothing about the function's rights moved ──────────────
  IF (SELECT md5(p.prosrc) FROM pg_proc p WHERE p.oid = v_fn) IS DISTINCT FROM v_expect THEN
    RAISE EXCEPTION 'S868: % does not match the old body with the one sentence changed', v_fn;
  END IF;
  IF (SELECT p.prosecdef FROM pg_proc p WHERE p.oid = v_fn) THEN
    RAISE EXCEPTION 'S868: % became SECURITY DEFINER', v_fn;
  END IF;
  IF NOT has_function_privilege('authenticated', v_fn, 'EXECUTE')
     OR NOT has_function_privilege('service_role', v_fn, 'EXECUTE')
     OR has_function_privilege('anon', v_fn, 'EXECUTE') THEN
    RAISE EXCEPTION 'S868: the EXECUTE grants on % changed', v_fn;
  END IF;
  IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname = 'save_pos_order_items') <> 1 THEN
    RAISE EXCEPTION 'S868: save_pos_order_items must keep exactly one signature';
  END IF;
END;
$$;
