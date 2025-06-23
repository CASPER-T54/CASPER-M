const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  jidNormalizedUser,
  getContentType,
  fetchLatestBaileysVersion,
  Browsers,
  makeCacheableSignalKeyStore
} = require('@whiskeysockets/baileys');

const { makeInMemoryStore } = require('@whiskeysockets/baileys/lib/store'); // ✅ Correct import


const fs = require('fs');
const P = require('pino');
const config = require('./config');
const qrcode = require('qrcode-terminal');
const readline = require('readline');
const chalk = require('chalk');
const NodeCache = require('node-cache');
const { File } = require('megajs');
const express = require('express');
const path = require('path');
const { sms } = require('./lib/msg');
const {
  getBuffer, getGroupAdmins, getRandom, h2k,
  isUrl, Json, runtime, sleep, fetchJson
} = require('./lib/functions');

const prefix = config.PREFIX;
const ownerNumber = config.OWNER_NUMBER;
const sessionDir = __dirname + '/auth_info_baileys/';
const credsPath = sessionDir + 'creds.json';

const isInteractive = process.stdout.isTTY && !process.env.PM2_HOME;
const PHONE_NUMBER = process.env.PHONE_NUMBER || config.PHONE_NUMBER;

let rl;
if (isInteractive) {
  rl = readline.createInterface({ input: process.stdin, output: process.stdout });
}

const question = (text) => {
  if (!isInteractive) {
    console.log(chalk.red('❌ Interactive mode required. Run without PM2.'));
    process.exit(1);
  }
  return new Promise((resolve) => rl.question(text, resolve));
};

// ✅ STORE INIT
const store = makeInMemoryStore({ logger: P({ level: 'silent' }) });
store.readFromFile('./baileys_store.json');
setInterval(() => store.writeToFile('./baileys_store.json'), 10_000);

async function downloadSessionData() {
  try {
    await fs.promises.mkdir(sessionDir, { recursive: true });
    if (!fs.existsSync(credsPath) && config.SESSION_ID) {
      const sessdata = config.SESSION_ID.split("CASPER-TECH:~")[1] || config.SESSION_ID;
      return new Promise((resolve) => {
        const file = File.fromURL(`https://mega.nz/file/${sessdata}`);
        file.download(async (err, data) => {
          if (err) return resolve();
          await fs.promises.writeFile(credsPath, data.toString());
          resolve();
        });
      });
    }
  } catch (e) {
    console.log(chalk.red('❌ Session init error:'), e.message);
  }
}

