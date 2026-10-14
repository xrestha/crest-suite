// Just enough ZIP for the build: read one entry out of the official Node.js zip, and write the
// release zip. Uses zlib's raw deflate and crc32 (Node 22.2+); no ZIP64 writing (files < 4 GB).
import zlib from 'node:zlib'

const SIG_EOCD = 0x06054b50
const SIG_EOCD64_LOC = 0x07064b50
const SIG_EOCD64 = 0x06064b50
const SIG_CEN = 0x02014b50
const SIG_LOC = 0x04034b50
const MAX32 = 0xFFFFFFFF

function findEocd(buf) {
  const min = Math.max(0, buf.length - 22 - 0xFFFF)
  for (let i = buf.length - 22; i >= min; i--) if (buf.readUInt32LE(i) === SIG_EOCD) return i
  throw new Error('not a zip file (no end of central directory)')
}

/** List entries: [{ name, method, csize, size, crc, offset }]. Understands ZIP64 sizes. */
export function listZip(buf) {
  const e = findEocd(buf)
  let count = buf.readUInt16LE(e + 10)
  let cdSize = buf.readUInt32LE(e + 12)
  let cdOff = buf.readUInt32LE(e + 16)
  if (cdOff === MAX32 || count === 0xFFFF) {
    const loc = e - 20
    if (loc < 0 || buf.readUInt32LE(loc) !== SIG_EOCD64_LOC) throw new Error('zip64 locator missing')
    const e64 = Number(buf.readBigUInt64LE(loc + 8))
    if (buf.readUInt32LE(e64) !== SIG_EOCD64) throw new Error('zip64 end record missing')
    count = Number(buf.readBigUInt64LE(e64 + 32))
    cdSize = Number(buf.readBigUInt64LE(e64 + 40))
    cdOff = Number(buf.readBigUInt64LE(e64 + 48))
  }
  const out = []
  let p = cdOff
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== SIG_CEN) throw new Error('bad central directory entry')
    const method = buf.readUInt16LE(p + 10)
    const crc = buf.readUInt32LE(p + 16)
    let csize = buf.readUInt32LE(p + 20)
    let size = buf.readUInt32LE(p + 24)
    const nameLen = buf.readUInt16LE(p + 28)
    const extraLen = buf.readUInt16LE(p + 30)
    const commentLen = buf.readUInt16LE(p + 32)
    let offset = buf.readUInt32LE(p + 42)
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen)
    let x = p + 46 + nameLen
    const xEnd = x + extraLen
    while (x + 4 <= xEnd) {
      const id = buf.readUInt16LE(x)
      const len = buf.readUInt16LE(x + 2)
      if (id === 0x0001) {
        let q = x + 4
        if (size === MAX32) { size = Number(buf.readBigUInt64LE(q)); q += 8 }
        if (csize === MAX32) { csize = Number(buf.readBigUInt64LE(q)); q += 8 }
        if (offset === MAX32) { offset = Number(buf.readBigUInt64LE(q)); q += 8 }
      }
      x += 4 + len
    }
    out.push({ name, method, csize, size, crc, offset })
    p = xEnd + commentLen
  }
  if (p - cdOff > cdSize + 1) throw new Error('central directory overran its size')
  return out
}

/** The bytes of one entry, checked against its CRC. */
export function readZipEntry(buf, name) {
  const ent = listZip(buf).find(e => e.name === name)
  if (!ent) throw new Error(`${name} is not in the zip`)
  const p = ent.offset
  if (buf.readUInt32LE(p) !== SIG_LOC) throw new Error('bad local header')
  const start = p + 30 + buf.readUInt16LE(p + 26) + buf.readUInt16LE(p + 28)
  const raw = buf.subarray(start, start + ent.csize)
  let data
  if (ent.method === 0) data = Buffer.from(raw)
  else if (ent.method === 8) data = zlib.inflateRawSync(raw)
  else throw new Error(`unsupported compression method ${ent.method}`)
  if (data.length !== ent.size) throw new Error(`${name}: size mismatch`)
  if ((zlib.crc32(data) >>> 0) !== ent.crc) throw new Error(`${name}: CRC mismatch`)
  return data
}

function dosTime(d) {
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2)
  const date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()
  return { time, date }
}

/** files: [{ name, data }]. Returns the zip as a Buffer (deflated entries). */
export function writeZip(files, when = new Date()) {
  const { time, date } = dosTime(when)
  const locals = []
  const cens = []
  let offset = 0
  for (const f of files) {
    const name = Buffer.from(f.name, 'utf8')
    const data = Buffer.isBuffer(f.data) ? f.data : Buffer.from(f.data)
    const comp = zlib.deflateRawSync(data, { level: 9 })
    const crc = zlib.crc32(data) >>> 0
    if (comp.length >= MAX32 || data.length >= MAX32) throw new Error(`${f.name} is too big for a plain zip`)
    const loc = Buffer.alloc(30)
    loc.writeUInt32LE(SIG_LOC, 0)
    loc.writeUInt16LE(20, 4)
    loc.writeUInt16LE(0x0800, 6) // UTF-8 names
    loc.writeUInt16LE(8, 8)
    loc.writeUInt16LE(time, 10)
    loc.writeUInt16LE(date, 12)
    loc.writeUInt32LE(crc, 14)
    loc.writeUInt32LE(comp.length, 18)
    loc.writeUInt32LE(data.length, 22)
    loc.writeUInt16LE(name.length, 26)
    loc.writeUInt16LE(0, 28)
    locals.push(loc, name, comp)
    const cen = Buffer.alloc(46)
    cen.writeUInt32LE(SIG_CEN, 0)
    cen.writeUInt16LE(20, 4)
    cen.writeUInt16LE(20, 6)
    cen.writeUInt16LE(0x0800, 8)
    cen.writeUInt16LE(8, 10)
    cen.writeUInt16LE(time, 12)
    cen.writeUInt16LE(date, 14)
    cen.writeUInt32LE(crc, 16)
    cen.writeUInt32LE(comp.length, 20)
    cen.writeUInt32LE(data.length, 24)
    cen.writeUInt16LE(name.length, 28)
    cen.writeUInt32LE(offset, 42)
    cens.push(cen, name)
    offset += 30 + name.length + comp.length
  }
  const cd = Buffer.concat(cens)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(SIG_EOCD, 0)
  end.writeUInt16LE(files.length, 8)
  end.writeUInt16LE(files.length, 10)
  end.writeUInt32LE(cd.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, cd, end])
}
