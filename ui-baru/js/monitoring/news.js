// News (kalender ekonomi USD dari Forex Factory) dan daftar Promo aktif.
import { $, h, icon, getJSON, openSheet, toast, HARI, pad2 } from '../api.js'
import { state } from './state.js'

// ===================================================================== NEWS
const WIB = 7 * 3600 * 1000
const toWib = iso => { const d = new Date(iso); return isNaN(d) ? null : new Date(d.getTime() + WIB) }
const dayKey = d => d ? d.getUTCFullYear() + '-' + pad2(d.getUTCMonth() + 1) + '-' + pad2(d.getUTCDate()) : ''
const dayLabel = d => d ? HARI[d.getUTCDay()] + ', ' + d.getUTCDate() + '/' + (d.getUTCMonth() + 1) : ''
const jamWib = d => d ? pad2(d.getUTCHours()) + ':' + pad2(d.getUTCMinutes()) + ' WIB' : 'Sepanjang hari'
const IMPACT = { High: ['Tinggi', 3, 'bg-down'], Medium: ['Sedang', 2, 'bg-gold'], Low: ['Rendah', 1, 'bg-yellow-300'] }
let filters = new Set(['High', 'Medium', 'Low'])

/** Perkiraan arah emas dari forecast vs previous (sama seperti tampilan lama) */
function predictGold(ev) {
  const t = (ev.title || '').toLowerCase()
  const f = parseFloat(String(ev.forecast || '').replace(/[^0-9.-]/g, ''))
  const p = parseFloat(String(ev.previous || '').replace(/[^0-9.-]/g, ''))
  if (isNaN(f) || isNaN(p) || f === p) return null
  const usdKuat = /interest rate|fed|fomc|non-farm|nfp|payroll|gdp|retail sales|pmi|ism|consumer confidence|average hourly|business inventories/.test(t)
  const usdLemah = /unemployment|jobless|claims|unit labor costs/.test(t)
  const inflasi = /cpi|inflation|pce|import prices/.test(t)
  if (usdLemah || inflasi) return f > p ? 'naik' : 'turun'
  if (usdKuat) return f > p ? 'turun' : 'naik'
  return null
}

// ---- Pengingat news dampak tinggi (3 batang): muncul di bar atas, menutupi judul "Harga PemulaOLD",
// status akun & tanggal selama ada pemberitahuan (satu kartu terbaru, ringkas 2 baris). Hilang -> judul kembali.
function floatBox() {
  let box = document.getElementById('newsFloat')
  if (!box) {
    const host = document.getElementById('brandBox') || document.body
    box = h('div', { id: 'newsFloat', class: 'news-float' })
    host.append(box)
  }
  return box
}
function floatNote(title, lines, ms) {
  const box = floatBox()
  const close = () => { card.classList.add('anim-float-out'); setTimeout(() => { card.remove(); if (!box.children.length) box.remove() }, 300) }
  const card = h('div', { class: 'news-card anim-float-in', role: 'status', onclick: e => { if (!e.target.closest('button')) openNews() } },
    h('div', { class: 'news-card-title' }, title),
    h('div', { class: 'news-card-line' }, lines[0] || ''),
    h('button', { class: 'news-card-x', 'aria-label': 'Tutup', onclick: e => { e.stopPropagation(); close() } }, '×'))
  box.append(card)
  // banyak news: baris kedua bergantian tiap 2,5 dtk (1/6, 2/6, ...) supaya semua terbaca di tempat kecil
  let timer = null
  if (lines.length > 1) {
    const line = card.querySelector('.news-card-line')
    let i = 0
    const show = () => { line.textContent = (i + 1) + '/' + lines.length + '  ' + lines[i]; line.classList.remove('news-roll'); void line.offsetWidth; line.classList.add('news-roll') }
    show()
    timer = setInterval(() => { if (!card.isConnected) return clearInterval(timer); i = (i + 1) % lines.length; show() }, 2500)
  }
  // tampil cukup lama untuk melihat semua news (minimal sekali putaran)
  setTimeout(() => { clearInterval(timer); close() }, Math.max(ms || 12000, lines.length * 2500 + 1500))
}
export function checkNewsReminders() {
  if (!state.news.length) return
  const now = Date.now()
  const today = dayKey(toWib(new Date(now).toISOString()))
  const high = state.news.filter(ev => ev.impact === 'High' && dayKey(ev._wib) === today)
  let store = {}
  try { store = JSON.parse(localStorage.getItem('newsRemind') || '{}') } catch (e) {}
  if (store.day !== today) store = { day: today, list: false, soon: {} }
  const upcoming = high.filter(ev => new Date(ev.date).getTime() > now)
  if (!store.list && upcoming.length) {
    store.list = true
    floatNote(upcoming.length + ' news penting hari ini',
      upcoming.slice(0, 12).map(ev => jamWib(ev._wib) + '  ' + ev.title), 15000)
  }
  // <= 30 menit lagi: news yang rilis di jam yang sama digabung jadi satu kartu (judul bergantian)
  const soonGroups = {}
  high.forEach(ev => {
    const left = new Date(ev.date).getTime() - now
    const key = ev.title + '|' + ev.date
    if (left > 0 && left <= 30 * 60000 && !store.soon[key]) {
      store.soon[key] = 1
      ;(soonGroups[ev.date] = soonGroups[ev.date] || []).push(ev)
    }
  })
  Object.values(soonGroups).forEach(list => {
    const left = new Date(list[0].date).getTime() - now
    const n = list.length
    floatNote(Math.max(1, Math.round(left / 60000)) + ' mnt lagi · ' + (n > 1 ? n + ' news ' + jamWib(list[0]._wib).replace(' WIB', '') : 'News penting'),
      list.map(ev => (n > 1 ? '' : jamWib(ev._wib) + '  ') + ev.title), 20000)
  })
  try { localStorage.setItem('newsRemind', JSON.stringify(store)) } catch (e) {}
}
setInterval(checkNewsReminders, 30000)

