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
let currentQR = null;

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

// Readline interface (hanya untuk pairing manual via terminal jika diperlukan)
const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
});

// ============ EVENT HANDLER ============
function setupSocketEvents(socket) {
    socket.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            currentQR = qr;
            console.log('\n📱 QR Code telah di-generate');
        }

        if (connection === 'open') {
            isConnected = true;
            console.log('\n╔══════════════════════════════════════════════════════════════╗');
            console.log('║                    ✅ WHATSAPP TERHUBUNG!                    ║');
            console.log(`║  📱 Nomor: ${(socket.user?.id || 'Unknown').padEnd(44)}║`);
            console.log('╚══════════════════════════════════════════════════════════════╝');
            console.log('\n🚀 API siap digunakan!\n');
        }

        if (connection === 'close') {
            isConnected = false;

            let statusCode = null;
            if (lastDisconnect && lastDisconnect.error && lastDisconnect.error.output) {
                statusCode = lastDisconnect.error.output.statusCode;
            }

            console.log(`\n⚠️ Koneksi terputus. Status code: ${statusCode || 'unknown'}`);

            if (statusCode === 405) {
                console.log('🔄 Error 405: Versi protocol tidak kompatibel');
                if (fs.existsSync('auth_info_baileys')) {
                    fs.rmSync('auth_info_baileys', { recursive: true, force: true });
                }
                sock = null;
                return;
            }

            if (statusCode === DisconnectReason.restartRequired) {
                console.log('🔄 Restart required, socket akan di-reconnect saat request berikutnya');
                sock = null;
                return;
            }

            if (statusCode === DisconnectReason.loggedOut) {
                console.log('🔑 Session logout — membersihkan data autentikasi...');
                if (fs.existsSync('auth_info_baileys')) {
                    fs.rmSync('auth_info_baileys', { recursive: true, force: true });
                    console.log('🗑️ Folder auth_info_baileys dihapus');
                }
                sock = null;
                console.log('🔄 Siap untuk pairing ulang...');
                return;
            }

            console.log('🔄 Koneksi hilang. Akan reconnect otomatis saat ada request.');
            sock = null;
        }
    });

    socket.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type === 'notify' && !messages[0].key.fromMe) {
            const msg = messages[0];
            const from = msg.key.remoteJid;
            let text = msg.message?.conversation || msg.message?.extendedTextMessage?.text || '(pesan non-teks)';
            console.log(`📨 Pesan masuk dari ${from}: ${text.substring(0, 50)}`);
        }
    });
}

// ============ CONNECT ON-DEMAND ============
/**
 * Connect ke WhatsApp menggunakan auth yang sudah ada.
 * Hanya dipanggil saat ada request kirim pesan.
 */
async function ensureConnected() {
    if (isConnected && sock) {
        return;
    }

    console.log('⚠️ WhatsApp belum terhubung, mencoba connect...');

    if (sock) {
        try { await sock.end(undefined); } catch (e) { /* ignore */ }
        sock = null;
    }

    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');

    if (!state.creds?.registered && !state.creds?.me) {
        throw new Error('WhatsApp belum dipairing. Silakan pairing via dashboard /dashboard');
    }

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
        connectTimeoutMs: 30000,
        defaultQueryTimeoutMs: 30000,
        keepAliveIntervalMs: 25000,
    });

    sock.ev.on('creds.update', saveCreds);
    setupSocketEvents(sock);

    // Tunggu sampai connected (max 15 detik)
    const maxWait = 15000;
    const startTime = Date.now();
    while (Date.now() - startTime < maxWait) {
        if (isConnected) {
            console.log('✅ Koneksi WhatsApp berhasil');
            return;
        }
        await new Promise(resolve => setTimeout(resolve, 500));
    }

    throw new Error('Timeout: tidak bisa connect setelah 15 detik');
}

