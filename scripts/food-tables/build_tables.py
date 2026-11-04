"""Build src/data/foodTables.json from the reviewed table extracts beside this script.

    python3 -I scripts/food-tables/build_tables.py

Reads dftqc-nepal-2012.csv, ifct-2017.csv and dftqc-nepal-2012-ifct-twins.csv; writes the rows
the app's nutrition library loads on demand (src/data/nutritionSeed.js). Left-out rows stay in
the CSVs with their reason and never reach the app. Allergens are a suggestion from the food's
group and name: a library pick never marks an ingredient as checked (nutrition-allergens rules).
"""
import csv
import json
import os
import re

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, '..', '..', 'src', 'data', 'foodTables.json')

# Whole words of a food's name → allergen keys of src/shared/constants/allergens.js.
NAME_RULES = [
    ('gluten', r'wheat|barley|oats?|oatmeal|rye|semolina|suji|bulgur|atta|maida|bread|biscuits?|naan|momos?|samosa|'
               r'jeri|noodles?|macaroni|pasta|spaghetti|muesli|uwa|sarbottam|sarvottam|roti|vermicelli|chau'),
    ('milk', r'milk|buttermilk|curd|dahi|butter|ghee|paneer|cheese|khuwa|khoa|chhena|cream|mohi|yogurt|yoghurt|whey'),
    ('eggs', r'eggs?'),
    ('soy', r'soybean|soyabean|soya|soy|tofu|nutrela'),
    ('peanuts', r'ground ?nuts?|peanuts?'),
    ('tree nuts', r'almonds?|cashew|walnuts?|pistachio|hazelnuts?|pecans?|macadamia'),
    ('sesame', r'sesame|gingelly|til'),
    ('fish', r'fish'),
    ('crustaceans', r'prawns?|shrimps?|crabs?|lobsters?'),
    ('molluscs', r'clams?|mussels?|squid|octopus|cuttlefish|snails?'),
    ('mustard', r'mustard'),
    ('celery', r'celery'),
]
# Words that cancel a rule for that name: rice noodles carry no gluten, cashew fruit is not the nut,
# vegetable ghee is not dairy, coconut milk is not milk, mustard leaves are a green, not the seed.
NOT_RULES = {
    'gluten': r'rice (?:vermicelli|noodles?)|buckwheat|sel roti',
    'milk': r'milk ?fish|coconut (?:milk|water)|ghee, vegetable|vanaspati|groundnut butter|peanut butter|butter ?fruit|butter beans?',
    'tree nuts': r'cashew fruit|cashew apple',
    'mustard': r'mustard (?:leaves|greens?)',
    'fish': r'fish(?:ing)? ?mint',
    'sesame': r'jhuse til|filinge',
    'eggs': r'\bfish\b',  # fish roe ("Eggs, Cat fish") is fish, not the egg allergen
}
# Food groups that carry an allergen whatever the name says.
GROUP_RULES = {
    'Milk and milk products': ['milk'], 'Milk and Milk Products': ['milk'],
    'Egg': ['eggs'], 'Egg and Egg Products': ['eggs'], 'Fish and fish products': ['fish'],
    'Instant noodles, seasoned': ['gluten'], 'Instant noodles, unseasoned': ['gluten'], 'Stick noodles': ['gluten'],
    'Macaroni': ['gluten'], 'Pasta': ['gluten'],
    'Marine Fish': ['fish'], 'Fresh Water Fish and Shellfish': ['fish'],
    'Marine Shellfish': ['crustaceans'], 'Marine Mollusks': ['molluscs'],
}
SHELLFISH_GROUPS = {'Fish and fish products', 'Fresh Water Fish and Shellfish', 'Marine Fish', 'Marine Shellfish', 'Marine Mollusks'}
ORDER = ['gluten', 'milk', 'eggs', 'peanuts', 'tree nuts', 'soy', 'sesame', 'fish', 'crustaceans', 'molluscs',
         'mustard', 'celery', 'sulphites', 'lupin']


