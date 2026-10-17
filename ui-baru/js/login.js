// Halaman login (tampilan baru): nomor -> PIN -> (wajib ganti PIN awal) -> monitoring.
// Nomor belum terdaftar / masa aktif habis -> pembayaran QRIS di halaman ini juga.
import { $, session, getJSON, applyTheme } from './api.js'
import { mountPayment } from './payment.js'

applyTheme()
let phone = ''
let stopPay = null

// ---------------------------------------------------------------- pesan
function msg(text, type = 'info', id = '#msg') {
  const el = $(id)
  if (!text) { el.classList.add('hidden'); return }
  el.textContent = text
  el.className = 'mb-4 rounded-xl px-4 py-3 text-sm font-semibold ' + ({ error: 'bg-down/10 text-down', success: 'bg-up/10 text-up' }[type] || 'bg-sky/10 text-sky')
}
function busy(btn, on, text) {
  if (on) { if (!btn.disabled) btn.dataset.text = btn.textContent; btn.textContent = text; btn.disabled = true }
  else { btn.textContent = btn.dataset.text || btn.textContent; btn.disabled = false }
}
function show(step) {
  $('#phoneForm').classList.toggle('hidden', step !== 'phone')
  $('#pinForm').classList.toggle('hidden', step !== 'pin')
  $('#payWrap').classList.toggle('hidden', step !== 'pay')
  $('#step2').className = 'h-1.5 flex-1 rounded-full ' + (step === 'phone' ? 'bg-line/15' : 'bg-gold')
  if (step !== 'pay' && stopPay) { stopPay(); stopPay = null }
}

// ---------------------------------------------------------------- sesi lama
async function checkExisting() {
  try {
    const k = localStorage.getItem('gold_kicked_notice')
    if (k) { localStorage.removeItem('gold_kicked_notice'); if (Date.now() - +k < 86400000) $('#kicked').classList.remove('hidden') }
  } catch (e) {}
  const s = session.get()
  if (!s) return true
  try {
    const v = await getJSON('/api/verify-session')
    if (v.valid) {
      const p = await getJSON('/api/check-pin-status')
      if (p.requirePinChange) { openChangePin(); return true }
      location.replace('/monitoring')
      return false
    }
    // sesi dihapus hanya kalau server benar-benar menjawab tidak valid (bukan saat tidak ada sinyal)
    if (v && v.valid === false && v.reason !== 'server_error') session.clear()
  } catch (e) {}
  return true
}

// ---------------------------------------------------------------- Cloudflare Turnstile
const siteKey = (document.querySelector('meta[name="turnstile-sitekey"]') || {}).content || ''
let tsWidget = null
let waitingTs = false
function loadTurnstile() {
  if (!siteKey || siteKey.startsWith('{{')) return
  window.onTsLoad = () => {
    tsWidget = window.turnstile.render('#turnstile', {
      sitekey: siteKey,
      theme: document.documentElement.dataset.theme === 'light' ? 'light' : 'dark',
      'refresh-expired': 'auto',
      retry: 'auto',
      callback: () => { if (waitingTs) checkUser() },
      'error-callback': () => { try { window.turnstile.reset(tsWidget) } catch (e) {} return true }
    })
  }
  const s = document.createElement('script')
  s.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit&onload=onTsLoad'
  s.async = true
  document.head.append(s)
}
const tsToken = () => { try { return tsWidget !== null ? window.turnstile.getResponse(tsWidget) || '' : '' } catch (e) { return '' } }
const tsReset = () => { try { if (tsWidget !== null) window.turnstile.reset(tsWidget) } catch (e) {} }

// ---------------------------------------------------------------- 1. nomor
function normalize(raw) {
  let p = String(raw || '').replace(/\D/g, '')
  if (p.startsWith('62')) p = p.slice(2)
  if (p.startsWith('0')) p = p.slice(1)
  return p
}
let giveUp = null
async function checkUser() {
  const p = normalize($('#phone').value)
  if (p.length < 9) { msg('Masukkan nomor HP yang valid.', 'error'); return }
  phone = p
  const btn = $('#btnPhone')
  busy(btn, true, 'Memeriksa...')
  const token = tsToken()
  if (siteKey && !siteKey.startsWith('{{') && !token) {
    // tunggu verifikasi Cloudflare selesai; lanjut otomatis lewat callback
    waitingTs = true
    msg('Memverifikasi keamanan, mohon tunggu...')
    clearTimeout(giveUp)
    giveUp = setTimeout(() => { if (waitingTs) { waitingTs = false; busy(btn, false); msg('Verifikasi keamanan tidak merespons. Tekan "Masuk / Daftar" lagi.', 'error'); tsReset() } }, 90000)
    return
  }
  waitingTs = false
  clearTimeout(giveUp)
  msg('')
  try {
    const res = await fetch('/api/check-user', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ phone: p, 'cf-turnstile-response': token }) })
    const d = await res.json()
    if (d.success) {
      $('#userName').textContent = (d.user && d.user.name) || 'Member'
      $('#userPhone').textContent = '+62' + p
      show('pin')
      setTimeout(() => $('#pin').focus(), 50)
    } else if (d.expired || d.needRegister) {
      await startPayment(p, !!d.expired)
    } else msg(d.error || 'Gagal memeriksa nomor.', 'error')
  } catch (e) { msg('Terjadi kesalahan. Coba lagi.', 'error') }
  tsReset()
  busy(btn, false)
}

