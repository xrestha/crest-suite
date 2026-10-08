// A count and its noun, agreeing: "1 employee", "3 employees", "1.5 leave days" (S806).
//
// HR printed "(1 EMPLOYEES)" on its dashboard and "employee(s)" / "claim(s)" across its messages —
// on screens whose whole point is the count. `many` is for a noun whose plural is not just + "s".
// A sentence's verb still has to agree on its own (`n === 1 ? 'was' : 'were'`).
export function plural(n, one, many = `${one}s`) {
  return `${n} ${Number(n) === 1 ? one : many}`
}
