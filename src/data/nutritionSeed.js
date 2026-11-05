import { NUTRIENTS, defaultBasisUnit } from '../utils/nutrition'

// The built-in nutrition library: three sources, one search.
//
// - 'DFTQC Nepal': the Food Composition Table for Nepal 2012 (Dept. of Food Technology & Quality
//   Control), main table and supplementary table of packaged goods.
// - 'IFCT 2017': the Indian Food Composition Tables 2017 (NIN Hyderabad).
// - 'USDA': the hand-picked FoodData Central rows below.
//
// The two regional tables are whole: 1,100+ rows in src/data/foodTables.json, built from the
// reviewed extracts in scripts/food-tables/ (README there: sources, what was left out and why).
// Never hand-edit that JSON; rebuild it. It loads on demand (loadLibrary), so the pages that
// import this file do not carry it. Figures are per 100 g. The Nepal table measured no sugar or
// sodium: a Nepal row carries the Indian table's figures for the same food when one exists
// (`borrowed` names it) and null otherwise, never 0.
//
// USDA row: { name, match:[lowercase keywords], unit:'GM'|'ML', source,
//             energy_kcal, protein_g, carbs_g, fat_g, sugar_g, sodium_mg, allergens }
// `allergens` uses the keys of src/shared/constants/allergens.js only (S870). A library pick adds
// them to the form; it never marks an ingredient checked.
//
// The USDA list was typed by hand, and in S887 every row was checked against the FoodData Central
// bulk files (SR Legacy, Foundation, Survey). A row whose figures differed now carries the figures
// of the FDC food its NAME describes (a raw row the raw food, never the cooked one), with the FDC id
// beside it. A food FDC does not have was, by owner decision (2026-11-05), replaced by the same
// food in the Nepal or Indian table (beaten rice, paneer, khuwa, jaggery, freshwater fish), or
// removed where neither table has it (garam masala, dry tea leaves). A figure FDC does not print
// stays out, never 0, except where it is plainly 0 (no sugar in meat, fish or oil).

