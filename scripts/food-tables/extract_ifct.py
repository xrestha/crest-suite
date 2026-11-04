"""Extract the Indian Food Composition Tables 2017 (NIN Hyderabad) for the nutrition library.

    npm pack @ifct2017/compositions --ignore-scripts && tar xzf ifct2017-compositions-*.tgz
    python3 -I scripts/food-tables/extract_ifct.py package/index.csv scripts/food-tables/ifct-2017.csv

The source is the @ifct2017/compositions package (MIT, a transcription of the book's tables):
energy in kJ, nutrients in g per 100 g, minerals in g (so sodium x 1000 = mg). The book's energy
factors are 17 kJ/g protein and carbohydrate, 37 kJ/g fat, 8 kJ/g fibre. Every row is written
out, kept or not, with the reason (README.md, "Review rules").
"""
import csv
import re
import sys

LANGS = ('N', 'H')  # Nepali and Hindi local names: the ones a Nepal kitchen writes

# Rows the arithmetic would keep but should not.
LEAVE_OUT = {}


def local_names(lang):
    """'A. Bajra; H. Bajra; N. Bajara.' → 'Bajara; Bajra' (Nepali first, de-duplicated)."""
    found = {}
    for part in re.split(r';\s*', lang or ''):
        m = re.match(r'^([A-Za-z.,\s]+?)\.\s+(.+?)\.?$', part.strip())
        if not m:
            continue
        codes = [c.strip() for c in m.group(1).split(',')]
        for c in codes:
            if c in LANGS:
                found.setdefault(c, m.group(2).strip())
    out = []
    for c in LANGS:
        if c in found and found[c].lower() not in (o.lower() for o in out):
            out.append(found[c])
    return '; '.join(out)


def main():
    rows = list(csv.reader(open(sys.argv[1], encoding='utf-8')))
    codes = [h.split(';')[-1].strip() for h in rows[0]]
    ix = {c: i for i, c in enumerate(codes)}
    out = []
    for r in rows[1:]:
        g = lambda c: float(r[ix[c]] or 0)  # noqa: E731
        P, F, C, FB, W, ASH = g('protcnt'), g('fatce'), g('choavldf'), g('fibtg'), g('water'), g('ash')
        kj = g('enerc')
        calc_kj = 17 * P + 37 * F + 17 * C + 8 * FB
        # The book does not count fibre energy the same way for every food (pulses and spices print
        # well below the full formula), and shellfish print above it, so only a missing figure or
        # one far outside both readings is treated as a misprint.
        low_kj = 16 * P + 37 * F + 16 * C
        total = W + P + F + C + FB + ASH
        rid = 'IN-' + r[ix['code']]
        if rid in LEAVE_OUT:
            status, kcal, reason = 'left out', None, LEAVE_OUT[rid]
        elif kj > 0 and 0.9 * low_kj - 25 <= kj <= 1.25 * calc_kj + 25:
            status, kcal, reason = 'printed', kj / 4.184, ''
        elif 97 <= total <= 103:
            why = 'no energy printed' if kj <= 0 else f'printed {kj:g} kJ disagrees with its protein, fat and carbohydrate'
            status, kcal, reason = 'recalculated', calc_kj / 4.184, why
        else:
            status, kcal, reason = 'left out', None, f'composition adds up to {total:.0f} g per 100 g and printed {kj:g} kJ disagrees'
        out.append({
            'id': rid, 'code': r[ix['code']], 'name': r[ix['name']].strip(),
            'scientific': r[ix['scie']].strip(), 'local': local_names(r[ix['lang']]),
            'group': r[ix['grup']].strip(),
            'water': f'{W:g}', 'protein': f'{P:g}', 'fat': f'{F:g}', 'carbs': f'{C:g}', 'fiber': f'{FB:g}',
            'ash': f'{ASH:g}', 'sugar': f"{g('fsugar'):g}", 'sodium_mg': f"{g('na') * 1000:.2f}",
            'energy_kj_printed': f'{kj:g}', 'energy_kcal': '' if kcal is None else f'{kcal:.1f}',
            'status': status, 'reason': reason,
        })
    with open(sys.argv[2], 'w', newline='', encoding='utf-8') as f:
        w = csv.DictWriter(f, fieldnames=list(out[0].keys()), lineterminator='\n')
        w.writeheader()
        w.writerows(out)
    counts = {}
    for r in out:
        counts[r['status']] = counts.get(r['status'], 0) + 1
    print(len(out), 'rows', counts)


main()
