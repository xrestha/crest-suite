// The Bloom demo café: who it is, what it sells, what it buys and who works there.
// Everything here is made up. Rates are ex-VAT, per BASE unit (GM / ML / PCS), as items.rate stores them.

export const OWNER_ID = '9da932f6-00c5-4035-8bd5-32b2941828f1'          // Owner login "AA"
export const KTM_MANAGER_PROFILE = '344073ef-38eb-4b32-9d37-19c65d5e94f2' // existing POS manager PIN, renamed Sita Shrestha
export const GROUP_ID = '4a0a6b29-3e20-4076-9fc1-3862ff9ccc90'

export const BS_YEAR = 2083
export const MONTHS = [4, 5, 6, 7]         // Shrawan, Bhadra, Ashoj (+ Kartik, for a top-up after Ashoj ends)
export const FY = '83/84'

// The cut-off of the first full build (Ashoj 23, 17:15). Anything that would otherwise move when a
// top-up moves "today" is computed against this, so days already loaded never change.
export const BASE_CUTOFF = { ad: '2026-10-09', minutes: 1035 }

export const OUTLETS = {
  ktm: {
    key: 'ktm', clientId: 'a4bd5cba-4955-4309-819e-646834c05c7e', name: 'BLOOM CAFE',
    invoicePrefix: 'BC', open: 8 * 60, close: 20 * 60,
    billsPerDay: 31,            // ~NPR 35,000 a day at ~NPR 1,150 a bill (VAT incl.)
    maxPaidBillsPerMonth: 960,  // the Owner Report reads at most 1,000 paid bills a month (unpaged read)
    channel: [['dine', 72], ['takeaway', 17], ['delivery', 11]],
    pay: [['FonePay', 43], ['Cash', 33], ['Card', 9], ['eSewa', 6], ['Khalti', 3]],
    priceUplift: 1.0,
    monthFactor: { 4: 0.95, 5: 1.0, 6: 1.04, 7: 0.97 },
  },
  pkr: {
    key: 'pkr', clientId: 'ef7e5196-e1dc-4f9d-a259-6d994f0b1932', name: 'BLOOM CAFE - PKR',
    invoicePrefix: 'BP', open: 8 * 60, close: 21 * 60,
    billsPerDay: 19,            // ~NPR 20,000 a day
    maxPaidBillsPerMonth: 700,
    channel: [['dine', 84], ['takeaway', 11], ['delivery', 5]],
    pay: [['Cash', 34], ['FonePay', 30], ['Card', 27], ['eSewa', 6], ['Khalti', 3]],
    priceUplift: 1.05,          // supplies cost a little more in Pokhara (transport)
    monthFactor: { 4: 0.9, 5: 0.97, 6: 1.12, 7: 1.2 },   // tourist season picks up in Ashoj
  },
}

// ── Stock categories (Item Master's default list) ───────────────────────────────────────────────
export const CATEGORIES = ['Dairy & Bakery', 'Meats & Poultry', 'Groceries', 'Veg & Fruits', 'Beverage', 'Misc. Items']