// ---------------------------------------------------------------- pembayaran (daftar / perpanjang)
async function startPayment(p, expired) {
  let cfg = null
  for (let i = 0; i < 3 && !cfg; i++) {
    try { cfg = await (await fetch('/api/payment/config', { cache: 'no-store' })).json() } catch (e) { await new Promise(r => setTimeout(r, 1500)) }
  }
  if (!cfg) { msg('Gagal memuat. Coba lagi sebentar lagi.', 'error'); return }
  if (!cfg.enabled) {
    if (cfg.waFallback === false) { msg(expired ? 'Masa aktif habis. Hubungi admin untuk perpanjang.' : 'Nomor tidak terdaftar.', 'error'); return }
    location.href = '/go/wa-admin?text=' + encodeURIComponent(expired
      ? 'Halo admin, saya mau perpanjang masa aktif. Nomor WA saya: +62' + p
      : 'Halo, saya ingin daftar grup harga PemulaOLD. Nomor WA saya: +62' + p)
    return
  }
  msg('')
  $('#payTitle').textContent = expired ? 'Masa aktif habis' : 'Nomor belum terdaftar'
  $('#payDesc').textContent = expired
    ? 'Perpanjang lewat QRIS: ' + 'Rp' + cfg.price.toLocaleString('id-ID') + ' untuk ' + cfg.days + ' hari. Setelah diterima, masuk dengan PIN lama Anda.'
    : 'Daftar lewat QRIS: Rp' + cfg.price.toLocaleString('id-ID') + ' untuk ' + cfg.days + ' hari. Setelah diterima, masuk dengan PIN awal 000000.'
  show('pay')
  stopPay = mountPayment($('#payBox'), {
    phone: '62' + p,
    renew: expired,
    months: 1,
    onPaid: () => setTimeout(() => { msg('Pembayaran diterima. Silakan masuk.', 'success'); show('phone'); $('#phone').value = p }, 2500)
  })
}

// ---------------------------------------------------------------- 2. PIN
async function submitPin() {
  const pin = $('#pin').value.replace(/\D/g, '')
  if (pin.length !== 6) { msg('Masukkan PIN 6 digit.', 'error'); return }
  const btn = $('#btnLogin')
  busy(btn, true, 'Masuk...')
  msg('')
  try {
    const res = await fetch('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ phone, pin, oldSession: session.get() || undefined }) })
    const d = await res.json()
    if (d.success) {
      session.set(d.sessionId)
      try { localStorage.setItem('gold_sess_ok_at', String(Date.now())) } catch (e) {}
      if (d.requirePinChange) openChangePin()
      else { msg('Berhasil masuk. Mengalihkan...', 'success'); location.replace('/monitoring') }
    } else { msg(d.error || 'Login gagal.', 'error'); $('#pin').value = ''; $('#pin').focus() }
  } catch (e) { msg('Terjadi kesalahan. Coba lagi.', 'error') }
  busy(btn, false)
}

// ---------------------------------------------------------------- ganti PIN awal
function openChangePin() {
  $('#changePin').classList.remove('hidden'); $('#changePin').classList.add('flex')
  setTimeout(() => $('#newPin').focus(), 50)
}
async function saveNewPin() {
  const a = $('#newPin').value.replace(/\D/g, '')
  const b = $('#newPin2').value.replace(/\D/g, '')
  if (a.length !== 6) return msg('PIN baru harus 6 digit.', 'error', '#cpMsg')
  if (a !== b) { $('#newPin2').value = ''; return msg('Ulangi PIN tidak cocok.', 'error', '#cpMsg') }
  if (a === '000000') return msg('PIN baru tidak boleh 000000.', 'error', '#cpMsg')
  const btn = $('#btnSavePin')
  busy(btn, true, 'Menyimpan...')
  try {
    const d = await (await fetch('/api/change-pin', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ session: session.get(), newPin: a }) })).json()
    if (d.success) { msg('PIN tersimpan. Mengalihkan...', 'success', '#cpMsg'); setTimeout(() => location.replace('/monitoring'), 700) }
    else msg(d.error || 'Gagal mengubah PIN.', 'error', '#cpMsg')
  } catch (e) { msg('Terjadi kesalahan. Coba lagi.', 'error', '#cpMsg') }
  busy(btn, false)
}

// ---------------------------------------------------------------- mulai
$('#phoneForm').addEventListener('submit', e => { e.preventDefault(); checkUser() })
$('#pinForm').addEventListener('submit', e => { e.preventDefault(); submitPin() })
$('#pin').addEventListener('input', e => { e.target.value = e.target.value.replace(/\D/g, '').slice(0, 6); if (e.target.value.length === 6) submitPin() })
$('#btnBack').addEventListener('click', () => { $('#pin').value = ''; msg(''); show('phone') })
$('#btnPayBack').addEventListener('click', () => { msg(''); show('phone') })
$('#changePinForm').addEventListener('submit', e => { e.preventDefault(); saveNewPin() })
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {})

checkExisting().then(stay => {
  if (!stay) return
  $('#loading').remove()
  loadTurnstile()
  $('#phone').focus()
})
