const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const { Server } = require('socket.io');
const { randomUUID } = require('crypto');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const UPLOAD_DIR = path.join(__dirname, 'uploads');
const CHAT_IMAGE_DIR = path.join(__dirname, 'uploads', 'chat-images');
const AVATAR_DIR = path.join(__dirname, 'uploads', 'avatars');

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

app.use(express.static(path.join(__dirname, 'public')));
app.use('/chat-images', express.static(CHAT_IMAGE_DIR));
app.use('/avatars', express.static(AVATAR_DIR));

// --- GIF-поиск (Giphy) ---
// По умолчанию используется публичный demo-ключ Giphy — он открыт для всех,
// работает сразу «из коробки» без какой-либо настройки, но имеет невысокий
// лимит запросов. Если нужен свой безлимитный ключ, задай переменную
// окружения GIPHY_API_KEY на Render/Railway (см. README) — сервер
// автоматически начнёт использовать его вместо demo-ключа.
const GIPHY_API_KEY = process.env.GIPHY_API_KEY || 'dc6zaTOxFJmzC';
const GIPHY_BASE = 'https://api.giphy.com/v1/gifs';

async function giphyRequest(res, endpoint, params) {
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

io.on('connection', (socket) => {
  let currentRoom = null;

  socket.on('join-room', ({ room, name, avatar, avatarPhoto }) => {
    currentRoom = room;
    socket.join(room);
    socket.data.name = name || 'Гость';
    socket.data.avatar = (avatar || '').toString().trim().slice(0, 8);
    socket.data.avatarPhoto = isValidAvatarPhoto(avatarPhoto) ? avatarPhoto : '';

    if (!rooms[room]) {
      rooms[room] = { video: null, currentTime: 0, playing: false, reactions: {}, streamLink: null, externalVideo: null };
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
      externalVideo: rooms[room].externalVideo
    });

    io.to(room).emit('chat-message', {
      system: true,
      text: `${socket.data.name} присоединился(-ась)`
    });

    io.to(room).emit('user-count', io.sockets.adapter.rooms.get(room)?.size || 1);
  });

  socket.on('select-video', ({ room, filename }) => {
    if (!rooms[room]) return;
    rooms[room].video = filename;
    rooms[room].currentTime = 0;
    rooms[room].playing = false;
    rooms[room].streamLink = null;
    rooms[room].externalVideo = null;
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
    rooms[room].currentTime = 0;
    rooms[room].playing = false;
    io.to(room).emit('external-video-selected', { url: trimmed, from: socket.data.name || 'Гость' });
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
  });

  socket.on('typing', ({ room, name }) => {
    if (!room) return;
    socket.to(room).emit('user-typing', { name: name || socket.data.name || 'Гость' });
  });

  socket.on('stop-typing', ({ room }) => {
    if (!room) return;
    socket.to(room).emit('user-stop-typing', {});
  });

  socket.on('chat-message', ({ room, text, image, gifUrl, replyTo }) => {
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
    if (!trimmedText && !safeImage && !safeGifUrl) return; // совсем пустое сообщение — игнорируем

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
      if (replyId && (replyText || replyImage || replyGif)) {
        safeReplyTo = { id: replyId, name: replyName, text: replyText, image: replyImage, gif: replyGif };
      }
    }

    if (!rooms[room]) rooms[room] = { video: null, currentTime: 0, playing: false, reactions: {}, streamLink: null, externalVideo: null };
    const id = randomUUID();
    rooms[room].reactions[id] = {};

    io.to(room).emit('chat-message', {
      id,
      system: false,
      name: socket.data.name,
      avatar: socket.data.avatar || '',
      avatarPhoto: socket.data.avatarPhoto ? ('/avatars/' + socket.data.avatarPhoto) : '',
      text: trimmedText,
      image: safeImage,
      gifUrl: safeGifUrl,
      replyTo: safeReplyTo
    });
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

  socket.on('disconnect', () => {
    if (currentRoom) {
      io.to(currentRoom).emit('chat-message', {
        system: true,
        text: `${socket.data.name || 'Гость'} вышел(ла)`
      });
      // Считаем оставшихся уже после того, как этот сокет вышел из комнаты
      // (socket.io делает это автоматически перед событием disconnect)
      const count = io.sockets.adapter.rooms.get(currentRoom)?.size || 0;
      io.to(currentRoom).emit('user-count', count);

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