// ============ FUNGSI KIRIM PESAN ============
export async function sendTextMessage(phoneNumber, message) {
    await ensureConnected();

    let jid = phoneNumber;
    if (!jid.includes('@')) {
        let cleanNumber = phoneNumber.replace(/[^0-9]/g, '');
        if (cleanNumber.startsWith('0')) cleanNumber = '62' + cleanNumber.substring(1);
        if (!cleanNumber.startsWith('62')) cleanNumber = '62' + cleanNumber;
        jid = `${cleanNumber}@s.whatsapp.net`;
    }

    const [exists] = await sock.onWhatsApp(jid);
    if (!exists || !exists.exists) {
        throw new Error(`Nomor ${phoneNumber} tidak terdaftar di WhatsApp`);
    }

    const result = await sock.sendMessage(exists.jid, { text: message });
    console.log(`✅ Pesan terkirim ke ${phoneNumber}`);
    return result;
}

export async function sendImageMessage(phoneNumber, imageSource, caption = '') {
    await ensureConnected();

    let jid = phoneNumber;
    if (!jid.includes('@')) {
        let cleanNumber = phoneNumber.replace(/[^0-9]/g, '');
        if (cleanNumber.startsWith('0')) cleanNumber = '62' + cleanNumber.substring(1);
        if (!cleanNumber.startsWith('62')) cleanNumber = '62' + cleanNumber;
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

    const result = await sock.sendMessage(exists.jid, { image: imageData, caption });
    console.log(`✅ Gambar terkirim ke ${phoneNumber}${caption ? `: ${caption}` : ''}`);
    return result;
}

export async function sendDocumentMessage(phoneNumber, documentPath, fileName, caption = '') {
    await ensureConnected();

    let jid = phoneNumber;
    if (!jid.includes('@')) {
        let cleanNumber = phoneNumber.replace(/[^0-9]/g, '');
        if (cleanNumber.startsWith('0')) cleanNumber = '62' + cleanNumber.substring(1);
        if (!cleanNumber.startsWith('62')) cleanNumber = '62' + cleanNumber;
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
        '.pdf': 'application/pdf', '.doc': 'application/msword',
        '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        '.xls': 'application/vnd.ms-excel', '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        '.txt': 'text/plain', '.zip': 'application/zip',
        '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png'
    };

    const result = await sock.sendMessage(exists.jid, {
        document: fileBuffer,
        mimetype: mimeTypes[ext] || 'application/octet-stream',
        fileName: fileName || path.basename(documentPath),
        caption
    });

    console.log(`✅ Dokumen terkirim ke ${phoneNumber}: ${fileName}`);
    return result;
}

// ============ EXPRESS ROUTES ============

app.get('/login', (req, res) => { res.render('login'); });

app.post('/api/auth/login', async (req, res) => {
    try {
        const { username, password } = req.body;
        if (!username || !password) {
            return res.status(400).json({ success: false, error: 'Username dan password wajib diisi' });
        }
        const result = await login(username, password);
        if (result.success) {
            req.session.isAuthenticated = true;
            req.session.user = result.user;
            res.json({ success: true, message: 'Login berhasil', user: result.user });
        } else {
            res.status(401).json({ success: false, error: result.error });
        }
    } catch (error) {
        res.status(500).json({ success: false, error: 'Terjadi kesalahan pada server' });
    }
});

app.post('/api/auth/logout', (req, res) => {
    req.session.destroy((err) => {
        if (err) return res.status(500).json({ success: false, error: 'Gagal logout' });
        res.json({ success: true, message: 'Logout berhasil' });
    });
});

app.get('/api/auth/check', (req, res) => {
    if (req.session && req.session.isAuthenticated) {
        res.json({ authenticated: true, user: req.session.user });
    } else {
        res.json({ authenticated: false });
    }
});

app.get('/dashboard', requireAuth, (req, res) => {
    res.render('dashboard', { apiKey: API_KEY });
});

app.get('/', (req, res) => {
    if (req.session && req.session.isAuthenticated) {
        res.redirect('/dashboard');
    } else {
        res.redirect('/login');
    }
});

// API: Kirim Pesan Teks
app.get('/api/send-text', verifyApiKey, async (req, res) => {
    const { to, message } = req.query;
    if (!to || !message) {
        return res.status(400).json({ status: false, error: 'Parameter "to" dan "message" wajib diisi' });
    }
    try {
        const result = await sendTextMessage(to, message);
        res.json({ status: true, message: 'Pesan terkirim', to, result });
    } catch (err) {
        res.status(500).json({ status: false, error: err.message });
    }
});

// API: Kirim Gambar
app.get('/api/send-image', verifyApiKey, async (req, res) => {
    const { to, image, caption } = req.query;
    if (!to || !image) {
        return res.status(400).json({ status: false, error: 'Parameter "to" dan "image" wajib diisi' });
    }
    try {
        const result = await sendImageMessage(to, image, caption || '');
        res.json({ status: true, message: 'Gambar terkirim', to, result });
    } catch (err) {
        res.status(500).json({ status: false, error: err.message });
    }
});

// API: Kirim Dokumen
app.get('/api/send-document', verifyApiKey, async (req, res) => {
    const { to, document, filename, caption } = req.query;
    if (!to || !document) {
        return res.status(400).json({ status: false, error: 'Parameter "to" dan "document" wajib diisi' });
    }
    try {
        const result = await sendDocumentMessage(to, document, filename || 'document', caption || '');
        res.json({ status: true, message: 'Dokumen terkirim', to, result });
    } catch (err) {
        res.status(500).json({ status: false, error: err.message });
    }
});

// API: Cek Status
app.get('/api/status', (req, res) => {
    const hasSession = req.session && req.session.isAuthenticated;
    const apiKey = req.headers['x-api-key'] || req.query.api_key;
    const hasApiKey = apiKey === API_KEY;

    if (!hasSession && !hasApiKey) {
        return res.status(401).json({ status: false, error: 'Authentication required.' });
    }

    let connected = false;
    let registered = false;
    if (sock && sock.authState?.creds) {
        registered = !!(sock.authState.creds.registered || sock.authState.creds.me);
        connected = isConnected && registered;
    }

    res.json({
        status: true,
        connected,
        registered,
        user: sock?.user?.id || sock?.authState?.creds?.me?.id || null,
        uptime: process.uptime()
    });
});

// API: Pairing Code (via dashboard)
app.get('/api/pair', verifyApiKey, async (req, res) => {
    const { phone } = req.query;
    if (!phone) {
        return res.status(400).json({ status: false, error: 'Parameter "phone" wajib diisi' });
    }

    try {
        // Jika belum ada socket, buat socket baru dari auth yang ada
        if (!sock) {
            console.log('📱 Membuat socket untuk pairing...');
            const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');
            sock = makeWASocket({
                auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, logger) },
                logger: P({ level: 'silent' }),
                browser: Browsers.macOS('Chrome'),
                printQRInTerminal: false,
                markOnlineOnConnect: false,
                syncFullHistory: false,
            });
            sock.ev.on('creds.update', saveCreds);
            setupSocketEvents(sock);
        }

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
        res.status(500).json({ status: false, error: err.message });
    }
});

