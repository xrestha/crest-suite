// Every foreign key the migrations leave in place, read from supabase/migrations (S809 3i). For tests
// only: the restore order (restoreClientData.test.js) and the till-login record words
// (posLoginRecords.test.js) are each a list that must follow the schema, and a test that reads the
// migrations is the only thing that can hold them to it (the itemRefTables.test.js technique). Node
// only (fs); no app code imports this, so it never reaches the bundle.
//
// Checked against the live catalog when it was written (2026-10-09): it found all 246 public foreign
// keys, each with its columns, parent and delete action, and nothing else. It reads the four shapes
// the migrations use: the baseline's ALTER TABLE ONLY … ADD CONSTRAINT … FOREIGN KEY, an inline
// column REFERENCES in CREATE TABLE or ALTER TABLE … ADD COLUMN, a table-level FOREIGN KEY in CREATE
// TABLE, and an ALTER TABLE inside a DO block (S737's closing_stock key). DROP CONSTRAINT, DROP
// COLUMN and DROP TABLE remove keys. A key built with EXECUTE format(…) would be missed.
import fs from 'fs'
import path from 'path'

const ID = '"?([a-z_][a-z0-9_]*)"?'
// auth.users comes back as parent "users"; no public table is called that.
const QUAL = `(?:"?(?:public|auth)"?\\.)?${ID}`

export function stripComments(sql) {
  return sql.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' ')
}

function onDelete(tail) {
  const m = /ON DELETE (CASCADE|SET NULL|SET DEFAULT|RESTRICT|NO ACTION)/i.exec(tail || '')
  return m ? m[1].toUpperCase() : 'NO ACTION'
}

// Splits on `;` outside dollar-quoted bodies, then opens each DO block for the ALTER TABLEs inside it.
function statements(sql) {
  const out = []
  let buf = ''
  let dollar = null
  for (let i = 0; i < sql.length; i++) {
    if (!dollar) {
      const m = /^\$[a-zA-Z_]*\$/.exec(sql.slice(i, i + 40))
      if (m) { dollar = m[0]; buf += m[0]; i += m[0].length - 1; continue }
      if (sql[i] === ';') { out.push(buf); buf = ''; continue }
    } else if (sql.startsWith(dollar, i)) {
      buf += dollar; i += dollar.length - 1; dollar = null; continue
    }
    buf += sql[i]
  }
  out.push(buf)
  const flat = []
  for (const raw of out) {
    const t = raw.trim()
    const d = /^DO\s+(\$[a-zA-Z_]*\$)([\s\S]*)\1/i.exec(t)
    if (!d) { flat.push(t); continue }
    for (const piece of d[2].split(';')) {
      const at = piece.search(/\bALTER TABLE\b/i)
      if (at >= 0) flat.push(piece.slice(at))
    }
  }
  return flat.map(s => s.replace(/\s+/g, ' ').trim())
}

// Top-level comma split (parentheses kept together).
function topLevelParts(text) {
  const parts = []
  let depth = 0
  let cur = ''
  for (const ch of text) {
    if (ch === '(') depth++
    if (ch === ')') depth--
    if (ch === ',' && depth === 0) { parts.push(cur.trim()); cur = '' } else cur += ch
  }
  parts.push(cur.trim())
  return parts
}

/** [{ table, cols, parent, name, onDelete }] for every foreign key the migrations leave in place. */
export function foreignKeysFromMigrations(dir) {
  const fks = new Map()
  const key = (t, n) => `${t}::${n}`
  const add = (table, cols, parent, name, tail) => fks.set(key(table, name), { table, cols, parent, name, onDelete: onDelete(tail) })
  for (const file of fs.readdirSync(dir).filter(f => f.endsWith('.sql')).sort()) {
    for (const s of statements(stripComments(fs.readFileSync(path.join(dir, file), 'utf8')))) {
      let m
      if ((m = new RegExp(`^CREATE TABLE (?:IF NOT EXISTS )?${QUAL} ?\\((.*)\\)`, 'i').exec(s))) {
        const table = m[1]
        for (const p of topLevelParts(m[2])) {
          let c
          if ((c = new RegExp(`^(?:CONSTRAINT ${ID} )?FOREIGN KEY ?\\(([^)]*)\\) REFERENCES ${QUAL}(.*)$`, 'i').exec(p))) {
            const cols = c[2].split(',').map(x => x.trim().replace(/"/g, ''))
            add(table, cols, c[3], c[1] || `${table}_${cols[0]}_fkey`, c[4])
          } else if (!/^(CONSTRAINT|PRIMARY|UNIQUE|CHECK|EXCLUDE)\b/i.test(p)
                     && (c = new RegExp(`^${ID} [^,]*?REFERENCES ${QUAL}(.*)$`, 'i').exec(p))) {
            const named = /CONSTRAINT "?([a-z0-9_]+)"? REFERENCES/i.exec(p)
            add(table, [c[1]], c[2], named ? named[1] : `${table}_${c[1]}_fkey`, c[3])
          }
        }
        continue
      }
      if ((m = new RegExp(`^ALTER TABLE (?:IF EXISTS )?(?:ONLY )?${QUAL} (.*)$`, 'i').exec(s))) {
        const table = m[1]
        for (const p of topLevelParts(m[2])) {
          let c
          if ((c = new RegExp(`^ADD CONSTRAINT ${ID} FOREIGN KEY ?\\(([^)]*)\\) REFERENCES ${QUAL}(.*)$`, 'i').exec(p))) {
            add(table, c[2].split(',').map(x => x.trim().replace(/"/g, '')), c[3], c[1], c[4])
          } else if (!/^ADD CONSTRAINT/i.test(p)
                     && (c = new RegExp(`^ADD (?:COLUMN )?(?:IF NOT EXISTS )?${ID} [^,]*?REFERENCES ${QUAL}(.*)$`, 'i').exec(p))) {
            const named = /CONSTRAINT "?([a-z0-9_]+)"? REFERENCES/i.exec(p)
            add(table, [c[1]], c[2], named ? named[1] : `${table}_${c[1]}_fkey`, c[3])
          } else if ((c = new RegExp(`^DROP CONSTRAINT (?:IF EXISTS )?${ID}`, 'i').exec(p))) {
            fks.delete(key(table, c[1]))
          } else if ((c = new RegExp(`^DROP COLUMN (?:IF EXISTS )?${ID}`, 'i').exec(p))) {
            for (const [k, v] of fks) if (v.table === table && v.cols.includes(c[1])) fks.delete(k)
          }
        }
        continue
      }
      if ((m = new RegExp(`^DROP TABLE (?:IF EXISTS )?${QUAL}`, 'i').exec(s))) {
        for (const [k, v] of fks) if (v.table === m[1]) fks.delete(k)
      }
    }
  }
  return [...fks.values()]
}

export const MIGRATIONS_DIR = path.join(__dirname, '..', '..', 'supabase', 'migrations')