// ── Suppliers ───────────────────────────────────────────────────────────────────────────────────
// kind decides the buying rhythm in build.mjs; pay: how the bill is paid.
export const VENDORS = {
  ktm: [
    { key: 'meat',    name: 'Sagarmatha Meat Suppliers',     contact: 'Bishnu Maharjan', phone: '9800011201', address: 'Kuleshwor, Kathmandu',   pan: '301456782', terms: 'Weekly credit',  pay: 'Credit' },
    { key: 'veg',     name: 'Kalimati Fresh Vegetables',     contact: 'Ram Krishna Shrestha', phone: '9800011202', address: 'Kalimati, Kathmandu', pan: '301456790', terms: 'Cash on delivery', pay: 'Cash' },
    { key: 'dairy',   name: 'Shree Ganesh Dairy',            contact: 'Ganesh Khadka',   phone: '9800011203', address: 'Sanepa, Lalitpur',       pan: '601234578', terms: 'Monthly credit', pay: 'Credit' },
    { key: 'grocery', name: 'Om Shanti Traders',             contact: 'Suresh Agrawal',  phone: '9800011204', address: 'Ason, Kathmandu',        pan: '601234596', terms: '30 days credit', pay: 'Credit' },
    { key: 'coffee',  name: 'Mountain Bean Coffee Roasters', contact: 'Prabin Lama',     phone: '9800011205', address: 'Thamel, Kathmandu',      pan: '609871236', terms: 'Monthly credit', pay: 'Credit' },
    { key: 'bakery',  name: 'Fresh Oven Bakery',             contact: 'Sabina Joshi',    phone: '9800011206', address: 'Jhamsikhel, Lalitpur',   pan: '301456811', terms: 'Cash on delivery', pay: 'Cash' },
  ],
  pkr: [
    { key: 'meat',    name: 'Lakeside Meat Center',          contact: 'Dil Bahadur Gurung', phone: '9800022101', address: 'Lakeside-6, Pokhara', pan: '302566781', terms: 'Weekly credit',  pay: 'Credit' },
    { key: 'veg',     name: 'Phewa Fresh Vegetables',        contact: 'Hem Kumari Thapa', phone: '9800022102', address: 'Bagar, Pokhara',        pan: '302566799', terms: 'Cash on delivery', pay: 'Cash' },
    { key: 'dairy',   name: 'Fewa Dairy Udhyog',             contact: 'Tek Bahadur KC',  phone: '9800022103', address: 'Prithvi Chowk, Pokhara', pan: '602345187', terms: 'Monthly credit', pay: 'Credit' },
    { key: 'grocery', name: 'Machhapuchhre Traders',         contact: 'Rabin Shrestha',  phone: '9800022104', address: 'Chipledhunga, Pokhara',  pan: '602345195', terms: '30 days credit', pay: 'Credit' },
    { key: 'coffee',  name: 'Mountain Bean Coffee Roasters', contact: 'Prabin Lama',     phone: '9800011205', address: 'Thamel, Kathmandu',      pan: '609871236', terms: 'Monthly credit', pay: 'Credit' },
    { key: 'bakery',  name: 'Lakeside Bakery House',         contact: 'Anita Poudel',    phone: '9800022106', address: 'Lakeside-6, Pokhara',    pan: '302566823', terms: 'Cash on delivery', pay: 'Cash' },
  ],
}

