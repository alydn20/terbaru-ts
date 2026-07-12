// index.js - Gold Price Monitor v2.2 with Redis + Push Notifications + User Auth
import makeWASocket, {
  DisconnectReason,
  fetchLatestBaileysVersion,
  useMultiFileAuthState,
  Browsers,
  makeCacheableSignalKeyStore,
  initAuthCreds,
  proto,
  BufferJSON
} from '@whiskeysockets/baileys'
import pino from 'pino'
import express from 'express'
import http from 'http'
import https from 'https'
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import webpush from 'web-push'
import crypto from 'crypto'
import { exec } from 'child_process'
import { promisify } from 'util'
import IORedis from 'ioredis'

const execAsync = promisify(exec)

// Global error handlers — cegah crash saat Redis limit/network error,
// TAPI tetap log lengkap ke stderr (terlihat di log Koyeb) + admin panel.
process.on('unhandledRejection', (reason) => {
  console.error(`[${new Date().toISOString()}] [UNHANDLED_REJECTION]`, reason)
  try { pushLog(`❌ UnhandledRejection: ${reason && reason.message ? reason.message : String(reason)}`) } catch (_) {}
})
process.on('uncaughtException', (err) => {
  console.error(`[${new Date().toISOString()}] [UNCAUGHT_EXCEPTION]`, err)
  try { pushLog(`❌ UncaughtException: ${err && err.message ? err.message : String(err)}`) } catch (_) {}
})

// VAPID Keys untuk Web Push Notifications
const VAPID_PUBLIC_KEY = 'BPvtMmw2JMUUh55UKWO9cSo014LpHor_JDQSwda_MM_J2psg3SsFhzil22utOe5o8wSsQKv218mEQbrvEwN0U18'
const VAPID_PRIVATE_KEY = 'KMp0F8Q9gzNWpRP1nBwr6xWbc__wG7LcDE17WNAuiHw'

webpush.setVapidDetails(
  'mailto:admin@goldmonitor.com',
  VAPID_PUBLIC_KEY,
  VAPID_PRIVATE_KEY
)

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

// Redis (Upstash) via ioredis.
// Upstash menutup koneksi TCP yang idle — tanpa keepalive, perintah pertama setelah
// jeda dikirim lewat koneksi mati → menggantung sampai commandTimeout ("Command timed out").
const _ioredis = new IORedis(process.env.REDIS_URL || 'redis://localhost:6379', {
  maxRetriesPerRequest: 5,
  commandTimeout: 15000,
  connectTimeout: 15000,
  keepAlive: 15000,            // TCP keepalive agar koneksi tidak dianggap idle
  noDelay: true,
  retryStrategy: (times) => Math.min(times * 500, 5000),
  reconnectOnError: (err) => {
    // Koneksi basi/di-reset oleh Upstash — langsung reconnect, jangan tunggu timeout
    const msg = err && err.message ? err.message : ''
    return msg.includes('ECONNRESET') || msg.includes('EPIPE') || msg.includes('Connection is closed')
  }
})

// PING berkala agar koneksi tidak pernah idle (Upstash memutus koneksi idle).
// Juga berfungsi sebagai deteksi dini: kalau koneksi mati, reconnect terjadi di sini,
// bukan saat request user berikutnya.
setInterval(() => { _ioredis.ping().catch(() => {}) }, 30 * 1000)

// Cache session di memory agar tidak logout saat Redis timeout
const _sessionCache = new Map() // sessionId -> phone, TTL 5 menit
const SESSION_CACHE_TTL = 5 * 60 * 1000
_ioredis.on('error', () => {})

// ==================== UPSTASH REST FALLBACK ====================
// Kalau perintah lewat TCP gagal (timeout/koneksi basi), ulangi lewat REST API
// Upstash (HTTPS, stateless — tidak punya masalah koneksi idle sama sekali).
// Kredensial: env UPSTASH_REDIS_REST_URL/TOKEN, atau diturunkan otomatis dari
// REDIS_URL (di Upstash, password TCP = token REST).
const _REDIS_REST = (() => {
  try {
    if (process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN) {
      return { url: process.env.UPSTASH_REDIS_REST_URL.replace(/\/$/, ''), token: process.env.UPSTASH_REDIS_REST_TOKEN }
    }
    const u = new URL(process.env.REDIS_URL || '')
    if (u.hostname.endsWith('.upstash.io') && u.password) {
      return { url: 'https://' + u.hostname, token: decodeURIComponent(u.password) }
    }
  } catch (e) {}
  return null
})()

// Log status fallback saat startup — untuk verifikasi build & konfigurasi di Koyeb
console.log(`[${new Date().toISOString()}] [REDIS] REST fallback: ${_REDIS_REST ? 'AKTIF → ' + _REDIS_REST.url : 'TIDAK TERSEDIA (REDIS_URL bukan Upstash & env UPSTASH_REDIS_REST_* kosong)'}`)
// Log host TCP (tanpa password) — untuk tahu database mana yang sebenarnya dipakai
try {
  const _u = new URL(process.env.REDIS_URL || 'redis://localhost:6379')
  console.log(`[${new Date().toISOString()}] [REDIS] TCP host: ${_u.hostname}:${_u.port || 6379} (scheme: ${_u.protocol}, password: ${_u.password ? 'ada' : 'KOSONG'})`)
} catch (e) {
  console.log(`[${new Date().toISOString()}] [REDIS] REDIS_URL tidak bisa diparse sebagai URL`)
}

async function _redisRest(cmd) {
  if (!_REDIS_REST) throw new Error('REST fallback tidak tersedia')
  const res = await fetch(_REDIS_REST.url, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + _REDIS_REST.token, 'Content-Type': 'application/json' },
    body: JSON.stringify(cmd.map(a => String(a))),
    signal: AbortSignal.timeout(10000)
  })
  const data = await res.json()
  if (data.error) throw new Error('Upstash REST: ' + data.error)
  return data.result
}

let _restFallbackCount = 0
let _restFailLogged = 0
async function _tcpThenRest(tcpFn, restCmd) {
  try {
    return await tcpFn()
  } catch (e) {
    // TCP gagal → coba lewat REST. Kalau REST juga gagal, lempar error TCP asli.
    try {
      const result = await _redisRest(restCmd)
      _restFallbackCount++
      if (_restFallbackCount === 1 || _restFallbackCount % 50 === 0) {
        console.log(`[${new Date().toISOString()}] [REDIS_REST_FALLBACK] TCP gagal (${e && e.message}), dilayani via REST (total fallback: ${_restFallbackCount})`)
      }
      return result
    } catch (e2) {
      // Log beberapa kegagalan REST pertama agar penyebabnya terlihat di Koyeb
      if (_restFailLogged < 5) {
        _restFailLogged++
        console.error(`[${new Date().toISOString()}] [REDIS_REST_FALLBACK_GAGAL] ${e2 && e2.message ? e2.message : e2}`)
      }
      throw e
    }
  }
}

// Wrapper agar API-nya kompatibel dengan kode lama (hset object form, hgetall null)
const redis = {
  async get(key) {
    return _tcpThenRest(() => _ioredis.get(key), ['GET', key])
  },
  async set(key, val) {
    return _tcpThenRest(() => _ioredis.set(key, val), ['SET', key, val])
  },
  async del(key) {
    return _tcpThenRest(() => _ioredis.del(key), ['DEL', key])
  },
  async hget(key, field) {
    try {
      const val = await _tcpThenRest(() => _ioredis.hget(key, field), ['HGET', key, field])
      if (key === 'gold:sessions' && val) {
        _sessionCache.set(field, { phone: val, exp: Date.now() + SESSION_CACHE_TTL })
      }
      return val
    } catch (e) {
      // TCP & REST sama-sama gagal: pakai cache memory agar user tidak logout
      if (key === 'gold:sessions') {
        const cached = _sessionCache.get(field)
        if (cached && cached.exp > Date.now()) return cached.phone
      }
      throw e
    }
  },
  async hset(key, fields) {
    const args = []
    for (const [f, v] of Object.entries(fields)) args.push(f, v)
    if (key === 'gold:sessions') {
      for (const [f, v] of Object.entries(fields)) {
        _sessionCache.set(f, { phone: v, exp: Date.now() + SESSION_CACHE_TTL })
      }
    }
    return _tcpThenRest(() => _ioredis.hset(key, ...args), ['HSET', key, ...args])
  },
  async hdel(key, field) {
    if (key === 'gold:sessions') _sessionCache.delete(field)
    return _tcpThenRest(() => _ioredis.hdel(key, field), ['HDEL', key, field])
  },
  async hgetall(key) {
    const res = await _tcpThenRest(() => _ioredis.hgetall(key), ['HGETALL', key])
    // REST mengembalikan array datar [field, value, ...] — konversi ke object
    let obj = res
    if (Array.isArray(res)) {
      obj = {}
      for (let i = 0; i < res.length; i += 2) obj[res[i]] = res[i + 1]
    }
    return (obj && Object.keys(obj).length > 0) ? obj : null
  },
  async rpush(key, val) {
    return _tcpThenRest(() => _ioredis.rpush(key, val), ['RPUSH', key, val])
  },
  async lrange(key, start, stop) {
    return _tcpThenRest(() => _ioredis.lrange(key, start, stop), ['LRANGE', key, start, stop])
  },
  async ltrim(key, start, stop) {
    return _tcpThenRest(() => _ioredis.ltrim(key, start, stop), ['LTRIM', key, start, stop])
  }
}

// HTTP Keep-Alive agents untuk koneksi lebih cepat
const httpAgent = new http.Agent({ keepAlive: true, maxSockets: 10 })
const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 10 })

// ------ CONFIG ------
const PORT = process.env.PORT || 8000
const TREASURY_URL = process.env.TREASURY_URL ||
  'https://api.treasury.id/api/v1/antigrvty/gold/rate'

// Treasury Promo API Config
const TREASURY_NOMINAL_URL = 'https://connect.treasury.id/nominal/suggestion'
const TREASURY_PROMO_SUGGESTION_URL = 'https://connect.treasury.id/promotion/suggestion'
const TREASURY_LOGIN_URL = 'https://connect.treasury.id/user/signin'
const TREASURY_CREDENTIALS = {
  "client_id": "3",
  "client_secret": "rDiXUGRe49xucEIkRbUW7l4AqQcezXlplFvLjKnO2",
  "latitude": "0.0",
  "longitude": "0.0",
  "scope": "*",
  "email": "085863566038",
  "password": "@Facebook20",
  "app_name": null,
  "provider": null,
  "token": null,
  "device_id": "android-V417IR-Asus/AI2401/AI2401:12/V417IR/118:user/release-keys",
  "shield_id": "440c8624bf64bb19cf837ba523cce794",
  "shield_session_id": "6aea0479c8ce4f2f829577ca82c9de07"
}

// Anti-spam settings
const COOLDOWN_PER_CHAT = 60000
const GLOBAL_THROTTLE = 3000
const TYPING_DURATION = 2000

// BROADCAST COOLDOWN
const PRICE_CHECK_INTERVAL = 500 // 500ms - balanced speed
const MIN_PRICE_CHANGE = 1
const BROADCAST_COOLDOWN = 50000 // 50 detik antar broadcast (atau ganti menit)

// Economic Calendar Settings
const ECONOMIC_CALENDAR_ENABLED = true
const CALENDAR_COUNTRY_FILTER = ['USD']
const CALENDAR_MIN_IMPACT = 3

// Broadcast Settings
const BATCH_SIZE = 20 // Max messages per batch
const BATCH_DELAY = 1000 // Delay between batches (ms)

// Konversi troy ounce ke gram
const TROY_OZ_TO_GRAM = 31.1034768

// Threshold untuk harga normal/abnormal
const NORMAL_THRESHOLD = 2000
const NORMAL_LOW_THRESHOLD = 1000

// Cache untuk XAU/USD
let cachedXAUUSD = null
let lastXAUUSDFetch = 0
const XAU_CACHE_DURATION = 30000

// History untuk chart XAU/USD (simpan 60 data points = 30 menit dengan interval 30 detik)
const xauHistory = []
const MAX_XAU_HISTORY = 60

// Cache untuk Economic Calendar
let cachedEconomicEvents = null
let lastEconomicFetch = 0
const ECONOMIC_CACHE_DURATION = 300000 // 5 menit

let lastKnownPrice = null
let lastBroadcastedPrice = null
let isBroadcasting = false
let broadcastCount = 0
let lastBroadcastTime = 0
let lastBroadcastMinute = -1  // Track menit terakhir broadcast untuk hindari 2x di menit sama
let lastBroadcastMessage = ''  // Simpan pesan terakhir untuk monitoring

// ⏱️ STALE PRICE DETECTION
let lastPriceUpdateTime = 0  // Kapan terakhir harga berubah dari API
const STALE_PRICE_THRESHOLD = 5 * 60 * 1000  // 5 menit

// Reconnect settings
let reconnectAttempts = 0
const MAX_RECONNECT_ATTEMPTS = 10
const BASE_RECONNECT_DELAY = 5000
let consecutive428 = 0 // Track consecutive 428 (connectionClosed) untuk deteksi sesi expired
let isStarting = false // Guard agar start() tidak dipanggil bersamaan
let reconnectTimer = null // Timer reconnect aktif - cancel dulu sebelum set baru
let pingInterval = null  // Interval ping WS - clear dulu sebelum buat baru

// ------ STATE ------
let lastQr = null
const logs = []
const loginHistory = [] // in-memory login log per nomor user
const MAX_LOGIN_HISTORY = 300
const processedMsgIds = new Set()
const lastReplyAtPerChat = new Map()
let lastGlobalReplyAt = 0
const pendingEmasReplies = new Map() // target → { pendingMsg, requestTime }
let isReady = false
let sock = null

const subscriptions = new Set()

// 🎁 PROMO ON/OFF STATE
// Token awal dari Treasury (akan di-refresh otomatis jika expired)
let treasuryToken = 'eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.eyJzY29wZXMiOlsiKiJdLCJhdWQiOiIzIiwiZXhwIjoxNzY3NzA3ODcwLCJqdGkiOiJyWmc2RTdLeU16YUtVZzB0Q3dPeUc5dGQxMlNROHh3YUxLT2IyZGZiMElCZjM0anJYMW5PSXVZZDNMOUxTUHR0eXd3eVRYN1RXN0RJbFpUdDdkbUhjRVJiWnJWbmVUSjJZWkl0IiwiaWF0IjoxNzY2NDExODcwLCJuYmYiOjE3NjY0MTE4NzAsInN1YiI6IjE2ODg3Nzk0In0.FDb_1WLhjE4pJ5zfhuAkAX4-mhIylcXAZmNbyWA2o-E9N8bzxrKqkiL0RRPaISggDOBz2m31eYtM_3-hNwsDIkhejhBnDDDYmD8xurKe1275zYE3OJE2XGw8QhXwlop1K_IA0PzVzXqnPJm5DQyKCU6Ya_QRVMmidVpOji3Q4bbR-aHL9U0l1CsubwvI7laj66qCjw2XT7ftKf0bFW1mm5yDz-l0zuJVzpNlvsFBqroI_RR6nVHeu4wG3QYhvoATKUyRntjWMLuPRB9wu2WA7-DJuQtACvfMPdqoNhfT-sgSYxR1WXuI4micZe3_tOKbabiK2FJUoLHkHtPnPwEuAxnxDwzlvqOoQrTpbtBRUbRprjjdJ6CD0J2TR7qkkhX284BJHBVub8kYTNYpYIhim9Zzvgh_1TdBnX-nBFNvK0fFiaA4VbqAnl5jcFTs2HEglj_Vh3RT0XHa7b8DSjHfRlnsWxr6jJexT7-6svnXHQFUBnRG-qa5RXYyp9mDxqIWsURcS19OuxSSwlHVTRsLq_4AMfupWwKLSRFIERHwYgrbYozDlROb-x8FDLuOlON8wiMSSlSaVCXW0ZboV7h6ROte_mrRoTjRsn2QVA1pyGZbSn6NfEudvqcLcHXBz1cc9rdJMJ6lvRBInUHg2JjZxzTJRGiVa69ICmm0D4bQK3Y'
let lastPromoStatus = null // 'ON' atau 'OFF'
let lowestOnPriceCache = undefined // undefined = belum diload, null = belum ada nilai
let lowestOnDateWIB = null        // Tanggal WIB (YYYY-MM-DD) saat lowestOnPriceCache dicatat
let lowestOnPendingTimeout = null // Timeout 20 detik sebelum update titik ON terendah
let lowestOnPendingPrice = null   // Harga kandidat yang sedang menunggu konfirmasi
let lowestOnResetTimeout = null   // Timeout 20 detik sebelum reset titik ON saat OFF
let prevUsdIdrRate = null         // USD/IDR rate sebelumnya untuk tampilkan perubahan
let lastLoggedUsdIdr = null       // USD/IDR terakhir yang sudah di-log saat berubah
const usdIdrHistory = []          // In-memory only, tidak disimpan ke Redis
const MAX_USD_IDR_HISTORY = 500
let dailyHighBuy = null           // Harga beli tertinggi hari ini (WIB)
let dailyLowBuy = null            // Harga beli terendah hari ini (WIB)
let dailyStatDate = null          // Tanggal WIB (YYYY-MM-DD) saat high/low dicatat
let cachedPromoSuggestions = [] // Cache active promotion suggestions
let promoTriggerTimeout = null // Timeout 5 detik setelah harga berubah
let promoCheckInterval = null // Interval cek promo setiap 1 detik
let isPromoIntervalRunning = false
let isPromoChecking = false // Guard untuk mencegah concurrent fetch
let promoCheckCount = 0 // Counter untuk logging
let offBroadcastCount = 0 // Counter OFF broadcast SSE (max 5)
let offWaCount = 0 // Counter OFF broadcast WA (max 5, terpisah dari SSE)
let offStartTime = null // Timestamp kapan status pertama kali OFF
let lastPromoBroadcastMinute = -1 // Track menit terakhir broadcast
let lastPromoWaMinute = -1 // Track menit terakhir WA ON/OFF dikirim

// CEKON subscribers (command cekon - logic tscek-main)
const promoSubscriptions = new Set()
let cekonLastOnBroadcastTime = 0
let cekonLastOffBroadcastTime = 0
let cekonOffStartTime = 0
let cekonNtfyOnLastTime = 0
let ntfyReminderIntervalMs = 600000 // default 10 menit, bisa diubah admin
const CEKON_ON_INTERVAL = 60000    // Broadcast ON tiap 1 menit
const CEKON_OFF_DURATION = 300000  // OFF broadcast max 5 menit
const CEKON_NTFY_ON_INTERVAL = 600000 // Ntfy ON default tiap 10 menit

// CACHE GLOBAL untuk market data (pre-fetched)
let cachedMarketData = {
  usdIdr: null, // Will be populated from realtime API
  xauUsd: null,
  economicEvents: null,
  lastUpdate: 0,
  lastUsdIdrFetch: 0 // Track kapan terakhir fetch USD/IDR
}

// ==================== REDIS STORAGE ====================

// Admin phones for notifications (dapat diubah via menu admin)
let ADMIN_PHONES = ['62895701692525'] // Fixed admin phones

// App version for force reload - update this to force all clients to reload
const APP_VERSION = '2024120104'

// Pending registrations now stored in Redis (REDIS_KEYS.PENDING_REGISTRATIONS)

const REDIS_KEYS = {
  DAILY_STATS: 'gold:daily_stats',
  PRICE_HISTORY: 'gold:price_history',
  USERS: 'gold:users',           // Hash: phone -> user data (name, expired, createdAt, pin, pinChanged)
  PUSH_SUBS: 'gold:push_subs',   // Hash: phone -> push subscription JSON
  SESSIONS: 'gold:sessions',     // Hash: sessionId -> phone
  WA_GROUP_ID: 'gold:wa_group_id', // String: ID grup WA yang di-monitor
  WA_BROADCAST_GROUP_ID: 'gold:wa_broadcast_group_id', // String: ID grup WA untuk broadcast harga otomatis
  WA_AUTH: 'gold:wa_auth',       // Hash: key -> auth data (creds, keys) for persistent WA session
  OTP_CODES: 'gold:otp_codes',   // Hash: phone -> OTP code for registration verification
  LOGIN_TOKENS: 'gold:login_tokens', // Hash: token -> { phone, expires }
  LOGIN_ATTEMPTS: 'gold:login_attempts', // Hash: phone -> { attempts, lastAttempt }
  BLOCKED_USERS: 'gold:blocked_users', // Hash: phone -> { blockedAt, reason }
  PENDING_REGISTRATIONS: 'gold:pending_reg_v2', // Hash: phone -> { name, phone, timestamp }
  USER_PINS: 'gold:user_pins',    // Hash: phone -> { pin (hashed), pinChanged (boolean) }
  SOUND_SETTINGS: 'gold:sound_settings', // JSON: custom sound settings (soundUp, soundDown URLs)
  NOMINAL_SETTINGS: 'gold:nominal_settings', // JSON: nominal investment settings
  NOTIF_HISTORY: 'gold:notif_history', // JSON array: broadcast notification history
  PROMO_LIMIT: 'gold:promo_limit',     // Number: monthly promo buy limit (set by admin)
  LOWEST_ON_PRICE: 'gold:lowest_on_price', // Number: lowest buy price recorded at OFF→ON transitions
  LOWEST_ON_DATE: 'gold:lowest_on_date',  // String: WIB date (YYYY-MM-DD) when lowest ON price was recorded
  NTFY_SETTINGS: 'gold:ntfy_settings',    // JSON: ntfy.sh notification settings
  MARKUP_SETTINGS: 'gold:markup_settings', // JSON: { minMargin, maxMargin } markup normal range
  THEME_SETTINGS: 'gold:theme_settings',   // String: nama tema aktif (navy/purple/green/red/teal/slate)
  FRESH_TOKEN: 'gold:fresh_token',         // String: token "fresh" — bila berubah, semua client tampilkan tur + reset sound/getar
  KICKED_SESSIONS: 'gold:kicked_sessions', // Hash: sessionId -> timestamp (session ditendang karena login di perangkat lain)
  SESSION_META: 'gold:session_meta',       // Hash: sessionId -> JSON {ip, ua, time}
  API_TOKENS: 'gold:api_tokens'            // Hash: apiKey -> JSON { name, enabled, createdAt } untuk API eksternal
}

// Default token fresh bila Redis belum punya nilai. Naikkan angka di sini saat deploy
// kalau ingin memaksa semua user dapat tur + reset sound/getar sekali lagi.
const DEFAULT_FRESH_TOKEN = 'v3'

// Admin password untuk akses admin panel
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '@Ahaqos20'

// Super Admin credentials untuk akses /qr dan /admin
const SUPER_ADMIN = {
  username: 'admin',
  password: process.env.SUPER_ADMIN_PASSWORD || '@Ahaqos20'
}

// Nomor HP admin yang selalu bisa login meski dihapus dari daftar user
const ADMIN_PHONE = process.env.ADMIN_PHONE || '62895701692525'

// ID Grup WhatsApp yang membernya otomatis terdaftar (di-set via admin panel)
let monitoredGroupId = null

// ID Grup WhatsApp untuk broadcast harga otomatis (di-set via admin panel)
let broadcastGroupId = null

// Cache promo limit dari Redis
let promoLimitCache = null

// Cache nominal settings dari Redis (untuk WA message)
let nominalSettingsCache = null

// Cache markup settings dari Redis
let markupSettingsCache = { minMargin: 0.7, maxMargin: 2.0 }
// Cache fresh token di memory — endpoint /api/fresh-token dipanggil setiap page load,
// jangan sampai membebani/menunggu Redis (yang kadang timeout).
let freshTokenCache = DEFAULT_FRESH_TOKEN
async function loadFreshToken() {
  try {
    const t = await redis.get(REDIS_KEYS.FRESH_TOKEN)
    if (t) freshTokenCache = t
  } catch (e) {}
}
loadFreshToken()
setInterval(loadFreshToken, 5 * 60 * 1000)

// ==================== API EKSTERNAL (token-based) ====================
// Cache API key di memory — validasi tidak menyentuh Redis di jalur panas.
let apiTokensCache = {}
async function loadApiTokens() {
  try {
    const val = await redis.hgetall(REDIS_KEYS.API_TOKENS)
    const parsed = {}
    for (const [k, v] of Object.entries(val || {})) {
      try { parsed[k] = typeof v === 'string' ? JSON.parse(v) : v } catch (e) {}
    }
    apiTokensCache = parsed
  } catch (e) {}
}
loadApiTokens()
setInterval(loadApiTokens, 5 * 60 * 1000)

// Tanpa rate limit — API key valid boleh memanggil sebebasnya
function requireApiToken(req, res, next) {
  // CORS agar bisa dipanggil dari browser/domain lain
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Headers', 'X-API-Key, Content-Type')
  const key = req.headers['x-api-key'] || req.query.api_key || ''
  const meta = key && apiTokensCache[key]
  if (!meta) {
    return res.status(401).json({ success: false, error: 'API key tidak valid. Sertakan header X-API-Key atau query ?api_key=' })
  }
  if (meta.enabled === false) {
    return res.status(403).json({ success: false, error: 'API key dinonaktifkan oleh admin' })
  }
  meta.lastUsed = Date.now()
  meta.hits = (meta.hits || 0) + 1
  next()
}

let themeCache = { bg1: '#000000', bg2: '#000000', bg3: '#000000', card: '#0a0a0a', header: '#000000' }

async function loadThemeSettings() {
  try {
    const val = await redis.get(REDIS_KEYS.THEME_SETTINGS)
    if (val) {
      const parsed = typeof val === 'string' ? JSON.parse(val) : val
      // Migrasi: tema navy lama (default sebelumnya, terlihat biru) → hitam pekat
      if (parsed.bg1 && parsed.bg1.toLowerCase() === '#06101e') return
      if (parsed.bg1) {
        themeCache = parsed
        if (!themeCache.header) themeCache.header = themeCache.bg1 // backwards compat
      }
    }
  } catch (e) {}
}
loadThemeSettings()

async function loadMarkupSettings() {
  try {
    const val = await redis.get(REDIS_KEYS.MARKUP_SETTINGS)
    if (val) {
      const parsed = typeof val === 'string' ? JSON.parse(val) : val
      if (parsed.minMargin != null) markupSettingsCache.minMargin = parseFloat(parsed.minMargin)
      if (parsed.maxMargin != null) markupSettingsCache.maxMargin = parseFloat(parsed.maxMargin)
    }
  } catch (e) {}
}
loadMarkupSettings()

// ==================== REDIS AUTH STATE (Persistent WA Session) ====================
async function useRedisAuthState() {
  const writeData = async (key, data) => {
    try {
      const serialized = JSON.stringify(data, BufferJSON.replacer)
      await redis.hset(REDIS_KEYS.WA_AUTH, { [key]: serialized })
    } catch (e) {
    }
  }

  const readData = async (key) => {
    try {
      const data = await redis.hget(REDIS_KEYS.WA_AUTH, key)
      if (!data) return null
      // Upstash auto-parse JSON saat hget, sehingga data bisa jadi object bukan string.
      // Re-serialize dulu agar BufferJSON.reviver bisa mengonversi {type:"Buffer"} ke Buffer asli.
      const str = typeof data === 'string' ? data : JSON.stringify(data)
      return JSON.parse(str, BufferJSON.reviver)
    } catch (e) {
      return null
    }
  }

  const removeData = async (key) => {
    try {
      await redis.hdel(REDIS_KEYS.WA_AUTH, key)
    } catch (e) {
    }
  }

  // Load or initialize creds
  let creds = await readData('creds')
  if (!creds) {
    creds = initAuthCreds()
    await writeData('creds', creds)
    pushLog('WA | New credentials initialized')
  } else {
    pushLog('WA | Loaded existing credentials from Redis')
  }

  return {
    state: {
      creds,
      keys: {
        get: async (type, ids) => {
          const data = {}
          for (const id of ids) {
            const value = await readData(`${type}-${id}`)
            if (value) {
              if (type === 'app-state-sync-key' && value.keyData) {
                data[id] = proto.Message.AppStateSyncKeyData.fromObject(value)
              } else {
                data[id] = value
              }
            }
          }
          return data
        },
        set: async (data) => {
          for (const [category, entries] of Object.entries(data)) {
            for (const [id, value] of Object.entries(entries || {})) {
              const key = `${category}-${id}`
              if (value) {
                await writeData(key, value)
              } else {
                await removeData(key)
              }
            }
          }
        }
      }
    },
    saveCreds: async () => {
      await writeData('creds', creds)
      pushLog('WA | Credentials saved to Redis')
    }
  }
}

// Clear WA auth from Redis
async function clearRedisAuth() {
  try {
    await redis.del(REDIS_KEYS.WA_AUTH)
    pushLog('WA | Redis auth cleared')
  } catch (e) {
    pushLog('WA | Failed to clear Redis auth: ' + e.message)
  }
}

// Load grup ID dari Redis saat startup
async function loadMonitoredGroup() {
  try {
    const groupId = await redis.get(REDIS_KEYS.WA_GROUP_ID)
    if (groupId) {
      monitoredGroupId = groupId
      pushLog('WA | Monitored group: ' + groupId.substring(0, 20) + '...')
    }
  } catch (e) {
    pushLog('WA | Failed to load monitored group: ' + e.message)
  }
}

// Load broadcast group ID dari Redis saat startup
async function loadBroadcastGroup() {
  try {
    const groupId = await redis.get(REDIS_KEYS.WA_BROADCAST_GROUP_ID)
    if (groupId) {
      broadcastGroupId = groupId
      pushLog('WA | Broadcast group: ' + groupId.substring(0, 20) + '...')
    }
  } catch (e) {
    pushLog('WA | Failed to load broadcast group: ' + e.message)
  }
}

// Load promo limit dari Redis
async function loadPromoLimit() {
  try {
    const val = await redis.get(REDIS_KEYS.PROMO_LIMIT)
    promoLimitCache = val !== null ? parseInt(val, 10) : null
  } catch (e) {
    // silent
  }
}

// Load nominal settings dari Redis
async function loadNominalSettings() {
  try {
    const settings = await redis.get(REDIS_KEYS.NOMINAL_SETTINGS)
    if (settings) {
      let config = typeof settings === 'string' ? JSON.parse(settings) : settings
      if (Array.isArray(config)) config = { nominals: config }
      nominalSettingsCache = config.nominals.filter(n => n.active && n.amount >= 1000000)
    }
  } catch (e) {
    // silent
  }
}

// Helper: Extract phone from JID (62xxx@s.whatsapp.net -> xxx)
function extractPhoneFromJid(jid) {
  if (!jid) return null
  const match = jid.match(/^(\d+)@/)
  if (!match) return null
  let phone = match[1]
  if (phone.startsWith('62')) phone = phone.substring(2)
  return phone
}

// Auto-register member grup ke database
async function autoRegisterGroupMember(phone, name = null) {
  if (!phone) return

  try {
    const existing = await redis.hget(REDIS_KEYS.USERS, phone)
    if (existing) return // Sudah terdaftar

    const userData = {
      name: name || 'Member ' + phone,
      createdAt: Date.now(),
      expired: null, // Default lifetime, admin bisa atur nanti
      source: 'whatsapp_group'
    }

    await redis.hset(REDIS_KEYS.USERS, { [phone]: JSON.stringify(userData) })
    pushLog('WA | Auto-registered: +62' + phone)
  } catch (e) {
    pushLog('WA | Auto-register failed: ' + e.message)
  }
}

// Remove member dari database saat keluar/kick dari grup
async function removeGroupMember(phone) {
  if (!phone) return

  try {
    const existing = await redis.hget(REDIS_KEYS.USERS, phone)
    if (!existing) return

    // Hapus user apapun source-nya (baik dari whatsapp_group, manual, OTP, dll)
    await Promise.all([
      redis.hdel(REDIS_KEYS.USERS, phone),
      redis.hdel(REDIS_KEYS.PUSH_SUBS, phone)
    ])

    // Hapus semua session user ini
    const sessions = await redis.hgetall(REDIS_KEYS.SESSIONS)
    for (const [sessId, sessPhone] of Object.entries(sessions || {})) {
      if (sessPhone === phone) {
        await redis.hdel(REDIS_KEYS.SESSIONS, sessId)
      }
    }

    pushLog('WA | Auto-removed member (kicked/left): +62' + phone)
  } catch (e) {
    pushLog('WA | Remove member failed: ' + e.message)
  }
}

// Cache lokal untuk mengurangi Redis calls
let dailyStatsCache = null
let priceHistoryCache = []
let lastCacheUpdate = 0
const CACHE_TTL = 5000 // 5 detik

// Load data dari Redis saat startup
async function loadFromRedis() {
  try {
    const [stats, history, lastTime] = await Promise.all([
      redis.get(REDIS_KEYS.DAILY_STATS),
      redis.lrange(REDIS_KEYS.PRICE_HISTORY, 0, -1),
      redis.get('gold:last_history_time')
    ])

    if (stats) {
      dailyStatsCache = stats
      pushLog('REDIS | Daily stats loaded')
    }

    if (history && history.length > 0) {
      priceHistoryCache = history.map(e => typeof e === 'string' ? JSON.parse(e) : e)
      // Populate addedTimestamps untuk deduplication — tapi JANGAN set lastAddedUpdatedAt
      // agar entry baru tetap bisa masuk meski Treasury belum update updated_at-nya
      priceHistoryCache.forEach(e => { if (e.time) addedTimestamps.add(e.time) })
      pushLog(`REDIS | ${priceHistoryCache.length} price history loaded`)

      // Inisialisasi dailyHighBuy/dailyLowBuy dari history hari ini
      const todayWIB = new Date(Date.now() + 7 * 60 * 60 * 1000).toISOString().slice(0, 10)
      const todayEntries = priceHistoryCache.filter(e => e.time && e.time.startsWith(todayWIB) && e.buy)
      if (todayEntries.length > 0) {
        dailyHighBuy = Math.max(...todayEntries.map(e => e.buy))
        dailyLowBuy = Math.min(...todayEntries.map(e => e.buy))
        dailyStatDate = todayWIB
        pushLog(`REDIS | Daily high/low init: ${dailyHighBuy} / ${dailyLowBuy}`)
      }
    }
  } catch (e) {
    pushLog('REDIS | Load error: ' + e.message)
  }
}

// Update daily stats - DISABLED (not needed)
function updateDailyStats(buyPrice) {
  // Daily stats disabled - tidak digunakan
}

// Get daily stats
async function getDailyStats() {
  try {
    // Gunakan cache jika masih fresh
    if (dailyStatsCache && Date.now() - lastCacheUpdate < CACHE_TTL) {
      return formatDailyStats(dailyStatsCache)
    }

    const stats = await redis.get(REDIS_KEYS.DAILY_STATS)
    if (stats) {
      dailyStatsCache = stats
      lastCacheUpdate = Date.now()
      return formatDailyStats(stats)
    }
  } catch (e) {}

  return { open: null, high: null, low: null, avg: null, change: null, changePct: null }
}

function formatDailyStats(stats) {
  if (!stats || !stats.date || !stats.prices || stats.prices.length === 0) {
    return { open: null, high: null, low: null, avg: null, change: null, changePct: null }
  }

  const avg = Math.round(stats.prices.reduce((a, b) => a + b, 0) / stats.prices.length)
  const current = stats.prices[stats.prices.length - 1]
  const change = current - stats.open
  const changePct = ((change / stats.open) * 100).toFixed(2)

  return {
    date: stats.date,
    open: stats.open,
    high: stats.high,
    low: stats.low,
    avg: avg,
    current: current,
    change: change,
    changePct: changePct
  }
}

// Add price history ke LOCAL memory only (no Redis)
let lastAddedUpdatedAt = '' // Track updatedAt terakhir yang sudah ditambahkan
const addedTimestamps = new Set() // Track semua timestamp yang sudah ditambahkan

function addPriceHistory(buy, sell, prevBuy, prevSell, updatedAt, xauUsd) {
  // Dedup: skip jika harga beli+jual sama dengan entry terakhir di cache
  const last = priceHistoryCache[priceHistoryCache.length - 1]
  if (last && last.buy === buy && last.sell === sell) return

  // Gunakan updated_at Treasury agar timestamp history website sesuai dengan pesan WA.
  // updated_at dari Treasury sudah berisi jam WIB dalam format UTC (jam-nya = jam WIB),
  // sehingga toISOString() langsung memberi jam yang benar tanpa perlu tambah offset.
  // Fallback ke waktu server (UTC + 7h) jika updated_at tidak tersedia.
  const wibOffset = 7 * 60 * 60 * 1000
  let timeStr
  if (updatedAt) {
    timeStr = new Date(updatedAt).toISOString().replace('T', ' ').substring(0, 19)
  } else {
    timeStr = new Date(Date.now() + wibOffset).toISOString().replace('T', ' ').substring(0, 19)
  }

  // Calculate spread percentage
  const spread = ((sell - buy) / buy * 100).toFixed(2)

  const usdIdr = cachedMarketData.usdIdr?.rate || 0

  // Hitung markup dari XAU
  let markup = 0
  let markupStatus = 'UNKNOWN'
  if (xauUsd && usdIdr) {
    const priceStatus = analyzePriceStatus(buy, sell, xauUsd, usdIdr)
    markup = Math.round(priceStatus.difference)
    markupStatus = priceStatus.status
  }

  const entry = {
    time: timeStr,
    buy: buy,
    sell: sell,
    buyChange: buy - prevBuy,
    sellChange: sell - prevSell,
    spread: spread,
    usdIdr: usdIdr,
    xauUsd: xauUsd || null,
    markup: markup,
    markupStatus: markupStatus
  }

  // Simpan ke local cache dan Redis
  priceHistoryCache.push(entry)
  lastAddedUpdatedAt = updatedAt
  redis.rpush(REDIS_KEYS.PRICE_HISTORY, JSON.stringify(entry)).catch(e => {
    pushLog(`REDIS | ❌ Gagal simpan history: ${e.message}`)
  })

  // Limit max 1440 entries (24 jam)
  if (priceHistoryCache.length > 1440) {
    priceHistoryCache.shift()
    redis.ltrim(REDIS_KEYS.PRICE_HISTORY, -1440, -1).catch(e => {
      pushLog(`REDIS | ❌ Gagal trim history: ${e.message}`)
    })
  }
}

// Get price history dengan pagination (local memory)
function getPriceHistory(page = 1, perPage = 10) {
  const total = priceHistoryCache.length
  const totalPages = Math.ceil(total / perPage)

  const end = total - ((page - 1) * perPage)
  const start = Math.max(0, end - perPage)
  const items = priceHistoryCache.slice(start, end).reverse()

  return {
    items: items,
    page: page,
    perPage: perPage,
    total: total,
    totalPages: totalPages
  }
}

// Reset data harian setiap jam 23:59 WIB
async function resetDailyData() {
  try {
    await Promise.all([
      redis.del(REDIS_KEYS.DAILY_STATS),
      redis.del(REDIS_KEYS.PRICE_HISTORY),
      redis.del('gold:last_history_time')
    ])
    dailyStatsCache = null
    priceHistoryCache = []
    lastAddedUpdatedAt = '' // Reset supaya data baru bisa masuk
    lastKnownPrice = null // Reset supaya harga pertama hari baru dianggap initial
    lastKnownTimestamp = 0 // Reset timestamp tracker
    pushLog('SYSTEM | Daily reset completed')
  } catch (e) {
    pushLog('REDIS | Reset error: ' + e.message)
  }
}

// Cek setiap menit untuk reset jam 23:59
setInterval(() => {
  const now = new Date()
  // Konversi ke WIB (UTC+7)
  const wibHour = (now.getUTCHours() + 7) % 24
  const wibMinute = now.getUTCMinutes()

  // Reset pada 23:59 WIB
  if (wibHour === 23 && wibMinute === 59) {
    resetDailyData()
  }
}, 60000)

// Lock untuk mencegah double fetch USD/IDR
let isUsdIdrFetching = false

// USD/IDR polling setiap 1 detik (dengan lock untuk mencegah double fetch)
setInterval(async () => {
  if (isUsdIdrFetching) return
  isUsdIdrFetching = true
  try {
    const now = Date.now()
    const usdIdr = await fetchUSDIDRFromGoogle();
    cachedMarketData.lastUsdIdrFetch = now
    if (usdIdr?.rate) {
      cachedMarketData.usdIdr = usdIdr
      const roundedRate = Math.round(usdIdr.rate)
      if (lastLoggedUsdIdr !== null && lastLoggedUsdIdr !== roundedRate) {
        const diff = roundedRate - lastLoggedUsdIdr
        pushLog(`USD/IDR | Berubah: ${formatRupiah(lastLoggedUsdIdr)}→${formatRupiah(roundedRate)} (${diff > 0 ? '+' : ''}${formatRupiah(diff)})`)
        const _wibTime = new Date(Date.now() + 7 * 60 * 60 * 1000).toISOString().replace('T', ' ').substring(0, 19)
        usdIdrHistory.push({ time: _wibTime, rate: roundedRate, change: diff })
        if (usdIdrHistory.length > MAX_USD_IDR_HISTORY) usdIdrHistory.shift()
        broadcastSSE({ type: 'usd_idr', rate: roundedRate, change: diff, time: _wibTime, xauUsd: cachedMarketData.xauUsd })
      }
      lastLoggedUsdIdr = roundedRate
    }
  } catch (e) {
    // Keep old USD/IDR if fetch fails
  } finally {
    isUsdIdrFetching = false
  }
}, 1000)

// Background task untuk pre-fetch XAU/USD and economic calendar
// XAU/USD and calendar updated every 5 seconds
setInterval(async () => {
  try {
    const now = Date.now()

    // Always fetch XAU/USD and economic calendar
    const [xauUsd, economicEvents] = await Promise.all([
      fetchXAUUSDCached(),
      fetchEconomicCalendar()
    ]);

    cachedMarketData = {
      ...cachedMarketData,
      xauUsd,
      economicEvents,
      lastUpdate: now
    }
  } catch (e) {
    pushLog(`MARKET | Background interval error — ${e.message}`)
  }
}, 5000)

const adminSseClients = new Set()

function pushLog(s) {
  const now = new Date()
  const time = now.toTimeString().substring(0, 8)
  const logMsg = `[${time}] ${s}`
  logs.push(logMsg)
  if (logs.length > 200) logs.shift()
  console.log(logMsg)
  // Push realtime ke admin panel via SSE
  const logSse = `data: ${JSON.stringify({ type: 'log', entry: logMsg })}\n\n`
  adminSseClients.forEach(client => {
    try { client.write(logSse) } catch (e) { adminSseClients.delete(client) }
  })
}

setInterval(() => {
  if (processedMsgIds.size > 300) {
    const arr = Array.from(processedMsgIds).slice(-200)
    processedMsgIds.clear()
    arr.forEach(id => processedMsgIds.add(id))
  }
}, 5 * 60 * 1000)

// ------ UTIL ------
function normalizeText(msg) {
  if (!msg) return ''
  return msg.replace(/\s+/g, ' ').trim().toLowerCase()
}

function shouldIgnoreMessage(m) {
  if (!m || !m.key) return true
  if (m.key.remoteJid === 'status@broadcast') return true
  if (m.key.fromMe) return true
  
  const hasText =
    m.message?.conversation ||
    m.message?.extendedTextMessage?.text ||
    m.message?.imageMessage?.caption ||
    m.message?.videoMessage?.caption
  if (!hasText) return true
  
  return false
}

function extractText(m) {
  return (
    m.message?.conversation ||
    m.message?.extendedTextMessage?.text ||
    m.message?.imageMessage?.caption ||
    m.message?.videoMessage?.caption ||
    ''
  )
}

function formatRupiah(n) {
  return typeof n === 'number'
    ? n.toLocaleString('id-ID')
    : (Number(n || 0) || 0).toLocaleString('id-ID')
}

function parseBrowser(ua) {
  if (!ua || ua === '-') return '-'
  if (/WhatsApp\//.test(ua)) return 'WhatsApp'
  if (/Instagram/.test(ua)) return 'Instagram'
  const mobile = /Mobile|Android|iPhone|iPad/.test(ua)
  const suffix = mobile ? ' 📱' : ' 🖥'
  if (/Edg\//.test(ua)) return 'Edge' + suffix
  if (/OPR\/|Opera\//.test(ua)) return 'Opera' + suffix
  if (/Firefox\//.test(ua)) return 'Firefox' + suffix
  if (/Chrome\//.test(ua)) return 'Chrome' + suffix
  if (/Safari\//.test(ua)) return 'Safari' + suffix
  return 'Browser' + suffix
}

function getClientIp(req) {
  const forwarded = req.headers['x-forwarded-for']
  if (forwarded) return forwarded.split(',')[0].trim()
  return req.socket?.remoteAddress || req.ip || '-'
}

async function getIpLocation(ip) {
  if (!ip || ip === '-' || ip === '::1' || ip === '127.0.0.1') return 'Lokal'
  if (/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(ip)) return 'Lokal'
  try {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), 3000)
    const res = await fetch(`http://ip-api.com/json/${ip}?fields=city,regionName,country,status`, { signal: ctrl.signal })
    clearTimeout(timer)
    const d = await res.json()
    if (d.status !== 'success') return '-'
    return [d.city, d.regionName, d.country].filter(Boolean).join(', ') || '-'
  } catch {
    return '-'
  }
}

function calculateDiscount(investmentAmount) {
  let discount

  if (investmentAmount <= 10000) {
    // 49.99% untuk nominal kecil
    discount = investmentAmount * 0.4999
  } else if (investmentAmount <= 10000000) {
    // 3.31% untuk s/d 10jt
    discount = investmentAmount * 0.0331
  } else {
    // 3.35% untuk > 10jt
    discount = investmentAmount * 0.0335
  }

  return Math.round(discount)
}

function calculateProfit(buyRate, sellRate, investmentAmount) {
  const discountAmount = calculateDiscount(investmentAmount)
  const discountedPrice = investmentAmount - discountAmount
  const totalGrams = investmentAmount / buyRate
  const sellValue = totalGrams * sellRate
  const totalProfit = sellValue - discountedPrice
  
  return {
    discountedPrice,
    totalGrams,
    profit: totalProfit
  }
}

// ------ ECONOMIC CALENDAR FUNCTIONS ------
async function fetchEconomicCalendar() {
  if (!ECONOMIC_CALENDAR_ENABLED) return null
  
  const now = Date.now()
  
  if (cachedEconomicEvents && (now - lastEconomicFetch) < ECONOMIC_CACHE_DURATION) {
    return cachedEconomicEvents
  }
  
  try {
    const res = await fetch('https://nfs.faireconomy.media/ff_calendar_thisweek.json', {
      signal: AbortSignal.timeout(5000)
    })
    
    if (!res.ok) {
      // Silent fail
      return null
    }
    
    const events = await res.json()
    
    // Waktu Jakarta (WIB = UTC+7)
    const jakartaNow = new Date(Date.now() + (7 * 60 * 60 * 1000))
    const todayJakarta = new Date(jakartaNow.getFullYear(), jakartaNow.getMonth(), jakartaNow.getDate())
    const tomorrowJakarta = new Date(todayJakarta.getTime() + (24 * 60 * 60 * 1000))
    const dayAfterTomorrowJakarta = new Date(todayJakarta.getTime() + (2 * 24 * 60 * 60 * 1000))
    
    const filteredEvents = events.filter(event => {
      if (!event.date) return false
      
      // Parse event date dan convert ke WIB
      const eventDate = new Date(event.date)
      const eventWIB = new Date(eventDate.getTime() + (7 * 60 * 60 * 1000))
      const eventDateOnly = new Date(eventWIB.getFullYear(), eventWIB.getMonth(), eventWIB.getDate())
      
      // ⏰ LOGIC: Tampilkan news 3 jam setelah rilis
      const threeHoursAfterEvent = new Date(eventDate.getTime() + (3 * 60 * 60 * 1000))
      
      // Jika news sudah lewat 3 jam, skip
      if (Date.now() > threeHoursAfterEvent.getTime()) {
        return false
      }
      
      // Filter: hanya hari ini dan besok (2 hari)
      if (eventDateOnly < todayJakarta || eventDateOnly >= dayAfterTomorrowJakarta) {
        return false
      }
      
      // Filter: hanya USD
      if (!CALENDAR_COUNTRY_FILTER.includes(event.country)) return false
      
      // Filter: hanya High Impact
      if (event.impact !== 'High') return false
      
      return true
    })
    
    // Sort by time
    filteredEvents.sort((a, b) => {
      const timeA = new Date(a.date).getTime()
      const timeB = new Date(b.date).getTime()
      return timeA - timeB
    })
    
    // Limit to 10 events
    const limitedEvents = filteredEvents.slice(0, 10)
    
    // Log struktur event pertama untuk debug
    if (limitedEvents.length > 0) {
      pushLog(`📰 Calendar event sample: ${JSON.stringify(limitedEvents[0])}`)
    }

    cachedEconomicEvents = limitedEvents
    lastEconomicFetch = now
    
    return limitedEvents
    
  } catch (e) {
    // Silent fail
    return null
  }
}

// Fungsi untuk menentukan apakah news bagus/jelek untuk gold
function analyzeGoldImpact(event) {
  const title = (event.title || '').toLowerCase()
  const actual = event.actual || ''
  const forecast = event.forecast || ''
  
  if (!actual || actual === '-' || !forecast || forecast === '-') {
    return null
  }
  
  const actualNum = parseFloat(actual.replace(/[^0-9.-]/g, ''))
  const forecastNum = parseFloat(forecast.replace(/[^0-9.-]/g, ''))
  
  if (isNaN(actualNum) || isNaN(forecastNum)) {
    return null
  }
  
  // Logic: news yang memperkuat USD = jelek untuk gold
  // news yang melemahkan USD = bagus untuk gold
  
  // Interest Rate: Naik = USD kuat = jelek untuk gold
  if (title.includes('interest rate') || title.includes('fed') || title.includes('fomc')) {
    return actualNum > forecastNum ? 'JELEK' : 'BAGUS'
  }
  
  // NFP / Employment: Naik = ekonomi kuat = USD kuat = jelek untuk gold
  if (title.includes('non-farm') || title.includes('nfp') || title.includes('payroll')) {
    return actualNum > forecastNum ? 'JELEK' : 'BAGUS'
  }
  
  // Unemployment: Naik = ekonomi lemah = USD lemah = bagus untuk gold
  if (title.includes('unemployment')) {
    return actualNum > forecastNum ? 'BAGUS' : 'JELEK'
  }
  
  // CPI / Inflation: Naik = inflasi tinggi = bagus untuk gold
  if (title.includes('cpi') || title.includes('inflation') || title.includes('pce')) {
    return actualNum > forecastNum ? 'BAGUS' : 'JELEK'
  }
  
  // GDP: Naik = ekonomi kuat = USD kuat = jelek untuk gold
  if (title.includes('gdp')) {
    return actualNum > forecastNum ? 'JELEK' : 'BAGUS'
  }
  
  // Jobless Claims: Naik = ekonomi lemah = bagus untuk gold
  if (title.includes('jobless') || title.includes('claims')) {
    return actualNum > forecastNum ? 'BAGUS' : 'JELEK'
  }
  
  // Retail Sales: Naik = ekonomi kuat = jelek untuk gold
  if (title.includes('retail sales')) {
    return actualNum > forecastNum ? 'JELEK' : 'BAGUS'
  }
  
  return null
}

function getGoldDirection(event) {
  const t = (event.title || '').toLowerCase()
  const f = event.forecast ? parseFloat(String(event.forecast).replace(/[^0-9.-]/g, '')) : NaN
  const p = event.previous ? parseFloat(String(event.previous).replace(/[^0-9.-]/g, '')) : NaN
  if (isNaN(f) || isNaN(p) || f === p) return null
  const bullUSD = t.includes('interest rate') || t.includes('fed') || t.includes('fomc') ||
    t.includes('non-farm') || t.includes('nfp') || t.includes('payroll') ||
    t.includes('gdp') || t.includes('retail sales') || t.includes('pmi') ||
    t.includes('ism') || t.includes('consumer confidence') || t.includes('average hourly') ||
    t.includes('core retail') || t.includes('business inventories')
  const bearUSD = t.includes('unemployment') || t.includes('jobless') || t.includes('claims') ||
    t.includes('unit labor costs')
  const inflation = t.includes('cpi') || t.includes('inflation') || t.includes('pce') ||
    t.includes('import prices')
  if (bearUSD || inflation) return f > p ? '🚀' : '🔻'
  if (bullUSD) return f > p ? '🔻' : '🚀'
  return null
}

function formatEconomicCalendar(events) {
  if (!events || events.length === 0) {
    return ''
  }

  let calendarText = '\n'

  // Group events by day+time
  const groups = []
  const groupMap = new Map()

  events.forEach(event => {
    const eventDate = new Date(event.date)
    const wibTime = new Date(eventDate.getTime() + (7 * 60 * 60 * 1000))

    const minutes = wibTime.getMinutes()
    const roundedMinutes = Math.round(minutes / 5) * 5
    wibTime.setMinutes(roundedMinutes)
    wibTime.setSeconds(0)

    const hours = wibTime.getHours().toString().padStart(2, '0')
    const mins = wibTime.getMinutes().toString().padStart(2, '0')
    const timeStr = `${hours}:${mins}`

    const days = ['Minggu', 'Senin', 'Selasa', 'Rabu', 'Kamis', 'Jumat', 'Sabtu']
    const dayName = days[wibTime.getDay()]

    const title = event.title || event.event || 'Unknown Event'
    const forecast = event.forecast || '-'
    const actual = event.actual || '-'

    const nowTime = Date.now()
    const eventTime = eventDate.getTime()
    const timeSinceEvent = nowTime - eventTime
    const minutesSinceEvent = Math.floor(timeSinceEvent / (60 * 1000))

    let timeStatus = ''
    if (timeSinceEvent < 0) {
      const minutesUntil = Math.abs(minutesSinceEvent)
      if (minutesUntil < 60) {
        timeStatus = `⏰${minutesUntil}m`
      } else {
        const hoursUntil = Math.floor(minutesUntil / 60)
        const minsUntil = minutesUntil % 60
        if (minsUntil > 0) {
          timeStatus = `⏰${hoursUntil}j ${minsUntil}m`
        } else {
          timeStatus = `⏰${hoursUntil}j`
        }
      }
    } else if (timeSinceEvent > 0 && timeSinceEvent <= 3 * 60 * 60 * 1000) {
      const hoursAgo = Math.floor(minutesSinceEvent / 60)
      const minsAgo = minutesSinceEvent % 60
      if (hoursAgo > 0) {
        timeStatus = `✅${hoursAgo}j ${minsAgo}m lalu`
      } else {
        timeStatus = `✅${minsAgo}m lalu`
      }
    }

    // Shortened title
    let shortTitle = title
    if (title.includes('Non-Farm')) shortTitle = 'NFP'
    else if (title.includes('Unemployment')) shortTitle = 'Unemp'
    else if (title.includes('Interest Rate')) shortTitle = 'Interest'
    else if (title.includes('CPI')) shortTitle = 'CPI'
    else if (title.includes('GDP')) shortTitle = 'GDP'
    else if (title.includes('Retail')) shortTitle = 'Retail'
    else if (title.includes('Jobless')) shortTitle = 'Jobless'

    // Build event text
    const isPast = timeSinceEvent > 0  // waktu event sudah lewat
    const direction = getGoldDirection(event)
    let eventText = shortTitle
    if (isPast) {
      // Event sudah lewat — hilangkan prediksi arah, tampilkan actual jika ada
      if (actual !== '-' && actual !== '') {
        const goldImpact = analyzeGoldImpact(event)
        eventText += ` ${actual}>${forecast}`
        if (goldImpact === 'BAGUS') {
          eventText += ` 🟢 BAGUS`
        } else if (goldImpact === 'JELEK') {
          eventText += ` 🔴 JELEK`
        }
      } else if (forecast !== '-') {
        eventText += ` F:${forecast}`
      }
    } else {
      // Event belum terjadi — tampilkan forecast + arah emas
      if (forecast !== '-') {
        eventText += ` F:${forecast}`
      }
      if (direction) eventText += ` ${direction}`
    }

    // Group by day+time
    const key = `${dayName}|${timeStr}`
    if (!groupMap.has(key)) {
      const group = { dayName, timeStr, timeStatus, items: [] }
      groupMap.set(key, group)
      groups.push(group)
    }
    groupMap.get(key).items.push(eventText)
  })

  groups.forEach(group => {
    calendarText += `📅 ${group.dayName} ${group.timeStr}`
    if (group.timeStatus) {
      calendarText += ` (${group.timeStatus})`
    }
    calendarText += `(${group.items.length})\n• ${group.items.join(', ')}\n`
  })

  return calendarText
}

// ------ FOREX FUNCTIONS ------
async function fetchUSDIDRFromBankIndonesia() {
  try {
    // Try to fetch from Bank Indonesia JISDOR
    const res = await fetch('https://api.exchangerate-api.com/v4/latest/USD', {
      signal: AbortSignal.timeout(2000)
    })
    if (res.ok) {
      const json = await res.json()
      const rate = json.rates?.IDR
      if (rate && rate > 10000 && rate < 20000) {
        return { rate }
      }
    }
  } catch (_) {}
  return null
}

async function fetchUSDIDRFallback() {
  try {
    // Try multiple sources for better accuracy
    const sources = [
      // Primary: ExchangeRate-API
      async () => {
        const res = await fetch('https://api.exchangerate-api.com/v4/latest/USD', {
          signal: AbortSignal.timeout(2000)
        })
        if (res.ok) {
          const json = await res.json()
          return json.rates?.IDR
        }
      },
      // Secondary: Fixer.io (free tier)
      async () => {
        const res = await fetch('https://api.fixer.io/latest?base=USD&symbols=IDR', {
          signal: AbortSignal.timeout(2000)
        })
        if (res.ok) {
          const json = await res.json()
          return json.rates?.IDR
        }
      }
    ]

    for (const source of sources) {
      try {
        const rate = await source()
        if (rate && rate > 10000 && rate < 20000) {
          return { rate }
        }
      } catch (_) {}
    }
  } catch (_) {}

  return null
}

async function fetchUSDIDRFromGoogle() {
  const maxRetries = 3
  let attempt = 0

  while (attempt < maxRetries) {
    attempt++

    try {
      const res = await fetch('https://www.google.com/finance/quote/USD-IDR', {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.9,id;q=0.8',
          'Accept-Encoding': 'gzip, deflate, br',
          'Cache-Control': 'no-cache',
          'Pragma': 'no-cache',
          'Sec-Ch-Ua': '"Chromium";v="122", "Not(A:Brand";v="24", "Google Chrome";v="122"',
          'Sec-Ch-Ua-Mobile': '?0',
          'Sec-Ch-Ua-Platform': '"Windows"',
          'Sec-Fetch-Dest': 'document',
          'Sec-Fetch-Mode': 'navigate',
          'Sec-Fetch-Site': 'none',
          'Sec-Fetch-User': '?1',
          'Upgrade-Insecure-Requests': '1'
        },
        signal: AbortSignal.timeout(10000) // Increased timeout to 10 seconds
      })

      if (!res.ok) {
        if (attempt < maxRetries) {
          await new Promise(r => setTimeout(r, 2000))
          continue
        }
      }

      const html = await res.text()

      // More comprehensive patterns for Google Finance
      const patterns = [
        // Primary patterns - most likely to work
        /class="YMlKec fxKbKc"[^>]*>([0-9,\.]+)<\/div>/i,
        /class="[^"]*fxKbKc[^"]*"[^>]*>([0-9,\.]+)<\/div>/i,
        /data-last-price="([0-9,\.]+)"/i,
        /data-price="([0-9,\.]+)"/i,

        // JSON-LD patterns
        /"price":\s*"([0-9,\.]+)"/i,
        /"value":\s*"([0-9,\.]+)"/i,

        // Alternative div patterns
        /<div[^>]*>([0-9]{1,2}[,\.][0-9]{3}(?:\.[0-9]+)?)<\/div>/i,

        // Specific Google Finance patterns
        /USD to IDR[^0-9]*([0-9]{1,2}[,\.][0-9]{3}(?:\.[0-9]+)?)/i,
        /1 USD = ([0-9]{1,2}[,\.][0-9]{3}(?:\.[0-9]+)?)/i,

        // Meta tag patterns
        /<meta[^>]*content="([0-9]{1,2}[,\.][0-9]{3}(?:\.[0-9]+)?)"[^>]*>/i,

        // Broader patterns
        />([0-9]{2}[,\.][0-9]{3}(?:\.[0-9]+)?)</,
        /USD\/IDR[^0-9]*([0-9]{1,2}[,\.][0-9]{3}(?:[,\.][0-9]+)?)/i
      ]

      // Silent parsing - no log needed

      for (const pattern of patterns) {
        const match = html.match(pattern)
        if (match?.[1]) {
          const rate = parseFloat(match[1].replace(/,/g, ''))

          // Validate rate is in reasonable range for IDR
          if (rate > 10000 && rate < 20000) {
            return { rate }
          }
        }
      }

      // Silent retry
      if (attempt < maxRetries) {
        await new Promise(r => setTimeout(r, 3000))
      }

    } catch (err) {
      if (attempt < maxRetries) {
        await new Promise(r => setTimeout(r, 3000))
      }
    }
  }

  // Google failed — try exchange rate API fallback
  return await fetchUSDIDRFallback()
}

async function fetchXAUUSDFromInvesting() {
  try {
    pushLog('XAU | Investing.com: mencoba fetch...')
    const res = await fetch('https://www.investing.com/currencies/xau-usd', {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept-Encoding': 'gzip, deflate, br',
        'Connection': 'keep-alive',
        'Upgrade-Insecure-Requests': '1',
        'Sec-Fetch-Dest': 'document',
        'Sec-Fetch-Mode': 'navigate',
        'Sec-Fetch-Site': 'none',
        'Cache-Control': 'max-age=0'
      },
      signal: AbortSignal.timeout(6000)
    })

    if (!res.ok) {
      pushLog(`XAU | Investing.com: HTTP ${res.status} ${res.statusText} — gagal`)
      return null
    }
    
    const html = await res.text()
    const foundPrices = []
    
    let match = html.match(/data-test="instrument-price-last"[^>]*>([0-9,]+\.?[0-9]*)</i)
    if (match?.[1]) {
      const price = parseFloat(match[1].replace(/,/g, ''))
      if (price > 1000 && price < 10000) {
        foundPrices.push({ method: 'data-test', price, priority: 1 })
      }
    }

    match = html.match(/class="instrument-price-last[^"]*"[^>]*>([0-9,]+\.?[0-9]*)</i)
    if (match?.[1]) {
      const price = parseFloat(match[1].replace(/,/g, ''))
      if (price > 1000 && price < 10000) {
        foundPrices.push({ method: 'class-instrument', price, priority: 2 })
      }
    }

    const pricePatterns = [
      /instrument[^>]{0,50}([0-9]{1},?[0-9]{3}\.[0-9]{2})/i,
      /quote[^>]{0,50}([0-9]{1},?[0-9]{3}\.[0-9]{2})/i,
      /current[^>]{0,50}([0-9]{1},?[0-9]{3}\.[0-9]{2})/i
    ]

    for (const pattern of pricePatterns) {
      match = html.match(pattern)
      if (match?.[1]) {
        const price = parseFloat(match[1].replace(/,/g, ''))
        if (price > 1000 && price < 10000) {
          foundPrices.push({ method: 'generic-pattern', price, priority: 9 })
        }
      }
    }

    if (foundPrices.length === 0) {
      pushLog('XAU | Investing.com: HTML OK tapi tidak ada harga yang berhasil di-parse')
      return null
    }

    if (foundPrices.length === 1) {
      pushLog(`XAU | Investing.com: berhasil (${foundPrices[0].method}) → $${foundPrices[0].price.toFixed(2)}`)
      return foundPrices[0].price
    }

    const priceGroups = new Map()

    for (const { method, price, priority } of foundPrices) {
      let foundGroup = false

      for (const [groupPrice, items] of priceGroups) {
        if (Math.abs(groupPrice - price) <= 1.0) {
          items.push({ method, price, priority })
          foundGroup = true
          break
        }
      }

      if (!foundGroup) {
        priceGroups.set(price, [{ method, price, priority }])
      }
    }

    let bestGroup = null
    let maxCount = 0
    let bestPriority = 999

    for (const [groupPrice, items] of priceGroups) {
      const avgPriority = items.reduce((sum, item) => sum + item.priority, 0) / items.length

      if (items.length > maxCount) {
        maxCount = items.length
        bestGroup = items
        bestPriority = avgPriority
      } else if (items.length === maxCount && avgPriority < bestPriority) {
        bestGroup = items
        bestPriority = avgPriority
      }
    }

    if (bestGroup) {
      const avgPrice = bestGroup.reduce((sum, item) => sum + item.price, 0) / bestGroup.length
      pushLog(`XAU | Investing.com: berhasil (consensus ${bestGroup.length} match) → $${avgPrice.toFixed(2)}`)
      return avgPrice
    }

    foundPrices.sort((a, b) => a.priority - b.priority)
    const fallbackPrice = foundPrices[0].price
    pushLog(`XAU | Investing.com: berhasil (fallback ${foundPrices[0].method}) → $${fallbackPrice.toFixed(2)}`)
    return fallbackPrice

  } catch (e) {
    pushLog(`XAU | Investing.com: error — ${e.message}`)
    return null
  }
}

async function fetchXAUUSDFromSwissquote() {
  try {
    const res = await fetch('https://forex-data-feed.swissquote.com/public-quotes/bboquotes/instrument/XAU/USD', {
      headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' },
      signal: AbortSignal.timeout(5000)
    })
    if (!res.ok) {
      pushLog(`XAU | Swissquote: HTTP ${res.status} — gagal`)
      return null
    }
    const json = await res.json()
    const quotes = Array.isArray(json) ? json[0]?.spreadProfilePrices : null
    if (quotes?.length) {
      const ask = quotes[0]?.ask
      const bid = quotes[0]?.bid
      if (ask && bid) {
        const price = (ask + bid) / 2
        if (price > 1000 && price < 10000) {
          pushLog(`XAU | Swissquote: berhasil → $${price.toFixed(2)}`)
          return price
        }
      }
    }
    pushLog('XAU | Swissquote: format tidak sesuai')
  } catch (e) {
    pushLog(`XAU | Swissquote: error — ${e.message}`)
  }
  return null
}

async function fetchXAUUSD() {
  const sources = [
    fetchXAUUSDFromSwissquote(),
    fetchXAUUSDFromInvesting(),
  ]

  try {
    const result = await Promise.any(
      sources.map(p => p.then(v => v ? v : Promise.reject('no result')))
    )
    return result
  } catch {
    pushLog('XAU | ❌ SEMUA SUMBER GAGAL — harga XAU/USD tidak tersedia')
    return null
  }
}

let lastXAUFailedFetch = 0
const XAU_FAIL_RETRY_INTERVAL = 30000 // tunggu 30 detik sebelum retry setelah semua sumber gagal

async function fetchXAUUSDCached() {
  const now = Date.now()

  if (cachedXAUUSD && (now - lastXAUUSDFetch) < XAU_CACHE_DURATION) {
    return cachedXAUUSD
  }

  // Jika belum punya data dan baru saja gagal, jangan retry terlalu cepat
  if (!cachedXAUUSD && lastXAUFailedFetch && (now - lastXAUFailedFetch) < XAU_FAIL_RETRY_INTERVAL) {
    return null
  }

  const price = await fetchXAUUSD()
  if (price) {
    cachedXAUUSD = price
    lastXAUUSDFetch = now
    lastXAUFailedFetch = 0
    xauHistory.push({ time: now, price })
    if (xauHistory.length > MAX_XAU_HISTORY) xauHistory.shift()
  } else {
    lastXAUFailedFetch = now
  }

  return cachedXAUUSD
}

function analyzePriceStatus(treasuryBuy, treasurySell, xauUsdPrice, usdIdrRate) {
  if (!xauUsdPrice || !usdIdrRate) {
    return {
      status: 'DATA_INCOMPLETE',
      message: '⚠️ Data Incomplete',
      emoji: '⚠️'
    }
  }

  // Range NORMAL: dari markupSettingsCache (default 0.7% - 2%)
  const TROY_OZ_TO_GRAM_EXACT = 31.1035
  const MIN_MARGIN = 1 + (markupSettingsCache.minMargin / 100)
  const MAX_MARGIN = 1 + (markupSettingsCache.maxMargin / 100)

  // Hitung harga dasar internasional
  const basePrice = (xauUsdPrice * usdIdrRate) / TROY_OZ_TO_GRAM_EXACT

  // Hitung batas bawah dan atas untuk range NORMAL
  const lowerBound = basePrice * MIN_MARGIN
  const upperBound = basePrice * MAX_MARGIN

  // Hitung selisih dari range NORMAL
  let difference = 0
  let status = 'NORMAL'
  let emoji = '✅'
  let message = '✅ NORMAL'

  if (treasurySell < lowerBound) {
    // Di bawah range NORMAL (margin < 0.7%)
    difference = treasurySell - lowerBound  // akan negatif
    status = 'ABNORMAL'
    emoji = '⚠️'
    message = `⚠️ TIDAK NORMAL (${difference > 0 ? '+' : ''}${formatRupiah(Math.round(difference))})`
  } else if (treasurySell > upperBound) {
    // Di atas range NORMAL (margin > 2%)
    difference = treasurySell - upperBound  // akan positif
    status = 'ABNORMAL'
    emoji = '⚠️'
    message = `⚠️ TIDAK NORMAL (+${formatRupiah(Math.round(difference))})`
  }

  // Calculate actual margin percentage
  const actualMargin = ((treasurySell - basePrice) / basePrice) * 100

  // Log only once per minute or when status changes (removed repetitive logging)

  return {
    status,
    emoji,
    message,
    basePrice,
    lowerBound,
    upperBound,
    treasuryPrice: treasurySell,
    difference,
    actualMargin
  }
}

function formatMessage(treasuryData, usdIdrRate, xauUsdPrice = null, priceChange = null, economicEvents = null, lowestOnPrice = null, promoLimit = null, usdIdrChange = null, dailyHigh = null, dailyLow = null) {
  const buy = treasuryData?.data?.buying_rate || 0
  const sell = treasuryData?.data?.selling_rate || 0

  const spread = sell - buy
  const spreadPercent = ((spread / buy) * 100).toFixed(2)

  const buyFormatted = `Rp${formatRupiah(buy)}/gr`
  const sellFormatted = `Rp${formatRupiah(sell)}/gr`

  const updatedAt = treasuryData?.data?.updated_at
  let timeSection = ''
  if (updatedAt) {
    const date = new Date(updatedAt)
    const days = ['Minggu', 'Senin', 'Selasa', 'Rabu', 'Kamis', 'Jumat', 'Sabtu']
    const months = ['Jan','Feb','Mar','Apr','Mei','Jun','Jul','Agu','Sep','Okt','Nov','Des']
    const dayName = days[date.getDay()]
    const dateNum = date.getDate()
    const monthName = months[date.getMonth()]
    const year = date.getFullYear()
    const hours = date.getHours().toString().padStart(2, '0')
    const minutes = date.getMinutes().toString().padStart(2, '0')
    const seconds = date.getSeconds().toString().padStart(2, '0')
    timeSection = `${dayName}, ${dateNum} ${monthName} ${year} ${hours}:${minutes}:${seconds} WIB`
  }

  let headerSection = ''
  if (priceChange && priceChange.buyChange !== 0) {
    const changeAmount = Math.abs(priceChange.buyChange)
    const changeFormatted = formatRupiah(changeAmount)
    if (priceChange.buyChange > 0) {
      headerSection = `🚀 🚀 NAIK 🚀 🚀 (+Rp${changeFormatted})\n`
    } else {
      headerSection = `🔻 🔻 TURUN 🔻 🔻 (-Rp${changeFormatted})\n`
    }
  }

  let usdChangeStr = ''
  if (usdIdrChange !== null) {
    const usdChangeRounded = Math.round(usdIdrChange)
    if (usdChangeRounded > 0) usdChangeStr = ` (🚀${formatRupiah(usdChangeRounded)})`
    else if (usdChangeRounded < 0) usdChangeStr = ` (🔻${formatRupiah(Math.abs(usdChangeRounded))})`
  }

  let marketSection = usdIdrRate
    ? `💱 USD Rp${formatRupiah(Math.round(usdIdrRate))}${usdChangeStr}`
    : `💱 USD -`

  if (xauUsdPrice) {
    marketSection += ` | XAU $${xauUsdPrice.toFixed(2)}`
    if (usdIdrRate) {
      const priceStatus = analyzePriceStatus(buy, sell, xauUsdPrice, usdIdrRate)
      if (priceStatus.status === 'NORMAL') {
        marketSection += ` (✅ Normal)`
      } else {
        const diff = Math.round(priceStatus.difference)
        const mkLabel = diff > 0 ? 'MARKUP' : 'MARKDOWN'
        marketSection += ` (⚠️ ${mkLabel} ${diff > 0 ? '+' : ''}${formatRupiah(diff)})`
      }
    }
  }

  const calendarSection = formatEconomicCalendar(economicEvents)

  // Titik ON + Limit section
  let promoInfoSection = ''
  if (lowestOnPrice) {
    promoInfoSection = `\n🏷️ Titik ON ▼ Rp${formatRupiah(lowestOnPrice)}`
    if (promoLimit !== null && promoLimit !== undefined) {
      promoInfoSection += ` | Limit ${promoLimit} beli/bln`
    }
  } else if (promoLimit !== null && promoLimit !== undefined) {
    promoInfoSection = `\n🏷️ Limit ${promoLimit} beli/bln`
  }

  // Gunakan nominal dari settings jika ada, fallback ke default
  const formatGrams = (g) => g.toFixed(4)
  const activeNominals = (nominalSettingsCache && nominalSettingsCache.length > 0)
    ? nominalSettingsCache
    : [
        { label: '20jt', amount: 20000000 },
        { label: '30jt', amount: 30000000 },
        { label: '40jt', amount: 40000000 },
        { label: '50jt', amount: 50000000 }
      ]

  const nominalLines = activeNominals.map(n => {
    // Gunakan discountRate dari admin settings, fallback ke calculateDiscount jika tidak ada
    let profit, totalGrams
    if (n.discountRate) {
      const discountAmount = Math.round(n.amount * n.discountRate)
      const discountedPrice = n.amount - discountAmount
      totalGrams = n.amount / buy
      const sellValue = totalGrams * sell
      profit = sellValue - discountedPrice
    } else {
      const result = calculateProfit(buy, sell, n.amount)
      totalGrams = result.totalGrams
      profit = result.profit
    }
    const profitRounded = Math.round(profit)
    const icon = profitRounded >= 0 ? '📈' : '📉'
    const sign = profitRounded >= 0 ? '+' : '-'
    const warning = profitRounded < 0 ? ' ⚠️' : ''
    return `• ${n.label}→${formatGrams(totalGrams)}gr (${icon} ${sign}Rp${formatRupiah(Math.abs(profitRounded))})${warning}`
  }).join('\n')

  const highLowLine = (dailyHigh !== null && dailyLow !== null)
    ? `\n_~📊 Tertinggi Rp${formatRupiah(dailyHigh)} | Terendah Rp${formatRupiah(dailyLow)}~_`
    : ''

  return `${headerSection}${timeSection}

*💰 Beli ${buyFormatted} | Jual ${sellFormatted} (${Math.abs(parseFloat(spreadPercent)) > 3.35 ? '⚠️' : ''}${spreadPercent > 0 ? '-' : ''}${spreadPercent}%)*
${marketSection}${promoInfoSection}

${nominalLines}
${calendarSection}${highLowLine}
🌐 Via website: https://ts.muhamadaliyudin.my.id`
}
async function fetchTreasury() {
  const res = await fetch(TREASURY_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Connection': 'keep-alive'
    },
    agent: httpsAgent, // Reuse TCP connection
    signal: AbortSignal.timeout(5000) // 5 detik timeout (lebih toleran untuk network latency)
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const json = await res.json()
  if (!json?.data?.buying_rate || !json?.data?.selling_rate) {
    throw new Error('Invalid data')
  }
  return json
}

// 🎁 PROMO ON/OFF FUNCTIONS
let _lastTokenRefreshLog = 0 // throttle log token refresh — spam tiap 3 detik kalau tidak dibatasi

async function refreshTreasuryToken() {
  const _now = Date.now()
  const _verbose = _now - _lastTokenRefreshLog > 300000 // log setiap 5 menit, kecuali error
  try {
    if (_verbose) pushLog('TREASURY | Memperbarui token...')
    const res = await fetch(TREASURY_LOGIN_URL, {
      method: 'POST',
      headers: {
        'accept': 'application/json',
        'content-type': 'application/json',
        'x-app-version': '8.0.90',
        'x-language': 'id',
        'x-platform': 'android',
        'x-version': '1.0'
      },
      body: JSON.stringify(TREASURY_CREDENTIALS),
      signal: AbortSignal.timeout(10000)
    })

    if (!res.ok) {
      const errText = await res.text()
      pushLog(`TREASURY | ❌ Login gagal HTTP ${res.status}: ${errText.substring(0, 200)}`)
      throw new Error(`HTTP ${res.status}`)
    }
    const json = await res.json()

    if (json.meta?.status !== 'success') {
      pushLog(`TREASURY | ❌ API error: status=${json.meta?.status} msg=${json.meta?.message || '-'}`)
      throw new Error('API error')
    }

    const token = typeof json.data?.token === 'string'
      ? json.data.token
      : json.data?.token?.access_token
    if (!token) {
      pushLog(`TREASURY | ❌ Token tidak ada dalam response: ${JSON.stringify(json.data).substring(0, 200)}`)
      throw new Error('No token in response')
    }

    treasuryToken = token
    if (_verbose) {
      pushLog('TREASURY | ✅ Token berhasil diperbarui')
      _lastTokenRefreshLog = _now
    }
    return token
  } catch (e) {
    pushLog(`TREASURY | ❌ Gagal refresh token: ${e.message}`)
    throw e
  }
}

async function fetchNominalPromo(retryCount = 0) {
  try {
    if (!treasuryToken) {
      await refreshTreasuryToken()
    }

    const headers = {
      'accept': 'application/json',
      'authorization': `Bearer ${treasuryToken}`,
      'content-type': 'application/json',
      'x-app-version': '8.0.90',
      'x-language': 'id',
      'x-platform': 'android',
      'x-version': '1.0'
    }

    // Real app sends POST /nominal/suggestion with body {"type": 1}
    const res = await fetch(TREASURY_NOMINAL_URL, {
      method: 'POST',
      headers,
      body: JSON.stringify({ type: 1 }),
      signal: AbortSignal.timeout(15000)
    })

    if (!res.ok) {
      if (res.status === 401 && retryCount === 0) {
        await refreshTreasuryToken()
        return fetchNominalPromo(1)
      }
      throw new Error(`HTTP ${res.status}`)
    }

    const json = await res.json()
    if (json.meta.status !== 'success') throw new Error('API error')
    return json
  } catch (e) {
    throw new Error(`Nominal fetch failed: ${e.message}`)
  }
}

async function doPromoBroadcast() {
  if (isPromoChecking) return
  isPromoChecking = true

  const now = Date.now()
  const currentMinute = Math.floor(now / 60000)
  promoCheckCount++

  try {
    // Cek ganti hari WIB — reset titik ON terendah (terlepas dari status ON/OFF)
    if (lowestOnPriceCache !== null && lowestOnDateWIB) {
      const todayWIB = new Date(Date.now() + 7 * 60 * 60 * 1000).toISOString().slice(0, 10)
      if (lowestOnDateWIB !== todayWIB) {
        await redis.del(REDIS_KEYS.LOWEST_ON_PRICE)
        await redis.del(REDIS_KEYS.LOWEST_ON_DATE)
        lowestOnPriceCache = null
        lowestOnDateWIB = null
        broadcastSSE({ type: 'lowest_on_price', price: null })
        pushLog(`🏷️ Titik ON terendah direset (ganti hari)`)
      }
    }

    // Fetch nominal promo data dari Treasury API
    const nominalData = await fetchNominalPromo().catch(() => null)

    if (!nominalData) {
      pushLog(`⚠️ Promo check #${promoCheckCount}: Gagal fetch data`)
      return
    }

    // Ambil nominal promoRef dari admin settings
    let promoRefAmount = 20000000 // fallback default 20jt
    try {
      const nomSettings = await redis.get(REDIS_KEYS.NOMINAL_SETTINGS)
      if (nomSettings) {
        let nomConfig = typeof nomSettings === 'string' ? JSON.parse(nomSettings) : nomSettings
        if (Array.isArray(nomConfig)) nomConfig = { nominals: nomConfig }
        const promoRefNom = (nomConfig.nominals || []).find(n => n.promoRef === true && n.active !== false)
        if (promoRefNom) promoRefAmount = promoRefNom.amount
      }
    } catch (_) {}

    // Cek apakah nominal promoRef aktif di Treasury API
    const hasPromo = nominalData.data.some(n =>
      n.status === true && n.default_amount === promoRefAmount
    )
    const currentStatus = hasPromo ? 'ON' : 'OFF'

    // Detect status change
    const isFirstCheck = lastPromoStatus === null
    const statusChanged = lastPromoStatus !== null && lastPromoStatus !== currentStatus
    const isOffToOn = statusChanged && currentStatus === 'ON'

    if (statusChanged) {
      pushLog(`🎁 Status berubah: ${lastPromoStatus} → ${currentStatus}`)
    }

    // Track lowest ON price — hanya saat Treasury API konfirmasi status ON
    // Update dengan delay 40 detik untuk menghindari fluktuasi sesaat
    if (lowestOnPriceCache === undefined) {
      const storedVal = await redis.get(REDIS_KEYS.LOWEST_ON_PRICE)
      lowestOnPriceCache = storedVal !== null ? parseInt(storedVal, 10) : null
      const storedDate = await redis.get(REDIS_KEYS.LOWEST_ON_DATE)
      lowestOnDateWIB = storedDate || null
    }

    if (currentStatus === 'ON' && lastKnownPrice?.buy) {
      const currentBuy = lastKnownPrice.buy
      if (lowestOnPriceCache === null || currentBuy < lowestOnPriceCache) {
        // Harga lebih rendah — tunggu 40 detik sebelum commit
        // Hanya reset timer jika harga lebih rendah dari pending sebelumnya (atau belum ada pending)
        if (!lowestOnPendingTimeout || currentBuy < (lowestOnPendingPrice ?? Infinity)) {
          if (lowestOnPendingTimeout) clearTimeout(lowestOnPendingTimeout)
          lowestOnPendingPrice = currentBuy
          lowestOnPendingTimeout = setTimeout(async () => {
          // Setelah 40 detik: cek masih ON, lalu commit harga terendah
          if (lastPromoStatus !== 'ON') return
          if (lowestOnPriceCache !== null && lowestOnPendingPrice >= lowestOnPriceCache) return
          lowestOnPriceCache = lowestOnPendingPrice
          const todayWIB = new Date(Date.now() + 7 * 60 * 60 * 1000).toISOString().slice(0, 10)
          lowestOnDateWIB = todayWIB
          await redis.set(REDIS_KEYS.LOWEST_ON_PRICE, String(lowestOnPendingPrice))
          await redis.set(REDIS_KEYS.LOWEST_ON_DATE, todayWIB)
          broadcastSSE({ type: 'lowest_on_price', price: lowestOnPendingPrice })
          pushLog(`🏷️ Titik ON terendah: ${formatRupiah(lowestOnPendingPrice)} (konfirmasi 40 detik)`)
          lowestOnPendingPrice = null
          lowestOnPendingTimeout = null
          }, 40000)
        }
      }
    } else if (currentStatus !== 'ON') {
      // Status OFF — batalkan pending update terendah
      if (lowestOnPendingTimeout) {
        clearTimeout(lowestOnPendingTimeout)
        lowestOnPendingTimeout = null
        lowestOnPendingPrice = null
      }
      // Reset titik ON terendah jika OFF sudah 1+ menit dan harga di atas terendah
      // Tapi tunggu 20 detik dulu sebelum reset — antisipasi OFF sesaat lalu ON lagi
      if (offBroadcastCount >= 1 && lowestOnPriceCache !== null && lastKnownPrice?.buy && lastKnownPrice.buy > lowestOnPriceCache) {
        if (!lowestOnResetTimeout) {
          lowestOnResetTimeout = setTimeout(async () => {
            lowestOnResetTimeout = null
            // Cek ulang: masih OFF dan harga masih di atas titik ON?
            if (lastPromoStatus === 'ON') return
            if (!lowestOnPriceCache || !lastKnownPrice?.buy || lastKnownPrice.buy <= lowestOnPriceCache) return
            lowestOnPriceCache = null
            await redis.del(REDIS_KEYS.LOWEST_ON_PRICE)
            broadcastSSE({ type: 'lowest_on_price', price: null })
            pushLog(`🏷️ Titik ON terendah direset (OFF 1m+ dan harga lebih tinggi, konfirmasi 20 detik)`)
          }, 20000)
        }
      } else {
        // Kondisi reset tidak terpenuhi — batalkan timer reset jika ada
        if (lowestOnResetTimeout) {
          clearTimeout(lowestOnResetTimeout)
          lowestOnResetTimeout = null
        }
      }
    }

    let shouldBroadcast = false

    if (currentStatus === 'ON') {
      // ON: Batalkan timer reset titik ON jika sempat terpicu saat OFF sesaat
      if (lowestOnResetTimeout) {
        clearTimeout(lowestOnResetTimeout)
        lowestOnResetTimeout = null
        pushLog(`🏷️ Timer reset titik ON dibatalkan — status kembali ON`)
      }
      // ON: Reset counter OFF dan kirim sound
      if (offBroadcastCount > 0 || lastPromoStatus === 'OFF') {
        pushLog(`🎁 Status ON kembali! Reset OFF counter (was ${offBroadcastCount})`)
        offBroadcastCount = 0
        offWaCount = 0
        offStartTime = null
        sendBotMessage('Promo Treasury aktif. Cek tab Promo untuk melihat detail penawaran yang tersedia.')
      }
      // ON: Kirim 1x per menit
      if (currentMinute !== lastPromoBroadcastMinute || isFirstCheck || statusChanged) {
        shouldBroadcast = true
        lastPromoBroadcastMinute = currentMinute
      }
    } else {
      // OFF: Max 5x broadcast, tapi tetap cek terus
      // isFirstCheck diabaikan untuk OFF — hanya broadcast jika dari ON (statusChanged)
      if (currentMinute !== lastPromoBroadcastMinute || statusChanged) {
        if (offBroadcastCount < 5 && (statusChanged || offBroadcastCount > 0)) {
          // Masih boleh broadcast OFF (hanya jika dari ON atau sudah dalam siklus OFF)
          shouldBroadcast = true
          lastPromoBroadcastMinute = currentMinute
          if (!offStartTime) offStartTime = Date.now()
          offBroadcastCount++
          pushLog(`🎁 OFF count: ${offBroadcastCount}/5`)
        } else {
          // Sudah 5x, tidak broadcast tapi tetap update lastPromoBroadcastMinute
          lastPromoBroadcastMinute = currentMinute
          // Log sesekali saja (setiap 5 menit)
          if (currentMinute % 5 === 0) {
            pushLog(`🎁 OFF sudah 5x, menunggu ON... (tetap cek)`)
          }
        }
      }
    }

    lastPromoStatus = currentStatus

    // 📲 WA ON/OFF broadcast — dijalankan SEBELUM shouldBroadcast gate
    // agar seconds >= 50 bisa tercapai (shouldBroadcast hanya true di detik :00-:03)
    // - OFF→ON: langsung kirim (detik berapa saja) + tag semua member grup (1x)
    // - ON biasa: kirim ✅ ON di detik 50+ tiap menit, tanpa tag & tanpa link
    // - OFF biasa: kirim ❌ OFF di detik 50+ (1x per menit), max 5x
    if (sock && isReady && (broadcastGroupId || subscriptions.size > 0)) {
      const seconds = new Date(now).getSeconds()
      const isNewWaMinute = currentMinute !== lastPromoWaMinute
      const offWaAllowed = currentStatus === 'OFF' && offWaCount < 5
      const onWaAllowed = currentStatus === 'ON' && !isOffToOn

      const shouldWaOnOff = isOffToOn ||
        (isNewWaMinute && seconds >= 50 && (onWaAllowed || offWaAllowed))

      if (shouldWaOnOff) {
        lastPromoWaMinute = currentMinute
        if (currentStatus === 'OFF') offWaCount++
        const waMsg = isOffToOn
          ? `✅ ON\n\n🌐 Via website: https://ts.muhamadaliyudin.my.id`
          : currentStatus === 'ON' ? '✅ ON' : '❌ OFF'
        const chatIds = [broadcastGroupId, ...Array.from(subscriptions)].filter(Boolean)

        for (const chatId of chatIds) {
          if (isOffToOn && chatId.endsWith('@g.us')) {
            let mentions = []
            try {
              const gm = await sock.groupMetadata(chatId)
              mentions = gm.participants.map(p => p.id)
            } catch (e) { pushLog(`⚠️ Gagal ambil member: ${e.message}`) }
            sock.sendMessage(chatId, { text: waMsg, mentions }).catch(() => {})
          } else {
            sock.sendMessage(chatId, { text: waMsg }).catch(() => {})
          }
        }
        pushLog(`🎁 WA ON/OFF: ${waMsg}${isOffToOn ? ' (OFF→ON + tag)' : ''}`)
      }
    }

    if (!shouldBroadcast) return

    // Broadcast via SSE ke semua clients
    const message = currentStatus === 'ON' ? '✅ ON' : '❌ OFF'
    pushLog(`🎁 Broadcasting: ${currentStatus} (OFF count: ${offBroadcastCount}/5)`)

    broadcastSSE({
      type: 'promo_status',
      status: currentStatus,
      message: message,
      time: new Date().toISOString()
    })

    // 📱 PUSH NOTIFICATION untuk promo - HANYA saat status BERUBAH
    if (statusChanged) {
      const promoTitle = currentStatus === 'ON' ? '🎁 PROMO ON' : '❌ PROMO OFF'
      pushLog(`🎁 Status changed! Sending push: ${promoTitle}`)
      sendPushToAll(promoTitle, '', 'promo').catch(() => {})
    }

    // 📲 CEKON broadcast (promoSubscriptions) - logic tscek-main
    // OFF→ON: 10x alert + tag → lalu ✅ ON + tag
    // ON normal tiap 1 menit: ✅ ON + tag semua
    // OFF tiap 1 menit max 5 menit: ❌ OFF tanpa tag
    if (sock && isReady && promoSubscriptions.size > 0) {
      // Auto-init OFF cycle jika subscriber baru join saat status sudah OFF
      // (hanya jika bukan isFirstCheck — agar tidak spam OFF saat restart)
      if (currentStatus === 'OFF' && cekonOffStartTime === 0 && !isFirstCheck) {
        cekonOffStartTime = now
        cekonLastOffBroadcastTime = 0
      }

      const statusChangedToOff = statusChanged && currentStatus === 'OFF'

      let cekonShouldBroadcast = false
      let cekonReason = ''

      if (isOffToOn) {
        cekonShouldBroadcast = true
        cekonReason = 'OFF→ON'
        cekonOffStartTime = 0
      } else if (statusChangedToOff) {
        cekonShouldBroadcast = true
        cekonReason = 'ON→OFF'
        cekonLastOffBroadcastTime = now
        cekonOffStartTime = now
      } else if (isFirstCheck && currentStatus === 'ON') {
        // isFirstCheck OFF diabaikan — tidak spam OFF saat restart
        cekonShouldBroadcast = true
        cekonReason = 'ON (initial)'
        cekonLastOnBroadcastTime = now
      } else if (currentStatus === 'ON') {
        if (now - cekonLastOnBroadcastTime >= CEKON_ON_INTERVAL) {
          cekonShouldBroadcast = true
          cekonReason = 'ON (1 menit)'
        }
      } else if (currentStatus === 'OFF' && cekonOffStartTime > 0) {
        const timeSinceOff = now - cekonOffStartTime
        if (timeSinceOff <= CEKON_OFF_DURATION && now - cekonLastOffBroadcastTime >= CEKON_ON_INTERVAL) {
          cekonShouldBroadcast = true
          cekonReason = `OFF (menit ${Math.ceil(timeSinceOff / 60000)}/5)`
          cekonLastOffBroadcastTime = now
        }
      }

      if (cekonShouldBroadcast) {
        pushLog(`🔔 CEKON: ${cekonReason} → ${promoSubscriptions.size} subscriber`)

        if (isOffToOn) {
          // OFF→ON: 10x alert + tag, lalu ✅ ON + tag
          for (const chatId of promoSubscriptions) {
            try {
              const isGroupChat = chatId.endsWith('@g.us')
              let mentions = []
              if (isGroupChat) {
                try {
                  const gm = await sock.groupMetadata(chatId)
                  mentions = gm.participants.map(p => p.id)
                  pushLog(`👥 Got ${mentions.length} participants from ${chatId.substring(0, 15)}`)
                } catch (metaErr) {
                  pushLog(`⚠️ Gagal ambil member: ${metaErr.message}`)
                }

                // Trigger call script
                pushLog(`📞 Triggering call script for ${chatId.substring(0, 15)}...`)
                execAsync(`node call-group.js ${chatId}`, { timeout: 60000 })
                  .then(({ stdout }) => {
                    if (stdout) pushLog(`[Call Script]: ${stdout.substring(0, 200)}`)
                    pushLog(`✅ Call script completed for ${chatId.substring(0, 15)}`)
                  })
                  .catch(err => {
                    pushLog(`⚠️ Call script failed: ${err.message}`)
                    if (err.message.includes('Could not find Chrome')) {
                      pushLog(`💡 Chromium not installed - call feature disabled`)
                    }
                  })

                for (let i = 0; i < 10; i++) {
                  try {
                    await sock.sendMessage(chatId, { text: '🚨🚨🚨 PROMO ON! 🚨🚨🚨', mentions })
                    await new Promise(r => setTimeout(r, 500))
                  } catch (alertErr) {
                    pushLog(`⚠️ Alert ${i+1} failed: ${alertErr.message}`)
                  }
                }
                pushLog(`📢 Sent 10 alert messages with @mentions to ${chatId.substring(0, 15)}`)
                await new Promise(r => setTimeout(r, 1000))
              }
              await sock.sendMessage(chatId, { text: '✅ ON', mentions })
              pushLog(`🔔 Sent OFF→ON status to ${chatId.substring(0, 15)}`)
            } catch (e) {
              pushLog(`❌ CEKON OFF→ON error: ${e.message}`)
            }
          }
          cekonLastOnBroadcastTime = now
          cekonNtfyOnLastTime = now // reset timer, ntfy 10 menit dimulai setelah trigger OFF→ON
        } else {
          // ON normal atau OFF: kirim 1 pesan, tag hanya saat ON
          for (const chatId of promoSubscriptions) {
            try {
              const isGroupChat = chatId.endsWith('@g.us')
              let mentions = []
              if (isGroupChat && currentStatus === 'ON') {
                try {
                  const gm = await sock.groupMetadata(chatId)
                  mentions = gm.participants.map(p => p.id)
                } catch (_) {}
              }
              await sock.sendMessage(chatId, {
                text: currentStatus === 'ON' ? '✅ ON' : '❌ OFF',
                mentions
              })
              pushLog(`🔔 CEKON sent: ${currentStatus === 'ON' ? '✅ ON' : '❌ OFF'} → ${chatId.substring(0, 15)}`)
            } catch (e) {
              pushLog(`❌ CEKON send error: ${e.message}`)
            }
          }
          if (currentStatus === 'ON') {
            cekonLastOnBroadcastTime = now
          }
        }
      }
    }

    // 📱 NTFY standalone - tidak bergantung pada promoSubscriptions (tetap jalan walau subs=0)
    if (isOffToOn) {
      ;(async () => {
        try {
          const ntfyRaw = await redis.get(REDIS_KEYS.NTFY_SETTINGS)
          const ntfyCfg = ntfyRaw ? (typeof ntfyRaw === 'string' ? JSON.parse(ntfyRaw) : ntfyRaw) : {}
          const ntfyEnabled = ntfyCfg.enabled !== false
          const ntfyCount = Math.max(1, Math.min(600, parseInt(ntfyCfg.count) || 60))
          const ntfyReminderMin = Math.max(1, Math.min(60, parseInt(ntfyCfg.reminderMinutes) || 10))
          if (!ntfyEnabled) {
            pushLog('🔔 NTFY: dinonaktifkan oleh admin')
            return
          }
          pushLog(`🔔 NTFY: mulai kirim ON ON ON ${ntfyCount}x (reminder tiap ${ntfyReminderMin} menit)`)
          cekonNtfyOnLastTime = now
          ntfyReminderIntervalMs = ntfyReminderMin * 60000
          let ntfyOk = 0, ntfyFail = 0
          for (let i = 0; i < ntfyCount; i++) {
            try {
              await fetch('https://ntfy.sh/cekonts', {
                method: 'POST',
                headers: { 'Title': 'PROMO ON!', 'Priority': 'urgent', 'Tags': 'rotating_light' },
                body: 'ON ON ON'
              })
              ntfyOk++
            } catch (e) {
              ntfyFail++
            }
            await new Promise(r => setTimeout(r, 1000))
          }
          pushLog(`🔔 NTFY: selesai ${ntfyOk} ok / ${ntfyFail} fail`)
        } catch (e) {
          pushLog(`⚠️ NTFY OFF→ON error: ${e.message}`)
        }
      })()
    }
    // NTFY reminder saat ON - tetap jalan walau promoSubscriptions kosong
    if (currentStatus === 'ON') {
      const reminderMs = ntfyReminderIntervalMs || CEKON_NTFY_ON_INTERVAL
      if (now - cekonNtfyOnLastTime >= reminderMs) {
        redis.get(REDIS_KEYS.NTFY_SETTINGS).then(raw => {
          const cfg = raw ? (typeof raw === 'string' ? JSON.parse(raw) : raw) : {}
          if (cfg.enabled === false) return
          cekonNtfyOnLastTime = now
          const remMin = Math.max(1, Math.min(60, parseInt(cfg.reminderMinutes) || 10))
          fetch('https://ntfy.sh/cekonts', {
            method: 'POST',
            headers: { 'Title': 'PROMO MASIH ON', 'Priority': 'urgent', 'Tags': 'rotating_light' },
            body: 'ON ON ON'
          }).catch(e => pushLog(`⚠️ NTFY reminder error: ${e.message}`))
          pushLog(`🔔 NTFY: ON reminder dikirim (tiap ${remMin} menit)`)
        }).catch(() => {})
      }
    }

  } catch (e) {
    pushLog(`❌ Promo broadcast error: ${e.message}`)
  } finally {
    isPromoChecking = false
  }
}

// 🎁 CONTINUOUS PROMO CHECK - Berjalan terus seperti price check
const PROMO_CHECK_INTERVAL = 3000 // Cek setiap 3 detik
let promoContinuousInterval = null

function startContinuousPromoCheck() {
  if (promoContinuousInterval) return // Sudah jalan

  pushLog(`🎁 Memulai continuous promo check setiap ${PROMO_CHECK_INTERVAL/1000} detik...`)

  // Cek pertama setelah 5 detik
  setTimeout(() => {
    doPromoBroadcast().catch(e => pushLog(`❌ Promo error: ${e.message}`))
  }, 5000)

  // Lanjut cek terus menerus
  promoContinuousInterval = setInterval(() => {
    doPromoBroadcast().catch(e => pushLog(`❌ Promo error: ${e.message}`))
  }, PROMO_CHECK_INTERVAL)
}

// Trigger promo check segera setelah harga berubah (debounced 1 detik)
let promoTriggerTimer = null
function triggerPromoCheck() {
  if (promoTriggerTimer) return // sudah ada yang dijadwalkan, skip
  promoTriggerTimer = setTimeout(() => {
    promoTriggerTimer = null
    if (!isPromoChecking) {
      doPromoBroadcast().catch(e => pushLog(`❌ Promo triggered: ${e.message}`))
    }
  }, 1000)
}

// 🎟️ PROMO SUGGESTIONS - Fetch & polling setiap 1 menit
async function fetchPromoSuggestions() {
  try {
    if (!treasuryToken) await refreshTreasuryToken()
    // Real app: GET /promotion/suggestion (tanpa body)
    const res = await fetch(TREASURY_PROMO_SUGGESTION_URL, {
      method: 'GET',
      headers: {
        'accept': 'application/json',
        'authorization': `Bearer ${treasuryToken}`,
        'content-type': 'application/json',
        'x-app-version': '8.0.90',
        'x-language': 'id',
        'x-platform': 'android',
        'x-version': '1.0'
      },
      signal: AbortSignal.timeout(10000)
    })
    if (!res.ok) {
      if (res.status === 401) { treasuryToken = null; return fetchPromoSuggestions() }
      throw new Error(`HTTP ${res.status}`)
    }
    const json = await res.json()
    if (json.meta?.status !== 'success') throw new Error('API error')
    // Endpoint suggestion mengembalikan list ter-paginasi: { data: { data: [ ...promo... ] } }
    const list = json.data?.data || []
    return list
      .filter(p => p.promotion_status === true)
      .map(p => ({
        code: p.promotion_code || '',
        name: p.promotion_name || 'Promo Aktif',
        short_desc: p.promotion_short_description || '',
        image_url: null,
        article_url: null,
        min_trx: p.promotion_tnc?.minimum_transaction || '-',
        end_to: p.promotion_tnc?.end_to || '-'
      }))
  } catch (e) {
    pushLog(`❌ PromoSuggestion error: ${e.message}`)
    return null
  }
}

function formatPromoWaMessage(promos) {
  const now = new Date(Date.now() + 7 * 60 * 60 * 1000)
  const days = ['Minggu','Senin','Selasa','Rabu','Kamis','Jumat','Sabtu']
  const months = ['Jan','Feb','Mar','Apr','Mei','Jun','Jul','Agu','Sep','Okt','Nov','Des']
  const dayName = days[now.getUTCDay()]
  const dateNum = now.getUTCDate()
  const monthName = months[now.getUTCMonth()]
  const year = now.getUTCFullYear()
  const hh = String(now.getUTCHours()).padStart(2, '0')
  const mm = String(now.getUTCMinutes()).padStart(2, '0')
  const ss = String(now.getUTCSeconds()).padStart(2, '0')
  const timestamp = `${dayName}, ${dateNum} ${monthName} ${year} ${hh}:${mm}:${ss} WIB`

  let msg = `*PROMO AKTIF (${timestamp})*\n\n`
  promos.forEach((p, i) => {
    msg += `${i + 1}. *${p.name}*\n`
    if (p.short_desc) msg += `   ${p.short_desc}\n`
    if (p.code) msg += `   Kode: ${p.code}\n`
    const tnc = []
    if (p.min_trx && p.min_trx !== '-') tnc.push(`Min. ${p.min_trx}`)
    if (p.end_to && p.end_to !== '-') tnc.push(`s/d ${p.end_to}`)
    if (tnc.length) msg += `   ${tnc.join(' • ')}\n`
  })
  msg += `\n🌐 Via website: https://ts.muhamadaliyudin.my.id`
  return msg
}

async function pollPromoSuggestions() {
  const active = await fetchPromoSuggestions()
  if (active === null) return // error, skip
  const sig = (list) => list.map(p => `${p.code || ''}|${p.name || ''}|${p.end_to || ''}`).sort().join(',')
  const prevIds = sig(cachedPromoSuggestions)
  const newIds = sig(active)
  if (prevIds !== newIds) {
    pushLog(`🎟️ Promo suggestions updated: ${active.length} active`)
    // Kirim pesan WA terpisah jika ada perubahan promo
    if (sock && isReady && (broadcastGroupId || subscriptions.size > 0)) {
      const promoMsg = formatPromoWaMessage(active)
      // Kirim ke broadcast group dengan tag semua member
      if (broadcastGroupId) {
        let mentions = []
        try {
          const groupMetadata = await sock.groupMetadata(broadcastGroupId)
          mentions = groupMetadata.participants.map(p => p.id)
        } catch (e) {
          pushLog(`⚠️ Gagal ambil member grup promo: ${e.message}`)
        }
        sock.sendMessage(broadcastGroupId, { text: promoMsg, mentions }).catch(() => {})
        pushLog(`🎟️ Promo WA broadcast group sent (${active.length} promo, ${mentions.length} tagged)`)
      }
      // Kirim ke semua subscriber individu
      if (subscriptions.size > 0) {
        const chatIds = Array.from(subscriptions)
        for (const chatId of chatIds) {
          sock.sendMessage(chatId, { text: promoMsg }).catch(() => {})
        }
        pushLog(`🎟️ Promo WA broadcast sent to ${subscriptions.size} subscribers`)
      }
    }
  }
  cachedPromoSuggestions = active
  // Selalu broadcast setiap menit agar timestamp di client terupdate
  broadcastSSE({ type: 'promo_suggestions', promos: active })
}

// Start polling setiap 1 menit
setTimeout(() => {
  pollPromoSuggestions()
  setInterval(pollPromoSuggestions, 60000)
}, 8000) // Tunda 8 detik setelah server start

// 📱 PUSH NOTIFICATION HELPER - Kirim notif ke semua subscriber
// Cooldown TERPISAH untuk price dan promo agar tidak saling blocking
let lastPricePushTime = 0
let lastPromoPushTime = 0
const PRICE_PUSH_COOLDOWN = 60000 // 1 menit untuk price
const PROMO_PUSH_COOLDOWN = 300000 // 5 menit untuk promo (karena hanya saat status berubah)

async function sendPushToAll(title, body, type = 'price') {
  pushLog(`📱 PUSH | Attempting: "${title}" (type: ${type})`)

  // Rate limit TERPISAH untuk price dan promo
  const now = Date.now()

  if (type === 'price') {
    const timeSinceLastPush = now - lastPricePushTime
    if (timeSinceLastPush < PRICE_PUSH_COOLDOWN) {
      const waitTime = Math.round((PRICE_PUSH_COOLDOWN - timeSinceLastPush) / 1000)
      pushLog(`📱 PUSH | Skipped price - cooldown ${waitTime}s remaining`)
      return { skipped: true, reason: 'cooldown' }
    }
    lastPricePushTime = now
  } else if (type === 'promo') {
    const timeSinceLastPush = now - lastPromoPushTime
    if (timeSinceLastPush < PROMO_PUSH_COOLDOWN) {
      const waitTime = Math.round((PROMO_PUSH_COOLDOWN - timeSinceLastPush) / 1000)
      pushLog(`📱 PUSH | Skipped promo - cooldown ${waitTime}s remaining`)
      return { skipped: true, reason: 'cooldown' }
    }
    lastPromoPushTime = now
  }

  try {
    const allSubs = await redis.hgetall(REDIS_KEYS.PUSH_SUBS)
    const subsCount = allSubs ? Object.keys(allSubs).length : 0

    if (subsCount === 0) {
      pushLog(`📱 PUSH | No subscribers found`)
      return { sent: 0, failed: 0, total: 0 }
    }

    pushLog(`📱 PUSH | Sending to ${subsCount} subscribers...`)

    const payload = JSON.stringify({
      title,
      body,
      icon: '/icon.png',
      badge: '/icon.png',
      type,
      url: '/monitoring'
    })

    let sent = 0, failed = 0
    for (const [phone, subData] of Object.entries(allSubs)) {
      try {
        const subscription = typeof subData === 'string' ? JSON.parse(subData) : subData
        await webpush.sendNotification(subscription, payload)
        sent++
      } catch (e) {
        failed++
        pushLog(`📱 PUSH | Failed for ${phone}: ${e.message}`)
        // Hapus subscription yang expired
        if (e.statusCode === 410) {
          await redis.hdel(REDIS_KEYS.PUSH_SUBS, phone)
          pushLog(`📱 PUSH | Removed expired subscription: ${phone}`)
        }
      }
    }

    pushLog(`📱 PUSH | ✅ Done: ${sent} sent, ${failed} failed`)
    return { sent, failed, total: sent + failed }
  } catch (e) {
    pushLog(`📱 PUSH | ❌ Error: ${e.message}`)
    return { error: e.message }
  }
}

let _lastWaSendErrLog = 0 // throttle log error WA agar tidak spam

// ⚡ ULTRA-INSTANT BROADCAST - Message sudah di-build sebelumnya
function doBroadcastInstant(message) {
  lastBroadcastMessage = message

  const hasGroup = !!(sock && isReady && broadcastGroupId)
  const hasSubs = !!(sock && isReady && subscriptions.size > 0)

  if (hasGroup) {
    sock.sendMessage(broadcastGroupId, { text: message }).catch(e => {
      const _n = Date.now()
      if (_n - _lastWaSendErrLog > 30000) {
        _lastWaSendErrLog = _n
        pushLog(`SEND | ❌ WA group gagal: ${e.message}`)
      }
    })
  }

  if (!hasSubs && !hasGroup) return
  if (!hasSubs) {
    pushLog(`SEND | WA → group saja (0 sub)`)
    return
  }

  broadcastCount++
  const currentBroadcastId = broadcastCount
  const subsCount = subscriptions.size

  const chatIds = Array.from(subscriptions)
  for (let i = 0; i < chatIds.length; i++) {
    sock.sendMessage(chatIds[i], { text: message }).catch(() => {})
  }

  pushLog(`SEND | Broadcast #${currentBroadcastId} → ${hasGroup ? 'group + ' : ''}${subsCount} sub`)
}

let isPriceChecking = false // Lock untuk mencegah overlap

// ==================== MULTI-INTERVAL SPEED TEST ====================
const INTERVALS = [100, 200, 300, 500] // Interval yang ditest (ms)
let currentIntervalIndex = 0
let intervalStats = {}
let lastPriceChangeTime = null
let lastApiUpdateTime = null

// Initialize stats untuk setiap interval
INTERVALS.forEach(interval => {
  intervalStats[interval] = {
    attempts: 0,
    successes: 0,
    totalDelay: 0,
    minDelay: Infinity,
    maxDelay: 0,
    avgDelay: 0,
    errors: 0
  }
})

async function checkPriceUpdate() {
  if (isPriceChecking) return // Skip jika masih fetching
  isPriceChecking = true

  const currentInterval = INTERVALS[currentIntervalIndex]

  // Selalu fetch price untuk monitoring web, broadcast hanya jika ada subscriber
  try {
    const fetchStart = Date.now()
    const treasuryData = await fetchTreasury()
    const fetchTime = Date.now() - fetchStart
    const currentPrice = {
      buy: treasuryData?.data?.buying_rate,
      sell: treasuryData?.data?.selling_rate,
      updated_at: treasuryData?.data?.updated_at,
      fetchedAt: Date.now()
    }

    intervalStats[currentInterval].attempts++

    // Cek apakah API time berubah (harga baru dari Treasury)
    const apiTime = currentPrice.updated_at
    if (apiTime && apiTime !== lastApiUpdateTime) {
      const delayMs = Date.now() - new Date(apiTime).getTime()

      // Update stats
      intervalStats[currentInterval].successes++
      intervalStats[currentInterval].totalDelay += delayMs
      if (delayMs < intervalStats[currentInterval].minDelay) {
        intervalStats[currentInterval].minDelay = delayMs
      }
      if (delayMs > intervalStats[currentInterval].maxDelay) {
        intervalStats[currentInterval].maxDelay = delayMs
      }

      lastApiUpdateTime = apiTime
    }

    // Rotate interval untuk test berikutnya
    currentIntervalIndex = (currentIntervalIndex + 1) % INTERVALS.length

    if (!lastKnownPrice) {
      lastKnownPrice = currentPrice
      lastBroadcastedPrice = currentPrice
      lastPriceUpdateTime = Date.now()
      await updateDailyStats(currentPrice.buy)
      pushLog(`PRICE | Initial: Buy ${formatRupiah(currentPrice.buy)} | Sell ${formatRupiah(currentPrice.sell)}`)

      // Check initial price status
      if (cachedMarketData.xauUsd && cachedMarketData.usdIdr) {
        const priceStatus = analyzePriceStatus(
          currentPrice.buy,
          currentPrice.sell,
          cachedMarketData.xauUsd,
          cachedMarketData.usdIdr.rate
        )
        if (priceStatus.status === 'ABNORMAL') {
          pushLog(`PRICE | Initial status: ABNORMAL`)
        }
      }
      return
    }
    
    const buyChanged = lastKnownPrice.buy !== currentPrice.buy
    const sellChanged = lastKnownPrice.sell !== currentPrice.sell

    // ⏱️ STALE PRICE DETECTION
    const now = Date.now()
    const timeSinceLastUpdate = now - lastPriceUpdateTime
    const isPriceStale = timeSinceLastUpdate >= STALE_PRICE_THRESHOLD

    // Check jika status berubah dari NORMAL ke TIDAK NORMAL atau sebaliknya
    let statusChanged = false
    let currentStatus = null
    let previousStatus = null

    if (cachedMarketData.xauUsd && cachedMarketData.usdIdr) {
      const currentPriceStatus = analyzePriceStatus(
        currentPrice.buy,
        currentPrice.sell,
        cachedMarketData.xauUsd,
        cachedMarketData.usdIdr.rate
      )
      currentStatus = currentPriceStatus.status

      const lastPriceStatus = analyzePriceStatus(
        lastKnownPrice.buy,
        lastKnownPrice.sell,
        cachedMarketData.xauUsd,
        cachedMarketData.usdIdr.rate
      )
      previousStatus = lastPriceStatus.status

      statusChanged = currentStatus !== previousStatus

      if (statusChanged) {
        if (currentStatus === 'ABNORMAL') {
          pushLog(`PRICE | Status changed: NORMAL -> ABNORMAL`)
        } else if (currentStatus === 'NORMAL') {
          pushLog(`PRICE | Status changed: ABNORMAL -> NORMAL`)
        }
      }
    }

    // Cek apakah data lebih baru berdasarkan updated_at
    const currentUpdatedAt = new Date(currentPrice.updated_at).getTime()
    const lastUpdatedAt = lastKnownPrice.updated_at ? new Date(lastKnownPrice.updated_at).getTime() : 0

    // SKIP jika data dari API lebih lama dari yang sudah ada
    if (currentUpdatedAt < lastUpdatedAt) {
      pushLog(`PRICE | Skip old data: ${currentPrice.updated_at} < ${lastKnownPrice.updated_at}`)
      return
    }

    // Selalu update lastKnownPrice untuk monitoring web
    const prevPrice = { ...lastKnownPrice }
    lastKnownPrice = currentPrice

    // Update daily stats only (history handled by fastPoll)
    if (buyChanged) {
      await updateDailyStats(currentPrice.buy)
    }

    // INSTANT SSE PUSH ke frontend monitoring
    if (buyChanged || sellChanged) {
      const sseData = {
        type: 'price',
        buy: currentPrice.buy,
        sell: currentPrice.sell,
        prevBuy: prevPrice.buy,
        prevSell: prevPrice.sell,
        updatedAt: currentPrice.updated_at,
        usdIdr: cachedMarketData.usdIdr?.rate,
        xauUsd: cachedMarketData.xauUsd,
        serverTime: new Date().toISOString()
      }
      broadcastSSE(sseData)
    }

    if (!buyChanged && !sellChanged) {
      return
    }

    // Skip WA broadcast jika tidak ada subscriber DAN tidak ada broadcast group
    if (!isReady || (subscriptions.size === 0 && !broadcastGroupId)) {
      return
    }
    
    // 🔥 ADA PERUBAHAN HARGA!
    const buyChangeSinceBroadcast = Math.abs(currentPrice.buy - (lastBroadcastedPrice?.buy || currentPrice.buy))
    const sellChangeSinceBroadcast = Math.abs(currentPrice.sell - (lastBroadcastedPrice?.sell || currentPrice.sell))
    
    if (buyChangeSinceBroadcast < MIN_PRICE_CHANGE && sellChangeSinceBroadcast < MIN_PRICE_CHANGE) {
      lastPriceUpdateTime = now  // Update timestamp meskipun perubahan kecil
      return
    }
    
    const timeSinceLastBroadcast = now - lastBroadcastTime
    
    // Cek apakah sudah ganti menit
    const lastBroadcastDate = new Date(lastBroadcastTime)
    const currentDate = new Date(now)
    const lastMinute = lastBroadcastDate.getHours() * 60 + lastBroadcastDate.getMinutes()
    const currentMinute = currentDate.getHours() * 60 + currentDate.getMinutes()
    const isNewMinute = currentMinute !== lastMinute
    
    // 🚫 CEK DULU: Apakah sudah broadcast di menit ini?
    const alreadyBroadcastThisMinute = lastBroadcastMinute === currentMinute

    // 🎯 LOGIKA BROADCAST:
    // 1. Jika sudah broadcast di menit ini → SKIP (hindari 2x broadcast per menit)
    // 2. Jika status berubah ke TIDAK NORMAL → BROADCAST LANGSUNG (prioritas tinggi!)
    // 3. Jika harga stale (5+ menit tidak update) → BROADCAST LANGSUNG saat ada update baru
    // 4. Jika harga tidak stale → ikuti cooldown normal (50 detik ATAU ganti menit)

    const shouldBroadcast = alreadyBroadcastThisMinute
      ? false  // 🚫 Sudah broadcast di menit ini, skip!
      : statusChanged && currentStatus === 'ABNORMAL'
      ? true  // Langsung broadcast jika status berubah ke TIDAK NORMAL
      : isPriceStale
      ? true  // Langsung broadcast jika harga baru setelah 5 menit stale
      : (timeSinceLastBroadcast >= BROADCAST_COOLDOWN || isNewMinute)
    
    if (!shouldBroadcast) {
      const priceChange = {
        buyChange: currentPrice.buy - prevPrice.buy,
        sellChange: currentPrice.sell - prevPrice.sell
      }

      lastPriceUpdateTime = now  // Update timestamp

      const time = new Date().toISOString().substring(11, 19)
      const buyIcon = priceChange.buyChange > 0 ? '📈' : '📉'
      const sellIcon = priceChange.sellChange > 0 ? '📈' : '📉'

      // Log dengan reason yang tepat
      const skipReason = alreadyBroadcastThisMinute
        ? 'sudah kirim menit ini'
        : `tunggu ${Math.round((BROADCAST_COOLDOWN - timeSinceLastBroadcast)/1000)}s`

      pushLog(`PRICE | ${buyIcon}Buy ${priceChange.buyChange > 0 ? '+' : ''}${formatRupiah(priceChange.buyChange)} ${sellIcon}Sell ${priceChange.sellChange > 0 ? '+' : ''}${formatRupiah(priceChange.sellChange)} → skip (${skipReason})`)
      return
    }

    const priceChange = {
      buyChange: currentPrice.buy - prevPrice.buy,
      sellChange: currentPrice.sell - prevPrice.sell
    }

    lastPriceUpdateTime = now  // Update timestamp saat broadcast
    
    const buyIcon = priceChange.buyChange > 0 ? '📈' : '📉'
    const sellIcon = priceChange.sellChange > 0 ? '📈' : '📉'

    pushLog(`PRICE | ${buyIcon}Buy ${priceChange.buyChange > 0 ? '+' : ''}${formatRupiah(priceChange.buyChange)} ${sellIcon}Sell ${priceChange.sellChange > 0 ? '+' : ''}${formatRupiah(priceChange.sellChange)} → BROADCAST`)
    
    // CRITICAL FIX: Hitung finalPriceChange SEBELUM update lastBroadcastedPrice
    const finalPriceChange = {
      buyChange: currentPrice.buy - lastBroadcastedPrice.buy,
      sellChange: currentPrice.sell - lastBroadcastedPrice.sell
    }
    
    // ✅ VALIDASI: Hanya broadcast jika harga masih di menit yang sama
    const priceFetchTime = new Date(currentPrice.fetchedAt)
    const nowTime = new Date(Date.now())
    const priceMinute = priceFetchTime.getHours() * 60 + priceFetchTime.getMinutes()
    const nowMinute = nowTime.getHours() * 60 + nowTime.getMinutes()
    
    if (priceMinute !== nowMinute && !isPriceStale) {
      pushLog(`PRICE | Old minute data, skip`)
      lastBroadcastedPrice = {
        buy: currentPrice.buy,
        sell: currentPrice.sell,
        fetchedAt: currentPrice.fetchedAt
      }
      return
    }
    
    // Update timestamp dan price SEBELUM broadcast dimulai
    lastBroadcastTime = now
    lastBroadcastMinute = currentMinute  // 🚫 Track menit ini sudah broadcast
    lastBroadcastedPrice = {
      buy: currentPrice.buy,
      sell: currentPrice.sell,
      fetchedAt: currentPrice.fetchedAt
    }

    // 🚀 PRE-BUILD MESSAGE untuk instant broadcast
    const broadcastData = {
      data: {
        buying_rate: currentPrice.buy,
        selling_rate: currentPrice.sell,
        updated_at: currentPrice.updated_at
      }
    }
    const usdIdrChangeVal = prevUsdIdrRate && cachedMarketData.usdIdr?.rate ? cachedMarketData.usdIdr.rate - prevUsdIdrRate : null
    const message = formatMessage(broadcastData, cachedMarketData.usdIdr.rate, cachedMarketData.xauUsd, finalPriceChange, cachedMarketData.economicEvents, lowestOnPriceCache, promoLimitCache, usdIdrChangeVal, dailyHighBuy, dailyLowBuy)

    // 🚀 INSTANT BROADCAST - Langsung kirim tanpa delay
    doBroadcastInstant(message)

    // 📱 PUSH NOTIFICATION - Kirim ke HP walaupun browser tertutup
    const buyDir = finalPriceChange.buyChange > 0 ? '📈' : '📉'
    const sellDir = finalPriceChange.sellChange > 0 ? '📈' : '📉'
    const pushTitle = `${buyDir} Harga Emas Update`
    const pushBody = `Beli: Rp ${currentPrice.buy.toLocaleString('id-ID')} (${finalPriceChange.buyChange > 0 ? '+' : ''}${formatRupiah(finalPriceChange.buyChange)})\nJual: Rp ${currentPrice.sell.toLocaleString('id-ID')} (${finalPriceChange.sellChange > 0 ? '+' : ''}${formatRupiah(finalPriceChange.sellChange)})`
    sendPushToAll(pushTitle, pushBody, 'price').catch(() => {})

  } catch (e) {
    // Track error per interval
    const currentInterval = INTERVALS[currentIntervalIndex]
    intervalStats[currentInterval].errors++

    // Log error hanya sekali per 10 detik
    const now = Date.now()
    if (!global.lastErrorLog || now - global.lastErrorLog > 10000) {
      global.lastErrorLog = now
    }
  } finally {
    isPriceChecking = false // Release lock
  }
}

// DISABLED: checkPriceUpdate - diganti dengan fastPoll untuk menghindari flip-flop
// setInterval(checkPriceUpdate, 100)

// ==================== CONTINUOUS FAST POLLING ====================
// Polling terus-menerus untuk real-time update
let isFastPolling = false
let isFastPollingSince = 0 // timestamp kapan isFastPolling = true (untuk deadlock detection)
let lastKnownTimestamp = 0
let consecutiveErrors = 0
let lastFetchMs = null       // berapa ms request ke Treasury API
let lastDataAgeMs = null     // berapa ms sejak Treasury update datanya
let latencyHistory = []      // rolling 10 sample terakhir untuk avg

async function fastPoll() {
  // Deadlock detection: jika isFastPolling stuck > 10 detik, force reset
  if (isFastPolling) {
    if (isFastPollingSince && Date.now() - isFastPollingSince > 10000) {
      pushLog(`TREASURY | isFastPolling stuck ${Math.round((Date.now()-isFastPollingSince)/1000)}s — force reset`)
      isFastPolling = false
    } else {
      return
    }
  }
  isFastPolling = true
  isFastPollingSince = Date.now()

  try {
    const _fetchStart = Date.now()
    const treasuryData = await fetchTreasury()
    const _fetchMs = Date.now() - _fetchStart

    if (!treasuryData?.data?.buying_rate) {
      consecutiveErrors++
      pushLog(`TREASURY | buying_rate kosong/nol (error #${consecutiveErrors}) — raw: ${JSON.stringify(treasuryData?.data).substring(0, 150)}`)
      return
    }

    consecutiveErrors = 0
    lastSuccessfulFetch = Date.now() // Track successful fetch

    // Simpan latency
    lastFetchMs = _fetchMs
    lastDataAgeMs = treasuryData.data.updated_at
      ? Date.now() - new Date(treasuryData.data.updated_at).getTime()
      : null
    latencyHistory.push(_fetchMs)
    if (latencyHistory.length > 10) latencyHistory.shift()

    const currentPrice = {
      buy: treasuryData.data.buying_rate,
      sell: treasuryData.data.selling_rate,
      updated_at: treasuryData.data.updated_at,
      fetchedAt: Date.now()
    }

    const updateTime = new Date(treasuryData.data.updated_at).getTime()
    const isNewTimestamp = updateTime > lastKnownTimestamp
    const isPriceChanged = lastKnownPrice &&
      (lastKnownPrice.buy !== currentPrice.buy || lastKnownPrice.sell !== currentPrice.sell)

    if (isNewTimestamp) {
      lastKnownTimestamp = updateTime
      lastApiUpdateTime = treasuryData.data.updated_at
      const _usdIdrLog = cachedMarketData.usdIdr?.rate ? ` | USD/IDR Rp${formatRupiah(cachedMarketData.usdIdr.rate)}` : ''
      pushLog(`TREASURY | Timestamp baru: ${treasuryData.data.updated_at} | Buy Rp${formatRupiah(currentPrice.buy)} | Sell Rp${formatRupiah(currentPrice.sell)}${_usdIdrLog} | latency ${_fetchMs}ms`)

      // Kirim ke pending emas requests (dari command !emas yang menunggu harga baru)
      if (pendingEmasReplies.size > 0 && sock && isReady) {
        const _snapPrice = { ...currentPrice }
        const _snapUsdIdr = cachedMarketData.usdIdr?.rate
        const _snapXauUsd = cachedMarketData.xauUsd
        setImmediate(async () => {
          for (const [target, { pendingMsg }] of pendingEmasReplies) {
            try {
              const buy = _snapPrice.buy
              const sell = _snapPrice.sell
              const spreadPercent = buy > 0 ? (Math.abs(buy - sell) / buy * 100).toFixed(2) : '0.00'
              const date = _snapPrice.updated_at ? new Date(_snapPrice.updated_at) : new Date()
              const days = ['Minggu','Senin','Selasa','Rabu','Kamis','Jumat','Sabtu']
              const months = ['Jan','Feb','Mar','Apr','Mei','Jun','Jul','Agu','Sep','Okt','Nov','Des']
              const hh = String(date.getHours()).padStart(2,'0')
              const mm = String(date.getMinutes()).padStart(2,'0')
              const ss = String(date.getSeconds()).padStart(2,'0')
              const timeStr = `${days[date.getDay()]}, ${date.getDate()} ${months[date.getMonth()]} ${date.getFullYear()} ${hh}:${mm}:${ss} WIB`
              let statusLine = ''
              if (_snapXauUsd && _snapUsdIdr) {
                const ps = analyzePriceStatus(buy, sell, _snapXauUsd, _snapUsdIdr)
                if (ps.status === 'NORMAL') {
                  statusLine = `Status : *NORMAL*`
                } else {
                  const diff = Math.round(ps.difference)
                  statusLine = `Status : *${diff > 0 ? 'MARKUP' : 'MARKDOWN'}* ${diff > 0 ? '+' : ''}Rp${formatRupiah(Math.abs(diff))}`
                }
              }
              const replyText = [`*HARGA EMAS TREASURY*`, timeStr, ``, `Beli   : Rp${formatRupiah(buy)}/gr`, `Jual   : Rp${formatRupiah(sell)}/gr`, `Spread : ${spreadPercent}%`, statusLine].filter(Boolean).join('\n')
              await sock.sendMessage(target, { text: replyText }, { quoted: pendingMsg })
              pushLog(`CMD | emas (antrian→terkirim) ke ${target.substring(0, 20)}`)
            } catch (e) {
              pushLog(`CMD | emas antrian error: ${e.message}`)
            }
          }
          pendingEmasReplies.clear()
        })
      }
    }

    if (isPriceChanged) {
      const _bd = currentPrice.buy - lastKnownPrice.buy
      const _sd = currentPrice.sell - lastKnownPrice.sell
      pushLog(`TREASURY | Harga berubah: Buy ${formatRupiah(lastKnownPrice.buy)}→${formatRupiah(currentPrice.buy)} (${_bd > 0 ? '+' : ''}${formatRupiah(_bd)}) | Sell ${formatRupiah(lastKnownPrice.sell)}→${formatRupiah(currentPrice.sell)} (${_sd > 0 ? '+' : ''}${formatRupiah(_sd)})`)
    }

    const prevPrice = lastKnownPrice ? { ...lastKnownPrice } : null

    if (!lastKnownPrice) {
      lastKnownPrice = currentPrice
      await updateDailyStats(currentPrice.buy)
      broadcastSSE({
        type: 'price',
        buy: currentPrice.buy,
        sell: currentPrice.sell,
        updatedAt: currentPrice.updated_at,
        usdIdr: cachedMarketData.usdIdr?.rate,
        xauUsd: cachedMarketData.xauUsd,
        serverTime: new Date().toISOString(),
        fetchMs: lastFetchMs,
        dataAgeMs: lastDataAgeMs
      })
    } else if (isPriceChanged) {
      lastKnownPrice = currentPrice
      if (currentPrice.updated_at !== lastAddedUpdatedAt) {
        await updateDailyStats(currentPrice.buy)
        await addPriceHistory(currentPrice.buy, currentPrice.sell, prevPrice.buy, prevPrice.sell, currentPrice.updated_at, cachedMarketData.xauUsd)
      }
      broadcastSSE({
        type: 'price',
        buy: currentPrice.buy,
        sell: currentPrice.sell,
        prevBuy: prevPrice.buy,
        prevSell: prevPrice.sell,
        updatedAt: currentPrice.updated_at,
        usdIdr: cachedMarketData.usdIdr?.rate,
        xauUsd: cachedMarketData.xauUsd,
        serverTime: new Date().toISOString(),
        fetchMs: lastFetchMs,
        dataAgeMs: lastDataAgeMs
      })

      // 🎁 Trigger promo check 5 detik setelah harga berubah
      triggerPromoCheck()

      // 📱 WA BROADCAST - kirim ke grup WA dan subscriber (throttled: max 1x per menit)
      if (sock && isReady && (subscriptions.size > 0 || broadcastGroupId)) {
        const nowWa = Date.now()
        const currentMinuteWa = new Date(nowWa).getHours() * 60 + new Date(nowWa).getMinutes()
        const timeSinceLastBroadcast = nowWa - lastBroadcastTime
        const alreadyBroadcastThisMinute = lastBroadcastMinute === currentMinuteWa

        const buyChangeSinceBroadcast = Math.abs(currentPrice.buy - (lastBroadcastedPrice?.buy || prevPrice.buy))
        const minChangeOk = buyChangeSinceBroadcast >= MIN_PRICE_CHANGE

        const shouldWaBroadcast = !alreadyBroadcastThisMinute && minChangeOk &&
          (timeSinceLastBroadcast >= BROADCAST_COOLDOWN || currentMinuteWa !== lastBroadcastMinute)

        if (!shouldWaBroadcast) {
          const _skipReason = alreadyBroadcastThisMinute ? 'sudah broadcast menit ini'
            : !minChangeOk ? `perubahan terlalu kecil (Rp${formatRupiah(buyChangeSinceBroadcast)} < min Rp${formatRupiah(MIN_PRICE_CHANGE)})`
            : `cooldown ${Math.round((BROADCAST_COOLDOWN - timeSinceLastBroadcast) / 1000)}s`
          pushLog(`SEND | WA skip: ${_skipReason}`)
        }

        if (shouldWaBroadcast) {
          const finalPriceChange = {
            buyChange: currentPrice.buy - (lastBroadcastedPrice?.buy || prevPrice.buy),
            sellChange: currentPrice.sell - (lastBroadcastedPrice?.sell || prevPrice.sell)
          }
          const waData = {
            data: {
              buying_rate: currentPrice.buy,
              selling_rate: currentPrice.sell,
              updated_at: currentPrice.updated_at
            }
          }
          const waUsdIdrChange = prevUsdIdrRate && cachedMarketData.usdIdr?.rate ? cachedMarketData.usdIdr.rate - prevUsdIdrRate : null
          const waMessage = formatMessage(waData, cachedMarketData.usdIdr?.rate, cachedMarketData.xauUsd, finalPriceChange, cachedMarketData.economicEvents, lowestOnPriceCache, promoLimitCache, waUsdIdrChange, dailyHighBuy, dailyLowBuy)

          lastBroadcastTime = nowWa
          lastBroadcastMinute = currentMinuteWa
          lastBroadcastedPrice = { buy: currentPrice.buy, sell: currentPrice.sell, fetchedAt: currentPrice.fetchedAt }
          prevUsdIdrRate = cachedMarketData.usdIdr?.rate || null  // Simpan rate yang dibroadcast untuk perbandingan berikutnya

          doBroadcastInstant(waMessage)

          // Push notification ke HP
          const buyDir = finalPriceChange.buyChange > 0 ? '📈' : '📉'
          const pushTitle = `${buyDir} Harga Emas Update`
          const pushBody = `Beli: Rp ${currentPrice.buy.toLocaleString('id-ID')} (${finalPriceChange.buyChange > 0 ? '+' : ''}${formatRupiah(finalPriceChange.buyChange)})`
          sendPushToAll(pushTitle, pushBody, 'price').catch(() => {})
        }
      }
    } else {
      lastKnownPrice = currentPrice
    }

    // Update harga tertinggi/terendah hari ini (WIB)
    {
      const _todayWIB = new Date(Date.now() + 7 * 60 * 60 * 1000).toISOString().slice(0, 10)
      if (dailyStatDate !== _todayWIB) {
        dailyHighBuy = currentPrice.buy
        dailyLowBuy = currentPrice.buy
        dailyStatDate = _todayWIB
      } else {
        if (dailyHighBuy === null || currentPrice.buy > dailyHighBuy) dailyHighBuy = currentPrice.buy
        if (dailyLowBuy === null || currentPrice.buy < dailyLowBuy) dailyLowBuy = currentPrice.buy
      }
    }
  } catch (e) {
    consecutiveErrors++
    if (consecutiveErrors <= 3 || consecutiveErrors % 20 === 0) {
      pushLog(`TREASURY | Fetch error #${consecutiveErrors}: ${e.message}`)
    }
  } finally {
    isFastPolling = false
    isFastPollingSince = 0
  }
}

// Fast poll setiap 500ms (balanced - 2x per detik)
setInterval(fastPoll, 500)
// ==================== XAU/USD REAL-TIME ====================
let lastXauUsdPrice = null
let isXauFetching = false

async function checkXauUpdate() {
  if (isXauFetching) return
  isXauFetching = true

  try {
    const price = await fetchXAUUSDCached()
    if (price && price !== lastXauUsdPrice) {
      const prevPrice = lastXauUsdPrice
      const change = prevPrice ? (price - prevPrice) : 0
      lastXauUsdPrice = price
      cachedMarketData.xauUsd = price
      if (prevPrice) {
        pushLog(`XAU | Update: $${prevPrice.toFixed(2)} → $${price.toFixed(2)} (${change > 0 ? '+' : ''}${change.toFixed(2)})`)
      }
      broadcastSSE({
        type: 'xau',
        price: price,
        prevPrice: prevPrice,
        change: change.toFixed(2),
        timestamp: new Date().toISOString()
      })
    }
  } catch (e) {
    pushLog(`XAU | ❌ checkXauUpdate error: ${e.message}`)
  } finally {
    isXauFetching = false
  }
}

// XAU/USD polling setiap 5 detik (gunakan cache, tidak perlu 1 detik karena TradingView mati)
setInterval(checkXauUpdate, 5000)
checkXauUpdate() // Initial fetch

// ==================== PERIODIC PRICE BROADCAST ====================
// Kirim update harga setiap 10 detik meskipun harga tidak berubah
// Ini memastikan client selalu mendapat data terbaru dan timestamp update
let lastPeriodicBroadcast = 0
let lastSuccessfulFetch = Date.now() // Track kapan terakhir fetch berhasil

setInterval(() => {
  if (lastKnownPrice && sseClients.size > 0) {
    const now = Date.now()
    // Broadcast setiap 10 detik
    if (now - lastPeriodicBroadcast >= 10000) {
      lastPeriodicBroadcast = now
      broadcastSSE({
        type: 'price',
        buy: lastKnownPrice.buy,
        sell: lastKnownPrice.sell,
        updatedAt: lastKnownPrice.updated_at,
        usdIdr: cachedMarketData.usdIdr?.rate,
        xauUsd: cachedMarketData.xauUsd,
        serverTime: new Date().toISOString()
      })
    }
  }

  // Log warning jika tidak ada successful fetch dalam 30 detik
  const now = Date.now()
  if (now - lastSuccessfulFetch > 30000) {
    pushLog('TREASURY | Warning: No successful fetch in 30+ seconds! Consecutive errors: ' + consecutiveErrors)
    lastSuccessfulFetch = now // Reset untuk hindari spam log
  }
}, 2000) // Check setiap 2 detik

// ==================== STARTUP INFO ====================

const app = express()
app.set('trust proxy', 1) // trust Koyeb/Cloudflare proxy so req.ip reflects real client IP
app.use(express.json({ limit: '10mb' }))

// Self-host lucide icons
let lucideCache = null
app.get('/assets/lucide.min.js', async (_req, res) => {
  try {
    if (!lucideCache) {
      const r = await fetch('https://unpkg.com/lucide@0.577.0/dist/umd/lucide.min.js', { signal: AbortSignal.timeout(5000) })
      if (r.ok) lucideCache = await r.text()
    }
    if (lucideCache) {
      res.setHeader('Content-Type', 'application/javascript')
      res.setHeader('Cache-Control', 'public, max-age=86400')
      return res.send(lucideCache)
    }
  } catch (_) {}
  res.status(503).send('// lucide unavailable')
})

// Security headers
app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.setHeader('X-Frame-Options', 'SAMEORIGIN')
  res.setHeader('X-XSS-Protection', '1; mode=block')
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin')
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()')

  // HSTS: paksa HTTPS selama 1 tahun
  res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains')

  // CSP: batasi sumber resource yang boleh dimuat
  const csp = [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://s3.tradingview.com https://challenges.cloudflare.com",
    "style-src 'self' 'unsafe-inline'",
    "font-src 'self'",
    "img-src 'self' data: https:",
    "connect-src 'self' wss://*.tradingview.com https://*.tradingview.com https://challenges.cloudflare.com",
    "frame-src https://s3.tradingview.com https://www.tradingview-widget.com https://challenges.cloudflare.com",
    "media-src 'self' data: blob:",
    "worker-src 'self' blob:",
    "manifest-src 'self'",
    "base-uri 'self'",
    "form-action 'self'"
  ].join('; ')
  res.setHeader('Content-Security-Policy', csp)

  next()
})

// Middleware: terima x-admin-token sebagai auth pengganti password
app.use((req, res, next) => {
  const token = req.headers['x-admin-token']
  if (token) {
    try {
      const decoded = Buffer.from(token, 'base64').toString()
      const [username, pwd] = decoded.split(':')
      if (username === SUPER_ADMIN.username && pwd === SUPER_ADMIN.password) {
        if (req.body && typeof req.body === 'object') req.body.password = ADMIN_PASSWORD
        req.query = { ...req.query, password: ADMIN_PASSWORD }
        req.headers['x-admin-password'] = ADMIN_PASSWORD
        req._adminAuthed = true
      }
    } catch {}
  }
  next()
})

// Helper: validasi session user atau admin — kembalikan false jika tidak valid (sudah kirim 403)
async function requireSession(req, res) {
  if (req._adminAuthed) return true
  const session = req.query.session || (req.body && req.body.session)
  if (!session) { res.status(403).json({ error: 'Unauthorized' }); return false }
  let phone = null
  try { phone = await redis.hget(REDIS_KEYS.SESSIONS, session) } catch {}
  if (!phone) { res.status(403).json({ error: 'Unauthorized' }); return false }
  return true
}

// Helper: validasi admin password untuk endpoint berbahaya
function requireAdminPassword(req, res) {
  const pw = req.query.password || (req.body && req.body.password) || req.headers['x-admin-password']
  if (pw !== ADMIN_PASSWORD) { res.status(403).json({ error: 'Unauthorized' }); return false }
  return true
}

// Simple in-memory rate limiter for sensitive endpoints
const _rateLimitMap = new Map()
function rateLimit(maxReq, windowMs) {
  return (req, res, next) => {
    const key = req.ip + ':' + req.path
    const now = Date.now()
    const entry = _rateLimitMap.get(key) || { count: 0, start: now }
    if (now - entry.start > windowMs) { entry.count = 0; entry.start = now }
    entry.count++
    _rateLimitMap.set(key, entry)
    if (entry.count > maxReq) return res.status(429).json({ error: 'Too many requests' })
    next()
  }
}

// Cloudflare Turnstile CAPTCHA verification
async function verifyTurnstile(token, ip) {
  const secret = process.env.TURNSTILE_SECRET_KEY
  if (!secret) return true // skip jika belum dikonfigurasi
  if (!token) return false
  try {
    const resp = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ secret, response: token, remoteip: ip })
    })
    const data = await resp.json()
    return data.success === true
  } catch { return false }
}

// ==================== SUPER ADMIN LOGIN ====================
// Login page untuk akses /qr dan /admin
app.get('/admin-login', (req, res) => {
  if (isAdminCookieValid(req)) {
    return res.redirect(req.query.redirect || '/admin/users')
  }
  const { redirect } = req.query
  res.send(`<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>body,*{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;}</style>
  <title>Admin Login - Gold Price Monitor</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      background: linear-gradient(145deg, #0a0e13 0%, #131921 50%, #0f1419 100%);
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 20px;
      position: relative;
      overflow: hidden;
    }
    body::before {
      content: '';
      position: absolute;
      top: -50%;
      left: -50%;
      width: 200%;
      height: 200%;
      background: radial-gradient(circle at 30% 20%, rgba(220,38,38,0.08) 0%, transparent 50%),
                  radial-gradient(circle at 70% 80%, rgba(220,38,38,0.05) 0%, transparent 40%);
      animation: float 20s ease-in-out infinite;
      pointer-events: none;
    }
    @keyframes float {
      0%, 100% { transform: translate(0, 0) rotate(0deg); }
      50% { transform: translate(-2%, 2%) rotate(1deg); }
    }
    .card {
      background: rgba(20, 26, 34, 0.9);
      backdrop-filter: blur(20px);
      -webkit-backdrop-filter: blur(20px);
      border-radius: 24px;
      padding: 40px 32px;
      width: 100%;
      max-width: 400px;
      border: 1px solid rgba(255,255,255,0.08);
      box-shadow: 0 25px 80px rgba(0,0,0,0.5),
                  0 0 0 1px rgba(255,255,255,0.05) inset;
      position: relative;
      z-index: 1;
    }
    .admin-badge {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      background: linear-gradient(135deg, rgba(220,38,38,0.2), rgba(220,38,38,0.1));
      color: #f87171;
      padding: 8px 14px;
      border-radius: 20px;
      font-size: 0.75em;
      font-weight: 600;
      margin-bottom: 20px;
      border: 1px solid rgba(220,38,38,0.2);
    }
    .admin-badge svg { width: 14px; height: 14px; }
    h1 {
      color: #ffffff;
      text-align: center;
      margin-bottom: 8px;
      font-size: 1.6em;
      font-weight: 700;
      letter-spacing: -0.02em;
    }
    .subtitle {
      color: #8b949e;
      text-align: center;
      margin-bottom: 32px;
      font-size: 0.9em;
      font-weight: 400;
    }
    .form-group {
      margin-bottom: 20px;
    }
    label {
      display: block;
      color: #8b949e;
      margin-bottom: 10px;
      font-size: 0.85em;
      font-weight: 500;
    }
    input {
      width: 100%;
      padding: 16px 18px;
      border: 2px solid rgba(255,255,255,0.08);
      border-radius: 14px;
      background: rgba(15, 20, 25, 0.8);
      color: #e7e9ea;
      font-size: 1em;
      font-family: inherit;
      transition: all 0.2s ease;
    }
    input:focus {
      outline: none;
      border-color: #dc2626;
      background: rgba(15, 20, 25, 1);
      box-shadow: 0 0 0 4px rgba(220,38,38,0.15);
    }
    input::placeholder { color: #4a5568; }
    .btn {
      width: 100%;
      padding: 16px;
      background: linear-gradient(135deg, #dc2626 0%, #b91c1c 100%);
      color: white;
      border: none;
      border-radius: 14px;
      font-size: 1em;
      font-weight: 600;
      cursor: pointer;
      transition: all 0.2s ease;
      font-family: inherit;
      box-shadow: 0 4px 20px rgba(220,38,38,0.35);
    }
    .btn:hover {
      transform: translateY(-2px);
      box-shadow: 0 8px 30px rgba(220,38,38,0.45);
    }
    .btn:active { transform: translateY(0); }
    .error {
      background: rgba(239,68,68,0.12);
      border: 1px solid rgba(239,68,68,0.3);
      color: #f87171;
      padding: 14px 16px;
      border-radius: 12px;
      margin-bottom: 20px;
      text-align: left;
      display: none;
      font-size: 0.9em;
      font-weight: 500;
    }
    .error.show { display: block; }
    .back-link {
      display: block;
      text-align: center;
      margin-top: 24px;
      color: #8b949e;
      font-size: 0.85em;
      text-decoration: none;
    }
    .back-link:hover { color: #f7931a; }
    @media (max-width: 480px) {
      .card { padding: 32px 24px; border-radius: 20px; }
      h1 { font-size: 1.4em; }
      input { padding: 14px 16px; }
      .btn { padding: 14px; }
    }
  </style>
</head>
<body>
  <div class="card">
    <div style="text-align:center;">
      <span class="admin-badge">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>
        Admin Area
      </span>
    </div>
    <h1>Admin Login</h1>
    <p class="subtitle">Masuk untuk mengakses panel admin</p>
    <div class="error" id="error">Username atau password salah</div>
    <form id="loginForm">
      <div class="form-group">
        <label>Username</label>
        <input type="text" id="username" placeholder="Masukkan username" required>
      </div>
      <div class="form-group">
        <label>Password</label>
        <input type="password" id="password" placeholder="Masukkan password" required>
      </div>
      <button type="submit" class="btn">Login Admin</button>
    </form>
    <a href="/login" class="back-link">← Kembali ke halaman user</a>
  </div>
  <script>
    document.getElementById('loginForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const username = document.getElementById('username').value;
      const password = document.getElementById('password').value;
      const error = document.getElementById('error');

      try {
        let turnstileToken = '';
        if (window.turnstile) {
          try { turnstileToken = turnstile.getResponse() || ''; } catch {}
        }
        const res = await fetch('/api/admin-login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username, password, 'cf-turnstile-response': turnstileToken })
        });
        const data = await res.json();

        if (data.success) {
          localStorage.setItem('super_admin_token', data.token);
          // Save monitoring session so admin can access /monitoring
          if (data.monitoringSession) {
            localStorage.setItem('goldmonitor_session', data.monitoringSession);
            try { localStorage.setItem('gold_sess_ok_at', String(Date.now())); } catch(e) {}
          }
          window.location.href = '${redirect || '/admin/users'}';
        } else {
          error.classList.add('show');
        }
      } catch (err) {
        error.textContent = 'Terjadi kesalahan';
        error.classList.add('show');
      }
    });
  </script>
</body>
</html>`)
})

// API untuk login
app.post('/api/admin-login', rateLimit(10, 60000), async (req, res) => {
  const { username, password } = req.body
  if (username === SUPER_ADMIN.username && password === SUPER_ADMIN.password) {
    // Generate simple token
    const token = Buffer.from(username + ':' + password + ':' + Date.now()).toString('base64')

    // Create admin session for monitoring access
    const adminSessionId = 'admin_' + crypto.randomBytes(16).toString('hex')
    await redis.hset(REDIS_KEYS.SESSIONS, { [adminSessionId]: 'admin' })

    // Also add admin to users hash if not exists (for session validation)
    const adminUserData = JSON.stringify({ name: 'Administrator', phone: 'admin', isAdmin: true })
    await redis.hset(REDIS_KEYS.USERS, { 'admin': adminUserData })

    // Set httpOnly cookie untuk server-side auth check di /admin/users
    const maxAge = 12 * 60 * 60 // 12 jam dalam detik
    res.setHeader('Set-Cookie', `admin_auth=${encodeURIComponent(token)}; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}; Path=/`)

    res.json({ success: true, token, monitoringSession: adminSessionId })
  } else {
    res.json({ success: false, error: 'Invalid credentials' })
  }
})

// API untuk verify token
app.post('/api/verify-admin', (req, res) => {
  const { token } = req.body
  try {
    const decoded = Buffer.from(token, 'base64').toString()
    const [username, password] = decoded.split(':')
    if (username === SUPER_ADMIN.username && password === SUPER_ADMIN.password) {
      res.json({ success: true })
    } else {
      res.json({ success: false })
    }
  } catch (e) {
    res.json({ success: false })
  }
})

// Helper: parse cookie header manual (tanpa cookie-parser)
function parseCookies(req) {
  const list = {}
  const header = req.headers && req.headers.cookie
  if (!header) return list
  header.split(';').forEach(part => {
    const [k, ...v] = part.split('=')
    if (k) list[k.trim()] = decodeURIComponent(v.join('=').trim())
  })
  return list
}

// Helper: cek cookie admin_auth dari request
function isAdminCookieValid(req) {
  try {
    const cookies = parseCookies(req)
    const cookie = cookies.admin_auth
    if (!cookie) return false
    const decoded = Buffer.from(cookie, 'base64').toString()
    const [username, password] = decoded.split(':')
    return username === SUPER_ADMIN.username && password === SUPER_ADMIN.password
  } catch {
    return false
  }
}

// Helper function untuk generate auth check script
function getAuthCheckScript(redirectTo) {
  return `
  <script>
    (async function() {
      const token = localStorage.getItem('super_admin_token');
      if (!token) {
        window.location.href = '/admin-login?redirect=${encodeURIComponent(redirectTo)}';
        return;
      }

      try {
        const res = await fetch('/api/verify-admin', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token })
        });
        const data = await res.json();
        if (!data.success) {
          localStorage.removeItem('super_admin_token');
          window.location.href = '/admin-login?redirect=${encodeURIComponent(redirectTo)}';
        }
      } catch (e) {
        window.location.href = '/admin-login?redirect=${encodeURIComponent(redirectTo)}';
      }
    })();
  </script>`
}

app.get('/', (_req, res) => {
  res.redirect('/login')
})

app.get('/health', (_req, res) => {
  res.status(200).json({
    status: 'ok',
    timestamp: Date.now(),
    uptime: Math.floor(process.uptime()),
    ready: isReady,
    subscriptions: subscriptions.size,
    wsConnected: sock?.ws?.readyState === 1
  })
})

// ==================== PUBLIC API v1 (butuh API key) ====================
// Dokumentasi lengkap: /admin/api-docs (khusus admin)

// Preflight CORS untuk semua endpoint v1
app.options(/^\/api\/v1\/.*/, (_req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Headers', 'X-API-Key, Content-Type')
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS')
  res.status(204).end()
})

// GET /api/v1/price — harga emas Treasury saat ini
app.get('/api/v1/price', requireApiToken, (_req, res) => {
  const buy = lastKnownPrice?.buy || null
  const sell = lastKnownPrice?.sell || null
  res.json({
    success: true,
    data: {
      buy,
      sell,
      spreadPercent: (buy && sell) ? Number((((sell - buy) / buy) * 100).toFixed(2)) : null,
      usdIdr: cachedMarketData.usdIdr?.rate || null,
      xauUsd: lastXauUsdPrice || null,
      promoStatus: lastPromoStatus || null,
      dailyHigh: typeof dailyHighBuy !== 'undefined' ? dailyHighBuy : null,
      dailyLow: typeof dailyLowBuy !== 'undefined' ? dailyLowBuy : null,
      titikOn: (lowestOnPriceCache !== undefined && lowestOnPriceCache !== null) ? lowestOnPriceCache : null,
      titikOnDate: lowestOnDateWIB || null,
      updatedAt: lastKnownPrice?.updated_at || null,
      serverTime: new Date().toISOString()
    }
  })
})

// GET /api/v1/history?limit=100 — riwayat harga per menit (max 500)
app.get('/api/v1/history', requireApiToken, (req, res) => {
  let limit = parseInt(req.query.limit, 10)
  if (isNaN(limit) || limit < 1) limit = 100
  if (limit > 500) limit = 500
  const items = priceHistoryCache.slice(-limit).reverse()
  res.json({ success: true, total: priceHistoryCache.length, count: items.length, data: items })
})

// GET /api/v1/promo-status — status promo Treasury ON/OFF
app.get('/api/v1/promo-status', requireApiToken, (_req, res) => {
  res.json({ success: true, data: { status: lastPromoStatus || 'UNKNOWN', serverTime: new Date().toISOString() } })
})

// GET /api/v1/titik-on — harga beli terendah saat promo ON (Titik ON)
app.get('/api/v1/titik-on', requireApiToken, (_req, res) => {
  res.json({
    success: true,
    data: {
      titikOn: (lowestOnPriceCache !== undefined && lowestOnPriceCache !== null) ? lowestOnPriceCache : null,
      date: lowestOnDateWIB || null, // tanggal WIB (YYYY-MM-DD) saat titik ON tercatat
      promoStatus: lastPromoStatus || null,
      serverTime: new Date().toISOString()
    }
  })
})

// GET /api/v1/market — data pasar (XAU/USD & USD/IDR)
app.get('/api/v1/market', requireApiToken, (_req, res) => {
  res.json({
    success: true,
    data: {
      xauUsd: lastXauUsdPrice || null,
      usdIdr: cachedMarketData.usdIdr?.rate || null,
      serverTime: new Date().toISOString()
    }
  })
})

// API: QR status + image (untuk polling dari halaman QR)
app.get('/api/qr-status', async (req, res) => {
  // Auth check via admin_auth cookie (sama dengan isAdminCookieValid)
  if (!isAdminCookieValid(req)) return res.json({ auth: false })

  if (isReady) return res.json({ status: 'connected' })

  if (!lastQr) return res.json({ status: 'waiting' })

  // Selalu return rawQr agar client bisa generate sendiri jika server-side gagal
  const response = { status: 'qr', rawQr: lastQr }

  try {
    const mod = await import('qrcode').catch(() => null)
    if (mod?.toDataURL) {
      const dataUrl = await mod.toDataURL(lastQr, { width: 280, margin: 1 })
      response.dataUrl = dataUrl
    }
  } catch (_) {}

  res.json(response)
})

app.get('/qr', rateLimit(30, 60000), async (_req, res) => {
  // Auth check akan di-inject di halaman
  const authScript = getAuthCheckScript('/qr')
  if (!lastQr) {
    const statusMsg = isReady
      ? '<span style="color:#00ff88;">✓ WhatsApp sudah terhubung!</span><br><small style="color:#71767b;">Bot aktif dan siap digunakan.</small>'
      : '<span style="color:#ffaa00;">⏳ Menunggu QR Code...</span><br><small style="color:#71767b;">Jika tidak muncul dalam 30 detik, coba Reset.</small>'

    return res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>WhatsApp Status</title></head><body>
    ${authScript}
    <div style="text-align:center;padding:20px;font-family:sans-serif;background:#0f1419;color:#e7e9ea;min-height:100vh;">
      <h2 style="color:#f7931a;">WhatsApp Bot Status</h2>
      <div style="margin:30px 0;padding:20px;background:#1a1f26;border-radius:12px;border:1px solid #2f3640;">
        <p style="font-size:1.2em;">${statusMsg}</p>
      </div>

      ${isReady ? `
      <div style="margin:20px 0;padding:15px;background:rgba(0,255,136,0.1);border:1px solid #00ff88;border-radius:10px;">
        <p style="color:#00ff88;margin-bottom:10px;">Bot sudah aktif!</p>
        <p style="color:#71767b;font-size:0.9em;">Jika ingin ganti nomor WA atau login ulang, klik Reset di bawah.</p>
      </div>
      ` : ''}

      <div style="margin-top:30px;">
        <a href="/qr-reset" style="display:inline-block;margin:10px;padding:12px 25px;background:#ff4444;color:white;text-decoration:none;border-radius:8px;font-weight:bold;">Reset / Login Ulang</a>
        <a href="/qr" style="display:inline-block;margin:10px;padding:12px 25px;background:#2f3640;color:white;text-decoration:none;border-radius:8px;">Refresh</a>
      </div>

      <div style="margin-top:30px;padding:15px;background:#1a1f26;border-radius:10px;text-align:left;max-width:400px;margin-left:auto;margin-right:auto;">
        <p style="color:#f7931a;font-weight:bold;margin-bottom:10px;">Jika tidak bisa "Tautkan Perangkat":</p>
        <ol style="color:#71767b;font-size:0.85em;line-height:1.8;padding-left:20px;">
          <li>Buka WhatsApp di HP</li>
          <li>Pergi ke Settings > Linked Devices</li>
          <li>Hapus semua device yang terhubung</li>
          <li>Klik "Reset / Login Ulang" di atas</li>
          <li>Scan QR code yang muncul</li>
        </ol>
      </div>

      <p style="margin-top:20px;color:#555;font-size:0.8em;">Auto-refresh dalam 10 detik...</p>
      <script>setTimeout(() => window.location.reload(), 10000);</script>
    </div>
  </body></html>`)
  }

  // Render halaman QR dengan auto-polling (update QR tanpa reload halaman)
  return res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Scan QR WhatsApp</title></head><body>
    ${authScript}
    <div style="text-align:center;padding:20px;font-family:sans-serif;background:#0f1419;color:#e7e9ea;min-height:100vh;">
      <h2 style="color:#f7931a;" id="title">Scan QR dengan WhatsApp</h2>
      <div id="qrBox" style="background:white;padding:15px;border-radius:15px;display:inline-block;margin:20px 0;">
        <img id="qrImg" src="" style="max-width:280px;display:block;"/>
      </div>
      <div id="statusBox" style="display:none;margin:20px auto;padding:20px;background:#1a1f26;border-radius:12px;max-width:320px;">
        <p id="statusText" style="color:#ffaa00;font-size:1em;"></p>
      </div>
      <div style="margin:10px auto;padding:15px;background:#1a1f26;border-radius:10px;max-width:350px;">
        <p style="color:#f7931a;font-weight:bold;margin-bottom:8px;">Cara Scan:</p>
        <p style="color:#71767b;font-size:0.9em;line-height:1.6;">
          1. Buka WhatsApp di HP<br>
          2. Tap ⋮ atau Settings<br>
          3. Pilih "Linked Devices"<br>
          4. Tap "Link a Device"<br>
          5. Arahkan kamera ke QR di atas
        </p>
      </div>
      <p id="timerText" style="margin-top:10px;color:#555;font-size:0.8em;">Mengambil QR...</p>
      <a href="/qr-reset?confirm=yes" style="display:inline-block;margin-top:12px;padding:10px 20px;background:#ff4444;color:white;text-decoration:none;border-radius:8px;font-size:0.85em;">Reset / Ganti WA</a>
    </div>
    <script>
      let pollInterval;
      let countdown = 60;
      let countdownTimer;

      function startCountdown() {
        clearInterval(countdownTimer);
        countdown = 60;
        countdownTimer = setInterval(() => {
          countdown--;
          document.getElementById('timerText').textContent = 'QR diperbarui otomatis, expires dalam ' + countdown + 's';
          if (countdown <= 0) clearInterval(countdownTimer);
        }, 1000);
      }

      async function pollQR() {
        try {
          const r = await fetch('/api/qr-status');
          const data = await r.json();
          if (data.status === 'connected') {
            clearInterval(pollInterval);
            clearInterval(countdownTimer);
            document.getElementById('qrBox').style.display = 'none';
            document.getElementById('title').textContent = '✅ WhatsApp Terhubung!';
            document.getElementById('title').style.color = '#00ff88';
            document.getElementById('statusBox').style.display = 'block';
            document.getElementById('statusText').style.color = '#00ff88';
            document.getElementById('statusText').textContent = 'Bot aktif dan siap digunakan.';
            document.getElementById('timerText').textContent = '';
            setTimeout(() => window.location.href = '/admin/users', 3000);
          } else if (data.status === 'qr' && data.dataUrl) {
            document.getElementById('qrImg').src = data.dataUrl;
            document.getElementById('qrBox').style.display = 'inline-block';
            document.getElementById('statusBox').style.display = 'none';
            startCountdown();
          } else {
            document.getElementById('qrBox').style.display = 'none';
            document.getElementById('statusBox').style.display = 'block';
            document.getElementById('statusText').textContent = data.auth === false ? '🔒 Silakan login admin terlebih dahulu.' : '⏳ Menunggu QR dari WhatsApp server...';
            document.getElementById('timerText').textContent = 'Polling tiap 3 detik...';
          }
        } catch(e) {
          document.getElementById('timerText').textContent = 'Error polling, coba lagi...';
        }
      }

      pollQR();
      pollInterval = setInterval(pollQR, 3000);
    <\/script>
  </body></html>`)
})

// Reset QR - Hapus session dan restart koneksi WA
app.get('/qr-reset', async (req, res) => {
  const { confirm } = req.query
  const authScript = getAuthCheckScript('/qr-reset')

  if (confirm !== 'yes') {
    return res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Reset WhatsApp</title></head><body>
      ${authScript}
      <div style="text-align:center;padding:40px;font-family:sans-serif;background:#0f1419;color:#e7e9ea;min-height:100vh;">
        <h2 style="color:#ff4444;">Reset WhatsApp Session</h2>
        <p style="margin:20px 0;color:#71767b;">Ini akan menghapus sesi WhatsApp dan memerlukan scan QR ulang.</p>
        <p style="margin:20px 0;color:#ffaa00;display:flex;align-items:center;justify-content:center;gap:8px;"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#ffaa00" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg> WhatsApp akan logout dari device ini!</p>
        <a href="/qr-reset?confirm=yes" style="display:inline-block;margin:10px;padding:15px 30px;background:#ff4444;color:white;text-decoration:none;border-radius:10px;font-weight:bold;">Ya, Reset Sekarang</a>
        <a href="/qr" style="display:inline-block;margin:10px;padding:15px 30px;background:#2f3640;color:white;text-decoration:none;border-radius:10px;">Batal</a>
      </div>
    </body></html>`)
  }

  try {
    // Close existing connection
    if (sock) {
      sock.ev.removeAllListeners()
      await sock.logout().catch(() => {})
      sock = null
    }

    isReady = false
    lastQr = null
    reconnectAttempts = 0
    consecutive428 = 0
    isStarting = false
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null }

    // Hapus Redis auth
    await redis.del(REDIS_KEYS.WA_AUTH)
    pushLog('WA | Redis auth cleared')

    // Delete local auth folder
    const fs = await import('fs')
    const path = await import('path')
    const authPath = path.join(process.cwd(), 'auth')

    if (fs.existsSync(authPath)) {
      fs.rmSync(authPath, { recursive: true, force: true })
      pushLog('WA | Auth folder deleted')
    }

    // Restart connection
    pushLog('WA | Restarting connection...')
    scheduleReconnect(2000)

    res.send(`
      <div style="text-align:center;padding:40px;font-family:sans-serif;background:#0f1419;color:#e7e9ea;min-height:100vh;">
        <h2 style="color:#00ff88;">Reset Berhasil!</h2>
        <p style="margin:20px 0;color:#71767b;">Menunggu QR code baru...</p>
        <p style="margin:20px 0;">Halaman akan refresh otomatis dalam 5 detik.</p>
        <a href="/qr" style="display:inline-block;margin:10px;padding:15px 30px;background:#f7931a;color:white;text-decoration:none;border-radius:10px;font-weight:bold;">Lihat QR Code</a>
        <script>setTimeout(() => window.location.href = '/qr', 5000);</script>
      </div>
    `)
  } catch (e) {
    pushLog('WA | Reset error: ' + e.message)
    res.send(`
      <div style="text-align:center;padding:40px;font-family:sans-serif;background:#0f1419;color:#e7e9ea;min-height:100vh;">
        <h2 style="color:#ff4444;">Reset Gagal</h2>
        <p style="color:#71767b;">${e.message}</p>
        <a href="/qr" style="color:#f7931a;">Kembali</a>
      </div>
    `)
  }
})

// Admin: Get full system logs
app.get('/api/admin/logs', async (req, res) => {
  const { password } = req.query
  if (password !== ADMIN_PASSWORD) return res.json({ success: false, error: 'Unauthorized' })
  const limit = Math.min(parseInt(req.query.limit) || 100, 200)
  res.json({ success: true, logs: logs.slice(-limit), total: logs.length })
})

// Admin: Login history per nomor user (in-memory)
app.get('/api/admin/login-history', (req, res) => {
  if (!isAdminCookieValid(req)) return res.status(403).json({ error: 'Unauthorized' })
  const limit = Math.min(parseInt(req.query.limit) || 100, MAX_LOGIN_HISTORY)
  res.json({ success: true, items: [...loginHistory].reverse().slice(0, limit), total: loginHistory.length })
})

app.get('/stats', (_req, res) => {
  const now = Date.now()
  const timeSinceLastUpdate = lastPriceUpdateTime > 0 ? now - lastPriceUpdateTime : null
  const isPriceStale = timeSinceLastUpdate ? timeSinceLastUpdate >= STALE_PRICE_THRESHOLD : false
  
  res.json({
    status: isReady ? 'ready' : 'not_ready',
    uptime: Math.floor(process.uptime()),
    subs: subscriptions.size,
    lastPrice: lastKnownPrice,
    lastBroadcasted: lastBroadcastedPrice,
    broadcastCount: broadcastCount,
    lastBroadcastTime: lastBroadcastTime > 0 ? new Date(lastBroadcastTime).toISOString() : null,
    timeSinceLastBroadcast: lastBroadcastTime > 0 ? Math.floor((now - lastBroadcastTime) / 1000) : null,
    lastPriceUpdateTime: lastPriceUpdateTime > 0 ? new Date(lastPriceUpdateTime).toISOString() : null,
    timeSinceLastPriceUpdate: timeSinceLastUpdate ? Math.floor(timeSinceLastUpdate / 1000) : null,
    isPriceStale: isPriceStale,
    staleThreshold: STALE_PRICE_THRESHOLD / 60000,
    cachedXAUUSD: cachedXAUUSD,
    cachedEconomicEvents: cachedEconomicEvents,
    wsConnected: sock?.ws?.readyState === 1,
    logs: logs.slice(-20)
  })
})

app.get('/calendar', async (_req, res) => {
  try {
    const events = await fetchEconomicCalendar()
    res.json({
      success: true,
      count: events?.length || 0,
      events: events || [],
      formatted: formatEconomicCalendar(events)
    })
  } catch (e) {
    res.status(500).json({
      success: false,
      error: e.message
    })
  }
})

// XAU/USD Proxy API - untuk menghindari CORS di frontend
app.get('/xau', async (_req, res) => {
  try {
    const price = await fetchXAUUSD()
    if (price) {
      res.json({ price, timestamp: Date.now() })
    } else {
      res.json({ price: cachedXAUUSD, timestamp: lastXAUUSDFetch, cached: true })
    }
  } catch (e) {
    res.json({ price: cachedXAUUSD, timestamp: lastXAUUSDFetch, cached: true })
  }
})

// Endpoint untuk waktu server yang akurat (WIB)
app.get('/time', (_req, res) => {
  const now = new Date()
  // Konversi ke WIB (UTC+7)
  const wibOffset = 7 * 60 * 60 * 1000
  const wibTime = new Date(now.getTime() + wibOffset + now.getTimezoneOffset() * 60 * 1000)

  res.json({
    timestamp: now.getTime(),
    iso: now.toISOString(),
    wib: wibTime.toISOString().replace('Z', '+07:00'),
    timezone: 'Asia/Jakarta'
  })
})

// Daily Stats API - konsisten di semua device (async untuk Redis)
app.get('/daily-stats', async (_req, res) => {
  const stats = await getDailyStats()
  res.json(stats)
})

// Price History API - public (data harga bukan sensitif)
// Sparkline init — last 30 entries untuk inisialisasi sparkline di client
app.get('/api/sparkline-init', (req, res) => {
  const last30 = priceHistoryCache.slice(-30)
  const HARDCODED_RATES = [15900, 16600]
  res.json(last30.map(e => ({
    buy: e.buy || 0,
    sell: e.sell || 0,
    usdIdr: (e.usdIdr && !HARDCODED_RATES.includes(Math.round(e.usdIdr))) ? e.usdIdr : 0,
    spread: e.spread || (e.buy && e.sell ? parseFloat(((e.sell - e.buy) / e.buy * 100).toFixed(2)) : 0)
  })))
})

app.get('/price-history', async (req, res) => {
  const page = parseInt(req.query.page) || 1
  const perPage = parseInt(req.query.perPage) || 10
  const history = await getPriceHistory(page, perPage)
  // Include current USD/IDR for fallback on old entries
  history.currentUsdIdr = cachedMarketData.usdIdr?.rate || 0
  res.json(history)
})

app.get('/usd-idr-history', (req, res) => {
  res.json({ items: [...usdIdrHistory].reverse(), total: usdIdrHistory.length })
})

// Clear price history (untuk reset data duplikat)
app.get('/clear-history', async (req, res) => {
  if (!requireAdminPassword(req, res)) return
  try {
    await redis.del(REDIS_KEYS.PRICE_HISTORY)
    priceHistoryCache = []
    lastAddedUpdatedAt = ''
    res.json({ success: true, message: 'Price history cleared' })
  } catch (e) {
    res.json({ success: false, error: e.message })
  }
})

// Remove duplicate entries from history
app.get('/cleanup-history', async (req, res) => {
  if (!requireAdminPassword(req, res)) return
  try {
    const allHistory = await redis.lrange(REDIS_KEYS.PRICE_HISTORY, 0, -1)
    const seen = new Set()
    const uniqueHistory = []

    for (const entry of allHistory) {
      const parsed = typeof entry === 'string' ? JSON.parse(entry) : entry
      if (!seen.has(parsed.time)) {
        seen.add(parsed.time)
        uniqueHistory.push(entry)
      }
    }

    const removed = allHistory.length - uniqueHistory.length

    if (removed > 0) {
      await redis.del(REDIS_KEYS.PRICE_HISTORY)
      for (const entry of uniqueHistory) {
        await redis.rpush(REDIS_KEYS.PRICE_HISTORY, entry)
      }
      priceHistoryCache = uniqueHistory.map(e => typeof e === 'string' ? JSON.parse(e) : e)
      addedTimestamps.clear()
      uniqueHistory.forEach(e => {
        const parsed = typeof e === 'string' ? JSON.parse(e) : e
        addedTimestamps.add(parsed.time)
      })
    }

    res.json({ success: true, removed: removed, remaining: uniqueHistory.length })
  } catch (e) {
    res.json({ success: false, error: e.message })
  }
})

// ==================== CHAT ====================
const CHAT_ANIMALS = ['Harimau','Gajah','Singa','Serigala','Beruang','Rusa','Kuda','Zebra','Jerapah','Panda','Koala','Kanguru','Rubah','Otter','Lynx','Cheetah','Jaguar','Tapir','Bison','Flamingo','Pinguin','Elang','Naga','Phoenix','Kuda Nil','Badak','Gorila','Simpanse','Capybara','Axolotl','Cerpelai','Luwak','Musang','Biawak','Komodo','Iguana','Kadal','Bunglon','Tokek','Buaya','Aligator','Anaconda','Python','Cobra','Viper','Sanca','Belut','Kuda Laut','Pari','Hiu','Ikan Mas','Koi','Gurame','Salmon','Tuna','Cumi','Gurita','Kepiting','Lobster','Udang','Kerang','Tiram','Ubur','Bintang Laut','Landak Laut','Kura Laut','Penyu','Dugong','Lumba','Paus','Orca','Delfin','Anjing Laut','Walrus','Berang','Platipus','Wombat','Tasmanian','Oposum','Armadillo','Trenggiling','Landak','Tikus Tanah','Hamster','Gerbil','Marmot','Berang Air','Beaver','Tupai','Bajing','Monyet','Babon','Mandrill','Orang','Gibbon','Bonobo','Lemur','Galago','Makaka','Macaw','Kakaktua','Beo','Kenari','Murai','Kutilang','Cendrawasih','Merak','Kasuari','Emu','Nuri','Lovebird','Burung Hantu','Elang Bondol','Rajawali','Kondor','Vulture','Albatros','Pelikan','Bangau','Kuntul','Blekok','Pecuk','Kormoran','Gannet','Dodo','Quetzal','Toucan','Hornbill','Woodpecker','Robin','Wren','Sparrow','Finch','Swallow','Martin','Swift','Hummingbird','Kingfisher','Bee Eater','Roller','Hoopoe','Trogon','Manakin','Cotinga','Tanager','Oriole','Raven','Crow','Jay','Magpie','Starling','Mynah','Bulbul','Thrush','Warbler','Vireo','Creeper','Nuthatch','Treecreeper','Dipper','Waxwing','Flycatcher','Pipit','Wagtail','Lark','Bunting','Grosbeak','Cardinal','Towhee','Junco','Siskin','Goldfinch','Linnet','Chaffinch','Hawfinch','Redstart','Wheatear','Chat','Stonechat','Whinchat','Dunnock','Accentor','Warblers','Grassbird','Cisticola','Apalis','Camaroptera','Prinia','Tailorbird','Sunbird','Flowerpecker','Spiderhunter','Sugarbird','Honeyeater','Thornbill','Gerygone','Weebill','Fairywren','Emu Wren','Grasswren','Bristlebird','Pilotbird','Rockwarbler','Whipbird','Quail Thrush','Logrunner','Treecreeper AU','Sitella','Shrike Tit','Whistler','Shrike','Monarch','Fantail','Drongo','Iora','Woodswallow','Currawong','Butcherbird','Bellbird','Catbird','Bowerbird','Riflebird','Sicklebill','Lophorina','Parotia','Astrapia','Paradigalla','Manucodia','Trumpet','Satinbird','Berrypecker','Pitohui','Ifrita','Ploughbill','Cnemophilus','Macgregor','Melampitta','Paradisaea','Cicinnurus','Diphyllodes','Seleucidis','Pteridophora','Epimachus','Ptiloris','Craspedophora','Ptilonorhynchus']
const chatHistory = [] // max 100 pesan, in-memory
const MAX_CHAT = 100
const phoneAnimalMap = new Map() // phone -> animal name

function sendBotMessage(text) {
  const msg = { animal: 'SISTEM', text, time: Date.now(), isBot: true }
  chatHistory.push(msg)
  if (chatHistory.length > MAX_CHAT) chatHistory.shift()
  broadcastSSE({ type: 'chat_message', ...msg })
}

function getAnimalName(phone) {
  if (phoneAnimalMap.has(phone)) return phoneAnimalMap.get(phone)
  // Hash phone ke index yang konsisten
  let hash = 0
  for (let i = 0; i < phone.length; i++) hash = (hash * 31 + phone.charCodeAt(i)) >>> 0
  // Hindari nama yang sudah dipakai user lain
  const usedNames = new Set(phoneAnimalMap.values())
  let idx = hash % CHAT_ANIMALS.length
  let tries = 0
  while (usedNames.has(CHAT_ANIMALS[idx]) && tries < CHAT_ANIMALS.length) { idx = (idx + 1) % CHAT_ANIMALS.length; tries++ }
  const name = CHAT_ANIMALS[idx]
  phoneAnimalMap.set(phone, name)
  return name
}

// Reset chat tiap tengah malam (00:00 server time)
function scheduleMidnightChatReset() {
  const now = new Date()
  const next = new Date(now)
  next.setHours(24, 0, 0, 0) // jam 00:00 hari berikutnya
  const msUntilMidnight = next - now
  setTimeout(() => {
    chatHistory.length = 0
    broadcastSSE({ type: 'chat_reset' })
    scheduleMidnightChatReset() // jadwal ulang untuk besok
  }, msUntilMidnight)
}
scheduleMidnightChatReset()

// [DINONAKTIFKAN] Reset semua session setiap Senin 00:00.
// Ini penyebab SEMUA user ter-logout massal tiap Senin 00:00 (terlihat di log 2026-07-06).
// Kebijakan sekarang: user tidak pernah di-logout otomatis kecuali ditendang limit 3 device.
// function scheduleWeeklySessionReset() { ... } — dihapus dari jadwal.

// Price Alert Bot: cek pergerakan harga setiap 30 menit
let _priceSnapshot30 = null
setInterval(() => {
  if (!lastKnownPrice?.buy) return
  if (!_priceSnapshot30) {
    _priceSnapshot30 = { buy: lastKnownPrice.buy, sell: lastKnownPrice.sell }
    return
  }
  const buyDiff = lastKnownPrice.buy - _priceSnapshot30.buy
  const absBuy = Math.abs(buyDiff)
  const threshold = 2000
  if (absBuy >= threshold) {
    const dir = buyDiff > 0 ? 'naik' : 'turun'
    const changeStr = 'Rp ' + absBuy.toLocaleString('id-ID')
    const nowStr = 'Rp ' + lastKnownPrice.buy.toLocaleString('id-ID') + '/gram'
    sendBotMessage(`Pergerakan Harga | Harga beli ${dir} ${changeStr} dalam 30 menit. Saat ini: ${nowStr}`)
  }
  _priceSnapshot30 = { buy: lastKnownPrice.buy, sell: lastKnownPrice.sell }
}, 30 * 60 * 1000)

// SSE (Server-Sent Events) untuk real-time push ke frontend
// Map: res -> { phone, name, connectedAt, lastActivity }
const sseClients = new Map()

app.get('/sse', async (req, res) => {
  // Get user info from session - REQUIRE valid session
  const session = req.query.session || ''

  // Reject if no session provided
  if (!session) {
    return res.status(403).json({ error: 'Unauthorized - No session' })
  }

  // Verify session is valid
  let phone = null
  try {
    phone = await redis.hget(REDIS_KEYS.SESSIONS, session)
  } catch (e) {}

  // Reject if session is invalid
  if (!phone) {
    return res.status(403).json({ error: 'Unauthorized - Invalid session' })
  }

  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.flushHeaders()

  // Build user info from validated session
  let userInfo = { phone: phone, name: 'Member', connectedAt: new Date().toISOString(), lastActivity: Date.now() }

  try {
    const userData = await redis.hget(REDIS_KEYS.USERS, phone)
    if (userData) {
      const parsed = JSON.parse(userData)
      userInfo.name = parsed.name || ('Member ' + phone)
    } else {
      userInfo.name = phone === 'admin' ? 'Administrator' : ('Member ' + phone)
    }
  } catch (e) {}

  // Kirim data awal
  if (lastKnownPrice) {
    res.write(`data: ${JSON.stringify({
      type: 'price',
      buy: lastKnownPrice.buy,
      sell: lastKnownPrice.sell,
      updatedAt: lastKnownPrice.updated_at,
      usdIdr: cachedMarketData.usdIdr?.rate,
      xauUsd: cachedMarketData.xauUsd
    })}\n\n`)
  }

  // Kirim titik ON terendah jika ada
  if (lowestOnPriceCache === undefined) {
    try {
      const storedVal = await redis.get(REDIS_KEYS.LOWEST_ON_PRICE)
      lowestOnPriceCache = storedVal !== null ? parseInt(storedVal, 10) : null
    } catch (e) {}
  }
  if (lowestOnPriceCache !== null && lowestOnPriceCache !== undefined) {
    res.write(`data: ${JSON.stringify({ type: 'lowest_on_price', price: lowestOnPriceCache })}\n\n`)
  }

  // Kirim daily high/low saat koneksi SSE pertama
  if (dailyHighBuy !== null || dailyLowBuy !== null) {
    res.write(`data: ${JSON.stringify({ type: 'daily_highlow', high: dailyHighBuy, low: dailyLowBuy })}\n\n`)
  }

  // Kirim status promo saat ini jika sudah diketahui
  if (lastPromoStatus !== null) {
    res.write(`data: ${JSON.stringify({
      type: 'promo_status',
      status: lastPromoStatus,
      message: lastPromoStatus === 'ON' ? '✅ ON' : '❌ OFF'
    })}\n\n`)
  }

  // Kirim nama samaran dan riwayat chat
  const animal = getAnimalName(phone)
  res.write(`data: ${JSON.stringify({ type: 'chat_init', animal, messages: chatHistory, clients: sseClients.size + 1 })}\n\n`)


  sseClients.set(res, userInfo)

  // Broadcast online users update to admin
  broadcastOnlineUsers()

  req.on('close', () => {
    sseClients.delete(res)
    // Broadcast online users update when someone disconnects
    broadcastOnlineUsers()
  })
})

// Fungsi untuk broadcast ke semua SSE clients
function broadcastSSE(data) {
  const message = `data: ${JSON.stringify(data)}\n\n`
  sseClients.forEach((userInfo, client) => {
    try {
      client.write(message)
    } catch (e) {
      sseClients.delete(client)
    }
  })
}

// Fungsi untuk get online users list
function getOnlineUsers() {
  const users = []
  const seen = new Set()
  sseClients.forEach((userInfo, client) => {
    // Avoid duplicates by phone
    if (!seen.has(userInfo.phone)) {
      seen.add(userInfo.phone)
      users.push({
        phone: userInfo.phone,
        name: userInfo.name,
        connectedAt: userInfo.connectedAt
      })
    }
  })
  return users
}

// Broadcast online users ke admin SSE (separate channel)
function broadcastOnlineUsers() {
  const users = getOnlineUsers()
  // Use users.length for unique user count, not sseClients.size (which counts multiple tabs)
  const message = `data: ${JSON.stringify({ type: 'online_users', users, count: users.length })}\n\n`
  adminSseClients.forEach(client => {
    try {
      client.write(message)
    } catch (e) {
      adminSseClients.delete(client)
    }
  })
}

// SSE endpoint untuk admin (online users monitoring)
app.get('/admin-sse', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.flushHeaders()

  // Send initial online users data (count = unique users, not total connections)
  const users = getOnlineUsers()
  res.write(`data: ${JSON.stringify({ type: 'online_users', users, count: users.length })}\n\n`)

  adminSseClients.add(res)

  req.on('close', () => {
    adminSseClients.delete(res)
  })
})

// API untuk get online users (non-realtime)
app.get('/api/admin/online-users', (req, res) => {
  const { password } = req.query
  if (password !== ADMIN_PASSWORD) return res.json({ success: false, error: 'Unauthorized' })

  const users = getOnlineUsers()
  res.json({
    success: true,
    count: sseClients.size,
    uniqueUsers: users.length,
    users
  })
})

// API untuk broadcast notifikasi/promo ke semua user
// Contoh: /send-notif?title=Promo&message=Diskon%2050%25&type=promo
// type: promo, info, warning, urgent
app.get('/send-notif', (req, res) => {
  if (!requireAdminPassword(req, res)) return
  const { title, message, type = 'info' } = req.query

  if (!title || !message) {
    return res.json({ success: false, error: 'title dan message wajib diisi' })
  }

  const notifData = {
    type: 'notification',
    notifType: type, // promo, info, warning, urgent
    title: decodeURIComponent(title),
    message: decodeURIComponent(message),
    time: new Date().toISOString()
  }

  broadcastSSE(notifData)

  res.json({
    success: true,
    sent: sseClients.size,
    data: notifData
  })
})

// SSE Heartbeat - kirim ping setiap 5 detik untuk menjaga koneksi aktif dan responsif
setInterval(() => {
  if (sseClients.size > 0) {
    const heartbeat = `data: ${JSON.stringify({ type: 'heartbeat', time: Date.now(), clients: sseClients.size })}\n\n`
    sseClients.forEach(client => {
      try {
        client.write(heartbeat)
      } catch (e) {
        sseClients.delete(client)
      }
    })
  }
}, 5000)

// Log status setiap 30 detik
// Status log every 30s (silent - available via /stats)

// Serve icon.png dan favicon.ico
let iconBuffer = null
let faviconBuffer = null

try {
  iconBuffer = readFileSync(join(__dirname, 'icon.png'))
} catch (e) {
}

try {
  faviconBuffer = readFileSync(join(__dirname, 'favicon.ico'))
} catch (e) {
}

app.get('/icon.png', (_req, res) => {
  if (iconBuffer) {
    res.setHeader('Content-Type', 'image/png')
    res.send(iconBuffer)
  } else {
    res.status(404).send('Icon not found')
  }
})

// Rounded square icon (SVG) untuk PWA install — sudut membulat + padding safe-zone (maskable)
app.get('/icon-rounded.svg', (_req, res) => {
  res.setHeader('Content-Type', 'image/svg+xml')
  res.setHeader('Cache-Control', 'public, max-age=86400')
  const b64 = iconBuffer ? iconBuffer.toString('base64') : ''
  // Canvas 512, sudut rx=112 (~22%), logo dalam area aman 352px di tengah
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#0c1626"/>
      <stop offset="1" stop-color="#0a1322"/>
    </linearGradient>
    <clipPath id="r"><rect width="512" height="512" rx="112" ry="112"/></clipPath>
  </defs>
  <g clip-path="url(#r)">
    <rect width="512" height="512" fill="url(#bg)"/>
    ${b64 ? `<image href="data:image/png;base64,${b64}" x="80" y="80" width="352" height="352" preserveAspectRatio="xMidYMid meet"/>` : ''}
  </g>
</svg>`
  res.send(svg)
})

app.get('/favicon.ico', (_req, res) => {
  if (faviconBuffer) {
    res.setHeader('Content-Type', 'image/x-icon')
    res.send(faviconBuffer)
  } else if (iconBuffer) {
    res.setHeader('Content-Type', 'image/png')
    res.send(iconBuffer)
  } else {
    res.status(404).send('Favicon not found')
  }
})

// PWA Manifest
app.get('/manifest.json', (req, res) => {
  const host = req.get('host') || 'ts.muhamadaliyudin.xyz'
  res.json({
    name: 'Treasury Price',
    short_name: 'Treasury Price',
    description: 'Real-time Treasury Gold Price Monitor',
    start_url: '/monitoring',
    display: 'standalone',
    background_color: '#0f1419',
    theme_color: '#f7931a',
    icons: [
      {
        src: '/icon-rounded.svg',
        sizes: 'any',
        type: 'image/svg+xml',
        purpose: 'any maskable'
      },
      {
        src: '/icon.png',
        sizes: '192x192',
        type: 'image/png',
        purpose: 'any maskable'
      },
      {
        src: '/icon.png',
        sizes: '512x512',
        type: 'image/png',
        purpose: 'any maskable'
      }
    ],
    related_applications: [
      {
        platform: 'webapp',
        url: 'https://' + host + '/manifest.json'
      }
    ],
    prefer_related_applications: false
  })
})

// Service Worker for PWA - v4 dengan Push Notifications
app.get('/sw.js', (_req, res) => {
  res.setHeader('Content-Type', 'application/javascript')
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate')
  res.send(`
    const CACHE_VERSION = 'gold-monitor-v13';

    self.addEventListener('install', (e) => {
      self.skipWaiting();
      e.waitUntil(
        caches.open(CACHE_VERSION).then((cache) => {
          return cache.addAll(['/icon.png']);
        })
      );
    });

    self.addEventListener('activate', (e) => {
      e.waitUntil(
        caches.keys().then((keys) => {
          return Promise.all(
            keys.filter(k => k !== CACHE_VERSION).map(k => caches.delete(k))
          );
        }).then(() => self.clients.claim())
      );
    });

    self.addEventListener('fetch', (e) => {
      // Jangan intercept URL eksternal - biarkan browser handle sendiri
      if (!e.request.url.startsWith(self.location.origin)) return;
      const url = e.request.url;
      // Jangan intercept SSE - koneksi long-lived, biarkan browser handle
      if (url.includes('/sse')) return;
      // Jangan cache HTML dan API calls - selalu fetch fresh
      const noCache = e.request.mode === 'navigate'
        || url.includes('/monitoring') || url.includes('/login') || url.includes('/install')
        || url.includes('/price-history') || url.includes('/api/')
        || url.includes('/stats') || url.includes('/health');
      if (noCache) {
        e.respondWith(
          fetch(e.request).catch(() => {
            if (url.includes('/api/')) {
              return new Response(JSON.stringify({ success: false, error: 'Network error' }), {
                status: 503,
                headers: { 'Content-Type': 'application/json' }
              });
            }
            return new Response('Service unavailable', { status: 503 });
          })
        );
        return;
      }
      // Cache hanya untuk assets same-origin (icon, manifest)
      e.respondWith(
        caches.match(e.request).then((response) => {
          return response || fetch(e.request).catch(() => new Response('', { status: 503 }));
        })
      );
    });

    // Handle Push Notifications
    self.addEventListener('push', (e) => {
      let data = { title: 'Gold Price Monitor', body: 'Ada update baru!' };

      if (e.data) {
        try {
          data = e.data.json();
        } catch (err) {
          data.body = e.data.text();
        }
      }

      const options = {
        body: data.body,
        icon: data.icon || '/icon.png',
        badge: data.badge || '/icon.png',
        vibrate: [200, 100, 200],
        tag: data.type || 'notification',
        renotify: true,
        data: { url: data.url || '/monitoring' }
      };

      e.waitUntil(
        self.registration.showNotification(data.title, options)
      );
    });

    // Handle notification click
    self.addEventListener('notificationclick', (e) => {
      e.notification.close();

      const urlToOpen = e.notification.data?.url || '/monitoring';

      e.waitUntil(
        clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windowClients) => {
          // Check if there is already a window open
          for (let client of windowClients) {
            if (client.url.includes('/monitoring') && 'focus' in client) {
              return client.focus();
            }
          }
          // If no window open, open new one
          if (clients.openWindow) {
            return clients.openWindow(urlToOpen);
          }
        })
      );
    });
  `)
})

// ADMIN SSO — masuk panel admin langsung dari monitoring bila session milik nomor admin.
// Tidak perlu login ulang: cookie admin + token localStorage di-set otomatis.
app.get('/admin/sso', async (req, res) => {
  const session = req.query.session || ''
  try {
    const phone = session ? await redis.hget(REDIS_KEYS.SESSIONS, session) : null
    if (phone && (phone === 'admin' || ADMIN_PHONES.includes(phone))) {
      const token = Buffer.from(SUPER_ADMIN.username + ':' + SUPER_ADMIN.password + ':' + Date.now()).toString('base64')
      const maxAge = 12 * 60 * 60
      res.setHeader('Set-Cookie', `admin_auth=${encodeURIComponent(token)}; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}; Path=/`)
      pushLog(`Auth | SSO admin dari monitoring (+${phone})`)
      // Set juga token client-side (dipakai getAuthCheckScript) lalu redirect
      return res.send('<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Masuk Panel Admin...</title></head><body style="background:#000;color:#e7e9ea;font-family:sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;">' +
        '<p>Masuk ke panel admin...</p>' +
        '<script>try{localStorage.setItem("super_admin_token", ' + JSON.stringify(token) + ');}catch(e){} window.location.replace("/admin/users");</script>' +
        '</body></html>')
    }
  } catch (e) {
    console.error(`[${new Date().toISOString()}] [ADMIN_SSO_ERROR]`, e && e.message ? e.message : e)
  }
  res.redirect('/admin-login?redirect=' + encodeURIComponent('/admin/users'))
})

// ==================== ADMIN: Dokumentasi API Eksternal ====================
app.get('/admin/api-docs', (req, res) => {
  if (!isAdminCookieValid(req)) {
    return res.redirect('/admin-login?redirect=' + encodeURIComponent('/admin/api-docs'))
  }
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate')
  const baseUrl = 'https://' + (req.headers.host || 'ts.muhamadaliyudin.my.id')
  const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Dokumentasi API - Gold Price Monitor</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      background:
        radial-gradient(1000px 500px at 85% -10%, rgba(247,147,26,0.07), transparent 60%),
        linear-gradient(180deg, #070a10 0%, #0d1118 55%, #0a0e13 100%);
      background-attachment: fixed;
      min-height: 100vh; padding: 20px; color: #e7e9ea; line-height: 1.6;
    }
    .container { max-width: 860px; margin: 0 auto; }
    .header {
      padding: 18px 24px; margin-bottom: 24px;
      background: linear-gradient(135deg, rgba(24,30,40,0.95), rgba(16,21,30,0.95));
      border-radius: 16px; border: 1px solid rgba(247,147,26,0.14);
      display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 10px;
    }
    .header h1 { font-size: 1.3em; color: #fff; }
    .header h1 span { color: #f7931a; }
    .header a { color: #e7e9ea; text-decoration: none; padding: 8px 14px; background: rgba(255,255,255,0.06); border: 1px solid rgba(255,255,255,0.1); border-radius: 10px; font-size: 0.85em; }
    .header a:hover { color: #f7931a; border-color: rgba(247,147,26,0.3); }
    .card {
      background: linear-gradient(170deg, rgba(22,28,38,0.88), rgba(16,21,30,0.88));
      border-radius: 16px; padding: 24px; margin-bottom: 18px;
      border: 1px solid rgba(255,255,255,0.06);
    }
    h2 { color: #f7931a; font-size: 1.05em; margin-bottom: 12px; }
    h3 { color: #fff; font-size: 0.95em; margin: 18px 0 8px; }
    p, li { color: #b9c2cc; font-size: 0.9em; }
    ul { margin: 8px 0 8px 22px; }
    code { background: rgba(247,147,26,0.1); border: 1px solid rgba(247,147,26,0.2); color: #f7931a; padding: 1px 6px; border-radius: 5px; font-family: 'Courier New', monospace; font-size: 0.9em; }
    pre {
      background: #0a0a0a; border: 1px solid rgba(255,255,255,0.08); border-radius: 10px;
      padding: 14px 16px; overflow-x: auto; margin: 10px 0; font-size: 0.82em; line-height: 1.55;
      font-family: 'Courier New', monospace; color: #c9d1d9;
    }
    pre .k { color: #f7931a; }
    table { width: 100%; border-collapse: collapse; font-size: 0.85em; margin: 10px 0; }
    th { text-align: left; color: #8b949e; padding: 8px 10px; border-bottom: 1px solid rgba(255,255,255,0.1); font-weight: 600; }
    td { padding: 8px 10px; border-bottom: 1px solid rgba(255,255,255,0.04); color: #c9d1d9; }
    .method { display: inline-block; background: rgba(34,197,94,0.15); color: #4ade80; border: 1px solid rgba(34,197,94,0.3); padding: 2px 8px; border-radius: 6px; font-weight: 700; font-size: 0.85em; font-family: monospace; margin-right: 8px; }
    .badge-warn { background: rgba(251,191,36,0.12); color: #fbbf24; border: 1px solid rgba(251,191,36,0.3); padding: 2px 8px; border-radius: 6px; font-size: 0.8em; font-weight: 600; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1><span>API</span> Dokumentasi — Gold Price Monitor</h1>
      <a href="/admin/users">&larr; Kembali ke Panel Admin</a>
    </div>

    <div class="card">
      <h2>1. Pengantar</h2>
      <p>API eksternal untuk mengambil data harga emas Treasury, riwayat harga, status promo, dan data pasar secara real-time dari luar aplikasi (bot, spreadsheet, aplikasi lain, dll).</p>
      <h3>Base URL</h3>
      <pre>${baseUrl}</pre>
      <h3>Autentikasi</h3>
      <p>Semua endpoint membutuhkan <b>API key</b>. Generate/nonaktifkan key di <b>Panel Admin &rarr; Pengaturan &rarr; API Eksternal</b>. Kirim key dengan salah satu cara:</p>
      <ul>
        <li>Header: <code>X-API-Key: trs_xxxxx</code> (disarankan)</li>
        <li>Query string: <code>?api_key=trs_xxxxx</code></li>
      </ul>
      <h3>Rate Limit</h3>
      <p>Tidak ada batas request. Catatan: data harga diperbarui tiap ±1 menit, jadi polling 1x per menit sudah optimal.</p>
    </div>

    <div class="card">
      <h2>2. Endpoint</h2>

      <h3><span class="method">GET</span>/api/v1/price</h3>
      <p>Harga emas Treasury terkini beserta spread, kurs, XAU, status promo, dan tertinggi/terendah hari ini.</p>
      <pre>curl -H "X-API-Key: trs_xxxxx" ${baseUrl}/api/v1/price</pre>
      <pre>{
  "success": true,
  "data": {
    "buy": 2504224,            // harga beli (Rp/gram)
    "sell": 2420943,           // harga jual (Rp/gram)
    "spreadPercent": -3.33,    // selisih jual vs beli (%)
    "usdIdr": 18005,           // kurs USD/IDR
    "xauUsd": 4182.94,         // harga emas dunia (USD/oz)
    "promoStatus": "ON",       // status promo: ON / OFF
    "dailyHigh": 2509092,      // beli tertinggi hari ini
    "dailyLow": 2498929,       // beli terendah hari ini
    "titikOn": 2499141,        // Titik ON: beli terendah saat promo ON (null jika belum ada)
    "titikOnDate": "2026-07-06", // tanggal WIB titik ON tercatat
    "updatedAt": "2026-07-06 07:00:01",
    "serverTime": "2026-07-06T00:00:05.123Z"
  }
}</pre>

      <h3><span class="method">GET</span>/api/v1/history</h3>
      <p>Riwayat harga per menit, terbaru dulu. Parameter: <code>limit</code> (default 100, maksimal 500).</p>
      <pre>curl -H "X-API-Key: trs_xxxxx" "${baseUrl}/api/v1/history?limit=10"</pre>
      <pre>{
  "success": true,
  "total": 1257,
  "count": 10,
  "data": [
    {
      "time": "07:00:01", "buy": 2504224, "sell": 2420943,
      "buyChange": 42, "sellChange": 98, "spread": -3.3,
      "usdIdr": 18005, "xauUsd": 4182.94,
      "markup": 348, "markupStatus": "MARKUP"
    }
  ]
}</pre>

      <h3><span class="method">GET</span>/api/v1/promo-status</h3>
      <p>Status promo Treasury saat ini.</p>
      <pre>curl -H "X-API-Key: trs_xxxxx" ${baseUrl}/api/v1/promo-status</pre>
      <pre>{ "success": true, "data": { "status": "ON", "serverTime": "..." } }</pre>

      <h3><span class="method">GET</span>/api/v1/titik-on</h3>
      <p>Titik ON — harga beli terendah yang tercatat saat promo ON (direset saat promo OFF berkelanjutan / server tracking ulang). <code>titikOn</code> bernilai <code>null</code> bila belum ada catatan.</p>
      <pre>curl -H "X-API-Key: trs_xxxxx" ${baseUrl}/api/v1/titik-on</pre>
      <pre>{
  "success": true,
  "data": {
    "titikOn": 2499141,        // Rp/gram
    "date": "2026-07-06",      // tanggal WIB tercatat
    "promoStatus": "ON",
    "serverTime": "..."
  }
}</pre>

      <h3><span class="method">GET</span>/api/v1/market</h3>
      <p>Data pasar: harga emas dunia dan kurs.</p>
      <pre>curl -H "X-API-Key: trs_xxxxx" ${baseUrl}/api/v1/market</pre>
      <pre>{ "success": true, "data": { "xauUsd": 4182.94, "usdIdr": 18005, "serverTime": "..." } }</pre>
    </div>

    <div class="card">
      <h2>3. Contoh Kode</h2>
      <h3>JavaScript (fetch)</h3>
      <pre>const res = await fetch('${baseUrl}/api/v1/price', {
  headers: { 'X-API-Key': 'trs_xxxxx' }
});
const json = await res.json();
console.log(json.data.buy); // 2504224</pre>
      <h3>Python (requests)</h3>
      <pre>import requests
r = requests.get('${baseUrl}/api/v1/price',
                 headers={'X-API-Key': 'trs_xxxxx'})
print(r.json()['data']['buy'])</pre>
      <h3>Google Sheets (Apps Script)</h3>
      <pre>function hargaEmas() {
  var r = UrlFetchApp.fetch('${baseUrl}/api/v1/price',
    { headers: { 'X-API-Key': 'trs_xxxxx' } });
  return JSON.parse(r.getContentText()).data.buy;
}</pre>
    </div>

    <div class="card">
      <h2>4. Kode Error</h2>
      <table>
        <tr><th>Kode</th><th>Arti</th><th>Solusi</th></tr>
        <tr><td><code>401</code></td><td>API key tidak dikirim / tidak dikenal</td><td>Periksa header X-API-Key</td></tr>
        <tr><td><code>403</code></td><td>API key dinonaktifkan admin</td><td>Aktifkan lagi di Panel Admin &rarr; Pengaturan</td></tr>
        <tr><td><code>500</code></td><td>Error internal server</td><td>Coba lagi; cek log Koyeb</td></tr>
      </table>
      <h3>Catatan</h3>
      <ul>
        <li>Semua endpoint mendukung <b>CORS</b> — bisa dipanggil langsung dari browser/frontend domain lain.</li>
        <li>API key baru aktif maksimal 5 menit setelah dibuat di server lain (cache), biasanya langsung.</li>
        <li>Statistik pemakaian (hits, last used) direset saat server restart.</li>
      </ul>
    </div>
  </div>
</body>
</html>`
  res.send(html)
})

// ADMIN LOGOUT
app.get('/admin/logout', (req, res) => {
  res.setHeader('Set-Cookie', 'admin_auth=; HttpOnly; Secure; SameSite=Lax; Max-Age=0; Path=/')
  res.redirect('/admin-login')
})

// ADMIN PAGE - Broadcast Notifications
app.get('/admin/monitoring', (req, res) => {
  if (!isAdminCookieValid(req)) {
    return res.redirect('/admin-login?redirect=' + encodeURIComponent('/admin/monitoring'))
  }
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate')
  const authScript = getAuthCheckScript('/admin/monitoring')
  const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>body,*{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;}</style>
  <title>Admin - Gold Price Monitor</title>
${authScript}
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      background:
        radial-gradient(1000px 500px at 85% -10%, rgba(247,147,26,0.07), transparent 60%),
        radial-gradient(800px 400px at -10% 20%, rgba(59,130,246,0.05), transparent 55%),
        linear-gradient(180deg, #070a10 0%, #0d1118 55%, #0a0e13 100%);
      background-attachment: fixed;
      min-height: 100vh;
      padding: 20px;
      color: #e7e9ea;
    }
    .container { max-width: 640px; margin: 0 auto; }

    .header {
      text-align: center;
      margin-bottom: 24px;
      padding: 24px;
      background: linear-gradient(135deg, rgba(24,30,40,0.95), rgba(16,21,30,0.95));
      backdrop-filter: blur(20px);
      border-radius: 20px;
      border: 1px solid rgba(247,147,26,0.14);
      box-shadow: 0 8px 32px rgba(0,0,0,0.3), inset 0 1px 0 rgba(255,255,255,0.04);
      position: relative;
      overflow: hidden;
    }
    .header::before {
      content: '';
      position: absolute;
      top: 0; left: 0; right: 0;
      height: 2px;
      background: linear-gradient(90deg, transparent, #f7931a, transparent);
      opacity: 0.7;
    }
    .header h1 {
      color: #ffffff;
      font-size: 1.5em;
      font-weight: 700;
      margin-bottom: 6px;
      letter-spacing: -0.02em;
    }
    .header h1 span { color: #f7931a; }
    .header p { color: #8b949e; font-size: 0.9em; }

    .stats-bar {
      display: flex;
      justify-content: center;
      gap: 16px;
      margin-bottom: 24px;
    }
    .stat-item {
      text-align: center;
      background: linear-gradient(160deg, rgba(24,30,40,0.9), rgba(16,21,30,0.9));
      backdrop-filter: blur(10px);
      padding: 20px 32px;
      border-radius: 16px;
      border: 1px solid rgba(255,255,255,0.06);
      flex: 1;
      max-width: 200px;
      transition: all 0.2s;
    }
    .stat-item:hover { border-color: rgba(247,147,26,0.25); transform: translateY(-2px); }
    .stat-value { font-size: 2em; font-weight: 700; color: #f7931a; font-family: 'JetBrains Mono', monospace; text-shadow: 0 0 20px rgba(247,147,26,0.25); }
    .stat-label { font-size: 0.8em; color: #8b949e; margin-top: 4px; font-weight: 500; }

    .card {
      background: linear-gradient(170deg, rgba(22,28,38,0.88), rgba(16,21,30,0.88));
      backdrop-filter: blur(20px);
      border-radius: 20px;
      padding: 24px;
      margin-bottom: 20px;
      border: 1px solid rgba(255,255,255,0.06);
      box-shadow: 0 8px 32px rgba(0,0,0,0.2), inset 0 1px 0 rgba(255,255,255,0.03);
      transition: border-color 0.2s;
    }
    .card:hover { border-color: rgba(255,255,255,0.1); }
    .card h2 {
      color: #ffffff;
      font-size: 1.1em;
      font-weight: 600;
      margin-bottom: 20px;
      padding-bottom: 12px;
      border-bottom: 1px solid rgba(255,255,255,0.06);
      letter-spacing: -0.02em;
    }

    .form-group { margin-bottom: 18px; }
    .form-group label {
      display: block;
      margin-bottom: 8px;
      color: #8b949e;
      font-size: 0.85em;
      font-weight: 500;
    }
    .form-group input, .form-group textarea, .form-group select {
      width: 100%;
      padding: 14px 16px;
      border: 2px solid rgba(255,255,255,0.08);
      border-radius: 12px;
      background: rgba(15, 20, 25, 0.8);
      color: #e7e9ea;
      font-size: 0.95em;
      font-family: inherit;
      transition: all 0.2s ease;
    }
    .form-group input:focus, .form-group textarea:focus, .form-group select:focus {
      outline: none;
      border-color: #f7931a;
      box-shadow: 0 0 0 4px rgba(247,147,26,0.15);
    }
    .form-group textarea { resize: vertical; min-height: 100px; }

    .type-buttons {
      display: grid;
      grid-template-columns: repeat(4, 1fr);
      gap: 12px;
    }
    .type-btn {
      padding: 14px 10px;
      border: 2px solid rgba(255,255,255,0.08);
      border-radius: 14px;
      background: rgba(15, 20, 25, 0.8);
      color: #8b949e;
      cursor: pointer;
      text-align: center;
      transition: all 0.2s ease;
      font-family: inherit;
    }
    .type-btn:hover { border-color: rgba(247,147,26,0.5); background: rgba(247,147,26,0.08); }
    .type-btn.active { border-color: #f7931a; color: #f7931a; background: rgba(247,147,26,0.12); }
    .type-btn .icon { font-size: 1.6em; display: block; margin-bottom: 6px; }
    .type-btn .label { font-size: 0.8em; font-weight: 500; }

    .btn {
      width: 100%;
      padding: 16px;
      border: none;
      border-radius: 14px;
      font-size: 1em;
      font-weight: 600;
      cursor: pointer;
      transition: all 0.2s ease;
      font-family: inherit;
    }
    .btn-primary {
      background: linear-gradient(135deg, #f7931a 0%, #e8850f 100%);
      color: white;
      box-shadow: 0 4px 20px rgba(247,147,26,0.35);
    }
    .btn-primary:hover { transform: translateY(-2px); box-shadow: 0 8px 30px rgba(247,147,26,0.45); }
    .btn-primary:disabled { opacity: 0.5; cursor: not-allowed; transform: none; }

    .result {
      margin-top: 16px;
      padding: 14px 16px;
      border-radius: 12px;
      display: none;
      font-weight: 500;
    }
    .result.success { display: block; background: rgba(34,197,94,0.12); border: 1px solid rgba(34,197,94,0.3); color: #4ade80; }
    .result.error { display: block; background: rgba(239,68,68,0.12); border: 1px solid rgba(239,68,68,0.3); color: #f87171; }

    .history { max-height: 320px; overflow-y: auto; }
    .history-item {
      padding: 14px 16px;
      background: rgba(15, 20, 25, 0.8);
      border-radius: 12px;
      margin-bottom: 10px;
      border-left: 4px solid #f7931a;
    }
    .history-item .time { font-size: 0.8em; color: #8b949e; }
    .history-item .title { font-weight: 600; color: #ffffff; margin-top: 4px; }
    .history-item .message { font-size: 0.85em; color: #8b949e; margin-top: 4px; line-height: 1.4; }
    .history-item.promo { border-left-color: #4ade80; }
    .history-item.warning { border-left-color: #fbbf24; }
    .history-item.urgent { border-left-color: #f87171; }

    .empty-state { text-align: center; color: #8b949e; padding: 40px; font-size: 0.95em; }

    .back-link {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      color: #8b949e;
      text-decoration: none;
      font-size: 0.9em;
      margin-bottom: 16px;
      transition: color 0.2s;
    }
    .back-link:hover { color: #f7931a; }

    @media (max-width: 480px) {
      body { padding: 12px; }
      .header { padding: 20px; border-radius: 16px; }
      .card { padding: 20px; border-radius: 16px; }
      .type-buttons { grid-template-columns: repeat(2, 1fr); }
      .stat-item { padding: 16px 20px; }
      .stat-value { font-size: 1.6em; }
    }
  </style>
</head>
<body>
  <div class="container">
    <a href="/admin/users" class="back-link">← Kembali ke Kelola User</a>
    <div class="header">
      <h1><span>Admin</span> Panel</h1>
      <p>Gold Price Monitor - Broadcast Notifications</p>
    </div>

    <div class="stats-bar">
      <div class="stat-item">
        <div class="stat-value" id="clientCount">-</div>
        <div class="stat-label">Online Users</div>
      </div>
      <div class="stat-item">
        <div class="stat-value" id="sentCount">0</div>
        <div class="stat-label">Sent Today</div>
      </div>
    </div>

    <div class="card">
      <h2>Kirim Notifikasi</h2>
      <form id="notifForm">
        <div class="form-group">
          <label>Tipe Notifikasi</label>
          <div class="type-buttons">
            <div class="type-btn active" data-type="info">
              <span class="icon"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 11l19-9-9 19-2-8-8-2z"/></svg></span>
              <span class="label">Info</span>
            </div>
            <div class="type-btn" data-type="promo">
              <span class="icon"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z"/><line x1="7" y1="7" x2="7.01" y2="7"/></svg></span>
              <span class="label">Promo</span>
            </div>
            <div class="type-btn" data-type="warning">
              <span class="icon"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg></span>
              <span class="label">Warning</span>
            </div>
            <div class="type-btn" data-type="urgent">
              <span class="icon"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg></span>
              <span class="label">Urgent</span>
            </div>
          </div>
        </div>
        <div class="form-group">
          <label>Judul</label>
          <input type="text" id="notifTitle" placeholder="Contoh: Promo Spesial!" required>
        </div>
        <div class="form-group">
          <label>Pesan</label>
          <textarea id="notifMessage" placeholder="Contoh: Dapatkan diskon 10% untuk pembelian emas hari ini!" required></textarea>
        </div>
        <button type="submit" class="btn btn-primary" id="sendBtn">
          Kirim Notifikasi
        </button>
        <div class="result" id="result"></div>
      </form>
    </div>

    <div class="card">
      <h2>Riwayat Notifikasi</h2>
      <div class="history" id="history">
        <div class="empty-state">Belum ada notifikasi dikirim</div>
      </div>
    </div>
  </div>

  <script>
    let selectedType = 'info';
    let sentCount = 0;
    const history = [];

    // Type button selection
    document.querySelectorAll('.type-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.type-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        selectedType = btn.dataset.type;
      });
    });

    // Fetch client count
    async function updateClientCount() {
      try {
        const res = await fetch('/stats');
        const data = await res.json();
        document.getElementById('clientCount').textContent = data.sseClients || 0;
      } catch(e) {
        document.getElementById('clientCount').textContent = '-';
      }
    }
    updateClientCount();
    setInterval(updateClientCount, 5000);

    // Form submit
    document.getElementById('notifForm').addEventListener('submit', async (e) => {
      e.preventDefault();

      const title = document.getElementById('notifTitle').value.trim();
      const message = document.getElementById('notifMessage').value.trim();
      const btn = document.getElementById('sendBtn');
      const result = document.getElementById('result');

      if (!title || !message) return;

      btn.disabled = true;
      btn.textContent = 'Mengirim...';

      try {
        const url = '/send-notif?title=' + encodeURIComponent(title) + '&message=' + encodeURIComponent(message) + '&type=' + selectedType;
        const res = await fetch(url);
        const data = await res.json();

        if (data.success) {
          result.className = 'result success';
          result.textContent = 'Notifikasi berhasil dikirim ke ' + data.sent + ' user!';

          // Add to history
          sentCount++;
          document.getElementById('sentCount').textContent = sentCount;
          addToHistory({ type: selectedType, title, message, time: new Date().toISOString(), sent: data.sent });

          // Reset form
          document.getElementById('notifTitle').value = '';
          document.getElementById('notifMessage').value = '';
        } else {
          result.className = 'result error';
          result.textContent = 'Gagal: ' + (data.error || 'Unknown error');
        }
      } catch(err) {
        result.className = 'result error';
        result.textContent = 'Error: ' + err.message;
      }

      btn.disabled = false;
      btn.textContent = 'Kirim Notifikasi';

      setTimeout(() => { result.className = 'result'; }, 5000);
    });

    function addToHistory(item) {
      history.unshift(item);
      renderHistory();
    }

    function renderHistory() {
      const container = document.getElementById('history');
      if (history.length === 0) {
        container.innerHTML = '<div class="empty-state">Belum ada notifikasi dikirim</div>';
        return;
      }

      container.innerHTML = history.map(item => {
        const time = new Date(item.time).toLocaleTimeString('id-ID');
        return '<div class="history-item ' + item.type + '">' +
          '<div class="time">' + time + ' - Terkirim ke ' + item.sent + ' user</div>' +
          '<div class="title">' + item.title + '</div>' +
          '<div class="message">' + item.message + '</div>' +
        '</div>';
      }).join('');
    }
  </script>
</body>
</html>`;
  res.send(html);
})

// ==================== USER AUTHENTICATION SYSTEM ====================

// Helper: Generate session ID
function generateSessionId() {
  return 'sess_' + Math.random().toString(36).substr(2, 9) + Date.now().toString(36)
}

// Helper: Normalize phone number (remove +62, 62, 0 prefix -> just numbers)
function normalizePhone(phone) {
  let clean = phone.replace(/\D/g, '')
  // Remove leading 0 or 62
  if (clean.startsWith('62')) clean = clean.substring(2)
  if (clean.startsWith('0')) clean = clean.substring(1)
  // Always return with 62 prefix for consistency with database
  return '62' + clean
}

// Helper: Check if user is valid (exists and not expired)
async function isUserValid(phone) {
  try {
    // Admin internal selalu valid
    if (phone === 'admin') {
      return { valid: true, user: { name: 'Administrator', phone: 'admin', isAdmin: true } }
    }

    // Nomor admin permanen — selalu bisa login meski dihapus dari user list
    if (phone === ADMIN_PHONE) {
      const stored = await redis.hget(REDIS_KEYS.USERS, phone)
      const user = stored ? (typeof stored === 'string' ? JSON.parse(stored) : stored) : { name: 'Admin', phone: ADMIN_PHONE }
      return { valid: true, user }
    }

    const userData = await redis.hget(REDIS_KEYS.USERS, phone)
    if (!userData) return { valid: false, reason: 'not_found' }

    const user = typeof userData === 'string' ? JSON.parse(userData) : userData
    const now = Date.now()

    if (user.expired && now > user.expired) {
      return { valid: false, reason: 'expired', user }
    }

    return { valid: true, user }
  } catch (e) {
    return { valid: false, reason: 'error' }
  }
}

// API: Request OTP for registration
app.post('/api/request-otp', express.json(), async (req, res) => {
  const { phone } = req.body
  if (!phone) return res.json({ success: false, error: 'Nomor HP wajib diisi' })

  const normalizedPhone = normalizePhone(phone)

  // Check if already registered
  const existing = await redis.hget(REDIS_KEYS.USERS, normalizedPhone)
  if (existing) {
    return res.json({ success: false, error: 'Nomor sudah terdaftar. Silakan login.' })
  }

  // Check if WhatsApp is connected
  if (!sock || !isReady) {
    return res.json({ success: false, error: 'WhatsApp tidak terhubung. Coba lagi nanti.' })
  }

  // Generate 6-digit OTP
  const otp = Math.floor(100000 + Math.random() * 900000).toString()

  // Store OTP with 5 minute expiry
  await redis.hset(REDIS_KEYS.OTP_CODES, { [normalizedPhone]: JSON.stringify({ otp, expires: Date.now() + 5 * 60 * 1000 }) })

  // Send OTP via WhatsApp
  try {
    const jid = `${normalizedPhone}@s.whatsapp.net`
    await sock.sendMessage(jid, {
      text: `🔐 *Kode OTP Gold Price Monitor*\n\nKode verifikasi Anda: *${otp}*\n\nKode berlaku 5 menit.\nJangan bagikan kode ini kepada siapapun.`
    })

    pushLog(`OTP | Sent to +${normalizedPhone}`)
    res.json({ success: true, message: 'Kode OTP telah dikirim ke WhatsApp Anda' })
  } catch (e) {
    pushLog(`OTP | Failed to send to +${normalizedPhone}: ${e.message}`)
    res.json({ success: false, error: 'Gagal mengirim OTP. Pastikan nomor WhatsApp aktif.' })
  }
})

// API: Verify OTP and register user
app.post('/api/verify-otp', express.json(), async (req, res) => {
  const { phone, otp, name } = req.body
  if (!phone || !otp) return res.json({ success: false, error: 'Nomor dan OTP wajib diisi' })

  const normalizedPhone = normalizePhone(phone)

  // Get stored OTP
  const stored = await redis.hget(REDIS_KEYS.OTP_CODES, normalizedPhone)
  if (!stored) {
    return res.json({ success: false, error: 'OTP tidak ditemukan. Minta OTP baru.' })
  }

  const otpData = typeof stored === 'string' ? JSON.parse(stored) : stored

  // Check expiry
  if (Date.now() > otpData.expires) {
    await redis.hdel(REDIS_KEYS.OTP_CODES, normalizedPhone)
    return res.json({ success: false, error: 'OTP sudah expired. Minta OTP baru.' })
  }

  // Verify OTP
  if (otp !== otpData.otp) {
    return res.json({ success: false, error: 'OTP salah' })
  }

  // OTP valid - register user
  const userData = {
    name: name || 'User ' + normalizedPhone,
    createdAt: Date.now(),
    expired: null,
    source: 'otp_registration'
  }

  await redis.hset(REDIS_KEYS.USERS, { [normalizedPhone]: JSON.stringify(userData) })
  await redis.hdel(REDIS_KEYS.OTP_CODES, normalizedPhone)

  // Create session
  const sessionId = generateSessionId()
  await redis.hset(REDIS_KEYS.SESSIONS, { [sessionId]: normalizedPhone })

  pushLog(`OTP | User registered: +${normalizedPhone}`)
  res.json({ success: true, sessionId, user: userData })
})

// API: Login user
// Helper: Get default PIN (000000 for all users)
function getDefaultPin(phone) {
  return '000000'
}

// Helper: Simple hash PIN for security (not storing plain text)
function hashPin(pin) {
  // Simple hash using base64 encoding with salt
  const salt = 'goldmonitor2024'
  const combined = pin + salt
  return Buffer.from(combined).toString('base64')
}

// Helper: Verify PIN
function verifyPin(inputPin, storedHash) {
  return hashPin(inputPin) === storedHash
}

// API: Check user exists (step 1 of login)
app.post('/api/check-user', rateLimit(10, 60000), express.json(), async (req, res) => {
  const { phone } = req.body
  if (!phone) return res.json({ success: false, error: 'Nomor HP wajib diisi' })

  // Verifikasi Cloudflare Turnstile (anti-bot) — hanya aktif bila TURNSTILE_SECRET_KEY diset
  const tsOk = await verifyTurnstile(req.body['cf-turnstile-response'], req.ip)
  if (!tsOk) return res.json({ success: false, error: 'Verifikasi keamanan gagal. Muat ulang halaman dan coba lagi.' })

  const normalizedPhone = normalizePhone(phone)
  const check = await isUserValid(normalizedPhone)

  if (!check.valid) {
    if (check.reason === 'not_found') {
      return res.json({ success: false, error: 'Nomor tidak terdaftar. Silakan daftar dulu.', needRegister: true })
    }
    if (check.reason === 'expired') {
      return res.json({ success: false, error: 'Akun sudah expired. Hubungi admin untuk perpanjang.' })
    }
    return res.json({ success: false, error: 'Terjadi kesalahan' })
  }

  // Check if user has PIN set
  const pinData = await redis.hget(REDIS_KEYS.USER_PINS, normalizedPhone)
  let pinChanged = false
  if (pinData) {
    try {
      const parsed = typeof pinData === 'string' ? JSON.parse(pinData) : pinData
      pinChanged = parsed.pinChanged || false
    } catch (e) {}
  }

  res.json({
    success: true,
    user: { name: check.user.name },
    pinChanged // true if user already changed default PIN
  })
})

// API: Login with PIN (step 2 of login)
app.post('/api/login', rateLimit(5, 60000), express.json(), async (req, res) => {
  const { phone, pin } = req.body
  if (!phone) return res.json({ success: false, error: 'Nomor HP wajib diisi' })
  if (!pin) return res.json({ success: false, error: 'PIN wajib diisi' })

  const normalizedPhone = normalizePhone(phone)
  const check = await isUserValid(normalizedPhone)

  if (!check.valid) {
    if (check.reason === 'not_found') {
      return res.json({ success: false, error: 'Nomor tidak terdaftar. Silakan daftar dulu.', needRegister: true })
    }
    if (check.reason === 'expired') {
      return res.json({ success: false, error: 'Akun sudah expired. Hubungi admin untuk perpanjang.' })
    }
    return res.json({ success: false, error: 'Terjadi kesalahan' })
  }

  // Check PIN
  const pinData = await redis.hget(REDIS_KEYS.USER_PINS, normalizedPhone)
  let storedPin = null
  let pinChanged = false

  if (pinData) {
    try {
      const parsed = typeof pinData === 'string' ? JSON.parse(pinData) : pinData
      storedPin = parsed.pin
      pinChanged = parsed.pinChanged || false
    } catch (e) {}
  }

  // If no PIN set, use default PIN (first 6 digits of phone)
  if (!storedPin) {
    const defaultPin = getDefaultPin(normalizedPhone)
    storedPin = hashPin(defaultPin)
    // Save default PIN to database
    await redis.hset(REDIS_KEYS.USER_PINS, {
      [normalizedPhone]: JSON.stringify({ pin: storedPin, pinChanged: false })
    })
    pinChanged = false
  }

  // Verify PIN
  if (!verifyPin(pin, storedPin)) {
    return res.json({ success: false, error: 'PIN salah. Silakan coba lagi.' })
  }

  const _clientIp = getClientIp(req)
  const _clientUa = parseBrowser(req.headers['user-agent'])

  // Login ulang dari device yang sama: ganti session lama milik device ini,
  // JANGAN menendang device lain (mencegah ping-pong logout antar device user sendiri)
  const { oldSession } = req.body
  if (oldSession) {
    try {
      const oldPhone = await redis.hget(REDIS_KEYS.SESSIONS, oldSession)
      if (oldPhone === normalizedPhone) {
        await redis.hdel(REDIS_KEYS.SESSIONS, oldSession)
        await redis.hdel(REDIS_KEYS.SESSION_META, oldSession)
      }
    } catch (e) {}
  }

  // Check existing sessions (max 2 devices, kecuali admin phone tidak ada limit).
  // Device lama ditendang dan ditandai agar dapat notif "login di perangkat lain".
  if (normalizedPhone !== ADMIN_PHONE) {
    const allSessions = await redis.hgetall(REDIS_KEYS.SESSIONS) || {}
    const userSessions = []
    for (const [sessId, sessPhone] of Object.entries(allSessions)) {
      if (sessPhone === normalizedPhone) userSessions.push(sessId)
    }
    while (userSessions.length >= 3) { // max 3 device per user
      const oldSess = userSessions.shift()
      const _kickedMetaRaw = await redis.hget(REDIS_KEYS.SESSION_META, oldSess)
      const _kickedMeta = _kickedMetaRaw ? JSON.parse(_kickedMetaRaw) : {}
      await redis.hdel(REDIS_KEYS.SESSIONS, oldSess)
      await redis.hdel(REDIS_KEYS.SESSION_META, oldSess)
      await redis.hset(REDIS_KEYS.KICKED_SESSIONS, { [oldSess]: Date.now().toString() })
      const _kickWib = new Date(Date.now() + 7 * 60 * 60 * 1000).toISOString().replace('T', ' ').substring(0, 19)
      const _kickName = check.user?.name || '-'
      pushLog(`Auth | KICKED +${normalizedPhone} (${_kickName}) — sesi lama ditendang (login perangkat baru)`)
      const _kickEntry = { time: _kickWib, phone: normalizedPhone, name: _kickName, event: 'kicked', ip: _kickedMeta.ip || '-', ua: _kickedMeta.ua || '-', location: _kickedMeta.location || '-' }
      loginHistory.push(_kickEntry)
      if (loginHistory.length > MAX_LOGIN_HISTORY) loginHistory.shift()
    }
  }

  // Create new session
  const sessionId = generateSessionId()
  await redis.hset(REDIS_KEYS.SESSIONS, { [sessionId]: normalizedPhone })
  await redis.hset(REDIS_KEYS.SESSION_META, { [sessionId]: JSON.stringify({ ip: _clientIp, ua: _clientUa, location: '' }) })

  // Catat ke login history (LOGIN di-push setelah KICKED agar saat .reverse() LOGIN muncul di atas)
  const _loginWib = new Date(Date.now() + 7 * 60 * 60 * 1000).toISOString().replace('T', ' ').substring(0, 19)
  const _loginName = check.user?.name || '-'
  pushLog(`Auth | LOGIN +${normalizedPhone} (${_loginName}) — ${_clientIp} — ${_clientUa}`)
  const _loginEntry = { time: _loginWib, phone: normalizedPhone, name: _loginName, ip: _clientIp, ua: _clientUa, location: '-' }
  loginHistory.push(_loginEntry)
  if (loginHistory.length > MAX_LOGIN_HISTORY) loginHistory.shift()
  // Lookup lokasi async — update entry & session meta tanpa blokir response
  getIpLocation(_clientIp).then(loc => {
    _loginEntry.location = loc
    redis.hset(REDIS_KEYS.SESSION_META, { [sessionId]: JSON.stringify({ ip: _clientIp, ua: _clientUa, location: loc }) }).catch(() => {})
  })

  res.json({
    success: true,
    sessionId,
    user: check.user,
    // Nomor admin tidak pernah dipaksa ganti PIN
    requirePinChange: normalizedPhone === ADMIN_PHONE ? false : !pinChanged
  })
})

// API: Change PIN
app.post('/api/change-pin', express.json(), async (req, res) => {
  const { session, oldPin, newPin } = req.body

  if (!session) return res.json({ success: false, error: 'Session tidak valid' })
  if (!newPin || newPin.length !== 6 || !/^\d{6}$/.test(newPin)) {
    return res.json({ success: false, error: 'PIN baru harus 6 digit angka' })
  }

  const phone = await redis.hget(REDIS_KEYS.SESSIONS, session)
  if (!phone) return res.json({ success: false, error: 'Session tidak valid' })

  // Get current PIN
  const pinData = await redis.hget(REDIS_KEYS.USER_PINS, phone)
  let storedPin = null
  let pinChanged = false

  if (pinData) {
    try {
      const parsed = typeof pinData === 'string' ? JSON.parse(pinData) : pinData
      storedPin = parsed.pin
      pinChanged = parsed.pinChanged || false
    } catch (e) {}
  }

  // If PIN already changed, verify old PIN
  if (pinChanged && oldPin) {
    if (!verifyPin(oldPin, storedPin)) {
      return res.json({ success: false, error: 'PIN lama salah' })
    }
  }

  // Save new PIN
  const newPinHash = hashPin(newPin)
  await redis.hset(REDIS_KEYS.USER_PINS, {
    [phone]: JSON.stringify({ pin: newPinHash, pinChanged: true })
  })

  pushLog(`Auth | User +${phone} changed PIN`)
  res.json({ success: true, message: 'PIN berhasil diubah' })
})

// API: Check if PIN needs to be changed
app.get('/api/check-pin-status', async (req, res) => {
  const session = req.query.session
  if (!session) return res.json({ success: false })

  const phone = await redis.hget(REDIS_KEYS.SESSIONS, session)
  if (!phone) return res.json({ success: false })

  // Admin doesn't need PIN (baik akun internal maupun nomor admin)
  if (phone === 'admin' || phone === ADMIN_PHONE) {
    return res.json({ success: true, pinChanged: true, requirePinChange: false })
  }

  const pinData = await redis.hget(REDIS_KEYS.USER_PINS, phone)
  let pinChanged = false

  if (pinData) {
    try {
      const parsed = typeof pinData === 'string' ? JSON.parse(pinData) : pinData
      pinChanged = parsed.pinChanged || false
    } catch (e) {}
  }

  res.json({ success: true, pinChanged, requirePinChange: !pinChanged })
})

// API: Verify session
// Refresh session monitoring untuk admin: cookie admin masih valid tapi session
// monitoring hilang dari Redis (mis. terhapus reset lama / eviction) — terbitkan
// session baru otomatis tanpa perlu login ulang.
app.get('/api/admin-session-refresh', async (req, res) => {
  if (!isAdminCookieValid(req)) return res.json({ success: false })
  try {
    const adminSessionId = 'admin_' + crypto.randomBytes(16).toString('hex')
    await redis.hset(REDIS_KEYS.SESSIONS, { [adminSessionId]: 'admin' })
    pushLog('Auth | Session monitoring admin di-refresh otomatis (cookie masih valid)')
    res.json({ success: true, sessionId: adminSessionId })
  } catch (e) {
    res.json({ success: false })
  }
})

app.get('/api/verify-session', async (req, res) => {
  try {
    const sessionId = req.query.session
    if (!sessionId) return res.json({ valid: false })

    const phone = await redis.hget(REDIS_KEYS.SESSIONS, sessionId)
    if (!phone) {
      // Session hilang — cek apakah ditendang karena login di perangkat lain
      try {
        const kicked = await redis.hget(REDIS_KEYS.KICKED_SESSIONS, sessionId)
        if (kicked) {
          await redis.hdel(REDIS_KEYS.KICKED_SESSIONS, sessionId)
          return res.json({ valid: false, reason: 'kicked_other_device' })
        }
      } catch (e) {}
      return res.json({ valid: false })
    }

    const check = await isUserValid(phone)
    // reason 'error' = Redis/server bermasalah, BUKAN session tidak valid — jangan buat client logout
    if (!check.valid) {
      if (check.reason === 'error') return res.json({ valid: false, reason: 'server_error' })
      return res.json({ valid: false, reason: check.reason })
    }

    // Check if user is admin (akun internal 'admin' ATAU nomor admin)
    const isAdmin = phone === 'admin' || ADMIN_PHONES.includes(phone)

    res.json({ valid: true, user: check.user, phone, isAdmin })
  } catch (e) {
    // Error transien (mis. Redis timeout) — beri tanda agar client TIDAK menghapus session
    console.error(`[${new Date().toISOString()}] [VERIFY_SESSION_ERROR]`, e && e.message ? e.message : e)
    res.json({ valid: false, reason: 'server_error' })
  }
})

// API: Logout
app.post('/api/logout', express.json(), async (req, res) => {
  const { session } = req.body
  if (session) {
    await redis.hdel(REDIS_KEYS.SESSIONS, session)
  }
  res.json({ success: true })
})

// API: Admin Reset User PIN to default (000000)
app.post('/api/admin/reset-pin', express.json(), async (req, res) => {
  const { password, phone } = req.body
  if (password !== ADMIN_PASSWORD) {
    return res.json({ success: false, error: 'Password admin salah' })
  }
  if (!phone) {
    return res.json({ success: false, error: 'Nomor HP wajib diisi' })
  }

  const normalizedPhone = normalizePhone(phone)

  // Check if user exists
  const userData = await redis.hget(REDIS_KEYS.USERS, normalizedPhone)
  if (!userData) {
    return res.json({ success: false, error: 'User tidak ditemukan' })
  }

  // Reset PIN to default (000000)
  const defaultPinHash = hashPin('000000')
  await redis.hset(REDIS_KEYS.USER_PINS, {
    [normalizedPhone]: JSON.stringify({ pin: defaultPinHash, pinChanged: false })
  })

  pushLog(`Admin | Reset PIN for user +${normalizedPhone}`)
  res.json({ success: true, message: 'PIN berhasil direset ke 000000' })
})

// Helper: Generate login token
function generateLoginToken() {
  return Math.random().toString(36).substr(2, 12) + Date.now().toString(36)
}

// API: Request login link via WhatsApp
app.post('/api/user/request-login', express.json(), async (req, res) => {
  const { phone } = req.body
  if (!phone) return res.json({ success: false, error: 'Nomor HP wajib diisi' })

  const normalizedPhone = normalizePhone(phone)

  // Check if user is blocked (nomor admin tidak pernah diblokir)
  if (normalizedPhone !== ADMIN_PHONE) {
    const blocked = await redis.hget(REDIS_KEYS.BLOCKED_USERS, normalizedPhone)
    if (blocked) {
      return res.json({ success: false, error: 'Akun diblokir. Hubungi admin untuk membuka blokir.' })
    }
  }

  // Check if user exists and valid
  const check = await isUserValid(normalizedPhone)
  if (!check.valid) {
    if (check.reason === 'not_found') {
      return res.json({ success: false, error: 'Nomor tidak terdaftar. Hubungi admin untuk mendaftar.' })
    }
    if (check.reason === 'expired') {
      return res.json({ success: false, error: 'Akun sudah expired. Hubungi admin untuk perpanjang.' })
    }
    return res.json({ success: false, error: 'Terjadi kesalahan' })
  }

  // Check if WhatsApp is connected
  if (!sock || !isReady) {
    return res.json({ success: false, error: 'WhatsApp tidak terhubung. Coba lagi nanti.' })
  }

  // Generate login token (valid for 5 minutes)
  const token = generateLoginToken()
  const tokenData = {
    phone: normalizedPhone,
    expires: Date.now() + 5 * 60 * 1000 // 5 minutes
  }

  await redis.hset(REDIS_KEYS.LOGIN_TOKENS, { [token]: JSON.stringify(tokenData) })

  // Get base URL from request
  const protocol = req.headers['x-forwarded-proto'] || 'https'
  const host = req.headers.host
  const loginUrl = `${protocol}://${host}/auth/${token}`

  // Send login link via WhatsApp
  try {
    const jid = `${normalizedPhone}@s.whatsapp.net`
    await sock.sendMessage(jid, {
      text: `🔐 *Login Gold Price Monitor*\n\nHalo ${check.user?.name || 'User'}!\n\nKlik link berikut untuk masuk:\n${loginUrl}\n\n⏰ Link berlaku 5 menit.\n⚠️ Jangan bagikan link ini kepada siapapun.`
    })

    pushLog(`Auth | Login link sent to +${normalizedPhone}`)
    res.json({ success: true, message: 'Link login telah dikirim ke WhatsApp Anda' })
  } catch (e) {
    pushLog(`Auth | Failed to send login link to +${normalizedPhone}: ${e.message}`)
    res.json({ success: false, error: 'Gagal mengirim link. Pastikan nomor WhatsApp aktif.' })
  }
})

// API: Save push subscription
app.post('/api/push-subscribe', express.json(), async (req, res) => {
  const { session, subscription } = req.body
  if (!session || !subscription) return res.json({ success: false })

  const phone = await redis.hget(REDIS_KEYS.SESSIONS, session)
  if (!phone) return res.json({ success: false, error: 'Invalid session' })

  await redis.hset(REDIS_KEYS.PUSH_SUBS, { [phone]: JSON.stringify(subscription) })
  res.json({ success: true })
})

// API: Get VAPID public key
app.get('/api/vapid-public-key', (_req, res) => {
  res.json({ publicKey: VAPID_PUBLIC_KEY })
})

// ==================== ADMIN API ====================

// Admin: Get all users
app.get('/api/admin/users', async (req, res) => {
  const { password } = req.query
  if (password !== ADMIN_PASSWORD) return res.json({ success: false, error: 'Unauthorized' })

  try {
    const [users, blockedUsers, pinData] = await Promise.all([
      redis.hgetall(REDIS_KEYS.USERS),
      redis.hgetall(REDIS_KEYS.BLOCKED_USERS),
      redis.hgetall(REDIS_KEYS.USER_PINS)
    ])
    const result = []

    for (const [phone, data] of Object.entries(users || {})) {
      const user = typeof data === 'string' ? JSON.parse(data) : data
      const hasPushSub = await redis.hget(REDIS_KEYS.PUSH_SUBS, phone)
      const isBlocked = !!blockedUsers?.[phone]

      // Check PIN status
      let pinChanged = false
      if (pinData && pinData[phone]) {
        try {
          const pinInfo = typeof pinData[phone] === 'string' ? JSON.parse(pinData[phone]) : pinData[phone]
          pinChanged = pinInfo.pinChanged || false
        } catch (e) { /* ignore */ }
      }

      result.push({
        phone,
        ...user,
        hasPushSubscription: !!hasPushSub,
        isBlocked,
        pinChanged
      })
    }

    res.json({ success: true, users: result })
  } catch (e) {
    res.json({ success: false, error: e.message })
  }
})

// Admin: Block user
app.post('/api/admin/users/block', express.json(), async (req, res) => {
  const { password, phone, reason } = req.body
  if (password !== ADMIN_PASSWORD) return res.json({ success: false, error: 'Unauthorized' })

  if (!phone) return res.json({ success: false, error: 'Phone required' })

  const normalizedPhone = normalizePhone(phone)
  const blockData = {
    blockedAt: Date.now(),
    reason: reason || 'Blocked by admin'
  }

  await redis.hset(REDIS_KEYS.BLOCKED_USERS, { [normalizedPhone]: JSON.stringify(blockData) })

  // Also remove all sessions for this user
  const sessions = await redis.hgetall(REDIS_KEYS.SESSIONS)
  for (const [sessId, sessPhone] of Object.entries(sessions || {})) {
    if (sessPhone === normalizedPhone) {
      await redis.hdel(REDIS_KEYS.SESSIONS, sessId)
    }
  }

  pushLog(`Admin | Blocked user +${normalizedPhone}`)
  res.json({ success: true })
})

// Admin: Unblock user
app.post('/api/admin/users/unblock', express.json(), async (req, res) => {
  const { password, phone } = req.body
  if (password !== ADMIN_PASSWORD) return res.json({ success: false, error: 'Unauthorized' })

  if (!phone) return res.json({ success: false, error: 'Phone required' })

  const normalizedPhone = normalizePhone(phone)
  await redis.hdel(REDIS_KEYS.BLOCKED_USERS, normalizedPhone)

  pushLog(`Admin | Unblocked user +${normalizedPhone}`)
  res.json({ success: true })
})

// Admin: Add user
app.post('/api/admin/users', express.json(), async (req, res) => {
  const { password, phone, name, expiredDays, expiredTimestamp } = req.body
  if (password !== ADMIN_PASSWORD) return res.json({ success: false, error: 'Unauthorized' })

  if (!phone) return res.json({ success: false, error: 'Nomor WA wajib diisi' })

  const normalizedPhone = normalizePhone(phone)
  const now = Date.now()

  // Support both expiredTimestamp (from date picker) and expiredDays
  let expired = null
  if (expiredTimestamp) {
    expired = expiredTimestamp
  } else if (expiredDays) {
    expired = now + (expiredDays * 24 * 60 * 60 * 1000)
  }

  const userData = {
    name: name || 'Member ' + normalizedPhone.substring(2),
    createdAt: now,
    expired: expired
  }

  await redis.hset(REDIS_KEYS.USERS, { [normalizedPhone]: JSON.stringify(userData) })

  pushLog(`Admin | Added user +${normalizedPhone}, expired: ${expired ? new Date(expired).toLocaleDateString('id-ID') : 'Lifetime'}`)

  res.json({ success: true, user: { phone: normalizedPhone, ...userData } })
})

// Admin: Bulk import users
app.post('/api/admin/users/bulk', express.json(), async (req, res) => {
  const { password, phones } = req.body
  if (password !== ADMIN_PASSWORD) return res.json({ success: false, error: 'Unauthorized' })

  if (!phones || !Array.isArray(phones)) return res.json({ success: false, error: 'phones array required' })

  let added = 0
  let skipped = 0
  const now = Date.now()

  for (const phone of phones) {
    const normalizedPhone = normalizePhone(phone)
    if (!normalizedPhone || normalizedPhone.length < 9) {
      skipped++
      continue
    }

    // Check if exists
    const existing = await redis.hget(REDIS_KEYS.USERS, normalizedPhone)
    if (existing) {
      skipped++
      continue
    }

    const userData = JSON.stringify({
      name: 'Member ' + normalizedPhone,
      createdAt: now,
      expired: null,
      source: 'bulk_import'
    })

    await redis.hset(REDIS_KEYS.USERS, { [normalizedPhone]: userData })
    added++
  }

  pushLog(`Admin | Bulk import: ${added} added, ${skipped} skipped`)
  res.json({ success: true, added, skipped, total: phones.length })
})

// Admin: Update user
app.put('/api/admin/users', express.json(), async (req, res) => {
  const { password, phone, name, expiredDays, addDays, expiredTimestamp } = req.body
  if (password !== ADMIN_PASSWORD) return res.json({ success: false, error: 'Unauthorized' })

  const normalizedPhone = normalizePhone(phone)
  const existing = await redis.hget(REDIS_KEYS.USERS, normalizedPhone)

  if (!existing) return res.json({ success: false, error: 'User tidak ditemukan' })

  const user = typeof existing === 'string' ? JSON.parse(existing) : existing

  if (name) user.name = name

  // Handle expired timestamp from date picker
  if (expiredTimestamp) {
    user.expired = expiredTimestamp
  } else if (expiredDays !== undefined) {
    user.expired = expiredDays ? Date.now() + (expiredDays * 24 * 60 * 60 * 1000) : null
  } else if (addDays) {
    const base = user.expired && user.expired > Date.now() ? user.expired : Date.now()
    user.expired = base + (addDays * 24 * 60 * 60 * 1000)
  }

  await redis.hset(REDIS_KEYS.USERS, { [normalizedPhone]: JSON.stringify(user) })

  pushLog(`Admin | Updated user +${normalizedPhone}: name=${user.name}, expired=${user.expired ? new Date(user.expired).toLocaleDateString('id-ID') : 'Lifetime'}`)

  res.json({ success: true, user: { phone: normalizedPhone, ...user } })
})

// Admin: Delete user
app.delete('/api/admin/users', express.json(), async (req, res) => {
  const { password, phone } = req.body
  if (password !== ADMIN_PASSWORD) return res.json({ success: false, error: 'Unauthorized' })

  const normalizedPhone = normalizePhone(phone)

  await Promise.all([
    redis.hdel(REDIS_KEYS.USERS, normalizedPhone),
    redis.hdel(REDIS_KEYS.PUSH_SUBS, normalizedPhone)
  ])

  // Remove all sessions for this user
  const sessions = await redis.hgetall(REDIS_KEYS.SESSIONS)
  for (const [sessId, sessPhone] of Object.entries(sessions || {})) {
    if (sessPhone === normalizedPhone) {
      await redis.hdel(REDIS_KEYS.SESSIONS, sessId)
    }
  }

  res.json({ success: true })
})

// Admin: Kick user from WhatsApp group AND delete from database
app.post('/api/admin/users/kick', express.json(), async (req, res) => {
  const { password, phone } = req.body
  if (password !== ADMIN_PASSWORD) return res.json({ success: false, error: 'Unauthorized' })

  if (!phone) return res.json({ success: false, error: 'Nomor wajib diisi' })

  const normalizedPhone = normalizePhone(phone)
  const jid = `${normalizedPhone}@s.whatsapp.net`

  try {
    // Check if we have a monitored group
    if (!monitoredGroupId) {
      return res.json({ success: false, error: 'Belum ada grup yang di-monitor. Set grup terlebih dahulu.' })
    }

    // Check if WhatsApp is connected
    if (!sock) {
      return res.json({ success: false, error: 'WhatsApp tidak terhubung' })
    }

    // Try to kick from WhatsApp group
    let kickedFromGroup = false
    try {
      await sock.groupParticipantsUpdate(monitoredGroupId, [jid], 'remove')
      kickedFromGroup = true
      pushLog(`WA | Kicked +${normalizedPhone} from group`)

      // Send kick notification to user
      try {
        await sock.sendMessage(jid, {
          text: `❌ *ANDA TELAH DI-KICK*\n\nAnda telah dikeluarkan dari grup Gold Price Monitor.\n\nJika ada pertanyaan, hubungi admin:\nhttps://wa.me/62895701692525`
        })
      } catch (msgErr) {
      }
    } catch (kickError) {
      // User might not be in group, or bot is not admin
      pushLog(`WA | Failed to kick +${normalizedPhone}: ${kickError.message}`)
      // Continue to delete user even if kick fails
    }

    // Delete user from database
    await Promise.all([
      redis.hdel(REDIS_KEYS.USERS, normalizedPhone),
      redis.hdel(REDIS_KEYS.PUSH_SUBS, normalizedPhone)
    ])

    // Remove all sessions for this user
    const sessions = await redis.hgetall(REDIS_KEYS.SESSIONS)
    for (const [sessId, sessPhone] of Object.entries(sessions || {})) {
      if (sessPhone === normalizedPhone) {
        await redis.hdel(REDIS_KEYS.SESSIONS, sessId)
      }
    }

    pushLog(`Admin | User +${normalizedPhone} deleted (kicked: ${kickedFromGroup})`)

    res.json({
      success: true,
      kickedFromGroup,
      message: kickedFromGroup
        ? 'User berhasil di-kick dari grup dan dihapus dari database'
        : 'User dihapus dari database (gagal kick dari grup - mungkin bukan admin atau user tidak di grup)'
    })
  } catch (e) {
    pushLog(`Admin | Kick error: ${e.message}`)
    res.json({ success: false, error: e.message })
  }
})

// Admin: Clear invalid users (LID format or invalid Indonesian phone numbers)
app.post('/api/admin/users/clear-invalid', express.json(), async (req, res) => {
  const { password } = req.body
  if (password !== ADMIN_PASSWORD) return res.json({ success: false, error: 'Unauthorized' })

  try {
    const allUsers = await redis.hgetall(REDIS_KEYS.USERS) || {}
    let deleted = 0

    for (const phone of Object.keys(allUsers)) {
      // Valid Indonesian phone: starts with 8, length 9-12 (without 62 prefix)
      // Invalid: LID numbers (very long), or doesn't start with 8
      const isValidIndonesian = /^8\d{8,11}$/.test(phone)

      if (!isValidIndonesian) {
        await redis.hdel(REDIS_KEYS.USERS, phone)
        deleted++
      }
    }

    pushLog(`Admin | Cleared ${deleted} invalid users`)
    res.json({ success: true, deleted })
  } catch (e) {
    res.json({ success: false, error: e.message })
  }
})

// Admin: Clear ALL users (use with caution!)
app.post('/api/admin/users/clear-all', express.json(), async (req, res) => {
  const { password, confirm } = req.body
  if (password !== ADMIN_PASSWORD) return res.json({ success: false, error: 'Unauthorized' })
  if (confirm !== 'DELETE_ALL') return res.json({ success: false, error: 'Konfirmasi salah' })

  try {
    await redis.del(REDIS_KEYS.USERS)
    await redis.del(REDIS_KEYS.SESSIONS)
    pushLog(`Admin | All users cleared!`)
    res.json({ success: true })
  } catch (e) {
    res.json({ success: false, error: e.message })
  }
})

// Admin: Force logout all users (clear all sessions)
app.post('/api/admin/force-logout-all', express.json(), async (req, res) => {
  const { password } = req.body
  if (password !== ADMIN_PASSWORD) return res.json({ success: false, error: 'Unauthorized' })

  try {
    await redis.del(REDIS_KEYS.SESSIONS)
    await redis.del(REDIS_KEYS.LOGIN_TOKENS)

    // Broadcast ke semua client untuk logout lalu tutup semua koneksi SSE
    broadcastSSE({ type: 'force_logout', message: 'Session expired, please login again' })
    setTimeout(() => {
      sseClients.forEach((userInfo, client) => {
        try { client.end() } catch {}
      })
      sseClients.clear()
      broadcastOnlineUsersToAdmin()
    }, 300)

    pushLog(`Admin | Force logout all users`)
    res.json({ success: true, message: 'Semua user berhasil di-logout' })
  } catch (e) {
    res.json({ success: false, error: e.message })
  }
})

// Admin: Send push notification
app.post('/api/admin/push', express.json(), async (req, res) => {
  const { password, title, message, phone, type = 'info' } = req.body
  if (password !== ADMIN_PASSWORD) return res.json({ success: false, error: 'Unauthorized' })

  if (!title || !message) return res.json({ success: false, error: 'Title dan message wajib' })

  const payload = JSON.stringify({
    title,
    body: message,
    icon: '/icon.png',
    badge: '/icon.png',
    type,
    url: '/monitoring'
  })

  let sent = 0
  let failed = 0

  try {
    if (phone) {
      // Send to specific user
      const normalizedPhone = normalizePhone(phone)
      const subData = await redis.hget(REDIS_KEYS.PUSH_SUBS, normalizedPhone)
      if (subData) {
        const subscription = typeof subData === 'string' ? JSON.parse(subData) : subData
        try {
          await webpush.sendNotification(subscription, payload)
          sent++
        } catch (e) {
          failed++
          if (e.statusCode === 410) {
            await redis.hdel(REDIS_KEYS.PUSH_SUBS, normalizedPhone)
          }
        }
      }
    } else {
      // Send to all users
      const allSubs = await redis.hgetall(REDIS_KEYS.PUSH_SUBS)
      for (const [userPhone, subData] of Object.entries(allSubs || {})) {
        const subscription = typeof subData === 'string' ? JSON.parse(subData) : subData
        try {
          await webpush.sendNotification(subscription, payload)
          sent++
        } catch (e) {
          failed++
          if (e.statusCode === 410) {
            await redis.hdel(REDIS_KEYS.PUSH_SUBS, userPhone)
          }
        }
      }
    }

    // Also broadcast via SSE
    broadcastSSE({ type: 'notification', notifType: type, title, message, time: new Date().toISOString() })

    // Simpan ke riwayat notifikasi di Redis
    const notifEntry = { id: Date.now().toString(), type, title, message, sent, failed, sentAt: new Date().toISOString() }
    try {
      const existing = await redis.get(REDIS_KEYS.NOTIF_HISTORY)
      const history = existing ? JSON.parse(existing) : []
      history.unshift(notifEntry)
      await redis.set(REDIS_KEYS.NOTIF_HISTORY, JSON.stringify(history))
    } catch (_) {}

    res.json({ success: true, sent, failed })
  } catch (e) {
    res.json({ success: false, error: e.message })
  }
})

// Admin: Get notification history
app.get('/api/admin/notif-history', async (req, res) => {
  const { password } = req.query
  if (password !== ADMIN_PASSWORD) return res.json({ success: false, error: 'Unauthorized' })
  try {
    const data = await redis.get(REDIS_KEYS.NOTIF_HISTORY)
    res.json({ success: true, history: data ? JSON.parse(data) : [] })
  } catch (e) {
    res.json({ success: false, error: e.message })
  }
})

// Admin: Delete one notification from history
app.delete('/api/admin/notif-history/:id', async (req, res) => {
  const { password } = req.query
  if (password !== ADMIN_PASSWORD) return res.json({ success: false, error: 'Unauthorized' })
  try {
    const data = await redis.get(REDIS_KEYS.NOTIF_HISTORY)
    const history = (data ? JSON.parse(data) : []).filter(n => n.id !== req.params.id)
    await redis.set(REDIS_KEYS.NOTIF_HISTORY, JSON.stringify(history))
    res.json({ success: true })
  } catch (e) {
    res.json({ success: false, error: e.message })
  }
})

// Admin: Clear all notification history
app.delete('/api/admin/notif-history', async (req, res) => {
  const { password } = req.query
  if (password !== ADMIN_PASSWORD) return res.json({ success: false, error: 'Unauthorized' })
  try {
    await redis.set(REDIS_KEYS.NOTIF_HISTORY, JSON.stringify([]))
    res.json({ success: true })
  } catch (e) {
    res.json({ success: false, error: e.message })
  }
})

// ==================== SOUND SETTINGS ====================

// Get sound settings (public - for monitoring page)
app.get('/api/sound-settings', async (req, res) => {
  if (!await requireSession(req, res)) return
  try {
    const settings = await redis.get(REDIS_KEYS.SOUND_SETTINGS)
    if (settings) {
      const parsed = typeof settings === 'string' ? JSON.parse(settings) : settings
      res.json({ success: true, settings: parsed })
    } else {
      res.json({ success: true, settings: { soundUp: '', soundDown: '', soundOn: '', soundOff: '', soundBigUp: '', soundBigDown: '' } })
    }
  } catch (e) {
    res.json({ success: false, error: e.message })
  }
})

// Admin: Update sound settings
app.post('/api/admin/sound-settings', express.json({ limit: '10mb' }), async (req, res) => {
  const { password, soundUp, soundDown, soundOn, soundOff, soundBigUp, soundBigDown } = req.body
  if (password !== ADMIN_PASSWORD) return res.json({ success: false, error: 'Unauthorized' })

  try {
    const settings = {
      soundUp: soundUp || '',
      soundDown: soundDown || '',
      soundOn: soundOn || '',
      soundOff: soundOff || '',
      soundBigUp: soundBigUp || '',
      soundBigDown: soundBigDown || ''
    }
    await redis.set(REDIS_KEYS.SOUND_SETTINGS, JSON.stringify(settings))

    // Broadcast to all clients to update their sounds
    broadcastSSE({ type: 'sound_update', settings })

    res.json({ success: true, settings })
  } catch (e) {
    res.json({ success: false, error: e.message })
  }
})

// ==================== NOMINAL SETTINGS MANAGEMENT ====================

// Default nominal settings
const DEFAULT_NOMINAL_CONFIG = {
  nominals: [
    { id: '10rb', label: '10rb', amount: 10000, discountRate: 0.4999, active: true, promoRef: false },
    { id: '10jt', label: '10jt', amount: 10000000, discountRate: 0.0331, active: true, promoRef: false },
    { id: '20jt', label: '20jt', amount: 20000000, discountRate: 0.0335, active: true, promoRef: true },
    { id: '30jt', label: '30jt', amount: 30000000, discountRate: 0.0335, active: true, promoRef: false },
    { id: '40jt', label: '40jt', amount: 40000000, discountRate: 0.0335, active: true, promoRef: false },
    { id: '50jt', label: '50jt', amount: 50000000, discountRate: 0.0335, active: true, promoRef: false }
  ]
}

// Get nominal settings (public - for client)
app.get('/api/nominal-settings', async (req, res) => {
  if (!await requireSession(req, res)) return
  try {
    const settings = await redis.get(REDIS_KEYS.NOMINAL_SETTINGS)
    let config = settings ? (typeof settings === 'string' ? JSON.parse(settings) : settings) : DEFAULT_NOMINAL_CONFIG

    // Handle old format (array instead of object)
    if (Array.isArray(config)) {
      config = { defaultVisible: true, nominals: config }
    }

    // Only return active nominals for public
    const activeNominals = config.nominals.filter(n => n.active)
    // Default visible = true if any nominal > 9jt exists
    const hasLargeNominal = activeNominals.some(n => n.amount > 9000000)
    const defaultVisible = config.defaultVisible !== undefined ? config.defaultVisible : hasLargeNominal

    res.json({ success: true, defaultVisible, nominals: activeNominals })
  } catch (e) {
    res.json({ success: false, error: e.message })
  }
})

// Admin: Get all nominal settings (including inactive)
app.get('/api/admin/nominal-settings', async (req, res) => {
  const { password } = req.query
  if (password !== ADMIN_PASSWORD) return res.json({ success: false, error: 'Unauthorized' })

  try {
    const settings = await redis.get(REDIS_KEYS.NOMINAL_SETTINGS)
    let config = settings ? (typeof settings === 'string' ? JSON.parse(settings) : settings) : DEFAULT_NOMINAL_CONFIG

    // Handle old format
    if (Array.isArray(config)) {
      config = { defaultVisible: true, nominals: config }
    }

    res.json({ success: true, config })
  } catch (e) {
    res.json({ success: false, error: e.message })
  }
})

// Admin: Update nominal settings
app.post('/api/admin/nominal-settings', express.json(), async (req, res) => {
  const { password, config } = req.body
  if (password !== ADMIN_PASSWORD) return res.json({ success: false, error: 'Unauthorized' })

  try {
    await redis.set(REDIS_KEYS.NOMINAL_SETTINGS, JSON.stringify(config))
    // Update cache untuk WA message
    nominalSettingsCache = config.nominals.filter(n => n.active && n.amount >= 1000000)
    // Broadcast to all clients to update their nominals
    const activeNominals = config.nominals.filter(n => n.active)
    broadcastSSE({ type: 'nominal_update', defaultVisible: config.defaultVisible, nominals: activeNominals })
    res.json({ success: true, config })
  } catch (e) {
    res.json({ success: false, error: e.message })
  }
})

// Admin: Get ntfy settings
app.get('/api/admin/ntfy-settings', async (req, res) => {
  const { password } = req.query
  if (password !== ADMIN_PASSWORD) return res.json({ success: false, error: 'Unauthorized' })
  try {
    const raw = await redis.get(REDIS_KEYS.NTFY_SETTINGS)
    const cfg = raw ? (typeof raw === 'string' ? JSON.parse(raw) : raw) : {}
    res.json({ success: true, settings: {
      enabled: cfg.enabled !== false,
      count: cfg.count || 60,
      reminderMinutes: cfg.reminderMinutes || 10
    }})
  } catch (e) {
    res.json({ success: false, error: e.message })
  }
})

// Admin: Update ntfy settings
app.post('/api/admin/ntfy-settings', express.json(), async (req, res) => {
  const { password, enabled, count, reminderMinutes } = req.body
  if (password !== ADMIN_PASSWORD) return res.json({ success: false, error: 'Unauthorized' })
  try {
    const cfg = {
      enabled: enabled !== false,
      count: Math.max(1, Math.min(600, parseInt(count) || 60)),
      reminderMinutes: Math.max(1, Math.min(60, parseInt(reminderMinutes) || 10))
    }
    await redis.set(REDIS_KEYS.NTFY_SETTINGS, JSON.stringify(cfg))
    ntfyReminderIntervalMs = cfg.reminderMinutes * 60000
    pushLog(`🔔 NTFY settings updated: enabled=${cfg.enabled} count=${cfg.count} reminderMin=${cfg.reminderMinutes}`)
    res.json({ success: true, settings: cfg })
  } catch (e) {
    res.json({ success: false, error: e.message })
  }
})

// Public: Treasury API latency stats
app.get('/api/latency', async (req, res) => {
  if (!await requireSession(req, res)) return
  const avg = latencyHistory.length
    ? Math.round(latencyHistory.reduce((a, b) => a + b, 0) / latencyHistory.length)
    : null
  res.json({
    fetchMs: lastFetchMs,
    dataAgeMs: lastDataAgeMs,
    avgFetchMs: avg,
    samples: latencyHistory.length
  })
})

// Public: Get promo limit
app.get('/api/promo-limit', async (req, res) => {
  if (!await requireSession(req, res)) return
  try {
    const val = await redis.get(REDIS_KEYS.PROMO_LIMIT)
    const limit = val !== null ? parseInt(val, 10) : null
    res.json({ success: true, limit })
  } catch (e) {
    res.json({ success: false, error: e.message })
  }
})

// Admin: Set promo limit
app.post('/api/admin/promo-limit', express.json(), async (req, res) => {
  const { password, limit } = req.body
  if (password !== ADMIN_PASSWORD) return res.json({ success: false, error: 'Unauthorized' })
  try {
    const numLimit = parseInt(limit, 10)
    if (isNaN(numLimit) || numLimit < 0) return res.json({ success: false, error: 'Nilai tidak valid' })
    const oldLimit = promoLimitCache
    await redis.set(REDIS_KEYS.PROMO_LIMIT, String(numLimit))
    promoLimitCache = numLimit
    broadcastSSE({ type: 'promo_limit_update', limit: numLimit })

    // Kirim pesan WA limit terbaru ke grup + subscriber (dgn nama website di bawah), seperti pesan ON
    if (numLimit !== oldLimit && sock && isReady && (broadcastGroupId || subscriptions.size > 0)) {
      const waMsg = `🏷️ *Limit Beli Promo Diperbarui*\n\nLimit sekarang: *${numLimit} beli/bln*\n\n🌐 Via website: https://ts.muhamadaliyudin.my.id`
      const chatIds = [broadcastGroupId, ...Array.from(subscriptions)].filter(Boolean)
      for (const chatId of chatIds) {
        if (chatId.endsWith('@g.us')) {
          let mentions = []
          try {
            const gm = await sock.groupMetadata(chatId)
            mentions = gm.participants.map(p => p.id)
          } catch (e) {}
          sock.sendMessage(chatId, { text: waMsg, mentions }).catch(() => {})
        } else {
          sock.sendMessage(chatId, { text: waMsg }).catch(() => {})
        }
      }
      pushLog(`🏷️ WA limit update terkirim: ${numLimit} beli/bln`)
    }

    res.json({ success: true, limit: numLimit })
  } catch (e) {
    res.json({ success: false, error: e.message })
  }
})

// Get markup settings (admin)
app.get('/api/theme-settings', async (req, res) => {
  res.json({ success: true, theme: themeCache })
})

app.post('/api/admin/theme-settings', express.json(), async (req, res) => {
  const { password, bg1, bg2, bg3, card, header } = req.body
  if (password !== ADMIN_PASSWORD) return res.json({ success: false, error: 'Unauthorized' })
  const isHex = v => /^#[0-9a-fA-F]{6}$/.test(v)
  if (!isHex(bg1) || !isHex(bg2) || !isHex(bg3) || !isHex(card) || !isHex(header)) {
    return res.json({ success: false, error: 'Format warna tidak valid (harus #rrggbb)' })
  }
  try {
    themeCache = { bg1, bg2, bg3, card, header }
    await redis.set(REDIS_KEYS.THEME_SETTINGS, JSON.stringify(themeCache))
    res.json({ success: true, theme: themeCache })
  } catch (e) {
    res.json({ success: false, error: e.message })
  }
})

app.get('/api/markup-settings', async (req, res) => {
  res.json({ success: true, settings: markupSettingsCache })
})

// Admin: Set markup settings
app.post('/api/admin/markup-settings', express.json(), async (req, res) => {
  const { password, minMargin, maxMargin } = req.body
  if (password !== ADMIN_PASSWORD) return res.json({ success: false, error: 'Unauthorized' })
  const min = parseFloat(minMargin)
  const max = parseFloat(maxMargin)
  if (isNaN(min) || isNaN(max) || min < 0 || max < min || max > 20) {
    return res.json({ success: false, error: 'Nilai tidak valid. Pastikan min ≤ max dan max ≤ 20%' })
  }
  try {
    markupSettingsCache = { minMargin: min, maxMargin: max }
    await redis.set(REDIS_KEYS.MARKUP_SETTINGS, JSON.stringify(markupSettingsCache))
    broadcastSSE({ type: 'markup_settings_update', settings: markupSettingsCache })
    res.json({ success: true, settings: markupSettingsCache })
  } catch (e) {
    res.json({ success: false, error: e.message })
  }
})

// Get lowest ON price
// Chat API
app.get('/api/chat/history', async (req, res) => {
  const session = req.query.session || ''
  if (!session) return res.status(403).json({ error: 'Unauthorized' })
  const phone = await redis.hget(REDIS_KEYS.SESSIONS, session).catch(() => null)
  if (!phone) return res.status(403).json({ error: 'Unauthorized' })
  res.json({ success: true, messages: chatHistory, animal: getAnimalName(phone) })
})

app.post('/api/chat/send', express.json(), async (req, res) => {
  const { session, message } = req.body || {}
  if (!session || !message) return res.status(400).json({ error: 'Missing params' })
  const phone = await redis.hget(REDIS_KEYS.SESSIONS, session).catch(() => null)
  if (!phone) return res.status(403).json({ error: 'Unauthorized' })
  const text = String(message).trim().slice(0, 300)
  if (!text) return res.status(400).json({ error: 'Empty message' })
  const animal = getAnimalName(phone)
  const msg = { animal, text, time: Date.now() }
  chatHistory.push(msg)
  if (chatHistory.length > MAX_CHAT) chatHistory.shift()
  broadcastSSE({ type: 'chat_message', ...msg })
  res.json({ success: true })
})

app.get('/api/daily-highlow', async (req, res) => {
  if (!await requireSession(req, res)) return
  res.json({ success: true, high: dailyHighBuy, low: dailyLowBuy })
})

app.get('/api/lowest-on-price', async (req, res) => {
  if (!await requireSession(req, res)) return
  try {
    const val = await redis.get(REDIS_KEYS.LOWEST_ON_PRICE)
    const price = val !== null ? parseInt(val, 10) : null
    res.json({ success: true, price })
  } catch (e) {
    res.json({ success: false, error: e.message })
  }
})

// Get active promo suggestions (cached)
app.get('/api/promo-suggestions', async (req, res) => {
  if (!await requireSession(req, res)) return
  try {
    // Jika cache kosong, fetch langsung
    if (cachedPromoSuggestions.length === 0) {
      const active = await fetchPromoSuggestions()
      if (active !== null) cachedPromoSuggestions = active
    }
    res.json({ success: true, promos: cachedPromoSuggestions })
  } catch (e) {
    res.json({ success: false, error: e.message, promos: [] })
  }
})

// ==================== FOREX FACTORY CALENDAR (XAU/USD NEWS) ====================

let cachedFFCalendar = []
let lastFFCalendarFetch = 0
const FF_CALENDAR_TTL = 5 * 60 * 1000 // cache 5 menit

app.get('/api/ff-calendar', async (req, res) => {
  if (!await requireSession(req, res)) return
  try {
    const now = Date.now()
    if (cachedFFCalendar.length > 0 && now - lastFFCalendarFetch < FF_CALENDAR_TTL) {
      return res.json({ success: true, events: cachedFFCalendar, cached: true })
    }

    // Fetch Forex Factory JSON feed (this week + next week)
    const fetchJson = (url) => new Promise((resolve, reject) => {
      https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (r) => {
        let data = ''
        r.on('data', chunk => data += chunk)
        r.on('end', () => { try { resolve(JSON.parse(data)) } catch(e) { resolve([]) } })
        r.on('error', () => resolve([]))
      }).on('error', () => resolve([]))
    })

    const [week1, week2] = await Promise.all([
      fetchJson('https://nfs.faireconomy.media/ff_calendar_thisweek.json').catch(() => []),
      fetchJson('https://nfs.faireconomy.media/ff_calendar_nextweek.json').catch(() => [])
    ])

    const allEvents = [...(Array.isArray(week1) ? week1 : []), ...(Array.isArray(week2) ? week2 : [])]
    const events = allEvents.filter(ev => ev.country === 'USD').map(ev => ({
      title: ev.title || '',
      country: ev.country || '',
      date: ev.date || '',
      time: ev.time || '',
      impact: ev.impact || '',
      forecast: ev.forecast || '',
      previous: ev.previous || '',
      actual: ev.actual || ''
    }))
    cachedFFCalendar = events
    lastFFCalendarFetch = now
    pushLog(`📰 FF Calendar: ${events.length} USD events loaded`)
    res.json({ success: true, events })
  } catch (e) {
    pushLog(`❌ FF Calendar error: ${e.message}`)
    res.json({ success: false, error: e.message, events: cachedFFCalendar })
  }
})

// ==================== WHATSAPP STATUS & RESET ====================

// Admin: Get WA connection status
app.get('/api/admin/wa-status', async (req, res) => {
  const { password } = req.query
  if (password !== ADMIN_PASSWORD) return res.json({ success: false, error: 'Unauthorized' })

  const phone = sock?.user?.id ? sock.user.id.split(':')[0].split('@')[0] : null
  res.json({
    success: true,
    connected: isReady,
    hasQr: !!lastQr,
    phone: phone ? `+${phone}` : null,
    broadcastGroupId: broadcastGroupId || null,
    monitoredGroupId: monitoredGroupId || null
  })
})

// Public: token "fresh" — client membandingkan dengan yang tersimpan di localStorage.
// Kalau beda → client tampilkan tur pengenalan lagi + reset Sound & Getar ke default.
app.get('/api/fresh-token', (_req, res) => {
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate')
  // Dilayani dari memory (freshTokenCache) — tidak menyentuh Redis di jalur panas
  res.json({ token: freshTokenCache })
})

// Admin: paksa SEMUA user dapat tur + reset Sound & Getar sekali lagi (set token baru).
app.post('/api/admin/reset-fresh', express.json(), async (req, res) => {
  if (!isAdminCookieValid(req) && req.headers['x-admin-password'] !== ADMIN_PASSWORD) {
    return res.json({ success: false, error: 'Unauthorized' })
  }
  try {
    const token = 'r' + Date.now().toString(36)
    await redis.set(REDIS_KEYS.FRESH_TOKEN, token)
    freshTokenCache = token
    console.log(`[${new Date().toISOString()}] [ADMIN_RESET_FRESH] token=${token} — semua user akan dapat tur + reset sound/getar`)
    pushLog(`🔄 Admin reset FRESH — token baru ${token}. Semua user akan dapat tur pengenalan + reset Sound & Getar.`)
    res.json({ success: true, token })
  } catch (e) {
    console.error(`[${new Date().toISOString()}] [ADMIN_RESET_FRESH_ERROR]`, e)
    res.json({ success: false, error: e.message })
  }
})

// ==================== ADMIN: Kelola API Token Eksternal ====================
function _requireAdminReq(req, res) {
  if (!isAdminCookieValid(req) && req.headers['x-admin-password'] !== ADMIN_PASSWORD) {
    res.json({ success: false, error: 'Unauthorized' })
    return false
  }
  return true
}

// List semua API key
app.get('/api/admin/api-tokens', (req, res) => {
  if (!_requireAdminReq(req, res)) return
  const items = Object.entries(apiTokensCache).map(([key, m]) => ({
    key, name: m.name || '-', enabled: m.enabled !== false,
    createdAt: m.createdAt || null, lastUsed: m.lastUsed || null, hits: m.hits || 0
  })).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
  res.json({ success: true, items })
})

// Generate API key baru
app.post('/api/admin/api-tokens', express.json(), async (req, res) => {
  if (!_requireAdminReq(req, res)) return
  try {
    const name = String((req.body && req.body.name) || 'default').trim().slice(0, 40) || 'default'
    const key = 'trs_' + crypto.randomBytes(24).toString('hex')
    const meta = { name, enabled: true, createdAt: Date.now() }
    await redis.hset(REDIS_KEYS.API_TOKENS, { [key]: JSON.stringify(meta) })
    apiTokensCache[key] = meta
    pushLog(`🔑 API | Admin generate API key "${name}" (${key.slice(0, 12)}...)`)
    res.json({ success: true, key, name })
  } catch (e) {
    console.error(`[${new Date().toISOString()}] [API_TOKEN_CREATE_ERROR]`, e)
    res.json({ success: false, error: e.message })
  }
})

// Enable/disable API key
app.post('/api/admin/api-tokens/toggle', express.json(), async (req, res) => {
  if (!_requireAdminReq(req, res)) return
  try {
    const { key } = req.body || {}
    const meta = key && apiTokensCache[key]
    if (!meta) return res.json({ success: false, error: 'API key tidak ditemukan' })
    meta.enabled = meta.enabled === false
    await redis.hset(REDIS_KEYS.API_TOKENS, { [key]: JSON.stringify({ name: meta.name, enabled: meta.enabled, createdAt: meta.createdAt }) })
    pushLog(`🔑 API | Key "${meta.name}" ${meta.enabled ? 'DIAKTIFKAN' : 'DINONAKTIFKAN'} oleh admin`)
    res.json({ success: true, enabled: meta.enabled })
  } catch (e) {
    res.json({ success: false, error: e.message })
  }
})

// Hapus API key permanen
app.post('/api/admin/api-tokens/delete', express.json(), async (req, res) => {
  if (!_requireAdminReq(req, res)) return
  try {
    const { key } = req.body || {}
    if (!key || !apiTokensCache[key]) return res.json({ success: false, error: 'API key tidak ditemukan' })
    const name = apiTokensCache[key].name
    await redis.hdel(REDIS_KEYS.API_TOKENS, key)
    delete apiTokensCache[key]
    pushLog(`🔑 API | Key "${name}" DIHAPUS oleh admin`)
    res.json({ success: true })
  } catch (e) {
    res.json({ success: false, error: e.message })
  }
})

// Admin: Reset Titik ON terendah
app.post('/api/admin/reset-titik-on', express.json(), async (req, res) => {
  if (!isAdminCookieValid(req)) return res.json({ success: false, error: 'Unauthorized' })
  try {
    await redis.del(REDIS_KEYS.LOWEST_ON_PRICE)
    await redis.del(REDIS_KEYS.LOWEST_ON_DATE)
    lowestOnPriceCache = null
    lowestOnDateWIB = null
    broadcastSSE({ type: 'lowest_on_price', price: null })
    pushLog('🏷️ Titik ON terendah direset manual oleh admin')
    res.json({ success: true })
  } catch (e) {
    res.json({ success: false, error: e.message })
  }
})


// Admin: Reset WA connection (logout + restart, scan QR ulang)
app.post('/api/admin/wa-reset', express.json(), async (req, res) => {
  const { password } = req.body
  if (password !== ADMIN_PASSWORD) return res.json({ success: false, error: 'Unauthorized' })

  try {
    pushLog('WA | Admin requested reset...')

    if (sock) {
      sock.ev.removeAllListeners()
      await sock.logout().catch(() => {})
      sock = null
    }

    isReady = false
    lastQr = null

    // Hapus Redis auth agar QR muncul baru
    await redis.del(REDIS_KEYS.WA_AUTH)
    pushLog('WA | Redis auth cleared')

    // Hapus folder auth lokal
    const fs = await import('fs')
    const path = await import('path')
    const authPath = path.join(process.cwd(), 'auth')
    if (fs.existsSync(authPath)) {
      fs.rmSync(authPath, { recursive: true, force: true })
      pushLog('WA | Auth folder deleted')
    }

    // Reset semua counter agar reconnect berjalan normal
    reconnectAttempts = 0
    consecutive428 = 0
    isStarting = false
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null }

    // Restart koneksi setelah 2 detik
    scheduleReconnect(2000)

    res.json({ success: true, message: 'Reset berhasil. Scan QR baru di halaman QR.' })
  } catch (e) {
    pushLog('WA | Reset error: ' + e.message)
    res.json({ success: false, error: e.message })
  }
})

// ==================== WHATSAPP GROUP MANAGEMENT ====================

// Admin: Get list of WhatsApp groups
app.get('/api/admin/wa-groups', async (req, res) => {
  const { password } = req.query
  if (password !== ADMIN_PASSWORD) return res.json({ success: false, error: 'Unauthorized' })

  if (!sock || !isReady) {
    return res.json({ success: false, error: 'WhatsApp not connected' })
  }

  try {
    const groups = await sock.groupFetchAllParticipating()
    const groupList = Object.values(groups).map(g => ({
      id: g.id,
      name: g.subject,
      participants: g.participants?.length || 0,
      isMonitored: g.id === monitoredGroupId,
      isBroadcast: g.id === broadcastGroupId
    }))

    res.json({ success: true, groups: groupList, currentGroupId: monitoredGroupId, broadcastGroupId })
  } catch (e) {
    res.json({ success: false, error: e.message })
  }
})

// Admin: Set monitored group
app.post('/api/admin/wa-groups/set', express.json(), async (req, res) => {
  const { password, groupId } = req.body
  if (password !== ADMIN_PASSWORD) return res.json({ success: false, error: 'Unauthorized' })

  if (!groupId) return res.json({ success: false, error: 'Group ID wajib' })

  try {
    await redis.set(REDIS_KEYS.WA_GROUP_ID, groupId)
    monitoredGroupId = groupId
    pushLog('WA | Monitored group set: ' + groupId.substring(0, 20) + '...')

    res.json({ success: true, groupId })
  } catch (e) {
    res.json({ success: false, error: e.message })
  }
})

// Admin: Set broadcast group (untuk kirim harga otomatis ke grup WA)
app.post('/api/admin/wa-groups/set-broadcast', express.json(), async (req, res) => {
  const { password, groupId } = req.body
  if (password !== ADMIN_PASSWORD) return res.json({ success: false, error: 'Unauthorized' })

  try {
    if (groupId) {
      await redis.set(REDIS_KEYS.WA_BROADCAST_GROUP_ID, groupId)
      broadcastGroupId = groupId
      pushLog('WA | Broadcast group set: ' + groupId.substring(0, 20) + '...')
    } else {
      await redis.del(REDIS_KEYS.WA_BROADCAST_GROUP_ID)
      broadcastGroupId = null
      pushLog('WA | Broadcast group cleared')
    }
    res.json({ success: true, groupId: broadcastGroupId })
  } catch (e) {
    res.json({ success: false, error: e.message })
  }
})

// Admin: Debug - get group members raw data
app.get('/api/admin/wa-groups/debug', async (req, res) => {
  const { password } = req.query
  if (password !== ADMIN_PASSWORD) return res.json({ success: false, error: 'Unauthorized' })

  if (!sock || !isReady) {
    return res.json({ success: false, error: 'WhatsApp not connected' })
  }

  if (!monitoredGroupId) {
    return res.json({ success: false, error: 'Belum ada grup yang dipilih' })
  }

  try {
    const groupMeta = await sock.groupMetadata(monitoredGroupId)
    const participants = groupMeta.participants || []

    // Try to get phone numbers using lidToPhone mapping if available
    const sampleWithPhone = []
    for (const p of participants.slice(0, 10)) {
      let phoneNumber = null

      // Check if it's LID format (@lid) or standard format (@s.whatsapp.net)
      if (p.id.endsWith('@lid')) {
        // Try to resolve LID to phone number
        try {
          // Check if sock has lidToPhone store
          if (sock.store?.lidToPhone) {
            phoneNumber = sock.store.lidToPhone.get(p.id)
          }
        } catch (e) {}
      } else if (p.id.endsWith('@s.whatsapp.net')) {
        // Standard format - extract phone directly
        const match = p.id.match(/^(\d+)@/)
        if (match) phoneNumber = match[1]
      }

      sampleWithPhone.push({
        id: p.id,
        admin: p.admin,
        notify: p.notify,
        resolvedPhone: phoneNumber
      })
    }

    res.json({
      success: true,
      groupId: monitoredGroupId,
      groupName: groupMeta.subject,
      totalParticipants: participants.length,
      sampleParticipants: sampleWithPhone,
      note: 'WhatsApp menggunakan LID (Linked ID) untuk privacy. Nomor asli mungkin tidak bisa diakses.'
    })
  } catch (e) {
    res.json({ success: false, error: e.message })
  }
})

// Admin: Sync all members from monitored group
// NOTE: WhatsApp now uses LID (Linked ID) format which doesn't expose phone numbers
// This function will inform admin about this limitation
app.post('/api/admin/wa-groups/sync', express.json(), async (req, res) => {
  const { password } = req.body
  if (password !== ADMIN_PASSWORD) return res.json({ success: false, error: 'Unauthorized' })

  if (!sock || !isReady) {
    return res.json({ success: false, error: 'WhatsApp not connected' })
  }

  if (!monitoredGroupId) {
    return res.json({ success: false, error: 'Belum ada grup yang dipilih' })
  }

  try {
    const groupMeta = await sock.groupMetadata(monitoredGroupId)
    const participants = groupMeta.participants || []

    pushLog(`WA | Checking ${participants.length} members from group`)

    // Check if participants use LID format
    const usesLid = participants.some(p => p.id?.endsWith('@lid'))

    if (usesLid) {
      pushLog(`WA | Group uses LID format - phone numbers hidden by WhatsApp`)
      return res.json({
        success: false,
        error: 'WhatsApp menggunakan format LID (privacy) di grup ini. Nomor telepon tidak dapat diakses otomatis. Gunakan fitur "Tambah User Manual" atau aktifkan "Registrasi via OTP".',
        total: participants.length,
        usesLid: true
      })
    }

    // Standard format - proceed with sync
    const existingUsers = await redis.hgetall(REDIS_KEYS.USERS) || {}

    let added = 0
    let skipped = 0
    let errors = 0

    for (const p of participants) {
      if (!p.id) continue

      const jidMatch = p.id.match(/^(\d+)@s\.whatsapp\.net/)
      if (!jidMatch) continue

      const fullPhone = jidMatch[1]
      const phone = fullPhone.startsWith('62') ? fullPhone.substring(2) : fullPhone

      if (!phone || phone.length < 9) continue

      if (existingUsers[phone]) {
        skipped++
        continue
      }

      try {
        const userData = JSON.stringify({
          name: p.notify || p.verifiedName || 'Member ' + phone,
          createdAt: Date.now(),
          expired: null,
          source: 'whatsapp_group'
        })

        await redis.hset(REDIS_KEYS.USERS, { [phone]: userData })
        added++
      } catch (err) {
        errors++
      }
    }

    pushLog(`WA | Sync completed: ${added} added, ${skipped} skipped`)
    res.json({ success: true, added, skipped, errors, total: participants.length })
  } catch (e) {
    pushLog(`WA | Sync error: ${e.message}`)
    res.json({ success: false, error: e.message })
  }
})


// ==================== REGISTRATION ENDPOINTS ====================

// Register endpoint - user submit pendaftaran
app.post('/api/register', rateLimit(5, 60000), async (req, res) => {
  try {
    const { phone, name } = req.body

    if (!phone || !name) {
      return res.json({ success: false, message: 'Nama dan nomor HP wajib diisi' })
    }

    // Normalize phone
    let normalizedPhone = phone.replace(/\D/g, '')
    if (normalizedPhone.startsWith('0')) normalizedPhone = '62' + normalizedPhone.substring(1)
    if (!normalizedPhone.startsWith('62')) normalizedPhone = '62' + normalizedPhone

    // Check if already registered
    const existing = await redis.hget(REDIS_KEYS.USERS, normalizedPhone)
    if (existing) {
      return res.json({ success: false, message: 'Nomor ini sudah terdaftar. Silakan login.' })
    }

    // Check if already pending
    const existingPending = await redis.hget(REDIS_KEYS.PENDING_REGISTRATIONS, normalizedPhone)
    if (existingPending) {
      return res.json({ success: false, message: 'Pendaftaran Anda sedang menunggu persetujuan admin.' })
    }

    // Add to pending (stored in Redis)
    await redis.hset(REDIS_KEYS.PENDING_REGISTRATIONS, {
      [normalizedPhone]: JSON.stringify({
        name: name,
        phone: normalizedPhone,
        timestamp: Date.now()
      })
    })

    // Send notification to all admin phones via WhatsApp
    if (isReady && sock) {
      for (const adminPhone of ADMIN_PHONES) {
        try {
          const adminJid = adminPhone + '@s.whatsapp.net'
          await sock.sendMessage(adminJid, {
            text: `🔔 *PENDAFTARAN BARU*\n\nNama: *${name}*\nNo HP: ${normalizedPhone}\n\nSilakan ACC di menu admin:\nhttps://ts.muhamadaliyudin.xyz/admin/users`
          })
          pushLog(`REGISTER | Notification sent to admin ${adminPhone} for ${normalizedPhone}`)
        } catch (e) {
          pushLog(`REGISTER | Failed to send admin notification to ${adminPhone}: ${e.message}`)
        }
      }
    }

    pushLog(`REGISTER | New registration: ${name} (${normalizedPhone})`)

    res.json({
      success: true,
      message: 'Pendaftaran berhasil dikirim! Tunggu persetujuan admin.'
    })
  } catch (e) {
    res.json({ success: false, message: 'Terjadi kesalahan. Coba lagi.' })
  }
})

// Get pending registrations (admin only)
app.get('/api/pending-registrations', async (req, res) => {
  if (!requireAdminPassword(req, res)) return
  try {
    const all = await redis.hgetall(REDIS_KEYS.PENDING_REGISTRATIONS)

    // Debug log

    if (!all) {
      return res.json({ registrations: [] })
    }

    const list = []

    // Upstash returns object {key: value, key2: value2}
    // Or could be array [key, value, key2, value2]
    if (Array.isArray(all)) {
      // Handle array format [key, val, key, val...]
      for (let i = 0; i < all.length; i += 2) {
        try {
          const data = all[i + 1]
          if (data) {
            const parsed = typeof data === 'string' ? JSON.parse(data) : data
            list.push(parsed)
          }
        } catch (e) {}
      }
    } else if (typeof all === 'object') {
      // Handle object format
      for (const data of Object.values(all)) {
        try {
          const parsed = typeof data === 'string' ? JSON.parse(data) : data
          list.push(parsed)
        } catch (e) {}
      }
    }

    res.json({ registrations: list })
  } catch (e) {
    res.json({ registrations: [] })
  }
})

// Check if user exists in database
app.get('/api/check-user/:phone', async (req, res) => {
  try {
    const phone = req.params.phone
    const userData = await redis.hget(REDIS_KEYS.USERS, phone)
    if (userData) {
      const user = typeof userData === 'string' ? JSON.parse(userData) : userData
      res.json({ exists: true, user })
    } else {
      res.json({ exists: false })
    }
  } catch (e) {
    res.json({ error: e.message })
  }
})

// Approve registration (admin only)
app.post('/api/approve-registration', async (req, res) => {
  if (!requireAdminPassword(req, res)) return
  try {
    const { phone } = req.body

    const pendingData = await redis.hget(REDIS_KEYS.PENDING_REGISTRATIONS, phone)

    if (!pendingData) {
      return res.json({ success: false, message: 'Pendaftaran tidak ditemukan' })
    }

    // Handle both string and object formats
    const registration = typeof pendingData === 'string' ? JSON.parse(pendingData) : pendingData

    // Create user
    const userData = {
      phone: phone,
      name: registration.name,
      createdAt: new Date().toISOString(),
      active: true
    }

    // Use correct Upstash hset syntax
    await redis.hset(REDIS_KEYS.USERS, { [phone]: JSON.stringify(userData) })

    // Remove from pending (Redis)
    await redis.hdel(REDIS_KEYS.PENDING_REGISTRATIONS, phone)

    // Send approval message to user
    if (isReady && sock) {
      try {
        const userJid = phone + '@s.whatsapp.net'
        await sock.sendMessage(userJid, {
          text: `✅ *PENDAFTARAN DISETUJUI*\n\nHalo ${registration.name}!\n\nPendaftaran Anda telah disetujui.\nSilakan login di:\nhttps://ts.muhamadaliyudin.xyz/login\n\nGunakan nomor ini untuk login.`
        })
      } catch (e) {}
    }

    pushLog(`REGISTER | Approved: ${registration.name} (${phone})`)

    res.json({ success: true, message: 'Pendaftaran disetujui' })
  } catch (e) {
    res.json({ success: false, message: 'Gagal menyetujui pendaftaran: ' + e.message })
  }
})

// Reject registration (admin only)
app.post('/api/reject-registration', async (req, res) => {
  if (!requireAdminPassword(req, res)) return
  try {
    const { phone, reason } = req.body

    const pendingData = await redis.hget(REDIS_KEYS.PENDING_REGISTRATIONS, phone)

    if (!pendingData) {
      return res.json({ success: false, message: 'Pendaftaran tidak ditemukan' })
    }

    // Handle both string and object formats
    const registration = typeof pendingData === 'string' ? JSON.parse(pendingData) : pendingData

    // Remove from pending (Redis)
    await redis.hdel(REDIS_KEYS.PENDING_REGISTRATIONS, phone)

    // Send rejection message to user
    if (isReady && sock) {
      try {
        const userJid = phone + '@s.whatsapp.net'
        await sock.sendMessage(userJid, {
          text: `❌ *PENDAFTARAN DITOLAK*\n\nMaaf ${registration.name},\n\nPendaftaran Anda tidak disetujui.${reason ? '\nAlasan: ' + reason : ''}\n\nSilakan hubungi admin untuk informasi lebih lanjut.`
        })
      } catch (e) {}
    }

    pushLog(`REGISTER | Rejected: ${registration.name} (${phone})`)

    res.json({ success: true, message: 'Pendaftaran ditolak' })
  } catch (e) {
    res.json({ success: false, message: 'Gagal menolak pendaftaran: ' + e.message })
  }
})


// ==================== ADMIN PHONES MANAGEMENT ====================

// Get admin phones
app.get('/api/admin-phones', (req, res) => {
  if (!req._adminAuthed && !isAdminCookieValid(req) && req.headers['x-admin-password'] !== ADMIN_PASSWORD) {
    return res.status(403).json({ error: 'Unauthorized' })
  }
  res.json({ success: true, phones: ADMIN_PHONES })
})

// Update admin phones
app.post('/api/admin-phones', express.json(), (req, res) => {
  if (!isAdminCookieValid(req) && req.headers['x-admin-password'] !== ADMIN_PASSWORD) {
    return res.status(403).json({ error: 'Unauthorized' })
  }
  try {
    const { phones } = req.body
    if (!Array.isArray(phones) || phones.length === 0) {
      return res.json({ success: false, message: 'Minimal 1 nomor admin' })
    }

    // Normalize phones
    ADMIN_PHONES = phones.map(p => {
      let normalized = p.replace(/\D/g, '')
      if (normalized.startsWith('0')) normalized = '62' + normalized.substring(1)
      if (!normalized.startsWith('62')) normalized = '62' + normalized
      return normalized
    }).filter(p => p.length >= 10)

    if (ADMIN_PHONES.length === 0) {
      ADMIN_PHONES = ['62895701692525'] // Fallback
      return res.json({ success: false, message: 'Nomor tidak valid' })
    }

    pushLog(`ADMIN | Admin phones updated: ${ADMIN_PHONES.join(', ')}`)
    res.json({ success: true, phones: ADMIN_PHONES })
  } catch (e) {
    res.json({ success: false, message: e.message })
  }
})

// ==================== LOGIN PAGE ====================
app.get('/login', (_req, res) => {
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate')
  const tsSiteKey = process.env.TURNSTILE_SITE_KEY || ''
  const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, user-scalable=no">
  <meta name="theme-color" content="#000000">
  <link rel="manifest" href="/manifest.json">
  <link rel="icon" href="/icon.png">
  ${tsSiteKey ? '<script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>' : ''}
  <style>body,*{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;}</style>
  <title>Login - Gold Price Monitor</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      background: #000000;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 20px;
      color: #e7e9ea;
      position: relative;
      overflow: hidden;
    }
    body::before {
      content: '';
      position: absolute;
      top: -50%;
      left: -50%;
      width: 200%;
      height: 200%;
      background: radial-gradient(circle at 30% 20%, rgba(247,147,26,0.08) 0%, transparent 50%),
                  radial-gradient(circle at 70% 80%, rgba(247,147,26,0.05) 0%, transparent 40%);
      animation: float 20s ease-in-out infinite;
      pointer-events: none;
    }
    @keyframes float {
      0%, 100% { transform: translate(0, 0) rotate(0deg); }
      50% { transform: translate(-2%, 2%) rotate(1deg); }
    }
    .container {
      width: 100%;
      max-width: 420px;
      text-align: center;
      position: relative;
      z-index: 1;
    }
    .card {
      background: rgba(10, 10, 10, 0.85);
      backdrop-filter: blur(14px);
      -webkit-backdrop-filter: blur(14px);
      border-radius: 16px;
      padding: 36px 30px;
      border: 1px solid rgba(255,255,255,0.08);
      border-top: 2px solid rgba(247,147,26,0.55);
      box-shadow: 0 8px 32px rgba(0,0,0,0.4);
    }
    .logo-container { margin-bottom: 28px; }
    .icon {
      width: 80px;
      height: 80px;
      margin: 0 auto 16px;
      border-radius: 16px;
      overflow: hidden;
      box-shadow: 0 6px 22px rgba(247,147,26,0.22);
      border: 1px solid rgba(247,147,26,0.3);
      transition: transform 0.3s ease;
    }
    .icon:hover { transform: scale(1.05); }
    .icon img { width: 100%; height: 100%; object-fit: cover; }
    h1 { color: #ffffff; font-size: 1.5em; font-weight: 700; margin-bottom: 10px; letter-spacing: -0.01em; }
    h1 span { color: #f7931a; }
    .subtitle {
      color: #8b949e;
      font-size: 0.72em;
      margin-bottom: 30px;
      line-height: 1.5;
      font-weight: 600;
      font-family: 'JetBrains Mono', monospace;
      text-transform: uppercase;
      letter-spacing: 1.5px;
    }
    .form-group { margin-bottom: 20px; text-align: left; }
    .form-group label { display: block; color: #8b949e; font-size: 0.72em; margin-bottom: 9px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.7px; }
    .form-group input {
      width: 100%;
      padding: 14px 16px;
      border: 1px solid rgba(255,255,255,0.1);
      border-radius: 10px;
      background: rgba(12, 12, 12, 0.9);
      color: #e6edf3;
      font-size: 1em;
      font-family: 'JetBrains Mono', monospace;
      letter-spacing: 0.5px;
      transition: all 0.2s ease;
    }
    .form-group input:focus {
      outline: none;
      border-color: #f7931a;
      background: #0c0c0c;
      box-shadow: 0 0 0 3px rgba(247,147,26,0.15);
    }
    .form-group input::placeholder { color: #4a5568; }
    .btn {
      width: 100%;
      padding: 15px;
      border: none;
      border-radius: 10px;
      font-size: 0.95em;
      font-weight: 700;
      letter-spacing: 0.3px;
      cursor: pointer;
      transition: all 0.2s ease;
      margin-bottom: 12px;
      font-family: inherit;
    }
    .btn-primary {
      background: linear-gradient(135deg, #f7931a 0%, #e8850f 100%);
      color: white;
      box-shadow: 0 3px 14px rgba(247,147,26,0.28);
    }
    .btn-primary:hover:not(:disabled) { transform: translateY(-1px); box-shadow: 0 6px 22px rgba(247,147,26,0.4); }
    .btn-primary:active:not(:disabled) { transform: translateY(0); }
    .btn-primary:disabled { opacity: 0.6; cursor: not-allowed; transform: none; }
    .btn-secondary {
      background: rgba(255,255,255,0.08);
      color: #8b949e;
      border: 1px solid rgba(255,255,255,0.1);
    }
    .btn-secondary:hover:not(:disabled) { background: rgba(255,255,255,0.12); color: #e7e9ea; }
    .link-register {
      color: #25D366;
      font-size: 0.85em;
      cursor: pointer;
      transition: all 0.2s ease;
    }
    .link-register:hover { color: #128C7E; text-decoration: underline; }
    .message {
      padding: 13px 15px;
      border-radius: 10px;
      margin-bottom: 20px;
      font-size: 0.85em;
      display: none;
      text-align: left;
      font-weight: 500;
    }
    .message.error { background: rgba(239,68,68,0.12); border: 1px solid rgba(239,68,68,0.3); color: #f87171; display: block; }
    .message.success { background: rgba(34,197,94,0.12); border: 1px solid rgba(34,197,94,0.3); color: #4ade80; display: block; }
    .message.info { background: rgba(247,147,26,0.12); border: 1px solid rgba(247,147,26,0.3); color: #f7931a; display: block; }
    .phone-prefix {
      display: flex;
      align-items: center;
      gap: 12px;
    }
    .phone-prefix span {
      background: rgba(247,147,26,0.1);
      padding: 14px 14px;
      border-radius: 10px;
      color: #f7931a;
      font-weight: 700;
      border: 1px solid rgba(247,147,26,0.25);
      font-size: 0.95em;
      font-family: 'JetBrains Mono', monospace;
    }
    .phone-prefix input { flex: 1; }
    .loading {
      display: inline-block;
      width: 20px;
      height: 20px;
      border: 2px solid rgba(255,255,255,0.3);
      border-radius: 50%;
      border-top-color: #fff;
      animation: spin 0.8s linear infinite;
      margin-right: 10px;
      vertical-align: middle;
    }
    @keyframes spin { to { transform: rotate(360deg); } }
    .pin-input-container {
      display: flex;
      gap: 10px;
      justify-content: center;
      margin-bottom: 20px;
    }
    .pin-input {
      width: 48px;
      height: 56px;
      text-align: center;
      font-size: 1.5em;
      font-weight: 700;
      border: 1px solid rgba(255,255,255,0.1);
      border-radius: 10px;
      background: rgba(12, 12, 12, 0.9);
      color: #f7931a;
      font-family: 'JetBrains Mono', monospace;
      transition: all 0.2s ease;
    }
    .pin-input:focus {
      outline: none;
      border-color: #f7931a;
      background: #0c0c0c;
      box-shadow: 0 0 0 3px rgba(247,147,26,0.15);
    }
    .pin-hint {
      margin-top: 12px;
      font-size: 0.8em;
      color: #71767b;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .pin-hint strong {
      color: #f7931a;
      margin-left: 4px;
    }
    .user-info {
      background: rgba(74,222,128,0.08);
      border: 1px solid rgba(74,222,128,0.2);
      border-radius: 12px;
      padding: 14px 16px;
      margin-bottom: 20px;
      text-align: left;
    }
    .user-info .name { color: #4ade80; font-weight: 600; font-size: 1.1em; }
    .user-info .phone { color: #8b949e; font-size: 0.9em; margin-top: 4px; }
    .step-indicator {
      display: flex;
      justify-content: center;
      gap: 8px;
      margin-bottom: 24px;
    }
    .step {
      width: 32px;
      height: 4px;
      border-radius: 2px;
      background: rgba(255,255,255,0.1);
      transition: all 0.3s ease;
    }
    .step.active { background: #f7931a; width: 48px; }
    .step.completed { background: #4ade80; }
    .footer-text { margin-top: 24px; font-size: 0.8em; color: #4a5568; }
    .footer-text a { color: #f7931a; text-decoration: none; }
    /* Modal for PIN Change */
    .modal-overlay {
      display: none;
      position: fixed;
      top: 0;
      left: 0;
      right: 0;
      bottom: 0;
      background: rgba(0,0,0,0.8);
      z-index: 1000;
      align-items: center;
      justify-content: center;
      padding: 20px;
    }
    .modal-overlay.show { display: flex; }
    .modal {
      background: rgba(20, 26, 34, 0.98);
      border-radius: 24px;
      padding: 32px;
      max-width: 400px;
      width: 100%;
      border: 1px solid rgba(255,255,255,0.1);
      box-shadow: 0 25px 80px rgba(0,0,0,0.5);
    }
    .modal h2 { color: #f7931a; font-size: 1.3em; margin-bottom: 12px; }
    .modal p { color: #8b949e; font-size: 0.9em; line-height: 1.6; margin-bottom: 24px; }
    .modal .warning {
      background: rgba(239,68,68,0.1);
      border: 1px solid rgba(239,68,68,0.2);
      border-radius: 10px;
      padding: 12px;
      margin-bottom: 20px;
      color: #f87171;
      font-size: 0.85em;
    }
    @media (max-width: 480px) {
      .card { padding: 30px 22px; border-radius: 14px; }
      .icon { width: 68px; height: 68px; }
      h1 { font-size: 1.3em; }
      .subtitle { font-size: 0.85em; }
      .form-group input { padding: 14px 16px; }
      .btn { padding: 14px; }
      .pin-input { width: 42px; height: 50px; font-size: 1.3em; }
    }
    /* Light mode login — konsisten dengan monitoring page */
    body.light-mode { background: #ffffff; color: #111111; }
    body.light-mode::before { display: none; }
    body.light-mode .card { background: #ffffff; border-color: #e5e7eb; border-top-color: rgba(247,147,26,0.6); box-shadow: 0 4px 20px rgba(0,0,0,0.08); backdrop-filter: none; }
    body.light-mode h1 { color: #111111; }
    body.light-mode h1 span { color: #c2700f; }
    body.light-mode .subtitle { color: #444444; }
    body.light-mode .form-group label { color: #333333; }
    body.light-mode .form-group input { background: #fff; border-color: #e0e0e0; color: #111; }
    body.light-mode .form-group input:focus { border-color: #c2700f; background: #fff; box-shadow: 0 0 0 3px rgba(194,112,15,0.15); }
    body.light-mode .form-group input::placeholder { color: #999; }
    body.light-mode .phone-prefix span { background: #fef3c7; border-color: #fcd34d; color: #b45309; }
    body.light-mode .btn-secondary { background: #fff; color: #333; border-color: #e0e0e0; }
    body.light-mode .btn-secondary:hover:not(:disabled) { background: #fff; border-color: #bbb; color: #111; }
    body.light-mode .message.error { background: #fee2e2; border-color: #fca5a5; color: #b91c1c; }
    body.light-mode .message.success { background: #dcfce7; border-color: #86efac; color: #15803d; }
    body.light-mode .message.info { background: #fef3c7; border-color: #fcd34d; color: #b45309; }
    body.light-mode .step { background: #e0e0e0; }
    body.light-mode .step.active { background: #c2700f; width: 48px; }
    body.light-mode .step.completed { background: #15803d; }
    body.light-mode .pin-input { background: #fff; border-color: #e0e0e0; color: #c2700f; }
    body.light-mode .pin-input:focus { border-color: #c2700f; background: #fff; box-shadow: 0 0 0 3px rgba(194,112,15,0.15); }
    body.light-mode .pin-hint { color: #666666; }
    body.light-mode .pin-hint strong { color: #c2700f; }
    body.light-mode .user-info { background: #dcfce7; border-color: #86efac; }
    body.light-mode .user-info .name { color: #15803d; }
    body.light-mode .user-info .phone { color: #444444; }
    body.light-mode .footer-text { color: #666666; }
    body.light-mode .footer-text a { color: #c2700f; }
  </style>
</head>
<body>
  <div class="container">
    <div class="card">
      <div class="logo-container">
        <div class="icon">
          <img src="/icon.png" alt="Gold Monitor">
        </div>
        <h1><span>Treasury</span> Price Monitor</h1>
        <p class="subtitle">Pantau harga emas real-time dengan akurat</p>
      </div>

      <!-- Notice: sesi dikeluarkan karena login di perangkat lain -->
      <div id="kickedNotice" style="display:none;text-align:left;background:rgba(251,191,36,0.08);border:1px solid rgba(251,191,36,0.35);border-left:3px solid #fbbf24;border-radius:10px;padding:12px 14px;margin-bottom:18px;">
        <div style="display:flex;align-items:center;gap:8px;color:#fbbf24;font-weight:700;font-size:0.82em;margin-bottom:4px;">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0;"><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
          Sesi Berakhir — Login di Perangkat Lain
        </div>
        <div style="color:#c9a86a;font-size:0.76em;line-height:1.5;">Akun Anda baru saja masuk di perangkat lain. Demi keamanan, maksimal <b>3 perangkat aktif</b> per akun — sesi di perangkat ini dikeluarkan otomatis. Silakan login kembali untuk melanjutkan.</div>
      </div>

      <!-- Step Indicator -->
      <div class="step-indicator">
        <div class="step active" id="step1"></div>
        <div class="step" id="step2"></div>
      </div>

      <div id="message" class="message"></div>

      <!-- Step 1: Phone Number -->
      <div id="phoneForm">
        <div class="form-group">
          <label>Nomor WhatsApp</label>
          <div class="phone-prefix">
            <span>+62</span>
            <input type="tel" id="phoneInput" placeholder="8xxxxxxxxxx" maxlength="12" autocomplete="tel">
          </div>
        </div>
        ${tsSiteKey ? `<div class="cf-turnstile" data-sitekey="${tsSiteKey}" data-theme="dark" data-appearance="interaction-only" style="display:flex;justify-content:center;"></div>` : ''}
        <button class="btn btn-primary" id="checkBtn" onclick="checkUser()">
          Masuk ke Akun
        </button>
      </div>

      <!-- Step 2: PIN Input -->
      <div id="pinForm" style="display:none;">
        <div class="user-info" id="userInfo">
          <div class="name" id="userName">-</div>
          <div class="phone" id="userPhone">+62xxx</div>
        </div>

        <div class="form-group" style="text-align:center;">
          <label style="text-align:center;">Masukkan PIN 6 Digit</label>
          <div class="pin-input-container">
            <input type="password" class="pin-input" maxlength="1" inputmode="numeric" pattern="[0-9]" autocomplete="off">
            <input type="password" class="pin-input" maxlength="1" inputmode="numeric" pattern="[0-9]" autocomplete="off">
            <input type="password" class="pin-input" maxlength="1" inputmode="numeric" pattern="[0-9]" autocomplete="off">
            <input type="password" class="pin-input" maxlength="1" inputmode="numeric" pattern="[0-9]" autocomplete="off">
            <input type="password" class="pin-input" maxlength="1" inputmode="numeric" pattern="[0-9]" autocomplete="off">
            <input type="password" class="pin-input" maxlength="1" inputmode="numeric" pattern="[0-9]" autocomplete="off">
          </div>
          <div class="pin-hint">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="vertical-align:middle;margin-right:4px;"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>
            PIN default: <strong>000000</strong>
          </div>
        </div>

        <button class="btn btn-primary" id="loginBtn" onclick="submitLogin()">
          Masuk
        </button>
        <button class="btn btn-secondary" onclick="backToPhone()">
          Ganti Nomor
        </button>
      </div>

    </div>
  </div>

  <!-- Modal: Change PIN (Required) -->
  <div class="modal-overlay" id="changePinModal">
    <div class="modal">
      <h2>Ganti PIN Anda</h2>
      <p>Untuk keamanan akun, Anda wajib mengganti PIN default sebelum melanjutkan.</p>
      <div class="warning">
        Anda tidak dapat melewati langkah ini. PIN baru harus berbeda dari PIN default.
      </div>

      <div id="changePinMessage" class="message" style="display:none;"></div>

      <div class="form-group" style="text-align:center;">
        <label style="text-align:center;">PIN Baru (6 digit)</label>
        <div class="pin-input-container" id="newPinInputs">
          <input type="password" class="pin-input new-pin" maxlength="1" inputmode="numeric" pattern="[0-9]" autocomplete="off">
          <input type="password" class="pin-input new-pin" maxlength="1" inputmode="numeric" pattern="[0-9]" autocomplete="off">
          <input type="password" class="pin-input new-pin" maxlength="1" inputmode="numeric" pattern="[0-9]" autocomplete="off">
          <input type="password" class="pin-input new-pin" maxlength="1" inputmode="numeric" pattern="[0-9]" autocomplete="off">
          <input type="password" class="pin-input new-pin" maxlength="1" inputmode="numeric" pattern="[0-9]" autocomplete="off">
          <input type="password" class="pin-input new-pin" maxlength="1" inputmode="numeric" pattern="[0-9]" autocomplete="off">
        </div>
      </div>

      <div class="form-group" style="text-align:center;">
        <label style="text-align:center;">Konfirmasi PIN Baru</label>
        <div class="pin-input-container" id="confirmPinInputs">
          <input type="password" class="pin-input confirm-pin" maxlength="1" inputmode="numeric" pattern="[0-9]" autocomplete="off">
          <input type="password" class="pin-input confirm-pin" maxlength="1" inputmode="numeric" pattern="[0-9]" autocomplete="off">
          <input type="password" class="pin-input confirm-pin" maxlength="1" inputmode="numeric" pattern="[0-9]" autocomplete="off">
          <input type="password" class="pin-input confirm-pin" maxlength="1" inputmode="numeric" pattern="[0-9]" autocomplete="off">
          <input type="password" class="pin-input confirm-pin" maxlength="1" inputmode="numeric" pattern="[0-9]" autocomplete="off">
          <input type="password" class="pin-input confirm-pin" maxlength="1" inputmode="numeric" pattern="[0-9]" autocomplete="off">
        </div>
      </div>

      <button class="btn btn-primary" id="savePinBtn" onclick="saveNewPin()">
        Simpan PIN Baru
      </button>
    </div>
  </div>

  <script>
    let currentPhone = '';
    let currentSession = '';
    let userName = '';

    // Tampilkan pemberitahuan bila sesi sebelumnya dikeluarkan karena login di perangkat lain
    try {
      const kickedAt = localStorage.getItem('gold_kicked_notice');
      if (kickedAt) {
        localStorage.removeItem('gold_kicked_notice');
        // hanya tampilkan bila kejadiannya belum lama (< 24 jam)
        if (Date.now() - parseInt(kickedAt, 10) < 24 * 60 * 60 * 1000) {
          const kn = document.getElementById('kickedNotice');
          if (kn) kn.style.display = 'block';
        }
      }
    } catch (e) {}

    // Check if already logged in
    const existingSession = localStorage.getItem('goldmonitor_session');
    if (existingSession) {
      fetch('/api/verify-session?session=' + existingSession)
        .then(r => r.json())
        .then(data => {
          if (data.valid) {
            // Check if PIN change required
            fetch('/api/check-pin-status?session=' + existingSession)
              .then(r => r.json())
              .then(pinData => {
                if (pinData.requirePinChange) {
                  currentSession = existingSession;
                  document.getElementById('changePinModal').classList.add('show');
                  setupPinInputs(document.querySelectorAll('.new-pin'), () => {
                    document.querySelector('.confirm-pin').focus();
                  });
                  setupPinInputs(document.querySelectorAll('.confirm-pin'), () => saveNewPin());
                } else {
                  window.location.replace('/monitoring');
                }
              });
          } else if (data.reason !== 'server_error') {
            // server_error = gangguan sementara — jangan hapus session yang mungkin masih valid
            localStorage.removeItem('goldmonitor_session');
          }
        })
        .catch(() => {});
    }

    function showMessage(text, type, elementId = 'message') {
      const msg = document.getElementById(elementId);
      msg.textContent = text;
      msg.className = 'message ' + type;
      msg.style.display = 'block';
    }

    function hideMessage(elementId = 'message') {
      const msg = document.getElementById(elementId);
      msg.className = 'message';
      msg.style.display = 'none';
    }

    function setLoading(btn, loading, text = 'Memproses...') {
      if (loading) {
        btn.disabled = true;
        btn.dataset.originalText = btn.textContent;
        btn.innerHTML = '<span class="loading"></span>' + text;
      } else {
        btn.disabled = false;
        btn.textContent = btn.dataset.originalText || 'Submit';
      }
    }

    // Setup PIN input auto-focus + optional auto-submit on completion
    function setupPinInputs(inputs, onComplete) {
      inputs.forEach((input, index) => {
        input.addEventListener('input', (e) => {
          const value = e.target.value;
          if (value && index < inputs.length - 1) {
            inputs[index + 1].focus();
          }
          // Auto-submit when last digit filled
          if (value && index === inputs.length - 1 && onComplete) {
            setTimeout(onComplete, 300);
          }
        });
        input.addEventListener('keydown', (e) => {
          if (e.key === 'Backspace' && !e.target.value && index > 0) {
            inputs[index - 1].focus();
          }
        });
        input.addEventListener('paste', (e) => {
          e.preventDefault();
          const paste = (e.clipboardData || window.clipboardData).getData('text');
          const digits = paste.replace(/\\D/g, '').split('').slice(0, 6);
          digits.forEach((digit, i) => {
            if (inputs[i]) inputs[i].value = digit;
          });
          if (digits.length > 0) {
            inputs[Math.min(digits.length, inputs.length - 1)].focus();
          }
        });
      });
    }

    // Get PIN value from inputs
    function getPinValue(inputs) {
      return Array.from(inputs).map(i => i.value).join('');
    }

    // Clear PIN inputs
    function clearPinInputs(inputs) {
      inputs.forEach(i => i.value = '');
      if (inputs[0]) inputs[0].focus();
    }

    // Daftar via WhatsApp
    function daftarWhatsApp() {
      const phoneInput = document.getElementById('phoneInput');
      let phone = phoneInput.value.replace(/\\D/g, '');

      if (phone.startsWith('62')) phone = phone.substring(2);
      if (phone.startsWith('0')) phone = phone.substring(1);

      if (!phone || phone.length < 9) {
        showMessage('Masukkan nomor WhatsApp Anda terlebih dahulu', 'error');
        phoneInput.focus();
        return;
      }

      const message = encodeURIComponent('Halo, saya ingin daftar grup harga Treasury.\\n\\nNomor WA saya: +62' + phone);
      const waUrl = 'https://wa.me/62895701692525?text=' + message;
      window.open(waUrl, '_blank');
    }

    // Step 1: Check if user exists
    async function checkUser() {
      const phoneInput = document.getElementById('phoneInput');
      let phone = phoneInput.value.replace(/\\D/g, '');

      if (phone.startsWith('62')) phone = phone.substring(2);
      if (phone.startsWith('0')) phone = phone.substring(1);

      if (!phone || phone.length < 9) {
        showMessage('Masukkan nomor HP yang valid', 'error');
        return;
      }

      currentPhone = phone;
      const btn = document.getElementById('checkBtn');
      setLoading(btn, true, 'Memeriksa...');
      hideMessage();

      try {
        let tsToken = '';
        if (window.turnstile) { try { tsToken = turnstile.getResponse() || ''; } catch {} }
        const res = await fetch('/api/check-user', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ phone, 'cf-turnstile-response': tsToken })
        });

        const data = await res.json();

        if (data.success) {
          userName = data.user.name;
          document.getElementById('userName').textContent = data.user.name;
          document.getElementById('userPhone').textContent = '+62' + phone;

          // Show PIN form
          document.getElementById('phoneForm').style.display = 'none';
          document.getElementById('pinForm').style.display = 'block';
          document.getElementById('step1').classList.remove('active');
          document.getElementById('step1').classList.add('completed');
          document.getElementById('step2').classList.add('active');

          // Setup PIN inputs
          const pinInputs = document.querySelectorAll('#pinForm .pin-input');
          setupPinInputs(pinInputs, () => submitLogin());
          pinInputs[0].focus();
        } else if (data.needRegister) {
          // Nomor tidak terdaftar — langsung redirect ke WA admin
          const message = encodeURIComponent('Halo, saya ingin daftar grup harga Treasury.\\n\\nNomor WA saya: +62' + phone);
          window.location.href = 'https://wa.me/62895701692525?text=' + message;
          return;
        } else {
          showMessage(data.error || 'Gagal memeriksa nomor', 'error');
        }
      } catch (e) {
        showMessage('Terjadi kesalahan. Coba lagi.', 'error');
      }

      // Token Turnstile sekali pakai — reset agar percobaan berikutnya dapat token baru
      if (window.turnstile) { try { turnstile.reset(); } catch {} }
      setLoading(btn, false);
      btn.textContent = 'Masuk ke Akun';
    }

    // Back to phone input
    function backToPhone() {
      document.getElementById('phoneForm').style.display = 'block';
      document.getElementById('pinForm').style.display = 'none';
      document.getElementById('step1').classList.add('active');
      document.getElementById('step1').classList.remove('completed');
      document.getElementById('step2').classList.remove('active');
      hideMessage();
      clearPinInputs(document.querySelectorAll('#pinForm .pin-input'));
    }

    // Step 2: Submit login with PIN
    async function submitLogin() {
      const pinInputs = document.querySelectorAll('#pinForm .pin-input');
      const pin = getPinValue(pinInputs);

      if (pin.length !== 6) {
        showMessage('Masukkan PIN 6 digit', 'error');
        return;
      }

      const btn = document.getElementById('loginBtn');
      setLoading(btn, true, 'Masuk...');
      hideMessage();

      try {
        const res = await fetch('/api/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          // oldSession: session lama device ini (kalau ada) — server akan menggantinya,
          // bukan menendang session device lain
          body: JSON.stringify({ phone: currentPhone, pin, oldSession: localStorage.getItem('goldmonitor_session') || undefined })
        });

        const data = await res.json();

        if (data.success) {
          localStorage.setItem('goldmonitor_session', data.sessionId);
          try { localStorage.setItem('gold_sess_ok_at', String(Date.now())); } catch(e) {}
          currentSession = data.sessionId;

          if (data.requirePinChange) {
            // Show PIN change modal
            document.getElementById('changePinModal').classList.add('show');
            setupPinInputs(document.querySelectorAll('.new-pin'), () => {
              document.querySelector('.confirm-pin').focus();
            });
            setupPinInputs(document.querySelectorAll('.confirm-pin'), () => saveNewPin());
            document.querySelector('.new-pin').focus();
          } else {
            showMessage('Login berhasil! Mengalihkan...', 'success');
            setTimeout(() => {
              window.location.replace('/monitoring');
            }, 500);
          }
        } else {
          showMessage(data.error || 'Login gagal', 'error');
          clearPinInputs(pinInputs);
        }
      } catch (e) {
        showMessage('Terjadi kesalahan. Coba lagi.', 'error');
      }

      setLoading(btn, false);
      btn.textContent = 'Masuk';
    }

    // Save new PIN
    async function saveNewPin() {
      const newPinInputs = document.querySelectorAll('.new-pin');
      const confirmPinInputs = document.querySelectorAll('.confirm-pin');
      const newPin = getPinValue(newPinInputs);
      const confirmPin = getPinValue(confirmPinInputs);

      hideMessage('changePinMessage');

      if (newPin.length !== 6) {
        showMessage('PIN baru harus 6 digit', 'error', 'changePinMessage');
        return;
      }

      if (newPin !== confirmPin) {
        showMessage('Konfirmasi PIN tidak cocok', 'error', 'changePinMessage');
        clearPinInputs(confirmPinInputs);
        return;
      }

      // Check if new PIN is same as default (000000)
      if (newPin === '000000') {
        showMessage('PIN baru tidak boleh sama dengan PIN default (000000)', 'error', 'changePinMessage');
        clearPinInputs(newPinInputs);
        clearPinInputs(confirmPinInputs);
        return;
      }

      const btn = document.getElementById('savePinBtn');
      setLoading(btn, true, 'Menyimpan...');

      try {
        const res = await fetch('/api/change-pin', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ session: currentSession, newPin })
        });

        const data = await res.json();

        if (data.success) {
          showMessage('PIN berhasil diubah! Mengalihkan...', 'success', 'changePinMessage');
          setTimeout(() => {
            window.location.replace('/monitoring');
          }, 1000);
        } else {
          showMessage(data.error || 'Gagal mengubah PIN', 'error', 'changePinMessage');
        }
      } catch (e) {
        showMessage('Terjadi kesalahan. Coba lagi.', 'error', 'changePinMessage');
      }

      setLoading(btn, false);
      btn.textContent = 'Simpan PIN Baru';
    }

    // Enter key handlers
    document.getElementById('phoneInput').addEventListener('keypress', (e) => {
      if (e.key === 'Enter') checkUser();
    });

    // Register Service Worker
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('/sw.js').catch(() => {});
    }
  </script>
</body>
</html>`;
  res.send(html);
})

// ==================== LOGIN VIA LINK ====================
app.get('/auth/:token', async (req, res) => {
  const { token } = req.params

  try {
    // Get token data from Redis
    const tokenData = await redis.hget(REDIS_KEYS.LOGIN_TOKENS, token)
    if (!tokenData) {
      return res.send(getLoginErrorPage('Link login tidak valid atau sudah kadaluarsa.'))
    }

    const data = typeof tokenData === 'string' ? JSON.parse(tokenData) : tokenData

    // Check expiry (5 minutes)
    if (Date.now() > data.expires) {
      await redis.hdel(REDIS_KEYS.LOGIN_TOKENS, token)
      return res.send(getLoginErrorPage('Link login sudah kadaluarsa. Silakan minta link baru.'))
    }

    const phone = data.phone

    // Check if user is blocked (nomor admin tidak pernah diblokir)
    if (phone !== ADMIN_PHONE) {
      const blocked = await redis.hget(REDIS_KEYS.BLOCKED_USERS, phone)
      if (blocked) {
        return res.send(getLoginErrorPage('Akun Anda diblokir. Hubungi admin untuk membuka blokir.'))
      }
    }

    // Check if user is valid
    const check = await isUserValid(phone)
    if (!check.valid) {
      if (check.reason === 'expired') {
        return res.send(getLoginErrorPage('Akun sudah expired. Hubungi admin untuk perpanjang.'))
      }
      return res.send(getLoginErrorPage('Akun tidak ditemukan atau tidak valid.'))
    }

    // Check existing sessions for this user (max 2 devices, kecuali nomor admin tanpa batas)
    if (phone !== ADMIN_PHONE) {
      const allSessions = await redis.hgetall(REDIS_KEYS.SESSIONS) || {}
      const userSessions = []
      for (const [sessId, sessPhone] of Object.entries(allSessions)) {
        if (sessPhone === phone) {
          userSessions.push(sessId)
        }
      }

      // Device lama ditendang dan ditandai agar dapat notif "login di perangkat lain"
      while (userSessions.length >= 3) { // max 3 device per user
        const oldSess = userSessions.shift()
        await redis.hdel(REDIS_KEYS.SESSIONS, oldSess)
        await redis.hset(REDIS_KEYS.KICKED_SESSIONS, { [oldSess]: Date.now().toString() })
        pushLog('Auth | User +' + phone + ' login di perangkat baru — session lama ditendang')
      }
    }

    // Create new session
    const sessionId = generateSessionId()
    await redis.hset(REDIS_KEYS.SESSIONS, { [sessionId]: phone })

    // Delete used token
    await redis.hdel(REDIS_KEYS.LOGIN_TOKENS, token)

    pushLog('Auth | User +62' + phone + ' logged in via link')

    // Return success page that saves session and redirects
    const userName = check.user?.name || 'User'
    res.send('<!DOCTYPE html>' +
'<html>' +
'<head>' +
'  <meta charset="UTF-8">' +
'  <meta name="viewport" content="width=device-width, initial-scale=1.0">' +
'  <meta name="theme-color" content="#0f1419">' +
'  <link rel="icon" href="/icon.png">' +
'  <title>Login Berhasil</title>' +
'  <style>' +
'    body {' +
'      font-family: "Segoe UI", sans-serif;' +
'      background: linear-gradient(135deg, #0f1419, #1a1f26);' +
'      min-height: 100vh;' +
'      display: flex;' +
'      align-items: center;' +
'      justify-content: center;' +
'      margin: 0;' +
'      color: #e7e9ea;' +
'    }' +
'    .card {' +
'      background: rgba(26, 31, 38, 0.95);' +
'      border-radius: 20px;' +
'      padding: 40px;' +
'      text-align: center;' +
'      border: 1px solid #2f3640;' +
'      max-width: 400px;' +
'    }' +
'    .success-icon { font-size: 60px; margin-bottom: 20px; }' +
'    h1 { color: #00ff88; margin-bottom: 10px; }' +
'    p { color: #71767b; }' +
'    .loading {' +
'      display: inline-block;' +
'      width: 30px;' +
'      height: 30px;' +
'      border: 3px solid #2f3640;' +
'      border-radius: 50%;' +
'      border-top-color: #f7931a;' +
'      animation: spin 1s linear infinite;' +
'      margin-top: 20px;' +
'    }' +
'    @keyframes spin { to { transform: rotate(360deg); } }' +
'  </style>' +
'</head>' +
'<body>' +
'  <div class="card">' +
'    <div class="success-icon"><svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="#26a69a" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg></div>' +
'    <h1>Login Berhasil!</h1>' +
'    <p>Selamat datang, ' + userName + '</p>' +
'    <p style="margin-top:10px;">Mengalihkan ke monitoring...</p>' +
'    <div class="loading"></div>' +
'  </div>' +
'  <script>' +
'    localStorage.setItem("goldmonitor_session", "' + sessionId + '");' +
'    try { localStorage.setItem("gold_sess_ok_at", String(Date.now())); } catch(e) {}' +
'    setTimeout(function() {' +
'      window.location.replace("/monitoring");' +
'    }, 1500);' +
'  </script>' +
'</body>' +
'</html>')

  } catch (e) {
    pushLog('Auth | Login link error: ' + e.message)
    res.send(getLoginErrorPage('Terjadi kesalahan. Silakan coba lagi.'))
  }
})

// Helper: Login error page
function getLoginErrorPage(message) {
  return '<!DOCTYPE html>' +
'<html>' +
'<head>' +
'  <meta charset="UTF-8">' +
'  <meta name="viewport" content="width=device-width, initial-scale=1.0">' +
'  <meta name="theme-color" content="#0f1419">' +
'  <link rel="icon" href="/icon.png">' +
'  <title>Login Gagal</title>' +
'  <style>' +
'    body {' +
'      font-family: "Segoe UI", sans-serif;' +
'      background: linear-gradient(135deg, #0f1419, #1a1f26);' +
'      min-height: 100vh;' +
'      display: flex;' +
'      align-items: center;' +
'      justify-content: center;' +
'      margin: 0;' +
'      color: #e7e9ea;' +
'    }' +
'    .card {' +
'      background: rgba(26, 31, 38, 0.95);' +
'      border-radius: 20px;' +
'      padding: 40px;' +
'      text-align: center;' +
'      border: 1px solid #2f3640;' +
'      max-width: 400px;' +
'    }' +
'    .error-icon { font-size: 60px; margin-bottom: 20px; }' +
'    h1 { color: #ff6b6b; margin-bottom: 10px; }' +
'    p { color: #71767b; margin-bottom: 20px; }' +
'    a {' +
'      display: inline-block;' +
'      background: linear-gradient(135deg, #f7931a, #ff6b00);' +
'      color: white;' +
'      padding: 12px 30px;' +
'      border-radius: 10px;' +
'      text-decoration: none;' +
'      font-weight: bold;' +
'    }' +
'  </style>' +
'</head>' +
'<body>' +
'  <div class="card">' +
'    <div class="error-icon"><svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="#ef5350" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg></div>' +
'    <h1>Login Gagal</h1>' +
'    <p>' + message + '</p>' +
'    <a href="/login">Coba Lagi</a>' +
'  </div>' +
'</body>' +
'</html>'
}

// Redirect /install to /login
app.get('/install', (_req, res) => {
  res.redirect('/login');
})

// ==================== ADMIN PANEL - USER MANAGEMENT ====================
app.get('/admin/users', (req, res) => {
  if (!isAdminCookieValid(req)) {
    return res.redirect('/admin-login?redirect=' + encodeURIComponent('/admin/users'))
  }
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate')
  const authScript = getAuthCheckScript('/admin/users')
  const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>body,*{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;}code,pre,.mono{font-family:'Courier New',Courier,monospace;}</style>
  <title>Admin - Kelola User</title>
${authScript}
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      background:
        radial-gradient(1000px 500px at 85% -10%, rgba(247,147,26,0.07), transparent 60%),
        radial-gradient(800px 400px at -10% 20%, rgba(59,130,246,0.05), transparent 55%),
        linear-gradient(180deg, #070a10 0%, #0d1118 55%, #0a0e13 100%);
      background-attachment: fixed;
      min-height: 100vh;
      padding: 20px;
      color: #e7e9ea;
    }
    .container { max-width: 1100px; margin: 0 auto; }

    /* Header Modern */
    .header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 24px;
      padding: 18px 24px;
      background: linear-gradient(135deg, rgba(24,30,40,0.95), rgba(16,21,30,0.95));
      backdrop-filter: blur(20px);
      border-radius: 16px;
      border: 1px solid rgba(247,147,26,0.14);
      box-shadow: 0 8px 32px rgba(0,0,0,0.3), inset 0 1px 0 rgba(255,255,255,0.04);
      position: relative;
      overflow: hidden;
    }
    .header::before {
      content: '';
      position: absolute;
      top: 0; left: 0; right: 0;
      height: 2px;
      background: linear-gradient(90deg, transparent, #f7931a, transparent);
      opacity: 0.7;
    }
    .header h1 { color: #ffffff; font-size: 1.4em; font-weight: 700; letter-spacing: -0.02em; display: flex; align-items: center; gap: 10px; }
    .header h1 svg { width: 24px; height: 24px; color: #f7931a; filter: drop-shadow(0 0 8px rgba(247,147,26,0.4)); }
    .header-actions { display: flex; gap: 10px; flex-wrap: wrap; }
    .header-actions a {
      padding: 10px 16px;
      background: rgba(255,255,255,0.06);
      color: #e7e9ea;
      text-decoration: none;
      border-radius: 10px;
      font-size: 0.85em;
      font-weight: 500;
      border: 1px solid rgba(255,255,255,0.08);
      transition: all 0.2s ease;
    }
    .header-actions a:hover { background: rgba(247,147,26,0.15); border-color: rgba(247,147,26,0.3); color: #f7931a; transform: translateY(-1px); }
    .header-actions a.action-monitoring {
      background: linear-gradient(135deg, #f7931a 0%, #e8850f 100%);
      color: #fff;
      border-color: transparent;
      box-shadow: 0 4px 12px rgba(247,147,26,0.3);
    }
    .header-actions a.action-monitoring:hover { color: #fff; background: linear-gradient(135deg, #ffa733 0%, #f7931a 100%); box-shadow: 0 6px 16px rgba(247,147,26,0.4); }

    /* Stats Cards */
    .stats-row {
      display: grid;
      grid-template-columns: repeat(4, 1fr);
      gap: 14px;
      margin-bottom: 24px;
    }
    .stat-card {
      background: linear-gradient(160deg, rgba(24,30,40,0.9), rgba(16,21,30,0.9));
      backdrop-filter: blur(10px);
      padding: 20px 16px;
      border-radius: 14px;
      text-align: center;
      border: 1px solid rgba(255,255,255,0.06);
      transition: all 0.2s;
      position: relative;
      overflow: hidden;
    }
    .stat-card::after {
      content: '';
      position: absolute;
      top: 0; left: 20%; right: 20%;
      height: 2px;
      background: linear-gradient(90deg, transparent, rgba(247,147,26,0.5), transparent);
      opacity: 0;
      transition: opacity 0.2s;
    }
    .stat-card:hover { border-color: rgba(247,147,26,0.25); transform: translateY(-2px); box-shadow: 0 8px 24px rgba(0,0,0,0.25); }
    .stat-card:hover::after { opacity: 1; }
    .stat-value { font-size: 1.8em; font-weight: 700; color: #f7931a; font-family: 'JetBrains Mono', monospace; text-shadow: 0 0 20px rgba(247,147,26,0.25); }
    .stat-label { color: #8b949e; font-size: 0.8em; margin-top: 4px; font-weight: 500; }

    /* Cards */
    .card {
      background: linear-gradient(170deg, rgba(22,28,38,0.88), rgba(16,21,30,0.88));
      backdrop-filter: blur(20px);
      border-radius: 16px;
      padding: 22px;
      margin-bottom: 18px;
      border: 1px solid rgba(255,255,255,0.06);
      box-shadow: 0 4px 20px rgba(0,0,0,0.18), inset 0 1px 0 rgba(255,255,255,0.03);
      transition: border-color 0.2s;
    }
    .card:hover { border-color: rgba(255,255,255,0.1); }
    .card h2 {
      color: #ffffff;
      font-size: 1em;
      font-weight: 600;
      margin-bottom: 16px;
      padding-bottom: 12px;
      border-bottom: 1px solid rgba(255,255,255,0.06);
      letter-spacing: -0.01em;
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .card h2 svg { width: 18px; height: 18px; color: #f7931a; }

    /* Section Tabs */
    .section-tabs {
      display: flex;
      gap: 6px;
      margin-bottom: 20px;
      flex-wrap: wrap;
      padding: 6px;
      background: rgba(14,18,26,0.75);
      border: 1px solid rgba(255,255,255,0.05);
      border-radius: 14px;
      backdrop-filter: blur(16px);
      position: sticky;
      top: 12px;
      z-index: 50;
    }
    .section-tab {
      padding: 9px 16px;
      background: transparent;
      border: 1px solid transparent;
      border-radius: 9px;
      color: #8b949e;
      font-size: 0.85em;
      font-weight: 500;
      cursor: pointer;
      transition: all 0.2s;
    }
    .section-tab:hover { background: rgba(255,255,255,0.06); color: #e7e9ea; }
    .section-tab.active {
      background: linear-gradient(135deg, rgba(247,147,26,0.2), rgba(247,147,26,0.1));
      border-color: rgba(247,147,26,0.35);
      color: #f7931a;
      font-weight: 600;
      box-shadow: 0 2px 10px rgba(247,147,26,0.12);
    }

    /* Section Content */
    .section-content { display: none; }
    .section-content.active { display: block; }

    /* Forms */
    .form-row {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
      gap: 14px;
      margin-bottom: 16px;
    }
    .form-group { margin-bottom: 14px; }
    .form-group label {
      display: block;
      margin-bottom: 8px;
      color: #8b949e;
      font-size: 0.82em;
      font-weight: 500;
    }
    .form-group input, .form-group select, .form-group textarea {
      width: 100%;
      padding: 11px 14px;
      border: 1px solid rgba(255,255,255,0.1);
      border-radius: 10px;
      background: rgba(15, 20, 25, 0.9);
      color: #e7e9ea;
      font-size: 0.9em;
      font-family: inherit;
      transition: all 0.2s ease;
    }
    .form-group input:focus, .form-group select:focus, .form-group textarea:focus {
      outline: none;
      border-color: #f7931a;
      box-shadow: 0 0 0 3px rgba(247,147,26,0.12);
    }
    .form-group textarea { resize: vertical; min-height: 100px; }

    /* Buttons */
    .btn {
      padding: 10px 18px;
      border: none;
      border-radius: 10px;
      font-size: 0.88em;
      font-weight: 600;
      cursor: pointer;
      transition: all 0.2s ease;
      font-family: inherit;
      display: inline-flex;
      align-items: center;
      gap: 6px;
    }
    .btn-primary {
      background: linear-gradient(135deg, #f7931a 0%, #e8850f 100%);
      color: white;
      box-shadow: 0 4px 12px rgba(247,147,26,0.25);
    }
    .btn-primary:hover { transform: translateY(-1px); box-shadow: 0 6px 16px rgba(247,147,26,0.35); }
    .btn-secondary { background: rgba(255,255,255,0.08); color: #e7e9ea; border: 1px solid rgba(255,255,255,0.1); }
    .btn-secondary:hover { background: rgba(255,255,255,0.12); }
    .btn-success { background: linear-gradient(135deg, #22c55e 0%, #16a34a 100%); color: white; }
    .btn-success:hover { background: linear-gradient(135deg, #4ade80 0%, #22c55e 100%); }
    .btn-danger { background: linear-gradient(135deg, #ef4444 0%, #dc2626 100%); color: white; }
    .btn-danger:hover { background: linear-gradient(135deg, #f87171 0%, #ef4444 100%); }
    .btn-warning { background: linear-gradient(135deg, #f59e0b 0%, #d97706 100%); color: white; }
    .btn-sm { padding: 6px 12px; font-size: 0.78em; }
    .btn-xs { padding: 4px 8px; font-size: 0.72em; border-radius: 6px; }

    /* Action Buttons Group */
    .action-btns {
      display: flex;
      gap: 4px;
      flex-wrap: wrap;
    }
    .action-btn {
      padding: 5px 10px;
      border-radius: 6px;
      font-size: 0.72em;
      font-weight: 600;
      cursor: pointer;
      border: none;
      transition: all 0.15s;
    }
    .action-btn.edit { background: rgba(59,130,246,0.15); color: #60a5fa; }
    .action-btn.edit:hover { background: rgba(59,130,246,0.25); }
    .action-btn.push { background: rgba(168,85,247,0.15); color: #c084fc; }
    .action-btn.push:hover { background: rgba(168,85,247,0.25); }
    .action-btn.pin { background: rgba(247,147,26,0.15); color: #f7931a; }
    .action-btn.pin:hover { background: rgba(247,147,26,0.25); }
    .action-btn.block { background: rgba(239,68,68,0.15); color: #f87171; }
    .action-btn.block:hover { background: rgba(239,68,68,0.25); }
    .action-btn.unblock { background: rgba(34,197,94,0.15); color: #4ade80; }
    .action-btn.unblock:hover { background: rgba(34,197,94,0.25); }
    .action-btn.delete { background: rgba(239,68,68,0.2); color: #f87171; }
    .action-btn.delete:hover { background: rgba(239,68,68,0.35); }
    .action-btn.kick { background: rgba(249,115,22,0.15); color: #fb923c; }
    .action-btn.kick:hover { background: rgba(249,115,22,0.25); }

    /* User Table */
    .user-table-wrapper {
      overflow-x: auto;
      margin: 0 -10px;
      padding: 0 10px;
    }
    .user-table {
      width: 100%;
      border-collapse: collapse;
      min-width: 700px;
    }
    .user-table th, .user-table td {
      padding: 12px 10px;
      text-align: left;
      border-bottom: 1px solid rgba(255,255,255,0.04);
    }
    .user-table th {
      color: #8b949e;
      font-size: 0.72em;
      text-transform: uppercase;
      font-weight: 600;
      letter-spacing: 0.5px;
      background: rgba(0,0,0,0.2);
      position: sticky;
      top: 0;
    }
    .user-table tr:hover { background: rgba(247,147,26,0.04); }
    .user-table td { font-size: 0.85em; }
    .user-table td.phone { font-family: 'JetBrains Mono', monospace; font-size: 0.8em; }

    /* Status Badges */
    .status-badge {
      padding: 4px 10px;
      border-radius: 20px;
      font-size: 0.72em;
      font-weight: 600;
      font-family: 'Inter', sans-serif;
      display: inline-block;
    }
    .status-active { background: rgba(74,222,128,0.15); color: #4ade80; }
    .status-expired { background: rgba(248,113,113,0.15); color: #f87171; }
    .status-lifetime { background: rgba(247,147,26,0.15); color: #f7931a; }
    .status-blocked { background: rgba(248,113,113,0.25); color: #f87171; }

    /* Push Badge */
    .push-badge {
      width: 10px;
      height: 10px;
      border-radius: 50%;
      display: inline-block;
    }
    .push-yes { background: #4ade80; box-shadow: 0 0 6px rgba(74,222,128,0.5); }
    .push-no { background: #6b7280; }

    /* PIN Badge */
    .pin-badge {
      padding: 3px 8px;
      border-radius: 12px;
      font-size: 0.68em;
      font-weight: 600;
    }
    .pin-changed { background: rgba(74,222,128,0.15); color: #4ade80; }
    .pin-default { background: rgba(251,191,36,0.15); color: #fbbf24; }

    /* Result Messages */
    .result-msg {
      padding: 12px 16px;
      border-radius: 10px;
      margin-bottom: 14px;
      display: none;
      font-weight: 500;
      font-size: 0.88em;
    }
    .result-msg.success { display: block; background: rgba(74,222,128,0.1); border: 1px solid rgba(74,222,128,0.25); color: #4ade80; }
    .result-msg.error { display: block; background: rgba(248,113,113,0.1); border: 1px solid rgba(248,113,113,0.25); color: #f87171; }

    /* Modal */
    .modal {
      display: none;
      position: fixed;
      top: 0;
      left: 0;
      width: 100%;
      height: 100%;
      background: rgba(0,0,0,0.8);
      backdrop-filter: blur(4px);
      align-items: center;
      justify-content: center;
      z-index: 1000;
    }
    .modal.show { display: flex; }
    .modal-content {
      background: rgba(20, 26, 34, 0.98);
      backdrop-filter: blur(20px);
      padding: 24px;
      border-radius: 16px;
      width: 90%;
      max-width: 400px;
      border: 1px solid rgba(255,255,255,0.08);
      box-shadow: 0 20px 50px rgba(0,0,0,0.4);
    }
    .modal-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 20px;
    }
    .modal-header h3 { color: #ffffff; font-weight: 600; font-size: 1.05em; }
    .modal-close {
      background: rgba(255,255,255,0.08);
      border: none;
      color: #8b949e;
      display: inline-flex; align-items: center; justify-content: center;
      font-size: 1.2em;
      cursor: pointer;
      padding: 6px 10px;
      border-radius: 8px;
      transition: all 0.2s;
    }
    .modal-close:hover { background: rgba(255,255,255,0.15); color: #fff; }

    /* Empty State */
    .empty-state {
      text-align: center;
      padding: 40px;
      color: #6b7280;
      font-size: 0.9em;
    }

    /* Warning Box */
    .warning-box {
      padding: 12px 14px;
      background: rgba(251,191,36,0.08);
      border: 1px solid rgba(251,191,36,0.2);
      border-radius: 10px;
      margin-top: 14px;
    }
    .warning-box p { color: #fbbf24; font-size: 0.82em; margin: 0; line-height: 1.5; }

    /* Buttons Row */
    .btns-row {
      display: flex;
      gap: 10px;
      flex-wrap: wrap;
      margin-top: 14px;
    }

    /* Responsive */
    @media (max-width: 900px) {
      .stats-row { grid-template-columns: repeat(2, 1fr); }
      .form-row { grid-template-columns: 1fr; }
    }
    @media (max-width: 768px) {
      body { padding: 12px; }
      .header { flex-direction: column; gap: 12px; text-align: center; padding: 14px 18px; }
      .header h1 { font-size: 1.2em; }
      .header-actions { justify-content: center; }
      .stats-row { gap: 10px; }
      .stat-card { padding: 16px 12px; }
      .stat-value { font-size: 1.5em; }
      .section-tabs { gap: 6px; }
      .section-tab { padding: 8px 14px; font-size: 0.8em; }
      .card { padding: 16px; }
    }
    @media (max-width: 500px) {
      body { padding: 8px; }
      .stats-row { grid-template-columns: repeat(2, 1fr); gap: 8px; }
      .stat-card { padding: 12px 8px; }
      .stat-value { font-size: 1.3em; }
      .stat-label { font-size: 0.7em; }
      .header-actions a { padding: 8px 12px; font-size: 0.78em; }
      .section-tab { padding: 7px 12px; font-size: 0.75em; }
      .btn { padding: 8px 14px; font-size: 0.82em; }
      .action-btn { padding: 4px 7px; font-size: 0.68em; }
    }

    /* Professional Modal System */
    .pro-modal-overlay {
      display: none;
      position: fixed;
      top: 0;
      left: 0;
      width: 100%;
      height: 100%;
      background: rgba(0,0,0,0.85);
      backdrop-filter: blur(8px);
      align-items: center;
      justify-content: center;
      z-index: 9999;
      animation: fadeIn 0.2s ease;
    }
    .pro-modal-overlay.show { display: flex; }
    @keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }
    @keyframes slideUp { from { transform: translateY(20px); opacity: 0; } to { transform: translateY(0); opacity: 1; } }
    .pro-modal-box {
      background: linear-gradient(180deg, rgba(25, 32, 42, 0.98) 0%, rgba(18, 24, 32, 0.98) 100%);
      border-radius: 16px;
      width: 90%;
      max-width: 380px;
      border: 1px solid rgba(255,255,255,0.1);
      box-shadow: 0 25px 60px rgba(0,0,0,0.5);
      animation: slideUp 0.25s ease;
      overflow: hidden;
    }
    .pro-modal-icon {
      width: 56px;
      height: 56px;
      border-radius: 50%;
      display: flex;
      align-items: center;
      justify-content: center;
      margin: 24px auto 16px;
    }
    .pro-modal-icon.info { background: rgba(59,130,246,0.15); color: #60a5fa; }
    .pro-modal-icon.success { background: rgba(34,197,94,0.15); color: #4ade80; }
    .pro-modal-icon.warning { background: rgba(251,191,36,0.15); color: #fbbf24; }
    .pro-modal-icon.danger { background: rgba(239,68,68,0.15); color: #f87171; }
    .pro-modal-icon svg { width: 28px; height: 28px; }
    .pro-modal-content { padding: 0 24px 24px; text-align: center; }
    .pro-modal-title { color: #fff; font-size: 1.1em; font-weight: 600; margin-bottom: 8px; }
    .pro-modal-message { color: #9ca3af; font-size: 0.9em; line-height: 1.5; }
    .pro-modal-buttons { display: flex; gap: 10px; margin-top: 20px; justify-content: center; }
    .pro-modal-btn {
      padding: 10px 20px;
      border-radius: 10px;
      font-size: 0.88em;
      font-weight: 600;
      cursor: pointer;
      border: none;
      transition: all 0.2s;
      min-width: 100px;
    }
    .pro-modal-btn.cancel { background: rgba(255,255,255,0.08); color: #e7e9ea; }
    .pro-modal-btn.cancel:hover { background: rgba(255,255,255,0.15); }
    .pro-modal-btn.confirm { background: linear-gradient(135deg, #f7931a 0%, #e8850f 100%); color: white; }
    .pro-modal-btn.confirm:hover { transform: translateY(-1px); }
    .pro-modal-btn.danger { background: linear-gradient(135deg, #ef4444 0%, #dc2626 100%); color: white; }
    .pro-modal-btn.danger:hover { transform: translateY(-1px); }
  </style>
</head>
<body>
  <!-- Professional Modal -->
  <div class="pro-modal-overlay" id="proModal">
    <div class="pro-modal-box">
      <div class="pro-modal-icon info" id="proModalIcon">
        <svg id="proModalSvg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"></svg>
      </div>
      <div class="pro-modal-content">
        <div class="pro-modal-title" id="proModalTitle">Title</div>
        <div class="pro-modal-message" id="proModalMessage">Message</div>
        <div class="pro-modal-buttons" id="proModalButtons"></div>
      </div>
    </div>
  </div>
  <div class="container">
    <div id="mainContent">
      <!-- Header -->
      <div class="header">
        <h1>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/>
            <circle cx="9" cy="7" r="4"/>
            <path d="M22 21v-2a4 4 0 0 0-3-3.87"/>
            <path d="M16 3.13a4 4 0 0 1 0 7.75"/>
          </svg>
          Kelola User
        </h1>
        <div class="header-actions">
          <a href="/admin/monitoring">Notifikasi</a>
          <a href="/monitoring" class="action-monitoring"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14" style="vertical-align:-2px;margin-right:5px;"><polyline points="22 7 13.5 15.5 8.5 10.5 2 17"/><polyline points="16 7 22 7 22 13"/></svg>Ke Monitoring</a>
          <a href="/admin/logout" style="color:#f87171;border-color:rgba(248,113,113,0.3);" onclick="return confirm('Yakin ingin logout?')">Logout</a>
        </div>
      </div>

      <!-- Stats -->
      <div class="stats-row">
        <div class="stat-card">
          <div class="stat-value" id="totalUsers">0</div>
          <div class="stat-label">Total User</div>
        </div>
        <div class="stat-card">
          <div class="stat-value" id="activeUsers">0</div>
          <div class="stat-label">User Aktif</div>
        </div>
        <div class="stat-card">
          <div class="stat-value" id="pushUsers">0</div>
          <div class="stat-label">Push Enabled</div>
        </div>
        <div class="stat-card">
          <div class="stat-value" id="pinChangedUsers">0</div>
          <div class="stat-label">PIN Changed</div>
        </div>
      </div>

      <!-- Section Tabs -->
      <div class="section-tabs">
        <div class="section-tab active" data-section="users">Daftar User</div>
        <div class="section-tab" data-section="online">Online <span id="onlineBadge" style="background:#22c55e;color:#fff;padding:1px 6px;border-radius:8px;font-size:0.75em;margin-left:4px;">0</span></div>
        <div class="section-tab" data-section="add">Tambah User</div>
        <div class="section-tab" data-section="pending">Pending <span id="pendingBadge" style="background:#f7931a;color:#000;padding:1px 6px;border-radius:8px;font-size:0.75em;margin-left:4px;">0</span></div>
        <div class="section-tab" data-section="whatsapp">WhatsApp</div>
        <div class="section-tab" data-section="nominal">Nominal</div>
        <div class="section-tab" data-section="broadcast">Broadcast</div>
        <div class="section-tab" data-section="settings">Pengaturan</div>
        <div class="section-tab" data-section="logs">📋 Logs</div>
      </div>

      <!-- Section: Daftar User -->
      <div class="section-content active" id="section-users">
        <div class="card">
          <h2>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/>
              <circle cx="9" cy="7" r="4"/>
              <path d="M23 21v-2a4 4 0 0 0-3-3.87"/>
              <path d="M16 3.13a4 4 0 0 1 0 7.75"/>
            </svg>
            Daftar User
          </h2>
          <div class="user-table-wrapper">
            <table class="user-table">
              <thead>
                <tr>
                  <th>No WA</th>
                  <th>Nama</th>
                  <th>Status</th>
                  <th>Push</th>
                  <th>PIN</th>
                  <th>Expired</th>
                  <th>Aksi</th>
                </tr>
              </thead>
              <tbody id="userList">
                <tr><td colspan="7" class="empty-state">Memuat data...</td></tr>
              </tbody>
            </table>
          </div>
        </div>
      </div>

      <!-- Section: Online Users -->
      <div class="section-content" id="section-online">
        <div class="card">
          <h2>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <circle cx="12" cy="12" r="10"/>
              <circle cx="12" cy="12" r="3" fill="#22c55e"/>
            </svg>
            User Online
            <span id="onlineCount" style="background:#22c55e;color:#fff;padding:2px 10px;border-radius:12px;font-size:0.75em;margin-left:8px;">0</span>
          </h2>
          <p style="color:#6b7280;font-size:0.82em;margin-bottom:14px;">Daftar user yang sedang membuka halaman monitoring secara realtime.</p>
          <div class="user-table-wrapper" style="max-height:300px;overflow:hidden;transition:max-height 0.3s ease;" id="onlineTableWrapper">
            <table class="user-table">
              <thead>
                <tr>
                  <th style="width:40px;">#</th>
                  <th>Nama</th>
                  <th>No WA</th>
                  <th>Waktu Terhubung</th>
                </tr>
              </thead>
              <tbody id="onlineUsersList">
                <tr><td colspan="4" class="empty-state">Tidak ada user online</td></tr>
              </tbody>
            </table>
          </div>
          <div id="showMoreOnline" style="display:none;text-align:center;margin-top:10px;">
            <button onclick="toggleOnlineUsers()" style="background:linear-gradient(135deg,#3b82f6,#2563eb);color:#fff;border:none;padding:8px 20px;border-radius:8px;cursor:pointer;font-size:0.85em;">
              <span id="showMoreText">Lihat Semua</span>
              <svg id="showMoreIcon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="vertical-align:middle;margin-left:5px;"><polyline points="6 9 12 15 18 9"/></svg>
            </button>
          </div>
        </div>
      </div>

      <!-- Section: Tambah User -->
      <div class="section-content" id="section-add">
        <div class="card">
          <h2>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/>
              <circle cx="9" cy="7" r="4"/>
              <line x1="19" y1="8" x2="19" y2="14"/>
              <line x1="22" y1="11" x2="16" y2="11"/>
            </svg>
            Tambah User Manual
          </h2>
          <div class="result-msg" id="addResult"></div>
          <div class="form-row">
            <div class="form-group">
              <label>Nomor WhatsApp</label>
              <input type="tel" id="newPhone" placeholder="08123456789">
            </div>
            <div class="form-group">
              <label>Nama (opsional)</label>
              <input type="text" id="newName" placeholder="Nama user">
            </div>
            <div class="form-group">
              <label>Tanggal Expired</label>
              <input type="date" id="newExpiredDate">
            </div>
          </div>
          <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap;">
            <button class="btn btn-primary" onclick="addUser()">Tambah User</button>
            <small style="color:#6b7280;">Kosongkan tanggal untuk lifetime</small>
          </div>
        </div>

        <div class="card">
          <h2>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
              <polyline points="17 8 12 3 7 8"/>
              <line x1="12" y1="3" x2="12" y2="15"/>
            </svg>
            Import Bulk User
          </h2>
          <div class="result-msg" id="bulkResult"></div>
          <div class="form-group">
            <label>Paste dari WhatsApp (inspect element) atau satu nomor per baris</label>
            <textarea id="bulkPhones" placeholder="Paste langsung dari inspect WhatsApp: I, Ma, +62 851-5633-8205, +62 822-1980-1013, ... Anda&#10;&#10;Atau format biasa:&#10;08123456789&#10;08234567890"></textarea>
          </div>
          <div id="bulkPreview" style="font-size:0.8em;color:#6b7280;margin-bottom:8px;display:none;"></div>
          <button class="btn btn-primary" onclick="bulkImport()">Import Semua</button>
        </div>
      </div>

      <!-- Section: Pending -->
      <div class="section-content" id="section-pending">
        <div class="card" style="border-color:rgba(247,147,26,0.3);">
          <h2 style="color:#f7931a;">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <circle cx="12" cy="12" r="10"/>
              <polyline points="12 6 12 12 16 14"/>
            </svg>
            Pending Registrasi <span id="pendingCount" style="background:#f7931a;color:#000;padding:2px 8px;border-radius:10px;font-size:0.7em;margin-left:5px;">0</span>
          </h2>
          <div class="user-table-wrapper">
            <table class="user-table">
              <thead>
                <tr>
                  <th>Waktu</th>
                  <th>Nama</th>
                  <th>No WA</th>
                  <th>Aksi</th>
                </tr>
              </thead>
              <tbody id="pendingList">
                <tr><td colspan="4" class="empty-state">Tidak ada pendaftaran baru</td></tr>
              </tbody>
            </table>
          </div>
        </div>
      </div>

      <!-- Section: WhatsApp -->
      <div class="section-content" id="section-whatsapp">

        <!-- WA Connection Status Card -->
        <div class="card" style="margin-bottom:16px;">
          <h2>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/>
            </svg>
            Status Koneksi WhatsApp
          </h2>
          <div class="result-msg" id="waResetResult"></div>
          <div id="waStatusCard" style="display:flex;align-items:center;gap:16px;padding:16px;background:rgba(255,255,255,0.04);border-radius:12px;margin-bottom:16px;flex-wrap:wrap;">
            <div id="waStatusDot" style="width:14px;height:14px;border-radius:50%;background:#6b7280;flex-shrink:0;"></div>
            <div style="flex:1;min-width:180px;">
              <div id="waStatusText" style="font-weight:600;font-size:0.95em;">Memuat status...</div>
              <div id="waStatusPhone" style="font-size:0.78em;color:#6b7280;margin-top:2px;"></div>
            </div>
            <div style="display:flex;gap:8px;flex-wrap:wrap;">
              <button class="btn btn-secondary btn-sm" onclick="loadWaStatus()">🔁 Refresh</button>
              <a id="waQrLink" href="/qr" target="_blank" class="btn btn-sm" style="background:#f7931a;color:#000;text-decoration:none;">📷 Lihat QR</a>
              <button class="btn btn-danger btn-sm" onclick="resetWaConnection()">⚠️ Reset / Ganti WA</button>
            </div>
          </div>
          <p style="color:#6b7280;font-size:0.78em;">Reset akan logout dari WA saat ini dan meminta scan QR baru. Cocok untuk ganti nomor WA yang terhubung.</p>
        </div>

        <div class="card">
          <h2>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/>
            </svg>
            Sinkronisasi Grup WhatsApp
          </h2>
          <p style="color:#6b7280;font-size:0.85em;margin-bottom:14px;">Member grup yang dipilih akan otomatis terdaftar dan bisa login ke website.</p>
          <div class="result-msg" id="syncResult"></div>
          <div class="form-row" style="align-items:flex-end;">
            <div class="form-group" style="flex:2;">
              <label>Pilih Grup WhatsApp (Monitor Member)</label>
              <select id="waGroupSelect">
                <option value="">-- Pilih Grup --</option>
              </select>
            </div>
            <div class="form-group" style="flex:1;">
              <button class="btn btn-primary" onclick="setWaGroup()" style="width:100%;">Set Grup Monitor</button>
            </div>
          </div>
          <div id="currentGroup" style="margin-top:8px;font-size:0.82em;color:#6b7280;"></div>

          <!-- Broadcast Group (Kirim Harga Otomatis) -->
          <div style="margin-top:20px;padding:16px;background:rgba(0,255,136,0.05);border:1px solid rgba(0,255,136,0.2);border-radius:12px;">
            <label style="color:#00ff88;font-weight:600;display:block;margin-bottom:4px;font-size:0.9em;">📢 Grup Broadcast Harga (Grup Beli)</label>
            <p style="color:#6b7280;font-size:0.8em;margin-bottom:12px;">Harga emas akan otomatis dikirim ke grup ini setiap kali ada perubahan harga. Pesan akan menyertakan Titik ON ▼ dan Limit beli/bln.</p>
            <div class="form-row" style="align-items:flex-end;">
              <div class="form-group" style="flex:2;">
                <label>Pilih Grup Broadcast</label>
                <select id="waBroadcastGroupSelect">
                  <option value="">-- Pilih Grup (Kosongkan untuk nonaktifkan) --</option>
                </select>
              </div>
              <div class="form-group" style="flex:1;">
                <button class="btn" style="background:#00ff88;color:#000;width:100%;" onclick="setBroadcastGroup()">Set Grup Broadcast</button>
              </div>
            </div>
            <div id="currentBroadcastGroup" style="margin-top:8px;font-size:0.82em;color:#6b7280;"></div>
          </div>

          <div class="btns-row" style="margin-top:16px;">
            <button class="btn btn-secondary" onclick="loadWaGroups()">Refresh Grup</button>
            <button class="btn btn-danger btn-sm" onclick="clearInvalidUsers()">Hapus Invalid</button>
            <button class="btn btn-sm" style="background:#7f1d1d;color:white;" onclick="clearAllUsers()">Hapus Semua</button>
            <button class="btn btn-sm" style="background:#f59e0b;color:#000;" onclick="forceLogoutAll()">Force Logout Semua</button>
          </div>
          <div class="warning-box">
            <p><strong>Catatan:</strong> WhatsApp menggunakan format LID (privacy) sehingga nomor telepon member tidak bisa diakses otomatis. User harus mendaftar sendiri via OTP atau ditambahkan manual oleh admin.</p>
          </div>
        </div>
      </div>

      <!-- Section: Nominal -->
      <div class="section-content" id="section-nominal">
        <div class="card">
          <h2>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/>
            </svg>
            Kelola Nominal Investasi
          </h2>
          <p style="color:#6b7280;font-size:0.82em;margin-bottom:16px;">Atur nominal investasi dan pilih mana yang jadi patokan Promo ON/OFF.</p>
          <div class="result-msg" id="nominalResult"></div>

          <!-- Add New Nominal -->
          <div style="background:rgba(247,147,26,0.05);padding:16px;border-radius:12px;border:1px solid rgba(247,147,26,0.15);margin-bottom:20px;">
            <label style="color:#f7931a;font-weight:600;display:block;margin-bottom:12px;font-size:0.9em;">Tambah Nominal Baru</label>
            <div style="display:grid;grid-template-columns:1fr 1fr 1fr 1fr auto;gap:10px;align-items:end;">
              <div class="form-group" style="margin:0;">
                <label>ID (unik)</label>
                <input type="text" id="newNominalId" placeholder="cth: 100jt">
              </div>
              <div class="form-group" style="margin:0;">
                <label>Label</label>
                <input type="text" id="newNominalLabel" placeholder="cth: 100jt">
              </div>
              <div class="form-group" style="margin:0;">
                <label>Nominal (Rp)</label>
                <input type="number" id="newNominalAmount" placeholder="100000000">
              </div>
              <div class="form-group" style="margin:0;">
                <label>Diskon (%)</label>
                <input type="number" id="newNominalDiscount" placeholder="3.35" step="0.01">
              </div>
              <button class="btn btn-sm" style="background:#22c55e;height:38px;" onclick="addNominal()">+ Tambah</button>
            </div>
          </div>

          <!-- Nominal List -->
          <div style="overflow-x:auto;">
            <table class="user-table" id="nominalTable">
              <thead>
                <tr>
                  <th>Promo</th>
                  <th>ID</th>
                  <th>Label</th>
                  <th>Nominal</th>
                  <th>Diskon (%)</th>
                  <th>Status</th>
                  <th>Aksi</th>
                </tr>
              </thead>
              <tbody id="nominalTableBody">
                <tr><td colspan="7" style="text-align:center;color:#6b7280;">Loading...</td></tr>
              </tbody>
            </table>
          </div>

          <div style="margin-top:16px;">
            <button class="btn" style="background:#f7931a;color:#000;" onclick="saveNominals()">Simpan Perubahan</button>
          </div>
        </div>
      </div>

      <!-- Section: Pengaturan -->
      <div class="section-content" id="section-settings">
        <!-- Tur Pengenalan & Sound/Getar -->
        <div class="card">
          <h2>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="18" height="18">
              <path d="M21.5 12a9.5 9.5 0 1 1-9.5-9.5"/><polyline points="21.5 2.5 21.5 7.5 16.5 7.5"/>
            </svg>
            Tur Pengenalan &amp; Sound/Getar
          </h2>
          <p style="color:#6b7280;font-size:0.82em;margin-bottom:14px;">Paksa SEMUA user melihat tur pengenalan lagi dan reset Sound &amp; Getar ke default (aktif semua). Berlaku saat user membuka / refresh halaman monitoring.</p>
          <div class="result-msg" id="resetFreshResult"></div>
          <button class="btn btn-primary" id="resetFreshBtn" style="width:100%;" onclick="resetFreshAll()">Reset Tur + Sound/Getar untuk Semua User</button>
        </div>

        <!-- API Eksternal -->
        <div class="card">
          <h2>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="18" height="18">
              <path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4"/>
            </svg>
            API Eksternal
          </h2>
          <p style="color:#6b7280;font-size:0.82em;margin-bottom:6px;">Generate API key untuk mengambil data harga dari luar (bot, spreadsheet, aplikasi lain). Key bisa dinonaktifkan/dihapus kapan saja.</p>
          <p style="margin-bottom:14px;"><a href="/admin/api-docs" target="_blank" style="color:#f7931a;font-size:0.85em;font-weight:600;text-decoration:none;">&#128214; Buka Dokumentasi API Lengkap &rarr;</a></p>
          <div class="result-msg" id="apiTokenResult"></div>
          <div class="form-group" style="display:flex;gap:10px;align-items:flex-end;">
            <div style="flex:1;">
              <label>Nama Key (mis. "bot-telegram", "sheet-laporan")</label>
              <input type="text" id="apiTokenName" placeholder="nama key" maxlength="40" style="width:100%;">
            </div>
            <button class="btn btn-primary" style="white-space:nowrap;" onclick="createApiToken()">Generate Key</button>
          </div>
          <div style="overflow-x:auto;">
            <table style="width:100%;border-collapse:collapse;font-size:0.82em;">
              <thead>
                <tr style="border-bottom:1px solid rgba(255,255,255,0.08);">
                  <th style="text-align:left;padding:8px 10px;color:#8b949e;font-weight:600;">Nama</th>
                  <th style="text-align:left;padding:8px 10px;color:#8b949e;font-weight:600;">API Key</th>
                  <th style="text-align:left;padding:8px 10px;color:#8b949e;font-weight:600;">Status</th>
                  <th style="text-align:left;padding:8px 10px;color:#8b949e;font-weight:600;">Hits</th>
                  <th style="text-align:left;padding:8px 10px;color:#8b949e;font-weight:600;">Aksi</th>
                </tr>
              </thead>
              <tbody id="apiTokenBody">
                <tr><td colspan="5" style="text-align:center;padding:16px;color:#6b7280;">Memuat...</td></tr>
              </tbody>
            </table>
          </div>
        </div>

        <!-- Sound Notifikasi -->
        <div class="card">
          <h2>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/>
              <path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07"/>
            </svg>
            Sound Notifikasi
          </h2>
          <p style="color:#6b7280;font-size:0.82em;margin-bottom:16px;">Upload file audio atau masukkan URL. Max 500KB per file.</p>
          <div class="result-msg" id="soundResult"></div>

          <!-- Sound Naik -->
          <div style="background:rgba(74,222,128,0.05);padding:16px;border-radius:12px;border:1px solid rgba(74,222,128,0.15);margin-bottom:14px;">
            <label style="color:#4ade80;font-weight:600;display:block;margin-bottom:12px;font-size:0.9em;">Sound Harga Naik</label>
            <div class="form-group" style="margin-bottom:10px;">
              <label>Upload File Audio</label>
              <input type="file" id="soundUpFile" accept="audio/*" onchange="handleSoundUpload('up')">
            </div>
            <div class="form-group" style="margin-bottom:10px;">
              <label>Atau Masukkan URL</label>
              <input type="text" id="soundUpUrl" placeholder="https://example.com/naik.mp3">
            </div>
            <div id="soundUpPreview" style="margin-top:10px;display:none;">
              <audio id="soundUpAudio" controls style="width:100%;height:36px;"></audio>
            </div>
            <button class="btn btn-sm" style="margin-top:10px;background:rgba(74,222,128,0.15);color:#4ade80;border:1px solid rgba(74,222,128,0.25);" onclick="testSound('up')">Test Sound Naik</button>
          </div>

          <!-- Sound Turun -->
          <div style="background:rgba(248,113,113,0.05);padding:16px;border-radius:12px;border:1px solid rgba(248,113,113,0.15);margin-bottom:16px;">
            <label style="color:#f87171;font-weight:600;display:block;margin-bottom:12px;font-size:0.9em;">Sound Harga Turun</label>
            <div class="form-group" style="margin-bottom:10px;">
              <label>Upload File Audio</label>
              <input type="file" id="soundDownFile" accept="audio/*" onchange="handleSoundUpload('down')">
            </div>
            <div class="form-group" style="margin-bottom:10px;">
              <label>Atau Masukkan URL</label>
              <input type="text" id="soundDownUrl" placeholder="https://example.com/turun.mp3">
            </div>
            <div id="soundDownPreview" style="margin-top:10px;display:none;">
              <audio id="soundDownAudio" controls style="width:100%;height:36px;"></audio>
            </div>
            <button class="btn btn-sm" style="margin-top:10px;background:rgba(248,113,113,0.15);color:#f87171;border:1px solid rgba(248,113,113,0.25);" onclick="testSound('down')">Test Sound Turun</button>
          </div>

          <!-- Sound Naik Besar -->
          <div style="background:rgba(250,204,21,0.05);padding:16px;border-radius:12px;border:1px solid rgba(250,204,21,0.25);margin-bottom:14px;">
            <label style="color:#facc15;font-weight:600;display:block;margin-bottom:6px;font-size:0.9em;">⚡ Sound Naik Besar (&gt;3.000)</label>
            <p style="color:#6b7280;font-size:0.78em;margin-bottom:10px;">Berbunyi saat harga naik lebih dari Rp 3.000 sekaligus. Jika kosong, memakai sound naik biasa.</p>
            <div class="form-group" style="margin-bottom:10px;">
              <label>Upload File Audio</label>
              <input type="file" id="soundBigUpFile" accept="audio/*" onchange="handleSoundUpload('bigUp')">
            </div>
            <div class="form-group" style="margin-bottom:10px;">
              <label>Atau Masukkan URL</label>
              <input type="text" id="soundBigUpUrl" placeholder="https://example.com/naik-besar.mp3">
            </div>
            <div id="soundBigUpPreview" style="margin-top:10px;display:none;">
              <audio id="soundBigUpAudio" controls style="width:100%;height:36px;"></audio>
            </div>
            <button class="btn btn-sm" style="margin-top:10px;background:rgba(250,204,21,0.15);color:#facc15;border:1px solid rgba(250,204,21,0.25);" onclick="testSound('bigUp')">Test Sound Naik Besar</button>
          </div>

          <!-- Sound Turun Besar -->
          <div style="background:rgba(251,146,60,0.05);padding:16px;border-radius:12px;border:1px solid rgba(251,146,60,0.25);margin-bottom:16px;">
            <label style="color:#fb923c;font-weight:600;display:block;margin-bottom:6px;font-size:0.9em;">⚡ Sound Turun Besar (&gt;3.000)</label>
            <p style="color:#6b7280;font-size:0.78em;margin-bottom:10px;">Berbunyi saat harga turun lebih dari Rp 3.000 sekaligus. Jika kosong, memakai sound turun biasa.</p>
            <div class="form-group" style="margin-bottom:10px;">
              <label>Upload File Audio</label>
              <input type="file" id="soundBigDownFile" accept="audio/*" onchange="handleSoundUpload('bigDown')">
            </div>
            <div class="form-group" style="margin-bottom:10px;">
              <label>Atau Masukkan URL</label>
              <input type="text" id="soundBigDownUrl" placeholder="https://example.com/turun-besar.mp3">
            </div>
            <div id="soundBigDownPreview" style="margin-top:10px;display:none;">
              <audio id="soundBigDownAudio" controls style="width:100%;height:36px;"></audio>
            </div>
            <button class="btn btn-sm" style="margin-top:10px;background:rgba(251,146,60,0.15);color:#fb923c;border:1px solid rgba(251,146,60,0.25);" onclick="testSound('bigDown')">Test Sound Turun Besar</button>
          </div>

          <!-- Sound Promo ON -->
          <div style="background:rgba(59,130,246,0.05);padding:16px;border-radius:12px;border:1px solid rgba(59,130,246,0.15);margin-bottom:14px;">
            <label style="color:#3b82f6;font-weight:600;display:block;margin-bottom:12px;font-size:0.9em;">Sound Promo ON (20jt aktif)</label>
            <div class="form-group" style="margin-bottom:10px;">
              <label>Upload File Audio</label>
              <input type="file" id="soundOnFile" accept="audio/*" onchange="handleSoundUpload('on')">
            </div>
            <div class="form-group" style="margin-bottom:10px;">
              <label>Atau Masukkan URL</label>
              <input type="text" id="soundOnUrl" placeholder="https://example.com/on.mp3">
            </div>
            <div id="soundOnPreview" style="margin-top:10px;display:none;">
              <audio id="soundOnAudio" controls style="width:100%;height:36px;"></audio>
            </div>
            <button class="btn btn-sm" style="margin-top:10px;background:rgba(59,130,246,0.15);color:#3b82f6;border:1px solid rgba(59,130,246,0.25);" onclick="testSound('on')">Test Sound ON</button>
          </div>

          <!-- Sound Promo OFF -->
          <div style="background:rgba(156,163,175,0.05);padding:16px;border-radius:12px;border:1px solid rgba(156,163,175,0.15);margin-bottom:16px;">
            <label style="color:#9ca3af;font-weight:600;display:block;margin-bottom:12px;font-size:0.9em;">Sound Promo OFF (20jt nonaktif)</label>
            <div class="form-group" style="margin-bottom:10px;">
              <label>Upload File Audio</label>
              <input type="file" id="soundOffFile" accept="audio/*" onchange="handleSoundUpload('off')">
            </div>
            <div class="form-group" style="margin-bottom:10px;">
              <label>Atau Masukkan URL</label>
              <input type="text" id="soundOffUrl" placeholder="https://example.com/off.mp3">
            </div>
            <div id="soundOffPreview" style="margin-top:10px;display:none;">
              <audio id="soundOffAudio" controls style="width:100%;height:36px;"></audio>
            </div>
            <button class="btn btn-sm" style="margin-top:10px;background:rgba(156,163,175,0.15);color:#9ca3af;border:1px solid rgba(156,163,175,0.25);" onclick="testSound('off')">Test Sound OFF</button>
          </div>

          <div style="display:flex;gap:10px;flex-wrap:wrap;">
            <button class="btn btn-primary" onclick="saveSoundSettings()">Simpan Sound</button>
            <button class="btn btn-danger btn-sm" onclick="resetSounds()">Reset Default</button>
          </div>
        </div>

        <!-- Limit Beli Promo -->
        <div class="card">
          <h2>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="18" height="18">
              <circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>
            </svg>
            Limit Beli Promo Bulanan
          </h2>
          <p style="color:#6b7280;font-size:0.82em;margin-bottom:14px;">Angka yang ditampilkan sebagai badge Limit di halaman user (batas beli promo bulan ini). Bisa diisi bebas.</p>
          <div class="result-msg" id="promoLimitResult"></div>
          <div class="form-group" style="display:flex;gap:10px;align-items:flex-end;">
            <div style="flex:1;">
              <label>Nilai Limit</label>
              <input type="number" id="promoLimitInput" min="0" step="1" placeholder="Contoh: 50" style="width:100%;">
            </div>
            <button class="btn btn-primary" style="white-space:nowrap;" onclick="savePromoLimit()">Simpan</button>
          </div>
          <p style="color:#6b7280;font-size:0.78em;margin-top:8px;">Nilai saat ini: <strong id="promoLimitCurrent">-</strong></p>
        </div>

        <!-- Markup Normal Range -->
        <div class="card">
          <h2>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="18" height="18">
              <polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/>
            </svg>
            Batas Markup Normal
          </h2>
          <p style="color:#6b7280;font-size:0.82em;margin-bottom:14px;">Range margin dari harga dasar (XAU × USD/IDR ÷ 31.1035) untuk dianggap Normal. Default: 0.7% – 2%.</p>
          <div class="result-msg" id="markupSettingsResult"></div>
          <div class="form-group" style="display:flex;gap:10px;align-items:flex-end;">
            <div style="flex:1;">
              <label>Batas Bawah (%)</label>
              <input type="number" id="markupMinInput" min="0" max="20" step="0.1" placeholder="0.7" style="width:100%;">
            </div>
            <div style="flex:1;">
              <label>Batas Atas (%)</label>
              <input type="number" id="markupMaxInput" min="0" max="20" step="0.1" placeholder="2.0" style="width:100%;">
            </div>
            <button class="btn btn-primary" style="white-space:nowrap;" onclick="saveMarkupSettings()">Simpan</button>
          </div>
          <p style="color:#6b7280;font-size:0.78em;margin-top:8px;">Saat ini: <strong id="markupMinCurrent">-</strong>% – <strong id="markupMaxCurrent">-</strong>%</p>
        </div>

        <!-- Tema Tampilan -->
        <div class="card">
          <h2>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="18" height="18">
              <circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="4"/><line x1="12" y1="2" x2="12" y2="4"/><line x1="12" y1="20" x2="12" y2="22"/><line x1="2" y1="12" x2="4" y2="12"/><line x1="20" y1="12" x2="22" y2="12"/>
            </svg>
            Tema Tampilan
          </h2>
          <p style="color:#6b7280;font-size:0.82em;margin-bottom:12px;">Pilih preset atau atur warna bebas. Disimpan permanen, berlaku untuk semua pengguna.</p>
          <div class="result-msg" id="themeResult"></div>
          <p style="color:#6b7280;font-size:0.78em;margin-bottom:8px;font-weight:600;">Preset Cepat:</p>
          <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:7px;margin-bottom:16px;">
            <button onclick="applyThemePreset(\'black\')" style="border:1px solid rgba(255,255,255,0.15);border-radius:7px;padding:0;overflow:hidden;cursor:pointer;"><div style="background:#000000;height:40px;display:flex;align-items:center;justify-content:center;font-size:0.72em;color:#d0d0d0;font-weight:600;">Hitam</div></button>
            <button onclick="applyThemePreset(\'navy\')" style="border:none;border-radius:7px;padding:0;overflow:hidden;cursor:pointer;"><div style="background:linear-gradient(160deg,#06101e,#091628,#0c1a32);height:40px;display:flex;align-items:center;justify-content:center;font-size:0.72em;color:#c4d0df;font-weight:600;">Navy</div></button>
            <button onclick="applyThemePreset(\'purple\')" style="border:none;border-radius:7px;padding:0;overflow:hidden;cursor:pointer;"><div style="background:linear-gradient(160deg,#0d0618,#130a2a,#1a0f3d);height:40px;display:flex;align-items:center;justify-content:center;font-size:0.72em;color:#c4bfe8;font-weight:600;">Purple</div></button>
            <button onclick="applyThemePreset(\'green\')" style="border:none;border-radius:7px;padding:0;overflow:hidden;cursor:pointer;"><div style="background:linear-gradient(160deg,#061209,#091a0e,#0c2218);height:40px;display:flex;align-items:center;justify-content:center;font-size:0.72em;color:#a7d9b0;font-weight:600;">Green</div></button>
            <button onclick="applyThemePreset(\'red\')" style="border:none;border-radius:7px;padding:0;overflow:hidden;cursor:pointer;"><div style="background:linear-gradient(160deg,#160608,#200a0d,#2a1015);height:40px;display:flex;align-items:center;justify-content:center;font-size:0.72em;color:#e8a0a8;font-weight:600;">Red</div></button>
            <button onclick="applyThemePreset(\'teal\')" style="border:none;border-radius:7px;padding:0;overflow:hidden;cursor:pointer;"><div style="background:linear-gradient(160deg,#060f10,#091519,#0c1c1e);height:40px;display:flex;align-items:center;justify-content:center;font-size:0.72em;color:#9ee8e0;font-weight:600;">Teal</div></button>
            <button onclick="applyThemePreset(\'slate\')" style="border:none;border-radius:7px;padding:0;overflow:hidden;cursor:pointer;"><div style="background:linear-gradient(160deg,#0a0a0f,#0f0f18,#141420);height:40px;display:flex;align-items:center;justify-content:center;font-size:0.72em;color:#c0c8d8;font-weight:600;">Slate</div></button>
            <button onclick="applyThemePreset(\'midnight\')" style="border:none;border-radius:7px;padding:0;overflow:hidden;cursor:pointer;"><div style="background:linear-gradient(160deg,#06060a,#09090f,#0d0d18);height:40px;display:flex;align-items:center;justify-content:center;font-size:0.72em;color:#9090b8;font-weight:600;">Midnight</div></button>
            <button onclick="applyThemePreset(\'rose\')" style="border:none;border-radius:7px;padding:0;overflow:hidden;cursor:pointer;"><div style="background:linear-gradient(160deg,#160a12,#1e0f1a,#281424);height:40px;display:flex;align-items:center;justify-content:center;font-size:0.72em;color:#e8b0c8;font-weight:600;">Rose</div></button>
            <button onclick="applyThemePreset(\'amber\')" style="border:none;border-radius:7px;padding:0;overflow:hidden;cursor:pointer;"><div style="background:linear-gradient(160deg,#150c02,#201305,#2a1808);height:40px;display:flex;align-items:center;justify-content:center;font-size:0.72em;color:#e8c880;font-weight:600;">Amber</div></button>
            <button onclick="applyThemePreset(\'ocean\')" style="border:none;border-radius:7px;padding:0;overflow:hidden;cursor:pointer;"><div style="background:linear-gradient(160deg,#040e1a,#071520,#0a1c2e);height:40px;display:flex;align-items:center;justify-content:center;font-size:0.72em;color:#80c8e8;font-weight:600;">Ocean</div></button>
            <button onclick="applyThemePreset(\'indigo\')" style="border:none;border-radius:7px;padding:0;overflow:hidden;cursor:pointer;"><div style="background:linear-gradient(160deg,#080a20,#0d1030,#121540);height:40px;display:flex;align-items:center;justify-content:center;font-size:0.72em;color:#a0a8f0;font-weight:600;">Indigo</div></button>
            <button onclick="applyThemePreset(\'copper\')" style="border:none;border-radius:7px;padding:0;overflow:hidden;cursor:pointer;"><div style="background:linear-gradient(160deg,#140a04,#1e1008,#281510);height:40px;display:flex;align-items:center;justify-content:center;font-size:0.72em;color:#d4a070;font-weight:600;">Copper</div></button>
            <button onclick="applyThemePreset(\'forest\')" style="border:none;border-radius:7px;padding:0;overflow:hidden;cursor:pointer;"><div style="background:linear-gradient(160deg,#041008,#07180c,#0a2010);height:40px;display:flex;align-items:center;justify-content:center;font-size:0.72em;color:#80c890;font-weight:600;">Forest</div></button>
            <button onclick="applyThemePreset(\'wine\')" style="border:none;border-radius:7px;padding:0;overflow:hidden;cursor:pointer;"><div style="background:linear-gradient(160deg,#180610,#220c18,#2e1220);height:40px;display:flex;align-items:center;justify-content:center;font-size:0.72em;color:#d880a0;font-weight:600;">Wine</div></button>
            <button onclick="applyThemePreset(\'cobalt\')" style="border:none;border-radius:7px;padding:0;overflow:hidden;cursor:pointer;"><div style="background:linear-gradient(160deg,#050a1e,#080f2c,#0c143a);height:40px;display:flex;align-items:center;justify-content:center;font-size:0.72em;color:#7090e8;font-weight:600;">Cobalt</div></button>
            <button onclick="applyThemePreset(\'sage\')" style="border:none;border-radius:7px;padding:0;overflow:hidden;cursor:pointer;"><div style="background:linear-gradient(160deg,#08100a,#0d1810,#122016);height:40px;display:flex;align-items:center;justify-content:center;font-size:0.72em;color:#90c898;font-weight:600;">Sage</div></button>
            <button onclick="applyThemePreset(\'gold\')" style="border:none;border-radius:7px;padding:0;overflow:hidden;cursor:pointer;"><div style="background:linear-gradient(160deg,#130e02,#1c1504,#261c06);height:40px;display:flex;align-items:center;justify-content:center;font-size:0.72em;color:#e0c050;font-weight:600;">Gold</div></button>
            <button onclick="applyThemePreset(\'storm\')" style="border:none;border-radius:7px;padding:0;overflow:hidden;cursor:pointer;"><div style="background:linear-gradient(160deg,#08101a,#0e1824,#14202e);height:40px;display:flex;align-items:center;justify-content:center;font-size:0.72em;color:#90aac8;font-weight:600;">Storm</div></button>
            <button onclick="applyThemePreset(\'plum\')" style="border:none;border-radius:7px;padding:0;overflow:hidden;cursor:pointer;"><div style="background:linear-gradient(160deg,#130618,#1c0d24,#251430);height:40px;display:flex;align-items:center;justify-content:center;font-size:0.72em;color:#c880d8;font-weight:600;">Plum</div></button>
            <button onclick="applyThemePreset(\'steel\')" style="border:none;border-radius:7px;padding:0;overflow:hidden;cursor:pointer;"><div style="background:linear-gradient(160deg,#080e18,#0e1622,#141e2e);height:40px;display:flex;align-items:center;justify-content:center;font-size:0.72em;color:#88a8c8;font-weight:600;">Steel</div></button>
            <button onclick="applyThemePreset(\'moss\')" style="border:none;border-radius:7px;padding:0;overflow:hidden;cursor:pointer;"><div style="background:linear-gradient(160deg,#070e06,#0c1409,#111a0d);height:40px;display:flex;align-items:center;justify-content:center;font-size:0.72em;color:#789870;font-weight:600;">Moss</div></button>
            <button onclick="applyThemePreset(\'carbon\')" style="border:none;border-radius:7px;padding:0;overflow:hidden;cursor:pointer;"><div style="background:linear-gradient(160deg,#080808,#0c0c0c,#111111);height:40px;display:flex;align-items:center;justify-content:center;font-size:0.72em;color:#707070;font-weight:600;">Carbon</div></button>
            <button onclick="applyThemePreset(\'dusk\')" style="border:none;border-radius:7px;padding:0;overflow:hidden;cursor:pointer;"><div style="background:linear-gradient(160deg,#100818,#180e22,#20142e);height:40px;display:flex;align-items:center;justify-content:center;font-size:0.72em;color:#b890d0;font-weight:600;">Dusk</div></button>
          </div>
          <p style="color:#6b7280;font-size:0.78em;margin-bottom:8px;font-weight:600;">Warna Custom:</p>
          <div style="display:grid;grid-template-columns:repeat(2,1fr);gap:10px;margin-bottom:14px;">
            <div>
              <label style="font-size:0.78em;color:#6b7280;display:block;margin-bottom:4px;">Gradient Kiri</label>
              <div style="display:flex;gap:6px;align-items:center;">
                <input type="color" id="themeBg1" value="#06101e" style="width:38px;height:32px;border:none;border-radius:6px;cursor:pointer;padding:2px;">
                <input type="text" id="themeBg1Txt" value="#06101e" maxlength="7" oninput="syncColorFromText(\'themeBg1\')" style="flex:1;background:#1a2e48;border:1px solid rgba(255,255,255,0.1);border-radius:6px;color:#c4d0df;padding:4px 8px;font-size:0.82em;">
              </div>
            </div>
            <div>
              <label style="font-size:0.78em;color:#6b7280;display:block;margin-bottom:4px;">Gradient Tengah</label>
              <div style="display:flex;gap:6px;align-items:center;">
                <input type="color" id="themeBg2" value="#091628" style="width:38px;height:32px;border:none;border-radius:6px;cursor:pointer;padding:2px;">
                <input type="text" id="themeBg2Txt" value="#091628" maxlength="7" oninput="syncColorFromText(\'themeBg2\')" style="flex:1;background:#1a2e48;border:1px solid rgba(255,255,255,0.1);border-radius:6px;color:#c4d0df;padding:4px 8px;font-size:0.82em;">
              </div>
            </div>
            <div>
              <label style="font-size:0.78em;color:#6b7280;display:block;margin-bottom:4px;">Gradient Kanan</label>
              <div style="display:flex;gap:6px;align-items:center;">
                <input type="color" id="themeBg3" value="#0c1a32" style="width:38px;height:32px;border:none;border-radius:6px;cursor:pointer;padding:2px;">
                <input type="text" id="themeBg3Txt" value="#0c1a32" maxlength="7" oninput="syncColorFromText(\'themeBg3\')" style="flex:1;background:#1a2e48;border:1px solid rgba(255,255,255,0.1);border-radius:6px;color:#c4d0df;padding:4px 8px;font-size:0.82em;">
              </div>
            </div>
            <div>
              <label style="font-size:0.78em;color:#6b7280;display:block;margin-bottom:4px;">Warna Kartu</label>
              <div style="display:flex;gap:6px;align-items:center;">
                <input type="color" id="themeCard" value="#0e1b2e" style="width:38px;height:32px;border:none;border-radius:6px;cursor:pointer;padding:2px;">
                <input type="text" id="themeCardTxt" value="#0e1b2e" maxlength="7" oninput="syncColorFromText(\'themeCard\')" style="flex:1;background:#1a2e48;border:1px solid rgba(255,255,255,0.1);border-radius:6px;color:#c4d0df;padding:4px 8px;font-size:0.82em;">
              </div>
            </div>
            <div>
              <label style="font-size:0.78em;color:#6b7280;display:block;margin-bottom:4px;">Warna Header/Stat</label>
              <div style="display:flex;gap:6px;align-items:center;">
                <input type="color" id="themeHeader" value="#070d1a" style="width:38px;height:32px;border:none;border-radius:6px;cursor:pointer;padding:2px;">
                <input type="text" id="themeHeaderTxt" value="#070d1a" maxlength="7" oninput="syncColorFromText(\'themeHeader\')" style="flex:1;background:#1a2e48;border:1px solid rgba(255,255,255,0.1);border-radius:6px;color:#c4d0df;padding:4px 8px;font-size:0.82em;">
              </div>
            </div>
          </div>
          <div id="themePreview" style="height:48px;border-radius:8px;margin-bottom:12px;background:linear-gradient(160deg,#06101e,#091628,#0c1a32);display:flex;align-items:center;justify-content:center;font-size:0.82em;color:#c4d0df;font-weight:600;transition:background 0.3s;">Preview</div>
          <button class="btn btn-primary" style="width:100%;" onclick="saveThemeSettings()">Simpan Tema</button>
        </div>

        <!-- Admin Phones -->
        <div class="card">
          <h2>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/>
            </svg>
            Nomor Admin untuk Notifikasi
          </h2>
          <p style="color:#6b7280;font-size:0.82em;margin-bottom:14px;">Nomor yang menerima notifikasi WhatsApp saat ada pendaftaran baru. Maksimal 2 nomor.</p>
          <div class="result-msg" id="adminPhoneResult"></div>
          <div class="form-group">
            <label>Nomor Admin 1 (Utama)</label>
            <input type="tel" id="adminPhone1" placeholder="0895701692525">
          </div>
          <div class="form-group">
            <label>Nomor Admin 2 (Opsional)</label>
            <input type="tel" id="adminPhone2" placeholder="08xxxxxxxxxx">
          </div>
          <button class="btn btn-primary" onclick="saveAdminPhones()">Simpan Nomor Admin</button>
        </div>

        <!-- Notifikasi ntfy.sh -->
        <div class="card">
          <h2>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="18" height="18">
              <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/>
            </svg>
            Notifikasi ntfy.sh
          </h2>
          <p style="color:#6b7280;font-size:0.82em;margin-bottom:14px;">Pengaturan notifikasi push via ntfy.sh/cekonts saat promo ON.</p>
          <div class="result-msg" id="ntfySettingsResult"></div>
          <div class="form-group" style="display:flex;align-items:center;gap:12px;margin-bottom:14px;">
            <label style="margin-bottom:0;">Aktifkan Notifikasi ntfy</label>
            <label style="display:flex;align-items:center;gap:6px;cursor:pointer;">
              <input type="checkbox" id="ntfyEnabled" style="width:18px;height:18px;cursor:pointer;">
              <span style="font-size:0.85em;color:#6b7280;" id="ntfyEnabledLabel">Aktif</span>
            </label>
          </div>
          <div class="form-group">
            <label>Jumlah kirim saat OFF→ON (1–600)</label>
            <input type="number" id="ntfyCount" min="1" max="600" placeholder="60" style="width:100%;">
            <p style="color:#6b7280;font-size:0.78em;margin-top:4px;">Default: 60x (1 per detik = 1 menit)</p>
          </div>
          <div class="form-group">
            <label>Interval reminder saat ON (menit, 1–60)</label>
            <input type="number" id="ntfyReminderMinutes" min="1" max="60" placeholder="10" style="width:100%;">
            <p style="color:#6b7280;font-size:0.78em;margin-top:4px;">Default: 10 menit</p>
          </div>
          <button class="btn btn-primary" onclick="saveNtfySettings()">Simpan Pengaturan ntfy</button>
        </div>
      </div>

      <!-- Section: Logs -->
      <div class="section-content" id="section-logs">
        <div class="card" style="margin-bottom:18px;">
          <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:14px;flex-wrap:wrap;gap:8px;">
            <h2 style="margin:0;">🔐 Riwayat Login User</h2>
            <span id="loginHistoryCount" style="font-size:0.82em;color:#8b949e;"></span>
          </div>
          <div style="display:flex;gap:8px;margin-bottom:12px;flex-wrap:wrap;align-items:center;">
            <input id="filterLoginPhone" type="text" placeholder="Filter nomor HP..." oninput="renderLoginHistoryFiltered()"
              style="padding:6px 10px;background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.1);border-radius:8px;color:#e7e9ea;font-size:0.82em;width:170px;outline:none;">
            <input id="filterLoginDate" type="date" oninput="renderLoginHistoryFiltered()"
              style="padding:6px 10px;background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.1);border-radius:8px;color:#e7e9ea;font-size:0.82em;outline:none;">
            <input id="filterLoginName" type="text" placeholder="Filter nama..." oninput="renderLoginHistoryFiltered()"
              style="padding:6px 10px;background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.1);border-radius:8px;color:#e7e9ea;font-size:0.82em;width:140px;outline:none;">
            <input id="filterLoginLocation" type="text" placeholder="Filter kota/provinsi..." oninput="renderLoginHistoryFiltered()"
              style="padding:6px 10px;background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.1);border-radius:8px;color:#e7e9ea;font-size:0.82em;width:170px;outline:none;">
            <button class="btn btn-secondary btn-sm" onclick="clearLoginFilters()">✕ Reset</button>
          </div>
          <div style="overflow-x:auto;">
            <table style="width:100%;border-collapse:collapse;font-size:0.82em;">
              <thead>
                <tr style="border-bottom:1px solid rgba(255,255,255,0.08);">
                  <th style="text-align:left;padding:8px 10px;color:#8b949e;font-weight:600;">Waktu (WIB)</th>
                  <th style="text-align:left;padding:8px 10px;color:#8b949e;font-weight:600;">Nomor HP &amp; Status</th>
                  <th style="text-align:left;padding:8px 10px;color:#8b949e;font-weight:600;">Nama</th>
                  <th style="text-align:left;padding:8px 10px;color:#8b949e;font-weight:600;">IP</th>
                  <th style="text-align:left;padding:8px 10px;color:#8b949e;font-weight:600;">Browser</th>
                  <th style="text-align:left;padding:8px 10px;color:#8b949e;font-weight:600;">Lokasi</th>
                </tr>
              </thead>
              <tbody id="loginHistoryBody">
                <tr><td colspan="3" style="text-align:center;padding:20px;color:#6b7280;">Memuat...</td></tr>
              </tbody>
            </table>
          </div>
        </div>
        <div class="card">
          <h2>📋 System Logs</h2>
          <div style="display:flex;gap:8px;margin-bottom:12px;flex-wrap:wrap;">
            <button class="btn btn-secondary btn-sm" onclick="loadAdminLogs()">🔁 Reload</button>
            <span style="font-size:0.82em;color:#00ff88;">⚡ Realtime via SSE</span>
          </div>
          <div id="logsContainer" style="background:#0a0e13;border-radius:10px;padding:12px;max-height:520px;overflow-y:auto;font-family:monospace;font-size:0.78em;line-height:1.6;"></div>
        </div>
      </div>

      <!-- Section: Broadcast Notifications -->
      <div class="section-content" id="section-broadcast">
        <div class="card">
          <h2>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="18" height="18">
              <path d="M22 2L11 13"/><path d="M22 2L15 22L11 13L2 9L22 2"/>
            </svg>
            Broadcast Notifikasi
          </h2>

          <!-- Stats Bar -->
          <div style="display:flex;gap:12px;margin-bottom:20px;">
            <div style="flex:1;background:rgba(34,197,94,0.08);border:1px solid rgba(34,197,94,0.2);border-radius:10px;padding:14px;text-align:center;">
              <div style="font-size:1.6em;font-weight:700;color:#22c55e;" id="bcastOnline">0</div>
              <div style="font-size:0.78em;color:#6b7280;margin-top:2px;">User Online</div>
            </div>
            <div style="flex:1;background:rgba(247,147,26,0.08);border:1px solid rgba(247,147,26,0.2);border-radius:10px;padding:14px;text-align:center;">
              <div style="font-size:1.6em;font-weight:700;color:#f7931a;" id="bcastSentToday">0</div>
              <div style="font-size:0.78em;color:#6b7280;margin-top:2px;">Terkirim Hari Ini</div>
            </div>
          </div>

          <!-- Tipe Notifikasi -->
          <div class="form-group">
            <label>Tipe Notifikasi</label>
            <div style="display:flex;gap:8px;flex-wrap:wrap;" id="bcastTypeBtns">
              <button class="action-btn bcast-type-btn active-type" data-type="info" onclick="selectBcastType(this)" style="background:rgba(59,130,246,0.2);border:1px solid rgba(96,165,250,0.5);color:#60a5fa;padding:6px 14px;font-size:0.85em;display:inline-flex;align-items:center;gap:5px;"><i data-lucide="send" style="width:13px;height:13px;"></i> Info</button>
              <button class="action-btn bcast-type-btn" data-type="promo" onclick="selectBcastType(this)" style="background:rgba(34,197,94,0.12);border:1px solid rgba(74,222,128,0.3);color:#4ade80;padding:6px 14px;font-size:0.85em;display:inline-flex;align-items:center;gap:5px;"><i data-lucide="tag" style="width:13px;height:13px;"></i> Promo</button>
              <button class="action-btn bcast-type-btn" data-type="warning" onclick="selectBcastType(this)" style="background:rgba(234,179,8,0.12);border:1px solid rgba(250,204,21,0.3);color:#facc15;padding:6px 14px;font-size:0.85em;display:inline-flex;align-items:center;gap:5px;"><i data-lucide="alert-triangle" style="width:13px;height:13px;"></i> Warning</button>
              <button class="action-btn bcast-type-btn" data-type="urgent" onclick="selectBcastType(this)" style="background:rgba(239,68,68,0.12);border:1px solid rgba(248,113,113,0.3);color:#f87171;padding:6px 14px;font-size:0.85em;display:inline-flex;align-items:center;gap:5px;"><i data-lucide="alert-circle" style="width:13px;height:13px;"></i> Urgent</button>
            </div>
          </div>

          <!-- Judul -->
          <div class="form-group">
            <label>Judul</label>
            <input type="text" id="bcastTitle" placeholder="Contoh: Promo Spesial!" style="width:100%;">
          </div>

          <!-- Pesan -->
          <div class="form-group">
            <label>Pesan</label>
            <textarea id="bcastMessage" placeholder="Contoh: Dapatkan diskon 10% untuk pembelian emas hari ini!" style="width:100%;min-height:80px;background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.1);border-radius:8px;padding:10px 12px;color:#e7e9ea;resize:vertical;font-family:inherit;font-size:0.9em;outline:none;"></textarea>
          </div>

          <button class="btn btn-primary" style="width:100%;" onclick="sendBroadcast()">Kirim Notifikasi</button>
          <div class="result-msg" id="bcastResult" style="margin-top:10px;"></div>
        </div>

        <!-- Riwayat -->
        <div class="card">
          <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px;">
            <h2 style="margin-bottom:0;">Riwayat Notifikasi</h2>
            <button class="btn btn-danger btn-sm" onclick="clearAllNotifHistory()" style="font-size:0.78em;padding:4px 10px;">Hapus Semua</button>
          </div>
          <div id="bcastHistory">
            <div style="text-align:center;color:#6b7280;padding:20px;">Memuat...</div>
          </div>
        </div>
      </div>
    </div>
  </div>

  <!-- Edit Modal -->
  <div class="modal" id="editModal">
    <div class="modal-content">
      <div class="modal-header">
        <h3>Edit User</h3>
        <button class="modal-close" onclick="closeModal()"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>
      </div>
      <div class="form-group">
        <label>Nomor WhatsApp</label>
        <input type="text" id="editPhone" readonly style="opacity:0.6;">
      </div>
      <div class="form-group">
        <label>Nama</label>
        <input type="text" id="editName">
      </div>
      <div class="form-group">
        <label>Tanggal Expired</label>
        <input type="date" id="editExpiredDate">
        <small style="color:#6b7280;font-size:0.8em;">Kosongkan untuk lifetime</small>
      </div>
      <div class="form-group">
        <label>Atau Tambah Hari dari Sekarang</label>
        <input type="number" id="editAddDays" placeholder="30" min="0">
      </div>
      <button class="btn btn-primary" style="width:100%;margin-top:12px;" onclick="saveUser()">Simpan</button>
    </div>
  </div>

  <!-- Push Modal -->
  <div class="modal" id="pushModal">
    <div class="modal-content">
      <div class="modal-header">
        <h3>Kirim Notifikasi</h3>
        <button class="modal-close" onclick="closePushModal()"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>
      </div>
      <input type="hidden" id="pushPhone">
      <div class="form-group">
        <label>Tipe</label>
        <select id="pushType">
          <option value="info">Info</option>
          <option value="promo">Promo</option>
          <option value="warning">Warning</option>
          <option value="urgent">Urgent</option>
        </select>
      </div>
      <div class="form-group">
        <label>Judul</label>
        <input type="text" id="pushTitle" placeholder="Judul notifikasi">
      </div>
      <div class="form-group">
        <label>Pesan</label>
        <input type="text" id="pushMessage" placeholder="Isi pesan">
      </div>
      <button class="btn btn-primary" style="width:100%;margin-top:12px;" onclick="sendPush()">Kirim</button>
    </div>
  </div>

  <script>
    // Admin sudah terautentikasi via /admin-login
    function adminFetch(url, opts) {
      var o = opts || {};
      var token = localStorage.getItem('super_admin_token') || '';
      var hdrs = Object.assign({ 'x-admin-token': token }, o.headers || {});
      return fetch(url, Object.assign({}, o, { headers: hdrs }));
    }

    // ==================== Professional Modal System ====================
    const modalIcons = {
      info: '<circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/>',
      success: '<path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/>',
      warning: '<path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>',
      danger: '<circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/>'
    };

    function showModal(options) {
      return new Promise((resolve) => {
        const modal = document.getElementById('proModal');
        const icon = document.getElementById('proModalIcon');
        const svg = document.getElementById('proModalSvg');
        const title = document.getElementById('proModalTitle');
        const message = document.getElementById('proModalMessage');
        const buttons = document.getElementById('proModalButtons');

        const type = options.type || 'info';
        icon.className = 'pro-modal-icon ' + type;
        svg.innerHTML = modalIcons[type] || modalIcons.info;
        title.textContent = options.title || '';
        message.textContent = options.message || '';

        buttons.innerHTML = '';
        if (options.showCancel !== false && options.confirmText) {
          const cancelBtn = document.createElement('button');
          cancelBtn.className = 'pro-modal-btn cancel';
          cancelBtn.textContent = options.cancelText || 'Batal';
          cancelBtn.onclick = () => { modal.classList.remove('show'); resolve(false); };
          buttons.appendChild(cancelBtn);
        }

        const confirmBtn = document.createElement('button');
        confirmBtn.className = 'pro-modal-btn ' + (type === 'danger' ? 'danger' : 'confirm');
        confirmBtn.textContent = options.confirmText || 'OK';
        confirmBtn.onclick = () => { modal.classList.remove('show'); resolve(true); };
        buttons.appendChild(confirmBtn);

        modal.classList.add('show');
      });
    }

    function showAlert(message, type = 'info') {
      return showModal({ type, title: type === 'success' ? 'Berhasil' : type === 'danger' ? 'Error' : 'Informasi', message, showCancel: false, confirmText: 'OK' });
    }

    function showConfirm(message, options = {}) {
      return showModal({ type: options.type || 'warning', title: options.title || 'Konfirmasi', message, confirmText: options.confirmText || 'Ya', cancelText: options.cancelText || 'Batal' });
    }

    // Tab Navigation
    document.querySelectorAll('.section-tab').forEach(tab => {
      tab.addEventListener('click', () => {
        document.querySelectorAll('.section-tab').forEach(t => t.classList.remove('active'));
        document.querySelectorAll('.section-content').forEach(s => s.classList.remove('active'));
        tab.classList.add('active');
        document.getElementById('section-' + tab.dataset.section).classList.add('active');
      });
    });

    // Load data langsung saat halaman dibuka
    document.addEventListener('DOMContentLoaded', function() {
      loadUsers();
      loadPendingRegistrations();
      loadWaGroups();
      loadAdminPhones();
      loadNtfySettings();
      loadSoundSettings();
      loadPromoLimit();
      loadMarkupSettingsAdmin();
      loadThemeAdmin();
      loadApiTokensAdmin();
      loadBroadcastHistory();
      connectAdminSSE();

      // Refresh broadcast stats saat tab broadcast diklik
      document.querySelectorAll('.section-tab[data-section="broadcast"]').forEach(tab => {
        tab.addEventListener('click', loadBroadcastHistory);
      });

      // Refresh WA status saat tab whatsapp diklik
      document.querySelectorAll('.section-tab[data-section="whatsapp"]').forEach(tab => {
        tab.addEventListener('click', () => {
          loadWaStatus();
          loadWaGroups();
        });
      });

      // Load logs & login history saat tab logs diklik, auto-refresh setiap 5 detik
      document.querySelectorAll('.section-tab[data-section="logs"]').forEach(tab => {
        tab.addEventListener('click', function() {
          loadAdminLogs();
          loadLoginHistory();
          clearInterval(_loginHistoryTimer);
          _loginHistoryTimer = setInterval(loadLoginHistory, 5000);
        });
      });
      // Hentikan auto-refresh login history saat pindah ke tab lain
      document.querySelectorAll('.section-tab:not([data-section="logs"])').forEach(tab => {
        tab.addEventListener('click', function() {
          clearInterval(_loginHistoryTimer);
        });
      });
    });

    // ==================== Online Users SSE ====================
    let adminEvtSource = null;

    function connectAdminSSE() {
      if (adminEvtSource) {
        adminEvtSource.close();
      }
      adminEvtSource = new EventSource('/admin-sse');

      adminEvtSource.onmessage = function(event) {
        try {
          const data = JSON.parse(event.data);
          if (data.type === 'online_users') {
            updateOnlineUsers(data.users, data.count);
          } else if (data.type === 'log') {
            appendLog(data.entry);
          }
        } catch (e) {}
      };

      adminEvtSource.onerror = function() {
        // Reconnect after 5 seconds
        setTimeout(connectAdminSSE, 5000);
      };
    }

    let onlineUsersExpanded = false;
    const ONLINE_USERS_LIMIT = 5;

    function updateOnlineUsers(users, count) {
      // Update badge
      document.getElementById('onlineBadge').textContent = count;
      document.getElementById('onlineCount').textContent = count;
      const bcastOnlineEl = document.getElementById('bcastOnline');
      if (bcastOnlineEl) bcastOnlineEl.textContent = count;

      // Update table
      const tbody = document.getElementById('onlineUsersList');
      const showMoreBtn = document.getElementById('showMoreOnline');
      if (!tbody) return;

      if (!users || users.length === 0) {
        tbody.innerHTML = '<tr><td colspan="4" class="empty-state">Tidak ada user online</td></tr>';
        if (showMoreBtn) showMoreBtn.style.display = 'none';
        return;
      }

      // Show/hide "Lihat Semua" button
      if (showMoreBtn) {
        showMoreBtn.style.display = users.length > ONLINE_USERS_LIMIT ? 'block' : 'none';
      }

      let html = '';
      users.forEach((user, index) => {
        const connectedAt = new Date(user.connectedAt);
        const timeStr = connectedAt.toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
        const isAnonymous = !user.phone || user.phone === 'anonymous';
        const displayName = user.name && user.name !== 'Anonymous' ? user.name : (isAnonymous ? '-' : 'Member');
        const displayPhone = isAnonymous ? '<span style="color:#6b7280;">Guest</span>' : '+' + user.phone;

        html += '<tr>' +
          '<td>' + (index + 1) + '</td>' +
          '<td>' + displayName + '</td>' +
          '<td class="phone">' + displayPhone + '</td>' +
          '<td>' + timeStr + '</td>' +
          '</tr>';
      });
      tbody.innerHTML = html;

      // Update wrapper height based on expanded state
      updateOnlineTableHeight(users.length);
    }

    function updateOnlineTableHeight(totalUsers) {
      const wrapper = document.getElementById('onlineTableWrapper');
      if (!wrapper) return;

      if (onlineUsersExpanded || totalUsers <= ONLINE_USERS_LIMIT) {
        wrapper.style.maxHeight = 'none';
      } else {
        wrapper.style.maxHeight = '300px';
      }
    }

    function toggleOnlineUsers() {
      onlineUsersExpanded = !onlineUsersExpanded;
      const wrapper = document.getElementById('onlineTableWrapper');
      const text = document.getElementById('showMoreText');
      const icon = document.getElementById('showMoreIcon');

      if (onlineUsersExpanded) {
        wrapper.style.maxHeight = 'none';
        text.textContent = 'Sembunyikan';
        icon.innerHTML = '<polyline points="18 15 12 9 6 15"/>';
      } else {
        wrapper.style.maxHeight = '300px';
        text.textContent = 'Lihat Semua';
        icon.innerHTML = '<polyline points="6 9 12 15 18 9"/>';
      }
    }

    function formatPhone(phone) {
      if (!phone) return '-';
      // Format: 628xxx -> 08xxx
      if (phone.startsWith('62')) {
        return '0' + phone.substring(2);
      }
      return phone;
    }

    // ==================== Sound Settings Functions ====================
    let currentSoundUp = '';
    let currentSoundDown = '';
    let currentSoundOn = '';
    let currentSoundOff = '';
    let currentSoundBigUp = '';
    let currentSoundBigDown = '';

    function loadSoundSettings() {
      adminFetch('/api/sound-settings')
        .then(r => r.json())
        .then(data => {
          if (data.success) {
            currentSoundUp = data.settings.soundUp || '';
            currentSoundDown = data.settings.soundDown || '';
            currentSoundOn = data.settings.soundOn || '';
            currentSoundOff = data.settings.soundOff || '';
            currentSoundBigUp = data.settings.soundBigUp || '';
            currentSoundBigDown = data.settings.soundBigDown || '';

            document.getElementById('soundUpUrl').value = currentSoundUp;
            document.getElementById('soundDownUrl').value = currentSoundDown;
            document.getElementById('soundOnUrl').value = currentSoundOn;
            document.getElementById('soundOffUrl').value = currentSoundOff;
            document.getElementById('soundBigUpUrl').value = currentSoundBigUp;
            document.getElementById('soundBigDownUrl').value = currentSoundBigDown;

            if (currentSoundUp) {
              document.getElementById('soundUpPreview').style.display = 'block';
              document.getElementById('soundUpAudio').src = currentSoundUp;
            }
            if (currentSoundDown) {
              document.getElementById('soundDownPreview').style.display = 'block';
              document.getElementById('soundDownAudio').src = currentSoundDown;
            }
            if (currentSoundOn) {
              document.getElementById('soundOnPreview').style.display = 'block';
              document.getElementById('soundOnAudio').src = currentSoundOn;
            }
            if (currentSoundOff) {
              document.getElementById('soundOffPreview').style.display = 'block';
              document.getElementById('soundOffAudio').src = currentSoundOff;
            }
            if (currentSoundBigUp) {
              document.getElementById('soundBigUpPreview').style.display = 'block';
              document.getElementById('soundBigUpAudio').src = currentSoundBigUp;
            }
            if (currentSoundBigDown) {
              document.getElementById('soundBigDownPreview').style.display = 'block';
              document.getElementById('soundBigDownAudio').src = currentSoundBigDown;
            }
          }
        });
    }

    function handleSoundUpload(direction) {
      const idMap = { up: 'Up', down: 'Down', on: 'On', off: 'Off', bigUp: 'BigUp', bigDown: 'BigDown' };
      const suffix = idMap[direction] || 'Up';
      const fileInput = document.getElementById('sound' + suffix + 'File');
      const urlInput = document.getElementById('sound' + suffix + 'Url');
      const preview = document.getElementById('sound' + suffix + 'Preview');
      const audio = document.getElementById('sound' + suffix + 'Audio');
      const result = document.getElementById('soundResult');

      const file = fileInput.files[0];
      if (!file) return;

      if (file.size > 500 * 1024) {
        result.className = 'result-msg error';
        result.textContent = 'File terlalu besar! Maksimal 500KB. File Anda: ' + Math.round(file.size/1024) + 'KB';
        fileInput.value = '';
        return;
      }

      if (!file.type.startsWith('audio/')) {
        result.className = 'result-msg error';
        result.textContent = 'File harus berformat audio (MP3, WAV, OGG, dll)';
        fileInput.value = '';
        return;
      }

      const reader = new FileReader();
      reader.onload = function(e) {
        const dataUrl = e.target.result;
        urlInput.value = dataUrl;
        audio.src = dataUrl;
        preview.style.display = 'block';
        result.className = 'result-msg success';
        result.textContent = 'File "' + file.name + '" berhasil dimuat. Klik "Simpan Sound" untuk menyimpan.';
        setTimeout(() => result.className = 'result-msg', 5000);
      };
      reader.onerror = function() {
        result.className = 'result-msg error';
        result.textContent = 'Gagal membaca file';
      };
      reader.readAsDataURL(file);
    }

    function saveSoundSettings() {
      const soundUp = document.getElementById('soundUpUrl').value.trim();
      const soundDown = document.getElementById('soundDownUrl').value.trim();
      const soundOn = document.getElementById('soundOnUrl').value.trim();
      const soundOff = document.getElementById('soundOffUrl').value.trim();
      const soundBigUp = document.getElementById('soundBigUpUrl').value.trim();
      const soundBigDown = document.getElementById('soundBigDownUrl').value.trim();
      const result = document.getElementById('soundResult');

      result.className = 'result-msg success';
      result.textContent = 'Menyimpan...';

      adminFetch('/api/admin/sound-settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ soundUp, soundDown, soundOn, soundOff, soundBigUp, soundBigDown })
      })
      .then(r => r.json())
      .then(data => {
        if (data.success) {
          currentSoundUp = soundUp;
          currentSoundDown = soundDown;
          currentSoundOn = soundOn;
          currentSoundOff = soundOff;
          currentSoundBigUp = soundBigUp;
          currentSoundBigDown = soundBigDown;
          result.className = 'result-msg success';
          result.textContent = 'Sound berhasil disimpan!';
        } else {
          result.className = 'result-msg error';
          result.textContent = 'Gagal: ' + data.error;
        }
        setTimeout(() => result.className = 'result-msg', 5000);
      })
      .catch(e => {
        result.className = 'result-msg error';
        result.textContent = 'Error: ' + e.message;
      });
    }

    async function resetSounds() {
      const confirmed = await showConfirm('Reset semua sound ke default?', { title: 'Reset Sound', type: 'warning' });
      if (!confirmed) return;

      const result = document.getElementById('soundResult');
      result.className = 'result-msg success';
      result.textContent = 'Mereset sound...';

      adminFetch('/api/admin/sound-settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ soundUp: '', soundDown: '', soundOn: '', soundOff: '', soundBigUp: '', soundBigDown: '' })
      })
      .then(r => r.json())
      .then(data => {
        if (data.success) {
          currentSoundUp = '';
          currentSoundDown = '';
          currentSoundOn = '';
          currentSoundOff = '';
          currentSoundBigUp = '';
          currentSoundBigDown = '';
          ['Up', 'Down', 'On', 'Off', 'BigUp', 'BigDown'].forEach(s => {
            document.getElementById('sound' + s + 'Url').value = '';
            document.getElementById('sound' + s + 'File').value = '';
            document.getElementById('sound' + s + 'Preview').style.display = 'none';
          });
          result.className = 'result-msg success';
          result.textContent = 'Sound berhasil direset ke default!';
        } else {
          result.className = 'result-msg error';
          result.textContent = 'Gagal: ' + data.error;
        }
        setTimeout(() => result.className = 'result-msg', 5000);
      });
    }

    function testSound(direction) {
      const idMap = { up: 'Up', down: 'Down', on: 'On', off: 'Off', bigUp: 'BigUp', bigDown: 'BigDown' };
      const suffix = idMap[direction] || 'Up';
      const url = document.getElementById('sound' + suffix + 'Url').value.trim();

      if (url) {
        const audio = new Audio(url);
        audio.volume = 0.5;
        audio.play().catch(e => showAlert('Gagal memutar sound: ' + e.message, 'danger'));
      } else if (direction === 'bigUp' || direction === 'bigDown') {
        playDefaultBigSound(direction);
      } else {
        playDefaultSound(direction);
      }
    }

    function playDefaultBigSound(direction) {
      try {
        const ctx = new (window.AudioContext || window.webkitAudioContext)();
        if (direction === 'bigUp') {
          [600, 900, 1400].forEach((freq, i) => {
            const osc = ctx.createOscillator();
            const gain = ctx.createGain();
            osc.connect(gain); gain.connect(ctx.destination);
            osc.type = 'sine';
            osc.frequency.setValueAtTime(freq, ctx.currentTime + i * 0.12);
            gain.gain.setValueAtTime(0.4, ctx.currentTime + i * 0.12);
            gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + i * 0.12 + 0.25);
            osc.start(ctx.currentTime + i * 0.12);
            osc.stop(ctx.currentTime + i * 0.12 + 0.25);
          });
        } else {
          [1200, 800, 350].forEach((freq, i) => {
            const osc = ctx.createOscillator();
            const gain = ctx.createGain();
            osc.connect(gain); gain.connect(ctx.destination);
            osc.type = 'sawtooth';
            osc.frequency.setValueAtTime(freq, ctx.currentTime + i * 0.12);
            gain.gain.setValueAtTime(0.35, ctx.currentTime + i * 0.12);
            gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + i * 0.12 + 0.25);
            osc.start(ctx.currentTime + i * 0.12);
            osc.stop(ctx.currentTime + i * 0.12 + 0.25);
          });
        }
      } catch (e) {}
    }

    function playDefaultSound(direction) {
      try {
        const ctx = new (window.AudioContext || window.webkitAudioContext)();
        const oscillator = ctx.createOscillator();
        const gainNode = ctx.createGain();
        oscillator.connect(gainNode);
        gainNode.connect(ctx.destination);

        if (direction === 'up') {
          oscillator.type = 'sine';
          oscillator.frequency.setValueAtTime(800, ctx.currentTime);
          oscillator.frequency.setValueAtTime(1200, ctx.currentTime + 0.15);
          gainNode.gain.setValueAtTime(0.3, ctx.currentTime);
          gainNode.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.3);
          oscillator.start(ctx.currentTime);
          oscillator.stop(ctx.currentTime + 0.3);
        } else {
          oscillator.type = 'sawtooth';
          oscillator.frequency.setValueAtTime(400, ctx.currentTime);
          oscillator.frequency.exponentialRampToValueAtTime(150, ctx.currentTime + 0.3);
          gainNode.gain.setValueAtTime(0.2, ctx.currentTime);
          gainNode.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.3);
          oscillator.start(ctx.currentTime);
          oscillator.stop(ctx.currentTime + 0.3);
        }
      } catch (e) {
      }
    }

    // ==================== Admin Phones Functions ====================
    function loadAdminPhones() {
      fetch('/api/admin-phones')
        .then(r => r.json())
        .then(data => {
          if (data.success && data.phones) {
            document.getElementById('adminPhone1').value = data.phones[0] ? data.phones[0].replace('62', '0') : '';
            document.getElementById('adminPhone2').value = data.phones[1] ? data.phones[1].replace('62', '0') : '';
          }
        });
    }

    function saveAdminPhones() {
      const phone1 = document.getElementById('adminPhone1').value.trim();
      const phone2 = document.getElementById('adminPhone2').value.trim();
      const result = document.getElementById('adminPhoneResult');

      if (!phone1) {
        result.className = 'result-msg error';
        result.textContent = 'Nomor admin 1 wajib diisi';
        return;
      }

      const phones = [phone1];
      if (phone2) phones.push(phone2);

      fetch('/api/admin-phones', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phones })
      })
      .then(r => r.json())
      .then(data => {
        if (data.success) {
          result.className = 'result-msg success';
          result.textContent = 'Nomor admin berhasil disimpan';
          loadAdminPhones();
        } else {
          result.className = 'result-msg error';
          result.textContent = data.message || 'Gagal menyimpan';
        }
      });
    }

    // ==================== ntfy Settings Functions ====================
    function loadNtfySettings() {
      adminFetch('/api/admin/ntfy-settings')
        .then(r => r.json())
        .then(data => {
          if (data.success && data.settings) {
            const s = data.settings;
            document.getElementById('ntfyEnabled').checked = s.enabled;
            document.getElementById('ntfyEnabledLabel').textContent = s.enabled ? 'Aktif' : 'Nonaktif';
            document.getElementById('ntfyCount').value = s.count;
            document.getElementById('ntfyReminderMinutes').value = s.reminderMinutes;
          }
        }).catch(() => {});
      document.getElementById('ntfyEnabled').addEventListener('change', function() {
        document.getElementById('ntfyEnabledLabel').textContent = this.checked ? 'Aktif' : 'Nonaktif';
      });
    }

    function saveNtfySettings() {
      const result = document.getElementById('ntfySettingsResult');
      const enabled = document.getElementById('ntfyEnabled').checked;
      const count = parseInt(document.getElementById('ntfyCount').value, 10);
      const reminderMinutes = parseInt(document.getElementById('ntfyReminderMinutes').value, 10);
      if (isNaN(count) || count < 1 || count > 600) {
        result.className = 'result-msg error';
        result.textContent = 'Jumlah kirim harus antara 1–600';
        return;
      }
      if (isNaN(reminderMinutes) || reminderMinutes < 1 || reminderMinutes > 60) {
        result.className = 'result-msg error';
        result.textContent = 'Interval reminder harus antara 1–60 menit';
        return;
      }
      result.className = 'result-msg success';
      result.textContent = 'Menyimpan...';
      adminFetch('/api/admin/ntfy-settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled, count, reminderMinutes })
      })
      .then(r => r.json())
      .then(data => {
        if (data.success) {
          result.className = 'result-msg success';
          result.textContent = 'Pengaturan ntfy berhasil disimpan!';
        } else {
          result.className = 'result-msg error';
          result.textContent = data.error || 'Gagal menyimpan';
        }
        setTimeout(() => { result.textContent = ''; }, 3000);
      })
      .catch(() => {
        result.className = 'result-msg error';
        result.textContent = 'Gagal menghubungi server';
        setTimeout(() => { result.textContent = ''; }, 3000);
      });
    }

    // ==================== Promo Limit Functions ====================
    function loadPromoLimit() {
      adminFetch('/api/promo-limit')
        .then(r => r.json())
        .then(data => {
          const cur = document.getElementById('promoLimitCurrent');
          if (cur) cur.textContent = data.limit !== null ? data.limit : '(belum diset)';
          const inp = document.getElementById('promoLimitInput');
          if (inp && data.limit !== null) inp.value = data.limit;
        });
    }

    // ==================== API Eksternal: kelola API key ====================
    function loadApiTokensAdmin() {
      adminFetch('/api/admin/api-tokens')
        .then(r => r.json())
        .then(data => {
          const tbody = document.getElementById('apiTokenBody');
          if (!tbody) return;
          if (!data.success || !data.items || data.items.length === 0) {
            tbody.innerHTML = '<tr><td colspan="5" style="text-align:center;padding:16px;color:#6b7280;">Belum ada API key. Generate di atas.</td></tr>';
            return;
          }
          tbody.innerHTML = data.items.map(function(t) {
            var st = t.enabled
              ? '<span style="background:rgba(34,197,94,0.12);color:#4ade80;border:1px solid rgba(34,197,94,0.25);padding:1px 8px;border-radius:6px;font-size:0.85em;font-weight:600;">AKTIF</span>'
              : '<span style="background:rgba(239,68,68,0.12);color:#f87171;border:1px solid rgba(239,68,68,0.25);padding:1px 8px;border-radius:6px;font-size:0.85em;font-weight:600;">NONAKTIF</span>';
            var safeName = String(t.name || '-').replace(/[<>"&]/g, '');
            return '<tr style="border-bottom:1px solid rgba(255,255,255,0.04);">' +
              '<td style="padding:8px 10px;color:#e6edf3;">' + safeName + '</td>' +
              '<td style="padding:8px 10px;"><code class="api-key-code" data-key="' + t.key + '" style="font-family:monospace;font-size:0.9em;color:#f7931a;background:rgba(247,147,26,0.08);padding:2px 6px;border-radius:5px;cursor:pointer;" title="Klik untuk salin">' + t.key.slice(0, 16) + '...</code></td>' +
              '<td style="padding:8px 10px;">' + st + '</td>' +
              '<td style="padding:8px 10px;color:#9ca3af;font-family:monospace;">' + (t.hits || 0) + '</td>' +
              '<td style="padding:8px 10px;white-space:nowrap;">' +
                '<button class="action-btn ' + (t.enabled ? 'block' : 'unblock') + '" data-act="toggle" data-key="' + t.key + '">' + (t.enabled ? 'Nonaktifkan' : 'Aktifkan') + '</button> ' +
                '<button class="action-btn delete" data-act="del" data-key="' + t.key + '" data-name="' + safeName + '">Hapus</button>' +
              '</td></tr>';
          }).join('');
          _wireApiTokenTable();
        })
        .catch(() => {});
    }

    // Event delegation — hindari onclick inline (bermasalah dengan tanda kutip di dalam key)
    function _wireApiTokenTable() {
      var tb = document.getElementById('apiTokenBody');
      if (!tb || tb._wired) return;
      tb._wired = true;
      tb.addEventListener('click', function(e) {
        var el = e.target.closest ? e.target.closest('.api-key-code, [data-act]') : null;
        if (!el) return;
        var key = el.getAttribute('data-key') || '';
        if (el.classList.contains('api-key-code')) {
          if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(key).then(function() {
              el.textContent = 'Tersalin!';
              setTimeout(function() { el.textContent = key.slice(0, 16) + '...'; }, 1200);
            }).catch(function() {});
          }
          return;
        }
        var act = el.getAttribute('data-act');
        if (act === 'toggle') toggleApiToken(key);
        else if (act === 'del') deleteApiToken(key, el.getAttribute('data-name') || '');
      });
    }

    function createApiToken() {
      const nameEl = document.getElementById('apiTokenName');
      const result = document.getElementById('apiTokenResult');
      const name = (nameEl ? nameEl.value : '').trim() || 'default';
      adminFetch('/api/admin/api-tokens', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name })
      })
      .then(r => r.json())
      .then(data => {
        if (data.success) {
          result.className = 'result-msg success';
          result.innerHTML = 'Key dibuat! Salin sekarang: <code style="font-family:monospace;user-select:all;">' + data.key + '</code>';
          if (nameEl) nameEl.value = '';
          loadApiTokensAdmin();
        } else {
          result.className = 'result-msg error';
          result.textContent = data.error || 'Gagal membuat key';
          setTimeout(() => { result.textContent = ''; result.className = 'result-msg'; }, 4000);
        }
      })
      .catch(err => {
        result.className = 'result-msg error';
        result.textContent = 'Error: ' + err.message;
      });
    }

    function toggleApiToken(key) {
      adminFetch('/api/admin/api-tokens/toggle', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key })
      }).then(r => r.json()).then(() => loadApiTokensAdmin()).catch(() => {});
    }

    function deleteApiToken(key, name) {
      if (!confirm('Hapus API key "' + name + '" permanen? Aplikasi luar yang memakainya akan langsung berhenti bisa akses.')) return;
      adminFetch('/api/admin/api-tokens/delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key })
      }).then(r => r.json()).then(() => loadApiTokensAdmin()).catch(() => {});
    }

    // ==================== Reset Tur + Sound/Getar ====================
    function resetFreshAll() {
      if (!confirm('Yakin? Semua user akan melihat tur pengenalan lagi dan Sound & Getar direset ke default.')) return;
      const btn = document.getElementById('resetFreshBtn');
      const result = document.getElementById('resetFreshResult');
      btn.disabled = true;
      const oldText = btn.textContent;
      btn.textContent = 'Memproses...';
      adminFetch('/api/admin/reset-fresh', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      })
      .then(r => r.json())
      .then(data => {
        if (data.success) {
          result.className = 'result-msg success';
          result.textContent = 'Berhasil! Semua user akan dapat tur + reset Sound/Getar saat buka/refresh. (token: ' + data.token + ')';
        } else {
          result.className = 'result-msg error';
          result.textContent = data.error || 'Gagal';
        }
      })
      .catch(err => {
        result.className = 'result-msg error';
        result.textContent = 'Error: ' + err.message;
      })
      .finally(() => {
        btn.disabled = false;
        btn.textContent = oldText;
        setTimeout(() => { result.textContent = ''; result.className = 'result-msg'; }, 6000);
      });
    }

    function savePromoLimit() {
      const inp = document.getElementById('promoLimitInput');
      const result = document.getElementById('promoLimitResult');
      const val = inp ? inp.value.trim() : '';
      if (val === '' || isNaN(parseInt(val, 10))) {
        result.className = 'result-msg error';
        result.textContent = 'Masukkan angka yang valid';
        return;
      }
      adminFetch('/api/admin/promo-limit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ limit: parseInt(val, 10) })
      })
      .then(r => r.json())
      .then(data => {
        if (data.success) {
          result.className = 'result-msg success';
          result.textContent = 'Limit berhasil disimpan: ' + data.limit;
          loadPromoLimit();
        } else {
          result.className = 'result-msg error';
          result.textContent = data.error || 'Gagal menyimpan';
        }
        setTimeout(() => { result.textContent = ''; result.className = 'result-msg'; }, 3000);
      });
    }

    // ==================== Markup Settings Functions ====================
    function loadMarkupSettingsAdmin() {
      adminFetch('/api/markup-settings')
        .then(r => r.json())
        .then(data => {
          if (!data.success) return;
          const s = data.settings;
          const minEl = document.getElementById('markupMinCurrent');
          const maxEl = document.getElementById('markupMaxCurrent');
          const minInp = document.getElementById('markupMinInput');
          const maxInp = document.getElementById('markupMaxInput');
          if (minEl) minEl.textContent = s.minMargin;
          if (maxEl) maxEl.textContent = s.maxMargin;
          if (minInp) minInp.value = s.minMargin;
          if (maxInp) maxInp.value = s.maxMargin;
        });
    }

    function saveMarkupSettings() {
      const minVal = parseFloat(document.getElementById('markupMinInput')?.value);
      const maxVal = parseFloat(document.getElementById('markupMaxInput')?.value);
      const result = document.getElementById('markupSettingsResult');
      if (isNaN(minVal) || isNaN(maxVal) || minVal < 0 || maxVal < minVal || maxVal > 20) {
        result.className = 'result-msg error';
        result.textContent = 'Nilai tidak valid. Pastikan min ≤ max dan max ≤ 20%';
        return;
      }
      adminFetch('/api/admin/markup-settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ minMargin: minVal, maxMargin: maxVal })
      })
      .then(r => r.json())
      .then(data => {
        if (data.success) {
          result.className = 'result-msg success';
          result.textContent = 'Berhasil disimpan: ' + data.settings.minMargin + '% – ' + data.settings.maxMargin + '%';
          loadMarkupSettingsAdmin();
        } else {
          result.className = 'result-msg error';
          result.textContent = data.error || 'Gagal menyimpan';
        }
        setTimeout(() => { result.textContent = ''; result.className = 'result-msg'; }, 4000);
      });
    }

    // ==================== Theme Settings Functions ====================
    const _THEME_PRESETS = {
      black:    { bg1: '#000000', bg2: '#000000', bg3: '#000000', card: '#0a0a0a', header: '#000000' },
      navy:     { bg1: '#06101e', bg2: '#091628', bg3: '#0c1a32', card: '#0e1b2e', header: '#070d1a' },
      purple:   { bg1: '#0d0618', bg2: '#130a2a', bg3: '#1a0f3d', card: '#160d2e', header: '#0a0414' },
      green:    { bg1: '#061209', bg2: '#091a0e', bg3: '#0c2218', card: '#0a1c0e', header: '#040e06' },
      red:      { bg1: '#160608', bg2: '#200a0d', bg3: '#2a1015', card: '#1e0a0d', header: '#120406' },
      teal:     { bg1: '#060f10', bg2: '#091519', bg3: '#0c1c1e', card: '#0a181a', header: '#040b0c' },
      slate:    { bg1: '#0a0a0f', bg2: '#0f0f18', bg3: '#141420', card: '#121218', header: '#08080c' },
      midnight: { bg1: '#06060a', bg2: '#09090f', bg3: '#0d0d18', card: '#101016', header: '#040408' },
      rose:     { bg1: '#160a12', bg2: '#1e0f1a', bg3: '#281424', card: '#1e0e1a', header: '#110809' },
      amber:    { bg1: '#150c02', bg2: '#201305', bg3: '#2a1808', card: '#1e1206', header: '#100a02' },
      ocean:    { bg1: '#040e1a', bg2: '#071520', bg3: '#0a1c2e', card: '#0a1828', header: '#030b14' },
      indigo:   { bg1: '#080a20', bg2: '#0d1030', bg3: '#121540', card: '#0f1235', header: '#06081a' },
      copper:   { bg1: '#140a04', bg2: '#1e1008', bg3: '#281510', card: '#1e1008', header: '#100802' },
      forest:   { bg1: '#041008', bg2: '#07180c', bg3: '#0a2010', card: '#081a0c', header: '#030c06' },
      wine:     { bg1: '#180610', bg2: '#220c18', bg3: '#2e1220', card: '#220a14', header: '#140408' },
      cobalt:   { bg1: '#050a1e', bg2: '#080f2c', bg3: '#0c143a', card: '#0a1230', header: '#040818' },
      sage:     { bg1: '#08100a', bg2: '#0d1810', bg3: '#122016', card: '#0e1a12', header: '#060d08' },
      gold:     { bg1: '#130e02', bg2: '#1c1504', bg3: '#261c06', card: '#1c1404', header: '#0f0c02' },
      storm:    { bg1: '#08101a', bg2: '#0e1824', bg3: '#14202e', card: '#101a28', header: '#060e16' },
      plum:     { bg1: '#130618', bg2: '#1c0d24', bg3: '#251430', card: '#1c0c22', header: '#0f0414' },
      steel:    { bg1: '#080e18', bg2: '#0e1622', bg3: '#141e2e', card: '#101820', header: '#060c14' },
      moss:     { bg1: '#070e06', bg2: '#0c1409', bg3: '#111a0d', card: '#0e1a0a', header: '#050b04' },
      carbon:   { bg1: '#080808', bg2: '#0c0c0c', bg3: '#111111', card: '#101010', header: '#060606' },
      dusk:     { bg1: '#100818', bg2: '#180e22', bg3: '#20142e', card: '#180d20', header: '#0c0614' },
    };

    function _setThemeInputs(t) {
      ['bg1','bg2','bg3','card','header'].forEach(k => {
        const el = document.getElementById('theme' + k.charAt(0).toUpperCase() + k.slice(1));
        const txt = document.getElementById('theme' + k.charAt(0).toUpperCase() + k.slice(1) + 'Txt');
        if (el && t[k]) el.value = t[k];
        if (txt && t[k]) txt.value = t[k];
      });
      const prev = document.getElementById('themePreview');
      if (prev) prev.style.background = 'linear-gradient(160deg,' + t.bg1 + ',' + t.bg2 + ',' + t.bg3 + ')';
    }

    function applyThemePreset(name) {
      if (_THEME_PRESETS[name]) _setThemeInputs(_THEME_PRESETS[name]);
    }

    function syncColorFromText(id) {
      const txt = document.getElementById(id + 'Txt');
      const picker = document.getElementById(id);
      if (txt && picker && /^#[0-9a-fA-F]{6}$/.test(txt.value)) {
        picker.value = txt.value;
        const bg1 = document.getElementById('themeBg1')?.value || '#06101e';
        const bg2 = document.getElementById('themeBg2')?.value || '#091628';
        const bg3 = document.getElementById('themeBg3')?.value || '#0c1a32';
        const prev = document.getElementById('themePreview');
        if (prev) prev.style.background = 'linear-gradient(160deg,' + bg1 + ',' + bg2 + ',' + bg3 + ')';
      }
    }

    function loadThemeAdmin() {
      adminFetch('/api/theme-settings')
        .then(r => r.json())
        .then(data => {
          if (data.success && data.theme) _setThemeInputs(data.theme);
        }).catch(() => {});
    }

    // Sync color picker → text input + preview
    ['Bg1','Bg2','Bg3','Card','Header'].forEach(function(k) {
      setTimeout(function() {
        const el = document.getElementById('theme' + k);
        if (el) el.addEventListener('input', function() {
          const txt = document.getElementById('theme' + k + 'Txt');
          if (txt) txt.value = el.value;
          const bg1 = document.getElementById('themeBg1')?.value || '#06101e';
          const bg2 = document.getElementById('themeBg2')?.value || '#091628';
          const bg3 = document.getElementById('themeBg3')?.value || '#0c1a32';
          const prev = document.getElementById('themePreview');
          if (prev) prev.style.background = 'linear-gradient(160deg,' + bg1 + ',' + bg2 + ',' + bg3 + ')';
        });
      }, 500);
    });

    function saveThemeSettings() {
      const bg1 = document.getElementById('themeBg1')?.value;
      const bg2 = document.getElementById('themeBg2')?.value;
      const bg3 = document.getElementById('themeBg3')?.value;
      const card = document.getElementById('themeCard')?.value;
      const header = document.getElementById('themeHeader')?.value;
      const result = document.getElementById('themeResult');
      const isHex = v => /^#[0-9a-fA-F]{6}$/.test(v);
      if (!isHex(bg1) || !isHex(bg2) || !isHex(bg3) || !isHex(card) || !isHex(header)) {
        result.className = 'result-msg error';
        result.textContent = 'Format warna tidak valid';
        return;
      }
      adminFetch('/api/admin/theme-settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ bg1, bg2, bg3, card, header })
      })
      .then(r => r.json())
      .then(data => {
        result.className = data.success ? 'result-msg success' : 'result-msg error';
        result.textContent = data.success ? 'Tema berhasil disimpan! User baru akan langsung melihat tema ini.' : (data.error || 'Gagal menyimpan');
        setTimeout(() => { result.textContent = ''; result.className = 'result-msg'; }, 4000);
      });
    }

    // ==================== Nominal Management Functions ====================
    let currentNominals = [];

    function loadNominals() {
      adminFetch('/api/admin/nominal-settings')
        .then(r => r.json())
        .then(data => {
          if (data.success) {
            currentNominals = data.config.nominals || [];
            renderNominalTable();
          }
        })
        .catch(() => {});
    }

    function renderNominalTable() {
      const tbody = document.getElementById('nominalTableBody');
      if (!currentNominals || currentNominals.length === 0) {
        tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;color:#6b7280;">Tidak ada nominal</td></tr>';
        return;
      }

      tbody.innerHTML = currentNominals.map((nom, idx) => {
        const statusClass = nom.active ? 'badge-success' : 'badge-danger';
        const statusText = nom.active ? 'Aktif' : 'Nonaktif';
        const toggleText = nom.active ? 'Nonaktifkan' : 'Aktifkan';
        const toggleColor = nom.active ? '#ef4444' : '#22c55e';
        const promoChecked = nom.promoRef ? 'checked' : '';

        return '<tr>' +
          '<td style="text-align:center;"><input type="radio" name="promoRef" ' + promoChecked + ' onchange="setPromoRef(' + idx + ')" style="width:18px;height:18px;cursor:pointer;accent-color:#22c55e;" title="Patokan Promo ON/OFF"></td>' +
          '<td><input type="text" value="' + nom.id + '" onchange="updateNominal(' + idx + ', &apos;id&apos;, this.value)" style="width:60px;background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.1);padding:4px 8px;border-radius:4px;color:#e7e9ea;"></td>' +
          '<td><input type="text" value="' + nom.label + '" onchange="updateNominal(' + idx + ', &apos;label&apos;, this.value)" style="width:60px;background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.1);padding:4px 8px;border-radius:4px;color:#e7e9ea;"></td>' +
          '<td><input type="number" value="' + nom.amount + '" onchange="updateNominal(' + idx + ', &apos;amount&apos;, parseFloat(this.value))" style="width:120px;background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.1);padding:4px 8px;border-radius:4px;color:#e7e9ea;"></td>' +
          '<td><input type="number" value="' + parseFloat((nom.discountRate * 100).toFixed(3)) + '" onchange="updateNominal(' + idx + ', &apos;discountRate&apos;, parseFloat(this.value) / 100)" step="0.001" style="width:80px;background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.1);padding:4px 8px;border-radius:4px;color:#e7e9ea;"></td>' +
          '<td><span class="badge ' + statusClass + '">' + statusText + '</span></td>' +
          '<td>' +
            '<button class="action-btn" style="background:' + toggleColor + ';" onclick="toggleNominal(' + idx + ')">' + toggleText + '</button> ' +
            '<button class="action-btn" style="background:#ef4444;" onclick="deleteNominal(' + idx + ')">Hapus</button>' +
          '</td>' +
        '</tr>';
      }).join('');
    }

    function setPromoRef(idx) {
      // Hanya 1 yang bisa dipilih - clear semua dulu, lalu set yang dipilih
      currentNominals.forEach((nom, i) => {
        nom.promoRef = (i === idx);
      });
    }

    function updateNominal(idx, field, value) {
      if (currentNominals[idx]) {
        currentNominals[idx][field] = value;
      }
    }

    function toggleNominal(idx) {
      if (currentNominals[idx]) {
        currentNominals[idx].active = !currentNominals[idx].active;
        renderNominalTable();
      }
    }

    async function deleteNominal(idx) {
      const nom = currentNominals[idx];
      const confirmed = await showConfirm('Hapus nominal "' + nom.label + '"?', { title: 'Hapus Nominal', type: 'danger' });
      if (!confirmed) return;

      currentNominals.splice(idx, 1);
      renderNominalTable();
    }

    function addNominal() {
      const id = document.getElementById('newNominalId').value.trim();
      const label = document.getElementById('newNominalLabel').value.trim();
      const amount = parseFloat(document.getElementById('newNominalAmount').value);
      const discountRate = parseFloat(document.getElementById('newNominalDiscount').value) / 100;

      if (!id || !label || !amount || isNaN(discountRate)) {
        showAlert('Semua field harus diisi dengan benar!', 'danger');
        return;
      }

      if (currentNominals.find(n => n.id === id)) {
        showAlert('ID nominal sudah ada!', 'danger');
        return;
      }

      currentNominals.push({
        id: id,
        label: label,
        amount: amount,
        discountRate: discountRate,
        active: true
      });

      // Clear inputs
      document.getElementById('newNominalId').value = '';
      document.getElementById('newNominalLabel').value = '';
      document.getElementById('newNominalAmount').value = '';
      document.getElementById('newNominalDiscount').value = '';

      renderNominalTable();
      showAlert('Nominal ditambahkan. Klik "Simpan Perubahan" untuk menyimpan.', 'success');
    }

    function saveNominals() {
      const result = document.getElementById('nominalResult');
      result.className = 'result-msg success';
      result.textContent = 'Menyimpan...';

      const config = {
        nominals: currentNominals
      };

      adminFetch('/api/admin/nominal-settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ config: config })
      })
      .then(r => r.json())
      .then(data => {
        if (data.success) {
          result.className = 'result-msg success';
          result.textContent = 'Nominal berhasil disimpan!';
        } else {
          result.className = 'result-msg error';
          result.textContent = 'Gagal: ' + data.error;
        }
        setTimeout(() => result.className = 'result-msg', 5000);
      })
      .catch(e => {
        result.className = 'result-msg error';
        result.textContent = 'Error: ' + e.message;
      });
    }

    // Load nominals on page load
    loadNominals();

    // ==================== Admin Logs ====================
    let logsAutoRefreshTimer = null;

    function logLineColor(line) {
      if (line.includes('ERROR') || line.includes('❌') || line.includes('Failed') || line.includes('error')) return '#ef4444';
      if (line.includes('✅') || line.includes('Connected') || line.includes('ready') || line.includes('OK')) return '#00ff88';
      if (line.includes('⚠️') || line.includes('WARN') || line.includes('Reconnect')) return '#f7931a';
      if (line.includes('SEND |') || line.includes('Broadcast')) return '#60a5fa';
      if (line.includes('WA |')) return '#a78bfa';
      return '#9ca3af';
    }

    function appendLog(line) {
      const container = document.getElementById('logsContainer');
      if (!container) return;
      const wasAtBottom = container.scrollHeight - container.scrollTop <= container.clientHeight + 40;
      const div = document.createElement('div');
      div.style.cssText = 'color:' + logLineColor(line) + ';padding:2px 0;border-bottom:1px solid rgba(255,255,255,0.04);';
      div.textContent = line;
      container.insertBefore(div, container.firstChild);
      // Batas 200 entri
      while (container.children.length > 200) container.removeChild(container.lastChild);
      if (wasAtBottom) container.scrollTop = 0;
    }

    function loadAdminLogs() {
      adminFetch('/api/admin/logs?limit=100')
        .then(r => r.json())
        .then(data => {
          if (!data.success) return;
          const container = document.getElementById('logsContainer');
          container.innerHTML = data.logs.slice().reverse().map(line => {
            return '<div style="color:' + logLineColor(line) + ';padding:2px 0;border-bottom:1px solid rgba(255,255,255,0.04);">' + line.replace(/</g, '&lt;') + '</div>';
          }).join('');
        })
        .catch(() => {});
    }

    var _loginHistoryData = [];
    var _loginHistoryTimer = null;

    function loadLoginHistory() {
      adminFetch('/api/admin/login-history?limit=300')
        .then(r => r.json())
        .then(data => {
          if (!data.success) return;
          _loginHistoryData = data.items || [];
          const countEl = document.getElementById('loginHistoryCount');
          if (countEl) countEl.textContent = data.total + ' entri (session ini)';
          renderLoginHistoryFiltered();
        })
        .catch(() => {});
    }

    function renderLoginHistoryFiltered() {
      const tbody = document.getElementById('loginHistoryBody');
      if (!tbody) return;
      const phone = (document.getElementById('filterLoginPhone') || {}).value || '';
      const date = (document.getElementById('filterLoginDate') || {}).value || '';
      const name = (document.getElementById('filterLoginName') || {}).value || '';
      const loc = (document.getElementById('filterLoginLocation') || {}).value || '';
      const filtered = _loginHistoryData.filter(function(item) {
        if (phone && !(item.phone || '').includes(phone.charAt(0) === '+' ? phone.slice(1) : phone)) return false;
        if (date && !(item.time || '').startsWith(date)) return false;
        if (name && !(item.name || '').toLowerCase().includes(name.toLowerCase())) return false;
        // Filter lokasi: teks bebas, cocok ke kota/provinsi/negara (kolom Lokasi)
        if (loc && !(item.location || '').toLowerCase().includes(loc.toLowerCase())) return false;
        return true;
      });
      if (filtered.length === 0) {
        tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;padding:20px;color:#6b7280;">Tidak ada data yang cocok</td></tr>';
        return;
      }
      tbody.innerHTML = filtered.map(function(item) {
        var isKicked = item.event === 'kicked';
        var badge = isKicked
          ? '<span style="background:rgba(239,68,68,0.15);color:#f87171;border:1px solid rgba(239,68,68,0.3);padding:1px 7px;border-radius:6px;font-size:0.78em;font-weight:600;margin-left:6px;">DITENDANG</span>'
          : '<span style="background:rgba(34,197,94,0.12);color:#4ade80;border:1px solid rgba(34,197,94,0.25);padding:1px 7px;border-radius:6px;font-size:0.78em;font-weight:600;margin-left:6px;">LOGIN</span>';
        var ipText = (item.ip && item.ip !== '-') ? item.ip : '<span style="color:#4b5563;">-</span>';
        var uaText = (item.ua && item.ua !== '-') ? item.ua : '<span style="color:#4b5563;">-</span>';
        var locText = (item.location && item.location !== '-') ? item.location : '<span style="color:#4b5563;">-</span>';
        return '<tr style="border-bottom:1px solid rgba(255,255,255,0.04);">' +
          '<td style="padding:8px 10px;color:#9ca3af;font-size:0.9em;font-family:monospace;white-space:nowrap;">' + (item.time || '-') + '</td>' +
          '<td style="padding:8px 10px;font-family:monospace;font-weight:600;color:' + (isKicked ? '#f87171' : '#60a5fa') + ';white-space:nowrap;">+' + (item.phone || '-') + badge + '</td>' +
          '<td style="padding:8px 10px;color:#e6edf3;">' + (item.name || '-') + '</td>' +
          '<td style="padding:8px 10px;color:#9ca3af;font-family:monospace;font-size:0.85em;">' + ipText + '</td>' +
          '<td style="padding:8px 10px;color:#c9d1d9;font-size:0.85em;">' + uaText + '</td>' +
          '<td style="padding:8px 10px;color:#86efac;font-size:0.85em;">' + locText + '</td>' +
          '</tr>';
      }).join('');
    }

    function clearLoginFilters() {
      var f = document.getElementById('filterLoginPhone'); if (f) f.value = '';
      var d = document.getElementById('filterLoginDate'); if (d) d.value = '';
      var n = document.getElementById('filterLoginName'); if (n) n.value = '';
      var l = document.getElementById('filterLoginLocation'); if (l) l.value = '';
      renderLoginHistoryFiltered();
    }

    function toggleLogsAutoRefresh() {
      const enabled = document.getElementById('logsAutoRefresh').checked;
      clearInterval(logsAutoRefreshTimer);
      if (enabled) {
        logsAutoRefreshTimer = setInterval(loadAdminLogs, 5000);
      }
    }

    // ==================== WhatsApp Status & Reset ====================
    function loadWaStatus() {
      adminFetch('/api/admin/wa-status')
        .then(r => r.json())
        .then(data => {
          if (!data.success) return;
          const dot = document.getElementById('waStatusDot');
          const text = document.getElementById('waStatusText');
          const phone = document.getElementById('waStatusPhone');
          if (data.connected) {
            dot.style.background = '#00ff88';
            dot.style.boxShadow = '0 0 8px #00ff88';
            text.textContent = '✅ Terhubung';
            text.style.color = '#00ff88';
            phone.textContent = data.phone ? 'Nomor: ' + data.phone : '';
          } else if (data.hasQr) {
            dot.style.background = '#f7931a';
            dot.style.boxShadow = '0 0 8px #f7931a';
            text.textContent = '📷 Menunggu scan QR';
            text.style.color = '#f7931a';
            phone.textContent = 'Buka halaman QR untuk scan';
          } else {
            dot.style.background = '#ef4444';
            dot.style.boxShadow = 'none';
            text.textContent = '❌ Tidak terhubung';
            text.style.color = '#ef4444';
            phone.textContent = 'Klik "Lihat QR" untuk menghubungkan';
          }
        })
        .catch(() => {});
    }

    async function resetWaConnection() {
      const confirmed = await showConfirm(
        'Ini akan logout dari WhatsApp saat ini dan memerlukan scan QR ulang untuk menghubungkan nomor baru.\\n\\nLanjutkan?',
        { title: '⚠️ Reset Koneksi WhatsApp', type: 'warning' }
      );
      if (!confirmed) return;

      const result = document.getElementById('waResetResult');
      result.className = 'result-msg success';
      result.textContent = 'Mereset koneksi WA...';

      adminFetch('/api/admin/wa-reset', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({})
      })
      .then(r => r.json())
      .then(data => {
        if (data.success) {
          result.className = 'result-msg success';
          result.textContent = '✅ ' + data.message;
          setTimeout(() => loadWaStatus(), 3000);
        } else {
          result.className = 'result-msg error';
          result.textContent = 'Error: ' + data.error;
        }
        setTimeout(() => result.className = 'result-msg', 8000);
      });
    }

    // Load WA status saat tab whatsapp dibuka
    loadWaStatus();

    // ==================== WhatsApp Group Functions ====================
    function loadWaGroups() {
      const select = document.getElementById('waGroupSelect');
      const broadcastSelect = document.getElementById('waBroadcastGroupSelect');
      select.innerHTML = '<option value="">Memuat grup...</option>';
      broadcastSelect.innerHTML = '<option value="">Memuat grup...</option>';

      adminFetch('/api/admin/wa-groups')
        .then(r => r.json())
        .then(data => {
          if (!data.success) {
            select.innerHTML = '<option value="">Error: ' + (data.error || 'Unknown') + '</option>';
            broadcastSelect.innerHTML = '<option value="">Error: ' + (data.error || 'Unknown') + '</option>';
            return;
          }

          select.innerHTML = '<option value="">-- Pilih Grup (' + data.groups.length + ' grup) --</option>';
          broadcastSelect.innerHTML = '<option value="">-- Kosongkan untuk nonaktifkan --</option>';

          data.groups.forEach(g => {
            // Monitor select
            const opt = document.createElement('option');
            opt.value = g.id;
            opt.textContent = g.name + ' (' + g.participants + ' member)' + (g.isMonitored ? ' [MONITOR]' : '');
            if (g.isMonitored) opt.selected = true;
            select.appendChild(opt);

            // Broadcast select
            const opt2 = document.createElement('option');
            opt2.value = g.id;
            opt2.textContent = g.name + ' (' + g.participants + ' member)' + (g.isBroadcast ? ' [BROADCAST AKTIF]' : '');
            if (g.isBroadcast) opt2.selected = true;
            broadcastSelect.appendChild(opt2);
          });

          // Show current monitor group
          if (data.currentGroupId) {
            const current = data.groups.find(g => g.id === data.currentGroupId);
            if (current) {
              document.getElementById('currentGroup').innerHTML = 'Grup monitor aktif: <strong style="color:#00ff88;">' + current.name + '</strong>';
            }
          } else {
            document.getElementById('currentGroup').textContent = 'Belum ada grup monitor yang dipilih';
          }

          // Show current broadcast group
          if (data.broadcastGroupId) {
            const bcast = data.groups.find(g => g.id === data.broadcastGroupId);
            if (bcast) {
              document.getElementById('currentBroadcastGroup').innerHTML = '📢 Broadcast aktif ke: <strong style="color:#00ff88;">' + bcast.name + '</strong>';
            } else {
              document.getElementById('currentBroadcastGroup').innerHTML = '📢 Broadcast aktif: <strong style="color:#f7931a;">' + data.broadcastGroupId.substring(0, 20) + '...</strong>';
            }
          } else {
            document.getElementById('currentBroadcastGroup').textContent = 'Broadcast grup belum di-set (tidak ada broadcast ke grup WA)';
          }
        })
        .catch(e => {
          select.innerHTML = '<option value="">Error loading groups</option>';
          broadcastSelect.innerHTML = '<option value="">Error loading groups</option>';
        });
    }

    function setWaGroup() {
      const groupId = document.getElementById('waGroupSelect').value;
      const result = document.getElementById('syncResult');

      if (!groupId) {
        showAlert('Pilih grup terlebih dahulu', 'warning');
        return;
      }

      adminFetch('/api/admin/wa-groups/set', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ groupId })
      })
      .then(r => r.json())
      .then(data => {
        if (data.success) {
          result.className = 'result-msg success';
          result.textContent = 'Grup monitor berhasil di-set! Member baru yang masuk akan otomatis terdaftar.';
          loadWaGroups();
        } else {
          result.className = 'result-msg error';
          result.textContent = 'Error: ' + data.error;
        }
        setTimeout(() => result.className = 'result-msg', 5000);
      });
    }

    function setBroadcastGroup() {
      const groupId = document.getElementById('waBroadcastGroupSelect').value;
      const result = document.getElementById('syncResult');

      adminFetch('/api/admin/wa-groups/set-broadcast', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ groupId: groupId || null })
      })
      .then(r => r.json())
      .then(data => {
        if (data.success) {
          result.className = 'result-msg success';
          result.textContent = groupId
            ? '📢 Grup broadcast berhasil di-set! Harga akan otomatis dikirim ke grup ini.'
            : '📢 Broadcast grup dinonaktifkan.';
          loadWaGroups();
        } else {
          result.className = 'result-msg error';
          result.textContent = 'Error: ' + data.error;
        }
        setTimeout(() => result.className = 'result-msg', 5000);
      });
    }

    function syncMembers() {
      const result = document.getElementById('syncResult');
      result.className = 'result-msg success';
      result.textContent = 'Menyinkronkan member...';

      adminFetch('/api/admin/wa-groups/sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ })
      })
      .then(r => r.json())
      .then(data => {
        if (data.success) {
          result.className = 'result-msg success';
          result.textContent = 'Sync selesai! ' + data.added + ' user baru ditambahkan, ' + data.skipped + ' sudah ada. Total: ' + data.total + ' member.';
          loadUsers();
        } else {
          result.className = 'result-msg error';
          result.textContent = 'Error: ' + data.error;
        }
        setTimeout(() => result.className = 'result-msg', 5000);
      });
    }

    async function clearInvalidUsers() {
      const confirmed = await showConfirm('Hapus semua user dengan nomor invalid (bukan format Indonesia 08xx)?', { title: 'Hapus User Invalid', type: 'warning' });
      if (!confirmed) return;

      const result = document.getElementById('syncResult');
      result.className = 'result-msg success';
      result.textContent = 'Menghapus user invalid...';

      adminFetch('/api/admin/users/clear-invalid', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ })
      })
      .then(r => r.json())
      .then(data => {
        if (data.success) {
          result.className = 'result-msg success';
          result.textContent = 'Berhasil menghapus ' + data.deleted + ' user invalid.';
          loadUsers();
        } else {
          result.className = 'result-msg error';
          result.textContent = 'Error: ' + data.error;
        }
        setTimeout(() => result.className = 'result-msg', 5000);
      });
    }

    async function clearAllUsers() {
      const confirmed1 = await showConfirm('HAPUS SEMUA USER? Aksi ini tidak dapat dibatalkan!', { title: 'Peringatan', type: 'danger', confirmText: 'Lanjutkan' });
      if (!confirmed1) return;
      const confirmed2 = await showConfirm('Konfirmasi sekali lagi untuk HAPUS SEMUA USER', { title: 'Konfirmasi Final', type: 'danger', confirmText: 'Hapus Semua' });
      if (!confirmed2) return;

      const result = document.getElementById('syncResult');
      result.className = 'result-msg success';
      result.textContent = 'Menghapus semua user...';

      adminFetch('/api/admin/users/clear-all', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirm: 'DELETE_ALL' })
      })
      .then(r => r.json())
      .then(data => {
        if (data.success) {
          result.className = 'result-msg success';
          result.textContent = 'Semua user berhasil dihapus.';
          loadUsers();
        } else {
          result.className = 'result-msg error';
          result.textContent = 'Error: ' + data.error;
        }
        setTimeout(() => result.className = 'result-msg', 5000);
      });
    }

    async function forceLogoutAll() {
      const confirmed = await showConfirm('Force logout semua user? Semua user akan diminta login ulang.', { title: 'Force Logout', type: 'warning' });
      if (!confirmed) return;

      const result = document.getElementById('syncResult');
      result.className = 'result-msg success';
      result.textContent = 'Memproses force logout...';

      adminFetch('/api/admin/force-logout-all', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ })
      })
      .then(r => r.json())
      .then(data => {
        if (data.success) {
          result.className = 'result-msg success';
          result.textContent = 'Semua user berhasil di-logout. Mereka harus login ulang.';
        } else {
          result.className = 'result-msg error';
          result.textContent = 'Error: ' + data.error;
        }
        setTimeout(() => result.className = 'result-msg', 5000);
      });
    }


    // Load pending registrations
    function loadPendingRegistrations() {
      adminFetch('/api/pending-registrations')
        .then(r => r.json())
        .then(data => {
          const list = data.registrations || [];
          const tbody = document.getElementById('pendingList');
          const countEl = document.getElementById('pendingCount');
          const badgeEl = document.getElementById('pendingBadge');

          countEl.textContent = list.length;
          badgeEl.textContent = list.length;
          badgeEl.style.display = list.length > 0 ? 'inline' : 'none';

          if (list.length === 0) {
            tbody.innerHTML = '<tr><td colspan="4" class="empty-state">Tidak ada pendaftaran baru</td></tr>';
            return;
          }

          tbody.innerHTML = list.map(r => {
            const time = new Date(r.timestamp).toLocaleString('id-ID');
            return '<tr style="background:rgba(247,147,26,0.08);">' +
              '<td>' + time + '</td>' +
              '<td><strong>' + r.name + '</strong></td>' +
              '<td class="phone">+' + r.phone + '</td>' +
              '<td>' +
                '<div class="action-btns">' +
                  '<button class="action-btn unblock btn-approve" data-phone="' + r.phone + '">ACC</button>' +
                  '<button class="action-btn delete btn-reject" data-phone="' + r.phone + '">Tolak</button>' +
                '</div>' +
              '</td>' +
            '</tr>';
          }).join('');

          // Add click handlers
          tbody.querySelectorAll('.btn-approve').forEach(function(btn) {
            btn.addEventListener('click', function() { approveRegistration(this.dataset.phone); });
          });
          tbody.querySelectorAll('.btn-reject').forEach(function(btn) {
            btn.addEventListener('click', function() { rejectRegistration(this.dataset.phone); });
          });
        });
    }

    async function approveRegistration(phone) {
      const confirmed = await showConfirm('Setujui pendaftaran ini?', { title: 'Setujui Pendaftaran', type: 'info', confirmText: 'Setujui' });
      if (!confirmed) return;

      adminFetch('/api/approve-registration', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone })
      })
      .then(r => r.json())
      .then(data => {
        showAlert(data.message, 'success');
        loadPendingRegistrations();
        loadUsers();
      });
    }

    async function rejectRegistration(phone) {
      const confirmed = await showConfirm('Tolak pendaftaran ini?', { title: 'Tolak Pendaftaran', type: 'warning', confirmText: 'Tolak' });
      if (!confirmed) return;

      adminFetch('/api/reject-registration', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone, reason: '' })
      })
      .then(r => r.json())
      .then(data => {
        showAlert(data.message, 'success');
        loadPendingRegistrations();
      });
    }

    function loadUsers() {
      adminFetch('/api/admin/users')
        .then(r => r.json())
        .then(data => {
          if (!data.success) return;

          const users = data.users;
          const now = Date.now();

          let total = users.length;
          let active = users.filter(u => !u.expired || u.expired > now).length;
          let push = users.filter(u => u.hasPushSubscription).length;
          let pinChanged = users.filter(u => u.pinChanged).length;

          document.getElementById('totalUsers').textContent = total;
          document.getElementById('activeUsers').textContent = active;
          document.getElementById('pushUsers').textContent = push;
          document.getElementById('pinChangedUsers').textContent = pinChanged;

          const tbody = document.getElementById('userList');
          if (users.length === 0) {
            tbody.innerHTML = '<tr><td colspan="7" class="empty-state">Belum ada user</td></tr>';
            return;
          }

          tbody.innerHTML = users.map(u => {
            let status, statusClass;
            if (u.isBlocked) {
              status = 'Blocked';
              statusClass = 'status-blocked';
            } else if (!u.expired) {
              status = 'Lifetime';
              statusClass = 'status-lifetime';
            } else if (u.expired > now) {
              status = 'Aktif';
              statusClass = 'status-active';
            } else {
              status = 'Expired';
              statusClass = 'status-expired';
            }

            const expDate = u.expired ? new Date(u.expired).toLocaleDateString('id-ID') : '-';
            const pinStatus = u.pinChanged
              ? '<span class="pin-badge pin-changed">Changed</span>'
              : '<span class="pin-badge pin-default">Default</span>';
            const blockBtn = u.isBlocked
              ? '<button class="action-btn unblock" onclick="unblockUser(&apos;' + u.phone + '&apos;)">Unblock</button>'
              : '<button class="action-btn block" onclick="blockUser(&apos;' + u.phone + '&apos;)">Block</button>';

            return '<tr' + (u.isBlocked ? ' style="opacity:0.6;background:rgba(255,82,82,0.05);"' : '') + '>' +
              '<td class="phone">+' + u.phone + '</td>' +
              '<td>' + (u.name || '-') + '</td>' +
              '<td><span class="status-badge ' + statusClass + '">' + status + '</span></td>' +
              '<td><span class="push-badge ' + (u.hasPushSubscription ? 'push-yes' : 'push-no') + '"></span></td>' +
              '<td>' + pinStatus + '</td>' +
              '<td>' + expDate + '</td>' +
              '<td>' +
                '<div class="action-btns">' +
                  '<button class="action-btn edit" data-phone="' + u.phone + '" data-name="' + (u.name||'').replace(/&/g,'&amp;').replace(/"/g,'&quot;') + '" onclick="editUserBtn(this)">Edit</button>' +
                  '<button class="action-btn push" onclick="openPushModal(&apos;' + u.phone + '&apos;)">Push</button>' +
                  '<button class="action-btn pin" onclick="resetPin(&apos;' + u.phone + '&apos;)">Reset PIN</button>' +
                  blockBtn +
                  '<button class="action-btn delete" onclick="deleteUser(&apos;' + u.phone + '&apos;)">Hapus</button>' +
                  '<button class="action-btn kick" onclick="kickUser(&apos;' + u.phone + '&apos;)">Kick</button>' +
                '</div>' +
              '</td>' +
            '</tr>';
          }).join('');
        });
    }

    // Reset PIN user ke default (000000)
    async function resetPin(phone) {
      const confirmed = await showConfirm('Reset PIN user +62' + phone + ' ke default (000000)?', { title: 'Reset PIN', type: 'warning' });
      if (!confirmed) return;

      adminFetch('/api/admin/reset-pin', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone })
      })
      .then(r => r.json())
      .then(data => {
        if (data.success) {
          showAlert('PIN berhasil direset ke 000000', 'success');
          loadUsers();
        } else {
          showAlert('Error: ' + data.error, 'danger');
        }
      });
    }

    function addUser() {
      const phone = document.getElementById('newPhone').value.trim();
      const name = document.getElementById('newName').value.trim();
      const expiredDate = document.getElementById('newExpiredDate').value;
      const result = document.getElementById('addResult');

      if (!phone) { showAlert('Nomor WA wajib diisi', 'warning'); return; }

      const bodyData = {

        phone,
        name
      };

      // If date is set, convert to timestamp
      if (expiredDate) {
        bodyData.expiredTimestamp = new Date(expiredDate + 'T23:59:59').getTime();
      }

      adminFetch('/api/admin/users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(bodyData)
      })
      .then(r => r.json())
      .then(data => {
        if (data.success) {
          result.className = 'result-msg success';
          result.textContent = 'User berhasil ditambahkan!';
          document.getElementById('newPhone').value = '';
          document.getElementById('newName').value = '';
          document.getElementById('newExpiredDate').value = '';
          loadUsers();
        } else {
          result.className = 'result-msg error';
          result.textContent = data.error;
        }
        setTimeout(() => result.className = 'result-msg', 3000);
      });
    }

    function bulkImport() {
      const text = document.getElementById('bulkPhones').value.trim();
      const result = document.getElementById('bulkResult');

      if (!text) { showAlert('Masukkan daftar nomor', 'warning'); return; }

      // Coba ekstrak nomor format WhatsApp (+62 XXX-XXXX-XXXX)
      const waMatches = text.match(/\\+62[\\d\\s\\-]+/g);
      let phones;
      if (waMatches && waMatches.length > 0) {
        // Format WhatsApp: strip spasi dan tanda hubung
        phones = waMatches.map(p => p.replace(/[\\s\\-]/g, '').trim()).filter(p => p.length >= 10);
      } else {
        // Format biasa: satu per baris atau pisah koma
        phones = text.split(/[\\n,]+/).map(p => p.trim()).filter(p => p.length >= 8);
      }

      if (phones.length === 0) { showAlert('Tidak ada nomor valid', 'warning'); return; }

      result.className = 'result-msg success';
      result.textContent = 'Mengimport ' + phones.length + ' nomor...';

      adminFetch('/api/admin/users/bulk', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phones })
      })
      .then(r => r.json())
      .then(data => {
        if (data.success) {
          result.className = 'result-msg success';
          result.textContent = 'Import selesai! ' + data.added + ' ditambahkan, ' + data.skipped + ' dilewati.';
          document.getElementById('bulkPhones').value = '';
          loadUsers();
        } else {
          result.className = 'result-msg error';
          result.textContent = 'Error: ' + data.error;
        }
        setTimeout(() => result.className = 'result-msg', 5000);
      });
    }

    // Preview jumlah nomor saat paste/input
    document.addEventListener('DOMContentLoaded', () => {
      const ta = document.getElementById('bulkPhones');
      const preview = document.getElementById('bulkPreview');
      if (ta && preview) {
        ta.addEventListener('input', () => {
          const text = ta.value.trim();
          if (!text) { preview.style.display = 'none'; return; }
          const waMatches = text.match(/\\+62[\\d\\s\\-]+/g);
          let count;
          if (waMatches && waMatches.length > 0) {
            count = waMatches.filter(p => p.replace(/[\\s\\-]/g, '').length >= 10).length;
            preview.textContent = 'Terdeteksi ' + count + ' nomor dari format WhatsApp';
          } else {
            count = text.split(/[\\n,]+/).filter(p => p.trim().length >= 8).length;
            preview.textContent = 'Terdeteksi ' + count + ' nomor';
          }
          preview.style.display = count > 0 ? 'block' : 'none';
        });
      }
    });

    function editUserBtn(btn) {
      editUser(btn.getAttribute('data-phone'), btn.getAttribute('data-name'));
    }

    function editUser(phone, name, expired) {
      document.getElementById('editPhone').value = phone;
      document.getElementById('editName').value = name;
      document.getElementById('editAddDays').value = '';
      // Set expired date if exists
      if (expired && expired !== 'Lifetime') {
        // Parse from timestamp or date string
        const expDate = new Date(expired);
        if (!isNaN(expDate.getTime())) {
          document.getElementById('editExpiredDate').value = expDate.toISOString().split('T')[0];
        } else {
          document.getElementById('editExpiredDate').value = '';
        }
      } else {
        document.getElementById('editExpiredDate').value = '';
      }
      document.getElementById('editModal').classList.add('show');
    }

    function closeModal() {
      document.getElementById('editModal').classList.remove('show');
    }

    function saveUser() {
      const phone = document.getElementById('editPhone').value;
      const name = document.getElementById('editName').value;
      const addDays = document.getElementById('editAddDays').value;
      const expiredDate = document.getElementById('editExpiredDate').value;

      const bodyData = {

        phone,
        name
      };

      // If date is set, use it
      if (expiredDate) {
        bodyData.expiredTimestamp = new Date(expiredDate + 'T23:59:59').getTime();
      } else if (addDays) {
        bodyData.addDays = parseInt(addDays);
      }

      adminFetch('/api/admin/users', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(bodyData)
      })
      .then(r => r.json())
      .then(data => {
        if (data.success) {
          closeModal();
          loadUsers();
          showAlert('User berhasil diupdate!', 'success');
        } else {
          showAlert(data.error || 'Gagal update user', 'danger');
        }
      });
    }

    async function deleteUser(phone) {
      const confirmed = await showConfirm('Hapus user +62' + phone + '?', { title: 'Hapus User', type: 'danger', confirmText: 'Hapus' });
      if (!confirmed) return;

      adminFetch('/api/admin/users', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone })
      })
      .then(r => r.json())
      .then(data => {
        if (data.success) loadUsers();
        else showAlert(data.error, 'danger');
      });
    }

    async function blockUser(phone) {
      const confirmed = await showConfirm('Blokir user +62' + phone + '? User tidak bisa login sampai di-unblock.', { title: 'Blokir User', type: 'danger', confirmText: 'Blokir' });
      if (!confirmed) return;

      adminFetch('/api/admin/users/block', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone })
      })
      .then(r => r.json())
      .then(data => {
        if (data.success) {
          showAlert('User berhasil diblokir', 'success');
          loadUsers();
        } else {
          showAlert(data.error, 'danger');
        }
      });
    }

    async function unblockUser(phone) {
      const confirmed = await showConfirm('Buka blokir user +62' + phone + '?', { title: 'Unblock User', type: 'info', confirmText: 'Unblock' });
      if (!confirmed) return;

      adminFetch('/api/admin/users/unblock', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone })
      })
      .then(r => r.json())
      .then(data => {
        if (data.success) {
          showAlert('User berhasil di-unblock', 'success');
          loadUsers();
        } else {
          showAlert(data.error, 'danger');
        }
      });
    }

    async function kickUser(phone) {
      const confirmed = await showConfirm('KICK +62' + phone + ' dari grup WhatsApp? User akan di-kick dari grup DAN dihapus dari database!', { title: 'Kick User', type: 'danger', confirmText: 'Kick' });
      if (!confirmed) return;

      const result = document.getElementById('syncResult');
      result.className = 'result-msg success';
      result.textContent = 'Mengeluarkan user dari grup...';

      adminFetch('/api/admin/users/kick', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone })
      })
      .then(r => r.json())
      .then(data => {
        if (data.success) {
          result.className = 'result-msg success';
          result.textContent = data.message;
          loadUsers();
        } else {
          result.className = 'result-msg error';
          result.textContent = 'Error: ' + data.error;
        }
        setTimeout(() => result.className = 'result-msg', 5000);
      });
    }

    function openPushModal(phone) {
      document.getElementById('pushPhone').value = phone || '';
      document.getElementById('pushTitle').value = '';
      document.getElementById('pushMessage').value = '';
      document.getElementById('pushModal').classList.add('show');
    }

    function closePushModal() {
      document.getElementById('pushModal').classList.remove('show');
    }

    function sendPush() {
      const phone = document.getElementById('pushPhone').value;
      const type = document.getElementById('pushType').value;
      const title = document.getElementById('pushTitle').value;
      const message = document.getElementById('pushMessage').value;

      if (!title || !message) { showAlert('Judul dan pesan wajib diisi', 'warning'); return; }

      adminFetch('/api/admin/push', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone: phone || null, type, title, message })
      })
      .then(r => r.json())
      .then(data => {
        if (data.success) {
          showAlert('Notifikasi terkirim ke ' + data.sent + ' user', 'success');
          closePushModal();
        } else {
          showAlert(data.error, 'danger');
        }
      });
    }

    // ==================== Broadcast Section ====================
    let currentBcastType = 'info';

    function selectBcastType(btn) {
      document.querySelectorAll('.bcast-type-btn').forEach(b => b.classList.remove('active-type'));
      btn.classList.add('active-type');
      currentBcastType = btn.getAttribute('data-type');
    }

    function sendBroadcast() {
      const title = document.getElementById('bcastTitle').value.trim();
      const message = document.getElementById('bcastMessage').value.trim();
      const result = document.getElementById('bcastResult');

      if (!title || !message) { showAlert('Judul dan pesan wajib diisi', 'warning'); return; }

      result.className = 'result-msg success';
      result.textContent = 'Mengirim...';

      adminFetch('/api/admin/push', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: currentBcastType, title, message })
      })
      .then(r => r.json())
      .then(data => {
        if (data.success) {
          result.className = 'result-msg success';
          result.textContent = 'Terkirim ke ' + data.sent + ' user!';
          document.getElementById('bcastTitle').value = '';
          document.getElementById('bcastMessage').value = '';
          loadBroadcastHistory();
        } else {
          result.className = 'result-msg error';
          result.textContent = 'Error: ' + data.error;
        }
        setTimeout(() => { result.className = 'result-msg'; }, 5000);
      });
    }

    function loadBroadcastHistory() {
      adminFetch('/api/admin/notif-history')
        .then(r => r.json())
        .then(data => {
          if (!data.success) return;
          const history = data.history || [];

          // Sent today - hitung dari history
          const today = new Date().toDateString();
          const sentToday = history.filter(n => new Date(n.sentAt).toDateString() === today).length;
          const sentEl = document.getElementById('bcastSentToday');
          if (sentEl) sentEl.textContent = sentToday;

          // Online count - sinkronkan dari onlineBadge yang sudah diupdate SSE
          const bcastOnlineEl = document.getElementById('bcastOnline');
          const badgeEl = document.getElementById('onlineBadge');
          if (bcastOnlineEl && badgeEl) bcastOnlineEl.textContent = badgeEl.textContent;

          renderBcastHistory(history);
        })
        .catch(() => {});
    }

    function renderBcastHistory(history) {
      const container = document.getElementById('bcastHistory');
      if (!container) return;

      if (!history || history.length === 0) {
        container.innerHTML = '<div style="text-align:center;color:#6b7280;padding:20px;">Belum ada notifikasi dikirim</div>';
        return;
      }

      const typeIcons = {
        info: '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>',
        promo: '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z"/><line x1="7" y1="7" x2="7.01" y2="7"/></svg>',
        warning: '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>',
        urgent: '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>'
      };
      const typeColors = { info: '#60a5fa', promo: '#4ade80', warning: '#facc15', urgent: '#f87171' };

      container.innerHTML = history.map(n => {
        const d = new Date(n.sentAt);
        const dateStr = d.toLocaleDateString('id-ID', { day:'2-digit', month:'short', year:'numeric' });
        const timeStr = d.toTimeString().substring(0, 5);
        const color = typeColors[n.type] || '#60a5fa';
        const icon = typeIcons[n.type] || typeIcons.info;
        return '<div style="border:1px solid rgba(255,255,255,0.07);border-radius:10px;padding:12px 14px;margin-bottom:10px;background:rgba(255,255,255,0.03);">' +
          '<div style="display:flex;align-items:flex-start;justify-content:space-between;gap:8px;">' +
            '<div style="flex:1;min-width:0;">' +
              '<div style="display:flex;align-items:center;gap:6px;margin-bottom:4px;">' +
                '<span style="font-size:0.78em;background:rgba(255,255,255,0.07);color:' + color + ';padding:2px 8px;border-radius:6px;display:inline-flex;align-items:center;gap:4px;">' + icon + ' ' + n.type.toUpperCase() + '</span>' +
                '<span style="font-size:0.75em;color:#6b7280;">' + dateStr + ' ' + timeStr + '</span>' +
              '</div>' +
              '<div style="font-weight:600;color:#e7e9ea;font-size:0.9em;margin-bottom:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + n.title + '</div>' +
              '<div style="font-size:0.82em;color:#8b949e;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + n.message + '</div>' +
              '<div style="font-size:0.75em;color:#6b7280;margin-top:4px;">Terkirim: ' + (n.sent || 0) + ' user' + (n.failed ? ' · Gagal: ' + n.failed : '') + '</div>' +
            '</div>' +
            '<button onclick="deleteNotifHistory(&apos;' + n.id + '&apos;)" style="background:rgba(239,68,68,0.15);border:1px solid rgba(239,68,68,0.3);color:#f87171;padding:4px 10px;border-radius:6px;cursor:pointer;font-size:0.78em;white-space:nowrap;flex-shrink:0;">Hapus</button>' +
          '</div>' +
        '</div>';
      }).join('');
    }

    async function deleteNotifHistory(id) {
      const ok = await showConfirm('Hapus notifikasi ini dari riwayat?', { title: 'Hapus Riwayat', type: 'danger' });
      if (!ok) return;
      adminFetch('/api/admin/notif-history/' + id, { method: 'DELETE' })
        .then(r => r.json())
        .then(data => { if (data.success) loadBroadcastHistory(); });
    }

    async function clearAllNotifHistory() {
      const ok = await showConfirm('Hapus semua riwayat notifikasi?', { title: 'Hapus Semua', type: 'danger' });
      if (!ok) return;
      adminFetch('/api/admin/notif-history', { method: 'DELETE' })
        .then(r => r.json())
        .then(data => { if (data.success) loadBroadcastHistory(); });
    }
  </script>
</body>
</html>`;
  res.send(html);
})

// MONITORING PAGE - Professional Gold Price Dashboard
app.get('/monitoring', async (_req, res) => {
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate')
  res.setHeader('Pragma', 'no-cache')
  res.setHeader('Pragma', 'no-cache')
  res.setHeader('Expires', '0')
  const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="theme-color" content="#000000">
  <meta name="mobile-web-app-capable" content="yes">
  <meta name="apple-mobile-web-app-capable" content="yes">
  <meta name="apple-mobile-web-app-title" content="Treasury Price">
  <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
  <link rel="manifest" href="/manifest.json">
  <link rel="apple-touch-icon" href="/icon.png">
  <link rel="icon" type="image/x-icon" href="/favicon.ico">
  <link rel="icon" type="image/png" href="/icon.png">
  <style>body,*{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;-webkit-font-smoothing:antialiased;-moz-osx-font-smoothing:grayscale;font-synthesis:none;}code,pre,.mono{font-family:'Courier New',Courier,monospace;}</style>
  <script src="/assets/lucide.min.js"></script>
  <title>Gold Price Monitor</title>
  <style>
    /* Lucide icons sizing */
    [data-lucide] { display: inline-flex; vertical-align: middle; flex-shrink: 0; }

    :root {
      --bg-page: #000000;
      --bg-header: rgba(0, 0, 0, 0.97);
      --bg-card: #0a0a0a;
      --bg-card-hover: #141414;
      --bg-input: #1a1a1a;
      --text-primary: #c4d0df;
      --text-secondary: #5e7080;
      --text-heading: #eef3fa;
      --border-color: rgba(247, 147, 26, 0.1);
      --border-hover: rgba(247, 147, 26, 0.28);
      --shadow: 0 4px 32px rgba(0,0,0,0.55), 0 0 0 1px rgba(247,147,26,0.04);
      --gold: #f7931a;
      --green: #0ecb81;
      --red: #f6465d;
      --blue: #3b9eff;
      --header-text: #eef3fa;
      --theme-icon-dark: block;
      --theme-icon-light: none;
    }
    body.light-mode {
      --bg-page: #ffffff;
      --bg-header: #ffffff;
      --bg-card: #ffffff;
      --bg-card-hover: #ffffff;
      --bg-input: #ffffff;
      --text-primary: #222222;
      --text-secondary: #666666;
      --text-heading: #111111;
      --header-text: #111111;
      --border-color: #e0e0e0;
      --border-hover: #cccccc;
      --shadow: 0 2px 8px rgba(0,0,0,0.08);
      --gold: #c2700f;
      --theme-icon-dark: none;
      --theme-icon-light: block;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    /* Custom scrollbar */
    ::-webkit-scrollbar { width: 5px; height: 5px; }
    ::-webkit-scrollbar-track { background: rgba(255,255,255,0.03); border-radius: 10px; }
    ::-webkit-scrollbar-thumb { background: rgba(247,147,26,0.25); border-radius: 10px; }
    ::-webkit-scrollbar-thumb:hover { background: rgba(247,147,26,0.45); }
    * { scrollbar-width: thin; scrollbar-color: rgba(247,147,26,0.25) rgba(255,255,255,0.03); }

    body {
      font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      background: var(--bg-page);
      min-height: 100vh;
      padding: 16px;
      color: var(--text-primary);
      transition: background 0.3s ease, color 0.3s ease;
      position: relative;
      overflow-x: hidden;
    }
    body::before {
      content: '';
      position: fixed;
      top: -20%; left: -10%;
      width: 50vw; height: 50vw;
      background: radial-gradient(circle, rgba(247,147,26,0.06) 0%, transparent 65%);
      pointer-events: none;
      z-index: 0;
    }
    body::after {
      content: '';
      position: fixed;
      bottom: -20%; right: -10%;
      width: 45vw; height: 45vw;
      background: radial-gradient(circle, rgba(96,165,250,0.05) 0%, transparent 65%);
      pointer-events: none;
      z-index: 0;
    }
    .container { max-width: 1400px; width: 100%; margin: 0 auto; position: relative; z-index: 1; }

    /* Header - Glassmorphism */
    .header {
      display: flex;
      align-items: center;
      gap: 8px;
      position: relative;
      margin-bottom: 14px;
      padding: 0 10px;
      height: 46px;
      background: rgba(8, 8, 8, 0.92);
      backdrop-filter: blur(28px);
      -webkit-backdrop-filter: blur(28px);
      border-radius: 4px;
      border: 1px solid rgba(255,255,255,0.07);
      box-shadow: 0 2px 16px rgba(0,0,0,0.25);
      transition: background 0.3s ease, border-color 0.3s ease;
    }
    /* Header Logo (original Treasury gold icon) */
    .header-logo {
      display: flex;
      align-items: center;
      justify-content: center;
      flex-shrink: 0;
      position: relative;
      cursor: pointer;
    }
    /* Header title text (replaces search bar) */
    .header-title-text {
      font-size: 0.85em;
      font-weight: 700;
      color: #e7e9ea;
      letter-spacing: -0.01em;
      white-space: nowrap;
      flex: 1;
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    body.light-mode .header-title-text { color: #111827; }
    /* Nav icon buttons */
    .nav-icon-btn {
      display: flex;
      align-items: center;
      justify-content: center;
      width: 32px;
      height: 32px;
      background: transparent;
      border: none;
      border-radius: 6px;
      cursor: pointer;
      color: #9ca3af;
      transition: background 0.15s, color 0.15s;
      flex-shrink: 0;
      font-family: inherit;
    }
    .nav-icon-btn:hover {
      background: rgba(255,255,255,0.08);
      color: #e7e9ea;
    }
    /* Nav menu dropdown */
    .nav-menu-dropdown {
      position: fixed;
      background: #101010;
      border: 1px solid rgba(255,255,255,0.1);
      border-radius: 12px;
      box-shadow: 0 8px 32px rgba(0,0,0,0.5);
      z-index: 99999;
      min-width: 190px;
      overflow: hidden;
      display: none;
    }
    .nav-menu-dropdown.active { display: block; }
    .nav-menu-item {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 10px 15px;
      color: #d1d5db;
      font-size: 0.83em;
      cursor: pointer;
      border: none;
      background: none;
      width: 100%;
      text-align: left;
      font-family: inherit;
      transition: background 0.12s;
      white-space: nowrap;
    }
    .nav-menu-item:hover { background: rgba(255,255,255,0.06); color: #e7e9ea; }
    .nav-menu-divider { height: 1px; background: rgba(255,255,255,0.07); margin: 3px 0; }
    /* Install App: menonjol + kedip agar ternotice */
    .install-nav { color: #4ade80 !important; font-weight: 700; }
    .install-nav i { color: #4ade80; }
    .install-blink { animation: installBlink 1.3s ease-in-out infinite; }
    @keyframes installBlink {
      0%, 100% { background: rgba(34,197,94,0.10); }
      50% { background: rgba(34,197,94,0.30); }
    }
    body.light-mode .install-nav { color: #15803d !important; }
    body.light-mode .install-nav i { color: #15803d; }
    body.light-mode .install-blink { animation: installBlinkLight 1.3s ease-in-out infinite; }
    @keyframes installBlinkLight {
      0%, 100% { background: rgba(34,197,94,0.12); }
      50% { background: rgba(34,197,94,0.30); }
    }
    /* ── Onboarding tour (pengenalan untuk user baru) ── */
    .tour-overlay { position: fixed; inset: 0; z-index: 100000; display: none; }
    .tour-overlay.active { display: block; }
    .tour-spot {
      position: absolute; border-radius: 12px; pointer-events: none;
      box-shadow: 0 0 0 4px rgba(247,147,26,0.9), 0 0 0 9999px rgba(0,0,0,0.72);
      transition: all 0.28s cubic-bezier(.4,.0,.2,1);
    }
    .tour-tip {
      position: fixed; z-index: 100001; width: min(300px, calc(100vw - 32px));
      background: #121212; border: 1px solid rgba(255,255,255,0.12);
      border-top: 2px solid #f7931a; border-radius: 14px; padding: 16px;
      box-shadow: 0 16px 48px rgba(0,0,0,0.55);
      transition: top 0.28s ease, left 0.28s ease;
    }
    .tour-tip-title { display:flex; align-items:center; gap:8px; font-size: 0.98em; font-weight: 700; color: #f7931a; margin-bottom: 7px; }
    .tour-tip-body { font-size: 0.82em; color: #d1d5db; line-height: 1.55; }
    .tour-tip-foot { display:flex; align-items:center; justify-content:space-between; margin-top: 14px; gap: 10px; }
    .tour-step-count { font-size: 0.72em; color: #8b949e; font-weight: 600; }
    .tour-btns { display:flex; gap: 8px; }
    .tour-skip { background: none; border: none; color: #8b949e; font-size: 0.78em; cursor: pointer; padding: 7px 8px; font-family: inherit; }
    .tour-skip:hover { color: #e7e9ea; }
    .tour-next {
      background: #f7931a; border: none; color: #0a0e13; font-size: 0.8em; font-weight: 700;
      cursor: pointer; padding: 7px 16px; border-radius: 8px; font-family: inherit;
    }
    .tour-next:hover { background: #ffa733; }
    body.light-mode .tour-tip { background: #fff; border-color: #e5e7eb; border-top-color: #f7931a; box-shadow: 0 16px 48px rgba(0,0,0,0.18); }
    body.light-mode .tour-tip-body { color: #374151; }
    body.light-mode .tour-next { color: #fff; }
    .nav-menu-logout { color: #f87171; }
    .nav-menu-logout:hover { background: rgba(239,68,68,0.1) !important; color: #f87171 !important; }
    .chart-title-header {
      display: flex;
      align-items: center;
      gap: 8px;
      margin-top: 8px;
      flex-wrap: wrap;
    }

    /* Sound Toggle (now a nav-menu-item) */
    #soundToggle svg { color: #4ade80; }
    #soundToggle.partial svg { color: #fbbf24; }
    #soundToggle.off svg { color: #f87171; }
    /* Sound Panel */
    .sound-panel {
      position: fixed; z-index: 9999;
      background: #121212; border: 1px solid rgba(255,255,255,0.1);
      border-radius: 14px; box-shadow: 0 12px 40px rgba(0,0,0,0.5);
      width: 248px; overflow: hidden;
    }
    .sound-panel-header {
      display: flex; align-items: center; justify-content: space-between;
      padding: 13px 16px; border-bottom: 1px solid rgba(255,255,255,0.07);
      font-size: 0.78em; font-weight: 700; color: #9ca3af;
      letter-spacing: 0.6px; text-transform: uppercase;
    }
    .sound-panel-close {
      background: none; border: none; color: #6b7280; cursor: pointer;
      padding: 2px 7px; border-radius: 5px; font-size: 1em; line-height: 1;
      transition: color 0.15s, background 0.15s;
    }
    .sound-panel-close:hover { color: #e7e9ea; background: rgba(255,255,255,0.07); }
    /* Tombol kembali di sub-panel: area sentuh lebih besar & gampang diklik */
    .sound-panel-back {
      display: inline-flex; align-items: center; justify-content: center;
      width: 30px; height: 30px; padding: 0; margin: -4px 4px -4px -6px;
      background: none; border: none; color: #9ca3af; cursor: pointer;
      border-radius: 7px; flex-shrink: 0;
      transition: color 0.15s, background 0.15s;
    }
    .sound-panel-back:hover, .sound-panel-back:active { color: #e7e9ea; background: rgba(255,255,255,0.1); }
    .sound-row {
      display: flex; align-items: center; gap: 11px;
      padding: 11px 16px; border-bottom: 1px solid rgba(255,255,255,0.04);
      transition: background 0.15s; cursor: default;
    }
    .sound-row:last-of-type { border-bottom: none; }
    .sound-row:hover { background: rgba(255,255,255,0.03); }
    .sound-row-icon {
      width: 30px; height: 30px; display: flex; align-items: center;
      justify-content: center; border-radius: 8px; flex-shrink: 0;
    }
    .sound-row-label { flex: 1; font-size: 0.82em; color: #d1d5db; font-weight: 500; line-height: 1.3; }
    .sound-row-sub { font-size: 0.78em; color: #6b7280; display: block; margin-top: 1px; }
    .sound-sw { position: relative; display: inline-block; width: 38px; height: 21px; flex-shrink: 0; }
    .sound-sw input { opacity: 0; width: 0; height: 0; }
    .sound-sw-track {
      position: absolute; inset: 0; background: rgba(255,255,255,0.1);
      border-radius: 21px; cursor: pointer; transition: background 0.2s;
      border: 1px solid rgba(255,255,255,0.08);
    }
    .sound-sw-track::before {
      content: ''; position: absolute;
      width: 15px; height: 15px; left: 2px; top: 2px;
      background: #6b7280; border-radius: 50%; transition: all 0.2s;
    }
    .sound-sw input:checked + .sound-sw-track { background: rgba(74,222,128,0.3); border-color: rgba(74,222,128,0.4); }
    .sound-sw input:checked + .sound-sw-track::before { transform: translateX(17px); background: #4ade80; }
    .sound-panel-footer {
      display: flex; gap: 8px; padding: 11px 16px;
      border-top: 1px solid rgba(255,255,255,0.07);
    }
    .sound-panel-btn {
      flex: 1; padding: 7px 8px; border-radius: 7px;
      border: 1px solid rgba(255,255,255,0.08); background: rgba(255,255,255,0.05);
      color: #9ca3af; font-size: 0.75em; cursor: pointer;
      transition: all 0.15s; font-weight: 500;
    }
    .sound-panel-btn:hover { background: rgba(255,255,255,0.1); color: #e7e9ea; }

    .header-right {
      display: flex;
      align-items: center;
      gap: 2px;
      margin-left: auto;
    }

    /* Stat Items — Glassmorphism */
    .stat-item {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      column-gap: 5px;
      row-gap: 0;
      padding: 5px 9px;
      background: #0d0d0d;
      border-radius: 4px;
      border: 1px solid rgba(255,255,255,0.07);
      border-top: 2px solid rgba(255,255,255,0.15);
      box-shadow: 0 2px 8px rgba(0,0,0,0.18);
      transition: background 0.2s ease, transform 0.2s ease;
    }
    .stat-item:hover {
      background: #111e33;
      transform: translateY(-1px);
    }
    /* === Feedback klik ringan (tap mobile & klik desktop) + cursor pointer === */
    button, [onclick], a[href], label[for], select {
      cursor: pointer;
      -webkit-tap-highlight-color: transparent;
    }
    button, [onclick] { transition: transform 0.12s ease; }
    button:active, [onclick]:active {
      transform: scale(0.93);
    }
    /* Elemen besar/kartu yang bisa diklik: efek tekan lebih halus */
    .stat-item[onclick]:active, .promo-card:active, .news-card:active,
    .nav-menu-item:active, .page-btn:active {
      transform: scale(0.97);
    }
    @media (hover: none) {
      /* Di layar sentuh: cursor tidak relevan, biarkan efek tekan saja */
      button, [onclick] { cursor: default; }
    }
    .stat-item .stat-label {
      flex: 0 0 100%;
      font-size: 0.58em;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.7px;
      color: #9ca3af;
      line-height: 1.5;
    }
    .stat-item .stat-value {
      flex: 0 1 auto;
      font-size: 0.88em;
      font-weight: 700;
      color: #f0f6ff;
      font-family: 'JetBrains Mono', monospace;
      white-space: nowrap;
      line-height: 1.3;
    }
    .rp-prefix { font-size: 0.55em; font-weight: 500; opacity: 0.7; }
    .stat-item .stat-value.green { color: #4ade80; }
    .stat-item .stat-value.blue { color: #60a5fa; }
    .stat-item .stat-change {
      flex: 0 0 auto;
      font-size: 0.62em;
      padding: 1px 6px;
      border-radius: 4px;
      font-weight: 700;
      letter-spacing: 0.2px;
      white-space: nowrap;
      min-height: 1.45em;
      display: inline-flex;
      align-items: center;
    }
    /* Badge kosong (belum ada perubahan, mis. USD/IDR diam) jangan dirender —
       di light mode background putihnya kelihatan seperti kapsul kosong */
    .stat-item .stat-change:empty { display: none !important; }
    /* Dorong badge +/- ke kanan agar mepet ke tepi kotak, bukan ke font harga */
    #buyCard .stat-change, #sellCard .stat-change, #usdIdrCard .stat-change { margin-left: auto; }
    .stat-item .stat-change.up {
      color: #4ade80;
      background: rgba(74,222,128,0.13);
    }
    .stat-item .stat-change.down {
      color: #f87171;
      background: rgba(248,113,113,0.13);
    }
    .stat-item.price-up {
      border-top-color: #4ade80;
      box-shadow: 0 0 16px rgba(74,222,128,0.08), 0 2px 12px rgba(0,0,0,0.2);
    }
    .stat-item.price-up .stat-value { color: #4ade80; }
    .stat-item.price-down {
      border-top-color: #f87171;
      box-shadow: 0 0 16px rgba(248,113,113,0.08), 0 2px 12px rgba(0,0,0,0.2);
    }
    .stat-item.price-down .stat-value { color: #f87171; }

    /* ── Skeleton loading ──────────────────────────────────────── */
    .stat-val-skeleton {
      display: inline-block !important;
      min-width: 82px; height: 0.95em;
      background: linear-gradient(90deg, rgba(255,255,255,0.06) 25%, rgba(255,255,255,0.13) 50%, rgba(255,255,255,0.06) 75%);
      background-size: 200% 100%;
      animation: skelShimmer 1.4s infinite linear;
      border-radius: 6px; vertical-align: middle;
    }
    @keyframes skelShimmer {
      0%   { background-position: 200% 0; }
      100% { background-position: -200% 0; }
    }

    /* ── Price flip animation ──────────────────────────────────── */
    @keyframes flipOutUp   { 0%{opacity:1;transform:translateY(0)} 100%{opacity:0;transform:translateY(-9px)} }
    @keyframes flipOutDown { 0%{opacity:1;transform:translateY(0)} 100%{opacity:0;transform:translateY(9px)}  }
    @keyframes flipIn      { 0%{opacity:0;transform:translateY(9px)} 100%{opacity:1;transform:translateY(0)}  }
    .flip-out-up   { animation: flipOutUp   0.16s ease forwards; display:inline-block; }
    .flip-out-down { animation: flipOutDown 0.16s ease forwards; display:inline-block; }
    .flip-in       { animation: flipIn      0.18s ease forwards; display:inline-block; }

    /* ── Per-card accent colors ────────────────────────────────── */
    #buyCard    .stat-label { color: #4ade80 !important; opacity:1 !important; }
    #sellCard   .stat-label { color: #60a5fa !important; opacity:1 !important; }
    #usdIdrCard .stat-label { color: #a78bfa !important; opacity:1 !important; }
    #promoLimitCard .stat-label { color: #f7931a !important; opacity:1 !important; }
    #lowestOnCard   .stat-label { color: #34d399 !important; opacity:1 !important; }
    #markupCard     .stat-label { color: #fbbf24 !important; opacity:1 !important; }
    #buyCard    { border-top-color: #4ade80 !important; border-left: none !important; }
    #sellCard   { border-top-color: #60a5fa !important; border-left: none !important; }
    #usdIdrCard { border-top-color: #a78bfa !important; border-left: none !important; }
    #promoLimitCard { border-top-color: #f7931a !important; border-left: none !important; }
    /* Titik ON: border hijau penuh + latar tipis agar serasi dengan kartu lain yang punya glow */
    #lowestOnCard   { border-color: rgba(52,211,153,0.45) !important; border-top-color: #34d399 !important; border-left: none !important; background: rgba(52,211,153,0.06); box-shadow: 0 0 10px rgba(52,211,153,0.12), 0 2px 8px rgba(0,0,0,0.18); }
    #markupCard     { border-top-color: #fbbf24 !important; border-left: none !important; }

    .stat-item.invest {
      border-left: 2px solid rgba(247,147,26,0.6);
      background: rgba(247,147,26,0.05);
    }
    .stat-item.invest .stat-label { color: #f7931a; }

    /* Invest Stats Row - horizontal pill per nominal */
    .invest-stats {
      display: flex;
      flex-wrap: wrap;
      overflow: visible;
      gap: 6px;
      padding: 4px 16px 8px 16px;
      justify-content: center;
      align-items: center;
      scrollbar-width: none;
    }
    .invest-stats::-webkit-scrollbar { display: none; }
    #investStatsList {
      display: flex;
      flex-direction: row;
      flex-wrap: wrap;
      gap: 6px;
      align-items: center;
      justify-content: center;
    }
    .invest-stats .stat-item {
      display: flex;
      flex-direction: row;
      flex-wrap: nowrap;
      align-items: center;
      gap: 6px;
      padding: 5px 12px;
      flex: 0 0 auto;
      text-align: left;
      background: linear-gradient(135deg, rgba(247,147,26,0.1) 0%, rgba(247,147,26,0.04) 100%);
      border: 1px solid rgba(247,147,26,0.22);
      border-top: 1px solid rgba(247,147,26,0.4);
      border-radius: 4px;
      box-shadow: 0 2px 6px rgba(247,147,26,0.1), inset 0 1px 0 rgba(255,255,255,0.04);
      transform: none !important;
    }
    .invest-stats .stat-item:hover {
      background: linear-gradient(135deg, rgba(247,147,26,0.16) 0%, rgba(247,147,26,0.08) 100%);
      border-color: rgba(247,147,26,0.38);
      box-shadow: 0 3px 10px rgba(247,147,26,0.15);
      transform: none !important;
    }
    /* Reset base overrides yang merusak horizontal layout pill invest */
    .invest-stats .stat-item .stat-label {
      flex: 0 0 auto;
      font-size: 0.75em;
      min-width: 28px;
      color: #f7931a;
    }
    .invest-stats .stat-item .stat-value {
      flex: 0 0 auto;
      font-size: 0.85em;
    }
    .invest-stats .stat-item .stat-change {
      flex: 0 0 auto;
      font-size: 0.8em;
      padding: 2px 6px;
      min-height: auto;
      display: inline;
    }

    /* History Font Settings Button - hanya mobile */
    #historyFontSettingsBtn { display: none; }

    /* Nominal Settings Button - tampil di semua mode */
    .nominal-settings-btn {
      display: flex; /* Visible on all modes */
      align-items: center;
      justify-content: center;
      width: 32px;
      height: 32px;
      background: rgba(247, 147, 26, 0.15);
      border: 1px solid rgba(247, 147, 26, 0.3);
      border-radius: 8px;
      color: #f7931a;
      cursor: pointer;
      transition: all 0.2s;
      flex-shrink: 0;
    }
    .nominal-settings-btn:hover {
      background: rgba(247, 147, 26, 0.25);
    }

    /* Nominal Settings Modal */
    .nominal-modal-overlay {
      position: fixed;
      top: 0;
      left: 0;
      right: 0;
      bottom: 0;
      background: rgba(0,0,0,0.6);
      z-index: 9999;
      display: none;
      align-items: center;
      justify-content: center;
    }
    .nominal-modal-overlay.active { display: flex; }
    .display-settings-overlay {
      position: fixed; top: 0; left: 0; right: 0; bottom: 0;
      background: rgba(0,0,0,0.6);
      z-index: 10000; display: none; align-items: center; justify-content: center;
      padding: 16px;
    }
    .display-settings-overlay.active { display: flex; }
    .display-settings-modal {
      background: rgba(10,10,10,0.92);
      backdrop-filter: blur(24px); -webkit-backdrop-filter: blur(24px);
      border-radius: 18px;
      border: 1px solid rgba(255,255,255,0.12);
      border-top: 1px solid rgba(255,255,255,0.22);
      max-width: 380px; width: 100%;
      max-height: 86vh; overflow-y: auto;
      box-shadow: 0 32px 80px rgba(0,0,0,0.6), inset 0 1px 0 rgba(255,255,255,0.08);
    }
    .display-settings-modal > h3 {
      color: #f7931a; font-size: 1em; font-weight: 700;
      display: flex; align-items: center; gap: 8px;
      padding: 18px 20px 14px; margin: 0;
      position: sticky; top: 0; z-index: 1;
      background: rgba(10,10,10,0.95);
      border-bottom: 1px solid rgba(255,255,255,0.08);
    }
    .display-settings-close {
      margin-left: auto; background: rgba(255,255,255,0.06);
      border: 1px solid rgba(255,255,255,0.12); color: #8b949e;
      width: 28px; height: 28px; border-radius: 8px; cursor: pointer;
      display: flex; align-items: center; justify-content: center;
      transition: all 0.2s;
    }
    .display-settings-close:hover { background: rgba(255,255,255,0.12); color: #e7e9ea; }
    body.light-mode .display-settings-modal { background: #fff; border-color: #e0e0e0; border-top-color: rgba(247,147,26,0.6); }
    body.light-mode .display-settings-modal > h3 { background: #fff; border-bottom-color: #eee; }
    body.light-mode .display-settings-close { background: #f3f4f6; border-color: #e0e0e0; color: #6b7280; }
    body.light-mode .display-settings-close:hover { background: #e5e7eb; color: #1f2937; }
    .nominal-modal {
      background: rgba(10,10,10,0.85);
      backdrop-filter: blur(24px);
      -webkit-backdrop-filter: blur(24px);
      border-radius: 20px;
      border: 1px solid rgba(255,255,255,0.12);
      border-top: 1px solid rgba(255,255,255,0.22);
      padding: 20px;
      max-width: 320px;
      width: 90%;
      box-shadow: 0 32px 80px rgba(0,0,0,0.6), inset 0 1px 0 rgba(255,255,255,0.08);
    }
    .nominal-modal h3 {
      color: #f7931a;
      font-size: 1em;
      margin-bottom: 16px;
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .nominal-modal-list {
      display: flex;
      flex-direction: column;
      gap: 8px;
      margin-bottom: 16px;
    }
    .nominal-modal-item {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 10px 12px;
      background: rgba(255,255,255,0.04);
      backdrop-filter: blur(8px);
      border: 1px solid rgba(255,255,255,0.08);
      border-top: 1px solid rgba(255,255,255,0.14);
      border-radius: 12px;
      cursor: pointer;
      transition: all 0.2s;
      box-shadow: 0 2px 8px rgba(0,0,0,0.15), inset 0 1px 0 rgba(255,255,255,0.05);
    }
    .nominal-modal-item:hover { background: rgba(255,255,255,0.08); border-color: rgba(255,255,255,0.15); }
    .nominal-modal-item input[type="checkbox"] {
      width: 18px;
      height: 18px;
      cursor: pointer;
      accent-color: #f7931a;
    }
    .nominal-modal-item label {
      flex: 1;
      cursor: pointer;
      color: #e7e9ea;
      font-size: 0.9em;
    }
    .nominal-modal-item .nominal-discount {
      color: #6b7280;
      font-size: 0.75em;
    }
    .nominal-modal-actions {
      display: flex;
      gap: 10px;
    }
    .nominal-modal-actions button {
      flex: 1;
      padding: 10px;
      border-radius: 8px;
      font-weight: 600;
      cursor: pointer;
      transition: all 0.2s;
    }
    .nominal-modal-actions .btn-cancel {
      background: rgba(255,255,255,0.06);
      backdrop-filter: blur(10px);
      border: 1px solid rgba(255,255,255,0.12);
      border-top: 1px solid rgba(255,255,255,0.2);
      color: #8b949e;
      box-shadow: 0 4px 10px rgba(0,0,0,0.2), inset 0 1px 0 rgba(255,255,255,0.07);
    }
    .nominal-modal-actions .btn-cancel:hover {
      background: rgba(255,255,255,0.1);
      color: #e7e9ea;
    }
    .nominal-modal-actions .btn-save {
      background: rgba(247,147,26,0.2);
      backdrop-filter: blur(10px);
      border: 1px solid rgba(247,147,26,0.4);
      border-top: 1px solid rgba(247,147,26,0.6);
      color: #f7931a;
      box-shadow: 0 4px 14px rgba(247,147,26,0.15), inset 0 1px 0 rgba(247,147,26,0.2);
    }
    .nominal-modal-actions .btn-save:hover {
      background: rgba(247,147,26,0.3);
      box-shadow: 0 0 18px rgba(247,147,26,0.25);
    }
    /* User hidden nominal */
    .stat-item.invest.user-hidden {
      display: none !important;
    }

    /* Chart Section */
    .chart-section {
      background: #0d0d0d;
      border-radius: 4px 4px 0 0;
      border: 1px solid rgba(255,255,255,0.07);
      margin-bottom: 20px;
      box-shadow: 0 4px 24px rgba(0,0,0,0.3);
      transition: border-color 0.3s ease, box-shadow 0.3s ease;
      position: relative;
    }
    /* Glow effect — border berwarna saat perubahan, tetap sampai harga berubah lagi */
    .glow-up {
      border-color: rgba(0,200,83,0.6) !important;
      box-shadow: 0 0 0 1px rgba(0,200,83,0.3), 0 24px 64px rgba(0,0,0,0.45) !important;
      animation: glowBlinkUp 0.6s ease-in-out 8;
    }
    .glow-down {
      border-color: rgba(255,82,82,0.6) !important;
      box-shadow: 0 0 0 1px rgba(255,82,82,0.3), 0 24px 64px rgba(0,0,0,0.45) !important;
      animation: glowBlinkDown 0.6s ease-in-out 8;
    }
    @keyframes glowBlinkUp {
      0%, 100% { box-shadow: 0 0 0 1px rgba(0,200,83,0.2), 0 0 20px rgba(0,200,83,0.3), 0 24px 64px rgba(0,0,0,0.45); }
      50% { box-shadow: 0 0 0 2px rgba(0,200,83,0.5), 0 0 50px rgba(0,200,83,0.5), 0 0 100px rgba(0,200,83,0.2), 0 24px 64px rgba(0,0,0,0.45); }
    }
    @keyframes glowBlinkDown {
      0%, 100% { box-shadow: 0 0 0 1px rgba(255,82,82,0.2), 0 0 20px rgba(255,82,82,0.3), 0 24px 64px rgba(0,0,0,0.45); }
      50% { box-shadow: 0 0 0 2px rgba(255,82,82,0.5), 0 0 50px rgba(255,82,82,0.5), 0 0 100px rgba(255,82,82,0.2), 0 24px 64px rgba(0,0,0,0.45); }
    }
    .chart-header {
      padding: 14px 18px;
      background: #0a0a0a;
      border-bottom: 1px solid rgba(255,255,255,0.06);
      border-radius: 4px 4px 0 0;
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 8px;
      position: relative;
      transition: background 0.3s ease;
    }
    .chart-section::before {
      content: '';
      position: absolute;
      top: -40px; left: 15%;
      width: 300px; height: 220px;
      background: radial-gradient(ellipse, rgba(247,147,26,0.1) 0%, transparent 70%);
      pointer-events: none;
      z-index: 0;
    }
    .chart-section::after {
      content: '';
      position: absolute;
      top: -30px; right: 10%;
      width: 200px; height: 180px;
      background: radial-gradient(ellipse, rgba(96,165,250,0.07) 0%, transparent 70%);
      pointer-events: none;
      z-index: 0;
    }
    .chart-title {
      display: flex;
      align-items: center;
      gap: 12px;
      width: 100%;
      justify-content: center;
    }
    .chart-header h2 {
      font-size: 1.2em;
      font-weight: 700;
      color: #ffffff;
      margin: 0;
      letter-spacing: -0.02em;
    }
    /* Live dot pulse */
    .live-dot {
      position: absolute;
      top: -2px;
      right: -3px;
      width: 8px;
      height: 8px;
      background: #22c55e;
      border-radius: 50%;
      box-shadow: 0 0 0 0 rgba(34,197,94,0.6);
      animation: livePulse 1.8s ease-in-out infinite;
    }
    .live-dot.reconnecting {
      background: #f59e0b;
      box-shadow: 0 0 0 0 rgba(245,158,11,0.6);
      animation: livePulseAmber 1.8s ease-in-out infinite;
    }
    @keyframes livePulse {
      0%   { box-shadow: 0 0 0 0 rgba(34,197,94,0.6); }
      70%  { box-shadow: 0 0 0 7px rgba(34,197,94,0); }
      100% { box-shadow: 0 0 0 0 rgba(34,197,94,0); }
    }
    @keyframes livePulseAmber {
      0%   { box-shadow: 0 0 0 0 rgba(245,158,11,0.6); }
      70%  { box-shadow: 0 0 0 7px rgba(245,158,11,0); }
      100% { box-shadow: 0 0 0 0 rgba(245,158,11,0); }
    }
    body.light-mode .live-dot { border: 1.5px solid #fff; }

    .chart-header .live-badge {
      background: rgba(34,197,94,0.12);
      backdrop-filter: blur(10px);
      color: #4ade80;
      font-size: 0.7em;
      padding: 5px 12px;
      border-radius: 20px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      border: 1px solid rgba(34,197,94,0.3);
      border-top: 1px solid rgba(34,197,94,0.5);
      box-shadow: 0 0 12px rgba(34,197,94,0.2), inset 0 1px 0 rgba(34,197,94,0.15);
      animation: pulse 2s infinite;
    }
    .calc-btn-header {
      background: linear-gradient(135deg, #f7931a 0%, #e8850a 100%);
      color: #fff;
      font-size: 0.7em;
      padding: 5px 12px;
      border-radius: 20px;
      font-weight: 600;
      border: none;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      gap: 5px;
      box-shadow: 0 2px 10px rgba(247,147,26,0.3);
      transition: all 0.2s ease;
    }
    .calc-btn-header:hover {
      transform: translateY(-1px);
      box-shadow: 0 4px 15px rgba(247,147,26,0.4);
    }
    .calc-btn-header svg {
      width: 12px;
      height: 12px;
    }
    /* Promo Status Badge */
    .promo-status-badge {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 4px 12px;
      border-radius: 20px;
      font-size: 11px;
      font-weight: 800;
      letter-spacing: 0.6px;
      background: rgba(255,255,255,0.05);
      backdrop-filter: blur(10px);
      border: 1px solid rgba(255,255,255,0.1);
      color: #888;
      margin-left: 8px;
    }
    /* ON: hijau mengkilap (gradasi + highlight atas) dengan kedip glow rapi */
    .promo-status-badge.on {
      background: linear-gradient(180deg, #00e676 0%, #00c853 48%, #00993f 100%);
      border: 1px solid rgba(0,230,118,0.9);
      color: #ffffff;
      text-shadow: 0 1px 2px rgba(0,80,30,0.55);
      box-shadow: 0 0 14px rgba(0,230,118,0.5), 0 2px 6px rgba(0,0,0,0.3), inset 0 1px 0 rgba(255,255,255,0.5);
      animation: promoBlinkOn 1.6s ease-in-out infinite;
    }
    /* OFF: merah mengkilap dengan kedip glow rapi */
    .promo-status-badge.off {
      background: linear-gradient(180deg, #ff6b6b 0%, #f43b3b 48%, #c62828 100%);
      border: 1px solid rgba(255,107,107,0.9);
      color: #ffffff;
      text-shadow: 0 1px 2px rgba(100,10,10,0.55);
      box-shadow: 0 0 14px rgba(244,59,59,0.5), 0 2px 6px rgba(0,0,0,0.3), inset 0 1px 0 rgba(255,255,255,0.45);
      animation: promoBlinkOff 1.6s ease-in-out infinite;
    }
    .promo-dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: #888;
    }
    .promo-status-badge.on .promo-dot,
    .promo-status-badge.off .promo-dot {
      background: radial-gradient(circle at 35% 30%, #ffffff 0%, rgba(255,255,255,0.85) 35%, rgba(255,255,255,0.45) 100%);
      box-shadow: 0 0 6px rgba(255,255,255,0.9);
      animation: promoPulse 1s ease-in-out infinite;
    }
    @keyframes promoPulse {
      0%, 100% { transform: scale(1); opacity: 1; }
      50% { transform: scale(1.35); opacity: 0.65; }
    }
    @keyframes promoBlinkOn {
      0%, 100% { box-shadow: 0 0 8px rgba(0,230,118,0.35), 0 2px 6px rgba(0,0,0,0.3), inset 0 1px 0 rgba(255,255,255,0.5); filter: brightness(1); }
      50% { box-shadow: 0 0 22px rgba(0,230,118,0.85), 0 2px 6px rgba(0,0,0,0.3), inset 0 1px 0 rgba(255,255,255,0.5); filter: brightness(1.18); }
    }
    @keyframes promoBlinkOff {
      0%, 100% { box-shadow: 0 0 8px rgba(244,59,59,0.35), 0 2px 6px rgba(0,0,0,0.3), inset 0 1px 0 rgba(255,255,255,0.45); filter: brightness(1); }
      50% { box-shadow: 0 0 22px rgba(244,59,59,0.85), 0 2px 6px rgba(0,0,0,0.3), inset 0 1px 0 rgba(255,255,255,0.45); filter: brightness(1.18); }
    }
    @keyframes pulse {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.7; }
    }
    @keyframes badgePulse {
      0%, 100% { transform: scale(1); box-shadow: 0 0 0 0 rgba(239,68,68,0.7); }
      50% { transform: scale(1.2); box-shadow: 0 0 0 5px rgba(239,68,68,0); }
    }
    #chatUnreadBadge.pulse { animation: badgePulse 1s ease-in-out infinite; }
    @keyframes promoBlink {
      0%, 100% { box-shadow: 0 0 0 0 rgba(14,203,129,0.8); background: linear-gradient(135deg, rgba(14,203,129,0.25), rgba(14,203,129,0.1)); }
      50% { box-shadow: 0 0 0 6px rgba(14,203,129,0); background: linear-gradient(135deg, rgba(14,203,129,0.55), rgba(14,203,129,0.35)); }
    }
    @keyframes promoBadgePop {
      0%, 100% { transform: scale(1); }
      50% { transform: scale(1.25); }
    }
    .indicator-btn.promo.has-new {
      animation: promoBlink 0.8s ease-in-out infinite !important;
      border-color: rgba(14,203,129,0.8) !important;
    }
    .indicator-btn.promo.has-new #promoBadge {
      animation: promoBadgePop 0.8s ease-in-out infinite;
    }
    body.light-mode .indicator-btn.promo.has-new {
      animation: promoBlinkLight 0.8s ease-in-out infinite !important;
    }
    .promo-nav.has-new {
      animation: promoNavBlink 0.8s ease-in-out infinite !important;
    }
    .promo-nav.has-new #promoBadge {
      animation: promoBadgePop 0.8s ease-in-out infinite;
    }
    @keyframes promoNavBlink {
      0%, 100% { background: rgba(14,203,129,0.08); box-shadow: 0 0 0 0 rgba(14,203,129,0.6); }
      50% { background: rgba(14,203,129,0.22); box-shadow: 0 0 0 5px rgba(14,203,129,0); }
    }
    @keyframes promoBlinkLight {
      0%, 100% { box-shadow: 0 0 0 0 rgba(16,185,129,0.4); background: #d1fae5; }
      50% { box-shadow: 0 0 0 5px rgba(16,185,129,0); background: #a7f3d0; }
    }
    .chart-stats {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      align-items: stretch; /* semua kartu sebaris sama tinggi walau badge perubahan beda ukuran */
      justify-content: center;
    }
    .chart-stats > .stat-item { align-content: center; }
    /* Titik ON: label satu baris agar tinggi kotak sama dgn kartu lain */
    #lowestOnCard .stat-label { white-space: nowrap; }
    /* Desktop: semua kartu (Beli/Jual/USD-IDR/Titik ON) seragam lebarnya */
    @media (min-width: 769px) {
      .chart-stats > .stat-item {
        flex: 1 1 0;
        min-width: 0;
        max-width: 250px;
      }
    }
    .daily-stats {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      align-items: center;
      justify-content: center;
      padding: 12px 16px;
      background: rgba(0,0,0,0.15);
      border-top: 1px solid rgba(255,255,255,0.06);
    }
    .daily-item {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 8px 14px;
      background: rgba(12, 12, 12, 0.8);
      border-radius: 10px;
      font-size: 0.85em;
      border: 1px solid rgba(255,255,255,0.05);
    }
    .daily-item .daily-label {
      color: #8b949e;
      text-transform: uppercase;
      font-size: 0.75em;
      font-weight: 600;
      letter-spacing: 0.5px;
    }
    .daily-item .daily-value {
      color: #ffffff;
      font-weight: 600;
      font-family: 'JetBrains Mono', monospace;
    }
    .daily-item.clock-item {
      flex-direction: column;
      gap: 4px;
      padding: 10px 16px;
      background: linear-gradient(135deg, rgba(247,147,26,0.1), rgba(247,147,26,0.05));
      border: 1px solid rgba(247,147,26,0.2);
      border-radius: 12px;
    }
    /* Limit/Markup/Spread - kolom badge di kanan jam (in-flow, tidak absolute
       agar tidak terpotong di layar sempit dan tidak menyisakan ruang kosong di desktop) */
    .limit-markup-group {
      display: flex;
      flex-direction: column;
      gap: 4px;
      align-items: flex-start;
      justify-content: center;
      flex: 0 0 auto;
    }
    /* === Overlay badges - shared base === */
    .limit-label, .markup-overlay, .spread-overlay,
    .price-high-overlay, .price-low-overlay {
      display: flex;
      flex-direction: row;
      align-items: center;
      gap: 5px;
      font-size: 0.78em;
      font-weight: 600;
      padding: 5px 9px;
      border-radius: 4px;
      backdrop-filter: blur(12px);
      -webkit-backdrop-filter: blur(12px);
      box-shadow: 0 2px 8px rgba(0,0,0,0.25);
      line-height: 1;
    }
    /* LIMIT badge */
    .limit-label {
      background: rgba(247,147,26,0.1);
      border: 1px solid rgba(247,147,26,0.28);
      border-left: 2px solid #f7931a;
      color: #f7931a;
    }
    .limit-label .limit-text {
      font-size: 0.75em;
      font-weight: 500;
      color: rgba(255,255,255,0.45);
      text-transform: uppercase;
      letter-spacing: 0.5px;
      margin-bottom: 2px;
    }
    .limit-label .limit-eq { display: none; }
    .limit-label #promoLimitValue { font-size: 1em; color: #f7931a; font-weight: 700; }
    /* MARKUP badge */
    .markup-overlay {
      background: rgba(251,191,36,0.1);
      border: 1px solid rgba(251,191,36,0.28);
      border-left: 2px solid #fbbf24;
      color: #fbbf24;
    }
    .markup-overlay > svg { display: none; }
    .markup-overlay-text {
      font-size: 0.75em;
      font-weight: 500;
      color: rgba(255,255,255,0.45);
      text-transform: uppercase;
      letter-spacing: 0.5px;
      margin-bottom: 2px;
    }
    /* SPREAD badge */
    .spread-overlay {
      background: rgba(74,222,128,0.09);
      border: 1px solid rgba(74,222,128,0.28);
      border-left: 2px solid #4ade80;
      color: #4ade80;
    }
    .spread-overlay-text {
      font-size: 0.75em;
      font-weight: 500;
      color: rgba(255,255,255,0.45);
      text-transform: uppercase;
      letter-spacing: 0.5px;
      margin-bottom: 2px;
    }
    /* Tertinggi/Terendah - kolom badge di kiri jam (in-flow), rata kanan menempel jam */
    .price-highlow-group {
      display: flex;
      flex-direction: column;
      gap: 4px;
      align-items: flex-end;
      justify-content: center;
      flex: 0 0 auto;
    }
    .price-high-overlay {
      background: rgba(74,222,128,0.09);
      border: 1px solid rgba(74,222,128,0.28);
      border-left: 2px solid #4ade80;
      color: #4ade80;
    }
    .price-low-overlay {
      background: rgba(248,113,113,0.09);
      border: 1px solid rgba(248,113,113,0.28);
      border-left: 2px solid #f87171;
      color: #f87171;
    }
    .price-highlow-text {
      font-size: 0.75em;
      font-weight: 500;
      color: rgba(255,255,255,0.45);
      text-transform: uppercase;
      letter-spacing: 0.5px;
      margin-bottom: 2px;
    }
    /* Label badge sejajar dengan nilai dalam 1 baris (row) — tanpa jarak bawah */
    .limit-label .limit-text, .markup-overlay-text,
    .spread-overlay-text, .price-highlow-text { margin-bottom: 0; }
    @media (max-width: 768px) {
      .limit-label, .markup-overlay, .spread-overlay,
      .price-high-overlay, .price-low-overlay { font-size: 0.65em; padding: 3px 7px; }
      .limit-label .limit-text, .markup-overlay-text, .spread-overlay-text,
      .price-highlow-text { display: none; }
      .markup-overlay > svg { display: none; }
    }
    @media (max-width: 480px) {
      .limit-label, .markup-overlay, .spread-overlay,
      .price-high-overlay, .price-low-overlay { font-size: 0.58em; padding: 3px 6px; }
    }

    /* Info Row - Clock & User Phone */
    .chart-info-row {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-top: 10px;
      padding: 10px 16px;
      background: rgba(255,255,255,0.04);
      border: 1px solid rgba(255,255,255,0.1);
      border-left: 3px solid rgba(255,255,255,0.18);
      border-radius: 4px;
      backdrop-filter: blur(10px);
      -webkit-backdrop-filter: blur(10px);
      transition: border-color 0.3s ease, background-color 0.3s ease;
    }
    .info-item {
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .clock-info {
      flex-direction: column;
      align-items: center;
      gap: 2px;
      text-align: center;
    }
    .info-time {
      font-size: 1.25em;
      font-weight: 700;
      color: #e6edf3;
      font-family: 'JetBrains Mono', monospace;
      letter-spacing: 1px;
      text-align: center;
      display: block;
      text-shadow: none;
    }
    /* Jam: bedakan warna jam / menit / detik agar jelas */
    .clk-h { color: #e6edf3; }
    .clk-m { color: #f7931a; }
    .clk-s { color: #22c55e; display: inline-block; transition: color 0.2s ease; }
    .clk-s.clk-s-alert { color: #ef4444 !important; animation: clkSPulse 1s ease-in-out infinite; }
    @keyframes clkSPulse { 0%,100% { opacity: 1; } 50% { opacity: 0.45; } }
    /* Goyang layar (pengganti getar untuk iPhone/desktop) */
    body.is-shaking { overflow-x: hidden; }
    /* Goyang layar halus (smooth) — bukan getar kasar */
    .screen-shake { animation: screenShake 0.6s ease-in-out; }
    @keyframes screenShake {
      0%,100% { transform: translateX(0); }
      20% { transform: translateX(-1.5px); }
      40% { transform: translateX(1.5px); }
      60% { transform: translateX(-1px); }
      80% { transform: translateX(0.6px); }
    }
    .screen-shake-strong { animation: screenShakeStrong 0.72s ease-in-out; }
    @keyframes screenShakeStrong {
      0%,100% { transform: translateX(0); }
      15% { transform: translateX(-2.5px); }
      35% { transform: translateX(2.5px); }
      55% { transform: translateX(-1.6px); }
      75% { transform: translateX(1px); }
      90% { transform: translateX(-0.5px); }
    }
    .clk-sep { color: rgba(255,255,255,0.35); margin: 0 1px; animation: clkBlink 1s steps(1,end) infinite; }
    @keyframes clkBlink { 0%,50% { opacity: 1; } 51%,100% { opacity: 0.3; } }
    /* Animasi gerak saat detik berganti */
    .clk-tick { animation: clkTick 0.4s ease; }
    @keyframes clkTick {
      0% { transform: translateY(-3px) scale(1.18); opacity: 0.45; }
      60% { transform: translateY(0) scale(1.05); opacity: 1; }
      100% { transform: translateY(0) scale(1); opacity: 1; }
    }
    .info-date {
      font-size: 0.85em;
      color: #c9d1d9;
      font-weight: 500;
    }
    @media (max-width: 768px) {
      .info-date-day { display: none; }
    }
    .user-info-display {
      background: rgba(255,255,255,0.05);
      padding: 8px 14px;
      border-radius: 8px;
    }
    .info-label {
      font-size: 0.8em;
      color: #8b949e;
    }
    .info-value {
      font-size: 0.95em;
      font-weight: 600;
      color: #4ade80;
      font-family: 'JetBrains Mono', monospace;
    }
    .clock-time {
      font-size: 1.3em;
      font-weight: 600;
      color: #f7931a;
      font-family: 'JetBrains Mono', monospace;
      letter-spacing: 1px;
    }
    .clock-date {
      font-size: 0.8em;
      color: #8b949e;
    }
    .trend-icon-up {
      color: #4ade80;
      font-size: 1.2em;
    }
    .trend-icon-down {
      color: #f87171;
      font-size: 1.2em;
    }
    .daily-item .daily-value.high { color: #4ade80; }
    .daily-item .daily-value.low { color: #f87171; }
    .daily-item.sound-toggle {
      cursor: pointer;
      transition: all 0.2s ease;
    }
    .daily-item.sound-toggle:hover {
      background: rgba(247,147,26,0.15);
      border-color: rgba(247,147,26,0.3);
    }

    /* Notification Banner */
    #notifContainer {
      display: flex;
      flex-direction: column;
      gap: 12px;
      margin-bottom: 0;
    }
    #notifContainer:not(:empty) {
      margin-bottom: 14px;
    }
    .notif-banner {
      background: rgba(255,255,255,0.05);
      backdrop-filter: blur(20px);
      -webkit-backdrop-filter: blur(20px);
      border-radius: 16px;
      padding: 14px 18px;
      display: flex;
      align-items: center;
      gap: 14px;
      animation: slideDown 0.3s ease;
      border: 1px solid rgba(255,255,255,0.1);
      border-top: 1px solid rgba(255,255,255,0.18);
      box-shadow: 0 8px 32px rgba(0,0,0,0.3), inset 0 1px 0 rgba(255,255,255,0.07);
    }
    .notif-banner.promo { border-color: rgba(247,147,26,0.25); border-top-color: rgba(247,147,26,0.45); background: rgba(247,147,26,0.06); box-shadow: 0 8px 32px rgba(0,0,0,0.3), 0 0 20px rgba(247,147,26,0.06), inset 0 1px 0 rgba(247,147,26,0.1); }
    .notif-banner.warning { border-color: rgba(251,191,36,0.25); border-top-color: rgba(251,191,36,0.45); background: rgba(251,191,36,0.06); box-shadow: 0 8px 32px rgba(0,0,0,0.3), 0 0 20px rgba(251,191,36,0.06), inset 0 1px 0 rgba(251,191,36,0.1); }
    .notif-banner.urgent { border-color: rgba(248,113,113,0.25); border-top-color: rgba(248,113,113,0.45); background: rgba(248,113,113,0.06); box-shadow: 0 8px 32px rgba(0,0,0,0.3), 0 0 20px rgba(248,113,113,0.08), inset 0 1px 0 rgba(248,113,113,0.1); }
    .notif-banner.info { border-color: rgba(96,165,250,0.25); border-top-color: rgba(96,165,250,0.45); background: rgba(96,165,250,0.06); box-shadow: 0 8px 32px rgba(0,0,0,0.3), 0 0 20px rgba(96,165,250,0.06), inset 0 1px 0 rgba(96,165,250,0.1); }
    .notif-icon {
      width: 40px;
      height: 40px;
      border-radius: 12px;
      display: flex;
      align-items: center;
      justify-content: center;
      flex-shrink: 0;
      font-size: 18px;
    }
    .notif-banner.promo .notif-icon { background: linear-gradient(135deg, #f7931a, #e8850f); }
    .notif-banner.warning .notif-icon { background: linear-gradient(135deg, #fbbf24, #f59e0b); }
    .notif-banner.urgent .notif-icon { background: linear-gradient(135deg, #f87171, #ef4444); }
    .notif-banner.info .notif-icon { background: linear-gradient(135deg, #60a5fa, #3b82f6); }
    .notif-content {
      flex: 1;
      min-width: 0;
    }
    .notif-title {
      font-size: 0.95em;
      font-weight: 600;
      color: #ffffff;
      margin-bottom: 4px;
    }
    .notif-message {
      font-size: 0.85em;
      color: #8b949e;
      line-height: 1.4;
    }
    .notif-close {
      background: rgba(255,255,255,0.08);
      border: none;
      color: #8b949e;
      font-size: 16px;
      cursor: pointer;
      padding: 8px 12px;
      border-radius: 8px;
      transition: all 0.2s;
    }
    .notif-close:hover { background: rgba(255,255,255,0.15); color: #fff; }
    @keyframes slideDown {
      from { transform: translateY(-20px); opacity: 0; }
      to { transform: translateY(0); opacity: 1; }
    }

    .tradingview-widget-container {
      height: 600px;
      position: relative;
      touch-action: none;
    }
    .tradingview-widget-container__widget {
      height: 100% !important;
      touch-action: none;
      overflow: hidden;
    }
    .tradingview-widget-container iframe {
      touch-action: none !important;
    }

    /* Chart Bottom Row - Clock & Buttons */
    .chart-bottom-row {
      display: flex;
      flex-direction: row;
      align-items: center;
      justify-content: center;
      gap: 12px;
      margin-top: 4px;
      width: 100%;
      position: relative;
    }
    .chart-bottom-row .chart-info-row {
      margin-top: 0;
      flex: none;
      min-width: 0;
    }
    @media (max-width: 768px) {
      /* Mobile: rapat dan muat satu baris — badge kiri | jam | badge kanan */
      .chart-bottom-row { gap: 8px; justify-content: center; padding: 0 4px; }
      .chart-bottom-row .chart-info-row { flex: 0 1 auto; }
    }
    .all-btns-row {
      display: flex;
      gap: 8px;
      justify-content: center;
      flex-wrap: wrap;
      width: 100%;
    }
    .header-btns-row { display: none; }
    .indicator-btn {
      background: rgba(255,255,255,0.05);
      backdrop-filter: blur(14px);
      -webkit-backdrop-filter: blur(14px);
      color: #c4d0df;
      border: 1px solid rgba(255,255,255,0.12);
      border-top: 1px solid rgba(255,255,255,0.2);
      border-radius: 20px;
      padding: 6px 14px;
      font-size: 0.7em;
      font-weight: 600;
      cursor: pointer;
      display: flex;
      align-items: center;
      gap: 5px;
      box-shadow: 0 4px 12px rgba(0,0,0,0.2), inset 0 1px 0 rgba(255,255,255,0.08);
      transition: all 0.25s ease;
    }
    .indicator-btn:hover {
      background: rgba(255,255,255,0.1);
      border-color: rgba(255,255,255,0.22);
      transform: translateY(-2px);
      box-shadow: 0 8px 20px rgba(0,0,0,0.3), inset 0 1px 0 rgba(255,255,255,0.12);
    }
    .indicator-btn.guide {
      background: rgba(247,147,26,0.1);
      border-color: rgba(247,147,26,0.3);
      border-top-color: rgba(247,147,26,0.5);
      color: #f7931a;
      box-shadow: 0 4px 12px rgba(247,147,26,0.1), inset 0 1px 0 rgba(247,147,26,0.15);
    }
    .indicator-btn.guide:hover {
      background: rgba(247,147,26,0.18);
      box-shadow: 0 0 16px rgba(247,147,26,0.25), inset 0 1px 0 rgba(247,147,26,0.2);
    }
    .indicator-btn.chat {
      background: rgba(167,139,250,0.1);
      border-color: rgba(167,139,250,0.3);
      border-top-color: rgba(167,139,250,0.5);
      color: #a78bfa;
      box-shadow: 0 4px 12px rgba(167,139,250,0.1), inset 0 1px 0 rgba(167,139,250,0.15);
    }
    .indicator-btn.chat:hover {
      background: rgba(167,139,250,0.18);
      box-shadow: 0 0 16px rgba(167,139,250,0.25), inset 0 1px 0 rgba(167,139,250,0.2);
    }
    .chat-bubble { padding: 7px 11px; border-radius: 12px; font-size: 0.8em; max-width: 85%; word-break: break-word; }
    .chat-bubble.mine { background: rgba(59,158,255,0.18); border: 1px solid rgba(59,158,255,0.25); align-self: flex-end; }
    .chat-bubble.others { background: rgba(255,255,255,0.06); border: 1px solid rgba(255,255,255,0.1); align-self: flex-start; }
    .chat-animal { font-size: 0.75em; font-weight: 700; margin-bottom: 2px; }
    .chat-animal.mine { color: #3b9eff; text-align: right; }
    .chat-animal.others { color: #f7931a; }
    .chat-time { font-size: 0.68em; color: #6b7280; margin-top: 2px; text-align: right; }
    .indicator-btn.settings {
      background: rgba(59,158,255,0.1);
      border-color: rgba(59,158,255,0.3);
      border-top-color: rgba(59,158,255,0.5);
      color: #60a5fa;
      box-shadow: 0 4px 12px rgba(59,158,255,0.1), inset 0 1px 0 rgba(59,158,255,0.15);
    }
    .indicator-btn.settings:hover {
      background: rgba(59,158,255,0.18);
      box-shadow: 0 0 16px rgba(59,158,255,0.25), inset 0 1px 0 rgba(59,158,255,0.2);
    }
    .indicator-btn.calc {
      background: rgba(247,147,26,0.1);
      border-color: rgba(247,147,26,0.3);
      border-top-color: rgba(247,147,26,0.5);
      color: #f7931a;
      box-shadow: 0 4px 12px rgba(247,147,26,0.1), inset 0 1px 0 rgba(247,147,26,0.15);
    }
    .indicator-btn.calc:hover {
      background: rgba(247,147,26,0.18);
      box-shadow: 0 0 16px rgba(247,147,26,0.25), inset 0 1px 0 rgba(247,147,26,0.2);
    }
    .indicator-btn.promo {
      background: rgba(14,203,129,0.1);
      border-color: rgba(14,203,129,0.3);
      border-top-color: rgba(14,203,129,0.5);
      color: #0ecb81;
      box-shadow: 0 4px 12px rgba(14,203,129,0.1), inset 0 1px 0 rgba(14,203,129,0.15);
    }
    .indicator-btn.promo:hover {
      background: rgba(14,203,129,0.18);
      box-shadow: 0 0 16px rgba(14,203,129,0.25), inset 0 1px 0 rgba(14,203,129,0.2);
    }
    .indicator-btn.news {
      background: rgba(245,158,11,0.1);
      border-color: rgba(245,158,11,0.3);
      border-top-color: rgba(245,158,11,0.5);
      color: #fbbf24;
      box-shadow: 0 4px 12px rgba(245,158,11,0.1), inset 0 1px 0 rgba(245,158,11,0.15);
    }
    .indicator-btn.news:hover {
      background: rgba(245,158,11,0.18);
      box-shadow: 0 0 16px rgba(245,158,11,0.25), inset 0 1px 0 rgba(245,158,11,0.2);
    }
    /* History table: kolom non-esensial disembunyikan di mobile — bisa diaktifkan
       lewat Setting > Kolom Riwayat (class hist-col-* di body) */
    .col-spread, .col-usdidr, .col-markup { }
    @media (max-width: 600px) {
      body:not(.hist-col-spread) .col-spread { display: none !important; }
      body:not(.hist-col-usdidr) .col-usdidr { display: none !important; }
      body:not(.hist-col-status) .col-markup { display: none !important; }
    }
    /* Menu Kolom Riwayat hanya relevan di mobile */
    @media (min-width: 769px) {
      #histColsRow { display: none !important; }
    }

    /* Promo Suggestions Modal */
    .promo-suggestions-overlay {
      display: none;
      position: fixed;
      top: 0; left: 0; right: 0; bottom: 0;
      background: rgba(0,0,0,0.55);
      z-index: 1000;
      align-items: center;
      justify-content: center;
    }
    .promo-suggestions-overlay.active { display: flex; }
    .promo-suggestions-modal {
      background: rgba(10,10,10,0.85);
      backdrop-filter: blur(24px);
      -webkit-backdrop-filter: blur(24px);
      border: 1px solid rgba(255,255,255,0.12);
      border-top: 1px solid rgba(255,255,255,0.22);
      border-radius: 20px;
      padding: 20px;
      width: 92%;
      max-width: 480px;
      max-height: 80vh;
      overflow-y: auto;
      box-shadow: 0 32px 80px rgba(0,0,0,0.6), inset 0 1px 0 rgba(255,255,255,0.08);
    }
    .promo-suggestions-modal h3 {
      margin: 0 0 14px 0;
      font-size: 1em;
      font-weight: 700;
      color: #fff;
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .promo-card {
      background: rgba(255,255,255,0.04);
      backdrop-filter: blur(10px);
      border: 1px solid rgba(255,255,255,0.1);
      border-top: 1px solid rgba(255,255,255,0.18);
      border-radius: 14px;
      padding: 12px 14px;
      margin-bottom: 10px;
      box-shadow: 0 4px 16px rgba(0,0,0,0.2), inset 0 1px 0 rgba(255,255,255,0.06);
      transition: background 0.2s;
    }
    .promo-card:hover {
      background: rgba(255,255,255,0.07);
    }
    .promo-card-code {
      font-size: 0.75em;
      font-weight: 800;
      color: #22c55e;
      letter-spacing: 0.05em;
      background: rgba(34,197,94,0.1);
      border: 1px solid rgba(34,197,94,0.3);
      border-radius: 6px;
      padding: 2px 8px;
      display: inline-block;
      margin-bottom: 6px;
    }
    .promo-card-name {
      font-size: 0.8em;
      font-weight: 700;
      color: #fff;
      margin-bottom: 4px;
    }
    .promo-card-desc {
      font-size: 0.72em;
      color: #9ca3af;
      margin-bottom: 6px;
    }
    .promo-card-meta {
      display: flex;
      gap: 10px;
      font-size: 0.68em;
      color: #6b7280;
    }
    .promo-card-meta span { display: flex; align-items: center; gap: 3px; }
    .promo-copy-btn {
      display: inline-flex;
      align-items: center;
      gap: 5px;
      background: rgba(34,197,94,0.1);
      border: 1px solid rgba(34,197,94,0.35);
      color: #22c55e;
      border-radius: 7px;
      padding: 4px 10px;
      font-size: 0.7em;
      font-weight: 700;
      cursor: pointer;
      transition: all 0.2s;
      font-family: inherit;
    }
    .promo-copy-btn:hover { background: rgba(34,197,94,0.2); }
    .promo-copy-btn.copied { background: rgba(34,197,94,0.85); color: #fff; border-color: rgba(34,197,94,0.9); }
    body.light-mode .promo-copy-btn { background: #dcfce7; border-color: #86efac; color: #15803d; }
    body.light-mode .promo-copy-btn.copied { background: #22c55e; color: #fff; border-color: #16a34a; }
    .promo-empty {
      text-align: center;
      color: #6b7280;
      font-size: 0.82em;
      padding: 20px 0;
    }
    .promo-modal-close {
      float: right;
      background: rgba(255,255,255,0.06);
      backdrop-filter: blur(8px);
      border: 1px solid rgba(255,255,255,0.12);
      border-top: 1px solid rgba(255,255,255,0.2);
      border-radius: 8px;
      color: #8b949e;
      width: 30px; height: 30px;
      display: inline-flex; align-items: center; justify-content: center;
      cursor: pointer; transition: all 0.25s; flex-shrink: 0;
      box-shadow: 0 2px 8px rgba(0,0,0,0.2), inset 0 1px 0 rgba(255,255,255,0.07);
    }
    .promo-modal-close:hover { background: rgba(255,77,77,0.15); color: #ff4d4d; border-color: rgba(255,77,77,0.3); box-shadow: 0 0 12px rgba(255,77,77,0.2); }
    .promo-last-update {
      font-size: 0.65em;
      color: #6b7280;
      margin-top: 10px;
      text-align: center;
    }
    /* News XAU/USD Modal */
    .news-card {
      background: rgba(255,255,255,0.04);
      backdrop-filter: blur(10px);
      border: 1px solid rgba(255,255,255,0.1);
      border-top: 1px solid rgba(255,255,255,0.18);
      border-radius: 14px;
      padding: 10px 14px;
      margin-bottom: 8px;
      box-shadow: 0 4px 14px rgba(0,0,0,0.2), inset 0 1px 0 rgba(255,255,255,0.06);
      transition: background 0.2s;
      display: flex;
      align-items: flex-start;
      gap: 10px;
    }
    .news-card.impact-high { border-left: 3px solid rgba(239,68,68,0.8); box-shadow: 0 4px 14px rgba(0,0,0,0.2), -2px 0 12px rgba(239,68,68,0.08), inset 0 1px 0 rgba(255,255,255,0.06); }
    .news-card.impact-medium { border-left: 3px solid rgba(247,147,26,0.8); box-shadow: 0 4px 14px rgba(0,0,0,0.2), -2px 0 12px rgba(247,147,26,0.08), inset 0 1px 0 rgba(255,255,255,0.06); }
    .news-card.impact-low { border-left: 3px solid rgba(107,114,128,0.6); }
    .news-card.past { background: rgba(255,255,255,0.02); opacity: 0.45; }
    .news-card.past .news-title { color: #9ca3af; }
    .news-card.upcoming { background: rgba(14,203,129,0.06); border-color: rgba(14,203,129,0.2); border-top-color: rgba(14,203,129,0.35); box-shadow: 0 4px 14px rgba(0,0,0,0.2), 0 0 16px rgba(14,203,129,0.06), inset 0 1px 0 rgba(14,203,129,0.08); }
    .news-countdown { background: rgba(14,203,129,0.15); color: #0ecb81; border-radius: 4px; padding: 1px 6px; font-size: 0.85em; font-weight: 600; white-space: nowrap; }
    .news-title-row { display: flex; align-items: center; justify-content: space-between; gap: 6px; margin-bottom: 3px; }
    .news-title { font-size: 0.82em; font-weight: 700; color: #fff; }
    .news-pred { font-size: 0.72em; font-weight: 700; padding: 2px 7px; border-radius: 4px; white-space: nowrap; flex-shrink: 0; }
    .news-pred.pred-up { background: rgba(14,203,129,0.18); color: #0ecb81; border: 1px solid rgba(14,203,129,0.3); }
    .news-pred.pred-down { background: rgba(246,70,93,0.15); color: #f6465d; border: 1px solid rgba(246,70,93,0.25); }
    .news-bulls { font-size: 1em; min-width: 44px; text-align: center; line-height: 1; padding-top: 2px; }
    .news-body { flex: 1; }
    .news-title { font-size: 0.82em; font-weight: 700; color: #fff; }
    .news-meta { font-size: 0.7em; color: #9ca3af; display: flex; gap: 8px; flex-wrap: wrap; }
    .news-meta span { display: flex; align-items: center; gap: 3px; }
    .news-values { font-size: 0.7em; color: #9ca3af; margin-top: 4px; display: flex; gap: 10px; flex-wrap: wrap; }
    .news-values .actual { color: #22c55e; font-weight: 700; }
    .news-section-label { font-size: 0.7em; font-weight: 700; color: #fbbf24; text-transform: uppercase; letter-spacing: 0.08em; margin: 12px 0 6px; }
    .news-empty { text-align: center; color: #6b7280; font-size: 0.85em; padding: 20px; }
    .news-past-toggle {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 6px;
      width: 100%;
      margin-top: 12px;
      padding: 7px 10px;
      background: rgba(255,255,255,0.04);
      border: 1px dashed rgba(255,255,255,0.15);
      border-radius: 10px;
      color: #8b949e;
      font-size: 0.72em;
      font-weight: 700;
      letter-spacing: 0.05em;
      cursor: pointer;
      transition: all 0.2s;
      font-family: inherit;
    }
    .news-past-toggle:hover { background: rgba(255,255,255,0.08); color: #d1d4dc; }
    body.light-mode .news-past-toggle { background: #f9fafb; border-color: #d1d5db; color: #6b7280; }
    body.light-mode .news-past-toggle:hover { background: #f3f4f6; color: #374151; }
    .news-filter-row { display: flex; gap: 6px; margin-bottom: 10px; flex-wrap: wrap; }
    .news-filter-btn { background: rgba(255,255,255,0.05); backdrop-filter: blur(8px); border: 1px solid rgba(255,255,255,0.1); border-top: 1px solid rgba(255,255,255,0.18); color: #9ca3af; border-radius: 8px; padding: 4px 10px; font-size: 0.72em; cursor: pointer; display: inline-flex; align-items: center; gap: 5px; font-weight: 600; transition: all 0.2s; box-shadow: 0 2px 8px rgba(0,0,0,0.15), inset 0 1px 0 rgba(255,255,255,0.06); }
    .news-filter-btn:hover { background: rgba(255,255,255,0.09); color: #d1d4dc; box-shadow: 0 0 10px rgba(255,255,255,0.05); }
    .news-filter-btn.active { background: rgba(247,147,26,0.1); border-color: rgba(247,147,26,0.3); border-top-color: rgba(247,147,26,0.5); color: #f7931a; box-shadow: 0 0 12px rgba(247,147,26,0.12), inset 0 1px 0 rgba(247,147,26,0.1); }

    /* Indicator Settings Modal */
    .indicator-settings-overlay {
      display: none;
      position: fixed;
      top: 0;
      left: 0;
      width: 100%;
      height: 100%;
      background: rgba(0,0,0,0.6);
      z-index: 9999;
      justify-content: center;
      align-items: center;
      padding: 20px;
    }
    .indicator-settings-overlay.active {
      display: flex;
    }
    .indicator-settings-modal {
      background: rgba(10,10,10,0.88);
      backdrop-filter: blur(28px);
      -webkit-backdrop-filter: blur(28px);
      border-radius: 20px;
      border: 1px solid rgba(247,147,26,0.2);
      border-top: 1px solid rgba(247,147,26,0.4);
      max-width: 500px;
      width: 100%;
      max-height: 90vh;
      overflow-y: auto;
      box-shadow: 0 32px 80px rgba(0,0,0,0.6), 0 0 40px rgba(247,147,26,0.05), inset 0 1px 0 rgba(247,147,26,0.12);
    }
    .indicator-settings-header {
      padding: 20px 24px;
      border-bottom: 1px solid rgba(255,255,255,0.07);
      display: flex;
      justify-content: space-between;
      align-items: center;
      position: sticky;
      top: 0;
      background: rgba(10,10,10,0.92);
      backdrop-filter: blur(20px);
      border-radius: 20px 20px 0 0;
    }
    .indicator-settings-header h3 {
      color: #f7931a;
      font-size: 1.1em;
      font-weight: 700;
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .indicator-settings-body {
      padding: 20px 24px;
    }
    .indicator-settings-body p.hint {
      color: #8b949e;
      font-size: 0.8em;
      margin-bottom: 16px;
    }
    .indicator-list {
      display: flex;
      flex-direction: column;
      gap: 10px;
    }
    .indicator-item {
      background: rgba(255,255,255,0.04);
      backdrop-filter: blur(10px);
      border: 1px solid rgba(255,255,255,0.1);
      border-top: 1px solid rgba(255,255,255,0.16);
      border-radius: 14px;
      padding: 14px 16px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      transition: all 0.25s;
      box-shadow: 0 4px 12px rgba(0,0,0,0.15), inset 0 1px 0 rgba(255,255,255,0.06);
    }
    .indicator-item:hover {
      background: rgba(255,255,255,0.08);
      border-color: rgba(255,255,255,0.18);
      box-shadow: 0 6px 16px rgba(0,0,0,0.2), inset 0 1px 0 rgba(255,255,255,0.09);
    }
    .indicator-item.active {
      border-color: rgba(34,197,94,0.35);
      border-top-color: rgba(34,197,94,0.55);
      background: rgba(34,197,94,0.07);
      box-shadow: 0 0 16px rgba(34,197,94,0.1), inset 0 1px 0 rgba(34,197,94,0.1);
    }
    .indicator-item-info {
      display: flex;
      align-items: center;
      gap: 12px;
    }
    .indicator-item-color {
      width: 12px;
      height: 12px;
      border-radius: 3px;
    }
    .indicator-item-details h5 {
      color: #e7e9ea;
      font-size: 0.9em;
      font-weight: 600;
      margin-bottom: 2px;
    }
    .indicator-item-details span {
      color: #8b949e;
      font-size: 0.75em;
    }
    .ind-rec-badge {
      font-size: 0.62em;
      font-weight: 700;
      color: #f7931a;
      background: rgba(247,147,26,0.12);
      border: 1px solid rgba(247,147,26,0.3);
      border-radius: 5px;
      padding: 2px 6px;
      margin-left: 7px;
      letter-spacing: 0.3px;
      text-transform: uppercase;
      vertical-align: 1px;
      white-space: nowrap;
    }
    body.light-mode .ind-rec-badge { background: #fff7ed; border-color: #fdba74; color: #c2700f; }
    .indicator-toggle {
      position: relative;
      width: 44px;
      height: 24px;
      background: rgba(255,255,255,0.1);
      backdrop-filter: blur(6px);
      border: 1px solid rgba(255,255,255,0.15);
      border-radius: 12px;
      cursor: pointer;
      transition: all 0.3s;
      box-shadow: inset 0 2px 6px rgba(0,0,0,0.3);
    }
    .indicator-toggle.active {
      background: rgba(34,197,94,0.8);
      border-color: rgba(34,197,94,0.6);
      box-shadow: 0 0 12px rgba(34,197,94,0.3), inset 0 2px 6px rgba(0,0,0,0.2);
    }
    .indicator-toggle::after {
      content: '';
      position: absolute;
      top: 2px;
      left: 2px;
      width: 20px;
      height: 20px;
      background: #fff;
      border-radius: 50%;
      transition: all 0.3s;
    }
    .indicator-toggle.active::after {
      left: 22px;
    }
    .indicator-settings-footer {
      padding: 16px 24px;
      border-top: 1px solid rgba(255, 255, 255, 0.1);
      display: flex;
      justify-content: flex-end;
      gap: 10px;
    }
    .indicator-settings-footer button {
      padding: 10px 20px;
      border-radius: 8px;
      font-size: 0.85em;
      font-weight: 600;
      cursor: pointer;
      transition: all 0.2s;
    }
    .indicator-settings-footer .cancel-btn {
      background: rgba(255,255,255,0.06);
      backdrop-filter: blur(10px);
      border: 1px solid rgba(255,255,255,0.12);
      border-top: 1px solid rgba(255,255,255,0.2);
      color: #8b949e;
      box-shadow: 0 4px 10px rgba(0,0,0,0.2), inset 0 1px 0 rgba(255,255,255,0.07);
    }
    .indicator-settings-footer .cancel-btn:hover {
      background: rgba(255,255,255,0.1);
      color: #e7e9ea;
      box-shadow: 0 0 12px rgba(255,255,255,0.06);
    }
    .indicator-settings-footer .apply-btn {
      background: rgba(247,147,26,0.15);
      backdrop-filter: blur(10px);
      border: 1px solid rgba(247,147,26,0.35);
      border-top: 1px solid rgba(247,147,26,0.55);
      color: #f7931a;
      box-shadow: 0 4px 14px rgba(247,147,26,0.15), inset 0 1px 0 rgba(247,147,26,0.15);
    }
    .indicator-settings-footer .apply-btn:hover {
      background: rgba(247,147,26,0.25);
      box-shadow: 0 0 18px rgba(247,147,26,0.25), inset 0 1px 0 rgba(247,147,26,0.2);
    }

    /* Indicator Guide Modal */
    .indicator-modal-overlay {
      display: none;
      position: fixed;
      top: 0;
      left: 0;
      width: 100%;
      height: 100%;
      background: rgba(0, 0, 0, 0.6);
      z-index: 9999;
      justify-content: center;
      align-items: center;
      padding: 20px;
      overflow-y: auto;
    }
    .indicator-modal-overlay.active {
      display: flex;
    }
    .indicator-modal {
      background: rgba(10,10,10,0.85);
      backdrop-filter: blur(24px);
      -webkit-backdrop-filter: blur(24px);
      border-radius: 20px;
      border: 1px solid rgba(247,147,26,0.2);
      border-top: 1px solid rgba(247,147,26,0.4);
      max-width: 600px;
      width: 100%;
      max-height: 90vh;
      overflow-y: auto;
      box-shadow: 0 32px 80px rgba(0,0,0,0.6), 0 0 40px rgba(247,147,26,0.05), inset 0 1px 0 rgba(247,147,26,0.12);
    }
    .indicator-modal-header {
      padding: 20px 24px;
      border-bottom: 1px solid rgba(255, 255, 255, 0.08);
      display: flex;
      justify-content: space-between;
      align-items: center;
      position: sticky;
      top: 0;
      background: rgba(10,10,10,0.9);
      backdrop-filter: blur(20px);
      border-radius: 20px 20px 0 0;
    }
    .indicator-modal-header h3 {
      color: #f7931a;
      font-size: 1.1em;
      font-weight: 700;
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .indicator-modal-close {
      background: rgba(255, 255, 255, 0.08);
      border: 1px solid rgba(255,255,255,0.1);
      color: #8b949e;
      display: inline-flex; align-items: center; justify-content: center;
      width: 32px;
      height: 32px;
      border-radius: 8px;
      cursor: pointer;
      font-size: 1.2em;
      transition: all 0.2s;
    }
    .indicator-modal-close:hover {
      background: rgba(255, 77, 77, 0.2);
      color: #ff4d4d;
    }
    .indicator-modal-body {
      padding: 20px 24px;
    }
    .indicator-section {
      margin-bottom: 24px;
    }
    .indicator-section:last-child {
      margin-bottom: 0;
    }
    .indicator-section h4 {
      color: #ffffff;
      font-size: 0.95em;
      font-weight: 600;
      margin-bottom: 12px;
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .indicator-section h4 .badge {
      font-size: 0.7em;
      padding: 3px 8px;
      border-radius: 4px;
      font-weight: 500;
    }
    .indicator-section h4 .badge.ma { background: rgba(33, 150, 243, 0.2); color: #2196F3; }
    .indicator-section h4 .badge.ema { background: rgba(0, 188, 212, 0.2); color: #00BCD4; }
    .indicator-section h4 .badge.bb { background: rgba(156, 39, 176, 0.2); color: #9C27B0; }
    .indicator-section h4 .badge.vwap { background: rgba(255, 152, 0, 0.2); color: #FF9800; }
    .indicator-section h4 .badge.rsi { background: rgba(233, 30, 99, 0.2); color: #E91E63; }
    .indicator-section h4 .badge.macd { background: rgba(76, 175, 80, 0.2); color: #4CAF50; }
    .indicator-section h4 .badge.stoch { background: rgba(255, 87, 34, 0.2); color: #FF5722; }
    .indicator-section h4 .badge.atr { background: rgba(121, 85, 72, 0.2); color: #8D6E63; }
    .indicator-section h4 .badge.vol { background: rgba(96, 125, 139, 0.2); color: #78909C; }
    .indicator-section h4 .badge.ichimoku { background: rgba(103, 58, 183, 0.2); color: #7C4DFF; }
    .no-indicator-msg {
      text-align: center;
      padding: 40px 20px;
      color: #8b949e;
    }
    .no-indicator-msg svg {
      width: 48px;
      height: 48px;
      margin-bottom: 12px;
      opacity: 0.5;
    }
    .no-indicator-msg p {
      font-size: 0.9em;
    }

    /* Gold Calculator Button */
    .calc-gold-btn {
      background: linear-gradient(135deg, #f7931a 0%, #e8850a 100%);
      color: #fff;
      border: none;
      border-radius: 8px;
      padding: 6px 14px;
      font-size: 0.75em;
      font-weight: 600;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      gap: 6px;
      margin-left: 12px;
      transition: all 0.2s ease;
      box-shadow: 0 2px 8px rgba(247, 147, 26, 0.3);
      vertical-align: middle;
    }
    .calc-gold-btn:hover {
      transform: translateY(-1px);
      box-shadow: 0 4px 12px rgba(247, 147, 26, 0.4);
    }

    /* Gold Calculator Modal */
    .calc-modal-overlay {
      display: none;
      position: fixed;
      top: 0;
      left: 0;
      width: 100%;
      height: 100%;
      background: rgba(0, 0, 0, 0.6);
      z-index: 9999;
      justify-content: center;
      align-items: center;
      padding: 20px;
    }
    .calc-modal-overlay.active {
      display: flex;
    }
    .calc-modal {
      background: rgba(10,10,10,0.88);
      backdrop-filter: blur(28px);
      -webkit-backdrop-filter: blur(28px);
      border-radius: 24px;
      border: 1px solid rgba(247,147,26,0.2);
      border-top: 1px solid rgba(247,147,26,0.45);
      max-width: 420px;
      width: 100%;
      box-shadow: 0 32px 80px rgba(0,0,0,0.6), 0 0 40px rgba(247,147,26,0.06), inset 0 1px 0 rgba(247,147,26,0.15);
      overflow: hidden;
    }
    .calc-modal-header {
      padding: 20px 24px;
      border-bottom: 1px solid rgba(255, 255, 255, 0.07);
      display: flex;
      justify-content: space-between;
      align-items: center;
      background: rgba(247, 147, 26, 0.07);
    }
    .calc-modal-header h3 {
      color: #f7931a;
      font-size: 1.1em;
      font-weight: 700;
      display: flex;
      align-items: center;
      gap: 10px;
    }
    .calc-modal-body {
      padding: 24px;
    }
    .calc-input-group {
      margin-bottom: 20px;
    }
    .calc-input-group label {
      display: block;
      color: #8b949e;
      font-size: 0.85em;
      margin-bottom: 8px;
      font-weight: 500;
    }
    .calc-input-group input, .calc-input-group select {
      width: 100%;
      padding: 14px 16px;
      border-radius: 12px;
      border: 1px solid rgba(255,255,255,0.1);
      border-top: 1px solid rgba(255,255,255,0.18);
      background: rgba(255,255,255,0.05);
      backdrop-filter: blur(8px);
      color: #e7e9ea;
      font-size: 1em;
      transition: all 0.25s;
      box-shadow: inset 0 2px 8px rgba(0,0,0,0.2);
    }
    .calc-input-group input:focus, .calc-input-group select:focus {
      outline: none;
      border-color: rgba(247,147,26,0.5);
      border-top-color: rgba(247,147,26,0.7);
      background: rgba(247,147,26,0.07);
      box-shadow: 0 0 16px rgba(247,147,26,0.1), inset 0 2px 8px rgba(0,0,0,0.15);
    }
    .calc-input-group input::placeholder {
      color: #6e7681;
    }
    .calc-tabs {
      display: flex;
      gap: 8px;
      margin-bottom: 20px;
    }
    .calc-tab {
      flex: 1;
      padding: 12px;
      border: 1px solid rgba(255,255,255,0.1);
      border-top: 1px solid rgba(255,255,255,0.18);
      background: rgba(255,255,255,0.04);
      backdrop-filter: blur(8px);
      color: #8b949e;
      border-radius: 10px;
      cursor: pointer;
      font-size: 0.85em;
      font-weight: 600;
      transition: all 0.25s;
      text-align: center;
      box-shadow: 0 2px 8px rgba(0,0,0,0.15), inset 0 1px 0 rgba(255,255,255,0.06);
    }
    .calc-tab:hover {
      background: rgba(255,255,255,0.08);
      color: #c4d0df;
    }
    .calc-tab.active {
      background: rgba(247,147,26,0.12);
      border-color: rgba(247,147,26,0.35);
      border-top-color: rgba(247,147,26,0.55);
      color: #f7931a;
      box-shadow: 0 0 14px rgba(247,147,26,0.15), inset 0 1px 0 rgba(247,147,26,0.15);
    }
    .calc-result {
      background: rgba(34,197,94,0.07);
      backdrop-filter: blur(12px);
      border: 1px solid rgba(34,197,94,0.25);
      border-top: 1px solid rgba(34,197,94,0.45);
      border-radius: 14px;
      padding: 16px;
      text-align: center;
      box-shadow: 0 0 20px rgba(34,197,94,0.08), inset 0 1px 0 rgba(34,197,94,0.12);
    }
    .calc-result-label {
      color: #8b949e;
      font-size: 0.8em;
      margin-bottom: 6px;
    }
    .calc-result-value {
      color: #22c55e;
      font-size: 1.5em;
      font-weight: 700;
    }
    .calc-result-sub {
      color: #8b949e;
      font-size: 0.8em;
      margin-top: 8px;
    }
    .calc-btn {
      width: 100%;
      padding: 14px;
      background: linear-gradient(135deg, #f7931a 0%, #e8850a 100%);
      border: none;
      border-radius: 12px;
      color: #fff;
      font-size: 1em;
      font-weight: 600;
      cursor: pointer;
      margin-top: 16px;
      transition: all 0.2s;
    }
    .calc-btn:hover {
      transform: translateY(-2px);
      box-shadow: 0 4px 15px rgba(247, 147, 26, 0.4);
    }
    .calc-current-price {
      background: rgba(255, 255, 255, 0.03);
      border-radius: 10px;
      padding: 12px;
      margin-bottom: 20px;
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    .calc-current-price span:first-child {
      color: #8b949e;
      font-size: 0.85em;
    }
    .calc-current-price span:last-child {
      color: #f7931a;
      font-weight: 600;
    }
    .calc-price-toggle {
      display: flex;
      gap: 10px;
      margin-bottom: 20px;
    }
    .calc-price-option {
      flex: 1;
      background: rgba(255, 255, 255, 0.03);
      border: 2px solid rgba(255, 255, 255, 0.1);
      border-radius: 12px;
      padding: 14px;
      cursor: pointer;
      transition: all 0.2s;
      text-align: center;
    }
    .calc-price-option:hover {
      background: rgba(255, 255, 255, 0.06);
    }
    .calc-price-option.active {
      border-color: #f7931a;
      background: rgba(247, 147, 26, 0.1);
    }
    .calc-price-option .price-label {
      display: block;
      color: #8b949e;
      font-size: 0.75em;
      margin-bottom: 4px;
    }
    .calc-price-option.active .price-label {
      color: #f7931a;
    }
    .calc-price-option .price-value {
      display: block;
      color: #e7e9ea;
      font-size: 1em;
      font-weight: 700;
    }
    .calc-price-option.active .price-value {
      color: #f7931a;
    }

    .indicator-desc {
      color: #8b949e;
      font-size: 0.85em;
      line-height: 1.6;
      margin-bottom: 12px;
    }
    .indicator-signals {
      background: rgba(255, 255, 255, 0.03);
      border-radius: 10px;
      padding: 12px;
    }
    .signal-item {
      display: flex;
      align-items: flex-start;
      gap: 10px;
      padding: 8px 0;
      border-bottom: 1px solid rgba(255, 255, 255, 0.05);
    }
    .signal-item:last-child {
      border-bottom: none;
      padding-bottom: 0;
    }
    .signal-item:first-child {
      padding-top: 0;
    }
    .signal-icon {
      width: 24px;
      height: 24px;
      border-radius: 6px;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 0.75em;
      flex-shrink: 0;
    }
    .signal-icon.buy { background: rgba(34, 197, 94, 0.2); color: #22c55e; }
    .signal-icon.sell { background: rgba(239, 68, 68, 0.2); color: #ef4444; }
    .signal-icon.info { background: rgba(59, 130, 246, 0.2); color: #3b82f6; }
    .signal-icon.warn { background: rgba(251, 191, 36, 0.2); color: #fbbf24; }
    .signal-text {
      flex: 1;
    }
    .signal-text strong {
      color: #e7e9ea;
      font-size: 0.85em;
    }
    .signal-text p {
      color: #8b949e;
      font-size: 0.8em;
      margin-top: 2px;
    }

    /* History Table */
    .history-table-wrap { overflow-x: auto; }
    .history-section {
      background: #0d0d0d;
      border-radius: 4px;
      border: 1px solid rgba(255,255,255,0.07);
      overflow: hidden;
      box-shadow: 0 4px 24px rgba(0,0,0,0.3);
      transition: border-color 0.3s ease;
    }
    .history-header {
      padding: 14px 20px;
      background: #0a0a0a;
      border-bottom: 1px solid rgba(255,255,255,0.06);
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    .history-header h2 {
      font-size: 0.88em;
      font-weight: 700;
      color: #e7e9ea;
      letter-spacing: -0.01em;
    }
    .history-header .count {
      font-size: 0.7em;
      color: #6b7280;
      font-weight: 500;
    }
    .history-table {
      width: 100%;
      border-collapse: collapse;
    }
    .history-table th {
      text-align: left;
      padding: 8px 8px;
      font-size: 0.72em;
      color: #ffffff;
      opacity: 0.6;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      background: rgba(255,255,255,0.04);
      font-weight: 600;
      white-space: nowrap;
      border-bottom: 1px solid rgba(255,255,255,0.08);
    }
    .history-table td {
      padding: 9px 8px;
      font-size: 0.85em;
      border-bottom: 1px solid rgba(255,255,255,0.04);
      color: var(--text-heading);
      white-space: nowrap;
      font-family: 'JetBrains Mono', monospace;
      vertical-align: top;
    }
    .history-table tr:last-child td {
      border-bottom: none;
    }
    .history-table tr:hover {
      background: rgba(255,255,255,0.04);
    }
    .history-table .price-up { color: #4ade80; font-weight: 600; }
    .history-table .price-down { color: #f87171; font-weight: 600; }
    .history-table .time-col { color: var(--text-heading); font-family: 'JetBrains Mono', monospace; font-size: 0.9em; text-align: left; }
    .history-time { display: block; }
    .history-date { display: block; font-size: 0.72em; color: var(--text-primary); text-align: left; margin-top: 2px; white-space: nowrap; }
    .col-markup { text-align: left; white-space: nowrap; }
    .markup-badge { display: inline-flex; align-items: center; gap: 3px; font-size: 0.72em; font-weight: 600; padding: 1px 5px; border-radius: 4px; white-space: nowrap; }
    .markup-normal { background: rgba(34,197,94,0.08); color: #4ade80; border: 1px solid rgba(34,197,94,0.25); border-top-color: rgba(34,197,94,0.4); box-shadow: 0 0 8px rgba(34,197,94,0.1); backdrop-filter: blur(8px); }
    .markup-abnormal { background: rgba(245,158,11,0.08); color: #fbbf24; border: 1px solid rgba(245,158,11,0.25); border-top-color: rgba(245,158,11,0.4); box-shadow: 0 0 8px rgba(245,158,11,0.1); backdrop-filter: blur(8px); }
    .history-table th.th-nominal { text-align: right; }
    .history-table td.td-nominal { text-align: right; vertical-align: top; }
    .history-table td.td-nominal .nom-gram { display: block; color: var(--text-primary); font-size: 0.8em; }
    .history-table td.td-nominal br { display: none; }
    .history-table td.td-nominal small { display: block; }
    .history-table .no-data {
      text-align: center;
      color: #8b949e;
      padding: 50px 20px;
      font-size: 0.95em;
    }
    .history-pagination {
      display: flex;
      justify-content: center;
      align-items: center;
      gap: 12px;
      padding: 14px 20px;
      border-top: 1px solid rgba(255,255,255,0.06);
      background: #0a0a0a;
    }
    .page-btn {
      background: rgba(255,255,255,0.04);
      color: #d1d5db;
      border: 1px solid rgba(255,255,255,0.1);
      padding: 8px 18px;
      border-radius: 8px;
      cursor: pointer;
      font-size: 0.85em;
      font-weight: 600;
      transition: background 0.15s, color 0.15s, border-color 0.15s;
      font-family: inherit;
    }
    .page-btn:hover:not(:disabled) {
      background: rgba(247,147,26,0.1);
      border-color: rgba(247,147,26,0.35);
      color: #f7931a;
    }
    .page-btn:disabled { opacity: 0.25; cursor: not-allowed; }
    .page-info { color: #6b7280; font-size: 0.85em; font-weight: 500; }

    /* Animations - color based on price direction */
    .price-card.updated-up {
      animation: highlight-up 0.8s ease-out 1;
    }
    .price-card.updated-up .value {
      animation: value-up 0.8s ease-out 1;
    }
    .price-card.updated-down {
      animation: highlight-down 0.8s ease-out 1;
    }
    .price-card.updated-down .value {
      animation: value-down 0.8s ease-out 1;
    }
    .updated { animation: highlight 0.3s ease-out 1; }

    @keyframes highlight-up {
      0%, 30% {
        background: linear-gradient(145deg, rgba(74, 222, 128, 0.25), rgba(74, 222, 128, 0.1));
        box-shadow: 0 0 30px rgba(74, 222, 128, 0.25);
      }
      100% {
        background: rgba(20, 26, 34, 0.6);
        box-shadow: none;
      }
    }
    @keyframes highlight-down {
      0%, 30% {
        background: linear-gradient(145deg, rgba(248, 113, 113, 0.25), rgba(248, 113, 113, 0.1));
        box-shadow: 0 0 30px rgba(248, 113, 113, 0.25);
      }
      100% {
        background: rgba(20, 26, 34, 0.6);
        box-shadow: none;
      }
    }
    @keyframes highlight {
      0% { background: rgba(247, 147, 26, 0.25); }
      100% { background: transparent; }
    }
    @keyframes rowBlink {
      0%, 100% { background: transparent; }
      20% { background: rgba(247, 147, 26, 0.22); box-shadow: inset 0 0 0 1px rgba(247,147,26,0.35); }
      50% { background: rgba(247, 147, 26, 0.08); }
      70% { background: rgba(247, 147, 26, 0.18); box-shadow: inset 0 0 0 1px rgba(247,147,26,0.28); }
    }
    .history-new-row { animation: rowBlink 0.7s ease-in-out 4; }

    /* Responsive - Tablet */
    @media (max-width: 768px) {
      body { padding: 12px; }
      .container { max-width: 100%; }
      /* nominal-settings-btn already visible from base style */
      .header {
        height: 42px;
        padding: 0 8px;
        gap: 6px;
        margin-bottom: 10px;
        border-radius: 4px;
      }
      .header-search-wrap { max-width: 110px; padding: 4px 8px; font-size: 0.75em; }
      .nav-icon-btn { width: 28px; height: 28px; }
      .header-logo { width: 28px; height: 28px; border-radius: 6px; }
      .chart-section { margin-bottom: 16px; border-radius: 4px 4px 0 0; }
      .chart-header { padding: 10px 14px; gap: 6px; border-radius: 4px 4px 0 0; }
      .chart-stats { gap: 6px; }
      .chart-info-row { padding: 8px 12px; margin-top: 8px; border-radius: 4px; }
      .info-time { font-size: 1.2em; }
      .info-date { font-size: 0.75em; }
      .stat-item { padding: 8px 12px; border-radius: 4px; column-gap: 7px; row-gap: 1px; }
      .stat-item .stat-label { font-size: 0.58em; }
      .stat-item .stat-value { font-size: 0.95em; }
      .stat-item .stat-change { font-size: 0.62em; padding: 1px 6px; }
      /* Mobile: kartu seragam — 2 per baris, lebar sama */
      .chart-stats > .stat-item { flex: 1 1 calc(50% - 6px); width: auto; min-width: 0; }
      .tradingview-widget-container { height: 400px; }
      .history-section { border-radius: 4px; }
      .history-header { padding: 12px 16px; }
      .history-table th { padding: 8px; font-size: 0.68em; }
      .history-table td { padding: 10px 8px; font-size: 0.82em; }
      .history-pagination { padding: 12px; gap: 10px; }
      .page-btn { padding: 7px 14px; font-size: 0.82em; }
    }

    /* Responsive - Mobile */
    @media (max-width: 480px) {
      body { padding: 10px; }
      .header {
        height: 40px;
        padding: 0 6px;
        gap: 5px;
        margin-bottom: 10px;
        border-radius: 4px;
      }
      .header-search-wrap { max-width: 90px; padding: 4px 7px; }
      .nav-icon-btn { width: 26px; height: 26px; }
      .header-logo { width: 26px; height: 26px; }
      .stat-item.clock-item { min-width: 110px; }
      .stat-item.clock-item .clock-time { font-size: 0.95em; }
      .stat-item.clock-item .clock-date { font-size: 0.6em; }

      .chart-section {
        margin-bottom: 14px;
        border-radius: 12px;
      }
      .chart-info-row { padding: 6px 10px; margin-top: 6px; border-radius: 8px; }
      .info-time { font-size: 1.1em; }
      .info-date { font-size: 0.7em; }
      .chart-header { padding: 10px 12px; gap: 6px; border-radius: 12px 12px 0 0; }
      .chart-title { gap: 8px; }
      .chart-header h2 { font-size: 0.9em; }
      .live-badge { font-size: 0.6em; padding: 3px 8px; }
      /* Mobile: grid 2 kolom untuk stat cards */
      .chart-stats {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 5px;
        padding: 0 8px;
      }
      .chart-stats > .stat-item:not(.invest) {
        padding: 4px 8px;
        border-radius: 7px;
        min-width: 0;
        overflow: hidden;
        column-gap: 5px;
        row-gap: 0;
      }
      .chart-stats > .stat-item:not(.invest) .stat-label { font-size: 0.5em; flex: 0 0 100%; }
      .chart-stats > .stat-item:not(.invest) .stat-value { font-size: 0.72em; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .chart-stats > .stat-item:not(.invest) .stat-change { font-size: 0.52em; padding: 1px 4px; min-height: 1.3em; }
      #buyCard .stat-value, #sellCard .stat-value { white-space: nowrap; overflow: hidden; }
      /* Titik ON: sembunyikan teks "harga beli" di mobile agar nilai (Rp ...) tampil penuh */
      #lowestOnCard .stat-change { display: none; }
      #lowestOnCard .stat-value { flex: 1; text-align: center; overflow: visible; }
      /* Center badge when alone in last row of 2-col grid (set via JS) */
      .chart-stats > .stat-item.stat-alone { grid-column: 1 / -1; justify-self: center; width: calc(50% - 2px); }
      .tradingview-widget-container { height: 350px; }

      /* Mobile: invest stats wrap */
      .invest-stats {
        overflow-x: hidden;
        align-items: flex-start;
        padding: 4px 12px 8px;
        gap: 6px;
      }
      #investStatsList {
        flex: 1;
        display: grid;
        gap: 5px;
        min-width: 0;
      }
      /* 1 nominal → tunggal, di tengah */
      #investStatsList.nom-1 {
        grid-template-columns: 1fr;
        justify-items: center;
      }
      /* 1 nominal: chip menyesuaikan lebar konten & di tengah (hindari +Rp terpotong) */
      #investStatsList.nom-1 .stat-item.invest { width: auto; max-width: 100%; justify-content: center; gap: 6px; }
      /* 2 nominal → kiri-kanan, berapa pun nominalnya */
      #investStatsList.nom-2 { grid-template-columns: 1fr 1fr; }
      /* >2 nominal → grid 2 kolom, item ganjil terakhir penuh & di tengah */
      #investStatsList.nom-many { grid-template-columns: 1fr 1fr; }
      #investStatsList.nom-many .stat-item.invest:last-child:nth-child(odd) {
        grid-column: 1 / -1;
        justify-self: center;
        width: calc(50% - 2.5px);
      }
      .invest-stats .stat-item.invest {
        flex: unset;
        flex-direction: row;
        align-items: center;
        justify-content: space-between;
        width: 100%;
        padding: 4px 6px;
        gap: 2px;
        min-width: 0;
        overflow: visible;
      }
      .invest-stats .stat-item.invest .stat-label {
        font-size: 0.5em;
        font-weight: 700;
        color: #f7931a;
        flex-shrink: 0;
      }
      /* Gram tampil penuh (tanpa ellipsis), font dikecilkan agar muat bersama +Rp */
      .invest-stats .stat-item.invest .stat-value {
        font-size: 0.5em;
        font-weight: 600;
        color: #eef3fa;
        white-space: nowrap;
        overflow: visible;
        flex: 0 1 auto;
        text-align: center;
      }
      /* +Rp tampil penuh */
      .invest-stats .stat-item.invest .stat-change {
        font-size: 0.5em;
        padding: 1px 3px;
        align-self: center;
        margin-top: 0;
        flex-shrink: 0;
        white-space: nowrap;
      }
      .nominal-settings-btn { width: 26px; height: 26px; border-radius: 6px; }
      #historyFontSettingsBtn { display: flex; }
      .nominal-settings-btn svg { width: 12px; height: 12px; }

      /* Responsive buttons */
      .chart-bottom-row {
        flex-direction: row;
        gap: 6px;
        margin-top: 4px;
        align-items: center;
        justify-content: center;
      }
      .indicator-btn {
        padding: 3px 8px;
        font-size: 0.58em;
      }

      .history-section { border-radius: 4px; margin-top: 0; }
      .history-header { padding: 10px 14px; flex-wrap: wrap; gap: 6px; }
      .history-header h2 { font-size: 0.82em; }
      .history-header h2 svg { width: 11px; height: 11px; }
      .history-header > div { gap: 6px; }
      /* Mobile card layout */
      .history-table-wrap { overflow-x: auto; -webkit-overflow-scrolling: touch; }
      .history-table { display: block; min-width: max-content; width: 100%; }
      .history-table thead, .history-table tbody { display: block; min-width: max-content; }
      .history-table thead tr { background: rgba(0,0,0,0.2); border-bottom: 1px solid rgba(255,255,255,0.07); }
      body.light-mode .history-table thead tr { background: #fff; border-bottom: 1px solid #e0e0e0; }
      .history-table tr {
        display: flex;
        flex-direction: row;
        align-items: center;
        gap: 0 4px;
        padding: 2px 8px;
        border-bottom: 1px solid rgba(255,255,255,0.05);
      }
      .history-table th { display: block; border: none; padding: 0; font-size: 0.55em; color: #8b949e; text-transform: uppercase; letter-spacing: 0.3px; font-weight: 600; white-space: nowrap; }
      .history-table th:first-child { width: 72px; flex-shrink: 0; }
      .history-table th:nth-child(2) { min-width: 105px; flex: 0 0 auto; }
      .history-table th:nth-child(3) { min-width: 100px; flex: 0 0 auto; }
      .history-table th.th-nominal { width: 72px; flex: 0 0 72px; text-align: right; }
      body:not(.hist-col-spread) .history-table th.col-spread { display: none; }
      body:not(.hist-col-usdidr) .history-table th.col-usdidr { display: none; }
      body:not(.hist-col-status) .history-table th.col-markup { display: none; }
      .history-table th.col-spread, .history-table th.col-usdidr, .history-table th.col-markup { min-width: 62px; flex: 0 0 auto; }
      .history-table td { display: block; border: none; padding: 0; font-size: 0.65em; white-space: nowrap; }
      .history-table td.time-col { color: #9ca3af; font-size: 0.62em; width: 72px; flex-shrink: 0; overflow: hidden; }
      .history-table td:nth-child(2) { font-weight: 700; min-width: 105px; flex: 0 0 auto; }
      .history-table td:nth-child(3) { color: #9ca3af; min-width: 100px; flex: 0 0 auto; }
      .history-table td.td-nominal { font-size: 0.62em; width: 72px; flex: 0 0 72px; text-align: right; display: flex; flex-direction: column; align-items: stretch; line-height: 1.3; }
      .history-table td.td-nominal .nom-gram { color: var(--text-primary); font-size: 0.9em; width: 100%; text-align: right; }
      .history-table td.td-nominal br { display: none; }
      .history-table td.td-nominal small { display: block; width: 100%; text-align: right; }
      body:not(.hist-col-spread) .history-table td.col-spread { display: none; }
      body:not(.hist-col-usdidr) .history-table td.col-usdidr { display: none; }
      body:not(.hist-col-status) .history-table td.col-markup { display: none; }
      .history-table td.col-spread, .history-table td.col-usdidr, .history-table td.col-markup { min-width: 62px; flex: 0 0 auto; font-size: 0.62em; }
      .history-pagination { padding: 10px 12px; gap: 8px; flex-wrap: wrap; }
      .page-btn { padding: 7px 12px; font-size: 0.8em; }
      .page-info { font-size: 0.78em; }
      /* Chat modal responsive */
      #chatModal .promo-suggestions-modal { width: 98%; max-width: 100%; height: 90vh; max-height: 90vh; border-radius: 12px; padding: 14px; }
      #chatModal .promo-suggestions-modal h3 { font-size: 0.9em; gap: 6px; }
      #chatInput { font-size: 0.85em; padding: 9px 10px; }
    }

    /* Extra small screens */
    @media (max-width: 360px) {
      body { padding: 8px; }
      .header { padding: 8px 10px; margin-bottom: 8px; }
      .header-left h1 { font-size: 0.85em; }
      .clock { font-size: 1.1em; }
      .chart-header { padding: 10px 12px; gap: 8px; }
      .chart-header h2 { font-size: 0.9em; }
      .stat-item { padding: 6px 10px; gap: 4px; }
      .stat-item .stat-label { font-size: 0.6em; }
      .stat-item .stat-value { font-size: 0.85em; }
      .stat-item .stat-change { font-size: 0.5em; }
      .tradingview-widget-container { height: 280px; }
      .history-table th, .history-table td { padding: 4px 6px; }
    }

    /* Mobile Landscape - kotak Beli/Jual lebih besar */
    @media (orientation: landscape) and (max-height: 500px) {
      #buyCard .stat-label, #sellCard .stat-label { font-size: 0.82em; }
      #buyCard .stat-value:not([style*="font-size"]), #sellCard .stat-value:not([style*="font-size"]) { font-size: 1.15em; white-space: nowrap; }
      #buyCard .stat-change:not([style*="font-size"]), #sellCard .stat-change:not([style*="font-size"]) { font-size: 0.72em; }
      .chart-stats > .stat-item:not(.invest) { padding: 10px 16px; gap: 8px; border-radius: 10px; }
      .chart-stats > .stat-item:not(.invest) .stat-label { font-size: 0.82em; }
      .chart-stats > .stat-item:not(.invest) .stat-value:not([style*="font-size"]) { font-size: 1.15em; }
      .chart-stats > .stat-item:not(.invest) .stat-change:not([style*="font-size"]) { font-size: 0.72em; padding: 2px 6px; }
    }

    /* Transisi smooth saat ganti mode (elemen yang belum punya transition) */
    .chart-info-row, .price-high-overlay, .price-low-overlay, .markup-overlay, .spread-overlay,
    .limit-label, .promo-status-badge, .history-table th, .history-table td, .history-section,
    .news-card, .promo-card, .invest-stats .stat-item, .info-time, .info-date, .stat-label,
    .stat-value, .stat-change, .markup-overlay-text, .spread-overlay-text, .price-highlow-text,
    .count, .page-btn, .page-info {
      transition: background-color 0.35s ease, border-color 0.35s ease, color 0.35s ease;
    }

    /* Matikan glow blob, backdrop-filter, text-shadow, glow animations di light mode */
    body.light-mode::before, body.light-mode::after { display: none; }
    body.light-mode *, body.light-mode *::before, body.light-mode *::after { backdrop-filter: none !important; -webkit-backdrop-filter: none !important; text-shadow: none !important; }

    /* Subtle light shadow untuk container non-glow */
    body.light-mode .chart-section { box-shadow: 0 1px 6px rgba(0,0,0,0.07); }
    body.light-mode .header { box-shadow: 0 1px 6px rgba(0,0,0,0.07); }
    body.light-mode .stat-item { box-shadow: 0 1px 4px rgba(0,0,0,0.06); }
    body.light-mode .history-section { box-shadow: 0 1px 6px rgba(0,0,0,0.07); }
    /* Glow aktif: border warna penuh (merah/hijau) + ring tipis, tanpa dark shadow & animasi */
    body.light-mode .glow-up { border-color: #22c55e !important; box-shadow: 0 0 0 1px rgba(34,197,94,0.45), 0 1px 6px rgba(0,0,0,0.06) !important; animation: none !important; }
    body.light-mode .glow-down { border-color: #ef4444 !important; box-shadow: 0 0 0 1px rgba(239,68,68,0.45), 0 1px 6px rgba(0,0,0,0.06) !important; animation: none !important; }
    body.light-mode .updated-up, body.light-mode .updated-down, body.light-mode .updated { box-shadow: none !important; animation: none !important; }
    body.light-mode .nominal-modal, body.light-mode .promo-suggestions-modal,
    body.light-mode .calc-modal, body.light-mode .indicator-modal,
    body.light-mode .indicator-settings-modal, body.light-mode .confirm-box,
    body.light-mode .toast, body.light-mode .notif-banner,
    body.light-mode .sound-panel { box-shadow: 0 4px 16px rgba(0,0,0,0.1) !important; }
    body.light-mode .indicator-btn { box-shadow: none !important; }
    body.light-mode .nav-icon-btn { color: #6b7280; }
    body.light-mode .nav-icon-btn:hover { background: rgba(0,0,0,0.06); color: #374151; }
    body.light-mode .nav-menu-dropdown { background: #ffffff; border-color: rgba(0,0,0,0.1); box-shadow: 0 8px 24px rgba(0,0,0,0.15); }
    body.light-mode .nav-menu-item { color: #374151; }
    body.light-mode .nav-menu-item:hover { background: rgba(0,0,0,0.05); color: #111827; }
    body.light-mode .nav-menu-divider { background: rgba(0,0,0,0.1); }
    body.light-mode .nav-menu-logout { color: #dc2626; }
    body.light-mode .header-search-wrap { background: rgba(0,0,0,0.05); border-color: rgba(0,0,0,0.12); }
    body.light-mode #soundToggle svg { color: #15803d; }
    body.light-mode #soundToggle.partial svg { color: #b45309; }
    body.light-mode #soundToggle.off svg { color: #dc2626; }

    /* History mode select — dark mode default */
    #historyModeSelect {
      background: #22272e;
      border: 1px solid rgba(255,255,255,0.15);
      border-radius: 7px;
      padding: 3px 8px;
      color: #e6edf3;
      font-size: 0.75em;
      cursor: pointer;
      outline: none;
      -webkit-appearance: auto;
      appearance: auto;
    }
    #historyModeSelect option {
      background: #22272e;
      color: #e6edf3;
    }
    body.light-mode #historyModeSelect {
      background: #fff !important;
      border-color: #d1d5db !important;
      color: #374151 !important;
    }
    body.light-mode #historyModeSelect option {
      background: #fff !important;
      color: #374151 !important;
    }
    /* Mobile: sembunyikan select, tampilkan badge button */
    #historyModeMobileWrap { display: none; position: relative; }
    #historyModeMobileBtn {
      display: inline-flex;
      align-items: center;
      gap: 3px;
      padding: 3px 8px;
      border-radius: 7px;
      border: 1px solid rgba(255,255,255,0.15);
      background: rgba(255,255,255,0.08);
      color: var(--text-primary, #e6edf3);
      font-size: 0.72em;
      cursor: pointer;
      white-space: nowrap;
    }
    body.light-mode #historyModeMobileBtn {
      background: #fff !important;
      border-color: #d1d5db !important;
      color: #374151 !important;
    }
    .hist-mode-dropdown {
      display: none;
      position: absolute;
      top: calc(100% + 4px);
      left: 0;
      z-index: 60;
      min-width: 130px;
      background: #1c2128;
      border: 1px solid rgba(255,255,255,0.12);
      border-radius: 8px;
      box-shadow: 0 8px 24px rgba(0,0,0,0.4);
      overflow: hidden;
    }
    .hist-mode-dropdown.open { display: block; }
    .hist-mode-dropdown button {
      display: block;
      width: 100%;
      text-align: left;
      padding: 8px 12px;
      background: transparent;
      border: none;
      color: #e6edf3;
      font-size: 0.78em;
      cursor: pointer;
      white-space: nowrap;
    }
    .hist-mode-dropdown button:hover,
    .hist-mode-dropdown button.active {
      background: rgba(247,147,26,0.15);
      color: #f7931a;
    }
    body.light-mode .hist-mode-dropdown { background: #fff; border-color: #d1d5db; }
    body.light-mode .hist-mode-dropdown button { color: #374151; }
    body.light-mode .hist-mode-dropdown button:hover,
    body.light-mode .hist-mode-dropdown button.active { background: #fef3c7; color: #92400e; }
    @media (max-width: 480px) {
      #historyModeSelect { display: none !important; }
      #historyModeMobileWrap { display: inline-block; }
    }

    /* Font settings panel — override inline dark styles */
    body.light-mode #historyFontSettingsBtn { background: #fff !important; border-color: #d1d5db !important; color: #374151 !important; }
    body.light-mode #historyFontPanel { background: #fff !important; border-color: #e5e7eb !important; }
    body.light-mode #historyFontPanel span[style*="color:#8b949e"] { color: #374151 !important; }
    body.light-mode #historyFontPanel button[style*="color:#fff"] { background: #ffffff !important; border-color: #d1d5db !important; color: #374151 !important; }
    body.light-mode #historyFontPanel button[style*="color:#8b949e"] { color: #374151 !important; }
    body.light-mode #historyFontPanel span[style*="color:#f7931a"] { color: #c2700f !important; }
    body.light-mode #historyFontPanel div[style*="border-top:1px solid rgba(255,255,255"] { border-top-color: #e5e7eb !important; }
    body.light-mode #historyFontPanel button[style*="background:rgba(255,255,255,0.08)"][style*="color:#8b949e"] { background: #fff !important; border-color: #d1d5db !important; color: #374151 !important; }

    /* Invest stats boxes — kuning */
    body.light-mode .invest-stats { background: transparent; }
    body.light-mode .invest-stats .stat-item, body.light-mode .invest-stats .stat-item.invest { background: #fef3c7 !important; border-color: #f59e0b !important; border-top-color: #d97706 !important; box-shadow: none !important; }
    body.light-mode .invest-stats .stat-item:hover { background: #fde68a !important; border-color: #d97706 !important; }
    body.light-mode .invest-stats .stat-item .stat-label, body.light-mode .invest-stats .stat-item.invest .stat-label { color: #713f12 !important; font-weight: 700; }
    body.light-mode .invest-stats .stat-item .stat-value, body.light-mode .invest-stats .stat-item.invest .stat-value { color: #422006 !important; font-weight: 600; }
    body.light-mode .invest-stats .stat-item .stat-change.up { color: #14532d !important; background: #dcfce7 !important; border-color: #86efac !important; font-weight: 700; }
    body.light-mode .invest-stats .stat-item .stat-change.down { color: #7f1d1d !important; background: #fee2e2 !important; border-color: #fca5a5 !important; font-weight: 700; }

    /* ===== LIGHT MODE OVERRIDES ===== */
    body.light-mode .header { background: #f8f9fc; backdrop-filter: none; -webkit-backdrop-filter: none; border-color: #e0e0e0; box-shadow: 0 2px 8px rgba(0,0,0,0.07); }

    /* Chart section */
    body.light-mode .chart-section { background: #ffffff; border-color: #e5e7eb; box-shadow: 0 2px 12px rgba(0,0,0,0.06); }
    body.light-mode .chart-header { background: #f9fafb; border-color: #e5e7eb; }
    body.light-mode .history-section { background: #ffffff !important; border-color: #e5e7eb !important; box-shadow: 0 2px 12px rgba(0,0,0,0.06) !important; }
    body.light-mode .history-header { background: #f9fafb !important; border-color: #e5e7eb !important; }
    body.light-mode .history-header h2 { color: #111827 !important; }
    body.light-mode .history-header .count { color: #6b7280 !important; }
    body.light-mode .history-pagination { background: #f9fafb; border-color: #e5e7eb; }
    body.light-mode .page-btn { background: #fff; border-color: #d1d5db; color: #374151; }
    body.light-mode .page-btn:hover:not(:disabled) { background: #fff7ed; border-color: #f7931a; color: #ea580c; }
    body.light-mode .stat-item { background: #ffffff; border-color: #e5e7eb; border-top-width: 2px; box-shadow: 0 1px 6px rgba(0,0,0,0.06); }
    body.light-mode .stat-item:hover { background: #f9fafb; }
    body.light-mode .stat-item .stat-label { color: #6b7280; }
    body.light-mode .stat-item .stat-value { color: #111827; }
    body.light-mode .stat-item.price-up .stat-value { color: #15803d; }
    body.light-mode .stat-item.price-down .stat-value { color: #dc2626; }
    body.light-mode .stat-item .stat-change.up { color: #15803d; background: rgba(22,163,74,0.1); }
    body.light-mode .stat-item .stat-change.down { color: #dc2626; background: rgba(239,68,68,0.1); }
    body.light-mode .chart-header h2 { color: #111; }
    body.light-mode .invest-stats { background: #fff; }

    /* Stat items */
    body.light-mode .stat-item { background: #fff; backdrop-filter: none; -webkit-backdrop-filter: none; border-color: #e0e0e0; box-shadow: 0 2px 6px rgba(0,0,0,0.06); }
    body.light-mode .stat-item:hover { background: #fff; border-color: #bbb; box-shadow: 0 4px 12px rgba(0,0,0,0.09); }
    body.light-mode .stat-item .stat-label { color: #444; opacity: 1; }
    body.light-mode .stat-item .stat-value { color: #111; text-shadow: none; }
    body.light-mode .stat-item .stat-value.green { color: #1a7a5e; text-shadow: none; }
    body.light-mode .stat-item .stat-value.blue { color: #1d5fa8; text-shadow: none; }
    body.light-mode .stat-item.price-up { border-color: #22c55e; border-top-color: #16a34a; box-shadow: none; }
    body.light-mode .stat-item.price-up .stat-value { color: #15803d; text-shadow: none; }
    body.light-mode .stat-item.price-down { border-color: #f87171; border-top-color: #dc2626; box-shadow: none; }
    body.light-mode .stat-item.price-down .stat-value { color: #dc2626; text-shadow: none; }
    body.light-mode .stat-item .stat-change.up { color: #15803d; background: #dcfce7; border-color: #bbf7d0; }
    body.light-mode .stat-item .stat-change.down { color: #dc2626; background: #fee2e2; border-color: #fecaca; }

    /* Kotak Beli/Jual/USD-IDR — warna solid per kartu (light mode) */
    body.light-mode #buyCard { background: #bbf7d0 !important; border-color: #22c55e !important; border-top-color: #16a34a !important; }
    body.light-mode #buyCard .stat-label { color: #14532d; }
    body.light-mode #buyCard .stat-value, body.light-mode #buyCard .stat-value * { color: #14532d !important; }
    body.light-mode #sellCard { background: #bfdbfe !important; border-color: #3b82f6 !important; border-top-color: #2563eb !important; }
    body.light-mode #sellCard .stat-label { color: #1e3a8a; }
    body.light-mode #sellCard .stat-value, body.light-mode #sellCard .stat-value * { color: #1e3a8a !important; }
    body.light-mode #usdIdrCard { background: #ddd6fe !important; border-color: #8b5cf6 !important; border-top-color: #7c3aed !important; }
    body.light-mode #usdIdrCard .stat-label { color: #4c1d95; }
    body.light-mode #usdIdrCard .stat-value, body.light-mode #usdIdrCard .stat-value * { color: #4c1d95 !important; }
    body.light-mode #lowestOnCard { background: #d1fae5 !important; border-color: #10b981 !important; border-top-color: #059669 !important; box-shadow: none !important; }
    body.light-mode #lowestOnCard .stat-label { color: #065f46 !important; }
    body.light-mode #lowestOnCard .stat-value { color: #065f46 !important; }
    /* Change badge di kotak berwarna — putih agar kontras */
    body.light-mode #buyCard .stat-change, body.light-mode #sellCard .stat-change, body.light-mode #usdIdrCard .stat-change { background: #fff !important; }
    body.light-mode #buyCard .stat-change.up, body.light-mode #sellCard .stat-change.up, body.light-mode #usdIdrCard .stat-change.up { color: #15803d !important; border-color: #86efac !important; }
    body.light-mode #buyCard .stat-change.down, body.light-mode #sellCard .stat-change.down, body.light-mode #usdIdrCard .stat-change.down { color: #b91c1c !important; border-color: #fca5a5 !important; }

    /* Chart bottom row — clock/date/OFF box netral (dark glass setara di light mode) */
    body.light-mode .chart-info-row { background: #f1f5f9; border-color: #cbd5e1; }
    body.light-mode .info-time { color: #0f172a; text-shadow: none; }
    body.light-mode .clk-h { color: #0f172a; }
    body.light-mode .clk-m { color: #b45309; }
    body.light-mode .clk-s { color: #15803d; }
    body.light-mode .clk-s.clk-s-alert { color: #dc2626 !important; }
    body.light-mode .clk-sep { color: rgba(15,23,42,0.4); }
    body.light-mode .info-date { color: #1e293b; }
    body.light-mode .price-high-overlay { background: #bbf7d0; border-color: #22c55e; box-shadow: none; }
    body.light-mode .price-high-overlay span:last-child { color: #14532d; }
    body.light-mode .price-low-overlay { background: #fecaca; border-color: #ef4444; box-shadow: none; }
    body.light-mode .price-low-overlay span:last-child { color: #7f1d1d; }
    body.light-mode .price-highlow-text { color: #374151; font-weight: 600; }
    body.light-mode .markup-overlay { background: #fed7aa; border-color: #f97316; box-shadow: none; }
    body.light-mode .markup-overlay-text { color: #7c2d12; font-weight: 600; }
    body.light-mode #markupOverlayValue { color: #7c2d12; font-weight: 700; }
    body.light-mode .spread-overlay { background: #bbf7d0; border-color: #22c55e; box-shadow: none; }
    body.light-mode .spread-overlay-text { color: #14532d; font-weight: 600; }
    body.light-mode #spreadPercent { color: #14532d; font-weight: 700; }
    /* Badge ON/OFF di light mode tetap glossy — gradasi sama dengan dark mode */
    body.light-mode .promo-status-badge.off { box-shadow: 0 0 12px rgba(244,59,59,0.4), 0 2px 6px rgba(0,0,0,0.15), inset 0 1px 0 rgba(255,255,255,0.45); }
    body.light-mode .promo-status-badge.on { box-shadow: 0 0 12px rgba(0,230,118,0.4), 0 2px 6px rgba(0,0,0,0.15), inset 0 1px 0 rgba(255,255,255,0.5); }
    body.light-mode .limit-label { background: #fed7aa; border-color: #f97316; box-shadow: none; }
    body.light-mode .limit-label .limit-text { color: #7c2d12; font-weight: 600; }
    body.light-mode .limit-label #promoLimitValue { color: #7c2d12; font-weight: 700; }

    /* Stat items — price up/down lebih solid */
    body.light-mode .stat-item.price-up { background: #f0fdf4; border-color: #16a34a; border-top-color: #15803d; }
    body.light-mode .stat-item.price-down { background: #fef2f2; border-color: #dc2626; border-top-color: #b91c1c; }

    /* Indicator buttons — solid, no dark shadow */
    body.light-mode .indicator-btn { background: #fff; border-color: #d1d5db; color: #374151; box-shadow: 0 1px 3px rgba(0,0,0,0.08); transform: none; }
    body.light-mode .indicator-btn:hover { background: #f5f5f5; border-color: #9ca3af; box-shadow: 0 1px 3px rgba(0,0,0,0.08); transform: translateY(-1px); }
    body.light-mode .indicator-btn.promo { background: #d1fae5; border-color: #10b981; border-top-color: #059669; color: #065f46; box-shadow: 0 1px 4px rgba(16,185,129,0.2); }
    body.light-mode .indicator-btn.promo:hover { background: #a7f3d0; border-color: #059669; }
    body.light-mode .indicator-btn.news { background: #fef3c7; border-color: #f59e0b; border-top-color: #d97706; color: #78350f; box-shadow: 0 1px 4px rgba(245,158,11,0.2); }
    body.light-mode .indicator-btn.news:hover { background: #fde68a; border-color: #d97706; }
    body.light-mode .indicator-btn.settings { background: #dbeafe; border-color: #3b82f6; border-top-color: #2563eb; color: #1e3a8a; box-shadow: 0 1px 4px rgba(59,130,246,0.2); }
    body.light-mode .indicator-btn.settings:hover { background: #bfdbfe; border-color: #2563eb; }
    body.light-mode .indicator-btn.calc { background: #ffedd5; border-color: #f97316; border-top-color: #ea580c; color: #7c2d12; box-shadow: 0 1px 4px rgba(249,115,22,0.2); }
    body.light-mode .indicator-btn.calc:hover { background: #fed7aa; border-color: #ea580c; }
    body.light-mode .indicator-btn.guide { background: #ffedd5; border-color: #f97316; border-top-color: #ea580c; color: #7c2d12; }
    body.light-mode .indicator-btn.chat { background: #ede9fe; border-color: #8b5cf6; border-top-color: #7c3aed; color: #4c1d95; }
    body.light-mode .nominal-settings-btn { background: #ffedd5; border-color: #f97316; color: #7c2d12; }

    /* Indicator settings modal — solid */
    body.light-mode .indicator-settings-modal { background: #fff; border-color: #e0e0e0; }
    body.light-mode .indicator-settings-header { background: #fff; border-color: #e5e7eb; }
    body.light-mode .indicator-settings-header h3 { color: #111; }
    body.light-mode .indicator-settings-body p.hint { color: #6b7280; }
    body.light-mode .indicator-item { background: #fff; border-color: #e0e0e0; border-top-color: #d1d5db; box-shadow: 0 1px 4px rgba(0,0,0,0.06); }
    body.light-mode .indicator-item:hover { background: #fff; border-color: #d1d5db; box-shadow: 0 2px 8px rgba(0,0,0,0.08); }
    body.light-mode .indicator-item.active { background: #f0fdf4; border-color: #22c55e; border-top-color: #16a34a; box-shadow: 0 1px 4px rgba(34,197,94,0.15); }
    body.light-mode .indicator-item-details h5 { color: #111; }
    body.light-mode .indicator-item-details span { color: #6b7280; }
    body.light-mode .indicator-toggle { background: #e5e7eb; border-color: #d1d5db; box-shadow: inset 0 1px 3px rgba(0,0,0,0.1); }
    body.light-mode .indicator-toggle.active { background: #22c55e; border-color: #16a34a; box-shadow: 0 0 8px rgba(34,197,94,0.3); }
    body.light-mode .indicator-settings-footer { border-color: #e5e7eb; }
    body.light-mode .indicator-settings-footer .cancel-btn { background: #fff; border-color: #d1d5db; color: #374151; box-shadow: none; }
    body.light-mode .indicator-settings-footer .cancel-btn:hover { background: #f5f5f5; color: #111; box-shadow: none; }
    body.light-mode .indicator-settings-footer .apply-btn { background: #fff7ed; border-color: #f7931a; border-top-color: #e8850f; color: #c2700f; box-shadow: none; }
    body.light-mode .indicator-settings-footer .apply-btn:hover { background: #ffedd5; box-shadow: none; }
    body.light-mode .indicator-settings-header h3 { color: #c2700f; }
    body.light-mode .sound-toggle-header { background: #bbf7d0; border-color: #22c55e; border-top-color: #16a34a; box-shadow: 0 2px 6px rgba(22,163,74,0.2); }
    body.light-mode .sound-toggle-header svg { color: #14532d; }
    body.light-mode .sound-toggle-header.partial { background: #fef3c7; border-color: #f59e0b; border-top-color: #d97706; box-shadow: 0 2px 6px rgba(217,119,6,0.2); }
    body.light-mode .sound-toggle-header.partial svg { color: #78350f; }
    body.light-mode .sound-toggle-header.off { background: #fecaca; border-color: #ef4444; border-top-color: #dc2626; box-shadow: 0 2px 6px rgba(220,38,38,0.2); }
    body.light-mode .sound-toggle-header.off svg { color: #7f1d1d; }
    body.light-mode .theme-toggle-btn { background: #fef08a; border-color: #facc15; border-top-color: #eab308; color: #713f12; box-shadow: 0 2px 6px rgba(202,138,4,0.25); }
    body.light-mode .theme-toggle-btn:hover { background: #fde047; border-color: #ca8a04; }
    body.light-mode .logout-btn { background: #fecaca; border-color: #ef4444; border-top-color: #dc2626; color: #7f1d1d; box-shadow: 0 2px 6px rgba(220,38,38,0.2); }
    body.light-mode .logout-btn:hover { background: #fca5a5; border-color: #dc2626; }
    body.light-mode .live-badge { background: #dcfce7; color: #15803d; border-color: #86efac; }
    body.light-mode .calc-btn-header { background: #fef3c7; border-color: #fcd34d; color: #b45309; }

    /* Teks */
    body.light-mode .rp-prefix { color: #333; opacity: 1; }

    /* History section */
    body.light-mode .history-section { background: #fff; border-color: #e0e0e0; box-shadow: 0 2px 8px rgba(0,0,0,0.06); }
    body.light-mode .history-header { border-color: #e0e0e0; }
    body.light-mode .history-header h2 { color: #111; }
    body.light-mode .history-table th { background: #fff; color: #111; border-color: #d1d5db; opacity: 1; }
    body.light-mode .history-table td { color: #111; border-color: #e5e7eb; }
    body.light-mode .history-table td.time-col, body.light-mode .history-table td:nth-child(3) { color: #111 !important; }
    body.light-mode .history-table tr:hover { background: #fff; }
    body.light-mode .history-table tr:last-child td { border-bottom: none; }
    body.light-mode .history-table .time-col { color: #111; }
    body.light-mode .history-date { color: #111; }
    body.light-mode .history-table .no-data { color: #333; }
    /* Warna harga naik/turun lebih solid */
    body.light-mode .history-table .price-up { color: #15803d; font-weight: 700; }
    body.light-mode .history-table .price-down { color: #b91c1c; font-weight: 700; }
    /* Status badge MARKDOWN/MARKUP lebih solid */
    body.light-mode .markup-normal { background: #bbf7d0; color: #14532d; border-color: #22c55e; border-top-color: #16a34a; box-shadow: none; }
    body.light-mode .markup-abnormal { background: #fef3c7; color: #78350f; border-color: #f59e0b; border-top-color: #d97706; box-shadow: none; }
    /* Nominal kolom */
    body.light-mode .history-table td.td-nominal .nom-gram { color: #111; font-weight: 500; }
    body.light-mode .history-table td.td-nominal small { font-weight: 600; }
    body.light-mode .history-table td.td-nominal small.price-up { color: #15803d; }
    body.light-mode .history-table td.td-nominal small.price-down { color: #b91c1c; }
    /* Pagination */
    body.light-mode .history-pagination { background: #fff; border-color: #e0e0e0; }
    body.light-mode .page-btn { background: #fff; border-color: #d1d5db; color: #374151; }
    body.light-mode .page-btn:hover { background: #f5f5f5; border-color: #9ca3af; }
    body.light-mode .page-btn.active { background: #f97316; border-color: #f97316; color: #fff; }
    body.light-mode .page-btn:not(.active) { color: #374151 !important; }
    body.light-mode .page-info { color: #374151 !important; }
    body.light-mode #pageJumpInput { color: #374151 !important; background: #fff !important; border-color: #d1d5db !important; }
    body.light-mode .count { color: #374151; font-weight: 600; }

    /* Modals */
    /* Nominal modal — solid */
    body.light-mode .nominal-modal { background: #fff; border-color: #e0e0e0; }
    body.light-mode .nominal-modal h3 { color: #c2700f; }
    body.light-mode .nominal-modal-item { background: #fff; border-color: #f97316; border-top-color: #ea580c; color: #222; }
    body.light-mode .nominal-modal-item:hover { background: #fff7ed; border-color: #ea580c; }
    body.light-mode .nominal-modal-item label { color: #111; font-weight: 600; }
    body.light-mode .nominal-modal-item .nominal-discount { color: #c2700f; font-weight: 500; }
    body.light-mode .nominal-modal-actions .btn-cancel { background: #fff; border-color: #d1d5db; color: #374151; }
    body.light-mode .nominal-modal-actions .btn-cancel:hover { background: #f5f5f5; color: #111; }
    body.light-mode .nominal-modal-actions .btn-save { background: #ffedd5; border-color: #f97316; border-top-color: #ea580c; color: #c2700f; }
    body.light-mode .nominal-modal-actions .btn-save:hover { background: #fed7aa; }
    /* Promo modal — solid */
    body.light-mode .promo-suggestions-overlay { background: rgba(15,23,42,0.28); }
    body.light-mode .promo-suggestions-modal { background: #fff; border-color: #e0e0e0; box-shadow: 0 8px 32px rgba(0,0,0,0.12); }
    body.light-mode .promo-suggestions-modal h3 { color: #111; }
    body.light-mode .promo-card { background: #ffffff; border-color: #e5e7eb; border-top-color: #e5e7eb; box-shadow: 0 1px 3px rgba(0,0,0,0.05); }
    body.light-mode .promo-card:hover { background: #fafafa; }
    body.light-mode .promo-card-code { color: #15803d; background: #dcfce7; border-color: #86efac; }
    body.light-mode .promo-card-name { color: #111; }
    body.light-mode .promo-card-desc { color: #374151; }
    body.light-mode .promo-card-meta { color: #6b7280; }
    body.light-mode .promo-empty { color: #6b7280; }

    /* News modal (Forex Factory) — solid */
    body.light-mode .news-card { background: #ffffff; border-color: #e5e7eb; border-top-color: #e5e7eb; box-shadow: 0 1px 3px rgba(0,0,0,0.05); }
    body.light-mode .news-card.impact-high { border-left: 3px solid #ef4444; box-shadow: none; }
    body.light-mode .news-card.impact-medium { border-left: 3px solid #f97316; box-shadow: none; }
    body.light-mode .news-card.impact-low { border-left: 3px solid #9ca3af; }
    body.light-mode .news-card.past { background: #f3f4f6; opacity: 0.6; }
    body.light-mode .news-card.past .news-title { color: #6b7280; }
    body.light-mode .news-card.upcoming { background: #f0fdf4; border-color: #86efac; border-top-color: #4ade80; box-shadow: none; }
    body.light-mode .news-countdown { background: #dcfce7; color: #15803d; }
    body.light-mode .news-title { color: #111; }
    body.light-mode .news-meta { color: #374151; }
    body.light-mode .news-values { color: #374151; }
    body.light-mode .news-values .actual { color: #15803d; }
    body.light-mode .news-pred.pred-up { background: #dcfce7; color: #15803d; border-color: #86efac; }
    body.light-mode .news-pred.pred-down { background: #fee2e2; color: #b91c1c; border-color: #fca5a5; }
    body.light-mode .news-section-label { color: #b45309; }
    body.light-mode .news-empty { color: #6b7280; }
    body.light-mode .news-filter-btn { background: #f3f4f6; border-color: #d1d5db; border-top-color: #d1d5db; color: #374151; box-shadow: none; }
    body.light-mode .news-filter-btn:hover { background: #e5e7eb; color: #111; box-shadow: none; }
    body.light-mode .news-filter-btn.active { background: #ffedd5; border-color: #f97316; border-top-color: #ea580c; color: #c2700f; box-shadow: none; }

    /* Confirm modal (logout) — solid */
    body.light-mode .confirm-modal { background: rgba(0,0,0,0.5); }
    body.light-mode .confirm-box { background: #fff; border-color: #e0e0e0; box-shadow: 0 8px 32px rgba(0,0,0,0.15); }
    body.light-mode .confirm-icon { background: #fef3c7; color: #d97706; }
    body.light-mode .confirm-title { color: #111; font-weight: 700; }
    body.light-mode .confirm-message { color: #374151; }
    body.light-mode .confirm-btn.cancel { background: #fff; color: #374151; border: 1px solid #d1d5db; font-weight: 600; }
    body.light-mode .confirm-btn.cancel:hover { background: #f5f5f5; border-color: #9ca3af; }

    /* Toast notifications */
    body.light-mode .toast { background: #fff; border-color: #e0e0e0; box-shadow: 0 4px 16px rgba(0,0,0,0.1); }
    body.light-mode .toast-message { color: #222; }
    body.light-mode .toast.info .toast-icon { background: #dbeafe; color: #1d4ed8; }
    body.light-mode .toast.success .toast-icon { background: #dcfce7; color: #15803d; }
    body.light-mode .toast.warning .toast-icon { background: #fef3c7; color: #b45309; }
    body.light-mode .toast.danger .toast-icon { background: #fee2e2; color: #b91c1c; }

    /* Notif banner */
    body.light-mode .notif-banner { background: #fff; border-color: #e0e0e0; box-shadow: 0 4px 16px rgba(0,0,0,0.08); backdrop-filter: none; }

    /* Sound panel — solid */
    body.light-mode .sound-panel { background: #fff; border-color: #e0e0e0; box-shadow: 0 8px 24px rgba(0,0,0,0.12); }
    body.light-mode .sound-panel-header { color: #374151; border-color: #e0e0e0; }
    body.light-mode .sound-panel-close { color: #6b7280; }
    body.light-mode .sound-panel-close:hover { color: #111; background: #f5f5f5; }
    body.light-mode .sound-row { border-color: #e5e7eb; }
    body.light-mode .sound-row-label { color: #111; font-weight: 600; }
    body.light-mode .sound-row-sub { color: #6b7280; }
    body.light-mode .sound-sw-track { background: #e5e7eb; border-color: #d1d5db; }
    body.light-mode .sound-sw input:checked + .sound-sw-track { background: #bbf7d0; border-color: #22c55e; }
    body.light-mode .sound-sw input:checked + .sound-sw-track::before { background: #16a34a; }
    body.light-mode .sound-panel-footer { border-color: #e0e0e0; background: #fff; }
    body.light-mode .sound-panel-btn { background: #fff; border-color: #d1d5db; color: #374151; font-weight: 600; }
    body.light-mode .sound-panel-btn:hover { background: #f5f5f5; border-color: #9ca3af; color: #111; }

    /* Calc modal */
    body.light-mode .calc-modal { background: #fff; border-color: #e0e0e0; box-shadow: 0 8px 32px rgba(0,0,0,0.12); }
    body.light-mode .calc-modal-header { background: #fff8f0; border-color: #e0e0e0; }
    body.light-mode .calc-modal-header h3 { color: #c2700f; }
    body.light-mode .calc-modal-body { color: #222; }
    body.light-mode .calc-input-group label { color: #374151; }
    body.light-mode .calc-input-group input, body.light-mode .calc-input-group select { background: #fff; border-color: #d1d5db; border-top-color: #d1d5db; color: #111; box-shadow: none; }
    body.light-mode .calc-input-group input:focus, body.light-mode .calc-input-group select:focus { border-color: #f97316; border-top-color: #ea580c; background: #fff; box-shadow: 0 0 0 3px rgba(249,115,22,0.12); }
    body.light-mode .calc-input-group input::placeholder { color: #9ca3af; }
    body.light-mode .calc-tab { background: #f3f4f6; border-color: #d1d5db; border-top-color: #d1d5db; color: #374151; box-shadow: none; }
    body.light-mode .calc-tab:hover { background: #e5e7eb; color: #111; }
    body.light-mode .calc-tab.active { background: #ffedd5; border-color: #f97316; border-top-color: #ea580c; color: #c2700f; box-shadow: none; }
    body.light-mode .calc-result { background: #f0fdf4; border-color: #22c55e; border-top-color: #16a34a; box-shadow: none; }
    body.light-mode .calc-result-label { color: #374151; }
    body.light-mode .calc-result-value { color: #15803d; }
    body.light-mode .calc-result-sub { color: #374151; }
    body.light-mode .calc-current-price { background: #f9fafb; }
    body.light-mode .calc-current-price span:first-child { color: #374151; }
    body.light-mode .calc-current-price span:last-child { color: #c2700f; }
    body.light-mode .calc-price-toggle { }
    body.light-mode .calc-price-option { background: #fff; border-color: #d1d5db; }
    body.light-mode .calc-price-option:hover { background: #f9fafb; }
    body.light-mode .calc-price-option.active { background: #ffedd5; border-color: #f97316; }
    body.light-mode .calc-price-option .price-label { color: #374151; }
    body.light-mode .calc-price-option.active .price-label { color: #c2700f; }
    body.light-mode .calc-price-option .price-value { color: #111; }
    body.light-mode .calc-price-option.active .price-value { color: #c2700f; }

    /* Indicator modal */
    body.light-mode .indicator-modal { background: #fff; border-color: #e0e0e0; box-shadow: 0 8px 32px rgba(0,0,0,0.12); }
    body.light-mode .indicator-modal-header { background: #fff; border-color: #e0e0e0; }
    body.light-mode .indicator-modal-header h3 { color: #c2700f; }

    /* Professional Toast System */
    .toast-container {
      position: fixed;
      top: 20px;
      right: 20px;
      z-index: 9999;
      display: flex;
      flex-direction: column;
      gap: 10px;
    }
    .toast {
      background: rgba(20, 26, 34, 0.98);
      backdrop-filter: blur(10px);
      border-radius: 12px;
      padding: 14px 18px;
      display: flex;
      align-items: center;
      gap: 12px;
      border: 1px solid rgba(255,255,255,0.1);
      box-shadow: 0 10px 30px rgba(0,0,0,0.4);
      animation: slideIn 0.3s ease;
      max-width: 320px;
    }
    @keyframes slideIn { from { transform: translateX(100%); opacity: 0; } to { transform: translateX(0); opacity: 1; } }
    @keyframes slideOut { from { transform: translateX(0); opacity: 1; } to { transform: translateX(100%); opacity: 0; } }
    .toast-icon {
      width: 36px;
      height: 36px;
      border-radius: 50%;
      display: flex;
      align-items: center;
      justify-content: center;
      flex-shrink: 0;
    }
    .toast-icon svg { width: 18px; height: 18px; }
    .toast.info .toast-icon { background: rgba(59,130,246,0.15); color: #60a5fa; }
    .toast.success .toast-icon { background: rgba(34,197,94,0.15); color: #4ade80; }
    .toast.warning .toast-icon { background: rgba(251,191,36,0.15); color: #fbbf24; }
    .toast.danger .toast-icon { background: rgba(239,68,68,0.15); color: #f87171; }
    .toast-message { color: #e7e9ea; font-size: 0.9em; line-height: 1.4; }

    /* Confirm Modal */
    .confirm-modal {
      display: none;
      position: fixed;
      top: 0;
      left: 0;
      width: 100%;
      height: 100%;
      background: rgba(0,0,0,0.85);
      align-items: center;
      justify-content: center;
      z-index: 9999;
    }
    .confirm-modal.show { display: flex; }
    .confirm-box {
      background: linear-gradient(180deg, rgba(25, 32, 42, 0.98) 0%, rgba(18, 24, 32, 0.98) 100%);
      border-radius: 16px;
      padding: 24px;
      width: 90%;
      max-width: 340px;
      text-align: center;
      border: 1px solid rgba(255,255,255,0.1);
      box-shadow: 0 25px 60px rgba(0,0,0,0.5);
    }
    .confirm-icon {
      width: 56px;
      height: 56px;
      border-radius: 50%;
      background: rgba(251,191,36,0.15);
      color: #fbbf24;
      display: flex;
      align-items: center;
      justify-content: center;
      margin: 0 auto 16px;
    }
    .confirm-icon svg { width: 28px; height: 28px; }
    .confirm-title { color: #fff; font-size: 1.1em; font-weight: 600; margin-bottom: 8px; }
    .confirm-message { color: #9ca3af; font-size: 0.9em; line-height: 1.5; margin-bottom: 20px; }
    .confirm-buttons { display: flex; gap: 10px; justify-content: center; }
    .confirm-btn {
      padding: 10px 24px;
      border-radius: 10px;
      font-size: 0.88em;
      font-weight: 600;
      cursor: pointer;
      border: none;
      transition: all 0.2s;
    }
    .confirm-btn.cancel { background: rgba(255,255,255,0.08); color: #e7e9ea; }
    .confirm-btn.cancel:hover { background: rgba(255,255,255,0.15); }
    .confirm-btn.ok { background: linear-gradient(135deg, #f7931a 0%, #e8850f 100%); color: white; }
    .confirm-btn.ok:hover { transform: translateY(-1px); }
  </style>
</head>
<body>
  <div class="toast-container" id="toastContainer"></div>

  <!-- Nominal Settings Modal -->
  <div class="nominal-modal-overlay" id="nominalSettingsModal">
    <div class="nominal-modal">
      <h3>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></svg>
        Pilih Nominal Investasi
      </h3>
      <div class="nominal-modal-list" id="nominalModalList">
        <!-- Will be populated by JavaScript -->
      </div>
      <div class="nominal-modal-actions">
        <button class="btn-cancel" onclick="closeNominalSettings()">Batal</button>
        <button class="btn-save" onclick="saveNominalSettings()">Simpan</button>
      </div>
    </div>
  </div>


  <!-- Indicator Settings Modal -->
  <!-- Promo Suggestions Modal -->
  <div class="promo-suggestions-overlay" id="promoSuggestionsModal" onclick="if(event.target===this)closePromoSuggestions()">
    <div class="promo-suggestions-modal">
      <h3>
        <i data-lucide="tag" style="width:15px;height:15px;color:#22c55e;"></i>
        Promo Aktif Treasury
        <button class="promo-modal-close" onclick="closePromoSuggestions()"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>
      </h3>
      <div id="promoSuggestionsList"><div class="promo-empty">Memuat...</div></div>
      <div class="promo-last-update" id="promoLastUpdate"></div>
    </div>
  </div>

  <!-- News XAU/USD Modal -->
  <div class="promo-suggestions-overlay" id="newsModal" onclick="if(event.target===this)closeNewsModal()">
    <div class="promo-suggestions-modal">
      <h3>
        <i data-lucide="newspaper" style="width:15px;height:15px;color:#fbbf24;"></i>
        News XAU/USD (Forex Factory)
        <button class="promo-modal-close" onclick="closeNewsModal()"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>
      </h3>
      <div class="news-filter-row" id="newsFilterRow">
        <button class="news-filter-btn active" data-impact="Low" onclick="toggleNewsFilter('Low',this)">
          <span style="display:inline-flex;gap:2px;vertical-align:middle;">
            <span style="display:inline-block;width:4px;height:12px;border-radius:2px;background:#ffd600;"></span>
            <span style="display:inline-block;width:4px;height:12px;border-radius:2px;background:rgba(255,255,255,0.15);"></span>
            <span style="display:inline-block;width:4px;height:12px;border-radius:2px;background:rgba(255,255,255,0.15);"></span>
          </span>
          Low
        </button>
        <button class="news-filter-btn active" data-impact="Medium" onclick="toggleNewsFilter('Medium',this)">
          <span style="display:inline-flex;gap:2px;vertical-align:middle;">
            <span style="display:inline-block;width:4px;height:12px;border-radius:2px;background:#ff9800;"></span>
            <span style="display:inline-block;width:4px;height:12px;border-radius:2px;background:#ff9800;"></span>
            <span style="display:inline-block;width:4px;height:12px;border-radius:2px;background:rgba(255,255,255,0.15);"></span>
          </span>
          Medium
        </button>
        <button class="news-filter-btn active" data-impact="High" onclick="toggleNewsFilter('High',this)">
          <span style="display:inline-flex;gap:2px;vertical-align:middle;">
            <span style="display:inline-block;width:4px;height:12px;border-radius:2px;background:#ef5350;"></span>
            <span style="display:inline-block;width:4px;height:12px;border-radius:2px;background:#ef5350;"></span>
            <span style="display:inline-block;width:4px;height:12px;border-radius:2px;background:#ef5350;"></span>
          </span>
          High
        </button>
      </div>
      <div id="newsModalBody"><div class="news-empty">Memuat...</div></div>
      <div class="promo-last-update" id="newsLastUpdate"></div>
    </div>
  </div>

  <!-- Chat Modal -->
  <div class="promo-suggestions-overlay" id="chatModal" onclick="if(event.target===this)closeChatModal()">
    <div class="promo-suggestions-modal" style="display:flex;flex-direction:column;height:80vh;max-height:600px;">
      <h3 style="flex-shrink:0;">
        <i data-lucide="message-circle" style="width:15px;height:15px;color:#3b9eff;"></i>
        Chat Member Aktif
        <span id="chatOnlineCount" style="font-size:0.75em;color:#0ecb81;font-weight:600;margin-left:4px;background:rgba(14,203,129,0.12);border-radius:6px;padding:1px 7px;"></span>
        <button class="promo-modal-close" onclick="closeChatModal()"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>
      </h3>
      <div id="chatMessages" style="flex:1;overflow-y:auto;display:flex;flex-direction:column;gap:6px;padding:4px 0;"></div>
      <div style="flex-shrink:0;display:flex;gap:8px;margin-top:8px;">
        <input id="chatInput" type="text" maxlength="300" placeholder="Tulis pesan..." style="flex:1;background:rgba(255,255,255,0.07);border:1px solid rgba(255,255,255,0.12);border-radius:10px;padding:8px 12px;color:#eef3fa;font-size:0.82em;outline:none;" onkeydown="if(event.key==='Enter')sendChat()">
        <button onclick="sendChat()" style="background:rgba(59,158,255,0.2);border:1px solid rgba(59,158,255,0.3);color:#3b9eff;border-radius:10px;padding:8px 14px;font-size:0.82em;font-weight:600;cursor:pointer;display:inline-flex;align-items:center;gap:5px;"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg> Kirim</button>
      </div>
    </div>
  </div>

  <div class="indicator-settings-overlay" id="indicatorSettingsModal">
    <div class="indicator-settings-modal">
      <div class="indicator-settings-header">
        <h3>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9c.26.604.852.997 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
          Pengaturan Indikator
        </h3>
        <button class="indicator-modal-close" onclick="closeIndicatorSettings()"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>
      </div>
      <div class="indicator-settings-body">
        <p class="hint">Aktifkan indikator yang ingin ditampilkan di chart. Setiap indikator memakai parameter standar terbaiknya (BB 20/2, RSI 14, MACD 12-26-9, Stochastic 14-3-3, ATR 14). Kombinasi berlabel <b style="color:#f7931a;">Rekomendasi</b> paling pas untuk memantau emas. Perubahan memerlukan refresh halaman.</p>
        <div class="indicator-list" id="indicatorList"></div>
      </div>
      <div class="indicator-settings-footer">
        <button class="cancel-btn" onclick="closeIndicatorSettings()">Batal</button>
        <button class="apply-btn" onclick="applyIndicatorSettings()">Terapkan & Refresh</button>
      </div>
    </div>
  </div>

  <!-- Indicator Guide Modal -->
  <div class="indicator-modal-overlay" id="indicatorModal">
    <div class="indicator-modal">
      <div class="indicator-modal-header">
        <h3>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/></svg>
          Panduan Indikator Chart
        </h3>
        <button class="indicator-modal-close" onclick="closeIndicatorGuide()"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>
      </div>
      <div class="indicator-modal-body" id="indicatorGuideBody">
        <!-- Dynamic content will be inserted here -->
      </div>
    </div>
  </div>

  <div class="confirm-modal" id="confirmModal">
    <div class="confirm-box">
      <div class="confirm-icon">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
      </div>
      <div class="confirm-title" id="confirmTitle">Konfirmasi</div>
      <div class="confirm-message" id="confirmMessage">Apakah Anda yakin?</div>
      <div class="confirm-buttons">
        <button class="confirm-btn cancel" onclick="resolveConfirm(false)">Batal</button>
        <button class="confirm-btn ok" onclick="resolveConfirm(true)">Ya</button>
      </div>
    </div>
  </div>

  <!-- Gold Calculator Modal -->
  <div class="calc-modal-overlay" id="goldCalcModal">
    <div class="calc-modal">
      <div class="calc-modal-header">
        <h3>
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M12 6v12M8 10h8M8 14h8"/></svg>
          Kalkulator Emas
        </h3>
        <button class="indicator-modal-close" onclick="closeGoldCalc()"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>
      </div>
      <div class="calc-modal-body">
        <div class="calc-price-toggle">
          <div class="calc-price-option active" onclick="switchPriceType('buy')" id="calcPriceBuy">
            <span class="price-label">Harga Beli</span>
            <span class="price-value" id="calcBuyPrice">Rp -</span>
          </div>
          <div class="calc-price-option" onclick="switchPriceType('sell')" id="calcPriceSell">
            <span class="price-label">Harga Jual</span>
            <span class="price-value" id="calcSellPrice">Rp -</span>
          </div>
        </div>

        <div class="calc-tabs">
          <div class="calc-tab active" onclick="switchCalcTab('uangToGram')">Uang → Gram</div>
          <div class="calc-tab" onclick="switchCalcTab('gramToUang')">Gram → Uang</div>
        </div>

        <div id="calcUangToGram">
          <div class="calc-input-group">
            <label>Jumlah Uang (Rp)</label>
            <input type="number" id="calcInputUang" placeholder="Contoh: 10000000" oninput="calculateGold()">
          </div>
          <div class="calc-result" id="calcResultGram" style="display:none;">
            <div class="calc-result-label">Anda mendapatkan</div>
            <div class="calc-result-value" id="calcGramResult">0 gram</div>
            <div class="calc-result-sub" id="calcGramSub"></div>
          </div>
        </div>

        <div id="calcGramToUang" style="display:none;">
          <div class="calc-input-group">
            <label>Jumlah Gram</label>
            <input type="number" id="calcInputGram" placeholder="Contoh: 5" step="0.0001" oninput="calculateMoney()">
          </div>
          <div class="calc-result" id="calcResultUang" style="display:none;">
            <div class="calc-result-label">Nilai emas Anda</div>
            <div class="calc-result-value" id="calcUangResult">Rp 0</div>
            <div class="calc-result-sub" id="calcUangSub"></div>
          </div>
        </div>

        <button class="calc-btn" onclick="resetCalc()">Reset</button>
      </div>
    </div>
  </div>

  <div class="container">
    <div class="header">
      <div class="header-logo" title="Treasury Realtime Price">
        <span style="position:relative;display:inline-flex;flex-shrink:0;align-items:center;">
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="22" height="22" style="display:block;" aria-hidden="true">
            <rect x="7" y="1" width="16" height="16" rx="4" ry="4" fill="#f7931a"/>
            <path d="M1 23 L1 9 A13 13 0 0 1 14 23 Z" fill="#c97a10" opacity="0.9"/>
          </svg>
          <span class="live-dot"></span>
        </span>
        <span id="trendIcon" style="display:none;"></span>
      </div>

      <div class="header-title-text">Harga Treasury</div>

      <div class="header-right">
        <button class="nav-icon-btn" id="navIndicatorBtn" onclick="openIndicatorSettings()" title="Indikator">
          <i data-lucide="activity" style="width:16px;height:16px;color:#60a5fa;"></i>
        </button>
        <button class="nav-icon-btn" id="navNewsBtn" onclick="openNewsModal()" title="Cek News" style="position:relative;">
          <i data-lucide="bell" style="width:16px;height:16px;color:#c084fc;"></i>
          <span id="newsBadge" style="display:none;position:absolute;top:2px;right:2px;background:#f59e0b;color:#000;border-radius:99px;padding:0 4px;font-size:0.58em;font-weight:700;line-height:1.5;min-width:13px;text-align:center;">0</span>
        </button>
        <button class="nav-icon-btn promo-nav" id="promoBtnEl" onclick="openPromoSuggestions()" title="Cek Promo" style="position:relative;">
          <i data-lucide="percent" style="width:16px;height:16px;color:#34d399;"></i>
          <span id="promoBadge" style="display:none;position:absolute;top:2px;right:2px;background:#ef4444;color:#fff;border-radius:99px;padding:0 4px;font-size:0.58em;font-weight:700;line-height:1.5;min-width:13px;text-align:center;">0</span>
        </button>
        <button class="nav-icon-btn" id="navCalcBtn" onclick="openGoldCalc()" title="Harga Beli dan Jual">
          <i data-lucide="scale" style="width:16px;height:16px;color:#fbbf24;"></i>
        </button>
        <button class="nav-icon-btn" onclick="openNavMenu(event)" title="Menu" id="navMenuBtn">
          <i data-lucide="align-justify" style="width:15px;height:15px;"></i>
        </button>
      </div>

    </div>

    <!-- Nav Menu Dropdown (outside header to avoid backdrop-filter stacking context) -->
    <div class="nav-menu-dropdown" id="navMenuDropdown">
      <button class="nav-menu-item install-nav install-blink" id="installBtn" onclick="installFromSettings();closeNavMenu()" title="Install Aplikasi">
        <i data-lucide="download" style="width:14px;height:14px;"></i>
        Install Aplikasi
      </button>
      <button class="nav-menu-item" id="themeToggleItem" onclick="toggleTheme()">
        <i id="themeIconDark" data-lucide="moon" style="width:14px;height:14px;"></i>
        <i id="themeIconLight" data-lucide="sun" style="width:14px;height:14px;display:none;"></i>
        Ganti Mode
      </button>
      <div class="nav-menu-item" id="soundToggle" onclick="openSoundPanel(event)" title="Pengaturan Sound &amp; Getar">
        <i id="soundIconOn" data-lucide="volume-2" style="width:14px;height:14px;"></i>
        <i id="soundIconPartial" data-lucide="volume-1" style="width:14px;height:14px;display:none;"></i>
        <i id="soundIconOff" data-lucide="volume-x" style="width:14px;height:14px;display:none;"></i>
        Sound &amp; Getar
      </div>
      <button class="nav-menu-item" id="settingToggle" onclick="openSettingsPanel(event)" title="Pengaturan">
        <i data-lucide="settings" style="width:14px;height:14px;"></i>
        Setting
      </button>
      <button class="nav-menu-item" id="adminPanelBtn" style="display:none;" onclick="window.location.href='/admin/sso?session=' + encodeURIComponent(localStorage.getItem('goldmonitor_session')||'')" title="Panel Admin">
        <i data-lucide="shield" style="width:14px;height:14px;"></i>
        Panel Admin
      </button>
      <div class="nav-menu-divider"></div>
      <button class="nav-menu-item nav-menu-logout" id="logoutBtn" onclick="logout()">
        <i data-lucide="log-out" style="width:14px;height:14px;"></i>
        Logout
      </button>
    </div>

    <!-- Notification Banner Container -->
    <div id="notifContainer"></div>

    <div class="chart-section">
      <div class="chart-header">
        <div class="chart-stats">
          <div class="stat-item" id="buyCard" style="position:relative;overflow:hidden;">
            <span class="stat-label">Beli</span>
            <span class="stat-value" id="buyPrice"><span class="rp-prefix">Rp </span><span id="buyPriceNum">-</span></span>
            <span class="stat-change" id="buyChange"></span>
          </div>
          <div class="stat-item" id="sellCard" style="position:relative;overflow:hidden;">
            <span class="stat-label">Jual</span>
            <span class="stat-value" id="sellPrice"><span class="rp-prefix">Rp </span><span id="sellPriceNum">-</span></span>
            <span class="stat-change" id="sellChange"></span>
          </div>
          <div class="stat-item" id="usdIdrCard" style="position:relative;overflow:hidden;">
            <span class="stat-label">USD/IDR</span>
            <span class="stat-value blue" id="usdIdr">-</span>
            <span class="stat-change" id="usdIdrChange"></span>
          </div>
          <div class="stat-item" id="lowestOnCard" style="display:none;">
            <span class="stat-label">Titik ON <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="#22c55e" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="display:inline;vertical-align:middle"><polyline points="6 9 12 15 18 9"/></svg></span>
            <span class="stat-value" id="lowestOnValue" style="color:#22c55e;">-</span>
          </div>
          <div class="stat-item" id="markupCard" style="display:none;">
            <span class="stat-label">Markup</span>
            <span class="stat-value" id="markupValue" style="color:#6b7280;">-</span>
          </div>
        </div>
        <div class="invest-stats">
          <div id="investStatsList"></div>
        </div>
        <div class="chart-bottom-row">
          <div class="price-highlow-group">
            <div class="price-high-overlay">
              <span class="price-highlow-text">TERTINGGI</span>
              <span id="sessionHighValue">-</span>
            </div>
            <div class="price-low-overlay">
              <span class="price-highlow-text">TERENDAH</span>
              <span id="sessionLowValue">-</span>
            </div>
          </div>
          <div class="chart-info-row">
            <div class="info-item clock-info">
              <span class="info-time" id="clock2"><span class="clk-h" id="clkH">--</span><span class="clk-sep">:</span><span class="clk-m" id="clkM">--</span><span class="clk-sep">:</span><span class="clk-s" id="clkS">--</span></span>
              <span class="info-date" style="text-align:center;display:block;">
                <span class="info-date-day" id="dateInfo2Day"></span>
                <span id="dateInfo2"></span>
              </span>
            </div>
            <div class="promo-status-badge" id="promoStatusBadge">
              <span class="promo-dot" id="promoDot"></span>
              <span id="promoStatusText">-</span>
            </div>
          </div>
          <div class="limit-markup-group">
            <div class="limit-label" id="promoLimitCard" style="display:none;">
              <span class="limit-text">LIMIT</span>
              <span class="limit-eq">=</span>
              <span id="promoLimitValue">-</span>
            </div>
            <div class="markup-overlay" id="markupOverlay" style="display:none;">
              <span class="markup-overlay-text" id="markupOverlayLabel">MARKUP</span>
              <svg viewBox="0 0 16 16" width="11" height="11" fill="#fbbf24" style="flex-shrink:0"><path d="M8.982 1.566a1.13 1.13 0 0 0-1.96 0L.165 13.233c-.457.778.091 1.767.98 1.767h13.713c.889 0 1.438-.99.98-1.767L8.982 1.566zM8 5c.535 0 .954.462.9.995l-.35 3.507a.552.552 0 0 1-1.1 0L7.1 5.995A.905.905 0 0 1 8 5zm.002 6a1 1 0 1 1 0 2 1 1 0 0 1 0-2z"/></svg>
              <span id="markupOverlayValue">-</span>
            </div>
            <div class="spread-overlay">
              <span class="spread-overlay-text">SPREAD</span>
              <span id="spreadPercent">-</span>
            </div>
          </div>
        </div>
      </div>
      <div class="tradingview-widget-container">
        <!-- TradingView Widget - Dynamic Loading -->
        <div class="tradingview-widget-container__widget" id="tradingview-widget"></div>
        <script type="text/javascript">
        const INDICATOR_KEY = 'gold_monitor_indicators';
        const DEFAULT_IND = ['ma', 'bb', 'vwap'];
        const STUDY_MAP = {
          ma: 'MASimple@tv-basicstudies',
          ema: 'MAExp@tv-basicstudies',
          bb: 'BB@tv-basicstudies',
          vwap: 'VWAP@tv-basicstudies',
          rsi: 'RSI@tv-basicstudies',
          macd: 'MACD@tv-basicstudies',
          stoch: 'Stochastic@tv-basicstudies',
          atr: 'ATR@tv-basicstudies',
          vol: 'Volume@tv-basicstudies',
          ichimoku: 'IchimokuCloud@tv-basicstudies'
        };

        window._loadTVWidget = function() {
          let activeIndicators = DEFAULT_IND;
          try {
            const saved = localStorage.getItem(INDICATOR_KEY);
            if (saved) {
              const parsed = JSON.parse(saved);
              if (Array.isArray(parsed)) activeIndicators = parsed;
            }
          } catch(e) {}

          const studies = activeIndicators.map(id => STUDY_MAP[id]).filter(s => s);
          const hideVolume = !activeIndicators.includes('vol');
          const isMobile = window.innerWidth <= 768;
          const isLight = document.body.classList.contains('light-mode');

          const config = {
            autosize: true,
            height: "600",
            symbol: "TVC:GOLD",
            interval: "1",
            timezone: "Asia/Jakarta",
            theme: isLight ? "light" : "dark",
            style: "1",
            locale: "en",
            backgroundColor: isLight ? "#ffffff" : "#1a1f26",
            gridColor: isLight ? "#f0f2f5" : "#2f3640",
            hide_top_toolbar: false,
            hide_legend: false,
            allow_symbol_change: true,
            save_image: true,
            calendar: true,
            hide_volume: hideVolume,
            hide_side_toolbar: isMobile,
            withdateranges: true,
            details: false,
            hotlist: false,
            show_popup_button: true,
            popup_width: "1000",
            popup_height: "650",
            studies: studies,
            support_host: "https://www.tradingview.com"
          };

          // Suppress TradingView telemetry errors
          if (!window._tvTelemetryBlocked) {
            window._tvTelemetryBlocked = true;
            const _origFetch = window.fetch;
            window.fetch = function(url, opts) {
              if (typeof url === 'string' && url.includes('telemetry.tradingview.com')) {
                return Promise.resolve(new Response('', { status: 200 }));
              }
              return _origFetch.apply(this, arguments);
            };
          }

          // Clear existing widget before reload
          const container = document.getElementById('tradingview-widget');
          container.innerHTML = '';

          const script = document.createElement('script');
          script.src = 'https://s3.tradingview.com/external-embedding/embed-widget-advanced-chart.js';
          script.async = true;
          script.innerHTML = JSON.stringify(config);
          container.appendChild(script);

          // Apply touch-action:none to iframe once TradingView creates it (mobile fix)
          const tvObserver = new MutationObserver(function() {
            const iframes = document.querySelectorAll('.tradingview-widget-container iframe');
            iframes.forEach(function(iframe) { iframe.style.touchAction = 'none'; });
            if (iframes.length > 0) tvObserver.disconnect();
          });
          tvObserver.observe(document.querySelector('.tradingview-widget-container'), { childList: true, subtree: true });
        };

        window._loadTVWidget();
        </script>
        <!-- TradingView Widget END -->
      </div>
    </div>

    <div class="history-section">
      <div class="history-header">
        <div style="display:flex;align-items:center;gap:8px;">
          <h2 style="margin:0;"><i data-lucide="history" style="width:13px;height:13px;vertical-align:middle;margin-right:5px;"></i>Riwayat Perubahan Harga</h2>
          <select id="historyModeSelect" onchange="switchHistoryMode(this.value)">
            <option value="price">Harga Emas</option>
            <option value="usdidr">USD/IDR</option>
          </select>
          <div id="historyModeMobileWrap">
            <button id="historyModeMobileBtn" onclick="toggleHistoryModeDropdown(event)">
              <span id="historyModeBadgeLabel">Harga Emas</span>
              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="6 9 12 15 18 9"/></svg>
            </button>
            <div class="hist-mode-dropdown" id="historyModeDropdown">
              <button type="button" data-mode="price" onclick="selectHistoryMode('price')">Harga Emas</button>
              <button type="button" data-mode="usdidr" onclick="selectHistoryMode('usdidr')">USD/IDR</button>
            </div>
          </div>
        </div>
        <div style="display:flex;align-items:center;gap:8px;">
          <span class="count" id="historyCount">0 records</span>
        </div>
      </div>
      <div class="display-settings-overlay" id="displaySettingsModal" onclick="if(event.target===this)closeDisplaySettings()">
        <div class="display-settings-modal">
          <h3>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
            Pengaturan Tampilan
            <button class="display-settings-close" onclick="closeDisplaySettings()"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>
          </h3>
          <div id="historyFontPanel" style="padding:16px 20px 20px;background:transparent;border:none;">
        <div style="display:flex;gap:16px;align-items:center;flex-wrap:wrap;">
          <span style="font-size:0.75em;color:#8b949e;font-weight:600;">UKURAN FONT MOBILE</span>
          <div style="display:flex;align-items:center;gap:6px;">
            <span style="font-size:0.72em;color:#8b949e;">Nominal</span>
            <button onclick="adjustHistoryFont('nominal',-0.1)" style="width:22px;height:22px;border-radius:5px;background:rgba(255,255,255,0.08);border:1px solid rgba(255,255,255,0.12);color:#fff;cursor:pointer;font-size:0.9em;display:flex;align-items:center;justify-content:center;">−</button>
            <span id="historyFontNominalVal" style="font-size:0.78em;color:#f7931a;font-weight:700;min-width:34px;text-align:center;">100%</span>
            <button onclick="adjustHistoryFont('nominal',0.1)" style="width:22px;height:22px;border-radius:5px;background:rgba(255,255,255,0.08);border:1px solid rgba(255,255,255,0.12);color:#fff;cursor:pointer;font-size:0.9em;display:flex;align-items:center;justify-content:center;">+</button>
          </div>
          <div style="display:flex;align-items:center;gap:6px;">
            <span style="font-size:0.72em;color:#8b949e;">+/−</span>
            <button onclick="adjustHistoryFont('change',-0.1)" style="width:22px;height:22px;border-radius:5px;background:rgba(255,255,255,0.08);border:1px solid rgba(255,255,255,0.12);color:#fff;cursor:pointer;font-size:0.9em;display:flex;align-items:center;justify-content:center;">−</button>
            <span id="historyFontChangeVal" style="font-size:0.78em;color:#f7931a;font-weight:700;min-width:34px;text-align:center;">100%</span>
            <button onclick="adjustHistoryFont('change',0.1)" style="width:22px;height:22px;border-radius:5px;background:rgba(255,255,255,0.08);border:1px solid rgba(255,255,255,0.12);color:#fff;cursor:pointer;font-size:0.9em;display:flex;align-items:center;justify-content:center;">+</button>
          </div>
          <button onclick="resetHistoryFont()" style="font-size:0.7em;color:#8b949e;background:none;border:none;cursor:pointer;text-decoration:underline;">Reset</button>
        </div>
        <div style="display:flex;gap:16px;align-items:center;flex-wrap:wrap;margin-top:8px;padding-top:8px;border-top:1px solid rgba(255,255,255,0.06);">
          <span style="font-size:0.75em;color:#8b949e;font-weight:600;">BELI / JUAL ATAS</span>
          <div style="display:flex;align-items:center;gap:6px;">
            <span style="font-size:0.72em;color:#8b949e;">Nominal</span>
            <button onclick="adjustBuySellFont('nominal',-0.1)" style="width:22px;height:22px;border-radius:5px;background:rgba(255,255,255,0.08);border:1px solid rgba(255,255,255,0.12);color:#fff;cursor:pointer;font-size:0.9em;display:flex;align-items:center;justify-content:center;">−</button>
            <span id="buySellFontNominalVal" style="font-size:0.78em;color:#f7931a;font-weight:700;min-width:34px;text-align:center;">100%</span>
            <button onclick="adjustBuySellFont('nominal',0.1)" style="width:22px;height:22px;border-radius:5px;background:rgba(255,255,255,0.08);border:1px solid rgba(255,255,255,0.12);color:#fff;cursor:pointer;font-size:0.9em;display:flex;align-items:center;justify-content:center;">+</button>
          </div>
          <div style="display:flex;align-items:center;gap:6px;">
            <span style="font-size:0.72em;color:#8b949e;">+/−</span>
            <button onclick="adjustBuySellFont('change',-0.1)" style="width:22px;height:22px;border-radius:5px;background:rgba(255,255,255,0.08);border:1px solid rgba(255,255,255,0.12);color:#fff;cursor:pointer;font-size:0.9em;display:flex;align-items:center;justify-content:center;">−</button>
            <span id="buySellFontChangeVal" style="font-size:0.78em;color:#f7931a;font-weight:700;min-width:34px;text-align:center;">100%</span>
            <button onclick="adjustBuySellFont('change',0.1)" style="width:22px;height:22px;border-radius:5px;background:rgba(255,255,255,0.08);border:1px solid rgba(255,255,255,0.12);color:#fff;cursor:pointer;font-size:0.9em;display:flex;align-items:center;justify-content:center;">+</button>
          </div>
          <button onclick="resetBuySellFont()" style="font-size:0.7em;color:#8b949e;background:none;border:none;cursor:pointer;text-decoration:underline;">Reset</button>
        </div>
        <div style="display:flex;gap:16px;align-items:center;flex-wrap:wrap;margin-top:8px;padding-top:8px;border-top:1px solid rgba(255,255,255,0.06);">
          <span style="font-size:0.75em;color:#8b949e;font-weight:600;">KOTAK BELI / JUAL</span>
          <div style="display:flex;align-items:center;gap:6px;">
            <span style="font-size:0.72em;color:#8b949e;">Ukuran</span>
            <button onclick="adjustBuySellCard(-0.1)" style="width:22px;height:22px;border-radius:5px;background:rgba(255,255,255,0.08);border:1px solid rgba(255,255,255,0.12);color:#fff;cursor:pointer;font-size:0.9em;display:flex;align-items:center;justify-content:center;">−</button>
            <span id="buySellCardVal" style="font-size:0.78em;color:#f7931a;font-weight:700;min-width:34px;text-align:center;">100%</span>
            <button onclick="adjustBuySellCard(0.1)" style="width:22px;height:22px;border-radius:5px;background:rgba(255,255,255,0.08);border:1px solid rgba(255,255,255,0.12);color:#fff;cursor:pointer;font-size:0.9em;display:flex;align-items:center;justify-content:center;">+</button>
          </div>
          <button onclick="resetBuySellCard()" style="font-size:0.7em;color:#8b949e;background:none;border:none;cursor:pointer;text-decoration:underline;">Reset</button>
        </div>
        <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-top:8px;padding-top:8px;border-top:1px solid rgba(255,255,255,0.06);">
          <span style="font-size:0.75em;color:#8b949e;font-weight:600;">BARIS PER HALAMAN</span>
          <div style="display:flex;gap:5px;">
            <button onclick="setHistoryPerPage(10)" id="perPageBtn10" style="padding:3px 9px;border-radius:5px;border:1px solid rgba(255,255,255,0.15);background:rgba(255,255,255,0.08);color:#8b949e;cursor:pointer;font-size:0.78em;">10</button>
            <button onclick="setHistoryPerPage(20)" id="perPageBtn20" style="padding:3px 9px;border-radius:5px;border:1px solid rgba(255,255,255,0.15);background:rgba(255,255,255,0.08);color:#8b949e;cursor:pointer;font-size:0.78em;">20</button>
            <button onclick="setHistoryPerPage(30)" id="perPageBtn30" style="padding:3px 9px;border-radius:5px;border:1px solid rgba(255,255,255,0.15);background:rgba(255,255,255,0.08);color:#8b949e;cursor:pointer;font-size:0.78em;">30</button>
            <button onclick="setHistoryPerPage(50)" id="perPageBtn50" style="padding:3px 9px;border-radius:5px;border:1px solid rgba(255,255,255,0.15);background:rgba(255,255,255,0.08);color:#8b949e;cursor:pointer;font-size:0.78em;">50</button>
          </div>
        </div>
        <div style="display:flex;justify-content:flex-end;margin-top:10px;padding-top:8px;border-top:1px solid rgba(255,255,255,0.06);">
          <button onclick="resetAllDisplaySettings()" style="display:inline-flex;align-items:center;gap:5px;padding:5px 12px;border-radius:6px;border:1px solid rgba(247,147,26,0.4);background:rgba(247,147,26,0.12);color:#f7931a;cursor:pointer;font-size:0.74em;font-weight:600;">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/></svg>
            Default (kembali ke semula)
          </button>
        </div>
          </div>
        </div>
      </div>
      <div id="priceHistoryWrap" class="history-table-wrap">
      <table class="history-table">
        <thead>
          <tr id="historyHeaderRow">
            <th>Waktu</th>
            <th>Beli</th>
            <th>Jual</th>
            <th class="col-spread">Spread</th>
            <th class="col-usdidr">USD/IDR</th>
            <th class="col-markup">Status</th>
          </tr>
        </thead>
        <tbody id="historyBody">
          <tr><td colspan="10" class="no-data">Menunggu data...</td></tr>
        </tbody>
      </table>
      </div>
      <div id="usdIdrHistoryWrap" class="history-table-wrap" style="display:none;">
      <table class="history-table">
        <thead>
          <tr>
            <th>Waktu</th>
            <th>USD/IDR</th>
            <th>Perubahan</th>
          </tr>
        </thead>
        <tbody id="usdIdrHistoryBody">
          <tr><td colspan="3" class="no-data">Belum ada data...</td></tr>
        </tbody>
      </table>
      </div>
      <div class="history-pagination" id="historyPagination" style="display:none;">
        <button class="page-btn" id="prevPage" disabled>Sebelumnya</button>
        <div style="display:flex;align-items:center;gap:5px;">
          <span class="page-info" style="white-space:nowrap;">Hal</span>
          <input id="pageJumpInput" type="number" min="1" style="width:46px;padding:3px 5px;border-radius:5px;border:1px solid rgba(255,255,255,0.15);background:rgba(255,255,255,0.07);color:#fff;font-size:0.82em;text-align:center;" />
          <span class="page-info" style="white-space:nowrap;">/ <span id="totalPagesLabel">1</span></span>
          <button id="pageJumpBtn" class="page-btn" style="padding:4px 8px;min-width:unset;">Go</button>
        </div>
        <button class="page-btn" id="nextPage">Selanjutnya</button>
      </div>
    </div>
  </div>

  <script>
    // ==================== Toast System ====================
    const toastIcons = {
      info: '<circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/>',
      success: '<path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/>',
      warning: '<path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>',
      danger: '<circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/>'
    };

    function showToast(message, type = 'info', duration = 4000) {
      const container = document.getElementById('toastContainer');
      const toast = document.createElement('div');
      toast.className = 'toast ' + type;
      toast.innerHTML = '<div class="toast-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">' + (toastIcons[type] || toastIcons.info) + '</svg></div><div class="toast-message">' + message + '</div>';
      container.appendChild(toast);
      setTimeout(() => {
        toast.style.animation = 'slideOut 0.3s ease forwards';
        setTimeout(() => toast.remove(), 300);
      }, duration);
    }

    let confirmResolver = null;
    function showConfirm(message, title = 'Konfirmasi') {
      return new Promise((resolve) => {
        confirmResolver = resolve;
        document.getElementById('confirmTitle').textContent = title;
        document.getElementById('confirmMessage').textContent = message;
        document.getElementById('confirmModal').classList.add('show');
      });
    }
    function resolveConfirm(result) {
      document.getElementById('confirmModal').classList.remove('show');
      if (confirmResolver) { confirmResolver(result); confirmResolver = null; }
    }

    // ========== INDICATOR SYSTEM ==========
    const INDICATOR_STORAGE_KEY = 'gold_monitor_indicators';

    // All available indicators with TradingView study names
    const ALL_INDICATORS = {
      ma: {
        id: 'ma',
        name: 'Moving Average (MA)',
        desc: 'Simple Moving Average',
        study: 'MASimple@tv-basicstudies',
        color: '#2196F3',
        badgeClass: 'ma',
        guide: {
          title: 'Moving Average (MA)',
          badge: 'Garis Biru',
          description: 'Garis rata-rata harga dalam periode tertentu. Membantu melihat arah trend secara keseluruhan.',
          signals: [
            { icon: 'buy', label: 'BUY', title: 'Harga di ATAS garis MA', desc: 'Trend naik (bullish), pertimbangkan untuk buy/hold' },
            { icon: 'sell', label: 'SELL', title: 'Harga di BAWAH garis MA', desc: 'Trend turun (bearish), waspada atau pertimbangkan sell' },
            { icon: 'info', label: 'TIP', title: 'Harga memotong MA dari bawah ke atas', desc: 'Sinyal potensial pembalikan ke trend naik' }
          ]
        }
      },
      ema: {
        id: 'ema',
        name: 'Exponential MA (EMA)',
        desc: 'Exponential Moving Average',
        study: 'MAExp@tv-basicstudies',
        color: '#00BCD4',
        badgeClass: 'ema',
        guide: {
          title: 'Exponential Moving Average (EMA)',
          badge: 'Garis Cyan',
          description: 'Seperti MA tapi lebih responsif terhadap perubahan harga terbaru. Cocok untuk trading jangka pendek.',
          signals: [
            { icon: 'buy', label: 'BUY', title: 'Harga di ATAS EMA', desc: 'Momentum bullish, trend naik aktif' },
            { icon: 'sell', label: 'SELL', title: 'Harga di BAWAH EMA', desc: 'Momentum bearish, trend turun aktif' },
            { icon: 'info', label: 'TIP', title: 'EMA cross di atas MA', desc: 'Golden cross - sinyal bullish kuat' }
          ]
        }
      },
      bb: {
        id: 'bb',
        name: 'Bollinger Bands',
        desc: 'Volatility bands',
        study: 'BB@tv-basicstudies',
        color: '#9C27B0',
        badgeClass: 'bb',
        guide: {
          title: 'Bollinger Bands (BB)',
          badge: 'Garis Ungu',
          description: '3 garis (atas, tengah, bawah) yang menunjukkan volatilitas dan area overbought/oversold.',
          signals: [
            { icon: 'warn', label: 'OB', title: 'Harga menyentuh/melewati garis ATAS', desc: 'Overbought - harga mungkin terlalu tinggi, potensi koreksi turun' },
            { icon: 'buy', label: 'OS', title: 'Harga menyentuh/melewati garis BAWAH', desc: 'Oversold - harga mungkin terlalu rendah, potensi rebound naik' },
            { icon: 'info', label: 'TIP', title: 'Band menyempit (squeeze)', desc: 'Volatilitas rendah, siap-siap ada pergerakan besar' }
          ]
        }
      },
      vwap: {
        id: 'vwap',
        name: 'VWAP',
        desc: 'Volume Weighted Avg Price',
        study: 'VWAP@tv-basicstudies',
        color: '#FF9800',
        badgeClass: 'vwap',
        guide: {
          title: 'VWAP',
          badge: 'Garis Oranye',
          description: 'Volume Weighted Average Price - harga rata-rata tertimbang volume. Indikator favorit trader institusional.',
          signals: [
            { icon: 'buy', label: 'BUY', title: 'Harga di ATAS VWAP', desc: 'Buyer lebih dominan, trend bullish intraday' },
            { icon: 'sell', label: 'SELL', title: 'Harga di BAWAH VWAP', desc: 'Seller lebih dominan, trend bearish intraday' },
            { icon: 'info', label: 'S/R', title: 'Harga mendekati VWAP', desc: 'VWAP sering jadi area support/resistance dinamis' }
          ]
        }
      },
      rsi: {
        id: 'rsi',
        name: 'RSI',
        desc: 'Relative Strength Index',
        study: 'RSI@tv-basicstudies',
        color: '#E91E63',
        badgeClass: 'rsi',
        guide: {
          title: 'RSI (Relative Strength Index)',
          badge: 'Garis Pink',
          description: 'Oscillator yang mengukur kekuatan trend. Nilai 0-100, dengan level penting di 30 dan 70.',
          signals: [
            { icon: 'buy', label: 'BUY', title: 'RSI di bawah 30', desc: 'Oversold - harga terlalu murah, potensi rebound' },
            { icon: 'sell', label: 'SELL', title: 'RSI di atas 70', desc: 'Overbought - harga terlalu mahal, potensi koreksi' },
            { icon: 'info', label: 'DIV', title: 'Divergence RSI vs Harga', desc: 'Jika RSI naik tapi harga turun = bullish divergence' }
          ]
        }
      },
      macd: {
        id: 'macd',
        name: 'MACD',
        desc: 'Moving Average Convergence',
        study: 'MACD@tv-basicstudies',
        color: '#4CAF50',
        badgeClass: 'macd',
        guide: {
          title: 'MACD',
          badge: 'Garis Hijau',
          description: 'Indikator momentum yang menunjukkan hubungan antara dua moving average. Terdiri dari MACD line, signal line, dan histogram.',
          signals: [
            { icon: 'buy', label: 'BUY', title: 'MACD cross di atas Signal', desc: 'Bullish crossover - momentum naik, sinyal buy' },
            { icon: 'sell', label: 'SELL', title: 'MACD cross di bawah Signal', desc: 'Bearish crossover - momentum turun, sinyal sell' },
            { icon: 'info', label: 'TIP', title: 'Histogram membesar', desc: 'Momentum menguat ke arah trend saat ini' }
          ]
        }
      },
      stoch: {
        id: 'stoch',
        name: 'Stochastic',
        desc: 'Stochastic Oscillator',
        study: 'Stochastic@tv-basicstudies',
        color: '#FF5722',
        badgeClass: 'stoch',
        guide: {
          title: 'Stochastic Oscillator',
          badge: 'Garis Merah-Oranye',
          description: 'Oscillator yang membandingkan harga penutupan dengan range harga. Level penting: 20 (oversold) dan 80 (overbought).',
          signals: [
            { icon: 'buy', label: 'BUY', title: '%K di bawah 20 lalu cross ke atas', desc: 'Oversold + bullish cross = sinyal buy kuat' },
            { icon: 'sell', label: 'SELL', title: '%K di atas 80 lalu cross ke bawah', desc: 'Overbought + bearish cross = sinyal sell kuat' },
            { icon: 'info', label: 'TIP', title: '%K dan %D bergerak bersamaan', desc: 'Konfirmasi trend lebih kuat' }
          ]
        }
      },
      atr: {
        id: 'atr',
        name: 'ATR',
        desc: 'Average True Range',
        study: 'ATR@tv-basicstudies',
        color: '#8D6E63',
        badgeClass: 'atr',
        guide: {
          title: 'ATR (Average True Range)',
          badge: 'Garis Coklat',
          description: 'Mengukur volatilitas pasar. Tidak menunjukkan arah, hanya seberapa besar pergerakan harga.',
          signals: [
            { icon: 'warn', label: 'HIGH', title: 'ATR tinggi/naik', desc: 'Volatilitas tinggi - pasar aktif, pergerakan besar' },
            { icon: 'info', label: 'LOW', title: 'ATR rendah/turun', desc: 'Volatilitas rendah - pasar tenang, siap-siap breakout' },
            { icon: 'info', label: 'SL', title: 'Gunakan untuk Stop Loss', desc: 'SL = 1.5-2x ATR dari entry point' }
          ]
        }
      },
      vol: {
        id: 'vol',
        name: 'Volume',
        desc: 'Trading Volume',
        study: 'Volume@tv-basicstudies',
        color: '#78909C',
        badgeClass: 'vol',
        guide: {
          title: 'Volume',
          badge: 'Bar Abu-abu',
          description: 'Jumlah transaksi dalam periode waktu. Volume tinggi = banyak partisipan, pergerakan lebih valid.',
          signals: [
            { icon: 'buy', label: 'CONF', title: 'Harga naik + Volume tinggi', desc: 'Kenaikan valid, banyak buyer masuk' },
            { icon: 'sell', label: 'CONF', title: 'Harga turun + Volume tinggi', desc: 'Penurunan valid, banyak seller masuk' },
            { icon: 'warn', label: 'WARN', title: 'Harga naik + Volume rendah', desc: 'Kenaikan lemah, bisa jadi false breakout' }
          ]
        }
      },
      ichimoku: {
        id: 'ichimoku',
        name: 'Ichimoku Cloud',
        desc: 'Ichimoku Kinko Hyo',
        study: 'IchimokuCloud@tv-basicstudies',
        color: '#7C4DFF',
        badgeClass: 'ichimoku',
        guide: {
          title: 'Ichimoku Cloud',
          badge: 'Cloud Ungu',
          description: 'Sistem trading lengkap dari Jepang. Menunjukkan support/resistance, momentum, dan arah trend sekaligus.',
          signals: [
            { icon: 'buy', label: 'BUY', title: 'Harga di ATAS cloud', desc: 'Trend bullish kuat, cloud jadi support' },
            { icon: 'sell', label: 'SELL', title: 'Harga di BAWAH cloud', desc: 'Trend bearish kuat, cloud jadi resistance' },
            { icon: 'info', label: 'WAIT', title: 'Harga DI DALAM cloud', desc: 'Zona netral/konsolidasi, tunggu breakout' }
          ]
        }
      }
    };

    // Default active indicators
    const DEFAULT_INDICATORS = ['ma', 'bb', 'vwap'];

    // Get saved indicators or use defaults
    function getActiveIndicators() {
      try {
        const saved = localStorage.getItem(INDICATOR_STORAGE_KEY);
        if (saved) {
          const parsed = JSON.parse(saved);
          return Array.isArray(parsed) ? parsed : DEFAULT_INDICATORS;
        }
      } catch (e) {}
      return DEFAULT_INDICATORS;
    }

    // Save indicators to localStorage
    function saveIndicators(indicators) {
      localStorage.setItem(INDICATOR_STORAGE_KEY, JSON.stringify(indicators));
    }

    // Temporary state for settings modal
    let tempIndicatorState = {};

    // Open Indicator Settings Modal
    // 🎟️ PROMO SUGGESTIONS
    function renderPromoSuggestions(promos) {
      const container = document.getElementById('promoSuggestionsList');
      const lastUpdate = document.getElementById('promoLastUpdate');
      if (!container) return;
      if (!promos || promos.length === 0) {
        container.innerHTML = '<div class="promo-empty">Tidak ada promo aktif saat ini</div>';
      } else {
        container.innerHTML = promos.map(p => {
          const img = p.image_url
            ? '<img class="promo-card-img" src="' + p.image_url + '" alt="' + (p.name || 'Promo') + '" style="width:100%;border-radius:8px;margin-bottom:6px;">'
            : '';
          const link = p.article_url
            ? '<a class="promo-card-link" href="' + p.article_url + '" target="_blank" rel="noopener">Lihat detail &rarr;</a>'
            : '';
          const desc = p.short_desc
            ? '<div class="promo-card-desc" style="font-size:12px;color:#9ca3af;margin-top:2px;">' + p.short_desc + '</div>'
            : '';
          const meta = [];
          if (p.code) meta.push('<span style="color:#22c55e;font-weight:600;">' + p.code + '</span>');
          if (p.min_trx && p.min_trx !== '-') meta.push('Min. ' + p.min_trx);
          if (p.end_to && p.end_to !== '-') meta.push('s/d ' + p.end_to);
          const metaLine = meta.length
            ? '<div class="promo-card-meta" style="font-size:11px;color:#6b7280;margin-top:4px;">' + meta.join(' &middot; ') + '</div>'
            : '';
          const copyBtn = p.code
            ? '<button class="promo-copy-btn" onclick="copyPromoCode(&apos;' + p.code + '&apos;, this)"><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>Salin kode</button>'
            : '';
          return '<div class="promo-card">' +
            img +
            '<div class="promo-card-name">' + (p.name || 'Promo Aktif') + '</div>' +
            desc +
            metaLine +
            '<div style="display:flex;align-items:center;gap:10px;margin-top:6px;">' + copyBtn + link + '</div>' +
          '</div>';
        }).join('');
      }
      if (lastUpdate) lastUpdate.textContent = 'Update: ' + new Date().toLocaleTimeString('id-ID');
      // Update badge count
      const badgeEl = document.getElementById('promoBadge');
      const btnEl = document.getElementById('promoBtnEl');
      const count = (promos && promos.length) ? promos.length : 0;
      if (badgeEl) {
        badgeEl.textContent = count;
        badgeEl.style.display = count > 0 ? 'inline' : 'none';
      }
      // Cek apakah ada promo baru yang belum dilihat
      if (count > 0 && btnEl) {
        const currentIds = (promos || []).map(p => p.code).sort().join(',');
        const seenIds = localStorage.getItem('promoSeenIds') || '';
        if (currentIds !== seenIds) {
          btnEl.classList.add('has-new');
        }
      } else if (btnEl) {
        btnEl.classList.remove('has-new');
      }
    }

    function copyPromoCode(code, btn) {
      const done = function() {
        const old = btn.innerHTML;
        btn.classList.add('copied');
        btn.innerHTML = '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>Tersalin!';
        setTimeout(function(){ btn.classList.remove('copied'); btn.innerHTML = old; }, 1800);
      };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(code).then(done).catch(function(){ _copyFallback(code); done(); });
      } else {
        _copyFallback(code); done();
      }
    }
    function _copyFallback(text) {
      try {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed'; ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
      } catch(e){}
    }

    function openPromoSuggestions() {
      const modal = document.getElementById('promoSuggestionsModal');
      if (modal) modal.classList.add('active');
      monFetch('/api/promo-suggestions').then(r => r.json()).then(data => {
        const promos = data.promos || [];
        renderPromoSuggestions(promos);
        // Mark as seen - simpan IDs ke localStorage
        const seenIds = promos.map(p => p.code).sort().join(',');
        localStorage.setItem('promoSeenIds', seenIds);
        // Hentikan kedip
        const btnEl = document.getElementById('promoBtnEl');
        if (btnEl) btnEl.classList.remove('has-new');
      }).catch(() => {
        const c = document.getElementById('promoSuggestionsList');
        if (c) c.innerHTML = '<div class="promo-empty">Gagal memuat data</div>';
      });
    }

    function closePromoSuggestions() {
      const modal = document.getElementById('promoSuggestionsModal');
      if (modal) modal.classList.remove('active');
    }

    let _newsEventsCache = [];
    let _newsActiveFilters = new Set(['Low','Medium','High']);

    const _HARI = ['Minggu','Senin','Selasa','Rabu','Kamis','Jumat','Sabtu'];
    const _toWIB = (isoStr) => { const d = new Date(isoStr); if (isNaN(d)) return null; return new Date(d.getTime() + 7*3600*1000); };

    function _updateNewsBadge() {
      const badge = document.getElementById('newsBadge');
      if (!badge || _newsEventsCache.length === 0) return;
      const nowWIB = _toWIB(new Date().toISOString());
      if (!nowWIB) return;
      const todayStr = nowWIB.getUTCFullYear() + '-' + String(nowWIB.getUTCMonth()+1).padStart(2,'0') + '-' + String(nowWIB.getUTCDate()).padStart(2,'0');
      const count = _newsEventsCache.filter(ev => {
        if (ev.impact !== 'High') return false;
        if (!ev._wib) return false;
        const evStr = ev._wib.getUTCFullYear() + '-' + String(ev._wib.getUTCMonth()+1).padStart(2,'0') + '-' + String(ev._wib.getUTCDate()).padStart(2,'0');
        return evStr === todayStr;
      }).length;
      if (count > 0) {
        badge.textContent = count;
        badge.style.display = 'inline';
      } else {
        badge.style.display = 'none';
      }
    }

    // Auto-fetch news di background saat load untuk tampilkan badge
    setTimeout(function() {
      monFetch('/api/ff-calendar').then(r => r.json()).then(data => {
        if (data.success && data.events && data.events.length > 0) {
          data.events.forEach(ev => { ev._wib = _toWIB(ev.date); });
          data.events.sort((a,b) => (a._wib||0) - (b._wib||0));
          _newsEventsCache = data.events;
          _updateNewsBadge();
        }
      }).catch(() => {});
    }, 3000);
    const _fmtDate = (d) => { if (!d) return ''; return String(d.getUTCDate()).padStart(2,'0')+'/'+String(d.getUTCMonth()+1).padStart(2,'0')+'/'+d.getUTCFullYear(); };
    const _fmtTime = (d) => { if (!d) return 'All Day'; return String(d.getUTCHours()).padStart(2,'0')+':'+String(d.getUTCMinutes()).padStart(2,'0')+' WIB'; };
    const _fmtDayDate = (d) => { if (!d) return ''; return _HARI[d.getUTCDay()]+', '+_fmtDate(d); };
    const _svgClock = '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:middle;margin-right:3px;opacity:0.6;"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>';
    const _svgCal = '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:middle;margin-right:3px;opacity:0.6;"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>';
    const _svgPin = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#f7931a" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:middle;margin-right:5px;"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg>';
    const _svgCalDays = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#60a5fa" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:middle;margin-right:5px;"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>';
    const _impactNum = { 'High': 3, 'Medium': 2, 'Low': 1 };
    const _impactBars = (impact) => {
      const cfg = { 'High': { n:3, color:'#ef5350' }, 'Medium': { n:2, color:'#ff9800' }, 'Low': { n:1, color:'#ffd600' } };
      const c = cfg[impact];
      if (!c) return '<span style="color:#555;font-size:0.8em;font-weight:600;">—</span>';
      return Array(3).fill(0).map((_,i) => '<span style="display:inline-block;width:5px;height:14px;border-radius:2px;margin-right:2px;background:'+(i<c.n?c.color:'rgba(255,255,255,0.12)')+'"></span>').join('');
    };
    const _impactClass = (impact) => ({ 'High':'impact-high','Medium':'impact-medium','Low':'impact-low' })[impact] || 'impact-low';

    function _fmtCountdown(evMs, nowMs) {
      const diffMs = evMs - nowMs;
      if (diffMs <= 0) return null;
      const totalMin = Math.floor(diffMs / 60000);
      const h = Math.floor(totalMin / 60);
      const m = totalMin % 60;
      if (h > 0) return h + ' jam ' + m + ' menit lagi';
      return m + ' menit lagi';
    }

    function _predictGold(ev) {
      const t = (ev.title || '').toLowerCase();
      const f = ev.forecast ? parseFloat(ev.forecast.replace(/[^0-9.-]/g, '')) : NaN;
      const p = ev.previous ? parseFloat(ev.previous.replace(/[^0-9.-]/g, '')) : NaN;
      if (isNaN(f) || isNaN(p) || f === p) return null;
      // Indikator yang naik = USD kuat = emas turun
      const bullUSD = t.includes('interest rate') || t.includes('fed') || t.includes('fomc') ||
        t.includes('non-farm') || t.includes('nfp') || t.includes('payroll') ||
        t.includes('gdp') || t.includes('retail sales') || t.includes('pmi') ||
        t.includes('ism') || t.includes('consumer confidence') || t.includes('average hourly') ||
        t.includes('core retail') || t.includes('business inventories');
      // Indikator yang naik = USD lemah = emas naik
      const bearUSD = t.includes('unemployment') || t.includes('jobless') || t.includes('claims') ||
        t.includes('unit labor costs');
      // Inflasi: naik = emas naik
      const inflation = t.includes('cpi') || t.includes('inflation') || t.includes('pce') ||
        t.includes('import prices');
      if (bearUSD || inflation) return f > p ? 'NAIK' : 'TURUN';
      if (bullUSD) return f > p ? 'TURUN' : 'NAIK';
      return null;
    }

    function _renderNewsCard(ev, nowMs, isToday) {
      const isPast = ev._wib && ev._wib.getTime() < nowMs;
      const vals = [];
      if (ev.forecast) vals.push('<span>Forecast: '+ev.forecast+'</span>');
      if (ev.previous) vals.push('<span>Prev: '+ev.previous+'</span>');
      if (ev.actual) vals.push('<span class="actual">Actual: '+ev.actual+'</span>');
      const stateClass = isPast ? ' past' : ' upcoming';
      const evMs = ev._wib ? ev._wib.getTime() : 0;
      const countdownHtml = isToday && !isPast
        ? '<span class="news-countdown" data-evms="'+evMs+'">'+(_fmtCountdown(evMs, nowMs)||'')+'</span>'
        : '';
      const pred = !isPast ? _predictGold(ev) : null;
      const predHtml = pred
        ? '<span class="news-pred '+(pred==='NAIK'?'pred-up':'pred-down')+'">'+(pred==='NAIK'?'<svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" style="display:inline;vertical-align:middle;margin-right:2px"><polyline points="18 15 12 9 6 15"/></svg>Emas Naik':'<svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" style="display:inline;vertical-align:middle;margin-right:2px"><polyline points="6 9 12 15 18 9"/></svg>Emas Turun')+'</span>'
        : '';
      return '<div class="news-card '+_impactClass(ev.impact)+stateClass+'">'+
        '<div class="news-bulls">'+_impactBars(ev.impact)+'</div>'+
        '<div class="news-body">'+
          '<div class="news-title-row"><span class="news-title">'+ev.title+'</span>'+predHtml+'</div>'+
          '<div class="news-meta"><span>'+_svgClock+_fmtTime(ev._wib)+'</span><span>'+_svgCal+_fmtDayDate(ev._wib)+'</span>'+countdownHtml+'</div>'+
          (vals.length?'<div class="news-values">'+vals.join('')+'</div>':'')+
        '</div></div>';
    }

    function _renderNewsBody() {
      const body = document.getElementById('newsModalBody');
      if (!body) return;
      const filtered = _newsActiveFilters.size === 0
        ? []
        : _newsEventsCache.filter(ev => _newsActiveFilters.has(ev.impact));
      if (filtered.length === 0) { body.innerHTML = '<div class="news-empty">Tidak ada event dengan filter ini</div>'; return; }
      const nowWIB = _toWIB(new Date().toISOString());
      const nowMs = nowWIB ? nowWIB.getTime() : Date.now();
      const todayStr = _fmtDate(nowWIB);
      const todayMs = nowWIB ? new Date(nowWIB.getUTCFullYear(), nowWIB.getUTCMonth(), nowWIB.getUTCDate()).getTime() : 0;
      const today = [], future = [], past = [];
      filtered.forEach(ev => {
        const evDateStr = _fmtDate(ev._wib);
        if (evDateStr === todayStr) { today.push(ev); }
        else {
          const evMs = ev._wib ? new Date(ev._wib.getUTCFullYear(), ev._wib.getUTCMonth(), ev._wib.getUTCDate()).getTime() : 0;
          if (evMs > todayMs) future.push(ev); else past.push(ev);
        }
      });
      const groupByDay = (evs) => {
        const map = {};
        evs.forEach(ev => { const k = _fmtDayDate(ev._wib)||'Unknown'; if (!map[k]) map[k]=[]; map[k].push(ev); });
        return map;
      };
      const futureByDay = groupByDay(future);
      const pastByDay = groupByDay(past);
      let html = '';
      if (today.length > 0) { html += '<div class="news-section-label">'+_svgPin+'Hari Ini — '+_fmtDayDate(nowWIB)+' ('+today.length+')</div>'+today.map(ev=>_renderNewsCard(ev,nowMs,true)).join(''); }
      Object.entries(futureByDay).forEach(([d,evs]) => { html += '<div class="news-section-label">'+_svgCalDays+d+' ('+evs.length+')</div>'+evs.map(ev=>_renderNewsCard(ev,nowMs,false)).join(''); });
      if (Object.keys(pastByDay).length > 0) {
        // Bagian "Sudah Lewat" dilipat default — klik untuk buka/tutup, biar panel tidak panjang
        const pastCount = past.length;
        let pastHtml = '';
        Object.entries(pastByDay).forEach(([d,evs]) => { pastHtml += '<div class="news-section-label">'+_svgCalDays+d+' ('+evs.length+')</div>'+evs.map(ev=>_renderNewsCard(ev,nowMs,false)).join(''); });
        html += '<button class="news-past-toggle" onclick="var b=document.getElementById(&apos;newsPastBody&apos;);var open=b.style.display!==&apos;none&apos;;b.style.display=open?&apos;none&apos;:&apos;block&apos;;this.querySelector(&apos;.chev&apos;).style.transform=open?&apos;&apos;:&apos;rotate(180deg)&apos;;">'+
          '— Sudah Lewat ('+pastCount+') —'+
          '<svg class="chev" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="transition:transform 0.2s;"><polyline points="6 9 12 15 18 9"/></svg>'+
        '</button>';
        html += '<div id="newsPastBody" style="display:none;">' + pastHtml + '</div>';
      }
      body.innerHTML = html || '<div class="news-empty">Tidak ada event minggu ini</div>';
    }

    function toggleNewsFilter(impact, btn) {
      if (_newsActiveFilters.has(impact)) {
        // Don't allow deselecting all
        if (_newsActiveFilters.size === 1) return;
        _newsActiveFilters.delete(impact);
        btn.classList.remove('active');
      } else {
        _newsActiveFilters.add(impact);
        btn.classList.add('active');
      }
      _renderNewsBody();
    }

    let _newsCountdownInterval = null;
    function _startCountdownTicker() {
      if (_newsCountdownInterval) clearInterval(_newsCountdownInterval);
      _newsCountdownInterval = setInterval(() => {
        const nowMs = Date.now() + 7*3600*1000; // WIB approx
        document.querySelectorAll('.news-countdown[data-evms]').forEach(el => {
          const evMs = parseInt(el.dataset.evms, 10);
          const txt = _fmtCountdown(evMs, nowMs);
          if (txt) { el.textContent = txt; }
          else { el.textContent = ''; el.closest('.news-card')?.classList.replace('upcoming','past'); }
        });
      }, 30000);
    }

    function openNewsModal() {
      const modal = document.getElementById('newsModal');
      if (modal) modal.classList.add('active');
      _startCountdownTicker();
      const body = document.getElementById('newsModalBody');
      if (_newsEventsCache.length > 0) { _renderNewsBody(); return; }
      body.innerHTML = '<div class="news-empty">Memuat kalender Forex Factory...</div>';
      monFetch('/api/ff-calendar')
        .then(r => r.json())
        .then(data => {
          document.getElementById('newsLastUpdate').textContent = 'Update: ' + new Date().toLocaleTimeString('id-ID');
          if (!data.success || !data.events || data.events.length === 0) {
            body.innerHTML = '<div class="news-empty">Tidak ada event USD minggu ini</div>';
            return;
          }
          data.events.forEach(ev => { ev._wib = _toWIB(ev.date); });
          data.events.sort((a,b) => (a._wib||0) - (b._wib||0));
          _newsEventsCache = data.events;
          _updateNewsBadge();
          _renderNewsBody();
        })
        .catch(() => {
          body.innerHTML = '<div class="news-empty">Gagal memuat data Forex Factory</div>';
        });
    }

    function closeNewsModal() {
      const modal = document.getElementById('newsModal');
      if (modal) modal.classList.remove('active');
      if (_newsCountdownInterval) { clearInterval(_newsCountdownInterval); _newsCountdownInterval = null; }
    }

    // ==================== CHAT ====================
    let _chatMyAnimal = '';
    let _chatOpen = false;
    let _chatUnread = 0;

    function _fmtChatTime(ms) {
      const d = new Date(ms);
      return d.toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' });
    }

    function _renderChatBubble(msg) {
      if (msg.isBot) {
        var safeText = msg.text.replace(/</g,'&lt;').replace(/>/g,'&gt;');
        var parts = safeText.split('|');
        var label = parts.length > 1 ? parts[0].trim() : 'SISTEM';
        var body = parts.length > 1 ? parts.slice(1).join('|').trim() : safeText;
        return '<div style="display:flex;justify-content:center;margin:8px 0;">' +
          '<div style="background:rgba(247,147,26,0.07);border:1px solid rgba(247,147,26,0.2);border-radius:10px;padding:8px 16px;max-width:92%;text-align:center;">' +
          '<div style="font-size:0.68em;font-weight:700;color:rgba(247,147,26,0.75);letter-spacing:0.08em;text-transform:uppercase;margin-bottom:3px;">'+label+'</div>' +
          '<div style="font-size:0.84em;color:#c4d0df;line-height:1.4;">'+body+'</div>' +
          '<div style="font-size:0.68em;color:#4e606e;margin-top:3px;">'+_fmtChatTime(msg.time)+'</div>' +
          '</div></div>';
      }
      const isMine = msg.animal === _chatMyAnimal;
      return '<div style="display:flex;flex-direction:column;align-items:'+(isMine?'flex-end':'flex-start')+'">' +
        '<div class="chat-animal '+(isMine?'mine':'others')+'">'+msg.animal+'</div>'+
        '<div class="chat-bubble '+(isMine?'mine':'others')+'">'+msg.text.replace(/</g,'&lt;').replace(/>/g,'&gt;')+'</div>'+
        '<div class="chat-time">'+_fmtChatTime(msg.time)+'</div>'+
      '</div>';
    }

    function _appendChatMsg(msg) {
      const box = document.getElementById('chatMessages');
      if (!box) return;
      const el = document.createElement('div');
      el.innerHTML = _renderChatBubble(msg);
      box.appendChild(el.firstChild);
      box.scrollTop = box.scrollHeight;
      if (!_chatOpen) {
        _chatUnread++;
        const badge = document.getElementById('chatUnreadBadge');
        if (badge) { badge.textContent = _chatUnread; badge.style.display = ''; badge.classList.add('pulse'); }
      }
    }

    function _loadChatHistory(messages) {
      const box = document.getElementById('chatMessages');
      if (!box) return;
      box.innerHTML = messages.map(_renderChatBubble).join('');
      box.scrollTop = box.scrollHeight;
    }

    function openChatModal() {
      _chatOpen = true;
      _chatUnread = 0;
      const badge = document.getElementById('chatUnreadBadge');
      if (badge) { badge.style.display = 'none'; badge.classList.remove('pulse'); }
      const modal = document.getElementById('chatModal');
      if (modal) modal.classList.add('active');
      const box = document.getElementById('chatMessages');
      if (box) box.scrollTop = box.scrollHeight;
      document.getElementById('chatInput')?.focus();
    }

    function closeChatModal() {
      _chatOpen = false;
      const modal = document.getElementById('chatModal');
      if (modal) modal.classList.remove('active');
    }

    function sendChat() {
      const input = document.getElementById('chatInput');
      const text = input?.value?.trim();
      if (!text) return;
      input.value = '';
      const session = localStorage.getItem('goldmonitor_session') || '';
      fetch('/api/chat/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session, message: text })
      }).catch(() => {});
    }

    function openIndicatorSettings() {
      const activeIndicators = getActiveIndicators();
      tempIndicatorState = {};

      // Build list HTML
      let html = '';
      const RECOMMENDED_IND = ['ma', 'bb', 'vwap']; // kombinasi default terbaik untuk pantau emas
      Object.values(ALL_INDICATORS).forEach(ind => {
        const isActive = activeIndicators.includes(ind.id);
        tempIndicatorState[ind.id] = isActive;
        const recBadge = RECOMMENDED_IND.includes(ind.id) ? '<span class="ind-rec-badge">Rekomendasi</span>' : '';
        html += '<div class="indicator-item ' + (isActive ? 'active' : '') + '" data-id="' + ind.id + '">' +
          '<div class="indicator-item-info">' +
            '<div class="indicator-item-color" style="background:' + ind.color + '"></div>' +
            '<div class="indicator-item-details">' +
              '<h5>' + ind.name + recBadge + '</h5>' +
              '<span>' + ind.desc + '</span>' +
            '</div>' +
          '</div>' +
          '<div class="indicator-toggle ' + (isActive ? 'active' : '') + '" onclick="toggleIndicator(&apos;' + ind.id + '&apos;, this)"></div>' +
        '</div>';
      });

      document.getElementById('indicatorList').innerHTML = html;
      document.getElementById('indicatorSettingsModal').classList.add('active');
      document.body.style.overflow = 'hidden';
    }

    function closeIndicatorSettings() {
      document.getElementById('indicatorSettingsModal').classList.remove('active');
      document.body.style.overflow = '';
    }

    function toggleIndicator(id, toggleEl) {
      tempIndicatorState[id] = !tempIndicatorState[id];
      toggleEl.classList.toggle('active');
      toggleEl.closest('.indicator-item').classList.toggle('active');
    }

    function applyIndicatorSettings() {
      const selected = Object.keys(tempIndicatorState).filter(k => tempIndicatorState[k]);
      saveIndicators(selected);
      showToast('Indikator disimpan. Halaman akan di-refresh...', 'success');
      setTimeout(() => location.reload(), 1000);
    }

    // Render dynamic guide content
    function renderIndicatorGuide() {
      const activeIndicators = getActiveIndicators();
      const guideBody = document.getElementById('indicatorGuideBody');

      if (activeIndicators.length === 0) {
        guideBody.innerHTML = '<div class="no-indicator-msg">' +
          '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>' +
          '<p>Tidak ada indikator aktif.<br>Klik tombol "Indikator" untuk menambahkan.</p>' +
        '</div>';
        return;
      }

      let html = '';
      activeIndicators.forEach(id => {
        const ind = ALL_INDICATORS[id];
        if (!ind || !ind.guide) return;

        const g = ind.guide;
        html += '<div class="indicator-section">' +
          '<h4>' + g.title + ' <span class="badge ' + ind.badgeClass + '">' + g.badge + '</span></h4>' +
          '<p class="indicator-desc">' + g.description + '</p>' +
          '<div class="indicator-signals">';

        g.signals.forEach(s => {
          html += '<div class="signal-item">' +
            '<div class="signal-icon ' + s.icon + '">' + s.label + '</div>' +
            '<div class="signal-text">' +
              '<strong>' + s.title + '</strong>' +
              '<p>' + s.desc + '</p>' +
            '</div>' +
          '</div>';
        });

        html += '</div></div>';
      });

      guideBody.innerHTML = html;
    }

    // Indicator Guide Modal Functions
    function openIndicatorGuide() {
      renderIndicatorGuide();
      document.getElementById('indicatorModal').classList.add('active');
      document.body.style.overflow = 'hidden';
    }
    function closeIndicatorGuide() {
      document.getElementById('indicatorModal').classList.remove('active');
      document.body.style.overflow = '';
    }

    // Close modals on overlay click
    document.getElementById('indicatorModal').addEventListener('click', function(e) {
      if (e.target === this) closeIndicatorGuide();
    });
    document.getElementById('indicatorSettingsModal').addEventListener('click', function(e) {
      if (e.target === this) closeIndicatorSettings();
    });

    // Close on Escape key
    document.addEventListener('keydown', function(e) {
      if (e.key === 'Escape') {
        if (document.getElementById('indicatorModal').classList.contains('active')) {
          closeIndicatorGuide();
        }
        if (document.getElementById('indicatorSettingsModal').classList.contains('active')) {
          closeIndicatorSettings();
        }
        if (document.getElementById('goldCalcModal').classList.contains('active')) {
          closeGoldCalc();
        }
      }
    });
    // ========== END INDICATOR SYSTEM ==========

    // ========== GOLD CALCULATOR ==========
    let calcCurrentPrice = 0;
    let calcPriceType = 'buy'; // 'buy' or 'sell'

    function openGoldCalc() {
      // Update both prices
      document.getElementById('calcBuyPrice').textContent =
        lastBuy > 0 ? 'Rp ' + lastBuy.toLocaleString('id-ID') : 'Rp -';
      document.getElementById('calcSellPrice').textContent =
        lastSell > 0 ? 'Rp ' + lastSell.toLocaleString('id-ID') : 'Rp -';

      // Set current price based on selected type
      calcCurrentPrice = calcPriceType === 'buy' ? lastBuy : lastSell;

      document.getElementById('goldCalcModal').classList.add('active');
      document.body.style.overflow = 'hidden';
    }

    function closeGoldCalc() {
      document.getElementById('goldCalcModal').classList.remove('active');
      document.body.style.overflow = '';
    }

    function switchPriceType(type) {
      calcPriceType = type;
      calcCurrentPrice = type === 'buy' ? lastBuy : lastSell;

      // Update UI
      document.getElementById('calcPriceBuy').classList.toggle('active', type === 'buy');
      document.getElementById('calcPriceSell').classList.toggle('active', type === 'sell');

      // Recalculate if there's input
      calculateGold();
      calculateMoney();
    }

    function switchCalcTab(tab) {
      document.querySelectorAll('.calc-tab').forEach(t => t.classList.remove('active'));
      event.target.classList.add('active');

      if (tab === 'uangToGram') {
        document.getElementById('calcUangToGram').style.display = 'block';
        document.getElementById('calcGramToUang').style.display = 'none';
      } else {
        document.getElementById('calcUangToGram').style.display = 'none';
        document.getElementById('calcGramToUang').style.display = 'block';
      }
    }

    function calculateGold() {
      const uang = parseFloat(document.getElementById('calcInputUang').value) || 0;
      const resultDiv = document.getElementById('calcResultGram');

      if (uang > 0 && calcCurrentPrice > 0) {
        const gram = uang / calcCurrentPrice;
        document.getElementById('calcGramResult').textContent = gram.toFixed(4) + ' gram';
        document.getElementById('calcGramSub').textContent =
          'Harga ' + (calcPriceType === 'buy' ? 'Beli' : 'Jual') + ': Rp ' + calcCurrentPrice.toLocaleString('id-ID') + '/gram';
        resultDiv.style.display = 'block';
      } else {
        resultDiv.style.display = 'none';
      }
    }

    function calculateMoney() {
      const gram = parseFloat(document.getElementById('calcInputGram').value) || 0;
      const resultDiv = document.getElementById('calcResultUang');

      if (gram > 0 && calcCurrentPrice > 0) {
        const uang = gram * calcCurrentPrice;
        document.getElementById('calcUangResult').textContent = 'Rp ' + Math.round(uang).toLocaleString('id-ID');
        document.getElementById('calcUangSub').textContent =
          gram.toFixed(4) + ' gram x Rp ' + calcCurrentPrice.toLocaleString('id-ID') + ' (' + (calcPriceType === 'buy' ? 'Beli' : 'Jual') + ')';
        resultDiv.style.display = 'block';
      } else {
        resultDiv.style.display = 'none';
      }
    }

    function resetCalc() {
      document.getElementById('calcInputUang').value = '';
      document.getElementById('calcInputGram').value = '';
      document.getElementById('calcResultGram').style.display = 'none';
      document.getElementById('calcResultUang').style.display = 'none';
    }

    // Close calc modal on overlay click
    document.getElementById('goldCalcModal').addEventListener('click', function(e) {
      if (e.target === this) closeGoldCalc();
    });
    // ========== END GOLD CALCULATOR ==========

    const days = ['Minggu', 'Senin', 'Selasa', 'Rabu', 'Kamis', 'Jumat', 'Sabtu'];
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'Mei', 'Jun', 'Jul', 'Agu', 'Sep', 'Okt', 'Nov', 'Des'];

    let lastBuy = 0;
    let lastSell = 0;
    let lastUsdIdr = 0;
    let sessionHigh = null;
    let sessionLow = null;
    let _markupMinMargin = 0.7;
    let _markupMaxMargin = 2.0;

    var _nominalProfit = {}; // { nominalId: [profit1, profit2, ...] }

    // ── Skeleton loading ────────────────────────────────────────
    ;['buyPrice','sellPrice','usdIdr','spreadPercent'].forEach(function(id) {
      var el = document.getElementById(id);
      if (el) { el.textContent = ''; el.classList.add('stat-val-skeleton'); }
    });
    let lastUpdatedAt = 0; // Track timestamp untuk anti flip-flop
    function _getPerPage() {
      try { var v = parseInt(localStorage.getItem('historyPerPage')); if (v && [10,20,30,50].includes(v)) return v; } catch(e) {}
      return 10;
    }
    function _updatePerPageButtons() {
      var pp = _getPerPage();
      [10,20,30,50].forEach(function(n) {
        var btn = document.getElementById('perPageBtn' + n);
        if (!btn) return;
        if (n === pp) {
          btn.style.background = 'rgba(247,147,26,0.25)';
          btn.style.color = '#f7931a';
          btn.style.borderColor = 'rgba(247,147,26,0.5)';
        } else {
          btn.style.background = 'rgba(255,255,255,0.08)';
          btn.style.color = '#8b949e';
          btn.style.borderColor = 'rgba(255,255,255,0.15)';
        }
      });
    }
    window.setHistoryPerPage = function(n) {
      try { localStorage.setItem('historyPerPage', String(n)); } catch(e) {}
      _updatePerPageButtons();
      currentPage = 1;
      loadHistory();
    };
    let currentPage = 1;
    let totalPages = 1;
    let totalRecords = 0;
    let currentUsdIdr = 0;

    // Load history dari server (sama untuk semua user)
    // History font size settings (saved to localStorage)
    var _historyFontDefaults = { nominal: 1.2, change: 1.0 };
    function _getHistoryFontSettings() {
      try {
        var s = localStorage.getItem('historyFontSettings');
        if (s) { var p = JSON.parse(s); return { nominal: p.nominal || 1.2, change: p.change || 1.0 }; }
      } catch(e) {}
      return { nominal: 1.2, change: 1.0 };
    }
    function _saveHistoryFontSettings(s) {
      try { localStorage.setItem('historyFontSettings', JSON.stringify(s)); } catch(e) {}
    }
    function _emToPct(em) { return Math.round(em * 100 / 1.2 * 10) / 10; }
    function _updateHistoryFontDisplay() {
      var s = _getHistoryFontSettings();
      var nEl = document.getElementById('historyFontNominalVal');
      var cEl = document.getElementById('historyFontChangeVal');
      if (nEl) nEl.textContent = Math.round(s.nominal / 1.2 * 100) + '%';
      if (cEl) cEl.textContent = Math.round(s.change / 1.0 * 100) + '%';
    }
    window.toggleHistoryFontPanel = function() {
      if (typeof window.openDisplaySettings === 'function') window.openDisplaySettings();
    };
    window.adjustHistoryFont = function(type, delta) {
      var s = _getHistoryFontSettings();
      var val = Math.round((s[type] + delta) * 10) / 10;
      if (val < 0.5) val = 0.5;
      if (val > 2.5) val = 2.5;
      s[type] = val;
      _saveHistoryFontSettings(s);
      _updateHistoryFontDisplay();
      loadHistory();
    };
    window.resetHistoryFont = function() {
      _saveHistoryFontSettings({ nominal: 1.2, change: 1.0 });
      _updateHistoryFontDisplay();
      loadHistory();
    };

    // ---- Stat items font settings — semua 3 card konsisten ----
    function _getBuySellFontSettings() {
      try {
        var s = localStorage.getItem('buySellFontSettings');
        if (s) { var p = JSON.parse(s); return { nominal: p.nominal || 1.0, change: p.change || 1.0 }; }
      } catch(e) {}
      return { nominal: 1.0, change: 1.0 };
    }
    function _saveBuySellFontSettings(s) {
      try { localStorage.setItem('buySellFontSettings', JSON.stringify(s)); } catch(e) {}
    }
    function _updateBuySellFontDisplay() {
      var s = _getBuySellFontSettings();
      var nEl = document.getElementById('buySellFontNominalVal');
      var cEl = document.getElementById('buySellFontChangeVal');
      if (nEl) nEl.textContent = Math.round(s.nominal * 100) + '%';
      if (cEl) cEl.textContent = Math.round(s.change * 100) + '%';
    }
    function _applyBuySellFontToDOM() {
      var s = _getBuySellFontSettings();
      // Apply ke semua 3 card: Beli, Jual, USD/IDR
      ['buyPriceNum','sellPriceNum'].forEach(function(id) {
        var el = document.getElementById(id);
        if (el) el.style.fontSize = s.nominal + 'em';
      });
      // USD/IDR value — hapus inline style agar CSS yang kontrol (konsisten)
      var usdEl = document.getElementById('usdIdr');
      if (usdEl) usdEl.style.fontSize = '';
      // Change badges — semua 3 card pakai skala yang sama
      ['buyChange','sellChange','usdIdrChange'].forEach(function(id) {
        var el = document.getElementById(id);
        if (el) el.style.fontSize = s.change + 'em';
      });
    }
    window.adjustBuySellFont = function(type, delta) {
      var s = _getBuySellFontSettings();
      var val = Math.round((s[type] + delta) * 10) / 10;
      if (val < 0.5) val = 0.5;
      if (val > 3.0) val = 3.0;
      s[type] = val;
      _saveBuySellFontSettings(s);
      _updateBuySellFontDisplay();
      _applyBuySellFontToDOM();
    };
    window.resetBuySellFont = function() {
      _saveBuySellFontSettings({ nominal: 1.0, change: 1.0 });
      _updateBuySellFontDisplay();
      _applyBuySellFontToDOM();
    };

    // ---- Beli/Jual Card Size (mobile only) ----
    function _getBuySellCardSettings() {
      try {
        var s = localStorage.getItem('buySellCardSettings');
        if (s) { var p = JSON.parse(s); return { scale: p.scale || 1.0 }; }
      } catch(e) {}
      return { scale: 1.0 };
    }
    function _saveBuySellCardSettings(s) {
      try { localStorage.setItem('buySellCardSettings', JSON.stringify(s)); } catch(e) {}
    }
    function _updateBuySellCardDisplay() {
      var el = document.getElementById('buySellCardVal');
      if (el) el.textContent = Math.round(_getBuySellCardSettings().scale * 100) + '%';
    }
    function _applyBuySellCardToDOM() {
      var isDesktop = window.innerWidth > 768;
      var sc = _getBuySellCardSettings().scale;
      var vPad = Math.round(5 * sc);
      var hPad = Math.round(8 * sc);
      var gap  = Math.round(4 * sc);
      ['buyCard','sellCard'].forEach(function(id) {
        var el = document.getElementById(id);
        if (!el) return;
        if (isDesktop) {
          // Hapus inline style mobile agar CSS desktop kembali berlaku (responsif saat zoom in/out)
          el.style.padding = '';
          el.style.gap = '';
        } else {
          el.style.padding = vPad + 'px ' + hPad + 'px';
          el.style.gap = gap + 'px';
        }
      });
    }
    window.adjustBuySellCard = function(delta) {
      var s = _getBuySellCardSettings();
      var val = Math.round((s.scale + delta) * 10) / 10;
      if (val < 0.5) val = 0.5;
      if (val > 4.0) val = 4.0;
      s.scale = val;
      _saveBuySellCardSettings(s);
      _updateBuySellCardDisplay();
      _applyBuySellCardToDOM();
    };
    window.resetBuySellCard = function() {
      _saveBuySellCardSettings({ scale: 1.0 });
      _updateBuySellCardDisplay();
      ['buyCard','sellCard'].forEach(function(id) {
        var el = document.getElementById(id);
        if (el) { el.style.padding = ''; el.style.gap = ''; }
      });
    };

    // Kembalikan SEMUA pengaturan tampilan ke default semula
    window.resetAllDisplaySettings = function() {
      _saveHistoryFontSettings({ nominal: 1.2, change: 1.0 });
      _saveBuySellFontSettings({ nominal: 1.0, change: 1.0 });
      _saveBuySellCardSettings({ scale: 1.0 });
      try { localStorage.setItem('historyPerPage', '10'); } catch(e) {}
      currentPage = 1;
      // Bersihkan inline style kotak beli/jual
      ['buyCard','sellCard'].forEach(function(id) {
        var el = document.getElementById(id);
        if (el) { el.style.padding = ''; el.style.gap = ''; }
      });
      // Refresh tampilan & nilai persen
      _updateHistoryFontDisplay();
      _updateBuySellFontDisplay();
      _updateBuySellCardDisplay();
      _updatePerPageButtons();
      _applyBuySellFontToDOM();
      _applyBuySellCardToDOM();
      loadHistory();
    };

    let _historyMode = 'price'; // 'price' | 'usdidr'

    function switchHistoryMode(mode) {
      _historyMode = mode;
      const priceWrap = document.getElementById('priceHistoryWrap');
      const usdIdrWrap = document.getElementById('usdIdrHistoryWrap');
      const fontBtn = document.getElementById('historyFontSettingsBtn');
      const pagination = document.getElementById('historyPagination');
      // Sync badge label
      const badgeLabel = document.getElementById('historyModeBadgeLabel');
      if (badgeLabel) badgeLabel.textContent = mode === 'price' ? 'Harga Emas' : 'USD/IDR';
      if (mode === 'usdidr') {
        priceWrap.style.display = 'none';
        usdIdrWrap.style.display = '';
        if (fontBtn) fontBtn.style.display = 'none';
        if (pagination) pagination.style.display = 'none';
        if (typeof window.closeDisplaySettings === 'function') window.closeDisplaySettings();
        loadUsdIdrHistory();
      } else {
        priceWrap.style.display = '';
        usdIdrWrap.style.display = 'none';
        if (fontBtn) fontBtn.style.display = '';
        loadHistory();
      }
    }

    function cycleHistoryMode() {
      const newMode = _historyMode === 'price' ? 'usdidr' : 'price';
      const sel = document.getElementById('historyModeSelect');
      if (sel) sel.value = newMode;
      switchHistoryMode(newMode);
    }

    function _syncHistoryModeDropdownActive() {
      document.querySelectorAll('#historyModeDropdown button').forEach(function(b) {
        b.classList.toggle('active', b.dataset.mode === _historyMode);
      });
    }
    window.toggleHistoryModeDropdown = function(e) {
      if (e) e.stopPropagation();
      const dd = document.getElementById('historyModeDropdown');
      if (!dd) return;
      const willOpen = !dd.classList.contains('open');
      dd.classList.toggle('open', willOpen);
      if (willOpen) _syncHistoryModeDropdownActive();
    };
    window.selectHistoryMode = function(mode) {
      const dd = document.getElementById('historyModeDropdown');
      if (dd) dd.classList.remove('open');
      const sel = document.getElementById('historyModeSelect');
      if (sel) sel.value = mode;
      switchHistoryMode(mode);
    };
    document.addEventListener('click', function(ev) {
      const wrap = document.getElementById('historyModeMobileWrap');
      const dd = document.getElementById('historyModeDropdown');
      if (dd && dd.classList.contains('open') && wrap && !wrap.contains(ev.target)) {
        dd.classList.remove('open');
      }
    });

    function loadUsdIdrHistory() {
      monFetch('/usd-idr-history')
        .then(r => r.json())
        .then(data => {
          renderUsdIdrHistory(data.items || [], data.total || 0);
        })
        .catch(() => {
          document.getElementById('usdIdrHistoryBody').innerHTML = '<tr><td colspan="3" class="no-data">Gagal memuat data</td></tr>';
        });
    }

    function renderUsdIdrHistory(items, total) {
      const tbody = document.getElementById('usdIdrHistoryBody');
      const countEl = document.getElementById('historyCount');
      if (countEl) countEl.textContent = total + ' records';
      if (!items || items.length === 0) {
        tbody.innerHTML = '<tr><td colspan="3" class="no-data">Belum ada data perubahan USD/IDR</td></tr>';
        return;
      }
      const _triUp = '<svg width="10" height="10" viewBox="0 0 10 10" fill="currentColor" style="display:inline;vertical-align:middle;margin-right:2px"><polygon points="5,0 10,10 0,10"/></svg>';
      const _triDn = '<svg width="10" height="10" viewBox="0 0 10 10" fill="currentColor" style="display:inline;vertical-align:middle;margin-right:2px"><polygon points="0,0 10,0 5,10"/></svg>';
      let html = '';
      items.forEach(function(item) {
        const timeStr = typeof item.time === 'string' ? item.time.substring(11, 19) : '-';
        const rate = Math.round(item.rate).toLocaleString('id-ID');
        const change = item.change || 0;
        const changeHtml = change > 0
          ? '<span style="color:#22c55e;font-weight:600;">' + _triUp + '+' + Math.round(change).toLocaleString('id-ID') + '</span>'
          : change < 0
          ? '<span style="color:#ef4444;font-weight:600;">' + _triDn + Math.round(change).toLocaleString('id-ID') + '</span>'
          : '<span style="color:#8b949e;">-</span>';
        html += '<tr><td>' + timeStr + '</td><td>Rp ' + rate + '</td><td>' + changeHtml + '</td></tr>';
      });
      tbody.innerHTML = html;
    }

    function loadHistory() {
      const url = '/price-history?page=' + currentPage + '&perPage=' + _getPerPage();
      monFetch(url)
        .then(r => {
          return r.json();
        })
        .then(data => {
          totalRecords = data.total || 0;
          totalPages = data.totalPages || 1;
          if (data.currentUsdIdr) currentUsdIdr = data.currentUsdIdr;
          renderServerHistory(data.items || []);
        })
        .catch(err => {
          renderServerHistory([]);
        });
    }

    function renderServerHistory(items) {
      const tbody = document.getElementById('historyBody');
      const countEl = document.getElementById('historyCount');
      const pagination = document.getElementById('historyPagination');
      var _hfs = _getHistoryFontSettings();

      if (!items || items.length === 0) {
        tbody.innerHTML = '<tr><td colspan="9" class="no-data">Belum ada data perubahan harga</td></tr>';
        countEl.textContent = '0 records';
        pagination.style.display = 'none';
        return;
      }

      countEl.textContent = totalRecords + ' records';

      const DAYS_ID = ['Min', 'Sen', 'Sel', 'Rab', 'Kam', 'Jum', 'Sab'];
      const MONTHS_ID = ['Jan', 'Feb', 'Mar', 'Apr', 'Mei', 'Jun', 'Jul', 'Agu', 'Sep', 'Okt', 'Nov', 'Des'];

      // Deteksi apakah ada row baru (item pertama berbeda dari sebelumnya)
      const topItemTime = items[0] ? String(items[0].time) : '';
      const isNewTop = currentPage === 1 && topItemTime && topItemTime !== window._lastHistoryTopTime;
      if (isNewTop) window._lastHistoryTopTime = topItemTime;

      let html = '';
      items.forEach(function(item, index) {
        // Parse date robustly — replace space with T for non-ISO strings
        const time = new Date(typeof item.time === 'string' ? item.time.replace(' ', 'T') : item.time);
        const timeStr = isNaN(time) ? String(item.time).substring(11, 19) || '-' : time.toTimeString().substring(0, 8);
        const dateStr = isNaN(time) ? '' : DAYS_ID[time.getDay()] + ', ' + time.getDate() + ' ' + MONTHS_ID[time.getMonth()] + ' ' + time.getFullYear();
        const buyChange = item.buyChange || 0;
        const changeSign = buyChange >= 0 ? '+' : '';
        const changeClass = buyChange >= 0 ? 'price-up' : 'price-down';

        // Calculate spread (if not in data, calculate it)
        const spread = item.spread || ((item.sell - item.buy) / item.buy * 100).toFixed(2);
        const spreadClass = parseFloat(spread) < 0 ? 'price-down' : '';

        // USD/IDR - filter out known hardcoded values (15900, 16600), use current rate as fallback
        const HARDCODED_RATES = [15900, 16600];
        const rawUsdIdr = item.usdIdr && !HARDCODED_RATES.includes(Math.round(item.usdIdr)) ? item.usdIdr : null;
        const usdIdrVal = rawUsdIdr || currentUsdIdr;
        const usdIdr = usdIdrVal ? Math.round(usdIdrVal).toLocaleString('id-ID') : '-';

        // USD/IDR change - bandingkan dgn data SEBELUMNYA (lebih lama, di bawahnya),
        // konsisten dgn kolom Beli/Jual, agar baris terbaru (index 0) ikut tampil perubahan
        const prevItem = items[index + 1];
        const prevRaw = prevItem?.usdIdr && !HARDCODED_RATES.includes(Math.round(prevItem.usdIdr)) ? prevItem.usdIdr : null;
        const usdIdrChange = (rawUsdIdr && prevRaw) ? Math.round(usdIdrVal) - Math.round(prevRaw) : 0;
        const usdIdrChangeSign = usdIdrChange > 0 ? '+' : usdIdrChange < 0 ? '-' : '';
        const usdIdrChangeClass = usdIdrChange > 0 ? 'price-up' : usdIdrChange < 0 ? 'price-down' : '';

        // Calculate gram & profit dynamically for selected history nominals
        const nominalCols = getHistoryNominals().map((n, idx) => {
          const gram = n.amount / item.buy;
          const profit = Math.round((gram * item.sell) - (n.amount - n.amount * n.discountRate));
          const profitClass = profit >= 0 ? 'price-up' : 'price-down';
          const profitSign = profit >= 0 ? '+' : '-';
          return '<td class="td-nominal td-nom-' + idx + '"><span class="nom-gram">' + gram.toFixed(4) + 'g</span><br><small class="' + profitClass + '">' + profitSign + 'Rp ' + Math.abs(profit).toLocaleString('id-ID') + '</small></td>';
        }).join('');

        const sellChange = item.sellChange || 0;
        const _triUp = '<svg width="10" height="10" viewBox="0 0 10 10" fill="currentColor" style="display:inline;vertical-align:middle;margin-right:2px"><polygon points="5,0 10,10 0,10"/></svg>';
        const _triDn = '<svg width="10" height="10" viewBox="0 0 10 10" fill="currentColor" style="display:inline;vertical-align:middle;margin-right:2px"><polygon points="0,0 10,0 5,10"/></svg>';
        const arrowHtml = buyChange > 0
          ? ' <span style="color:#22c55e;font-size:' + _hfs.change + 'em;font-weight:600;white-space:nowrap;">' + _triUp + '+' + buyChange.toLocaleString('id-ID') + '</span>'
          : buyChange < 0
          ? ' <span style="color:#ef4444;font-size:' + _hfs.change + 'em;font-weight:600;white-space:nowrap;">' + _triDn + buyChange.toLocaleString('id-ID') + '</span>'
          : '';
        const sellArrowHtml = sellChange > 0
          ? ' <span style="color:#22c55e;font-size:' + _hfs.change + 'em;font-weight:600;white-space:nowrap;">' + _triUp + '+' + sellChange.toLocaleString('id-ID') + '</span>'
          : sellChange < 0
          ? ' <span style="color:#ef4444;font-size:' + _hfs.change + 'em;font-weight:600;white-space:nowrap;">' + _triDn + sellChange.toLocaleString('id-ID') + '</span>'
          : '';

        // Markup badge — hitung ulang pakai setting aktif (_markupMinMargin/_markupMaxMargin)
        const warnIcon = '<svg viewBox="0 0 16 16" width="10" height="10" fill="currentColor" style="flex-shrink:0"><path d="M8.982 1.566a1.13 1.13 0 0 0-1.96 0L.165 13.233c-.457.778.091 1.767.98 1.767h13.713c.889 0 1.438-.99.98-1.767L8.982 1.566zM8 5c.535 0 .954.462.9.995l-.35 3.507a.552.552 0 0 1-1.1 0L7.1 5.995A.905.905 0 0 1 8 5zm.002 6a1 1 0 1 1 0 2 1 1 0 0 1 0-2z"/></svg>';
        const checkIcon = '<svg viewBox="0 0 16 16" width="10" height="10" fill="currentColor" style="flex-shrink:0"><path d="M13.854 3.646a.5.5 0 0 1 0 .708l-7 7a.5.5 0 0 1-.708 0l-3.5-3.5a.5.5 0 1 1 .708-.708L6.5 10.293l6.646-6.647a.5.5 0 0 1 .708 0z"/></svg>';
        let markupHtml = '';
        if (item.xauUsd && item.usdIdr) {
          const _base = (item.xauUsd * item.usdIdr) / 31.1035;
          const _lower = _base * (1 + _markupMinMargin / 100);
          const _upper = _base * (1 + _markupMaxMargin / 100);
          if (item.sell >= _lower && item.sell <= _upper) {
            markupHtml = '<span class="markup-badge markup-normal">' + checkIcon + ' Normal</span>';
          } else {
            const _diff = item.sell < _lower ? Math.round(item.sell - _lower) : Math.round(item.sell - _upper);
            const _sign = _diff > 0 ? '+' : '';
            markupHtml = '<span class="markup-badge markup-abnormal">' + warnIcon + ' ' + (_diff > 0 ? 'MARKUP' : 'MARKDOWN') + ' ' + _sign + _diff.toLocaleString('id-ID') + '</span>';
          }
        }

        const buyColorStyle = buyChange > 0 ? 'color:#4ade80;font-weight:600;' : buyChange < 0 ? 'color:#f87171;font-weight:600;' : '';
        const sellColorStyle = sellChange > 0 ? 'color:#4ade80;font-weight:600;' : sellChange < 0 ? 'color:#f87171;font-weight:600;' : '';

        html += '<tr' + (index === 0 && isNewTop ? ' class="history-new-row"' : '') + '>' +
          '<td class="time-col"><span class="history-time">' + timeStr + '</span></td>' +
          '<td><span style="font-size:' + _hfs.nominal + 'em;' + buyColorStyle + '">' + formatRupiahShortHTML(item.buy) + '</span>' + (arrowHtml ? '<br>' + arrowHtml.trim() : '') + '</td>' +
          '<td><span style="font-size:' + _hfs.nominal + 'em;' + sellColorStyle + '">' + formatRupiahShortHTML(item.sell) + '</span>' + (sellArrowHtml ? '<br>' + sellArrowHtml.trim() : '') + '</td>' +
          '<td class="col-spread ' + spreadClass + '">' + spread + '%</td>' +
          '<td class="col-usdidr"><span style="' + (usdIdrChange > 0 ? 'color:#4ade80;font-weight:600;' : usdIdrChange < 0 ? 'color:#f87171;font-weight:600;' : '') + '">' + usdIdr + '</span>' + (usdIdrChange !== 0 ? '<br><small class="' + usdIdrChangeClass + '">' + usdIdrChangeSign + Math.abs(usdIdrChange).toLocaleString('id-ID') + '</small>' : '') + '</td>' +
          '<td class="col-markup">' + (markupHtml || '<span style="color:var(--text-secondary);">-</span>') + '</td>' +
          nominalCols +
          '</tr>';
      });
      tbody.innerHTML = html;

      // Pagination
      if (totalPages > 1) {
        pagination.style.display = 'flex';
        var jumpInput = document.getElementById('pageJumpInput');
        if (jumpInput) jumpInput.value = currentPage;
        var totalLabel = document.getElementById('totalPagesLabel');
        if (totalLabel) totalLabel.textContent = totalPages;
        document.getElementById('prevPage').disabled = currentPage >= totalPages;
        document.getElementById('nextPage').disabled = currentPage <= 1;
      } else {
        pagination.style.display = 'none';
      }
      _updatePerPageButtons();
    }

    function prevPage() {
      if (currentPage < totalPages) {
        currentPage++;
        loadHistory();
      }
    }

    function nextPage() {
      if (currentPage > 1) {
        currentPage--;
        loadHistory();
      }
    }

    function jumpToPage() {
      var input = document.getElementById('pageJumpInput');
      if (!input) return;
      var p = parseInt(input.value);
      if (!p || p < 1 || p > totalPages) { input.value = currentPage; return; }
      currentPage = p;
      loadHistory();
    }

    document.getElementById('prevPage').onclick = prevPage;
    document.getElementById('nextPage').onclick = nextPage;
    document.getElementById('pageJumpBtn').onclick = jumpToPage;
    document.getElementById('pageJumpInput').addEventListener('keydown', function(e) {
      if (e.key === 'Enter') jumpToPage();
    });

    function formatRupiah(n) {
      return 'Rp ' + n.toLocaleString('id-ID');
    }

    function formatRupiahHTML(n) {
      return '<span style="font-size:0.5em;font-weight:500;">Rp </span>' + n.toLocaleString('id-ID');
    }

    function formatRupiahShort(n) {
      // Format lengkap: 2.325.000 -> Rp 2.325.000
      return 'Rp ' + n.toLocaleString('id-ID');
    }

    function formatRupiahShortHTML(n) {
      return '<span style="font-size:0.5em;font-weight:500;">Rp </span>' + n.toLocaleString('id-ID');
    }

    function formatChangeShort(n) {
      // Format singkat untuk perubahan
      const abs = Math.abs(n);
      if (abs >= 1000) {
        return (n / 1000).toFixed(1) + 'rb';
      }
      return n.toLocaleString('id-ID');
    }

    function formatTime(date) {
      const h = date.getHours().toString().padStart(2, '0');
      const m = date.getMinutes().toString().padStart(2, '0');
      const s = date.getSeconds().toString().padStart(2, '0');
      return h + ':' + m + ':' + s;
    }

    // Daily Statistics - fetch dari server
    // Sound Notification - menggunakan audio file dari admin
    function _loadSoundSettings() {
      const defaults = { up: true, bigUp: true, down: true, bigDown: true, promo: true, countdown: true, vibrate: true, shake: true };
      try {
        // Reset satu kali untuk semua user: aktifkan semua Sound & Getar lagi (fresh).
        // Setelah ini perilaku normal — pengaturan user tersimpan seperti biasa.
        if (localStorage.getItem('soundResetV3') !== '1') {
          localStorage.removeItem('soundSettings');
          localStorage.removeItem('soundEnabled');
          localStorage.setItem('soundResetV3', '1');
          return defaults;
        }
        const saved = localStorage.getItem('soundSettings');
        if (saved) return { ...defaults, ...JSON.parse(saved) };
        // Backwards compat: jika ada soundEnabled=false lama, matikan semua
        if (localStorage.getItem('soundEnabled') === 'false')
          return { up: false, bigUp: false, down: false, bigDown: false, promo: false, countdown: false, vibrate: false, shake: false };
      } catch (e) {}
      return defaults;
    }
    let soundSettings = _loadSoundSettings();
    // Alias agar kode lama yang cek soundEnabled masih jalan
    Object.defineProperty(window, 'soundEnabled', { get: () => Object.values(soundSettings).some(Boolean) });
    let audioContext = null;
    let customSoundUp = '';
    let customSoundDown = '';
    let customSoundBigUp = '';
    let customSoundBigDown = '';

    // 🎁 Promo ON/OFF sounds (embedded base64 as default)
    const defaultPromoSoundOn = 'data:audio/ogg;base64,T2dnUwACAAAAAAAAAAAAAAAAAAAAACqCBoIBE09wdXNIZWFkAQFoAIA+AAAAAABPZ2dTAAAAAAAAAAAAAAAAAAABAAAAjzLsvAEYT3B1c1RhZ3MIAAAAV2hhdHNBcHAAAAAAT2dnUwAAqBkBAAAAAAAAAAAAAgAAABXyBe4U3ebU/P8n/yD3/xr/D/8D/yD/CXhLhgcmMiclC+TBNuzFgIA9sn7+4iVmxpkbClFnEaOuL84tSV/4Vu55ZTqwJq/bWzd2j+woitwO7jxeY+zM2yZWypvYb4n97GZDdi0vA0+uNXqnir3UmZrCrC6L2OABJuzkXckzZMCK259YZmIj8+06uF7vsqz1+SIP8XmjAIue262m6QW4l98e/MvDpvSBjA6BfAeNkJUU8Dic6xH3LagqPTjfXNsZF/xC65nHlfRy6ySAil/yD6Zf2ZR9xeb3RURaccoHtn9wIltMSVkj7QCfP/tBlVVG+PF1a2eBUEuGJycnJCKKU9a4dYdyYJIkaEa7YMkRb7yY8Gcsuw48YuAbLr4IiEnmYzDLFOCJ9HywRC3I9ooVuyN7PNVA6yb/HHADXdTcdEupeD2RcKZiXnNVIomJlKTbc1yo7nERPv0s9cWIUaDZobSq6BjucPcvkskjvVcE0F9suv+JlKMFeLeohoKiDRT+Ge9/VZ5lv9COBmxgFP6ZIfFZDNj8C7qJhMTEO1ZHEI1AgGvRU4GHsh6duJ00oCeOcHt4rMeM0GNgiSw2AGrDsah3Vmnh5qbbsprngHehrWlC+rofzB/1y2PVdDinS4YiHR8jKIERximC9PPyhlpp3ygxe99zmf0p7QS03Pw2xSMgw+yAJiAElGGI/wHieYRsiJKjRGmEeZWh8Wn8tHwZ2ZNTeC0VL57YVJRhCR7Vx7yaQ7Oyuei0IWiabV/g28236qsreiuvkUiQe3cUdy2YMyZuAJkj52nl+tJrc18C20ZUqk5aoiulZrUVW2F/LFY2qFwcUqQ5n7Ax2KRMzDMdJJt4UCzwMUphSln/hq6IxGDm4R0ecJGB0pYcRNvHPgMln/Of247zEho89XzHSQgml/RLhiYnIygrLWSrd5X/s5jTqsgzyZew0ovXkogMlTCG64oGJsA9NM6mo9F3GvgttqBL3x3Nq/HEpzUpTz55GybvnfXG61+aaRQ+GjG/YA+tJw3521otjjM22JFpMuxzwJNbsagvIZFk30ShuEpaN2EAOIfLunH0YIkshkFNpvWG/mmdSRdsmNQ4+r1j8g0ElUK8U5J7ijk6L+8QaWaTMm2A7WEYXdTiZRqooUrRJpxkMuq5pcE/W3Pd0P5Yus6ixOnea1CQ6X2LY5GgguE3m2e49gEkf0KQn7O1d4pILPPF4fAdqjNSdIIPRF3hTARxQw/n0F0XWUHJ4c7PKoBLhjExLDIwsAp18vrIjScPpSjx4MborUU85/6umh9pOqlMFQTwpge9ULG+12iiof1y+MXU4u2rwK6X+dFGaeYlLl2TRfb2CAFX+wnLi4QRjaFMPv6wjjO5WPesgxlXwAHNiQOtz6A62ECumAKwuhYkcAg8m4XmgPgGHkw1xffi91PAUZcl8eUPL03ZwsSCry12e1vdwK6YArC6BNlqA8spBILLybAwLrneXDCYhAuYOdla3oe+4vxAcV+2niD8w6CaE13W0OkgrKjqocoaaHX0laLX5iF1wNDy3/xy7Z4FHlk43vtynCRPJwiu5z4bt60dDXhh63eArMA2gqYa779T0B5frT57U4bE+iWlZd3YdcH/7yUZMi8hkfeKUoWfrhGDihO7bEdLhjkxKSkrpyiVbLWJSVLnGElmj+ngF9/lDMaxPWtJ9e0WY6INTqNzGdw7Zk2m7N3O43EAIq/PvjhiM9VZjQOAo0+B7ZfJeqlrv/cTdsjvtmdRHx+6YKOh4ALG40W5CxaALF0G9Os5c0KJa2yM7y8KWJ64iJCeh2GONMiMyRSaAIFooFO7KY+5rjzO2/uNXAu2moLsT9ogKr7gnrepe4hoH3uK3dtpN0TXEhepmz0XApEeht+ST7o1SG20hiJ6FyZKUyCek/7pg3sRU48Rb3FQbOsBgClAfd3sS+G5w1ksIlpNSoY+nF67cQQl8ZPQnSU6jEg4mb+GB+678LekhltsLtXVNzxH5uJVH2J+dqP68RidyH9KHrkHbvXyLm8mMEuGIyMkICwwrZN+Xf0S2DUr8ZBmZMUY8S7dYg4BiIlcdcofqVSQMKYJUASZ8fs5iWXoMFr9wcstQNEiCqGiWyvoMElyDtcOwqRSGJvYLr5DNGzSvSnJ6W6i9er5XKPDDR1tOUasOKc9UZgxYiUBmuSALRpK4rilGagv16jc3fmt1sVvvhdSUOMPRIq2qPGjhICA9J15GHPQeuI9SKalklHqBP2N1rVoqE7jmBElbAn9U8xJVDNrwr3nUSdlWLJTBLkIE6T8HKws0S7uzfdp23W/SaaK6yfR18yGXJKbxHLAvYdv/ildSlh+WIaLMRboGQSjn+upCEBLhiovKycytPLA2kzeN3ML1YkZp3DdVzJmHZy6tvYnlq8w6qIB+9SK4r67cGHIgSX4szbXfnfw/L0hevD+AkvvsJfH+UmgbPkBtNJmbndhQ0Y1WdP21UtOLVlD+nF0HLiyHwZ+cHGTCSHwfSemk/z5jioyCRQ3FVe7sxN++6FUU4+6TlFz+9XMTQumspdV+YkXyj8YQNgzfrxTke8nnweTtoqBinHGclL+e9530NyblfvAs5MNfIioJBpoc9AwolduornPKESqKkrSCQPsJIcrwqj0gZP7Yf0qIsL8CJg/57J8+/CsRbXL71t9Z+fhyexlSrMhScW6DOuzceY4zH53v6LLuNM4QJirGJe3JlfVIQD19KXHz2CKwEuGMy4wMCWjYCUne3Z0IpqicWiWj7woM6qd+PnjQL+SkLAORT3vzUrMkB7LD3VBTYQ805V1J2lcqJSflaDeq50xGh9FVhIUjB80DydzUA6wslDCQIl5iRNxylp8ZPkKtlRkfNNMRMo5nnyxmpLUK9OKr0nowDYQP7NsCmbsN+P6j5E5Sn5Nsxeo0xcVpNlm0/A+86w9qUbAnTLZpq4LIccWAyvxZBoSjgFkOVjiRn4NSeRxSMoCsa93sxTbcPye/jjCzmB96MNQgVWBJ5fTUNVMCRl1pxMAjAHOsxr7xgIbk/6y6XSzw7ez/rxtMC0gtuAL24ZylwEfYbz3E8AfWKJmfrAaykMCZ27ReHHtgEuGIykmKjArVMJl4T7rgyD16wtsi12G8pDNnDTcpmhkNjlgYMAGuPQY4Cwb6dYbWTepSKRNNzO8anXwniWTwSo1KojS6nKOSiwdPPnLU+PsArsoL0xlkFL9q+ff13AEpAz5HvaLk6drb3hwqiIw3Hrrl9riN15P1DOJErp+eno9PAg9XfdZCAzkpnLprCMvHzKXfDZ3efF0FHvWQQifkXs4d2yElXT8Lu9kUkJUO3qBGxk4GZs0zz73Cl/AQHLJn7RLMQXHI+9IbDNv3LyEJR60kjC2vRGeIAXgxNehDIv1MJNoS+hjSZZpiv6AzT6n16SgT99Oo0WpyX9SNRJ9VqbJ4kuGKi8pKje16rwZ80qcUqEJsyt+j45ZBUZ6TAhmSZS2GQ/MzOZqi0YseRHsyyMMPcC1bRDVTopTRdzwh61GPR2frVOkTMg3m3v183oCBb13xLIeMUe0oMVnddZ/FPFemrbrCFzcnteJ/Uow+WuqvkpsbSn1Jnq36RFcKXno76gNaeShqfLHV0+GtrRUg8F+05WmU+Sjy809W/U7ExjHNhvSlQ9WKMfwUSice4WQ0gP9h7GAr6njgxwdtEPf/updok2gicAkm9fhdk1f+kHxzpBDl8TTkIEO61Dur1R4snUgBtm6UdQ1Mdf+wKNPYb3AvKHePXHFGJHzch4tjMtIcu9bNUsDlcq26gwFhaWujT94nxDCsuydm2SV+ozbuNKoS4YzKSouIp7NO1l5AIAB0UDJrYLPEeq7gQ07rbe+csgBDp4lXkXkJ3xJsd0oWb7Fk04BlgTcibIYLJ+G6Lh0BGqurm2J/bqH+I9QrI14ndgysmt4RRH6J1gTIqF1lovTfD5MvcPNge6E6w+RZjEdW75pMg95MGGnwx15sHF8XHNHgXLW91sRinHf6rCAgQ5W6PMb0Ei+16ZZE/JTLW4ShmUHQUSk+wj6RjALJ0GPZt7uk9Jrz9T1ugzw3i9nTzeX0Wmiewu8eym83pNxtVbttregRYpWV/rb0R+b1KMvSnysh54ChokEsLE5zPrqGrnwjhTDcs96aQ8nRvqS4I9bPUbv8aalWhCAS4MpKIjQwQVFrquNgWtZ+ePkmhVsljDGyeBrjNVlzf/ugqeKxlX1HNr1KVWAgrsAcd5ea76AY9KN6+09wFRErv1ga3bbmt7vfskdDNWcWAmDQIn+wDCV+6YRDlxK8N4MxlrtCYeQL1E74PG0yab4Co1GjPwQ9Udg';
    const defaultPromoSoundOff = 'data:audio/ogg;base64,T2dnUwACAAAAAAAAAAAAAAAAAAAAACqCBoIBE09wdXNIZWFkAQFoAIA+AAAAAABPZ2dTAAAAAAAAAAAAAAAAAAABAAAAjzLsvAEYT3B1c1RhZ3MIAAAAV2hhdHNBcHAAAAAAT2dnUwAAqJEBAAAAAAAAAAAAAgAAAAZx6GgZz/fi/yz/Av8Y/xLp/xLy8v8B/xj69QICAkuGByQlKioL5ME27MWAgAvYyPwjBuzmj2T8HmsV83eHqYVjYmzhXnDj0Dik1TQebvWQimSlxeWeihzSqbJjnOURWY8uDUzDqqNsyhg7U1cHccpjS7pgIIpk+q2XH5SptsoHwiDz/FBn+zUV9EDn+DFBtaPhcfmVNekgpPBQtpXKhIpkzk4eC6PRbU101Sb1z2QwMvwbi9Xke1Svl1yzl7pJdGeozq7DdcMFgIpkpctNXFs0pi39XFvogugsBwNqy51rdJN1kJcFG7cXabA/YEuGJyklKCeKRkqJKszuX83bnuEHgKFfC58+db25Qh6Xm6fEpWopCzluVv+zus+BTeh19oKfCKDllEBD6dO9NKc8TZiTK1CdNGYS1Uv2jOjd10W0lbvpH4n8vktufZaB7bxbJyY1CRJ/zgSMrQ+81ahmiW0YXV+E3nkUSiCJ/KzfHwNCH7PX1tNzygYn1YYxvrwZBAtWavCVaJRejMB0HDAeHwigid5HkUsxMlocgzmPvWC7t6GfG3rnIFIml/YG+31s9s9f6C/hFL2VgUsbGFGkmMgMAQlLe2pEtgfLwkqMkIqZV6B/xbMTqZsPIaD2WqQzOwh+59RLhiklJCUhifys46alIPc8jsrT4taYZ0F1hMfzW3p9m9ndZ/EYmVYI6QRmLT2lL/SKDiCRcHTH804PAfclUgQRcFmqJktlJbWTAcTDCsc6YpU07s+gimS9B3RJf6DHqteyKO0r9a41gHRdAK5M9HfwKAMXZyf9mXKaNL1Amlz3r6lhmzP/anWw3/LF7R2zpm0KUJn493inqkw8qptNWDMd4q65Q+5I1vEWoVWnAtiVawkxZhuymQA0B30FZAF5pDMeDcB8THn7yJC05yolHOhPe35+/AfVB27CA1nde5J0r4VAS4YrMTIyNYod9qe5al0sGT2JXISnlCFMNzGX4mIwRT5rOInlW12khfSznWRvLzF0r4CLDTmg7Pq9d3xSQ5/XhIJUl/kJiRvYuF6iMbnZSiBU79pInqEPHXmztcmQxAC1zfzEjK1vYJqB/aYz/mTQTaqViCdofa/3IK2XoPs/+wmCwrw98N1Yo6j6IwI7qC0XZSibb9CO2EtNEYeMo/WIl9JmehpPZiFa/KQdSRn2v8TQValqLfyWkAIgx9HbfPNlrSF1Q1KVwJCAd+uIlFy1/KVUjZzj4OjccXm4VubBZc4sP/RnjUCBQWcuaZDFtQb/ATzw2IOM9qDtAStFg4w/E0IyMJ7Dy3GtbUUNiRUpVTrTAL4510woQfav+g0qHctQ+HijplYBQXzWHMBLhicsJCstsORfeXK0RFxPhzsvlxOtVZDHA8kJAWwAJQp11Z2/MA6ojIEQ1PKar7C8KL35Tb/q4Ly0QhGFPfwzYPGP0NeOrrqvDIZ7pQv5M6nvkPOCKFm/K8CrTB0ZFhQ6lAVV8MOkQCJSXUM6IOOU3hvxA6S7I9JL7+IRNoCrYh3xZSDrYMufhHit7cFSY/ikCsFMhF4Aem+Q488l/pnsSK3ZrJS0dp9grP1+y/pIsQ+W9Pd88yffWsWAZCzp77zmTc6KaV+P/4PWM3uHbaIJGc9ilVggrGoPy+fXszEJNTIFUxKSX4UI0jbx8OBdSzDcpv00bBWwwg0s2T4FN+9TcEuGLjExKSeqvigDN1tTz9gyN2cZJ9TV9Hsa0W4/AvAdVk9wmKqPZdFv0kiIIYGhcUMAm7UIq1mOcQ+O+tjeKLSwSeM0+QKK3YZOjFqKcNQX3H2UlzWYwwteCTgAUxqEv453Fm46eKtKx2YxK53TBSa7S07onIwQMVzRCxfA202MbrmJWFoSxmKV/Do99vYfUObHJ68tx2CrFYwNDZnWf5Q7iMT7BPzuKJtLyhpNZXgdBTHr1cziBJcG4c/wMJx7gKj+ECiXIbLOfEqtO/KfPq5OHynyFjjdn4vsZ6kJ3MdS8jM8v1aZML5YHcge3fmmilf/EHOjxzeBO9MYEIhVUNCVu3uW6n0+SZ4kFE9Ef0Qa/EPqGhR/FEuGNCkuKyy+YYFiKWySF+wg+ryonuQgDXUQrpqfGvJkq64897wPNl/9nU5mtGQCfkUzGDRV42ts8B5AjxrWlgm+AdNFpHaF7Ox9YHbtzxMCBcLYAJlnzTMFbf/di3AohT8ILSCNveywaykIW1uPOZqfEW7liC9QSdiOakj0Vi8TYehauV0azIS1vaGifynMOENgjhfRgMowgMfKJLA7TdxidbIhruyPvKD19YqUMXT3Rti8v8pxpCdGWktiozsbWp+HbmkeWal6m+vg6XmGlhgfo3bB58N6I8S63GkzHAdb2OYb+bez7qGYgma8t0KRJZlsFxVbahxjixmRgHF5/hmVKytObWzLy0vrz1370HE9gEuGJCUhJCYFw8ZZ8eX9lUJjKKWSQNDfZ8e0IxkjzoLMhRGXSIL7+5Idm4AFluV8cW98GCj9msSnWLNCD4+/h9haB0Z2gsLgVtxv6mrpe5KAMllFr5hUo90AHHH8s+/jBA7wbNnvXbvU0Vus1saRZT2AK3pR1JuIqEkG0u1aWAvM11H5Xm/t2UaYmT8MIoMzLn3xxmzAgPUwNuxmnpOhMm4wKBqf1ByMUEbBlty0uJCZ9nZoIW2vRDTN0n2fKG0Z4DflSrnq5yYOcXb4VtSIHJloWvg/jrgh0qI95+2XDbqN0eQP2+107jc8S4YyMCkpKaN7RXzN+8SEqJzYTI47g72LHPa2asr9QK7cvAfmhZTbbkE8XEoKYEbpzpBkVhJ6XucMplfKKcd1/MaBKb8sviTw4/iufN96BkKKQ4R0cA6vilIL7naeRvnZYq/v1BmKGhSApqBcl70FaFE3WgAXMzb4bdg6EDsgpFGgmnX5on7prUmf6vfumXJyu6qp2wJBJYPcLH/vh+oilVJFD8Sm3/2oMf+wGp/pbJPXtrjTNR11ebXNxKsxihJzelsZnYd7DjsXUANSCbjPg9SbO6M6FF+aX3D2uUbF5iWYj4KAqUM+eGOWFSlkJx7MmrQ4iBw9fVhV/EMrY1rDC9dhDpDo6rSvUE+b5KANg/ZAS4YqIyooJ6fa62C3vAoU5yvOCluiKwIWy6YPVrObq6k3lnDwW0THmgRMY4pGLheeuKfRXUhmc3Ukt69beiWfwsMhl/mE/fJiBkJSOL+3mBrFpouAp7fTmP3y7q2WnaGjFeRQD6EzDZlH9RYue6mF3lhJCtYHJVUDCaZUdc3/pnEF0fNuhFbMM3+iXucvsgF37GK0qT5x2+N0taFoOPdbwVPIqXRAwKZYnNSR0SZXs95x9nSOnd/zGdkl8iv3lMtQ4lEBGF6i35vbwzkT/KZX4VpAji46UxsYhMKV0FwdLl3/SrDjqJhQnE3xfLaIq1/AWUBLhiomJx8opgsT5gV5FU6RK0s/BOU0UZCmHvikRaaFPBvL6KJ/2pEUfNcInkjasqHQpfzQiz7z5ANFtaJ6ktiiQxb60i/+PEwifkFTUsvdxmVegvtCLs6lECoZb6P0LrMbl7X8M4iJv63GpfaIAyklXruUeH1uUVW5NbZQt36j6EEcw2U8A3tHjnIXHMc2peERV9n2qdJ6gaeXEl8RpPbwqLZivG/z0CoFCZ3dScYClrTfM//b741bDGdE9VOCF0v+t9H7IKNVkRh+TAunEIOj8eR50eo7Q4OMroHB7p5aFKoGtqKGf7bea5msnZcQ6fq6gEuGLS0nJCeg21CsotC9yimHXbEC9V9FtlL0c9jaNmri1Llo0ENwaabaLvGzfcn+WU4HsBSfxTJrzXkvVLCuLEle6UiBSozhG2tw7aJzCuUX0Lxz6Px4n4vfKm66heTFLFCdTNWCqYvwy+qaNlwcA+nHb0XN+/Bp60SHZr9nV/2emHM1MBKoyCCKapeYWnsUWsvwrON0Ho0fH0TDw52xDY3bpuACC6FLjsiPdYAzAr0HowwVjNwMSqmXEqiH7wuQ78AvUpr9Ik77VaN+iDT9MqBkufWKjlZpDZGY3RmhWdsetpM1PrYROR1fIishpymaIJ4sS5XwHsfi6/pMuv3esRFLhjUvKyoqjLN5EE7MFd5c9LlrIR7Hv6ExMMNiO5cFUr4FIOCbmhzxXFMaa7wW1JrLQcr2VKVKWDewF1KPM9snZxiB7IkZDnfAv/1DMY4quC7FyO+PA5dVrjYGbygAJiVOJqgs1MmalUj8+o8fA8kDGujnVceOz3MyfBOAkb4i0PIptPEj0OBN5+m0LGr2moN1priRmPCOBzUMOqYCI5ldMi5qDvos0I8C+CbQrEfA8HGub+WgMceCVABBVChrUnSNXX+C70R7PyK9JAuy3YdnhJbx+d/BRY+VkEp+KKi2BhzcYUauFIeSUKCL9uGbnEQcoQp4zYov6qlKdHJIiQAh0umT1m+W7OIYytRM+zPq98T8bw8dykRLhiovJycli/FTQfRaD4e4a0x+UVmXNOXzF+wQuRd+0rlfI6B5nG0qRhq/XTQaf63Qi/VyMs9jmd6+lSvXXHdnJy+oio8dLQ7MGeAxU65zXfmgiRh76rYxlWLkJLkAMJg5qPfjq2Fe8R57NG1lHLIS/bvICWF5hVM2Uvv16ufXj9i/8PEE9Cg46S9hXsRrvylFvJyqxCsxMMPna4suVgXQGf4k8dwQiMb2O64PHsA46YLyirNiU9un+22aDog8bB96geqh6T95IzmZJzKPeSbha4/ABZw7VGtUC2+8W8XugA6BkLGuQUJ09m2UJw/XaaOG6Nl5AK3wUeMkS4YpJyMrJzgYv2FsTmEijNloWxpAD3xLt5t/qxWveC0yJUKPuDeO9CVpw3gUuMxoN97FVWPEYiscoCIcdr+eEbPW57kGPjeanrI4yDpawXzVfCEuO0ogN0hNSY53TGzAd9Bo0wgudQF1k22jgl943PS7UuHr60oSXoQ3C1IivdjbOB7ryOckAmCAdRSz7DGNf/FQY/VA8B7Jo3wlaYzn44BTdOV0NoS8uaGN9y2R7jETN5ax7zG7tFBoqa8XESWfZ8jDtoGa4z1j9Sh4NnfiKqX5KupcJQ/CBSeLQrKWocR26IgvvZGYnoah3J6dUF9+h+bBrTBLBksGSwU=';
    let customSoundOn = ''; // Custom sound dari admin
    let customSoundOff = ''; // Custom sound dari admin
    let lastPromoStatusClient = null; // Track status terakhir untuk hindari duplikat

    // Initialize sound panel state on load
    function _updateSoundHeaderIcon() {
      const types = ['up','bigUp','down','bigDown','promo','countdown'];
      const on = types.filter(t => soundSettings[t]).length;
      const toggle = document.getElementById('soundToggle');
      const iconOn = document.getElementById('soundIconOn');
      const iconPartial = document.getElementById('soundIconPartial');
      const iconOff = document.getElementById('soundIconOff');
      if (!toggle) return;
      toggle.classList.remove('off','partial');
      [iconOn, iconPartial, iconOff].forEach(el => el && (el.style.display = 'none'));
      if (on === 0) { toggle.classList.add('off'); if (iconOff) iconOff.style.display = 'block'; }
      else if (on < types.length) { toggle.classList.add('partial'); if (iconPartial) iconPartial.style.display = 'block'; }
      else { if (iconOn) iconOn.style.display = 'block'; }
    }
    function _initSoundCheckboxes() {
      ['up','bigUp','down','bigDown','promo','countdown','vibrate','shake'].forEach(t => {
        const el = document.getElementById('sw_' + t);
        if (el) el.checked = !!soundSettings[t];
      });
      // Getar HP (fisik) hanya tersedia di perangkat yang mendukung (umumnya Android)
      if (!('vibrate' in navigator)) {
        var vrow = document.getElementById('vibrateRow');
        if (vrow) vrow.style.display = 'none';
        var vsub = document.getElementById('vibrateSub');
        if (vsub) vsub.textContent = 'Tidak didukung perangkat ini';
      }
      _updateSoundHeaderIcon();
    }
    // Panel HTML di-render setelah script, defer agar checkbox sudah ada di DOM
    setTimeout(_initSoundCheckboxes, 0);

    // Tutup semua floating panel (biar hanya 1 dropdown terbuka)
    function _closeAllPanels() {
      ['soundPanel','soundFxPanel','getarPanel','settingsPanel','histColsPanel'].forEach(function(id){
        const p = document.getElementById(id);
        if (p) p.style.display = 'none';
      });
      _soundPanelOpen = false; _soundFxOpen = false; _getarOpen = false; _settingsPanelOpen = false; _histColsOpen = false;
    }
    let _soundPanelOpen = false;
    function openSoundPanel(e) {
      if (e) e.stopPropagation();
      const willOpen = !_soundPanelOpen;
      _closeAllPanels();
      if (typeof closeNavMenu === 'function') closeNavMenu();
      _soundPanelOpen = willOpen;
      const panel = document.getElementById('soundPanel');
      if (!panel) return;
      if (_soundPanelOpen) {
        panel.style.display = 'block';
        // Menu hamburger sudah ditutup, jadi pakai tombol hamburger sebagai acuan posisi
        const toggle = document.getElementById('soundToggle');
        const ref = toggle && toggle.getBoundingClientRect().width ? toggle : document.getElementById('navMenuBtn');
        if (ref) {
          const rect = ref.getBoundingClientRect();
          const panelW = 248;
          let left = rect.right - panelW; // sejajar tepi kanan tombol hamburger
          if (left + panelW > window.innerWidth - 8) left = window.innerWidth - panelW - 8;
          if (left < 8) left = 8;
          panel.style.top = (rect.bottom + 8) + 'px';
          panel.style.left = left + 'px';
        }
      } else {
        panel.style.display = 'none';
      }
    }
    function closeSoundPanel() {
      _soundPanelOpen = false;
      const panel = document.getElementById('soundPanel');
      if (panel) panel.style.display = 'none';
    }
    document.addEventListener('click', function(e) {
      if (!_soundPanelOpen) return;
      const toggle = document.getElementById('soundToggle');
      const panel = document.getElementById('soundPanel');
      if (toggle && !toggle.contains(e.target) && panel && !panel.contains(e.target)) closeSoundPanel();
    });

    // Sub-panel positioning helper (relatif ke tombol Pengaturan Suara di menu)
    function _positionSubPanel(panel) {
      const toggle = document.getElementById('soundToggle');
      const ref = toggle && toggle.getBoundingClientRect().width ? toggle : document.getElementById('navMenuBtn');
      if (!ref) return;
      const rect = ref.getBoundingClientRect();
      const panelW = 248;
      let left = rect.left;
      if (left + panelW > window.innerWidth - 8) left = window.innerWidth - panelW - 8;
      if (left < 8) left = 8;
      panel.style.top = (rect.bottom + 8) + 'px';
      panel.style.left = left + 'px';
    }
    // Sub-panel: Sound (efek suara)
    let _soundFxOpen = false;
    function openSoundFx(e) {
      if (e) e.stopPropagation();
      closeSoundPanel();
      const panel = document.getElementById('soundFxPanel');
      if (!panel) return;
      _soundFxOpen = true;
      panel.style.display = 'block';
      _positionSubPanel(panel);
    }
    window.openSoundFx = openSoundFx;
    function closeSoundFx() {
      _soundFxOpen = false;
      const panel = document.getElementById('soundFxPanel');
      if (panel) panel.style.display = 'none';
    }
    window.closeSoundFx = closeSoundFx;
    document.addEventListener('click', function(e) {
      if (!_soundFxOpen) return;
      const panel = document.getElementById('soundFxPanel');
      if (panel && !panel.contains(e.target)) closeSoundFx();
    });
    // Sub-panel: Getar
    let _getarOpen = false;
    function openGetar(e) {
      if (e) e.stopPropagation();
      closeSoundPanel();
      const panel = document.getElementById('getarPanel');
      if (!panel) return;
      _getarOpen = true;
      panel.style.display = 'block';
      _positionSubPanel(panel);
    }
    window.openGetar = openGetar;
    function closeGetar() {
      _getarOpen = false;
      const panel = document.getElementById('getarPanel');
      if (panel) panel.style.display = 'none';
    }
    window.closeGetar = closeGetar;
    document.addEventListener('click', function(e) {
      if (!_getarOpen) return;
      const panel = document.getElementById('getarPanel');
      if (panel && !panel.contains(e.target)) closeGetar();
    });

    // ── Kolom Riwayat (khusus mobile): pilih kolom Spread/USD-IDR/Status di tabel ──
    const HIST_COLS_KEY = 'histColsMobile';
    let histCols = (function() {
      const def = { spread: false, usdidr: false, status: false };
      try { return Object.assign(def, JSON.parse(localStorage.getItem(HIST_COLS_KEY) || '{}')); }
      catch(e) { return def; }
    })();
    function _applyHistCols() {
      document.body.classList.toggle('hist-col-spread', !!histCols.spread);
      document.body.classList.toggle('hist-col-usdidr', !!histCols.usdidr);
      document.body.classList.toggle('hist-col-status', !!histCols.status);
    }
    _applyHistCols();
    function toggleHistCol(key, el) {
      histCols[key] = !!(el && el.checked);
      try { localStorage.setItem(HIST_COLS_KEY, JSON.stringify(histCols)); } catch(e) {}
      _applyHistCols();
    }
    window.toggleHistCol = toggleHistCol;
    let _histColsOpen = false;
    function openHistCols(e) {
      if (e) e.stopPropagation();
      closeSettingsPanel();
      const panel = document.getElementById('histColsPanel');
      if (!panel) return;
      const s = document.getElementById('sw_histSpread'); if (s) s.checked = !!histCols.spread;
      const u = document.getElementById('sw_histUsdidr'); if (u) u.checked = !!histCols.usdidr;
      const m = document.getElementById('sw_histStatus'); if (m) m.checked = !!histCols.status;
      _histColsOpen = true;
      panel.style.display = 'block';
      _positionSubPanel(panel);
    }
    window.openHistCols = openHistCols;
    function closeHistCols() {
      _histColsOpen = false;
      const panel = document.getElementById('histColsPanel');
      if (panel) panel.style.display = 'none';
    }
    window.closeHistCols = closeHistCols;
    document.addEventListener('click', function(e) {
      if (!_histColsOpen) return;
      const panel = document.getElementById('histColsPanel');
      if (panel && !panel.contains(e.target)) closeHistCols();
    });

    // Settings chooser panel (Tampilan / Pilih Nominal)
    let _settingsPanelOpen = false;
    function openSettingsPanel(e) {
      if (e) e.stopPropagation();
      const willOpen = !_settingsPanelOpen;
      _closeAllPanels();
      closeNavMenu();
      _settingsPanelOpen = willOpen;
      const panel = document.getElementById('settingsPanel');
      if (!panel) return;
      if (_settingsPanelOpen) {
        panel.style.display = 'block';
        const toggle = document.getElementById('settingToggle');
        const ref = toggle && toggle.getBoundingClientRect().width ? toggle : document.getElementById('navMenuBtn');
        if (ref) {
          const rect = ref.getBoundingClientRect();
          const panelW = 248;
          let left = rect.right - panelW;
          if (left + panelW > window.innerWidth - 8) left = window.innerWidth - panelW - 8;
          if (left < 8) left = 8;
          panel.style.top = (rect.bottom + 8) + 'px';
          panel.style.left = left + 'px';
        }
      } else {
        panel.style.display = 'none';
      }
    }
    window.openSettingsPanel = openSettingsPanel;
    function closeSettingsPanel() {
      _settingsPanelOpen = false;
      const panel = document.getElementById('settingsPanel');
      if (panel) panel.style.display = 'none';
    }
    window.closeSettingsPanel = closeSettingsPanel;
    document.addEventListener('click', function(e) {
      if (!_settingsPanelOpen) return;
      const toggle = document.getElementById('settingToggle');
      const panel = document.getElementById('settingsPanel');
      if ((!toggle || !toggle.contains(e.target)) && panel && !panel.contains(e.target)) closeSettingsPanel();
    });
    window.openDisplaySettings = function() {
      closeSettingsPanel();
      const modal = document.getElementById('displaySettingsModal');
      if (!modal) return;
      modal.classList.add('active');
      _updateHistoryFontDisplay();
      _updateBuySellFontDisplay();
      _updateBuySellCardDisplay();
      _updatePerPageButtons();
    };
    window.closeDisplaySettings = function() {
      const modal = document.getElementById('displaySettingsModal');
      if (modal) modal.classList.remove('active');
    };
    window.openNominalFromSettings = function() {
      closeSettingsPanel();
      if (typeof openNominalSettings === 'function') openNominalSettings();
    };

    // Nav Menu Dropdown
    let _navMenuOpen = false;
    function openNavMenu(e) {
      if (e) e.stopPropagation();
      const willOpen = !_navMenuOpen;
      // Tutup panel lain dulu supaya tidak ada 2 dropdown terbuka bersamaan
      if (typeof _closeAllPanels === 'function') _closeAllPanels();
      _navMenuOpen = willOpen;
      const dropdown = document.getElementById('navMenuDropdown');
      if (!dropdown) return;
      if (_navMenuOpen) {
        const btn = document.getElementById('navMenuBtn');
        if (btn) {
          const rect = btn.getBoundingClientRect();
          const dropW = 190;
          let left = rect.right - dropW;
          if (left < 8) left = 8;
          if (left + dropW > window.innerWidth - 8) left = window.innerWidth - dropW - 8;
          dropdown.style.top = (rect.bottom + 6) + 'px';
          dropdown.style.left = left + 'px';
        }
        dropdown.classList.add('active');
        if (typeof lucide !== 'undefined') lucide.createIcons();
      } else {
        dropdown.classList.remove('active');
      }
    }
    function closeNavMenu() {
      _navMenuOpen = false;
      const dropdown = document.getElementById('navMenuDropdown');
      if (dropdown) dropdown.classList.remove('active');
    }
    document.addEventListener('click', function(e) {
      if (!_navMenuOpen) return;
      const dropdown = document.getElementById('navMenuDropdown');
      const btn = document.getElementById('navMenuBtn');
      const soundPanel = document.getElementById('soundPanel');
      const settingsPanel = document.getElementById('settingsPanel');
      const soundFxPanel = document.getElementById('soundFxPanel');
      const getarPanel = document.getElementById('getarPanel');
      if (dropdown && !dropdown.contains(e.target) && btn && !btn.contains(e.target) && !(soundPanel && soundPanel.contains(e.target)) && !(settingsPanel && settingsPanel.contains(e.target)) && !(soundFxPanel && soundFxPanel.contains(e.target)) && !(getarPanel && getarPanel.contains(e.target))) {
        closeNavMenu();
      }
    });

    // Load custom sounds from server
    async function loadCustomSounds() {
      try {
        const res = await monFetch('/api/sound-settings');
        const data = await res.json();
        if (data.success) {
          customSoundUp = data.settings.soundUp || '';
          customSoundDown = data.settings.soundDown || '';
          customSoundOn = data.settings.soundOn || '';
          customSoundOff = data.settings.soundOff || '';
          customSoundBigUp = data.settings.soundBigUp || '';
          customSoundBigDown = data.settings.soundBigDown || '';
          return true;
        }
      } catch (e) {}
      return false;
    }
    // Muat custom sound; kalau gagal (server/jaringan sedang bermasalah) coba ulang
    // hingga berhasil — tanpa ini user yang load-nya gagal cuma dapat beep default.
    (function _loadSoundsWithRetry(attempt) {
      loadCustomSounds().then(function(ok) {
        if (!ok && attempt < 10) {
          setTimeout(function() { _loadSoundsWithRetry(attempt + 1); }, Math.min(15000 * (attempt + 1), 60000));
        }
      });
    })(0);

    function getAudioContext() {
      if (!audioContext) {
        audioContext = new (window.AudioContext || window.webkitAudioContext)();
      }
      // Autoplay policy: context tercipta "suspended" sampai ada gesture — coba resume tiap dipakai
      if (audioContext.state === 'suspended') {
        try { audioContext.resume(); } catch(e) {}
      }
      return audioContext;
    }
    // Aktifkan audio pada sentuhan/klik pertama user (syarat autoplay browser).
    // Tanpa ini, user yang hanya menonton tanpa pernah menyentuh halaman tidak akan
    // mendengar suara sama sekali (context tetap suspended).
    ['pointerdown', 'keydown', 'touchstart'].forEach(function(ev) {
      window.addEventListener(ev, function() {
        try {
          const ctx = getAudioContext();
          if (ctx.state === 'suspended') ctx.resume();
        } catch(e) {}
      }, { once: true, passive: true });
    });

    // Init Lucide icons
    if (typeof lucide !== 'undefined') lucide.createIcons();

    // Theme toggle — hanya admin yang bisa akses (non-admin tombolnya disembunyikan)
    function toggleTheme() {
      const isLight = document.body.classList.toggle('light-mode');
      localStorage.setItem('goldmonitor_theme', isLight ? 'light' : 'dark');
      document.getElementById('themeIconDark').style.display = isLight ? 'none' : '';
      document.getElementById('themeIconLight').style.display = isLight ? '' : 'none';
      if (typeof window._loadTVWidget === 'function') window._loadTVWidget();
    }

    // Migrate old change scale 0.75 → 1.0 untuk konsistensi
    (function() {
      try {
        var s = localStorage.getItem('buySellFontSettings');
        if (s) { var p = JSON.parse(s); if (p.change && p.change < 0.88) { p.change = 1.0; localStorage.setItem('buySellFontSettings', JSON.stringify(p)); } }
      } catch(e) {}
    })();

    // Apply saved font/card scales on load
    _applyBuySellFontToDOM();
    _updateBuySellFontDisplay();
    _applyBuySellCardToDOM();
    _updateBuySellCardDisplay();
    window.addEventListener('resize', function() { _applyBuySellCardToDOM(); });

    function toggleSoundType(type, el) {
      // Pakai state checkbox yang aktual, bukan toggle blind
      soundSettings[type] = el ? !!el.checked : !soundSettings[type];
      localStorage.setItem('soundSettings', JSON.stringify(soundSettings));
      _updateSoundHeaderIcon();
    }
    function setSoundAll(val, group) {
      var types;
      if (group === 'getar') types = ['vibrate','shake'];
      else if (group === 'sound') types = ['up','bigUp','down','bigDown','promo','countdown'];
      else types = ['up','bigUp','down','bigDown','promo','countdown','vibrate','shake'];
      types.forEach(t => {
        soundSettings[t] = val;
        const el = document.getElementById('sw_' + t);
        if (el) el.checked = val;
      });
      localStorage.setItem('soundSettings', JSON.stringify(soundSettings));
      _updateSoundHeaderIcon();
    }
    function toggleSound() { openSoundPanel(); } // backwards compat

    // Play default beep sound using Web Audio API
    function playDefaultSound(direction) {
      try {
        const ctx = getAudioContext();
        const oscillator = ctx.createOscillator();
        const gainNode = ctx.createGain();
        oscillator.connect(gainNode);
        gainNode.connect(ctx.destination);

        if (direction === 'up') {
          oscillator.type = 'sine';
          oscillator.frequency.setValueAtTime(800, ctx.currentTime);
          oscillator.frequency.setValueAtTime(1200, ctx.currentTime + 0.15);
          gainNode.gain.setValueAtTime(0.3, ctx.currentTime);
          gainNode.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.3);
          oscillator.start(ctx.currentTime);
          oscillator.stop(ctx.currentTime + 0.3);
        } else {
          oscillator.type = 'sawtooth';
          oscillator.frequency.setValueAtTime(400, ctx.currentTime);
          oscillator.frequency.exponentialRampToValueAtTime(150, ctx.currentTime + 0.3);
          gainNode.gain.setValueAtTime(0.2, ctx.currentTime);
          gainNode.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.3);
          oscillator.start(ctx.currentTime);
          oscillator.stop(ctx.currentTime + 0.3);
        }
      } catch (e) {
      }
    }

    // Default big-change sound: lebih dramatis (chord 2 nada berurutan)
    function playDefaultBigSound(direction) {
      try {
        const ctx = getAudioContext();
        if (direction === 'bigUp') {
          // Naik besar: 3 nada naik cepat + sustain
          [600, 900, 1400].forEach((freq, i) => {
            const osc = ctx.createOscillator();
            const gain = ctx.createGain();
            osc.connect(gain); gain.connect(ctx.destination);
            osc.type = 'sine';
            osc.frequency.setValueAtTime(freq, ctx.currentTime + i * 0.12);
            gain.gain.setValueAtTime(0.4, ctx.currentTime + i * 0.12);
            gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + i * 0.12 + 0.25);
            osc.start(ctx.currentTime + i * 0.12);
            osc.stop(ctx.currentTime + i * 0.12 + 0.25);
          });
        } else {
          // Turun besar: 3 nada turun cepat
          [1200, 800, 350].forEach((freq, i) => {
            const osc = ctx.createOscillator();
            const gain = ctx.createGain();
            osc.connect(gain); gain.connect(ctx.destination);
            osc.type = 'sawtooth';
            osc.frequency.setValueAtTime(freq, ctx.currentTime + i * 0.12);
            gain.gain.setValueAtTime(0.35, ctx.currentTime + i * 0.12);
            gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + i * 0.12 + 0.25);
            osc.start(ctx.currentTime + i * 0.12);
            osc.stop(ctx.currentTime + i * 0.12 + 0.25);
          });
        }
      } catch (e) {}
    }

    // Beep "titit" pendek untuk hitung mundur 5 detik terakhir
    function playCountdownBeep(isFinal) {
      try {
        const ctx = getAudioContext();
        if (ctx.state === 'suspended') ctx.resume();
        // isFinal (detik 59): nada lebih tinggi + double-beep agar lebih menonjol
        const freq = isFinal ? 1500 : 1000;
        const beeps = isFinal ? [0, 0.13] : [0];
        beeps.forEach(function(offset) {
          const osc = ctx.createOscillator();
          const gain = ctx.createGain();
          osc.connect(gain); gain.connect(ctx.destination);
          osc.type = 'square';
          osc.frequency.setValueAtTime(freq, ctx.currentTime + offset);
          gain.gain.setValueAtTime(0.0001, ctx.currentTime + offset);
          gain.gain.exponentialRampToValueAtTime(0.25, ctx.currentTime + offset + 0.01);
          gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + offset + 0.09);
          osc.start(ctx.currentTime + offset);
          osc.stop(ctx.currentTime + offset + 0.1);
        });
      } catch (e) {}
    }

    // Goyang layar sebentar (pengganti getar di iPhone/desktop, juga jalan di Android)
    let _shakeTimer = null;
    function shakeScreen(strong) {
      const el = document.querySelector('.container');
      if (!el) return;
      const cls = strong ? 'screen-shake-strong' : 'screen-shake';
      document.body.classList.add('is-shaking');
      el.classList.remove('screen-shake', 'screen-shake-strong');
      void el.offsetWidth; // reflow agar animasi restart
      el.classList.add(cls);
      if (_shakeTimer) clearTimeout(_shakeTimer);
      _shakeTimer = setTimeout(function() {
        el.classList.remove('screen-shake', 'screen-shake-strong');
        document.body.classList.remove('is-shaking');
      }, strong ? 760 : 640);
    }

    // navigator.vibrate butuh user gesture dulu; tandai setelah interaksi pertama
    let _userInteracted = false;
    ['pointerdown','keydown','touchstart'].forEach(function(ev){
      window.addEventListener(ev, function(){ _userInteracted = true; }, { once: true, passive: true });
    });

    // Dipanggil tiap pergantian detik 55-59 dari updateClock
    let _lastCountdownSec = -1;
    function triggerCountdownAlert(sec) {
      if (sec < 55) { _lastCountdownSec = sec; return; }
      if (sec === _lastCountdownSec) return; // hindari dobel di detik yang sama
      _lastCountdownSec = sec;
      const isFinal = sec === 59;
      if (soundSettings.countdown) playCountdownBeep(isFinal);
      // Getar HP (fisik) — hanya perangkat yang mendukung (umumnya Android) & setelah user interaksi
      if (soundSettings.vibrate && navigator.vibrate && _userInteracted) {
        try { navigator.vibrate(isFinal ? [90, 50, 90] : 60); } catch (e) {}
      }
      // Goyang layar (visual halus) — jalan di semua perangkat termasuk iPhone & desktop
      if (soundSettings.shake) shakeScreen(isFinal);
    }

    function playSound(direction) {
      const keyMap = { up: 'up', bigUp: 'bigUp', down: 'down', bigDown: 'bigDown' };
      if (!soundSettings[keyMap[direction] ?? direction]) return;

      // Tentukan URL custom sound yang tepat
      let soundUrl = '';
      if (direction === 'bigUp') {
        soundUrl = customSoundBigUp || customSoundUp; // fallback ke sound naik biasa
      } else if (direction === 'bigDown') {
        soundUrl = customSoundBigDown || customSoundDown; // fallback ke sound turun biasa
      } else if (direction === 'up') {
        soundUrl = customSoundUp;
      } else {
        soundUrl = customSoundDown;
      }

      if (soundUrl) {
        const audio = new Audio(soundUrl);
        audio.volume = 0.5;
        audio.play().catch(e => {
          if (direction === 'bigUp' || direction === 'bigDown') {
            playDefaultBigSound(direction);
          } else {
            playDefaultSound(direction);
          }
        });
      } else if (direction === 'bigUp' || direction === 'bigDown') {
        playDefaultBigSound(direction);
      } else {
        playDefaultSound(direction);
      }
    }

    // Browser Notification
    let notifEnabled = false;

    async function requestNotificationPermission() {
      if (!('Notification' in window)) {
        showToast('Browser tidak mendukung notifikasi', 'warning');
        return false;
      }

      if (Notification.permission === 'granted') {
        notifEnabled = true;
        subscribeToPush(); // Subscribe to push when permission already granted
        return true;
      }

      if (Notification.permission !== 'denied') {
        const permission = await Notification.requestPermission();
        if (permission === 'granted') {
          notifEnabled = true;
          subscribeToPush(); // Subscribe to push after permission granted
          return true;
        }
      }

      return false;
    }

    // Promo/Info Notification Banner
    function showPromoNotification(data) {
      const container = document.getElementById('notifContainer');
      if (!container) {
        return;
      }

      // Icon berdasarkan type
      const icons = {
        promo: '\u{1F381}',
        warning: '\u26A0\uFE0F',
        urgent: '\u{1F6A8}',
        info: '\u{1F4E2}'
      };

      const banner = document.createElement('div');
      banner.className = 'notif-banner ' + (data.notifType || 'info');
      banner.innerHTML = \`
        <div class="notif-icon">\${icons[data.notifType] || icons.info}</div>
        <div class="notif-content">
          <div class="notif-title">\${data.title}</div>
          <div class="notif-message">\${data.message}</div>
        </div>
        <button class="notif-close" onclick="this.parentElement.remove()"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>
      \`;

      container.insertBefore(banner, container.firstChild);

      // Browser notification juga
      if (notifEnabled && Notification.permission === 'granted') {
        new Notification(data.title, {
          body: data.message,
          icon: '/icon.png',
          tag: 'promo-' + Date.now()
        });
      }

      // Play sound for promo
      playSound('up');
    }

    // Fungsi untuk tutup popup promo
    window.closePromoPopup = function(el) {
      el.parentElement.parentElement.remove();
    };

    function showNotification(title, body, isUp) {
      if (!notifEnabled || Notification.permission !== 'granted') return;

      const options = {
        body: body,
        icon: '/icon.png',
        badge: '/icon.png',
        tag: 'gold-price',
        renotify: true,
        silent: false
      };

      try {
        new Notification(title, options);
      } catch (e) {
      }
    }

    // Minta izin notifikasi saat halaman load
    if ('Notification' in window && Notification.permission === 'granted') {
      notifEnabled = true;
    } else if ('Notification' in window && Notification.permission !== 'denied') {
      // Tampilkan prompt untuk minta izin
      setTimeout(() => {
        requestNotificationPermission();
      }, 3000);
    }

    // Disable right-click
    // Right-click enabled

    // ==================== PUSH NOTIFICATION SUBSCRIPTION ====================
    async function subscribeToPush() {
      if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
        return;
      }

      try {
        const registration = await navigator.serviceWorker.ready;

        // Get VAPID public key
        const vapidRes = await fetch('/api/vapid-public-key');
        const { publicKey } = await vapidRes.json();

        // Convert VAPID key
        const applicationServerKey = urlBase64ToUint8Array(publicKey);

        // Subscribe
        const subscription = await registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey
        });

        // Send to server
        const session = localStorage.getItem('goldmonitor_session');
        if (session) {
          await fetch('/api/push-subscribe', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ session, subscription })
          });
        }
      } catch (e) {
      }
    }

    function urlBase64ToUint8Array(base64String) {
      const padding = '='.repeat((4 - base64String.length % 4) % 4);
      const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
      const rawData = window.atob(base64);
      const outputArray = new Uint8Array(rawData.length);
      for (let i = 0; i < rawData.length; ++i) {
        outputArray[i] = rawData.charCodeAt(i);
      }
      return outputArray;
    }

    // Register Service Worker for PWA
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('/sw.js')
        .then(() => {
          // Subscribe to push after SW registered
          if (Notification.permission === 'granted') {
            subscribeToPush();
          }
        })
        .catch(() => {});
    }

    // PWA Install Prompt
    let deferredPrompt = null;

    function _isAppInstalled() {
      return window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
    }
    function _updateInstallVisibility() {
      var b = document.getElementById('installBtn');
      if (!b) return;
      // Sembunyikan tombol install kalau app sudah terpasang
      b.style.display = _isAppInstalled() ? 'none' : 'flex';
    }

    window.addEventListener('beforeinstallprompt', function(e) {
      e.preventDefault();
      deferredPrompt = e;
      _updateInstallVisibility();
    });

    function installApp() {
      if (deferredPrompt) {
        deferredPrompt.prompt();
        deferredPrompt.userChoice.then(function(result) {
          if (result.outcome === 'accepted') {
            var b = document.getElementById('installBtn');
            if (b) b.style.display = 'none';
          }
          deferredPrompt = null;
        });
      }
    }

    // Install dari panel Setting (mobile & desktop). Fallback instruksi manual bila prompt tidak tersedia (mis. iOS Safari).
    window.installFromSettings = function() {
      if (typeof closeSettingsPanel === 'function') closeSettingsPanel();
      if (_isAppInstalled()) {
        showConfirm('Aplikasi sudah terpasang di perangkat ini.', 'Install Aplikasi');
        return;
      }
      if (deferredPrompt) {
        installApp();
        return;
      }
      // Tidak ada prompt otomatis — beri instruksi sesuai platform
      var ua = navigator.userAgent || '';
      var isIOS = /iphone|ipad|ipod/i.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
      var msg;
      if (isIOS) {
        msg = 'Di iPhone/iPad (Safari): ketuk tombol Bagikan (kotak dengan panah ke atas) di bawah, lalu pilih "Tambahkan ke Layar Utama".';
      } else {
        msg = 'Buka menu browser (⋮) lalu pilih "Install aplikasi" / "Tambahkan ke Layar Utama". Jika tidak muncul, aplikasi mungkin sudah terpasang atau browser tidak mendukung.';
      }
      showConfirm(msg, 'Cara Install');
    };

    window.addEventListener('appinstalled', function() {
      deferredPrompt = null;
      _updateInstallVisibility();
    });
    setTimeout(_updateInstallVisibility, 0);

    // ── Onboarding tour (pengenalan untuk user pertama kali) ──
    (function(){
      var TOUR_KEY = 'onboardingDone_v3';
      var steps = [
        { sel: '.header-logo', title: 'Treasury Price Monitor', body: 'Harga emas update tiap detik. Titik hijau berarti data live.', menu: false },
        { sel: '#navIndicatorBtn', title: 'Indikator', body: 'Atur indikator dan garis bantu di grafik.', menu: false },
        { sel: '#navNewsBtn', title: 'Berita', body: 'Berita terbaru. Titik merah berarti ada yang belum dibaca.', menu: false },
        { sel: '#promoBtnEl', title: 'Promo', body: 'Lihat promo yang sedang berjalan.', menu: false },
        { sel: '#navCalcBtn', title: 'Kalkulator', body: 'Hitung simulasi harga beli dan jual.', menu: false },
        { sel: '.clock-info', title: 'Jam & Kunci Harga', body: 'Jam ini menghitung detik berjalan. Saat <b>detik 50 ke atas berubah merah</b>, itu tandanya waktunya <b>KUNCI HARGA</b>.', menu: false, scroll: true },
        { sel: '.price-highlow-group', title: 'Tertinggi & Terendah', body: '<b>TERTINGGI</b> = harga emas paling tinggi hari ini. <b>TERENDAH</b> = harga paling rendah hari ini.', menu: false, scroll: true, mobileOnly: true },
        { sel: '.limit-markup-group', title: 'Limit, Markup & Spread', body: '<b>LIMIT</b> = sisa kuota promo. <b>MARKUP</b> = selisih harga dari acuan. <b>SPREAD</b> = selisih persen antara harga beli dan jual.', menu: false, scroll: true, mobileOnly: true },
        { sel: '#navMenuBtn', title: 'Menu', body: 'Menu utama ada di sini. Isinya kita lihat satu per satu.', menu: false, scroll: true },
        { sel: '#installBtn', title: 'Install Aplikasi', body: 'Pasang aplikasi ke layar HP atau desktop.', menu: true },
        { sel: '#themeToggleItem', title: 'Ganti Mode', body: 'Ubah tampilan ke mode gelap atau terang.', menu: true },
        { sel: '#soundToggle', title: 'Sound & Getar', body: 'Ada 2 bagian: <b>Sound</b> (suara naik/turun, promo, hitung mundur) dan <b>Getar</b> (getar HP dan goyang layar).', menu: true },
        { sel: '#settingToggle', title: 'Setting', body: 'Berisi <b>Tampilan</b> (ukuran dan jenis font) serta <b>Pilih Nominal</b> (nominal yang dipantau).', menu: true }
      ];
      var idx = 0, overlay = null, spot = null, tip = null;

      function buildDom(){
        overlay = document.createElement('div'); overlay.className = 'tour-overlay';
        spot = document.createElement('div'); spot.className = 'tour-spot';
        tip = document.createElement('div'); tip.className = 'tour-tip';
        overlay.appendChild(spot);
        document.body.appendChild(overlay);
        document.body.appendChild(tip);
        // Blokir SEMUA interaksi di luar tombol Next/Lewati — tur hanya bisa lanjut/lewati lewat tombol.
        // Capture phase + preventDefault supaya klik tidak tembus ke elemen di bawah / handler outside-click.
        ['click','mousedown','pointerdown','touchstart'].forEach(function(ev){
          overlay.addEventListener(ev, function(e){ e.preventDefault(); e.stopPropagation(); }, true);
        });
        // Klik di dalam kartu tooltip tidak boleh dianggap klik luar (tombol tetap berfungsi)
        tip.addEventListener('click', function(e){ e.stopPropagation(); });
      }

      function ensureMenu(open){
        if (open) { if (!_navMenuOpen) openNavMenu(); }
        else { if (_navMenuOpen) closeNavMenu(); }
      }

      function isMobile(){
        try { return window.matchMedia('(max-width: 768px)').matches; }
        catch(e){ return window.innerWidth <= 768; }
      }
      function isStepAvailable(s){
        if (s.mobileOnly && !isMobile()) return false; // keterangan stat hanya perlu di mobile (desktop sudah ada labelnya)
        var el = document.querySelector(s.sel);
        if (!el) return false;
        if (el.style && el.style.display === 'none') return false; // mis. installBtn saat sudah terpasang
        // item di dalam hamburger (menu:true) dianggap ada walau dropdown sedang tertutup
        if (!s.menu && el.offsetParent === null) return false; // item navbar yang tersembunyi
        return true;
      }
      function nextVisibleFrom(i, dir){
        while (i >= 0 && i < steps.length){
          if (isStepAvailable(steps[i])) return i;
          i += dir;
        }
        return -1;
      }

      function render(){
        var s = steps[idx];
        // item di dalam hamburger menempel ke tombol di header (position:relative), jadi pastikan halaman di atas
        // sebelum dropdown dibuka supaya posisinya tidak melenceng saat sebelumnya scroll ke bawah.
        if (s.menu) { try { window.scrollTo(0, 0); } catch(e){} }
        ensureMenu(!!s.menu);
        // beri waktu menu/dropdown muncul sebelum mengukur
        setTimeout(function(){
          var el = document.querySelector(s.sel);
          if (!el) { advance(1); return; }
          if (s.scroll) { try { el.scrollIntoView({ block: 'center', behavior: 'auto' }); } catch(e){} }
          var r = el.getBoundingClientRect();
          var pad = 6;
          spot.style.top = (r.top - pad) + 'px';
          spot.style.left = (r.left - pad) + 'px';
          spot.style.width = (r.width + pad*2) + 'px';
          spot.style.height = (r.height + pad*2) + 'px';
          tip.innerHTML =
            '<div class="tour-tip-title"><i data-lucide="sparkles" style="width:16px;height:16px;"></i>' + s.title + '</div>' +
            '<div class="tour-tip-body">' + s.body + '</div>' +
            '<div class="tour-tip-foot">' +
              '<span class="tour-step-count">' + (idx+1) + ' / ' + steps.length + '</span>' +
              '<div class="tour-btns">' +
                '<button class="tour-skip" id="tourSkipBtn">Lewati</button>' +
                '<button class="tour-next" id="tourNextBtn">' + (idx >= lastVisible() ? 'Selesai' : 'Lanjut') + '</button>' +
              '</div>' +
            '</div>';
          if (typeof lucide !== 'undefined') lucide.createIcons();
          document.getElementById('tourSkipBtn').addEventListener('click', function(e){ e.stopPropagation(); finish(); });
          document.getElementById('tourNextBtn').addEventListener('click', function(e){ e.stopPropagation(); advance(1); });
          // posisikan tooltip
          positionTip(r);
        }, s.menu ? 130 : 30);
      }

      function lastVisible(){
        for (var i = steps.length - 1; i >= 0; i--){
          if (isStepAvailable(steps[i])) return i;
        }
        return steps.length - 1;
      }

      function positionTip(r){
        var tipR = tip.getBoundingClientRect();
        var top = r.bottom + 14;
        var left = r.left + r.width/2 - tipR.width/2;
        // kalau tidak muat di bawah, taruh di atas
        if (top + tipR.height > window.innerHeight - 12) {
          var above = r.top - tipR.height - 14;
          if (above > 12) top = above;
          else top = Math.max(12, window.innerHeight - tipR.height - 12);
        }
        if (left < 12) left = 12;
        if (left + tipR.width > window.innerWidth - 12) left = window.innerWidth - tipR.width - 12;
        tip.style.top = top + 'px';
        tip.style.left = left + 'px';
      }

      function advance(dir){
        var ni = nextVisibleFrom(idx + dir, dir);
        if (ni === -1) { finish(); return; }
        idx = ni;
        render();
      }

      function finish(){
        try { localStorage.setItem(TOUR_KEY, '1'); } catch(e){}
        ensureMenu(false);
        if (overlay) overlay.classList.remove('active');
        if (tip) tip.style.display = 'none';
        window.removeEventListener('resize', onResize);
      }

      function onResize(){ if (overlay && overlay.classList.contains('active')) render(); }

      function start(){
        if (overlay && overlay.classList.contains('active')) return; // jangan dobel start
        if (!overlay) buildDom();
        overlay.classList.add('active');
        tip.style.display = 'block';
        idx = nextVisibleFrom(0, 1);
        if (idx === -1) { finish(); return; }
        window.addEventListener('resize', onResize);
        render();
      }
      window.startOnboardingTour = start;

      // auto-start untuk user yang belum pernah lihat (termasuk semua user lama karena fitur baru)
      function maybeStart(){
        var done = false;
        try { done = localStorage.getItem(TOUR_KEY) === '1'; } catch(e){}
        if (done) return;
        setTimeout(start, 900);
      }
      if (document.readyState === 'complete' || document.readyState === 'interactive') maybeStart();
      else window.addEventListener('DOMContentLoaded', maybeStart);

      // Cek token "fresh" dari server. Admin bisa menaikkan token ini kapan saja
      // (tombol di /admin/monitoring) untuk memaksa SEMUA user dapat tur + reset Sound & Getar.
      function freshCheck(){
        fetch('/api/fresh-token', { cache: 'no-store' })
          .then(function(r){ return r.json(); })
          .then(function(d){
            var token = d && d.token ? String(d.token) : '';
            if (!token) return;
            var seen = '';
            try { seen = localStorage.getItem('gold_fresh_token') || ''; } catch(e){}
            if (seen === token) return; // sudah fresh untuk token ini
            try {
              localStorage.removeItem(TOUR_KEY);          // tur muncul lagi
              localStorage.removeItem('soundSettings');   // sound/getar ke default
              localStorage.removeItem('soundEnabled');
              localStorage.setItem('gold_fresh_token', token);
            } catch(e){}
            // terapkan default Sound & Getar ke memori + UI
            try { if (typeof _loadSoundSettings === 'function') { soundSettings = _loadSoundSettings(); } } catch(e){}
            try { if (typeof _initSoundCheckboxes === 'function') _initSoundCheckboxes(); } catch(e){}
            // mulai tur (start() aman dipanggil walau maybeStart sudah jalan)
            setTimeout(start, 600);
          })
          .catch(function(){});
      }
      if (document.readyState === 'complete' || document.readyState === 'interactive') freshCheck();
      else window.addEventListener('DOMContentLoaded', freshCheck);
    })();

    // Logout function
    async function logout() {
      const confirmed = await showConfirm('Yakin ingin keluar?', 'Logout');
      if (!confirmed) return;

      const session = localStorage.getItem('goldmonitor_session');
      if (session) {
        try {
          await fetch('/api/logout', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ session })
          });
        } catch (e) {}
        localStorage.removeItem('goldmonitor_session');
      }
      window.location.replace('/login');
    }

    // Notif + logout saat session ditendang karena login di perangkat lain
    function _kickedToLogin() {
      localStorage.removeItem('goldmonitor_session');
      try { localStorage.setItem('gold_kicked_notice', String(Date.now())); } catch(e) {}
      try {
        showConfirm('Akun Anda baru saja login di perangkat lain. Demi keamanan, maksimal 3 perangkat aktif — sesi di perangkat ini dikeluarkan otomatis. Silakan login kembali jika ingin memakai perangkat ini.', 'Login di Perangkat Lain')
          .then(function(){ window.location.replace('/login'); });
        // fallback: redirect otomatis kalau modal tidak ditutup
        setTimeout(function(){ window.location.replace('/login'); }, 12000);
      } catch(e) {
        window.location.replace('/login');
      }
    }

    // ── Kebijakan session:
    // • Ditendang limit 3 device → notif + logout.
    // • Akun expired → logout.
    // • Session BENAR-BENAR hilang di server (jawaban tegas, bukan error) → logout rapi
    //   dengan pemberitahuan — jangan biarkan user menggantung di halaman yang datanya 403.
    // • Redis/server error (server_error) atau jaringan → toleransi 24 jam sejak verifikasi
    //   sukses terakhir; user tetap memantau. Lewat 24 jam tanpa sukses → baru keluar.
    var SESSION_GRACE_MS = 24 * 60 * 60 * 1000;
    function _sessionOk() {
      try { localStorage.setItem('gold_sess_ok_at', String(Date.now())); } catch(e) {}
    }
    function _sessionGraceExpired() {
      try {
        var t = parseInt(localStorage.getItem('gold_sess_ok_at') || '0', 10);
        if (!t) { _sessionOk(); return false; } // belum pernah tercatat — mulai hitung dari sekarang
        return (Date.now() - t) > SESSION_GRACE_MS;
      } catch(e) { return false; }
    }
    var _adminSessRefreshing = false;
    function _handleInvalidSession(data) {
      if (data.reason === 'kicked_other_device') { _kickedToLogin(); return; }
      // Akun expired = keputusan definitif server (bukan error) — langsung keluar
      if (data.reason === 'expired') {
        localStorage.removeItem('goldmonitor_session');
        window.location.replace('/login');
        return;
      }
      // Session admin (dari panel) hilang di server tapi cookie admin masih valid:
      // refresh otomatis tanpa login ulang, lalu muat ulang halaman sekali.
      var _sess = localStorage.getItem('goldmonitor_session') || '';
      if (_sess.indexOf('admin_') === 0 && !data.reason && !_adminSessRefreshing) {
        _adminSessRefreshing = true;
        fetch('/api/admin-session-refresh')
          .then(function(r){ return r.json(); })
          .then(function(d){
            if (d.success && d.sessionId) {
              localStorage.setItem('goldmonitor_session', d.sessionId);
              _sessionOk();
              window.location.reload();
            } else {
              _adminSessRefreshing = false;
            }
          })
          .catch(function(){ _adminSessRefreshing = false; });
        return;
      }
      // server_error = Redis/server lagi bermasalah — session mungkin masih valid.
      // Tahan user di halaman, baru keluar bila >24 jam tidak pernah tervalidasi.
      if (data.reason === 'server_error') {
        if (_sessionGraceExpired()) _sessionEndedToLogin();
        return;
      }
      // Tanpa reason = server menjawab TEGAS bahwa session sudah tidak ada.
      // Jangan biarkan user menggantung dengan halaman lumpuh (semua data 403) —
      // beri tahu dengan sopan lalu arahkan ke login.
      _sessionEndedToLogin();
    }

    var _sessionEnding = false;
    function _sessionEndedToLogin() {
      if (_sessionEnding) return;
      _sessionEnding = true;
      localStorage.removeItem('goldmonitor_session');
      try { localStorage.removeItem('gold_sess_ok_at'); } catch(e) {}
      try {
        showConfirm('Sesi Anda telah berakhir. Silakan login kembali untuk melanjutkan memantau harga.', 'Sesi Berakhir')
          .then(function(){ window.location.replace('/login'); });
        // fallback: redirect otomatis kalau modal tidak ditutup
        setTimeout(function(){ window.location.replace('/login'); }, 8000);
      } catch(e) {
        window.location.replace('/login');
      }
    }

    // Cek berkala: kalau session sudah ditendang (login di device lain), beri notif lalu logout
    setInterval(function() {
      const session = localStorage.getItem('goldmonitor_session');
      if (!session) return;
      fetch('/api/verify-session?session=' + session)
        .then(r => r.json())
        .then(data => {
          if (data.valid) { _sessionOk(); return; }
          _handleInvalidSession(data);
        })
        .catch(() => {}); // jaringan bermasalah — jangan logout paksa
    }, 30000);

    // Check session validity and PIN status on page load
    (function checkSession() {
      const session = localStorage.getItem('goldmonitor_session');
      if (!session) {
        window.location.replace('/login');
        return;
      }

      fetch('/api/verify-session?session=' + session)
        .then(r => r.json())
        .then(data => {
          if (!data.valid) {
            _handleInvalidSession(data); // toleransi 24 jam kecuali ditendang device lain
            return;
          }
          _sessionOk();

          // Tampilkan tombol Panel Admin di menu untuk admin
          if (data.isAdmin) {
            try { document.getElementById('adminPanelBtn').style.display = 'flex'; } catch(e){}
          }

          // Proteksi inspect hanya untuk non-admin
          if (!data.isAdmin) {
            document.addEventListener('contextmenu', function(e) { e.preventDefault(); return false; });
            document.addEventListener('keydown', function(e) {
              if (e.key === 'F12' || (e.ctrlKey && e.shiftKey && (e.key === 'I' || e.key === 'i' || e.key === 'J' || e.key === 'j' || e.key === 'C' || e.key === 'c')) || (e.ctrlKey && (e.key === 'U' || e.key === 'u'))) {
                e.preventDefault(); return false;
              }
            });
          }

          // Tema untuk SEMUA user — apply tema tersimpan, reload TV jika light
          const savedTheme = localStorage.getItem('goldmonitor_theme');
          if (savedTheme === 'light') {
            document.body.classList.add('light-mode');
            const iconDark = document.getElementById('themeIconDark');
            const iconLight = document.getElementById('themeIconLight');
            if (iconDark) iconDark.style.display = 'none';
            if (iconLight) iconLight.style.display = '';
            if (typeof window._loadTVWidget === 'function') window._loadTVWidget();
          }

          // Check if PIN change is required
          return fetch('/api/check-pin-status?session=' + session);
        })
        .then(r => r ? r.json() : null)
        .then(pinData => {
          if (pinData && pinData.requirePinChange) {
            // Redirect to login to change PIN
            window.location.replace('/login');
          }
        })
        .catch(() => {});
    })();

    // Offset waktu server vs browser (dalam ms)
    let serverTimeOffset = 0;

    // Ambil waktu akurat dari server sendiri
    async function fetchServerTime() {
      try {
        const res = await fetch('/time');
        const data = await res.json();
        serverTimeOffset = data.timestamp - Date.now();
      } catch (e) {}
    }

    // Sync waktu saat load dan setiap 5 menit
    fetchServerTime();
    setInterval(fetchServerTime, 5 * 60 * 1000);

    function getAccurateTime() {
      return new Date(Date.now() + serverTimeOffset);
    }

    function updateClock() {
      const now = getAccurateTime();
      const timeStr = formatTime(now);
      const dayName = days[now.getDay()];
      const date = now.getDate();
      const month = months[now.getMonth()];
      const year = now.getFullYear();
      const dateStr = date + ' ' + month + ' ' + year + ' WIB';

      // Update clock2 di pojok kanan (bawah Sound) — jam/menit/detik dipisah + animasi tick
      const clkH = document.getElementById('clkH');
      const clkM = document.getElementById('clkM');
      const clkS = document.getElementById('clkS');
      if (clkH || clkM || clkS) {
        const parts = timeStr.split(':');
        if (clkH && clkH.textContent !== parts[0]) clkH.textContent = parts[0];
        if (clkM && clkM.textContent !== parts[1]) clkM.textContent = parts[1];
        if (clkS && clkS.textContent !== parts[2]) {
          clkS.textContent = parts[2];
          clkS.classList.remove('clk-tick');
          void clkS.offsetWidth; // reflow agar animasi restart
          clkS.classList.add('clk-tick');
          // Detik 50 ke atas: warna merah agar ternotice (harga akan segera update)
          const _sec = parseInt(parts[2], 10);
          if (_sec >= 50) clkS.classList.add('clk-s-alert');
          else clkS.classList.remove('clk-s-alert');
          // 5 detik terakhir (55-59): beep + getar
          triggerCountdownAlert(_sec);
        }
      } else {
        const clock2 = document.getElementById('clock2');
        if (clock2) clock2.textContent = timeStr;
      }
      const dateInfo2 = document.getElementById('dateInfo2');
      const dateInfo2Day = document.getElementById('dateInfo2Day');
      if (dateInfo2) dateInfo2.textContent = dateStr;
      if (dateInfo2Day) dateInfo2Day.textContent = dayName + ', ';
    }

    // updateHistory - refresh dari server saat ada perubahan
    function updateHistory() {
      currentPage = 1; // Reset ke halaman pertama
      loadHistory();
    }

    let isFetching = false;
    let lastFetchTime = 0;
    let fetchCount = 0;
    let currentAppVersion = null; // For force reload detection

    async function fetchPrices() {
      if (isFetching) return;
      isFetching = true;
      fetchCount++;
      const fetchStart = Date.now();

      try {
        const session = localStorage.getItem('goldmonitor_session') || '';
        const res = await fetch('/monitoring/api?session=' + encodeURIComponent(session), { cache: 'no-store' });

        // 403 = session bermasalah — JANGAN logout di sini. Biarkan pengecekan
        // verify-session (30 detik) yang memutuskan: kicked → notif+logout,
        // selain itu toleransi 24 jam. Lewati siklus ini saja.
        if (res.status === 403) {
          return;
        }

        const data = await res.json();
        const fetchTime = Date.now() - fetchStart;

        // Check for version change - force reload if different
        if (data.version) {
          if (currentAppVersion === null) {
            currentAppVersion = data.version;
          } else if (currentAppVersion !== data.version) {
            window.location.reload(true);
            return;
          }
        }

        // Anti flip-flop: cek timestamp
        const dataTimestamp = data.updatedAt ? new Date(data.updatedAt).getTime() : 0;
        if (dataTimestamp > 0 && dataTimestamp <= lastUpdatedAt) {
          return; // Skip data lama
        }
        if (dataTimestamp > lastUpdatedAt) {
          lastUpdatedAt = dataTimestamp;
        }

        if (data.buy) {
          var _bpn = document.getElementById('buyPriceNum');
          if (!_bpn) { var _bp = document.getElementById('buyPrice'); if (_bp) { _bp.innerHTML = '<span class="rp-prefix">Rp </span><span id="buyPriceNum">-</span>'; _bpn = document.getElementById('buyPriceNum'); } }
          if (_bpn) _bpn.textContent = data.buy.toLocaleString('id-ID');
          if (data.buy !== lastBuy && lastBuy > 0) {
            const change = data.buy - lastBuy;
            const sign = change > 0 ? '+' : '';
            const cls = change > 0 ? 'up' : 'down';
            document.getElementById('buyChange').textContent = sign + change.toLocaleString('id-ID');
            document.getElementById('buyChange').className = 'change ' + cls;

            // Flash animation - remove and re-add class to trigger
            const buyCard = document.getElementById('buyCard');
            buyCard.classList.remove('updated');
            void buyCard.offsetWidth;
            buyCard.classList.add('updated');

            window.lastApiTimestamp = data.updatedAt ? new Date(data.updatedAt).getTime() : 0;
            updateHistory();
                      }
          lastBuy = data.buy;
        }

        if (data.sell) {
          var _spn = document.getElementById('sellPriceNum');
          if (!_spn) { var _sp = document.getElementById('sellPrice'); if (_sp) { _sp.innerHTML = '<span class="rp-prefix">Rp </span><span id="sellPriceNum">-</span>'; _spn = document.getElementById('sellPriceNum'); } }
          if (_spn) _spn.textContent = data.sell.toLocaleString('id-ID');
          if (data.sell !== lastSell && lastSell > 0) {
            const change = data.sell - lastSell;
            const sign = change > 0 ? '+' : '';
            const cls = change > 0 ? 'up' : 'down';
            document.getElementById('sellChange').textContent = sign + change.toLocaleString('id-ID');
            document.getElementById('sellChange').className = 'change ' + cls;

            // Flash animation - remove and re-add class to trigger
            const sellCard = document.getElementById('sellCard');
            sellCard.classList.remove('updated');
            void sellCard.offsetWidth; // Force reflow
            sellCard.classList.add('updated');
          }
          lastSell = data.sell;
        }

        // Update tab title
        if (lastBuy > 0 && lastSell > 0) {
          document.title = 'B ' + Math.round(lastBuy/1000) + 'k | J ' + Math.round(lastSell/1000) + 'k — Gold Monitor';
        }

        // Re-apply Beli/Jual font scale setelah update harga
        _applyBuySellFontToDOM();

        if (data.usdIdr) {
          const usdIdrRounded = Math.round(data.usdIdr);
          document.getElementById('usdIdr').innerHTML = '<span class="rp-prefix">Rp </span>' + usdIdrRounded.toLocaleString('id-ID');
          if (usdIdrRounded !== lastUsdIdr && lastUsdIdr > 0) {
            const change = usdIdrRounded - lastUsdIdr;
            const sign = change > 0 ? '+' : '';
            const cls = change > 0 ? 'up' : 'down';
            document.getElementById('usdIdrChange').textContent = sign + change.toLocaleString('id-ID');
            document.getElementById('usdIdrChange').className = 'stat-change ' + cls;

            // Flash animation
            const usdIdrCard = document.getElementById('usdIdrCard');
            usdIdrCard.classList.remove('updated');
            void usdIdrCard.offsetWidth;
            usdIdrCard.classList.add('updated');
          }
          // Jangan hapus badge usdIdrChange di sini — biarkan event usd_idr yang kontrol
          lastUsdIdr = usdIdrRounded;
        }

        // Hitung spread + nominal langsung dari data load awal (jangan tunggu SSE)
        renderSpreadAndNominals(data);
      } catch (e) {
        // Silent fail
      } finally {
        isFetching = false;
      }
    }

    setInterval(updateClock, 100);
    updateClock();

    // 📱 Mobile Invest Selector
    function showSelectedInvest(value) {
      const investItems = document.querySelectorAll('.stat-item.invest');
      investItems.forEach(function(item) {
        item.classList.remove('mobile-visible');
        if (item.dataset.invest === value) {
          item.classList.add('mobile-visible');
        }
      });
      localStorage.setItem('selectedInvest', value);
    }

    // Initialize mobile selector on page load
    (function() {
      const saved = localStorage.getItem('selectedInvest') || '20jt';
      const select = document.getElementById('mobileInvestSelect');
      if (select) {
        select.value = saved;
        showSelectedInvest(saved);
      }
    })();

    // 💰 Nominal Settings from API
    let loadedNominals = [];
    let userNominalPrefs = {}; // { id: true/false }

    function getHistoryNominals() {
      return loadedNominals.filter(n => userNominalPrefs[n.id] !== false);
    }

    // Load nominal settings from API
    function loadNominalSettings() {
      monFetch('/api/nominal-settings')
        .then(r => r.json())
        .then(data => {
          if (data.success) {
            loadedNominals = data.nominals;
            // Load user preferences from localStorage
            const saved = localStorage.getItem('userNominalPrefs');
            if (saved) {
              userNominalPrefs = JSON.parse(saved);
            } else {
              // Default: semua nominal aktif
              loadedNominals.forEach(n => { userNominalPrefs[n.id] = true; });
            }
            applyNominalVisibility();
            updateMobileSelector();
            // Re-render table with correct column visibility
            updateHistory();
          }
        })
        .catch(() => {});
    }

    function renderInvestStats() {
      const container = document.getElementById('investStatsList');
      if (!container) return;
      // Hanya render nominal yang terlihat (tidak disembunyikan user)
      const visible = loadedNominals.filter(n => userNominalPrefs[n.id] !== false);
      // Kelas jumlah → 1 tunggal, 2 kiri-kanan, >2 grid 2 kolom
      container.classList.remove('nom-1', 'nom-2', 'nom-many');
      container.classList.add(visible.length === 1 ? 'nom-1' : (visible.length === 2 ? 'nom-2' : 'nom-many'));
      container.innerHTML = visible.map(n => {
        return '<div class="stat-item invest" data-invest="' + n.id + '" style="position:relative;">' +
          '<span class="stat-label">' + n.label + '</span>' +
          '<span class="stat-value" id="gram_' + n.id + '">-</span>' +
          '<span class="stat-change up" id="profit_' + n.id + '">-</span>' +
          '</div>';
      }).join('');
    }

    // Hitung & tampilkan spread + profit per-nominal dari harga terakhir.
    // Dipanggil dari fetchPrices (load awal), SSE onmessage, dan saat nominal selesai di-load,
    // supaya saat reload nilai 10-60jt & spread langsung terisi (tidak "-").
    function renderSpreadAndNominals(data) {
      if (!data || !data.buy || !data.sell) return;
      window._lastPriceData = data;
      const spreadEl = document.getElementById('spreadPercent');
      if (spreadEl) {
        spreadEl.classList.remove('stat-val-skeleton');
        const _spreadPct = parseFloat(((data.sell - data.buy) / data.buy * 100).toFixed(2));
        spreadEl.textContent = _spreadPct + '%';
      }
      function updateProfit(elementId, profitValue) {
        const el = document.getElementById(elementId);
        if (!el) return;
        const rounded = Math.round(profitValue);
        const isPositive = rounded >= 0;
        const sign = isPositive ? '+' : '-';
        el.textContent = sign + 'Rp ' + Math.abs(rounded).toLocaleString('id-ID');
        el.classList.remove('up', 'down');
        el.classList.add(isPositive ? 'up' : 'down');
      }
      loadedNominals.forEach(n => {
        const gram = n.amount / data.buy;
        const profit = (gram * data.sell) - (n.amount - n.amount * n.discountRate);
        const gramEl = document.getElementById('gram_' + n.id);
        if (gramEl) gramEl.textContent = gram.toFixed(4) + ' gr';
        updateProfit('profit_' + n.id, profit);
        if (!_nominalProfit[n.id]) _nominalProfit[n.id] = [];
      });
    }

    function renderHistoryHeaders() {
      const row = document.getElementById('historyHeaderRow');
      if (!row) return;
      row.querySelectorAll('.th-nominal').forEach(th => th.remove());
      getHistoryNominals().forEach((n, idx) => {
        const th = document.createElement('th');
        th.className = 'th-nominal th-nom-' + idx;
        th.setAttribute('data-nominal', n.id);
        th.textContent = n.label;
        row.appendChild(th);
      });
    }

    function applyNominalVisibility() {
      renderInvestStats();
      renderHistoryHeaders();
      window.adminNominalIds = loadedNominals.map(n => n.id);
      window.loadedNominalsMap = {};
      loadedNominals.forEach(n => { window.loadedNominalsMap[n.id] = n; });
      // Jika harga sudah pernah diterima, langsung isi chip (hindari "-" saat reload)
      if (window._lastPriceData) renderSpreadAndNominals(window._lastPriceData);
    }

    function openNominalSettings() {
      const modal = document.getElementById('nominalSettingsModal');
      const list = document.getElementById('nominalModalList');

      list.innerHTML = loadedNominals.map(n => {
        const checked = userNominalPrefs[n.id] !== false ? 'checked' : '';
        const discountPercent = parseFloat((n.discountRate * 100).toFixed(3));
        return '<div class="nominal-modal-item" onclick="toggleNominalCheckbox(&apos;' + n.id + '&apos;)">' +
          '<input type="checkbox" id="nom_' + n.id + '" ' + checked + ' onclick="event.stopPropagation()">' +
          '<label for="nom_' + n.id + '">' + n.label + '</label>' +
          '<span class="nominal-discount">Disc ' + discountPercent + '%</span>' +
        '</div>';
      }).join('');

      modal.classList.add('active');
    }

    function toggleNominalCheckbox(id) {
      const cb = document.getElementById('nom_' + id);
      if (cb) cb.checked = !cb.checked;
    }

    function closeNominalSettings() {
      document.getElementById('nominalSettingsModal').classList.remove('active');
    }

    function saveNominalSettings() {
      loadedNominals.forEach(n => {
        const cb = document.getElementById('nom_' + n.id);
        userNominalPrefs[n.id] = cb ? cb.checked : true;
      });
      localStorage.setItem('userNominalPrefs', JSON.stringify(userNominalPrefs));
      applyNominalVisibility();
      updateMobileSelector();
      renderHistoryHeaders();
      loadHistory();
      closeNominalSettings();
    }

    function updateMobileSelector() {
      // Dropdown selector sudah dihapus - fungsi ini tidak diperlukan lagi
      return;
    }

    // Load nominal settings on page load
    loadNominalSettings();

    // Load promo limit on page load
    function updateStatCentering() {
      const statsEl = document.querySelector('.chart-stats');
      if (!statsEl) return;
      const items = Array.from(statsEl.children);
      items.forEach(el => el.classList.remove('stat-alone'));
      const visible = items.filter(el => el.style.display !== 'none');
      if (visible.length % 2 === 1) visible[visible.length - 1].classList.add('stat-alone');
    }

    function loadAndShowPromoLimit() {
      monFetch('/api/promo-limit')
        .then(r => r.json())
        .then(data => {
          const card = document.getElementById('promoLimitCard');
          const val = document.getElementById('promoLimitValue');
          if (data.limit !== null && data.limit !== undefined) {
            if (val) val.textContent = data.limit;
            if (card) card.style.display = 'flex';
          } else {
            if (card) card.style.display = 'none';
          }
          updateStatCentering();
        })
        .catch(() => {});
    }
    loadAndShowPromoLimit();

    function loadLowestOnPrice() {
      monFetch('/api/lowest-on-price')
        .then(r => r.json())
        .then(data => {
          const card = document.getElementById('lowestOnCard');
          const val = document.getElementById('lowestOnValue');
          if (data.price !== null && data.price !== undefined) {
            if (val) val.textContent = formatRupiahShort(data.price);
            if (card) card.style.display = '';
          } else {
            if (card) card.style.display = 'none';
          }
          updateStatCentering();
        })
        .catch(() => {});
    }
    loadLowestOnPrice();

    // Load daily high/low dari server untuk inisialisasi
    function loadDailyHighLow() {
      monFetch('/api/daily-highlow')
        .then(r => r.json())
        .then(data => {
          if (data.high !== null && data.high !== undefined) {
            if (sessionHigh === null || data.high > sessionHigh) {
              sessionHigh = data.high;
              const el = document.getElementById('sessionHighValue');
              if (el) el.textContent = data.high.toLocaleString('id-ID');
            }
          }
          if (data.low !== null && data.low !== undefined) {
            if (sessionLow === null || data.low < sessionLow) {
              sessionLow = data.low;
              const el = document.getElementById('sessionLowValue');
              if (el) el.textContent = data.low.toLocaleString('id-ID');
            }
          }
        })
        .catch(() => {});
    }
    loadDailyHighLow();

    // 🚀 SSE (Server-Sent Events) untuk real-time INSTANT update
    let evtSource = null;
    let sseReconnectTimer = null;
    let lastDataTime = Date.now();

    // Helper: fetch dengan session otomatis untuk monitoring page
    function monFetch(url, opts) {
      var session = localStorage.getItem('goldmonitor_session') || '';
      var sep = url.indexOf('?') !== -1 ? '&' : '?';
      return fetch(url + sep + 'session=' + encodeURIComponent(session), opts || {});
    }

    let _sseEverConnected = false;
    function connectSSE() {
      if (evtSource) {
        evtSource.close();
      }
      // Include session for online user tracking
      const session = localStorage.getItem('goldmonitor_session') || '';
      evtSource = new EventSource('/sse?session=' + encodeURIComponent(session));
      evtSource.onopen = function() {
        if (_sseEverConnected) {
          loadHistory();
        }
        _sseEverConnected = true;
      };
      setupSSEHandlers();
    }

    function setupSSEHandlers() {
    // Stats untuk evaluasi
    let updateCount = 0;
    let totalDelay = 0;
    let minDelay = Infinity;
    let maxDelay = 0;
    let delayHistory = [];

    evtSource.onmessage = function(event) {
      try {
        lastDataTime = Date.now();
        const data = JSON.parse(event.data);

        // Skip heartbeat silently
        if (data.type === 'heartbeat') {
          const el = document.getElementById('chatOnlineCount');
          if (el && data.clients) el.textContent = data.clients + ' online';
          return;
        }

        // Update harga XAU/USD di title tab browser
        if (data.type === 'xau') {
          const price = parseFloat(data.price);
          if (!isNaN(price)) {
            const change = parseFloat(data.change) || 0;
            const sign = change >= 0 ? '+' : '';
            const pctChange = data.prevPrice ? ((change / data.prevPrice) * 100).toFixed(2) : '0.00';
            document.title = 'GOLD ' + price.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' ' + sign + pctChange + '% | Gold Price Monitor';
          }
          return;
        }

        // Handle notifikasi/promo dari admin
        if (data.type === 'notification') {
          showPromoNotification(data);
          return;
        }

        // Handle sound settings update from admin
        if (data.type === 'sound_update') {
          customSoundUp = data.settings.soundUp || '';
          customSoundDown = data.settings.soundDown || '';
          customSoundOn = data.settings.soundOn || '';
          customSoundOff = data.settings.soundOff || '';
          customSoundBigUp = data.settings.soundBigUp || '';
          customSoundBigDown = data.settings.soundBigDown || '';
          return;
        }

        // Handle nominal settings update from admin
        if (data.type === 'nominal_update') {
          loadedNominals = data.nominals || [];
          applyNominalVisibility();
          updateMobileSelector();
          updateHistory();
          return;
        }

        // Handle promo suggestions real-time update
        if (data.type === 'promo_suggestions') {
          renderPromoSuggestions(data.promos || []);
          return;
        }

        // Handle promo limit update from admin
        if (data.type === 'promo_limit_update') {
          const card = document.getElementById('promoLimitCard');
          const val = document.getElementById('promoLimitValue');
          if (data.limit !== null && data.limit !== undefined) {
            if (val) val.textContent = data.limit;
            if (card) card.style.display = 'flex';
          } else {
            if (card) card.style.display = 'none';
          }
          updateStatCentering();
          return;
        }

        // Handle lowest ON price update
        if (data.type === 'lowest_on_price') {
          const card = document.getElementById('lowestOnCard');
          const val = document.getElementById('lowestOnValue');
          if (data.price !== null && data.price !== undefined) {
            if (val) val.textContent = formatRupiahShort(data.price);
            if (card) card.style.display = '';
          } else {
            if (card) card.style.display = 'none';
          }
          updateStatCentering();
          return;
        }

        if (data.type === 'daily_highlow') {
          if (data.high !== null && data.high !== undefined) {
            if (sessionHigh === null || data.high > sessionHigh) {
              sessionHigh = data.high;
              const el = document.getElementById('sessionHighValue');
              if (el) el.textContent = data.high.toLocaleString('id-ID');
            }
          }
          if (data.low !== null && data.low !== undefined) {
            if (sessionLow === null || data.low < sessionLow) {
              sessionLow = data.low;
              const el = document.getElementById('sessionLowValue');
              if (el) el.textContent = data.low.toLocaleString('id-ID');
            }
          }
          return;
        }

        if (data.type === 'markup_settings_update') {
          if (data.settings) {
            if (data.settings.minMargin != null) _markupMinMargin = parseFloat(data.settings.minMargin);
            if (data.settings.maxMargin != null) _markupMaxMargin = parseFloat(data.settings.maxMargin);
          }
          return;
        }

        if (data.type === 'chat_init') {
          _chatMyAnimal = data.animal || '';
          const el = document.getElementById('chatMyAnimal');
          if (el) el.textContent = _chatMyAnimal;
          _loadChatHistory(data.messages || []);
          const countEl = document.getElementById('chatOnlineCount');
          if (countEl && data.clients) countEl.textContent = data.clients + ' online';
          return;
        }

        if (data.type === 'chat_message') {
          _appendChatMsg(data);
          return;
        }

        if (data.type === 'chat_reset') {
          const box = document.getElementById('chatMessages');
          if (box) box.innerHTML = '';
          return;
        }

        if (data.type === 'session_expired') {
          localStorage.removeItem('goldmonitor_session');
          var _toast = document.createElement('div');
          _toast.style.cssText = 'position:fixed;top:20px;left:50%;transform:translateX(-50%);background:#ef4444;color:#fff;padding:14px 24px;border-radius:12px;font-size:0.95em;font-weight:600;z-index:99999;box-shadow:0 4px 20px rgba(0,0,0,0.4);text-align:center;';
          _toast.innerHTML = '🔒 Sesi Anda telah berakhir<br><span style="font-weight:400;font-size:0.88em;">Mengalihkan ke halaman login...</span>';
          document.body.appendChild(_toast);
          setTimeout(function() { window.location.href = '/login'; }, 2500);
          return;
        }


        // 🎁 Handle promo ON/OFF status
        if (data.type === 'promo_status') {

          // Update badge UI (selalu update, tidak perlu soundEnabled)
          const badge = document.getElementById('promoStatusBadge');
          const statusText = document.getElementById('promoStatusText');
          if (badge && statusText) {
            badge.classList.remove('on', 'off');
            badge.classList.add(data.status === 'ON' ? 'on' : 'off');
            statusText.textContent = data.status;
          }

          // Sound hanya jika promo sound enabled
          if (!soundSettings.promo) {
            return;
          }

          // Update status tracker
          lastPromoStatusClient = data.status;

          // Capture status untuk setTimeout
          const statusForSound = data.status;


          // Play sound dengan delay 5 detik agar tidak nyatu dengan sound NAIK/TURUN
          setTimeout(() => {
            try {
              const soundUrl = statusForSound === 'ON'
                ? (customSoundOn || defaultPromoSoundOn)
                : (customSoundOff || defaultPromoSoundOff);
              const audio = new Audio(soundUrl);
              audio.volume = 0.7;
              audio.play()
                .then(() => {})
                .catch(() => {});
            } catch (e) {
            }
          }, 5000); // 5 detik delay

          return;
        }

        // Handle force logout from admin
        if (data.type === 'force_logout') {
          showToast('Sesi Anda telah berakhir. Silakan login kembali.', 'warning');
          setTimeout(() => {
            localStorage.removeItem('goldmonitor_session');
            window.location.href = '/login';
          }, 2000);
          return;
        }

        if (data.type === 'usd_idr') {
          const rate = data.rate;
          if (!rate) return;
          const usdIdrRounded = Math.round(rate);
          const usdIdrEl = document.getElementById('usdIdr');
          if (usdIdrEl) {
            usdIdrEl.classList.remove('stat-val-skeleton');
            usdIdrEl.textContent = 'Rp ' + usdIdrRounded.toLocaleString('id-ID');
            if (usdIdrRounded !== lastUsdIdr && lastUsdIdr > 0) {
              const change = usdIdrRounded - lastUsdIdr;
              const sign = change > 0 ? '+' : '';
              const cls = change > 0 ? 'up' : 'down';
              document.getElementById('usdIdrChange').textContent = sign + change.toLocaleString('id-ID');
              document.getElementById('usdIdrChange').className = 'stat-change ' + cls;
              const usdIdrCard = document.getElementById('usdIdrCard');
              if (usdIdrCard) { usdIdrCard.classList.remove('updated'); void usdIdrCard.offsetWidth; usdIdrCard.classList.add('updated'); }
            }
            lastUsdIdr = usdIdrRounded;
          }
          // Tambah ke tabel USD/IDR history jika mode aktif
          if (_historyMode === 'usdidr' && data.time) {
            const tbody = document.getElementById('usdIdrHistoryBody');
            if (tbody) {
              const noData = tbody.querySelector('.no-data');
              if (noData) noData.parentElement.remove();
              const _triUp = '<svg width="10" height="10" viewBox="0 0 10 10" fill="currentColor" style="display:inline;vertical-align:middle;margin-right:2px"><polygon points="5,0 10,10 0,10"/></svg>';
              const _triDn = '<svg width="10" height="10" viewBox="0 0 10 10" fill="currentColor" style="display:inline;vertical-align:middle;margin-right:2px"><polygon points="0,0 10,0 5,10"/></svg>';
              const ch = data.change || 0;
              const changeHtml = ch > 0
                ? '<span style="color:#22c55e;font-weight:600;">' + _triUp + '+' + Math.round(ch).toLocaleString('id-ID') + '</span>'
                : ch < 0
                ? '<span style="color:#ef4444;font-weight:600;">' + _triDn + Math.round(ch).toLocaleString('id-ID') + '</span>'
                : '<span style="color:#8b949e;">-</span>';
              const tr = document.createElement('tr');
              tr.innerHTML = '<td>' + data.time.substring(11,19) + '</td><td>Rp ' + Math.round(data.rate).toLocaleString('id-ID') + '</td><td>' + changeHtml + '</td>';
              tbody.insertBefore(tr, tbody.firstChild);
              const countEl = document.getElementById('historyCount');
              if (countEl) {
                const cur = parseInt(countEl.textContent) || 0;
                countEl.textContent = (cur + 1) + ' records';
              }
            }
          }
          // Recalculate markup with updated USD/IDR
          const _d = window._lastPriceData;
          const _xau = data.xauUsd;
          if (_d && _d.buy && _d.sell && _xau) {
            const _TROY = 31.1035;
            const _base = (_xau * rate) / _TROY;
            const _lower = _base * (1 + _markupMinMargin / 100);
            const _upper = _base * (1 + _markupMaxMargin / 100);
            const _mkOverlay = document.getElementById('markupOverlay');
            const _mkOverlayVal = document.getElementById('markupOverlayValue');
            if (_d.sell >= _lower && _d.sell <= _upper) {
              if (_mkOverlay) _mkOverlay.style.display = 'none';
            } else {
              const _diff = _d.sell > _upper ? Math.round(_d.sell - _upper) : Math.round(_d.sell - _lower);
              const _sign = _diff > 0 ? '+' : '';
              const _mkLabel = document.getElementById('markupOverlayLabel');
              if (_mkLabel) _mkLabel.textContent = _diff > 0 ? 'MARKUP' : 'MARKDOWN';
              if (_mkOverlayVal) _mkOverlayVal.textContent = _sign + _diff.toLocaleString('id-ID');
              if (_mkOverlay) _mkOverlay.style.display = 'flex';
            }
            updateStatCentering();
          }
          return;
        }

        if (data.type === 'price') {
          // Anti flip-flop: cek timestamp, skip jika data lama
          const dataTimestamp = data.updatedAt ? new Date(data.updatedAt).getTime() : 0;
          if (dataTimestamp > 0 && dataTimestamp <= lastUpdatedAt) {
            return; // Skip data lama
          }
          if (dataTimestamp > lastUpdatedAt) {
            lastUpdatedAt = dataTimestamp;
          }

          // Update API health widget
          if (data.fetchMs != null) {
            const pctEl = document.getElementById('apiHealthPct');
            const iconEl = document.getElementById('apiHealthIcon');
            const widget = document.getElementById('apiHealthWidget');
            if (pctEl && iconEl && widget) {
              const ms = data.fetchMs;
              // Smoothness: 0ms=100%, 5000ms=0% (linear)
              const smooth = Math.max(0, Math.round(100 - (ms / 50)));
              // Penalti tambahan jika data Treasury stale > 60 detik
              const ageS = data.dataAgeMs != null ? Math.round(data.dataAgeMs / 1000) : 0;
              const agePenalty = ageS > 60 ? Math.min(30, Math.round((ageS - 60) / 10)) : 0;
              const final = Math.max(0, smooth - agePenalty);
              const color = final >= 80 ? '#00c853' : final >= 50 ? '#f7931a' : '#ff5252';
              pctEl.textContent = final + '%';
              pctEl.style.color = color;
              iconEl.style.color = color;
              widget.style.borderColor = color.replace(')', ',0.25)').replace('rgb', 'rgba');
              widget.title = 'Kelancaran Aplikasi: ' + final + '%';
            }
          }

          // Update harga beli
          if (data.buy) {
            const buyEl = document.getElementById('buyPrice');
            buyEl.classList.remove('stat-val-skeleton');

            if (data.prevBuy && data.buy !== data.prevBuy) {
              const change = data.buy - data.prevBuy;
              const sign = change > 0 ? '+' : '';
              const cls = change > 0 ? 'up' : 'down';
              document.getElementById('buyChange').textContent = sign + change.toLocaleString('id-ID');
              document.getElementById('buyChange').className = 'stat-change ' + cls;
              // Pakai sound "besar" jika selisih > 3000
              if (Math.abs(change) > 3000) {
                playSound(change > 0 ? 'bigUp' : 'bigDown');
              } else {
                playSound(change > 0 ? 'up' : 'down');
              }

              // Update trend icon di XAU/USD Chart title
              const trendIcon = document.getElementById('trendIcon');
              if (trendIcon) {
                if (change > 0) {
                  trendIcon.innerHTML = '<svg width="20" height="20" viewBox="0 0 24 24" fill="#00c853" style="vertical-align:middle;"><path d="M7 14l5-5 5 5H7z"/></svg>';
                  trendIcon.className = 'trend-icon-up';
                } else {
                  trendIcon.innerHTML = '<svg width="20" height="20" viewBox="0 0 24 24" fill="#ff5252" style="vertical-align:middle;"><path d="M7 10l5 5 5-5H7z"/></svg>';
                  trendIcon.className = 'trend-icon-down';
                }
              }

              // Browser Notification
              const notifTitle = change > 0 ? 'Harga Emas NAIK' : 'Harga Emas TURUN';
              const notifBody = 'Rp ' + data.buy.toLocaleString('id-ID') + ' (' + sign + change.toLocaleString('id-ID') + ')';
              showNotification(notifTitle, notifBody, change > 0);

              const buyCard = document.getElementById('buyCard');
              buyCard.classList.remove('updated', 'updated-up', 'updated-down', 'price-up', 'price-down');
              void buyCard.offsetWidth;
              buyCard.classList.add(change > 0 ? 'updated-up' : 'updated-down', change > 0 ? 'price-up' : 'price-down');

              // Glow effect on ALL bordered elements - blink for 5 seconds
              const glowClass = change > 0 ? 'glow-up' : 'glow-down';

              // All elements to apply glow
              const glowElements = [
                document.querySelector('.header'),
                document.querySelector('.chart-section'),
                document.querySelector('.chart-info-row'),
                document.querySelector('.history-section'),
                ...document.querySelectorAll('.stat-item')
              ].filter(el => el);

              // Apply glow to all elements
              glowElements.forEach(el => {
                el.classList.remove('glow-up', 'glow-down');
                void el.offsetWidth;
                el.classList.add(glowClass);
              });

              // Glow tidak dihapus — tetap sampai harga berubah lagi

              // Flip animation
              buyEl.classList.remove('flip-out-up','flip-out-down','flip-in');
              void buyEl.offsetWidth;
              buyEl.classList.add(change > 0 ? 'flip-out-up' : 'flip-out-down');
              var _newBuyNum = data.buy.toLocaleString('id-ID');
              var _buyNumEl = document.getElementById('buyPriceNum');
              if (!_buyNumEl) { buyEl.innerHTML = '<span class="rp-prefix">Rp </span><span id="buyPriceNum">-</span>'; _buyNumEl = document.getElementById('buyPriceNum'); }
              setTimeout(function(){ if (_buyNumEl) { _buyNumEl.textContent = _newBuyNum; _applyBuySellFontToDOM(); } buyEl.classList.remove('flip-out-up','flip-out-down'); buyEl.classList.add('flip-in'); }, 160);

              updateHistory();
            } else {
              var _buyNumEl2 = document.getElementById('buyPriceNum');
              if (!_buyNumEl2) { buyEl.innerHTML = '<span class="rp-prefix">Rp </span><span id="buyPriceNum">-</span>'; _buyNumEl2 = document.getElementById('buyPriceNum'); }
              if (_buyNumEl2) _buyNumEl2.textContent = data.buy.toLocaleString('id-ID');
            }
            lastBuy = data.buy;

            // Update session high/low
            if (sessionHigh === null || data.buy > sessionHigh) {
              sessionHigh = data.buy;
              const _highEl = document.getElementById('sessionHighValue');
              if (_highEl) _highEl.textContent = data.buy.toLocaleString('id-ID');
            }
            if (sessionLow === null || data.buy < sessionLow) {
              sessionLow = data.buy;
              const _lowEl = document.getElementById('sessionLowValue');
              if (_lowEl) _lowEl.textContent = data.buy.toLocaleString('id-ID');
            }
          }

          // Update harga jual
          if (data.sell) {
            const sellEl = document.getElementById('sellPrice');
            sellEl.classList.remove('stat-val-skeleton');
            if (data.prevSell && data.sell !== data.prevSell) {
              const change = data.sell - data.prevSell;
              const sign = change > 0 ? '+' : '';
              const cls = change > 0 ? 'up' : 'down';
              document.getElementById('sellChange').textContent = sign + change.toLocaleString('id-ID');
              document.getElementById('sellChange').className = 'stat-change ' + cls;

              const sellCard = document.getElementById('sellCard');
              sellCard.classList.remove('updated', 'updated-up', 'updated-down', 'price-up', 'price-down');
              void sellCard.offsetWidth;
              sellCard.classList.add(change > 0 ? 'updated-up' : 'updated-down', change > 0 ? 'price-up' : 'price-down');

              // Flip animation
              sellEl.classList.remove('flip-out-up','flip-out-down','flip-in');
              void sellEl.offsetWidth;
              sellEl.classList.add(change > 0 ? 'flip-out-up' : 'flip-out-down');
              var _newSellNum = data.sell.toLocaleString('id-ID');
              var _sellNumEl = document.getElementById('sellPriceNum');
              if (!_sellNumEl) { sellEl.innerHTML = '<span class="rp-prefix">Rp </span><span id="sellPriceNum">-</span>'; _sellNumEl = document.getElementById('sellPriceNum'); }
              setTimeout(function(){ if (_sellNumEl) { _sellNumEl.textContent = _newSellNum; _applyBuySellFontToDOM(); } sellEl.classList.remove('flip-out-up','flip-out-down'); sellEl.classList.add('flip-in'); }, 160);
            } else {
              var _sellNumEl2 = document.getElementById('sellPriceNum');
              if (!_sellNumEl2) { sellEl.innerHTML = '<span class="rp-prefix">Rp </span><span id="sellPriceNum">-</span>'; _sellNumEl2 = document.getElementById('sellPriceNum'); }
              if (_sellNumEl2) _sellNumEl2.textContent = data.sell.toLocaleString('id-ID');
            }
            lastSell = data.sell;
          }

          // Update tab title
          if (lastBuy > 0) {
            document.title = 'Monitor - HB ' + lastBuy.toLocaleString('id-ID');
          }

          // Update USD/IDR
          if (data.usdIdr) {
            const usdIdrRounded = Math.round(data.usdIdr);
            const usdIdrEl = document.getElementById('usdIdr');
            usdIdrEl.classList.remove('stat-val-skeleton');
            usdIdrEl.textContent = 'Rp ' + usdIdrRounded.toLocaleString('id-ID');
            if (usdIdrRounded !== lastUsdIdr && lastUsdIdr > 0) {
              const change = usdIdrRounded - lastUsdIdr;
              const sign = change > 0 ? '+' : '';
              const cls = change > 0 ? 'up' : 'down';
              document.getElementById('usdIdrChange').textContent = sign + change.toLocaleString('id-ID');
              document.getElementById('usdIdrChange').className = 'stat-change ' + cls;

              // Flash animation
              const usdIdrCard = document.getElementById('usdIdrCard');
              usdIdrCard.classList.remove('updated');
              void usdIdrCard.offsetWidth;
              usdIdrCard.classList.add('updated');
            }
            // Jangan hapus badge usdIdrChange di sini — biarkan event usd_idr yang kontrol
            lastUsdIdr = usdIdrRounded;
          }

          // Update Markup stat card
          if (data.buy && data.sell && data.xauUsd && data.usdIdr) {
            const _TROY = 31.1035;
            const _base = (data.xauUsd * data.usdIdr) / _TROY;
            const _lower = _base * (1 + _markupMinMargin / 100);
            const _upper = _base * (1 + _markupMaxMargin / 100);
            const _sell = data.sell;
            const _mkCard = document.getElementById('markupCard');
            const _mkVal = document.getElementById('markupValue');
            const _mkOverlay = document.getElementById('markupOverlay');
            const _mkOverlayVal = document.getElementById('markupOverlayValue');
            if (_mkCard) _mkCard.style.display = 'none';
            if (_sell >= _lower && _sell <= _upper) {
              if (_mkOverlay) _mkOverlay.style.display = 'none';
            } else {
              const _diff = _sell > _upper ? Math.round(_sell - _upper) : Math.round(_sell - _lower);
              const _sign = _diff > 0 ? '+' : '';
              const _mkLabel = document.getElementById('markupOverlayLabel');
              if (_mkLabel) _mkLabel.textContent = _diff > 0 ? 'MARKUP' : 'MARKDOWN';
              if (_mkOverlayVal) _mkOverlayVal.textContent = _sign + _diff.toLocaleString('id-ID');
              if (_mkOverlay) _mkOverlay.style.display = 'flex';
            }
            updateStatCentering();
          }

          // Update Spread dan Investasi (fungsi bersama dengan load awal)
          renderSpreadAndNominals(data);
        }
      } catch (e) {}
    };

    evtSource.onopen = function() {
      const dot = document.querySelector('.live-dot');
      if (dot) { dot.classList.remove('reconnecting'); }
      lastDataTime = Date.now();
      sseReconnectCount = 0;
    };

    evtSource.onerror = function() {
      const dot = document.querySelector('.live-dot');
      if (dot) { dot.classList.add('reconnecting'); }
      if (sseReconnectTimer) clearTimeout(sseReconnectTimer);
      const delay = Math.min(3000 * Math.pow(2, sseReconnectCount), 30000);
      sseReconnectCount++;
      sseReconnectTimer = setTimeout(function() {
        connectSSE();
      }, delay);
    };
    } // end setupSSEHandlers

    // Reconnect counter
    let sseReconnectCount = 0;

    // Fetch markup settings dulu, baru start SSE + history
    monFetch('/api/markup-settings').then(r => r.json()).then(data => {
      if (data.success && data.settings) {
        if (data.settings.minMargin != null) _markupMinMargin = parseFloat(data.settings.minMargin);
        if (data.settings.maxMargin != null) _markupMaxMargin = parseFloat(data.settings.maxMargin);
      }
    }).catch(() => {}).finally(() => {
      connectSSE();
      loadHistory();
    });

    // Check jika tidak ada data selama 60 detik, reconnect
    setInterval(function() {
      if (Date.now() - lastDataTime > 60000) {
        sseReconnectCount++;
        if (sseReconnectCount >= 3) {
          // Auto reload jika sudah reconnect 3x tanpa data
          window.location.reload();
        } else {
          connectSSE();
        }
      }
    }, 10000);

    // 📱 Handle visibility change (untuk HP yang minimize browser)
    let wasHidden = false;
    let wakeLock = null;

    // Request Wake Lock untuk mencegah layar mati (optional)
    async function requestWakeLock() {
      if ('wakeLock' in navigator) {
        try {
          wakeLock = await navigator.wakeLock.request('screen');
          wakeLock.addEventListener('release', () => {
          });
        } catch (err) {
        }
      }
    }

    // Request wake lock saat pertama load
    requestWakeLock();

    document.addEventListener('visibilitychange', function() {
      if (document.hidden) {
        // Tab/browser masuk background
        wasHidden = true;
        // Release wake lock saat di background
        if (wakeLock) {
          wakeLock.release();
          wakeLock = null;
        }
      } else if (wasHidden) {
        // Tab/browser kembali ke foreground
        wasHidden = false;

        // Re-request wake lock
        requestWakeLock();

        // Reconnect SSE
        connectSSE();

        // Fetch data terbaru
        fetchPrices();

        // Reset reconnect counter
        sseReconnectCount = 0;
        lastDataTime = Date.now();

        // Toast reconnect dihilangkan (terlalu sering muncul saat ganti tab)
      }
    });

    // Fallback: Fetch sekali saat load untuk data awal
    fetchPrices();

    // Load & apply tema dari server
    (function() {
      const _hexToRgb = h => { const r=/^#([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(h); return r?parseInt(r[1],16)+','+parseInt(r[2],16)+','+parseInt(r[3],16):'0,0,0'; };
      const _lighten = (hex, amt) => { const c=parseInt(hex.slice(1),16); const r=Math.min(255,((c>>16)&255)+amt),g=Math.min(255,((c>>8)&255)+amt),b=Math.min(255,(c&255)+amt); return '#'+(r<<16|g<<8|b).toString(16).padStart(6,'0'); };
      const _lum = hex => { const r=parseInt(hex.slice(1,3),16)/255,g=parseInt(hex.slice(3,5),16)/255,b=parseInt(hex.slice(5,7),16)/255; return 0.299*r+0.587*g+0.114*b; };
      monFetch('/api/theme-settings').then(r => r.json()).then(data => {
        if (!data.success || !data.theme) return;
        const t = data.theme;
        const root = document.documentElement;
        // Background
        root.style.setProperty('--bg-page', 'linear-gradient(160deg,'+t.bg1+' 0%,'+t.bg2+' 50%,'+t.bg3+' 100%)');
        const hdr = t.header || t.bg1;
        root.style.setProperty('--bg-header', hdr);
        root.style.setProperty('--bg-card', t.card);
        root.style.setProperty('--bg-card-hover', _lighten(t.card, 10));
        root.style.setProperty('--bg-input', _lighten(t.card, 18));
        // Auto text color: header area
        const hdrLum = _lum(hdr);
        root.style.setProperty('--header-text', hdrLum > 0.4 ? '#131722' : '#eef3fa');
        // Auto text color: card/body area (riwayat, dll)
        const cardLum = _lum(t.card);
        if (cardLum > 0.4) {
          root.style.setProperty('--text-primary', '#1a2030');
          root.style.setProperty('--text-secondary', '#4a5568');
          root.style.setProperty('--text-heading', '#0d1120');
        } else {
          root.style.setProperty('--text-primary', '#c4d0df');
          root.style.setProperty('--text-secondary', '#5e7080');
          root.style.setProperty('--text-heading', '#eef3fa');
        }
      }).catch(() => {});
    })();



    // Initial promo badge load
    monFetch('/api/promo-suggestions').then(r => r.json()).then(data => {
      const promos = data.promos || [];
      const badgeEl = document.getElementById('promoBadge');
      const btnEl = document.getElementById('promoBtnEl');
      const count = promos.length;
      if (badgeEl) {
        badgeEl.textContent = count;
        badgeEl.style.display = count > 0 ? 'inline' : 'none';
      }
      if (count > 0 && btnEl) {
        const currentIds = promos.map(p => p.code).sort().join(',');
        const seenIds = localStorage.getItem('promoSeenIds') || '';
        if (currentIds !== seenIds) btnEl.classList.add('has-new');
      }
    }).catch(() => {});
  </script>

  <!-- Sound Panel — di luar header agar position:fixed tidak terkena backdrop-filter -->
  <!-- Chooser: Sound & Getar -->
  <div id="soundPanel" class="sound-panel" style="display:none" onclick="event.stopPropagation()">
    <div class="sound-panel-header">
      Pengaturan Sound &amp; Getar
      <button class="sound-panel-close" onclick="closeSoundPanel()"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>
    </div>
    <div class="sound-row" style="cursor:pointer" onclick="openSoundFx(event)">
      <div class="sound-row-icon" style="background:rgba(96,165,250,0.15)"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#60a5fa" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/></svg></div>
      <div class="sound-row-label">Sound<span class="sound-row-sub">Suara naik/turun, promo, hitung mundur</span></div>
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#6b7280" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>
    </div>
    <div class="sound-row" style="cursor:pointer" onclick="openGetar(event)">
      <div class="sound-row-icon" style="background:rgba(167,139,250,0.15)"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#a78bfa" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect x="7" y="2" width="10" height="20" rx="2"/><line x1="11" y1="18" x2="13" y2="18"/></svg></div>
      <div class="sound-row-label">Getar<span class="sound-row-sub">Getar HP &amp; goyang layar</span></div>
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#6b7280" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>
    </div>
  </div>

  <!-- Sub-panel: Sound (efek suara) -->
  <div id="soundFxPanel" class="sound-panel" style="display:none" onclick="event.stopPropagation()">
    <div class="sound-panel-header">
      <span style="display:inline-flex;align-items:center;gap:6px;"><button class="sound-panel-back" title="Kembali" onclick="closeSoundFx();openSoundPanel()"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg></button>Sound</span>
      <button class="sound-panel-close" onclick="closeSoundFx()"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>
    </div>
    <div class="sound-row">
      <div class="sound-row-icon" style="background:rgba(34,197,94,0.15)"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#4ade80" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="18 15 12 9 6 15"/></svg></div>
      <div class="sound-row-label">Harga Naik<span class="sound-row-sub">Perubahan normal</span></div>
      <label class="sound-sw"><input type="checkbox" id="sw_up" onchange="toggleSoundType('up',this)"><span class="sound-sw-track"></span></label>
    </div>
    <div class="sound-row">
      <div class="sound-row-icon" style="background:rgba(34,197,94,0.25)"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#4ade80" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="18 17 12 11 6 17"/><polyline points="18 11 12 5 6 11"/></svg></div>
      <div class="sound-row-label">Naik Tinggi<span class="sound-row-sub">&gt; Rp 3.000 perubahan</span></div>
      <label class="sound-sw"><input type="checkbox" id="sw_bigUp" onchange="toggleSoundType('bigUp',this)"><span class="sound-sw-track"></span></label>
    </div>
    <div class="sound-row">
      <div class="sound-row-icon" style="background:rgba(239,68,68,0.15)"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#f87171" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg></div>
      <div class="sound-row-label">Harga Turun<span class="sound-row-sub">Perubahan normal</span></div>
      <label class="sound-sw"><input type="checkbox" id="sw_down" onchange="toggleSoundType('down',this)"><span class="sound-sw-track"></span></label>
    </div>
    <div class="sound-row">
      <div class="sound-row-icon" style="background:rgba(239,68,68,0.25)"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#f87171" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 7 12 13 18 7"/><polyline points="6 13 12 19 18 13"/></svg></div>
      <div class="sound-row-label">Turun Tinggi<span class="sound-row-sub">&gt; Rp 3.000 perubahan</span></div>
      <label class="sound-sw"><input type="checkbox" id="sw_bigDown" onchange="toggleSoundType('bigDown',this)"><span class="sound-sw-track"></span></label>
    </div>
    <div class="sound-row">
      <div class="sound-row-icon" style="background:rgba(251,191,36,0.15)"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#fbbf24" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M6 2L3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4z"/><line x1="3" y1="6" x2="21" y2="6"/><path d="M16 10a4 4 0 0 1-8 0"/></svg></div>
      <div class="sound-row-label">Promo ON/OFF<span class="sound-row-sub">Status promo berubah</span></div>
      <label class="sound-sw"><input type="checkbox" id="sw_promo" onchange="toggleSoundType('promo',this)"><span class="sound-sw-track"></span></label>
    </div>
    <div class="sound-row">
      <div class="sound-row-icon" style="background:rgba(96,165,250,0.15)"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#60a5fa" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><polyline points="12 7 12 12 15 14"/></svg></div>
      <div class="sound-row-label">Bunyi Hitung Mundur<span class="sound-row-sub">Beep 5 detik terakhir</span></div>
      <label class="sound-sw"><input type="checkbox" id="sw_countdown" onchange="toggleSoundType('countdown',this)"><span class="sound-sw-track"></span></label>
    </div>
    <div class="sound-panel-footer">
      <button class="sound-panel-btn" onclick="setSoundAll(true,'sound')">Nyalakan Semua</button>
      <button class="sound-panel-btn" onclick="setSoundAll(false,'sound')">Matikan Semua</button>
    </div>
  </div>

  <!-- Sub-panel: Getar -->
  <div id="getarPanel" class="sound-panel" style="display:none" onclick="event.stopPropagation()">
    <div class="sound-panel-header">
      <span style="display:inline-flex;align-items:center;gap:6px;"><button class="sound-panel-back" title="Kembali" onclick="closeGetar();openSoundPanel()"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg></button>Getar</span>
      <button class="sound-panel-close" onclick="closeGetar()"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>
    </div>
    <div class="sound-row" id="vibrateRow">
      <div class="sound-row-icon" style="background:rgba(167,139,250,0.15)"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#a78bfa" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><rect x="7" y="2" width="10" height="20" rx="2"/><line x1="11" y1="18" x2="13" y2="18"/></svg></div>
      <div class="sound-row-label">Getar HP<span class="sound-row-sub" id="vibrateSub">Getar fisik (Android) 5 detik terakhir</span></div>
      <label class="sound-sw"><input type="checkbox" id="sw_vibrate" onchange="toggleSoundType('vibrate',this)"><span class="sound-sw-track"></span></label>
    </div>
    <div class="sound-row">
      <div class="sound-row-icon" style="background:rgba(52,211,153,0.15)"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#34d399" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg></div>
      <div class="sound-row-label">Goyang Layar<span class="sound-row-sub">Layar bergetar halus 5 detik terakhir</span></div>
      <label class="sound-sw"><input type="checkbox" id="sw_shake" onchange="toggleSoundType('shake',this)"><span class="sound-sw-track"></span></label>
    </div>
    <div class="sound-panel-footer">
      <button class="sound-panel-btn" onclick="setSoundAll(true,'getar')">Nyalakan Semua</button>
      <button class="sound-panel-btn" onclick="setSoundAll(false,'getar')">Matikan Semua</button>
    </div>
  </div>

  <div id="settingsPanel" class="sound-panel" style="display:none" onclick="event.stopPropagation()">
    <div class="sound-panel-header">
      Pengaturan
      <button class="sound-panel-close" onclick="closeSettingsPanel()"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>
    </div>
    <div class="sound-row" style="cursor:pointer" onclick="openDisplaySettings()">
      <div class="sound-row-icon" style="background:rgba(247,147,26,0.15)"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#f7931a" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg></div>
      <div class="sound-row-label">Tampilan<span class="sound-row-sub">Ukuran font &amp; baris tabel</span></div>
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#6b7280" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>
    </div>
    <div class="sound-row" style="cursor:pointer" onclick="openNominalFromSettings()">
      <div class="sound-row-icon" style="background:rgba(96,165,250,0.15)"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#60a5fa" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><line x1="21" y1="4" x2="14" y2="4"/><line x1="10" y1="4" x2="3" y2="4"/><line x1="21" y1="12" x2="12" y2="12"/><line x1="8" y1="12" x2="3" y2="12"/><line x1="21" y1="20" x2="16" y2="20"/><line x1="12" y1="20" x2="3" y2="20"/><line x1="14" y1="2" x2="14" y2="6"/><line x1="8" y1="10" x2="8" y2="14"/><line x1="16" y1="18" x2="16" y2="22"/></svg></div>
      <div class="sound-row-label">Pilih Nominal<span class="sound-row-sub">Atur nominal investasi</span></div>
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#6b7280" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>
    </div>
    <div class="sound-row" id="histColsRow" style="cursor:pointer" onclick="openHistCols()">
      <div class="sound-row-icon" style="background:rgba(74,222,128,0.15)"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#4ade80" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><line x1="3" y1="9" x2="21" y2="9"/><line x1="9" y1="3" x2="9" y2="21"/><line x1="15" y1="3" x2="15" y2="21"/></svg></div>
      <div class="sound-row-label">Kolom Riwayat<span class="sound-row-sub">Spread, USD/IDR &amp; Status di tabel</span></div>
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#6b7280" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>
    </div>
  </div>

  <!-- Sub-panel: kolom tabel riwayat (khusus mobile) -->
  <div id="histColsPanel" class="sound-panel" style="display:none" onclick="event.stopPropagation()">
    <div class="sound-panel-header">
      <span style="display:inline-flex;align-items:center;gap:6px;"><button class="sound-panel-back" title="Kembali" onclick="closeHistCols();openSettingsPanel()"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg></button>Kolom Riwayat</span>
      <button class="sound-panel-close" onclick="closeHistCols()"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>
    </div>
    <div class="sound-row">
      <div class="sound-row-icon" style="background:rgba(74,222,128,0.15)"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#4ade80" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="22 7 13.5 15.5 8.5 10.5 2 17"/><polyline points="16 7 22 7 22 13"/></svg></div>
      <div class="sound-row-label">Spread<span class="sound-row-sub">Selisih beli vs jual (%)</span></div>
      <label class="sound-sw"><input type="checkbox" id="sw_histSpread" onchange="toggleHistCol('spread',this)"><span class="sound-sw-track"></span></label>
    </div>
    <div class="sound-row">
      <div class="sound-row-icon" style="background:rgba(167,139,250,0.15)"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#a78bfa" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></svg></div>
      <div class="sound-row-label">USD/IDR<span class="sound-row-sub">Kurs dolar per baris</span></div>
      <label class="sound-sw"><input type="checkbox" id="sw_histUsdidr" onchange="toggleHistCol('usdidr',this)"><span class="sound-sw-track"></span></label>
    </div>
    <div class="sound-row">
      <div class="sound-row-icon" style="background:rgba(251,191,36,0.15)"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#fbbf24" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg></div>
      <div class="sound-row-label">Status<span class="sound-row-sub">MARKUP / MARKDOWN</span></div>
      <label class="sound-sw"><input type="checkbox" id="sw_histStatus" onchange="toggleHistCol('status',this)"><span class="sound-sw-track"></span></label>
    </div>
    <div style="padding:8px 14px 12px;color:#6b7280;font-size:0.68em;line-height:1.5;">Hanya berlaku di tampilan mobile. Di desktop semua kolom selalu tampil.</div>
  </div>
</body>
</html>`

  res.send(html)
})

// API endpoint untuk mendapatkan data monitoring (JSON) - REAL-TIME
app.get('/monitoring/api', async (req, res) => {
  // Verify session - REQUIRE valid session
  const session = req.query.session || ''

  if (!session) {
    return res.status(403).json({ error: 'Unauthorized - No session' })
  }

  let phone = null
  let sessCheckError = false
  try {
    phone = await redis.hget(REDIS_KEYS.SESSIONS, session)
  } catch (e) {
    sessCheckError = true // Redis bermasalah — jangan hukum user, tetap layani data
  }

  if (!phone && !sessCheckError) {
    return res.status(403).json({ error: 'Unauthorized - Invalid session' })
  }

  // Gunakan lastKnownPrice yang di-update oleh checkPriceUpdate setiap 1 detik
  // Ini lebih cepat daripada fetch Treasury setiap request
  let buy = lastKnownPrice?.buy || null
  let sell = lastKnownPrice?.sell || null
  let updatedAt = lastKnownPrice?.updated_at || null

  // Generate pesan real-time
  let currentMessage = ''
  if (buy && sell) {
    const priceData = {
      data: {
        buying_rate: buy,
        selling_rate: sell,
        updated_at: updatedAt
      }
    }
    currentMessage = formatMessage(priceData, cachedMarketData.usdIdr?.rate, cachedMarketData.xauUsd, null, cachedMarketData.economicEvents)
  }

  res.json({
    status: isReady ? 'ready' : 'offline',
    subscribers: subscriptions.size,
    broadcastCount,
    lastBroadcastTime: lastBroadcastTime > 0 ? new Date(lastBroadcastTime).toISOString() : null,
    timeSinceLastBroadcast: lastBroadcastTime > 0 ? Math.floor((Date.now() - lastBroadcastTime) / 1000) : null,
    usdIdr: cachedMarketData.usdIdr?.rate,
    xauUsd: cachedMarketData.xauUsd,
    buy,
    sell,
    updatedAt,
    message: currentMessage,
    logs: logs.slice(-10),
    version: APP_VERSION
  })
})

// ==================== CATCH-ALL ROUTE ====================
// Semua route yang tidak terdaftar akan redirect ke /login
app.get('*', (_req, res) => {
  res.redirect('/login')
})



// ====== AUTO-KICK EXPIRED USERS ======
async function checkAndKickExpiredUsers() {
  try {
    const allUsers = await redis.hgetall(REDIS_KEYS.USERS)
    if (!allUsers) return

    const now = Date.now()

    for (const [phone, userData] of Object.entries(allUsers)) {
      try {
        const user = typeof userData === 'string' ? JSON.parse(userData) : userData

        // Check if expired
        if (user.expired && user.expired < now) {
          pushLog(`Auto-kick | User +${phone} expired, processing...`)

          // Try to kick from group if connected
          if (sock && isReady && monitoredGroupId) {
            try {
              const jid = phone + '@s.whatsapp.net'
              await sock.groupParticipantsUpdate(monitoredGroupId, [jid], 'remove')
              pushLog(`Auto-kick | Kicked +${phone} from group`)

              // Send expiry notification
              try {
                await sock.sendMessage(jid, {
                  text: `⏰ *LANGGANAN EXPIRED*\n\nHalo ${user.name || 'User'},\n\nLangganan Anda telah berakhir pada ${new Date(user.expired).toLocaleDateString('id-ID')}.\n\nAnda telah dikeluarkan dari grup.\n\nUntuk perpanjang, hubungi admin:\nhttps://wa.me/6289654454210`
                })
              } catch (msgErr) {}
            } catch (kickErr) {
              pushLog(`Auto-kick | Failed to kick +${phone}: ${kickErr.message}`)
            }
          }

          // Delete from database
          await redis.hdel(REDIS_KEYS.USERS, phone)
          await redis.hdel(REDIS_KEYS.PUSH_SUBS, phone)

          // Remove sessions
          const sessions = await redis.hgetall(REDIS_KEYS.SESSIONS)
          for (const [sessId, sessPhone] of Object.entries(sessions || {})) {
            if (sessPhone === phone) {
              await redis.hdel(REDIS_KEYS.SESSIONS, sessId)
            }
          }

          pushLog(`Auto-kick | User +${phone} removed from database`)
        }
      } catch (e) {
      }
    }
  } catch (e) {
  }
}

// Run auto-kick check every 5 minutes
setInterval(checkAndKickExpiredUsers, 5 * 60 * 1000)

// Also run once on startup (after 30 seconds to let WA connect)
setTimeout(checkAndKickExpiredUsers, 30000)
// ====== END AUTO-KICK ======

// ── 404 handler: route tidak ditemukan ──
app.use((req, res) => {
  res.status(404).json({ error: 'Not Found', path: req.originalUrl })
})

// ── Global Express error handler — log jelas (method + URL + stack) ke Koyeb ──
// Harus 4 argumen (err, req, res, next) agar dikenali Express sebagai error handler.
app.use((err, req, res, _next) => {
  const where = `${req.method} ${req.originalUrl}`
  console.error(`[${new Date().toISOString()}] [ROUTE_ERROR] ${where}\n`, err)
  try { pushLog(`❌ Error ${where} — ${err && err.message ? err.message : String(err)}`) } catch (_) {}
  if (res.headersSent) return
  res.status(err.status || 500).json({ error: 'Internal Server Error' })
})

app.listen(PORT, async () => {
  console.log(`[${new Date().toISOString()}] [STARTUP] Server listening on port ${PORT}`)
  try { pushLog(`🚀 Server start — listening on port ${PORT}`) } catch (_) {}

  // Reset titik ON terendah agar selalu realtime (tidak permanen dari sesi sebelumnya)
  try {
    await redis.del(REDIS_KEYS.LOWEST_ON_PRICE)
    await redis.del(REDIS_KEYS.LOWEST_ON_DATE)
    lowestOnPriceCache = null
    lowestOnDateWIB = null
    pushLog('🏷️ Titik ON terendah direset (server start — realtime tracking aktif)')
  } catch (_) {}

  // 🎁 Start continuous promo check
  startContinuousPromoCheck()
})

// KEEP-ALIVE SYSTEM
const SELF_URL = process.env.RENDER_EXTERNAL_URL ||
                 process.env.RAILWAY_STATIC_URL ||
                 `http://localhost:${PORT}`

setInterval(async () => {
  try {
    const response = await fetch(`${SELF_URL}/health`, {
      signal: AbortSignal.timeout(5000)
    })
    
    if (response.ok) {
      const data = await response.json()
      const _buy = lastKnownPrice?.buy ? `Beli Rp${formatRupiah(lastKnownPrice.buy)}` : 'harga -'
      const _xau = cachedXAUUSD ? `XAU $${cachedXAUUSD.toFixed(0)}` : 'XAU -'
      const _wa = isReady ? 'WA ✓' : 'WA ✗'
      pushLog(`PING | uptime ${Math.floor(data.uptime/60)}m | ${_wa} | ${subscriptions.size} sub | ${_buy} | ${_xau}`)
    }
  } catch (e) {
    // Silent fail
  }
}, 60 * 1000)

setTimeout(async () => {
  try {
    await fetch(`${SELF_URL}/health`, { signal: AbortSignal.timeout(5000) })
  } catch (e) {
    // Silent fail
  }
}, 30000)

function scheduleReconnect(delay) {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer)
    reconnectTimer = null
    pushLog('WA | Timer reconnect sebelumnya dibatalkan')
  }
  isStarting = false // Buka gate agar start() berikutnya bisa jalan
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null
    start().catch(e => pushLog('WA | start() error: ' + e.message))
  }, delay)
}

// ------ GROUP ADMIN CHECK ------
async function isGroupAdmin(sock, groupJid, participantJid) {
  try {
    const metadata = await sock.groupMetadata(groupJid)
    const participant = metadata.participants.find(p => p.id === participantJid)
    return participant && (participant.admin === 'admin' || participant.admin === 'superadmin')
  } catch (e) {
    return false
  }
}

async function start() {
  if (isStarting) {
    pushLog('WA | start() sudah berjalan, skip')
    return
  }
  isStarting = true
  try {
  // Load data dari Redis saat startup
  await loadFromRedis()
  await loadMonitoredGroup()
  await loadBroadcastGroup()
  await loadPromoLimit()
  await loadNominalSettings()

  // Use file-based auth (tmp folder, tidak persist saat restart)
  const { state, saveCreds } = await useMultiFileAuthState('/tmp/wa_auth')
  const { version } = await fetchLatestBaileysVersion()

  pushLog('WA | Using file-based auth (/tmp/wa_auth)')

  sock = makeWASocket({
    version,
    logger: pino({ level: 'silent' }),
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'silent' }))
    },
    browser: Browsers.ubuntu('Chrome'),
    markOnlineOnConnect: false,
    syncFullHistory: false,
    defaultQueryTimeoutMs: 120000,
    keepAliveIntervalMs: 25000,
    connectTimeoutMs: 60000,
    qrTimeout: 60000,
    getMessage: async () => ({ conversation: '' })
  })

  if (pingInterval) clearInterval(pingInterval)
  pingInterval = setInterval(() => {
    if (sock?.ws?.readyState === 1) sock.ws.ping()
  }, 30000)

  sock.ev.on('connection.update', async (u) => {
    const { connection, lastDisconnect, qr } = u
    
    if (qr) {
      lastQr = qr
      pushLog('WA | QR diterima - silakan scan dengan WhatsApp')
    }

    if (connection === 'close') {
      const error = lastDisconnect?.error
      const reason = error?.output?.statusCode
      const errMsg = error?.message || error?.toString?.() || 'no message'
      pushLog(`WA | Disconnected (${reason}) - ${errMsg}`)

      const clearAuthAndRestart = async (msg) => {
        pushLog(`WA | ${msg} - menghapus auth dan minta QR baru...`)
        if (sock) { sock.ev.removeAllListeners(); sock = null }
        isReady = false
        lastQr = null
        const fs = await import('fs')
        if (fs.existsSync('./auth')) {
          fs.rmSync('./auth', { recursive: true, force: true })
          pushLog('WA | Auth folder deleted')
        }
        consecutive428 = 0
        reconnectAttempts = 0
        scheduleReconnect(3000)
      }

      if (reason === DisconnectReason.loggedOut) {
        await clearAuthAndRestart('LOGGED OUT')
        return
      }

      // 408 = timedOut/connectionLost - QR expired atau koneksi timeout, restart tanpa hitung counter
      if (reason === 408) {
        pushLog('WA | Timeout/QR expired - restart ulang...')
        consecutive428 = 0
        scheduleReconnect(3000)
        return
      }

      // 515 = restartRequired - Baileys minta restart
      if (reason === 515) {
        pushLog('WA | Restart required - restarting...')
        consecutive428 = 0
        scheduleReconnect(2000)
        return
      }

      // 428 = connectionClosed - sering terjadi saat sesi expired
      // Setelah 2 kali berturut-turut, paksa QR baru
      if (reason === 428) {
        consecutive428++
        pushLog(`WA | connectionClosed (428) count: ${consecutive428}`)
        if (consecutive428 >= 2) {
          await clearAuthAndRestart('Sesi expired (428 berulang)')
          return
        }
      } else {
        consecutive428 = 0
      }

      if (reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
        const delay = BASE_RECONNECT_DELAY * Math.pow(1.5, reconnectAttempts)
        reconnectAttempts++
        pushLog(`WA | Reconnect ${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS} in ${Math.round(delay/1000)}s`)
        scheduleReconnect(delay)
      } else {
        pushLog('WA | Max reconnect reached - reset manual diperlukan')
        isStarting = false // Buka gate agar wa-reset bisa trigger start() baru
      }

    } else if (connection === 'open') {
      lastQr = null
      reconnectAttempts = 0
      consecutive428 = 0
      isStarting = false // Koneksi berhasil, buka gate untuk reconnect berikutnya jika perlu
      pushLog('WA | Connected')
      pushLog('WA | Warming up 15s...')

      isReady = false
      setTimeout(async () => {
        try {
          const usdIdr = await fetchUSDIDRFromGoogle()
          cachedMarketData.usdIdr = usdIdr
          cachedMarketData.lastUsdIdrFetch = Date.now()
          pushLog(`DATA | USD/IDR: Rp ${usdIdr.rate.toLocaleString('id-ID')}`)
        } catch (e) {
          pushLog(`DATA | USD/IDR fallback`)
        }

        isReady = true
        pushLog('WA | Bot ready')
        checkPriceUpdate()

        fetchEconomicCalendar().then(events => {
          if (events && events.length > 0) {
            pushLog(`DATA | ${events.length} economic events loaded`)
          }
        })
      }, 15000)
    }
  })

  sock.ev.on('creds.update', saveCreds)

  // ==================== GROUP PARTICIPANT UPDATE ====================
  sock.ev.on('group-participants.update', async (update) => {
    try {
      const { id, participants, action } = update

      // Hanya proses jika ini grup yang di-monitor
      if (!monitoredGroupId || id !== monitoredGroupId) return

      for (const participant of participants) {
        const phone = extractPhoneFromJid(participant)
        if (!phone) continue

        if (action === 'add') {
          // Member baru masuk grup
          await autoRegisterGroupMember(phone)
        } else if (action === 'remove') {
          // Member keluar/dikeluarkan dari grup
          await removeGroupMember(phone)
        }
      }
    } catch (e) {
      pushLog('WA | Group update error: ' + e.message)
    }
  })

  // DISABLED: WhatsApp commands - website only mode
  /*
  sock.ev.on('messages.upsert', async (ev) => {
    if (!isReady || ev.type !== 'notify') return
    
    for (const msg of ev.messages) {
      try {
        if (shouldIgnoreMessage(msg)) continue

        const stanzaId = msg.key.id
        if (processedMsgIds.has(stanzaId)) continue
        processedMsgIds.add(stanzaId)

        const text = normalizeText(extractText(msg))
        if (!text) continue

        const sendTarget = msg.key.remoteJid
        
        if (/\bmulai\b|\bstart\b|\bsubscribe\b|\/langganan/.test(text)) {
          if (subscriptions.has(sendTarget)) {
            await sock.sendMessage(sendTarget, {
              text: '✅ Sudah aktif!\n\n📢 Update otomatis saat harga berubah\n⏰ Broadcast setiap ganti menit atau per 50 detik\n📅 Termasuk kalender ekonomi USD (auto-hide 3 jam)\n⚡ Ultra real-time (1 detik check interval)'
            }, { quoted: msg })
          } else {
            subscriptions.add(sendTarget)
            pushLog(`SUB   | ➕ ${sendTarget.substring(0, 15)}... (total: ${subscriptions.size})`)

            await sock.sendMessage(sendTarget, {
              text: '🎉 Berhasil Dimulai!\n\n📢 Notifikasi otomatis saat harga berubah\n⏰ Broadcast setiap ganti menit atau per 50 detik\n📅 Termasuk kalender ekonomi USD high-impact (auto-hide 3 jam)\n⚡ Ultra real-time (1 detik check interval)\n\n_Ketik "berhenti" untuk stop._'
            }, { quoted: msg })
          }
          continue
        }

        if (/\bberhenti\b|\bunsubscribe\b|\bstop\b|^\/berhenti$/.test(text)) {
          if (subscriptions.has(sendTarget)) {
            subscriptions.delete(sendTarget)
            pushLog(`SUB   | ➖ ${sendTarget.substring(0, 15)}... (total: ${subscriptions.size})`)
            await sock.sendMessage(sendTarget, { text: '👋 Notifikasi dihentikan.' }, { quoted: msg })
          } else {
            await sock.sendMessage(sendTarget, { text: '❌ Belum aktif.' }, { quoted: msg })
          }
          continue
        }
        
        if (!/\bemas\b/.test(text)) continue

        const now = Date.now()
        const lastReply = lastReplyAtPerChat.get(sendTarget) || 0
        
        if (now - lastReply < COOLDOWN_PER_CHAT) continue
        if (now - lastGlobalReplyAt < GLOBAL_THROTTLE) continue

        try {
          await sock.sendPresenceUpdate('composing', sendTarget)
        } catch (_) {}
        
        await new Promise(r => setTimeout(r, TYPING_DURATION))

        let replyText
        try {
          const [treasury, usdIdr, xauUsd, economicEvents] = await Promise.all([
            fetchTreasury(),
            fetchUSDIDRFromGoogle(), // Only use Google Finance
            fetchXAUUSDCached(),
            fetchEconomicCalendar()
          ])
          replyText = formatMessage(treasury, usdIdr.rate, xauUsd, null, economicEvents)
        } catch (e) {
          replyText = '❌ Gagal mengambil data harga.'
        }

        await new Promise(r => setTimeout(r, 500))
        
        try {
          await sock.sendPresenceUpdate('paused', sendTarget)
        } catch (_) {}
        
        await sock.sendMessage(sendTarget, { text: replyText }, { quoted: msg })

        lastReplyAtPerChat.set(sendTarget, now)
        lastGlobalReplyAt = now
        
        await new Promise(r => setTimeout(r, 1000))
        
      } catch (e) {
        // Silent fail
      }
    }
  })
  */

  // ==================== ADMIN WHATSAPP COMMANDS ====================
  // Store LID to Phone mapping for admin verification
  const lidToPhoneMap = new Map()

  // Commands hanya bisa digunakan oleh nomor admin yang terdaftar
  sock.ev.on('messages.upsert', async (ev) => {
    if (!isReady || ev.type !== 'notify') return

    for (const msg of ev.messages) {
      try {
        if (!msg.message) continue

        // Skip messages from self
        if (msg.key.fromMe) continue

        // Get sender JID
        const senderJid = msg.key.remoteJid
        if (!senderJid) continue

        const isGroup = senderJid.endsWith('@g.us')
        const isLid = senderJid.endsWith('@lid')

        // Get actual sender
        let senderPhone = ''
        let senderLid = ''

        if (isGroup) {
          const participant = msg.key.participant || ''
          if (participant.endsWith('@lid')) {
            senderLid = participant.replace('@lid', '')
          } else {
            senderPhone = participant.replace('@s.whatsapp.net', '')
          }
        } else if (isLid) {
          senderLid = senderJid.replace('@lid', '')
        } else {
          senderPhone = senderJid.replace('@s.whatsapp.net', '')
        }

        // Try to get phone from stored mapping if we have LID
        if (senderLid && !senderPhone) {
          senderPhone = lidToPhoneMap.get(senderLid) || ''
        }

        // Store LID mapping if we have both
        if (senderLid && senderPhone) {
          lidToPhoneMap.set(senderLid, senderPhone)
        }

        // Extract message text
        const text = msg.message.conversation ||
                     msg.message.extendedTextMessage?.text ||
                     msg.message.imageMessage?.caption || ''

        if (!text) continue

        // Only process commands starting with / — atau teks berupa nomor HP saja
        // (tambah user cepat via DM: kirim nomornya langsung, format bebas: +62 / 0 / spasi / strip)
        const isPhoneOnly = !isGroup && /^\+?[\d\s\-().]{8,20}$/.test(text.trim()) && (text.replace(/\D/g, '').length >= 9)
        if (!text.startsWith('/') && !isPhoneOnly) continue

        const lowerText = text.toLowerCase().trim()

        // Debug log
        const senderInfo = senderPhone || `LID:${senderLid}`
        pushLog(`WA CMD | Received: "${text}" from ${senderInfo}`)
        pushLog(`WA CMD | Admin phones: ${ADMIN_PHONES.join(', ')}`)

        // Check if sender is admin (by phone or by first admin LID mapping)
        let isAdmin = false
        if (senderPhone) {
          isAdmin = ADMIN_PHONES.includes(senderPhone)
        }

        // If using LID and not verified yet, check if this is the first admin trying to register
        // Allow first registered admin phone's LID to be auto-mapped
        if (!isAdmin && senderLid && ADMIN_PHONES.length > 0) {
          // Check if any admin phone has this LID mapped
          for (const [lid, phone] of lidToPhoneMap.entries()) {
            if (ADMIN_PHONES.includes(phone) && lid === senderLid) {
              isAdmin = true
              senderPhone = phone
              break
            }
          }
        }

        // Special command to register LID for admin
        if (lowerText.startsWith('/registeradmin ') && senderLid) {
          const inputPhone = text.substring(15).trim().replace(/\D/g, '')
          let normalizedPhone = inputPhone
          if (normalizedPhone.startsWith('0')) normalizedPhone = '62' + normalizedPhone.substring(1)
          if (!normalizedPhone.startsWith('62')) normalizedPhone = '62' + normalizedPhone

          if (ADMIN_PHONES.includes(normalizedPhone)) {
            lidToPhoneMap.set(senderLid, normalizedPhone)
            await sock.sendMessage(senderJid, {
              text: `✅ *LID Terdaftar*\n\nLID: ${senderLid}\nPhone: +${normalizedPhone}\n\nSekarang Anda bisa menggunakan command admin.`
            }, { quoted: msg })
            pushLog(`WA CMD | Admin LID registered: ${senderLid} -> ${normalizedPhone}`)
            continue
          } else {
            await sock.sendMessage(senderJid, {
              text: `❌ Nomor ${normalizedPhone} bukan admin. Pastikan nomor sudah terdaftar di Admin Phones.`
            }, { quoted: msg })
            continue
          }
        }

        if (!isAdmin) {
          // Send help message for unregistered admin with LID
          if (senderLid && lowerText === '/help') {
            await sock.sendMessage(senderJid, {
              text: `⚠️ *LID Belum Terdaftar*\n\nWhatsApp Anda menggunakan format LID baru.\nUntuk mendaftarkan LID, ketik:\n\n/registeradmin 08xxxxxxxxxx\n\n(Gunakan nomor yang terdaftar di Admin Phones)`
            }, { quoted: msg })
          }
          pushLog(`WA CMD | ${senderInfo} is NOT admin, ignoring`)
          continue
        }

        pushLog(`WA CMD | Processing command from admin ${senderPhone}`)

        // ===== COMMAND: /help =====
        if (lowerText === '/help' || lowerText === '/menu') {
          const helpText = `🤖 *ADMIN COMMANDS*

📋 *Manajemen User:*
• Kirim nomor HP saja - Tambah user cepat (lifetime)
• /add 08xxx - Tambah user baru
• /add 08xxx 30 - Tambah user + expired 30 hari
• /del 08xxx - Hapus user dari database
• /kick 08xxx - Kick dari grup + hapus database
• /list - Lihat semua user

📊 *Statistik:*
• /stats - Statistik sistem
• /online - User yang sedang online

❓ *Bantuan:*
• /help - Tampilkan menu ini

_Ganti 08xxx dengan nomor WA target_`

          await sock.sendMessage(senderJid, { text: helpText }, { quoted: msg })
          continue
        }

        // ===== COMMAND: /add <phone> [days] =====
        if (lowerText.startsWith('/add ')) {
          const parts = text.substring(5).trim().split(/\s+/)
          let phone = parts[0]
          const days = parts[1] ? parseInt(parts[1]) : null

          if (!phone) {
            await sock.sendMessage(senderJid, { text: '❌ Format: /add 08xxx [hari]' }, { quoted: msg })
            continue
          }

          // Normalize phone
          phone = phone.replace(/\D/g, '')
          if (phone.startsWith('0')) phone = '62' + phone.substring(1)
          if (!phone.startsWith('62')) phone = '62' + phone

          // Check if exists
          const existing = await redis.hget(REDIS_KEYS.USERS, phone)
          if (existing) {
            await sock.sendMessage(senderJid, { text: `⚠️ User +${phone} sudah terdaftar` }, { quoted: msg })
            continue
          }

          // Calculate expired
          const now = Date.now()
          let expired = null
          if (days && days > 0) {
            expired = now + (days * 24 * 60 * 60 * 1000)
          }

          // Add user
          const userData = {
            name: 'Member ' + phone.substring(2),
            createdAt: now,
            expired: expired,
            source: 'wa_command'
          }

          await redis.hset(REDIS_KEYS.USERS, { [phone]: JSON.stringify(userData) })

          const expiredText = expired
            ? new Date(expired).toLocaleDateString('id-ID', { day: 'numeric', month: 'long', year: 'numeric' })
            : 'Lifetime'

          await sock.sendMessage(senderJid, {
            text: `✅ *User Ditambahkan*\n\n📱 Nomor: +${phone}\n⏰ Expired: ${expiredText}\n📅 Dibuat: ${new Date().toLocaleDateString('id-ID')}`
          }, { quoted: msg })

          pushLog(`WA CMD | Admin ${senderPhone} added user +${phone}`)
          continue
        }

        // ===== COMMAND: /del <phone> =====
        if (lowerText.startsWith('/del ')) {
          let phone = text.substring(5).trim()

          if (!phone) {
            await sock.sendMessage(senderJid, { text: '❌ Format: /del 08xxx' }, { quoted: msg })
            continue
          }

          // Normalize phone
          phone = phone.replace(/\D/g, '')
          if (phone.startsWith('0')) phone = '62' + phone.substring(1)
          if (!phone.startsWith('62')) phone = '62' + phone

          // Check if exists
          const existing = await redis.hget(REDIS_KEYS.USERS, phone)
          if (!existing) {
            await sock.sendMessage(senderJid, { text: `❌ User +${phone} tidak ditemukan` }, { quoted: msg })
            continue
          }

          // Delete user
          await Promise.all([
            redis.hdel(REDIS_KEYS.USERS, phone),
            redis.hdel(REDIS_KEYS.PUSH_SUBS, phone)
          ])

          // Remove sessions
          const sessions = await redis.hgetall(REDIS_KEYS.SESSIONS)
          for (const [sessId, sessPhone] of Object.entries(sessions || {})) {
            if (sessPhone === phone) {
              await redis.hdel(REDIS_KEYS.SESSIONS, sessId)
            }
          }

          await sock.sendMessage(senderJid, {
            text: `✅ *User Dihapus*\n\n📱 Nomor: +${phone}\n🗑️ Dihapus dari database`
          }, { quoted: msg })

          pushLog(`WA CMD | Admin ${senderPhone} deleted user +${phone}`)
          continue
        }

        // ===== COMMAND: /kick <phone> =====
        if (lowerText.startsWith('/kick ')) {
          let phone = text.substring(6).trim()

          if (!phone) {
            await sock.sendMessage(senderJid, { text: '❌ Format: /kick 08xxx' }, { quoted: msg })
            continue
          }

          // Normalize phone
          phone = phone.replace(/\D/g, '')
          if (phone.startsWith('0')) phone = '62' + phone.substring(1)
          if (!phone.startsWith('62')) phone = '62' + phone

          const jid = phone + '@s.whatsapp.net'
          let kickedFromGroup = false
          let deletedFromDb = false

          // Try to kick from group
          if (monitoredGroupId) {
            try {
              await sock.groupParticipantsUpdate(monitoredGroupId, [jid], 'remove')
              kickedFromGroup = true

              // Send notification to kicked user
              try {
                await sock.sendMessage(jid, {
                  text: '❌ *ANDA TELAH DI-KICK*\\n\\nAnda telah dikeluarkan dari grup Gold Price Monitor.\\n\\nJika ada pertanyaan, hubungi admin:\\nhttps://wa.me/6289654454210'
                })
              } catch (_) {}
            } catch (e) {
              pushLog(`WA CMD | Failed to kick ${phone} from group: ${e.message}`)
            }
          }

          // Delete from database
          const existing = await redis.hget(REDIS_KEYS.USERS, phone)
          if (existing) {
            await Promise.all([
              redis.hdel(REDIS_KEYS.USERS, phone),
              redis.hdel(REDIS_KEYS.PUSH_SUBS, phone)
            ])

            const sessions = await redis.hgetall(REDIS_KEYS.SESSIONS)
            for (const [sessId, sessPhone] of Object.entries(sessions || {})) {
              if (sessPhone === phone) {
                await redis.hdel(REDIS_KEYS.SESSIONS, sessId)
              }
            }
            deletedFromDb = true
          }

          let resultText = `📱 Nomor: +${phone}\\n`
          resultText += kickedFromGroup ? '✅ Kicked dari grup\\n' : '⚠️ Gagal kick dari grup\\n'
          resultText += deletedFromDb ? '✅ Dihapus dari database' : '⚠️ Tidak ada di database'

          await sock.sendMessage(senderJid, {
            text: `🔨 *KICK USER*\\n\\n${resultText}`
          }, { quoted: msg })

          pushLog(`WA CMD | Admin ${senderPhone} kicked user +${phone} (group: ${kickedFromGroup}, db: ${deletedFromDb})`)
          continue
        }

        // ===== COMMAND: /list =====
        if (lowerText === '/list') {
          const users = await redis.hgetall(REDIS_KEYS.USERS)
          const userList = Object.entries(users || {})

          if (userList.length === 0) {
            await sock.sendMessage(senderJid, { text: '📋 Tidak ada user terdaftar' }, { quoted: msg })
            continue
          }

          let listText = `📋 *DAFTAR USER* (${userList.length})\\n\\n`

          const now = Date.now()
          let activeCount = 0
          let expiredCount = 0

          // Sort by created date
          const sortedUsers = userList
            .map(([phone, data]) => ({ phone, ...JSON.parse(data) }))
            .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
            .slice(0, 20) // Limit to 20 users

          for (const user of sortedUsers) {
            const isExpired = user.expired && user.expired < now
            if (isExpired) expiredCount++
            else activeCount++

            const status = isExpired ? '🔴' : '🟢'
            const expText = user.expired
              ? new Date(user.expired).toLocaleDateString('id-ID', { day: '2-digit', month: '2-digit', year: '2-digit' })
              : '∞'

            listText += `${status} +${user.phone} (${expText})\\n`
          }

          if (userList.length > 20) {
            listText += `\\n_... dan ${userList.length - 20} user lainnya_`
          }

          listText += `\\n\\n🟢 Aktif: ${activeCount} | 🔴 Expired: ${expiredCount}`

          await sock.sendMessage(senderJid, { text: listText }, { quoted: msg })
          continue
        }

        // ===== COMMAND: /stats =====
        if (lowerText === '/stats') {
          const users = await redis.hgetall(REDIS_KEYS.USERS)
          const userCount = Object.keys(users || {}).length

          const now = Date.now()
          let activeCount = 0
          let expiredCount = 0

          for (const [_, data] of Object.entries(users || {})) {
            const user = JSON.parse(data)
            if (user.expired && user.expired < now) expiredCount++
            else activeCount++
          }

          const statsText = `📊 *STATISTIK SISTEM*

👥 *User:*
• Total: ${userCount}
• Aktif: ${activeCount}
• Expired: ${expiredCount}

🌐 *Online:*
• SSE Clients: ${sseClients.size}

📱 *WhatsApp:*
• Status: ${isReady ? '✅ Connected' : '❌ Disconnected'}
• Grup Monitor: ${monitoredGroupId ? '✅ Set' : '❌ Belum set'}

⏰ *Server Time:*
${new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' })} WIB`

          await sock.sendMessage(senderJid, { text: statsText }, { quoted: msg })
          continue
        }

        // ===== COMMAND: /online =====
        if (lowerText === '/online') {
          if (sseClients.size === 0) {
            await sock.sendMessage(senderJid, { text: '📱 Tidak ada user online saat ini' }, { quoted: msg })
            continue
          }

          let onlineText = `📱 *USER ONLINE* (${sseClients.size})\\n\\n`

          let count = 0
          sseClients.forEach((userInfo, _) => {
            if (count < 20) {
              const phone = userInfo.phone || 'Unknown'
              const name = userInfo.name || 'Unknown'
              onlineText += `• ${name} (+${phone})\\n`
              count++
            }
          })

          if (sseClients.size > 20) {
            onlineText += `\\n_... dan ${sseClients.size - 20} lainnya_`
          }

          await sock.sendMessage(senderJid, { text: onlineText }, { quoted: msg })
          continue
        }

        // ===== TAMBAH USER CEPAT: kirim nomor HP saja via DM =====
        if (isPhoneOnly) {
          let phone = text.replace(/\D/g, '')
          if (phone.startsWith('0')) phone = '62' + phone.substring(1)
          if (!phone.startsWith('62')) phone = '62' + phone

          if (phone.length < 10 || phone.length > 15) {
            await sock.sendMessage(senderJid, { text: `❌ Nomor tidak valid: ${text.trim()}\n\nContoh format: 0812xxxx / +62 812-xxxx / 62812xxxx` }, { quoted: msg })
            continue
          }

          // Check if exists
          const existing = await redis.hget(REDIS_KEYS.USERS, phone)
          if (existing) {
            await sock.sendMessage(senderJid, { text: `⚠️ User +${phone} sudah terdaftar` }, { quoted: msg })
            continue
          }

          const userData = {
            name: 'Member ' + phone.substring(2),
            createdAt: Date.now(),
            expired: null,
            source: 'wa_quick_add'
          }
          await redis.hset(REDIS_KEYS.USERS, { [phone]: JSON.stringify(userData) })

          await sock.sendMessage(senderJid, {
            text: `✅ *User Disimpan*\n\n📱 Nomor: +${phone}\n⏰ Expired: Lifetime\n📅 Dibuat: ${new Date().toLocaleDateString('id-ID')}\n\n_Untuk atur masa aktif: /add ${phone} 30_`
          }, { quoted: msg })

          pushLog(`WA CMD | Admin ${senderPhone} quick-added user +${phone}`)
          continue
        }

      } catch (e) {
        pushLog(`WA CMD | Error: ${e.message}`)
      }
    }
  })

  // ==================== USER COMMANDS (cekoon, emas) ====================
  // cekoon  : subscribe broadcast promo ON/OFF + harga (admin grup atau owner DM)
  // emas    : cek harga real-time (semua anggota grup bisa, DM hanya owner)
  sock.ev.on('messages.upsert', async (ev) => {
    if (!isReady || ev.type !== 'notify') return

    for (const msg of ev.messages) {
      try {
        if (shouldIgnoreMessage(msg)) continue

        const stanzaId = msg.key.id
        if (processedMsgIds.has(stanzaId)) continue
        processedMsgIds.add(stanzaId)

        const text = normalizeText(extractText(msg))
        if (!text) continue

        const sendTarget = msg.key.remoteJid
        const isGroup = sendTarget.endsWith('@g.us')
        const senderJid = msg.key.participant || msg.key.remoteJid

        // Daftar command yang dikenali
        const isUserCommand = /\b(cekoon|cekoonnonaktif|emas)\b/.test(text)
        if (!isUserCommand) continue

        const OWNER_JIDS = ADMIN_PHONES.map(p => `${p}@s.whatsapp.net`)
        const normalizedSender = senderJid.replace(/:[0-9]+@/, '@')
        const isOwner = OWNER_JIDS.includes(normalizedSender) || ADMIN_PHONES.some(p => normalizedSender.includes(p))
        const isEmasCommand = /\bemas\b/.test(text)

        if (isGroup) {
          // emas: semua anggota grup boleh pakai
          // cekoon/cekoonnonaktif: hanya admin grup
          if (!isEmasCommand) {
            const senderIsAdmin = await isGroupAdmin(sock, sendTarget, senderJid)
            if (!senderIsAdmin) continue
          }
        } else {
          // Di DM: emas boleh siapa saja, cekoon/cekoonnonaktif hanya owner
          if (!isEmasCommand && !isOwner) continue
        }

        // Command: cekoon (subscribe broadcast promo ON/OFF - logic tscek-main)
        if (/\bcekoon\b/.test(text)) {
          if (promoSubscriptions.has(sendTarget)) {
            await sock.sendMessage(sendTarget, {
              text: '🎉 Broadcast Promo Aktif!'
            }, { quoted: msg })
          } else {
            promoSubscriptions.add(sendTarget)
            pushLog(`SUB | ➕ cekoon: ${sendTarget.substring(0, 20)} (total: ${promoSubscriptions.size})`)
            await sock.sendMessage(sendTarget, {
              text: '🎉 Mulai'
            }, { quoted: msg })
          }
          continue
        }

        // Command: cekoonnonaktif (unsubscribe promo broadcast)
        if (/\bcekoonnonaktif\b/.test(text)) {
          if (promoSubscriptions.has(sendTarget)) {
            promoSubscriptions.delete(sendTarget)
            pushLog(`SUB | ➖ cekoonnonaktif: ${sendTarget.substring(0, 20)} (total: ${promoSubscriptions.size})`)
            await sock.sendMessage(sendTarget, { text: '🎉 Broadcast Promo OFF!' }, { quoted: msg })
          } else {
            await sock.sendMessage(sendTarget, { text: '🎉 Broadcast Promo OFF!' }, { quoted: msg })
          }
          continue
        }

        // Command: emas (cek harga) — gunakan cache jika segar, atau antri ke update berikutnya
        if (/\bemas\b/.test(text)) {
          const now = Date.now()
          const cacheAge = now - lastSuccessfulFetch

          if (lastKnownPrice && cacheAge < 45000) {
            // Cache segar — balas langsung
            const buy = lastKnownPrice.buy
            const sell = lastKnownPrice.sell
            const spreadPercent = buy > 0 ? (Math.abs(buy - sell) / buy * 100).toFixed(2) : '0.00'
            const date = lastKnownPrice.updated_at ? new Date(lastKnownPrice.updated_at) : new Date()
            const days = ['Minggu','Senin','Selasa','Rabu','Kamis','Jumat','Sabtu']
            const months = ['Jan','Feb','Mar','Apr','Mei','Jun','Jul','Agu','Sep','Okt','Nov','Des']
            const hh = String(date.getHours()).padStart(2,'0')
            const mm = String(date.getMinutes()).padStart(2,'0')
            const ss = String(date.getSeconds()).padStart(2,'0')
            const timeStr = `${days[date.getDay()]}, ${date.getDate()} ${months[date.getMonth()]} ${date.getFullYear()} ${hh}:${mm}:${ss} WIB`
            let statusLine = ''
            const _xauUsd = cachedMarketData.xauUsd
            const _usdIdr = cachedMarketData.usdIdr?.rate
            if (_xauUsd && _usdIdr) {
              const ps = analyzePriceStatus(buy, sell, _xauUsd, _usdIdr)
              if (ps.status === 'NORMAL') {
                statusLine = `Status : *NORMAL*`
              } else {
                const diff = Math.round(ps.difference)
                statusLine = `Status : *${diff > 0 ? 'MARKUP' : 'MARKDOWN'}* ${diff > 0 ? '+' : ''}Rp${formatRupiah(Math.abs(diff))}`
              }
            }
            const replyText = [`*HARGA EMAS TREASURY*`, timeStr, ``, `Beli   : Rp${formatRupiah(buy)}/gr`, `Jual   : Rp${formatRupiah(sell)}/gr`, `Spread : ${spreadPercent}%`, statusLine].filter(Boolean).join('\n')
            await sock.sendMessage(sendTarget, { text: replyText }, { quoted: msg })
            pushLog(`CMD | emas (cache ${Math.round(cacheAge/1000)}s) dari ${sendTarget.substring(0, 20)}`)
          } else {
            // Cache lama atau belum ada — antri ke update Treasury berikutnya
            pendingEmasReplies.set(sendTarget, { pendingMsg: msg, requestTime: now })
            await sock.sendMessage(sendTarget, { text: '⏳ Menunggu harga terbaru Treasury...' }, { quoted: msg })
            pushLog(`CMD | emas antri (cache ${Math.round(cacheAge/1000)}s) dari ${sendTarget.substring(0, 20)}`)
          }
          continue
        }

      } catch (e) {
        pushLog('WA | User cmd error: ' + e.message)
      }
    }
  })

  } catch (e) {
    pushLog('WA | start() fatal error: ' + e.message)
    isStarting = false // Error saat init, buka gate agar bisa retry
  }
}

start().catch(e => {
  process.exit(1)
})
