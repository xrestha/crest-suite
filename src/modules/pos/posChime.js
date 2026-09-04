// A short two-tone chime synthesized with the Web Audio API — no audio asset to host or ship.
//
// PosOrders.jsx (guest order arrived), GuestMenu.jsx (your order moved) and the Kitchen Display
// each carry their own inline copy of this; the Reservations page is the fourth caller, and a
// fourth inline copy is where a decision made three times becomes a file (staffLevelBadge.js,
// operatingBands.js). The existing three are left in place rather than migrated in the same
// change — each is on a live service screen and none of them is wrong.
//
// Browsers block audio before any user gesture on the page; staff reach these screens through a
// PIN login or a tap, so in practice the gesture has already happened.
export function playChime(tones = [880, 660], step = 0.18) {
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext
    if (!Ctx) return
    const ctx = new Ctx()
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
