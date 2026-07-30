const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const { Server } = require('socket.io');
const { randomUUID } = require('crypto');
const webPush = require('web-push');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const UPLOAD_DIR = path.join(__dirname, 'uploads');
const CHAT_IMAGE_DIR = path.join(__dirname, 'uploads', 'chat-images');
const AVATAR_DIR = path.join(__dirname, 'uploads', 'avatars');
const VOICE_DIR = path.join(__dirname, 'uploads', 'voice-messages');

if (fs.existsSync(UPLOAD_DIR) && !fs.statSync(UPLOAD_DIR).isDirectory()) {
  fs.unlinkSync(UPLOAD_DIR);
}
if (!fs.existsSync(UPLOAD_DIR)) {
  fs.mkdirSync(UPLOAD_DIR);
}
if (!fs.existsSync(CHAT_IMAGE_DIR)) {
  fs.mkdirSync(CHAT_IMAGE_DIR, { recursive: true });
}
if (!fs.existsSync(AVATAR_DIR)) {
  fs.mkdirSync(AVATAR_DIR, { recursive: true });
}
if (!fs.existsSync(VOICE_DIR)) {
  fs.mkdirSync(VOICE_DIR, { recursive: true });
}

// --- Настройка загрузки файлов ---
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const safeName = Date.now() + '-' + file.originalname.replace(/[^a-zA-Z0-9.\-_]/g, '_');
    cb(null, safeName);
  }
});
const upload = multer({
  storage,
  limits: { fileSize: 8 * 1024 * 1024 * 1024 } // до 8 ГБ
});

