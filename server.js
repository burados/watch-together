const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const helmet = require('helmet');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const { Server } = require('socket.io');
const { randomUUID } = require('crypto');

const app = express();
const server = http.createServer(app);

// --- CORS: список разрешённых источников ---
//
// Задаётся через переменную окружения ALLOWED_ORIGINS (через запятую), например:
//   ALLOWED_ORIGINS=https://watch.example.com,https://app.watch.example.com
//
// Это понадобится не только браузеру: когда приложение будет упаковано под
// Android (TWA/Capacitor), запросы к серверу будут приходить с другого origin
// (например, https://localhost или digital-asset-links домен), и без явного
// разрешения браузер/WebView будет блокировать такие запросы.
//
// Если переменная не задана — считаем, что мы в разработке, и разрешаем всё,
// но громко предупреждаем в консоли, чтобы это не забыли настроить в проде.
const allowedOriginsEnv = (process.env.ALLOWED_ORIGINS || '').trim();
const allowedOrigins = allowedOriginsEnv
  ? allowedOriginsEnv.split(',').map((s) => s.trim()).filter(Boolean)
  : null;

if (!allowedOrigins) {
  console.warn(
    '[CORS] Переменная ALLOWED_ORIGINS не задана — разрешены запросы с любого источника. ' +
    'Перед публикацией задайте ALLOWED_ORIGINS (например, ALLOWED_ORIGINS=https://your-domain.com).'
  );
}

function isOriginAllowed(origin) {
  // origin === undefined — запрос без заголовка Origin (curl, серверные вызовы,
  // некоторые мобильные WebView) — пропускаем, т.к. тут нет браузерной CORS-угрозы.
  if (!origin) return true;
  if (!allowedOrigins) return true; // список не настроен — разработка
  return allowedOrigins.includes(origin);
}

const corsOptions = {
  origin(origin, callback) {
    if (isOriginAllowed(origin)) callback(null, true);
    else callback(new Error(`CORS: источник "${origin}" не разрешён`));
  },
  methods: ['GET', 'POST'],
  credentials: false
};

const io = new Server(server, {
  cors: {
    origin(origin, callback) {
      if (isOriginAllowed(origin)) callback(null, true);
      else callback(new Error(`CORS: источник "${origin}" не разрешён`));
    },
    methods: ['GET', 'POST'],
    credentials: false
  }
});

// --- Безопасность: базовые HTTP-заголовки (Helmet) + Content-Security-Policy ---
//
// CSP настроен под реальные нужды приложения:
//  - шрифты Google Fonts (fonts.googleapis.com / fonts.gstatic.com);
//  - hls.js с cdn.jsdelivr.net (для проигрывания .m3u8-трансляций);
//  - произвольные внешние https-ссылки на видео/трансляции — их вставляет сам
//    пользователь комнаты (функции "внешнее видео" / "ссылка на трансляцию"),
//    поэтому media-src и connect-src не могут быть ограничены одним доменом.
//
// crossOriginEmbedderPolicy отключён намеренно: включённый COEP потребовал бы
// CORP-заголовков от ЛЮБОГО стороннего видео/трансляции, которую вставит
// пользователь, а мы такими серверами не управляем — с COEP большая часть
// внешних ссылок на видео просто перестала бы загружаться.
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        // 'unsafe-inline' для script/style пока обязателен — фронтенд сейчас
        // единым файлом с инлайн-<script>/<style> и инлайн-обработчиками;
        // это будет ужесточено (nonce/hash) на этапе рефакторинга фронтенда.
        scriptSrc: ["'self'", "'unsafe-inline'", 'https://cdn.jsdelivr.net'],
        styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
        fontSrc: ["'self'", 'https://fonts.gstatic.com', 'data:'],
        imgSrc: ["'self'", 'data:', 'blob:', 'https:'],
        mediaSrc: ["'self'", 'blob:', 'https:'],
        connectSrc: ["'self'", 'https:', 'wss:', 'ws:'],
        workerSrc: ["'self'", 'blob:'],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        frameAncestors: ["'self'"]
      }
    },
    crossOriginEmbedderPolicy: false,
    crossOriginResourcePolicy: { policy: 'cross-origin' }
  })
);

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