// 3 menit sebelum news dampak tinggi: tidak bisa ditutup, hitung mundur per detik, sampai rilis.
// Beberapa news di jam rilis yang sama = SATU kartu ("2:59 lagi · 4 news rilis"), nama news bergantian.
const urgent = {}
function urgentTick() {
  if (!state.news.length) return
  const now = Date.now()
  const today = dayKey(toWib(new Date(now).toISOString()))
  const groups = {}
  state.news.forEach(ev => {
    if (ev.impact !== 'High' || dayKey(ev._wib) !== today) return
    ;(groups[ev.date] = groups[ev.date] || []).push(ev)
  })
  Object.entries(groups).forEach(([key, list]) => {
    const left = new Date(key).getTime() - now
    let c = urgent[key]
    const n = list.length
    if (left > 0 && left <= 3 * 60000) {
      if (!c) {
        const box = floatBox()
        c = h('div', { class: 'news-card news-card-urgent anim-float-in', role: 'alert', onclick: openNews },
          h('div', { class: 'news-card-title' }, ''), h('div', { class: 'news-card-line' }, ''))
        c._i = 0
        c._lines = list.map((ev, k) => (n > 1 ? (k + 1) + '/' + n + '  ' : jamWib(ev._wib) + '  ') + ev.title)
        box.append(c)
        urgent[key] = c
      }
      const sec = Math.ceil(left / 1000)
      c.firstChild.textContent = Math.floor(sec / 60) + ':' + String(sec % 60).padStart(2, '0') + ' lagi · ' + (n > 1 ? n + ' news rilis' : 'News rilis')
      // nama news bergantian tiap 3 dtk, urut 1/4 -> 2/4 -> 3/4 -> 4/4
      const idx = n > 1 ? (n - 1 - Math.floor((sec % (n * 3)) / 3) % n) : 0
      const line = c.lastChild
      if (line.textContent !== c._lines[idx]) {
        line.textContent = c._lines[idx]
        if (n > 1) { line.classList.remove('news-roll'); void line.offsetWidth; line.classList.add('news-roll') }
      }
    } else if (c && left <= 0 && !c.dataset.done) {
      c.dataset.done = '1'
      c.firstChild.textContent = 'Rilis sekarang' + (n > 1 ? ' · ' + n + ' news' : '')
      setTimeout(() => { const box = c.parentElement; c.classList.add('anim-float-out'); setTimeout(() => { c.remove(); if (box && !box.children.length) box.remove() }, 300); delete urgent[key] }, 8000)
    }
  })
}
setInterval(urgentTick, 1000)
setInterval(() => loadNews(), 30 * 60000)