export const NUTRITION_SEED = [
  // ════════════════════════ USDA (FoodData Central) ════════════════════════
  // ── Grains, flours, rice ──
  { name: 'Rice (white, raw)',      match: ['rice', 'chamal', 'basmati'], unit: 'GM', source: 'USDA', energy_kcal: 360, protein_g: 6.6, carbs_g: 79, fat_g: 0.6, sugar_g: 0.1, sodium_mg: 1, allergens: '' },
  { name: 'Rice (brown, raw)',      match: ['brown rice'], unit: 'GM', source: 'USDA', energy_kcal: 370, protein_g: 7.9, carbs_g: 77, fat_g: 2.9, sugar_g: 0.7, sodium_mg: 4, allergens: '' },
  { name: 'Wheat flour (maida)',    match: ['maida', 'wheat flour', 'flour', 'pitho'], unit: 'GM', source: 'USDA', energy_kcal: 364, protein_g: 10, carbs_g: 76, fat_g: 1, sugar_g: 0.3, sodium_mg: 2, allergens: 'gluten' },
  { name: 'Whole wheat flour (atta)', match: ['atta', 'whole wheat', 'gahu'], unit: 'GM', source: 'USDA', energy_kcal: 340, protein_g: 13, carbs_g: 72, fat_g: 2.5, sugar_g: 0.4, sodium_mg: 2, allergens: 'gluten' },
  { name: 'Gram flour (besan)',     match: ['besan', 'gram flour', 'chickpea flour'], unit: 'GM', source: 'USDA', energy_kcal: 387, protein_g: 22, carbs_g: 58, fat_g: 6.7, sugar_g: 11, sodium_mg: 64, allergens: '' },
  { name: 'Cornflour / cornstarch', match: ['cornflour', 'cornstarch', 'corn flour'], unit: 'GM', source: 'USDA', energy_kcal: 381, protein_g: 0.3, carbs_g: 91, fat_g: 0.1, sugar_g: 0, sodium_mg: 9, allergens: '' },
  { name: 'Semolina (suji)',        match: ['suji', 'semolina', 'rava'], unit: 'GM', source: 'USDA', energy_kcal: 360, protein_g: 13, carbs_g: 73, fat_g: 1.1, sugar_g: 0, sodium_mg: 1, allergens: 'gluten' },
  // Plain wheat noodles: FDC 169736 "Pasta, dry, enriched". FDC files an egg-free noodle as pasta (its
  // dry "Noodles" rows are egg noodles), so this is the same wheat-and-water dough, with no egg.
  { name: 'Noodles (dry)',          match: ['noodle', 'chowmein', 'chow mein'], unit: 'GM', source: 'USDA', energy_kcal: 371, protein_g: 13, carbs_g: 75, fat_g: 1.5, sugar_g: 2.7, sodium_mg: 6, allergens: 'gluten' },
  // Fried and seasoned, so one row could not honestly cover both: FDC 171177 "Soup, ramen noodle, any flavor, dry".
  { name: 'Instant noodles (dry)',  match: ['instant noodle', 'wai wai'], unit: 'GM', source: 'USDA', energy_kcal: 440, protein_g: 10.2, carbs_g: 60.3, fat_g: 17.6, sugar_g: 2, sodium_mg: 1855, allergens: 'gluten' },
  { name: 'Pasta / macaroni (dry)', match: ['pasta', 'macaroni', 'spaghetti'], unit: 'GM', source: 'USDA', energy_kcal: 371, protein_g: 13, carbs_g: 75, fat_g: 1.5, sugar_g: 2.7, sodium_mg: 6, allergens: 'gluten' },
  { name: 'Bread (white)',          match: ['bread', 'pau', 'bun'], unit: 'GM', source: 'USDA', energy_kcal: 265, protein_g: 9, carbs_g: 49, fat_g: 3.2, sugar_g: 5, sodium_mg: 491, allergens: 'gluten' },
  { name: 'Oats',                   match: ['oats', 'oat'], unit: 'GM', source: 'USDA', energy_kcal: 389, protein_g: 17, carbs_g: 66, fat_g: 7, sugar_g: 1, sodium_mg: 2, allergens: 'gluten' },

  // ── Pulses / lentils ──
  { name: 'Lentils (dal, raw)',     match: ['dal', 'daal', 'lentil', 'masoor'], unit: 'GM', source: 'USDA', energy_kcal: 352, protein_g: 25, carbs_g: 63, fat_g: 1.1, sugar_g: 2, sodium_mg: 6, allergens: '' },
  { name: 'Chickpeas (chana, raw)', match: ['chana', 'chickpea', 'kabuli'], unit: 'GM', source: 'USDA', energy_kcal: 364, protein_g: 19, carbs_g: 61, fat_g: 6, sugar_g: 11, sodium_mg: 24, allergens: '' },
  { name: 'Kidney beans (rajma)',   match: ['rajma', 'kidney bean'], unit: 'GM', source: 'USDA', energy_kcal: 333, protein_g: 24, carbs_g: 60, fat_g: 0.8, sugar_g: 2.1, sodium_mg: 12, allergens: '' },
  { name: 'Black gram (maas/urad)', match: ['maas', 'urad', 'black gram'], unit: 'GM', source: 'USDA', energy_kcal: 341, protein_g: 25, carbs_g: 59, fat_g: 1.6, sugar_g: 0, sodium_mg: 38, allergens: '' },
  { name: 'Soybean (raw)',          match: ['soybean', 'soya', 'bhatmas'], unit: 'GM', source: 'USDA', energy_kcal: 446, protein_g: 36, carbs_g: 30, fat_g: 20, sugar_g: 7, sodium_mg: 2, allergens: 'soy' },
  { name: 'Green peas',             match: ['peas', 'matar', 'kerau'], unit: 'GM', source: 'USDA', energy_kcal: 81, protein_g: 5.4, carbs_g: 14, fat_g: 0.4, sugar_g: 5.7, sodium_mg: 5, allergens: '' },

  // ── Meat, poultry, fish, egg ──
  { name: 'Chicken (broiler, raw)', match: ['chicken', 'kukhura', 'broiler'], unit: 'GM', source: 'USDA', energy_kcal: 215, protein_g: 18, carbs_g: 0, fat_g: 15, sugar_g: 0, sodium_mg: 70, allergens: '' },
  { name: 'Chicken breast (raw)',   match: ['chicken breast', 'breast'], unit: 'GM', source: 'USDA', energy_kcal: 120, protein_g: 23, carbs_g: 0, fat_g: 2.6, sugar_g: 0, sodium_mg: 45, allergens: '' },
  { name: 'Mutton / goat (raw)',    match: ['mutton', 'goat', 'khasi', 'boka'], unit: 'GM', source: 'USDA', energy_kcal: 109, protein_g: 20.6, carbs_g: 0, fat_g: 2.3, sugar_g: 0, sodium_mg: 82, allergens: '' }, // FDC 175303
  { name: 'Buff / buffalo (raw)',   match: ['buff', 'buffalo', 'rango'], unit: 'GM', source: 'USDA', energy_kcal: 99, protein_g: 20.4, carbs_g: 0, fat_g: 1.4, sugar_g: 0, sodium_mg: 53, allergens: '' }, // FDC 175299
  { name: 'Pork (raw)',             match: ['pork', 'bangur', 'sungur'], unit: 'GM', source: 'USDA', energy_kcal: 198, protein_g: 19.7, carbs_g: 0, fat_g: 12.6, sugar_g: 0, sodium_mg: 50, allergens: '' }, // FDC 167818
  { name: 'Prawn / shrimp (raw)',   match: ['prawn', 'shrimp'], unit: 'GM', source: 'USDA', energy_kcal: 85, protein_g: 20.1, carbs_g: 0, fat_g: 0.5, sugar_g: 0, sodium_mg: 119, allergens: 'crustaceans' }, // FDC 175179
  { name: 'Egg (whole)',            match: ['egg', 'anda', 'phul'], unit: 'GM', source: 'USDA', energy_kcal: 155, protein_g: 13, carbs_g: 1.1, fat_g: 11, sugar_g: 1.1, sodium_mg: 124, allergens: 'eggs' },

  // ── Dairy ──
  { name: 'Milk (whole)',           match: ['milk', 'dudh'], unit: 'GM', source: 'USDA', energy_kcal: 61, protein_g: 3.2, carbs_g: 4.8, fat_g: 3.3, sugar_g: 5.1, sodium_mg: 43, allergens: 'milk' },
  { name: 'Curd / yogurt (dahi)',   match: ['dahi', 'curd', 'yogurt', 'yoghurt'], unit: 'GM', source: 'USDA', energy_kcal: 61, protein_g: 3.5, carbs_g: 4.7, fat_g: 3.3, sugar_g: 4.7, sodium_mg: 46, allergens: 'milk' },
  // The typed figures were cheddar's under a processed-cheese name, so cheddar has its own row.
  { name: 'Cheese (processed)',     match: ['cheese', 'processed cheese'], unit: 'GM', source: 'USDA', energy_kcal: 371, protein_g: 18.1, carbs_g: 3.7, fat_g: 31.8, sugar_g: 2.3, sodium_mg: 1671, allergens: 'milk' }, // FDC 171290
  { name: 'Cheese (cheddar)',       match: ['cheddar'], unit: 'GM', source: 'USDA', energy_kcal: 403, protein_g: 22.9, carbs_g: 3.4, fat_g: 33.3, sugar_g: 0.5, sodium_mg: 653, allergens: 'milk' }, // FDC 173414
  { name: 'Butter',                 match: ['butter', 'makhan'], unit: 'GM', source: 'USDA', energy_kcal: 717, protein_g: 0.9, carbs_g: 0.1, fat_g: 81, sugar_g: 0.1, sodium_mg: 11, allergens: 'milk' },
  { name: 'Ghee / clarified butter', match: ['ghee', 'ghiu'], unit: 'GM', source: 'USDA', energy_kcal: 900, protein_g: 0, carbs_g: 0, fat_g: 100, sugar_g: 0, sodium_mg: 0, allergens: 'milk' },
  { name: 'Cream',                  match: ['cream', 'malai'], unit: 'GM', source: 'USDA', energy_kcal: 340, protein_g: 2.1, carbs_g: 2.8, fat_g: 36, sugar_g: 2.9, sodium_mg: 27, allergens: 'milk' },

  // ── Oils & fats ──
  { name: 'Cooking oil (vegetable)', match: ['oil', 'tel', 'soybean oil', 'sunflower'], unit: 'GM', source: 'USDA', energy_kcal: 884, protein_g: 0, carbs_g: 0, fat_g: 100, sugar_g: 0, sodium_mg: 0, allergens: '' },
  { name: 'Mustard oil',            match: ['mustard oil', 'tori'], unit: 'GM', source: 'USDA', energy_kcal: 884, protein_g: 0, carbs_g: 0, fat_g: 100, sugar_g: 0, sodium_mg: 0, allergens: 'mustard' },
  { name: 'Olive oil',              match: ['olive oil', 'olive'], unit: 'GM', source: 'USDA', energy_kcal: 884, protein_g: 0, carbs_g: 0, fat_g: 100, sugar_g: 0, sodium_mg: 2, allergens: '' },

  // ── Vegetables ──
  { name: 'Potato',                 match: ['potato', 'aalu', 'alu'], unit: 'GM', source: 'USDA', energy_kcal: 77, protein_g: 2, carbs_g: 17, fat_g: 0.1, sugar_g: 0.8, sodium_mg: 6, allergens: '' },
  { name: 'Onion',                  match: ['onion', 'pyaj'], unit: 'GM', source: 'USDA', energy_kcal: 40, protein_g: 1.1, carbs_g: 9, fat_g: 0.1, sugar_g: 4.2, sodium_mg: 4, allergens: '' },
  { name: 'Tomato',                 match: ['tomato', 'golbheda'], unit: 'GM', source: 'USDA', energy_kcal: 18, protein_g: 0.9, carbs_g: 3.9, fat_g: 0.2, sugar_g: 2.6, sodium_mg: 5, allergens: '' },
  { name: 'Garlic',                 match: ['garlic', 'lasun'], unit: 'GM', source: 'USDA', energy_kcal: 149, protein_g: 6.4, carbs_g: 33, fat_g: 0.5, sugar_g: 1, sodium_mg: 17, allergens: '' },
  { name: 'Ginger',                 match: ['ginger', 'aduwa'], unit: 'GM', source: 'USDA', energy_kcal: 80, protein_g: 1.8, carbs_g: 18, fat_g: 0.8, sugar_g: 1.7, sodium_mg: 13, allergens: '' },
  { name: 'Cauliflower',            match: ['cauliflower', 'kauli'], unit: 'GM', source: 'USDA', energy_kcal: 25, protein_g: 1.9, carbs_g: 5, fat_g: 0.3, sugar_g: 1.9, sodium_mg: 30, allergens: '' },
  { name: 'Cabbage',                match: ['cabbage', 'bandakopi'], unit: 'GM', source: 'USDA', energy_kcal: 25, protein_g: 1.3, carbs_g: 6, fat_g: 0.1, sugar_g: 3.2, sodium_mg: 18, allergens: '' },
  { name: 'Carrot',                 match: ['carrot', 'gajar'], unit: 'GM', source: 'USDA', energy_kcal: 41, protein_g: 0.9, carbs_g: 10, fat_g: 0.2, sugar_g: 4.7, sodium_mg: 69, allergens: '' },
  { name: 'Spinach / greens (saag)', match: ['spinach', 'saag', 'palungo'], unit: 'GM', source: 'USDA', energy_kcal: 23, protein_g: 2.9, carbs_g: 3.6, fat_g: 0.4, sugar_g: 0.4, sodium_mg: 79, allergens: '' },
  { name: 'Capsicum / bell pepper', match: ['capsicum', 'bell pepper', 'khursani simi'], unit: 'GM', source: 'USDA', energy_kcal: 26, protein_g: 1, carbs_g: 6, fat_g: 0.3, sugar_g: 4.2, sodium_mg: 4, allergens: '' }, // FDC 170108
  { name: 'Green chilli',           match: ['chilli', 'chili', 'khursani'], unit: 'GM', source: 'USDA', energy_kcal: 40, protein_g: 1.9, carbs_g: 9, fat_g: 0.4, sugar_g: 5, sodium_mg: 7, allergens: '' },
  { name: 'Mushroom',               match: ['mushroom', 'chyau'], unit: 'GM', source: 'USDA', energy_kcal: 22, protein_g: 3.1, carbs_g: 3.3, fat_g: 0.3, sugar_g: 2, sodium_mg: 5, allergens: '' },
  { name: 'Cucumber',               match: ['cucumber', 'kakro'], unit: 'GM', source: 'USDA', energy_kcal: 15, protein_g: 0.7, carbs_g: 3.6, fat_g: 0.1, sugar_g: 1.7, sodium_mg: 2, allergens: '' },
  { name: 'Brinjal / eggplant',     match: ['brinjal', 'eggplant', 'bhanta'], unit: 'GM', source: 'USDA', energy_kcal: 25, protein_g: 1, carbs_g: 6, fat_g: 0.2, sugar_g: 3.5, sodium_mg: 2, allergens: '' },
  { name: 'Beans (green)',          match: ['green bean', 'simi', 'french bean'], unit: 'GM', source: 'USDA', energy_kcal: 31, protein_g: 1.8, carbs_g: 7, fat_g: 0.2, sugar_g: 3.3, sodium_mg: 6, allergens: '' },
  { name: 'Pumpkin',                match: ['pumpkin', 'pharsi'], unit: 'GM', source: 'USDA', energy_kcal: 26, protein_g: 1, carbs_g: 7, fat_g: 0.1, sugar_g: 2.8, sodium_mg: 1, allergens: '' },
  { name: 'Radish',                 match: ['radish', 'mula'], unit: 'GM', source: 'USDA', energy_kcal: 16, protein_g: 0.7, carbs_g: 3.4, fat_g: 0.1, sugar_g: 1.9, sodium_mg: 39, allergens: '' },
  { name: 'Okra (bhindi)',          match: ['okra', 'bhindi', 'ramtoriya'], unit: 'GM', source: 'USDA', energy_kcal: 33, protein_g: 1.9, carbs_g: 7, fat_g: 0.2, sugar_g: 1.5, sodium_mg: 7, allergens: '' },

  // ── Fruits ──
  { name: 'Banana',                 match: ['banana', 'kera'], unit: 'GM', source: 'USDA', energy_kcal: 89, protein_g: 1.1, carbs_g: 23, fat_g: 0.3, sugar_g: 12, sodium_mg: 1, allergens: '' },
  { name: 'Apple',                  match: ['apple', 'syau'], unit: 'GM', source: 'USDA', energy_kcal: 52, protein_g: 0.3, carbs_g: 14, fat_g: 0.2, sugar_g: 10, sodium_mg: 1, allergens: '' },
  { name: 'Mango',                  match: ['mango', 'aanp', 'aam'], unit: 'GM', source: 'USDA', energy_kcal: 60, protein_g: 0.8, carbs_g: 15, fat_g: 0.4, sugar_g: 14, sodium_mg: 1, allergens: '' },
  { name: 'Lemon / lime',           match: ['lemon', 'lime', 'kagati', 'nibuwa'], unit: 'GM', source: 'USDA', energy_kcal: 29, protein_g: 1.1, carbs_g: 9, fat_g: 0.3, sugar_g: 2.5, sodium_mg: 2, allergens: '' },
  { name: 'Orange',                 match: ['orange', 'suntala'], unit: 'GM', source: 'USDA', energy_kcal: 47, protein_g: 0.9, carbs_g: 12, fat_g: 0.1, sugar_g: 9, sodium_mg: 0, allergens: '' },
  { name: 'Coconut (fresh)',        match: ['coconut', 'nariwal'], unit: 'GM', source: 'USDA', energy_kcal: 354, protein_g: 3.3, carbs_g: 15, fat_g: 33, sugar_g: 6, sodium_mg: 20, allergens: '' },
  // FDC Branded Foods 2161316, a frozen unsweetened pure acai pulp (acai and citric acid); the
  // generic FDC tables carry only acai drinks.
  { name: 'Acai pulp (unsweetened)', match: ['acai', 'açaí'], unit: 'GM', source: 'USDA', energy_kcal: 77, protein_g: 1, carbs_g: 3.3, fat_g: 6.6, sugar_g: 0, sodium_mg: 36, allergens: '' },
  { name: 'Strawberry',             match: ['strawberry'], unit: 'GM', source: 'USDA', energy_kcal: 32, protein_g: 0.7, carbs_g: 8, fat_g: 0.3, sugar_g: 4.9, sodium_mg: 1, allergens: '' },
  { name: 'Blueberry',              match: ['blueberry'], unit: 'GM', source: 'USDA', energy_kcal: 57, protein_g: 0.7, carbs_g: 14, fat_g: 0.3, sugar_g: 10, sodium_mg: 1, allergens: '' },
  { name: 'Granola',                match: ['granola', 'muesli'], unit: 'GM', source: 'USDA', energy_kcal: 489, protein_g: 13.7, carbs_g: 53.9, fat_g: 24.3, sugar_g: 19.8, sodium_mg: 26, allergens: 'gluten, tree nuts' }, // FDC 171646
  { name: 'Peanut butter',          match: ['peanut butter'], unit: 'GM', source: 'USDA', energy_kcal: 588, protein_g: 25, carbs_g: 20, fat_g: 50, sugar_g: 9, sodium_mg: 17, allergens: 'peanuts' },
  { name: 'Chia seed',              match: ['chia'], unit: 'GM', source: 'USDA', energy_kcal: 486, protein_g: 17, carbs_g: 42, fat_g: 31, sugar_g: 0, sodium_mg: 16, allergens: '' },

  // ── Sugars & sweeteners ──
  { name: 'Sugar (white)',          match: ['sugar', 'chini', 'chinni'], unit: 'GM', source: 'USDA', energy_kcal: 387, protein_g: 0, carbs_g: 100, fat_g: 0, sugar_g: 100, sodium_mg: 1, allergens: '' },
  { name: 'Honey',                  match: ['honey', 'maha'], unit: 'GM', source: 'USDA', energy_kcal: 304, protein_g: 0.3, carbs_g: 82, fat_g: 0, sugar_g: 82, sodium_mg: 4, allergens: '' },

  // ── Nuts & seeds ──
  { name: 'Peanut / groundnut',     match: ['peanut', 'groundnut', 'badam'], unit: 'GM', source: 'USDA', energy_kcal: 567, protein_g: 26, carbs_g: 16, fat_g: 49, sugar_g: 4, sodium_mg: 18, allergens: 'peanuts' },
  { name: 'Cashew',                 match: ['cashew', 'kaju'], unit: 'GM', source: 'USDA', energy_kcal: 553, protein_g: 18, carbs_g: 30, fat_g: 44, sugar_g: 6, sodium_mg: 12, allergens: 'tree nuts' },
  { name: 'Almond',                 match: ['almond', 'badam giri'], unit: 'GM', source: 'USDA', energy_kcal: 579, protein_g: 21, carbs_g: 22, fat_g: 50, sugar_g: 4.4, sodium_mg: 1, allergens: 'tree nuts' },
  { name: 'Walnut',                 match: ['walnut', 'okhar'], unit: 'GM', source: 'USDA', energy_kcal: 654, protein_g: 15, carbs_g: 14, fat_g: 65, sugar_g: 2.6, sodium_mg: 2, allergens: 'tree nuts' },
  { name: 'Sesame seed (til)',      match: ['sesame', 'til'], unit: 'GM', source: 'USDA', energy_kcal: 573, protein_g: 18, carbs_g: 23, fat_g: 50, sugar_g: 0.3, sodium_mg: 11, allergens: 'sesame' },

  // ── Spices & condiments ──
  { name: 'Salt',                   match: ['salt', 'nun'], unit: 'GM', source: 'USDA', energy_kcal: 0, protein_g: 0, carbs_g: 0, fat_g: 0, sugar_g: 0, sodium_mg: 38758, allergens: '' },
  { name: 'Turmeric (besar)',       match: ['turmeric', 'besar', 'haldi'], unit: 'GM', source: 'USDA', energy_kcal: 312, protein_g: 9.7, carbs_g: 67, fat_g: 3.3, sugar_g: 3.2, sodium_mg: 27, allergens: '' },
  { name: 'Cumin (jeera)',          match: ['cumin', 'jeera', 'jira'], unit: 'GM', source: 'USDA', energy_kcal: 375, protein_g: 18, carbs_g: 44, fat_g: 22, sugar_g: 2.3, sodium_mg: 168, allergens: '' },
  { name: 'Coriander (dhaniya)',    match: ['coriander', 'dhaniya'], unit: 'GM', source: 'USDA', energy_kcal: 298, protein_g: 12, carbs_g: 55, fat_g: 18, sugar_g: 0, sodium_mg: 35, allergens: '' },
  // Plain ground red chilli: FDC 170932 "Spices, pepper, red or cayenne". The US "chili powder" is a salted blend.
  { name: 'Chilli powder',          match: ['chilli powder', 'chili powder', 'red chilli'], unit: 'GM', source: 'USDA', energy_kcal: 318, protein_g: 12, carbs_g: 56.6, fat_g: 17.3, sugar_g: 10.3, sodium_mg: 30, allergens: '' },
  { name: 'Black pepper',           match: ['pepper', 'marich'], unit: 'GM', source: 'USDA', energy_kcal: 251, protein_g: 10, carbs_g: 64, fat_g: 3.3, sugar_g: 0.6, sodium_mg: 20, allergens: '' },
  { name: 'Soy sauce',              match: ['soy sauce', 'soya sauce'], unit: 'GM', source: 'USDA', energy_kcal: 53, protein_g: 8, carbs_g: 4.9, fat_g: 0.6, sugar_g: 0.4, sodium_mg: 5493, allergens: 'gluten, soy' },
  { name: 'Tomato ketchup',         match: ['ketchup', 'tomato sauce'], unit: 'GM', source: 'USDA', energy_kcal: 101, protein_g: 1.3, carbs_g: 27, fat_g: 0.1, sugar_g: 22, sodium_mg: 907, allergens: '' },
  { name: 'Vinegar',                match: ['vinegar'], unit: 'GM', source: 'USDA', energy_kcal: 18, protein_g: 0, carbs_g: 0.9, fat_g: 0, sugar_g: 0.4, sodium_mg: 5, allergens: '' },
  { name: 'Mayonnaise',             match: ['mayonnaise', 'mayo'], unit: 'GM', source: 'USDA', energy_kcal: 680, protein_g: 1, carbs_g: 0.6, fat_g: 75, sugar_g: 0.6, sodium_mg: 635, allergens: 'eggs' },
  { name: 'Tamarind (imli)',        match: ['tamarind', 'imli', 'titri'], unit: 'GM', source: 'USDA', energy_kcal: 239, protein_g: 2.8, carbs_g: 63, fat_g: 0.6, sugar_g: 39, sodium_mg: 28, allergens: '' },

  // ── Beverages ──
  { name: 'Coffee (instant powder)', match: ['coffee', 'nescafe'], unit: 'GM', source: 'USDA', energy_kcal: 353, protein_g: 13, carbs_g: 75, fat_g: 0.5, sugar_g: 0, sodium_mg: 37, allergens: '' },
  { name: 'Cocoa powder',           match: ['cocoa', 'cacao'], unit: 'GM', source: 'USDA', energy_kcal: 228, protein_g: 20, carbs_g: 58, fat_g: 14, sugar_g: 1.8, sodium_mg: 21, allergens: '' },
  { name: 'Cola / soft drink',      match: ['cola', 'coke', 'soft drink', 'soda'], unit: 'ML', source: 'USDA', energy_kcal: 42, protein_g: 0, carbs_g: 11, fat_g: 0, sugar_g: 11, sodium_mg: 4, allergens: '' },
  { name: 'Orange juice',           match: ['orange juice', 'juice'], unit: 'ML', source: 'USDA', energy_kcal: 45, protein_g: 0.7, carbs_g: 10, fat_g: 0.2, sugar_g: 8.4, sodium_mg: 1, allergens: '' },
]

