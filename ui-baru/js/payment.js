// Pembayaran QRIS: dipakai untuk daftar baru (halaman login) dan perpanjang (monitoring).
// Alur: buat order -> tampilkan QRIS + nominal unik -> upload bukti -> pantau status sampai lunas/ditolak.
import { h, icon, rp, session, confirmDialog, shrinkImage, contactAdmin } from './api.js'

/**
 * Pasang form pembayaran ke dalam `root`.
 * opts: { phone, renew (bool), months (angka), monthOptions ([1,2,3,...]), pricePerMonth, onPaid(activeUntil), onCancel }
 * Mengembalikan fungsi stop() untuk menghentikan pemantauan.
 */
export function mountPayment(root, opts) {
  let order = null
  let timer = null
  let uploading = false
  let loadToken = 0
  const stop = () => { if (timer) clearInterval(timer); timer = null }

  const chooser = h('div', { class: 'mb-4' })
  const box = h('div', {})
  root.replaceChildren(chooser, box)

  // ---------- pilihan bulan (hanya perpanjang) ----------
  function renderChooser(active) {
    if (!opts.monthOptions || opts.monthOptions.length < 2) { chooser.replaceChildren(); return }
    chooser.replaceChildren(
      h('div', { class: 'label mb-2' }, 'Pilih lama perpanjangan'),
      h('div', { class: 'grid grid-cols-3 gap-2' }, opts.monthOptions.map(m =>
        h('button', {
          class: 'rounded-xl border px-2 py-2.5 text-center transition ' + (m === active ? 'border-gold bg-gold text-bg' : 'border-line/[0.12] bg-card2'),
          onclick: () => load(m)
        },
        h('div', { class: 'text-sm font-extrabold' }, m + ' bulan'),
        h('div', { class: 'num text-[11px] font-semibold opacity-80' }, rp((opts.pricePerMonth || 0) * m))))))
  }

  // ---------- buat / ambil order ----------
  async function load(months) {
    const token = ++loadToken
    stop()
    renderChooser(months)
    box.replaceChildren(h('div', { class: 'py-10 text-center text-sm text-muted' }, 'Menyiapkan QRIS...'))
    let data = null
    try {
      const res = await fetch('/api/payment/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone: opts.phone, session: session.get(), months })
      })
      data = await res.json()
    } catch (e) {}
    if (token !== loadToken) return
    if (!data || !data.success) {
      box.replaceChildren(h('div', { class: 'rounded-xl bg-down/10 p-4 text-sm text-down' }, (data && data.error) || 'Gagal membuat pembayaran. Coba lagi.'))
      return
    }
    order = data.order
    if ((order.months || 1) !== months) renderChooser(order.months || 1)
    renderOrder(months)
    if (order.status === 'rejected') showRejected(order.rejectReason)
    else showProof(order.proofStatus)
    poll()
  }

  // ---------- tampilan order ----------
  let statusEl, uploadBtn, rejectBox, fileInput
  function renderOrder(asked) {
    statusEl = h('div', { class: 'mt-2 text-center text-sm font-semibold' })
    rejectBox = h('div', { class: 'mb-3 hidden rounded-xl border border-down/40 bg-down/10 p-3 text-sm text-down' })
    fileInput = h('input', { type: 'file', accept: 'image/*', class: 'hidden', onchange: () => upload() })
    uploadBtn = h('button', { class: 'btn-green w-full py-4 text-base', onclick: () => fileInput.click(), html: icon('upload') + '<span>Upload bukti pembayaran</span>' })
    const saveLink = order.qrDataUrl ? h('a', { href: order.qrDataUrl, download: 'qris-pemulaold.png', class: 'mt-2 inline-block text-xs font-semibold text-gold' }, 'Simpan gambar QRIS') : null
    box.replaceChildren(
      (order.months || 1) !== asked ? h('div', { class: 'mb-3 rounded-xl bg-gold/10 p-3 text-xs font-semibold text-gold' }, 'Bukti untuk pilihan ' + (order.months || 1) + ' bulan sudah terkirim, jadi pilihan itu yang dipakai.') : null,
      h('div', { class: 'tile mb-3 p-4 text-center' },
        h('div', { class: 'label mb-1' }, '1. Scan QRIS, bayar persis'),
        h('div', { class: 'num mb-3 text-3xl font-extrabold text-gold' }, rp(order.amount)),
        order.qrDataUrl ? h('img', { src: order.qrDataUrl, alt: 'QRIS', class: 'mx-auto w-56 max-w-full rounded-xl bg-white p-2' }) : null,
        saveLink,
        h('div', { class: 'mt-2 text-xs text-muted' }, (opts.renew ? 'Tambah ' : 'Aktif ') + (order.days || 30) + ' hari. Jangan dibulatkan.')),
      h('div', { class: 'tile p-4' },
        h('div', { class: 'label mb-2' }, '2. Sudah bayar?'),
        rejectBox, fileInput, uploadBtn, statusEl))
  }
  const setStatus = (text, tone) => {
    statusEl.textContent = text
    statusEl.className = 'mt-2 text-center text-sm font-semibold ' + ({ ok: 'text-up', warn: 'text-gold', err: 'text-down' }[tone] || 'text-muted')
  }
  function showProof(proofStatus) {
    if (!statusEl) return
    if (!proofStatus) { uploadBtn.hidden = false; setStatus('Setelah bayar, upload screenshot buktinya.', 'warn'); return }
    uploadBtn.hidden = true
    setStatus(proofStatus === 'checking' ? 'Bukti terkirim, sedang diperiksa...' : 'Bukti terkirim, menunggu konfirmasi.', 'ok')
  }
  function showRejected(reason) {
    rejectBox.classList.remove('hidden')
    rejectBox.replaceChildren(
      h('div', { class: 'font-extrabold' }, 'Bukti ditolak'),
      h('div', { class: 'mt-1' }, 'Alasan: ' + (reason || 'Bukti tidak valid')),
      h('button', { class: 'mt-2 text-xs font-bold underline', onclick: () => contactAdmin(opts.phone, 'Hallo saya (+' + opts.phone + ') bukti pembayaran saya ditolak, mohon dicek') }, 'Hubungi admin'))
    uploadBtn.hidden = false
    uploadBtn.innerHTML = icon('upload') + '<span>Upload bukti baru</span>'
    setStatus('Upload bukti yang benar.', 'err')
  }

  // ---------- upload bukti ----------
  async function upload() {
    const file = fileInput.files && fileInput.files[0]
    fileInput.value = ''
    if (!file || !order) return
    if (!(await confirmDialog('Kirim foto ini sebagai bukti pembayaran?', { title: 'Kirim bukti', ok: 'Kirim' }))) return
    uploading = true
    uploadBtn.disabled = true
    setStatus('Mengunggah bukti...')
    try {
      const blob = await shrinkImage(file)
      const res = await fetch('/api/payment/proof?id=' + order.id, { method: 'POST', headers: { 'Content-Type': blob.type || 'image/jpeg' }, body: blob })
      const d = await res.json()
      if (d.success) { rejectBox.classList.add('hidden'); showProof('checking') }
      else setStatus(d.error || 'Gagal mengunggah. Coba lagi.', 'err')
    } catch (e) {
      setStatus('Gagal mengunggah. Periksa koneksi lalu coba lagi.', 'err')
    }
    uploading = false
    uploadBtn.disabled = false
  }

  // ---------- pantau status ----------
  function poll() {
    stop()
    timer = setInterval(async () => {
      if (!order || document.hidden || uploading) return
      let d = null
      try { d = await (await fetch('/api/payment/status?id=' + order.id, { cache: 'no-store' })).json() } catch (e) {}
      if (!d || !d.success) return
      if (d.status === 'paid') { stop(); done(d.activeUntil); return }
      if (d.status === 'rejected') { showRejected(d.rejectReason); return }
      rejectBox.classList.add('hidden')
      if (d.status === 'expired') { stop(); uploadBtn.hidden = true; setStatus('Order sudah tidak berlaku. Tutup lalu buka lagi.', 'err'); return }
      showProof(d.proofStatus)
    }, 4000)
  }
  function done(activeUntil) {
    chooser.replaceChildren()
    box.replaceChildren(h('div', { class: 'py-8 text-center' },
      h('div', { class: 'mx-auto mb-3 flex h-14 w-14 items-center justify-center rounded-full bg-up/15 text-up', html: icon('check', 'h-7 w-7') }),
      h('div', { class: 'text-lg font-extrabold text-up' }, 'Pembayaran diterima!'),
      h('div', { class: 'mt-1 text-sm text-muted' }, activeUntil ? 'Akun aktif sampai ' + new Date(Number(activeUntil)).toLocaleDateString('id-ID', { day: 'numeric', month: 'long', year: 'numeric' }) + '.' : 'Akun sudah aktif.')))
    if (opts.onPaid) opts.onPaid(activeUntil)
  }

  load(opts.months || 1)
  return stop
}
