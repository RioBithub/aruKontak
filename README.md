# aruKontak · JRCare

Live chat web Jasa Raharja Care untuk menerima pertanyaan pelanggan saat kanal WhatsApp Mekari Qontak terganggu. Pelanggan membuka `/` dan petugas masuk melalui `/petugas`. Pesan baru muncul otomatis pada kedua layar.

Pelanggan memasukkan nomor telepon dan dapat menambahkan email saat memulai chat. Kontak tersedia di detail percakapan bagi admin dan agen yang ditugaskan.

Pelanggan dan petugas dapat mengirim satu lampiran PDF, JPG, PNG, atau WebP per pesan. Browser mengecilkan foto dan mengemas PDF secara lossless sebelum dikirim. Batas lampiran adalah 8 MB setelah foto dikompres. Lampiran tersimpan bersama percakapan dan dapat diunduh dari riwayat.

Setiap percakapan memiliki tautan dan kode sendiri. Pelanggan dapat membuka tautan di perangkat lain atau memasukkan kode lewat **Cek chat**. Setelah mengonfirmasi **Tinggalkan chat**, pelanggan dapat memilih **Kembali ke chat** dari browser yang sama selama 24 jam. Petugas tetap dapat membalas dari kotak masuk. Tautan dan kode tersedia untuk membuka riwayat setelah chat selesai atau pilihan kembali berakhir.

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
3. Bagikan URL halaman utama melalui tombol **Salin tautan pelanggan**. Setelah balasan bot kedua, chat mendapat agen otomatis atau menunggu di **Kotak masuk → Antrean**.
4. Agen melihat, membalas, dan menyelesaikan chat yang ditugaskan kepadanya. Admin bisa melihat dan membalas semua chat, mengganti agen, menahan chat, dan membuka **Riwayat penugasan**.

## Penugasan otomatis

Pengaturan awal mengaktifkan penugasan otomatis dengan kapasitas tiga chat aktif per agen. Agen mulai menerima chat setelah mengaktifkan akun dan membuka portal. Mereka bisa menjeda chat baru lewat **Terima chat otomatis** sambil tetap menangani chat yang sudah diterima. Admin bisa mengatur kapasitas 1–20 chat per agen dan menyalakan atau mematikan penugasan di **Akun agen**.

Chat tertua di antrean diutamakan. JRCare memilih agen siap dengan rasio chat aktif terhadap kapasitas terendah. Jika rasionya sama, agen yang sudah paling lama tidak mendapat penugasan dipilih dulu. Chat menunggu jika semua agen jeda, offline, atau penuh.

Jika portal tidak mengirim sinyal selama 90 detik, agen dianggap offline. Chat otomatis yang belum pernah mendapat balasan petugas kembali ke antrean. Chat yang sudah dijawab dan chat yang dipilih admin tetap di agen semula. Sistem memeriksa antrean setiap 15 detik dan langsung mengisinya saat agen siap atau slot terbuka. Admin dapat memilih **Tahan di antrean** untuk menahan satu chat dan **Antrean otomatis** untuk melepaskannya kembali.

## Balasan otomatis

Alur awal mengirim dua balasan otomatis. Chat baru menerima sapaan dan pilihan layanan dalam satu pesan. Pilihan layanan atau pertanyaan berikutnya memicu satu pesan berisi format data dan pesan tunggu. Pada saat itu chat masuk antrean agen. Pelanggan bisa langsung melengkapi data atau meneruskan obrolan dengan petugas.

**Saran pesan** mengisi draf yang bisa diedit sebelum chat dimulai. Pelanggan bisa memilih **Ulangi topik** selama chat masih ditangani bot atau masih menunggu agen. Pilihan sebelumnya tetap tercatat dalam riwayat.

Di **Diagram alur**, admin dapat menggeser dan menyambungkan blok pesan, pilihan, pengumpulan jawaban, kondisi, penugasan, dan penyelesaian chat. Kondisi dapat memeriksa jam kerja WIB, isi pesan terakhir, kontak, atau jawaban tersimpan. Gunakan variabel seperti `{{name}}` dan `{{nomor_pengajuan}}` di dalam balasan. Jawaban yang dikumpulkan terlihat di detail chat petugas. Pada blok penugasan, admin dapat menetapkan agen prioritas. Sistem memakai antrean biasa jika agen tersebut belum siap.

**Uji alur** menjalankan draf memakai mesin bot yang sama di percakapan uji. **Simpan draf** menyimpan perubahan untuk diedit lagi. **Terbitkan alur** memakai versi tersebut untuk chat baru. Percakapan berjalan menyimpan diagram dan jadwal yang berlaku saat chat dimulai. **Pakai template dua bubble** memuat kembali susunan awal ke draf.

Di **Balasan otomatis**, admin bisa mengatur jam layanan, pemberitahuan luar jam, atau beralih ke mode dua balasan dan aturan kata kunci.

## Menjalankan di VPS

Untuk `helpdesk-jrcare.aruraharja.co.id`, gunakan [panduan dan installer HestiaCP](deploy/hestia/README.md). Keduanya mencakup layanan systemd, reverse proxy Nginx, HTTPS, dan database persisten.

### Konfigurasi server Node.js lain

Jalankan satu instance Node.js dengan direktori database persisten. Tentukan alamat HTTPS publik lewat `JRCARE_ORIGIN`, set `NODE_ENV=production`, dan teruskan HTTPS ke port aplikasi melalui reverse proxy. Izinkan permintaan hingga 12 MB untuk kiriman lampiran. Nonaktifkan buffering respons untuk `/api/visitor/events` dan `/api/staff/events` agar pembaruan Server-Sent Events langsung diteruskan. Browser mengambil pembaruan lewat API saat koneksi push sedang tersambung ulang. Gunakan `JRCARE_DATABASE` untuk menunjuk penyimpanan persisten bila direktori `./data/` bawaan tidak persisten. Aktifkan `JRCARE_TRUST_PROXY=1` hanya jika server hanya dapat dijangkau lewat reverse proxy yang mengganti header `X-Real-IP` dengan IP klien.

Setelah server berjalan, bagikan URL HTTPS halaman utama ke pelanggan. Sesi chat pelanggan tersimpan pada browser yang sama dan riwayatnya tersimpan di database.