// Kitchen names for a Nepal or Indian table food that replaced a USDA row (S887, owner decision).
// Beaten rice, paneer and khuwa needed nothing: their table rows are already found by every name
// their USDA row had (the row's own name, a bracketed name, SAME_FOOD below). These two did not:
// FISH and MACHHA found no fish without the USDA row, and JAGGERY, GUD and SAKHAR found white
// jaggery, which ties cane jaggery and comes first in the book. So the table row takes the names
// here as keywords and goes first in its table, which is what wins a tie (suggestSeeds: strong,
// score, regional first, then table order). It stays one row, with its own table figures and label;
// nothing is added to foodTables.json.
export const REGIONAL_KITCHEN_NAMES = {
  'NP-O17': ['jaggery', 'gud', 'sakhar'], // DFTQC Nepal: Jaggery, cane (sakhar)
  'IN-S006': ['fish', 'machha'],          // IFCT 2017: Rohu
}

// The library picker's three sources, regional first (most relevant for Nepal).
export const LIBRARY_SOURCES = ['DFTQC Nepal', 'IFCT 2017', 'USDA']
const SOURCE_ORDER = { 'DFTQC Nepal': 0, 'IFCT 2017': 1, 'USDA': 2 }

// ── Words ──────────────────────────────────────────────────────────────────────────────────────
// Spellings of one food, rewritten before a name is split into words, in item names and food
// names alike, so "Soya bean", "soyabean" and "soybean" are one word.
const SPELLINGS = [
  [/\bsoy[a]? ?beans?\b|\bsoyabeans?\b/g, 'soybean'], [/\bground ?nuts?\b/g, 'groundnut'],
  [/\bpea ?nuts?\b/g, 'peanut'], [/\bbutter ?milk\b/g, 'buttermilk'],
  [/\bwater ?melons?\b|\bmelon water\b/g, 'watermelon'], [/\blad(?:y|ies)(?: s)? ?fingers?\b/g, 'okra'],
  [/\begg ?plants?\b/g, 'eggplant'], [/\bchick ?peas?\b/g, 'chickpea'], [/\bbeet ?roots?\b/g, 'beetroot'],
  [/\bpine ?apples?\b/g, 'pineapple'], [/\bcotton ?seeds?\b/g, 'cottonseed'],
  [/\bcorn ?flour\b/g, 'cornflour'], [/\bgingelly\b/g, 'sesame'], [/\bseasome\b/g, 'sesame'],
]

