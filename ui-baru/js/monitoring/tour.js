// Panduan penggunaan (tur langkah demi langkah dengan sorotan pada bagian halaman).
// Wajib muncul sekali untuk pengguna yang baru pertama membuka tampilan ini (per perangkat),
// dan bisa dibuka lagi dari Lainnya -> Panduan penggunaan.
import { h } from '../api.js'

const DONE_KEY = 'tourDone_v1'
const STEP_KEY = 'tourStep_v1'   // langkah terakhir (reload di tengah panduan -> dilanjutkan)
const wide = () => matchMedia('(min-width: 768px)').matches
// tombol menu yang terlihat: di HP menu bawah, di desktop bar atas
const navBtn = key => '#topNav [data-nav="' + key + '"]'

function steps() {
  return [
    { title: 'Selamat datang di tampilan baru', text: 'Panduan singkat ini menjelaskan setiap bagian halaman. Tekan Lanjut untuk mulai (sekitar 1 menit).' },
    { sel: '#buyCard', sel2: '#sellCard', title: 'Harga Beli & Jual', text: 'Harga emas realtime. Kotak berwarna hijau saat harga naik dan merah saat turun, lalu berkedip beberapa detik supaya terlihat itu harga terbaru.' },
    { sel: '#promoStatus', title: 'Status promo', text: 'PROMO ON berarti promo sedang aktif. Anda akan mendapat pemberitahuan saat status berubah.' },
    { sel: '#chips', title: 'Info harga', text: 'Kurs USD/IDR, harga tertinggi & terendah hari ini, limit beli promo, markup/markdown, spread, dan Titik ON (harga saat promo terakhir aktif).' },
    { sel: '#nominals', title: 'Untung per nominal', text: 'Perkiraan gram dan untung untuk tiap nominal. Tekan "Atur" untuk memilih nominal yang ditampilkan.' },
    { sel: '#sec-grafik', title: 'Grafik XAU/USD', text: 'Grafik harga emas dunia. Indikator grafik bisa diatur dari menu Lainnya.' },
    { sel: '#sec-riwayat', title: 'Riwayat perubahan harga', text: 'Daftar setiap perubahan harga (jam sesuai Treasury). Tekan "Aa" untuk mengubah ukuran teks, dan "USD/IDR" untuk riwayat kurs.' },
    { sel: '#btnLayout', title: 'Tata letak', text: 'Pilih bagian yang ingin ditampilkan: harga, grafik, riwayat, atau gabungannya. Pilihan diingat di perangkat ini.' },
    { sel: navBtn('promo'), title: 'Promo', text: 'Daftar promo yang sedang berlaku. Angka merah = jumlah promo aktif.' },
    { sel: navBtn('news'), title: 'News', text: 'Jadwal news ekonomi Amerika yang biasa menggerakkan harga emas. Untuk news dampak tinggi, muncul pengingat 30 menit dan 3 menit sebelum rilis.' },
    { sel: navBtn('lainnya'), title: 'Lainnya', text: 'Pengaturan lain: suara & getar, notifikasi HP, kalkulator emas, perpanjang masa aktif, dan panduan ini.' },
    { sel: '#btnAdminWa', title: 'Hubungi admin', text: 'Butuh bantuan? Tekan tombol ini untuk chat admin lewat WhatsApp.' },
    { title: 'Selesai!', text: 'Selamat menggunakan PemulaOLD. Panduan ini bisa dibuka lagi kapan saja dari Lainnya → Panduan penggunaan.' }
  ]
}

const visible = el => !!el && el.offsetParent !== null && el.getBoundingClientRect().width > 0

export function tourDone() { try { return localStorage.getItem(DONE_KEY) === '1' } catch (e) { return true } }

/** Jalankan panduan. resume = lanjut dari langkah terakhir (dipakai saat muncul otomatis).
 *  Mengembalikan Promise yang selesai saat panduan ditutup. */