// --- Загрузка картинок в чат (скриншоты из буфера обмена, фото) ---
const chatImageStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, CHAT_IMAGE_DIR),
  filename: (req, file, cb) => {
    const ext = (path.extname(file.originalname || '') || '.png').toLowerCase().replace(/[^a-z0-9.]/g, '') || '.png';
    cb(null, Date.now() + '-' + randomUUID().slice(0, 8) + ext);
  }
});
const uploadChatImage = multer({
  storage: chatImageStorage,
  limits: { fileSize: 15 * 1024 * 1024 }, // до 15 МБ на картинку
  fileFilter: (req, file, cb) => {
    if (!/^image\//.test(file.mimetype)) return cb(new Error('Разрешены только изображения'));
    cb(null, true);
  }
});

// --- Загрузка фото для аватара профиля ---
const avatarStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, AVATAR_DIR),
  filename: (req, file, cb) => {
    const ext = (path.extname(file.originalname || '') || '.jpg').toLowerCase().replace(/[^a-z0-9.]/g, '') || '.jpg';
    cb(null, Date.now() + '-' + randomUUID().slice(0, 8) + ext);
  }
});
const uploadAvatar = multer({
  storage: avatarStorage,
  limits: { fileSize: 8 * 1024 * 1024 }, // до 8 МБ
  fileFilter: (req, file, cb) => {
    if (!/^image\//.test(file.mimetype)) return cb(new Error('Разрешены только изображения'));
    cb(null, true);
  }
});

// --- Загрузка голосовых сообщений в чат ---
const voiceStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, VOICE_DIR),
  filename: (req, file, cb) => {
    const ext = (path.extname(file.originalname || '') || '.webm').toLowerCase().replace(/[^a-z0-9.]/g, '') || '.webm';
    cb(null, Date.now() + '-' + randomUUID().slice(0, 8) + ext);
  }
});
const uploadVoice = multer({
  storage: voiceStorage,
  limits: { fileSize: 10 * 1024 * 1024 }, // до 10 МБ (с запасом на пару минут записи)
  fileFilter: (req, file, cb) => {
    if (!/^audio\//.test(file.mimetype)) return cb(new Error('Разрешены только аудиозаписи'));
    cb(null, true);
  }
});

app.use(express.static(path.join(__dirname, 'public')));
app.use('/chat-images', express.static(CHAT_IMAGE_DIR));
app.use('/avatars', express.static(AVATAR_DIR));
app.use('/voice-messages', express.static(VOICE_DIR));

// --- Push-уведомления (Web Push), чтобы сообщения приходили даже с закрытым приложением ---
// Ключи VAPID генерируются один раз и сохраняются рядом на диске — вручную
// ничего прописывать не нужно, при следующих запусках сервер их переиспользует.
const VAPID_FILE = path.join(__dirname, 'vapid-keys.json');
let vapidKeys;
if (fs.existsSync(VAPID_FILE)) {
  vapidKeys = JSON.parse(fs.readFileSync(VAPID_FILE, 'utf8'));
} else {
  vapidKeys = webPush.generateVAPIDKeys();
  fs.writeFileSync(VAPID_FILE, JSON.stringify(vapidKeys, null, 2));
  console.log('Сгенерированы новые VAPID-ключи для push-уведомлений');
}
webPush.setVapidDetails('mailto:watch-together@example.com', vapidKeys.publicKey, vapidKeys.privateKey);

app.use(express.json());

app.get('/api/push-public-key', (req, res) => {
  res.json({ publicKey: vapidKeys.publicKey });
});

// room -> { имя пользователя -> subscription }
const pushSubscriptions = {};

app.post('/api/push-subscribe', (req, res) => {
  const { room, name, subscription } = req.body || {};
  if (!room || !name || !subscription) return res.status(400).json({ error: 'room, name и subscription обязательны' });
  if (!pushSubscriptions[room]) pushSubscriptions[room] = {};
  pushSubscriptions[room][name] = subscription;
  res.json({ ok: true });
});

app.post('/api/push-unsubscribe', (req, res) => {
  const { room, name } = req.body || {};
  if (room && pushSubscriptions[room]) delete pushSubscriptions[room][name];
  res.json({ ok: true });
});

// Шлёт push всем в комнате, кроме отправителя. Мёртвые подписки (410/404 — юзер
// отозвал разрешение или переустановил приложение) сами вычищаются из памяти.
function sendPushToRoom(room, excludeName, payload) {
  const subs = pushSubscriptions[room];
  if (!subs) return;
  const body = JSON.stringify(payload);
  Object.entries(subs).forEach(([subName, subscription]) => {
    if (subName === excludeName) return;
    webPush.sendNotification(subscription, body).catch((err) => {
      if (err.statusCode === 410 || err.statusCode === 404) {
        delete subs[subName];
      } else {
        console.error(`Push-уведомление для "${subName}" не доставлено:`, err.message);
      }
    });
  });
}

// --- GIF-поиск (Giphy) ---
// Публичный общий demo-ключ Giphy ("dc6zaTOxFJmzC"), который раньше можно
// было использовать без регистрации, сейчас нестабилен и часто отдаёт 403 —
// слишком много проектов его исчерпали. Поэтому нужен свой ключ (получается
// за 1 минуту без модерации, см. README) в переменной окружения
// GIPHY_API_KEY. Без него GIF-поиск отключается с понятной подсказкой в
// интерфейсе, остальной сайт продолжает работать как обычно.
const GIPHY_API_KEY = process.env.GIPHY_API_KEY || '';
const GIPHY_BASE = 'https://api.giphy.com/v1/gifs';

async function giphyRequest(res, endpoint, params) {
  if (!GIPHY_API_KEY) {
    return res.status(501).json({ error: 'no-key', message: 'GIPHY_API_KEY не настроен на сервере' });
  }
  try {
    const qs = new URLSearchParams({
      api_key: GIPHY_API_KEY,
      limit: '24',
      rating: 'pg-13',
      ...params
    });
    const r = await fetch(`${GIPHY_BASE}/${endpoint}?${qs.toString()}`);
    if (!r.ok) return res.status(502).json({ error: 'giphy-error', status: r.status });
    const data = await r.json();
    const results = (data.data || []).map((item) => ({
      id: item.id,
      title: item.title || '',
      preview: item.images?.fixed_width_small?.url || item.images?.fixed_width?.url || item.images?.original?.url,
      url: item.images?.original?.url,
      width: Number(item.images?.original?.width) || 200,
      height: Number(item.images?.original?.height) || 200
    })).filter((g) => g.url);
    res.json({ results });
  } catch (err) {
    console.error('Ошибка запроса к Giphy:', err.message);
    res.status(502).json({ error: 'giphy-request-failed' });
  }
}

app.get('/api/gif/trending', (req, res) => giphyRequest(res, 'trending', {}));
app.get('/api/gif/search', (req, res) => {
  const q = (req.query.q || '').toString().trim().slice(0, 60);
  if (!q) return giphyRequest(res, 'trending', {});
  giphyRequest(res, 'search', { q });
});

// --- AI-помощник в чате ("/ai <вопрос>") ---
// Нужен свой ключ в переменной окружения GEMINI_API_KEY (aistudio.google.com
// → Get API key — бесплатный тариф щедрее, чем у большинства альтернатив).
// Без него команда /ai просто отвечает подсказкой о настройке, остальной
// сайт продолжает работать как обычно.
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
const AI_HISTORY_LIMIT = 24;       // сколько последних реплик чата держим для контекста
const AI_COOLDOWN_MS = 8000;       // минимальный интервал между запросами на комнату
const aiCooldownByRoom = {};

async function askAi(room, question, askerName) {
  if (!GEMINI_API_KEY) {
    return { ok: false, message: 'AI не настроен на сервере — добавь GEMINI_API_KEY в переменные окружения (см. README).' };
  }

  const history = (rooms[room]?.aiHistory || [])
    .map((m) => `${m.name}: ${m.text}`)
    .join('\n')
    .slice(-4000); // на всякий случай ограничиваем размер контекста

  const systemPrompt =
    'Ты — AI-помощник в комнате совместного онлайн-просмотра видео "Вместе". ' +
    'Люди смотрят видео и параллельно переписываются в чате рядом с плеером. ' +
    'Тебе доступен только текст этого чата (не сама аудио/видеодорожка) и твои общие знания. ' +
    'Отвечай кратко (2-4 предложения), по-русски, живо и по делу, без вступлений вроде "Конечно, вот ответ". ' +
    'Если в чате упоминались название фильма/сериала/актёра/трека — используй это как контекст. ' +
    'Если не уверен в ответе (например, вопрос про то, что реально происходит на экране прямо сейчас, а этого нет в чате) — честно скажи об этом и предложи лучший вариант, не выдумывая факты как точные.';

  const userPrompt =
    (history ? `Недавние сообщения в чате комнаты:\n${history}\n\n` : '') +
    `Вопрос от ${askerName}: ${question}`;

  try {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;
    const r = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': GEMINI_API_KEY
      },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: systemPrompt }] },
        contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
        generationConfig: { maxOutputTokens: 400 }
      })
    });
    if (!r.ok) {
      const errText = await r.text().catch(() => '');
      console.error('Gemini API error:', r.status, errText.slice(0, 300));
      return { ok: false, message: 'AI сейчас недоступен, попробуйте чуть позже.' };
    }
    const data = await r.json();
    const answer = (data.candidates?.[0]?.content?.parts || [])
      .map((part) => part.text || '')
      .join('\n')
      .trim();
    if (!answer) return { ok: false, message: 'AI не смог сформулировать ответ, попробуйте переформулировать вопрос.' };
    return { ok: true, answer };
  } catch (err) {
    console.error('Ошибка запроса к Gemini API:', err.message);
    return { ok: false, message: 'AI сейчас недоступен, попробуйте чуть позже.' };
  }
}

