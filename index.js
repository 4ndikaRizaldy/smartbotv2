// index.js - SmartBotV2 (fixed & cleaned)
// Required packages:
// npm i @whiskeysockets/baileys pino qrcode-terminal luxon node-schedule

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
const schedule = require("node-schedule");

// ---------------- CONFIG ----------------
const TIMEZONE = "Asia/Makassar";
const SCHEDULE_FILE = "./data/schedule.json";
const COMMANDS_FILE = "./commands.json";
const WELCOME_FILE = "./welcome.json";
const GOODBYE_FILE = "./goodbye.json";

// ensure data folder
if (!fs.existsSync("./data")) fs.mkdirSync("./data");

// ---------------- JSON helpers ----------------
function safeReadJson(path, fallback = {}) {
  try {
    if (!fs.existsSync(path)) {
      fs.writeFileSync(path, JSON.stringify(fallback, null, 2));
      return fallback;
    }
    const raw = fs.readFileSync(path, "utf8").trim();
    return raw ? JSON.parse(raw) : fallback;
  } catch (e) {
    console.error(`Error reading ${path}:`, e?.message || e);
    try { fs.writeFileSync(path, JSON.stringify(fallback, null, 2)); } catch {}
    return fallback;
  }
}
function safeWriteJson(path, data) {
  try {
    fs.writeFileSync(path, JSON.stringify(data, null, 2));
  } catch (e) {
    console.error(`Error writing ${path}:`, e?.message || e);
  }
}

// ---------------- Persistent data loaded at start ----------------
let scheduleStore = safeReadJson(SCHEDULE_FILE, { groups: {} });
let welcomeData = safeReadJson(WELCOME_FILE, {});
let goodbyeData = safeReadJson(GOODBYE_FILE, {});
let commandsFileCache = safeReadJson(COMMANDS_FILE, {});

// convenience saver
function saveAllStores() {
  safeWriteJson(SCHEDULE_FILE, scheduleStore);
  safeWriteJson(WELCOME_FILE, welcomeData);
  safeWriteJson(GOODBYE_FILE, goodbyeData);
  safeWriteJson(COMMANDS_FILE, commandsFileCache);
}

// ---------------- Utility helpers ----------------
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
function normNumber(n) {
  if (!n) return "";
  let s = String(n).trim();
  if (s.startsWith("+")) s = s.slice(1);
  s = s.replace(/\D/g, "");
  return s;
}

// participants admin check (participants is array from group metadata)
async function isGroupAdmin(sender, participants = []) {
  try {
    // sender passed as '628xxx@s.whatsapp.net' or '628xxx' (maybe)
    const idCheck = (s) => {
      if (!s) return "";
      if (s.includes("@")) return s;
      return `${s}@s.whatsapp.net`;
    };
    const targetId = idCheck(sender);
    const user = participants.find((p) => {
      const pid = p?.id || p?.participant || p;
      return pid === targetId;
    });
    // Baileys participant admin field variations
    return (
      user?.admin === "admin" ||
      user?.admin === "superadmin" ||
      user?.isAdmin === true ||
      user?.role === "admin" ||
      user?.role === "superadmin"
    );
  } catch (e) {
    return false;
  }
}

// ---------------- Scheduler jobs registry ----------------
const jobs = { open: {}, close: {} };