// Kitchen names for one food in Nepali, Hindi and English. An item name holding any phrase of a set
// is also searched as every other phrase in it: "KUKHURA MASU" finds chicken, "BHINDI" finds okra.
// Additive only, so a word never stops meaning itself.
const SAME_FOOD = [
  ['chicken', 'kukhura', 'murgi', 'murga'], ['goat', 'khasi', 'boka', 'mutton', 'chevon'],
  ['buffalo', 'buff', 'rango', 'bhainsi', 'bhaisi'], ['pork', 'sungur', 'bangur'],
  ['fish', 'machha', 'maachha', 'macha'], ['rohu', 'rahu'], ['prawn', 'shrimp', 'jhinge', 'jhinga'], ['egg', 'anda'],
  ['duck', 'hans'], ['quail', 'battai'], ['meat', 'masu', 'mashu'],
  ['milk', 'dudh', 'doodh', 'dudha'], ['curd', 'dahi', 'yogurt', 'yoghurt'], ['buttermilk', 'mohi', 'chhaas'],
  ['ghee', 'ghiu', 'ghyu'], ['butter', 'makhan', 'nauni'], ['khuwa', 'khoa', 'mawa', 'khova'],
  ['chhena', 'chenna'], ['paneer', 'cottage cheese'], ['cheese', 'chij'],
  ['rice', 'chamal', 'chawal'], ['beaten rice', 'rice flakes', 'chiura', 'chiwra', 'poha'],
  ['rice puff', 'puffed rice', 'bhuja', 'murai', 'murmura'], ['flour', 'pitho'],
  ['atta', 'whole wheat flour', 'wheat flour whole'], ['maida', 'refined wheat flour', 'wheat flour refined'],
  ['semolina', 'suji', 'sooji', 'rava'], ['gram flour', 'besan'], ['maize', 'corn', 'makai', 'makka', 'makkai'],
  ['finger millet', 'kodo', 'ragi', 'mandua'], ['buckwheat', 'phapar', 'fapar', 'kuttu'],
  ['barley', 'jau', 'jaun'], ['naked barley', 'uwa'], ['proso millet', 'chino', 'chinu'],
  ['foxtail millet', 'kaguno'], ['vermicelli', 'sewai', 'sevai', 'seviyan'],
  ['noodle', 'chowmein', 'chow mein', 'chau chau'], ['bread', 'pauroti', 'paurotti'],
  ['lentil', 'masoor', 'masur', 'musuro'], ['green gram', 'mung', 'moong', 'mugi'],
  ['black gram', 'maas', 'urad', 'urd'], ['red gram', 'pigeon pea', 'rahar', 'arhar', 'toor', 'tuvar'],
  ['bengal gram', 'chickpea', 'chana', 'channa', 'kabuli', 'chole', 'chhole'],
  ['rajma', 'rajmah', 'kidney bean'], ['soybean', 'bhatmas', 'soya', 'soy'],
  ['nutrela', 'soya chunk', 'soy chunk'], ['pea', 'kerau', 'matar', 'mattar'], ['cowpea', 'bodi', 'lobia'],
  ['french bean', 'green bean', 'simi'], ['potato', 'aalu', 'alu', 'aloo'],
  ['sweet potato', 'sakhar khand', 'sakharkhand', 'shakarkand'], ['onion', 'pyaj', 'pyaaj', 'pyaz'],
  ['spring onion', 'green onion', 'onion stalk', 'hariyo pyaj'], ['garlic', 'lasun', 'lahsun', 'lehsun'],
  ['ginger', 'aduwa', 'adrak'], ['tomato', 'golbheda', 'golveda', 'tamatar'],
  ['chilli', 'khursani', 'khorsani', 'mirch'], ['capsicum', 'bell pepper', 'bhede khursani', 'shimla mirch'],
  ['brinjal', 'eggplant', 'aubergine', 'bhanta', 'baingan'], ['okra', 'bhindi', 'ramtoriya', 'bhendi'],
  ['bitter gourd', 'karela', 'tite karela'], ['bottle gourd', 'lauka', 'lauki', 'ghiya'],
  ['sponge gourd', 'ghiraula', 'ghiraunla'], ['pumpkin', 'pharsi', 'kaddu'], ['chayote', 'iskus', 'cho cho'],
  ['cucumber', 'kakro', 'kheera', 'khira'], ['radish', 'mula', 'mooli'], ['carrot', 'gajar'],
  ['cabbage', 'banda', 'bandakobi', 'band gobi', 'patta gobi'],
  ['cauliflower', 'kauli', 'phul kobi', 'phulkobi', 'phool gobi', 'cauli'], ['spinach', 'palungo', 'palak'],
  ['mustard leaf', 'mustard green', 'rayo', 'sarson'], ['fenugreek', 'methi'],
  ['coriander', 'dhaniya', 'dhania', 'cilantro'], ['mint', 'pudina'], ['bamboo shoot', 'tama'],
  ['colocasia', 'pidalu', 'karkalo', 'arbi', 'taro'], ['yam', 'tarul'], ['mushroom', 'chyau', 'chyaau'],
  ['stinging nettle', 'sisnu', 'nettle'], ['asparagus', 'kurilo'], ['jackfruit', 'katahar', 'kathar'],
  ['turmeric', 'besar', 'haldi'], ['cumin', 'jeera', 'jira'], ['black pepper', 'marich', 'kali mirch'],
  ['cardamom', 'alaichi', 'elaichi', 'sukmel'], ['clove', 'lwang', 'laung'], ['cinnamon', 'dalchini'],
  ['ajwain', 'jwano', 'omum', 'carom'], ['asafoetida', 'hing'], ['aniseed', 'saunf', 'sounf', 'fennel'],
  ['sugar', 'chini', 'cheeni'], ['jaggery', 'gud', 'gur', 'sakhar'], ['honey', 'maha'],
  ['sesame', 'til'], ['groundnut', 'peanut', 'badam', 'mungfali'], ['cashew', 'kaju'],
  ['walnut', 'okhar', 'akhrot'], ['coconut', 'nariwal', 'nariyal'],
  ['banana', 'kera', 'kela'], ['apple', 'syau', 'seb'], ['orange', 'suntala', 'santra'],
  ['mango', 'aanp', 'aap', 'aam'], ['papaya', 'mewa', 'papita'], ['guava', 'amba', 'amrud'],
  ['pineapple', 'bhuikatahar', 'ananas'], ['pomegranate', 'anar', 'anaar'], ['pear', 'naspati', 'nashpati'],
  ['lemon', 'lime', 'kagati', 'nibuwa', 'nimbu'], ['grape', 'angur'], ['watermelon', 'tarbuja', 'tarbuj'],
  ['litchi', 'lichi', 'lychee'], ['tea', 'chiya', 'chai'], ['oil', 'tel'],
  ['jalebi', 'jeri'], ['pakoda', 'pakora', 'pakauda'], ['sel roti', 'sel'], ['dhindo', 'dhido'],
  ['momo', 'dumpling'], ['samosa', 'singada'], ['papad', 'papadum', 'pappadam'],
]