// --- Привязка доступа к видеофайлу к комнате (устранение IDOR) ---
//
// До этого момента /video/:filename отдавал ЛЮБОЙ файл из uploads по одному
// только имени — без проверки, что запрашивающий вообще имеет отношение к
// комнате, в которую это видео когда-то загрузили. Имена файлов строятся как
// `${Date.now()}-${originalname}` (см. multer.diskStorage выше) — то есть
// предсказуемы и легко перебираются/угадываются. То же самое с /videos:
// эндпоинт возвращал список ВСЕХ когда-либо загруженных файлов на сервере,
// независимо от комнаты, — по сути каталог чужого приватного контента.
// Итог — классический IDOR: обладание корректным именем файла (просто числом
// и оригинальным именем) давало доступ к видео другой, ничем не защищённой
// комнаты.
//
// Фикс: у каждого загруженного файла теперь есть комната-владелец, и:
//  - /video/:filename требует query-параметр room и отдаёт файл только если
//    он был загружен именно в эту комнату;
//  - /videos возвращает только файлы, привязанные к запрошенной комнате;
//  - select-video на сокете принимает выбор файла, только если он
//    действительно принадлежит комнате, в которой его выбирают — иначе
//    участник одной комнаты не может подставить (подобрав имя файла) видео
//    из чужой комнаты как видео своей.
//
// Хранится в памяти (Map), как и вся остальная информация о комнатах —
// осознанный компромисс, согласованный с уже существующим поведением
// приложения (rooms/cleanupTimer тоже не переживают перезапуск сервера).
const videoRoomOwner = new Map(); // filename -> room

function registerVideoOwnership(filename, room) {
  if (filename && room) videoRoomOwner.set(filename, room);
}

function isVideoOwnedByRoom(filename, room) {
  return !!filename && !!room && videoRoomOwner.get(filename) === room;
}

// --- Ограничение MIME-типов при загрузке видео ---
//
// До этого момента /upload принимал файл любого типа: filename() только
// вычищал недопустимые символы из имени, но не проверял, что за файл вообще
// пришёл. При этом /video/:filename отдаёт контент с жёстко прописанным
// Content-Type: video/mp4 независимо от реального содержимого — то есть
// сервер был готов молча сохранить и раздать любой файл (например .html/.js)
// под видео-эндпоинтом.
//
// Проверяем ДВА независимых сигнала и требуем совпадения обоих:
//  - file.mimetype, который выставляет браузер по содержимому файла
//    (Blob/File.type), а не только по расширению в имени;
//  - расширение из originalname.
// Одного mimetype недостаточно (его несложно подделать в форме на клиенте),
// одного расширения тоже недостаточно (это и есть ровно "проверка не только
// по расширению", которую убирает эта проверка) — поэтому оба должны быть
// одновременно из белого списка распространённых видеоформатов.
const ALLOWED_VIDEO_MIME_TYPES = new Set([
  'video/mp4',
  'video/webm',
  'video/ogg',
  'video/quicktime',
  'video/x-matroska',
  'video/x-msvideo',
  'video/x-ms-wmv',
  'video/3gpp',
  'video/mp2t'
]);

const ALLOWED_VIDEO_EXTENSIONS = new Set([
  '.mp4', '.m4v', '.webm', '.ogg', '.ogv', '.mov', '.mkv', '.avi', '.wmv', '.3gp', '.ts'
]);

function isAllowedVideoFile(file) {
  const mimetype = (file.mimetype || '').toLowerCase();
  const ext = path.extname(file.originalname || '').toLowerCase();
  return ALLOWED_VIDEO_MIME_TYPES.has(mimetype) && ALLOWED_VIDEO_EXTENSIONS.has(ext);
}

