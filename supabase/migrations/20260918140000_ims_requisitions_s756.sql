-- S756 — IMS re-analysis, stage 3: requisitions record who raised and who issued, can be REJECTED
-- with a reason, and a staff login can no longer add lines to an old issued slip over REST.
--
-- Owner decision D14 (Aashish, 2026-09-15, IMS_TODO.md): record requested_by / issued_by /
-- issued_at; add a Rejected status with a reason. No back-orders, no two-person rule.
--
-- Builds on 20260918100000 (stage 1), whose ims_requisition_rank_guard is replaced below from its
-- live body with every existing rule kept.
--
-- Carve-outs, in the order every guard in stage 1 uses them:
--   * current_user NOT IN ('anon','authenticated') — service role, SECURITY DEFINER bodies and FK
--     cascade actions (a header delete cascading into its lines runs as the table owner).
--   * COALESCE(is_admin(), false) — the operator, INCLUDING restore, which inserts from an admin
--     browser session as 'authenticated'. That is why the operator branch of the attribution
--     trigger keeps supplied values rather than stamping: restore nulls every *_by column
--     (restoreClientData.js, isAttributionColumn) and a stamp would attribute a year of historical
--     slips to the admin who ran the restore.
-- Every guard here is SECURITY INVOKER (the self-check asserts it): under DEFINER current_user is
-- the owner every time and none of them would fire.


-- ══ 1. Columns and constraints ═══════════════════════════════════════════════════════════════════
--
-- All nullable, and they stay nullable: every slip written before this migration has no record of
-- who raised or issued it, and back-filling one would be fabricating a history, not recovering it
-- (the S710 reasoning for requisition_lines.rate). ON DELETE SET NULL because the row must outlive
-- the account — a deleted login loses its name on the slip, never the slip.
-- Deliberately unindexed: no *_by column is ever filtered on (S543); they are display lookups
-- resolved through get_client_profile_names().
ALTER TABLE public.requisitions
  ADD COLUMN IF NOT EXISTS requested_by    uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS issued_by       uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS issued_at       timestamptz,
  ADD COLUMN IF NOT EXISTS rejected_reason text,
  ADD COLUMN IF NOT EXISTS rejected_by     uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS rejected_at     timestamptz;

ALTER TABLE public.requisitions DROP CONSTRAINT IF EXISTS requisitions_status_check;
ALTER TABLE public.requisitions
  ADD CONSTRAINT requisitions_status_check CHECK (status = ANY (ARRAY['draft'::text, 'issued'::text, 'rejected'::text]));

-- Rejected ⇔ a non-blank reason. A refusal with no reason is the "deleted, and nobody knows why"
-- the status exists to replace; a reason on a slip that is not rejected is a stray that would read
-- as a refusal on the printed slip. COALESCE on the right so a NULL reason compares as false
-- rather than NULL (a NULL CHECK passes). `status` itself is nullable in the baseline, and a NULL
-- status still passes — the status CHECK above has always allowed it.
ALTER TABLE public.requisitions DROP CONSTRAINT IF EXISTS requisitions_rejected_reason_check;
ALTER TABLE public.requisitions
  ADD CONSTRAINT requisitions_rejected_reason_check
  CHECK ((status = 'rejected') = (COALESCE(btrim(rejected_reason), '') <> ''));

-- Who/when of a rejection only on a rejected slip. Allows NULLs on a rejected slip: restore nulls
-- rejected_by, and an operator may reject without one.
ALTER TABLE public.requisitions DROP CONSTRAINT IF EXISTS requisitions_rejected_fields_check;
ALTER TABLE public.requisitions
  ADD CONSTRAINT requisitions_rejected_fields_check
  CHECK (status = 'rejected' OR (rejected_by IS NULL AND rejected_at IS NULL));
-- No equivalent check ties issued_by/issued_at to status = 'issued': every issued slip from before
-- this migration has both NULL, and that is the honest state of those rows.


