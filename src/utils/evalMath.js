// Arithmetic expression evaluator for quantity/rate fields and the Quick Calculator.
//
// Deliberately a hand-written parser, NOT eval() / new Function(): those execute arbitrary
// JavaScript, and these inputs are places where a pasted or typed string reaches the evaluator
// directly. This grammar can only ever produce a number — there is no code path from a string
// here to anything executable. It also keeps working under a strict CSP (no 'unsafe-eval').
//
// Grammar:
//   expr   := term (('+' | '-') term)*
//   term   := factor (('*' | '/') factor)*
//   factor := ('+' | '-') factor | '(' expr ')' | number
//
// Anything the grammar doesn't accept returns null, which every caller treats as "not an
// expression — leave the user's input alone" rather than as an error to surface.

// Floating-point cleanup: 0.1 + 0.2 must read as 0.3 in a stock count, not 0.30000000000000004.
// 6 decimals is well past any real qty/rate precision while staying clear of the noise floor.
function round(n) {
  return Math.round(n * 1e6) / 1e6
}

function tokenize(input) {
  // Accept what people actually paste: thousands separators, and the × / ÷ glyphs from
  // other calculators or a spreadsheet.
  const s = input.replace(/,/g, '').replace(/[×✕xX]/g, '*').replace(/[÷]/g, '/')
  const tokens = []
  let i = 0

  while (i < s.length) {
    const ch = s[i]

    if (ch === ' ' || ch === '\t') { i++; continue }

    if ((ch >= '0' && ch <= '9') || ch === '.') {
      let num = ''
      let dots = 0
      while (i < s.length && ((s[i] >= '0' && s[i] <= '9') || s[i] === '.')) {
        if (s[i] === '.' && ++dots > 1) return null // "1.2.3"
        num += s[i]
        i++
      }
      const v = parseFloat(num)
      if (!Number.isFinite(v)) return null // a bare "."
      tokens.push({ t: 'num', v })
      continue
    }

    if ('+-*/()'.includes(ch)) { tokens.push({ t: ch }); i++; continue }

    return null // any other character — not something we're willing to interpret
  }

  return tokens
}

// True only when the string contains an actual operation. A plain "146" or a leading-minus
// "-5" is NOT an expression: fields that hold a plain number must keep behaving exactly as
// they did before, with no evaluation step and no result preview.
//
// The character class must cover EVERYTHING tokenize() above normalises — x/X (its ASCII
// multiply) and the comma it strips included. When the two disagreed, "12x4" and "1,200"
// were waved past evaluation onto the raw-string path, where a caller's parseFloat read
// them as 12 and 1 — a silently 4×/1000×-wrong figure in a rate box (S623).
export function looksLikeExpression(str) {
  if (typeof str !== 'string') return false
  const s = str.trim()
  if (!s) return false
  if (/[+*/×✕xX÷(),]/.test(s)) return true
  return s.slice(1).includes('-') // a '-' anywhere but the sign position
}

// Returns a number, or null if `input` isn't a complete, valid expression.
export function evaluate(input) {
  if (typeof input !== 'string') return null
  if (!input.trim()) return null

  const tokens = tokenize(input)
  if (!tokens || tokens.length === 0) return null

  let pos = 0
  const peek = () => tokens[pos]

  function parseFactor() {
    const tk = peek()
    if (!tk) return null

    if (tk.t === '+') { pos++; return parseFactor() }
    if (tk.t === '-') { pos++; const v = parseFactor(); return v === null ? null : -v }

    if (tk.t === '(') {
      pos++
      const v = parseExpr()
      if (v === null) return null
      if (!peek() || peek().t !== ')') return null // unclosed group
      pos++
      return v
    }

    if (tk.t === 'num') { pos++; return tk.v }
    return null
  }

  function parseTerm() {
    let left = parseFactor()
    if (left === null) return null
    while (peek() && (peek().t === '*' || peek().t === '/')) {
      const op = tokens[pos++].t
      const right = parseFactor()
      if (right === null) return null
      // Division by zero yields Infinity, which would silently save as a garbage quantity —
      // treat it as an invalid expression so the field reverts instead.
      if (op === '/' && right === 0) return null
      left = op === '*' ? left * right : left / right
    }
    return left
  }

  function parseExpr() {
    let left = parseTerm()
    if (left === null) return null
    while (peek() && (peek().t === '+' || peek().t === '-')) {
      const op = tokens[pos++].t
      const right = parseTerm()
      if (right === null) return null
      left = op === '+' ? left + right : left - right
    }
    return left
  }

  const result = parseExpr()
  // pos must land exactly on the end — a trailing ")" or "5 5" is malformed, not a prefix
  // we're entitled to evaluate and quietly discard the rest of.
  if (result === null || pos !== tokens.length) return null
  if (!Number.isFinite(result)) return null
  return round(result)
}
