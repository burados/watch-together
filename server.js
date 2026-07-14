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

if (fs.existsSync(UPLOAD_DIR) && !fs.statSync(UPLOAD_DIR).isDirectory()) {
  fs.unlinkSync(UPLOAD_DIR);
}
if (!fs.existsSync(UPLOAD_DIR)) {
  fs.mkdirSync(UPLOAD_DIR);
}
if (!fs.existsSync(CHAT_IMAGE_DIR)) {
  fs.mkdirSync(CHAT_IMAGE_DIR, { recursive: true });
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

app.use(express.static(path.join(__dirname, 'public')));
app.use('/chat-images', express.static(CHAT_IMAGE_DIR));

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

io.on('connection', (socket) => {
  let currentRoom = null;

  socket.on('join-room', ({ room, name }) => {
    currentRoom = room;
    socket.join(room);
    socket.data.name = name || 'Гость';

    if (!rooms[room]) {
      rooms[room] = { video: null, currentTime: 0, playing: false, reactions: {}, streamLink: null };
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
      streamLink: rooms[room].streamLink
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
    io.to(room).emit('video-selected', { filename });
  });

  // Ссылка на трансляцию с другого сайта. Настоящую синхронизацию play/pause
  // тут не сделать (чужой плеер нам не подконтролен), но для прямого эфира
  // это и не нужно — все просто открывают один и тот же линк одновременно.
  socket.on('set-stream-link', ({ room, url }) => {
    if (!rooms[room] || !url) return;
    const trimmed = String(url).trim().slice(0, 2000);
    if (!/^https?:\/\//i.test(trimmed)) return;
    rooms[room].video = null;
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

  socket.on('typing', ({ room, name }) => {
    if (!room) return;
    socket.to(room).emit('user-typing', { name: name || socket.data.name || 'Гость' });
  });

  socket.on('stop-typing', ({ room }) => {
    if (!room) return;
    socket.to(room).emit('user-stop-typing', {});
  });

  socket.on('chat-message', ({ room, text, image }) => {
    if (!room) return;
    const trimmedText = (text || '').toString().trim().slice(0, 4000);
    // Картинка обязана быть именем файла, реально загруженным через /upload-image —
    // никаких произвольных путей/URL тут не принимаем
    const safeImage = (image && /^[a-zA-Z0-9._-]+$/.test(image) && fs.existsSync(path.join(CHAT_IMAGE_DIR, image)))
      ? image
      : null;
    if (!trimmedText && !safeImage) return; // пустое сообщение без текста и картинки — игнорируем

    if (!rooms[room]) rooms[room] = { video: null, currentTime: 0, playing: false, reactions: {} };
    const id = randomUUID();
    rooms[room].reactions[id] = {};

    io.to(room).emit('chat-message', {
      id,
      system: false,
      name: socket.data.name,
      text: trimmedText,
      image: safeImage
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
