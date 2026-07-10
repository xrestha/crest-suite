// Reference nutrition library for common Nepal F&B ingredients, multi-source.
//
// Each row carries a `source`: 'USDA' (US, FoodData Central), 'IFCT 2017' (Indian Food
// Composition Tables, NIN Hyderabad), or 'DFTQC Nepal' (Food Composition Table for Nepal,
// Dept. of Food Technology & Quality Control). Several staples appear under more than one
// source — the same `match` keyword surfaces all variants so the user can pick the most
// relevant (regional values are listed first in suggestions).
//
// Values are per 100 g (raw, unless noted) and ROUNDED. They are ESTIMATES transcribed from
// published tables — clients should verify/override for branded or prepared items.
//
// Row: { name, match:[lowercase keywords], unit:'GM'|'ML', source,
//        energy_kcal, protein_g, carbs_g, fat_g, sugar_g, sodium_mg, allergens }

export const NUTRITION_SEED = [
  // ════════════════════════ USDA (FoodData Central) ════════════════════════
  // ── Grains, flours, rice ──
  { name: 'Rice (white, raw)',      match: ['rice', 'chamal', 'basmati'], unit: 'GM', source: 'USDA', energy_kcal: 360, protein_g: 6.6, carbs_g: 79, fat_g: 0.6, sugar_g: 0.1, sodium_mg: 1, allergens: '' },
  { name: 'Rice (brown, raw)',      match: ['brown rice'], unit: 'GM', source: 'USDA', energy_kcal: 370, protein_g: 7.9, carbs_g: 77, fat_g: 2.9, sugar_g: 0.7, sodium_mg: 4, allergens: '' },
  { name: 'Beaten rice (chiura)',   match: ['chiura', 'beaten rice', 'poha'], unit: 'GM', source: 'USDA', energy_kcal: 350, protein_g: 6.6, carbs_g: 77, fat_g: 1.2, sugar_g: 0.5, sodium_mg: 5, allergens: '' },
  { name: 'Wheat flour (maida)',    match: ['maida', 'wheat flour', 'flour', 'pitho'], unit: 'GM', source: 'USDA', energy_kcal: 364, protein_g: 10, carbs_g: 76, fat_g: 1, sugar_g: 0.3, sodium_mg: 2, allergens: 'gluten' },
  { name: 'Whole wheat flour (atta)', match: ['atta', 'whole wheat', 'gahu'], unit: 'GM', source: 'USDA', energy_kcal: 340, protein_g: 13, carbs_g: 72, fat_g: 2.5, sugar_g: 0.4, sodium_mg: 2, allergens: 'gluten' },
  { name: 'Gram flour (besan)',     match: ['besan', 'gram flour', 'chickpea flour'], unit: 'GM', source: 'USDA', energy_kcal: 387, protein_g: 22, carbs_g: 58, fat_g: 6.7, sugar_g: 11, sodium_mg: 64, allergens: '' },
  { name: 'Cornflour / cornstarch', match: ['cornflour', 'cornstarch', 'corn flour'], unit: 'GM', source: 'USDA', energy_kcal: 381, protein_g: 0.3, carbs_g: 91, fat_g: 0.1, sugar_g: 0, sodium_mg: 9, allergens: '' },
  { name: 'Semolina (suji)',        match: ['suji', 'semolina', 'rava'], unit: 'GM', source: 'USDA', energy_kcal: 360, protein_g: 13, carbs_g: 73, fat_g: 1.1, sugar_g: 0, sodium_mg: 1, allergens: 'gluten' },
  { name: 'Noodles (dry)',          match: ['noodle', 'chowmein', 'chow mein', 'wai wai'], unit: 'GM', source: 'USDA', energy_kcal: 380, protein_g: 9, carbs_g: 71, fat_g: 6, sugar_g: 2, sodium_mg: 700, allergens: 'gluten' },
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
  { name: 'Mutton / goat (raw)',    match: ['mutton', 'goat', 'khasi', 'boka'], unit: 'GM', source: 'USDA', energy_kcal: 143, protein_g: 27, carbs_g: 0, fat_g: 3, sugar_g: 0, sodium_mg: 82, allergens: '' },
  { name: 'Buff / buffalo (raw)',   match: ['buff', 'buffalo', 'rango'], unit: 'GM', source: 'USDA', energy_kcal: 130, protein_g: 26, carbs_g: 0, fat_g: 1.8, sugar_g: 0, sodium_mg: 70, allergens: '' },
  { name: 'Pork (raw)',             match: ['pork', 'bangur', 'sungur'], unit: 'GM', source: 'USDA', energy_kcal: 242, protein_g: 27, carbs_g: 0, fat_g: 14, sugar_g: 0, sodium_mg: 62, allergens: '' },
  { name: 'Fish (freshwater, raw)', match: ['fish', 'machha', 'rohu'], unit: 'GM', source: 'USDA', energy_kcal: 97, protein_g: 17, carbs_g: 0, fat_g: 2.8, sugar_g: 0, sodium_mg: 50, allergens: 'fish' },
  { name: 'Prawn / shrimp (raw)',   match: ['prawn', 'shrimp'], unit: 'GM', source: 'USDA', energy_kcal: 99, protein_g: 24, carbs_g: 0.2, fat_g: 0.3, sugar_g: 0, sodium_mg: 111, allergens: 'shellfish' },
  { name: 'Egg (whole)',            match: ['egg', 'anda', 'phul'], unit: 'GM', source: 'USDA', energy_kcal: 155, protein_g: 13, carbs_g: 1.1, fat_g: 11, sugar_g: 1.1, sodium_mg: 124, allergens: 'egg' },

  // ── Dairy ──
  { name: 'Milk (whole)',           match: ['milk', 'dudh'], unit: 'GM', source: 'USDA', energy_kcal: 61, protein_g: 3.2, carbs_g: 4.8, fat_g: 3.3, sugar_g: 5.1, sodium_mg: 43, allergens: 'dairy' },
  { name: 'Curd / yogurt (dahi)',   match: ['dahi', 'curd', 'yogurt', 'yoghurt'], unit: 'GM', source: 'USDA', energy_kcal: 61, protein_g: 3.5, carbs_g: 4.7, fat_g: 3.3, sugar_g: 4.7, sodium_mg: 46, allergens: 'dairy' },
  { name: 'Paneer / cheese (soft)', match: ['paneer', 'chenna'], unit: 'GM', source: 'USDA', energy_kcal: 265, protein_g: 18, carbs_g: 1.2, fat_g: 21, sugar_g: 1.2, sodium_mg: 22, allergens: 'dairy' },
  { name: 'Cheese (processed)',     match: ['cheese', 'cheddar'], unit: 'GM', source: 'USDA', energy_kcal: 402, protein_g: 25, carbs_g: 1.3, fat_g: 33, sugar_g: 0.5, sodium_mg: 621, allergens: 'dairy' },
  { name: 'Butter',                 match: ['butter', 'makhan'], unit: 'GM', source: 'USDA', energy_kcal: 717, protein_g: 0.9, carbs_g: 0.1, fat_g: 81, sugar_g: 0.1, sodium_mg: 11, allergens: 'dairy' },
  { name: 'Ghee / clarified butter', match: ['ghee', 'ghiu'], unit: 'GM', source: 'USDA', energy_kcal: 900, protein_g: 0, carbs_g: 0, fat_g: 100, sugar_g: 0, sodium_mg: 0, allergens: 'dairy' },
  { name: 'Cream',                  match: ['cream', 'malai'], unit: 'GM', source: 'USDA', energy_kcal: 340, protein_g: 2.1, carbs_g: 2.8, fat_g: 36, sugar_g: 2.9, sodium_mg: 27, allergens: 'dairy' },
  { name: 'Khuwa / mawa',           match: ['khuwa', 'mawa', 'khoa'], unit: 'GM', source: 'USDA', energy_kcal: 421, protein_g: 15, carbs_g: 25, fat_g: 31, sugar_g: 25, sodium_mg: 80, allergens: 'dairy' },

  // ── Oils & fats ──
  { name: 'Cooking oil (vegetable)', match: ['oil', 'tel', 'soybean oil', 'sunflower'], unit: 'GM', source: 'USDA', energy_kcal: 884, protein_g: 0, carbs_g: 0, fat_g: 100, sugar_g: 0, sodium_mg: 0, allergens: '' },
  { name: 'Mustard oil',            match: ['mustard oil', 'tori'], unit: 'GM', source: 'USDA', energy_kcal: 884, protein_g: 0, carbs_g: 0, fat_g: 100, sugar_g: 0, sodium_mg: 0, allergens: '' },
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
  { name: 'Capsicum / bell pepper', match: ['capsicum', 'bell pepper', 'khursani simi'], unit: 'GM', source: 'USDA', energy_kcal: 31, protein_g: 1, carbs_g: 6, fat_g: 0.3, sugar_g: 4.2, sodium_mg: 4, allergens: '' },
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
  { name: 'Acai pulp (unsweetened)', match: ['acai', 'açaí'], unit: 'GM', source: 'USDA', energy_kcal: 70, protein_g: 1, carbs_g: 4, fat_g: 5, sugar_g: 0, sodium_mg: 7, allergens: '' },
  { name: 'Strawberry',             match: ['strawberry'], unit: 'GM', source: 'USDA', energy_kcal: 32, protein_g: 0.7, carbs_g: 8, fat_g: 0.3, sugar_g: 4.9, sodium_mg: 1, allergens: '' },
  { name: 'Blueberry',              match: ['blueberry'], unit: 'GM', source: 'USDA', energy_kcal: 57, protein_g: 0.7, carbs_g: 14, fat_g: 0.3, sugar_g: 10, sodium_mg: 1, allergens: '' },
  { name: 'Granola',                match: ['granola', 'muesli'], unit: 'GM', source: 'USDA', energy_kcal: 471, protein_g: 10, carbs_g: 64, fat_g: 20, sugar_g: 25, sodium_mg: 26, allergens: 'gluten, tree nuts' },
  { name: 'Peanut butter',          match: ['peanut butter'], unit: 'GM', source: 'USDA', energy_kcal: 588, protein_g: 25, carbs_g: 20, fat_g: 50, sugar_g: 9, sodium_mg: 17, allergens: 'peanut' },
  { name: 'Chia seed',              match: ['chia'], unit: 'GM', source: 'USDA', energy_kcal: 486, protein_g: 17, carbs_g: 42, fat_g: 31, sugar_g: 0, sodium_mg: 16, allergens: '' },

  // ── Sugars & sweeteners ──
  { name: 'Sugar (white)',          match: ['sugar', 'chini', 'chinni'], unit: 'GM', source: 'USDA', energy_kcal: 387, protein_g: 0, carbs_g: 100, fat_g: 0, sugar_g: 100, sodium_mg: 1, allergens: '' },
  { name: 'Jaggery (gud/sakhar)',   match: ['jaggery', 'gud', 'sakhar', 'chaku'], unit: 'GM', source: 'USDA', energy_kcal: 383, protein_g: 0.4, carbs_g: 98, fat_g: 0.1, sugar_g: 97, sodium_mg: 30, allergens: '' },
  { name: 'Honey',                  match: ['honey', 'maha'], unit: 'GM', source: 'USDA', energy_kcal: 304, protein_g: 0.3, carbs_g: 82, fat_g: 0, sugar_g: 82, sodium_mg: 4, allergens: '' },

  // ── Nuts & seeds ──
  { name: 'Peanut / groundnut',     match: ['peanut', 'groundnut', 'badam'], unit: 'GM', source: 'USDA', energy_kcal: 567, protein_g: 26, carbs_g: 16, fat_g: 49, sugar_g: 4, sodium_mg: 18, allergens: 'peanut' },
  { name: 'Cashew',                 match: ['cashew', 'kaju'], unit: 'GM', source: 'USDA', energy_kcal: 553, protein_g: 18, carbs_g: 30, fat_g: 44, sugar_g: 6, sodium_mg: 12, allergens: 'tree nuts' },
  { name: 'Almond',                 match: ['almond', 'badam giri'], unit: 'GM', source: 'USDA', energy_kcal: 579, protein_g: 21, carbs_g: 22, fat_g: 50, sugar_g: 4.4, sodium_mg: 1, allergens: 'tree nuts' },
  { name: 'Walnut',                 match: ['walnut', 'okhar'], unit: 'GM', source: 'USDA', energy_kcal: 654, protein_g: 15, carbs_g: 14, fat_g: 65, sugar_g: 2.6, sodium_mg: 2, allergens: 'tree nuts' },
  { name: 'Sesame seed (til)',      match: ['sesame', 'til'], unit: 'GM', source: 'USDA', energy_kcal: 573, protein_g: 18, carbs_g: 23, fat_g: 50, sugar_g: 0.3, sodium_mg: 11, allergens: 'sesame' },

  // ── Spices & condiments ──
  { name: 'Salt',                   match: ['salt', 'nun'], unit: 'GM', source: 'USDA', energy_kcal: 0, protein_g: 0, carbs_g: 0, fat_g: 0, sugar_g: 0, sodium_mg: 38758, allergens: '' },
  { name: 'Turmeric (besar)',       match: ['turmeric', 'besar', 'haldi'], unit: 'GM', source: 'USDA', energy_kcal: 312, protein_g: 9.7, carbs_g: 67, fat_g: 3.3, sugar_g: 3.2, sodium_mg: 27, allergens: '' },
  { name: 'Cumin (jeera)',          match: ['cumin', 'jeera', 'jira'], unit: 'GM', source: 'USDA', energy_kcal: 375, protein_g: 18, carbs_g: 44, fat_g: 22, sugar_g: 2.3, sodium_mg: 168, allergens: '' },
  { name: 'Coriander (dhaniya)',    match: ['coriander', 'dhaniya'], unit: 'GM', source: 'USDA', energy_kcal: 298, protein_g: 12, carbs_g: 55, fat_g: 18, sugar_g: 0, sodium_mg: 35, allergens: '' },
  { name: 'Chilli powder',          match: ['chilli powder', 'chili powder', 'red chilli'], unit: 'GM', source: 'USDA', energy_kcal: 282, protein_g: 12, carbs_g: 50, fat_g: 14, sugar_g: 8, sodium_mg: 1640, allergens: '' },
  { name: 'Garam masala / mixed spice', match: ['masala', 'garam', 'mixed spice'], unit: 'GM', source: 'USDA', energy_kcal: 379, protein_g: 14, carbs_g: 45, fat_g: 15, sugar_g: 3, sodium_mg: 90, allergens: '' },
  { name: 'Black pepper',           match: ['pepper', 'marich'], unit: 'GM', source: 'USDA', energy_kcal: 251, protein_g: 10, carbs_g: 64, fat_g: 3.3, sugar_g: 0.6, sodium_mg: 20, allergens: '' },
  { name: 'Soy sauce',              match: ['soy sauce', 'soya sauce'], unit: 'GM', source: 'USDA', energy_kcal: 53, protein_g: 8, carbs_g: 4.9, fat_g: 0.6, sugar_g: 0.4, sodium_mg: 5493, allergens: 'soy, gluten' },
  { name: 'Tomato ketchup',         match: ['ketchup', 'tomato sauce'], unit: 'GM', source: 'USDA', energy_kcal: 101, protein_g: 1.3, carbs_g: 27, fat_g: 0.1, sugar_g: 22, sodium_mg: 907, allergens: '' },
  { name: 'Vinegar',                match: ['vinegar'], unit: 'GM', source: 'USDA', energy_kcal: 18, protein_g: 0, carbs_g: 0.9, fat_g: 0, sugar_g: 0.4, sodium_mg: 5, allergens: '' },
  { name: 'Mayonnaise',             match: ['mayonnaise', 'mayo'], unit: 'GM', source: 'USDA', energy_kcal: 680, protein_g: 1, carbs_g: 0.6, fat_g: 75, sugar_g: 0.6, sodium_mg: 635, allergens: 'egg' },
  { name: 'Tamarind (imli)',        match: ['tamarind', 'imli', 'titri'], unit: 'GM', source: 'USDA', energy_kcal: 239, protein_g: 2.8, carbs_g: 63, fat_g: 0.6, sugar_g: 39, sodium_mg: 28, allergens: '' },

  // ── Beverages ──
  { name: 'Tea leaves (dry)',       match: ['tea', 'chiya', 'chai patti'], unit: 'GM', source: 'USDA', energy_kcal: 1, protein_g: 0, carbs_g: 0.3, fat_g: 0, sugar_g: 0, sodium_mg: 3, allergens: '' },
  { name: 'Coffee (instant powder)', match: ['coffee', 'nescafe'], unit: 'GM', source: 'USDA', energy_kcal: 353, protein_g: 13, carbs_g: 75, fat_g: 0.5, sugar_g: 0, sodium_mg: 37, allergens: '' },
  { name: 'Cocoa powder',           match: ['cocoa', 'cacao'], unit: 'GM', source: 'USDA', energy_kcal: 228, protein_g: 20, carbs_g: 58, fat_g: 14, sugar_g: 1.8, sodium_mg: 21, allergens: '' },
  { name: 'Cola / soft drink',      match: ['cola', 'coke', 'soft drink', 'soda'], unit: 'ML', source: 'USDA', energy_kcal: 42, protein_g: 0, carbs_g: 11, fat_g: 0, sugar_g: 11, sodium_mg: 4, allergens: '' },
  { name: 'Orange juice',           match: ['orange juice', 'juice'], unit: 'ML', source: 'USDA', energy_kcal: 45, protein_g: 0.7, carbs_g: 10, fat_g: 0.2, sugar_g: 8.4, sodium_mg: 1, allergens: '' },

  // ════════════════ IFCT 2017 (Indian Food Composition Tables, NIN) ════════════════
  // Regionally accurate for South Asian staples; values per 100 g raw.
  { name: 'Rice (milled, raw) — IFCT',   match: ['rice', 'chamal', 'basmati'], unit: 'GM', source: 'IFCT 2017', energy_kcal: 356, protein_g: 7.9, carbs_g: 78, fat_g: 0.5, sugar_g: 0.1, sodium_mg: 1, allergens: '' },
  { name: 'Wheat flour, whole (atta) — IFCT', match: ['atta', 'whole wheat', 'gahu'], unit: 'GM', source: 'IFCT 2017', energy_kcal: 321, protein_g: 10.6, carbs_g: 64, fat_g: 1.5, sugar_g: 0, sodium_mg: 2, allergens: 'gluten' },
  { name: 'Refined wheat flour (maida) — IFCT', match: ['maida', 'wheat flour', 'flour'], unit: 'GM', source: 'IFCT 2017', energy_kcal: 348, protein_g: 11, carbs_g: 74, fat_g: 0.9, sugar_g: 0, sodium_mg: 2, allergens: 'gluten' },
  { name: 'Maize flour — IFCT',          match: ['maize', 'corn flour', 'makai'], unit: 'GM', source: 'IFCT 2017', energy_kcal: 334, protein_g: 8.8, carbs_g: 65, fat_g: 3.8, sugar_g: 0, sodium_mg: 5, allergens: '' },
  { name: 'Lentil red (masoor dal) — IFCT', match: ['masoor', 'dal', 'daal', 'lentil'], unit: 'GM', source: 'IFCT 2017', energy_kcal: 343, protein_g: 25, carbs_g: 59, fat_g: 1.5, sugar_g: 2, sodium_mg: 17, allergens: '' },
  { name: 'Pigeon pea (rahar/toor dal) — IFCT', match: ['rahar', 'toor', 'arhar', 'tur dal'], unit: 'GM', source: 'IFCT 2017', energy_kcal: 335, protein_g: 22, carbs_g: 58, fat_g: 1.7, sugar_g: 0, sodium_mg: 18, allergens: '' },
  { name: 'Green gram (mung/moong) — IFCT', match: ['mung', 'moong', 'green gram'], unit: 'GM', source: 'IFCT 2017', energy_kcal: 334, protein_g: 24, carbs_g: 56, fat_g: 1.2, sugar_g: 0, sodium_mg: 28, allergens: '' },
  { name: 'Black gram (maas/urad) — IFCT', match: ['maas', 'urad', 'black gram'], unit: 'GM', source: 'IFCT 2017', energy_kcal: 341, protein_g: 24, carbs_g: 59, fat_g: 1.6, sugar_g: 0, sodium_mg: 38, allergens: '' },
  { name: 'Chickpea (chana) — IFCT',     match: ['chana', 'chickpea', 'kabuli'], unit: 'GM', source: 'IFCT 2017', energy_kcal: 360, protein_g: 18, carbs_g: 60, fat_g: 5.3, sugar_g: 0, sodium_mg: 24, allergens: '' },
  { name: 'Soybean (bhatmas) — IFCT',    match: ['soybean', 'soya', 'bhatmas'], unit: 'GM', source: 'IFCT 2017', energy_kcal: 432, protein_g: 37, carbs_g: 21, fat_g: 19, sugar_g: 0, sodium_mg: 2, allergens: 'soy' },
  { name: 'Paneer — IFCT',               match: ['paneer', 'chenna'], unit: 'GM', source: 'IFCT 2017', energy_kcal: 290, protein_g: 18, carbs_g: 6, fat_g: 22, sugar_g: 6, sodium_mg: 22, allergens: 'dairy' },
  { name: 'Chicken (country/desi) — IFCT', match: ['chicken', 'kukhura'], unit: 'GM', source: 'IFCT 2017', energy_kcal: 166, protein_g: 26, carbs_g: 0, fat_g: 6.6, sugar_g: 0, sodium_mg: 70, allergens: '' },
  { name: 'Goat / mutton — IFCT',        match: ['mutton', 'goat', 'khasi', 'boka'], unit: 'GM', source: 'IFCT 2017', energy_kcal: 122, protein_g: 21, carbs_g: 0, fat_g: 3.6, sugar_g: 0, sodium_mg: 82, allergens: '' },
  { name: 'Hen egg, whole — IFCT',       match: ['egg', 'anda', 'phul'], unit: 'GM', source: 'IFCT 2017', energy_kcal: 173, protein_g: 13, carbs_g: 1.2, fat_g: 13, sugar_g: 0, sodium_mg: 124, allergens: 'egg' },
  { name: 'Jaggery (gud) — IFCT',        match: ['jaggery', 'gud', 'sakhar', 'chaku'], unit: 'GM', source: 'IFCT 2017', energy_kcal: 383, protein_g: 0.4, carbs_g: 95, fat_g: 0.1, sugar_g: 90, sodium_mg: 30, allergens: '' },
  { name: 'Bamboo shoot (tama) — IFCT',  match: ['bamboo', 'tama'], unit: 'GM', source: 'IFCT 2017', energy_kcal: 21, protein_g: 2.6, carbs_g: 3, fat_g: 0.3, sugar_g: 2, sodium_mg: 4, allergens: '' },
  { name: 'Colocasia / taro root (pidalu) — IFCT', match: ['taro', 'colocasia', 'pidalu', 'karkalo'], unit: 'GM', source: 'IFCT 2017', energy_kcal: 97, protein_g: 2.7, carbs_g: 21, fat_g: 0.1, sugar_g: 0, sodium_mg: 11, allergens: '' },
  { name: 'Fenugreek leaves (methi) — IFCT', match: ['fenugreek', 'methi'], unit: 'GM', source: 'IFCT 2017', energy_kcal: 49, protein_g: 4.4, carbs_g: 6, fat_g: 0.9, sugar_g: 0, sodium_mg: 76, allergens: '' },
  { name: 'Mustard greens (rayo saag) — IFCT', match: ['mustard green', 'rayo', 'saag'], unit: 'GM', source: 'IFCT 2017', energy_kcal: 34, protein_g: 4, carbs_g: 3.4, fat_g: 0.6, sugar_g: 0, sodium_mg: 25, allergens: '' },

  // ════════════════ DFTQC Nepal (Food Composition Table for Nepal) ════════════════
  // Nepal-specific items & local processing; values per 100 g unless noted.
  { name: 'Beaten rice (chiura) — Nepal', match: ['chiura', 'beaten rice', 'poha'], unit: 'GM', source: 'DFTQC Nepal', energy_kcal: 346, protein_g: 6.6, carbs_g: 77, fat_g: 1.2, sugar_g: 0, sodium_mg: 5, allergens: '' },
  { name: 'Buffalo milk — Nepal',        match: ['buffalo milk', 'milk', 'dudh'], unit: 'ML', source: 'DFTQC Nepal', energy_kcal: 117, protein_g: 4.3, carbs_g: 5, fat_g: 8.8, sugar_g: 5, sodium_mg: 40, allergens: 'dairy' },
  { name: 'Cow milk — Nepal',            match: ['cow milk', 'milk', 'dudh'], unit: 'ML', source: 'DFTQC Nepal', energy_kcal: 67, protein_g: 3.2, carbs_g: 4.4, fat_g: 4.1, sugar_g: 4.4, sodium_mg: 43, allergens: 'dairy' },
  { name: 'Curd, buffalo (dahi) — Nepal', match: ['dahi', 'curd', 'yogurt', 'yoghurt'], unit: 'GM', source: 'DFTQC Nepal', energy_kcal: 100, protein_g: 3.7, carbs_g: 4, fat_g: 7.5, sugar_g: 4, sodium_mg: 45, allergens: 'dairy' },
  { name: 'Buffalo meat (buff) — Nepal', match: ['buff', 'buffalo', 'rango'], unit: 'GM', source: 'DFTQC Nepal', energy_kcal: 131, protein_g: 19, carbs_g: 0, fat_g: 5.9, sugar_g: 0, sodium_mg: 70, allergens: '' },
  { name: 'Dried meat (sukuti) — Nepal', match: ['sukuti', 'dried meat'], unit: 'GM', source: 'DFTQC Nepal', energy_kcal: 313, protein_g: 55, carbs_g: 0, fat_g: 10, sugar_g: 0, sodium_mg: 600, allergens: '' },
  { name: 'Hard cheese (chhurpi) — Nepal', match: ['chhurpi', 'churpi', 'hard cheese'], unit: 'GM', source: 'DFTQC Nepal', energy_kcal: 360, protein_g: 56, carbs_g: 22, fat_g: 4, sugar_g: 0, sodium_mg: 70, allergens: 'dairy' },
  { name: 'Fermented dried greens (gundruk) — Nepal', match: ['gundruk', 'sinki'], unit: 'GM', source: 'DFTQC Nepal', energy_kcal: 105, protein_g: 9, carbs_g: 15, fat_g: 1, sugar_g: 0, sodium_mg: 50, allergens: '' },
  { name: 'Finger millet flour (kodo) — Nepal', match: ['kodo', 'millet', 'ragi', 'dhido'], unit: 'GM', source: 'DFTQC Nepal', energy_kcal: 320, protein_g: 7.3, carbs_g: 72, fat_g: 1.3, sugar_g: 0, sodium_mg: 11, allergens: '' },
  { name: 'Buckwheat flour (phapar) — Nepal', match: ['buckwheat', 'phapar'], unit: 'GM', source: 'DFTQC Nepal', energy_kcal: 335, protein_g: 13, carbs_g: 71, fat_g: 3.4, sugar_g: 0, sodium_mg: 1, allergens: '' },
  { name: 'Mustard oil — Nepal',         match: ['mustard oil', 'tori'], unit: 'ML', source: 'DFTQC Nepal', energy_kcal: 900, protein_g: 0, carbs_g: 0, fat_g: 100, sugar_g: 0, sodium_mg: 0, allergens: '' },
  { name: 'Ghee (clarified butter) — Nepal', match: ['ghee', 'ghiu'], unit: 'GM', source: 'DFTQC Nepal', energy_kcal: 900, protein_g: 0, carbs_g: 0, fat_g: 100, sugar_g: 0, sodium_mg: 0, allergens: 'dairy' },
  { name: 'Khuwa (mawa) — Nepal',        match: ['khuwa', 'mawa', 'khoa'], unit: 'GM', source: 'DFTQC Nepal', energy_kcal: 421, protein_g: 20, carbs_g: 25, fat_g: 26, sugar_g: 25, sodium_mg: 80, allergens: 'dairy' },
]

