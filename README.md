# Fiber Monitoring

Fiber Monitoring adalah aplikasi web untuk membantu memantau dan mengelola jaringan fiber optic secara visual melalui peta interaktif. Aplikasi ini dibuat untuk menampilkan titik jaringan seperti OLT, ODP, pole, dan client, serta jalur kabel antar titik agar proses monitoring dan pendataan jaringan lebih mudah dilakukan.

Project ini cocok digunakan untuk kebutuhan internal ISP kecil, jaringan RT/RW Net, atau dokumentasi jaringan fiber optic berbasis peta.

## Fitur Utama

* Menampilkan peta jaringan fiber optic secara interaktif
* Menampilkan node jaringan seperti OLT, ODP, pole, dan client
* Menampilkan jalur kabel backbone, distribusi, dan drop wire
* Menambahkan node jaringan langsung dari peta
* Menambahkan client dan mengambil titik koordinat dari peta
* Mengedit, menghapus, dan menggeser titik lokasi node/client
* Menampilkan status client online, offline, dan warning
* Menampilkan jalur kabel dengan mode visual ON/OFF
* Import data ODP dari file KML
* Backend API menggunakan Node.js dan Prisma
* Database menggunakan PostgreSQL dengan dukungan PostGIS
* Frontend menggunakan React, Vite, dan Leaflet

## Teknologi yang Digunakan

### Frontend

* React
* TypeScript
* Vite
* Leaflet
* React Leaflet
* Socket.IO Client

### Backend

* Node.js
* TypeScript
* Express.js
* Prisma ORM
* Socket.IO
* PostgreSQL
* PostGIS

### Deployment

* Docker
* PM2
* Nginx
* VPS Linux

## Struktur Folder

```txt
fiber-monitoring/
├── backend/
│   ├── prisma/
│   │   ├── schema.prisma
│   │   └── seed.ts
│   ├── src/
│   │   ├── monitoring/
│   │   ├── olt/
│   │   ├── scripts/
│   │   ├── server.ts
│   │   └── prisma.ts
│   ├── package.json
│   └── .env.example
│
├── frontend/
│   ├── src/
│   │   ├── components/
│   │   ├── App.tsx
│   │   └── style.css
│   ├── package.json
│   └── vite.config.ts
│
├── .gitignore
└── README.md
```

## Persiapan Environment

Sebelum menjalankan project, pastikan sudah menginstall:

* Node.js
* npm
* Docker
* PostgreSQL atau Docker PostgreSQL
* Git

## Konfigurasi Environment Backend

Buat file `.env` di dalam folder `backend`.

Contoh isi file `.env`:

```env
DATABASE_URL="postgresql://USER:PASSWORD@localhost:5433/fiber_monitoring?schema=public"

PORT=4000

MIKROTIK_HOST=""
MIKROTIK_USER=""
MIKROTIK_PASSWORD=""

OLT_HOST=""
OLT_USERNAME=""
OLT_PASSWORD=""

JWT_SECRET="change-this-secret"
```

Catatan:

* Jangan upload file `.env` ke GitHub.
* Gunakan `.env.example` sebagai contoh konfigurasi.
* Isi password, host, dan token hanya di file `.env` lokal atau server.

## Menjalankan Backend

Masuk ke folder backend:

```bash
cd backend
```

Install dependency:

```bash
npm install
```

Generate Prisma Client:

```bash
npx prisma generate
```

Jalankan migrasi database:

```bash
npx prisma migrate dev
```

Jalankan backend mode development:

```bash
npm run dev
```

Backend akan berjalan di:

```txt
http://localhost:4000
```

## Menjalankan Frontend

Masuk ke folder frontend:

```bash
cd frontend
```

Install dependency:

```bash
npm install
```

Jalankan frontend:

```bash
npm run dev
```

Frontend akan berjalan di:

```txt
http://localhost:5173
```

## Build Frontend

Untuk membuat versi production frontend:

```bash
cd frontend
npm run build
```

Hasil build akan berada di folder:

```txt
frontend/dist
```

## Build Backend

Untuk membuat versi production backend:

```bash
cd backend
npm run build
```

Hasil build akan berada di folder:

```txt
backend/dist
```

## Menjalankan Backend dengan PM2

Setelah backend berhasil di-build, jalankan dengan PM2:

```bash
pm2 start dist/server.js --name fiber-backend
```

Jika sudah pernah dibuat, restart dengan:

```bash
pm2 restart fiber-backend --update-env
```

Cek status PM2:

```bash
pm2 status
```

Cek log backend:

```bash
pm2 logs fiber-backend
```

## Import Data ODP dari KML

Project ini mendukung import data ODP dari file KML.

Contoh command:

```bash
cd backend
npx tsx src/scripts/importKmlOdps.ts imports/DataODPMayangKawis.kml
```

Catatan penting:

* File KML biasanya berisi data koordinat jaringan.
* Jangan upload file KML asli ke repository public.
* Simpan file KML hanya di lokal atau server pribadi.

## File yang Tidak Boleh Di-upload

Beberapa file tidak boleh di-upload ke GitHub karena bisa berisi data sensitif:

```txt
.env
.env.local
.env.production
*.sql
backup_*.sql
backend/imports/*.kml
backend/imports/*.csv
backend/imports/*.json
node_modules
dist
```

Pastikan file tersebut sudah masuk ke `.gitignore`.

## Deployment Singkat ke VPS

### Backend

Masuk ke folder project di VPS:

```bash
cd ~/fiber-monitoring
git pull
```

Install dan build backend:

```bash
cd backend
npm install
npx prisma generate
npm run build
pm2 restart fiber-backend --update-env
```

### Frontend

Build frontend:

```bash
cd ~/fiber-monitoring/frontend
npm install
npm run build
```

Copy hasil build ke folder Nginx:

```bash
sudo rm -rf /var/www/fiber-monitoring/*
sudo cp -r dist/* /var/www/fiber-monitoring/
sudo chown -R www-data:www-data /var/www/fiber-monitoring
sudo systemctl restart nginx
```

## Contoh Konfigurasi Nginx

```nginx
server {
    listen 80;
    server_name _;

    root /var/www/fiber-monitoring;
    index index.html;

    location / {
        try_files $uri $uri/ /index.html;
    }

    location /api/ {
        proxy_pass http://127.0.0.1:4000/api/;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }

    location /socket.io/ {
        proxy_pass http://127.0.0.1:4000/socket.io/;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
    }
}
```

## Keamanan

Project ini dapat digunakan untuk data jaringan nyata, sehingga perlu memperhatikan keamanan:

* Jangan upload file `.env`
* Jangan upload password database
* Jangan upload password MikroTik atau OLT
* Jangan upload file KML yang berisi lokasi aset jaringan asli
* Jangan upload backup database
* Gunakan repository private jika data masih berisi informasi sensitif

## Status Project

Project ini masih dalam tahap pengembangan dan dapat dikembangkan lebih lanjut, seperti:

* Login dan role user
* Dashboard statistik jaringan
* Monitoring ping otomatis
* Monitoring PPPoE
* Monitoring OLT
* Export laporan jaringan
* Notifikasi client offline
* Riwayat perubahan status client

## Lisensi

Project ini dapat digunakan dan dikembangkan sesuai kebutuhan. Jika digunakan untuk produksi, pastikan konfigurasi keamanan, database, dan akses server sudah disesuaikan.
