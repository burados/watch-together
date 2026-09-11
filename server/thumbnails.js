// --- Превью кадров и техническая информация о видео через FFmpeg/FFprobe ---
// Оба инструмента совершенно необязательны: если их нет в окружении (частый
// случай на деве), все функции просто возвращают null, и остальной код
// обязан относиться к этому как к обычному "метаданных нет", а не как к
// ошибке, которая должна что-то сломать.

const { spawn } = require('child_process');
const fs = require('fs');

const FFMPEG_PATH = process.env.FFMPEG_PATH || 'ffmpeg';
const FFPROBE_PATH = process.env.FFPROBE_PATH || 'ffprobe';

let ffmpegAvailable = null; // null = ещё не проверяли, иначе true/false — кэшируем на весь процесс

function checkFfmpeg() {
  return new Promise((resolve) => {
    if (ffmpegAvailable !== null) return resolve(ffmpegAvailable);
    try {
      const p = spawn(FFMPEG_PATH, ['-version']);
      p.on('error', () => { ffmpegAvailable = false; resolve(false); });
      p.on('close', (code) => { ffmpegAvailable = code === 0; resolve(ffmpegAvailable); });
    } catch (e) {
      ffmpegAvailable = false;
      resolve(false);
    }
  });
}

// Best-effort техническая информация (длительность/разрешение) через ffprobe.
function probeVideo(filePath) {
  return new Promise((resolve) => {
    try {
      const args = ['-v', 'error', '-select_streams', 'v:0', '-show_entries',
        'stream=width,height:format=duration', '-of', 'json', filePath];
      const p = spawn(FFPROBE_PATH, args);
      let out = '';
      p.stdout.on('data', (d) => { out += d; });
      p.on('error', () => resolve(null));
      p.on('close', (code) => {
        if (code !== 0) return resolve(null);
        try {
          const json = JSON.parse(out);
          const stream = (json.streams || [])[0] || {};
          const duration = json.format && json.format.duration ? Math.round(parseFloat(json.format.duration)) : null;
          resolve({ width: stream.width || null, height: stream.height || null, duration: duration || null });
        } catch (e) {
          resolve(null);
        }
      });
    } catch (e) {
      resolve(null);
    }
  });
}

// Берёт кадр примерно на 15% длительности видео (не самый первый кадр —
// он у многих фильмов чёрный/с логотипом студии) и сохраняет JPEG-превью.
// Возвращает outputPath при успехе, иначе null — без исключений наружу.
async function generateThumbnail(inputPath, outputPath, durationSeconds) {
  const available = await checkFfmpeg();
  if (!available) return null;
  const seekTo = durationSeconds && durationSeconds > 4 ? Math.max(1, Math.floor(durationSeconds * 0.15)) : 1;
  return new Promise((resolve) => {
    try {
      const args = ['-y', '-ss', String(seekTo), '-i', inputPath, '-frames:v', '1', '-vf', 'scale=480:-1', outputPath];
      const p = spawn(FFMPEG_PATH, args);
      p.on('error', () => resolve(null));
      p.on('close', (code) => {
        resolve(code === 0 && fs.existsSync(outputPath) ? outputPath : null);
      });
    } catch (e) {
      resolve(null);
    }
  });
}

module.exports = { checkFfmpeg, probeVideo, generateThumbnail };
