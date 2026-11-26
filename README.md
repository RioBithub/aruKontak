# aruKontak · JRCare

Live chat web Jasa Raharja Care untuk menerima pertanyaan pelanggan saat kanal WhatsApp Mekari Qontak terganggu. Pelanggan membuka `/` dan petugas masuk melalui `/petugas`. Pesan baru muncul otomatis pada kedua layar.

Setiap percakapan memiliki tautan dan kode sendiri. Pelanggan dapat membuka tautan di perangkat lain atau memasukkan kode lewat **Cek chat**. Saat chat selesai, tautan tetap membuka seluruh riwayat. **Cek chat** juga menampilkan percakapan yang dimulai di browser tersebut selama sesi pelanggan tersimpan.

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
3. Bagikan URL halaman utama melalui tombol **Salin tautan pelanggan**. Pesan masuk mendapat agen otomatis atau menunggu di **Kotak masuk → Antrean**.
4. Agen melihat, membalas, dan menyelesaikan chat yang ditugaskan kepadanya. Admin bisa melihat dan membalas semua chat, mengganti agen, menahan chat, dan membuka **Riwayat penugasan**.

## Penugasan otomatis

Pengaturan awal mengaktifkan penugasan otomatis dengan kapasitas tiga chat aktif per agen. Agen mulai menerima chat setelah mengaktifkan akun dan membuka portal. Mereka bisa menjeda chat baru lewat **Terima chat otomatis** sambil tetap menangani chat yang sudah diterima. Admin bisa mengatur kapasitas 1–20 chat per agen dan menyalakan atau mematikan penugasan di **Akun agen**.

Chat tertua di antrean diutamakan. JRCare memilih agen siap dengan rasio chat aktif terhadap kapasitas terendah. Jika rasionya sama, agen yang sudah paling lama tidak mendapat penugasan dipilih dulu. Chat menunggu jika semua agen jeda, offline, atau penuh.

Jika portal tidak mengirim sinyal selama 90 detik, agen dianggap offline. Chat otomatis yang belum pernah mendapat balasan petugas kembali ke antrean. Chat yang sudah dijawab dan chat yang dipilih admin tetap di agen semula. Sistem memeriksa antrean setiap 15 detik dan langsung mengisinya saat agen siap atau slot terbuka. Admin dapat memilih **Tahan di antrean** untuk menahan satu chat dan **Antrean otomatis** untuk melepaskannya kembali.

## Balasan otomatis

Admin dapat mengubah pengaturan di **Balasan otomatis**. Sapaan awal aktif sejak penyiapan. Pesan di luar jam layanan dapat diaktifkan dengan hari dan jam layanan dalam WIB. Bila berlaku, pesan ini menggantikan sapaan pada awal chat.

Di **Menu dan penerusan ke agen**, pilih pencocokan **Sama persis** untuk jawaban seperti `1` atau `0`, atau pilih kata atau frasa yang perlu ada dalam pesan. JRCare menjalankan aturan pertama yang cocok. Setiap aturan dapat membalas saja atau membalas dan meneruskan chat ke antrean agen. **Pakai contoh menu** mengisi contoh yang dapat disunting sebelum disimpan.

Chat dapat masuk antrean sejak pesan pertama atau menunggu di balasan otomatis sampai ada aturan penerusan. Admin juga dapat memilih agar pertanyaan yang tidak cocok langsung masuk antrean. Dalam alur yang menunggu penerusan, balasan aturan berhenti setelah chat masuk antrean agar agen dapat melanjutkan percakapan.

## Menjalankan di VPS

Untuk `helpdesk-jrcare.aruraharja.co.id`, gunakan [panduan dan installer HestiaCP](deploy/hestia/README.md). Keduanya mencakup layanan systemd, reverse proxy Nginx, HTTPS, dan database persisten.

### Konfigurasi server Node.js lain

Jalankan satu instance Node.js dengan direktori database persisten. Tentukan alamat HTTPS publik lewat `JRCARE_ORIGIN`, set `NODE_ENV=production`, dan teruskan HTTPS ke port aplikasi melalui reverse proxy. Nonaktifkan buffering respons untuk `/api/visitor/events` dan `/api/staff/events` agar pembaruan Server-Sent Events langsung diteruskan. Gunakan `JRCARE_DATABASE` untuk menunjuk penyimpanan persisten bila direktori `./data/` bawaan tidak persisten. Aktifkan `JRCARE_TRUST_PROXY=1` hanya jika server hanya dapat dijangkau lewat reverse proxy yang mengganti header `X-Real-IP` dengan IP klien.

Setelah server berjalan, bagikan URL HTTPS halaman utama ke pelanggan. Sesi chat pelanggan tersimpan pada browser yang sama dan riwayatnya tersimpan di database.
