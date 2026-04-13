import dotenv from 'dotenv';
import {
    default as makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    Browsers,
    fetchLatestBaileysVersion,
    makeCacheableSignalKeyStore
} from '@whiskeysockets/baileys';
import P from 'pino';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import express from 'express';
import { Server as SocketIO } from 'socket.io';
import session from 'express-session';
import cookieParser from 'cookie-parser';
import readline from 'readline';
import { SESSION_CONFIG, API_KEY } from './config/auth.js';
import { verifyApiKey, requireAuth, login } from './middleware/auth.js';

// Load environment variables
dotenv.config();

// ============ KONFIGURASI AWAL ============
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const logger = P({ level: 'info' });

// Variabel global
let sock = null;
let isConnected = false;
let pairingRequested = false;
let reconnectAttempts = 0;
let currentQR = null; // Simpan QR code string
const MAX_RECONNECT_ATTEMPTS = 10;

// Express app setup
const app = express();
app.use(express.json());
app.use(cookieParser());
app.use(session(SESSION_CONFIG));
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// CORS headers
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type, X-API-Key');
    if (req.method === 'OPTIONS') {
        res.sendStatus(200);
    } else {
        next();
    }
});

// Serve static files
app.use(express.static(path.join(__dirname, 'public')));

// Readline interface untuk input terminal
const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
});
const question = (text) => new Promise((resolve) => rl.question(text, resolve));

// ============ FUNGSI KIRIM PESAN TEKS ============
export async function sendTextMessage(phoneNumber, message) {
    if (!isConnected || !sock) {
        throw new Error('WhatsApp belum terhubung');
    }
    
    let jid = phoneNumber;
    if (!jid.includes('@')) {
        let cleanNumber = phoneNumber.replace(/[^0-9]/g, '');
        if (cleanNumber.startsWith('0')) {
            cleanNumber = '62' + cleanNumber.substring(1);
        }
        if (!cleanNumber.startsWith('62')) {
            cleanNumber = '62' + cleanNumber;
        }
        jid = `${cleanNumber}@s.whatsapp.net`;
    }
    
    const [exists] = await sock.onWhatsApp(jid);
    if (!exists || !exists.exists) {
        throw new Error(`Nomor ${phoneNumber} tidak terdaftar di WhatsApp`);
    }
    
    const result = await sock.sendMessage(exists.jid, { text: message });
    console.log(`✅ Pesan terkirim ke ${phoneNumber}: ${message}`);
    return result;
}

// ============ FUNGSI KIRIM GAMBAR ============
export async function sendImageMessage(phoneNumber, imageSource, caption = '') {
    if (!isConnected || !sock) {
        throw new Error('WhatsApp belum terhubung');
    }
    
    let jid = phoneNumber;
    if (!jid.includes('@')) {
        let cleanNumber = phoneNumber.replace(/[^0-9]/g, '');
        if (cleanNumber.startsWith('0')) {
            cleanNumber = '62' + cleanNumber.substring(1);
        }
        if (!cleanNumber.startsWith('62')) {
            cleanNumber = '62' + cleanNumber;
        }
        jid = `${cleanNumber}@s.whatsapp.net`;
    }
    
    const [exists] = await sock.onWhatsApp(jid);
    if (!exists || !exists.exists) {
        throw new Error(`Nomor ${phoneNumber} tidak terdaftar di WhatsApp`);
    }
    
    let imageData;
    if (typeof imageSource === 'string') {
        if (imageSource.startsWith('http://') || imageSource.startsWith('https://')) {
            imageData = { url: imageSource };
        } else if (fs.existsSync(imageSource)) {
            imageData = fs.readFileSync(imageSource);
        } else {
            throw new Error('Image source tidak valid');
        }
    } else if (Buffer.isBuffer(imageSource)) {
        imageData = imageSource;
    } else {
        throw new Error('Image source harus URL, path file, atau buffer');
    }
    
    const result = await sock.sendMessage(exists.jid, {
        image: imageData,
        caption: caption
    });
    
    console.log(`✅ Gambar terkirim ke ${phoneNumber}${caption ? `: ${caption}` : ''}`);
    return result;
}

