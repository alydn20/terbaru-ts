// Tabel riwayat perubahan harga (dari /price-history, per halaman) dan riwayat USD/IDR.
import { $, $$, h, getJSON, num, signed } from '../api.js'
import { state, markupOf, visibleNominals, profitOf } from './state.js'

const PER_PAGE = 10
let mode = 'price'
let page = 1
let totalPages = 1
let usdItems = []

const changeEl = n => n
  ? h('div', { class: 'num text-[11px] font-bold ' + (n > 0 ? 'text-up' : 'text-down') }, (n > 0 ? '▲ ' : '▼ ') + signed(n))
  : null

function renderHead() {
  const th = (t, cls = '') => h('th', { class: 'px-3 py-2 font-bold ' + cls }, t)
  const row = mode === 'price'
    ? [th('Waktu', 'sticky left-0 bg-card2'), th('Beli'), th('Jual'), th('USD/IDR', 'hist-idr-col text-right'), th('Status', 'hist-st-col'), ...visibleNominals().map(n => th(n.label, 'text-right'))]
    : [th('Waktu'), th('USD/IDR'), th('Perubahan')]
  $('#histHead').replaceChildren(h('tr', {}, row))
}

function empty(text) {
  $('#histBody').replaceChildren(h('tr', {}, h('td', { colspan: 20, class: 'px-4 py-8 text-center text-sm text-muted' }, text)))
}

function idrCell(rate, prev) {
  if (!rate) return h('td', { class: 'hist-idr-col px-3 py-2 text-right text-muted' }, '—')
  const ch = prev ? Math.round(rate) - Math.round(prev) : 0
  return h('td', { class: 'hist-idr-col px-3 py-2 text-right' },
    h('div', { class: 'num font-mono font-bold text-sky' }, num(Math.round(rate))),
    ch ? h('div', { class: 'num text-[11px] font-bold ' + (ch > 0 ? 'text-up' : 'text-down') }, (ch > 0 ? '▲ ' : '▼ ') + signed(ch)) : null)
}

function renderPriceRows(items) {
  if (!items.length) return empty('Belum ada data perubahan harga')
  const rows = items.map((item, idx) => {
    const t = new Date(typeof item.time === 'string' ? item.time.replace(' ', 'T') : item.time)
    const jam = isNaN(t) ? String(item.time).substring(11, 19) : t.toTimeString().substring(0, 8)
    const mk = item.xauUsd && item.usdIdr ? markupOf(item.sell, item.xauUsd, item.usdIdr) : null
    const status = !mk ? h('span', { class: 'text-muted' }, '—')
      : mk.normal ? h('span', { class: 'pill-up' }, 'Normal')
      // panel samping (desktop, grafik + riwayat) memakai singkatan MU / MD supaya tabel muat
      : h('span', { class: 'pill bg-gold/15 text-gold' },
        h('span', { class: 'st-long' }, mk.diff > 0 ? 'MARKUP ' : 'MARKDOWN '),
        h('span', { class: 'st-short' }, mk.diff > 0 ? 'MU ' : 'MD '), signed(mk.diff))
    // HP: status ditaruh di bawah jam (kolom Status disembunyikan) supaya tabel muat selebar layar
    const statusSmall = h('div', { class: 'hist-st-inline mt-0.5 whitespace-nowrap font-sans text-[10px] font-bold ' + (!mk ? 'text-muted' : mk.normal ? 'text-up' : 'text-gold') },
      !mk ? '—' : mk.normal ? 'Normal' : (mk.diff > 0 ? 'MU ' : 'MD ') + signed(mk.diff))
    const priceCell = (v, ch) => h('td', { class: 'px-3 py-2' },
      h('div', { class: 'num font-mono font-bold ' + (ch > 0 ? 'text-up' : ch < 0 ? 'text-down' : '') }, num(v)), changeEl(ch))
    return h('tr', { class: 'odd:bg-transparent even:bg-card2/40' },
      h('td', { class: 'sticky left-0 bg-card px-3 py-2 font-mono text-xs text-muted' }, jam, statusSmall),
      priceCell(item.buy, item.buyChange || 0),
      priceCell(item.sell, item.sellChange || 0),
      // Desktop: kurs USD/IDR jadi satu kolom di tabel harga (HP tetap tabel terpisah lewat tombol USD/IDR).
      // Perubahan dibanding baris sebelumnya (lebih lama, di bawahnya).
      idrCell(item.usdIdr, items[idx + 1] && items[idx + 1].usdIdr),
      h('td', { class: 'hist-st-col px-3 py-2 whitespace-nowrap text-[11px]' }, status),
      ...visibleNominals().map(n => {
        const p = profitOf(n, item.buy, item.sell)
        return h('td', { class: 'px-3 py-2 text-right', title: p.gram.toFixed(4) + ' gram' },
          h('div', { class: 'hist-gram num font-mono text-xs text-muted' }, p.gram.toFixed(4) + 'g'),
          h('div', { class: 'num text-[11px] font-bold ' + (p.profit >= 0 ? 'text-up' : 'text-down') }, (p.profit >= 0 ? '+' : '−') + 'Rp' + num(Math.abs(p.profit))))
      }))
  })
  $('#histBody').replaceChildren(...rows)
}

