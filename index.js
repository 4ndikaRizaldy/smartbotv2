const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason
} = require('@whiskeysockets/baileys');
const P = require('pino');
const qrcode = require('qrcode-terminal');

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
        const pesan = msg.message.conversation || msg.message.extendedTextMessage?.text || '';

        console.log(`[Pesan] ${from} : ${pesan}`);

        if (pesan.toLowerCase() === '!ping') {
            await sock.sendMessage(from, { text: 'Pong! 🏓' });
        }

        if (pesan.toLowerCase().startsWith('!tagall')) {
            const metadata = await sock.groupMetadata(from);
            const participants = metadata.participants;

            let text = '📢 Tag All:\n\n';
            let mentions = [];

            for (let p of participants) {
                mentions.push(p.id);
                text += `@${p.id.split('@')[0]} `;
            }

            await sock.sendMessage(from, { text, mentions });
        }
    });
}

startBot();
