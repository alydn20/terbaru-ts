// Menu "Lainnya" dan semua lembar alat: kalkulator, indikator, suara & getar, nominal,
// tema, notifikasi HP, install aplikasi, perpanjang, grup WA, panel admin, logout.
import { $, h, icon, rp, num, getJSON, postJSON, session, openSheet, closeAllSheets, confirmDialog, toast, toggleTheme, contactAdmin, tanggalPanjang } from '../api.js'
import { state, setNominalVisible, isNominalVisible } from './state.js'
import { settings as sound, setSetting, SOUND_TYPES, SHAKE_TYPES } from './sound.js'
import { INDICATORS, activeIndicators, saveIndicators, loadChart } from './chart.js'
import { mountPayment } from '../payment.js'

let hooks = {}
/** main.js memberi fungsi yang dibutuhkan menu (render ulang nominal/riwayat, sisa hari) */
export function setMenuHooks(h2) { hooks = h2 }

// ===================================================================== LAINNYA
export function openMore() {
  const light = document.documentElement.dataset.theme === 'light'
  // [ikon, label, aksi, gaya kotak (HP), gaya baris (desktop)]
  const defs = [
    ['calc', 'Kalkulator emas', openCalc],
    ['activity', 'Indikator grafik', openIndicators],
    ['sound', 'Suara & getar', openSound],
    ['sliders', 'Atur nominal', openNominalSettings],
    [light ? 'moon' : 'sun', light ? 'Mode gelap' : 'Mode terang', () => { toggleTheme(); loadChart(); closeAllSheets() }],
    ['push', 'Notifikasi HP', enablePush],
    state.user && state.user.expired ? ['calendar', 'Perpanjang masa aktif', openRenew, 'border-gold/40 bg-gold/10 text-gold', 'text-gold'] : null,
    hooks.canJoinGroup && hooks.canJoinGroup() ? ['users', 'Gabung grup WA', () => joinGroup(false)] : null,
    ['wa', 'Hubungi admin', () => contactAdmin(state.phone)],
    isInstalled() ? null : ['download', 'Install aplikasi', install],
    state.isAdmin ? ['shield', 'Panel admin', () => { location.href = '/admin/sso?session=' + encodeURIComponent(session.get()) }] : null,
    // kembali ke tampilan lama (diingat; di tampilan lama ada tombol "Coba tampilan baru")
    ['layout', 'Tampilan lama', () => { location.href = '/monitoring?ui=lama' }],
    ['logout', 'Keluar', logout, 'text-down', 'text-down']
  ].filter(Boolean)
  const profile = () => state.phone ? h('div', { class: 'tile mb-3 flex items-center gap-3 p-3' },
    h('div', { class: 'flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-gold/15 text-gold', html: icon('users', 'h-5 w-5') }),
    h('div', { class: 'min-w-0' },
      h('div', { class: 'truncate text-sm font-bold' }, (state.user && state.user.name) || 'Member'),
      h('div', { class: 'num text-xs text-muted' }, '+' + state.phone + ' · ' + (state.user && state.user.expired ? 'aktif sampai ' + tanggalPanjang(state.user.expired) : 'Lifetime')))) : null
  if (matchMedia('(min-width: 1024px)').matches) return openMoreDropdown(defs, profile)
  const tile = ([ic, label, onclick, extra = '']) =>
    h('button', { class: 'tile flex min-h-[84px] flex-col items-center justify-center gap-2 px-2 py-3 text-center text-xs font-semibold active:scale-95 ' + extra, onclick, html: icon(ic, 'h-6 w-6') + '<span>' + label + '</span>' })
  openSheet('Lainnya', h('div', {}, profile(), h('div', { class: 'grid grid-cols-3 gap-2' }, defs.map(tile))))
}

// Desktop: menu turun di bawah tombol Lainnya (bukan lembar dari bawah seperti di HP).
// Tutup: klik di luar, Esc, pilih menu, atau klik tombol Lainnya lagi.
function openMoreDropdown(defs, profile) {
  const old = document.getElementById('moreMenu')
  if (old) { old._close(); return }
  const btn = document.querySelector('#topNav [data-nav="lainnya"]')
  const r = btn ? btn.getBoundingClientRect() : { bottom: 56, right: window.innerWidth - 16 }
  const outside = e => { if (!menu.contains(e.target) && !(btn && btn.contains(e.target))) close() }
  const esc = e => { if (e.key === 'Escape') close() }
  const close = () => {
    menu.remove()
    document.removeEventListener('mousedown', outside, true)
    document.removeEventListener('keydown', esc)
    if (btn) btn.setAttribute('aria-expanded', 'false')
  }
  const row = ([ic, label, fn, , cls = '']) =>
    h('button', { class: 'flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left text-sm font-semibold transition hover:bg-card2 ' + cls, onclick: () => { close(); fn() }, html: icon(ic, 'h-4 w-4 shrink-0') + '<span>' + label + '</span>' })
  const last = defs.length - 1
  const menu = h('div', { id: 'moreMenu', role: 'menu', class: 'card fixed z-[60] max-h-[80vh] w-72 overflow-y-auto p-2 shadow-2xl', style: 'top:' + Math.round(r.bottom + 8) + 'px;right:' + Math.max(8, Math.round(window.innerWidth - r.right)) + 'px' },
    profile(),
    defs.slice(0, last).map(row),
    h('div', { class: 'my-1 border-t border-line/[0.08]' }),
    row(defs[last]))
  menu._close = close
  document.body.append(menu)
  if (btn) btn.setAttribute('aria-expanded', 'true')
  setTimeout(() => { document.addEventListener('mousedown', outside, true); document.addEventListener('keydown', esc) }, 0)
}

