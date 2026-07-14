// Минимальный service worker — нужен в основном для того, чтобы Chrome/Android
// посчитал сайт "устанавливаемым" (PWA-критерий) и предложил "Добавить на экран".
// Кэшируем только статическую оболочку. Видео, сокеты и API — всегда напрямую из сети,
// их кэшировать нельзя (список видео и состояние комнаты постоянно меняются).

const CACHE_NAME = 'watch-together-shell-v1';
const SHELL_FILES = [
  '/',
  '/manifest.json',
  '/icon-192.png',
  '/icon-512.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_FILES))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Никогда не трогаем socket.io, API и стрим видео — только сеть
  if (
    url.pathname.startsWith('/socket.io') ||
    url.pathname.startsWith('/video/') ||
    url.pathname.startsWith('/videos') ||
    url.pathname.startsWith('/upload')
  ) {
    return; // не вызываем event.respondWith — запрос уйдёт в сеть как обычно
  }

  // Для остальной статики: кэш-сначала, с фоновым обновлением
  event.respondWith(
    caches.match(event.request).then((cached) => {
      const network = fetch(event.request)
        .then((resp) => {
          if (resp && resp.status === 200) {
            const clone = resp.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
          }
          return resp;
        })
        .catch(() => cached);
      return cached || network;
    })
  );
});