export async function loadNews() {
  try {
    const d = await getJSON('/api/ff-calendar')
    if (d.success && Array.isArray(d.events)) {
      d.events.forEach(ev => { ev._wib = toWib(ev.date) })
      d.events.sort((a, b) => (a._wib || 0) - (b._wib || 0))
      state.news = d.events
    }
  } catch (e) {}
  updateNewsBadge()
  checkNewsReminders()
}
export function updateNewsBadge() {
  const today = dayKey(toWib(new Date().toISOString()))
  const n = state.news.filter(ev => ev.impact === 'High' && dayKey(ev._wib) === today).length
  const b = $('#badgeNews')
  b.textContent = n
  b.classList.toggle('hidden', !n)
}

function newsCard(ev, nowMs) {
  const past = ev._wib && ev._wib.getTime() < nowMs
  const [lvl, bars, color] = IMPACT[ev.impact] || ['—', 0, 'bg-line']
  const pred = !past ? predictGold(ev) : null
  const minsLeft = ev._wib && !past ? Math.round((ev._wib.getTime() - nowMs) / 60000) : null
  return h('div', { class: 'tile flex gap-3 p-3 ' + (past ? 'opacity-60' : '') },
    h('div', { class: 'flex shrink-0 items-end gap-0.5 pt-1', title: 'Dampak ' + lvl },
      [0, 1, 2].map(i => h('span', { class: 'block w-1.5 rounded-sm ' + (i < bars ? color : 'bg-line/15'), style: 'height:' + (8 + i * 4) + 'px' }))),
    h('div', { class: 'min-w-0 flex-1' },
      h('div', { class: 'flex flex-wrap items-center gap-2' },
        h('span', { class: 'text-sm font-bold' }, ev.title),
        pred ? h('span', { class: pred === 'naik' ? 'pill-up' : 'pill-down' }, 'Emas ' + pred) : null),
      h('div', { class: 'mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-muted' },
        h('span', {}, jamWib(ev._wib)),
        minsLeft != null && minsLeft < 24 * 60 ? h('span', { class: 'font-semibold text-gold' }, minsLeft >= 60 ? Math.floor(minsLeft / 60) + ' jam ' + (minsLeft % 60) + ' menit lagi' : minsLeft + ' menit lagi') : null),
      (ev.forecast || ev.previous || ev.actual) ? h('div', { class: 'mt-1.5 flex flex-wrap gap-1.5 text-[11px]' },
        ev.forecast ? h('span', { class: 'chip py-0.5' }, 'Forecast ' + ev.forecast) : null,
        ev.previous ? h('span', { class: 'chip py-0.5' }, 'Prev ' + ev.previous) : null,
        ev.actual ? h('span', { class: 'chip border-gold/40 py-0.5 text-gold' }, 'Actual ' + ev.actual) : null) : null))
}

function renderNews(list) {
  const nowWib = toWib(new Date().toISOString())
  const nowMs = nowWib.getTime()
  const today = dayKey(nowWib)
  const evs = state.news.filter(ev => filters.has(ev.impact))
  if (!evs.length) { list.replaceChildren(h('div', { class: 'py-10 text-center text-sm text-muted' }, state.news.length ? 'Tidak ada event dengan filter ini' : 'Belum ada data news')); return }
  const groups = new Map()
  const past = []
  evs.forEach(ev => {
    const k = dayKey(ev._wib)
    if (k < today) { past.push(ev); return }
    if (!groups.has(k)) groups.set(k, [])
    groups.get(k).push(ev)
  })
  const out = []
  for (const [k, items] of groups) {
    out.push(h('div', { class: 'label mb-2 mt-4 first:mt-0' }, (k === today ? 'Hari ini · ' : '') + dayLabel(items[0]._wib) + ' (' + items.length + ')'))
    out.push(h('div', { class: 'flex flex-col gap-2' }, items.map(ev => newsCard(ev, nowMs))))
  }
  if (past.length) {
    const body = h('div', { class: 'mt-2 flex hidden flex-col gap-2' }, past.map(ev => newsCard(ev, nowMs)))
    out.push(h('button', { class: 'btn-ghost mt-4 w-full text-xs', onclick: () => body.classList.toggle('hidden') }, 'Sudah lewat (' + past.length + ')'), body)
  }
  list.replaceChildren(...out)
}

