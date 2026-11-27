# Deploy JRCare dengan HestiaCP

Domain pelanggan adalah `https://helpdesk-jrcare.aruraharja.co.id/`. Admin dan agen membuka `/petugas` pada domain tersebut.

## Pasang layanan di VPS

Gunakan VPS Debian atau Ubuntu yang sudah menjalankan HestiaCP dengan Nginx, baik proxy Nginx di depan Apache maupun Nginx mandiri. Pastikan domain mengarah ke VPS dan `git`, `curl`, serta `systemd` tersedia.

```sh
git clone https://github.com/RioBithub/aruKontak.git
cd aruKontak
sudo bash deploy/hestia/install.sh
```

Installer menjalankan satu layanan `jrcare` melalui systemd pada `127.0.0.1:7310`, menyediakan template `jrcare-node` untuk Hestia, dan menyimpan database di `/var/lib/jrcare/jrcare.sqlite`. Konfigurasi dan token penyiapan awal dibuat di `/etc/jrcare/jrcare.env`. Menjalankan installer kembali memakai database dan konfigurasi yang sudah ada.

JRCare memerlukan Node.js 24+ dengan `node:sqlite`. Jika VPS memakai Node.js 20 atau runtime global lain yang belum kompatibel, installer mengunduh Node.js 24.22.3 resmi untuk Linux x64 atau arm64, memeriksa SHA-256, dan menyimpannya di `/opt/jrcare/runtime/`. Layanan `jrcare` memakai runtime tersebut lewat `/opt/jrcare/node`.

## Kaitkan domain dan HTTPS

1. Di **Web** HestiaCP, buka `helpdesk-jrcare.aruraharja.co.id` atau tambahkan sebagai **Web Domain** jika belum ada.
2. Di **Advanced Options**, pilih `jrcare-node` pada **Proxy Template** untuk Nginx + Apache atau **Web Template Nginx** untuk Nginx mandiri. Simpan perubahan.
3. Pertahankan sertifikat HTTPS yang sudah mencakup `helpdesk-jrcare.aruraharja.co.id`. Jika sertifikat belum tersedia atau `curl` melaporkan nama host tidak cocok, terbitkan sertifikat melalui **SSL** dan **Use Let’s Encrypt**. Aktifkan pengalihan ke HTTPS setelah pemeriksaan HTTPS berhasil.
4. Jalankan pemeriksaan ini dari VPS atau dari komputer Anda.

   ```sh
   curl -fsS https://helpdesk-jrcare.aruraharja.co.id/healthz
   ```

   Respons yang diharapkan adalah `{"status":"ok","service":"jrcare"}`. Periksa `sudo nginx -t` dan `sudo journalctl -u jrcare -n 80` jika domain masih menampilkan halaman bawaan atau gateway error.

Referensi HestiaCP untuk [template dan rebuild domain](https://hestiacp.com/docs/server-administration/web-templates) dan [sertifikat web domain](https://hestiacp.com/docs/user-guide/web-domains).

Di VPS Nginx + Apache dengan domain yang sudah dibuat atas user Hestia `aru`, template proxy juga bisa diterapkan dari terminal setelah installer berhasil.

```sh
sudo /usr/local/hestia/bin/v-change-web-domain-proxy-tpl aru helpdesk-jrcare.aruraharja.co.id jrcare-node '' no &&
sudo nginx -t && sudo systemctl reload nginx &&
curl -fsS http://127.0.0.1:7310/healthz
```

Jika HTTPS masih menampilkan sertifikat domain lain, terbitkan sertifikat Let's Encrypt untuk hostname JRCare melalui Hestia. Gunakan nama domain yang sama saat menguji sertifikat dan layanan.

```sh
sudo /usr/local/hestia/bin/v-add-letsencrypt-domain aru helpdesk-jrcare.aruraharja.co.id '' &&
sudo nginx -t && sudo systemctl reload nginx &&
curl -fsS https://helpdesk-jrcare.aruraharja.co.id/healthz
```

## Siapkan akun dan coba chat

1. Tampilkan tautan aktivasi di terminal VPS yang hanya dapat diakses pengelola. Buka tautan tersebut untuk memilih sandi minimal 12 karakter bagi akun `admin`. Tautan hanya dapat dipakai untuk membuat admin pertama.

   ```sh
   sudo /opt/jrcare/node --env-file=/etc/jrcare/jrcare.env -p 'new URL("/petugas#siapkan=" + encodeURIComponent(process.env.JRCARE_SETUP_TOKEN), process.env.JRCARE_ORIGIN).href'
   ```

2. Di **Akun agen**, buat sandi sementara untuk Igun, Meri, dan Lingga. Setiap agen masuk dan menentukan sandi tetapnya. Menukar akun di satu browser akan mengganti sesi, jadi gunakan profil browser berbeda saat menguji beberapa peran.
3. Isi nomor telepon pada chat contoh, lalu pilih layanan. Cek kedua balasan bot, penugasan agen, dan kontak di kotak masuk. Kirim lampiran dari kedua sisi, lalu coba tinggalkan dan buka lagi chat dari browser yang sama.
4. Edit dan uji automasi melalui **Diagram alur**. Atur jam layanan WIB di **Balasan otomatis**.

## Perbarui dan cadangkan

Gunakan `git pull --ff-only` dari checkout, kemudian jalankan ulang installer. Installer memeriksa layanan dari loopback setelah berpindah rilis dan mengembalikan rilis sebelumnya jika pemeriksaan gagal. Data SQLite berada di luar direktori rilis. Jika template Nginx berubah di versi berikutnya, simpan ulang pengaturan domain di Hestia untuk membangun ulang konfigurasinya.

Untuk cadangan konsisten saat layanan aktif, jalankan perintah berikut jika CLI `sqlite3` sudah terpasang di VPS.

```sh
sudo sh -c 'umask 077
backup="/root/jrcare-$(date -u +%Y%m%dT%H%M%SZ).sqlite"
sqlite3 /var/lib/jrcare/jrcare.sqlite ".backup $backup"'
```

Cadangan mencakup percakapan, pengaturan, dan akun. Simpan cadangan dengan akses terbatas.
