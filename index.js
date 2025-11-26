const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
} = require("@whiskeysockets/baileys");
const P = require("pino");
const qrcode = require("qrcode-terminal");
const { DateTime } = require("luxon");
const fs = require("fs");

// Konfigurasi
const TIMEZONE = "Asia/Makassar";
const SCHEDULE_FILE = "./jadwal.json";
const COMMANDS_FILE = "./commands.json";
const BLACKLIST_FILE = "./blacklist.json";
const GOODBYE_FILE = "./goodbye.json";
const WELCOME_FILE = "./welcome.json";

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
    fs.writeFileSync(path, JSON.stringify(fallback, null, 2));
    return fallback;
  }
}
function saveJsonFile(path, data) {
  fs.writeFileSync(path, JSON.stringify(data, null, 2));
}

// Data (di-load sekali saat start)
let jadwal = loadJsonFile(SCHEDULE_FILE);
let welcomeData = loadJsonFile(WELCOME_FILE);
let goodbyeData = loadJsonFile(GOODBYE_FILE);
let blacklist = {};
let commandsFileCache = loadJsonFile(COMMANDS_FILE);

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
function saveBlacklist() {
  saveJsonFile(BLACKLIST_FILE, blacklist);
}
function saveCommands() {
  saveJsonFile(COMMANDS_FILE, commandsFileCache);
}
function loadCommands() {
  return loadJsonFile(COMMANDS_FILE);
}
function loadBlacklist() {
  if (fs.existsSync("./blacklist.json")) {
    blacklist = JSON.parse(fs.readFileSync("./blacklist.json"));
  }
}

function saveBlacklist() {
  fs.writeFileSync("./blacklist.json", JSON.stringify(blacklist, null, 2));
}

loadBlacklist();

// Helper: extract message text from many message types
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

