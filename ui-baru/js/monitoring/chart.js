// Grafik TradingView (TVC:GOLD) + pilihan indikator (disimpan di perangkat, sama dengan tampilan lama).
import { isMobile } from '../api.js'

const KEY = 'gold_monitor_indicators'
export const INDICATORS = [
  ['ma', 'Moving Average (MA)', 'MASimple@tv-basicstudies'],
  ['ema', 'Exponential MA (EMA)', 'MAExp@tv-basicstudies'],
  ['bb', 'Bollinger Bands', 'BB@tv-basicstudies'],
  ['vwap', 'VWAP', 'VWAP@tv-basicstudies'],
  ['rsi', 'RSI', 'RSI@tv-basicstudies'],
  ['macd', 'MACD', 'MACD@tv-basicstudies'],
  ['stoch', 'Stochastic', 'Stochastic@tv-basicstudies'],
  ['atr', 'ATR', 'ATR@tv-basicstudies'],
  ['vol', 'Volume', 'Volume@tv-basicstudies'],
  ['ichimoku', 'Ichimoku Cloud', 'IchimokuCloud@tv-basicstudies']
]
export function activeIndicators() {
  try { const v = JSON.parse(localStorage.getItem(KEY) || 'null'); if (Array.isArray(v)) return v } catch (e) {}
  return ['ma', 'bb', 'vwap']
}
export function saveIndicators(ids) {
  try { localStorage.setItem(KEY, JSON.stringify(ids)) } catch (e) {}
  loadChart()
}

export function loadChart() {
  const box = document.getElementById('tvChart')
  if (!box) return
  const light = document.documentElement.dataset.theme === 'light'
  const ids = activeIndicators()
  const config = {
    autosize: true,
    symbol: 'TVC:GOLD',
    interval: '1',
    timezone: 'Asia/Jakarta',
    theme: light ? 'light' : 'dark',
    style: '1',
    locale: 'en',
    backgroundColor: light ? '#f6f8fb' : '#18212c',
    gridColor: light ? 'rgba(15,23,42,0.06)' : 'rgba(255,255,255,0.05)',
    hide_top_toolbar: false,
    hide_legend: false,
    allow_symbol_change: true,
    save_image: true,
    calendar: false,
    hide_volume: !ids.includes('vol'),
    hide_side_toolbar: isMobile(),
    withdateranges: true,
    details: false,
    hotlist: false,
    studies: INDICATORS.filter(([id]) => ids.includes(id)).map(([, , s]) => s),
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
