// Suara & getar: harga naik/turun, naik/turun besar, promo ON/OFF, hitung mundur detik 55-59.
// Pengaturan disimpan di perangkat (localStorage 'soundSettings', sama dengan tampilan lama).
// Suara khusus dari admin diambil dari /api/sound-settings dan diperbarui lewat SSE 'sound_update'.
import { getJSON } from '../api.js'

const KEY = 'soundSettings'
export const SOUND_TYPES = [
  ['up', 'Harga naik'], ['bigUp', 'Harga naik besar (> Rp3.000)'],
  ['down', 'Harga turun'], ['bigDown', 'Harga turun besar (> Rp3.000)'],
  ['promo', 'Promo ON / OFF'], ['countdown', 'Hitung mundur detik 55–59']
]
export const SHAKE_TYPES = [['vibrate', 'Getar HP'], ['shake', 'Goyang layar']]
const DEFAULTS = { up: true, bigUp: true, down: true, bigDown: true, promo: true, countdown: true, vibrate: true, shake: true }

export const settings = (() => {
  try { return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(KEY) || '{}') } } catch (e) { return { ...DEFAULTS } }
})()
export function setSetting(type, on) {
  settings[type] = !!on
  try { localStorage.setItem(KEY, JSON.stringify(settings)) } catch (e) {}
}

// Suara khusus admin diputar lewat WebAudio (AudioBuffer), BUKAN new Audio().play():
// di HP (terutama iPhone) new Audio().play() diblokir kalau tidak tepat setelah layar disentuh,
// sehingga dulu selalu jatuh ke bunyi bawaan. AudioContext yang sudah dibuka sekali oleh sentuhan
// boleh memutar kapan saja.
let custom = {}
const buffers = {}   // url -> AudioBuffer
export function setCustomSounds(s) {
  custom = { up: s.soundUp, down: s.soundDown, bigUp: s.soundBigUp, bigDown: s.soundBigDown, on: s.soundOn, off: s.soundOff }
  Object.values(custom).forEach(u => { if (u) decode(u) })
}
async function decode(url) {
  if (!url || buffers[url]) return buffers[url]
  try {
    const data = await (await fetch(url)).arrayBuffer()
    const c = audio()
    buffers[url] = await new Promise((res, rej) => { const pr = c.decodeAudioData(data, res, rej); if (pr && pr.then) pr.then(res, rej) })
  } catch (e) { buffers[url] = null }
  return buffers[url]
}
export async function loadCustomSounds() {
  for (let i = 0; i < 5; i++) {
    try { const d = await getJSON('/api/sound-settings'); if (d.success) { setCustomSounds(d.settings || {}); return } } catch (e) {}
    await new Promise(r => setTimeout(r, 15000 * (i + 1)))
  }
}

// ---------- WebAudio (suara bawaan) ----------
let ctx = null
let interacted = false
const audio = () => {
  if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)()
  if (ctx.state === 'suspended') ctx.resume().catch(() => {})
  return ctx
}
// setiap sentuhan membuka (resume) audio lagi: iPhone menutupnya saat aplikasi ke latar belakang
;['pointerdown', 'keydown', 'touchstart'].forEach(ev => window.addEventListener(ev, () => { interacted = true; try { audio() } catch (e) {} }, { passive: true }))

function tones(list, type, vol) {
  try {
    const c = audio()
    list.forEach(([freq, at, len, to]) => {
      const o = c.createOscillator(); const g = c.createGain()
      o.connect(g); g.connect(c.destination); o.type = type
      o.frequency.setValueAtTime(freq, c.currentTime + at)
      if (to) o.frequency.exponentialRampToValueAtTime(to, c.currentTime + at + len)
      g.gain.setValueAtTime(vol, c.currentTime + at)
      g.gain.exponentialRampToValueAtTime(0.01, c.currentTime + at + len)
      o.start(c.currentTime + at); o.stop(c.currentTime + at + len)
    })
  } catch (e) {}
}
const BUILTIN = {
  up: () => tones([[800, 0, 0.15], [1200, 0.15, 0.15]], 'sine', 0.3),
  down: () => tones([[400, 0, 0.3, 150]], 'sawtooth', 0.2),
  bigUp: () => tones([[600, 0, 0.25], [900, 0.12, 0.25], [1400, 0.24, 0.25]], 'sine', 0.4),
  bigDown: () => tones([[1200, 0, 0.25], [800, 0.12, 0.25], [350, 0.24, 0.25]], 'sawtooth', 0.35)
}
async function playUrl(url, fallback, vol = 0.5) {
  if (!url) { if (fallback) fallback(); return }
  const buf = await decode(url)
  if (buf) {
    try {
      const c = audio()
      const src = c.createBufferSource(); const g = c.createGain()
      src.buffer = buf; g.gain.value = vol
      src.connect(g); g.connect(c.destination); src.start()
      return
    } catch (e) {}
  }
  // cadangan: elemen audio biasa, lalu bunyi bawaan
  const a = new Audio(url); a.volume = vol
  a.play().catch(() => { if (fallback) fallback() })
}

/** Harga beli berubah sebesar `change` */
export function priceSound(change) {
  const big = Math.abs(change) > 3000
  const type = change > 0 ? (big ? 'bigUp' : 'up') : (big ? 'bigDown' : 'down')
  if (!settings[type]) return
  const url = custom[type] || (big ? custom[change > 0 ? 'up' : 'down'] : '')
  playUrl(url, BUILTIN[type])
}
/** Status promo berubah; diberi jeda 5 detik supaya tidak bertabrakan dengan suara naik/turun */
export function promoSound(status) {
  if (!settings.promo) return
  setTimeout(() => playUrl(status === 'ON' ? (custom.on || '/ui-baru/sounds/promo-on.ogg') : (custom.off || '/ui-baru/sounds/promo-off.ogg'), null, 0.7), 5000)
}
export function notifSound() { if (settings.up) BUILTIN.up() }

let lastSec = -1
/** Dipanggil tiap detik; detik 55-59: bunyi + getar + goyang layar sesuai pengaturan */
export function countdownTick(sec, shakeEl) {
  if (sec < 55) { lastSec = sec; return }
  if (sec === lastSec) return
  lastSec = sec
  const final = sec === 59
  if (settings.countdown) tones(final ? [[1500, 0, 0.09], [1500, 0.13, 0.09]] : [[1000, 0, 0.09]], 'square', 0.25)
  if (settings.vibrate && interacted && navigator.vibrate) { try { navigator.vibrate(final ? [90, 50, 90] : 60) } catch (e) {} }
  if (settings.shake && shakeEl) {
    shakeEl.classList.remove('animate-shake'); void shakeEl.offsetWidth; shakeEl.classList.add('animate-shake')
  }
}
