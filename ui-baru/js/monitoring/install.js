// Install aplikasi (PWA): tombol install otomatis bila browser mendukung, selain itu panduan langkah
// demi langkah sesuai HP & browser (iPhone Safari, Chrome, Samsung Internet, browser di dalam WhatsApp, dll).
// Ajakan install muncul sendiri maks. sekali tiap 3 hari, dan tidak pernah lagi setelah aplikasi terpasang.
import { h, icon, openSheet, closeAllSheets, toast } from '../api.js'

let deferredPrompt = null
window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); deferredPrompt = e })
window.addEventListener('appinstalled', () => {
  deferredPrompt = null
  try { localStorage.setItem('appInstalled', '1') } catch (e) {}
  const card = document.getElementById('installInvite'); if (card) card.remove()
  toast('Aplikasi Harga PemulaOLD terpasang. Buka dari layar utama HP.', 'success', 5000)
})

/** true = browser siap memasang otomatis (event beforeinstallprompt sudah diterima) */
export const canAutoInstall = () => !!deferredPrompt
export const isInstalled = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true

/** Kenali HP & browser supaya panduan install tepat */
export function detectEnv() {
  const ua = navigator.userAgent || ''
  const ios = /iphone|ipad|ipod/i.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
  const android = /android/i.test(ua)
  const inapp = /FBAN|FBAV|Instagram|Line\/|WhatsApp|TikTok|musical_ly|Twitter|Snapchat|; wv\)/i.test(ua)
  const inappName = /WhatsApp/i.test(ua) ? 'WhatsApp' : /Instagram/i.test(ua) ? 'Instagram' : /FBAN|FBAV/i.test(ua) ? 'Facebook'
    : /Line\//i.test(ua) ? 'LINE' : /TikTok|musical_ly/i.test(ua) ? 'TikTok' : 'aplikasi ini'
  let browser = 'other'
  if (inapp) browser = 'inapp'
  else if (/SamsungBrowser/i.test(ua)) browser = 'samsung'
  else if (/EdgiOS|EdgA|Edg\//i.test(ua)) browser = 'edge'
  else if (/OPR\/|OPiOS|Opera/i.test(ua)) browser = 'opera'
  else if (/FxiOS|Firefox/i.test(ua)) browser = 'firefox'
  else if (/CriOS|Chrome/i.test(ua)) browser = 'chrome'
  else if (/Safari/i.test(ua)) browser = 'safari'
  return { os: ios ? 'ios' : android ? 'android' : 'desktop', browser, inappName }
}

/** Langkah install sesuai perangkat: [judul singkat, langkah-langkah] */
function steps(env) {
  const { os, browser, inappName } = env
  if (browser === 'inapp') return ['Buka di browser dulu', [
    'Halaman ini terbuka di dalam ' + inappName + ', yang tidak bisa memasang aplikasi.',
    os === 'ios' ? 'Ketuk ••• / ikon kompas, lalu pilih "Buka di Safari".' : 'Ketuk ⋮ di pojok kanan atas, lalu pilih "Buka di Chrome" / "Buka di browser".',
    'Setelah terbuka di browser, buka menu ini lagi untuk memasang.']]
  if (os === 'ios') {
    if (browser === 'safari') return ['iPhone / iPad (Safari)', [
      'Ketuk tombol Bagikan (kotak dengan panah ke atas) di bawah layar.',
      'Gulir, lalu pilih "Tambahkan ke Layar Utama".',
      'Ketuk "Tambah". Ikon PemulaOLD muncul di layar utama.']]
    return ['iPhone / iPad (' + (browser === 'chrome' ? 'Chrome' : browser === 'edge' ? 'Edge' : browser === 'firefox' ? 'Firefox' : 'browser ini') + ')', [
      'Ketuk tombol Bagikan (kotak dengan panah ke atas) di bilah alamat / menu.',
      'Pilih "Tambahkan ke Layar Utama", lalu ketuk "Tambah".',
      'Kalau pilihan itu tidak ada, buka halaman ini di Safari lalu ulangi.']]
  }
  if (os === 'android') {
    if (browser === 'samsung') return ['Samsung Internet', [
      'Ketuk ikon menu ☰ di bawah layar.',
      'Pilih "Tambahkan halaman ke" → "Layar Utama".',
      'Ketuk "Tambah".']]
    if (browser === 'firefox') return ['Firefox Android', ['Ketuk ⋮ di pojok kanan atas.', 'Pilih "Instal".', 'Ketuk "Tambah".']]
    return ['Android (' + (browser === 'edge' ? 'Edge' : browser === 'opera' ? 'Opera' : 'Chrome') + ')', [
      'Ketuk ⋮ di pojok kanan atas.',
      'Pilih "Instal aplikasi" atau "Tambahkan ke layar utama".',
      'Ketuk "Instal". Ikon PemulaOLD muncul di layar utama.']]
  }
  if (browser === 'safari') return ['Mac (Safari)', ['Klik menu File di bagian atas layar.', 'Pilih "Tambahkan ke Dock".']]
  if (browser === 'firefox') return ['Komputer (Firefox)', ['Firefox di komputer belum bisa memasang aplikasi web.', 'Buka halaman ini di Chrome atau Edge, lalu klik ikon install di bilah alamat.']]
  return ['Komputer (' + (browser === 'edge' ? 'Edge' : 'Chrome') + ')', [
    'Klik ikon install (layar dengan panah ke bawah) di ujung kanan bilah alamat.',
    'Atau buka menu ⋮ → "Simpan dan bagikan" / "Aplikasi" → "Instal Harga PemulaOLD".',
    'Klik "Instal".']]
}