// ============ FUNGSI KIRIM DOKUMEN ============
export async function sendDocumentMessage(phoneNumber, documentPath, fileName, caption = '') {
    if (!isConnected || !sock) {
        throw new Error('WhatsApp belum terhubung');
    }
    
    let jid = phoneNumber;
    if (!jid.includes('@')) {
        let cleanNumber = phoneNumber.replace(/[^0-9]/g, '');
        if (cleanNumber.startsWith('0')) {
            cleanNumber = '62' + cleanNumber.substring(1);
        }
        if (!cleanNumber.startsWith('62')) {
            cleanNumber = '62' + cleanNumber;
        }
        jid = `${cleanNumber}@s.whatsapp.net`;
    }
    
    const [exists] = await sock.onWhatsApp(jid);
    if (!exists || !exists.exists) {
        throw new Error(`Nomor ${phoneNumber} tidak terdaftar di WhatsApp`);
    }
    
    if (!fs.existsSync(documentPath)) {
        throw new Error(`File tidak ditemukan: ${documentPath}`);
    }
    
    const fileBuffer = fs.readFileSync(documentPath);
    const ext = path.extname(documentPath).toLowerCase();
    const mimeTypes = {
        '.pdf': 'application/pdf',
        '.doc': 'application/msword',
        '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        '.xls': 'application/vnd.ms-excel',
        '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        '.txt': 'text/plain',
        '.zip': 'application/zip',
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.png': 'image/png'
    };
    const mimeType = mimeTypes[ext] || 'application/octet-stream';
    
    const result = await sock.sendMessage(exists.jid, {
        document: fileBuffer,
        mimetype: mimeType,
        fileName: fileName || path.basename(documentPath),
        caption: caption
    });
    
    console.log(`✅ Dokumen terkirim ke ${phoneNumber}: ${fileName}`);
    return result;
}