// ── Stock items ─────────────────────────────────────────────────────────────────────────────────
// rate: NPR per base unit before VAT. pu/cf: how the supplier sells it (display + bill rounding).
// vat: the supplier charges 13% VAT on it. yield: usable % (recipe lines are divided by it).
// step: smallest amount bought (base units). cover: days of stock the café keeps.
export const ITEMS = [
  // Meats & Poultry
  { code: 'ITM-001', name: 'CHICKEN BONELESS',     uom: 'GM',  rate: 0.62,  pu: 'KG', cf: 1000, cat: 'Meats & Poultry', vendor: 'meat',    vat: false, step: 1000, cover: 3 },
  { code: 'ITM-002', name: 'CHICKEN KEEMA',        uom: 'GM',  rate: 0.56,  pu: 'KG', cf: 1000, cat: 'Meats & Poultry', vendor: 'meat',    vat: false, step: 1000, cover: 3 },
  { code: 'ITM-003', name: 'CHICKEN CURRY CUT',    uom: 'GM',  rate: 0.45,  pu: 'KG', cf: 1000, cat: 'Meats & Poultry', vendor: 'meat',    vat: false, step: 1000, cover: 3, yield: 90 },
  { code: 'ITM-004', name: 'EGGS',                 uom: 'PCS', rate: 16,    pu: 'TRAY', cf: 30, cat: 'Meats & Poultry', vendor: 'meat',    vat: false, step: 30,   cover: 6 },
  // Dairy & Bakery
  { code: 'ITM-005', name: 'MILK',                 uom: 'ML',  rate: 0.11,  pu: 'LTR', cf: 1000, cat: 'Dairy & Bakery', vendor: 'dairy',   vat: false, step: 1000, cover: 3 },
  { code: 'ITM-006', name: 'BUTTER',               uom: 'GM',  rate: 1.10,  pu: 'KG', cf: 1000, cat: 'Dairy & Bakery',  vendor: 'dairy',   vat: true,  step: 500,  cover: 10 },
  { code: 'ITM-007', name: 'MOZZARELLA CHEESE',    uom: 'GM',  rate: 1.10,  pu: 'KG', cf: 1000, cat: 'Dairy & Bakery',  vendor: 'dairy',   vat: true,  step: 1000, cover: 6 },
  { code: 'ITM-008', name: 'CHEESE SLICE',         uom: 'PCS', rate: 22,    pu: 'PKT', cf: 10,  cat: 'Dairy & Bakery',  vendor: 'dairy',   vat: true,  step: 10,   cover: 6 },
  { code: 'ITM-009', name: 'BURGER BUN',           uom: 'PCS', rate: 25,    cat: 'Dairy & Bakery', vendor: 'bakery', vat: false, step: 6,  cover: 1.5 },
  { code: 'ITM-010', name: 'SANDWICH BREAD SLICE', uom: 'PCS', rate: 7,     pu: 'LOAF', cf: 16, cat: 'Dairy & Bakery', vendor: 'bakery', vat: false, step: 16, cover: 1.5 },
  { code: 'ITM-011', name: 'PIZZA BASE 10 INCH',   uom: 'PCS', rate: 60,    cat: 'Dairy & Bakery', vendor: 'bakery', vat: false, step: 5,  cover: 1.5 },
  // Veg & Fruits
  { code: 'ITM-012', name: 'CABBAGE',              uom: 'GM',  rate: 0.06,  pu: 'KG', cf: 1000, cat: 'Veg & Fruits', vendor: 'veg', vat: false, step: 1000, cover: 3 },
  { code: 'ITM-013', name: 'ONION',                uom: 'GM',  rate: 0.09,  pu: 'KG', cf: 1000, cat: 'Veg & Fruits', vendor: 'veg', vat: false, step: 1000, cover: 4 },
  { code: 'ITM-014', name: 'TOMATO',               uom: 'GM',  rate: 0.08,  pu: 'KG', cf: 1000, cat: 'Veg & Fruits', vendor: 'veg', vat: false, step: 1000, cover: 3 },
  { code: 'ITM-015', name: 'GARLIC',               uom: 'GM',  rate: 0.28,  pu: 'KG', cf: 1000, cat: 'Veg & Fruits', vendor: 'veg', vat: false, step: 500,  cover: 7 },
  { code: 'ITM-016', name: 'GINGER',               uom: 'GM',  rate: 0.22,  pu: 'KG', cf: 1000, cat: 'Veg & Fruits', vendor: 'veg', vat: false, step: 500,  cover: 7 },
  { code: 'ITM-017', name: 'CORIANDER',            uom: 'GM',  rate: 0.25,  pu: 'KG', cf: 1000, cat: 'Veg & Fruits', vendor: 'veg', vat: false, step: 250,  cover: 2 },
  { code: 'ITM-018', name: 'CARROT',               uom: 'GM',  rate: 0.09,  pu: 'KG', cf: 1000, cat: 'Veg & Fruits', vendor: 'veg', vat: false, step: 1000, cover: 4 },
  { code: 'ITM-019', name: 'CAPSICUM',             uom: 'GM',  rate: 0.20,  pu: 'KG', cf: 1000, cat: 'Veg & Fruits', vendor: 'veg', vat: false, step: 500,  cover: 3 },
  { code: 'ITM-020', name: 'POTATO',               uom: 'GM',  rate: 0.06,  pu: 'KG', cf: 1000, cat: 'Veg & Fruits', vendor: 'veg', vat: false, step: 1000, cover: 5, yield: 85 },
  { code: 'ITM-021', name: 'LETTUCE',              uom: 'GM',  rate: 0.25,  pu: 'KG', cf: 1000, cat: 'Veg & Fruits', vendor: 'veg', vat: false, step: 500,  cover: 2 },
  { code: 'ITM-022', name: 'LEMON',                uom: 'PCS', rate: 12,    cat: 'Veg & Fruits', vendor: 'veg', vat: false, step: 10, cover: 3 },
  { code: 'ITM-023', name: 'GREEN CHILLI',         uom: 'GM',  rate: 0.20,  pu: 'KG', cf: 1000, cat: 'Veg & Fruits', vendor: 'veg', vat: false, step: 250,  cover: 4 },
  { code: 'ITM-024', name: 'SPRING ONION',         uom: 'GM',  rate: 0.16,  pu: 'KG', cf: 1000, cat: 'Veg & Fruits', vendor: 'veg', vat: false, step: 250,  cover: 2 },
  { code: 'ITM-025', name: 'MINT',                 uom: 'GM',  rate: 0.30,  pu: 'KG', cf: 1000, cat: 'Veg & Fruits', vendor: 'veg', vat: false, step: 100,  cover: 2 },
  { code: 'ITM-026', name: 'SPINACH (SAAG)',       uom: 'GM',  rate: 0.10,  pu: 'KG', cf: 1000, cat: 'Veg & Fruits', vendor: 'veg', vat: false, step: 1000, cover: 2 },
  { code: 'ITM-027', name: 'CUCUMBER',             uom: 'GM',  rate: 0.08,  pu: 'KG', cf: 1000, cat: 'Veg & Fruits', vendor: 'veg', vat: false, step: 1000, cover: 3 },
  // Groceries
  { code: 'ITM-028', name: 'MAIDA FLOUR',          uom: 'GM',  rate: 0.075, pu: 'KG', cf: 1000, cat: 'Groceries', vendor: 'grocery', vat: true,  step: 5000, cover: 10 },
  { code: 'ITM-029', name: 'BASMATI RICE',         uom: 'GM',  rate: 0.16,  pu: 'KG', cf: 1000, cat: 'Groceries', vendor: 'grocery', vat: false, step: 5000, cover: 10 },
  { code: 'ITM-030', name: 'MASOOR DAL',           uom: 'GM',  rate: 0.17,  pu: 'KG', cf: 1000, cat: 'Groceries', vendor: 'grocery', vat: false, step: 1000, cover: 10 },
  { code: 'ITM-031', name: 'CHOWMEIN NOODLES',     uom: 'GM',  rate: 0.18,  pu: 'KG', cf: 1000, cat: 'Groceries', vendor: 'grocery', vat: true,  step: 2000, cover: 10 },
  { code: 'ITM-032', name: 'SUNFLOWER OIL',        uom: 'ML',  rate: 0.26,  pu: 'LTR', cf: 1000, cat: 'Groceries', vendor: 'grocery', vat: true,  step: 5000, cover: 10 },
  { code: 'ITM-033', name: 'SALT',                 uom: 'GM',  rate: 0.03,  pu: 'KG', cf: 1000, cat: 'Groceries', vendor: 'grocery', vat: false, step: 1000, cover: 14 },
  { code: 'ITM-034', name: 'SUGAR',                uom: 'GM',  rate: 0.11,  pu: 'KG', cf: 1000, cat: 'Groceries', vendor: 'grocery', vat: false, step: 5000, cover: 10 },
  { code: 'ITM-035', name: 'SOY SAUCE',            uom: 'ML',  rate: 0.30,  pu: 'LTR', cf: 1000, cat: 'Groceries', vendor: 'grocery', vat: true,  step: 1000, cover: 14 },
  { code: 'ITM-036', name: 'TOMATO KETCHUP',       uom: 'GM',  rate: 0.28,  pu: 'KG', cf: 1000, cat: 'Groceries', vendor: 'grocery', vat: true,  step: 1000, cover: 10 },
  { code: 'ITM-037', name: 'MAYONNAISE',           uom: 'GM',  rate: 0.52,  pu: 'KG', cf: 1000, cat: 'Groceries', vendor: 'grocery', vat: true,  step: 1000, cover: 10 },
  { code: 'ITM-038', name: 'MOMO MASALA',          uom: 'GM',  rate: 0.90,  pu: 'KG', cf: 1000, cat: 'Groceries', vendor: 'grocery', vat: true,  step: 500,  cover: 20 },
  { code: 'ITM-039', name: 'CURRY SPICE MIX',      uom: 'GM',  rate: 0.80,  pu: 'KG', cf: 1000, cat: 'Groceries', vendor: 'grocery', vat: true,  step: 500,  cover: 20 },
  { code: 'ITM-040', name: 'TOMATO PUREE',         uom: 'GM',  rate: 0.26,  pu: 'KG', cf: 1000, cat: 'Groceries', vendor: 'grocery', vat: true,  step: 1000, cover: 10 },
  { code: 'ITM-041', name: 'OREGANO',              uom: 'GM',  rate: 2.50,  pu: 'KG', cf: 1000, cat: 'Groceries', vendor: 'grocery', vat: true,  step: 100,  cover: 25 },
  { code: 'ITM-042', name: 'TIMUR',                uom: 'GM',  rate: 2.00,  pu: 'KG', cf: 1000, cat: 'Groceries', vendor: 'grocery', vat: false, step: 100,  cover: 25 },
  // Beverage
  { code: 'ITM-045', name: 'COFFEE BEANS ESPRESSO', uom: 'GM', rate: 2.40,  pu: 'KG', cf: 1000, cat: 'Beverage', vendor: 'coffee', vat: true,  step: 1000, cover: 12 },
  { code: 'ITM-046', name: 'OAT MILK',             uom: 'ML',  rate: 0.45,  pu: 'LTR', cf: 1000, cat: 'Beverage', vendor: 'coffee', vat: true,  step: 1000, cover: 12 },
  { code: 'ITM-047', name: 'CTC TEA',              uom: 'GM',  rate: 0.60,  pu: 'KG', cf: 1000, cat: 'Beverage', vendor: 'grocery', vat: false, step: 1000, cover: 14 },
  { code: 'ITM-048', name: 'TEA MASALA',           uom: 'GM',  rate: 1.80,  pu: 'KG', cf: 1000, cat: 'Beverage', vendor: 'grocery', vat: true,  step: 250,  cover: 20 },
  { code: 'ITM-049', name: 'SODA WATER',           uom: 'ML',  rate: 0.13,  pu: 'BTL', cf: 300,  cat: 'Beverage', vendor: 'grocery', vat: true,  step: 3600, cover: 7 },
]

