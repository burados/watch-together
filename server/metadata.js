// --- Метаданные видео ---
// 1) Быстрый и всегда доступный разбор имени файла в чистое название.
// 2) Необязательное обогащение через TMDB (нужен TMDB_API_KEY) — если ключа
//    нет или запрос не удался, приложение просто использует то, что вышло
//    из разбора имени файла. Ничего никогда не должно ломать загрузку видео.

const RELEASE_JUNK = /\b(2160p|1080p|720p|480p|4k|hdr10?|dv|bluray|blu-ray|brrip|bdrip|webrip|web-?dl|hdtv|dvdrip|dvdscr|camrip|x264|x265|h264|h265|hevc|avc|aac2?\.?0?|ac3|dts(-hd)?|atmos|remux|proper|repack|extended|unrated|directors?\.?cut|multi|dual|rus|eng|ukr|sub(bed)?|dub(bed)?|yify|rarbg|galaxyrg)\b/gi;

function cleanTitle(raw) {
  let t = String(raw || '')
    .replace(/[._]/g, ' ')
    .replace(RELEASE_JUNK, ' ')
    .replace(/[\[\](){}]/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim()
    .replace(/^[-\s]+|[-\s]+$/g, '');
  return t;
}

// Разбирает имя файла вида "The.Dark.Knight.2008.1080p.BluRay.x264.mp4" или
// "Breaking.Bad.S01E01.mp4" в чистое название. Всегда возвращает что-то
// показываемое (в худшем случае — очищенное, но нетронутое имя файла).
function extractMetadataFromFilename(originalName) {
  const base = String(originalName || 'video').replace(/\.[^./]+$/, '');

  const seriesMatch = base.match(/^(.*?)[.\s_-]+[Ss](\d{1,2})[Ee](\d{1,3})/);
  if (seriesMatch) {
    const title = cleanTitle(seriesMatch[1]) || base;
    const season = parseInt(seriesMatch[2], 10);
    const episode = parseInt(seriesMatch[3], 10);
    return {
      title: `${title} — S${String(season).padStart(2, '0')}E${String(episode).padStart(2, '0')}`,
      searchTitle: title,
      year: null,
      season,
      episode,
      kind: 'series'
    };
  }

  const yearMatch = base.match(/(?:^|[.\s_([-])((?:19|20)\d{2})(?:[.\s_)\]-]|$)/);
  let title = base;
  let year = null;
  if (yearMatch) {
    year = parseInt(yearMatch[1], 10);
    title = base.slice(0, yearMatch.index);
  }
  title = cleanTitle(title) || cleanTitle(base) || base;

  return { title, searchTitle: title, year, season: null, episode: null, kind: 'movie' };
}

const TMDB_API_KEY = process.env.TMDB_API_KEY || '';
const TMDB_BASE = 'https://api.themoviedb.org/3';

// Ищет фильм/сериал на TMDB по названию. Возвращает null при отсутствии
// ключа, отсутствии совпадений или любой ошибке сети — вызывающий код
// должен просто продолжать работать с тем, что уже есть из имени файла.
async function lookupTmdb(searchTitle, year, kind) {
  if (!TMDB_API_KEY || !searchTitle) return null;
  try {
    const endpoint = kind === 'series' ? '/search/tv' : '/search/movie';
    const params = new URLSearchParams({ api_key: TMDB_API_KEY, query: searchTitle, include_adult: 'false' });
    if (year && kind !== 'series') params.set('year', String(year));
    const r = await fetch(`${TMDB_BASE}${endpoint}?${params.toString()}`);
    if (!r.ok) return null;
    const data = await r.json();
    const hit = (data.results || [])[0];
    if (!hit) return null;
    const releaseDate = hit.release_date || hit.first_air_date || '';
    return {
      title: hit.title || hit.name || searchTitle,
      year: releaseDate ? parseInt(releaseDate.slice(0, 4), 10) : (year || null),
      overview: hit.overview || '',
      posterUrl: hit.poster_path ? `https://image.tmdb.org/t/p/w500${hit.poster_path}` : null,
      backdropUrl: hit.backdrop_path ? `https://image.tmdb.org/t/p/w780${hit.backdrop_path}` : null,
      rating: typeof hit.vote_average === 'number' ? Math.round(hit.vote_average * 10) / 10 : null,
      metadataSource: 'tmdb'
    };
  } catch (e) {
    console.warn('[metadata] Запрос к TMDB не удался:', e.message);
    return null;
  }
}

module.exports = { extractMetadataFromFilename, lookupTmdb };
