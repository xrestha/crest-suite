"""Extract the Food Composition Table for Nepal 2012 (DFTQC) from its PDF.

    pdftotext -layout Nepal_Food_Composition_table_2012.pdf nepal.txt
    python3 -I scripts/food-tables/extract_nepal.py nepal.txt scripts/food-tables/dftqc-nepal-2012.csv

The PDF prints each food across two facing pages: an A page (S.N., name, edible portion,
moisture, protein, fat, carbohydrate, minerals) and a B page (S.N., fibre, energy, calcium...).
Columns are found from each page's numbering row ("0 1 2 ... 7" / "0 8 9 ... 17"), so a blank
cell cannot shift its neighbours. Rows pair by order within a page pair: the book prints S.N. 32
twice on page 12, so S.N. is not a safe key.

Every row is written out, kept or not, with the reason (README.md, "Review rules").
"""
import csv
import os
import re
import sys

A_COLS = ['sn', 'name', 'edible', 'moisture', 'protein', 'fat', 'carbs', 'minerals']
B_COLS = ['sn', 'fiber', 'energy', 'calcium', 'phosphorus', 'iron', 'carotene', 'vitc', 'thiamine', 'riboflavin', 'niacin']
VAL = re.compile(r'^(?:\d+(?:\.\d+)?\)?|[–\-—_]|traces?|Traces?|ND)$')
GROUP = re.compile(r'^\s+([A-R](?:\(\d\))?)\.\s*([A-Za-z][A-Za-z &,()–-]*?)?\s*(?:–.*)?$')

MAIN_GROUPS = {
    'A': 'Cereals and cereal products', 'B': 'Pulses and legumes', 'C': 'Green leafy vegetables',
    'D': 'Other vegetables', 'E': 'Roots and tubers', 'F': 'Vegetable products', 'G': 'Fruits',
    'H': 'Condiments and spices', 'I': 'Nuts and oilseeds', 'J': 'Meat and meat products',
    'K': 'Egg', 'L': 'Fish and fish products', 'M': 'Milk and milk products',
    'N': 'Fats and edible oils', 'O': 'Miscellaneous foods', 'P': 'Cooked food',
    'Q': 'Weaning foods prepared locally', 'R': 'Wild edible food',
}
ANNEX_GROUPS = {
    'A(1)': 'Instant noodles, seasoned', 'A(2)': 'Instant noodles, unseasoned', 'B': 'Stick noodles',
    'C': 'Crackers', 'D': 'Macaroni', 'E': 'Pasta', 'F': 'Miscellaneous', 'G': 'Miscellaneous',
}

# Display names (spelling, wrapped names) live in dftqc-nepal-2012-names.csv beside this script.
# A figure is never edited there; the book's own spelling stays in the book_name column.
NAMES_CSV = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'dftqc-nepal-2012-names.csv')


def numbering_row(lines, want_first):
    for i, l in enumerate(lines):
        toks = [(m.group(), (m.start() + m.end()) / 2) for m in re.finditer(r'\S+', l)]
        if len(toks) >= 6 and toks[0][0] == '0' and toks[1][0] == want_first and all(t[0].isdigit() for t in toks):
            return i, [t[1] for t in toks]
    return None, None


def nearest(x, centres):
    return min(range(len(centres)), key=lambda k: abs(centres[k] - x))


def parse_page(text, kind, group):
    """→ (rows, last group seen, printed page number)"""
    lines = text.split('\n')
    hdr_i, centres = numbering_row(lines, '1' if kind == 'A' else '8')
    if hdr_i is None:
        raise SystemExit(f'no numbering row on {kind} page')
    cols = A_COLS if kind == 'A' else B_COLS
    rows, pending, parent, printed, last_sn = [], [], None, '', ''
    for l in lines[hdr_i + 1:]:
        g = GROUP.match(l)
        if g:
            group = g.group(1)
            continue
        if re.match(r'^\s{20,}\d{1,2}\s*$', l):
            printed = l.strip()
            continue
        m = re.match(r'^\s*(\d+|[a-j])\s+(.*)$', l)
        toks = [(t.group(), (t.start() + t.end()) / 2, t.start()) for t in re.finditer(r'\S+', l)]
        if not m or len(toks) < 2:
            # A name wrapped onto its own line (A page only), or a stray label.
            if kind == 'A' and toks and toks[0][2] > 3 and not (len(toks) == 1 and toks[0][0].isdigit()):
                text_ = ' '.join(t[0] for t in toks)
                if re.match(r'^Vari\w+ of ', text_):  # an unnumbered heading over lettered rows
                    parent = re.sub(r'^Vari\w+ of\s+', '', text_)
                else:
                    pending.append((len(rows), text_))
            continue
        row = {'sn': toks[0][0], 'group': group}
        name_parts = []
        for tok, mid, _start in toks[1:]:
            k = nearest(mid, centres)
            if kind == 'A' and (k <= 1 or not VAL.match(tok)):
                name_parts.append(tok)
                continue
            key = cols[k]
            row[key] = (row[key] + ' ' + tok) if key in row else tok
        values = [k for k in row if k not in ('sn', 'group')]
        # A lettered row takes the number above it: "4 Varities of Maseura" then a..h is 4a..4h.
        if row['sn'].isdigit():
            last_sn = row['sn']
        else:
            row['sn'] = last_sn + row['sn']
        if kind == 'A':
            row['name'] = ' '.join(name_parts)
            if not values:  # "4 Varities of Maseura": the lettered rows below belong to it
                parent = re.sub(r'^Vari\w+ of\s+', '', row['name'])
                continue
            if row['sn'].isdigit():
                parent = None
            elif parent:
                row['name'] = f"{parent}: {row['name']}"
        if kind == 'B' and not values:
            continue
        rows.append(row)
    for idx, frag in pending:
        target = rows[idx] if idx < len(rows) else (rows[-1] if rows else None)
        if target is not None:
            target.setdefault('wrap', []).append(frag)
    return rows, group, printed