// ── Kitchen preparations (sub-recipes), quantities per batch ────────────────────────────────────
export const SUB_RECIPES = [
  { code: 'SRC-001', name: 'Chicken Momo Filling', yieldQty: 2000, yieldUom: 'GM', lines: [
    ['ITM-002', 1400], ['ITM-013', 300], ['ITM-012', 200], ['ITM-015', 30], ['ITM-016', 30],
    ['ITM-017', 20], ['ITM-038', 15], ['ITM-033', 15], ['ITM-032', 40]] },
  { code: 'SRC-002', name: 'Momo Achar', yieldQty: 1000, yieldUom: 'GM', lines: [
    ['ITM-014', 800], ['ITM-015', 30], ['ITM-042', 5], ['ITM-023', 20], ['ITM-033', 10], ['ITM-032', 30], ['ITM-017', 20]] },
  { code: 'SRC-003', name: 'Pizza Sauce', yieldQty: 1000, yieldUom: 'GM', lines: [
    ['ITM-040', 700], ['ITM-014', 250], ['ITM-015', 20], ['ITM-041', 8], ['ITM-033', 8], ['ITM-032', 30], ['ITM-034', 10]] },
]

// ── The menu: 6 food, 6 beverage. price is before VAT. lines: [item code | SRC code, qty per plate] ─
// pop: how often it is ordered (by part of the day). hsc: harmonised code on the tax invoice.
export const MENU = [
  { code: 'FOO-001', name: 'Chicken Momo (Steam)', cat: 'Food', price: 310, veg: false, hsc: '1902.20', desc: '10 pieces, house tomato achar',
    lines: [['SRC-001', 180], ['ITM-028', 120], ['SRC-002', 80], ['ITM-032', 5]], pop: { breakfast: 2, lunch: 10, afternoon: 9, dinner: 9 } },
  { code: 'FOO-002', name: 'Chicken Chowmein', cat: 'Food', price: 280, veg: false, hsc: '1902.30', desc: 'Wok-tossed noodles, vegetables, soy',
    lines: [['ITM-031', 150], ['ITM-001', 60], ['ITM-012', 50], ['ITM-018', 30], ['ITM-019', 20], ['ITM-013', 30], ['ITM-035', 15], ['ITM-032', 20], ['ITM-024', 10], ['ITM-033', 3]], pop: { breakfast: 1, lunch: 7, afternoon: 5, dinner: 6 } },
  { code: 'FOO-003', name: 'Chicken Burger & Fries', cat: 'Food', price: 520, veg: false, hsc: '1602.32', desc: 'Grilled chicken, cheese, lettuce, house fries',
    lines: [['ITM-009', 1], ['ITM-001', 110], ['ITM-008', 1], ['ITM-021', 20], ['ITM-014', 30], ['ITM-013', 20], ['ITM-037', 25], ['ITM-020', 200], ['ITM-032', 40], ['ITM-036', 20], ['ITM-033', 2]], pop: { breakfast: 0.5, lunch: 8, afternoon: 4, dinner: 8 } },
  { code: 'FOO-004', name: 'Margherita Pizza (10")', cat: 'Food', price: 590, veg: true, hsc: '1905.90', desc: 'Tomato sauce, mozzarella, oregano',
    lines: [['ITM-011', 1], ['SRC-003', 80], ['ITM-007', 100], ['ITM-041', 1], ['ITM-032', 10]], pop: { breakfast: 0, lunch: 4, afternoon: 3, dinner: 6 } },
  { code: 'FOO-005', name: 'Nepali Chicken Thali', cat: 'Food', price: 450, veg: false, hsc: '1904.90', desc: 'Rice, dal, chicken curry, saag, achar',
    lines: [['ITM-029', 180], ['ITM-030', 40], ['ITM-003', 150], ['ITM-026', 80], ['ITM-020', 60], ['ITM-027', 40], ['ITM-032', 30], ['ITM-039', 8], ['ITM-013', 40], ['ITM-014', 40], ['ITM-015', 8], ['ITM-016', 8], ['ITM-033', 5], ['SRC-002', 30]], pop: { breakfast: 0, lunch: 9, afternoon: 1, dinner: 7 } },
  { code: 'FOO-006', name: 'Club Sandwich', cat: 'Food', price: 420, veg: false, hsc: '1905.90', desc: 'Triple-decker, chicken, egg, cheese, chips',
    lines: [['ITM-010', 3], ['ITM-001', 70], ['ITM-004', 1], ['ITM-008', 1], ['ITM-021', 15], ['ITM-014', 30], ['ITM-037', 20], ['ITM-006', 10], ['ITM-020', 100], ['ITM-032', 20]], pop: { breakfast: 7, lunch: 4, afternoon: 4, dinner: 1.5 } },
  { code: 'BEV-001', name: 'Americano', cat: 'Beverage', price: 180, veg: true, hsc: '2101.11', desc: 'Double shot, hot water',
    lines: [['ITM-045', 18]], pop: { breakfast: 9, lunch: 3, afternoon: 7, dinner: 2 }, sizes: 'black', addons: true },
  { code: 'BEV-002', name: 'Cafe Latte', cat: 'Beverage', price: 240, veg: true, hsc: '2101.12', desc: 'Double shot, steamed milk',
    lines: [['ITM-045', 18], ['ITM-005', 200]], pop: { breakfast: 9, lunch: 4, afternoon: 9, dinner: 3 }, sizes: 'milk', addons: true },
  { code: 'BEV-003', name: 'Cappuccino', cat: 'Beverage', price: 240, veg: true, hsc: '2101.12', desc: 'Double shot, milk foam',
    lines: [['ITM-045', 18], ['ITM-005', 150]], pop: { breakfast: 8, lunch: 3, afternoon: 7, dinner: 2 }, sizes: 'milk', addons: true },
  { code: 'BEV-004', name: 'Masala Tea', cat: 'Beverage', price: 90, veg: true, hsc: '0902.40', desc: 'Milk tea with house masala',
    lines: [['ITM-047', 6], ['ITM-005', 100], ['ITM-034', 12], ['ITM-048', 2]], pop: { breakfast: 8, lunch: 4, afternoon: 10, dinner: 4 } },
  { code: 'BEV-005', name: 'Iced Lemon Tea', cat: 'Beverage', price: 190, veg: true, hsc: '2202.99', desc: 'Black tea, lemon, mint',
    lines: [['ITM-047', 6], ['ITM-022', 1.5], ['ITM-034', 25], ['ITM-025', 3]], pop: { breakfast: 1, lunch: 6, afternoon: 7, dinner: 4 } },
  { code: 'BEV-006', name: 'Fresh Lime Soda', cat: 'Beverage', price: 160, veg: true, hsc: '2202.99', desc: 'Sweet or salted',
    lines: [['ITM-022', 1.5], ['ITM-049', 250], ['ITM-034', 20], ['ITM-033', 1]], pop: { breakfast: 0.5, lunch: 6, afternoon: 6, dinner: 5 } },
]

