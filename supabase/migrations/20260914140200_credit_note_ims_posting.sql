-- S747: a credit note that could not reach Inventory is recorded as such, and can be posted later.
--
-- IssueCreditNoteModal reverses a credited bill's revenue by inserting negative sales_entries
-- (source 'pos_credit') into TODAY's open period. When no period was open for today's BS month it
-- skipped the insert without a word, and the insert's own error was never read (a supabase-js
-- error resolves, so the try/catch around it caught nothing). The note printed; Inventory revenue
-- stayed overstated by the whole bill, with no stamp, no banner and no way to post it afterwards.
--
-- Decided with Aashish: the same treatment a bill already gets (S573) -- issue it, mark it
-- "not yet in Inventory", say so, and let a manager post it from Periods once the month is open.
--
--   pos_credit_notes.ims_posted_at   stamped only once the reversal rows have landed
--   sales_entries.pos_credit_note_id the reversal row's link back to its note. This is what the
--                                    backfill asks before posting -- never ims_posted_at alone,
--                                    which can fail to stamp after the rows landed (S573/S654:
--                                    ask the table you actually mean).

ALTER TABLE public.pos_credit_notes
  ADD COLUMN IF NOT EXISTS ims_posted_at timestamptz;

ALTER TABLE public.sales_entries
  ADD COLUMN IF NOT EXISTS pos_credit_note_id uuid
    REFERENCES public.pos_credit_notes(id) ON DELETE SET NULL;

-- The backfill's already-posted guard reads by this column; FK columns are indexed by convention.
CREATE INDEX IF NOT EXISTS idx_sales_entries_pos_credit_note_id
  ON public.sales_entries (pos_credit_note_id) WHERE pos_credit_note_id IS NOT NULL;

-- The floor banner counts unposted notes per client with head:true.
CREATE INDEX IF NOT EXISTS idx_pos_credit_notes_unposted
  ON public.pos_credit_notes (client_id) WHERE ims_posted_at IS NULL;

-- Notes issued before this column existed: NULL there means "unknown", not "unposted" -- the rule
-- that cost a double-post on bills (pos-billing.md). Their reversal rows carry no link, so nothing
-- can prove which posted. Every existing note whose client has ANY 'pos_credit' revenue row is
-- stamped as posted (read live 2026-09-14: 1 note, 2 reversal rows, one client -- that note did
-- post). A note whose client has none genuinely never reached Inventory and is left NULL, so it
-- appears in the backfill.
UPDATE public.pos_credit_notes cn
   SET ims_posted_at = cn.created_at
 WHERE cn.ims_posted_at IS NULL
   AND EXISTS (
     SELECT 1
       FROM public.sales_entries se
       JOIN public.monthly_periods mp ON mp.id = se.period_id
      WHERE se.source = 'pos_credit'
        AND mp.client_id = cn.client_id
   );

NOTIFY pgrst, 'reload schema';

-- Verification ---------------------------------------------------------------------------------
--   SELECT count(*) FILTER (WHERE ims_posted_at IS NULL) AS unposted, count(*) AS total FROM pos_credit_notes;
--   SELECT column_name FROM information_schema.columns
--    WHERE table_schema = 'public' AND table_name = 'sales_entries' AND column_name = 'pos_credit_note_id';