export function openNews() {
  const list = h('div', { class: 'pb-2' }, h('div', { class: 'loader-box' }, h('span', { class: 'spinner' }), 'Memuat kalender...'))
  const filterRow = h('div', { class: 'mb-3 flex gap-2' }, Object.entries(IMPACT).map(([k, [lbl]]) => {
    const b = h('button', { class: 'chip', 'aria-pressed': String(filters.has(k)) }, lbl)
    const paint = () => { b.className = 'chip ' + (filters.has(k) ? 'border-gold text-gold' : 'opacity-50') }
    paint()
    b.addEventListener('click', () => {
      if (filters.has(k)) { if (filters.size > 1) filters.delete(k) } else filters.add(k)
      paint(); renderNews(list)
    })
    return b
  }))
  openSheet('News USD (Forex Factory)', h('div', {},
    h('p', { class: 'mb-3 text-xs text-muted' }, 'Jadwal rilis data ekonomi Amerika yang biasa menggerakkan harga emas. Jam dalam WIB.'),
    filterRow, list))
  if (state.news.length) renderNews(list)
  loadNews().then(() => renderNews(list))
}

// ===================================================================== PROMO
const SEEN_KEY = 'promoSeenIds'
export function setPromos(promos) {
  state.promos = Array.isArray(promos) ? promos : []
  const b = $('#badgePromo')
  const n = state.promos.length
  b.textContent = n
  b.classList.toggle('hidden', !n)
  const ids = state.promos.map(p => p.code).sort().join(',')
  let seen = ''
  try { seen = localStorage.getItem(SEEN_KEY) || '' } catch (e) {}
  b.classList.toggle('animate-pulse', n > 0 && ids !== seen)
}
export async function loadPromos() {
  try { const d = await getJSON('/api/promo-suggestions'); setPromos(d.promos || []) } catch (e) {}
}

async function copy(code, btn) {
  try { await navigator.clipboard.writeText(code) } catch (e) {
    const ta = h('textarea', { style: 'position:fixed;opacity:0' }); ta.value = code
    document.body.append(ta); ta.select(); try { document.execCommand('copy') } catch (e2) {} ta.remove()
  }
  btn.innerHTML = icon('check', 'h-4 w-4') + '<span>Tersalin</span>'
  setTimeout(() => { btn.innerHTML = icon('copy', 'h-4 w-4') + '<span>Salin kode</span>' }, 1600)
}

export function openPromos() {
  const list = h('div', { class: 'flex flex-col gap-3 pb-2' })
  const render = () => {
    if (!state.promos.length) { list.replaceChildren(h('div', { class: 'py-10 text-center text-sm text-muted' }, 'Tidak ada promo aktif saat ini')); return }
    list.replaceChildren(...state.promos.map(p => h('div', { class: 'tile overflow-hidden' },
      p.image_url ? h('img', { src: p.image_url, alt: p.name || 'Promo', class: 'w-full', loading: 'lazy' }) : null,
      h('div', { class: 'p-3' },
        h('div', { class: 'font-bold' }, p.name || 'Promo aktif'),
        p.short_desc ? h('div', { class: 'mt-1 text-xs text-muted' }, p.short_desc) : null,
        h('div', { class: 'mt-2 flex flex-wrap gap-1.5 text-[11px]' },
          p.min_trx && p.min_trx !== '-' ? h('span', { class: 'chip py-0.5' }, 'Min. ' + p.min_trx) : null,
          p.end_to && p.end_to !== '-' ? h('span', { class: 'chip py-0.5' }, 's/d ' + p.end_to) : null),
        h('div', { class: 'mt-3 flex items-center gap-3' },
          p.code ? h('button', { class: 'btn-gold px-3 py-2 text-xs', onclick: e => copy(p.code, e.currentTarget), html: icon('copy', 'h-4 w-4') + '<span>Salin kode</span>' }) : null,
          p.code ? h('span', { class: 'num font-mono text-sm font-bold text-up' }, p.code) : null,
          /^https?:\/\//.test(p.article_url || '') ? h('a', { href: p.article_url, target: '_blank', rel: 'noopener', class: 'ml-auto text-xs font-semibold text-gold' }, 'Detail →') : null)))))
  }
  render()
  openSheet('Promo aktif', list)
  getJSON('/api/promo-suggestions').then(d => {
    setPromos(d.promos || [])
    try { localStorage.setItem(SEEN_KEY, state.promos.map(p => p.code).sort().join(',')) } catch (e) {}
    $('#badgePromo').classList.remove('animate-pulse')
    render()
  }).catch(() => toast('Gagal memuat promo', 'error'))
}
