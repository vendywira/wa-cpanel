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
import session from 'express-session';
import cookieParser from 'cookie-parser';
import { SESSION_CONFIG, API_KEY } from './config/auth.js';
import { verifyApiKey, requireAuth, login } from './middleware/auth.js';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
// Logger silent untuk mengurangi overhead proses
const logger = P({ level: 'silent' });

let sock = null;
let isConnected = false;
let pairingRequested = false;
let reconnectAttempts = 0;
let currentQR = null;
const MAX_RECONNECT_ATTEMPTS = 10;

const app = express();
app.use(express.json());
app.use(cookieParser());
app.use(session(SESSION_CONFIG));
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type, X-API-Key');
    if (req.method === 'OPTIONS') { res.sendStatus(200); } else { next(); }
});

app.use(express.static(path.join(__dirname, 'public')));

// ============ EVENT HANDLER (sama seperti kode lama) ============
function setupSocketEvents(socket, saveCreds) {
    socket.ev.on('creds.update', saveCreds);

    socket.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) currentQR = qr;

        // Skip pairing prompt di cPanel (tidak ada terminal)
        if ((connection === 'connecting' || qr) && !socket.authState.creds.registered && !pairingRequested) {
            pairingRequested = true;
            console.log('⏳ Menunggu pairing code dari dashboard...');
            console.log('💡 Gunakan dashboard /dashboard untuk request pairing code');
        }

        if (connection === 'open') {
            isConnected = true;
            reconnectAttempts = 0;
            console.log(`✅ WhatsApp connected: ${socket.user?.id || 'Unknown'}`);
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
                pairingRequested = false;
                setTimeout(connectToWhatsApp, 3000);
                return;
            }

            if (statusCode === DisconnectReason.restartRequired) {
                setTimeout(connectToWhatsApp, 2000);
                return;
            }

            if (statusCode === DisconnectReason.loggedOut) {
                console.log('🔑 Session logout — membersihkan data autentikasi...');
                if (fs.existsSync('auth_info_baileys')) {
                    fs.rmSync('auth_info_baileys', { recursive: true, force: true });
                }
                pairingRequested = false;
                setTimeout(connectToWhatsApp, 3000);
                return;
            }

            if (reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
                reconnectAttempts++;
                const delay = Math.min(5000 * Math.pow(1.5, reconnectAttempts - 1), 60000);
                setTimeout(connectToWhatsApp, delay);
            }
        }
    });
}

// ============ CONNECT TO WHATSAPP (kode lama — auto-reconnect loop) ============
async function connectToWhatsApp() {
    try {
        const { version, isLatest } = await fetchLatestBaileysVersion();
        console.log(`📱 WhatsApp v${version.join('.')} ${isLatest ? '(latest)' : '(update available)'}`);

        const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');

        sock = makeWASocket({
            auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, logger) },
            logger: P({ level: 'silent' }),
            browser: Browsers.macOS('Chrome'),
            printQRInTerminal: false,
            markOnlineOnConnect: false,
            syncFullHistory: false,
            version: version,
            connectTimeoutMs: 30000,
            defaultQueryTimeoutMs: 30000,
            keepAliveIntervalMs: 60000
        });

        setupSocketEvents(sock, saveCreds);

    } catch (err) {
        console.error('❌ Error dalam connectToWhatsApp:', err.message);
        console.log('🔄 Mencoba reconnect dalam 10 detik...');
        setTimeout(connectToWhatsApp, 10000);
    }
}

// ============ CONNECT ON-DEMAND (untuk kirim pesan setelah pairing) ============
async function ensureConnected() {
    if (isConnected && sock) return;

    const maxRetries = 3;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        console.log(`⚠️ Mencoba connect ke WhatsApp (attempt ${attempt}/${maxRetries})...`);

        if (sock) {
            try { await sock.end(undefined); } catch (e) {}
            await new Promise(r => setTimeout(r, 1000));
            sock = null;
        }

        const { version } = await fetchLatestBaileysVersion();
        console.log(`📱 Menggunakan versi: ${version.join('.')}`);

        const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');

        if (!state.creds?.registered && !state.creds?.me) {
            throw new Error('WhatsApp belum dipairing. Silakan pairing ulang via dashboard.');
        }

        try {
            await waitForConnection(state, saveCreds, version);
            console.log('✅ Koneksi WhatsApp berhasil');
            return;
        } catch (err) {
            console.error(`❌ Attempt ${attempt} gagal: ${err.message}`);
            if (attempt === maxRetries) {
                throw new Error(`Gagal connect ke WhatsApp setelah ${maxRetries} percobaan: ${err.message}`);
            }
            await new Promise(r => setTimeout(r, 2000 * attempt));
        }
    }
}

