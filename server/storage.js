// --- Абстракция хранилища видео ---
// По умолчанию файлы живут локально в uploads/ (как и раньше). Если заданы
// STORAGE_PROVIDER=r2 и все R2_* переменные окружения, а пакет
// @aws-sdk/client-s3 установлен — используется Cloudflare R2. Если чего-то
// из этого не хватает, приложение молча и безопасно откатывается на
// локальное хранилище: ничего не ломается ни на деве, ни без интернета.
//
// Остальной код (server.js) не должен знать, где физически лежит файл —
// он вызывает только функции этого модуля.

const fs = require('fs');
const path = require('path');

const PROVIDER = (process.env.STORAGE_PROVIDER || 'local').toLowerCase();
const R2_BUCKET = process.env.R2_BUCKET_NAME || '';
const R2_ACCOUNT_ID = process.env.R2_ACCOUNT_ID || '';
const R2_ACCESS_KEY_ID = process.env.R2_ACCESS_KEY_ID || '';
const R2_SECRET_ACCESS_KEY = process.env.R2_SECRET_ACCESS_KEY || '';
const R2_PUBLIC_BASE_URL = process.env.R2_PUBLIC_BASE_URL || '';

const LOCAL_DIR = path.join(__dirname, '..', 'uploads');

let s3Client = null;
let s3Mod = null;
let usingR2 = false;

if (PROVIDER === 'r2') {
  if (!R2_ACCOUNT_ID || !R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY || !R2_BUCKET) {
    console.warn('[storage] STORAGE_PROVIDER=r2, но не все R2_* переменные заданы — использую локальное хранилище.');
  } else {
    try {
      // Необязательная зависимость — установи "npm install @aws-sdk/client-s3",
      // если хочешь реально включить R2. Без неё приложение не падает.
      s3Mod = require('@aws-sdk/client-s3');
      const { S3Client } = s3Mod;
      s3Client = new S3Client({
        region: 'auto',
        endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
        credentials: { accessKeyId: R2_ACCESS_KEY_ID, secretAccessKey: R2_SECRET_ACCESS_KEY }
      });
      usingR2 = true;
      console.log('[storage] Используется Cloudflare R2 как хранилище видео.');
    } catch (e) {
      console.warn('[storage] Пакет @aws-sdk/client-s3 не установлен — использую локальное хранилище (npm install @aws-sdk/client-s3 для R2).');
    }
  }
}

function provider() {
  return usingR2 ? 'r2' : 'local';
}

async function existsLocal(key) {
  return fs.existsSync(path.join(LOCAL_DIR, key));
}

// Удаляет файл из активного хранилища (используется автоочисткой старых файлов)
async function deleteFile(key) {
  if (usingR2) {
    const { DeleteObjectCommand } = s3Mod;
    try {
      await s3Client.send(new DeleteObjectCommand({ Bucket: R2_BUCKET, Key: key }));
    } catch (e) {
      console.error(`[storage] Не удалось удалить "${key}" из R2:`, e.message);
    }
  } else {
    const p = path.join(LOCAL_DIR, key);
    if (fs.existsSync(p)) fs.unlinkSync(p);
  }
}

// Multer уже сохранил файл локально (это самый надёжный и простой способ
// принять большую загрузку, не держа её всю в памяти сервера). Если включён
// R2 — докладываем копию в облако и локальную можно будет позже подчистить
// автоочисткой; если R2 выключен — делать нечего, файл уже на месте.
async function uploadFileFromPath(localFilePath, key, contentType) {
  if (!usingR2) return { provider: 'local' };
  try {
    const { PutObjectCommand } = s3Mod;
    const body = fs.createReadStream(localFilePath);
    await s3Client.send(new PutObjectCommand({
      Bucket: R2_BUCKET,
      Key: key,
      Body: body,
      ContentType: contentType || 'application/octet-stream'
    }));
    return { provider: 'r2' };
  } catch (e) {
    console.error(`[storage] Загрузка "${key}" в R2 не удалась, файл остаётся только локально:`, e.message);
    return { provider: 'local', error: e.message };
  }
}

function getPublicUrl(key) {
  if (usingR2 && R2_PUBLIC_BASE_URL) {
    return R2_PUBLIC_BASE_URL.replace(/\/$/, '') + '/' + encodeURIComponent(key);
  }
  return null; // локально всегда отдаём через /video/:filename
}

// Range-aware чтение файла — единая точка для стриминга видео независимо
// от того, где физически лежит файл. Возвращает null, если файла нет нигде.
async function getRangeStream(key, rangeHeader, mimeType) {
  if (usingR2) {
    try {
      const { GetObjectCommand } = s3Mod;
      const cmd = new GetObjectCommand({ Bucket: R2_BUCKET, Key: key, Range: rangeHeader || undefined });
      const obj = await s3Client.send(cmd);
      const headers = { 'Content-Type': mimeType || obj.ContentType || 'video/mp4', 'Accept-Ranges': 'bytes' };
      if (rangeHeader && obj.ContentRange) {
        headers['Content-Range'] = obj.ContentRange;
        headers['Content-Length'] = obj.ContentLength;
        return { stream: obj.Body, headers, statusCode: 206 };
      }
      headers['Content-Length'] = obj.ContentLength;
      return { stream: obj.Body, headers, statusCode: 200 };
    } catch (e) {
      console.error(`[storage] Не удалось прочитать "${key}" из R2:`, e.message);
      return null;
    }
  }

  const filePath = path.join(LOCAL_DIR, key);
  if (!fs.existsSync(filePath)) return null;
  const stat = fs.statSync(filePath);
  const fileSize = stat.size;

  if (rangeHeader) {
    const parts = rangeHeader.replace(/bytes=/, '').split('-');
    const start = parseInt(parts[0], 10);
    const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
    const chunkSize = end - start + 1;
    return {
      stream: fs.createReadStream(filePath, { start, end }),
      statusCode: 206,
      headers: {
        'Content-Range': `bytes ${start}-${end}/${fileSize}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': chunkSize,
        'Content-Type': mimeType || 'video/mp4'
      }
    };
  }

  return {
    stream: fs.createReadStream(filePath),
    statusCode: 200,
    headers: { 'Content-Length': fileSize, 'Content-Type': mimeType || 'video/mp4' }
  };
}

module.exports = {
  provider,
  usingR2: () => usingR2,
  existsLocal,
  deleteFile,
  uploadFileFromPath,
  getPublicUrl,
  getRangeStream
};
