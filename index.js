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
const logger = P({ level: 'silent' });

// Socket: null = tidak ada koneksi aktif, resource minimal
let sock = null;
let isConnected = false;
let currentQR = null;

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

// ============ HELPER: Close socket ============
async function closeSocket() {
    if (sock) {
        try { await sock.end(undefined); } catch (e) {}
        sock = null;
        isConnected = false;
        console.log('🔌 Socket closed — resource released');
    }
}

// ============ HELPER: Create socket for send ============
async function createSocketForSend() {
    const { version } = await fetchLatestBaileysVersion();
    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');

    if (!state.creds?.registered && !state.creds?.me) {
        throw new Error('WhatsApp belum dipairing. Pair via dashboard dulu.');
    }

    return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
            if (sock) { sock.end(undefined).catch(() => {}); sock = null; }
            reject(new Error('Timeout 20 detik'));
        }, 20000);

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
            keepAliveIntervalMs: 60000,
        });

        sock.ev.on('creds.update', saveCreds);
        sock.ev.on('connection.update', (update) => {
            if (update.connection === 'open') {
                clearTimeout(timeout);
                isConnected = true;
                resolve();
            }
            if (update.connection === 'close') {
                clearTimeout(timeout);
                sock = null;
                isConnected = false;
                reject(new Error('Connection closed'));
            }
            if (update.qr) currentQR = update.qr;
        });
    });
}

// ============ HELPER: Connect for pairing (startup only) ============
async function connectForPairing() {
    try {
        const { version } = await fetchLatestBaileysVersion();
        console.log(`📱 WhatsApp v${version.join('.')}`);

        const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');

        // Jika sudah registered (sudah pernah pairing), langsung close — tidak perlu stay connected
        if (state.creds?.registered || state.creds?.me) {
            console.log('✅ Auth sudah terdaftar. Socket ditutup untuk hemat resource.');
            console.log('💡 Socket akan dibuat on-demand saat ada notifikasi.');
            return; // Tidak buat socket — langsung return
        }

        // Belum registered → buat socket untuk pairing
        sock = makeWASocket({
            auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, logger) },
            logger: P({ level: 'silent' }),
            browser: Browsers.macOS('Chrome'),
            printQRInTerminal: false,
            markOnlineOnConnect: false,
            syncFullHistory: false,
            version: version,
            connectTimeoutMs: 60000,
            defaultQueryTimeoutMs: 60000,
            keepAliveIntervalMs: 60000,
        });

        sock.ev.on('creds.update', saveCreds);
        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;
            if (qr) currentQR = qr;

            if (connection === 'open') {
                isConnected = true;
                console.log('✅ WhatsApp connected untuk pairing!');
                console.log('⏳ Setelah user pair, socket akan otomatis close.');

                // Tunggu sebentar agar creds tersimpan, lalu close
                await new Promise(r => setTimeout(r, 10000));
                await closeSocket();
                console.log('✅ Socket ditutup. Auth tersimpan di auth_info_baileys/');
            }

            if (connection === 'close') {
                isConnected = false;
                const code = lastDisconnect?.error?.output?.statusCode;
                console.log(`⚠️ Connection closed: ${code || 'unknown'}`);

                if (code === 405) {
                    if (fs.existsSync('auth_info_baileys')) fs.rmSync('auth_info_baileys', { recursive: true, force: true });
                    setTimeout(connectForPairing, 3000);
                    return;
                }

                if (code === DisconnectReason.loggedOut) {
                    if (fs.existsSync('auth_info_baileys')) fs.rmSync('auth_info_baileys', { recursive: true, force: true });
                    console.log('🔄 Siap pairing ulang via dashboard.');
                    return;
                }

                // Reconnect jika belum registered
                const { state: s } = await useMultiFileAuthState('auth_info_baileys');
                if (!s.creds?.registered && !s.creds?.me) {
                    setTimeout(connectForPairing, 3000);
                }
            }
        });

    } catch (err) {
        console.error('❌ Error:', err.message);
        setTimeout(connectForPairing, 10000);
    }
}

// ============ FUNGSI KIRIM PESAN (on-demand) ============
async function sendWithSocket(phoneNumber, messageFn) {
    // Buat socket baru
    await createSocketForSend();
    console.log('✅ Socket created, sending message...');

    let jid = phoneNumber;
    if (!jid.includes('@')) {
        let cleanNumber = phoneNumber.replace(/[^0-9]/g, '');
        if (cleanNumber.startsWith('0')) cleanNumber = '62' + cleanNumber.substring(1);
        if (!cleanNumber.startsWith('62')) cleanNumber = '62' + cleanNumber;
        jid = `${cleanNumber}@s.whatsapp.net`;
    }

    const [exists] = await sock.onWhatsApp(jid);
    if (!exists || !exists.exists) {
        await closeSocket();
        throw new Error(`Nomor ${phoneNumber} tidak terdaftar di WhatsApp`);
    }

    // Kirim pesan — promise resolve setelah media upload + send selesai
    const result = await messageFn(exists.jid);
    const msgKey = result?.key?.id;

    if (msgKey) {
        console.log(`⏳ Menunggu konfirmasi server untuk msg: ${msgKey}`);
        // Tunggu event messages.upsert (pesan masuk kembali dari server sebagai konfirmasi)
        // Timeout 15 detik jika event tidak datang
        await new Promise((resolve) => {
            const timeout = setTimeout(() => {
                console.log(`⚠️ Timeout menunggu ack untuk ${msgKey}, closing socket...`);
                resolve();
            }, 15000);

            const handler = (data) => {
                const msgs = data.messages || [];
                const found = msgs.find(m => m.key?.id === msgKey);
                if (found) {
                    clearTimeout(timeout);
                    sock.ev.off('messages.upsert', handler);
                    console.log(`✅ Server confirm received for ${msgKey}`);
                    resolve();
                }
            };

            sock.ev.on('messages.upsert', handler);
        });
    }

    // Close socket
    await closeSocket();

    return result;
}

