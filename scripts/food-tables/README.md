# Food tables for the nutrition library

`src/data/foodTables.json` is built from the files in this folder. Never edit the JSON by hand:
change an extract, a names file or the pairs file, then rebuild. The app loads the JSON on demand
(`loadLibrary()` in `src/data/nutritionSeed.js`), so it adds nothing to a page until someone opens
the library.

## Sources

| Table | Source | Licence / terms |
| --- | --- | --- |
| DFTQC Nepal | *Food Composition Table for Nepal 2012*, Department of Food Technology and Quality Control, Government of Nepal. PDF: <https://www.fao.org/fileadmin/templates/food_composition/documents/regional/Nepal_Food_Composition_table_2012.pdf> (FAO/INFOODS listing). The main table (groups A–R) and the Supplementary Food Table of packaged goods. | Government publication, credited by name and page on every row. |
| IFCT 2017 | *Indian Food Composition Tables 2017*, National Institute of Nutrition (ICMR), Hyderabad, as transcribed in the npm package `@ifct2017/compositions` 2.0.9. | Package MIT (c) Subhajit Sahu; data credited to NIN by name and food code on every row. |

Figures are per 100 g edible portion. Neither table is per 100 ml: the app reads a per-100 g figure
as per 100 ml for an ingredient counted in litres, as the library always has.

## Rebuild

```bash
# Nepal: text out of the PDF, then the extract (names come from dftqc-nepal-2012-names.csv)
pdftotext -layout Nepal_Food_Composition_table_2012.pdf nepal.txt
python3 -I scripts/food-tables/extract_nepal.py nepal.txt scripts/food-tables/dftqc-nepal-2012.csv

# India: the transcription package, unpacked without running its scripts
npm pack @ifct2017/compositions --ignore-scripts && tar xzf ifct2017-compositions-*.tgz
python3 -I scripts/food-tables/extract_ifct.py package/index.csv scripts/food-tables/ifct-2017.csv

# Both → src/data/foodTables.json
python3 -I scripts/food-tables/build_tables.py
npx react-scripts test --watchAll=false src/data/nutritionSeed
```

Keep downloaded files out of the repo and out of this folder.

## Files

- `dftqc-nepal-2012.csv`: every row of the book, kept or not, with its printed page, the book's own
  spelling (`book_name`), the figures as printed, the energy used and why (`status`, `reason`).
- `dftqc-nepal-2012-names.csv`: display names. Spelling and wrapped names only ("Seasome oil" →
  "Sesame oil", "Brvssis sprouts" → "Brussels sprouts"). A figure is never edited here.
- `ifct-2017.csv`: every IFCT food with the columns the app uses, its Nepali and Hindi names, and
  the same `status` and `reason`.
- `dftqc-nepal-2012-ifct-twins.csv`: Nepal foods paired with the same food in the Indian table,
  for sugar and sodium (below). Reviewed pair by pair; the `note` column records the judgment calls.

## Review rules

**Energy.** The Nepal book states its energy is 4 × protein + 4 × carbohydrate + 9 × fat. A row whose
printed energy agrees within 3% (or 6 kcal) is kept as printed. A dash or "traces" in a protein, fat
or carbohydrate cell is read as none (the oils, meats and eggs). When the printed energy disagrees,
the row is checked against the rest of its composition: if moisture, protein, fat, carbohydrate,
minerals and fibre add up to 97–103 g, the macronutrients are sound and the energy is the misprint,
so it is recalculated with the book's own formula and the row says so ("Calories worked out…").
96% of the clean rows pass that 100 g test, which is what makes it trustworthy. Otherwise the row
is left out.

The Indian book counts energy with 17/37/17 kJ per gram of protein/fat/carbohydrate and treats fibre
differently by food, so its printed figure is accepted across a wide band and recalculated only when
none is printed (the 14 oils and ghee) or it is far outside both readings (chicken leg, 1605 kJ).

**Left out.** 47 Nepal rows and 2 Indian rows. Each is in its CSV with the reason. They are the rows
whose composition contradicts itself (e.g. purple cabbage, 52 g carbohydrate at 66 kcal), rows with
no protein, fat or carbohydrate figures at all (gundruk, timur, jimbu), jaand (an alcoholic drink:
the formula leaves the alcohol out) and human milk (not a kitchen ingredient).

**Sugar and sodium.** The Nepal table never measured either. A Nepal food takes both from its Indian
twin, only when the twin is the same food in the same form with moisture within 8 g per 100 g;
sugar is capped at the Nepal food's own carbohydrate. Without a twin they stay null, never 0, and
the picker says "No sugar or sodium figures".

**Allergens.** Suggested from the food group and whole words of the name (`build_tables.py`), with
the traps written out: milk fish, fish roe, oyster mushroom, cashew fruit, sel roti, jhuse til, rice
vermicelli. A library pick only adds allergens; it never marks an ingredient as checked.
