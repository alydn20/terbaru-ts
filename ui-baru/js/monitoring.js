// Halaman monitoring (tampilan baru). Alur:
// 1. cek sesi  2. muat harga + data pendukung  3. sambung SSE realtime  4. pasang navigasi & menu.
import './monitoring/defaults.js'
import { $, $$, h, icon, num, signed, rp, pad2, HARI, BULAN, getJSON, session, confirmDialog, toast, contactAdmin, applyTheme, toggleTheme, tanggalPanjang, openSheet, rollText } from './api.js'
import { state, visibleNominals, profitOf, markupOf } from './monitoring/state.js'
import { priceSound, promoSound, notifSound, countdownTick, loadCustomSounds, setCustomSounds } from './monitoring/sound.js'
import { initHistory, onNewPrice, onUsdIdr, loadHistory, histRowsSetting, setHistRows } from './monitoring/history.js'
import { initChart, loadChart } from './monitoring/chart.js'
import { loadNews, openNews, loadPromos, setPromos, openPromos } from './monitoring/news.js'
import { startTour, tourDone } from './monitoring/tour.js'
import { scheduleInstallInvite, isInstalled } from './monitoring/install.js'
import { openMore, openRenew, openIndicators, openNominalSettings, openPriceBox, joinGroup, subscribePush, setMenuHooks } from './monitoring/menu.js'

applyTheme()
if (!session.get()) location.replace('/login')

// Pengaman: halaman tidak boleh memuat ulang sendiri berulang-ulang (mis. versi server berganti-ganti saat
// restart, atau sesi admin tidak bisa disegarkan). Maks. 2 kali per menit; selebihnya diam.
function safeReload() {
  let list = []
  try { list = JSON.parse(sessionStorage.getItem('autoReloads') || '[]').filter(t => Date.now() - t < 60000) } catch (e) {}
  if (list.length >= 2) return false
  list.push(Date.now())
  try { sessionStorage.setItem('autoReloads', JSON.stringify(list)) } catch (e) {}
  location.reload()
  return true
}
// ===================================================================== SESI
const GRACE_MS = 24 * 3600 * 1000 // server bermasalah: user tetap boleh memantau maks 24 jam
const markOk = () => { try { localStorage.setItem('gold_sess_ok_at', String(Date.now())) } catch (e) {} }
const graceOver = () => { try { const t = +localStorage.getItem('gold_sess_ok_at') || 0; return t && Date.now() - t > GRACE_MS } catch (e) { return false } }
let ending = false
async function endSession(message, title, extra) {
  if (ending) return
  ending = true
  session.clear()
  if (extra) extra()
  setTimeout(() => location.replace('/login'), 10000)
  if (message) await confirmDialog(message, { title, ok: 'Login lagi', cancel: null })
  location.replace('/login')
}
function handleInvalid(d) {
  if (d.reason === 'kicked_other_device') {
    return endSession('Akun Anda baru saja login di perangkat lain. Jumlah perangkat aktif per akun dibatasi, jadi sesi di perangkat ini dikeluarkan.', 'Login di perangkat lain',
      () => { try { localStorage.setItem('gold_kicked_notice', String(Date.now())) } catch (e) {} })
  }
  if (d.reason === 'expired') return endSession('Masa aktif akun Anda sudah habis. Perpanjang dari halaman login.', 'Masa aktif habis')
  if (d.reason === 'server_error') { if (graceOver()) endSession('Sesi Anda telah berakhir. Silakan login kembali.', 'Sesi berakhir'); return }
  // sesi admin dari panel: segarkan otomatis
  if (session.get().startsWith('admin_') && !d.reason) {
    fetch('/api/admin-session-refresh').then(r => r.json()).then(x => {
      if (x.success && x.sessionId) { session.set(x.sessionId); markOk(); safeReload() }
    }).catch(() => {})
    return
  }
  endSession('Sesi Anda telah berakhir. Silakan login kembali.', 'Sesi berakhir')
}
/** null = jaringan/server tidak terjangkau (jangan keluarkan user) */
// null = tidak bisa dicek (tidak ada sinyal / server sibuk) -> sesi TIDAK diakhiri.
// Hanya jawaban asli server ({ valid: true/false }) yang dipakai untuk memutuskan sesi berakhir.
async function verify() {
  if (navigator.onLine === false) return null
  try {
    const d = await getJSON('/api/verify-session')
    return d && typeof d.valid === 'boolean' ? d : null
  } catch (e) { return null }
}

// ===================================================================== HEADER: sisa masa aktif
const CTA_HIDE = 'renew_cta_hide'
function renderSisaHari() {
  const el = $('#sisaHari')
  const u = state.user
  if (!u) return
  el.classList.remove('hidden'); el.classList.add('flex')
  if (!u.expired) { el.className = 'mt-0.5 flex shrink-0 items-center gap-1.5 whitespace-nowrap text-xs font-semibold text-muted'; el.textContent = 'Akun Lifetime'; el.onclick = null; el.parentElement.classList.remove('has-renew'); return }
  const ms = Number(u.expired) - Date.now()
  const hari = Math.ceil(ms / 86400000)
  const color = ms <= 0 || hari <= 3 ? 'text-down' : hari <= 7 ? 'text-gold' : 'text-up'
  // HP: singkat ("8 jam", "3 hari", "Habis"); tablet & desktop: lengkap ("Sisa 8 jam lagi")
  const jam = Math.max(1, Math.ceil(ms / 3600000))
  const pendek = ms <= 0 ? 'Habis' : hari <= 1 ? jam + ' jam' : hari + ' hari'
  const panjang = ms <= 0 ? 'Masa aktif habis' : hari <= 1 ? 'Sisa ' + jam + ' jam lagi' : 'Sisa ' + hari + ' hari lagi'
  const wajib = ms <= 0 || hari <= 7
  let hidden = false
  try { hidden = !wajib && localStorage.getItem(CTA_HIDE) === String(u.expired) } catch (e) {}
  el.className = 'mt-0.5 flex shrink-0 items-center gap-1 whitespace-nowrap text-[11px] font-semibold lg:gap-1.5 lg:text-xs ' + color
  el.title = 'Aktif sampai ' + tanggalPanjang(u.expired)
  el.replaceChildren(h('span', { class: 'lbl-s' }, pendek), h('span', { class: 'lbl-l' }, panjang))
  // tombol Perpanjang tampil: tanggal di bar atas disembunyikan di HP kecil supaya tidak terpotong "..."
  el.parentElement.classList.toggle('has-renew', !hidden)
  if (!hidden) {
    // sisa <= 7 hari / habis: merah & berkedip pelan (mendesak); selain itu emas biasa
    const pill = h('span', { class: 'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-extrabold lg:text-[11px] ' + (wajib ? 'renew-urgent bg-down text-white' : 'bg-gold text-bg') }, 'Perpanjang')
    if (!wajib) {
      pill.append(h('span', {
        class: 'ml-0.5 cursor-pointer opacity-70', role: 'button', 'aria-label': 'Tutup',
        onclick: e => { e.stopPropagation(); try { localStorage.setItem(CTA_HIDE, String(u.expired)) } catch (x) {} pill.remove(); el.parentElement.classList.remove('has-renew') }
      }, '×'))
    }
    el.append(pill)
  }
  el.onclick = openRenew
}
/** Sisa <= 7 hari: tanya sekali sehari; dari notifikasi (?perpanjang=1) langsung buka */
function renewReminder() {
  const u = state.user
  if (!u || !u.expired) return
  if (/[?&]perpanjang=1/.test(location.search)) { history.replaceState(null, '', location.pathname); openRenew(); return }
  const ms = Number(u.expired) - Date.now()
  const hari = Math.ceil(ms / 86400000)
  if (ms <= 0 || hari > 7) return
  const today = new Date().toDateString()
  try { if (localStorage.getItem('renew_ask_day') === today) return; localStorage.setItem('renew_ask_day', today) } catch (e) {}
  confirmDialog('Masa aktif tinggal ' + (hari <= 1 ? 'kurang dari 1 hari' : hari + ' hari') + '. Perpanjang sekarang?', { title: 'Perpanjang masa aktif', ok: 'Perpanjang', cancel: 'Nanti' })
    .then(ok => { if (ok) openRenew() })
}