// Разрешённые домены для GIF-сообщений в чате (только CDN Giphy — картинки
// грузятся у клиента напрямую по этому URL, поэтому нельзя пускать что попало)
const ALLOWED_GIF_HOSTS = ['media.giphy.com', 'media0.giphy.com', 'media1.giphy.com', 'media2.giphy.com', 'media3.giphy.com', 'media4.giphy.com', 'i.giphy.com'];
function isAllowedGifUrl(url) {
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:') return false;
    return ALLOWED_GIF_HOSTS.some((h) => u.hostname === h || u.hostname.endsWith('.' + h));
  } catch (e) {
    return false;
  }
}

// Проверяет, что присланное имя файла аватара — это реально загруженный
// через /upload-avatar файл, а не произвольный путь
function isValidAvatarPhoto(filename) {
  if (!filename || typeof filename !== 'string') return false;
  if (!/^[a-zA-Z0-9._-]+$/.test(filename)) return false;
  return fs.existsSync(path.join(AVATAR_DIR, filename));
}

// То же самое для голосовых сообщений
function isValidVoiceFile(filename) {
  if (!filename || typeof filename !== 'string') return false;
  if (!/^[a-zA-Z0-9._-]+$/.test(filename)) return false;
  return fs.existsSync(path.join(VOICE_DIR, filename));
}

// Загрузка видео
app.post('/upload', (req, res) => {
  upload.single('video')(req, res, (err) => {
    if (err) {
      console.error('Ошибка загрузки:', err.message);
      return res.status(400).json({ error: err.message });
    }
    if (!req.file) return res.status(400).json({ error: 'Файл не получен' });
    res.json({ filename: req.file.filename });
  });
});

// Загрузка картинки в чат (скрин из буфера обмена или фото с устройства)
app.post('/upload-image', (req, res) => {
  uploadChatImage.single('image')(req, res, (err) => {
    if (err) {
      console.error('Ошибка загрузки картинки:', err.message);
      return res.status(400).json({ error: err.message });
    }
    if (!req.file) return res.status(400).json({ error: 'Файл не получен' });
    res.json({ filename: req.file.filename });
  });
});

// Загрузка фото для аватара профиля
app.post('/upload-avatar', (req, res) => {
  uploadAvatar.single('avatar')(req, res, (err) => {
    if (err) {
      console.error('Ошибка загрузки аватара:', err.message);
      return res.status(400).json({ error: err.message });
    }
    if (!req.file) return res.status(400).json({ error: 'Файл не получен' });
    res.json({ filename: req.file.filename });
  });
});

// Загрузка голосового сообщения в чат
app.post('/upload-voice', (req, res) => {
  uploadVoice.single('voice')(req, res, (err) => {
    if (err) {
      console.error('Ошибка загрузки голосового:', err.message);
      return res.status(400).json({ error: err.message });
    }
    if (!req.file) return res.status(400).json({ error: 'Файл не получен' });
    res.json({ filename: req.file.filename });
  });
});

// Список загруженных файлов
app.get('/videos', (req, res) => {
  const files = fs.readdirSync(UPLOAD_DIR).filter(f => !f.startsWith('.'));
  res.json(files);
});

