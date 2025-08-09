const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');

// Inisialisasi client
const client = new Client({
    authStrategy: new LocalAuth(), // Simpan session otomatis di folder .wwebjs_auth
    puppeteer: { headless: true }  // Headless = tidak buka browser GUI
});

// Tampilkan QR di terminal
client.on('qr', qr => {
    qrcode.generate(qr, { small: true });
    console.log('Scan QR di WhatsApp (Linked Devices)...');
});

// Koneksi sukses
client.on('ready', () => {
    console.log('✅ SmartBotV2 sudah online!');
});

// Handler pesan
client.on('message', async msg => {
    const chat = await msg.getChat();

    // !ping
    if (msg.body.toLowerCase() === '!ping') {
        await msg.reply('Pong! 🏓');
    }

    // !tagall
    if (msg.body.toLowerCase().startsWith('!tagall')) {
        if (!chat.isGroup) {
            return msg.reply('Perintah ini hanya untuk grup!');
        }

        // Ambil semua member
        let text = '📢 Tag All:\n\n';
        let mentions = [];

        for (let participant of chat.participants) {
            const contact = await client.getContactById(participant.id._serialized);
            mentions.push(contact);
            text += `@${contact.number} `;
        }

        await chat.sendMessage(text, { mentions });
    }
});

// Mulai bot
client.initialize();