-- ══ 2. Attribution, stamped by the server ════════════════════════════════════════════════════════
--
-- Attribution the subject of the attribution can choose is not attribution (invariant #3, S576's
-- comped_by). So for a client login every one of these is OVERWRITTEN from auth.uid() / now(),
-- whatever the request carried: requested_by and created_at on INSERT; issued_by/issued_at when
-- the slip becomes 'issued' — including Save & Issue, which INSERTs already issued; rejected_by/
-- rejected_at when it becomes 'rejected'. On any other UPDATE they are pinned to OLD, so nobody
-- can re-attribute a slip after the fact, and a status that is no longer issued/rejected clears
-- its own pair.
--
-- Named so it fires AFTER ims_rank_guard (BEFORE triggers fire in name order): the guard decides
-- whether the write may happen, this decides what it records.
CREATE OR REPLACE FUNCTION public.ims_requisition_attribution()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $$
DECLARE
  v_uid uuid := (select auth.uid());
  v_operator boolean := current_user NOT IN ('anon', 'authenticated') OR COALESCE(public.is_admin(), false);
  v_to_issued boolean;
  v_to_rejected boolean;
BEGIN
  IF NEW.rejected_reason IS NOT NULL THEN
    NEW.rejected_reason := btrim(NEW.rejected_reason);
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF v_operator THEN
      -- Keep what was supplied: restore carries historical times (and NULL names); a live operator
      -- raise from the page sends its own id. Fill only a time the operator's own action implies.
      IF NEW.status = 'issued' AND NEW.issued_by IS NOT NULL AND NEW.issued_at IS NULL THEN
        NEW.issued_at := now();
      END IF;
      IF NEW.status = 'rejected' AND NEW.rejected_by IS NOT NULL AND NEW.rejected_at IS NULL THEN
        NEW.rejected_at := now();
      END IF;
      RETURN NEW;
    END IF;

    NEW.requested_by := v_uid;
    NEW.created_at   := now();
    IF NEW.status = 'issued' THEN
      NEW.issued_by := v_uid;
      NEW.issued_at := now();
    ELSE
      NEW.issued_by := NULL;
      NEW.issued_at := NULL;
    END IF;
    -- A client login cannot create a slip already rejected (ims_rank_guard refuses it first).
    NEW.rejected_by := NULL;
    NEW.rejected_at := NULL;
    RETURN NEW;
  END IF;

  -- UPDATE
  v_to_issued   := NEW.status = 'issued'   AND OLD.status IS DISTINCT FROM 'issued';
  v_to_rejected := NEW.status = 'rejected' AND OLD.status IS DISTINCT FROM 'rejected';

  IF v_operator THEN
    IF COALESCE(v_to_issued, false) THEN
      NEW.issued_by := COALESCE(NEW.issued_by, v_uid);
      NEW.issued_at := COALESCE(NEW.issued_at, now());
    END IF;
    IF COALESCE(v_to_rejected, false) THEN
      NEW.rejected_by := COALESCE(NEW.rejected_by, v_uid);
      NEW.rejected_at := COALESCE(NEW.rejected_at, now());
    END IF;
    RETURN NEW;
  END IF;

  NEW.requested_by := OLD.requested_by;
  NEW.created_at   := OLD.created_at;

  IF COALESCE(v_to_issued, false) THEN
    NEW.issued_by := v_uid;
    NEW.issued_at := now();
  ELSIF NEW.status = 'issued' THEN
    NEW.issued_by := OLD.issued_by;
    NEW.issued_at := OLD.issued_at;
  ELSE
    NEW.issued_by := NULL;
    NEW.issued_at := NULL;
  END IF;

  IF COALESCE(v_to_rejected, false) THEN
    NEW.rejected_by := v_uid;
    NEW.rejected_at := now();
  ELSE
    -- Unreachable for an already-rejected slip (the guard refuses any UPDATE of one), so this only
    -- ever clears a stray pair on a slip that is not rejected.
    NEW.rejected_by := NULL;
    NEW.rejected_at := NULL;
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.ims_requisition_attribution() FROM PUBLIC;

DROP TRIGGER IF EXISTS ims_requisition_attribution ON public.requisitions;
CREATE TRIGGER ims_requisition_attribution
  BEFORE INSERT OR UPDATE ON public.requisitions
  FOR EACH ROW EXECUTE FUNCTION public.ims_requisition_attribution();