// Units, pack sizes and shop words in an item name, never part of a food's identity.
const NOISE = new Set(['kg', 'kgs', 'gm', 'gms', 'g', 'ltr', 'lt', 'l', 'litre', 'liter', 'ml', 'pcs', 'pc',
  'pkt', 'pkts', 'packet', 'pack', 'btl', 'bottle', 'box', 'can', 'tin', 'jar', 'bag', 'sack', 'dozen', 'doz',
  'nos', 'local', 'imported', 'premium', 'grade', 'quality', 'brand', 'best'])
// Words with no meaning on their own in a food name.
const STOP = new Set(['and', 'of', 'the', 'with', 'without', 'in', 'a', 'an', 'for', 'ko', 'ka', 'ki', 'mix'])
// State and colour words rank one food above another but never make a food a match alone:
// "FRESH CREAM" must not suggest "Apricot, fresh".
const GENERIC = new Set(['raw', 'fresh', 'dry', 'whole', 'cooked', 'boiled', 'fried', 'roasted', 'ripe', 'meat', 'flesh', 'muscle',
  'tender', 'green', 'red', 'white', 'black', 'brown', 'yellow', 'pink', 'big', 'small', 'large', 'medium',
  'light', 'dark', 'pale', 'powder', 'flour', 'leaf', 'seed', 'stem', 'flower', 'juice', 'variety', 'india', 'thai'])