// --- Квота на диск / общий лимит хранилища uploads ---
//
// До этого момента диск ничем не был ограничен, кроме лимита размера ОДНОГО
// файла (fileSize у multer). Это не защищает от переполнения диска: можно
// было заливать видео за видео (или картинки в чат), пока место физически не
// кончится, — а сервер (логи, БД состояния и т.п.) находится на том же диске
// и падает вместе с ним.
//
// Считаем СУММАРНЫЙ размер каталога uploads (видео + uploads/chat-images,
// т.к. это подпапка) и не даём превысить UPLOAD_QUOTA_BYTES:
//  - до записи файла — оцениваем итоговый размер по Content-Length запроса
//    (доступен уже в fileFilter, до того как multer дописал файл на диск) —
//    это не даёт начать заведомо обречённую запись огромного файла;
//  - после записи — на случай гонки (несколько параллельных загрузок прошли
//    pre-check одновременно, суммарно превысив квоту) — если по факту квота
//    превышена, только что записанный файл удаляется, и клиенту возвращается
//    ошибка, а не тихо оставленный на диске файл сверх лимита.
//
// Задаётся в гигабайтах через UPLOAD_QUOTA_GB (по умолчанию 50 ГБ) — под
// реальный размер диска конкретного деплоя.
const UPLOAD_QUOTA_BYTES = (parseFloat(process.env.UPLOAD_QUOTA_GB) || 50) * 1024 * 1024 * 1024;

// Рекурсивно считает суммарный размер файлов в директории (в байтах).
// Достаточно дёшево (только stat, без чтения содержимого) для разумного
// количества файлов, характерного для самостоятельно хостящегося приложения.
function getDirectorySizeBytes(dir) {
  let total = 0;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    return total;
  }
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      total += getDirectorySizeBytes(fullPath);
    } else if (entry.isFile()) {
      try {
        total += fs.statSync(fullPath).size;
      } catch (err) {
        // Файл мог исчезнуть между readdir и stat (например, автоочистка) — пропускаем
      }
    }
  }
  return total;
}

// Предварительная проверка в fileFilter: используем Content-Length запроса
// как консервативную (чуть завышенную из-за multipart-обвязки) оценку
// размера входящего файла, т.к. реальный размер файла на этом этапе ещё
// неизвестен — тело запроса ещё не дочитано.
function isQuotaExceededForIncomingRequest(req) {
  const contentLength = parseInt(req.headers['content-length'], 10) || 0;
  const currentUsage = getDirectorySizeBytes(UPLOAD_DIR);
  return currentUsage + contentLength > UPLOAD_QUOTA_BYTES;
}

// Пост-проверка после того, как multer уже записал файл на диск: если общая
// занятость всё же превысила квоту (гонка параллельных загрузок), удаляем
// только что сохранённый файл и возвращаем ошибку клиенту.
function enforceQuotaAfterUpload(filePath) {
  if (getDirectorySizeBytes(UPLOAD_DIR) > UPLOAD_QUOTA_BYTES) {
    fs.unlink(filePath, (err) => {
      if (err) console.error('Не удалось удалить файл после превышения квоты:', err.message);
    });
    return true;
  }
  return false;
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
  limits: { fileSize: 8 * 1024 * 1024 * 1024 }, // до 8 ГБ
  fileFilter: (req, file, cb) => {
    if (!isAllowedVideoFile(file)) {
      return cb(new Error(
        'Недопустимый формат видео. Разрешены: MP4, WebM, OGG, MOV, MKV, AVI, WMV, 3GP, TS'
      ));
    }
    if (isQuotaExceededForIncomingRequest(req)) {
      return cb(new Error('Общий лимит хранилища для загрузок исчерпан. Освободите место и попробуйте снова.'));
    }
    cb(null, true);
  }
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
    if (isQuotaExceededForIncomingRequest(req)) {
      return cb(new Error('Общий лимит хранилища для загрузок исчерпан. Освободите место и попробуйте снова.'));
    }
    cb(null, true);
  }
});

app.use(cors(corsOptions));

app.use(express.static(path.join(__dirname, 'public')));
app.use('/chat-images', express.static(CHAT_IMAGE_DIR));

