// A short two-tone chime synthesized with the Web Audio API — no audio asset to host or ship.
//
// **Every caller is now in this file** (S763). PosOrders.jsx, GuestMenu.jsx and the Kitchen Display
// each carried their own inline copy, left in place when this file was created on the reasoning
// that "each is on a live service screen and none of them is wrong". All three WERE wrong, in the
// same way, and it took building a repeating alert to see it: each built a new `AudioContext` per
// call and never closed one. Chrome caps a document at about six, so on any screen that is opened
// once and left running — the kitchen board, the floor, the reservations page — the seventh event
// of a service made **no sound at all**, silently. `getCtx()` below keeps one and reuses it.
//
// Browsers block audio before any user gesture on the page; staff reach these screens through a
// PIN login or a tap, so in practice the gesture has already happened.
export function playChime(tones = [880, 660], step = 0.18) {
  try {
    const ctx = getCtx()
    if (!ctx) return
    const now = ctx.currentTime
    tones.forEach((freq, i) => {
      const osc = ctx.createOscillator()
      const gain = ctx.createGain()
      osc.type = 'sine'
      osc.frequency.value = freq
      gain.gain.setValueAtTime(0.0001, now + i * step)
      gain.gain.exponentialRampToValueAtTime(0.3, now + i * step + 0.02)
      gain.gain.exponentialRampToValueAtTime(0.0001, now + i * step + step - 0.02)
      osc.connect(gain); gain.connect(ctx.destination)
      osc.start(now + i * step)
      osc.stop(now + i * step + step)
    })
  } catch (_) { /* audio blocked or unsupported — the screen still updates visually */ }
}

// ── The app-wide guest-order alert (S763) ────────────────────────────────────────────────────
//
// `playChime` above builds a NEW AudioContext on every call and never closes it. That is fine for
// a chime that fires once when something arrives; it is not fine for an alert that REPEATS until
// someone deals with it — Chrome caps a document at ~6 concurrent AudioContexts, so the seventh
// repeat throws and the alert goes silent exactly when it has been ignored longest. This one
// keeps a single module-level context and reuses it.
let sharedCtx = null
function getCtx() {
  const Ctx = window.AudioContext || window.webkitAudioContext
  if (!Ctx) return null
  if (!sharedCtx || sharedCtx.state === 'closed') sharedCtx = new Ctx()
  // A context created before any user gesture starts 'suspended', and a tab left alone long enough
  // can have one suspended under it. resume() is a promise we deliberately do not await — if it is
  // still blocked the notes simply do not sound, and the banner is the part that always works.
  if (sharedCtx.state === 'suspended') sharedCtx.resume().catch(() => {})
  return sharedCtx
}

// Deliberately louder and longer than `playChime`: three rising notes, played twice, at roughly
// double the gain. A guest order nobody accepts is food nobody is cooking, and this has to carry
// across a kitchen from a tablet sitting on a counter. `urgent` adds a fourth repeat and a harder
// timbre for an order that has been waiting past the escalation threshold.
export function playGuestAlert({ urgent = false } = {}) {
  try {
    const ctx = getCtx()
    if (!ctx) return
    const now = ctx.currentTime
    const phrase = [988, 1319, 988]      // B5 → E6 → B5
    const step = 0.16
    const rounds = urgent ? 3 : 2
    const gap = 0.12
    for (let r = 0; r < rounds; r++) {
      const base = now + r * (phrase.length * step + gap)
      phrase.forEach((freq, i) => {
        const osc = ctx.createOscillator()
        const gain = ctx.createGain()
        osc.type = urgent ? 'triangle' : 'sine'
        osc.frequency.value = freq
        const t = base + i * step
        gain.gain.setValueAtTime(0.0001, t)
        gain.gain.exponentialRampToValueAtTime(urgent ? 0.75 : 0.6, t + 0.02)
        gain.gain.exponentialRampToValueAtTime(0.0001, t + step - 0.02)
        osc.connect(gain); gain.connect(ctx.destination)
        osc.start(t)
        osc.stop(t + step)
      })
    }
  } catch (_) { /* audio blocked or unsupported — the banner still shows */ }
}