// ===================================================================== HARGA
const pillHtml = n => (n > 0 ? 'pill-up' : 'pill-down')
function setChange(id, change) {
  const el = $('#' + id)
  if (!change) return
  el.className = pillHtml(change) + ' px-1.5 py-0 text-[10px] lg:text-xs'
  el.textContent = (change > 0 ? '▲' : '▼') + signed(change)
}
// Kotak Beli/Jual: hijau penuh saat naik, merah penuh saat turun (bertahan sampai harga berubah lagi)
function flash(id, change) {
  const el = $('#' + id)
  el.classList.remove('flash-up', 'flash-down', 'tile-up', 'tile-down', 'tile-blink'); void el.offsetWidth
  // + berkedip +-3 detik supaya terlihat itu harga terbaru
  el.classList.add(change > 0 ? 'tile-up' : 'tile-down', 'tile-blink')
}
function updateDayRange(buy) {
  if (state.high === null || buy > state.high) { state.high = buy; $('#dayHigh').textContent = num(buy) }
  if (state.low === null || buy < state.low) { state.low = buy; $('#dayLow').textContent = num(buy) }
}
function renderMarkup() {
  if (!(state.sell && state.xauUsd && state.usdIdr)) return
  const mk = markupOf(state.sell, state.xauUsd, state.usdIdr)
  $('#chipMarkup').classList.toggle('hidden', mk.normal)
  if (!mk.normal) {
    // disingkat: MU = markup, MD = markdown (nama lengkap di tooltip)
    $('#markupLabel').innerHTML = mk.diff > 0 ? '<span class="lbl-s">MU</span><span class="lbl-l">Markup</span>' : '<span class="lbl-s">MD</span><span class="lbl-l">Markdown</span>'
    $('#chipMarkup').title = mk.diff > 0 ? 'Markup' : 'Markdown'
    $('#markupVal').textContent = signed(mk.diff)
  }
}
function renderSpread() {
  if (!state.buy || !state.sell) return
  $('#spreadVal').textContent = parseFloat(((state.sell - state.buy) / state.buy * 100).toFixed(2)) + '%'
}
// Nilai kecil (untung nominal, Limit/MD/Spread/ON, Max/Min) berubah -> kotaknya berkedip sebentar
// (latar menyala lalu pudar + angka berkedip). Tidak mengubah ukuran, jadi tampilan tidak bergeser.
function pulse(el) {
  if (!el) return
  el.classList.remove('val-flash'); void el.offsetWidth
  el.classList.add('val-flash')
}
let lastProfit = {}
function renderNominals() {
  const box = $('#nominals')
  const list = visibleNominals()
  if (!state.nominals.length) return
  // 0 nominal dipilih: bagian untung per nominal disembunyikan (atur lagi dari Lainnya > Atur kotak harga)
  $('#nomWrap').classList.toggle('nom-off', !list.length)
  if (!list.length) { box.replaceChildren(); fitChart(); return }
  // Desktop: grid, jumlah kolom menyesuaikan jumlah nominal supaya kotak harga tidak memanjang:
  // 1 -> 1 (kotak lebar di tengah), 2 -> 2, 3 -> 3, 4 -> 2x2, 5+ -> 3 kolom. HP: 3 per baris, rata tengah.
  const cols = list.length === 1 ? 'lg:grid-cols-1' : list.length === 2 || list.length === 4 ? 'lg:grid-cols-2' : 'lg:grid-cols-3'
  box.className = 'flex flex-wrap justify-center gap-1 lg:grid lg:gap-2 ' + cols
  box.replaceChildren(...list.map((n, i) => {
    const p = state.buy && state.sell ? profitOf(n, state.buy, state.sell) : null
    // HP: 3 per baris; desktop: 2 per baris. Hanya 1 nominal: satu kotak lebar di tengah.
    const one = list.length === 1
    const size = one ? 'basis-1/2 lg:w-full lg:max-w-[300px] lg:justify-self-center' : 'basis-[calc((100%-0.5rem)/3)]'
    // singkat: tanpa "Rp", gram 3 desimal + "g" (angka lengkap di tooltip)
    // "Rp" hanya tampil di tablet & desktop (.rp-pfx disembunyikan di HP)
    const untung = p ? '<span>' + (p.profit >= 0 ? '+' : '−') + '<span class="rp-pfx">Rp</span>' + num(Math.abs(p.profit)) + '</span>' : ''
    const gram = p ? p.gram.toFixed(3).replace('.', ',') + 'g' : '—'
    const changed = p && lastProfit[n.id] !== undefined && lastProfit[n.id] !== p.profit
    if (p) lastProfit[n.id] = p.profit
    return h('div', { class: 'tile min-w-0 grow-0 overflow-hidden px-1.5 py-1 text-center lg:px-2.5 lg:py-1.5 lg:text-left ' + size + (changed ? ' val-flash' : '') },
      // HP: satu baris "10jt +Rp1.426" (gram di tooltip). Desktop: baris 1 = nominal + untung, baris 2 = gram
      h('div', { class: 'flex items-center justify-center gap-1.5 whitespace-nowrap lg:justify-between lg:gap-2', title: p ? (p.profit >= 0 ? 'Untung ' : 'Rugi ') + rp(Math.abs(p.profit)) + ' · ' + p.gram.toFixed(4) + ' gram' : '' },
        h('span', { class: 'font-extrabold text-gold ' + (one ? 'text-[12px] lg:text-base' : 'text-[11px] lg:text-[13px]') }, n.label),
        p ? h('span', { class: 'num font-extrabold lg:hidden ' + (one ? 'text-[12.5px] ' : 'text-[11.5px] ') + (p.profit >= 0 ? 'text-up' : 'text-down'), html: untung }) : null,
        p ? h('span', { class: 'num hidden shrink-0 lg:inline-flex ' + (p.profit >= 0 ? 'pill-up' : 'pill-down') + (one ? ' lg:text-sm' : ''), html: untung }) : null),
      h('div', { class: 'num mt-0.5 hidden whitespace-nowrap font-mono text-muted lg:block ' + (one ? 'text-xs' : 'text-[11px]') }, gram))
  }))
  fitChart()
}

/** Satu jalur untuk data harga dari /monitoring/api dan SSE 'price' */
function applyPrice(d, fromSse) {
  const ts = d.updatedAt ? new Date(d.updatedAt).getTime() : 0
  if (ts && ts <= state.lastUpdatedAt) return // data lama, abaikan
  if (ts) state.lastUpdatedAt = ts
  if (d.buy) {
    const prev = fromSse ? d.prevBuy : state.buy
    const change = prev ? d.buy - prev : 0
    rollText($('#buyPrice'), num(d.buy), change)
    document.body.classList.remove('loading-data')
    if (change) {
      state.arrow = change > 0 ? '▲ ' : '▼ '
      setChange('buyChange', change); flash('buyCard', change)
      if (fromSse) {
        priceSound(change)
        if (document.hidden && 'Notification' in window && Notification.permission === 'granted') {
          try { new Notification(change > 0 ? 'Harga emas NAIK' : 'Harga emas TURUN', { body: rp(d.buy) + ' (' + signed(change) + ')', icon: '/icon.png', tag: 'gold-price', renotify: true }) } catch (e) {}
        }
      }
      onNewPrice()
    }
    state.buy = d.buy
    updateDayRange(d.buy)
  }
  if (d.sell) {
    const prev = fromSse ? d.prevSell : state.sell
    const change = prev ? d.sell - prev : 0
    rollText($('#sellPrice'), num(d.sell), change)
    if (change) { setChange('sellChange', change); flash('sellCard', change) }
    state.sell = d.sell
  }
  if (d.usdIdr) setUsdIdr(d.usdIdr)
  if (d.xauUsd) state.xauUsd = d.xauUsd
  // judul tab: arah perubahan terakhir + harga beli & jual
  if (state.buy && state.sell) document.title = (state.arrow || '') + 'Beli ' + num(state.buy) + ' · Jual ' + num(state.sell) + ' | PemulaOLD'
  renderSpread(); renderMarkup(); renderNominals()
}
function setUsdIdr(rate) {
  const r = Math.round(rate)
  if (state.usdIdr && r !== Math.round(state.usdIdr)) {
    const c = r - Math.round(state.usdIdr)
    const el = $('#usdIdrChange')
    el.className = 'num text-[9px] ' + (c > 0 ? 'text-up' : 'text-down')
    el.textContent = (c > 0 ? '▲' : '▼') + signed(c)
    // kotak USD/IDR berkedip & berwarna sama seperti kotak Beli/Jual
    if ($('#chipUsd')) flash('chipUsd', c)
  }
  const dir = state.usdIdr ? r - Math.round(state.usdIdr) : 0
  state.usdIdr = rate
  rollText($('#usdIdr'), num(r), dir)
}
/** Promo ON: harga terendah selama ON (Titik ON). Promo OFF: tanggal terakhir ON (dd-mm-yyyy, WIB). */
function renderTitikOn() {
  const box = $('#chipOn'), lbl = $('#onLabel'), val = $('#lowestOnVal')
  if (state.promo === 'OFF' && state.lastOnAt) {
    const d = new Date(Number(state.lastOnAt) + 7 * 3600000)
    // singkat di semua ukuran: "ON 16/10" (tanggal & jam lengkap di tooltip)
    lbl.textContent = 'ON ' + pad2(d.getUTCDate()) + '/' + pad2(d.getUTCMonth() + 1)
    val.textContent = state.lastOnPrice ? num(state.lastOnPrice) : '—'
    val.className = 'stat-v text-muted'
    box.title = 'Promo terakhir ON: ' + new Date(Number(state.lastOnAt)).toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' }) + ' WIB'
    box.classList.remove('hidden')
  } else if (state.titikOn != null) {
    lbl.innerHTML = '<span class="lbl-s">ON</span><span class="lbl-l">Titik ON</span>'
    val.textContent = num(state.titikOn)
    val.className = 'stat-v text-up'
    box.title = 'Harga beli terendah selama promo ON hari ini'
    box.classList.remove('hidden')
  } else box.classList.add('hidden')
}
function setPromoStatus(status, fromSse) {
  const el = $('#promoStatus')
  const changed = state.promo && state.promo !== status
  el.className = 'pill shrink-0 whitespace-nowrap px-3 py-1.5 text-sm ' + (status === 'ON' ? 'bg-up text-white' : 'bg-down/15 text-down')
  // OFF <-> ON: pita membalik (flip) halus
  if (changed) { void el.offsetWidth; el.classList.add('promo-flip') }
  el.innerHTML = '<span class="lbl-l">PROMO</span>' + (status === 'ON' ? 'ON' : 'OFF')
  if (fromSse && state.promo && state.promo !== status) promoSound(status)
  state.promo = status
}
function setChip(id, valId, value, fmt) {
  const has = value !== null && value !== undefined
  $('#' + id).classList.toggle('hidden', !has)
  if (has) $('#' + valId).textContent = fmt ? fmt(value) : value
}