// --- Rate-limiting загрузок ---
//
// Ограничиваем частоту запросов на /upload и /upload-image по IP. Это не
// защита от DDoS (для этого нужен внешний слой — nginx/Cloudflare), а именно
// защита от злоупотребления самой функцией загрузки: заливка кучи больших
// видео подряд забивает диск быстрее, чем успевает сработать автоочистка;
// частые вызовы /upload-image — самый дешёвый способ засыпать сервер записью
// на диск через чат.
//
// Настраивается через переменные окружения, чтобы можно было подстроить под
// реальную нагрузку без правки кода.
function jsonRateLimitHandler(message) {
  return (req, res) => {
    res.status(429).json({ error: message });
  };
}

const uploadLimiter = rateLimit({
  windowMs: (parseInt(process.env.UPLOAD_RATE_WINDOW_MINUTES, 10) || 15) * 60 * 1000,
  limit: parseInt(process.env.UPLOAD_RATE_MAX, 10) || 10,
  standardHeaders: true,
  legacyHeaders: false,
  handler: jsonRateLimitHandler('Слишком много загрузок видео с этого адреса. Попробуйте позже.')
});

const uploadImageLimiter = rateLimit({
  windowMs: (parseInt(process.env.UPLOAD_IMAGE_RATE_WINDOW_MINUTES, 10) || 10) * 60 * 1000,
  limit: parseInt(process.env.UPLOAD_IMAGE_RATE_MAX, 10) || 40,
  standardHeaders: true,
  legacyHeaders: false,
  handler: jsonRateLimitHandler('Слишком много загрузок картинок с этого адреса. Попробуйте позже.')
});

// Загрузка видео
//
// Комната передаётся клиентом как обычное текстовое поле формы (room) —
// multer кладёт его в req.body ещё до вызова fileFilter/обработчика ниже.
// Без валидной комнаты файл не сохраняем: иначе он останется ничьим и либо
// будет недоступен всем (после фикса IDOR), либо (без привязки) — доступен
// всем, что и есть исходная уязвимость.
app.post('/upload', uploadLimiter, (req, res) => {
  upload.single('video')(req, res, (err) => {
    if (err) {
      console.error('Ошибка загрузки:', err.message);
      return res.status(400).json({ error: err.message });
    }
    if (!req.file) return res.status(400).json({ error: 'Файл не получен' });

    if (enforceQuotaAfterUpload(req.file.path)) {
      return res.status(413).json({ error: 'Общий лимит хранилища для загрузок исчерпан. Освободите место и попробуйте снова.' });
    }

    const room = sanitizeRoom(req.body && req.body.room);
    if (!room) {
      // Комната не передана/некорректна — не оставляем файл висеть без
      // владельца, сразу удаляем то, что multer уже успел записать на диск.
      fs.unlink(req.file.path, (unlinkErr) => {
        if (unlinkErr) console.error('Не удалось удалить файл без комнаты:', unlinkErr.message);
      });
      return res.status(400).json({ error: 'Не указана комната для загрузки' });
    }

    registerVideoOwnership(req.file.filename, room);
    res.json({ filename: req.file.filename });
  });
});

// Загрузка картинки в чат (скрин из буфера обмена или фото с устройства)
app.post('/upload-image', uploadImageLimiter, (req, res) => {
  uploadChatImage.single('image')(req, res, (err) => {
    if (err) {
      console.error('Ошибка загрузки картинки:', err.message);
      return res.status(400).json({ error: err.message });
    }
    if (!req.file) return res.status(400).json({ error: 'Файл не получен' });
    if (enforceQuotaAfterUpload(req.file.path)) {
      return res.status(413).json({ error: 'Общий лимит хранилища для загрузок исчерпан. Освободите место и попробуйте снова.' });
    }
    res.json({ filename: req.file.filename });
  });
});

// Список загруженных файлов — только те, что были загружены в указанную
// комнату (см. блок про IDOR выше). Без валидной комнаты возвращаем пустой
// список, а не всё содержимое uploads/.
app.get('/videos', (req, res) => {
  const room = sanitizeRoom(req.query.room);
  if (!room) return res.json([]);

  const files = fs.readdirSync(UPLOAD_DIR)
    .filter((f) => !f.startsWith('.') && isVideoOwnedByRoom(f, room));
  res.json(files);
});