// ============ FUNGSI KONEKSI WHATSAPP ============
async function connectToWhatsApp() {
    console.log('\n╔══════════════════════════════════════════════════════════════╗');
    console.log('║           WhatsApp API - Baileys v7 (Auto Version)           ║');
    console.log('╚══════════════════════════════════════════════════════════════╝\n');
    
    try {
        // Ambil versi terbaru dari WhatsApp
        const { version, isLatest } = await fetchLatestBaileysVersion();
        console.log(`📱 Versi WhatsApp API: ${version.join('.')} ${isLatest ? '(terbaru)' : '(update tersedia)'}`);
        
        // Load atau buat session
        const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');
        
        // Buat socket connection
        sock = makeWASocket({
            auth: {
                creds: state.creds,
                keys: makeCacheableSignalKeyStore(state.keys, logger)
            },
            logger: P({ level: 'silent' }),
            browser: Browsers.macOS('Chrome'),
            printQRInTerminal: false,
            markOnlineOnConnect: false,
            syncFullHistory: false,
            version: version,
            connectTimeoutMs: 60000,
            defaultQueryTimeoutMs: 60000,
            keepAliveIntervalMs: 25000,
            generateHighQualityLinkPreview: true
        });
        
        // ============ EVENT HANDLER ============
        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;

            // Simpan QR code terbaru
            if (qr) {
                currentQR = qr;
                console.log('\n📱 QR Code telah di-generate');
            }

            // Tampilkan QR jika ada (fallback method)
            if (qr && !sock.authState.creds.registered && !pairingRequested) {
                console.log('\n📱 QR Code tersedia (metode alternatif)');
                console.log('Jika pairing code bermasalah, scan QR ini dengan WhatsApp\n');
            }
            
            // PAIRING CODE - Request saat koneksi connecting
            if ((connection === 'connecting' || qr) && !sock.authState.creds.registered && !pairingRequested) {
                pairingRequested = true;
                
                console.log('⏳ Menghubungkan ke server WhatsApp...\n');
                await new Promise(resolve => setTimeout(resolve, 2000));
                
                const phoneNumber = await question('📱 Masukkan nomor WhatsApp Anda (contoh: 6281234567890): ');
                
                if (!phoneNumber) {
                    console.log('❌ Nomor tidak boleh kosong! Keluar...');
                    process.exit(1);
                }
                
                try {
                    const cleanNumber = phoneNumber.replace(/\D/g, '');
                    console.log(`\n⏳ Meminta pairing code untuk: ${cleanNumber}...`);
                    
                    const code = await sock.requestPairingCode(cleanNumber);
                    const formattedCode = code?.match(/.{1,4}/g)?.join("-") || code;
                    
                    console.log('\n╔══════════════════════════════════════════════════════════════╗');
                    console.log(`║                    🔑 PAIRING CODE: ${formattedCode.padEnd(20)}║`);
                    console.log('╚══════════════════════════════════════════════════════════════╝');
                    console.log('\n📝 Cara menggunakan:');
                    console.log('   1. Buka WhatsApp di HP');
                    console.log('   2. Settings (Pengaturan) → Perangkat Tertaut');
                    console.log('   3. Tap "Tautkan Perangkat"');
                    console.log(`   4. Masukkan kode: ${formattedCode}`);
                    console.log('\n⏰ Kode berlaku sekitar 2-3 menit. Anda memiliki waktu yang cukup.\n');
                    
                } catch (err) {
                    console.error('❌ Gagal meminta pairing code:', err.message);
                    pairingRequested = false;
                }
            }
            
            // KONEKSI BERHASIL
            if (connection === 'open') {
                isConnected = true;
                reconnectAttempts = 0;
                console.log('\n╔══════════════════════════════════════════════════════════════╗');
                console.log('║                    ✅ WHATSAPP TERHUBUNG!                    ║');
                console.log(`║  📱 Nomor: ${(sock.user?.id || 'Unknown').padEnd(44)}║`);
                console.log('╚══════════════════════════════════════════════════════════════╝');
                console.log('\n🚀 API siap digunakan!\n');
            }
            
            // KONEKSI TERPUTUS
            if (connection === 'close') {
                isConnected = false;
                
                // AMAN: Ambil status code tanpa TypeScript 'as'
                let statusCode = null;
                if (lastDisconnect && lastDisconnect.error && lastDisconnect.error.output) {
                    statusCode = lastDisconnect.error.output.statusCode;
                }
                
                console.log(`\n⚠️ Koneksi terputus. Status code: ${statusCode || 'unknown'}`);
                
                // Handle error 405 (version mismatch)
                if (statusCode === 405) {
                    console.log('🔄 Error 405: Versi protocol tidak kompatibel');
                    console.log('🗑️ Menghapus session lama dan mencoba ulang...');
                    
                    if (fs.existsSync('auth_info_baileys')) {
                        fs.rmSync('auth_info_baileys', { recursive: true, force: true });
                    }
                    pairingRequested = false;
                    setTimeout(connectToWhatsApp, 3000);
                    return;
                }
                
                // Handle restartRequired (normal setelah pairing/scan)
                if (statusCode === DisconnectReason.restartRequired) {
                    console.log('🔄 Restart required, melanjutkan koneksi...');
                    setTimeout(connectToWhatsApp, 2000);
                    return;
                }
                
                // Handle loggedOut — hapus auth folder dan reconnect fresh
                if (statusCode === DisconnectReason.loggedOut) {
                    console.log('🔑 Session logout — membersihkan data autentikasi...');
                    if (fs.existsSync('auth_info_baileys')) {
                        fs.rmSync('auth_info_baileys', { recursive: true, force: true });
                        console.log('🗑️ Folder auth_info_baileys dihapus');
                    }
                    pairingRequested = false;
                    console.log('🔄 Siap untuk pairing ulang...');
                    setTimeout(connectToWhatsApp, 3000);
                    return;
                }
                
                // Handle connection lost dengan exponential backoff
                if (reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
                    reconnectAttempts++;
                    const delay = Math.min(5000 * Math.pow(1.5, reconnectAttempts - 1), 60000);
                    console.log(`🔄 Mencoba reconnect dalam ${Math.round(delay/1000)} detik... (Percobaan ${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})`);
                    setTimeout(connectToWhatsApp, delay);
                } else {
                    console.log('❌ Maksimal percobaan reconnect tercapai.');
                    console.log('Silakan restart script secara manual.\n');
                }
            }
        });
        
        // Simpan kredensial saat ada update
        sock.ev.on('creds.update', saveCreds);
        
        // Event untuk pesan masuk (opsional, untuk logging)
        sock.ev.on('messages.upsert', async ({ messages, type }) => {
            if (type === 'notify' && !messages[0].key.fromMe) {
                const msg = messages[0];
                const from = msg.key.remoteJid;
                let text = '';
                if (msg.message?.conversation) {
                    text = msg.message.conversation;
                } else if (msg.message?.extendedTextMessage?.text) {
                    text = msg.message.extendedTextMessage.text;
                } else {
                    text = '(pesan non-teks)';
                }
                console.log(`📨 Pesan masuk dari ${from}: ${text.substring(0, 50)}`);
            }
        });
        
    } catch (err) {
        console.error('❌ Error dalam connectToWhatsApp:', err.message);
        console.log('🔄 Mencoba reconnect dalam 10 detik...');
        setTimeout(connectToWhatsApp, 10000);
    }
}