// Стриминг видео с поддержкой Range-запросов (перемотка)
app.get('/video/:filename', (req, res) => {
  const filePath = path.join(UPLOAD_DIR, req.params.filename);
  if (!fs.existsSync(filePath)) return res.status(404).send('Файл не найден');

  const stat = fs.statSync(filePath);
  const fileSize = stat.size;
  const range = req.headers.range;

  if (range) {
    const parts = range.replace(/bytes=/, '').split('-');
    const start = parseInt(parts[0], 10);
    const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
    const chunkSize = end - start + 1;
    const file = fs.createReadStream(filePath, { start, end });

    res.writeHead(206, {
      'Content-Range': `bytes ${start}-${end}/${fileSize}`,
      'Accept-Ranges': 'bytes',
      'Content-Length': chunkSize,
      'Content-Type': 'video/mp4'
    });
    file.pipe(res);
  } else {
    res.writeHead(200, {
      'Content-Length': fileSize,
      'Content-Type': 'video/mp4'
    });
    fs.createReadStream(filePath).pipe(res);
  }
});

// --- Комнаты и синхронизация ---
const rooms = {}; // roomId -> { video, currentTime, playing, reactions, cleanupTimer }

// Через сколько минут после того, как комната опустела, удалять её из памяти
const ROOM_EMPTY_TTL_MS = (parseInt(process.env.ROOM_EMPTY_TTL_MINUTES, 10) || 15) * 60 * 1000;

// Планирует удаление комнаты из памяти, если она останется пустой
function scheduleRoomCleanup(room) {
  if (!rooms[room]) return;
  if (rooms[room].cleanupTimer) clearTimeout(rooms[room].cleanupTimer);
  rooms[room].cleanupTimer = setTimeout(() => {
    const count = io.sockets.adapter.rooms.get(room)?.size || 0;
    if (count === 0) {
      delete rooms[room];
      delete aiCooldownByRoom[room];
      console.log(`Комната "${room}" удалена из памяти (пустовала ${ROOM_EMPTY_TTL_MS / 60000} мин.)`);
    }
  }, ROOM_EMPTY_TTL_MS);
}

// --- Автоочистка старых видеофайлов ---
// Сколько дней хранить файл с момента последнего изменения, если он не используется
// ни в одной активной комнате прямо сейчас
const FILE_MAX_AGE_MS = (parseInt(process.env.FILE_MAX_AGE_DAYS, 10) || 3) * 24 * 60 * 60 * 1000;
const FILE_CLEANUP_INTERVAL_MS = 60 * 60 * 1000; // проверка раз в час

function cleanupOldFiles() {
  const inUse = new Set(Object.values(rooms).map((r) => r.video).filter(Boolean));

  fs.readdir(UPLOAD_DIR, (err, files) => {
    if (err) {
      console.error('Ошибка чтения папки uploads при очистке:', err.message);
      return;
    }
    files.forEach((file) => {
      if (file.startsWith('.') || inUse.has(file)) return; // не трогаем скрытые и активно используемые файлы
      const filePath = path.join(UPLOAD_DIR, file);
      fs.stat(filePath, (err, stat) => {
        if (err || !stat.isFile()) return;
        if (Date.now() - stat.mtimeMs > FILE_MAX_AGE_MS) {
          fs.unlink(filePath, (err) => {
            if (err) console.error(`Не удалось удалить старый файл ${file}:`, err.message);
            else console.log(`Автоочистка: удалён старый файл ${file}`);
          });
        }
      });
    });
  });
}

setInterval(cleanupOldFiles, FILE_CLEANUP_INTERVAL_MS);
cleanupOldFiles(); // и сразу при старте сервера

// Отдельно чистим старые картинки из чата (скрины/фото) — они ни к какой
// комнате не привязаны, поэтому просто удаляем всё, что старше FILE_MAX_AGE_MS
function cleanupOldChatImages() {
  fs.readdir(CHAT_IMAGE_DIR, (err, files) => {
    if (err) {
      console.error('Ошибка чтения папки chat-images при очистке:', err.message);
      return;
    }
    files.forEach((file) => {
      if (file.startsWith('.')) return;
      const filePath = path.join(CHAT_IMAGE_DIR, file);
      fs.stat(filePath, (err, stat) => {
        if (err || !stat.isFile()) return;
        if (Date.now() - stat.mtimeMs > FILE_MAX_AGE_MS) {
          fs.unlink(filePath, (err) => {
            if (err) console.error(`Не удалось удалить старую картинку чата ${file}:`, err.message);
            else console.log(`Автоочистка: удалена старая картинка чата ${file}`);
          });
        }
      });
    });
  });
}

setInterval(cleanupOldChatImages, FILE_CLEANUP_INTERVAL_MS);
cleanupOldChatImages();

// Голосовые сообщения чистим по тому же принципу и с тем же сроком, что и
// картинки чата — они тоже не привязаны ни к какой комнате
function cleanupOldVoiceMessages() {
  fs.readdir(VOICE_DIR, (err, files) => {
    if (err) {
      console.error('Ошибка чтения папки voice-messages при очистке:', err.message);
      return;
    }
    files.forEach((file) => {
      if (file.startsWith('.')) return;
      const filePath = path.join(VOICE_DIR, file);
      fs.stat(filePath, (err, stat) => {
        if (err || !stat.isFile()) return;
        if (Date.now() - stat.mtimeMs > FILE_MAX_AGE_MS) {
          fs.unlink(filePath, (err) => {
            if (err) console.error(`Не удалось удалить старое голосовое ${file}:`, err.message);
            else console.log(`Автоочистка: удалено старое голосовое сообщение ${file}`);
          });
        }
      });
    });
  });
}