-- ══ 3. The rank guard, extended ══════════════════════════════════════════════════════════════════
--
-- Kept from stage 1: any requisition write needs an IMS login (a count PIN is refused at every
-- rank, via ims_caller_has_rank); changing or deleting an ISSUED slip, or its lines, needs an IMS
-- supervisor or manager (or the Owner).
--
-- New:
--   * REJECT a draft: the same rank that may ISSUE one — IMS staff and above. Rejecting is the
--     storekeeper's decision not to hand the goods over, i.e. the other answer to the question
--     Issue answers, and staff may already DELETE a draft, which destroys the request outright; a
--     rejection keeps it and says why, so it is strictly less than what staff can do today.
--   * Only a DRAFT can be rejected. An issued slip's goods have left the store; the remedy there is
--     Correct Quantities or Delete (supervisor), which already exist.
--   * A slip cannot be INSERTED already rejected by a client login. A rejection is a decision about
--     a request someone raised. (Restore is the operator and passes above.)
--   * A REJECTED slip is final: no header UPDATE (so no edit, no issue, no un-reject), and no line
--     INSERT/UPDATE/DELETE, for every client login including the Owner. DELETE of a rejected slip
--     follows the issued-slip rule: supervisor+. The line delete that cascades from it runs as the
--     table owner and passes at the current_user check.
--   * CLOSES the gap stage 1 recorded — a staff login adding lines to an already-issued slip over
--     REST. Save & Issue inserts the header as 'issued' and then its lines in a second request, so
--     a row trigger cannot refuse every line INSERT onto an issued slip. It CAN tell Save & Issue
--     apart from a later addition, because the attribution trigger above now stamps the header
--     server-side: a line INSERT onto an issued slip is allowed below supervisor only when the
--     caller IS that slip's issued_by AND issued_at is within the last 5 minutes. The page's Save &
--     Issue runs its stock-shortfall check BEFORE the header insert, so its lines follow within a
--     second or two; five minutes is slack for a slow connection, not a design window. Neither
--     value can be forged by the caller (both are overwritten on INSERT and pinned on UPDATE), and
--     every slip issued before this migration has issued_by NULL, so adding to an old slip needs a
--     supervisor exactly as changing one does. Moving an existing line onto an issued slip
--     (UPDATE of requisition_id) gets no such window.
--
-- The header lookups are INVOKER, as in stage 1: a caller whose policies hide the slip also fails
-- requisition_lines' own WITH CHECK, which scopes through the same requisitions read. The lookups
-- are COALESCE'd so a missing slip reads as "not issued / not rejected" exactly as stage 1 did.
CREATE OR REPLACE FUNCTION public.ims_requisition_rank_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $$
DECLARE
  v_slip requisitions%ROWTYPE;