// ============ EXPRESS ROUTES ============

// Public Routes
app.get('/login', (req, res) => {
    res.render('login');
});

// Auth Routes (tanpa API key)
app.post('/api/auth/login', async (req, res) => {
    try {
        const { username, password } = req.body;
        
        if (!username || !password) {
            return res.status(400).json({
                success: false,
                error: 'Username dan password wajib diisi'
            });
        }
        
        const result = await login(username, password);
        
        if (result.success) {
            // Set session
            req.session.isAuthenticated = true;
            req.session.user = result.user;
            
            res.json({
                success: true,
                message: 'Login berhasil',
                user: result.user
            });
        } else {
            res.status(401).json({
                success: false,
                error: result.error
            });
        }
    } catch (error) {
        res.status(500).json({
            success: false,
            error: 'Terjadi kesalahan pada server'
        });
    }
});

app.post('/api/auth/logout', (req, res) => {
    req.session.destroy((err) => {
        if (err) {
            return res.status(500).json({
                success: false,
                error: 'Gagal logout'
            });
        }
        res.json({
            success: true,
            message: 'Logout berhasil'
        });
    });
});

app.get('/api/auth/check', (req, res) => {
    if (req.session && req.session.isAuthenticated) {
        res.json({
            authenticated: true,
            user: req.session.user
        });
    } else {
        res.json({
            authenticated: false
        });
    }
});

// Protected Routes - Dashboard (butuh session login, API key otomatis dari .env)
app.get('/dashboard', requireAuth, (req, res) => {
    res.render('dashboard', {
        apiKey: API_KEY
    });
});

app.get('/', (req, res) => {
    if (req.session && req.session.isAuthenticated) {
        res.redirect('/dashboard');
    } else {
        res.redirect('/login');
    }
});

// API: Kirim Pesan Teks (butuh API key)
app.get('/api/send-text', verifyApiKey, async (req, res) => {
    const { to, message } = req.query;

    if (!to || !message) {
        return res.status(400).json({
            status: false,
            error: 'Parameter "to" dan "message" wajib diisi'
        });
    }

    try {
        const result = await sendTextMessage(to, message);
        res.json({
            status: true,
            message: 'Pesan terkirim',
            to: to,
            result: result
        });
    } catch (err) {
        res.status(500).json({
            status: false,
            error: err.message
        });
    }
});

// API: Kirim Gambar (butuh API key)
app.get('/api/send-image', verifyApiKey, async (req, res) => {
    const { to, image, caption } = req.query;

    if (!to || !image) {
        return res.status(400).json({
            status: false,
            error: 'Parameter "to" dan "image" wajib diisi'
        });
    }

    try {
        const result = await sendImageMessage(to, image, caption || '');
        res.json({
            status: true,
            message: 'Gambar terkirim',
            to: to,
            result: result
        });
    } catch (err) {
        res.status(500).json({
            status: false,
            error: err.message
        });
    }
});

// API: Kirim Dokumen (butuh API key)
app.get('/api/send-document', verifyApiKey, async (req, res) => {
    const { to, document, filename, caption } = req.query;

    if (!to || !document) {
        return res.status(400).json({
            status: false,
            error: 'Parameter "to" dan "document" wajib diisi'
        });
    }

    try {
        const result = await sendDocumentMessage(to, document, filename || 'document', caption || '');
        res.json({
            status: true,
            message: 'Dokumen terkirim',
            to: to,
            result: result
        });
    } catch (err) {
        res.status(500).json({
            status: false,
            error: err.message
        });
    }
});

