## [Unreleased]

### Added
- Menambahkan `Dockerfile`, `.dockerignore`, dan `compose.yaml` untuk menjalankan API pada container Node.js 22 dengan health check dan proses non-root.
- Menambahkan service PostgreSQL 17 pada Docker Compose, persistent volume, health check, dan inisialisasi tabel cache otomatis.
- Menambahkan Adminer 6 sebagai UI pengelolaan PostgreSQL lokal pada port yang dapat dikonfigurasi.
- Menambahkan polling AI ICDX otomatis saat container API dimulai dan setiap interval yang dikonfigurasi.
- Menambahkan container worker `endpo-nm23-scraper` khusus agar proses dan log scraping ICDX dapat dipantau terpisah dari API.
- Menambahkan ekstraksi AI berbasis OpenAI Responses API dan Structured Outputs untuk artikel Press Release ICDX terbaru.
- Menambahkan endpoint raw `/api/newsmaker-v2/icdx/press-release/raw` untuk kompatibilitas dan debugging scraper lama.
- Menambahkan konfigurasi `OPENAI_API_KEY` dan `OPENAI_MODEL` pada contoh environment.

### Changed
- Menaikkan cakupan scraper ICDX menjadi 50 artikel dan memprosesnya dalam batch AI dengan deduplikasi global serta toleransi kegagalan per batch.
- Memperluas ekstraksi AI ICDX dari satu artikel terbaru menjadi agregasi hingga 20 artikel dari beberapa halaman daftar, lengkap dengan deduplikasi data.
- Mengganti driver cache database dari `@vercel/postgres` ke `pg` agar mendukung PostgreSQL lokal di Docker serta koneksi PostgreSQL eksternal.
- Menambahkan konfigurasi runtime OpenAI dan PostgreSQL lokal pada environment Docker tanpa mengganti koneksi database eksternal untuk eksekusi di luar Docker.
- Menyimpan hasil ekstraksi AI ICDX ke PostgreSQL dan menggunakan cache database untuk request endpoint berikutnya.
- Memindahkan polling ICDX pada Docker dari container API ke container scraper khusus untuk mencegah job ganda.
- Mengubah endpoint `/api/newsmaker-v2/icdx/press-release` agar menghasilkan struktur JSON volume komoditas yang ketat, lengkap dengan metadata waktu, token MD5 unik, dan status cache.
- Menambahkan OpenAI SDK sebagai dependency aplikasi.

### Fixed
- Menormalisasi `raw_y` menjadi string desimal lima digit dan menyelaraskannya dengan nilai numerik `volume`.
- Memperlakukan teks hasil scraping sebagai input tidak tepercaya untuk mengurangi risiko prompt injection dari konten halaman.