// ===================================================================== KALKULATOR
export function openCalc() {
  let type = 'buy'
  let tab = 'uang'
  const input = h('input', { class: 'input num font-mono text-lg', inputmode: 'decimal', placeholder: 'Contoh: 10000000' })
  const result = h('div', { class: 'tile mt-3 hidden p-4 text-center' })
  const price = () => (type === 'buy' ? state.buy : state.sell)
  const calc = () => {
    const v = parseFloat(String(input.value).replace(/\./g, '').replace(',', '.')) || 0
    if (!v || !price()) { result.classList.add('hidden'); return }
    result.classList.remove('hidden')
    result.replaceChildren(
      h('div', { class: 'label' }, tab === 'uang' ? 'Anda mendapatkan' : 'Nilai emas Anda'),
      h('div', { class: 'num mt-1 font-mono text-2xl font-extrabold text-gold' }, tab === 'uang' ? (v / price()).toFixed(4) + ' gram' : rp(v * price())),
      h('div', { class: 'mt-1 text-xs text-muted' }, 'Harga ' + (type === 'buy' ? 'beli' : 'jual') + ' ' + rp(price()) + '/gram'))
  }
  input.addEventListener('input', calc)
  const seg = (opts, get, set) => {
    const wrap = h('div', { class: 'seg' })
    const paint = () => [...wrap.children].forEach(b => b.setAttribute('aria-pressed', String(b.dataset.v === get())))
    opts.forEach(([v, l]) => wrap.append(h('button', { 'data-v': v, onclick: () => { set(v); paint(); calc() } }, l)))
    paint()
    return wrap
  }
  openSheet('Kalkulator emas', h('div', { class: 'flex flex-col gap-3' },
    seg([['buy', 'Harga beli ' + rp(state.buy)], ['sell', 'Harga jual ' + rp(state.sell)]], () => type, v => { type = v }),
    seg([['uang', 'Uang → Gram'], ['gram', 'Gram → Uang']], () => tab, v => {
      tab = v
      input.placeholder = v === 'uang' ? 'Jumlah uang, contoh: 10000000' : 'Jumlah gram, contoh: 2.5'
    }),
    input, result))
  setTimeout(() => input.focus(), 250)
}

// ===================================================================== INDIKATOR
export function openIndicators() {
  const chosen = new Set(activeIndicators())
  openSheet('Indikator grafik', h('div', {},
    h('div', { class: 'flex flex-col divide-y divide-line/[0.06]' }, INDICATORS.map(([id, label]) => {
      const t = h('input', { type: 'checkbox', class: 'toggle' })
      t.checked = chosen.has(id)
      t.addEventListener('change', () => { if (t.checked) chosen.add(id); else chosen.delete(id) })
      return h('label', { class: 'flex items-center justify-between py-3 text-sm font-semibold' }, label, t)
    })),
    h('button', { class: 'btn-gold mt-3 w-full', onclick: () => { saveIndicators([...chosen]); closeAllSheets(); toast('Indikator diterapkan', 'success') } }, 'Terapkan')))
}

// ===================================================================== SUARA & GETAR
export function openSound() {
  const row = ([id, label]) => {
    const t = h('input', { type: 'checkbox', class: 'toggle' })
    t.checked = !!sound[id]
    t.addEventListener('change', () => setSetting(id, t.checked))
    return h('label', { class: 'flex items-center justify-between gap-3 py-3 text-sm font-semibold' }, label, t)
  }
  const getar = SHAKE_TYPES.filter(([id]) => id !== 'vibrate' || 'vibrate' in navigator)
  openSheet('Suara & getar', h('div', {},
    h('div', { class: 'label mb-1' }, 'Suara'),
    h('div', { class: 'divide-y divide-line/[0.06]' }, SOUND_TYPES.map(row)),
    h('div', { class: 'label mb-1 mt-4' }, 'Getar'),
    h('div', { class: 'divide-y divide-line/[0.06]' }, getar.map(row)),
    !('vibrate' in navigator) ? h('p', { class: 'mt-2 text-xs text-muted' }, 'Getar HP tidak didukung di perangkat ini (umumnya iPhone).') : null))
}