// A single bracketed word that only qualifies the food ("(raw)", "(Thai)"); any other bracketed
// word is another name for it ("(dahi)", "(iskus)") and is searched as one.
const QUALIFIER = new Set([...GENERIC, 'dal', 'milled', 'refined', 'lean', 'korea', 'china', 'nes', 'skinless',
  'boneless', 'coiled', 'snack', 'sliced', 'smoked'])
const RESPELL = { dried: 'dry', leaves: 'leaf', chillies: 'chilli', chilly: 'chilli', chillie: 'chilli',
  chili: 'chilli', yoghurt: 'yogurt', momos: 'momo' }

function stem(w) {
  if (RESPELL[w]) return RESPELL[w]
  if (w.length > 4 && w.endsWith('ies')) return w.slice(0, -3) + 'y'
  if (w.length > 4 && /(?:ches|shes|xes|oes)$/.test(w)) return w.slice(0, -2)
  if (w.length > 3 && w.endsWith('s') && !/(?:ss|us|is)$/.test(w)) return w.slice(0, -1)
  return w
}

// A food name or an item name → its words: lowercased, respelled, stemmed, without units.
export function foodWords(text) {
  let t = String(text || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ')
  SPELLINGS.forEach(([re, to]) => { t = t.replace(re, to) })
  return t.split(' ').filter(w => w && !/^\d/.test(w) && !NOISE.has(w)).map(stem)
}

const SAME_FOOD_WORDS = SAME_FOOD.map(set => set.map(p => foodWords(p)))

function runAt(words, run) {
  for (let i = 0; i + run.length <= words.length; i++) {
    if (run.every((w, k) => words[i + k] === w)) return i
  }
  return -1
}

// An item name or a typed search → its words, every word with what it may also mean, and the set
// of both together.
function itemTerms(text) {
  const base = foodWords(text).filter(w => !STOP.has(w))
  const all = new Set(base)
  const alts = new Map(base.map(w => [w, new Set([w])]))
  // word → the typed words it stands for, so "chow mein" added for NOODLES still counts as one word
  const owner = new Map()
  SAME_FOOD_WORDS.forEach(set => {
    for (const member of set) {
      const at = runAt(base, member)
      if (at < 0) continue
      const added = set.flat()
      added.forEach(w => all.add(w))
      member.forEach((_, k) => added.forEach(w => alts.get(base[at + k]).add(w)))
      break
    }
  })
  alts.forEach((meant, b) => meant.forEach(w => owner.set(w, (owner.get(w) || new Set()).add(b))))
  return { base, all, alts, owner }
}

// A food's names, for matching: its main name ("Buffalo meat" in "Buffalo meat (buff) (lean)") and
// that name's last word are what it IS; a bracketed other name, a USDA keyword and an Indian
// table's local name are what it is also called. Everything else qualifies it.
function prepareRow(row) {
  const name = String(row.name || '')
  const main = foodWords(name.split(/[,(:]/)[0]).filter(w => !STOP.has(w))
  const heads = []
  const mods = new Set()
  if (main.length) {
    heads.push(main)
    if (main.length > 1) heads.push([main[main.length - 1]])
    main.slice(0, -1).forEach(w => mods.add(w))
  }
  for (const m of name.matchAll(/\(([^)]*)\)/g)) {
    const ws = foodWords(m[1]).filter(w => !STOP.has(w))
    if (ws.length === 1 && !QUALIFIER.has(ws[0])) heads.push(ws)
    else ws.forEach(w => mods.add(w))
  }
  foodWords(name.replace(/\([^)]*\)/g, ' ').split(/[,:]/).slice(1).join(' '))
    .filter(w => !STOP.has(w)).forEach(w => mods.add(w))
  for (const phrase of [...(row.match || []), ...String(row.local || '').split(';')]) {
    const ws = foodWords(phrase).filter(w => !STOP.has(w))
    if (ws.length) heads.push(ws)
  }
  // The main name's own words stay qualifiers ("duck" in "Duck meat"); only a word that is a name
  // of the food on its own ("chiura") leaves them, never one inside a longer name ("beaten rice").
  const ownNames = new Set(heads.filter(h => h.length === 1).flat())
  const modList = [...mods].filter(w => !ownNames.has(w))
  const words = [...new Set([...heads.flat(), ...modList])]
  return {
    ...row, _heads: heads, _mods: modList, _words: words,
    // "duck" in "Duck meat": a word of the main name that says WHICH food; missing it costs more.
    _mainMods: new Set(main.slice(0, -1)),
    // What the food is called or filed under, for "does it answer every food the item names".
    _known: new Set([...words, ...foodWords(row.group)]),
  }
}

