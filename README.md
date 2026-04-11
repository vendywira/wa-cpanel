# WhatsApp API Baileys dengan Dashboard & Keamanan

API WhatsApp menggunakan Baileys dengan Dashboard web yang modern dan sistem keamanan berlapis.

## 🔐 Sistem Keamanan

### 1. **Autentikasi Dashboard (Session-based)**
- Login menggunakan username & password
- Session cookie dengan enkripsi
- Default: username `admin`, password `admin123`

### 2. **API Key Protection**
- Semua endpoint API dilindungi dengan API key
- API key bisa dikirim via header atau query parameter
- Default API Key: `your-secret-api-key-change-this-2026`

## 🚀 Cara Menjalankan

```bash
node index.js
```

Server akan berjalan di: **http://localhost:3000**

## 📱 Fitur Dashboard

### 1. **Login Page**
- Halaman login yang aman dengan bcrypt password hash
- Session management otomatis

### 2. **Status Monitoring**
- Status koneksi WhatsApp (Connected/Disconnected)
- Nomor telepon yang terhubung
- Status registrasi
- Uptime server

### 3. **Pairing Code dengan Modal Popup**
- Dapatkan pairing code dengan tampilan modal yang menarik
- Instruksi lengkap cara menghubungkan WhatsApp
- Tombol salin kode ke clipboard
- Countdown timer untuk masa berlaku kode

### 4. **Kirim Pesan**
- ✅ **Pesan Teks** - Kirim pesan teks ke nomor WhatsApp
- 🖼️ **Gambar** - Kirim gambar dari URL dengan caption opsional
- 📎 **Dokumen** - Kirim dokumen (PDF, DOC, XLS, dll) dari path lokal

### 5. **Logout**
- Putuskan sesi WhatsApp

## 📋 API Endpoints

Semua endpoint API dilindungi dengan **API Key**:

| Endpoint | Deskripsi | Auth |
|----------|-----------|------|
| `GET /login` | Halaman Login | Public |
| `POST /api/auth/login` | Login endpoint | Public |
| `POST /api/auth/logout` | Logout dashboard | Session |
| `GET /dashboard` | Dashboard Web | Session |
| `GET /api/status` | Cek status koneksi | API Key |
| `GET /api/send-text?to=62xxx&message=Hello` | Kirim pesan teks | API Key |
| `GET /api/send-image?to=62xxx&image=URL&caption=Text` | Kirim gambar | API Key |
| `GET /api/send-document?to=62xxx&document=/path/file.pdf&filename=file.pdf` | Kirim dokumen | API Key |
| `GET /api/pair?phone=62xxx` | Buat pairing code | API Key |
| `GET /api/logout` | Logout dari WhatsApp | API Key |

## 🔑 Cara Menggunakan API

### Metode 1: Header (Recommended)
```bash
curl -H "X-API-Key: your-secret-api-key-change-this-2026" \
     "http://localhost:3000/api/status"
```

### Metode 2: Query Parameter
```bash
curl "http://localhost:3000/api/status?api_key=your-secret-api-key-change-this-2026"
```

### Contoh Kirim Pesan
```bash
curl -H "X-API-Key: your-secret-api-key-change-this-2026" \
     "http://localhost:3000/api/send-text?to=6281234567890&message=Halo"
```

## ⚙️ Konfigurasi Keamanan

### 1. Ganti Default Credentials

**Buat file `.env`** (copy dari `.env.example`):
```bash
cp .env.example .env
```

**Edit `.env`:**
```env
# API Key untuk mengakses API endpoints
WA_API_KEY=ganti-dengan-api-key-yang-lebih-aman

# Session Secret untuk cookie encryption
WA_SESSION_SECRET=ganti-dengan-secret-yang-lebih-aman

# Admin credentials
ADMIN_USERNAME=admin
ADMIN_PASSWORD_HASH=$2b$10$...  # Generate dengan script di bawah
ADMIN_NAME=Administrator
```

### 2. Generate Password Hash Baru

```bash
node scripts/generate-password.js
```

Script ini akan memandu Anda membuat password hash yang aman.

### 3. Generate API Key Baru

```bash
node -e "console.log(require('crypto').randomBytes(64).toString('hex'))"
```

Copy hasilnya ke `.env` sebagai `WA_API_KEY`.

## 🎨 Teknologi

- **Backend**: Express.js + Baileys
- **Frontend**: Bootstrap 5 + Vanilla JavaScript
- **Template**: EJS
- **Security**: 
  - bcryptjs (password hashing)
  - express-session (session management)
  - cookie-parser (cookie handling)
  - API key authentication

## 📝 Catatan Keamanan

- ✅ Password di-hash dengan bcrypt (salt rounds: 10)
- ✅ Session cookie dienkripsi dan httpOnly
- ✅ API key validation di semua endpoint
- ✅ CORS headers dikonfigurasi
- ✅ Tidak ada hard-coded credentials di production
- ⚠️ **PENTING**: Ganti semua default credentials sebelum deploy ke production!
- ⚠️ File `.env` sudah di-gitignore, jangan commit ke repository!

## 🛡️ Best Practices

1. **Ganti semua default credentials** sebelum deploy
2. **Gunakan HTTPS** di production
3. **Rotate API key** secara berkala
4. **Monitor logs** untuk aktivitas mencurigakan
5. **Gunakan environment variables** untuk credentials sensitif
6. **Backup** file `.env` di tempat yang aman

## 📝 Catatan

- Pastikan WhatsApp Anda sudah terhubung sebelum mengirim pesan
- Untuk dokumen, gunakan path absolut (contoh: `/Users/name/file.pdf`)
- Pairing code berlaku selama 2-3 menit
