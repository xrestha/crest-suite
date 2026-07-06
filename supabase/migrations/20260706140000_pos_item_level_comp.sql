-- Item-level Complimentary/comp: lets Supervisor+ comp individual line items while the rest
-- of the table bills normally (today, Complimentary is whole-order only — see product-roadmap
-- memory). A comped item is excluded from the Tax Invoice/PAN Bill entirely and instead appears
-- on its own internal Complimentary Slip, sharing the SAME "NC-xx" sequential series as the
-- existing whole-order Complimentary Slip (assign_pos_invoice_no's close_type='writeoff'
-- branch) — so the two never hand out the same number to two different documents.

ALTER TABLE public.pos_order_items
  ADD COLUMN comped boolean DEFAULT false NOT NULL,
  ADD COLUMN comp_reason text,
  ADD COLUMN comped_by uuid,
  ADD COLUMN comped_at timestamp with time zone,
  ADD COLUMN comp_fy text,
  ADD COLUMN comp_no integer,
  ADD CONSTRAINT pos_order_items_comp_no_check CHECK (NOT comped OR comp_no IS NOT NULL);

-- Hands out the next number in the shared Complimentary Slip series for a client+fiscal-year,
-- considering both origins (whole-order pos_orders.invoice_no where close_type='writeoff', and
-- item-level pos_order_items.comp_no). Called once per Charge action from the client — every
-- item comped in the same action shares one slip/one number, not one number per line.
CREATE FUNCTION public.get_next_pos_comp_slip_no(p_client_id uuid, p_fy text) RETURNS integer
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  next_no integer;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('pos_comp_slip_no:' || p_client_id::text || ':' || p_fy));
  SELECT COALESCE(MAX(n), 0) + 1 INTO next_no FROM (
    SELECT invoice_no AS n FROM pos_orders WHERE client_id = p_client_id AND invoice_fy = p_fy AND close_type = 'writeoff'
    UNION ALL
    SELECT comp_no AS n FROM pos_order_items WHERE client_id = p_client_id AND comp_fy = p_fy
  ) combined;
  RETURN next_no;
END;
$$;

-- A whole-order Complimentary Slip still gets its number from assign_pos_invoice_no's
-- close_type='writeoff' branch (unchanged trigger, unchanged for 'paid'/'void') — but it must
-- lock on and consider the same combined pool as get_next_pos_comp_slip_no above, or a
-- whole-order comp created after some item-level comps could reuse a number one of them already
-- has. Only the 'writeoff' branch changes; every other close_type is byte-for-byte identical to
-- the original function.
CREATE OR REPLACE FUNCTION public.assign_pos_invoice_no() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
BEGIN
  IF NEW.status = 'billed' AND NEW.invoice_no IS NULL AND NEW.invoice_fy IS NOT NULL THEN
    IF NEW.close_type = 'writeoff' THEN
      PERFORM pg_advisory_xact_lock(hashtext('pos_comp_slip_no:' || NEW.client_id::text || ':' || NEW.invoice_fy));
      SELECT COALESCE(MAX(n), 0) + 1 INTO NEW.invoice_no FROM (
        SELECT invoice_no AS n FROM pos_orders WHERE client_id = NEW.client_id AND invoice_fy = NEW.invoice_fy AND close_type = 'writeoff'
        UNION ALL
        SELECT comp_no AS n FROM pos_order_items WHERE client_id = NEW.client_id AND comp_fy = NEW.invoice_fy
      ) combined;
    ELSE
      PERFORM pg_advisory_xact_lock(hashtext('pos_invoice_no:' || NEW.client_id::text || ':' || NEW.invoice_fy || ':' || NEW.close_type));
      SELECT COALESCE(MAX(invoice_no), 0) + 1 INTO NEW.invoice_no
      FROM pos_orders WHERE client_id = NEW.client_id AND invoice_fy = NEW.invoice_fy AND close_type = NEW.close_type;
    END IF;
  END IF;
  RETURN NEW;
END $$;

NOTIFY pgrst, 'reload schema';
