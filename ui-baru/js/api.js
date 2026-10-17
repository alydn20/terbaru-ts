// Fungsi bersama untuk halaman login dan monitoring (tampilan baru).
// Semua data diambil dari API server yang sama dengan tampilan lama.


// ------------------------------------------------------------------ sesi
const SESSION_KEY = 'goldmonitor_session'
export const session = {
  get: () => { try { return localStorage.getItem(SESSION_KEY) || '' } catch (e) { return '' } },
  set: v => { try { localStorage.setItem(SESSION_KEY, v) } catch (e) {} },
  clear: () => { try { localStorage.removeItem(SESSION_KEY) } catch (e) {} }
}
export const withSession = url => url + (url.includes('?') ? '&' : '?') + 'session=' + encodeURIComponent(session.get())

// ------------------------------------------------------------------ fetch
export async function getJSON(url, opts = {}) {
  const res = await fetch(opts.session === false ? url : withSession(url), { cache: 'no-store' })
  if (opts.raw) return res
  return res.json()
}
export async function postJSON(url, body, opts = {}) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(opts.session === false ? body : { session: session.get(), ...body }),
    keepalive: !!opts.keepalive
  })
  return res.json()
}

// ------------------------------------------------------------------ format
export const rp = n => 'Rp' + Math.round(Number(n) || 0).toLocaleString('id-ID')
export const num = n => Math.round(Number(n) || 0).toLocaleString('id-ID')
export const signed = n => (n > 0 ? '+' : n < 0 ? '−' : '') + Math.abs(Math.round(n)).toLocaleString('id-ID')
export const pad2 = n => String(n).padStart(2, '0')
export const HARI = ['Minggu', 'Senin', 'Selasa', 'Rabu', 'Kamis', 'Jumat', 'Sabtu']
export const BULAN = ['Jan', 'Feb', 'Mar', 'Apr', 'Mei', 'Jun', 'Jul', 'Agu', 'Sep', 'Okt', 'Nov', 'Des']
export const tanggalPanjang = ms => new Date(Number(ms)).toLocaleDateString('id-ID', { day: 'numeric', month: 'long', year: 'numeric' })

// ------------------------------------------------------------------ DOM
export const $ = (sel, root = document) => root.querySelector(sel)
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)]
/** Buat elemen: h('div', { class: 'x', onclick: fn }, 'teks', anak2...) — teks selalu aman (bukan HTML) */
export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag)
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === false || v == null) continue
    if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v)
    else if (k === 'html') el.innerHTML = v // hanya untuk ikon SVG milik sendiri
    else el.setAttribute(k, v === true ? '' : v)
  }
  for (const c of children.flat()) if (c != null && c !== false) el.append(c instanceof Node ? c : String(c))
  return el
}

