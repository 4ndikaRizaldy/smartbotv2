const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason
} = require('@whiskeysockets/baileys');
const P = require('pino');
const qrcode = require('qrcode-terminal');

// ================== FUNGSI ==================

async function mentionAll(remoteJid, sock, customMessage) {
    try {
        const metadata = await sock.groupMetadata(remoteJid);
        const participants = metadata.participants;

        let text = `${customMessage}\n\n`;
        let mentions = [];

        for (let p of participants) {
            mentions.push(p.id);
            text += `@${p.id.split('@')[0]} `;
        }

        await sock.sendMessage(remoteJid, { text, mentions });
    } catch (err) {
        console.error(`❌ Gagal mengambil data grup: ${err.message}`);
        await sock.sendMessage(remoteJid, {
            text: '⚠️ Gagal mengambil daftar member. Pastikan bot adalah admin grup.'
        });
    }
}

async function setGroupRestriction(remoteJid, sock, close, sender) {
    try {
        const metadata = await sock.groupMetadata(remoteJid);
        const participant = metadata.participants.find(p => p.id === sender);

        if (!participant || !(participant.admin === 'admin' || participant.admin === 'superadmin')) {
            return await sock.sendMessage(remoteJid, { text: '⚠️ Hanya admin yang bisa menggunakan perintah ini!' });
        }

        await sock.groupSettingUpdate(remoteJid, close ? 'announcement' : 'not_announcement');
        await sock.sendMessage(remoteJid, { text: close ? '🔒 Grup ditutup untuk semua member.' : '🔓 Grup dibuka untuk semua member.' });
    } catch (err) {
        console.error(`❌ Gagal mengubah pengaturan grup: ${err.message}`);
        await sock.sendMessage(remoteJid, {
            text: '⚠️ Gagal mengubah pengaturan grup. Pastikan bot adalah admin.'
        });
    }
}

// ================== MAIN BOT ==================

async function startBot() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');

    const sock = makeWASocket({
        logger: P({ level: 'silent' }),
        auth: state,
        browser: ['SmartBotV2', 'Chrome', '1.0.0']
    });

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            qrcode.generate(qr, { small: true });
            console.log('📲 Scan QR code di WhatsApp (Linked Devices)');
        }

        if (connection === 'close') {
            const shouldReconnect =
                (lastDisconnect?.error?.output?.statusCode) !== DisconnectReason.loggedOut;
            console.log('Koneksi terputus, reconnect:', shouldReconnect);
            if (shouldReconnect) {
                startBot();
            }
        } else if (connection === 'open') {
            console.log('✅ SmartBotV2 sudah online!');
        }
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('messages.upsert', async (m) => {
        const msg = m.messages[0];
        if (!msg.message || msg.key.fromMe) return;

        const from = msg.key.remoteJid;
        const sender = msg.key.participant || msg.key.remoteJid;
        const textMessage =
            msg.message.conversation ||
            msg.message.extendedTextMessage?.text ||
            '';

        console.log(`[Pesan] ${from} : ${textMessage}`);

        // !ping
        if (textMessage.toLowerCase() === '!ping') {
            await sock.sendMessage(from, { text: 'Pong! 🏓' });
        }

        // !tagall
        else if (textMessage.toLowerCase().startsWith('!tagall')) {
            if (!from.endsWith('@g.us')) {
                return await sock.sendMessage(from, { text: '⚠️ Perintah ini hanya untuk grup!' });
            }
            const customMessage =
                textMessage.replace(/!tagall/i, '').trim() || '👥 Mention All';
            mentionAll(from, sock, customMessage);
        }

        // !bukagrup
        else if (textMessage.toLowerCase() === '!bukagrup') {
            if (!from.endsWith('@g.us')) {
                return await sock.sendMessage(from, { text: '⚠️ Perintah ini hanya untuk grup!' });
            }
            await setGroupRestriction(from, sock, false, sender);
        }

        // !tutupgrup
        else if (textMessage.toLowerCase() === '!tutupgrup') {
            if (!from.endsWith('@g.us')) {
                return await sock.sendMessage(from, { text: '⚠️ Perintah ini hanya untuk grup!' });
            }
            await setGroupRestriction(from, sock, true, sender);
        }
    });
}

startBot();