// ── Coffee choices (Crest Customization) ────────────────────────────────────────────────────────
export const OPTION_GROUPS = [
  { key: 'size_black', name: 'Size', kitchen: 'Size', kind: 'size', min: 1, max: 1, sort: 1, options: [
    { key: 'reg', name: 'Regular', delta: 0, isDefault: true, sort: 1, lines: [] },
    { key: 'lrg', name: 'Large', delta: 40, sort: 2, lines: [['ITM-045', 9]] },
  ] },
  { key: 'size_milk', name: 'Cup size', kitchen: 'Size', kind: 'size', min: 1, max: 1, sort: 1, options: [
    { key: 'reg', name: 'Regular', delta: 0, isDefault: true, sort: 1, lines: [] },
    { key: 'lrg', name: 'Large', delta: 40, sort: 2, lines: [['ITM-045', 9], ['ITM-005', 80]] },
  ] },
  { key: 'addons', name: 'Coffee add-ons', kitchen: 'Add', kind: 'addon', min: 0, max: 2, sort: 2, options: [
    { key: 'oat', name: 'Oat Milk', delta: 100, sort: 1, lines: [['ITM-046', 150], ['ITM-005', -150]] },
    { key: 'shot', name: 'Extra Shot', delta: 60, sort: 2, lines: [['ITM-045', 9]] },
  ] },
]