/** Dari menu / ajakan: install langsung kalau bisa, kalau tidak tampilkan panduan sesuai HP & browser */
export async function openInstall() {
  closeAllSheets(true)
  if (isInstalled()) { toast('Aplikasi sudah terpasang dan sedang dipakai.', 'success'); return }
  if (deferredPrompt) {
    const p = deferredPrompt
    deferredPrompt = null
    p.prompt()
    try {
      const r = await p.userChoice
      if (r && r.outcome === 'dismissed') toast('Install dibatalkan. Bisa dipasang lagi dari menu pengaturan.')
    } catch (e) {}
    return
  }
  const env = detectEnv()
  const [title, list] = steps(env)
  openSheet('Pasang aplikasi', h('div', {},
    h('div', { class: 'mb-3 flex items-center gap-3' },
      appIcon({ class: 'h-12 w-12 shrink-0 rounded-xl' }),
      h('div', { class: 'min-w-0' },
        h('div', { class: 'text-sm font-extrabold' }, 'Harga PemulaOLD'),
        h('div', { class: 'text-xs text-muted' }, 'Buka lebih cepat dari layar utama & terima notifikasi harga'))),
    h('div', { class: 'label mb-1.5' }, title),
    h('ol', { class: 'flex flex-col gap-2' }, list.map((t, i) => h('li', { class: 'flex gap-2.5 text-sm leading-snug' },
      h('span', { class: 'flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-gold/15 text-xs font-extrabold text-gold' }, String(i + 1)),
      h('span', { class: 'pt-0.5' }, t)))),
    env.os === 'ios' && env.browser !== 'inapp' ? h('p', { class: 'mt-3 text-[11px] text-muted' }, 'Di iPhone, notifikasi harga hanya bisa aktif setelah aplikasi dipasang ke layar utama.') : null))
}

// Ikon aplikasi untuk panel/kartu install; kalau ikon baru belum tersedia, pakai ikon lama
function appIcon(attrs) {
  const img = document.createElement('img')
  img.alt = ''
  img.className = attrs.class || ''
  const fallback = () => { if (!img.dataset.fb) { img.dataset.fb = '1'; img.src = '/icon.png?v=3' } }
  img.addEventListener('error', fallback)
  img.addEventListener('load', () => { if (!img.naturalWidth) fallback() })
  img.src = '/icon-192.png?v=4'
  setTimeout(() => { if (img.complete && !img.naturalWidth) fallback() }, 1500)
  return img
}
const ASK_KEY = 'installAskAt'
/** Ajakan install otomatis: tidak terpasang, belum ditanya 3 hari terakhir, tidak sedang panduan / dialog */
export function scheduleInstallInvite(delay = 25000) {
  setTimeout(() => {
    if (isInstalled()) { try { localStorage.setItem('appInstalled', '1') } catch (e) {} return }
    let last = 0, never = false
    try { last = +localStorage.getItem(ASK_KEY) || 0; never = localStorage.getItem('installNever') === '1' } catch (e) {}
    if (never || Date.now() - last < 3 * 86400000) return
    if (document.querySelector('#tourRoot, .sheet, #installInvite, #askJoinModal')) return scheduleInstallInvite(30000)
    try { localStorage.setItem(ASK_KEY, String(Date.now())) } catch (e) {}
    const never2 = h('input', { type: 'checkbox', class: 'h-3.5 w-3.5 accent-current' })
    never2.addEventListener('change', () => { try { localStorage.setItem('installNever', never2.checked ? '1' : '0') } catch (e) {} })
    const card = h('div', { id: 'installInvite', class: 'install-invite anim-pop', role: 'dialog', 'aria-label': 'Pasang aplikasi' },
      appIcon({ class: 'h-10 w-10 shrink-0 rounded-lg' }),
      h('div', { class: 'min-w-0 flex-1' },
        h('div', { class: 'text-sm font-extrabold' }, 'Pasang aplikasi PemulaOLD'),
        h('div', { class: 'text-[11px] leading-snug text-muted' }, 'Buka lebih cepat & dapat notifikasi harga'),
        // centang: ajakan tidak muncul lagi (install tetap bisa dari menu pengaturan)
        h('label', { class: 'mt-1 flex cursor-pointer items-center gap-1.5 text-[11px] text-muted' }, never2, 'Jangan tanya lagi')),
      // bisa dipasang otomatis (Android Chrome/Samsung/Edge, komputer Chrome/Edge): "Pasang" langsung memunculkan
      // dialog install bawaan; tidak bisa (iPhone, browser di dalam aplikasi): "Cara pasang" membuka panduan
      h('button', { class: 'btn-gold shrink-0 px-3 py-2 text-xs', onclick: () => { card.remove(); openInstall() } }, canAutoInstall() ? 'Pasang' : 'Cara pasang'),
      h('button', { class: 'icon-btn h-8 w-8 shrink-0', 'aria-label': 'Nanti', html: icon('close', 'h-4 w-4'), onclick: () => {
        if (never2.checked) { try { localStorage.setItem('installNever', '1') } catch (e) {} toast('Ajakan install tidak akan muncul lagi. Install tetap bisa dari menu pengaturan.') }
        card.classList.add('anim-fade-out'); setTimeout(() => card.remove(), 200)
      } }))
    document.body.append(card)
  }, delay)
}