// How well a food answers an item. A name of the food found whole in the item scores 10 for each
// word the item typed that it covers. Each qualifier the item shares adds 4; each it lacks costs 1,
// or 5 for a word of the food's main name ("Mango ginger", "Cooked rice" for RICE). Each food the
// ITEM names that the food is not costs 6, so OAT MILK is not Buffalo milk. A match is STRONG
// (good enough to fill without a person picking) only when a name matched and the score stays
// above 5. A food sharing only a qualifier is a weak match, and only when that qualifier is not a
// state or colour word.
function scoreFood(row, terms, foodHeads) {
  const { base, all, alts, owner } = terms
  let head = 0
  row._heads.forEach(h => {
    if (!h.every(w => all.has(w))) return
    const typed = new Set(h.flatMap(w => [...(owner.get(w) || [])]))
    head = Math.max(head, 10 * typed.size)
  })
  let score = head
  let real = 0
  row._mods.forEach(m => {
    if (all.has(m)) {
      score += 4
      if (!GENERIC.has(m)) real++
    } else {
      score -= row._mainMods.has(m) ? 5 : 1
    }
  })
  if (!head && !real) return { score: 0, strong: false }
  base.forEach(b => {
    const meant = [...alts.get(b)]
    if (meant.some(w => GENERIC.has(w)) || !meant.some(w => foodHeads.has(w))) return
    if (!meant.some(w => row._known.has(w))) score -= 6
  })
  return { score: Math.max(1, score), strong: head > 0 && score > 5 }
}

