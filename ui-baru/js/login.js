// Halaman login (tampilan baru): nomor -> PIN -> monitoring.
// Belum punya PIN (akun baru / PIN direset admin) atau lupa PIN -> verifikasi nomor lewat WhatsApp
// (user mengirim "VERIFIKASI 123456" ke nomor bot) -> buat PIN baru -> monitoring.
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
  // pesan muncul dengan geser halus; pesan error ditambah goyang kecil
  el.className = 'anim-msg mb-4 rounded-xl px-4 py-3 text-sm font-semibold ' + ({ error: 'anim-shake bg-down/10 text-down', success: 'bg-up/10 text-up' }[type] || 'bg-sky/10 text-sky')
}
function busy(btn, on, text) {
  // tombol sibuk: putaran kecil + teks (bukan sekadar teks berubah)
  if (on) { if (!btn.disabled) btn.dataset.text = btn.textContent; btn.innerHTML = '<span class="spinner spinner-sm"></span><span>' + (text || '') + '</span>'; btn.disabled = true; btn.classList.add('is-busy') }
  else { btn.textContent = btn.dataset.text || btn.textContent; btn.disabled = false; btn.classList.remove('is-busy') }
}
function show(step) {
  // langkah berganti (nomor -> PIN -> pembayaran) dengan geser + memudar
  ;[['#phoneForm', 'phone'], ['#pinForm', 'pin'], ['#verifyWrap', 'verify'], ['#newPinForm', 'newpin'], ['#payWrap', 'pay']].forEach(([sel, k]) => {
    const el = $(sel)
    const on = step === k
    if (on && el.classList.contains('hidden')) { el.classList.remove('hidden', 'anim-step'); void el.offsetWidth; el.classList.add('anim-step') }
    else el.classList.toggle('hidden', !on)
  })
  $('#step2').className = 'h-1.5 flex-1 rounded-full ' + (step === 'phone' ? 'bg-line/15' : 'bg-gold')
  if (step !== 'pay' && stopPay) { stopPay(); stopPay = null }
  if (step !== 'verify') stopVerifyPoll()
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
      if (p.requirePinChange && v.phone && /^62[0-9]+$/.test(v.phone)) {
        phone = v.phone.slice(2)
        $('#loading').remove()
        loadTurnstile()
        startVerify('setup')
        return false
      }
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
    if (d.success && d.needPinSetup && d.adminReset) {
      // PIN baru direset admin / akun baru: langsung buat PIN baru (tanpa verifikasi)
      tsReset(); busy(btn, false)
      return openNewPin(false)
    } else if (d.success && d.needPinSetup) {
      // belum punya PIN dan bukan reset admin: verifikasi nomor lewat WhatsApp lalu buat PIN
      tsReset(); busy(btn, false)
      return startVerify('setup')
    } else if (d.success) {
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
    ? 'Perpanjang lewat QRIS: Rp' + cfg.price.toLocaleString('id-ID') + ' untuk ' + cfg.days + ' hari. Setelah diterima, langsung masuk dengan PIN Anda.'
    : 'Daftar lewat QRIS: Rp' + cfg.price.toLocaleString('id-ID') + ' untuk ' + cfg.days + ' hari. Setelah diterima, langsung buat PIN Anda.'
  show('pay')
  stopPay = mountPayment($('#payBox'), {
    phone: '62' + p,
    renew: expired,
    months: 1,
    pricePerMonth: cfg.price,
    // pembayaran diterima (otomatis / di-ACC admin): lanjut sendiri tanpa mengetik nomor lagi
    onPaid: () => setTimeout(() => {
      phone = p
      if (expired) {
        // perpanjang: langsung ke PIN
        $('#userName').textContent = 'Masa aktif diperpanjang'
        $('#userPhone').textContent = '+62' + p
        msg('Pembayaran diterima. Masukkan PIN Anda.', 'success')
        show('pin')
        setTimeout(() => $('#pin').focus(), 50)
      } else {
        // akun baru: langsung buat PIN
        msg('Pembayaran diterima. Akun aktif.', 'success')
        openNewPin(false)
      }
    }, 2000)
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
      msg('Berhasil masuk. Mengalihkan...', 'success'); location.replace('/monitoring')
    } else if (d.needPinSetup) { busy(btn, false); $('#pin').value = ''; return startVerify('setup') }
    else { msg(d.error || 'Login gagal.', 'error'); $('#pin').value = ''; $('#pin').focus() }
  } catch (e) { msg('Terjadi kesalahan. Coba lagi.', 'error') }
  busy(btn, false)
}

// ---------------------------------------------------------------- 3. verifikasi nomor lewat WhatsApp
// mode 'setup' = belum punya PIN (akun baru / PIN direset admin), 'forgot' = lupa PIN
let vToken = ''
let vPoll = null
let vTick = null
let vUntil = 0
function stopVerifyPoll() { clearInterval(vPoll); clearInterval(vTick); vPoll = vTick = null }
function vStatus(text, kind) {
  const el = $('#vStatus')
  el.classList.remove('v-ok', 'v-bad')
  if (kind) el.classList.add(kind)
  el.querySelector('.spinner').classList.toggle('hidden', !!kind)
  $('#vStatusText').textContent = text
}
async function startVerify(mode) {
  msg('')
  const btn = $('#vRetry')
  btn.classList.add('hidden')
  $('#vTitle').textContent = mode === 'forgot' ? 'Lupa PIN' : 'Buat PIN'
  $('#vDesc').textContent = 'Verifikasi nomor +62' + phone + ' lewat WhatsApp untuk membuat PIN baru.'
  $('#vText').textContent = 'VERIFIKASI ------'
  $('#vBot').textContent = ''
  $('#vTimer').textContent = ''
  vStatus('Menyiapkan kode...')
  show('verify')
  let d = null
  try { d = await (await fetch('/api/pin/verify-start', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ phone: '62' + phone }) })).json() } catch (e) {}
  if (!d || !d.success) {
    if (d && (d.expired || d.needRegister)) { show('phone'); return startPayment(phone, !!d.expired) }
    vStatus((d && d.error) || 'Gagal membuat kode. Periksa sinyal lalu coba lagi.', 'v-bad')
    btn.classList.remove('hidden')
    return
  }
  vToken = d.token
  $('#vText').textContent = d.waText
  $('#vBot').textContent = '+' + d.bot
  $('#vWa').href = d.waLink
  vStatus('Menunggu verifikasi...')
  vUntil = Date.now() + d.expiresIn * 1000
  const tick = () => {
    const left = Math.max(0, Math.round((vUntil - Date.now()) / 1000))
    $('#vTimer').textContent = 'Berlaku ' + Math.floor(left / 60) + ':' + String(left % 60).padStart(2, '0')
  }
  tick()
  stopVerifyPoll()
  vTick = setInterval(tick, 1000)
  vPoll = setInterval(checkVerify, 2500)
}
let vChecking = false
async function checkVerify() {
  if (!vToken || vChecking) return
  vChecking = true
  try {
    const d = await (await fetch('/api/pin/verify-status?token=' + encodeURIComponent(vToken), { cache: 'no-store' })).json()
    if (d.verified) {
      stopVerifyPoll()
      vStatus('Nomor terverifikasi', 'v-ok')
      setTimeout(() => openNewPin(true), 500)
    } else if (d.expired) {
      stopVerifyPoll(); vToken = ''
      $('#vTimer').textContent = ''
      vStatus('Kode kedaluwarsa.', 'v-bad')
      $('#vRetry').classList.remove('hidden')
    } else if (d.mismatch === 'other') {
      vStatus('Pesan masuk dari nomor lain. Kirim dari WhatsApp nomor +62' + phone + '.', 'v-bad')
    } else if (d.mismatch === 'hidden') {
      vStatus('Nomor pengirim tidak terbaca. Kirim sekali lagi atau hubungi admin.', 'v-bad')
    }
  } catch (e) {}
  vChecking = false
}
// kembali dari WhatsApp: langsung cek tanpa menunggu jadwal berikutnya
document.addEventListener('visibilitychange', () => { if (!document.hidden && vPoll) checkVerify() })
$('#vCopy').addEventListener('click', async () => {
  const t = $('#vText').textContent
  try { await navigator.clipboard.writeText(t) } catch (e) { return }
  $('#vCopy').classList.add('copied')
  setTimeout(() => $('#vCopy').classList.remove('copied'), 1200)
})
$('#vRetry').addEventListener('click', () => startVerify('forgot'))
$('#vBack').addEventListener('click', () => { vToken = ''; msg(''); show('phone') })