def value(v):
    """Book cell → float, 0.0 for traces, None for not given / not determined."""
    v = (v or '').strip().rstrip(')')
    if re.match(r'^traces?$', v, re.I):
        return 0.0
    try:
        return float(v)
    except ValueError:
        return None


# Rows the arithmetic would keep but should not: the reason is the published one.
LEAVE_OUT = {
    'NP-O18': 'an alcoholic drink: the book counts energy as 4P + 4C + 9F, which leaves the alcohol out',
    'NP-M9': 'not a kitchen ingredient (human milk)',
}


def classify(r, rid):
    """→ (status, energy_kcal, reason). Energy in this book is 4P + 4C + 9F (its Methods page)."""
    if rid in LEAVE_OUT:
        return 'left out', None, LEAVE_OUT[rid]
    P, F, C, E = (value(r.get(k)) for k in ('protein', 'fat', 'carbs', 'energy'))
    if P is None and F is None and C is None:
        return 'left out', None, 'no protein, fat or carbohydrate figures'
    # A dash in a macro column of an oil, a meat or an egg means none: test that reading.
    p, f, c = (x if x is not None else 0.0 for x in (P, F, C))
    calc = 4 * p + 4 * c + 9 * f
    if E is not None and abs(calc - E) <= max(6, 0.03 * E):
        return 'printed', E, ''
    parts = [value(r.get(k)) for k in ('moisture', 'minerals', 'fiber')] + [p, f, c]
    total = sum(x for x in parts if x is not None)
    if 97 <= total <= 103:
        why = 'no energy printed' if E is None else f'printed {E:g} kcal disagrees with its protein, fat and carbohydrate'
        return 'recalculated', round(calc), why
    return 'left out', None, f'composition adds up to {total:.0f} g per 100 g' + ('' if E is None else f' and printed {E:g} kcal disagrees')


def main():
    pages = open(sys.argv[1], encoding='utf-8').read().split('\f')
    names = {r['id']: r['name'] for r in csv.DictReader(open(NAMES_CSV, encoding='utf-8'))}
    out, group = [], None
    for p in range(9, 65, 2):
        part = 'main' if p < 59 else 'annex'
        if part == 'annex' and p == 59:
            group = None
        a, group_after, printed = parse_page(pages[p], 'A', group)
        b, _, _ = parse_page(pages[p + 1], 'B', group)
        if len(a) != len(b):
            raise SystemExit(f'page {p}: {len(a)} A rows vs {len(b)} B rows')
        for ra, rb in zip(a, b):
            r = {**rb, **ra}
            g = r['group']
            rid = f"NP-{g}{r['sn']}" if part == 'main' else f"NP-S-{g.replace('(', '').replace(')', '')}-{r['sn']}"
            book_name = ' '.join([r['name']] + r.get('wrap', [])).strip()
            if part == 'annex' and r.get('wrap'):  # annex group titles were read as wrapped names
                book_name = r['name']
            status, energy, reason = classify(r, rid)
            out.append({
                'id': rid, 'table': 'supplementary' if part == 'annex' else 'main',
                'page': printed, 'group': (ANNEX_GROUPS if part == 'annex' else MAIN_GROUPS).get(g, g),
                'sn': r['sn'], 'book_name': book_name, 'name': names.get(rid, re.sub(r'\s+', ' ', book_name)),
                **{k: r.get(k, '') for k in ('moisture', 'protein', 'fat', 'carbs', 'minerals', 'fiber')},
                'energy_printed': r.get('energy', ''), 'energy_kcal': '' if energy is None else f'{energy:g}',
                'status': status, 'reason': reason,
            })
        group = group_after
    ids = [r['id'] for r in out]
    dupes = {i for i in ids if ids.count(i) > 1}
    if dupes:
        raise SystemExit(f'duplicate ids: {sorted(dupes)}')
    fields = list(out[0].keys())
    with open(sys.argv[2], 'w', newline='', encoding='utf-8') as f:
        w = csv.DictWriter(f, fieldnames=fields, lineterminator='\n')
        w.writeheader()
        w.writerows(out)
    counts = {}
    for r in out:
        counts[r['status']] = counts.get(r['status'], 0) + 1
    print(len(out), 'rows', counts)


main()