BEGIN
  IF current_user NOT IN ('anon', 'authenticated') OR COALESCE(public.is_admin(), false) THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  IF NOT public.ims_caller_has_rank('staff') THEN
    RAISE EXCEPTION '%: requisitions need an IMS login', TG_TABLE_NAME
      USING ERRCODE = '42501', HINT = 'ims_rank';
  END IF;

  IF TG_TABLE_NAME = 'requisitions' THEN
    IF TG_OP = 'INSERT' THEN
      IF NEW.status = 'rejected' THEN
        RAISE EXCEPTION 'requisitions: a requisition cannot be created already rejected — save it, then reject it'
          USING ERRCODE = '42501', HINT = 'requisition_not_draft';
      END IF;
      RETURN NEW;
    END IF;

    IF OLD.status = 'rejected' THEN
      IF TG_OP = 'UPDATE' THEN
        RAISE EXCEPTION 'requisitions: this requisition was rejected, and a rejected requisition cannot be changed, issued or reopened'
          USING ERRCODE = '42501', HINT = 'requisition_rejected';
      END IF;
      IF NOT public.ims_caller_has_rank('supervisor') THEN
        RAISE EXCEPTION 'requisitions: deleting a rejected requisition needs an IMS supervisor or manager'
          USING ERRCODE = '42501', HINT = 'ims_rank';
      END IF;
      RETURN OLD;
    END IF;

    IF TG_OP = 'UPDATE' AND NEW.status = 'rejected' AND COALESCE(OLD.status, 'draft') <> 'draft' THEN
      RAISE EXCEPTION 'requisitions: only a draft requisition can be rejected — this one has already been issued'
        USING ERRCODE = '42501', HINT = 'requisition_not_draft';
    END IF;

    IF OLD.status = 'issued' AND NOT public.ims_caller_has_rank('supervisor') THEN
      RAISE EXCEPTION 'requisitions: changing or deleting a requisition that has already been issued needs an IMS supervisor or manager'
        USING ERRCODE = '42501', HINT = 'ims_rank';
    END IF;
    RETURN COALESCE(NEW, OLD);
  END IF;

  -- requisition_lines: the slip the line is on now…
  IF TG_OP <> 'INSERT' THEN
    SELECT r.* INTO v_slip FROM requisitions r WHERE r.id = OLD.requisition_id;
    IF COALESCE(v_slip.status = 'rejected', false) THEN
      RAISE EXCEPTION 'requisition_lines: this requisition was rejected, so its items cannot be changed'
        USING ERRCODE = '42501', HINT = 'requisition_rejected';
    END IF;
    IF COALESCE(v_slip.status = 'issued', false) AND NOT public.ims_caller_has_rank('supervisor') THEN
      RAISE EXCEPTION 'requisition_lines: changing or deleting a requisition that has already been issued needs an IMS supervisor or manager'
        USING ERRCODE = '42501', HINT = 'ims_rank';
    END IF;
  END IF;

  -- …and the slip it is landing on.
  IF TG_OP = 'INSERT' OR (TG_OP = 'UPDATE' AND NEW.requisition_id IS DISTINCT FROM OLD.requisition_id) THEN
    -- SELECT INTO without STRICT sets every field NULL when no row matches, so a line pointed at a
    -- missing slip cannot inherit the previous lookup's status.
    SELECT r.* INTO v_slip FROM requisitions r WHERE r.id = NEW.requisition_id;
    IF COALESCE(v_slip.status = 'rejected', false) THEN
      RAISE EXCEPTION 'requisition_lines: this requisition was rejected, so items cannot be added to it'
        USING ERRCODE = '42501', HINT = 'requisition_rejected';
    END IF;
    IF COALESCE(v_slip.status = 'issued', false)
       AND NOT public.ims_caller_has_rank('supervisor')
       AND NOT COALESCE(TG_OP = 'INSERT'
                        AND v_slip.issued_by = (select auth.uid())
                        AND v_slip.issued_at > now() - interval '5 minutes', false) THEN
      RAISE EXCEPTION 'requisition_lines: adding items to a requisition that has already been issued needs an IMS supervisor or manager'
        USING ERRCODE = '42501', HINT = 'ims_rank';
    END IF;
  END IF;

  RETURN COALESCE(NEW, OLD);
END;
$$;
REVOKE ALL ON FUNCTION public.ims_requisition_rank_guard() FROM PUBLIC;

-- Re-created unchanged from stage 1, so this file stands on its own if it is ever applied to a
-- database where stage 1's triggers were dropped.
DROP TRIGGER IF EXISTS ims_rank_guard ON public.requisitions;
CREATE TRIGGER ims_rank_guard BEFORE INSERT OR UPDATE OR DELETE ON public.requisitions
  FOR EACH ROW EXECUTE FUNCTION public.ims_requisition_rank_guard();
DROP TRIGGER IF EXISTS ims_rank_guard ON public.requisition_lines;
CREATE TRIGGER ims_rank_guard BEFORE INSERT OR UPDATE OR DELETE ON public.requisition_lines
  FOR EACH ROW EXECUTE FUNCTION public.ims_requisition_rank_guard();


-- ══ 4. Self-check ════════════════════════════════════════════════════════════════════════════════
DO $$
DECLARE
  v_missing text;
