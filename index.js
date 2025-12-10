// smartbotv2.js (updated)
// Dependencies (sama seperti sebelum)
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
} = require("@whiskeysockets/baileys");
const P = require("pino");
const qrcode = require("qrcode-terminal");
const { DateTime, Duration } = require("luxon");
const fs = require("fs");

// Konfigurasi
const TIMEZONE = "Asia/Makassar";
const SCHEDULE_FILE = "./jadwal.json";
const COMMANDS_FILE = "./commands.json";
const GOODBYE_FILE = "./goodbye.json";
const WELCOME_FILE = "./welcome.json";
const ADMIN_FILE = "./admin.json";

// Fungsi aman untuk load/simpan file JSON
function loadJsonFile(path, fallback = {}) {
  try {
    if (!fs.existsSync(path)) {
      fs.writeFileSync(path, JSON.stringify(fallback, null, 2));
      return fallback;
    }
    const content = fs.readFileSync(path, "utf8").trim();
    return content ? JSON.parse(content) : fallback;
  } catch (err) {
    console.error(`⚠️ Error membaca ${path}:`, err.message);
    try {
      fs.writeFileSync(path, JSON.stringify(fallback, null, 2));
    } catch {}
    return fallback;
  }
}
function saveJsonFile(path, data) {
  try {
    fs.writeFileSync(path, JSON.stringify(data, null, 2));
  } catch (e) {
    console.error(`⚠️ Gagal simpan ${path}:`, e.message);
  }
}

// Data (di-load sekali saat start)
let jadwal = loadJsonFile(SCHEDULE_FILE, {});
let welcomeData = loadJsonFile(WELCOME_FILE, {});
let goodbyeData = loadJsonFile(GOODBYE_FILE, {});
let commandsFileCache = loadJsonFile(COMMANDS_FILE, {});
let adminDB = loadJsonFile(ADMIN_FILE, { owner: "", admins: {} });

// Jika admin.json kosong, isi owner dari environment (opsional)
if (!adminDB.owner) {
  // opsional: set owner dari env var atau file lain; biarkan kosong jika belum ada
  adminDB.owner = adminDB.owner || "";
  saveJsonFile(ADMIN_FILE, adminDB);
}

let botStartTime = Date.now(); // otomatis terset saat file dijalankan

// helper untuk menyimpan
function simpanJadwal() {
  saveJsonFile(SCHEDULE_FILE, jadwal);
}
function saveWelcome() {
  saveJsonFile(WELCOME_FILE, welcomeData);
}
function saveGoodbye() {
  saveJsonFile(GOODBYE_FILE, goodbyeData);
}
function saveCommands() {
  saveJsonFile(COMMANDS_FILE, commandsFileCache);
}
function saveAdminDB() {
  saveJsonFile(ADMIN_FILE, adminDB);
}
function loadCommands() {
  commandsFileCache = loadJsonFile(COMMANDS_FILE, {});
  return commandsFileCache;
}

// Helper: extract message text from many message types (pakai fungsi kamu)
function extractMessage(msg) {
  try {
    const m = msg.message;
    if (!m) return "";
    if (m.conversation) return m.conversation;
    if (m.extendedTextMessage?.text) return m.extendedTextMessage.text;
    if (m.imageMessage?.caption) return m.imageMessage.caption;
    if (m.videoMessage?.caption) return m.videoMessage.caption;
    if (m.viewOnceMessage?.message)
      return extractMessage({ message: m.viewOnceMessage.message });
    if (m.ephemeralMessage?.message)
      return extractMessage({ message: m.ephemeralMessage.message });
    return "";
  } catch (e) {
    return "";
  }
}

// Helper: normalisasi nomor (hapus +, non-digit)
function normNumber(n) {
  if (!n) return "";
  let s = String(n).trim();
  if (s.startsWith("+")) s = s.slice(1);
  s = s.replace(/\D/g, "");
  return s;
}

// Helper permission: isOwner / isAdmin (owner = single number string)
async function isUserOwner(sender) {
  const s = String(sender).replace(/\D/g, "");
  return adminDB.owner && s === adminDB.owner;
}
function isUserAdminLocal(sender) {
  const s = String(sender).replace(/\D/g, "");
  return Boolean(adminDB.admins && adminDB.admins[s]);
}
async function isGroupAdmin(sender, participants = []) {
  // participants = metadata.participants
  return (participants || []).some((p) => p.id === sender && p.admin !== null);
}

