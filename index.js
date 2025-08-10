const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  delay,
} = require("@whiskeysockets/baileys");
const P = require("pino");
const qrcode = require("qrcode-terminal");
const { DateTime } = require("luxon");
const fs = require("fs");
const path = "./commands.json";

const TIMEZONE = "Asia/Makassar"; // zona waktu eksplisit
const SCHEDULE_FILE = "./jadwal.json"; // file simpan jadwal

// Load atau buat file jadwal
let jadwal = {};
if (fs.existsSync(SCHEDULE_FILE)) {
  jadwal = JSON.parse(fs.readFileSync(SCHEDULE_FILE, "utf-8"));
} else {
  fs.writeFileSync(SCHEDULE_FILE, JSON.stringify(jadwal, null, 2));
}

// Simpan jadwal ke file
function simpanJadwal() {
  fs.writeFileSync(SCHEDULE_FILE, JSON.stringify(jadwal, null, 2));
}

// Fungsi load dan save perintah
function loadCommands() {
  if (!fs.existsSync(path)) return {};
  const data = fs.readFileSync(path);
  return JSON.parse(data);
}

function saveCommands(commands) {
  fs.writeFileSync(path, JSON.stringify(commands, null, 2));
}

// Fungsi buka/tutup grup
async function setGroupRestriction(jid, sock, restrict, sender) {
  try {
    // Cek apakah sender admin dulu
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
    console.error(e);
  }
}

// Fungsi cek dan jalankan jadwal otomatis
async function cekJadwal(sock) {
  const now = DateTime.now().setZone(TIMEZONE);
  for (const [jid, schedules] of Object.entries(jadwal)) {
    for (const sch of schedules) {
      if (!sch.done) {
        // Format waktu: "HH:mm"
        const [hh, mm] = sch.time.split(":").map(Number);
        const actionTime = now.set({
          hour: hh,
          minute: mm,
          second: 0,
          millisecond: 0,
        });
        if (now >= actionTime) {
          // Lakukan aksi buka/tutup grup
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
        }
      }
    }
  }
}