// Fungsi buka/tutup grup
async function setGroupRestriction(jid, sock, restrict, sender) {
  try {
    const metadata = await sock.groupMetadata(jid);
    const adminIds = metadata.participants
      .filter((p) => p.admin !== null)
      .map((p) => p.id);
    if (!adminIds.includes(sender)) {
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
      const botIsAdmin = await isBotAdmin(jid);

      if (action === "add") {
        for (let num of participants) {
          let number = num.split("@")[0];

          // Cek apakah grup punya blacklist
          if (blacklist[jid] && blacklist[jid][number]) {
            try {
              await sock.groupParticipantsUpdate(id, [num], "remove");
              await sock.sendMessage(id, {
                text: `⚠️ Anggota dengan nomor *${number}* otomatis dikeluarkan karena masuk blacklist grup ini.`,
              });
            } catch (err) {
              console.log("Gagal kick:", err);
            }
          }

          // welcome
          if (welcomeData[jid]) {
            const message = welcomeData[jid].replace(
              /@user/g,
              `@${userNumber}`
            );
            try {
              await sock.sendMessage(jid, {
                text: message,
                mentions: [userId],
              });
            } catch (e) {
              console.error("Failed to send welcome:", e);
            }
          }
        }
      } else if (action === "remove") {
        for (const userId of participants) {
          if (!userId || typeof userId !== "string") continue;
          const userNumber = userId.split("@")[0];
          if (goodbyeData[jid]) {
            const message = goodbyeData[jid].replace(
              /@user/g,
              `@${userNumber}`
            );
            try {
              await sock.sendMessage(jid, {
                text: message,
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

      const from = msg.key.remoteJid;
      const sender = msg.key.participant || msg.key.remoteJid;
      const textRaw = extractMessage(msg);
      const text = (textRaw || "").toLowerCase();

      // apakah grup?
      const isGroup = from && from.endsWith && from.endsWith("@g.us");
      // WAJIB ADA INI
      const body =
        msg.message.conversation ||
        msg.message?.extendedTextMessage?.text ||
        msg.message?.imageMessage?.caption ||
        msg.message?.videoMessage?.caption ||
        "";

      // ambil metadata & participants hanya jika grup (bungkus dengan try)
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

      // AUTO-KICK jika pengirim (message) sendiri masuk blacklist
      if (isGroup) {
        const senderNumber = normNumber(String(sender).split("@")[0]);
        if (blacklist[from] && blacklist[from][senderNumber]) {
          const botAdmin = await isBotAdmin(from);
          if (botAdmin) {
            try {
              await sock.groupParticipantsUpdate(from, [sender], "remove");
              await sock.sendMessage(from, {
                text: `🚫 Nomor *${senderNumber}* dikeluarkan (blacklist).`,
              });
            } catch (e) {
              console.error("Failed to kick blacklisted sender:", e);
              await sock.sendMessage(from, {
                text: "⚠️ Gagal mengeluarkan (periksa hak admin).",
              });
            }
          } else {
            await sock.sendMessage(from, {
              text: "⚠️ Bot bukan admin, tidak bisa kick.",
            });
          }
          return;
        }
      }

      // reload commands from file (optional) or use cache
      const commands = loadCommands();

      // ---------- COMMAND HANDLERS ----------
      if (text === "!ping") {
        await sock.sendMessage(from, { text: "Pong! 🏓" });
        return;
      }

      // blacklist add/del (admin only)
      if (textRaw.startsWith("!blacklist ")) {
        const adminIds = (participants || [])
          .filter((p) => p.admin !== null)
          .map((p) => p.id);
        if (!adminIds.includes(sender)) {
          return sock.sendMessage(from, {
            text: "❌ Hanya admin yang bisa memakai perintah ini.",
          });
        }

        const args = textRaw.split(" ");
        if (args.length < 3) {
          return sock.sendMessage(from, {
            text: "⚠️ Format:\n!blacklist add 628xxxx\n!blacklist del 628xxxx",
          });
        }

        const action = args[1].toLowerCase();
        let number = (typeof num === "string" ? num.split("@")[0] : "").replace(
          /\D/g,
          ""
        ); // ambil angka saja

        // Buat grup ini punya blacklist sendiri
        if (!blacklist[from]) blacklist[from] = {};

        if (action === "add") {
          blacklist[from][number] = true;
          saveBlacklist();
          return sock.sendMessage(from, {
            text: `✅ Nomor ${number} ditambahkan ke blacklist grup ini.`,
          });
        }

        if (action === "del") {
          delete blacklist[from][number];
          saveBlacklist();
          return sock.sendMessage(from, {
            text: `✅ Nomor ${number} dihapus dari blacklist grup ini.`,
          });
        }

        return sock.sendMessage(from, { text: "⚠️ Gunakan add atau del." });
      }

      // setwelcome (admin only)
      if (textRaw.startsWith("!setwelcome ")) {
        if (!isGroup)
          return await sock.sendMessage(from, { text: "⚠️ Hanya di grup." });
        const adminIds = (participants || [])
          .filter((p) => p.admin !== null)
          .map((p) => p.id);
        if (!adminIds.includes(sender))
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
        const adminIds = (participants || [])
          .filter((p) => p.admin !== null)
          .map((p) => p.id);
        if (!adminIds.includes(sender))
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
        for (const p of participants || [])
          textTag += `@${p.id.split("@")[0]} `;
        await sock.sendMessage(from, { text: textTag, mentions });
        return;
      }
      // =========== HIDETAG (tag tanpa teks terlihat) ===========
      if (textRaw.startsWith("!hidetag ")) {
        if (!isGroup)
          return await sock.sendMessage(from, {
            text: "⚠️ Hanya bisa di grup.",
          });

        const adminIds = (participants || [])
          .filter((p) => p.admin !== null)
          .map((p) => p.id);

        if (!adminIds.includes(sender))
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

        const adminIds = (participants || [])
          .filter((p) => p.admin !== null)
          .map((p) => p.id);
        if (!adminIds.includes(sender))
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
        const adminIds = (participants || [])
          .filter((p) => p.admin !== null)
          .map((p) => p.id);
        if (!adminIds.includes(sender))
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

      // jadwal commands, addcmd/delcmd/listcmd, etc. (you can re-add other handlers here)
      // Example custom commands execution:
      if (text && commandsFileCache[text]) {
        await sock.sendMessage(from, { text: commandsFileCache[text] });
        return;
      }
    } catch (e) {
      console.error("messages.upsert handler error:", e);
    }
  });
} // end startBot

startBot().catch((e) => {
  console.error("startBot error:", e);
});