function bySource(a, b) {
  return (SOURCE_ORDER[a.row.source] ?? 9) - (SOURCE_ORDER[b.row.source] ?? 9)
}

// ── Loading ────────────────────────────────────────────────────────────────────────────────────
let libraryPromise = null

// The whole library (USDA rows + both regional tables), ready to search: { rows, heads }, where
// heads is every word that names a food. The tables are their own chunk, fetched on first use and
// kept; a failed fetch is not kept, so the next press retries.
export function loadLibrary() {
  if (!libraryPromise) {
    libraryPromise = import(/* webpackChunkName: "food-tables" */ './foodTables.json')
      .then(m => {
        const tables = m.default || m
        const named = tables.filter(r => REGIONAL_KITCHEN_NAMES[r.id])
          .map(r => ({ ...r, match: [...(r.match || []), ...REGIONAL_KITCHEN_NAMES[r.id]] }))
        const rest = tables.filter(r => !REGIONAL_KITCHEN_NAMES[r.id])
        const rows = [...NUTRITION_SEED, ...named, ...rest].map(prepareRow)
        return { rows, heads: new Set(rows.flatMap(r => r._heads.flat())) }
      })
      .catch(err => { libraryPromise = null; throw err })
  }
  return libraryPromise
}

// ── Matching ───────────────────────────────────────────────────────────────────────────────────
// Library foods for an ingredient's name, best first: strong matches, then score, then regional
// sources first, then table order. `strongOnly` is for a fill nobody picks by hand (Recipes'
// auto-fill): a food that shares only a qualifier with the name is never taken on a guess.
export function suggestSeeds(library, itemName, { limit = 6, strongOnly = false, source = null } = {}) {
  const terms = itemTerms(itemName)
  if (!terms.all.size) return []
  const scored = []
  library.rows.forEach(row => {
    if (source && row.source !== source) return
    const s = scoreFood(row, terms, library.heads)
    if (s.score && (s.strong || !strongOnly)) scored.push({ row, ...s })
  })
  scored.sort((a, b) => (b.strong - a.strong) || (b.score - a.score) || bySource(a, b))
  return scored.slice(0, limit).map(s => s.row)
}

// The picker's search box: foods of one source whose names hold every typed word, where a word
// may be the start of a name ("chick") or a kitchen name for it ("kukhura"). Falls back to the
// looser suggestion match when nothing holds every word (an item name full of shop words).
export function searchLibrary(library, query, source, limit = 12) {
  const terms = itemTerms(query)
  if (!terms.base.length) return []
  const found = []
  library.rows.forEach(row => {
    if (source && row.source !== source) return
    const every = terms.base.every(t => [...terms.alts.get(t)].some(a =>
      a === t ? row._words.some(w => w.startsWith(t)) : row._words.includes(a)))
    if (!every) return
    const headStart = terms.base.some(t => row._heads.some(h => h.some(w => w.startsWith(t))))
    found.push({ row, headStart, ...scoreFood(row, terms, library.heads) })
  })
  if (!found.length) return suggestSeeds(library, query, { limit, source })
  found.sort((a, b) => (b.strong - a.strong) || (b.headStart - a.headStart) || (b.score - a.score)
    || (a.row.name.length - b.row.name.length))
  return found.slice(0, limit).map(s => s.row)
}

// ── Applying a pick ────────────────────────────────────────────────────────────────────────────
// The basis a pick is saved on follows the INGREDIENT, not the food: per 100 g for an item
// weighed in KG/GM, per 100 ml for one in LTR/ML (a per-100 g figure read as per 100 ml, as the
// library always has for liquids), the food's own unit for a counted item, which then needs the
// weight of one piece. A GM basis on a LTR item is never converted and reads as nearly nothing.
export function basisUnitFor(uom, row) {
  const unit = defaultBasisUnit(uom)
  return unit === 'GM' || unit === 'ML' ? unit : (row?.unit || 'GM')
}

// A food's figures: null where its table has none (a Nepal food's sugar and sodium when the Indian
// table has no same food), never 0.
export function seedFigures(row) {
  const out = {}
  NUTRIENTS.forEach(d => { out[d.key] = row?.[d.key] ?? null })
  return out
}

// What items.nutrition.source says about a pick: the table, the food and where it is printed.
export function seedSourceText(row) {
  if (!row) return ''
  if (!row.ref) return row.source
  return `${row.source}: ${row.name} (${row.ref})`
    + (row.borrowed ? `; sugar and sodium from IFCT 2017: ${row.borrowed}` : '')
}