def allergens_for(name, group):
    text = name.lower()
    keys = set(GROUP_RULES.get(group, []))
    for key, pat in NAME_RULES:
        if re.search(rf'\b(?:{pat})\b', text):
            keys.add(key)
    keys = {k for k in keys if not (k in NOT_RULES and re.search(NOT_RULES[k], text))}
    # A prawn in the fish group is a crustacean, not a fish; an oyster mushroom is not a mollusc.
    if group in SHELLFISH_GROUPS and re.search(r'\b(?:prawns?|shrimps?|crabs?|lobsters?)\b', text):
        keys.discard('fish')
        keys.add('crustaceans')
    if group in SHELLFISH_GROUPS and re.search(r'\b(?:clams?|mussels?|oysters?|squid|octopus|cuttlefish)\b', text):
        keys.discard('fish')
        if not re.search(r'\b(?:prawns?|shrimps?|crabs?|lobsters?)\b', text):
            keys.discard('crustaceans')
        keys.add('molluscs')
    return ', '.join(k for k in ORDER if k in keys)


def num(v):
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def r1(v):
    return None if v is None else round(v, 1)


def sodium(v):
    return None if v is None else (round(v) if v >= 10 else round(v, 1))


def note_for(r):
    if r['status'] != 'recalculated':
        return ''
    if r['reason'].startswith('no energy'):
        return 'Calories worked out from its fat, protein and carbohydrate: the book prints none.'
    return 'Calories worked out from its fat, protein and carbohydrate: the printed figure disagrees with them.'


def read(name):
    return list(csv.DictReader(open(os.path.join(HERE, name), encoding='utf-8')))


def main():
    nepal = read('dftqc-nepal-2012.csv')
    india = read('ifct-2017.csv')
    india_by_id = {r['id']: r for r in india}
    twins_path = os.path.join(HERE, 'dftqc-nepal-2012-ifct-twins.csv')
    twins = {t['nepal_id']: t['ifct_id'] for t in read('dftqc-nepal-2012-ifct-twins.csv')} if os.path.exists(twins_path) else {}

    rows = []
    for r in nepal:
        if r['status'] == 'left out':
            continue
        row = {
            'id': r['id'], 'name': r['name'], 'group': r['group'], 'source': 'DFTQC Nepal',
            'ref': f"page {r['page']}" + (', supplementary table' if r['table'] == 'supplementary' else ''),
            'energy_kcal': round(num(r['energy_kcal'])),
            'protein_g': r1(num(r['protein']) or 0.0), 'carbs_g': r1(num(r['carbs']) or 0.0), 'fat_g': r1(num(r['fat']) or 0.0),
            'sugar_g': None, 'sodium_mg': None,
            'allergens': allergens_for(r['name'], r['group']),
        }
        twin = india_by_id.get(twins.get(r['id'], ''))
        if twin is not None:
            if twin['status'] == 'left out':
                raise SystemExit(f"{r['id']} is paired with left-out {twin['id']}")
            # Sugar is part of carbohydrate: a twin's sugar above this food's own carbohydrate
            # (cow milk: 4.89 g against 4.4 g) is capped at it.
            row['sugar_g'] = r1(min(num(twin['sugar']), num(r['carbs']) or 0.0))
            row['sodium_mg'] = sodium(num(twin['sodium_mg']))
            row['borrowed'] = twin['name']
        note = note_for(r)
        if note:
            row['note'] = note
        rows.append(row)
    for r in india:
        if r['status'] == 'left out':
            continue
        row = {
            'id': r['id'], 'name': r['name'], 'group': r['group'], 'source': 'IFCT 2017',
            'ref': f"code {r['code']}",
            'energy_kcal': round(num(r['energy_kcal'])),
            'protein_g': r1(num(r['protein'])), 'carbs_g': r1(num(r['carbs'])), 'fat_g': r1(num(r['fat'])),
            'sugar_g': r1(num(r['sugar'])), 'sodium_mg': sodium(num(r['sodium_mg'])),
            'allergens': allergens_for(r['name'], r['group']),
        }
        if r['local']:
            row['local'] = r['local']
        note = note_for(r)
        if note:
            row['note'] = note
        rows.append(row)

    with open(OUT, 'w', encoding='utf-8') as f:
        f.write('[\n' + ',\n'.join(json.dumps(x, ensure_ascii=False, separators=(',', ':')) for x in rows) + '\n]\n')
    print(f"{len(rows)} rows: {sum(1 for x in rows if x['source'] == 'DFTQC Nepal')} Nepal "
          f"({sum(1 for x in rows if x.get('borrowed'))} with borrowed sugar and sodium), "
          f"{sum(1 for x in rows if x['source'] == 'IFCT 2017')} India, {os.path.getsize(OUT)} bytes")


main()