// ── Staff ───────────────────────────────────────────────────────────────────────────────────────
// basic + allowance = gross; basic is ≥ 60% of gross and gross ≥ the minimum wage (NPR 19,550).
// pin: the till login this person gets (created in the app). join: AD date.
export const STAFF = {
  ktm: [
    { key: 'sita',    name: 'Sita Shrestha',      gender: 'female', dob: '1992-04-12', designation: 'Restaurant Manager', dept: 'Management', basic: 28000, allowance: 14000, join: '2024-01-15', ssf: 'SSF-1023-4471', pan: '120345678', marital: 'married', bank: 'Nabil Bank', acct: '01910017503321', pin: { role: 'manager', title: 'Manager', allowVoid: true }, shift: 'morning' },
    { key: 'ramesh',  name: 'Ramesh Thapa',       gender: 'male',   dob: '1988-09-03', designation: 'Head Chef',          dept: 'Kitchen',    basic: 24000, allowance: 12000, join: '2024-01-15', ssf: 'SSF-1023-4472', pan: '120345679', marital: 'married', bank: 'NIC Asia Bank', acct: '2914006518220011', shift: 'morning' },
    { key: 'bikash',  name: 'Bikash Tamang',      gender: 'male',   dob: '1998-12-21', designation: 'Cook',               dept: 'Kitchen',    basic: 16000, allowance: 6000,  join: '2026-08-31', ssf: null,            marital: 'single',  bank: 'Global IME Bank', acct: '0901010022311', shift: 'evening', status: 'probation', employment: 'probation', ssfEnrolled: true },
    { key: 'sunita',  name: 'Sunita Rai',         gender: 'female', dob: '1997-06-30', designation: 'Barista',            dept: 'Service',    basic: 15000, allowance: 6000,  join: '2024-05-01', ssf: 'SSF-1023-4475', marital: 'single', bank: 'Nabil Bank', acct: '01910017519901', shift: 'morning' },
    { key: 'prakash', name: 'Prakash Gurung',     gender: 'male',   dob: '1999-02-17', designation: 'Captain / Waiter',   dept: 'Service',    basic: 14000, allowance: 6000,  join: '2024-08-10', ssf: 'SSF-1023-4476', marital: 'single', bank: 'Global IME Bank', acct: '0901010022789', pin: { role: 'staff', title: 'Captain' }, shift: 'evening' },
    { key: 'anjali',  name: 'Anjali Magar',       gender: 'female', dob: '2000-10-05', designation: 'Cashier',            dept: 'Service',    basic: 15000, allowance: 6000,  join: '2025-02-01', ssf: 'SSF-1023-4477', marital: 'single', bank: 'NIC Asia Bank', acct: '2914006518229932', pin: { role: 'supervisor', title: 'Cashier' }, shift: 'evening' },
    { key: 'hari',    name: 'Hari Bahadur Karki', gender: 'male',   dob: '1985-07-19', designation: 'Kitchen Helper',     dept: 'Kitchen',    basic: 900,   allowance: 0,     join: '2025-04-14', ssf: null, marital: 'married', payBasis: 'daily', shift: 'mid' },
    { key: 'kamala',  name: 'Kamala B.K.',        gender: 'female', dob: '1990-03-08', designation: 'Cleaner / Dishwasher', dept: 'Kitchen',  basic: 13000, allowance: 6550,  join: '2025-06-01', ssf: null, marital: 'married', shift: 'mid' },
  ],
  pkr: [
    { key: 'rajan',   name: 'Rajan Adhikari',     gender: 'male',   dob: '1990-11-23', designation: 'Outlet Supervisor',  dept: 'Management', basic: 22000, allowance: 10000, join: '2025-09-01', ssf: 'SSF-2041-1101', pan: '120998877', marital: 'married', bank: 'Nabil Bank', acct: '04510017511040', pin: { role: 'manager', title: 'Outlet Supervisor', allowVoid: true }, shift: 'morning' },
    { key: 'mina',    name: 'Mina Gurung',        gender: 'female', dob: '1993-05-14', designation: 'Cook',               dept: 'Kitchen',    basic: 18000, allowance: 7000,  join: '2025-09-01', ssf: 'SSF-2041-1102', marital: 'married', bank: 'Global IME Bank', acct: '1301010031120', shift: 'morning' },
    { key: 'suman',   name: 'Suman Poudel',       gender: 'male',   dob: '1999-08-28', designation: 'Barista & Cashier',  dept: 'Service',    basic: 15000, allowance: 6000,  join: '2025-09-01', ssf: 'SSF-2041-1103', marital: 'single', bank: 'NIC Asia Bank', acct: '3514006519920013', pin: { role: 'supervisor', title: 'Cashier' }, shift: 'evening' },
    { key: 'dipak',   name: 'Dipak Thapa Magar',  gender: 'male',   dob: '2001-01-09', designation: 'Waiter',             dept: 'Service',    basic: 13000, allowance: 6550,  join: '2025-10-15', ssf: 'SSF-2041-1104', marital: 'single', bank: 'Global IME Bank', acct: '1301010031188', pin: { role: 'staff', title: 'Waiter' }, shift: 'evening' },
    { key: 'laxmi',   name: 'Laxmi Pun',          gender: 'female', dob: '1987-12-02', designation: 'Kitchen Helper',     dept: 'Kitchen',    basic: 850,   allowance: 0,     join: '2025-09-01', ssf: null, marital: 'married', payBasis: 'daily', shift: 'mid' },
  ],
}

