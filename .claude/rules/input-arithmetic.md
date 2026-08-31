---
paths:
  - "src/utils/evalMath.js"
  - "src/utils/evalMath.test.js"
  - "src/components/QtyInput.js"
  - "src/components/QtyInput.test.js"
  - "src/components/Calculator.js"
---

# Arithmetic in input fields

`src/utils/evalMath.js` is the single evaluator behind both `QtyInput` and the Quick Calculator. It is a hand-written recursive-descent parser, **never `eval()` / `new Function()`** — these are inputs where a pasted string reaches the evaluator directly, and the grammar (`expr → term → factor`, supporting `+ - * / ( )`, unary minus, `×`/`÷` glyphs and comma separators) can only ever produce a number. It also keeps working under a strict CSP. `evaluate()` returns `null` for anything malformed — including division by zero, so `Infinity` can never reach a saved quantity — and every caller reads `null` as "not an expression, leave the user's input alone" rather than as an error to surface. `looksLikeExpression()` gates the whole deferred-commit path: a plain `146` or a leading-minus `-5` is not an expression and must keep behaving exactly as a bare `<input type="number">` did.

Three invariants from S623's review, each a live bug before it was a rule (`QtyInput.test.js`/`evalMath.test.js` assert all three):

- **`looksLikeExpression()`'s character class must cover everything `tokenize()` normalises** — ASCII `x`/`X` (its multiply) and the comma it strips included. When detection lagged the tokenizer, `12x4` and `1,200` skipped evaluation and reached a caller's `parseFloat` as raw strings, which read a *prefix* (12, 1) — a silently 4×/1000×-wrong rate. Extending `tokenize` means extending the detection class in the same change.
- **`QtyInput` never hands a raw unparseable string up.** `commit()` runs even non-expression text through `evaluate()` and reverts genuine garbage (`5oo`) to the last good value; the live keystroke mirror suppresses anything that doesn't `Number()` as itself. Corollary: plain numbers commit as **numbers**, not strings.
- **Escape's cancel is a ref, not state** (`cancelRef`): Escape blurs the field and the blur's `commit()` runs before React re-renders, so it closes over the pre-Escape draft — without the ref, Esc *committed* the expression, byte-identical to Enter (measured, not reasoned). Enter itself only blurs (calling `commit()` in the keydown too double-fired `onCommit`). And Esc consumes the key (`stopPropagation`) only when there is an edit to cancel, paired with `Modal`'s `defaultPrevented` check, so cancelling one box never discards the dialog around it.