// API: Cek Status (public untuk dashboard, tapi butuh session atau API key)
app.get('/api/status', (req, res) => {
    // Cek apakah ada session valid ATAU API key
    const hasSession = req.session && req.session.isAuthenticated;
    const apiKey = req.headers['x-api-key'] || req.query.api_key;
    const hasApiKey = apiKey === API_KEY;
    
    // Izinkan jika punya session ATAU API key
    if (!hasSession && !hasApiKey) {
        return res.status(401).json({
            status: false,
            error: 'Authentication required. Login atau gunakan API key.'
        });
    }
    
    // Determine registration status dari berbagai kemungkinan path
    let registered = false;
    if (sock) {
        registered = !!(
            sock.authState?.creds?.registered ||
            sock.authState?.creds?.me ||
            sock.user?.id
        );
    }
    
    res.json({
        status: true,
        connected: isConnected,
        user: sock?.user?.id || sock?.authState?.creds?.me?.id || null,
        registered: registered,
        uptime: process.uptime()
    });
});

// API: Pairing Code (butuh API key)
app.get('/api/pair', verifyApiKey, async (req, res) => {
    const { phone } = req.query;

    if (!phone) {
        return res.status(400).json({
            status: false,
            error: 'Parameter "phone" wajib diisi (contoh: 6281234567890)'
        });
    }

    if (!sock) {
        return res.status(503).json({
            status: false,
            error: 'Socket belum siap. Tunggu sebentar.'
        });
    }

    try {
        const cleanNumber = phone.replace(/\D/g, '');
        const code = await sock.requestPairingCode(cleanNumber);
        const formattedCode = code?.match(/.{1,4}/g)?.join("-") || code;

        res.json({
            status: true,
            message: 'Pairing code berhasil dibuat',
            pairing_code: formattedCode,
            phone: cleanNumber
        });
    } catch (err) {
        res.status(500).json({
            status: false,
            error: err.message
        });
    }
});

// API: Get QR Code (butuh API key)
app.get('/api/qr', verifyApiKey, async (req, res) => {
    const QRCode = await import('qrcode');
    
    if (!currentQR) {
        return res.status(404).json({
            status: false,
            error: 'QR Code belum tersedia. Tunggu beberapa saat atau request pairing code terlebih dahulu.'
        });
    }

    try {
        // Convert QR code string ke base64 image
        const qrImage = await QRCode.toDataURL(currentQR, {
            width: 300,
            margin: 2,
            color: {
                dark: '#075E54',
                light: '#FFFFFF'
            }
        });

        res.json({
            status: true,
            qr_code: qrImage,
            message: 'QR code berhasil di-generate'
        });
    } catch (err) {
        res.status(500).json({
            status: false,
            error: err.message
        });
    }
});

// API: Logout WhatsApp (butuh API key)
app.get('/api/logout', verifyApiKey, async (req, res) => {
    try {
        if (sock) {
            await sock.logout();
        }

        // Note: Folder auth_info_baileys akan dihapus otomatis
        // oleh connection handler saat mendapat DisconnectReason.loggedOut

        res.json({
            status: true,
            message: 'Logout berhasil. Session akan dibersihkan secara otomatis.'
        });
    } catch (err) {
        res.status(500).json({
            status: false,
            error: err.message
        });
    }
});

// ============ START SERVER ============
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`\n🌐 HTTP Server berjalan di http://localhost:${PORT}`);
    console.log(`📋 Dashboard: http://localhost:${PORT}\n`);
});

// ============ START WHATSAPP CONNECTION ============
connectToWhatsApp().catch(err => {
    console.error('❌ Fatal error:', err);
    process.exit(1);
});

// ============ HANDLE EXIT ============
process.on('SIGINT', async () => {
    console.log('\n\n👋 Shutting down...');
    if (sock) {
        await sock.logout();
    }
    rl.close();
    process.exit(0);
});

process.on('uncaughtException', (err) => {
    console.error('❌ Uncaught exception:', err);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('❌ Unhandled rejection:', reason);
});