// Tables on each floor.
export const TABLES = {
  ktm: [
    ...['T1', 'T2', 'T3', 'T4', 'T5', 'T6'].map((n, i) => ({ name: n, section: 'Indoor', capacity: i < 4 ? 2 : 4 })),
    ...['G1', 'G2', 'G3'].map((n, i) => ({ name: n, section: 'Garden', capacity: i < 2 ? 4 : 6 })),
  ],
  pkr: [
    ...['L1', 'L2', 'L3', 'L4', 'L5'].map((n, i) => ({ name: n, section: 'Lakeview', capacity: i < 3 ? 2 : 4 })),
    ...['R1', 'R2'].map(n => ({ name: n, section: 'Rooftop', capacity: 6 })),
  ],
}

// Made-up regulars for the loyalty book and bookings. Phones use the 98000 block.
export const FIRST = ['Aarav', 'Anisha', 'Bibek', 'Prerana', 'Kiran', 'Sneha', 'Rohan', 'Nisha', 'Sujan', 'Pooja', 'Aayush', 'Shristi',
  'Nabin', 'Asmita', 'Saurav', 'Rachana', 'Bishal', 'Manisha', 'Pratik', 'Sarita', 'Ujjwal', 'Kabita', 'Roshan', 'Sabina', 'Niraj',
  'Pratima', 'Sagar', 'Barsha', 'Dipesh', 'Sushma', 'Anil', 'Rekha', 'Milan', 'Elina', 'Suraj', 'Kritika', 'Ashish', 'Riya', 'Binod', 'Srijana']