BEGIN
  SELECT string_agg(c, ', ') INTO v_missing
    FROM unnest(ARRAY['requested_by', 'issued_by', 'issued_at', 'rejected_reason', 'rejected_by', 'rejected_at']) c
   WHERE NOT EXISTS (SELECT 1 FROM pg_attribute a
                      WHERE a.attrelid = 'public.requisitions'::regclass AND a.attname = c
                        AND NOT a.attisdropped AND a.attnum > 0);
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'S756: requisitions is missing column(s) %', v_missing;
  END IF;

  -- The three attribution FKs must be SET NULL ('n'), so deleting a login never deletes a slip and
  -- is never refused because of one.
  SELECT string_agg(c, ', ') INTO v_missing
    FROM unnest(ARRAY['requested_by', 'issued_by', 'rejected_by']) c
   WHERE NOT EXISTS (SELECT 1 FROM pg_constraint k
                       JOIN pg_attribute a ON a.attrelid = k.conrelid AND a.attnum = k.conkey[1]
                      WHERE k.conrelid = 'public.requisitions'::regclass AND k.contype = 'f'
                        AND a.attname = c AND k.confrelid = 'public.profiles'::regclass
                        AND k.confdeltype = 'n');
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'S756: requisitions FK to profiles missing or not ON DELETE SET NULL on %', v_missing;
  END IF;

  SELECT string_agg(c, ', ') INTO v_missing
    FROM unnest(ARRAY['requisitions_status_check', 'requisitions_rejected_reason_check', 'requisitions_rejected_fields_check']) c
   WHERE NOT EXISTS (SELECT 1 FROM pg_constraint k
                      WHERE k.conrelid = 'public.requisitions'::regclass AND k.contype = 'c' AND k.conname = c);
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'S756: requisitions CHECK missing: %', v_missing;
  END IF;

  -- The status CHECK must now admit 'rejected'. conbin stores the literal as datum bytes, not text,
  -- so this reads the rendered definition — and tests only for the quoted literal, never the whole
  -- string's shape (the S630 trap was an exact match on a format that had been assumed).
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k
                  WHERE k.conrelid = 'public.requisitions'::regclass AND k.conname = 'requisitions_status_check'
                    AND pg_get_constraintdef(k.oid) LIKE '%''rejected''%') THEN
    RAISE EXCEPTION 'S756: requisitions_status_check does not admit rejected';
  END IF;

  SELECT string_agg(t.tbl || '.' || t.trg, ', ') INTO v_missing
    FROM (VALUES ('requisitions', 'ims_rank_guard'), ('requisitions', 'ims_requisition_attribution'),
                 ('requisitions', 'ims_closed_period_guard'), ('requisition_lines', 'ims_rank_guard'),
                 ('requisition_lines', 'ims_closed_period_guard')) AS t(tbl, trg)
   WHERE NOT EXISTS (SELECT 1 FROM pg_trigger tg JOIN pg_class c ON c.oid = tg.tgrelid
                      WHERE c.relname = t.tbl AND tg.tgname = t.trg AND NOT tg.tgisinternal
                        AND c.relnamespace = 'public'::regnamespace);
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'S756: trigger(s) missing: %', v_missing;
  END IF;

  IF EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
              WHERE n.nspname = 'public'
                AND p.proname IN ('ims_requisition_rank_guard', 'ims_requisition_attribution')
                AND p.prosecdef) THEN
    RAISE EXCEPTION 'S756: a requisition guard is SECURITY DEFINER — current_user would be the owner and it would never fire';
  END IF;

  -- Existing rows must satisfy the new CHECKs. ADD CONSTRAINT validates them already; this names the
  -- expectation so a future NOT VALID edit does not quietly drop it.
  IF EXISTS (SELECT 1 FROM public.requisitions
              WHERE NOT ((status = 'rejected') = (COALESCE(btrim(rejected_reason), '') <> ''))) THEN
    RAISE EXCEPTION 'S756: a requisition breaks the rejected ⇔ reason rule';
  END IF;
END $$;

NOTIFY pgrst, 'reload schema';
