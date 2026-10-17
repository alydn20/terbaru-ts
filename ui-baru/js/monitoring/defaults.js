// Tampilan bawaan baru (harga ringkas + grafik + riwayat sekaligus, teks riwayat kecil).
// Dijalankan sekali per perangkat SEBELUM modul lain dibaca: pengaturan tampilan lama dihapus supaya
// semua user (termasuk yang sudah pernah mengubah) memakai tampilan bawaan ini. Nominal, tema,
// suara, dan sesi tidak disentuh.
const VER = '2'
try {
  if (localStorage.getItem('uiDefaultsVer') !== VER) {
    ['monitorLayout', 'priceCompact', 'histTextSize', 'histRows', 'histSide', 'chipPrefs', 'histIdrMode'].forEach(k => localStorage.removeItem(k))
    localStorage.setItem('uiDefaultsVer', VER)
  }
} catch (e) {}