async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState("auth_info_baileys");

  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    logger: P({ level: "silent" }),
    auth: state,
    browser: ["SmartBotV2", "Chrome", "1.0.0"],
  });

  sock.ev.on("connection.update", (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      qrcode.generate(qr, { small: true });
      console.log("📲 Scan QR code di WhatsApp (Linked Devices)");
    }

    if (connection === "close") {
      const shouldReconnect =
        lastDisconnect?.error?.output?.statusCode !==
        DisconnectReason.loggedOut;
      console.log("Koneksi terputus, reconnect:", shouldReconnect);
      if (shouldReconnect) {
        startBot();
      }
    } else if (connection === "open") {
      console.log("✅ SmartBotV2 sudah online!");
    }
  });

  sock.ev.on("creds.update", saveCreds);

  // Cek jadwal tiap menit sekali
  setInterval(() => cekJadwal(sock), 60 * 1000);

  sock.ev.on("messages.upsert", async (m) => {
    const msg = m.messages[0];
    if (!msg.message || msg.key.fromMe) return;

    const from = msg.key.remoteJid;
    const sender = msg.key.participant || msg.key.remoteJid; // sender di grup/DM
    const pesan =
      msg.message.conversation || msg.message.extendedTextMessage?.text || "";

    console.log(`[Pesan] ${from} : ${pesan}`);

    const text = pesan.toLowerCase();
    const commands = loadCommands();
    if (!from.endsWith("@g.us")) return; // Pastikan pesan dari grup

    // Ambil metadata grup dan peserta
    const metadata = await sock.groupMetadata(from);
    const participants = metadata.participants;

    // !ping
    if (text === "!ping") {
      await sock.sendMessage(from, { text: "Pong! 🏓" });
      return;
    }

    // !tagall
    if (text.startsWith("!tagall")) {
      if (!from.endsWith("@g.us")) {
        await sock.sendMessage(from, {
          text: "⚠️ Perintah ini hanya untuk grup!",
        });
        return;
      }
      const metadata = await sock.groupMetadata(from);
      const participants = metadata.participants;

      let textTag = "📢 Tag All:\n\n";
      let mentions = [];

      for (let p of participants) {
        mentions.push(p.id);
        textTag += `@${p.id.split("@")[0]} `;
      }

      await sock.sendMessage(from, { text: textTag, mentions });
      return;
    }

    // !hidetag
    if (text.startsWith("!hidetag ")) {
      if (!from.endsWith("@g.us")) {
        await sock.sendMessage(from, {
          text: "⚠️ Perintah ini hanya bisa digunakan dalam grup.",
        });
        return;
      }
      const metadata = await sock.groupMetadata(from);
      const participants = metadata.participants;
      let mentions = participants.map((p) => p.id);
      const customMessage = pesan.slice(9).trim() || "👀";

      await sock.sendMessage(from, {
        text: customMessage,
        mentions,
      });
      return;
    }

    // !bukagrup
    if (text === "!bukagrup") {
      if (!from.endsWith("@g.us")) {
        await sock.sendMessage(from, {
          text: "⚠️ Perintah ini hanya untuk grup!",
        });
        return;
      }
      await setGroupRestriction(from, sock, false, sender);
      return;
    }

    // !tutupgrup
    if (text === "!tutupgrup") {
      if (!from.endsWith("@g.us")) {
        await sock.sendMessage(from, {
          text: "⚠️ Perintah ini hanya untuk grup!",
        });
        return;
      }
      await setGroupRestriction(from, sock, true, sender);
      return;
    }

    // !jadwal tambah (HH:mm) (buka/tutup)
    if (text.startsWith("!jadwal tambah ")) {
      if (!from.endsWith("@g.us")) {
        await sock.sendMessage(from, {
          text: "⚠️ Perintah ini hanya untuk grup!",
        });
        return;
      }
      const args = pesan.split(" ");
      if (args.length < 4) {
        await sock.sendMessage(from, {
          text: "⚠️ Format: !jadwal tambah HH:mm buka|tutup",
        });
        return;
      }
      const waktu = args[2];
      const aksi = args[3].toLowerCase();

      if (!/^([01]\d|2[0-3]):([0-5]\d)$/.test(waktu)) {
        await sock.sendMessage(from, {
          text: "⚠️ Format waktu harus HH:mm (24 jam).",
        });
        return;
      }
      if (aksi !== "buka" && aksi !== "tutup") {
        await sock.sendMessage(from, {
          text: '⚠️ Aksi harus "buka" atau "tutup".',
        });
        return;
      }
      if (!jadwal[from]) jadwal[from] = [];

      jadwal[from].push({
        time: waktu,
        action: aksi === "tutup" ? "close" : "open",
        done: false,
        requester: sender,
      });
      simpanJadwal();
      await sock.sendMessage(from, {
        text: `✅ Jadwal ${aksi} grup pada pukul ${waktu} berhasil ditambahkan.`,
      });
      return;
    }

    // !jadwal lihat
    if (text === "!jadwal lihat") {
      if (!from.endsWith("@g.us")) {
        await sock.sendMessage(from, {
          text: "⚠️ Perintah ini hanya untuk grup!",
        });
        return;
      }
      if (!jadwal[from] || jadwal[from].length === 0) {
        await sock.sendMessage(from, {
          text: "ℹ️ Belum ada jadwal untuk grup ini.",
        });
        return;
      }
      let daftar = "🗓️ Jadwal grup:\n\n";
      jadwal[from].forEach((j, i) => {
        daftar += `${i + 1}. Jam ${j.time} - ${
          j.action === "close" ? "Tutup" : "Buka"
        } - ${j.done ? "✅ Sudah dijalankan" : "⏳ Menunggu"}\n`;
      });
      await sock.sendMessage(from, { text: daftar });
      return;
    }

    // !jadwal hapus (nomor)
    if (text.startsWith("!jadwal hapus ")) {
      if (!from.endsWith("@g.us")) {
        await sock.sendMessage(from, {
          text: "⚠️ Perintah ini hanya untuk grup!",
        });
        return;
      }
      const args = pesan.split(" ");
      if (args.length < 3) {
        await sock.sendMessage(from, {
          text: "⚠️ Format: !jadwal hapus nomor",
        });
        return;
      }
      const nomor = parseInt(args[2]);
      if (!jadwal[from] || !jadwal[from][nomor - 1]) {
        await sock.sendMessage(from, { text: "⚠️ Jadwal tidak ditemukan." });
        return;
      }
      jadwal[from].splice(nomor - 1, 1);
      simpanJadwal();
      await sock.sendMessage(from, "✅ Jadwal berhasil dihapus.");
      return;
    }
    //Tag Member or Admin
    if (pesan.toLowerCase().startsWith("!tagmember")) {
      // Ambil pesan custom setelah command, atau default
      const textMessage =
        pesan.slice("!tagmember".length).trim() || "👥 Mention Member:";
      let mentions = [];

      for (const p of participants) {
        if (!p.admin) {
          // bukan admin
          mentions.push(p.id);
        }
      }

      await sock.sendMessage(from, {
        text: textMessage,
        mentions: mentions,
      });
    } else if (pesan.toLowerCase().startsWith("!tagadmin")) {
      const textMessage =
        pesan.slice("!tagadmin".length).trim() || "🛡️ Mention Admin:";
      let mentions = [];

      for (const p of participants) {
        if (p.admin) {
          // admin
          mentions.push(p.id);
        }
      }

      await sock.sendMessage(from, {
        text: textMessage,
        mentions: mentions,
      });
    }

    // Perintah tambah command
    else if (pesan.startsWith("!addcmd ")) {
      const [_, cmdName, ...replyArr] = pesan.split(" ");
      const replyText = replyArr.join(" ");
      if (!cmdName || !replyText) {
        return await sock.sendMessage(from, {
          text: "Format: !addcmd <nama> <pesan balasan>",
        });
      }
      commands[cmdName.toLowerCase()] = replyText;
      saveCommands(commands);
      return await sock.sendMessage(from, {
        text: `✅ Perintah baru "!${cmdName}" berhasil ditambahkan.`,
      });
    }

    // Perintah hapus command
    if (pesan.startsWith("!delcmd ")) {
      const cmdName = pesan.split(" ")[1];
      if (!cmdName || !commands[cmdName.toLowerCase()]) {
        return await sock.sendMessage(from, {
          text: `⚠️ Perintah "!${cmdName}" tidak ditemukan.`,
        });
      }
      delete commands[cmdName.toLowerCase()];
      saveCommands(commands);
      return await sock.sendMessage(from, {
        text: `✅ Perintah "!${cmdName}" berhasil dihapus.`,
      });
    }

    // Lihat daftar perintah
    if (pesan === "!listcmd") {
      const list =
        Object.keys(commands)
          .map((c) => `- !${c}`)
          .join("\n") || "Belum ada perintah custom.";
      return await sock.sendMessage(from, {
        text: `📋 Daftar perintah custom:\n${list}`,
      });
    }

    // Eksekusi perintah custom
    const cmd = pesan.toLowerCase();
    if (commands[cmd]) {
      return await sock.sendMessage(from, { text: commands[cmd] });
    }
  });
}

startBot();