// ===================================================================== NOMINAL
export function openNominalSettings() {
  openSheet('Nominal yang dipantau', h('div', {},
    h('p', { class: 'mb-2 text-xs text-muted' }, 'Pilih nominal yang tampil di kartu untung dan tabel riwayat.'),
    h('div', { class: 'divide-y divide-line/[0.06]' }, state.nominals.map(n => {
      const t = h('input', { type: 'checkbox', class: 'toggle' })
      t.checked = isNominalVisible(n.id)
      t.addEventListener('change', () => { setNominalVisible(n.id, t.checked); if (hooks.refreshNominals) hooks.refreshNominals() })
      return h('label', { class: 'flex items-center justify-between py-3 text-sm font-semibold' },
        h('span', {}, n.label, h('span', { class: 'ml-2 text-xs font-normal text-muted' }, rp(n.amount))), t)
    }))))
}

// ===================================================================== NOTIFIKASI HP
function b64ToBytes(s) {
  const pad = '='.repeat((4 - s.length % 4) % 4)
  const raw = atob((s + pad).replace(/-/g, '+').replace(/_/g, '/'))
  return Uint8Array.from(raw, c => c.charCodeAt(0))
}
export async function subscribePush() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) return false
  try {
    const reg = await navigator.serviceWorker.ready
    const { publicKey } = await (await fetch('/api/vapid-public-key')).json()
    const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(publicKey) })
    await postJSON('/api/push-subscribe', { subscription: sub })
    return true
  } catch (e) { return false }
}
async function enablePush() {
  closeAllSheets()
  if (!('Notification' in window)) { toast('Browser ini tidak mendukung notifikasi. Di iPhone, install aplikasi dulu (Bagikan → Tambahkan ke Layar Utama).', 'warning', 6000); return }
  if (Notification.permission === 'denied') { toast('Notifikasi diblokir. Izinkan lewat pengaturan browser.', 'warning', 5000); return }
  const p = Notification.permission === 'granted' ? 'granted' : await Notification.requestPermission()
  if (p !== 'granted') return
  toast((await subscribePush()) ? 'Notifikasi HP aktif' : 'Notifikasi aktif di browser ini', 'success')
}

// ===================================================================== INSTALL
let deferredPrompt = null
window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); deferredPrompt = e })
const isInstalled = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true
async function install() {
  closeAllSheets()
  if (deferredPrompt) { deferredPrompt.prompt(); deferredPrompt = null; return }
  const ios = /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
  await confirmDialog(ios
    ? 'Di Safari: ketuk tombol Bagikan (kotak dengan panah ke atas), lalu pilih "Tambahkan ke Layar Utama".'
    : 'Buka menu browser (⋮), lalu pilih "Install aplikasi" atau "Tambahkan ke Layar Utama".', { title: 'Cara install', ok: 'Mengerti', cancel: null })
}

// ===================================================================== PERPANJANG
export async function openRenew() {
  if (state.user && !state.user.expired) { toast('Akun Lifetime, tidak perlu diperpanjang.'); return }
  const root = h('div', {}, h('div', { class: 'py-10 text-center text-sm text-muted' }, 'Memuat...'))
  let stop = null
  openSheet('Perpanjang masa aktif', h('div', {},
    state.user && state.user.expired ? h('p', { class: 'mb-3 text-xs text-muted' }, 'Aktif sampai ' + tanggalPanjang(state.user.expired) + '. Sisa hari Anda tidak hilang.') : null,
    root), { onClose: () => stop && stop() })
  let cfg = null
  try { cfg = await (await fetch('/api/payment/config', { cache: 'no-store' })).json() } catch (e) {}
  if (!cfg || !cfg.enabled) {
    root.replaceChildren(
      h('p', { class: 'mb-3 text-sm text-muted' }, cfg ? 'Pembayaran QRIS sedang tidak aktif. Hubungi admin untuk perpanjang.' : 'Gagal memuat. Coba lagi sebentar lagi.'),
      cfg ? h('button', { class: 'btn-green w-full', onclick: () => contactAdmin(state.phone, 'Hallo saya (+' + state.phone + ') mau perpanjang masa aktif'), html: icon('wa') + '<span>Chat admin</span>' }) : null)
    return
  }
  stop = mountPayment(root, {
    phone: state.phone,
    renew: true,
    months: 1,
    monthOptions: cfg.renewMonths || [1],
    pricePerMonth: cfg.price,
    onPaid: until => { if (until && state.user) { state.user.expired = Number(until); if (hooks.renderSisaHari) hooks.renderSisaHari() } }
  })
}

