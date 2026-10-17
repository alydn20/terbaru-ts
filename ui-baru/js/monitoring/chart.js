// Grafik TradingView (TVC:GOLD) + pilihan indikator (disimpan di perangkat, sama dengan tampilan lama).
import { isMobile } from '../api.js'

// Indikator susunan user (disimpan di perangkat). Bawaan: EMA 20 + EMA 50 + BB 20.
// Simpanan: [{ t: 'ma', len: 50 }, ...]; len = periode (hanya untuk indikator yang punya periode).
// Kunci baru (v2) supaya semua user mulai tanpa indikator, lalu memakai pilihan sendiri.
const KEY = 'gold_monitor_indicators_v2'
// [id, nama, id studi TradingView, periode bawaan (null = tidak ada periode)]
export const INDICATORS = [
  ['ma', 'Moving Average (MA)', 'MASimple@tv-basicstudies', 20],
  ['ema', 'Exponential MA (EMA)', 'MAExp@tv-basicstudies', 20],
  ['bb', 'Bollinger Bands', 'BB@tv-basicstudies', 20],
  ['vwap', 'VWAP', 'VWAP@tv-basicstudies', null],
  ['rsi', 'RSI', 'RSI@tv-basicstudies', 14],
  ['macd', 'MACD', 'MACD@tv-basicstudies', null],
  ['stoch', 'Stochastic', 'Stochastic@tv-basicstudies', null],
  ['atr', 'ATR', 'ATR@tv-basicstudies', 14],
  ['vol', 'Volume', 'Volume@tv-basicstudies', null],
  ['ichimoku', 'Ichimoku Cloud', 'IchimokuCloud@tv-basicstudies', null]
]
export const indicatorDef = t => INDICATORS.find(x => x[0] === t)
export function activeIndicators() {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) || 'null')
    if (Array.isArray(v)) return v.filter(x => x && indicatorDef(x.t)).slice(0, 12)
  } catch (e) {}
  // Bawaan (belum pernah mengatur): EMA 20 + EMA 50 (arah tren) + Bollinger Bands 20 (rentang gerak),
  // semuanya di atas grafik harga, tidak menambah panel di bawah (cocok juga di HP). Bisa diubah di Indikator grafik.
  return [{ t: 'ema', len: 20 }, { t: 'ema', len: 50 }, { t: 'bb', len: 20 }]
}
export function saveIndicators(list) {
  try { localStorage.setItem(KEY, JSON.stringify(list)) } catch (e) {}
  loadChart()
}
function studyOf(x) {
  const d = indicatorDef(x.t)
  const len = parseInt(x.len, 10)
  return d[3] && len > 0 ? { id: d[2], inputs: { length: len } } : d[2]
}

// Grafik per tema disimpan berdampingan (yang tidak aktif tersembunyi di belakang): ganti mode gelap/terang
// cukup menukar tampilan -> grafik langsung berubah, tidak menunggu TradingView memuat ulang.
// Grafik tema lain disiapkan diam-diam beberapa detik setelah grafik utama tampil.
const charts = {} // tema -> { el, sig }
let preloadTimer = null
function chartConfig(theme, list) {
  const light = theme === 'light'
  return {
    autosize: true,
    symbol: 'TVC:GOLD',
    interval: '1',
    timezone: 'Asia/Jakarta',
    theme,
    style: '1',
    locale: 'en',
    backgroundColor: light ? '#eef2ff' : '#000000',
    gridColor: light ? 'rgba(30,41,99,0.07)' : 'rgba(255,255,255,0.05)',
    hide_top_toolbar: false,
    // label indikator di pojok kiri atas grafik (mis. "MA 20 close 4,166") disembunyikan supaya grafik bersih
    hide_legend: true,
    allow_symbol_change: true,
    save_image: true,
    calendar: false,
    hide_volume: !list.some(x => x.t === 'vol'),
    hide_side_toolbar: isMobile(),
    withdateranges: true,
    details: false,
    hotlist: false,
    studies: list.filter(x => x.t !== 'vol').map(studyOf),
    support_host: 'https://www.tradingview.com'
  }
}
function buildChart(box, theme, list) {
  const el = document.createElement('div')
  el.className = 'tv-layer tradingview-widget-container'
  el.dataset.theme = theme
  el.innerHTML = '<div class="tradingview-widget-container__widget h-full"></div>'
  const s = document.createElement('script')
  s.src = 'https://s3.tradingview.com/external-embedding/embed-widget-advanced-chart.js'
  s.async = true
  s.textContent = JSON.stringify(chartConfig(theme, list))
  el.append(s)
  box.append(el)
  return el
}
export function loadChart() {
  const box = document.getElementById('tvChart')
  if (!box) return
  const theme = document.documentElement.dataset.theme === 'light' ? 'light' : 'dark'
  const list = activeIndicators()
  const sig = JSON.stringify(list) + '|' + isMobile()
  // indikator berubah: semua grafik lama dibuang (dibuat ulang dengan indikator baru)
  for (const t of Object.keys(charts)) if (charts[t].sig !== sig) { charts[t].el.remove(); delete charts[t] }
  if (!charts[theme]) charts[theme] = { el: buildChart(box, theme, list), sig }
  for (const t of Object.keys(charts)) charts[t].el.classList.toggle('tv-hidden', t !== theme)
  // siapkan grafik tema lain di belakang (sekali), supaya ganti mode berikutnya instan
  clearTimeout(preloadTimer)
  const other = theme === 'light' ? 'dark' : 'light'
  if (!charts[other]) preloadTimer = setTimeout(() => {
    if (!charts[other] && (charts[theme] || {}).sig === sig) {
      charts[other] = { el: buildChart(box, other, list), sig }
      charts[other].el.classList.add('tv-hidden')
    }
  }, 6000)
}

// Grafik dimuat saat bagiannya hampir terlihat (hemat kuota di HP)
export function initChart() {
  const box = document.getElementById('tvChart')
  if (!box) return
  if (!('IntersectionObserver' in window)) return loadChart()
  const io = new IntersectionObserver(entries => {
    if (entries.some(e => e.isIntersecting)) { io.disconnect(); loadChart() }
  }, { rootMargin: '300px' })
  io.observe(box)
}