// ------------------------------------------------------------------ ikon (garis, gaya Lucide)
const ICON_PATHS = {
  layout: '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M9 21V9"/>',
  panels: '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 10h18M12 10v11"/>',
  swap: '<path d="M4 8h13l-3-3M20 16H7l3 3"/>',
  menu: '<path d="M4 6h16M4 12h16M4 18h16"/>',
  home: '<path d="M3 10.5 12 3l9 7.5V21H3z"/><path d="M9 21v-6h6v6"/>',
  chart: '<path d="M3 3v18h18"/><path d="m7 15 4-4 3 3 5-6"/>',
  tag: '<path d="M12 2H2v10l9.3 9.3a1 1 0 0 0 1.4 0l8.6-8.6a1 1 0 0 0 0-1.4z"/><circle cx="7" cy="7" r="1.5"/>',
  bell: '<path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.9 1.9 0 0 0 3.4 0"/>',
  settings: '<path d="M12.2 2h-.4a2 2 0 0 0-2 2v.2a2 2 0 0 1-1 1.7l-.4.3a2 2 0 0 1-2 0l-.2-.1a2 2 0 0 0-2.7.7l-.2.4a2 2 0 0 0 .7 2.7l.2.1a2 2 0 0 1 1 1.7v.5a2 2 0 0 1-1 1.7l-.2.1a2 2 0 0 0-.7 2.7l.2.4a2 2 0 0 0 2.7.7l.2-.1a2 2 0 0 1 2 0l.4.3a2 2 0 0 1 1 1.7v.2a2 2 0 0 0 2 2h.4a2 2 0 0 0 2-2v-.2a2 2 0 0 1 1-1.7l.4-.3a2 2 0 0 1 2 0l.2.1a2 2 0 0 0 2.7-.7l.2-.4a2 2 0 0 0-.7-2.7l-.2-.1a2 2 0 0 1-1-1.7v-.5a2 2 0 0 1 1-1.7l.2-.1a2 2 0 0 0 .7-2.7l-.2-.4a2 2 0 0 0-2.7-.7l-.2.1a2 2 0 0 1-2 0l-.4-.3a2 2 0 0 1-1-1.7V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/>',
  grid: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
  wa: '<path d="M3 21l1.65-4.9A8.5 8.5 0 1 1 8 19.3L3 21z"/><path d="M9 9.6c0 2.9 2.5 5.4 5.4 5.4l1.1-1.6-1.8-1.1-.8.7c-.9-.4-1.6-1.1-2-2l.7-.8-1.1-1.8L9 9.6z"/>',
  calc: '<rect x="4" y="2" width="16" height="20" rx="2"/><path d="M8 6h8M8 10h.01M12 10h.01M16 10h.01M8 14h.01M12 14h.01M16 14h.01M8 18h.01M12 18h4"/>',
  activity: '<path d="M22 12h-4l-3 9L9 3l-3 9H2"/>',
  sound: '<path d="M11 5 6 9H2v6h4l5 4z"/><path d="M15.5 8.5a5 5 0 0 1 0 7M19 5a10 10 0 0 1 0 14"/>',
  sliders: '<path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6"/>',
  moon: '<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5M12 15V3"/>',
  shield: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>',
  calendar: '<rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18M12 14v4M10 16h4"/>',
  users: '<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.9M16 3.1a4 4 0 0 1 0 7.8"/>',
  logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="m16 17 5-5-5-5M21 12H9"/>',
  push: '<path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.7 21a2 2 0 0 1-3.4 0"/><path d="M2 8c0-2.2.7-4.3 2-6M22 8a10 10 0 0 0-2-6"/>',
  close: '<path d="M18 6 6 18M6 6l12 12"/>',
  copy: '<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  up: '<path d="m18 15-6-6-6 6"/>',
  down: '<path d="m6 9 6 6 6-6"/>',
  left: '<path d="m15 18-6-6 6-6"/>',
  right: '<path d="m9 18 6-6-6-6"/>',
  upload: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m17 8-5-5-5 5M12 3v12"/>',
  qr: '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><path d="M14 14h3v3h-3zM20 14v.01M14 20h.01M17 20h4v-3"/>',
  info: '<circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/>',
  clock: '<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>'
}
export const icon = (name, cls = 'h-5 w-5') =>
  `<svg class="${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON_PATHS[name] || ''}</svg>`