export function startTour(resume) {
  return new Promise(resolve => {
    const list = steps().filter(s => !s.sel || visible(document.querySelector(s.sel)))
    let i = 0
    if (resume) { try { i = Math.max(0, Math.min(list.length - 1, parseInt(localStorage.getItem(STEP_KEY), 10) || 0)) } catch (e) {} }
    const root = h('div', { id: 'tourRoot', class: 'fixed inset-0 z-[100]', role: 'dialog', 'aria-modal': 'true' })
    // lapisan gelap (dipakai saat langkah tanpa sorotan) + kotak sorotan yang "melubangi" lapisan
    const dim = h('div', { class: 'absolute inset-0 bg-black/75' })
    const spot = h('div', { class: 'pointer-events-none absolute rounded-xl border-2 border-gold transition-all duration-300', style: 'box-shadow:0 0 0 9999px rgba(0,0,0,0.75)' })
    const card = h('div', { class: 'card absolute w-[min(340px,calc(100vw-24px))] p-4 shadow-2xl transition-all duration-300' })
    root.append(dim, spot, card)
    document.body.append(root)
    document.body.style.overflow = 'hidden'

    const place = () => {
      const s = list[i]
      const el = s.sel && document.querySelector(s.sel)
      const vw = window.innerWidth, vh = window.innerHeight
      card.style.visibility = 'hidden'
      requestAnimationFrame(() => {
        const ch = card.offsetHeight, cw = card.offsetWidth
        if (!el) {
          spot.style.display = 'none'; dim.style.display = ''
          card.style.left = Math.round((vw - cw) / 2) + 'px'
          card.style.top = Math.round((vh - ch) / 2) + 'px'
        } else {
          let r = el.getBoundingClientRect()
          const el2 = s.sel2 && document.querySelector(s.sel2)
          if (el2 && visible(el2)) { const r2 = el2.getBoundingClientRect(); r = { left: Math.min(r.left, r2.left), top: Math.min(r.top, r2.top), right: Math.max(r.right, r2.right), bottom: Math.max(r.bottom, r2.bottom) } }
          const pad = 6
          const top = Math.max(4, r.top - pad), left = Math.max(4, r.left - pad)
          const bottom = Math.min(vh - 4, r.bottom + pad), right = Math.min(vw - 4, r.right + pad)
          dim.style.display = 'none'; spot.style.display = ''
          spot.style.left = left + 'px'; spot.style.top = top + 'px'
          spot.style.width = (right - left) + 'px'; spot.style.height = (bottom - top) + 'px'
          // kartu penjelasan di bawah sorotan kalau muat, kalau tidak di atasnya, kalau tidak di tengah
          let cy = bottom + 10
          if (cy + ch > vh - 8) cy = top - ch - 10
          if (cy < 8) cy = Math.max(8, Math.min(vh - ch - 8, Math.round((vh - ch) / 2)))
          const cx = Math.max(12, Math.min(vw - cw - 12, Math.round((left + right) / 2 - cw / 2)))
          card.style.left = cx + 'px'; card.style.top = cy + 'px'
        }
        card.style.visibility = ''
      })
    }
    const render = () => {
      const s = list[i]
      const last = i === list.length - 1
      card.replaceChildren(
        h('div', { class: 'mb-1 flex items-center justify-between gap-2' },
          h('div', { class: 'text-base font-extrabold' }, s.title),
          h('div', { class: 'shrink-0 text-[11px] font-semibold text-muted' }, (i + 1) + ' / ' + list.length)),
        h('p', { class: 'text-sm leading-relaxed text-muted' }, s.text),
        h('div', { class: 'mt-3 flex gap-2' },
          i > 0 ? h('button', { class: 'btn-ghost flex-1 py-2.5', onclick: () => go(i - 1) }, 'Kembali') : null,
          h('button', { class: 'btn-gold flex-1 py-2.5', onclick: () => (last ? finish() : go(i + 1)) }, last ? 'Selesai' : 'Lanjut')))
      const el = s.sel && document.querySelector(s.sel)
      if (el) {
        // bagian di luar layar: digulir ke tengah dulu (halaman, lalu kotak sorotan diposisikan)
        document.body.style.overflow = ''
        el.scrollIntoView({ block: 'center', behavior: 'instant' })
        document.body.style.overflow = 'hidden'
      }
      place()
    }
    const go = n => {
      i = Math.max(0, Math.min(list.length - 1, n))
      try { localStorage.setItem(STEP_KEY, String(i)) } catch (e) {}
      render()
    }
    const onResize = () => place()
    const finish = () => {
      try { localStorage.setItem(DONE_KEY, '1'); localStorage.removeItem(STEP_KEY) } catch (e) {}
      window.removeEventListener('resize', onResize)
      root.remove()
      document.body.style.overflow = ''
      window.scrollTo({ top: 0 })
      resolve()
    }
    window.addEventListener('resize', onResize)
    render()
  })
}