function waitForConnection(state, saveCreds, version) {
    return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Timeout 20 detik')), 20000);

        sock = makeWASocket({
            auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, logger) },
            logger: P({ level: 'silent' }),
            browser: Browsers.macOS('Chrome'),
            printQRInTerminal: false,
            markOnlineOnConnect: false,
            syncFullHistory: false,
            version: version,
            connectTimeoutMs: 30000,
            defaultQueryTimeoutMs: 30000,
            keepAliveIntervalMs: 60000
        });

        sock.ev.on('creds.update', saveCreds);

        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;
            if (qr) currentQR = qr;

            if (connection === 'open') {
                clearTimeout(timeout);
                isConnected = true;
                console.log(`✅ WhatsApp connected: ${sock?.user?.id || 'Unknown'}`);
                resolve();
            }

            if (connection === 'close') {
                isConnected = false;
                let statusCode = null;
                if (lastDisconnect?.error?.output) statusCode = lastDisconnect.error.output.statusCode;
                console.log(`\n⚠️ Koneksi terputus. Status code: ${statusCode || 'unknown'}`);

                clearTimeout(timeout);
                sock = null;

                if (statusCode === DisconnectReason.loggedOut) {
                    if (fs.existsSync('auth_info_baileys')) fs.rmSync('auth_info_baileys', { recursive: true, force: true });
                    reject(new Error('WhatsApp logout. Hapus folder auth dan pairing ulang.'));
                    return;
                }
                if (statusCode === 405) {
                    if (fs.existsSync('auth_info_baileys')) fs.rmSync('auth_info_baileys', { recursive: true, force: true });
                    reject(new Error('Protocol mismatch. Restart server.'));
                    return;
                }
                reject(new Error('Connection closed'));
            }
        });
    });
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
    if (!exists || !exists.exists) throw new Error(`Nomor ${phoneNumber} tidak terdaftar di WhatsApp`);

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
    if (!exists || !exists.exists) throw new Error(`Nomor ${phoneNumber} tidak terdaftar di WhatsApp`);

    let imageData;
    if (typeof imageSource === 'string') {
        if (imageSource.startsWith('http://') || imageSource.startsWith('https://')) imageData = { url: imageSource };
        else if (fs.existsSync(imageSource)) imageData = fs.readFileSync(imageSource);
        else throw new Error('Image source tidak valid');
    } else if (Buffer.isBuffer(imageSource)) {
        imageData = imageSource;
    } else {
        throw new Error('Image source harus URL, path file, atau buffer');
    }

    const result = await sock.sendMessage(exists.jid, { image: imageData, caption });
    console.log(`✅ Gambar terkirim ke ${phoneNumber}`);
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
    if (!exists || !exists.exists) throw new Error(`Nomor ${phoneNumber} tidak terdaftar di WhatsApp`);
    if (!fs.existsSync(documentPath)) throw new Error(`File tidak ditemukan: ${documentPath}`);

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

// ============ ROUTES ============
app.get('/login', (req, res) => { res.render('login'); });