// API: Get QR Code
app.get('/api/qr', verifyApiKey, async (req, res) => {
    const QRCode = await import('qrcode');
    if (!currentQR) {
        return res.status(404).json({ status: false, error: 'QR Code belum tersedia.' });
    }
    try {
        const qrImage = await QRCode.toDataURL(currentQR, {
            width: 300, margin: 2,
            color: { dark: '#075E54', light: '#FFFFFF' }
        });
        res.json({ status: true, qr_code: qrImage, message: 'QR code berhasil di-generate' });
    } catch (err) {
        res.status(500).json({ status: false, error: err.message });
    }
});

// API: Logout WhatsApp
app.get('/api/logout', verifyApiKey, async (req, res) => {
    try {
        if (sock) {
            await sock.logout();
        }
        res.json({ status: true, message: 'Logout berhasil. Session akan dibersihkan secara otomatis.' });
    } catch (err) {
        res.status(500).json({ status: false, error: err.message });
    }
});

// ============ START SERVER ============
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`\n🌐 HTTP Server berjalan di http://localhost:${PORT}`);
    console.log(`📋 Dashboard: http://localhost:${PORT}\n`);
    console.log('💡 WhatsApp akan connect otomatis saat ada request kirim pesan.');
});

// ============ HANDLE EXIT ============
process.on('SIGINT', async () => {
    console.log('\n\n👋 Shutting down...');
    if (sock) {
        try { await sock.end(undefined); } catch (e) { /* ignore */ }
    }
    rl.close();
    process.exit(0);
});

process.on('uncaughtException', (err) => { console.error('❌ Uncaught exception:', err); });
process.on('unhandledRejection', (reason) => { console.error('❌ Unhandled rejection:', reason); });