// ------------------------------------------------------------------ tema
const THEME_KEY = 'goldmonitor_theme'
export function applyTheme(t) {
  const theme = t || (() => { try { return localStorage.getItem(THEME_KEY) } catch (e) { return null } })() || 'dark'
  document.documentElement.dataset.theme = theme
  const meta = document.querySelector('meta[name="theme-color"]')
  if (meta) meta.content = theme === 'light' ? '#eff3ff' : '#000000'
  return theme
}
// Ganti mode gelap/terang dengan transisi halus: View Transitions (memudar menyeluruh) bila didukung,
// selain itu warna latar/teks/garis berpindah perlahan lewat kelas .theme-fade.
// opts.origin = { x, y } titik awal lingkaran (mis. tengah sakelar); opts.after = dijalankan tepat setelah
// mode berganti (mis. menukar grafik) supaya ikut dalam animasi yang sama.
export function toggleTheme(opts = {}) {
  const next = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light'
  try { localStorage.setItem(THEME_KEY, next) } catch (e) {}
  const root = document.documentElement
  const apply = () => { applyTheme(next); if (opts.after) opts.after() }
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches
  if (reduce) { apply(); return next }
  const o = opts.origin || { x: innerWidth - 40, y: 30 }
  if (document.startViewTransition) {
    // lingkaran mode baru melebar dari sakelar sampai menutup seluruh layar
    root.classList.add('vt-theme')
    const t = document.startViewTransition(apply)
    t.finished.finally(() => root.classList.remove('vt-theme'))
    const r = Math.hypot(Math.max(o.x, innerWidth - o.x), Math.max(o.y, innerHeight - o.y))
    t.ready.then(() => {
      root.animate({ clipPath: ['circle(0px at ' + o.x + 'px ' + o.y + 'px)', 'circle(' + r + 'px at ' + o.x + 'px ' + o.y + 'px)'] },
        { duration: 650, easing: 'cubic-bezier(.4, 0, .2, 1)', pseudoElement: '::view-transition-new(root)' })
    }).catch(() => {})
    return next
  }
  // browser lama: lapisan warna mode lama memudar perlahan di atas mode baru
  const veil = document.createElement('div')
  veil.style.cssText = 'position:fixed;inset:0;z-index:9999;pointer-events:none;background:' + getComputedStyle(document.body).backgroundColor + ';opacity:1;transition:opacity .55s ease'
  document.body.append(veil)
  root.classList.add('theme-fade')
  apply()
  requestAnimationFrame(() => requestAnimationFrame(() => { veil.style.opacity = '0' }))
  setTimeout(() => { veil.remove(); root.classList.remove('theme-fade') }, 650)
  return next
}

// ------------------------------------------------------------------ toast
// Angka berganti dengan gulir halus: naik = angka baru masuk dari bawah, turun = dari atas.
export function rollText(el, text, dir = 0) {
  if (!el) return
  text = String(text)
  if (el.textContent === text) return
  el.textContent = text
  el.classList.remove('roll-up', 'roll-down', 'roll-in'); void el.offsetWidth
  el.classList.add(dir > 0 ? 'roll-up' : dir < 0 ? 'roll-down' : 'roll-in')
}
export function toast(msg, type = 'info', ms = 3200) {
  let box = document.getElementById('toasts')
  if (!box) {
    box = h('div', { id: 'toasts', class: 'pointer-events-none fixed inset-x-0 top-3 z-[80] flex flex-col items-center gap-2 px-4' })
    document.body.append(box)
  }
  const color = { success: 'border-up/40', error: 'border-down/40', warning: 'border-gold/40' }[type] || 'border-line/20'
  const t = h('div', { class: `pointer-events-auto max-w-md rounded-xl border ${color} bg-card px-4 py-3 text-sm font-semibold shadow-2xl` }, msg)
  t.classList.add('anim-toast-in')
  box.append(t)
  setTimeout(() => { t.classList.add('anim-toast-out'); setTimeout(() => t.remove(), 260) }, ms)
}