async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
  const msgRetryCounterCache = new NodeCache();

  const logger = P({
    level: process.env.NODE_ENV === 'development' ? 'debug' : 'warn',
    transport: {
      target: 'pino-pretty',
      options: { colorize: true, ignore: 'pid,hostname', translateTime: 'SYS:standard' }
    }
  });

  const conn = makeWASocket({
    logger,
    version: [2, 3000, 1017531287],
    printQRInTerminal: false,
    browser: Browsers.ubuntu('Chrome'),
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, logger),
    },
    msgRetryCounterCache,
    generateHighQualityLinkPreview: true,
    markOnlineOnConnect: true,
    getMessage: async (key) => store.loadMessage(key.remoteJid, key.id) || undefined,
    shouldSyncHistoryMessage: msg => !!msg.syncType
  });

  store.bind(conn.ev);
  conn.ev.on('creds.update', saveCreds);

  conn.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
    if (qr && isInteractive) qrcode.generate(qr, { small: true });

    if (connection === 'close') {
      const reason = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = reason !== DisconnectReason.loggedOut;
      if (shouldReconnect) return setTimeout(startBot, 3000);
      await fs.promises.rm(sessionDir, { recursive: true, force: true });
      process.exit(1);
    }

    if (connection === 'open') {
      console.log(chalk.green('✅ Connected!'), chalk.blue(conn.user.id));

      // ✅ LOAD PLUGINS
      let pluginCount = 0;
      const loadPlugin = (filePath) => {
        try {
          require(filePath);
          pluginCount++;
        } catch (e) {
          console.error(chalk.red(`❌ Plugin error (${filePath}):`), e.message);
        }
      };
      if (fs.existsSync("./plugins/")) {
        fs.readdirSync("./plugins/").forEach(file => {
          const fullPath = path.join(__dirname, "plugins", file);
          if (fs.statSync(fullPath).isDirectory()) {
            fs.readdirSync(fullPath).forEach(sub => {
              if (sub.endsWith(".js")) loadPlugin(path.join(fullPath, sub));
            });
          } else if (file.endsWith(".js")) {
            loadPlugin(fullPath);
          }
        });
      }
      console.log(chalk.green(`✅ Loaded ${pluginCount} plugins`));

      // ✅ NOTIFY OWNER
      if (ownerNumber) {
        try {
          await conn.sendMessage(ownerNumber + "@s.whatsapp.net", {
            image: { url: 'https://res.cloudinary.com/dkuwzqmr0/image/upload/v1746540689/IMG_20250504_091314_nhoalf.png' },
            caption: `✅ CASPER-X is live\nBot: ${conn.user.name}\nNumber: ${conn.user.id.split(':')[0]}\nPlugins: ${pluginCount}`
          });
        } catch (e) {
          console.log(chalk.red('❌ Failed to notify owner:'), e.message);
        }
      }
    }
  });

  // ✅ MESSAGE HANDLER
  conn.ev.on('messages.upsert', async ({ messages }) => {
    try {
      const mek = messages[0];
      if (!mek.message) return;

      mek.message = getContentType(mek.message) === 'ephemeralMessage'
        ? mek.message.ephemeralMessage.message
        : mek.message;

      const m = sms(conn, mek);
      const from = mek.key.remoteJid;
      const type = getContentType(mek.message);
      const body = type === 'conversation' ? mek.message.conversation :
        type === 'extendedTextMessage' ? mek.message.extendedTextMessage.text :
        type === 'imageMessage' ? mek.message.imageMessage.caption :
        type === 'videoMessage' ? mek.message.videoMessage.caption : '';
      const isCmd = body.startsWith(prefix);
      const command = isCmd ? body.slice(prefix.length).split(' ')[0].toLowerCase() : '';
      const args = body.trim().split(/\s+/).slice(1);
      const q = args.join(' ');
      const isGroup = from.endsWith('@g.us');
      const sender = mek.key.fromMe ? conn.user.id.split(':')[0] + '@s.whatsapp.net' : mek.key.participant || from;
      const senderNumber = sender.split('@')[0];
      const pushname = mek.pushName || 'User';
      const isMe = conn.user.id.includes(senderNumber);
      const isOwner = ownerNumber.includes(senderNumber) || isMe;
      const groupMetadata = isGroup ? await conn.groupMetadata(from).catch(() => ({})) : {};
      const participants = groupMetadata.participants || [];
      const groupAdmins = getGroupAdmins(participants);
      const isAdmins = groupAdmins.includes(sender);
      const isBotAdmins = groupAdmins.includes(conn.user?.id);
      const reply = (text) => conn.sendMessage(from, { text }, { quoted: mek });

      const events = require('./command');
      const cmd = events.commands.find(c => c.pattern === command || (c.alias && c.alias.includes(command)));
      if (isCmd && cmd) {
        if (cmd.react) await conn.sendMessage(from, { react: { text: cmd.react, key: mek.key } });
        await cmd.function(conn, mek, m, {
          from, body, command, args, q, isCmd, isGroup,
          sender, senderNumber, pushname, isMe, isOwner,
          groupMetadata, participants, groupAdmins, isAdmins,
          isBotAdmins, reply
        });
      }
    } catch (err) {
      console.log(chalk.red('❌ Message error:'), err.message);
    }
  });

  return conn;
}

// ✅ EXPRESS SERVER
const app = express();
const port = process.env.PORT || 8000;

app.get("/", (_, res) => res.json({ status: "Bot is running ✅", time: new Date() }));
app.get("/health", (_, res) => res.json({
  status: "healthy",
  memory: process.memoryUsage(),
  version: process.version
}));
app.listen(port, () => console.log(chalk.green(`🌐 Server: http://localhost:${port}`)));

// ✅ START BOT
downloadSessionData().then(() => setTimeout(startBot, 2000));
