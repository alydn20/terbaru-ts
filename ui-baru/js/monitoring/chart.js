// Grafik TradingView (TVC:GOLD) + pilihan indikator (disimpan di perangkat, sama dengan tampilan lama).
import { isMobile } from '../api.js'

// Indikator susunan user (disimpan di perangkat). Bawaan: TANPA indikator.
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
  return []
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

export function loadChart() {
  const box = document.getElementById('tvChart')
  if (!box) return
  const light = document.documentElement.dataset.theme === 'light'
  const list = activeIndicators()
  const config = {
    autosize: true,
    symbol: 'TVC:GOLD',
    interval: '1',
    timezone: 'Asia/Jakarta',
    theme: light ? 'light' : 'dark',
    style: '1',
    locale: 'en',
    backgroundColor: light ? '#eef2ff' : '#000000',
    gridColor: light ? 'rgba(30,41,99,0.07)' : 'rgba(255,255,255,0.05)',
    hide_top_toolbar: false,
    hide_legend: false,
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
  box.innerHTML = '<div class="tradingview-widget-container h-full"><div class="tradingview-widget-container__widget h-full"></div></div>'
  const s = document.createElement('script')
  s.src = 'https://s3.tradingview.com/external-embedding/embed-widget-advanced-chart.js'
  s.async = true
  s.textContent = JSON.stringify(config)
  box.firstChild.append(s)
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