setInterval(cleanupOldVoiceMessages, FILE_CLEANUP_INTERVAL_MS);
cleanupOldVoiceMessages();

// Аватарки, в отличие от картинок чата, должны жить долго, пока ими кто-то
// пользуется — привязки к аккаунту нет, поэтому просто даём им сильно больший
// срок жизни (по умолчанию 60 дней), чтобы не копился мусор от заброшенных
// профилей, но при этом не удалять активно используемые фото
const AVATAR_MAX_AGE_MS = (parseInt(process.env.AVATAR_MAX_AGE_DAYS, 10) || 60) * 24 * 60 * 60 * 1000;
function cleanupOldAvatars() {
  fs.readdir(AVATAR_DIR, (err, files) => {
    if (err) {
      console.error('Ошибка чтения папки avatars при очистке:', err.message);
      return;
    }
    files.forEach((file) => {
      if (file.startsWith('.')) return;
      const filePath = path.join(AVATAR_DIR, file);
      fs.stat(filePath, (err, stat) => {
        if (err || !stat.isFile()) return;
        if (Date.now() - stat.mtimeMs > AVATAR_MAX_AGE_MS) {
          fs.unlink(filePath, (err) => {
            if (err) console.error(`Не удалось удалить старую аватарку ${file}:`, err.message);
            else console.log(`Автоочистка: удалена старая аватарка ${file}`);
          });
        }
      });
    });
  });
}

setInterval(cleanupOldAvatars, FILE_CLEANUP_INTERVAL_MS);
cleanupOldAvatars();

// --- Крестики-нолики ---
const WIN_LINES = [
  [0, 1, 2], [3, 4, 5], [6, 7, 8],
  [0, 3, 6], [1, 4, 7], [2, 5, 8],
  [0, 4, 8], [2, 4, 6]
];

function checkTttWinner(board) {
  for (const [a, b, c] of WIN_LINES) {
    if (board[a] && board[a] === board[b] && board[a] === board[c]) return board[a];
  }
  if (board.every((cell) => cell)) return 'draw';
  return null;
}

function tttPublicState(game) {
  if (!game) return null;
  return {
    board: game.board,
    turn: game.turn,
    winner: game.winner,
    active: game.active,
    playerCount: Object.keys(game.players).length
  };
}

// Список отображаемых имён всех, кто сейчас в комнате (для автодополнения @упоминаний)
function getRoomNames(room) {
  const socketIds = io.sockets.adapter.rooms.get(room);
  if (!socketIds) return [];
  const names = new Set();
  socketIds.forEach((id) => {
    const s = io.sockets.sockets.get(id);
    if (s?.data?.name) names.add(s.data.name);
  });
  return Array.from(names);
}

function broadcastRoomUsers(room) {
  io.to(room).emit('room-users', { names: getRoomNames(room) });
}

// Достаёт из текста реально упомянутых участников комнаты (регистр не важен),
// чтобы не подсвечивать случайные "@" как настоящие упоминания
function extractMentions(text, roomNames) {
  if (!text || !roomNames.length) return [];
  const found = new Set();
  const regex = /@([^\s@]{1,24})/g;
  let match;
  while ((match = regex.exec(text))) {
    const token = match[1].toLowerCase();
    const real = roomNames.find((n) => n.toLowerCase() === token);
    if (real) found.add(real);
  }
  return Array.from(found);
}

