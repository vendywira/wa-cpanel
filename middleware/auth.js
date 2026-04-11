import { API_KEY, ADMIN_USERS, verifyPassword } from '../config/auth.js';

// Middleware untuk verifikasi API Key (untuk API endpoints)
export const verifyApiKey = (req, res, next) => {
    // Cek apakah sudah login via session
    if (req.session && req.session.isAuthenticated) {
        return next();
    }
    
    // Jika tidak, cek API key
    const apiKey = req.headers['x-api-key'] || req.query.api_key;
    
    if (!apiKey) {
        return res.status(401).json({
            status: false,
            error: 'Authentication required. Provide session or X-API-Key header.'
        });
    }
    
    if (apiKey !== API_KEY) {
        return res.status(403).json({
            status: false,
            error: 'Invalid API key'
        });
    }
    
    next();
};

// Middleware untuk verifikasi session (untuk dashboard)
export const requireAuth = (req, res, next) => {
    if (req.session && req.session.isAuthenticated) {
        return next();
    }
    
    // Jika belum auth, redirect ke login (untuk HTML requests)
    if (req.headers.accept && req.headers.accept.includes('text/html')) {
        return res.redirect('/login');
    }
    
    // Untuk API requests, return error
    return res.status(401).json({
        status: false,
        error: 'Authentication required. Please login first.'
    });
};

// Middleware untuk verifikasi login
export const login = async (username, password) => {
    const user = ADMIN_USERS.find(u => u.username === username);
    
    if (!user) {
        return { success: false, error: 'Username tidak ditemukan' };
    }
    
    // Untuk pertama kali, jika password belum di-hash, gunakan plain text comparison
    let isValid = false;
    if (user.password.startsWith('$2a$') || user.password.startsWith('$2b$')) {
        isValid = await verifyPassword(password, user.password);
    } else {
        // Fallback untuk plain text (hanya untuk setup awal)
        isValid = password === user.password;
    }
    
    if (!isValid) {
        return { success: false, error: 'Password salah' };
    }
    
    return {
        success: true,
        user: {
            username: user.username,
            name: user.name
        }
    };
};