export async function sendTextMessage(phoneNumber, message) {
    return sendWithSocket(phoneNumber, (jid) => sock.sendMessage(jid, { text: message }));
}

export async function sendImageMessage(phoneNumber, imageSource, caption = '') {
    return sendWithSocket(phoneNumber, async (jid) => {
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
        return sock.sendMessage(jid, { image: imageData, caption });
    });
}

export async function sendDocumentMessage(phoneNumber, documentPath, fileName, caption = '') {
    return sendWithSocket(phoneNumber, async (jid) => {
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

        return sock.sendMessage(jid, {
            document: fileBuffer,
            mimetype: mimeTypes[ext] || 'application/octet-stream',
            fileName: fileName || path.basename(documentPath),
            caption
        });
    });
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

app.post('/api/send-text', verifyApiKey, async (req, res) => {
    const { to, message } = req.body;
    if (!to || !message) return res.status(400).json({ status: false, error: 'Parameter "to" dan "message" wajib diisi' });
    try {
        const result = await sendTextMessage(to, message);
        res.json({ status: true, message: 'Pesan terkirim', to, result });
    } catch (err) { res.status(500).json({ status: false, error: err.message }); }
});

app.post('/api/send-image', verifyApiKey, async (req, res) => {
    const { to, image, caption } = req.body;
    if (!to || !image) return res.status(400).json({ status: false, error: 'Parameter "to" dan "image" wajib diisi' });
    try {
        const result = await sendImageMessage(to, image, caption || '');
        res.json({ status: true, message: 'Gambar terkirim', to, result });
    } catch (err) { res.status(500).json({ status: false, error: err.message }); }
});

app.post('/api/send-document', verifyApiKey, async (req, res) => {
    const { to, document, filename, caption } = req.body;
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

    let registered = false;
    if (fs.existsSync('auth_info_baileys/creds.json')) {
        try {
            const creds = JSON.parse(fs.readFileSync('auth_info_baileys/creds.json', 'utf8'));
            registered = !!(creds?.registered || creds?.me);
        } catch (e) {}
    }

    res.json({
        status: true,
        connected: isConnected,
        registered: registered,
        user: sock?.user?.id || null,
        uptime: process.uptime()
    });
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
        const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');

        sock = makeWASocket({
            auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, logger) },
            logger: P({ level: 'silent' }),
            browser: Browsers.ubuntu('Chrome'),
            printQRInTerminal: false,
            markOnlineOnConnect: false,
            syncFullHistory: false,
            version: version,
        });
        sock.ev.on('creds.update', saveCreds);

        sock.ev.on('connection.update', (update) => {
            if (update.qr) currentQR = update.qr;
            if (update.connection === 'open') {
                isConnected = true;
                console.log('✅ Socket stay alive untuk pairing');
            }
            if (update.connection === 'close') {
                isConnected = false;
                console.log('⚠️ Connection closed');
            }
        });

        await new Promise(r => setTimeout(r, 5000));

        const cleanNumber = phone.replace(/\D/g, '');
        const code = await sock.requestPairingCode(cleanNumber);
        const formattedCode = code?.match(/.{1,4}/g)?.join("-") || code;

        console.log(`🔑 Pairing code: ${formattedCode}`);
        console.log('⏳ Socket tetap hidup — user masukkan kode di WhatsApp (2-3 menit)');
        console.log('💡 Setelah user pair, socket akan otomatis close (10 detik setelah connected)');

        res.json({ status: true, message: 'Pairing code berhasil dibuat', pairing_code: formattedCode, phone: cleanNumber });
    } catch (err) {
        console.error('❌ Pairing error:', err);
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
        await closeSocket();
        res.json({ status: true, message: 'Logout berhasil.' });
    } catch (err) { res.status(500).json({ status: false, error: err.message }); }
});

// ============ START ============
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🌐 HTTP Server on http://localhost:${PORT}`);
});

// Startup: connect hanya untuk pairing, lalu close
connectForPairing().catch(err => { console.error('❌ Fatal:', err); });

// ============ HANDLE EXIT ============
process.on('SIGINT', async () => {
    await closeSocket();
    process.exit(0);
});

process.on('uncaughtException', (err) => { console.error('❌ Uncaught:', err); });
process.on('unhandledRejection', (reason) => { console.error('❌ Unhandled:', reason); });
