#!/usr/bin/env node
import bcrypt from 'bcryptjs';
import readline from 'readline';

const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
});

const question = (text) => new Promise((resolve) => rl.question(text, resolve));

async function generatePassword() {
    console.log('\n═══════════════════════════════════════════════════════════');
    console.log('           Password Hash Generator untuk WA Dashboard');
    console.log('═══════════════════════════════════════════════════════════\n');

    const password = await question('🔑 Masukkan password baru: ');
    
    if (!password || password.length < 4) {
        console.log('\n❌ Password minimal 4 karakter!');
        rl.close();
        process.exit(1);
    }

    const confirmPassword = await question('🔑 Konfirmasi password: ');
    
    if (password !== confirmPassword) {
        console.log('\n❌ Password tidak cocok!');
        rl.close();
        process.exit(1);
    }

    console.log('\n⏳ Generating hash...');
    
    const salt = await bcrypt.genSalt(10);
    const hash = await bcrypt.hash(password, salt);

    console.log('\n✅ Password hash berhasil dibuat!\n');
    console.log('📋 Hash Anda:');
    console.log('─'.repeat(65));
    console.log(hash);
    console.log('─'.repeat(65));
    console.log('\n📝 Cara menggunakan:');
    console.log('   1. Buka file: config/auth.js');
    console.log('   2. Ganti password di ADMIN_USERS dengan hash di atas');
    console.log('   3. Simpan dan restart server\n');

    rl.close();
}

generatePassword().catch(err => {
    console.error('❌ Error:', err);
    rl.close();
    process.exit(1);
});
