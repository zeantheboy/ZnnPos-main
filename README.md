# ZnnCashier – Smart Retail Checkout System

A full-stack, futuristic desktop Point of Sale (POS) application built with React, Node.js, PostgreSQL, and Electron.

## Database yang digunakan

ZnnCashier menggunakan **PostgreSQL sebagai database runtime utama**.

- Database lokal default: `postgresql://imac@localhost:5432/znnpos`
- Override database lokal dengan environment variable `LOCAL_DATABASE_URL`.
- Jika `LOCAL_DATABASE_URL` tidak diisi, backend memakai `DATABASE_URL` sebagai fallback.
- Sinkronisasi ke Supabase bersifat opsional dan memakai `REMOTE_DATABASE_URL` atau `SUPABASE_DATABASE_URL` bersama `SUPABASE_URL` dan `SUPABASE_ANON_KEY`.
- `sqlite3` dan `backend/migrate-sqlite-to-postgres.js` hanya dipakai untuk migrasi satu kali dari database SQLite lama. SQLite bukan database yang dipakai saat aplikasi berjalan normal.
- `database_backup.sql` adalah dump PostgreSQL.

## Features Added
- **Modern User Interface:** Dark/Light theme toggling, clean product layout, cart management.
- **Intelligent Barcode Scanner:** 
    - Use your smartphone as a wireless barcode scanner over your local network.
    - Scans are transmitted via WebSockets in real-time.
    - **Smart Registration:** If you scan a barcode that isn't in your database, the POS auto-prompts you to register the name, price, and stock!
- **Inventory Management:** Full view of all registered products with low-stock warnings.
- **Analytics Dashboard:** Keep track of daily revenue, total transactions, and alerts.
- **Checkout & Receipt:** Process customer payments, calculate change, and print a custom receipt natively.
- **Multi-Toko:** Setiap toko memiliki kode toko dan ruang data terpisah untuk pengguna, produk, stok, transaksi, dan laporan.

## How to Run the App Easily
You can now start the entire application by simply double-clicking the launcher file in the root folder, or running:
```bash
npm start
```
Before starting, make sure the PostgreSQL service is running and the `znnpos` database is available. Nama database tetap `znnpos` agar instalasi dan data lama tidak berubah. This command starts the PostgreSQL-backed backend, starts the React frontend, and launches the Electron desktop app sequentially.

Untuk memindahkan data dari database SQLite lama ke PostgreSQL, gunakan:
```bash
SOURCE_DB=/path/ke/pos.db TARGET_DATABASE_URL=postgresql://user:password@host:5432/znnpos npm run migrate:legacy-sqlite
```

## How to open POS and scanner on HP

Pastikan komputer POS dan HP terhubung ke Wi-Fi yang sama. Di aplikasi desktop, klik tombol **Buka POS / Scanner HP**.

- **LINK UTAMA — Buka POS lengkap di HP:** `https://IP_KOMPUTER:3002/`
- **LINK SCANNER BARCODE SAJA:** `https://IP_KOMPUTER:3002/scanner`

Scan QR pada bagian **LINK UTAMA** jika Anda ingin menjalankan kasir langsung dari HP. Scan atau salin link **LINK SCANNER BARCODE SAJA** jika HP hanya dipakai sebagai pemindai barcode untuk komputer.

POS lengkap di HP tersedia setelah frontend dibuat dengan `npm run build:frontend`. Jika hanya ingin memindai barcode, link `/scanner` dapat digunakan tanpa membuka POS lengkap.

## Multi-toko

Data lama otomatis ditempatkan pada toko **Toko Utama** dengan kode `utama`. Super Admin dapat membuka menu **Toko** untuk membuat toko baru dan akun pemiliknya. Pemilik atau pengguna toko masuk menggunakan kombinasi kode toko, username, dan PIN masing-masing.

Nama toko dapat diubah oleh Super Admin melalui **Pengaturan > Nama Toko**. Nama tersebut akan tampil bersama identitas **ZnnCashier** pada nota belanja, laporan A4, dan cetak barcode.

Setiap toko memiliki batas awal **3 akun aktif**. Toko Utama dapat menyesuaikan batas pengguna setiap toko melalui **Toko > Batas Pengguna Toko**. Untuk menambah akun setelah batas tercapai, naikkan kuota toko terlebih dahulu.

Data transaksi penjualan lebih lama dari **2 bulan** dibersihkan otomatis mulai tanggal **1 setiap bulan**. Rincian transaksi, item transaksi, retur terkait, serta jejak stok dan audit yang terkait dengan transaksi lama ikut dibersihkan. Jika aplikasi sedang mati pada tanggal 1, proses akan mengejar pembersihan tersebut saat aplikasi berikutnya aktif.

## Cara menggunakan scanner mobile
Scanner berjalan melalui jaringan lokal komputer POS.

1. Hubungkan komputer POS dan HP ke **Wi-Fi yang sama**.
2. Buka aplikasi ZnnCashier Desktop, lalu klik **"Buka POS / Scanner HP"**.
3. Untuk membuka POS lengkap, scan QR pada bagian **LINK UTAMA**. Untuk scanner saja, gunakan link pada bagian **LINK SCANNER BARCODE SAJA**.
4. Jika browser HP menampilkan peringatan keamanan, pilih **Advanced** lalu **Proceed to 192.168... (unsafe)**.
5. Izinkan akses kamera jika diminta, lalu mulai scan produk.
6. Jika memakai Windows dan HP tidak terhubung, jalankan `fix-firewall.bat` sebagai Administrator. Jika memakai macOS, izinkan Node/Electron pada **System Settings > Network > Firewall > Options**.
# ZnnCashier