let appVersion = null
async function fetchPrices() {
  try {
    const res = await fetch('/monitoring/api?session=' + encodeURIComponent(session.get()), { cache: 'no-store' })
    if (res.status === 403) return
    const d = await res.json()
    if (d.version) { if (appVersion && appVersion !== d.version && safeReload()) return; appVersion = d.version }
    applyPrice(d, false)
  } catch (e) {}
}

// ===================================================================== GRAFIK MUAT SATU LAYAR (HP)
const wide = () => matchMedia('(min-width: 768px)').matches
/** HP: tinggi grafik = sisa layar dari atas grafik sampai navigasi bawah, jadi harga + grafik tampil tanpa digulir */
// chartFull = menu Grafik ditekan: grafik setinggi layar (antara bar atas dan menu bawah)
let chartFull = false, chartFullAt = 0
// Tata letak pilihan user (diingat per perangkat). p = harga, c = grafik, h = riwayat;
// s = grafik & riwayat terlihat sekaligus (desktop berdampingan, HP grafik dipendekkan).
const LAYOUT_KEY = 'monitorLayout'
export const LAYOUTS = [
  ['def', 'Harga + Grafik, riwayat digulir', 'Riwayat di bawah grafik (halaman digulir)', { p: 1, c: 1, h: 1, s: 0 }],
  ['all', 'Harga + Grafik + Riwayat (bawaan)', 'Semua terlihat sekaligus', { p: 1, c: 1, h: 1, s: 1 }],
  ['pc', 'Harga + Grafik', 'Tanpa riwayat', { p: 1, c: 1, h: 0, s: 0 }],
  ['ch', 'Grafik + Riwayat', 'Tanpa kotak harga', { p: 0, c: 1, h: 1, s: 1 }],
  ['ph', 'Harga + Riwayat', 'Tanpa grafik', { p: 1, c: 0, h: 1, s: 0 }],
  ['c', 'Grafik saja', '', { p: 0, c: 1, h: 0, s: 0 }],
  ['p', 'Harga saja', '', { p: 1, c: 0, h: 0, s: 0 }],
  ['h', 'Riwayat saja', '', { p: 0, c: 0, h: 1, s: 0 }]
]
// bawaan: harga + grafik + riwayat terlihat sekaligus
let layout = 'all'
try {
  const v = localStorage.getItem(LAYOUT_KEY)
  layout = v === 'split' ? 'all' : v === 'chart' ? 'def' : LAYOUTS.some(l => l[0] === v) ? v : 'all'
} catch (e) {}
const lay = () => (LAYOUTS.find(l => l[0] === layout) || LAYOUTS[0])[3]
// Desktop & tablet: riwayat di samping grafik (bawaan) atau di bawahnya (pilihan di Tata letak)
// posisi riwayat: default di samping hanya di desktop (>= 1280px); tablet default di bawah
function histSide() {
  let v = null
  try { v = localStorage.getItem('histSide') } catch (e) {}
  return v === null ? matchMedia('(min-width: 1280px)').matches : v !== '0'
}
function applyLayout() {
  const L = lay(), b = document.body.classList
  const both = !!(L.s && L.c && L.h)
  b.toggle('hide-harga', !L.p)
  b.toggle('hide-grafik', !L.c)
  b.toggle('hide-riwayat', !L.h)
  // berdampingan hanya di desktop/tablet dan bila dipilih; selain itu bertumpuk (grafik dipendekkan)
  b.toggle('lay-split', both && wide() && histSide())
  b.toggle('lay-stack', both && !(wide() && histSide()))
  b.toggle('price-compact', !!(L.p && priceCompact()))
  b.toggle('price-only', !!(L.p && !L.c && !L.h))
  fitHistPanel()
}
// Desktop + grafik & riwayat berdampingan: lebar panel riwayat = lebar alami tabelnya (supaya
// semua kolom terlihat tanpa digeser), min 360px, maks 55% lebar; grafik mengisi sisanya.
function fitHistPanel() {
  const wrap = $('#chartHistWrap'), t = $('#histScroll table')
  if (!wrap || !t) return
  if (!wide() || !document.body.classList.contains('lay-split')) { wrap.style.gridTemplateColumns = ''; return }
  t.style.width = 'max-content'
  // lebar yang benar-benar tampil (tabel & kotaknya bisa diskalakan: ukuran teks + --ui-zoom)
  // + lebar scrollbar tegak di kotak riwayat (supaya tidak muncul geser ke samping)
  const sc = $('#histScroll'), sb = sc ? (sc.offsetWidth - sc.clientWidth) * (sc.offsetWidth ? sc.getBoundingClientRect().width / sc.offsetWidth : 1) : 0
  const need = Math.ceil(t.getBoundingClientRect().width + sb) + 6
  t.style.width = ''
  const w = Math.max(360, Math.min(Math.round(wrap.clientWidth * 0.55), need))
  wrap.style.gridTemplateColumns = 'minmax(0, 1fr) ' + w + 'px'
}
window.addEventListener('resize', () => { fitHistPanel(); fitHist() })
if ('MutationObserver' in window) {
  const hb = document.getElementById('histBody')
  if (hb) new MutationObserver(() => { fitHistPanel(); fitChart() }).observe(hb, { childList: true })
}
// Ukuran teks riwayat (tombol Aa di judul riwayat), diingat per perangkat
const HIST_SIZES = [['0.85', 'Kecil (bawaan)'], ['1', 'Sedang'], ['1.15', 'Besar'], ['1.3', 'Sangat besar']]
// bawaan: teks riwayat Kecil
function histSize() { try { const v = localStorage.getItem('histTextSize'); return HIST_SIZES.some(x => x[0] === v) ? v : '0.85' } catch (e) { return '0.85' } }
function applyHistSize() {
  const sc = $('#histScroll')
  if (sc) sc.style.setProperty('--hist-zoom', histSize())
  fitHistPanel()
}
// USD/IDR di riwayat: 'auto' (desktop & tablet digabung ke tabel harga, HP terpisah) | 'on' | 'off'
const IDR_MODES = [['auto', 'Otomatis', 'Desktop & tablet: digabung. HP: tabel terpisah'], ['on', 'Gabung di tabel harga', 'Kolom USD/IDR di tabel riwayat harga'], ['off', 'Tabel terpisah', 'Pilih lewat tombol Harga emas | USD/IDR']]
function idrMode() { try { const v = localStorage.getItem('histIdrMode'); return IDR_MODES.some(x => x[0] === v) ? v : 'auto' } catch (e) { return 'auto' } }
function applyIdrMode() {
  const m = idrMode()
  const merge = m === 'on' || (m === 'auto' && wide())
  const was = document.body.classList.contains('idr-merge')
  document.body.classList.toggle('idr-merge', merge)
  if (merge !== was) { loadHistory(); fitHistPanel() }
}
window.addEventListener('resize', () => { applyIdrMode(); applyLayout(); fitChart() })
// Pengaturan riwayat (tombol Aa): ukuran teks + USD/IDR digabung / terpisah. Diingat per perangkat.
function openHistSize() {
  const opt = (active, label, note, onclick, style, group) => h('button', { class: 'tile flex items-center gap-3 px-3 py-2.5 text-left ' + (active ? 'border-gold/60 bg-gold/10' : ''), 'data-pick': group || '', onclick: e => { markPicked(e.currentTarget); onclick() } },
    h('span', { class: 'flex h-5 w-5 shrink-0 items-center justify-center rounded-full border ' + (active ? 'border-gold bg-gold text-bg' : 'border-line/30'), html: active ? icon('check', 'h-3 w-3') : '' }),
    h('span', { class: 'min-w-0' },
      h('span', { class: 'block font-bold', style: style || '' }, label),
      note ? h('span', { class: 'block text-[11px] text-muted' }, note) : null))
  const cur = histSize(), im = idrMode()
  const sheet = openSheet('Pengaturan riwayat', h('div', { class: 'flex flex-col gap-1.5' },
    // posisi riwayat juga bisa diatur dari sini (tablet & desktop)
    histSideControl('mb-2'),
    h('div', { class: 'label px-0.5 text-[10px]' }, 'Ukuran teks'),
    HIST_SIZES.map(([v, label]) => opt(v === cur, label, '', () => { try { localStorage.setItem('histTextSize', v) } catch (e) {} applyHistSize() }, 'font-size:' + Math.round(14 * Number(v)) + 'px', 'size')),
    h('div', { class: 'label mt-3 px-0.5 text-[10px]' }, 'Jumlah baris'),
    h('p', { class: 'px-0.5 text-[11px] text-muted' }, 'Baris sedikit = grafik lebih besar (saat grafik & riwayat tampil sekaligus). Di HP bawaan 2 baris; geser riwayat untuk melihat yang lebih lama.'),
    (() => {
      // 1-30 baris lewat tombol - / +, atau Otomatis (10 baris, tinggi mengikuti layar)
      let n = histRowsSetting() || 10
      const val = h('span', { class: 'num w-14 text-center font-mono text-lg font-extrabold' }, histRowsSetting() ? String(n) : 'Auto')
      const apply = v => { n = Math.max(1, Math.min(30, v)); val.textContent = String(n); setHistRows(n); auto.classList.remove('border-gold/60', 'bg-gold/10', 'text-gold'); setTimeout(fitChart, 400) }
      const auto = h('button', { class: 'tile px-3 py-2 text-sm font-bold ' + (!histRowsSetting() ? 'border-gold/60 bg-gold/10 text-gold' : ''),
        onclick: () => { setHistRows(0); val.textContent = 'Auto'; auto.classList.add('border-gold/60', 'bg-gold/10', 'text-gold'); setTimeout(fitChart, 400) } }, 'Otomatis')
      return h('div', { class: 'flex items-center gap-2' },
        h('button', { class: 'icon-btn h-10 w-10 text-lg', onclick: () => apply(n - 1) }, '−'), val,
        h('button', { class: 'icon-btn h-10 w-10 text-lg', onclick: () => apply(n + 1) }, '+'),
        h('span', { class: 'text-xs text-muted' }, 'baris'), h('span', { class: 'flex-1' }), auto)
    })(),
    h('div', { class: 'label mt-3 px-0.5 text-[10px]' }, 'USD/IDR'),
    IDR_MODES.map(([v, label, note]) => opt(v === im, label, note, () => { try { localStorage.setItem('histIdrMode', v) } catch (e) {} applyIdrMode() }, '', 'idr'))), { peek: true })
}
// Kotak harga ringkas (hanya Beli, Jual, jam, promo): ceklis di lembar Tata letak, berlaku di semua tata letak
// bawaan: kotak harga ringkas (aktif kecuali user mematikannya)
function priceCompact() { try { return localStorage.getItem('priceCompact') !== '0' } catch (e) { return true } }
// Info harga yang ditampilkan (pilihan user, diingat per perangkat). Semua dimatikan = baris info hilang.
const CHIP_DEFS = [['chipUsd', 'Kurs USD/IDR (IDR)'], ['chipHigh', 'Tertinggi hari ini (Max)'], ['chipLow', 'Terendah hari ini (Min)'], ['chipLimit', 'Limit'], ['chipMarkup', 'Markup / Markdown (MU/MD)'], ['chipSpread', 'Spread (Spr)'], ['chipOn', 'Titik ON (ON)']]
function chipPrefs() { try { return JSON.parse(localStorage.getItem('chipPrefs') || '{}') || {} } catch (e) { return {} } }
function applyChipPrefs() {
  const pr = chipPrefs()
  CHIP_DEFS.forEach(([id]) => { const el = document.getElementById(id); if (el) el.classList.toggle('chip-off', pr[id] === false) })
  $('#chips').classList.toggle('chips-off', CHIP_DEFS.every(([id]) => pr[id] === false))
  fitChart()
}
// Bagian "Info harga" (toggle per info) — dipakai di lembar gabungan "Atur kotak harga"
export function chipSection() {
  const pr = chipPrefs()
  const save = () => { try { localStorage.setItem('chipPrefs', JSON.stringify(pr)) } catch (e) {} applyChipPrefs() }
  const toggles = []
  const rows = CHIP_DEFS.map(([id, label]) => {
    const t = h('input', { type: 'checkbox', class: 'toggle' })
    t.checked = pr[id] !== false
    t.addEventListener('change', () => { pr[id] = t.checked; save() })
    toggles.push([id, t])
    return h('label', { class: 'flex items-center justify-between py-1.5 text-[13px] font-semibold' }, label, t)
  })
  const all = on => { toggles.forEach(([id, t]) => { t.checked = on; pr[id] = on }); save() }
  return h('div', {},
    h('div', { class: 'divide-y divide-line/[0.06]' }, rows),
    h('div', { class: 'mt-1.5 flex justify-end gap-1.5' },
      h('button', { class: 'rounded-md border border-line/[0.12] px-2.5 py-1 text-[11px] font-semibold text-muted', onclick: () => all(false) }, 'Sembunyikan semua'),
      h('button', { class: 'rounded-md border border-line/[0.12] px-2.5 py-1 text-[11px] font-semibold text-muted', onclick: () => all(true) }, 'Tampilkan semua')))
}
export function openChipSettings() { openPriceBox() }
export function getLayout() { return layout }
// Perubahan tata letak oleh user: berpindah halus (bagian lama memudar/bergeser ke posisi baru)
function smoothLayout(fn) {
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches
  if (reduce || !document.startViewTransition) { fn(); return }
  const root = document.documentElement
  root.classList.add('vt-layout')
  const t = document.startViewTransition(fn)
  t.finished.finally(() => root.classList.remove('vt-layout'))
}
export function setLayout(v) {
  layout = LAYOUTS.some(l => l[0] === v) ? v : 'def'
  try { localStorage.setItem(LAYOUT_KEY, layout) } catch (e) {}
  chartFull = false
  smoothLayout(() => {
    applyLayout()
    fitChart()
    window.scrollTo({ top: 0 })
  })
}
// Lembar pilihan tata letak (dibuka dari Lainnya, dan tombol "Tata letak" di judul grafik)
// Pilihan di panel (tata letak, ukuran teks, mode USD/IDR): panel TIDAK ditutup, tanda centang langsung
// pindah ke pilihan baru sehingga user bisa mencoba beberapa pilihan sambil melihat hasilnya.
function markPicked(btn) {
  const group = btn.parentElement ? [...btn.parentElement.children].filter(b => b.dataset && b.dataset.pick === btn.dataset.pick) : [btn]
  group.forEach(b => {
    const on = b === btn
    b.classList.toggle('border-gold/60', on); b.classList.toggle('bg-gold/10', on)
    const dot = b.firstElementChild
    if (dot) {
      dot.className = 'flex h-5 w-5 shrink-0 items-center justify-center rounded-full border transition ' + (on ? 'border-gold bg-gold text-bg' : 'border-line/30')
      dot.innerHTML = on ? icon('check', 'h-3 w-3') : ''
    }
  })
}
export function openLayoutPicker() {
  const sheet = openSheet('Tata letak', h('div', { class: 'flex flex-col gap-1.5' },
    h('p', { class: 'mb-1 text-xs text-muted' }, 'Pilih bagian yang ingin ditampilkan. Diingat di perangkat ini.'),
    LAYOUTS.map(([id, label, note]) => h('button', {
      class: 'tile flex items-center gap-3 px-3 py-2.5 text-left ' + (id === layout ? 'border-gold/60 bg-gold/10' : ''),
      'data-pick': 'layout',
      onclick: e => { const b = e.currentTarget; markPicked(b); setLayout(id) }
    },
      h('span', { class: 'flex h-5 w-5 shrink-0 items-center justify-center rounded-full border ' + (id === layout ? 'border-gold bg-gold text-bg' : 'border-line/30'), html: id === layout ? icon('check', 'h-3 w-3') : '' }),
      h('span', { class: 'min-w-0' },
        h('span', { class: 'block text-sm font-bold' }, label),
        note ? h('span', { class: 'block text-[11px] text-muted' }, note) : null))),
    (() => {
      const t = h('input', { type: 'checkbox', class: 'toggle' })
      t.checked = priceCompact()
      t.addEventListener('change', () => { try { localStorage.setItem('priceCompact', t.checked ? '1' : '0') } catch (e) {} smoothLayout(() => { applyLayout(); fitChart() }) })
      return h('label', { class: 'tile mt-2 flex items-center justify-between gap-3 px-3 py-2.5' },
        h('span', { class: 'min-w-0' },
          h('span', { class: 'block text-sm font-bold' }, 'Kotak harga ringkas'),
          h('span', { class: 'block text-[11px] text-muted' }, 'Satu baris kecil: Beli, Jual, jam, promo + info harga & gramasi nominal dalam kotak kecil')), t)
    })(),
    // pengaturan isi kotak harga (info harga + nominal dalam satu lembar)
    ...[['sliders', 'Atur kotak harga', 'Info harga (IDR, Max, Min, Limit, MD, Spr, ON) & nominal untung', () => openPriceBox()]].map(([ic, label, note, fn]) =>
      h('button', { class: 'tile mt-2 flex w-full items-center gap-3 px-3 py-2.5 text-left', onclick: fn,
        html: icon(ic, 'h-4 w-4 shrink-0 text-gold') + '<span class="min-w-0"><span class="block text-sm font-bold">' + label + '</span><span class="block text-[11px] text-muted">' + note + '</span></span>' })),
    // posisi riwayat saat grafik & riwayat tampil sekaligus (desktop / tablet)
    histSideControl()), { peek: true })
}
// Posisi riwayat (samping / bawah grafik) — dipakai di Tata letak dan Pengaturan riwayat (tablet & desktop)
function histSideControl(extraClass = 'mt-2') {
  if (!wide()) return null
  const side = histSide()
  const pick = (v, e) => {
    try { localStorage.setItem('histSide', v ? '1' : '0') } catch (x) {}
    const seg = e.currentTarget.parentElement
    ;[...seg.children].forEach((b, i) => b.setAttribute('aria-pressed', String(i === (v ? 0 : 1))))
    smoothLayout(() => { applyLayout(); fitChart() })
  }
  return h('div', { class: 'tile flex items-center justify-between gap-3 px-3 py-2.5 ' + extraClass },
    h('span', { class: 'min-w-0' },
      h('span', { class: 'block text-sm font-bold' }, 'Posisi riwayat'),
      h('span', { class: 'block text-[11px] text-muted' }, 'Saat grafik & riwayat tampil sekaligus')),
    h('div', { class: 'seg shrink-0' },
      h('button', { 'aria-pressed': String(side), onclick: e => pick(true, e) }, 'Di samping'),
      h('button', { 'aria-pressed': String(!side), onclick: e => pick(false, e) }, 'Di bawah')))
}
function fitChart() { fitClock(); fitPriceOnly(); fitChartBox(); fitHist() }
// Jam (kotak PROMO + jam di baris bawah) membesar mengisi ruang kosong di kiri-kanannya, tetap
// menyisakan tempat untuk kotak info & Max/Min. Dihitung ulang tiap ukuran layar berubah.
function fitClock() {
  const row = $('#clockRow'), mid = $('#clockMid'), num = $('#clockNum'), promo = $('#promoStatus')
  if (!row || !mid || !num || !document.body.classList.contains('price-compact') || !mid.offsetWidth) {
    if (num) num.style.removeProperty('font-size')
    if (promo) promo.style.removeProperty('font-size')
    return
  }
  num.style.removeProperty('font-size'); promo.style.removeProperty('font-size')
  const cs = getComputedStyle(row)
  const inner = row.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight)
  const gap = parseFloat(cs.columnGap) || 0
  const w = mid.getBoundingClientRect().width / (row.getBoundingClientRect().width / row.offsetWidth || 1)
  const side = Math.max(($('#infoBox') || {}).offsetWidth || 0, ($('#hiloBox') || {}).offsetWidth || 0)
  // ruang yang boleh dipakai jam: semua sisa kecuali kolom kiri/kanan (+ jarak aman)
  const room = inner - 2 * (side + gap) - 12
  // jam tidak boleh lebih dari 1,6x angka harga Beli (supaya tetap serasi, harga tetap utama)
  const base = parseFloat(getComputedStyle(num).fontSize)
  const beli = parseFloat(getComputedStyle($('#buyPrice')).fontSize) || base
  const scale = Math.max(1, Math.min(room / w * 0.85, (beli * 1.6) / base, 1.8))
  if (scale > 1.02) {
    num.style.setProperty('font-size', (base * scale).toFixed(1) + 'px', 'important')
    promo.style.setProperty('font-size', (parseFloat(getComputedStyle(promo).fontSize) * Math.min(scale, 1.35)).toFixed(1) + 'px', 'important')
  }
}
// Tinggi menu bawah (0 di desktop, dan saat disembunyikan karena layar lama tidak disentuh)
function navH() { return document.body.classList.contains('nav-idle') ? 0 : $('#bottomNav').offsetHeight }
// Tinggi kotak riwayat untuk n baris: judul + kepala tabel + n baris + tombol halaman (kalau tampil)
function histRowsHeight(n) {
  const sec = $('#sec-riwayat'), tr = $('#histBody tr'), pager = $('#histPager'), scroll = $('#histScroll')
  // Tepat: tinggi kotak sekarang dikoreksi dengan selisih antara tinggi n baris pertama yang
  // sebenarnya dan area baris yang sedang terlihat (tidak ada potongan baris berikutnya)
  const trs = document.querySelectorAll('#histBody tr')
  if (sec && sec.offsetHeight && scroll && trs.length) {
    // ukuran yang benar-benar tampil (getBoundingClientRect), karena tabel bisa di-zoom (ukuran teks)
    const vh = el => el.getBoundingClientRect().height
    let need = 0
    for (let i = 0; i < Math.min(n, trs.length); i++) need += vh(trs[i])
    if (trs.length < n) need += vh(trs[0]) * (n - trs.length)
    const headH = $('#histHead') ? vh($('#histHead')) : 0
    // kotak gulir ikut diskalakan (--ui-zoom): clientHeight masih dalam ukuran sebelum skala
    const z = scroll.offsetHeight ? vh(scroll) / scroll.offsetHeight : 1
    return Math.round(sec.offsetHeight + need - (scroll.clientHeight * z - headH))
  }
  const title = sec && sec.firstElementChild ? sec.firstElementChild.offsetHeight : 36
  const head = $('#histHead') ? $('#histHead').offsetHeight : 28
  const rowH = tr ? tr.getBoundingClientRect().height : (wide() ? 48 : 44)
  const pg = pager && pager.offsetParent ? pager.offsetHeight : 0
  return Math.round(title + head + rowH * n + pg + 3)
}
// Tinggi kotak riwayat untuk n baris, dihitung dari bagian-bagiannya (judul + kepala tabel + n baris +
// tombol halaman) — TIDAK bergantung tinggi kotak saat ini, jadi ukuran grafik stabil walau user memilih
// banyak baris atau data riwayat belum termuat (baris "Memuat..." yang tinggi tidak ikut dihitung).
function histBaseHeight(n) {
  const sec = $('#sec-riwayat')
  if (!sec) return 0
  const vh = el => (el ? el.getBoundingClientRect().height : 0)
  const title = vh(sec.firstElementChild)
  const head = vh($('#histHead')) || 28
  const tr = $('#histBody tr')
  const real = tr && !tr.querySelector('td[colspan]')
  // tinggi baris asli diingat (per lebar layar) supaya perkiraan sebelum data termuat sudah tepat -> grafik tidak melompat
  const key = 'histRowH_' + Math.round(window.innerWidth / 50)
  let rowH = real ? vh(tr) : 0
  try {
    if (rowH) localStorage.setItem(key, String(Math.round(rowH)))
    else rowH = +localStorage.getItem(key) || 0
  } catch (e) {}
  if (!rowH) rowH = (window.innerWidth < 768 ? 46 : 40) * (parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--ui-zoom')) || 1)
  const pager = $('#histPager')
  const pg = pager && pager.offsetParent ? vh(pager) : 0
  return Math.round(title + head + rowH * n + pg + 4)
}
// HP: menu bawah disembunyikan setelah 5 detik layar tidak disentuh -> grafik lebih besar.
// Sentuh / geser / gerak mouse -> menu muncul lagi.
let idleTimer = null
function wake() {
  if (document.body.classList.contains('nav-idle')) { document.body.classList.remove('nav-idle'); fitChart() }
  clearTimeout(idleTimer)
  idleTimer = setTimeout(() => {
    if (wide() || document.querySelector('.sheet, #tourRoot, #askJoinModal')) return
    document.body.classList.add('nav-idle'); fitChart()
  }, 5000)
}
;['touchstart', 'scroll', 'mousemove', 'keydown', 'click'].forEach(ev => window.addEventListener(ev, wake, { passive: true, capture: true }))
// 'Harga saja': kotak harga setinggi layar (di antara bar atas dan menu bawah)
function fitPriceOnly() {
  const sec = $('#sec-harga')
  if (!sec) return
  if (!document.body.classList.contains('price-only') || document.body.classList.contains('price-compact')) { sec.style.minHeight = ''; return }
  sec.style.minHeight = Math.max(240, window.innerHeight - $('header').offsetHeight - navH() - (wide() ? 32 : 20)) + 'px'
}
// Kotak riwayat setinggi layar (isi digulir di dalam): kalau muat di layar pertama, isi sisa layar;
// kalau letaknya di bawah (setelah grafik), setinggi satu layar. Panel samping desktop diatur CSS.
function fitHist() {
  const sec = $('#sec-riwayat')
  if (!sec) return
  const b = document.body.classList
  if (b.contains('hide-riwayat') || (wide() && b.contains('lay-split'))) { sec.classList.remove('hist-fit'); sec.style.height = ''; return }
  const hdr = $('header').offsetHeight, nav = navH()
  const avail = window.innerHeight - hdr - nav - (wide() ? 32 : 16)
  const rest = window.innerHeight - (sec.getBoundingClientRect().top + window.scrollY) - nav - (wide() ? 16 : 8)
  sec.classList.add('hist-fit')
  // grafik & riwayat sekaligus (bertumpuk): riwayat cukup mengisi sisa layar di bawah grafik
  // jumlah baris dipilih: kotak tepat n baris (sisanya digeser di dalam kotak)
  if (b.contains('lay-stack') && histRowsSetting()) { sec.style.height = histRowsHeight(histRowsSetting()) + 'px'; return }
  if (b.contains('lay-stack')) { sec.style.height = Math.max(200, rest) + 'px'; return }
  sec.style.height = Math.max(320, rest >= 320 ? rest : avail) + 'px'
}
function fitChartBox() {
  const box = $('#tvChart')
  if (!box) return
  if (chartFull && !wide()) {
    const hdr = $('header').offsetHeight, nav = navH()
    box.style.height = Math.max(300, Math.round(window.innerHeight - hdr - nav - 12)) + 'px'
    return
  }
  // HP & desktop: grafik mengisi sisa layar di bawah harga, jadi harga + grafik muat satu layar
  // dan riwayat baru terlihat saat digulir (di desktop menu bawah tersembunyi, tingginya 0)
  const top = box.getBoundingClientRect().top + window.scrollY
  const nav = navH()
  const rest = window.innerHeight - top - nav - (wide() ? 16 : 8)
  // Grafik & riwayat sekaligus tetapi bertumpuk (HP, atau desktop dengan riwayat di bawah):
  // grafik +-setengah sisa layar supaya riwayat langsung terlihat
  const hpSplit = document.body.classList.contains('lay-stack')
  // Jumlah baris riwayat dipilih (1-30): riwayat setinggi baris itu saja, grafik mengambil sisanya
  // (baris sedikit -> grafik lebih besar)
  const nRows = histRowsSetting()
  if (hpSplit && nRows) {
    const gap = wide() ? 16 : 8
    // Ukuran grafik dihitung dari jumlah baris bawaan (HP 2, tablet 3, desktop 4). Pilih lebih banyak baris:
    // grafik TIDAK mengecil, kotak riwayat memanjang ke bawah (halaman digulir untuk melihatnya).
    const base = !matchMedia('(min-width: 768px)').matches ? 2 : !matchMedia('(min-width: 1280px)').matches ? 3 : 4
    box.style.height = Math.max(180, Math.round(rest - histBaseHeight(Math.min(nRows, base)) - gap)) + 'px'
    return
  }
  const h0 = Math.max(hpSplit ? 180 : wide() ? 320 : 220, Math.round(hpSplit ? rest * (wide() ? 0.55 : 0.45) : rest))
  // monitor sangat tinggi: grafik maksimal 1000px supaya tidak terlalu panjang
  box.style.height = (wide() ? Math.min(1000, h0) : h0) + 'px'
}
window.addEventListener('resize', fitChart)
// bagian atas berubah tinggi (font selesai dimuat, info bertambah, pemberitahuan muncul) -> hitung ulang
if ('ResizeObserver' in window) {
  const ro = new ResizeObserver(() => fitChart())
  ;['header', '#notifs', '#sec-harga', '#nominals'].forEach(sel => { const el = $(sel); if (el) ro.observe(el) })
}
if (document.fonts && document.fonts.ready) document.fonts.ready.then(fitChart)
window.addEventListener('orientationchange', () => setTimeout(fitChart, 300))

// ===================================================================== JAM
let offset = 0
async function syncTime() { try { const d = await (await fetch('/time')).json(); offset = d.timestamp - Date.now() } catch (e) {} }
function tick() {
  const now = new Date(Date.now() + offset)
  const s = now.getSeconds()
  // jam & menit bergulir halus saat berganti
  rollText($('#clkH'), pad2(now.getHours()), 1)
  rollText($('#clkM'), pad2(now.getMinutes()), 1)
  const sEl = $('#clkS')
  // jam terlihat bergerak: angka detik berdenyut saat berganti, titik dua berkedip tiap detik
  if (sEl.textContent !== pad2(s)) {
    sEl.textContent = pad2(s)
    sEl.className = (s >= 50 ? 'text-down ' : 'text-gold ') + 'clk-tick'
    void sEl.offsetWidth
    sEl.classList.add('clk-tick-on')
    document.querySelectorAll('.clk-colon').forEach(c => c.classList.toggle('clk-dim', s % 2 === 1))
  }
  // bar atas: HP versi pendek ("17 Okt"), desktop lengkap ("Sabtu, 17 Okt · WIB")
  $('#clkDate').textContent = wide() ? HARI[now.getDay()] + ', ' + now.getDate() + ' ' + BULAN[now.getMonth()] + ' · WIB' : now.getDate() + ' ' + BULAN[now.getMonth()]
  countdownTick(s, $('main'))
}

// ===================================================================== PEMBERITAHUAN ADMIN
function showNotice(d) {
  const color = { promo: 'border-up/40 bg-up/10', warning: 'border-gold/40 bg-gold/10', urgent: 'border-down/40 bg-down/10' }[d.notifType] || 'border-sky/40 bg-sky/10'
  const card = h('div', { class: 'anim-msg flex items-start gap-3 rounded-2xl border p-3 ' + color },
    h('div', { class: 'min-w-0 flex-1' }, h('div', { class: 'text-sm font-extrabold' }, d.title || 'Info'), h('div', { class: 'mt-0.5 whitespace-pre-line text-sm text-muted' }, d.message || '')),
    h('button', { class: 'icon-btn h-8 w-8 shrink-0', 'aria-label': 'Tutup', html: icon('close', 'h-4 w-4'), onclick: () => card.remove() }))
  $('#notifs').prepend(card)
  fitChart()
  if (document.hidden && 'Notification' in window && Notification.permission === 'granted') {
    try { new Notification(d.title || 'PemulaOLD', { body: d.message || '', icon: '/icon.png' }) } catch (e) {}
  }
  notifSound()
}

// ===================================================================== SSE REALTIME
let es = null
let lastData = Date.now()
let retry = 0
function connect() {
  if (es) es.close()
  es = new EventSource('/sse?ui=2&session=' + encodeURIComponent(session.get()))
  // Sambung ulang (mis. server restart karena update): cek versi lewat fetchPrices -> kalau versi
  // server berubah, halaman reload sendiri ke kode terbaru
  es.onopen = () => { $('#liveDot').className = $('#liveDot').className.replace('bg-gold', 'bg-up'); lastData = Date.now(); if (retry) { loadHistory(); fetchPrices() } retry = 0 }
  es.onerror = () => {
    $('#liveDot').className = $('#liveDot').className.replace('bg-up', 'bg-gold')
    es.close()
    setTimeout(connect, Math.min(3000 * 2 ** retry++, 30000))
  }
  es.onmessage = ev => {
    lastData = Date.now()
    let d
    try { d = JSON.parse(ev.data) } catch (e) { return }
    switch (d.type) {
      case 'price': applyPrice(d, true); break
      case 'usd_idr': if (d.rate) { setUsdIdr(d.rate); if (d.xauUsd) state.xauUsd = d.xauUsd; renderMarkup(); onUsdIdr(d) } break
      case 'daily_highlow':
        if (d.high != null && (state.high === null || d.high > state.high)) { state.high = d.high; $('#dayHigh').textContent = num(d.high) }
        if (d.low != null && (state.low === null || d.low < state.low)) { state.low = d.low; $('#dayLow').textContent = num(d.low) }
        break
      case 'promo_status': if (d.lastOnAt) state.lastOnAt = d.lastOnAt; if (d.lastOnPrice) state.lastOnPrice = d.lastOnPrice; setPromoStatus(d.status, true); renderTitikOn(); break
      case 'promo_limit_update': setChip('chipLimit', 'limitVal', d.limit); break
      case 'lowest_on_price': state.titikOn = d.price ?? null; renderTitikOn(); break
      case 'markup_settings_update':
        if (d.settings) { if (d.settings.minMargin != null) state.markupMin = parseFloat(d.settings.minMargin); if (d.settings.maxMargin != null) state.markupMax = parseFloat(d.settings.maxMargin) }
        renderMarkup(); loadHistory(); break
      case 'nominal_update': state.nominals = d.nominals || []; renderNominals(); loadHistory(); break
      case 'promo_suggestions': setPromos(d.promos || []); break
      case 'sound_update': if (d.settings) setCustomSounds(d.settings); break
      case 'notification': showNotice(d); break
      case 'force_logout':
      case 'session_expired': endSession('Sesi Anda telah berakhir. Silakan login kembali.', 'Sesi berakhir'); break
    }
  }
}
setInterval(() => { if (Date.now() - lastData > 60000) { lastData = Date.now(); connect() } }, 10000)

// ===================================================================== NAVIGASI BAWAH
const NAV = {
  // Harga: kembali ke atas (grafik kembali ke ukuran biasa). Grafik: grafik setinggi layar.
  harga: ['home', () => { chartFull = false; setActive('harga'); window.scrollTo({ top: 0, behavior: 'smooth' }); setTimeout(() => { fitChart(); setActive('harga') }, 700) }],
  grafik: ['chart', () => { chartFull = true; chartFullAt = Date.now(); setActive('grafik'); fitChart(); requestAnimationFrame(() => scrollTo('#sec-grafik')) }],
  promo: ['tag', openPromos],
  news: ['bell', openNews],
  lainnya: ['settings', openMore]
}
function scrollTo(sel) {
  const el = $(sel)
  const hdr = $('header').offsetHeight
  window.scrollTo({ top: Math.max(0, el.getBoundingClientRect().top + scrollY - hdr - 6), behavior: 'smooth' })
}
// Desktop: menu bawah disembunyikan; Promo / News / Lainnya dipindah ke bar atas (Harga & Grafik
// tidak perlu karena semuanya satu halaman). HP: kembali ke menu bawah.
// Promo / News / Lainnya selalu di bar atas (HP: ikon saja). Menu bawah tidak dipakai lagi.
function placeNav() {
  const top = $('#topNav')
  if (!top) return
  const to = top
  // tombol Promo tidak ditampilkan di bar atas (daftar promo ada di menu pengaturan)
  ;['news', 'lainnya'].forEach(k => { const b = document.querySelector('[data-nav="' + k + '"]'); if (b && b.parentNode !== to) to.append(b) })
}
window.addEventListener('resize', placeNav)
// tab aktif mengikuti bagian yang sedang terlihat
const setActive = key => $$('[data-nav]').forEach(b => b.setAttribute('aria-current', String(b.dataset.nav === key)))
function initNav() {
  $$('#bottomNav [data-nav]').forEach(b => {
    const [ic, fn] = NAV[b.dataset.nav]
    b.setAttribute('aria-label', b.textContent.trim()); b.title = b.textContent.trim()
    b.insertAdjacentHTML('afterbegin', icon(ic, 'h-5 w-5'))
    b.addEventListener('click', fn)
  })
  placeNav()
  setActive('harga')
  window.addEventListener('scroll', () => {
    const g = $('#sec-grafik').getBoundingClientRect().top
    setActive(scrollY > 4 && g < innerHeight * 0.45 ? 'grafik' : 'harga')
    // HP: kembali ke paling atas = tampilan biasa (harga + grafik dalam satu layar)
    // (bukan saat baru menekan Grafik: guliran ke grafik baru dimulai dari atas)
    // Grafik penuh (menu Grafik) kembali ke ukuran biasa begitu user menggulir ke atas: atas grafik
    // turun dari bawah bar atas (bukan saat guliran otomatis ke grafik masih berjalan)
    if (chartFull && !wide() && Date.now() - chartFullAt > 1200) {
      const gTop = $('#sec-grafik').getBoundingClientRect().top, hdrB = $('header').getBoundingClientRect().bottom
      if (gTop > hdrB + 24 || scrollY < 4) { chartFull = false; fitChart(); setActive(scrollY > 4 && gTop < innerHeight * 0.45 ? 'grafik' : 'harga') }
    }
  }, { passive: true })
}

// ===================================================================== MULAI
let canJoin = false
async function start() {
  $('#btnAdminWa').innerHTML = icon('wa', 'h-5 w-5')
  $('#btnAdminWa').addEventListener('click', () => contactAdmin(state.phone))
  $('#btnIndicator').addEventListener('click', openIndicators)
  $('#btnNominal').addEventListener('click', openNominalSettings)
  initNav()
  applyLayout()
  $('#btnLayout').innerHTML = icon('panels', 'h-4 w-4') + '<span class="hidden lg:inline">Tata letak</span>'
  $('#btnLayout').addEventListener('click', openLayoutPicker)
  // HP: tombol Tata letak diganti sakelar mode gelap/terang (Tata letak tetap ada di menu pengaturan)
  {
    const sw = h('button', { id: 'btnTheme', class: 'theme-switch', type: 'button', 'aria-label': 'Ganti mode gelap / terang', title: 'Mode gelap / terang' },
      h('span', { class: 'theme-knob', html: icon('moon', 'h-3.5 w-3.5 knob-moon') + icon('sun', 'h-3.5 w-3.5 knob-sun') }))
    const sync = () => sw.setAttribute('aria-pressed', String(document.documentElement.dataset.theme === 'light'))
    sync()
    // mode diganti dari mana pun (menu pengaturan / sakelar) -> posisi sakelar ikut
    new MutationObserver(sync).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
    sw.addEventListener('click', () => {
      const r = sw.getBoundingClientRect()
      // grafik ditukar di dalam animasi yang sama (grafik tema lain sudah disiapkan di belakang)
      toggleTheme({ origin: { x: r.left + r.width / 2, y: r.top + r.height / 2 }, after: loadChart })
      sync()
    })
    $('#btnLayout').after(sw)
  }
  applyHistSize()
  applyIdrMode()
  // USD/IDR: kotak ke-3 sejajar Beli/Jual di semua ukuran layar
  const usd = $('#chipUsd')
  if (usd) { usd.classList.add('usd-pill', 'usd-tile', 'tile'); $('#buyCard').parentElement.append(usd) }
  // ikon atur (slider, beda dari ikon Lainnya) di pojok kanan baris nominal -> Atur kotak harga
  $('#nomWrap').append(h('button', { id: 'btnPriceBox', class: 'price-box-gear', title: 'Atur kotak harga', 'aria-label': 'Atur kotak harga', html: icon('sliders', 'h-3.5 w-3.5'), onclick: () => openPriceBox() }))
  // Tertinggi / Terendah: satu kotak kecil di kanan jam (Max di atas, Min di bawah)
  const hilo = h('div', { id: 'hiloBox', class: 'hilo-box', title: 'Harga beli tertinggi / terendah hari ini' })
  hilo.append($('#chipHigh'), $('#chipLow'))
  $('#clockRow').append(hilo)
  // Limit / MD / Spread / ON: kotak kecil 4 baris di kiri baris jam
  const info = h('div', { id: 'infoBox', class: 'hilo-box info-box' })
  // tengah: PROMO ON/OFF di atas, jam di bawah, lebar kotaknya sama
  const mid = h('div', { id: 'clockMid', class: 'clock-mid' })
  mid.append($('#promoStatus'), $('#clockBox'))
  $('#clockRow').prepend(info, mid)
  const infoIds = ['chipLimit', 'chipMarkup', 'chipSpread', 'chipOn']
  const mqInfo = matchMedia('(min-width: 0px)')
  const placeInfo = () => {
    infoIds.forEach(id => { const el = document.getElementById(id); if (el) (mqInfo.matches ? info : $('#chips')).append(el) })
    fitChart()
  }
  placeInfo()
  mqInfo.addEventListener('change', placeInfo)
  // Max/Min, Limit, MD, Spread, ON berubah -> kotaknya berkedip (nilai awal '—' tidak dihitung)
  if ('MutationObserver' in window) {
    ['dayHigh', 'dayLow', 'limitVal', 'markupVal', 'spreadVal', 'lowestOnVal'].forEach(id => {
      const el = document.getElementById(id)
      if (!el) return
      let prev = el.textContent.trim()
      new MutationObserver(() => {
        const t = el.textContent.trim()
        if (t !== prev && prev && prev !== '—' && t && t !== '—') pulse(el.closest('.stat'))
        prev = t
      }).observe(el, { childList: true, characterData: true, subtree: true })
    })
  }
  applyChipPrefs()
  $('#btnHistSize').innerHTML = icon('sliders', 'h-4 w-4')   // ikon pengaturan riwayat
  $('#btnHistSize').addEventListener('click', openHistSize)
  fitChart()
  setMenuHooks({ openPromos, refreshNominals: () => { renderNominals(); loadHistory() }, renderSisaHari, openLayoutPicker, startTour, chipSection, canJoinGroup: () => canJoin, setCanJoinGroup: v => { canJoin = v } })

  // data — dimuat BERSAMAAN dengan cek sesi (tidak menunggu): harga dulu, lalu grafik, riwayat,
  // nominal & info lain masing-masing tampil begitu datang (sebelumnya berurutan: sesi -> markup ->
  // harga -> riwayat & grafik, sehingga grafik baru mulai dimuat setelah semuanya selesai)
  const pricesReady = fetchPrices()
  syncTime(); setInterval(syncTime, 5 * 60 * 1000)
  tick(); setInterval(tick, 250)
  // batas markup dari admin; 0 adalah nilai sah (jangan diganti nilai bawaan)
  getJSON('/api/markup-settings').then(m => {
    if (m.success && m.settings) {
      if (m.settings.minMargin != null && !isNaN(parseFloat(m.settings.minMargin))) state.markupMin = parseFloat(m.settings.minMargin)
      if (m.settings.maxMargin != null && !isNaN(parseFloat(m.settings.maxMargin))) state.markupMax = parseFloat(m.settings.maxMargin)
      renderMarkup()
    }
  }).catch(() => {})
  getJSON('/api/nominal-settings').then(d => { if (d.success) { state.nominals = d.nominals || []; renderNominals(); loadHistory() } }).catch(() => {})
  getJSON('/api/promo-limit').then(d => setChip('chipLimit', 'limitVal', d.limit)).catch(() => {})
  getJSON('/api/lowest-on-price').then(d => {
    state.titikOn = d.price ?? null
    if (d.lastOnAt) state.lastOnAt = d.lastOnAt
    if (d.lastOnPrice) state.lastOnPrice = d.lastOnPrice
    if (d.status && !state.promo) setPromoStatus(d.status, false)
    renderTitikOn()
  }).catch(() => {})
  getJSON('/api/daily-highlow').then(d => {
    if (d.high != null) { state.high = Math.max(state.high ?? d.high, d.high); $('#dayHigh').textContent = num(state.high) }
    if (d.low != null) { state.low = Math.min(state.low ?? d.low, d.low); $('#dayLow').textContent = num(state.low) }
  }).catch(() => {})
  connect()
  initHistory()
  initChart()
  loadCustomSounds()
  loadPromos()
  setTimeout(loadNews, 2000)

  // sesi
  const v = await verify()
  if (v && !v.valid) {
    handleInvalid(v)
    if (v.reason !== 'server_error') return
  } else if (v) {
    markOk()
    state.phone = String(v.phone || '')
    state.user = v.user || null
    state.isAdmin = !!v.isAdmin
    renderSisaHari()
    fitChart()
    setTimeout(renewReminder, 2500)
    // Pengguna baru: panduan penggunaan wajib tampil dulu, baru pertanyaan gabung grup WA
    // ajakan pasang aplikasi (maks. sekali tiap 3 hari, tidak muncul bila sudah terpasang / saat panduan)
    scheduleInstallInvite(tourDone() ? 40000 : 90000)
    // baru dipasang & dibuka dari layar utama: tawarkan notifikasi harga sekali
    if (isInstalled() && 'Notification' in window && Notification.permission === 'default') {
      let asked = false
      try { asked = localStorage.getItem('pushAskInstalled') === '1' } catch (e) {}
      if (!asked) setTimeout(async () => {
        try { localStorage.setItem('pushAskInstalled', '1') } catch (e) {}
        const ok = await confirmDialog('Aplikasi sudah terpasang. Aktifkan notifikasi supaya mendapat kabar harga naik/turun & promo walau aplikasi ditutup?', { title: 'Notifikasi harga', ok: 'Aktifkan', cancel: 'Nanti' })
        if (!ok) return
        if ((await Notification.requestPermission()) === 'granted') toast((await subscribePush()) ? 'Notifikasi harga aktif' : 'Notifikasi aktif di perangkat ini', 'success')
      }, 8000)
    }
    if (tourDone()) setTimeout(() => joinGroup(true), 6000)
    else setTimeout(() => startTour(true).then(() => setTimeout(() => joinGroup(true), 1500)), 1500)
    getJSON('/api/check-pin-status').then(p => { if (p && p.requirePinChange) location.replace('/login') }).catch(() => {})
  }
  setInterval(async () => {
    const x = await verify()
    if (!x) return
    if (x.valid) { markOk(); state.user = x.user || state.user; renderSisaHari() } else handleInvalid(x)
  }, 30000)


  // notifikasi HP: daftar ulang kalau izin sudah diberikan
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').then(() => {
      if ('Notification' in window && Notification.permission === 'granted') subscribePush()
    }).catch(() => {})
  }
  // kembali dari latar belakang: segarkan data
  document.addEventListener('visibilitychange', () => { if (!document.hidden) { fetchPrices(); if (Date.now() - lastData > 30000) connect() } })
}
start()

// Uji tampilan lokal saja (localhost): simulasi perubahan harga / kurs tanpa menunggu pasar
if (location.hostname === 'localhost') window.__mon = { applyPrice, setUsdIdr, state, openPriceBox, openIndicators, renderSisaHari, setPromoStatus, setLayout }
