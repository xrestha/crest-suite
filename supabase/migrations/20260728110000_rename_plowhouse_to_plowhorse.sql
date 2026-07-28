-- Renames the 'plowhouse' recipes.me_class value to the correctly-spelled 'plowhorse',
-- matching the app-wide code rename (MenuEngineering.js, PosOrders.jsx). This does NOT change
-- the underlying classification logic/meaning — only the string. Order matters: the CHECK
-- constraint validates all existing rows the moment it's added, so it must be dropped BEFORE
-- the data backfill, not after.
ALTER TABLE public.recipes DROP CONSTRAINT recipes_me_class_check;

UPDATE public.recipes SET me_class = 'plowhorse' WHERE me_class = 'plowhouse';

ALTER TABLE public.recipes ADD CONSTRAINT recipes_me_class_check
  CHECK ((me_class = ANY (ARRAY['star'::text, 'plowhorse'::text, 'puzzle'::text, 'dog'::text])));
