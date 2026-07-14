const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const UPLOAD_DIR = path.join(__dirname, 'uploads');

if (fs.existsSync(UPLOAD_DIR) && !fs.statSync(UPLOAD_DIR).isDirectory()) {
  fs.unlinkSync(UPLOAD_DIR);
}
if (!fs.existsSync(UPLOAD_DIR)) {
  fs.mkdirSync(UPLOAD_DIR);
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

app.use(express.static(path.join(__dirname, 'public')));

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
const rooms = {}; // roomId -> { video, currentTime, playing, users: Set }

io.on('connection', (socket) => {
  let currentRoom = null;

  socket.on('join-room', ({ room, name }) => {
    currentRoom = room;
    socket.join(room);
    socket.data.name = name || 'Гость';

    if (!rooms[room]) {
      rooms[room] = { video: null, currentTime: 0, playing: false };
    }

    // Отправляем новому участнику текущее состояние комнаты
    socket.emit('room-state', rooms[room]);

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
    io.to(room).emit('video-selected', { filename });
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

  socket.on('chat-message', ({ room, text }) => {
    io.to(room).emit('chat-message', {
      system: false,
      name: socket.data.name,
      text
    });
  });

  socket.on('reaction', ({ room, emoji }) => {
    if (!room || !emoji) return;
    io.to(room).emit('reaction', { emoji, name: socket.data.name || 'Гость' });
  });

  socket.on('disconnect', () => {
    if (currentRoom) {
      io.to(currentRoom).emit('chat-message', {
        system: true,
        text: `${socket.data.name || 'Гость'} вышел(ла)`
      });
      const count = io.sockets.adapter.rooms.get(currentRoom)?.size || 0;
      io.to(currentRoom).emit('user-count', count);
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Сервер запущен: http://localhost:${PORT}`);
});