app.post('/api/auth/login', async (req, res) => {
    try {
        const { username, password } = req.body;
        if (!username || !password) return res.status(400).json({ success: false, error: 'Username dan password wajib diisi' });
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
    if (req.session && req.session.isAuthenticated) res.json({ authenticated: true, user: req.session.user });
    else res.json({ authenticated: false });
});

app.get('/dashboard', requireAuth, (req, res) => { res.render('dashboard', { apiKey: API_KEY }); });

app.get('/', (req, res) => {
    if (req.session && req.session.isAuthenticated) res.redirect('/dashboard');
    else res.redirect('/login');
});

app.get('/api/send-text', verifyApiKey, async (req, res) => {
    const { to, message } = req.query;
    if (!to || !message) return res.status(400).json({ status: false, error: 'Parameter "to" dan "message" wajib diisi' });
    try {
        const result = await sendTextMessage(to, message);
        res.json({ status: true, message: 'Pesan terkirim', to, result });
    } catch (err) { res.status(500).json({ status: false, error: err.message }); }
});

app.get('/api/send-image', verifyApiKey, async (req, res) => {
    const { to, image, caption } = req.query;
    if (!to || !image) return res.status(400).json({ status: false, error: 'Parameter "to" dan "image" wajib diisi' });
    try {
        const result = await sendImageMessage(to, image, caption || '');
        res.json({ status: true, message: 'Gambar terkirim', to, result });
    } catch (err) { res.status(500).json({ status: false, error: err.message }); }
});

app.get('/api/send-document', verifyApiKey, async (req, res) => {
    const { to, document, filename, caption } = req.query;
    if (!to || !document) return res.status(400).json({ status: false, error: 'Parameter "to" dan "document" wajib diisi' });
    try {
        const result = await sendDocumentMessage(to, document, filename || 'document', caption || '');
        res.json({ status: true, message: 'Dokumen terkirim', to, result });
    } catch (err) { res.status(500).json({ status: false, error: err.message }); }
});

app.get('/api/status', (req, res) => {
    const hasSession = req.session && req.session.isAuthenticated;
    const apiKey = req.headers['x-api-key'] || req.query.api_key;
    const hasApiKey = apiKey === API_KEY;
    if (!hasSession && !hasApiKey) return res.status(401).json({ status: false, error: 'Authentication required.' });

    let connected = false, registered = false;
    if (sock && sock.authState?.creds) {
        registered = !!(sock.authState.creds.registered || sock.authState.creds.me);
        connected = isConnected && registered;
    }
    res.json({ status: true, connected, registered, user: sock?.user?.id || sock?.authState?.creds?.me?.id || null, uptime: process.uptime() });
});

app.get('/api/pair', verifyApiKey, async (req, res) => {
    const { phone } = req.query;
    if (!phone) return res.status(400).json({ status: false, error: 'Parameter "phone" wajib diisi' });
    try {
        if (fs.existsSync('auth_info_baileys')) {
            fs.rmSync('auth_info_baileys', { recursive: true, force: true });
            console.log('🗑️ Auth lama dihapus untuk pairing baru');
        }
        const { version } = await fetchLatestBaileysVersion();
        console.log(`📱 Menggunakan versi: ${version.join('.')}`);

        const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');
        sock = makeWASocket({
            auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, logger) },
            logger: P({ level: 'silent' }),
            browser: Browsers.ubuntu('Chrome'),
            printQRInTerminal: false,
            markOnlineOnConnect: false,
            syncFullHistory: false,
            version: version,
            connectTimeoutMs: 30000,
            defaultQueryTimeoutMs: 30000,
            keepAliveIntervalMs: 60000
        });
        sock.ev.on('creds.update', saveCreds);

        // Gunakan setupSocketEvents yang sama dengan connectToWhatsApp
        setupSocketEvents(sock, saveCreds);

        // Tunggu socket initializing
        console.log('⏳ Initializing socket...');
        await new Promise(r => setTimeout(r, 5000));

        const cleanNumber = phone.replace(/\D/g, '');
        console.log(`📱 Request pairing code untuk: ${cleanNumber}`);

        const code = await sock.requestPairingCode(cleanNumber);
        const formattedCode = code?.match(/.{1,4}/g)?.join("-") || code;

        console.log(`🔑 Pairing code berhasil: ${formattedCode}`);
        console.log('⏳ Socket tetap hidup — tunggu user masukkan kode di WhatsApp (2-3 menit)');

        res.json({ status: true, message: 'Pairing code berhasil dibuat', pairing_code: formattedCode, phone: cleanNumber });
    } catch (err) {
        console.error('❌ Pairing code error:', err);
        res.status(500).json({ status: false, error: err.message || 'Failed to create pairing code' });
    }
});

app.get('/api/qr', verifyApiKey, async (req, res) => {
    const QRCode = await import('qrcode');
    if (!currentQR) return res.status(404).json({ status: false, error: 'QR Code belum tersedia.' });
    try {
        const qrImage = await QRCode.toDataURL(currentQR, { width: 300, margin: 2, color: { dark: '#075E54', light: '#FFFFFF' } });
        res.json({ status: true, qr_code: qrImage, message: 'QR code berhasil di-generate' });
    } catch (err) { res.status(500).json({ status: false, error: err.message }); }
});

app.get('/api/logout', verifyApiKey, async (req, res) => {
    try {
        if (sock) await sock.logout();
        res.json({ status: true, message: 'Logout berhasil. Session akan dibersihkan secara otomatis.' });
    } catch (err) { res.status(500).json({ status: false, error: err.message }); }
});

// ============ START SERVER ============
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🌐 HTTP Server on http://localhost:${PORT}`);
});

// ============ START WHATSAPP ============
connectToWhatsApp().catch(err => { console.error('❌ Fatal error:', err); process.exit(1); });

// ============ HANDLE EXIT ============
process.on('SIGINT', async () => {
    if (sock) { try { await sock.end(undefined); } catch (e) {} }
    process.exit(0);
});

process.on('uncaughtException', (err) => { console.error('❌ Uncaught exception:', err); });
process.on('unhandledRejection', (reason) => { console.error('❌ Unhandled rejection:', reason); });