function cancelGroupJobs(groupId) {
  if (jobs.open[groupId]) {
    try { jobs.open[groupId].cancel(); } catch {}
    delete jobs.open[groupId];
  }
  if (jobs.close[groupId]) {
    try { jobs.close[groupId].cancel(); } catch {}
    delete jobs.close[groupId];
  }
}
function toCron(hhmm) {
  if (!hhmm) return null;
  const [hh, mm] = String(hhmm).split(":").map((s) => s.padStart(2, "0"));
  return `${mm} ${hh} * * *`;
}
function registerGroupSchedule(sock, groupId, openTimeStr, closeTimeStr) {
  cancelGroupJobs(groupId);
  const openCron = toCron(openTimeStr);
  const closeCron = toCron(closeTimeStr);

  if (openCron) {
    try {
      const job = schedule.scheduleJob(`open-${groupId}`, openCron, async () => {
        try {
          await sock.groupSettingUpdate(groupId, "not_announcement");
          await sock.sendMessage(groupId, { text: "🔓 Grup dibuka otomatis." });
          console.log(`[schedule] OPEN executed for ${groupId} at ${DateTime.now().setZone(TIMEZONE).toISO()}`);
        } catch (err) { console.error("Error executing open job:", err); }
      });
      jobs.open[groupId] = job;
    } catch (e) { console.error("Failed register open cron:", e); }
  }

  if (closeCron) {
    try {
      const job = schedule.scheduleJob(`close-${groupId}`, closeCron, async () => {
        try {
          await sock.groupSettingUpdate(groupId, "announcement");
          await sock.sendMessage(groupId, { text: "🔒 Grup ditutup otomatis." });
          console.log(`[schedule] CLOSE executed for ${groupId} at ${DateTime.now().setZone(TIMEZONE).toISO()}`);
        } catch (err) { console.error("Error executing close job:", err); }
      });
      jobs.close[groupId] = job;
    } catch (e) { console.error("Failed register close cron:", e); }
  }
}
function registerAllSchedules(sock) {
  const groups = scheduleStore.groups || {};
  for (const gid of Object.keys(groups)) {
    const g = groups[gid];
    registerGroupSchedule(sock, gid, g.open || null, g.close || null);
  }
}

// ---------------- Main bot ----------------
let botStartTime = Date.now();

