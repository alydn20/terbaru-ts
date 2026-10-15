// Data bersama halaman monitoring + rumus yang sama dengan tampilan lama.

export const state = {
  phone: '',
  user: null,
  isAdmin: false,
  buy: 0,
  sell: 0,
  usdIdr: 0,
  xauUsd: 0,
  lastUpdatedAt: 0,
  high: null,
  low: null,
  promo: null,          // 'ON' | 'OFF'
  markupMin: 0.7,       // % (diatur admin)
  markupMax: 2.0,
  nominals: [],         // dari /api/nominal-settings
  promos: [],
  news: []
}

// ---------- nominal yang ditampilkan (pilihan user, disimpan di perangkat) ----------
const PREF_KEY = 'userNominalPrefs'
let prefs = (() => { try { return JSON.parse(localStorage.getItem(PREF_KEY) || 'null') } catch (e) { return null } })()
export const visibleNominals = () => state.nominals.filter(n => !prefs || prefs[n.id] !== false)
export const isNominalVisible = id => !prefs || prefs[id] !== false
export function setNominalVisible(id, on) {
  if (!prefs) { prefs = {}; state.nominals.forEach(n => { prefs[n.id] = true }) }
  prefs[id] = !!on
  try { localStorage.setItem(PREF_KEY, JSON.stringify(prefs)) } catch (e) {}
}

/** Gram yang didapat dan untung bila langsung dijual (diskon nominal dari admin) */
export function profitOf(n, buy, sell) {
  const gram = n.amount / buy
  return { gram, profit: Math.round(gram * sell - (n.amount - n.amount * n.discountRate)) }
}

/** Markup/markdown harga jual terhadap harga acuan internasional (XAU x USD/IDR / 31,1035) */
export function markupOf(sell, xauUsd, usdIdr) {
  const base = (xauUsd * usdIdr) / 31.1035
  const lower = base * (1 + state.markupMin / 100)
  const upper = base * (1 + state.markupMax / 100)
  if (sell >= lower && sell <= upper) return { normal: true, diff: 0 }
  return { normal: false, diff: sell > upper ? Math.round(sell - upper) : Math.round(sell - lower) }
}
