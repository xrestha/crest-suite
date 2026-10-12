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
// Browsers block audio until someone touches the page. A screen reached by a tap is fine; one the
// browser reloaded or restored by itself (a crash, a power cut, a release reload) is not, and plays
// nothing until a tap. `soundBlocked` / `unlockAudio` / `primeAudio` at the end of this file let a
// screen say so and let that tap start it (S809 3c, S817 4i FLOOR-KITCHEN-9).
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
// Every sound here shares ONE module-level context. Until S763 each call built a new AudioContext
// and never closed it, and Chrome caps a document at ~6, so a repeating alert went silent exactly
// when it had been ignored longest (see the header). `playChime` above goes through it too.
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

// ── Whether the browser is letting this page play sound (S809 3c) ───────────────────────────
//
// A page that loaded without anyone touching it (the PIN screen reloads itself to take a release,
// S809 1b; a power cut; a restored tab) gets its context 'suspended', and every note above plays
// into nothing until a person taps the page. These two let a screen say so and let that tap unlock
// it. Neither creates a context: one exists once an alert has tried to sound.

// True only when a context exists and the browser is holding it ('suspended', or Safari's
// 'interrupted'). False before any sound was tried, and where the browser has no Web Audio.
export function soundBlocked() {
  return !!sharedCtx && sharedCtx.state !== 'running' && sharedCtx.state !== 'closed'
}

// Call from inside a tap or key handler: that is the one place a browser lets a held context start.
export function unlockAudio() {
  if (sharedCtx && sharedCtx.state !== 'running' && sharedCtx.state !== 'closed') {
    sharedCtx.resume().catch(() => {})
  }
}

// S817 4i (FLOOR-KITCHEN-9): make the context now, before any sound, so `soundBlocked` can answer
// while the screen is still quiet. The Kitchen Display calls it on opening: a board restored by the
// browser overnight then says the sound is off before the first ticket lands, not after it rang into
// nothing. Making a context plays nothing; a held one simply starts 'suspended'.
export function primeAudio() {
  try { getCtx() } catch (_) { /* no Web Audio: soundBlocked stays false and nothing is said */ }
}