// Normalize an item name to lowercase words for matching.
function normalize(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\b(fresh|raw|dry|dried|powder|whole|local|imported|premium|grade|kg|gm|ltr|ml|pcs)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

// Source display order — regional first (most relevant for Nepal).
const SOURCE_ORDER = { 'DFTQC Nepal': 0, 'IFCT 2017': 1, 'USDA': 2 }

// All seed rows matching an item name, best keyword first, regional sources first on ties.
// Returns up to `limit` candidates so the UI can show source options.
export function suggestSeeds(itemName, limit = 6) {
  const norm = normalize(itemName)
  if (!norm) return []
  const scored = []
  NUTRITION_SEED.forEach(row => {
    let best = 0
    row.match.forEach(kw => { if (norm.includes(kw) && kw.length > best) best = kw.length })
    if (best > 0) scored.push({ row, score: best })
  })
  if (!scored.length) return []
  const top = Math.max(...scored.map(s => s.score))
  return scored
    .filter(s => s.score === top)
    .sort((a, b) => (SOURCE_ORDER[a.row.source] ?? 9) - (SOURCE_ORDER[b.row.source] ?? 9))
    .slice(0, limit)
    .map(s => s.row)
}

// Single best seed match (backward compatible) — first of suggestSeeds, or null.
export function suggestSeed(itemName) {
  return suggestSeeds(itemName, 1)[0] || null
}

// Matches restricted to one specific source, best keyword match first — unlike suggestSeeds
// (which only returns ties at the single best score across ALL sources, so a source with a
// merely-good match gets silently dropped if another source has a longer one), this always
// searches the chosen source on its own so a user who explicitly picks e.g. "DFTQC Nepal" sees
// everything that source has, not just whichever source happened to win the cross-source tie.
export function suggestSeedsForSource(itemName, source, limit = 6) {
  const norm = normalize(itemName)
  if (!norm) return []
  const scored = []
  NUTRITION_SEED.forEach(row => {
    if (row.source !== source) return
    let best = 0
    row.match.forEach(kw => { if (norm.includes(kw) && kw.length > best) best = kw.length })
    if (best > 0) scored.push({ row, score: best })
  })
  return scored.sort((a, b) => b.score - a.score).slice(0, limit).map(s => s.row)
}
