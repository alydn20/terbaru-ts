# Tampilan baru (newxau.pemulaold.com)

Halaman `/login` dan `/monitoring` versi baru, dibuat dengan Tailwind. Server, API, data, dan
semua fitur admin tetap sama dengan tampilan lama (`index.js`). Alamat `newxau.*` memakai
tampilan ini; alamat lain tetap tampilan lama. Di alamat lain bisa dicoba dengan
`/monitoring?ui=baru` (kembali: `?ui=lama`).

## Struktur

```
ui-baru/
  pages/login.html        kerangka halaman login
  pages/monitoring.html   kerangka halaman monitoring
  js/api.js               sesi, fetch, format angka, ikon, dialog, lembar bawah, tema
  js/payment.js           pembayaran QRIS (daftar baru & perpanjang)
  js/login.js             alur login: nomor -> PIN -> ganti PIN awal / pembayaran
  js/monitoring.js        halaman monitoring: sesi, harga realtime (SSE), jam, navigasi
  js/monitoring/state.js  data bersama + rumus untung dan markup
  js/monitoring/history.js  tabel riwayat harga dan USD/IDR
  js/monitoring/chart.js    grafik TradingView + indikator
  js/monitoring/news.js     News (Forex Factory) dan Promo
  js/monitoring/menu.js     menu Lainnya: kalkulator, suara, nominal, perpanjang, grup WA, dll.
  js/monitoring/sound.js    suara & getar
  sounds/                 suara bawaan promo ON/OFF
  src/app.css             sumber Tailwind (warna tema ada di sini)
  dist/app.css            hasil build — ini yang dipakai website, ikut di-commit
```

## Mengubah tampilan

```
cd ui-baru
npm install        # sekali saja
npm run build      # wajib setiap mengubah class Tailwind di pages/ atau js/
```

Server tidak menjalankan build; `dist/app.css` harus ikut di-commit.