function renderUsdRows() {
  if (!usdItems.length) return empty('Belum ada data perubahan USD/IDR')
  const start = (page - 1) * PER_PAGE
  const rows = usdItems.slice(start, start + PER_PAGE).map(item => h('tr', {},
    h('td', { class: 'px-3 py-2 font-mono text-xs text-muted' }, typeof item.time === 'string' ? item.time.substring(11, 19) : '—'),
    h('td', { class: 'num px-3 py-2 font-mono font-bold' }, 'Rp' + num(item.rate)),
    h('td', { class: 'px-3 py-2' }, changeEl(Math.round(item.change || 0)) || h('span', { class: 'text-muted' }, '—'))))
  $('#histBody').replaceChildren(...rows)
}

function renderPager(total) {
  $('#histInfo').textContent = 'Hal ' + page + ' / ' + totalPages + ' · ' + total + ' data'
  $('#histNewer').disabled = page <= 1
  $('#histOlder').disabled = page >= totalPages
}

export async function loadHistory() {
  if (mode !== 'price' && matchMedia('(min-width: 1024px)').matches) {
    mode = 'price'
    $$('#histMode button').forEach(x => x.setAttribute('aria-pressed', String(x.dataset.mode === 'price')))
  }
  renderHead()
  try {
    if (mode === 'price') {
      const d = await getJSON('/price-history?page=' + page + '&perPage=' + PER_PAGE)
      totalPages = d.totalPages || 1
      if (d.currentUsdIdr) state.usdIdr = state.usdIdr || d.currentUsdIdr
      renderPriceRows(d.items || [])
      renderPager(d.total || 0)
    } else {
      const d = await getJSON('/usd-idr-history')
      usdItems = d.items || []
      totalPages = Math.max(1, Math.ceil(usdItems.length / PER_PAGE))
      renderUsdRows()
      renderPager(usdItems.length)
    }
  } catch (e) { empty('Gagal memuat data') }
}

/** Ada harga baru: kembali ke halaman pertama hanya kalau user sedang di halaman pertama */
export function onNewPrice() { if (mode === 'price' && page === 1) loadHistory() }
export function onUsdIdr(item) {
  if (mode !== 'usdidr' || !item || !item.time) return
  usdItems.unshift({ time: item.time, rate: item.rate, change: item.change || 0 })
  if (page === 1) { renderUsdRows(); renderPager(usdItems.length) }
}

export function initHistory() {
  $$('#histMode button').forEach(b => b.addEventListener('click', () => {
    mode = b.dataset.mode
    page = 1
    $$('#histMode button').forEach(x => x.setAttribute('aria-pressed', String(x === b)))
    loadHistory()
  }))
  $('#histNewer').addEventListener('click', () => { if (page > 1) { page--; loadHistory() } })
  $('#histOlder').addEventListener('click', () => { if (page < totalPages) { page++; loadHistory() } })
  loadHistory()
}