// Стриминг видео с поддержкой Range-запросов (перемотка).
// Требуем ту же комнату, в которую файл был загружен (см. IDOR-фикс выше):
// без неё или с чужой комнатой — 403, а не отдача файла по одному лишь имени.
app.get('/video/:filename', (req, res) => {
  const room = sanitizeRoom(req.query.room);
  if (!room || !isVideoOwnedByRoom(req.params.filename, room)) {
    return res.status(403).send('Нет доступа к этому видео из указанной комнаты');
  }

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
          // Файла больше нет — убираем и запись о его комнате-владельце,
          // иначе videoRoomOwner будет бесконечно расти за счёт удалённых файлов.
          videoRoomOwner.delete(file);
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

// --- Rate-limiting Socket.IO событий (анти-флуд) ---
//
// express-rate-limit защищает только HTTP-роуты (/upload, /upload-image),
// но основная поверхность для флуда — это как раз WS-события: можно долбить
// chat-message/seek/typing сотни раз в секунду и никакой HTTP-лимитер этого
// не увидит. Поэтому здесь отдельный, простой per-socket sliding-window
// лимитер: для каждого сокета и каждого события считаем количество вызовов
// в скользящем окне и молча отбрасываем всё, что превышает лимит (без ответа
// клиенту — это анти-флуд, а не обучение атакующего тому, где граница).
//
// Лимиты подобраны с запасом под обычное использование (быстрый чат,
// перетаскивание ползунка перемотки), но достаточно жёстко, чтобы не дать
// закинуть сервер/комнату событиями.
const SOCKET_EVENT_LIMITS = {
  'chat-message': { windowMs: 10_000, max: 10 },
  'message-reaction': { windowMs: 10_000, max: 20 },
  'seek': { windowMs: 5_000, max: 15 },
  'play': { windowMs: 5_000, max: 10 },
  'pause': { windowMs: 5_000, max: 10 },
  'typing': { windowMs: 5_000, max: 15 },
  'stop-typing': { windowMs: 5_000, max: 15 },
  'select-video': { windowMs: 10_000, max: 10 },
  'set-external-video': { windowMs: 10_000, max: 10 },
  'set-stream-link': { windowMs: 10_000, max: 10 },
  'join-room': { windowMs: 10_000, max: 10 }
};

// true — событие превысило лимит и должно быть отброшено
function isSocketEventRateLimited(socket, eventName) {
  const limit = SOCKET_EVENT_LIMITS[eventName];
  if (!limit) return false;

  const now = Date.now();
  if (!socket.data.rateBuckets) socket.data.rateBuckets = {};
  let bucket = socket.data.rateBuckets[eventName];

  if (!bucket || now - bucket.windowStart > limit.windowMs) {
    bucket = { windowStart: now, count: 0 };
    socket.data.rateBuckets[eventName] = bucket;
  }

  bucket.count += 1;
  return bucket.count > limit.max;
}

// Оборачивает обработчик события: если лимит для eventName превышен —
// обработчик просто не вызывается. Используется для всех событий, которые
// перечислены в SOCKET_EVENT_LIMITS.
function withRateLimit(socket, eventName, handler) {
  return (...args) => {
    if (isSocketEventRateLimited(socket, eventName)) return;
    handler(...args);
  };
}

// --- Валидация и санитизация name/room при join-room ---
//
// До этого момента room/name из события join-room использовались как есть,
// без какой-либо проверки типа или длины. Это не XSS-риск (имя выводится на
// клиенте через textContent, не innerHTML), но реальная проблема в другом:
// - room/name могут прийти вообще не строкой (объект, массив, число,
//   отсутствовать) — это либо уронит обработчик, либо запишет мусор в
//   socket.io room key / данные комнаты;
// - ничем не ограниченная длина строки позволяет засыпать сервер и всех
//   участников комнаты гигантскими значениями в каждом чат-сообщении/системном
//   уведомлении ("X присоединился(-ась)");
// - управляющие символы (\x00-\x1F и т.п.) в имени/коде комнаты не нужны ни
//   для одного легитимного сценария и могут ломать логи/консоль на клиенте.
//
// Ограничения по длине выбраны с запасом относительно client-side maxlength
// (20 для имени, 30 для кода комнаты в index.html), чтобы не задеть обычных
// пользователей, но полностью исключить произвол при обращении напрямую к
// сокету в обход разметки.
const MAX_NAME_LENGTH = 40;
const MAX_ROOM_LENGTH = 60;

// Управляющие символы (включая \x7F/DEL) — вырезаем из имени и кода комнаты
function stripControlChars(str) {
  return str.replace(/[\x00-\x1F\x7F]/g, '');
}

function sanitizeName(rawName) {
  if (typeof rawName !== 'string') return 'Гость';
  const cleaned = stripControlChars(rawName).trim().slice(0, MAX_NAME_LENGTH);
  return cleaned || 'Гость';
}

// Возвращает нормализованный код комнаты или null, если он некорректен
// (не строка / пустой после очистки). Специально не ограничиваем алфавит
// набором [a-z0-9-] жёстко: пользователи уже могли создать комнаты с
// пробелами/юникодом в названии, и мы не хотим ломать существующие ссылки —
// достаточно убрать управляющие символы и ограничить длину.
function sanitizeRoom(rawRoom) {
  if (typeof rawRoom !== 'string') return null;
  const cleaned = stripControlChars(rawRoom).trim().slice(0, MAX_ROOM_LENGTH);
  return cleaned || null;
}

io.on('connection', (socket) => {
  let currentRoom = null;

  socket.on('join-room', withRateLimit(socket, 'join-room', (payload) => {
    const safeRoom = sanitizeRoom(payload && payload.room);
    if (!safeRoom) {
      socket.emit('join-error', { error: 'Некорректный код комнаты' });
      return;
    }
    const safeName = sanitizeName(payload && payload.name);

    const room = safeRoom;
    currentRoom = room;
    socket.join(room);
    socket.data.name = safeName;

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
  }));

  socket.on('select-video', withRateLimit(socket, 'select-video', ({ room, filename }) => {
    if (!rooms[room]) return;
    // Файл должен быть загружен именно в эту комнату — иначе участник может
    // угадать/подобрать имя чужого файла (см. IDOR-фикс выше) и заставить
    // сервер и остальных участников трактовать его как видео своей комнаты.
    if (!isVideoOwnedByRoom(filename, room)) return;
    rooms[room].video = filename;
    rooms[room].currentTime = 0;
    rooms[room].playing = false;
    rooms[room].streamLink = null;
    rooms[room].externalVideo = null;
    io.to(room).emit('video-selected', { filename });
  }));

  // Прямая ссылка на видеофайл (.mp4/.webm/.m3u8 и т.п.) с внешнего сервера.
  // В отличие от set-stream-link, тут видео грузится прямо в наш <video>,
  // поэтому play/pause/перемотка синхронизируются между зрителями по-настоящему.
  socket.on('set-external-video', withRateLimit(socket, 'set-external-video', ({ room, url }) => {
    if (!rooms[room] || !url) return;
    const trimmed = String(url).trim().slice(0, 2000);
    if (!/^https?:\/\//i.test(trimmed)) return;
    rooms[room].video = null;
    rooms[room].streamLink = null;
    rooms[room].externalVideo = trimmed;
    rooms[room].currentTime = 0;
    rooms[room].playing = false;
    io.to(room).emit('external-video-selected', { url: trimmed, from: socket.data.name || 'Гость' });
  }));

  // Ссылка на трансляцию с другого сайта. Настоящую синхронизацию play/pause
  // тут не сделать (чужой плеер нам не подконтролен), но для прямого эфира
  // это и не нужно — все просто открывают один и тот же линк одновременно.
  socket.on('set-stream-link', withRateLimit(socket, 'set-stream-link', ({ room, url }) => {
    if (!rooms[room] || !url) return;
    const trimmed = String(url).trim().slice(0, 2000);
    if (!/^https?:\/\//i.test(trimmed)) return;
    rooms[room].video = null;
    rooms[room].externalVideo = null;
    rooms[room].streamLink = trimmed;
    io.to(room).emit('stream-link-updated', { url: trimmed, from: socket.data.name || 'Гость' });
  }));

  socket.on('play', withRateLimit(socket, 'play', ({ room, time }) => {
    if (!rooms[room]) return;
    rooms[room].playing = true;
    rooms[room].currentTime = time;
    socket.to(room).emit('sync-play', { time });
  }));

  socket.on('pause', withRateLimit(socket, 'pause', ({ room, time }) => {
    if (!rooms[room]) return;
    rooms[room].playing = false;
    rooms[room].currentTime = time;
    socket.to(room).emit('sync-pause', { time });
  }));

  socket.on('seek', withRateLimit(socket, 'seek', ({ room, time }) => {
    if (!rooms[room]) return;
    rooms[room].currentTime = time;
    socket.to(room).emit('sync-seek', { time });
  }));

  socket.on('typing', withRateLimit(socket, 'typing', ({ room, name }) => {
    if (!room) return;
    socket.to(room).emit('user-typing', { name: name || socket.data.name || 'Гость' });
  }));

  socket.on('stop-typing', withRateLimit(socket, 'stop-typing', ({ room }) => {
    if (!room) return;
    socket.to(room).emit('user-stop-typing', {});
  }));

  socket.on('chat-message', withRateLimit(socket, 'chat-message', ({ room, text, image, replyTo }) => {
    if (!room) return;
    const trimmedText = (text || '').toString().trim().slice(0, 4000);
    // Картинка обязана быть именем файла, реально загруженным через /upload-image —
    // никаких произвольных путей/URL тут не принимаем
    const safeImage = (image && /^[a-zA-Z0-9._-]+$/.test(image) && fs.existsSync(path.join(CHAT_IMAGE_DIR, image)))
      ? image
      : null;
    if (!trimmedText && !safeImage) return; // пустое сообщение без текста и картинки — игнорируем

    // "Ответ на сообщение" — сервер не хранит историю чата, поэтому просто
    // ретранслирует то, что прислал клиент (у него это сообщение уже есть на
    // экране), с обрезкой длины на всякий случай
    let safeReplyTo = null;
    if (replyTo && typeof replyTo === 'object') {
      const replyId = String(replyTo.id || '').slice(0, 100);
      const replyName = String(replyTo.name || 'Гость').slice(0, 100);
      const replyText = String(replyTo.text || '').slice(0, 300);
      const replyImage = !!replyTo.image;
      if (replyId && (replyText || replyImage)) {
        safeReplyTo = { id: replyId, name: replyName, text: replyText, image: replyImage };
      }
    }

    if (!rooms[room]) rooms[room] = { video: null, currentTime: 0, playing: false, reactions: {}, streamLink: null, externalVideo: null };
    const id = randomUUID();
    rooms[room].reactions[id] = {};

    io.to(room).emit('chat-message', {
      id,
      system: false,
      name: socket.data.name,
      text: trimmedText,
      image: safeImage,
      replyTo: safeReplyTo
    });
  }));

  // Реакция на конкретное сообщение чата (одна реакция на пользователя за сообщение)
  socket.on('message-reaction', withRateLimit(socket, 'message-reaction', ({ room, messageId, emoji }) => {
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
  }));

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

// --- Единый обработчик ошибок Express ---
// Ловит в том числе ошибки CORS (origin не в allowedOrigins) и отдаёт чистый
// JSON-ответ вместо стектрейса Node в теле ответа.
app.use((err, req, res, next) => {
  if (err && /^CORS:/.test(err.message || '')) {
    console.warn(`[CORS] Отклонён запрос: ${err.message}`);
    return res.status(403).json({ error: 'Источник запроса не разрешён (CORS)' });
  }
  console.error('Необработанная ошибка запроса:', err);
  res.status(500).json({ error: 'Внутренняя ошибка сервера' });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Сервер запущен: http://localhost:${PORT}`);
});