io.on('connection', (socket) => {
  let currentRoom = null;

  socket.on('join-room', ({ room, name, avatar, avatarPhoto }) => {
    currentRoom = room;
    socket.join(room);
    socket.data.name = name || 'Гость';
    socket.data.avatar = (avatar || '').toString().trim().slice(0, 8);
    socket.data.avatarPhoto = isValidAvatarPhoto(avatarPhoto) ? avatarPhoto : '';

    if (!rooms[room]) {
      rooms[room] = { video: null, currentTime: 0, playing: false, reactions: {}, streamLink: null, externalVideo: null, youtubeVideo: null, aiHistory: [], ttt: null };
    }

    // Если комната была запланирована к удалению (опустела), отменяем удаление —
    // кто-то вернулся
    if (rooms[room].cleanupTimer) {
      clearTimeout(rooms[room].cleanupTimer);
      rooms[room].cleanupTimer = null;
    }

    // Отправляем новому участнику текущее состояние комнаты
    // (без служебных полей вроде cleanupTimer)
    socket.emit('room-state', {
      video: rooms[room].video,
      currentTime: rooms[room].currentTime,
      playing: rooms[room].playing,
      reactions: rooms[room].reactions,
      streamLink: rooms[room].streamLink,
      externalVideo: rooms[room].externalVideo,
      youtubeVideo: rooms[room].youtubeVideo,
      ttt: tttPublicState(rooms[room].ttt)
    });

    const existingTttSymbol = rooms[room].ttt?.players?.[socket.id];
    if (existingTttSymbol) socket.emit('ttt-you', { symbol: existingTttSymbol });

    io.to(room).emit('chat-message', {
      system: true,
      text: `${socket.data.name} присоединился(-ась)`
    });

    io.to(room).emit('user-count', io.sockets.adapter.rooms.get(room)?.size || 1);
    broadcastRoomUsers(room);
  });

  socket.on('select-video', ({ room, filename }) => {
    if (!rooms[room]) return;
    rooms[room].video = filename;
    rooms[room].currentTime = 0;
    rooms[room].playing = false;
    rooms[room].streamLink = null;
    rooms[room].externalVideo = null;
    rooms[room].youtubeVideo = null;
    io.to(room).emit('video-selected', { filename });
  });

  // Прямая ссылка на видеофайл (.mp4/.webm/.m3u8 и т.п.) с внешнего сервера.
  // В отличие от set-stream-link, тут видео грузится прямо в наш <video>,
  // поэтому play/pause/перемотка синхронизируются между зрителями по-настоящему.
  socket.on('set-external-video', ({ room, url }) => {
    if (!rooms[room] || !url) return;
    const trimmed = String(url).trim().slice(0, 2000);
    if (!/^https?:\/\//i.test(trimmed)) return;
    rooms[room].video = null;
    rooms[room].streamLink = null;
    rooms[room].externalVideo = trimmed;
    rooms[room].youtubeVideo = null;
    rooms[room].currentTime = 0;
    rooms[room].playing = false;
    io.to(room).emit('external-video-selected', { url: trimmed, from: socket.data.name || 'Гость' });
  });

  // Ссылка на YouTube. В отличие от set-stream-link, тут клиент подключает
  // официальный YouTube IFrame Player API и получает реальный контроль над
  // чужим плеером (play/pause/seek), поэтому play/pause/перемотка
  // синхронизируются между зрителями по-настоящему — через те же общие
  // события play/pause/seek, что и для загруженных файлов.
  socket.on('set-youtube-video', ({ room, url }) => {
    if (!rooms[room] || !url) return;
    const trimmed = String(url).trim().slice(0, 2000);
    if (!/^https?:\/\//i.test(trimmed)) return;
    if (!/(youtube\.com|youtu\.be)/i.test(trimmed)) return;
    rooms[room].video = null;
    rooms[room].streamLink = null;
    rooms[room].externalVideo = null;
    rooms[room].youtubeVideo = trimmed;
    rooms[room].currentTime = 0;
    rooms[room].playing = false;
    io.to(room).emit('youtube-video-selected', { url: trimmed, from: socket.data.name || 'Гость' });
  });

  // Ссылка на трансляцию с другого сайта. Настоящую синхронизацию play/pause
  // тут не сделать (чужой плеер нам не подконтролен), но для прямого эфира
  // это и не нужно — все просто открывают один и тот же линк одновременно.
  socket.on('set-stream-link', ({ room, url }) => {
    if (!rooms[room] || !url) return;
    const trimmed = String(url).trim().slice(0, 2000);
    if (!/^https?:\/\//i.test(trimmed)) return;
    rooms[room].video = null;
    rooms[room].externalVideo = null;
    rooms[room].youtubeVideo = null;
    rooms[room].streamLink = trimmed;
    io.to(room).emit('stream-link-updated', { url: trimmed, from: socket.data.name || 'Гость' });
  });

  socket.on('play', ({ room, time }) => {
    if (!rooms[room]) return;
    rooms[room].playing = true;
    rooms[room].currentTime = time;
    socket.to(room).emit('sync-play', { time });
  });

  socket.on('pause', ({ room, time }) => {
    if (!rooms[room]) return;
    rooms[room].playing = false;
    rooms[room].currentTime = time;
    socket.to(room).emit('sync-pause', { time });
  });

  socket.on('seek', ({ room, time }) => {
    if (!rooms[room]) return;
    rooms[room].currentTime = time;
    socket.to(room).emit('sync-seek', { time });
  });

  // Пользователь изменил имя и/или аватар в профиле, находясь в комнате
  socket.on('update-profile', ({ room, name, avatar, avatarPhoto }) => {
    if (!room) return;
    const oldName = socket.data.name || 'Гость';
    const newName = (name || '').toString().trim().slice(0, 20) || oldName;
    const newAvatar = (avatar || '').toString().trim().slice(0, 8);
    socket.data.name = newName;
    socket.data.avatar = newAvatar;
    socket.data.avatarPhoto = isValidAvatarPhoto(avatarPhoto) ? avatarPhoto : '';
    if (newName !== oldName) {
      io.to(room).emit('chat-message', { system: true, text: `${oldName} теперь известен(на) как ${newName}` });
    }
    broadcastRoomUsers(room);
  });

  socket.on('typing', ({ room, name }) => {
    if (!room) return;
    socket.to(room).emit('user-typing', { name: name || socket.data.name || 'Гость' });
  });

  socket.on('stop-typing', ({ room }) => {
    if (!room) return;
    socket.to(room).emit('user-stop-typing', {});
  });

  socket.on('chat-message', ({ room, text, image, gifUrl, voice, voiceDuration, replyTo }) => {
    if (!room) return;
    const trimmedText = (text || '').toString().trim().slice(0, 4000);
    // Картинка обязана быть именем файла, реально загруженным через /upload-image —
    // никаких произвольных путей/URL тут не принимаем
    const safeImage = (image && /^[a-zA-Z0-9._-]+$/.test(image) && fs.existsSync(path.join(CHAT_IMAGE_DIR, image)))
      ? image
      : null;
    // GIF — это внешняя ссылка на CDN Tenor, а не загруженный файл, поэтому
    // проверяем домен, а не существование файла на диске
    const safeGifUrl = (gifUrl && typeof gifUrl === 'string' && isAllowedGifUrl(gifUrl))
      ? gifUrl.slice(0, 500)
      : null;
    // Голосовое сообщение — так же, как картинка, обязано быть реально
    // загруженным через /upload-voice файлом
    const safeVoice = isValidVoiceFile(voice) ? voice : null;
    const safeVoiceDuration = safeVoice ? Math.min(Math.max(parseInt(voiceDuration, 10) || 0, 0), 600) : 0;
    if (!trimmedText && !safeImage && !safeGifUrl && !safeVoice) return; // совсем пустое сообщение — игнорируем

    // "Ответ на сообщение" — сервер не хранит историю чата, поэтому просто
    // ретранслирует то, что прислал клиент (у него это сообщение уже есть на
    // экране), с обрезкой длины на всякий случай
    let safeReplyTo = null;
    if (replyTo && typeof replyTo === 'object') {
      const replyId = String(replyTo.id || '').slice(0, 100);
      const replyName = String(replyTo.name || 'Гость').slice(0, 100);
      const replyText = String(replyTo.text || '').slice(0, 300);
      const replyImage = !!replyTo.image;
      const replyGif = !!replyTo.gif;
      const replyVoice = !!replyTo.voice;
      if (replyId && (replyText || replyImage || replyGif || replyVoice)) {
        safeReplyTo = { id: replyId, name: replyName, text: replyText, image: replyImage, gif: replyGif, voice: replyVoice };
      }
    }

    if (!rooms[room]) rooms[room] = { video: null, currentTime: 0, playing: false, reactions: {}, streamLink: null, externalVideo: null, youtubeVideo: null, aiHistory: [] };
    const id = randomUUID();
    rooms[room].reactions[id] = {};
    const mentions = extractMentions(trimmedText, getRoomNames(room));

    io.to(room).emit('chat-message', {
      id,
      system: false,
      name: socket.data.name,
      avatar: socket.data.avatar || '',
      avatarPhoto: socket.data.avatarPhoto ? ('/avatars/' + socket.data.avatarPhoto) : '',
      text: trimmedText,
      image: safeImage,
      gifUrl: safeGifUrl,
      voice: safeVoice ? ('/voice-messages/' + safeVoice) : null,
      voiceDuration: safeVoiceDuration,
      replyTo: safeReplyTo,
      mentions
    });

    // Держим короткую скользящую историю текстовых реплик — только для
    // контекста AI-помощника (не для восстановления чата при реконнекте,
    // это по-прежнему целиком на клиенте).
    if (trimmedText) {
      if (!rooms[room].aiHistory) rooms[room].aiHistory = [];
      rooms[room].aiHistory.push({ name: socket.data.name || 'Гость', text: trimmedText });
      if (rooms[room].aiHistory.length > AI_HISTORY_LIMIT) {
        rooms[room].aiHistory = rooms[room].aiHistory.slice(-AI_HISTORY_LIMIT);
      }
    }

    const isMentionPush = mentions.length > 0;
    const pushBody = trimmedText || (safeGifUrl ? '🎞 GIF' : (safeImage ? '📷 Фото' : (safeVoice ? '🎤 Голосовое сообщение' : '')));
    sendPushToRoom(room, socket.data.name, {
      title: isMentionPush ? `${socket.data.name} упомянул(а) вас` : socket.data.name,
      body: pushBody.slice(0, 180),
      tag: 'wt-chat-' + room,
      url: '/?room=' + encodeURIComponent(room)
    });

    // Команда "/ai <вопрос>" — отвечает AI-помощник, используя как контекст
    // недавние реплики этой же комнаты (см. askAi выше).
    const aiMatch = trimmedText.match(/^\/ai\s+(.+)/i);
    if (aiMatch) {
      const question = aiMatch[1].trim().slice(0, 600);
      const now = Date.now();
      const lastAsk = aiCooldownByRoom[room] || 0;
      if (now - lastAsk < AI_COOLDOWN_MS) {
        socket.emit('chat-message', {
          system: true,
          text: 'AI уже отвечает на вопрос в этой комнате — подождите пару секунд и попробуйте снова'
        });
        return;
      }
      aiCooldownByRoom[room] = now;

      const askerName = socket.data.name || 'Гость';
      io.to(room).emit('user-typing', { name: '🤖 AI' });

      askAi(room, question, askerName).then((result) => {
        io.to(room).emit('user-stop-typing', {});
        if (!result.ok) {
          // Ошибка/не настроен — показываем только спросившему, чтобы не
          // засорять чат остальным участникам
          socket.emit('chat-message', { system: true, text: result.message });
          return;
        }
        const aiId = randomUUID();
        rooms[room].reactions[aiId] = {};
        io.to(room).emit('chat-message', {
          id: aiId,
          system: false,
          ai: true,
          name: 'AI',
          avatar: '🤖',
          text: result.answer,
          mentions: []
        });
      });
    }
  });

  // Реакция на конкретное сообщение чата (одна реакция на пользователя за сообщение)
  socket.on('message-reaction', ({ room, messageId, emoji }) => {
    if (!room || !messageId || !emoji || !rooms[room]) return;
    const user = socket.data.name || 'Гость';
    if (!rooms[room].reactions) rooms[room].reactions = {};
    if (!rooms[room].reactions[messageId]) rooms[room].reactions[messageId] = {};
    const msgReactions = rooms[room].reactions[messageId];

    let hadSameReaction = false;
    Object.keys(msgReactions).forEach((em) => {
      const idx = msgReactions[em].indexOf(user);
      if (idx !== -1) {
        msgReactions[em].splice(idx, 1);
        if (em === emoji) hadSameReaction = true;
        if (!msgReactions[em].length) delete msgReactions[em];
      }
    });

    if (!hadSameReaction) {
      if (!msgReactions[emoji]) msgReactions[emoji] = [];
      msgReactions[emoji].push(user);
    }

    io.to(room).emit('message-reaction-update', { messageId, reactions: msgReactions });
  });

  // Начать новую партию в крестики-нолики. Тот, кто нажал "Начать" — играет за X.
  socket.on('ttt-start', ({ room }) => {
    if (!room || !rooms[room]) return;
    rooms[room].ttt = {
      board: Array(9).fill(null),
      turn: 'X',
      players: { [socket.id]: 'X' },
      winner: null,
      active: true
    };
    socket.emit('ttt-you', { symbol: 'X' });
    io.to(room).emit('ttt-state', tttPublicState(rooms[room].ttt));
  });

  socket.on('ttt-move', ({ room, index }) => {
    const game = rooms[room]?.ttt;
    const cellIndex = parseInt(index, 10);
    if (!game || !game.active || game.winner) return;
    if (!Number.isInteger(cellIndex) || cellIndex < 0 || cellIndex > 8) return;

    let mySymbol = game.players[socket.id];
    if (!mySymbol) {
      // Второй игрок: назначаем ему свободный символ, если место ещё есть
      if (Object.keys(game.players).length >= 2) return;
      mySymbol = Object.values(game.players).includes('X') ? 'O' : 'X';
      game.players[socket.id] = mySymbol;
      socket.emit('ttt-you', { symbol: mySymbol });
    }

    if (mySymbol !== game.turn) return; // не твой ход
    if (game.board[cellIndex]) return; // клетка занята

    game.board[cellIndex] = mySymbol;
    const winner = checkTttWinner(game.board);
    if (winner) {
      game.winner = winner;
      game.active = false;
    } else {
      game.turn = game.turn === 'X' ? 'O' : 'X';
    }

    io.to(room).emit('ttt-state', tttPublicState(game));
  });

  socket.on('ttt-reset', ({ room }) => {
    const game = rooms[room]?.ttt;
    if (!game) return;
    game.board = Array(9).fill(null);
    game.turn = 'X';
    game.winner = null;
    game.active = true;
    io.to(room).emit('ttt-state', tttPublicState(game));
  });

  socket.on('disconnect', () => {
    const game = rooms[currentRoom]?.ttt;
    if (game && game.players[socket.id]) {
      delete game.players[socket.id];
      game.active = false; // ждём, пока кто-то нажмёт "Начать" заново
      io.to(currentRoom).emit('ttt-state', tttPublicState(game));
    }

    if (currentRoom) {
      io.to(currentRoom).emit('chat-message', {
        system: true,
        text: `${socket.data.name || 'Гость'} вышел(ла)`
      });
      // Считаем оставшихся уже после того, как этот сокет вышел из комнаты
      // (socket.io делает это автоматически перед событием disconnect)
      const count = io.sockets.adapter.rooms.get(currentRoom)?.size || 0;
      io.to(currentRoom).emit('user-count', count);
      broadcastRoomUsers(currentRoom);

      if (count === 0) {
        scheduleRoomCleanup(currentRoom);
      }
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Сервер запущен: http://localhost:${PORT}`);
});