// Fungsi buka/tutup grup (dipertahankan)
async function setGroupRestriction(jid, sock, restrict, requester) {
  try {
    const metadata = await sock.groupMetadata(jid);
    const adminIds = metadata.participants
      .filter((p) => p.admin !== null)
      .map((p) => p.id);
    if (!adminIds.includes(requester)) {
      await sock.sendMessage(jid, {
        text: "⚠️ Kamu harus admin untuk melakukan ini.",
      });
      return;
    }
    await sock.groupSettingUpdate(
      jid,
      restrict ? "announcement" : "not_announcement"
    );
    await sock.sendMessage(jid, {
      text: restrict
        ? "🔒 Grup telah ditutup untuk anggota (hanya admin bisa kirim pesan)."
        : "🔓 Grup dibuka kembali, semua anggota bisa kirim pesan.",
    });
  } catch (e) {
    console.error("setGroupRestriction error:", e);
  }
}

// Cek jadwal otomatis
async function cekJadwal(sock) {
  try {
    const now = DateTime.now().setZone(TIMEZONE);
    for (const [jid, schedules] of Object.entries(jadwal)) {
      for (const sch of schedules) {
        if (!sch.done) {
          const [hh, mm] = sch.time.split(":").map(Number);
          const actionTime = now.set({
            hour: hh,
            minute: mm,
            second: 0,
            millisecond: 0,
          });
          if (now >= actionTime) {
            try {
              await setGroupRestriction(
                jid,
                sock,
                sch.action === "close",
                sch.requester
              );
              sch.done = true;
              simpanJadwal();
              console.log(
                `Jadwal ${sch.action} grup ${jid} dilakukan pada ${sch.time}`
              );
            } catch (e) {
              console.error("cekJadwal action error:", e);
            }
          }
        }
      }
    }
  } catch (e) {
    console.error("cekJadwal error:", e);
  }
}

