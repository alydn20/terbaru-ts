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
  const list = h('div', { class: 'pb-2' }, h('div', { class: 'py-10 text-center text-sm text-muted' }, 'Memuat kalender...'))
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