// ---------------------------------------------------------------- 4. buat PIN baru
// verified = true: lewat verifikasi WhatsApp (pakai token). false: setelah reset admin / akun baru.
function openNewPin(verified) {
  if (!verified) vToken = ''
  $('#npVerified').classList.toggle('hidden', !verified)
  $('#npDesc').textContent = verified ? '6 digit angka. Hindari angka sama atau berurutan (mis. 111111, 123456).'
    : 'PIN akun +62' + phone + ' belum dibuat. Buat PIN 6 digit (hindari angka sama atau berurutan).'
  $('#newPin').value = $('#newPin2').value = ''
  show('newpin')
  setTimeout(() => $('#newPin').focus(), 50)
}
const weakPin = p => /^(\d)\1{5}$/.test(p) || '0123456789012345'.includes(p) || '9876543210987654'.includes(p)
async function saveNewPin() {
  const a = $('#newPin').value.replace(/\D/g, '')
  const b = $('#newPin2').value.replace(/\D/g, '')
  if (a.length !== 6) return msg('PIN baru harus 6 digit.', 'error')
  if (weakPin(a)) { $('#newPin').value = $('#newPin2').value = ''; $('#newPin').focus(); return msg('PIN terlalu mudah ditebak (angka sama / berurutan). Pilih PIN lain.', 'error') }
  if (a !== b) { $('#newPin2').value = ''; $('#newPin2').focus(); return msg('Ulangi PIN tidak cocok.', 'error') }
  const btn = $('#btnSavePin')
  busy(btn, true, 'Menyimpan...')
  try {
    const d = await (await fetch(vToken ? '/api/pin/set' : '/api/pin/set-after-reset', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: vToken || undefined, phone: '62' + phone, pin: a, oldSession: session.get() || undefined }) })).json()
    if (d.success) {
      session.set(d.sessionId)
      try { localStorage.setItem('gold_sess_ok_at', String(Date.now())) } catch (e) {}
      msg('PIN tersimpan. Mengalihkan...', 'success')
      setTimeout(() => location.replace('/monitoring'), 600)
      return
    }
    if (d.expired || d.needVerify) { busy(btn, false); return startVerify('setup') }
    msg(d.error || 'Gagal menyimpan PIN.', 'error')
  } catch (e) { msg('Terjadi kesalahan. Coba lagi.', 'error') }
  busy(btn, false)
}

// ---------------------------------------------------------------- mulai
$('#phoneForm').addEventListener('submit', e => { e.preventDefault(); checkUser() })
$('#pinForm').addEventListener('submit', e => { e.preventDefault(); submitPin() })
$('#pin').addEventListener('input', e => { e.target.value = e.target.value.replace(/\D/g, '').slice(0, 6); if (e.target.value.length === 6) submitPin() })
$('#btnBack').addEventListener('click', () => { $('#pin').value = ''; msg(''); show('phone') })
$('#btnPayBack').addEventListener('click', () => { msg(''); show('phone') })
$('#btnForgot').addEventListener('click', () => { $('#pin').value = ''; startVerify('forgot') })
$('#newPinForm').addEventListener('submit', e => { e.preventDefault(); saveNewPin() })
;['#newPin', '#newPin2'].forEach(id => $(id).addEventListener('input', e => { e.target.value = e.target.value.replace(/\D/g, '').slice(0, 6) }))
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {})

checkExisting().then(stay => {
  if (!stay) return
  $('#loading').remove()
  loadTurnstile()
  $('#phone').focus()
})