// START BOT
async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState("auth_info_baileys");
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    logger: P({ level: "silent" }),
    auth: state,
    browser: ["SmartBotV2", "Chrome", "1.0.0"],
  });

  // isBotAdmin menggunakan 'sock' yang valid -> definisikan di sini
  async function isBotAdmin(jid) {
    try {
      const meta = await sock.groupMetadata(jid);
      const botId = sock.user?.id;
      if (!botId) return false;
      const p = meta.participants.find((x) => x.id === botId);
      return p && p.admin !== null;
    } catch (e) {
      console.error("isBotAdmin error:", e?.message || e);
      return false;
    }
  }

  sock.ev.on("connection.update", (update) => {
    const { connection, lastDisconnect, qr } = update;
    if (qr) {
      qrcode.generate(qr, { small: true });
      console.log("📲 Scan QR code di WhatsApp (Linked Devices)");
    }
    if (connection === "close") {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      console.log("Koneksi terputus:", statusCode);
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
      if (shouldReconnect) {
        console.log("🔁 Mencoba reconnect dalam 5 detik...");
        setTimeout(startBot, 5000);
      } else {
        console.log("🛑 Logged out. Scan QR ulang.");
      }
    } else if (connection === "open") {
      botStartTime = Date.now();
      console.log("✅ SmartBotV2 sudah online!");
    }
  });

  sock.ev.on("creds.update", saveCreds);

  // Run scheduled check immediately & interval
  cekJadwal(sock).catch((e) => console.error(e));
  setInterval(() => cekJadwal(sock).catch((e) => console.error(e)), 60 * 1000);

  // =========================================
  // group-participants.update -> welcome/blacklist/goodbye
  // =========================================
  sock.ev.on("group-participants.update", async (update) => {
    try {
      const { id: jid, participants, action } = update;

      if (action === "add") {
        for (let num of participants) {
          const number = num.split("@")[0];
          if (welcomeData[jid]) {
            const msg = welcomeData[jid].replace(/@user/g, `@${number}`);
            try {
              await sock.sendMessage(jid, {
                text: msg,
                mentions: [num],
              });
            } catch (e) {
              console.error("Failed to send welcome:", e);
            }
          }
        }
      } else if (action === "remove") {
        for (const userId of participants) {
          const number = userId.split("@")[0];
          if (goodbyeData[jid]) {
            const msg = goodbyeData[jid].replace(/@user/g, `@${number}`);
            try {
              await sock.sendMessage(jid, {
                text: msg,
                mentions: [userId],
              });
            } catch (e) {
              console.error("Failed to send goodbye:", e);
            }
          }
        }
      }
    } catch (err) {
      console.error("group-participants.update error:", err);
    }
  });

  // =========================================
  // messages.upsert -> commands & auto-kick by message if necessary
  // =========================================
  sock.ev.on("messages.upsert", async (m) => {
    try {
      const msg = m.messages[0];
      if (!msg || !msg.message || msg.key.fromMe) return;
      // ---- IGNORE PESAN LAMA ----
      const msgTime = Number(msg.messageTimestamp) * 1000; // jadi ms
      if (msgTime < botStartTime) {
        return; // <--- jangan proses
      }

      const from = msg.key.remoteJid;
      const isGroup = from.endsWith("@g.us");
      const sender = isGroup ? msg.key.participant : msg.key.remoteJid;
      const senderNumber = String(sender).split("@")[0];

      // Menggunakan helper extractMessage agar konsisten
      const bodyRaw = extractMessage(msg) || "";
      const textRaw = bodyRaw.trim();
      const text = textRaw.toLowerCase();

      // lanjut metadata grup, command dll...
      let metadata = null;
      let participants = [];
      if (isGroup) {
        try {
          metadata = await sock.groupMetadata(from);
          participants = metadata.participants || [];
        } catch (e) {
          console.warn("Gagal ambil metadata:", e?.message || e);
        }
      }

      // reload commands (jika ada perubahan eksternal)
      loadCommands();

      // ---------- COMMAND HANDLERS ----------
      // HELP
      if (text === "!help" || text === "!menu") {
        let helpText = `🤖 *SmartBotV2 - Menu*\n
Perintah umum:
- !ping -> cek bot
- !uptime -> lama bot online
- !help -> tampilkan menu

Admin/Owner:
- !addadmin 628xxx -> add admin (OWNER)
- !deladmin 628xxx -> remove admin (OWNER)
- !listadmin -> list admin & owner

Group (admin group):
- !setwelcome <text> -> set welcome message
- !setgoodbye <text> -> set goodbye message
- !tagall -> mention semua anggota
- !hidetag <text> -> sembunyikan teks tapi mention semua
- !add 628xxx -> add member by admin
- !kick @tag -> kick member (mention)

Custom commands (bot admin/owner):
- !addcmd trigger|response -> tambah custom command
- !delcmd trigger -> hapus custom command
- !listcmd -> daftar custom commands

Jadwal (admin group):
- !addjadwal HH:MM close|open -> jadwalkan close/open grup
- !listjadwal -> list jadwal grup ini
- !deljadwal INDEX -> hapus jadwal (dari list)

Contoh: !addcmd halo|Halo juga!`;

        await sock.sendMessage(from, { text: helpText });
        return;
      }

      // PING
      if (text === "!ping") {
        await sock.sendMessage(from, { text: "Pong! 🏓" });
        return;
      }

      // UPTIME
      if (text === "!uptime") {
        const now = Date.now();
        const diff = Duration.fromMillis(now - botStartTime).shiftTo(
          "hours",
          "minutes",
          "seconds"
        );
        const up = `${Math.floor(diff.hours)}h ${Math.floor(diff.minutes)}m ${Math.floor(diff.seconds)}s`;
        await sock.sendMessage(from, { text: `⏱ Uptime: ${up}` });
        return;
      }

      // ================= CEK NOMOR ANGGOTA GRUP =================
      if (textRaw.startsWith("!cekno ")) {
        if (!isGroup)
          return sock.sendMessage(from, {
            text: "⚠️ Perintah ini hanya untuk grup.",
          });

        let num = textRaw.split(" ")[1] || "";
        let clean = num.replace(/\D/g, ""); // normalisasi nomor

        if (!clean)
          return sock.sendMessage(from, {
            text: "⚠️ Format: !cekno 628xxxxxx",
          });

        // ambil metadata grup
        let meta;
        try {
          meta = metadata || (await sock.groupMetadata(from));
        } catch (e) {
          return sock.sendMessage(from, {
            text: "⚠️ Gagal mendapatkan data grup.",
          });
        }

        // cek apakah nomor ada dalam daftar peserta
        let found = (meta.participants || []).find((p) => {
          let jid = p.id;
          return jid.includes(clean);
        });

        if (found) {
          return sock.sendMessage(from, {
            text: `✅ Nomor *${clean}* ditemukan di grup.\nID: ${found.id}`,
          });
        } else {
          return sock.sendMessage(from, {
            text: `❌ Nomor *${clean}* TIDAK ditemukan dalam grup.`,
          });
        }
      }

      // =============== ADD ADMIN BOT ==================
      if (textRaw.startsWith("!addadmin ")) {
        let senderNum = String(sender).replace(/\D/g, "");

        if (senderNum !== adminDB.owner)
          return sock.sendMessage(from, {
            text: "❌ Hanya OWNER yang boleh menambah admin.",
          });

        let target = textRaw.split(" ")[1].replace(/\D/g, "");

        if (!target)
          return sock.sendMessage(from, {
            text: "⚠️ Format: !addadmin 628xxxx",
          });

        adminDB.admins[target] = true;
        saveAdminDB();

        return sock.sendMessage(from, {
          text: `✅ Nomor *${target}* telah ditambahkan sebagai Admin Bot.`,
        });
      }

      // =============== DELETE ADMIN BOT ==================
      if (textRaw.startsWith("!deladmin ")) {
        let senderNum = String(sender).replace(/\D/g, "");

        if (senderNum !== adminDB.owner)
          return sock.sendMessage(from, {
            text: "❌ Hanya OWNER yang boleh menghapus admin.",
          });

        let target = textRaw.split(" ")[1].replace(/\D/g, "");

        if (!adminDB.admins[target])
          return sock.sendMessage(from, {
            text: "⚠️ Nomor tersebut bukan admin bot.",
          });

        delete adminDB.admins[target];
        saveAdminDB();

        return sock.sendMessage(from, {
          text: `🗑 Nomor *${target}* telah dihapus dari Admin Bot.`,
        });
      }

      // =============== LIST ADMIN BOT ==================
      if (textRaw === "!listadmin") {
        let list = Object.keys(adminDB.admins || {});

        let textMsg = `👑 *OWNER*: ${adminDB.owner || "-"}\n\n👥 *ADMIN BOT:*\n`;

        if (list.length === 0) textMsg += "- (Belum ada admin)";
        else list.forEach((a) => (textMsg += `- ${a}\n`));

        return sock.sendMessage(from, { text: textMsg });
      }

      // ================= SET WELCOME / GOODBYE =================

      // setwelcome (admin only)
      if (textRaw.startsWith("!setwelcome ")) {
        if (!isGroup)
          return await sock.sendMessage(from, { text: "⚠️ Hanya di grup." });
        const isAdmin = await isGroupAdmin(sender, participants);
        if (!isAdmin)
          return await sock.sendMessage(from, {
            text: "⚠️ Hanya admin yang bisa.",
          });
        const msgText = textRaw.slice("!setwelcome ".length).trim();
        welcomeData[from] = msgText;
        saveWelcome();
        await sock.sendMessage(from, { text: "✅ Welcome message disimpan." });
        return;
      }

      // setgoodbye
      if (textRaw.startsWith("!setgoodbye ")) {
        if (!isGroup)
          return await sock.sendMessage(from, { text: "⚠️ Hanya di grup." });
        const isAdmin = await isGroupAdmin(sender, participants);
        if (!isAdmin)
          return await sock.sendMessage(from, {
            text: "⚠️ Hanya admin yang bisa.",
          });
        const msgText = textRaw.slice("!setgoodbye ".length).trim();
        goodbyeData[from] = msgText;
        saveGoodbye();
        await sock.sendMessage(from, { text: "✅ Goodbye message disimpan." });
        return;
      }

      // tagall example
      if (text.startsWith("!tagall")) {
        if (!isGroup)
          return await sock.sendMessage(from, { text: "⚠️ Hanya di grup." });
        const mentions = (participants || []).map((p) => p.id);
        let textTag = "📢 Tag All:\n\n";
        for (const p of participants || []) textTag += `@${p.id.split("@")[0]} `;
        await sock.sendMessage(from, { text: textTag, mentions });
        return;
      }
      // =========== HIDETAG (tag tanpa teks terlihat) ===========
      if (textRaw.startsWith("!hidetag ")) {
        if (!isGroup)
          return await sock.sendMessage(from, {
            text: "⚠️ Hanya bisa di grup.",
          });

        const isAdmin = await isGroupAdmin(sender, participants);
        if (!isAdmin)
          return await sock.sendMessage(from, {
            text: "⚠️ Hanya admin yang bisa memakai perintah ini.",
          });

        const message = textRaw.slice("!hidetag ".length).trim();
        const mentions = (participants || []).map((p) => p.id);

        await sock.sendMessage(from, {
          text: message || " ",
          mentions,
        });

        return;
      }

      // add member by admin: "!add 628xxx"
      if (textRaw.startsWith("!add ")) {
        if (!isGroup)
          return await sock.sendMessage(from, {
            text: "⚠️ Hanya bisa di grup.",
          });
        const args = textRaw.split(/\s+/);
        if (args.length < 2)
          return await sock.sendMessage(from, {
            text: "⚠️ Format: !add 6281234567890",
          });
        const number = normNumber(args[1]);
        if (!/^[0-9]+$/.test(number))
          return await sock.sendMessage(from, {
            text: "⚠️ Nomor harus angka.",
          });

        const isAdmin = await isGroupAdmin(sender, participants);
        if (!isAdmin)
          return await sock.sendMessage(from, {
            text: "⚠️ Hanya admin yang bisa menambah anggota.",
          });

        const jid = `${number}@s.whatsapp.net`;
        try {
          await sock.groupParticipantsUpdate(from, [jid], "add");
          await sock.sendMessage(from, {
            text: `✅ Berhasil menambahkan ${number}`,
          });
        } catch (e) {
          console.error("Error add:", e);
          await sock.sendMessage(from, {
            text: `❌ Gagal menambahkan ${number}. Pastikan bot admin & nomor pernah chat bot.`,
          });
        }
        return;
      }

      // kick command
      if (textRaw.startsWith("!kick")) {
        if (!isGroup)
          return await sock.sendMessage(from, { text: "⚠️ Hanya di grup." });
        const isAdmin = await isGroupAdmin(sender, participants);
        if (!isAdmin)
          return await sock.sendMessage(from, {
            text: "⚠️ Hanya admin yang bisa mengeluarkan anggota.",
          });

        const mentioned =
          msg.message?.extendedTextMessage?.contextInfo?.mentionedJid || [];
        if (!mentioned.length)
          return await sock.sendMessage(from, {
            text: "⚠️ Mention anggota yang ingin dikeluarkan.\nContoh: !kick @nama",
          });

        try {
          await sock.groupParticipantsUpdate(from, mentioned, "remove");
          await sock.sendMessage(from, {
            text: `✅ Berhasil mengeluarkan ${mentioned.length} anggota.`,
          });
        } catch (e) {
          console.error("Error kick:", e);
          await sock.sendMessage(from, {
            text: "❌ Gagal mengeluarkan. Pastikan bot jadi admin.",
          });
        }
        return;
      }

      // ========== Custom command management ==========
      // Format addcmd: !addcmd trigger|response
      if (textRaw.startsWith("!addcmd ")) {
        const senderNum = String(sender).replace(/\D/g, "");
        if (!isUserOwner(senderNum) && !isUserAdminLocal(senderNum)) {
          return sock.sendMessage(from, {
            text: "⚠️ Hanya Owner atau Admin Bot yang bisa menambah command.",
          });
        }
        const payload = textRaw.slice("!addcmd ".length);
        const sepIndex = payload.indexOf("|");
        if (sepIndex === -1)
          return sock.sendMessage(from, {
            text: "⚠️ Format: !addcmd trigger|response",
          });
        const trig = payload.slice(0, sepIndex).trim().toLowerCase();
        const resp = payload.slice(sepIndex + 1).trim();
        if (!trig || !resp)
          return sock.sendMessage(from, { text: "⚠️ Trigger/response tidak boleh kosong." });

        commandsFileCache[trig] = resp;
        saveCommands();
        return sock.sendMessage(from, { text: `✅ Command *${trig}* ditambahkan.` });
      }

      if (textRaw.startsWith("!delcmd ")) {
        const senderNum = String(sender).replace(/\D/g, "");
        if (!isUserOwner(senderNum) && !isUserAdminLocal(senderNum)) {
          return sock.sendMessage(from, {
            text: "⚠️ Hanya Owner atau Admin Bot yang bisa menghapus command.",
          });
        }
        const trig = textRaw.split(" ")[1]?.trim().toLowerCase();
        if (!trig || !commandsFileCache[trig])
          return sock.sendMessage(from, { text: "⚠️ Trigger tidak ditemukan." });
        delete commandsFileCache[trig];
        saveCommands();
        return sock.sendMessage(from, { text: `🗑 Command *${trig}* dihapus.` });
      }

      if (textRaw === "!listcmd") {
        const keys = Object.keys(commandsFileCache || {});
        if (keys.length === 0) return sock.sendMessage(from, { text: "Tidak ada custom command." });
        let out = "📜 Custom commands:\n\n";
        keys.forEach((k) => (out += `- ${k}\n`));
        return sock.sendMessage(from, { text: out });
      }

      // ========== Jadwal management (group admin) ==========
      // !addjadwal 15:30 close
      if (textRaw.startsWith("!addjadwal ")) {
        if (!isGroup)
          return sock.sendMessage(from, { text: "⚠️ Hanya di grup." });
        const isAdmin = await isGroupAdmin(sender, participants);
        if (!isAdmin)
          return sock.sendMessage(from, { text: "⚠️ Hanya admin grup yang bisa menjadwalkan." });

        const parts = textRaw.split(/\s+/);
        if (parts.length < 3)
          return sock.sendMessage(from, { text: "⚠️ Format: !addjadwal HH:MM close|open" });

        const time = parts[1];
        const action = parts[2].toLowerCase();
        if (!/^\d{1,2}:\d{2}$/.test(time) || !["close", "open"].includes(action))
          return sock.sendMessage(from, { text: "⚠️ Contoh: !addjadwal 07:30 close" });

        if (!jadwal[from]) jadwal[from] = [];
        jadwal[from].push({
          time,
          action,
          requester: sender,
          done: false,
        });
        simpanJadwal();
        return sock.sendMessage(from, { text: `✅ Jadwal ${action} disimpan pada ${time}` });
      }

      // !listjadwal
      if (textRaw === "!listjadwal") {
        if (!isGroup)
          return sock.sendMessage(from, { text: "⚠️ Hanya di grup." });
        const list = jadwal[from] || [];
        if (list.length === 0) return sock.sendMessage(from, { text: "Tidak ada jadwal." });
        let out = "📅 Jadwal grup ini:\n\n";
        list.forEach((s, i) => {
          out += `${i}. ${s.time} -> ${s.action} [${s.done ? "done" : "pending"}]\n`;
        });
        return sock.sendMessage(from, { text: out });
      }

      // !deljadwal INDEX
      if (textRaw.startsWith("!deljadwal ")) {
        if (!isGroup)
          return sock.sendMessage(from, { text: "⚠️ Hanya di grup." });
        const isAdmin = await isGroupAdmin(sender, participants);
        if (!isAdmin)
          return sock.sendMessage(from, { text: "⚠️ Hanya admin grup yang bisa hapus jadwal." });
        const idx = Number(textRaw.split(" ")[1]);
        if (isNaN(idx)) return sock.sendMessage(from, { text: "⚠️ Format: !deljadwal INDEX" });
        const list = jadwal[from] || [];
        if (!list[idx]) return sock.sendMessage(from, { text: "⚠️ Index tidak ditemukan." });
        list.splice(idx, 1);
        jadwal[from] = list;
        simpanJadwal();
        return sock.sendMessage(from, { text: `🗑 Jadwal index ${idx} dihapus.` });
      }

      // ========== EXECUTE custom command (exact match) ==========
      if (text && commandsFileCache[text]) {
        await sock.sendMessage(from, { text: commandsFileCache[text] });
        return;
      }

      // Jika ingin tambahkan hook lain (mis. auto-responder), tambahkan di sini.

    } catch (e) {
      console.error("messages.upsert handler error:", e);
    }
  });
} // end startBot

startBot().catch((e) => {
  console.error("startBot error:", e);
});