export const LAST = ['Shrestha', 'Maharjan', 'Karki', 'Adhikari', 'Gurung', 'Tamang', 'Rai', 'Thapa', 'Bhattarai', 'Joshi', 'Pandey',
  'Basnet', 'Pokharel', 'Lama', 'Khadka', 'Sharma', 'Dahal', 'Magar', 'KC', 'Bajracharya']

export const OVERHEADS = {
  ktm: [['Rent', 120000], ['Electricity', 17500], ['LPG Gas', 21000], ['Internet & Phone', 2500], ['Marketing', 9000], ['Repairs & Maintenance', 4500], ['Bank & QR Charges', 2800], ['Cleaning Supplies', 3800], ['Water', 2200]],
  pkr: [['Rent', 80000], ['Electricity', 11800], ['LPG Gas', 13500], ['Internet & Phone', 2000], ['Marketing', 5000], ['Repairs & Maintenance', 3000], ['Bank & QR Charges', 1900], ['Cleaning Supplies', 2500], ['Water', 1500]],
}

export const ASSETS = {
  ktm: [
    ['Kitchen & Coffee Equipment', 'D', 7, [['Espresso Machine (2 group)', 1, 345000, '2024-01-05'], ['Coffee Grinder', 1, 82000, '2024-01-05'], ['Pizza Oven (electric)', 1, 118000, '2024-01-10'], ['Commercial Refrigerator', 1, 96000, '2024-01-10'], ['Deep Freezer', 1, 58000, '2024-02-02'], ['Gas Range (4 burner)', 1, 42000, '2024-01-10']]],
    ['Furniture & Fittings', 'B', 5, [['Dining Tables & Chairs', 9, 18500, '2024-01-08'], ['Garden Umbrellas', 3, 12000, '2024-03-15']]],
    ['Computers & POS', 'B', 4, [['POS Tablet & Receipt Printer', 1, 64000, '2025-07-20'], ['Kitchen Ticket Printer', 1, 18500, '2025-07-20']]],
  ],
  pkr: [
    ['Kitchen & Coffee Equipment', 'D', 7, [['Espresso Machine (1 group)', 1, 215000, '2025-08-20'], ['Coffee Grinder', 1, 76000, '2025-08-20'], ['Commercial Refrigerator', 1, 92000, '2025-08-22'], ['Gas Range (3 burner)', 1, 36000, '2025-08-22']]],
    ['Furniture & Fittings', 'B', 5, [['Dining Tables & Chairs', 7, 17500, '2025-08-25'], ['Rooftop Shade & Lights', 1, 68000, '2025-08-28']]],
    ['Computers & POS', 'B', 4, [['POS Tablet & Receipt Printer', 1, 64000, '2025-08-28']]],
  ],
}