// ------------------------------------------------------------------ lembar bawah (sheet)
let backdrop
function ensureBackdrop() {
  if (backdrop) return backdrop
  backdrop = h('div', { class: 'sheet-back', onclick: () => closeAllSheets() })
  document.body.append(backdrop)
  return backdrop
}
/** Buka lembar: isi bisa elemen atau fungsi yang mengembalikan elemen. Mengembalikan objek { el, close }. */
export function openSheet(title, content, opts = {}) {
  ensureBackdrop()
  closeAllSheets(true)
  const body = typeof content === 'function' ? content() : content
  // peek: lembar kecil tanpa latar gelap (HP: setengah layar bawah, desktop: panel kanan bawah) supaya
  // perubahan di halaman tetap terlihat sambil mengatur
  const sheet = h('section', { class: 'sheet' + (opts.peek ? ' sheet-peek' : ''), role: 'dialog', 'aria-modal': 'true', 'aria-label': title || '' },
    h('div', { class: 'grip' }),
    title ? h('div', { class: 'mb-3 flex items-center justify-between gap-3' },
      h('h2', { class: 'text-base font-extrabold' }, title),
      h('button', { class: 'icon-btn h-9 w-9', 'aria-label': 'Tutup', html: icon('close', 'h-4 w-4'), onclick: () => api.close() })
    ) : null,
    body)
  document.body.append(sheet)
  document.body.classList.toggle('peek-open', !!opts.peek)
  if (!opts.peek) document.body.style.overflow = 'hidden'
  requestAnimationFrame(() => { sheet.classList.add('open'); backdrop.classList.add('open') })
  const api = {
    el: sheet,
    close: () => {
      sheet.style.pointerEvents = 'none'
      sheet.classList.remove('open')
      backdrop.classList.remove('open')
      document.body.style.overflow = ''
      document.body.classList.remove('peek-open')
      setTimeout(() => sheet.remove(), 220)
      if (opts.onClose) opts.onClose()
    }
  }
  sheet._api = api
  return api
}
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeAllSheets() })
export function closeAllSheets(instant) {
  $$('.sheet').forEach(s => (instant ? s.remove() : s._api ? s._api.close() : s.remove()))
  if (backdrop) backdrop.classList.remove('open')
  document.body.style.overflow = ''
}

// ------------------------------------------------------------------ dialog konfirmasi
export function confirmDialog(message, { title = 'Konfirmasi', ok = 'Ya', cancel = 'Batal', danger = false } = {}) {
  return new Promise(resolve => {
    const wrap = h('div', { class: 'anim-fade-in fixed inset-0 z-[90] flex items-center justify-center bg-black/70 p-5' })
    // tutup dengan animasi (memudar + mengecil) sebelum dihapus
    const done = v => { wrap.classList.add('anim-fade-out'); setTimeout(() => wrap.remove(), 200); resolve(v) }
    wrap.append(h('div', { class: 'anim-pop card w-full max-w-sm p-5 text-center shadow-2xl' },
      h('div', { class: 'mb-1 text-lg font-extrabold' }, title),
      h('p', { class: 'mb-5 text-sm leading-relaxed text-muted' }, message),
      h('div', { class: 'flex gap-2' },
        cancel ? h('button', { class: 'btn-ghost flex-1', onclick: () => done(false) }, cancel) : null,
        h('button', { class: (danger ? 'btn bg-down text-white' : 'btn-gold') + ' flex-1', onclick: () => done(true) }, ok))))
    wrap.addEventListener('click', e => { if (e.target === wrap && cancel) done(false) })
    document.body.append(wrap)
  })
}

export function contactAdmin(phone, text) {
  const nomor = phone && /^[0-9]+$/.test(phone) ? ' (+' + phone + ')' : ''
  // nomor admin tidak ditulis di halaman; server yang meneruskan ke WhatsApp admin
  window.open('/go/wa-admin?text=' + encodeURIComponent(text || ('Hallo saya' + nomor + ' butuh bantuan')), '_blank')
}

/** Perkecil foto di perangkat sebelum diunggah (hemat kuota, tetap terbaca) */
export async function shrinkImage(file) {
  try {
    const bm = await createImageBitmap(file)
    const sc = Math.min(1, 1600 / Math.max(bm.width, bm.height))
    const c = document.createElement('canvas')
    c.width = Math.max(1, Math.round(bm.width * sc))
    c.height = Math.max(1, Math.round(bm.height * sc))
    c.getContext('2d').drawImage(bm, 0, 0, c.width, c.height)
    return await new Promise(res => c.toBlob(res, 'image/jpeg', 0.75))
  } catch (e) { return file }
}

/** Lebar 768px ke bawah dianggap HP */
export const isMobile = () => window.matchMedia('(max-width: 768px)').matches
