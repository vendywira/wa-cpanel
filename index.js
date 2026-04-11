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
import http from 'http';
import readline from 'readline';

// ============ KONFIGURASI AWAL ============
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const logger = P({ level: 'info' });

// Variabel global
let sock = null;
let isConnected = false;
let pairingRequested = false;
let reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 10;

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
            browser: Browsers.ubuntu('Chrome'),
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
                
                // Handle loggedOut
                if (statusCode === DisconnectReason.loggedOut) {
                    console.log('❌ Session logout!');
                    console.log('Silakan hapus folder "auth_info_baileys" dan jalankan ulang.\n');
                    process.exit(1);
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

// ============ HTTP SERVER UNTUK API ============
const server = http.createServer(async (req, res) => {
    // CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Content-Type', 'application/json');
    
    if (req.method === 'OPTIONS') {
        res.writeHead(200);
        res.end();
        return;
    }
    
    const url = new URL(req.url, `http://${req.headers.host}`);
    const pathname = url.pathname;
    
    // ENDPOINT: KIRIM PESAN TEKS
    if (pathname === '/send-text' && req.method === 'GET') {
        const to = url.searchParams.get('to');
        const message = url.searchParams.get('message');
        
        if (!to || !message) {
            res.writeHead(400);
            res.end(JSON.stringify({ 
                status: false, 
                error: 'Parameter "to" dan "message" wajib diisi' 
            }));
            return;
        }
        
        try {
            const result = await sendTextMessage(to, message);
            res.writeHead(200);
            res.end(JSON.stringify({ 
                status: true, 
                message: 'Pesan terkirim',
                to: to,
                result: result 
            }));
        } catch (err) {
            res.writeHead(500);
            res.end(JSON.stringify({ 
                status: false, 
                error: err.message 
            }));
        }
        return;
    }
    
    // ENDPOINT: KIRIM GAMBAR
    if (pathname === '/send-image' && req.method === 'GET') {
        const to = url.searchParams.get('to');
        const image = url.searchParams.get('image');
        const caption = url.searchParams.get('caption') || '';
        
        if (!to || !image) {
            res.writeHead(400);
            res.end(JSON.stringify({ 
                status: false, 
                error: 'Parameter "to" dan "image" wajib diisi' 
            }));
            return;
        }
        
        try {
            const result = await sendImageMessage(to, image, caption);
            res.writeHead(200);
            res.end(JSON.stringify({ 
                status: true, 
                message: 'Gambar terkirim',
                to: to,
                result: result 
            }));
        } catch (err) {
            res.writeHead(500);
            res.end(JSON.stringify({ 
                status: false, 
                error: err.message 
            }));
        }
        return;
    }
    
    // ENDPOINT: KIRIM DOKUMEN
    if (pathname === '/send-document' && req.method === 'GET') {
        const to = url.searchParams.get('to');
        const document = url.searchParams.get('document');
        const filename = url.searchParams.get('filename') || 'document';
        const caption = url.searchParams.get('caption') || '';
        
        if (!to || !document) {
            res.writeHead(400);
            res.end(JSON.stringify({ 
                status: false, 
                error: 'Parameter "to" dan "document" wajib diisi' 
            }));
            return;
        }
        
        try {
            const result = await sendDocumentMessage(to, document, filename, caption);
            res.writeHead(200);
            res.end(JSON.stringify({ 
                status: true, 
                message: 'Dokumen terkirim',
                to: to,
                result: result 
            }));
        } catch (err) {
            res.writeHead(500);
            res.end(JSON.stringify({ 
                status: false, 
                error: err.message 
            }));
        }
        return;
    }
    
    // ENDPOINT: CEK STATUS
    if (pathname === '/status') {
        res.writeHead(200);
        res.end(JSON.stringify({ 
            status: true,
            connected: isConnected, 
            user: sock?.user?.id || null,
            registered: sock?.authState?.creds?.registered || false,
            uptime: process.uptime()
        }));
        return;
    }
    
    // ENDPOINT: PAIRING CODE (manual)
    if (pathname === '/pair' && req.method === 'GET') {
        const phone = url.searchParams.get('phone');
        
        if (!phone) {
            res.writeHead(400);
            res.end(JSON.stringify({ 
                status: false, 
                error: 'Parameter "phone" wajib diisi (contoh: 6281234567890)' 
            }));
            return;
        }
        
        if (!sock) {
            res.writeHead(503);
            res.end(JSON.stringify({ 
                status: false, 
                error: 'Socket belum siap. Tunggu sebentar.' 
            }));
            return;
        }
        
        try {
            const cleanNumber = phone.replace(/\D/g, '');
            const code = await sock.requestPairingCode(cleanNumber);
            const formattedCode = code?.match(/.{1,4}/g)?.join("-") || code;
            
            res.writeHead(200);
            res.end(JSON.stringify({ 
                status: true, 
                message: 'Pairing code berhasil dibuat',
                pairing_code: formattedCode,
                phone: cleanNumber
            }));
        } catch (err) {
            res.writeHead(500);
            res.end(JSON.stringify({ 
                status: false, 
                error: err.message 
            }));
        }
        return;
    }
    
    // ENDPOINT: LOGOUT
    if (pathname === '/logout' && req.method === 'GET') {
        try {
            if (sock) {
                await sock.logout();
            }
            res.writeHead(200);
            res.end(JSON.stringify({ 
                status: true, 
                message: 'Logout berhasil. Hapus folder auth_info_baileys untuk reset total.' 
            }));
        } catch (err) {
            res.writeHead(500);
            res.end(JSON.stringify({ 
                status: false, 
                error: err.message 
            }));
        }
        return;
    }
    
    // ROOT ENDPOINT (Dokumentasi)
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end(`
╔══════════════════════════════════════════════════════════════════╗
║                    WhatsApp API - Baileys v7                     ║
╠══════════════════════════════════════════════════════════════════╣
║                                                                  ║
║  📤 KIRIM PESAN TEKS:                                            ║
║     GET /send-text?to=628xxx&message=Halo                       ║
║                                                                  ║
║  🖼️ KIRIM GAMBAR:                                                ║
║     GET /send-image?to=628xxx&image=URL&caption=Pesan           ║
║                                                                  ║
║  📎 KIRIM DOKUMEN:                                               ║
║     GET /send-document?to=628xxx&document=/path/file.pdf        ║
║                                                                  ║
║  🔑 PAIRING CODE (manual):                                       ║
║     GET /pair?phone=628xxx                                      ║
║                                                                  ║
║  📊 CEK STATUS:                                                  ║
║     GET /status                                                 ║
║                                                                  ║
║  🚪 LOGOUT:                                                      ║
║     GET /logout                                                 ║
║                                                                  ║
╚══════════════════════════════════════════════════════════════════╝
    `);
});

// ============ START SERVER ============
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`\n🌐 HTTP Server berjalan di http://localhost:${PORT}`);
    console.log(`📋 Dokumentasi API: http://localhost:${PORT}\n`);
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