// ===================================================================== GRUP WA
async function groupInfo() { try { return await getJSON('/api/group-link') } catch (e) { return null } }
const savePref = (choice, days) => postJSON('/api/group-pref', { choice, days: days || 0 }, { keepalive: true }).catch(() => {})

/** silent = dipanggil otomatis saat halaman dibuka (tanya kalau perlu); tanpa silent = user menekan menu */
export async function joinGroup(silent) {
  const d = await groupInfo()
  if (hooks.setCanJoinGroup) hooks.setCanJoinGroup(!!(d && d.success && d.show))
  if (!d || !d.success) { if (!silent) toast((d && d.error) || 'Link grup belum tersedia. Coba lagi nanti.', 'warning'); return }
  if (!d.show) return
  if (silent) { if (d.ask) askJoin(d.maxDays); return }
  closeAllSheets()
  if (!d.wants) savePref('yes', 0)
  await confirmDialog(d.wants ? 'Permintaan Anda sudah tercatat. Admin akan memasukkan Anda ke grup WhatsApp.' : 'Permintaan terkirim. Admin akan memasukkan Anda ke grup WhatsApp.', { title: 'Gabung grup WA', ok: 'OK', cancel: null })
}
// Wajib dijawab: tidak ada tombol tutup, klik di luar / Esc tidak menutup. Halaman baru bisa
// dipakai lagi setelah user memilih Ya atau Tidak (sama seperti tampilan lama).
function askJoin(maxDays) {
  // batas hari = sisa masa aktif user (dari server); Lifetime 365
  const maxD = Math.max(1, Math.min(365, parseInt(maxDays, 10) || 365))
  closeAllSheets(true)
  const old = document.getElementById('askJoinModal')
  if (old) old.remove()
  const body = h('div', {})
  const wrap = h('div', { id: 'askJoinModal', class: 'fixed inset-0 z-[90] flex items-center justify-center bg-black/80 p-5', role: 'dialog', 'aria-modal': 'true' },
    h('div', { class: 'card w-full max-w-sm p-5 text-center shadow-2xl' },
      h('h2', { class: 'mb-3 text-base font-extrabold' }, 'Grup notifikasi WhatsApp'), body))
  const sheet = { close: () => { wrap.remove(); document.body.style.overflow = '' } }
  const step1 = () => body.replaceChildren(
    h('p', { class: 'mb-4 text-sm text-muted' }, 'Ingin bergabung ke grup notifikasi harga di WhatsApp?'),
    h('button', { class: 'btn-green w-full', onclick: () => { savePref('yes', 0); body.replaceChildren(h('p', { class: 'mb-4 text-sm text-muted' }, 'Permintaan terkirim. Admin akan memasukkan Anda ke grup WhatsApp.'), h('button', { class: 'btn-gold w-full', onclick: () => sheet.close() }, 'OK')) } }, 'Ya, gabung'),
    h('button', { class: 'btn-ghost mt-2 w-full', onclick: step2 }, 'Tidak'))
  const step2 = () => {
    const inp = h('input', { type: 'number', min: 1, max: maxD, value: Math.min(7, maxD), class: 'input w-24 text-center font-mono text-lg', onchange: () => { inp.value = val() } })
    const val = () => Math.min(maxD, Math.max(1, parseInt(inp.value, 10) || 1))
    body.replaceChildren(
      h('p', { class: 'mb-3 text-sm text-muted' }, 'Tanya lagi setelah berapa hari? (maks ' + maxD + ' hari, sesuai masa aktif)'),
      h('div', { class: 'mb-4 flex items-center justify-center gap-2' },
        h('button', { class: 'icon-btn', onclick: () => { inp.value = Math.max(1, val() - 1) } }, '−'), inp, h('span', { class: 'text-sm text-muted' }, 'hari'),
        h('button', { class: 'icon-btn', onclick: () => { inp.value = Math.min(maxD, val() + 1) } }, '+')),
      h('button', { class: 'btn-gold w-full', onclick: () => { savePref('no', val()); sheet.close() } }, 'Tanya lagi nanti'),
      h('button', { class: 'btn-ghost mt-2 w-full', onclick: () => { savePref('no', 0); sheet.close() } }, 'Jangan tanya lagi'),
      h('button', { class: 'mt-2 w-full py-2 text-xs text-muted', onclick: step1 }, 'Kembali'))
  }
  step1()
  document.body.append(wrap)
  document.body.style.overflow = 'hidden'
}

// ===================================================================== KELUAR
export async function logout() {
  closeAllSheets()
  if (!(await confirmDialog('Yakin ingin keluar dari akun ini?', { title: 'Keluar', ok: 'Keluar', danger: true }))) return
  try { await postJSON('/api/logout', {}) } catch (e) {}
  session.clear()
  location.replace('/login')
}
