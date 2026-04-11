import dotenv from 'dotenv';
import bcrypt from 'bcryptjs';

// Load environment variables
dotenv.config();

// ============ KONFIGURASI KEAMANAN ============
// GANTI API KEY INI DENGAN YANG LEBIH AMAN!
export const API_KEY = process.env.WA_API_KEY || 'your-secret-api-key-change-this-2026';

// Session secret untuk cookie
export const SESSION_SECRET = process.env.WA_SESSION_SECRET || 'session-secret-change-this-2026';

// User credentials untuk login dashboard
// Password akan di-hash saat pertama kali dijalankan
export const ADMIN_USERS = [
    {
        username: process.env.ADMIN_USERNAME || 'admin',
        // Default password: admin123 (sudah di-hash)
        // Untuk generate password baru, jalankan: node scripts/generate-password.js
        password: process.env.ADMIN_PASSWORD_HASH || '$2b$10$3IoAGnXBNydtvSHKaLrGeOrUcWKIlEkl2S0JDtd.LaIeji2gcgSA6',
        name: process.env.ADMIN_NAME || 'Administrator'
    }
];

// Konfigurasi session
export const SESSION_CONFIG = {
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
        secure: false, // Set true jika menggunakan HTTPS
        maxAge: 24 * 60 * 60 * 1000, // 24 jam
        httpOnly: true, // Mencegah XSS
        sameSite: 'strict' // Mencegah CSRF
    }
};

// Fungsi untuk hash password
export const hashPassword = async (password) => {
    const salt = await bcrypt.genSalt(10);
    return await bcrypt.hash(password, salt);
};

// Fungsi untuk verify password
export const verifyPassword = async (password, hash) => {
    return await bcrypt.compare(password, hash);
};

// Fungsi untuk generate API key baru
export const generateApiKey = () => {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let result = '';
    for (let i = 0; i < 64; i++) {
        result += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return result;
};
