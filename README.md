# aruKontak · JRCare

Live chat web Jasa Raharja Care untuk menerima pertanyaan pelanggan saat kanal WhatsApp Mekari Qontak terganggu. Pelanggan membuka `/` dan petugas masuk melalui `/petugas`. Pesan baru muncul otomatis pada kedua layar.

## Menjalankan aplikasi

Gunakan Node.js 24 atau lebih baru. Aplikasi memakai SQLite bawaan Node.js.

```sh
cp .env.example .env
node -p "require('node:crypto').randomBytes(24).toString('hex')"
```

Simpan hasil perintah sebagai `JRCARE_SETUP_TOKEN` di `.env`, lalu jalankan `npm start`. Buka `http://127.0.0.1:3000/petugas`, masukkan token, dan pilih sandi untuk akun `admin`. Token dipakai untuk penyiapan pertama. Setelah akun dibuat, nilai token dapat dihapus dari konfigurasi.

## Alur petugas

1. Admin membuka **Akun agen**. Igun (`igun`), Meri (`meri`), dan Lingga (`lingga`) tersedia sejak penyiapan. Admin juga bisa menambahkan agen lewat **Buat akun**.
2. Admin memilih **Buat sandi sementara** dan menyampaikan kredensial ke agen. Agen masuk dengan sandi sementara lalu memilih sandi tetap.
3. Bagikan URL halaman utama melalui tombol **Salin tautan pelanggan**. Pesan pelanggan masuk ke **Kotak masuk → Antrean**.
4. Admin membuka percakapan dan memilih agen dari daftar **Tugaskan agen**. Agen melihat chat yang ditugaskan kepadanya, membalas, dan dapat menyelesaikan chat. Admin dapat melihat dan membalas semua chat.

## Balasan otomatis

Admin dapat mengubah pengaturan di **Balasan otomatis**. Sapaan awal aktif sejak penyiapan. Pesan di luar jam layanan dapat diaktifkan dengan hari dan jam layanan dalam WIB. Bila berlaku, pesan ini menggantikan sapaan pada awal chat. Untuk setiap pesan pelanggan, JRCare mengirim balasan dari kata atau frasa pertama yang cocok berdasarkan urutan aturan. Pencocokan mengabaikan huruf besar dan kecil.

## Menjalankan di server

Jalankan satu instance Node.js dengan direktori database persisten. Tentukan alamat HTTPS publik lewat `JRCARE_ORIGIN`, set `NODE_ENV=production`, dan teruskan HTTPS ke port aplikasi melalui reverse proxy. Gunakan `JRCARE_DATABASE` untuk menunjuk penyimpanan persisten bila direktori `./data/` bawaan tidak persisten. Aktifkan `JRCARE_TRUST_PROXY=1` hanya jika server hanya dapat dijangkau lewat reverse proxy yang mengganti header `X-Real-IP` dengan IP klien.

Setelah server berjalan, bagikan URL HTTPS halaman utama ke pelanggan. Sesi chat pelanggan tersimpan pada browser yang sama dan riwayatnya tersimpan di database.
