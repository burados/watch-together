// Минимальный service worker — нужен в основном для того, чтобы Chrome/Android
// посчитал сайт "устанавливаемым" (PWA-критерий) и предложил "Добавить на экран".
// Кэшируем только статическую оболочку. Видео, сокеты и API — всегда напрямую из сети,
// их кэшировать нельзя (список видео и состояние комнаты постоянно меняются).

const CACHE_NAME = 'roomly-shell-v3'; // версия увеличена, чтобы старый кэш точно сбросился после этого обновления
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

  // Саму страницу (HTML-навигацию) всегда берём из сети в первую очередь.
  // Раньше она отдавалась "кэш-сначала", из-за чего после каждого деплоя
  // люди ещё долго видели предыдущую версию сайта. Кэш теперь только
  // запасной вариант на случай, если сети совсем нет (офлайн).
  if (event.request.mode === 'navigate' || url.pathname === '/') {
    event.respondWith(
      fetch(event.request)
        .then((resp) => {
          if (resp && resp.status === 200) {
            const clone = resp.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
          }
          return resp;
        })
        .catch(() => caches.match(event.request))
    );
    return;
  }

  // Остальная статика (иконки, манифест и т.п.): кэш-сначала с фоновым
  // обновлением — тут актуальность не критична.
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

// --- Push-уведомления: приходят даже когда приложение полностью закрыто ---
// Если сейчас есть открытая и видимая вкладка приложения — не показываем
// уведомление, т.к. сообщение уже появилось в чате через сокет "вживую".
self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch (e) {}

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
      const hasFocusedClient = clients.some((c) => c.focused);
      if (hasFocusedClient) return;

      return self.registration.showNotification(data.title || 'Roomly', {
        body: data.body || '',
        icon: '/icon-192.png',
        badge: '/icon-192.png',
        tag: data.tag || 'wt-push',
        renotify: true,
        vibrate: Array.isArray(data.vibrate) ? data.vibrate : [40],
        data: { url: data.url || '/' }
      });
    })
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const targetUrl = (event.notification.data && event.notification.data.url) || '/';

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
      for (const c of clients) {
        if ('focus' in c) return c.focus();
      }
      if (self.clients.openWindow) return self.clients.openWindow(targetUrl);
    })
  );
});