async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState("auth_info_baileys");
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    logger: P({ level: "silent" }),
    auth: state,
    browser: ["SmartBotV2", "Chrome", "1.0.0"],
  });

  // helper: is bot admin in group
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
      // register schedules now that sock exists
      registerAllSchedules(sock);
    }
  });

  sock.ev.on("creds.update", saveCreds);

  // ---------------- Welcome / Goodbye handler (robust) ----------------
  sock.ev.on("group-participants.update", async (update) => {
    try {
      console.log("GROUP EVENT:", JSON.stringify(update));

      const groupId = update.id || update.jid || update.groupId;
      const action = String(update.action || "").toLowerCase();
      const participants = update.participants || update.participant || [];

      // message templates stored per groupId in welcomeData/goodbyeData
      const welcomeMsg = welcomeData[groupId];
      const goodbyeMsg = goodbyeData[groupId];

      // helper: extract full jid (prefer phoneNumber field if present)
      const extractFullJid = (p) => {
        if (!p) return null;
        if (typeof p === "string") return p;
        if (p.phoneNumber) return p.phoneNumber;
        if (p.id && String(p.id).includes("@")) return p.id;
        // fallback attempt: if p.participant exists
        if (p.participant) return p.participant;
        return null;
      };

      for (const p of participants) {
        const fullJid = extractFullJid(p);
        if (!fullJid) continue;
        const number = String(fullJid).split("@")[0];

        // JOIN-like actions
        if (["add", "invite", "join", "joined", "insert", "create", ""].includes(action)) {
          if (welcomeMsg) {
            const txt = String(welcomeMsg).replace(/@user/g, `@${number}`);
            try {
              // mentions need the full whatsapp jid (e.g. 628xx@s.whatsapp.net)
              await sock.sendMessage(groupId, { text: txt, mentions: [fullJid] });
              console.log(`WELCOME SENT to ${fullJid} in ${groupId}: ${txt}`);
            } catch (e) {
              console.error("Failed welcome with mentions (retry without mentions):", e?.message || e);
              try { await sock.sendMessage(groupId, { text: txt }); } catch (e2) { console.error("Fallback welcome failed:", e2); }
            }
          }
        }

        // LEAVE-like actions
        if (["remove", "leave", "left"].includes(action)) {
          if (goodbyeMsg) {
            const txt = String(goodbyeMsg).replace(/@user/g, `@${number}`);
            try {
              await sock.sendMessage(groupId, { text: txt, mentions: [fullJid] });
              console.log(`GOODBYE SENT to ${fullJid} in ${groupId}: ${txt}`);
            } catch (e) {
              console.error("Failed goodbye with mentions (retry without mentions):", e?.message || e);
              try { await sock.sendMessage(groupId, { text: txt }); } catch (e2) { console.error("Fallback goodbye failed:", e2); }
            }
          }
        }
      }
    } catch (err) {
      console.error("group-participants.update error:", err);
    }
  });

  // -------------- messages handler (commands + custom) --------------
  sock.ev.on("messages.upsert", async (m) => {
    try {
      const msg = m.messages[0];
      if (!msg || !msg.message || msg.key.fromMe) return;

      // ignore old messages from before bot started
      const msgTime = Number(msg.messageTimestamp) * 1000;
      if (msgTime < botStartTime) return;

      const from = msg.key.remoteJid;
      const isGroup = from && from.endsWith && from.endsWith("@g.us");
      const sender = isGroup ? msg.key.participant : msg.key.remoteJid;

      const bodyRaw = extractMessage(msg) || "";
      const textRaw = bodyRaw.trim();
      const text = textRaw.toLowerCase();

      // group metadata if needed for admin checks/mentions
      let metadata = null;
      let participants = [];
      if (isGroup) {
        try {
          metadata = await sock.groupMetadata(from);
          participants = metadata.participants || [];
        } catch (e) {
          // ignore metadata errors
        }
      }

      // reload commands in case edited externally
      commandsFileCache = safeReadJson(COMMANDS_FILE, commandsFileCache);

      if (!text) return;

      // ---------- Basic commands ----------
      if (text === "!help" || text === "!menu") {
        const helpText = `🤖 SmartBotV2 - Menu
Perintah umum:
- !ping
- !uptime
- !help / !menu

Group (admin group):
- !setwelcome <text>
- !setgoodbye <text>
- !tagall
- !hidetag <text>
- !add 628xxx
- !kick @tag

Jadwal auto open/close (admin grup):
- !setopen HH:MM
- !setclose HH:MM
- !viewschedule
- !delschedule

Manual:
- !buka
- !tutup

Custom commands (owner/admin bot):
- !addcmd trigger|response
- !delcmd trigger
- !listcmd
`;
        await sock.sendMessage(from, { text: helpText });
        return;
      }

      if (text === "!ping") {
        await sock.sendMessage(from, { text: "Pong! 🏓" });
        return;
      }

      if (text === "!uptime") {
        const now = Date.now();
        const diff = Duration.fromMillis(now - botStartTime).shiftTo("hours", "minutes", "seconds");
        const up = `${Math.floor(diff.hours)}h ${Math.floor(diff.minutes)}m ${Math.floor(diff.seconds)}s`;
        await sock.sendMessage(from, { text: `⏱ Uptime: ${up}` });
        return;
      }

      // ---------------- Welcome / Goodbye commands ----------------
      if (textRaw.startsWith("!setwelcome ")) {
        if (!isGroup) return sock.sendMessage(from, { text: "⚠️ Hanya di grup." });

        const isAdmin = await isGroupAdmin(sender, participants);
        if (!isAdmin) return sock.sendMessage(from, { text: "⚠️ Hanya admin yang bisa." });

        const msgText = textRaw.replace("!setwelcome", "").trim();
        if (!msgText) return sock.sendMessage(from, { text: "Contoh: !setwelcome Selamat datang @user" });

        welcomeData[from] = msgText;
        safeWriteJson(WELCOME_FILE, welcomeData);

        console.log(`WELCOME SAVED → ${from}: ${msgText}`);
        return sock.sendMessage(from, { text: "✅ Welcome message disimpan!" });
      }

      if (textRaw.startsWith("!setgoodbye ")) {
        if (!isGroup) return sock.sendMessage(from, { text: "⚠️ Hanya di grup." });

        const isAdmin = await isGroupAdmin(sender, participants);
        if (!isAdmin) return sock.sendMessage(from, { text: "⚠️ Hanya admin yang bisa." });

        const msgText = textRaw.replace("!setgoodbye", "").trim();
        if (!msgText) return sock.sendMessage(from, { text: "Contoh: !setgoodbye Selamat jalan @user" });

        goodbyeData[from] = msgText;
        safeWriteJson(GOODBYE_FILE, goodbyeData);

        console.log(`GOODBYE SAVED → ${from}: ${msgText}`);
        return sock.sendMessage(from, { text: "✅ Goodbye message disimpan!" });
      }

      // ---------------- Tagging / hidetag / add / kick ----------------
      if (text.startsWith("!tagall")) {
        if (!isGroup) return sock.sendMessage(from, { text: "⚠️ Hanya di grup." });
        const mentions = (participants || []).map((p) => p.id || p.participant || p);
        let textTag = "📢 Tag All:\n\n";
        for (const p of mentions) textTag += `@${String(p).split("@")[0]} `;
        await sock.sendMessage(from, { text: textTag, mentions });
        return;
      }

      if (textRaw.startsWith("!hidetag ")) {
        if (!isGroup) return sock.sendMessage(from, { text: "⚠️ Hanya di grup." });
        const isAdmin = await isGroupAdmin(sender, participants);
        if (!isAdmin) return sock.sendMessage(from, { text: "⚠️ Hanya admin yang bisa." });
        const message = textRaw.slice("!hidetag ".length).trim();
        const mentions = (participants || []).map((p) => p.id || p.participant || p);
        await sock.sendMessage(from, { text: message || " ", mentions });
        return;
      }

      if (textRaw.startsWith("!add ")) {
        if (!isGroup) return sock.sendMessage(from, { text: "⚠️ Hanya di grup." });
        const args = textRaw.split(/\s+/);
        if (args.length < 2) return sock.sendMessage(from, { text: "⚠️ Format: !add 6281234567890" });
        const number = normNumber(args[1]);
        if (!/^[0-9]+$/.test(number)) return sock.sendMessage(from, { text: "⚠️ Nomor harus angka." });
        const isAdmin = await isGroupAdmin(sender, participants);
        if (!isAdmin) return sock.sendMessage(from, { text: "⚠️ Hanya admin yang bisa menambah anggota." });
        const jid = `${number}@s.whatsapp.net`;
        try {
          await sock.groupParticipantsUpdate(from, [jid], "add");
          await sock.sendMessage(from, { text: `✅ Berhasil menambahkan ${number}` });
        } catch (e) {
          console.error("Error add:", e);
          await sock.sendMessage(from, { text: `❌ Gagal menambahkan ${number}. Pastikan bot admin & nomor pernah chat bot.` });
        }
        return;
      }

      if (textRaw.startsWith("!kick")) {
        if (!isGroup) return sock.sendMessage(from, { text: "⚠️ Hanya di grup." });
        const isAdmin = await isGroupAdmin(sender, participants);
        if (!isAdmin) return sock.sendMessage(from, { text: "⚠️ Hanya admin yang bisa mengeluarkan anggota." });
        const mentioned = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid || [];
        if (!mentioned.length) return sock.sendMessage(from, { text: "⚠️ Mention anggota. Contoh: !kick @tag" });
        try {
          await sock.groupParticipantsUpdate(from, mentioned, "remove");
          await sock.sendMessage(from, { text: `✅ Berhasil mengeluarkan ${mentioned.length} anggota.` });
        } catch (e) {
          console.error("Error kick:", e);
          await sock.sendMessage(from, { text: "❌ Gagal mengeluarkan. Pastikan bot jadi admin." });
        }
        return;
      }

      // ---------------- Manual open / close ----------------
      if (text === "!buka") {
        if (!isGroup) return sock.sendMessage(from, { text: "⚠️ Perintah ini hanya untuk grup." });
        const isAdmin = await isGroupAdmin(sender, participants);
        if (!isAdmin) return sock.sendMessage(from, { text: "⚠️ Hanya admin grup yang bisa buka grup." });
        try {
          await sock.groupSettingUpdate(from, "not_announcement");
          return sock.sendMessage(from, { text: "🔓 Grup dibuka oleh admin." });
        } catch (e) {
          console.error("Failed manual open:", e);
          return sock.sendMessage(from, { text: "❌ Gagal membuka grup." });
        }
      }

      if (text === "!tutup") {
        if (!isGroup) return sock.sendMessage(from, { text: "⚠️ Perintah ini hanya untuk grup." });
        const isAdmin = await isGroupAdmin(sender, participants);
        if (!isAdmin) return sock.sendMessage(from, { text: "⚠️ Hanya admin grup yang bisa menutup grup." });
        try {
          await sock.groupSettingUpdate(from, "announcement");
          return sock.sendMessage(from, { text: "🔒 Grup ditutup oleh admin." });
        } catch (e) {
          console.error("Failed manual close:", e);
          return sock.sendMessage(from, { text: "❌ Gagal menutup grup." });
        }
      }

      // ---------------- Schedule commands ----------------
      if (textRaw.startsWith("!setopen ")) {
        if (!isGroup) return sock.sendMessage(from, { text: "⚠️ Hanya di grup." });
        const isAdmin = await isGroupAdmin(sender, participants);
        if (!isAdmin) return sock.sendMessage(from, { text: "⚠️ Admin only." });
        const time = textRaw.split(" ")[1];
        if (!/^\d{1,2}:\d{2}$/.test(time)) return sock.sendMessage(from, { text: "⚠️ Format HH:MM (24 jam)" });
        if (!scheduleStore.groups[from]) scheduleStore.groups[from] = {};
        scheduleStore.groups[from].open = time;
        safeWriteJson(SCHEDULE_FILE, scheduleStore);
        registerGroupSchedule(sock, from, time, scheduleStore.groups[from].close);
        return sock.sendMessage(from, { text: `✅ Jam buka otomatis diset: ${time}` });
      }

      if (textRaw.startsWith("!setclose ")) {
        if (!isGroup) return sock.sendMessage(from, { text: "⚠️ Hanya di grup." });
        const isAdmin = await isGroupAdmin(sender, participants);
        if (!isAdmin) return sock.sendMessage(from, { text: "⚠️ Admin only." });
        const time = textRaw.split(" ")[1];
        if (!/^\d{1,2}:\d{2}$/.test(time)) return sock.sendMessage(from, { text: "⚠️ Format HH:MM (24 jam)" });
        if (!scheduleStore.groups[from]) scheduleStore.groups[from] = {};
        scheduleStore.groups[from].close = time;
        safeWriteJson(SCHEDULE_FILE, scheduleStore);
        registerGroupSchedule(sock, from, scheduleStore.groups[from].open, time);
        return sock.sendMessage(from, { text: `✅ Jam tutup otomatis diset: ${time}` });
      }

      if (text === "!viewschedule") {
        if (!isGroup) return sock.sendMessage(from, { text: "⚠️ Hanya di grup." });
        const g = scheduleStore.groups[from] || {};
        const open = g.open ? g.open : "❌ belum diset";
        const close = g.close ? g.close : "❌ belum diset";
        return sock.sendMessage(from, { text: `📅 *Schedule Grup*\n\n🔓 Buka: ${open}\n🔒 Tutup: ${close}` });
      }

      if (text === "!delschedule") {
        if (!isGroup) return sock.sendMessage(from, { text: "⚠️ Hanya di grup." });
        const isAdmin = await isGroupAdmin(sender, participants);
        if (!isAdmin) return sock.sendMessage(from, { text: "⚠️ Admin only." });
        cancelGroupJobs(from);
        delete scheduleStore.groups[from];
        safeWriteJson(SCHEDULE_FILE, scheduleStore);
        return sock.sendMessage(from, { text: "🗑 Jadwal auto open/close dihapus." });
      }

      // ---------------- Custom commands ----------------
      if (textRaw.startsWith("!addcmd ")) {
        const parts = textRaw.replace("!addcmd ", "").split("|");
        if (parts.length < 2) return sock.sendMessage(from, { text: "⚠️ Format: !addcmd trigger|respon" });
        const trigger = parts[0].trim().toLowerCase();
        const response = parts[1].trim();
        commandsFileCache[trigger] = response;
        safeWriteJson(COMMANDS_FILE, commandsFileCache);
        return sock.sendMessage(from, { text: `✅ Command disimpan: ${trigger}` });
      }

      if (textRaw.startsWith("!delcmd ")) {
        const trigger = textRaw.replace("!delcmd ", "").trim().toLowerCase();
        if (!commandsFileCache[trigger]) return sock.sendMessage(from, { text: "❌ Command tidak ditemukan." });
        delete commandsFileCache[trigger];
        safeWriteJson(COMMANDS_FILE, commandsFileCache);
        return sock.sendMessage(from, { text: `🗑 Command ${trigger} dihapus.` });
      }

      if (text === "!listcmd") {
        const keys = Object.keys(commandsFileCache || {});
        if (keys.length === 0) return sock.sendMessage(from, { text: "❌ Tidak ada custom command." });
        let out = "📚 *Daftar Custom Command*\n\n";
        keys.forEach((k) => (out += `- ${k}\n`));
        return sock.sendMessage(from, { text: out });
      }

      // execute exact-match custom command
      if (commandsFileCache[text]) {
        return sock.sendMessage(from, { text: commandsFileCache[text] });
      }

    } catch (err) {
      console.error("messages.upsert handler error:", err);
    }
  });

} // end startBot

startBot().catch((e) => {
  console.error("startBot error:", e);
});
