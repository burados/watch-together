let socket;
let room, name;
let avatarEmoji = '';
try { avatarEmoji = localStorage.getItem('wt_avatar') || ''; } catch (e) {}
let avatarPhoto = ''; // имя файла на сервере (uploads/avatars), не полный путь
try { avatarPhoto = localStorage.getItem('wt_avatar_photo') || ''; } catch (e) {}

// Стабильный идентификатор этого браузера/устройства, переживающий
// переподключения socket.io (обрыв интернета, сворачивание вкладки на
// телефоне и т.п.). socket.id при этом каждый раз новый, поэтому без
// clientId сервер не может отличить "человек вернулся" от "зашёл новый
// человек" — из-за этого в чате мелькало "вышел(ла)"/"присоединился(-ась)".
let clientId = '';
try {
  clientId = localStorage.getItem('wt_client_id') || '';
  if (!clientId) {
    clientId = (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`);
    localStorage.setItem('wt_client_id', clientId);
  }
} catch (e) {
  clientId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}
function avatarPhotoUrl(filename) { return filename ? '/avatars/' + filename : ''; }
let gifSearchDebounce = null;
let syncing = false; // флаг, чтобы не зациклить события play/pause/seek
let syncTargetState = null; // 'playing' | 'paused' | null — какого состояния ждём после sync-play/pause
let syncSafetyTimer = null; // защитный таймер на случай, если целевое состояние так и не наступит

// Снимает флаг syncing и чистит защитный таймер. Вызывается либо когда
// плеер реально достиг ожидаемого состояния (play/pause), либо по таймауту,
// если по какой-то причине событие state change не пришло вовсе.
function clearSyncing() {
  syncing = false;
  syncTargetState = null;
  if (syncSafetyTimer) { clearTimeout(syncSafetyTimer); syncSafetyTimer = null; }
}

// Ставит флаг syncing и запускает защитный таймаут. Раньше syncing снимался
// через фиксированные 300мс, но реальная буферизация YouTube на медленном
// интернете часто занимает дольше — флаг успевал сброситься раньше, чем
// плеер реально начинал играть, и honest PLAYING-событие от буферизации
// улетало на сервер как "новое" действие пользователя, зацикливая
// play/seek/buffering между участниками. Теперь флаг держится, пока плеер
// не придёт в ожидаемое состояние, а таймаут — лишь подстраховка.
function startSyncing(targetState) {
  syncing = true;
  syncTargetState = targetState;
  if (syncSafetyTimer) clearTimeout(syncSafetyTimer);
  syncSafetyTimer = setTimeout(clearSyncing, 8000);
}
let typingTimeout = null;
let lastTypingEmit = 0;
let remoteTypingTimeout = null;
let currentTypingUser = null;
let notificationsEnabled = localStorage.getItem('wt_notifications') === '1';
// Ручная высота видео на мобильном (см. initVideoResize ниже) — доля 0..1
// между минимальной и максимальной допустимой высотой; null = авто-расчёт
// (как было раньше, до ручного вмешательства пользователя).
let manualVideoRatio = null;
try {
  const savedRatio = localStorage.getItem('wt_video_ratio');
  if (savedRatio !== null) {
    const parsed = parseFloat(savedRatio);
    if (!Number.isNaN(parsed)) manualVideoRatio = parsed;
  }
} catch (e) {}
let roomUsers = []; // [{name, avatar, avatarPhoto}] — вкладка «Участники»
let roomAllNames = []; // все участники комнаты (включая себя) — для вкладки «Участники»
let roomMemberNames = []; // имена остальных участников комнаты, для @упоминаний
let mentionQueryStart = -1; // индекс символа '@' в поле ввода, если сейчас набирается упоминание
let audioCtx = null;

/* -----------------------------------------------------------
   PWA: регистрация service worker'а (нужно, чтобы сайт можно было
   "Добавить на экран" как отдельное приложение, особенно на Android)
   ----------------------------------------------------------- */
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch((err) => {
      console.warn('Service worker не зарегистрирован:', err.message);
    });
  });
}

/* -----------------------------------------------------------
   Viewport / keyboard handling
   ----------------------------------------------------------- */
let maxSeenHeight = 0;
let wasKeyboardOpen = false;
function setAppHeight() {
  const vv = window.visualViewport;
  const h = vv ? vv.height : window.innerHeight;
  document.documentElement.style.setProperty('--app-height', h + 'px');

  if (h > maxSeenHeight) maxSeenHeight = h;
  const keyboardOpen = maxSeenHeight - h > 120;
  document.body.classList.toggle('kb-open', keyboardOpen);

  if (keyboardOpen && !wasKeyboardOpen) scrollChatToBottom(false);
  wasKeyboardOpen = keyboardOpen;
  sizeVideoWrap(h);
}

/* Sizes the mobile video panel from real, measured element heights instead
   of a guessed vh fraction, so it's as large as possible on any device
   while always leaving the chat panel a usable minimum — the chat-section's
   own min-height (110px) is the hard floor this respects. */
function sizeVideoWrap(appH) {
  if (window.innerWidth >= 900) return; // desktop sizes the video via flex, not this var
  const roomEl = document.getElementById('room');
  if (!roomEl || getComputedStyle(roomEl).display === 'none') return;

  const kbOpen = document.body.classList.contains('kb-open');
  const topbar = document.querySelector('.room-topbar');
  const chatInputEl = document.querySelector('.chat-input');

  const topbarH = (!kbOpen && topbar) ? topbar.offsetHeight : 0;
  // Кнопка «Видео» теперь плавает поверх плеера и высоту не занимает.
  const toolbarH = 0;
  // Шапка листа чата: вкладки + «ручка» (скрыты при открытой клавиатуре)
  const tabsEl = document.querySelector('.sheet-tabs');
  const tabsH = (tabsEl && getComputedStyle(tabsEl).display !== 'none') ? tabsEl.offsetHeight + 8 : 0;
  const sheetGap = 22; // ручка + отступ карточки видео
  const navH = 0; // нижней панели больше нет

  const chatInputH = (kbOpen && chatInputEl) ? chatInputEl.offsetHeight : 64;
  // ~2 message rows worth of height (with a bit extra so a 3rd row peeks in
  // to signal the list scrolls), on top of the real input height
  const TWO_MSG_ROWS_H = 130;

  const chatFloor = (kbOpen ? (chatInputH + TWO_MSG_ROWS_H) : 150) + tabsH + sheetGap; // keeps chat comfortably usable, never crushed
  const minH = kbOpen ? 90 : 160;
  const maxH = appH * (kbOpen ? 0.62 : 0.72);

  // Если пользователь сам перетащил разделитель (см. initVideoResize), его
  // выбор — это доля между minH и maxH, а не автоматический расчёт по
  // доступному месту. Так ручной выбор остаётся осмысленным и при повороте
  // экрана, и при открытии клавиатуры — просто пересчитывается в новых
  // границах, а не сбрасывается на дефолт.
  let videoH;
  if (manualVideoRatio !== null) {
    videoH = minH + manualVideoRatio * (maxH - minH);
  } else {
    videoH = appH - topbarH - toolbarH - navH - chatFloor;
  }
  videoH = Math.max(minH, Math.min(videoH, maxH));
  document.documentElement.style.setProperty('--video-h', videoH + 'px');
}
setAppHeight();
if (window.visualViewport) {
  window.visualViewport.addEventListener('resize', setAppHeight);
  window.visualViewport.addEventListener('scroll', setAppHeight);
}
window.addEventListener('resize', setAppHeight);
if (screen.orientation && screen.orientation.lock) {
  screen.orientation.lock('portrait').catch(() => {
    // Блокировка не поддерживается вне fullscreen/PWA — это нормально,
    // основная защита обеспечивается через manifest.json (orientation: portrait)
  });
}

window.addEventListener('orientationchange', () => setTimeout(() => {
  maxSeenHeight = 0;
  setAppHeight();
}, 300));

/* Nav bar hides on real chat-input focus, not on the kb-open guess —
   this is the reliable signal for "the user is actively typing in chat". */
document.addEventListener('DOMContentLoaded', () => {
  try {
    const savedName = localStorage.getItem('wt_name');
    const nameField = document.getElementById('nameInput');
    if (savedName && nameField && !nameField.value.trim()) nameField.value = savedName;
  } catch (e) {}

  const chatInput = document.getElementById('chatInput');
  if (!chatInput) return;
  updateSendMicUI();
  chatInput.addEventListener('focus', () => {
    document.body.classList.add('chat-focused');
    requestAnimationFrame(() => sizeVideoWrap(window.visualViewport ? window.visualViewport.height : window.innerHeight));
  });
  chatInput.addEventListener('blur', () => {
    document.body.classList.remove('chat-focused');
    requestAnimationFrame(() => sizeVideoWrap(window.visualViewport ? window.visualViewport.height : window.innerHeight));
  });
});

/* -----------------------------------------------------------
   Ripple micro-interaction
   ----------------------------------------------------------- */
document.addEventListener('click', (e) => {
  if (!e.target.closest('.msg-react-picker') && !e.target.closest('.msg-react-btn')) {
    closeAllReactionPickers();
  }
});

document.addEventListener('click', (e) => {
  const host = e.target.closest('.ripple-host');
  if (!host) return;
  const rect = host.getBoundingClientRect();
  const size = Math.max(rect.width, rect.height);
  const el = document.createElement('span');
  el.className = 'ripple-el';
  el.style.width = el.style.height = size + 'px';
  el.style.left = (e.clientX - rect.left - size / 2) + 'px';
  el.style.top = (e.clientY - rect.top - size / 2) + 'px';
  host.appendChild(el);
  setTimeout(() => el.remove(), 550);
});

/* -----------------------------------------------------------
   Toast
   ----------------------------------------------------------- */
let toastTimer = null;
function showToast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2200);
}

/* -----------------------------------------------------------
   Recent rooms (localStorage)
   ----------------------------------------------------------- */
function getRecentRooms() {
  try { return JSON.parse(localStorage.getItem('wt_recent_rooms') || '[]'); }
  catch (e) { return []; }
}
function saveRecentRoom(roomId, userName) {
  let list = getRecentRooms().filter(r => r.room !== roomId);
  list.unshift({ room: roomId, name: userName, ts: Date.now() });
  list = list.slice(0, 5);
  try { localStorage.setItem('wt_recent_rooms', JSON.stringify(list)); } catch (e) {}
}
function renderRecentRooms() {
  const list = getRecentRooms();
  const wrap = document.getElementById('recentWrap');
  const grid = document.getElementById('recentGrid');
  if (!list.length) { wrap.style.display = 'none'; return; }
  wrap.style.display = 'block';
  grid.innerHTML = '';
  list.forEach(r => {
    const btn = document.createElement('button');
    btn.className = 'recent-card ripple-host';
    btn.onclick = () => {
      document.getElementById('roomInput').value = r.room;
      if (!document.getElementById('nameInput').value.trim()) {
        document.getElementById('nameInput').value = r.name || '';
      }
      enterRoom();
    };
    const when = timeAgo(r.ts);
    btn.innerHTML =
      '<div class="recent-avatar" style="background:' + avatarColor(r.room) + '">' + initials(r.room) + '</div>' +
      '<div class="recent-info">' +
        '<div class="recent-name">' + escapeHtml(r.room) + '</div>' +
        '<div class="recent-meta">' + when + '</div>' +
      '</div>' +
      '<div class="recent-arrow"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 18l6-6-6-6"/></svg></div>';
    grid.appendChild(btn);
  });
}
function timeAgo(ts) {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return 'только что';
  if (s < 3600) return Math.floor(s / 60) + ' мин назад';
  if (s < 86400) return Math.floor(s / 3600) + ' ч назад';
  return Math.floor(s / 86400) + ' дн назад';
}
function escapeHtml(str) {
  const d = document.createElement('div');
  d.textContent = str;
  return d.innerHTML;
}
renderRecentRooms();

(function prefillRoomFromLink() {
  try {
    const params = new URLSearchParams(location.search);
    const r = params.get('room');
    if (r) document.getElementById('roomInput').value = r;
  } catch (e) {}
  updateGateJoinState();
})();

function updateGateJoinState() {
  const btn = document.getElementById('joinRoomBtn');
  if (!btn) return;
  btn.disabled = !document.getElementById('roomInput').value.trim();
}

/* -----------------------------------------------------------
   Home actions
   ----------------------------------------------------------- */
function generateRoomCode() {
  const words = ['movie', 'friday', 'popcorn', 'cozy', 'night', 'sofa', 'rerun', 'replay', 'lounge', 'reel'];
  const a = words[Math.floor(Math.random() * words.length)];
  const b = words[Math.floor(Math.random() * words.length)];
  const n = Math.floor(Math.random() * 900 + 100);
  return a + '-' + b + '-' + n;
}
function createRoom(e) {
  if (e) e.preventDefault();
  const roomField = document.getElementById('roomInput');
  const customField = document.getElementById('customRoomInput');
  const custom = customField ? customField.value.trim() : '';
  if (custom) {
    roomField.value = custom;
  } else if (!roomField.value.trim()) {
    roomField.value = generateRoomCode();
  }
  enterRoom();
}
function toggleCustomCode() {
  const field = document.getElementById('customCodeField');
  const btn = document.getElementById('customCodeToggle');
  const opening = field.style.display === 'none';
  field.style.display = opening ? 'block' : 'none';
  btn.classList.toggle('open', opening);
  if (opening) document.getElementById('customRoomInput').focus();
  else document.getElementById('customRoomInput').value = '';
}
function joinRoom(e) {
  if (e) e.preventDefault();
  enterRoom();
}

function enterRoom() {
  if (socket) return; // already joined/joining a room - ignore duplicate calls (e.g. a rapid double-tap)
  name = document.getElementById('nameInput').value.trim() || 'Гость';
  room = document.getElementById('roomInput').value.trim();
  if (!room) { showToast('Введите код комнаты'); return; }

  try { localStorage.setItem('wt_name', name); } catch (e) {}

  document.getElementById('gate').style.display = 'none';
  document.getElementById('room').style.display = 'block';
  document.body.classList.add('in-room');
  document.getElementById('roomBadge').textContent = 'комната: ' + room;
  document.getElementById('settingsRoomCode').textContent = room;
  document.getElementById('profileRoomCode').textContent = room;
  requestAnimationFrame(() => sizeVideoWrap(window.visualViewport ? window.visualViewport.height : window.innerHeight));

  renderAvatarEl(document.getElementById('profileAvatar'), name, avatarEmoji, avatarPhotoUrl(avatarPhoto));
  document.getElementById('profileNameInput').value = name;

  saveRecentRoom(room, name);
  updateThemeButtons();
  updateNotifButton();

  setTimeout(() => {
    const skel = document.getElementById('roomSkeleton');
    if (skel) skel.classList.add('hide');
  }, 6000);

  socket = io();
  setupSocket();
  loadVideoList();
}

/* -----------------------------------------------------------
   Socket wiring
   ----------------------------------------------------------- */
function setupSocket() {
  const player = document.getElementById('player');

  // Fires on the initial connect AND on every automatic reconnect
  // (network drop, phone backgrounded, server restart, etc.) — this is
  // what used to be missing, so a dropped connection silently stopped
  // receiving chat/sync until the user manually re-entered the room.
  let hasConnectedBefore = false;
  socket.on('connect', () => {
    connectionState = 'CONNECTED';
    setSyncPill('connected', hasConnectedBefore ? 'Синхронизация…' : 'Подключено');
    socket.emit('join-room', { room, name, avatar: avatarEmoji, avatarPhoto, clientId });
    loadVideoList();
    if (hasConnectedBefore) showToast('Соединение восстановлено');
    hasConnectedBefore = true;
    if (notificationsEnabled && 'Notification' in window && Notification.permission === 'granted') {
      subscribeToPush();
    }
  });

  socket.on('disconnect', () => {
    connectionState = 'DISCONNECTED';
    setSyncPill('disconnected', 'Нет связи');
    showToast('Соединение потеряно, переподключение…');
  });

  socket.io.on('reconnect_attempt', () => {
    connectionState = 'RECONNECTING';
    setSyncPill('reconnecting', 'Реконнект…');
  });

  // Сообщения чата, которые пришли до открытия комнаты (см. chatHistory в
  // room-state) — рисуем их только один раз за загрузку страницы. При
  // обычном переподключении (без перезагрузки страницы) сообщения уже
  // на экране, и повторный room-state не должен их дублировать.
  let chatHistoryLoaded = false;

  socket.on('room-state', (state) => {
    const skel = document.getElementById('roomSkeleton');
    if (skel) skel.classList.add('hide');
    if (!chatHistoryLoaded) {
      chatHistoryLoaded = true;
      if (Array.isArray(state.chatHistory) && state.chatHistory.length) {
        state.chatHistory.forEach((m) => addChatMessage(m, true));
        const box = document.getElementById('chatMessages');
        if (box) box.scrollTop = box.scrollHeight;
      }
    }
    if (state.video) {
      showVideo(state.video, false);
      player.currentTime = state.currentTime || 0;
    } else if (state.externalVideo) {
      showExternalVideo(state.externalVideo, null, false);
      player.currentTime = state.currentTime || 0;
    } else if (state.youtubeVideo) {
      showYoutubeVideo(state.youtubeVideo, null, false);
      // время выставится в onReady чуть ниже через отдельный сет — YT-плеер
      // ещё не готов синхронно в этот момент, поэтому ждём его инициализации
      const seekWhenReady = setInterval(() => {
        if (ytPlayerInstance && typeof ytPlayerInstance.seekTo === 'function') {
          clearInterval(seekWhenReady);
          try {
            ytPlayerInstance.seekTo(state.currentTime || 0, true);
            if (state.playing) ytPlayerInstance.playVideo(); else ytPlayerInstance.pauseVideo();
          } catch (e) {}
        }
      }, 300);
    } else if (state.streamLink) {
      showStreamLink(state.streamLink, null, false);
    }
    // room-state — это полный авторитетный снимок на момент входа/переподключения,
    // а не инкрементальное обновление, поэтому применяем его безусловно, в обход
    // проверки версии в updateAuthoritativePlayback: та проверка защищает от
    // "устаревших" play/pause/seek не по порядку внутри ОДНОЙ комнаты, но её
    // счётчик версий стартует заново в каждой новой комнате — без явного сброса
    // здесь после выхода из одной комнаты и входа в другую (где номер версии
    // на сервере снова маленький) старое большое значение стало бы блокировать
    // применение свежего состояния до тех пор, пока версия не "догонит" его.
    lastAuthoritativePlayback = {
      time: state.currentTime || 0,
      playing: !!state.playing,
      updatedAt: state.playbackUpdatedAt || Date.now(),
      stateVersion: state.stateVersion || 0
    };
    renderMediaCard(state.media);
  });


  socket.on('video-selected', ({ filename, media }) => {
    showVideo(filename, false);
    renderMediaCard(media);
  });

  socket.on('media-updated', (media) => {
    renderMediaCard(media);
  });

  socket.on('external-video-selected', ({ url, from }) => {
    showExternalVideo(url, from, false);
    clearMediaCard();
  });

  socket.on('youtube-video-selected', ({ url, from }) => {
    showYoutubeVideo(url, from, false);
    clearMediaCard();
  });

  socket.on('stream-link-updated', ({ url, from }) => {
    showStreamLink(url, from, false);
    clearMediaCard();
  });

  // Эти три события общие для видео-файла и YouTube — сервер не знает и
  // не должен знать, какой именно плеер сейчас активен на клиенте, он
  // просто транслирует time/playing всем остальным.
  socket.on('sync-play', ({ time, stateVersion, updatedAt }) => {
    startSyncing('playing');
    updateAuthoritativePlayback(time, true, updatedAt, stateVersion);
    if (currentYoutubeVideo && ytPlayerInstance) {
      ytPlayerInstance.seekTo(time, true);
      ytPlayerInstance.playVideo();
      // Подстраховка: если даже приглушённый автозапуск почему-то не
      // сработал (очень редкий случай), не оставляем спиннер загрузки
      // висеть вечно — снимаем его через пару секунд в любом случае.
      setTimeout(() => document.getElementById('videoLoading').classList.remove('show'), 2500);
    } else {
      player.currentTime = time;
      player.play().catch(() => {});
      // У обычного <video> нет промежуточного BUFFERING-события со своим
      // обработчиком ниже, поэтому здесь по-прежнему снимаем флаг сами.
      setTimeout(clearSyncing, 300);
    }
  });

  socket.on('sync-pause', ({ time, stateVersion, updatedAt }) => {
    startSyncing('paused');
    updateAuthoritativePlayback(time, false, updatedAt, stateVersion);
    if (currentYoutubeVideo && ytPlayerInstance) {
      ytPlayerInstance.seekTo(time, true);
      ytPlayerInstance.pauseVideo();
    } else {
      player.currentTime = time;
      player.pause();
      setTimeout(clearSyncing, 300);
    }
  });

  socket.on('sync-seek', ({ time, stateVersion, updatedAt }) => {
    startSyncing(null); // после перемотки не ждём конкретного play/pause состояния
    updateAuthoritativePlayback(time, lastAuthoritativePlayback.playing, updatedAt, stateVersion);
    if (currentYoutubeVideo && ytPlayerInstance) {
      ytPlayerInstance.seekTo(time, true);
    } else {
      player.currentTime = time;
    }
    setTimeout(clearSyncing, 1500);
  });

  socket.on('chat-message', (msg) => {
    addChatMessage(msg);
    if (!msg.system && msg.name !== name) notifyIncomingMessage(msg);
  });

  socket.on('message-reaction-update', ({ messageId, reactions }) => {
    updateMessageReactions(messageId, reactions);
  });

  socket.on('user-count', (count) => {
    // В шапке — только число (экономит место на узких экранах), полная подпись — в title
    const mod10 = count % 10, mod100 = count % 100;
    const word = (mod10 === 1 && mod100 !== 11) ? 'зритель'
      : (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) ? 'зрителя' : 'зрителей';
    document.getElementById('userCount').textContent = String(count);
    const pillEl = document.getElementById('viewerPillBtn');
    if (pillEl) { pillEl.title = count + ' ' + word; pillEl.setAttribute('aria-label', count + ' ' + word); }
    document.getElementById('settingsViewers').textContent = count;
    document.getElementById('profileViewers').textContent = count;
  });

  socket.on('room-users', ({ names, users }) => {
    roomAllNames = names || [];
    roomUsers = Array.isArray(users) ? users : [];
    roomMemberNames = roomAllNames.filter((n) => n !== name);
    renderMembers();
  });

  socket.on('user-typing', ({ name: who }) => {
    if (who === name) return;
    showTyping(who);
  });
  socket.on('user-stop-typing', () => {
    hideTyping();
  });
}

/* -----------------------------------------------------------
   Video
   ----------------------------------------------------------- */
let currentStreamLink = null;
let currentExternalVideo = null;
let currentYoutubeVideo = null;
let hlsInstance = null;

let ytApiReady = false;
let ytApiLoading = false;
let ytPlayerInstance = null;
let ytPendingVideoId = null; // если запросили загрузку видео до готовности API

// Прямая ссылка на файл (.mp4 и т.п.) или на HLS-плейлист (.m3u8) можно
// загрузить прямо в наш <video> — тогда play/pause/перемотка синхронизируются
// у всех по-настоящему. YouTube — отдельный случай: через официальный
// YouTube IFrame Player API можно программно управлять чужим плеером
// (play/pause/seek), поэтому синхронизация тоже настоящая — см. showYoutubeVideo().
// Ссылка на страницу произвольного сайта (Twitch и т.п.) так не грузится —
// её можно только встроить как iframe, без синхронизации.
function extractYoutubeId(url) {
  const patterns = [
    /(?:youtube\.com\/watch\?(?:.*&)?v=)([\w-]{11})/,
    /(?:youtu\.be\/)([\w-]{11})/,
    /(?:youtube\.com\/shorts\/)([\w-]{11})/,
    /(?:youtube\.com\/embed\/)([\w-]{11})/,
    /(?:youtube\.com\/live\/)([\w-]{11})/
  ];
  for (const re of patterns) {
    const m = url.match(re);
    if (m) return m[1];
  }
  return null;
}

function detectVideoUrlType(url) {
  const clean = url.split('#')[0];
  if (extractYoutubeId(clean)) return 'youtube';
  const noQuery = clean.split('?')[0];
  if (/\.m3u8$/i.test(noQuery)) return 'hls';
  if (/\.(mp4|webm|ogv|ogg|mov|m4v)$/i.test(noQuery)) return 'direct';
  return 'embed';
}

function promptStreamLink() {
  const input = document.getElementById('linkModalInput');
  input.value = currentYoutubeVideo || currentExternalVideo || currentStreamLink || '';
  document.getElementById('linkModalHint').textContent = '';
  input.classList.remove('link-modal-error');
  document.getElementById('linkModalBackdrop').classList.add('show');
  setTimeout(() => { input.focus(); input.select(); }, 60);
}

function closeVideoLinkModal() {
  document.getElementById('linkModalBackdrop').classList.remove('show');
}

function submitVideoLink() {
  const input = document.getElementById('linkModalInput');
  const hint = document.getElementById('linkModalHint');
  const trimmed = input.value.trim();

  if (!trimmed) { closeVideoLinkModal(); return; }
  if (!/^https?:\/\//i.test(trimmed)) {
    hint.textContent = 'Ссылка должна начинаться с http:// или https://';
    input.classList.add('link-modal-error');
    input.focus();
    return;
  }

  const type = detectVideoUrlType(trimmed);
  if (type === 'youtube') {
    socket.emit('set-youtube-video', { room, url: trimmed });
  } else if (type === 'embed') {
    socket.emit('set-stream-link', { room, url: trimmed });
  } else {
    socket.emit('set-external-video', { room, url: trimmed });
  }
  closeVideoLinkModal();
}

function showStreamLink(url, from, notify) {
  currentStreamLink = url;
  currentExternalVideo = null;
  currentYoutubeVideo = null;
  hideYoutubeFrame();
  destroyHlsInstance();
  const player = document.getElementById('player');
  player.pause();
  player.removeAttribute('src');
  player.style.display = 'none';
  document.getElementById('videoLoading').classList.remove('show');
  document.getElementById('noVideo').style.display = 'none';

  // Карточка-приглашение больше не нужна как единственный вариант — сразу пробуем встроить трансляцию в iframe
  document.getElementById('streamLinkCard').style.display = 'none';

  const frame = document.getElementById('streamFrame');
  frame.src = url;
  frame.style.display = 'block';

  const bar = document.getElementById('streamFrameBar');
  bar.style.display = 'flex';
  document.getElementById('streamFrameFrom').textContent = from ? ('Добавил(а): ' + from) : '';
  document.getElementById('streamFramePeek').classList.remove('show');
  autoCollapseFrameBar('stream', hideStreamFrameBar);

  document.getElementById('expandBtn').style.display = 'flex';

  if (notify) socket.emit('set-stream-link', { room, url });
}

function openStreamLink() {
  // Запасной вариант: если сайт трансляции запрещает встраивание в iframe
  // (заголовки X-Frame-Options / Content-Security-Policy: frame-ancestors),
  // страница внутри iframe останется пустой/белой — тогда жмём эту кнопку.
  if (currentStreamLink) window.open(currentStreamLink, '_blank', 'noopener');
}

function toggleFullscreen() {
  const wrap = document.getElementById('videoWrap');
  const requestFn = wrap.requestFullscreen || wrap.webkitRequestFullscreen;

  // На iPhone/iPad Safari метод requestFullscreen() для произвольного div/iframe
  // либо отсутствует, либо есть, но по факту ничего не делает (там fullscreen
  // поддерживается нативно только для <video>). Поэтому не доверяем одному
  // только наличию метода — подстраховываемся таймером ниже.
  if (typeof requestFn !== 'function') {
    toggleFakeFullscreen();
    return;
  }

  if (!document.fullscreenElement && !wrap.classList.contains('fake-fullscreen')) {
    const result = requestFn.call(wrap);
    if (result && typeof result.catch === 'function') result.catch(() => toggleFakeFullscreen());
    setTimeout(() => {
      if (!document.fullscreenElement && !wrap.classList.contains('fake-fullscreen')) toggleFakeFullscreen();
    }, 400);
  } else if (document.fullscreenElement) {
    (document.exitFullscreen || document.webkitExitFullscreen)?.call(document);
  } else {
    exitFakeFullscreen();
  }
}

function updateExpandButton(isFull) {
  const btn = document.getElementById('expandBtn');
  const collapseIcon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 3v4a2 2 0 01-2 2H3m18 0h-4a2 2 0 01-2-2V3M3 15h4a2 2 0 012 2v4m6-6h4a2 2 0 002-2v4"/></svg>';
  const expandIcon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M8 3H5a2 2 0 00-2 2v3m18 0V5a2 2 0 00-2-2h-3m0 18h3a2 2 0 002-2v-3M3 16v3a2 2 0 002 2h3"/></svg>';
  btn.innerHTML = isFull ? collapseIcon : expandIcon;
  btn.title = isFull ? 'Свернуть видео' : 'Развернуть видео';
}

function setStreamBarHiddenForFullscreen(hide) {
  const bar = document.getElementById('streamFrameBar');
  if (hide) {
    bar.dataset.wasVisible = bar.style.display === 'flex' ? '1' : '0';
    bar.style.display = 'none';
  } else if (bar.dataset.wasVisible === '1') {
    bar.style.display = 'flex';
  }
}

function toggleFakeFullscreen() {
  const wrap = document.getElementById('videoWrap');
  const active = wrap.classList.toggle('fake-fullscreen');
  document.body.classList.toggle('video-fake-fullscreen', active);
  updateExpandButton(active);
  setStreamBarHiddenForFullscreen(active);
}

function exitFakeFullscreen() {
  const wrap = document.getElementById('videoWrap');
  if (!wrap.classList.contains('fake-fullscreen')) return;
  wrap.classList.remove('fake-fullscreen');
  document.body.classList.remove('video-fake-fullscreen');
  updateExpandButton(false);
  setStreamBarHiddenForFullscreen(false);
}

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') exitFakeFullscreen();
  if (e.key === 'Escape' && document.getElementById('linkModalBackdrop').classList.contains('show')) closeVideoLinkModal();
});

document.addEventListener('fullscreenchange', () => {
  updateExpandButton(!!document.fullscreenElement);
  setStreamBarHiddenForFullscreen(!!document.fullscreenElement);
});

// Панель над плеером («Открыть на YouTube» / «в новой вкладке») сама
// сворачивается в маленькую кнопку через несколько секунд, чтобы не
// закрывать картинку. Нажатие на кнопку возвращает панель.
let frameBarTimers = {};
function autoCollapseFrameBar(key, collapseFn, ms) {
  clearTimeout(frameBarTimers[key]);
  frameBarTimers[key] = setTimeout(collapseFn, ms || 5000);
}
function cancelFrameBarTimer(key) {
  clearTimeout(frameBarTimers[key]);
}

function hideStreamFrameBar() {
  cancelFrameBarTimer('stream');
  document.getElementById('streamFrameBar').style.display = 'none';
  document.getElementById('streamFramePeek').classList.add('show');
}

function showStreamFrameBar() {
  document.getElementById('streamFrameBar').style.display = 'flex';
  document.getElementById('streamFramePeek').classList.remove('show');
  autoCollapseFrameBar('stream', hideStreamFrameBar);
}

function hideStreamFrame() {
  cancelFrameBarTimer('stream');
  const frame = document.getElementById('streamFrame');
  frame.src = 'about:blank';
  frame.style.display = 'none';
  document.getElementById('streamFrameBar').style.display = 'none';
  document.getElementById('streamFramePeek').classList.remove('show');
}

function destroyHlsInstance() {
  if (hlsInstance) {
    hlsInstance.destroy();
    hlsInstance = null;
  }
}

/* -----------------------------------------------------------
   YouTube через официальный IFrame Player API — в отличие от
   streamFrame (голый iframe без контроля), тут можно программно
   play/pause/seek и слушать события плеера, поэтому синхронизация
   между зрителями настоящая, а не просто "у каждого свой плеер".
   ----------------------------------------------------------- */
function loadYoutubeApi(onReady) {
  if (ytApiReady) { onReady(); return; }
  if (!window.__ytReadyCallbacks) window.__ytReadyCallbacks = [];
  window.__ytReadyCallbacks.push(onReady);
  if (ytApiLoading) return;
  ytApiLoading = true;

  window.onYouTubeIframeAPIReady = () => {
    ytApiReady = true;
    window.__ytReadyCallbacks.forEach((cb) => cb());
    window.__ytReadyCallbacks = [];
  };

  const tag = document.createElement('script');
  tag.src = 'https://www.youtube.com/iframe_api';
  document.head.appendChild(tag);
}

function hideYoutubeFrame() {
  cancelFrameBarTimer('yt');
  document.getElementById('ytPlayer').style.display = 'none';
  document.getElementById('ytFrameBar').style.display = 'none';
  document.getElementById('ytFramePeek').classList.remove('show');
  document.getElementById('ytUnmuteBtn').classList.remove('show');
  if (ytPlayerInstance) {
    try { ytPlayerInstance.stopVideo(); } catch (e) {}
  }
}

function hideYtFrameBar() {
  cancelFrameBarTimer('yt');
  document.getElementById('ytFrameBar').style.display = 'none';
  document.getElementById('ytFramePeek').classList.add('show');
}

function showYtFrameBar() {
  document.getElementById('ytFrameBar').style.display = 'flex';
  document.getElementById('ytFramePeek').classList.remove('show');
  autoCollapseFrameBar('yt', hideYtFrameBar);
}

function openYoutubeLink() {
  if (currentYoutubeVideo) window.open(currentYoutubeVideo, '_blank', 'noopener');
}

// Плеер всегда стартует без звука (см. showYoutubeVideo) — иначе браузер
// на устройствах других зрителей молча блокирует автозапуск со звуком,
// когда play/pause/перемотка приходит по синхронизации, а не от прямого
// тапа человека. Каждый зритель включает звук у себя сам, одним тапом —
// это уже собственный жест пользователя, браузер его не блокирует.
function unmuteYoutube() {
  if (!ytPlayerInstance) return;
  try { ytPlayerInstance.unMute(); } catch (e) {}
  document.getElementById('ytUnmuteBtn').classList.remove('show');
}

function showYoutubeVideo(url, from, notify) {
  const videoId = extractYoutubeId(url);
  if (!videoId) { showToast('Не удалось распознать ссылку на YouTube'); return; }

  currentStreamLink = null;
  currentExternalVideo = null;
  currentYoutubeVideo = url;
  destroyHlsInstance();
  document.getElementById('streamLinkCard').style.display = 'none';
  hideStreamFrame();

  const video = document.getElementById('player');
  video.pause();
  video.removeAttribute('src');
  video.style.display = 'none';

  document.getElementById('noVideo').style.display = 'none';
  document.getElementById('videoLoading').classList.remove('show');

  const container = document.getElementById('ytPlayer');
  container.style.display = 'block';

  const bar = document.getElementById('ytFrameBar');
  bar.style.display = 'flex';
  document.getElementById('ytFrameFrom').textContent = from ? ('Добавил(а): ' + from) : '';
  document.getElementById('ytFramePeek').classList.remove('show');
  autoCollapseFrameBar('yt', hideYtFrameBar);

  document.getElementById('expandBtn').style.display = 'flex';

  const loading = document.getElementById('videoLoading');

  loadYoutubeApi(() => {
    if (ytPlayerInstance) {
      ytPlayerInstance.mute();
      document.getElementById('ytUnmuteBtn').classList.add('show');
      ytPlayerInstance.loadVideoById(videoId);
      return;
    }
    loading.classList.add('show');
    ytPlayerInstance = new YT.Player('ytPlayer', {
      videoId,
      playerVars: {
        playsinline: 1,
        rel: 0,        // не показывать чужие рекомендованные видео по окончании — разрешено правилами API
        modestbranding: 1
      },
      events: {
        onReady: () => {
          loading.classList.remove('show');
          // Стартуем без звука: у зрителей (не у того, кто нажал play)
          // play/pause/seek приходят программно через синхронизацию, а не
          // от прямого тапа — с включённым звуком браузер такой автозапуск
          // молча блокирует, и видео зависает на превью+"Загрузка".
          // Приглушённый автозапуск браузеры разрешают всегда.
          try { ytPlayerInstance.mute(); } catch (e) {}
          document.getElementById('ytUnmuteBtn').classList.add('show');
          if ('mediaSession' in navigator) {
            navigator.mediaSession.metadata = new MediaMetadata({
              title: 'Смотрим вместе',
              artist: room ? `Комната ${room}` : 'Roomly',
              artwork: [
                { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
                { src: '/icon-512.png', sizes: '512x512', type: 'image/png' }
              ]
            });
            navigator.mediaSession.setActionHandler('play', () => ytPlayerInstance.playVideo());
            navigator.mediaSession.setActionHandler('pause', () => ytPlayerInstance.pauseVideo());
            navigator.mediaSession.setActionHandler('seekbackward', () => ytPlayerInstance.seekTo(Math.max(0, ytPlayerInstance.getCurrentTime() - 10), true));
            navigator.mediaSession.setActionHandler('seekforward', () => ytPlayerInstance.seekTo(ytPlayerInstance.getCurrentTime() + 10, true));
          }
        },
        onStateChange: (e) => {
          if (e.data === YT.PlayerState.BUFFERING) {
            // Буферизация не эхо-событие само по себе (никуда не шлётся) —
            // просто показываем спиннер, флаг syncing не трогаем.
            loading.classList.add('show');
            return;
          }
          if (syncing) {
            // Мы ждём, пока плеер реально придёт в состояние, которое
            // запросила синхронизация (play/pause). Буферизация после
            // seekTo может занять сколько угодно — раньше флаг снимался
            // по фиксированному таймеру и "настоящее" PLAYING-событие после
            // долгой буферизации улетало на сервер как новое действие
            // пользователя, зацикливая play/seek между участниками.
            if (
              (e.data === YT.PlayerState.PLAYING && syncTargetState === 'playing') ||
              (e.data === YT.PlayerState.PAUSED && syncTargetState === 'paused')
            ) {
              clearSyncing();
              if (e.data === YT.PlayerState.PLAYING) loading.classList.remove('show');
            }
            return;
          }
          const time = ytPlayerInstance.getCurrentTime();
          if (e.data === YT.PlayerState.PLAYING) {
            loading.classList.remove('show');
            socket.emit('play', { room, time });
            if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'playing';
            requestWakeLock();
          } else if (e.data === YT.PlayerState.PAUSED) {
            if (backgroundedRecently && document.visibilityState !== 'visible') {
              // Как и для обычного видео — не считаем это настоящей паузой,
              // пробуем продолжить воспроизведение и ничего не рассылаем.
              try { ytPlayerInstance.playVideo(); } catch (e) {}
              return;
            }
            socket.emit('pause', { room, time });
            if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'paused';
            releaseWakeLock();
          }
          // Отдельного события для "перемотки" в YT API нет — приблизительно
          // ловим её через большой скачок времени между play-событиями, для
          // точности хватает того, что при паузе/старте мы всегда шлём time.
        }
      }
    });
  });

  if (notify) socket.emit('set-youtube-video', { room, url });
}

// Общая проводка событий плеера (лоадер, соотношение сторон, синхронизация
// play/pause/перемотки) — одна и та же что для своих загруженных видео,
// что для видео по прямой внешней ссылке.
/* -----------------------------------------------------------
   Фоновое воспроизведение: Media Session (кнопки на экране блокировки
   и разрешение системе не "убивать" звук в фоне) + Wake Lock (экран не
   гаснет во время просмотра) + ручной Picture-in-Picture.
   ----------------------------------------------------------- */
let wakeLock = null;

async function requestWakeLock() {
  if (!('wakeLock' in navigator)) return;
  try {
    wakeLock = await navigator.wakeLock.request('screen');
    wakeLock.addEventListener('release', () => { wakeLock = null; });
  } catch (e) { /* например, вкладка не видна — это ожидаемо, не критично */ }
}

function releaseWakeLock() {
  if (wakeLock) { wakeLock.release().catch(() => {}); wakeLock = null; }
}

// Флаг "приложение только что было свёрнуто". Пока он включён, паузу,
// которую вызвал сам браузер/ОС при сворачивании (а не нажатие пользователя),
// не рассылаем остальным зрителям и пытаемся сразу возобновить воспроизведение —
// см. player.onpause и обработчик YT.PlayerState.PAUSED ниже.
let backgroundedRecently = false;

document.addEventListener('visibilitychange', () => {
  document.documentElement.classList.toggle('page-hidden', document.visibilityState === 'hidden');
  const player = document.getElementById('player');
  if (document.visibilityState === 'hidden') {
    backgroundedRecently = true;
    // Пытаемся не дать видео остановиться при сворачивании: если это
    // обычный <video> и он сейчас играет — уходим в Picture-in-Picture,
    // это единственный надёжный способ продолжить показ в фоне.
    if (player && player.style.display !== 'none' && !player.paused &&
        document.pictureInPictureEnabled && player.requestPictureInPicture &&
        !document.pictureInPictureElement) {
      player.requestPictureInPicture().catch(() => {});
    }
  } else if (document.visibilityState === 'visible') {
    if (player && !player.paused && !wakeLock) requestWakeLock();
    // Небольшая задержка перед сбросом флага — автопауза браузера при
    // сворачивании иногда приходит с опозданием, уже после возврата в приложение.
    setTimeout(() => { backgroundedRecently = false; }, 1500);
  }
});

function setupMediaSession(player) {
  if (!('mediaSession' in navigator)) return;
  navigator.mediaSession.metadata = new MediaMetadata({
    title: 'Смотрим вместе',
    artist: room ? `Комната ${room}` : 'Roomly',
    artwork: [
      { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
      { src: '/icon-512.png', sizes: '512x512', type: 'image/png' }
    ]
  });
  navigator.mediaSession.setActionHandler('play', () => player.play());
  navigator.mediaSession.setActionHandler('pause', () => player.pause());
  navigator.mediaSession.setActionHandler('seekbackward', () => { player.currentTime = Math.max(0, player.currentTime - 10); });
  navigator.mediaSession.setActionHandler('seekforward', () => { player.currentTime = Math.min(player.duration || 1e9, player.currentTime + 10); });
}

function togglePip() {
  const player = document.getElementById('player');
  if (document.pictureInPictureElement) {
    document.exitPictureInPicture().catch(() => {});
    return;
  }
  if (document.pictureInPictureEnabled && player.requestPictureInPicture) {
    player.requestPictureInPicture().catch((e) => showToast('Picture-in-Picture недоступен: ' + e.message));
  } else {
    showToast('Picture-in-Picture не поддерживается в этом браузере');
  }
}

function wirePlayerCommon(player) {
  document.getElementById('expandBtn').style.display = 'flex';
  const pipBtn = document.getElementById('pipBtn');
  if (pipBtn) pipBtn.style.display = ('pictureInPictureEnabled' in document && document.pictureInPictureEnabled) ? 'flex' : 'none';

  // reset to a sane default until we know the real dimensions, then match
  // the video-wrap's aspect ratio to the actual video so object-fit:contain
  // has nothing left to letterbox
  document.documentElement.style.setProperty('--video-ar', '16/9');
  player.onloadedmetadata = () => {
    if (player.videoWidth && player.videoHeight) {
      document.documentElement.style.setProperty('--video-ar', player.videoWidth + '/' + player.videoHeight);
    }
  };

  const loading = document.getElementById('videoLoading');
  player.onloadstart = () => loading.classList.add('show');
  player.onwaiting = () => loading.classList.add('show');
  player.oncanplay = () => loading.classList.remove('show');
  player.onplaying = () => loading.classList.remove('show');

  player.onplay = () => {
    if (!syncing) socket.emit('play', { room, time: player.currentTime });
    if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'playing';
    requestWakeLock();
  };
  player.onpause = () => {
    if (backgroundedRecently && document.visibilityState !== 'visible') {
      // Пауза вызвана сворачиванием приложения, а не пользователем —
      // не шлём её остальным зрителям, пробуем продолжить воспроизведение.
      player.play().catch(() => {});
      return;
    }
    if (!syncing) socket.emit('pause', { room, time: player.currentTime });
    if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'paused';
    releaseWakeLock();
  };
  player.onseeked = () => { if (!syncing) socket.emit('seek', { room, time: player.currentTime }); };

  setupMediaSession(player);
}

function showVideo(filename, notify) {
  currentStreamLink = null;
  currentExternalVideo = null;
  currentYoutubeVideo = null;
  hideYoutubeFrame();
  destroyHlsInstance();
  document.getElementById('streamLinkCard').style.display = 'none';
  hideStreamFrame();
  const player = document.getElementById('player');
  document.getElementById('noVideo').style.display = 'none';
  player.style.display = 'block';
  player.src = '/video/' + filename;

  wirePlayerCommon(player);

  if (notify) socket.emit('select-video', { room, filename });
}

// Видео по прямой ссылке на файл (.mp4/.webm) или HLS-плейлист (.m3u8) с
// внешнего сервера — грузим прямо в свой <video>, поэтому play/pause/
// перемотка синхронизируются между всеми зрителями по-настоящему, как и
// с обычным загруженным файлом.
function showExternalVideo(url, from, notify) {
  currentStreamLink = null;
  currentExternalVideo = url;
  currentYoutubeVideo = null;
  hideYoutubeFrame();
  destroyHlsInstance();
  document.getElementById('streamLinkCard').style.display = 'none';
  hideStreamFrame();

  const player = document.getElementById('player');
  document.getElementById('noVideo').style.display = 'none';
  player.style.display = 'block';

  const type = detectVideoUrlType(url);
  if (type === 'hls' && !player.canPlayType('application/vnd.apple.mpegurl') && window.Hls && Hls.isSupported()) {
    hlsInstance = new Hls();
    hlsInstance.loadSource(url);
    hlsInstance.attachMedia(player);
    hlsInstance.on(Hls.Events.ERROR, (event, data) => {
      if (data.fatal) {
        console.error('Ошибка HLS-потока:', data);
        showToast('Не удалось загрузить видео по этой ссылке');
      }
    });
  } else {
    // Safari умеет .m3u8 нативно; обычные .mp4/.webm тоже просто через src
    player.src = url;
  }

  wirePlayerCommon(player);

  if (notify) socket.emit('set-external-video', { room, url });
}

async function handleUpload(event) {
  const file = event.target.files[0];
  if (!file) return;

  const formData = new FormData();
  formData.append('video', file);

  const progress = document.getElementById('uploadProgress');
  progress.textContent = 'Загрузка 0%';

  const xhr = new XMLHttpRequest();
  xhr.open('POST', '/upload');
  xhr.upload.onprogress = (e) => {
    if (e.lengthComputable) {
      const pct = Math.round((e.loaded / e.total) * 100);
      progress.textContent = 'Загрузка ' + pct + '%';
    }
  };
  xhr.onload = () => {
    if (xhr.status < 200 || xhr.status >= 300) {
      progress.textContent = 'Ошибка сервера: код ' + xhr.status;
      console.error('Upload failed, status:', xhr.status, 'body:', xhr.responseText);
      return;
    }
    let res;
    try {
      res = JSON.parse(xhr.responseText);
    } catch (e) {
      progress.textContent = 'Сервер вернул не JSON (см. консоль)';
      console.error('Bad response body:', xhr.responseText);
      return;
    }
    if (!res.filename) {
      progress.textContent = 'Сервер не вернул имя файла';
      console.error('Unexpected response:', res);
      return;
    }
    progress.textContent = 'Готово ✓';
    showToast('Видео загружено');
    showVideo(res.filename, true);
    loadVideoList();
    setTimeout(() => progress.textContent = '', 3000);
  };
  xhr.onerror = () => {
    progress.textContent = 'Ошибка сети при загрузке';
    console.error('XHR network error during upload');
  };
  xhr.send(formData);
}

async function loadVideoList() {
  const select = document.getElementById('videoSelect');
  try {
    const res = await fetch('/videos');
    if (!res.ok) throw new Error('status ' + res.status);
    const files = await res.json();
    select.innerHTML = '<option value="">— выбрать уже загруженное —</option>';
    files.forEach(f => {
      const opt = document.createElement('option');
      opt.value = f;
      opt.textContent = f.replace(/^\d+-/, '');
      select.appendChild(opt);
    });
  } catch (e) {
    console.error('Не удалось получить список видео:', e);
    select.innerHTML = '<option value="">— не удалось загрузить список —</option>';
  }
}

function pickExisting() {
  const filename = document.getElementById('videoSelect').value;
  if (filename) showVideo(filename, true);
}

function toggleUploadMenu() {
  const menu = document.getElementById('uploadMenu');
  const backdrop = document.getElementById('uploadMenuBackdrop');
  const show = !menu.classList.contains('show');
  menu.classList.toggle('show', show);
  backdrop.classList.toggle('show', show);
}
function closeUploadMenu() {
  document.getElementById('uploadMenu').classList.remove('show');
  document.getElementById('uploadMenuBackdrop').classList.remove('show');
}
function openExistingVideoPicker() {
  const select = document.getElementById('videoSelect');
  if (!select.options || select.options.length <= 1) {
    showToast('Пока нет ранее загруженных видео');
    return;
  }
  if (typeof select.showPicker === 'function') {
    try { select.showPicker(); return; } catch (e) { /* fall through */ }
  }
  select.style.display = 'block';
  select.style.position = 'fixed';
  select.style.opacity = '0';
  select.focus();
  select.click();
  setTimeout(() => { select.style.display = 'none'; select.style.position = ''; select.style.opacity = ''; }, 300);
}

function openImageLightbox(url) {
  document.getElementById('lightboxImg').src = url;
  document.getElementById('imageLightbox').classList.add('show');
}

function closeImageLightbox() {
  document.getElementById('imageLightbox').classList.remove('show');
  document.getElementById('lightboxImg').src = '';
}

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && document.getElementById('imageLightbox').classList.contains('show')) {
    closeImageLightbox();
  }
});

/* -----------------------------------------------------------
   Chat
   ----------------------------------------------------------- */
let pendingChatImage = null; // File объект, ожидающий отправки

/* -----------------------------------------------------------
   Голосовые сообщения — запись через MediaRecorder
   ----------------------------------------------------------- */
let voiceRecorder = null;
let voiceChunks = [];
let voiceStream = null;
let voiceStartedAt = 0;
let voiceTimerInterval = null;
let voiceRecordingActive = false;

function pickVoiceMimeType() {
  const candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4'];
  for (const type of candidates) {
    if (window.MediaRecorder && MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(type)) return type;
  }
  return '';
}

function extForMimeType(type) {
  if (type.includes('ogg')) return '.ogg';
  if (type.includes('mp4')) return '.m4a';
  return '.webm';
}

async function startVoiceRecording() {
  if (voiceRecordingActive) return;
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    showToast('Запись голоса не поддерживается этим браузером');
    return;
  }
  try {
    voiceStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (e) {
    showToast('Нет доступа к микрофону');
    return;
  }

  const mimeType = pickVoiceMimeType();
  try {
    voiceRecorder = mimeType ? new MediaRecorder(voiceStream, { mimeType }) : new MediaRecorder(voiceStream);
  } catch (e) {
    showToast('Не удалось начать запись');
    voiceStream.getTracks().forEach((t) => t.stop());
    voiceStream = null;
    return;
  }

  voiceChunks = [];
  voiceRecorder.ondataavailable = (e) => { if (e.data && e.data.size) voiceChunks.push(e.data); };
  voiceRecorder.start();
  voiceRecordingActive = true;
  voiceStartedAt = Date.now();

  document.getElementById('chatInputBar').style.display = 'none';
  document.getElementById('voiceRecordBar').classList.add('show');
  document.getElementById('voiceRecordTime').textContent = '0:00';
  voiceTimerInterval = setInterval(() => {
    const elapsed = Math.floor((Date.now() - voiceStartedAt) / 1000);
    document.getElementById('voiceRecordTime').textContent = formatDuration(elapsed);
    if (elapsed >= 300) finishVoiceRecording(); // защитный лимит — 5 минут
  }, 250);
}

function exitVoiceRecordingUI() {
  voiceRecordingActive = false;
  clearInterval(voiceTimerInterval);
  voiceTimerInterval = null;
  document.getElementById('voiceRecordBar').classList.remove('show');
  document.getElementById('chatInputBar').style.display = '';
  if (voiceStream) {
    voiceStream.getTracks().forEach((t) => t.stop());
    voiceStream = null;
  }
}

function cancelVoiceRecording() {
  if (!voiceRecorder) { exitVoiceRecordingUI(); return; }
  voiceRecorder.onstop = () => { voiceChunks = []; exitVoiceRecordingUI(); };
  try { voiceRecorder.stop(); } catch (e) { exitVoiceRecordingUI(); }
}

function finishVoiceRecording() {
  if (!voiceRecorder) { exitVoiceRecordingUI(); return; }
  const elapsedSeconds = Math.max(1, Math.round((Date.now() - voiceStartedAt) / 1000));
  const mimeType = voiceRecorder.mimeType || 'audio/webm';
  voiceRecorder.onstop = () => {
    exitVoiceRecordingUI();
    if (elapsedSeconds < 1 || !voiceChunks.length) return;
    const blob = new Blob(voiceChunks, { type: mimeType });
    voiceChunks = [];
    sendVoiceMessage(blob, elapsedSeconds, mimeType);
  };
  try { voiceRecorder.stop(); } catch (e) { exitVoiceRecordingUI(); }
}

function uploadVoiceBlob(blob, mimeType) {
  return new Promise((resolve, reject) => {
    const formData = new FormData();
    formData.append('voice', blob, 'voice' + extForMimeType(mimeType));
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/upload-voice');
    xhr.onload = () => {
      if (xhr.status < 200 || xhr.status >= 300) {
        reject(new Error('Сервер вернул код ' + xhr.status));
        return;
      }
      try {
        const res = JSON.parse(xhr.responseText);
        if (!res.filename) { reject(new Error('Сервер не вернул имя файла')); return; }
        resolve(res.filename);
      } catch (e) {
        reject(e);
      }
    };
    xhr.onerror = () => reject(new Error('Ошибка сети при загрузке голосового'));
    xhr.send(formData);
  });
}

function sendVoiceMessage(blob, durationSeconds, mimeType) {
  if (!socket || !room) { showToast('Нет соединения'); return; }
  const replyPayload = replyingTo ? { id: replyingTo.id, name: replyingTo.name, text: replyingTo.text, image: replyingTo.image, gif: replyingTo.gif, voice: replyingTo.voice } : null;
  uploadVoiceBlob(blob, mimeType)
    .then((filename) => {
      socket.emit('chat-message', { room, voice: filename, voiceDuration: durationSeconds, replyTo: replyPayload });
      clearReply();
    })
    .catch((err) => {
      console.error('Ошибка отправки голосового:', err);
      showToast('Не удалось отправить голосовое');
    });
}

function formatDuration(totalSeconds) {
  const s = Math.max(0, Math.round(totalSeconds));
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return m + ':' + String(rem).padStart(2, '0');
}

function toggleVoicePlayback(btn, audio) {
  document.querySelectorAll('.msg-voice audio').forEach((a) => {
    if (a !== audio && !a.paused) a.pause();
  });
  if (audio.paused) {
    audio.play().catch(() => showToast('Не удалось воспроизвести'));
  } else {
    audio.pause();
  }
}
let replyingTo = null; // { id, name, text, image, gif, voice }

function startReply(id, fromName, text, hasImage, hasGif, hasVoice) {
  replyingTo = {
    id,
    name: fromName,
    text: (text || '').slice(0, 300),
    image: !!hasImage,
    gif: !!hasGif,
    voice: !!hasVoice
  };
  document.getElementById('replyToName').textContent = fromName;
  document.getElementById('replyToText').textContent = text || (hasGif ? '🎞 GIF' : (hasImage ? '📷 Фото' : (hasVoice ? '🎤 Голосовое' : '')));
  document.getElementById('replyPreview').classList.add('show');
  document.getElementById('chatInput').focus();
}

function clearReply() {
  replyingTo = null;
  document.getElementById('replyPreview').classList.remove('show');
}

// Свайп сообщения вправо -> ответ на него (жест как в Telegram/WhatsApp).
// Работает через Pointer Events, поэтому одинаково реагирует и на палец, и на мышь.
function attachSwipeReply(bodyEl, msg, displayName) {
  if (!msg.id) return; // системные сообщения ("вошёл/вышел") не отвечаемы

  const icon = document.createElement('div');
  icon.className = 'msg-swipe-icon';
  icon.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 17l-5-5 5-5M4 12h10a5 5 0 015 5v1"/></svg>';
  bodyEl.appendChild(icon);

  const THRESHOLD = 56; // сколько пикселей нужно протянуть, чтобы сработало
  const MAX_DRAG = 84;
  let startX = 0, startY = 0, dx = 0;
  let dragging = false, decided = false, isHorizontal = false;

  const reset = () => {
    bodyEl.style.transition = 'transform .18s var(--ease)';
    bodyEl.style.transform = '';
    icon.style.opacity = 0;
    icon.style.transform = 'translateY(-50%) scale(.5)';
  };

  bodyEl.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    startX = e.clientX; startY = e.clientY; dx = 0;
    dragging = true; decided = false; isHorizontal = false;
    bodyEl.style.transition = 'none';
  });

  bodyEl.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    const cdx = e.clientX - startX;
    const cdy = e.clientY - startY;

    if (!decided) {
      if (Math.abs(cdx) > 8 || Math.abs(cdy) > 8) {
        decided = true;
        // Только вправо, и только если движение явно горизонтальное —
        // иначе не мешаем обычному вертикальному скроллу списка сообщений
        isHorizontal = cdx > 0 && Math.abs(cdx) > Math.abs(cdy) * 1.3;
        if (isHorizontal) bodyEl.setPointerCapture(e.pointerId);
      }
    }
    if (!isHorizontal) return;

    dx = Math.max(0, Math.min(cdx, MAX_DRAG));
    e.preventDefault();
    bodyEl.style.transform = `translateX(${dx}px)`;
    const progress = Math.min(dx / THRESHOLD, 1);
    icon.style.opacity = progress;
    icon.style.transform = `translateY(-50%) scale(${0.5 + progress * 0.5})`;
  });

  const finish = () => {
    if (!dragging) return;
    dragging = false;
    const triggered = isHorizontal && dx >= THRESHOLD;
    reset();
    if (triggered) {
      if (navigator.vibrate) navigator.vibrate(10);
      startReply(msg.id, displayName, msg.text, !!msg.image, !!msg.gifUrl, !!msg.voice);
    }
  };

  bodyEl.addEventListener('pointerup', finish);
  bodyEl.addEventListener('pointercancel', finish);
}

function jumpToMessage(id) {
  if (!id) return;
  const target = document.querySelector('.msg-row[data-id="' + CSS.escape(id) + '"]');
  if (!target) { showToast('Сообщение не найдено (могло уйти из истории)'); return; }
  target.scrollIntoView({ behavior: 'smooth', block: 'center' });
  target.classList.remove('highlight');
  void target.offsetWidth; // рестарт анимации, если уже была
  target.classList.add('highlight');
  setTimeout(() => target.classList.remove('highlight'), 1200);
}

function handleChatImageSelect(event) {
  const file = event.target.files[0];
  event.target.value = ''; // чтобы повторный выбор того же файла тоже сработал
  if (file) setPendingChatImage(file);
}

function handleChatPaste(event) {
  if (!document.body.classList.contains('in-room')) return; // работаем только внутри активной комнаты
  const items = event.clipboardData && event.clipboardData.items;
  if (!items) return;
  for (const item of items) {
    if (item.type && item.type.startsWith('image/')) {
      event.preventDefault(); // не даём вставить бинарные данные как текст в поле ввода
      const file = item.getAsFile();
      if (file) setPendingChatImage(file);
      return;
    }
  }
  // если в буфере не картинка — ничего не делаем, обычная вставка текста идёт своим чередом
}
document.addEventListener('paste', handleChatPaste);

function setPendingChatImage(file) {
  if (!file.type || !file.type.startsWith('image/')) {
    showToast('Можно прикрепить только изображение');
    return;
  }
  if (file.size > 15 * 1024 * 1024) {
    showToast('Картинка слишком большая (максимум 15 МБ)');
    return;
  }
  pendingChatImage = file;

  const reader = new FileReader();
  reader.onload = () => {
    document.getElementById('chatAttachThumb').src = reader.result;
  };
  reader.readAsDataURL(file);

  document.getElementById('chatAttachCaption').textContent = file.name || 'Картинка готова к отправке';
  document.getElementById('chatAttachPreview').classList.add('show');
  document.getElementById('chatInput').focus();
  updateSendMicUI();
}

function clearChatAttachment() {
  pendingChatImage = null;
  document.getElementById('chatAttachPreview').classList.remove('show');
  document.getElementById('chatAttachThumb').src = '';
  updateSendMicUI();
}

function uploadChatImage(file) {
  return new Promise((resolve, reject) => {
    const formData = new FormData();
    formData.append('image', file);
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/upload-image');
    xhr.onload = () => {
      if (xhr.status < 200 || xhr.status >= 300) {
        reject(new Error('Сервер вернул код ' + xhr.status));
        return;
      }
      try {
        const res = JSON.parse(xhr.responseText);
        if (!res.filename) { reject(new Error('Сервер не вернул имя файла')); return; }
        resolve(res.filename);
      } catch (e) {
        reject(e);
      }
    };
    xhr.onerror = () => reject(new Error('Ошибка сети при загрузке картинки'));
    xhr.send(formData);
  });
}

// Кнопка 🤖 просто подставляет команду в поле ввода — сама логика вопроса
// живёт на сервере (см. "/ai" в обработчике chat-message), это позволяет
// переиспользовать всю уже готовую отправку чата (typing-индикатор AI тоже
// приходит через обычные события user-typing/user-stop-typing).
function promptAiAsk() {
  const input = document.getElementById('chatInput');
  if (!input.value.trim().toLowerCase().startsWith('/ai')) {
    input.value = '/ai ';
  }
  input.focus();
  if (input.setSelectionRange) input.setSelectionRange(input.value.length, input.value.length);
}

function sendChat() {
  const input = document.getElementById('chatInput');
  const text = input.value.trim();
  const imageFile = pendingChatImage;
  const replyPayload = replyingTo ? { id: replyingTo.id, name: replyingTo.name, text: replyingTo.text, image: replyingTo.image, gif: replyingTo.gif, voice: replyingTo.voice } : null;

  if (!text && !imageFile) return;

  if (!imageFile) {
    socket.emit('chat-message', { room, text, replyTo: replyPayload });
    input.value = '';
    stopTypingEmit();
    clearReply();
    document.getElementById('mentionDropdown').classList.remove('show');
    updateSendMicUI();
    requestAnimationFrame(() => input.focus());
    return;
  }

  // Есть картинка — сперва грузим её на сервер, потом отправляем сообщение
  const caption = document.getElementById('chatAttachCaption');
  caption.textContent = 'Отправка...';
  input.value = '';
  stopTypingEmit();
  updateSendMicUI();

  uploadChatImage(imageFile)
    .then((filename) => {
      socket.emit('chat-message', { room, text, image: filename, replyTo: replyPayload });
      clearChatAttachment();
      clearReply();
      requestAnimationFrame(() => input.focus());
    })
    .catch((err) => {
      console.error('Не удалось загрузить картинку:', err);
      showToast('Не удалось отправить картинку');
      caption.textContent = imageFile.name || 'Картинка готова к отправке';
    });
}

function updateSendMicUI() {
  const input = document.getElementById('chatInput');
  const slot = document.getElementById('sendMicSlot');
  if (!input || !slot) return;
  const hasContent = input.value.trim().length > 0 || !!pendingChatImage;
  slot.classList.toggle('has-content', hasContent);
}

function handleTyping() {
  const menu = document.getElementById('chatMoreMenu');
  if (menu && menu.classList.contains('show')) closeChatMoreMenu();
  if (!socket) return;
  const now = Date.now();
  if (now - lastTypingEmit > 1500) {
    socket.emit('typing', { room, name });
    lastTypingEmit = now;
  }
  clearTimeout(typingTimeout);
  typingTimeout = setTimeout(stopTypingEmit, 2500);
  updateMentionDropdown();
}

/* -----------------------------------------------------------
   @упоминания: детект набора, автодополнение, вставка
   ----------------------------------------------------------- */
function updateMentionDropdown() {
  const input = document.getElementById('chatInput');
  const dropdown = document.getElementById('mentionDropdown');
  const caret = input.selectionStart;
  const before = input.value.slice(0, caret);
  const match = before.match(/(?:^|\s)@([^\s@]{0,24})$/);

  if (!match || !roomMemberNames.length) {
    mentionQueryStart = -1;
    dropdown.classList.remove('show');
    return;
  }

  mentionQueryStart = caret - match[1].length - 1;
  const query = match[1].toLowerCase();
  const suggestions = roomMemberNames.filter((n) => n.toLowerCase().startsWith(query));

  if (!suggestions.length) {
    dropdown.classList.remove('show');
    return;
  }

  dropdown.innerHTML = '';
  suggestions.forEach((n) => {
    const item = document.createElement('div');
    item.className = 'mention-item';
    item.textContent = '@' + n;
    item.onmousedown = (ev) => { ev.preventDefault(); insertMention(n); };
    dropdown.appendChild(item);
  });
  dropdown.classList.add('show');
}

function insertMention(mentionName) {
  const input = document.getElementById('chatInput');
  const before = input.value.slice(0, mentionQueryStart);
  const after = input.value.slice(input.selectionStart);
  input.value = `${before}@${mentionName} ${after}`;
  const newCaret = (before + '@' + mentionName + ' ').length;
  input.setSelectionRange(newCaret, newCaret);
  document.getElementById('mentionDropdown').classList.remove('show');
  mentionQueryStart = -1;
  input.focus();
}

// Разбивает текст сообщения на обычный текст + подсвеченные @упоминания,
// не трогая textContent пользовательского ввода (без innerHTML — безопасно)
function renderMessageText(container, text, mentions) {
  container.textContent = '';
  if (!text) return;
  if (!mentions || !mentions.length) { container.textContent = text; return; }

  const regex = /@([^\s@]{1,24})/g;
  let lastIndex = 0, match;
  while ((match = regex.exec(text))) {
    const isReal = mentions.some((m) => m.toLowerCase() === match[1].toLowerCase());
    if (match.index > lastIndex) container.appendChild(document.createTextNode(text.slice(lastIndex, match.index)));
    if (isReal) {
      const span = document.createElement('span');
      span.className = 'msg-mention';
      span.textContent = match[0];
      container.appendChild(span);
    } else {
      container.appendChild(document.createTextNode(match[0]));
    }
    lastIndex = regex.lastIndex;
  }
  if (lastIndex < text.length) container.appendChild(document.createTextNode(text.slice(lastIndex)));
}

function stopTypingEmit() {
  clearTimeout(typingTimeout);
  if (socket) socket.emit('stop-typing', { room, name });
}

function showTyping(who) {
  const row = document.getElementById('typingRow');
  currentTypingUser = who;
  document.getElementById('typingText').textContent = who + ' печатает';
  row.classList.add('show');
  clearTimeout(remoteTypingTimeout);
  remoteTypingTimeout = setTimeout(hideTyping, 3000);
  if (isNearBottom(document.getElementById('chatMessages'), 90)) scrollChatToBottom(false);
}
function hideTyping() {
  currentTypingUser = null;
  document.getElementById('typingRow').classList.remove('show');
}

function avatarColor(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) hash = (hash * 31 + str.charCodeAt(i)) >>> 0;
  const palette = ['#8579C4', '#4F8FBF', '#5FA87E', '#C6A84A'];
  const i = hash % palette.length;
  const j = (i + hash % 3 + 1) % palette.length;
  return `linear-gradient(135deg, ${palette[i]}, ${palette[j]})`;
}
function initials(str) {
  const s = (str || '?').trim();
  return s ? s[0].toUpperCase() : '?';
}
// Сообщение состоит только из эмодзи (плюс пробелы) и не слишком длинное —
// такие сообщения показываем крупно с анимацией, как в iMessage/WhatsApp
function isEmojiOnlyText(text) {
  const t = (text || '').trim();
  if (!t || t.length > 24) return false;
  if (!/\p{Extended_Pictographic}/u.test(t)) return false; // должен быть хотя бы один настоящий эмодзи-глиф
  const stripped = t.replace(/[\p{Extended_Pictographic}\p{Emoji_Component}\u{FE0F}\u{200D}\s]/gu, '');
  return stripped.length === 0;
}
function renderAvatarEl(el, displayName, emoji, photoUrl) {
  el.classList.remove('has-emoji', 'has-photo');
  el.innerHTML = '';
  if (photoUrl) {
    el.style.background = 'transparent';
    const img = document.createElement('img');
    img.src = photoUrl;
    img.alt = '';
    img.loading = 'lazy';
    el.appendChild(img);
    el.classList.add('has-photo');
    return;
  }
  el.style.background = avatarColor(displayName);
  if (emoji) {
    el.textContent = emoji;
    el.classList.add('has-emoji');
  } else {
    el.textContent = initials(displayName);
  }
}
function formatTime(date) {
  return String(date.getHours()).padStart(2, '0') + ':' + String(date.getMinutes()).padStart(2, '0');
}

function isNearBottom(box, threshold = 60) {
  return box.scrollHeight - box.scrollTop - box.clientHeight < threshold;
}

function scrollChatToBottom(smooth) {
  const box = document.getElementById('chatMessages');
  box.scrollTo({ top: box.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });
}

// --- Лёгкие GIF: статичный кадр + запуск по тапу ---
function gifStillUrl(url) {
  // У Giphy статичный кадр лежит рядом: 200w.gif -> 200w_s.gif
  const m = /^(https:\/\/[^?]*?)(\d+w|giphy|200_d|200)\.gif(\?.*)?$/.exec(url);
  return m ? m[1] + m[2] + '_s.gif' + (m[3] || '') : null;
}
let activeGif = null;
const gifVisibilityObserver = ('IntersectionObserver' in window)
  ? new IntersectionObserver((entries) => {
      entries.forEach((e) => { if (!e.isIntersecting && e.target._stopGif) e.target._stopGif(); });
    }, { threshold: 0.2 })
  : null;
function playGifInline(img, badge, gifUrl, still) {
  if (activeGif && activeGif !== img && activeGif._stopGif) activeGif._stopGif();
  img.src = gifUrl;
  img.dataset.playing = '1';
  badge.style.display = 'none';
  img._stopGif = () => {
    img.src = still;
    img.dataset.playing = '0';
    badge.style.display = '';
    img._stopGif = null;
    if (activeGif === img) activeGif = null;
    if (gifVisibilityObserver) gifVisibilityObserver.unobserve(img);
  };
  activeGif = img;
  if (gifVisibilityObserver) gifVisibilityObserver.observe(img);
}

const CHAT_DOM_LIMIT = 120;
function addChatMessage(msg, bulkLoad) {
  const box = document.getElementById('chatMessages');
  const inner = document.getElementById('chatMessagesInner');
  const emptyEl = document.getElementById('chatEmpty');
  if (emptyEl) emptyEl.classList.add('hide');
  const wasNearBottom = bulkLoad ? true : isNearBottom(box);

  if (msg.system) {
    // Тот же текст подряд (например, старая история с дублями «присоединился») — не рисуем повторно
    const last = inner.lastElementChild;
    if (last && last.classList.contains('msg') && last.classList.contains('system') && last.textContent === msg.text) return;
    const div = document.createElement('div');
    div.className = 'msg system';
    div.textContent = msg.text;
    inner.appendChild(div);
  } else {
    const displayName = msg.name || 'Гость';
    if (displayName === currentTypingUser) hideTyping();
    const isOwn = displayName === name;

    const row = document.createElement('div');
    const isMentioned = !!(msg.mentions && msg.mentions.some((m) => m === name));
    row.className = 'msg-row' + (isOwn ? ' own' : '') + (isMentioned ? ' mentioned' : '') + (msg.ai ? ' ai-msg' : '');
    if (msg.id) row.dataset.id = msg.id;
    if (bulkLoad) row.style.animation = 'none';

    const avatar = document.createElement('div');
    avatar.className = 'msg-avatar';
    renderAvatarEl(avatar, displayName, msg.avatar, msg.avatarPhoto || '');

    const bodyEl = document.createElement('div');
    bodyEl.className = 'msg-body';

    const nameEl = document.createElement('div');
    nameEl.className = 'msg-name';
    nameEl.textContent = isOwn ? displayName + ' (вы)' : displayName;

    const line = document.createElement('div');
    line.className = 'msg-line';

    const textEl = document.createElement('div');
    textEl.className = 'msg-text';
    renderMessageText(textEl, msg.text, msg.mentions);
    const isBigEmoji = !!msg.id && !msg.image && !msg.gifUrl && !msg.voice && !msg.replyTo && isEmojiOnlyText(msg.text);
    if (isBigEmoji) textEl.classList.add('msg-text-emoji-only');

    const timeEl = document.createElement('div');
    timeEl.className = 'msg-time';
    timeEl.textContent = formatTime(msg.time ? new Date(msg.time) : new Date());

    if (msg.text) line.appendChild(textEl);
    line.appendChild(timeEl);

    if (msg.id) {
      const replyBtn = document.createElement('button');
      replyBtn.type = 'button';
      replyBtn.className = 'msg-react-btn';
      replyBtn.setAttribute('aria-label', 'Ответить на сообщение');
      replyBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M9 17l-5-5 5-5M4 12h10a5 5 0 015 5v1"/></svg>';
      replyBtn.onclick = (ev) => { ev.stopPropagation(); startReply(msg.id, displayName, msg.text, !!msg.image, !!msg.gifUrl, !!msg.voice); };
      line.appendChild(replyBtn);
    }

    if (msg.id) {
      const reactBtn = document.createElement('button');
      reactBtn.type = 'button';
      reactBtn.className = 'msg-react-btn';
      reactBtn.setAttribute('aria-label', 'Реакция на сообщение');
      reactBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="9"/><path d="M8 14s1.5 2 4 2 4-2 4-2"/><path d="M9 9h.01M15 9h.01"/></svg>';
      reactBtn.onclick = (ev) => { ev.stopPropagation(); toggleMessageReactionPicker(msg.id, reactBtn); };
      line.appendChild(reactBtn);
    }


    bodyEl.appendChild(nameEl);

    if (msg.replyTo) {
      const quote = document.createElement('div');
      quote.className = 'msg-quote';
      quote.innerHTML = '<div class="bar"></div><div class="info"><div class="to-name"></div><div class="to-text"></div></div>';
      quote.querySelector('.to-name').textContent = msg.replyTo.name || 'Гость';
      quote.querySelector('.to-text').textContent = msg.replyTo.text || (msg.replyTo.gif ? '🎞 GIF' : (msg.replyTo.image ? '📷 Фото' : (msg.replyTo.voice ? '🎤 Голосовое' : '')));
      quote.onclick = (ev) => { ev.stopPropagation(); jumpToMessage(msg.replyTo.id); };
      bodyEl.appendChild(quote);
    }

    bodyEl.appendChild(line);

    if (msg.image) {
      const img = document.createElement('img');
      img.className = 'msg-image';
      img.src = '/chat-images/' + msg.image;
      img.loading = 'lazy';
      img.alt = 'Изображение из чата';
      img.onclick = () => openImageLightbox('/chat-images/' + msg.image);
      bodyEl.appendChild(img);
    }

    if (msg.gifUrl) {
      const wrap = document.createElement('div');
      wrap.className = 'msg-gif';
      wrap.style.cssText = 'display:inline-block; margin-top:4px;';
      const img = document.createElement('img');
      img.className = 'msg-image';
      img.loading = 'lazy';
      img.decoding = 'async';
      img.alt = 'GIF';
      const badge = document.createElement('span');
      badge.className = 'gif-badge';
      badge.textContent = 'GIF';
      // Лёгкий режим: в ленте показываем статичный кадр, анимация — по тапу
      // и только пока GIF на экране (одновременно играет один).
      const still = gifStillUrl(msg.gifUrl);
      if (still) {
        img.src = still;
        badge.textContent = '▶ GIF';
        img.onclick = () => {
          if (img.dataset.playing === '1') { openImageLightbox(msg.gifUrl); return; }
          playGifInline(img, badge, msg.gifUrl, still);
        };
      } else {
        img.src = msg.gifUrl;
        img.onclick = () => openImageLightbox(msg.gifUrl);
      }
      wrap.appendChild(img);
      wrap.appendChild(badge);
      bodyEl.appendChild(wrap);
    }

    if (msg.voice) {
      const voiceWrap = document.createElement('div');
      voiceWrap.className = 'msg-voice';

      const audio = document.createElement('audio');
      audio.src = msg.voice;
      audio.preload = 'none';

      const playBtn = document.createElement('button');
      playBtn.type = 'button';
      playBtn.className = 'voice-play-btn';
      playBtn.setAttribute('aria-label', 'Воспроизвести голосовое');
      const playIcon = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>';
      const pauseIcon = '<svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="5" width="4" height="14"/><rect x="14" y="5" width="4" height="14"/></svg>';
      playBtn.innerHTML = playIcon;
      playBtn.onclick = () => toggleVoicePlayback(playBtn, audio);

      const track = document.createElement('div');
      track.className = 'voice-track';
      const trackFill = document.createElement('div');
      trackFill.className = 'voice-track-fill';
      track.appendChild(trackFill);

      const durationEl = document.createElement('span');
      durationEl.className = 'voice-duration';
      durationEl.textContent = formatDuration(msg.voiceDuration || 0);

      audio.addEventListener('play', () => { playBtn.innerHTML = pauseIcon; });
      audio.addEventListener('pause', () => { playBtn.innerHTML = playIcon; });
      audio.addEventListener('ended', () => { playBtn.innerHTML = playIcon; trackFill.style.width = '0%'; });
      audio.addEventListener('timeupdate', () => {
        if (audio.duration) trackFill.style.width = (audio.currentTime / audio.duration * 100) + '%';
        durationEl.textContent = formatDuration(audio.duration ? (audio.duration - audio.currentTime) : (msg.voiceDuration || 0));
      });

      voiceWrap.appendChild(playBtn);
      voiceWrap.appendChild(track);
      voiceWrap.appendChild(durationEl);
      voiceWrap.appendChild(audio);
      bodyEl.appendChild(voiceWrap);
    }

    if (msg.id) {
      bodyEl.addEventListener('dblclick', (ev) => {
        ev.preventDefault();
        window.getSelection && window.getSelection().removeAllRanges();
        sendMessageReaction(msg.id, '❤️');
        triggerEmojiBurst(bodyEl, '❤️');
      });
    }

    if (isBigEmoji) {
      triggerEmojiBurst(bodyEl, Array.from(msg.text.trim())[0]);
    }

    attachSwipeReply(bodyEl, msg, displayName);

    row.appendChild(avatar);
    row.appendChild(bodyEl);
    inner.appendChild(row);

    if (msg.reactions) renderMessageReactions(row, msg.reactions);
  }

  // Лимит DOM: старые сообщения убираем, чтобы список не рос бесконечно
  if (wasNearBottom) {
    while (inner.childElementCount > CHAT_DOM_LIMIT) inner.firstElementChild.remove();
  }
  if (wasNearBottom) requestAnimationFrame(() => { box.scrollTop = box.scrollHeight; });
}

/* =============================================================
   Новое: метаданные видео, умный реконнект + статус синхронизации,
   присутствие, таймлайн/активность, закреп/поиск/фильтр в чате
   ============================================================= */

function formatMediaDuration(totalSeconds) {
  const s = Math.max(0, Math.round(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.round((s % 3600) / 60);
  if (h > 0) return `${h}ч ${m}м`;
  return `${m}м`;
}

// --- Метаданные видео (Phase 1) ---
function renderMediaCard(media) {
  const card = document.getElementById('mediaCard');
  if (!media || !media.title) { card.style.display = 'none'; return; }
  const poster = document.getElementById('mediaCardPoster');
  if (media.posterUrl) {
    poster.src = media.posterUrl;
    poster.style.display = '';
  } else {
    poster.style.display = 'none';
  }
  document.getElementById('mediaCardTitle').textContent = media.title;
  const metaParts = [];
  if (media.year) metaParts.push(media.year);
  if (media.duration) metaParts.push(formatMediaDuration(media.duration));
  if (media.rating) metaParts.push('★ ' + media.rating.toFixed(1));
  document.getElementById('mediaCardMeta').textContent = metaParts.join(' · ');
  document.getElementById('mediaCardOverview').textContent = media.overview || '';
  card.style.display = media.overview || media.posterUrl || media.rating ? 'flex' : 'none';
}
function clearMediaCard() {
  document.getElementById('mediaCard').style.display = 'none';
}

// --- Умный реконнект + статус синхронизации (Phase 2-3) ---
// lastAuthoritativePlayback хранит последнее известное авторитетное
// состояние сервера (время/играет ли/когда обновлено) — по нему на клиенте
// без единого лишнего сетевого запроса вычисляется дрейф синхронизации.
let lastAuthoritativePlayback = { time: 0, playing: false, updatedAt: Date.now(), stateVersion: 0 };
let connectionState = 'CONNECTED'; // CONNECTED | RECONNECTING | DISCONNECTED

// Плашка статуса: при смене состояния показывает подпись 4 секунды,
// затем сворачивается до маленькой иконки с цветной точкой (не мешает видео).
let syncPillCompactTimer = null;
function setSyncPill(stateClass, label) {
  const pill = document.getElementById('syncPill');
  if (!pill) return;
  const changed = pill.dataset.state !== stateClass;
  const keepCompact = !changed && pill.dataset.compact === '1';
  pill.className = 'sync-pill state-' + stateClass + (keepCompact ? ' compact' : '');
  document.getElementById('syncLabel').textContent = label;
  if (changed) {
    pill.dataset.state = stateClass;
    pill.dataset.compact = '0';
    clearTimeout(syncPillCompactTimer);
    syncPillCompactTimer = setTimeout(() => {
      pill.dataset.compact = '1';
      pill.classList.add('compact');
    }, 4000);
  }
}

function updateAuthoritativePlayback(time, playing, updatedAt, stateVersion) {
  // Защита от гонки: устаревшее событие (более старая версия состояния),
  // пришедшее не по порядку после переподключения, не должно откатывать
  // уже применённое более новое состояние.
  if (typeof stateVersion === 'number' && stateVersion < lastAuthoritativePlayback.stateVersion) return;
  lastAuthoritativePlayback = {
    time: time || 0,
    playing: !!playing,
    updatedAt: updatedAt || Date.now(),
    stateVersion: stateVersion || 0
  };
}

function getLocalPlayerTime() {
  if (currentYoutubeVideo && ytPlayerInstance && typeof ytPlayerInstance.getCurrentTime === 'function') {
    try { return ytPlayerInstance.getCurrentTime(); } catch (e) { return null; }
  }
  const player = document.getElementById('player');
  if (player && player.style.display !== 'none') return player.currentTime;
  return null;
}

// Раз в пару секунд сверяем локальное время плеера с расчётным
// "авторитетным" временем сервера (время + сколько прошло с момента
// последнего play/pause/seek) — без единого доп. запроса по сети.
// Тап по плашке статуса: подтягиваем локальный плеер к расчётному
// «авторитетному» времени комнаты (без запросов к серверу).
function resyncNow() {
  if (connectionState !== 'CONNECTED') { showToast('Нет связи с комнатой'); return; }
  const a = lastAuthoritativePlayback;
  const expected = a.playing ? a.time + (Date.now() - a.updatedAt) / 1000 : a.time;
  setSyncPill('syncing', 'Синхронизация…');
  try {
    if (currentYoutubeVideo && ytPlayerInstance && typeof ytPlayerInstance.seekTo === 'function') {
      ytPlayerInstance.seekTo(expected, true);
      if (a.playing) ytPlayerInstance.playVideo(); else ytPlayerInstance.pauseVideo();
    } else {
      const pl = document.getElementById('player');
      if (!pl || pl.style.display === 'none') { showToast('Видео не выбрано'); return; }
      pl.currentTime = expected;
      if (a.playing) pl.play().catch(() => {}); else pl.pause();
    }
    showToast('Пересинхронизировано');
  } catch (e) {}
}
document.addEventListener('keydown', (e) => {
  if ((e.key === 'Enter' || e.key === ' ') && e.target && e.target.id === 'syncPill') {
    e.preventDefault(); resyncNow();
  }
});

// Оверлеи поверх плеера («+ Видео», статус) прячутся, пока видео идёт и
// никто ничего не трогает. Любое касание/движение/смена фокуса (в том
// числе тап внутри YouTube-iframe — он уводит фокус окна) возвращает их.
let videoUiLastTouch = Date.now();
function wakeVideoUi() {
  videoUiLastTouch = Date.now();
  const sec = document.querySelector('.video-section');
  if (sec) sec.classList.remove('ui-idle');
}
['pointerdown', 'touchstart', 'mousemove', 'keydown', 'wheel'].forEach((ev) => {
  document.addEventListener(ev, wakeVideoUi, { passive: true, capture: true });
});
window.addEventListener('blur', wakeVideoUi);
function isVideoPlayingNow() {
  try {
    if (currentYoutubeVideo && ytPlayerInstance && typeof ytPlayerInstance.getPlayerState === 'function') {
      return ytPlayerInstance.getPlayerState() === 1;
    }
  } catch (e) {}
  const pl = document.getElementById('player');
  return !!(pl && pl.style.display !== 'none' && !pl.paused && !pl.ended);
}
setInterval(() => {
  const sec = document.querySelector('.video-section');
  if (!sec) return;
  const pill = document.getElementById('syncPill');
  // Скрываем оверлеи и при рассинхроне (статус остаётся иконкой-точкой),
  // но не при обрыве связи/переподключении — там пользователю нужен статус.
  const connOk = pill && !/state-(disconnected|reconnecting)\b/.test(pill.className);
  const menuOpen = document.getElementById('uploadMenu')?.classList.contains('show');
  const uploading = !!(document.getElementById('uploadProgress') || {}).textContent;
  const pl = document.getElementById('player');
  const hasVideo = !!currentYoutubeVideo || !!(pl && pl.style.display !== 'none' && (pl.currentSrc || pl.src));
  const idleMs = Date.now() - videoUiLastTouch;
  const idleEnough = isVideoPlayingNow() ? idleMs > 4000 : idleMs > 10000;
  if (connOk && hasVideo && !menuOpen && !uploading && idleEnough) {
    sec.classList.add('ui-idle');
  } else {
    sec.classList.remove('ui-idle');
  }
}, 1000);

// Яркость экрана и тёплый тон: полупрозрачный слой поверх приложения
// (значения хранятся локально на устройстве).
function applyScreenComfort(dim, warm) {
  const el = document.getElementById('screenComfort');
  if (!el) return;
  el.style.setProperty('--dim', String(dim / 100));
  el.style.setProperty('--warm', String(warm / 100));
  el.style.display = (dim > 0 || warm > 0) ? 'block' : 'none';
}
function setScreenComfort() {
  const d = parseInt(document.getElementById('dimSlider').value, 10) || 0;
  const w = parseInt(document.getElementById('warmSlider').value, 10) || 0;
  applyScreenComfort(d, w);
  try { localStorage.setItem('wt_dim', String(d)); localStorage.setItem('wt_warm', String(w)); } catch (e) {}
}
(function initScreenComfort() {
  let d = 0, w = 0;
  try {
    d = Math.min(60, Math.max(0, parseInt(localStorage.getItem('wt_dim'), 10) || 0));
    w = Math.min(40, Math.max(0, parseInt(localStorage.getItem('wt_warm'), 10) || 0));
  } catch (e) {}
  const apply = () => {
    const ds = document.getElementById('dimSlider');
    const ws = document.getElementById('warmSlider');
    if (ds) ds.value = d;
    if (ws) ws.value = w;
    applyScreenComfort(d, w);
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', apply); else apply();
})();

setInterval(() => {
  if (connectionState !== 'CONNECTED') return;
  if (syncing) { setSyncPill('syncing', 'Синхронизация…'); return; }
  const localTime = getLocalPlayerTime();
  if (localTime === null) { setSyncPill('connected', 'Подключено'); return; }
  const expected = lastAuthoritativePlayback.playing
    ? lastAuthoritativePlayback.time + (Date.now() - lastAuthoritativePlayback.updatedAt) / 1000
    : lastAuthoritativePlayback.time;
  const drift = Math.abs(localTime - expected);
  if (drift < 0.3) {
    setSyncPill('synced', 'В синхроне');
  } else if (drift < 2) {
    setSyncPill('drift', drift.toFixed(1) + 'с');
  } else {
    setSyncPill('drift', 'Рассинхрон');
  }
}, 2000);




/* -----------------------------------------------------------
   Профиль (имя + аватар — хранится локально, синхронизируется
   с другими участниками комнаты через update-profile)
   ----------------------------------------------------------- */
const AVATAR_EMOJI_SET = ['😀','😎','🦊','🐼','🐶','🐱','🦁','🐸','👾','🎬','🍿','🔥','🌟','🧑‍🚀','🥷','🤖'];

function openProfileEditor() {
  const nameInput = document.getElementById('profileNameInput');
  nameInput.value = name || '';

  const grid = document.getElementById('avatarPickGrid');
  grid.innerHTML = '';

  const noneBtn = document.createElement('button');
  noneBtn.type = 'button';
  noneBtn.className = 'avatar-pick-btn emoji-pick-btn' + (!avatarEmoji ? ' selected' : '');
  noneBtn.textContent = (name || '?').trim()[0]?.toUpperCase() || '?';
  noneBtn.style.background = avatarColor(name || 'Гость');
  noneBtn.style.color = '#fff';
  noneBtn.onclick = () => selectAvatarEmoji('', grid);
  grid.appendChild(noneBtn);

  AVATAR_EMOJI_SET.forEach((em) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = em;
    b.className = 'avatar-pick-btn emoji-pick-btn' + (avatarEmoji === em ? ' selected' : '');
    b.onclick = () => selectAvatarEmoji(em, grid);
    grid.appendChild(b);
  });

  renderAvatarEl(document.getElementById('profileAvatar'), name || 'Гость', avatarEmoji, avatarPhotoUrl(avatarPhoto));
  document.getElementById('removeAvatarPhotoBtn').style.display = avatarPhoto ? '' : 'none';
  openSheet('profileOverlay');
}

function selectAvatarEmoji(em, grid) {
  avatarEmoji = em;
  avatarPhoto = ''; // выбор эмодзи отменяет загруженное фото
  document.getElementById('removeAvatarPhotoBtn').style.display = 'none';
  grid.querySelectorAll('.avatar-pick-btn').forEach((b) => b.classList.remove('selected'));
  const idx = em ? AVATAR_EMOJI_SET.indexOf(em) + 1 : 0;
  grid.children[idx].classList.add('selected');
  const currentName = document.getElementById('profileNameInput').value.trim() || name || 'Гость';
  renderAvatarEl(document.getElementById('profileAvatar'), currentName, avatarEmoji);
}

function handleAvatarPhotoInput(event) {
  const file = event.target.files && event.target.files[0];
  event.target.value = ''; // разрешаем выбрать тот же файл повторно
  if (!file) return;
  if (!/^image\//.test(file.type)) { showToast('Выбери файл изображения'); return; }
  if (file.size > 8 * 1024 * 1024) { showToast('Фото слишком большое (максимум 8 МБ)'); return; }

  showToast('Загружаем фото…');
  uploadAvatarPhoto(file)
    .then((filename) => {
      avatarPhoto = filename;
      avatarEmoji = ''; // фото важнее эмодзи — сбрасываем выбор эмодзи
      try { localStorage.setItem('wt_avatar_photo', avatarPhoto); localStorage.setItem('wt_avatar', ''); } catch (e) {}
      const currentName = document.getElementById('profileNameInput').value.trim() || name || 'Гость';
      renderAvatarEl(document.getElementById('profileAvatar'), currentName, avatarEmoji, avatarPhotoUrl(avatarPhoto));
      document.getElementById('avatarPickGrid').querySelectorAll('.avatar-pick-btn').forEach((b) => b.classList.remove('selected'));
      document.getElementById('removeAvatarPhotoBtn').style.display = '';
      showToast('Фото загружено');
    })
    .catch((err) => {
      console.error('Ошибка загрузки аватара:', err);
      showToast('Не удалось загрузить фото');
    });
}

function uploadAvatarPhoto(file) {
  return new Promise((resolve, reject) => {
    const formData = new FormData();
    formData.append('avatar', file);
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/upload-avatar');
    xhr.onload = () => {
      if (xhr.status < 200 || xhr.status >= 300) {
        reject(new Error('Сервер вернул код ' + xhr.status));
        return;
      }
      try {
        const res = JSON.parse(xhr.responseText);
        if (!res.filename) { reject(new Error('Сервер не вернул имя файла')); return; }
        resolve(res.filename);
      } catch (e) {
        reject(e);
      }
    };
    xhr.onerror = () => reject(new Error('Ошибка сети при загрузке фото'));
    xhr.send(formData);
  });
}

function removeAvatarPhoto() {
  avatarPhoto = '';
  try { localStorage.setItem('wt_avatar_photo', ''); } catch (e) {}
  document.getElementById('removeAvatarPhotoBtn').style.display = 'none';
  const currentName = document.getElementById('profileNameInput').value.trim() || name || 'Гость';
  renderAvatarEl(document.getElementById('profileAvatar'), currentName, avatarEmoji, '');
}

function saveProfile() {
  const newName = document.getElementById('profileNameInput').value.trim().slice(0, 20) || name || 'Гость';
  name = newName;

  try {
    localStorage.setItem('wt_name', name);
    localStorage.setItem('wt_avatar', avatarEmoji);
    localStorage.setItem('wt_avatar_photo', avatarPhoto);
  } catch (e) {}

  renderAvatarEl(document.getElementById('profileAvatar'), name, avatarEmoji, avatarPhotoUrl(avatarPhoto));

  if (socket && room) {
    socket.emit('update-profile', { room, name, avatar: avatarEmoji, avatarPhoto });
  }

  showToast('Профиль сохранён');
  closeSheet('profileOverlay');
}

/* -----------------------------------------------------------
   GIF-пикер (поиск через Tenor, проксируется сервером)
   ----------------------------------------------------------- */
function openGifPicker() {
  document.getElementById('gifSearchInput').value = '';
  loadGifs('');
  openSheet('gifOverlay');
  requestAnimationFrame(() => document.getElementById('gifSearchInput').focus());
}

function handleGifSearchInput() {
  clearTimeout(gifSearchDebounce);
  const q = document.getElementById('gifSearchInput').value.trim();
  gifSearchDebounce = setTimeout(() => loadGifs(q), 350);
}

function loadGifs(query) {
  const grid = document.getElementById('gifGrid');
  grid.innerHTML = '<div class="gif-empty">Загрузка…</div>';
  const url = query ? '/api/gif/search?q=' + encodeURIComponent(query) : '/api/gif/trending';

  fetch(url)
    .then((r) => r.json().then((data) => ({ ok: r.ok, data })))
    .then(({ ok, data }) => {
      if (!ok || data.error === 'no-key') {
        grid.innerHTML = '<div class="gif-empty">Поиск GIF не настроен на сервере.<br>' +
          'Владельцу сайта нужно добавить бесплатный ключ <b>GIPHY_API_KEY</b> ' +
          '(см. README проекта).</div>';
        return;
      }
      const results = data.results || [];
      if (!results.length) {
        grid.innerHTML = '<div class="gif-empty">Ничего не найдено</div>';
        return;
      }
      grid.innerHTML = '';
      results.forEach((g) => {
        const b = document.createElement('button');
        b.type = 'button';
        const img = document.createElement('img');
        img.src = g.preview || g.url;
        img.loading = 'lazy';
        img.alt = g.title || 'GIF';
        b.appendChild(img);
        b.onclick = () => sendGif(g.url);
        grid.appendChild(b);
      });
    })
    .catch(() => {
      grid.innerHTML = '<div class="gif-empty">Не удалось загрузить GIF. Проверьте соединение.</div>';
    });
}

function sendGif(url) {
  if (!url || !socket) return;
  const replyPayload = replyingTo ? { id: replyingTo.id, name: replyingTo.name, text: replyingTo.text, image: replyingTo.image, gif: replyingTo.gif, voice: replyingTo.voice } : null;
  socket.emit('chat-message', { room, gifUrl: url, replyTo: replyPayload });
  clearReply();
  closeSheet('gifOverlay');
}

/* -----------------------------------------------------------
   Emoji picker (lightweight, no external deps)
   ----------------------------------------------------------- */
const EMOJI_SET = ['😀','😂','😍','😎','🔥','🎬','🍿','👍','❤️','😢','😱','🙌','👏','🤔','😴','🎉'];
function openEmojiPicker() {
  const grid = document.getElementById('emojiGrid');
  grid.innerHTML = '';
  EMOJI_SET.forEach(em => {
    const b = document.createElement('button');
    b.textContent = em;
    b.className = 'ripple-host emoji-pick-btn';
    b.style.cssText = 'font-size:24px; background:var(--surface); border:1px solid var(--border); border-radius:12px; width:48px; height:48px; cursor:pointer;';
    b.onclick = () => {
      const input = document.getElementById('chatInput');
      input.value += em;
      closeSheet('emojiOverlay');
      input.focus();
    };
    grid.appendChild(b);
  });
  openSheet('emojiOverlay');
}


/* -----------------------------------------------------------
   Bottom nav / theater mode / sheets
   ----------------------------------------------------------- */
function setSheetTab(which) {
  const sec = document.getElementById('chatSection');
  if (!sec) return;
  const members = which === 'members';
  sec.classList.toggle('tab-members', members);
  document.getElementById('tabChat').classList.toggle('active', !members);
  document.getElementById('viewerPillBtn').classList.toggle('active', members);
  if (members) renderMembers();
}
function renderMembers() {
  const list = document.getElementById('membersList');
  if (!list) return;
  list.innerHTML = '';
  // Сервер присылает users с аватарками; names — запасной вариант
  let users = roomUsers.length ? roomUsers.slice() : roomAllNames.map((n) => ({ name: n, avatar: '', avatarPhoto: '' }));
  if (!users.length && name) users.push({ name, avatar: avatarEmoji, avatarPhoto: '' });
  users.sort((a, b) => (a.name === name ? -1 : b.name === name ? 1 : a.name.localeCompare(b.name)));
  users.forEach((u) => {
    const mine = u.name === name;
    const row = document.createElement('div');
    row.className = 'member-row';
    const av = document.createElement('div');
    av.className = 'msg-avatar member-avatar';
    renderAvatarEl(av, u.name, mine ? avatarEmoji : (u.avatar || ''), mine ? avatarPhotoUrl(avatarPhoto) : (u.avatarPhoto || ''));
    const nm = document.createElement('span');
    nm.className = 'member-name';
    nm.textContent = u.name + (mine ? ' (вы)' : '');
    const dot = document.createElement('span');
    dot.className = 'member-online';
    dot.title = 'В сети';
    row.append(av, nm, dot);
    list.appendChild(row);
  });
}
function toggleRoomMenu() {
  const menu = document.getElementById('roomMenu');
  const show = !menu.classList.contains('show');
  menu.classList.toggle('show', show);
  document.getElementById('roomMenuBackdrop').classList.toggle('show', show);
}
function closeRoomMenu() {
  document.getElementById('roomMenu').classList.remove('show');
  document.getElementById('roomMenuBackdrop').classList.remove('show');
}
function toggleTheater() {
  const on = document.getElementById('roomRoot').classList.toggle('theater-mode');
  const label = document.getElementById('theaterMenuLabel');
  if (label) label.textContent = on ? 'Обычный экран' : 'Большой экран';
  sizeVideoWrap(window.visualViewport ? window.visualViewport.height : window.innerHeight);
}

function toggleChatMoreMenu() {
  const menu = document.getElementById('chatMoreMenu');
  const backdrop = document.getElementById('chatMoreMenuBackdrop');
  const show = !menu.classList.contains('show');
  menu.classList.toggle('show', show);
  backdrop.classList.toggle('show', show);
  setChatMoreBtnState(show);
}
function closeChatMoreMenu() {
  document.getElementById('chatMoreMenu').classList.remove('show');
  document.getElementById('chatMoreMenuBackdrop').classList.remove('show');
  setChatMoreBtnState(false);
}
function setChatMoreBtnState(open) {
  const btn = document.getElementById('chatMoreBtn');
  const dots = document.getElementById('chatMoreIconDots');
  const close = document.getElementById('chatMoreIconClose');
  if (!btn || !dots || !close) return;
  btn.classList.toggle('active', open);
  dots.style.display = open ? 'none' : '';
  close.style.display = open ? '' : 'none';
}

function openSettings() {
  updateThemeButtons();
  renderAccentSwatches();
  openSheet('settingsOverlay');
}
function openSheet(id) { document.getElementById(id).classList.add('show'); }
function closeSheet(id) { document.getElementById(id).classList.remove('show'); }

function copyRoomCode() {
  if (!room) return;
  if (navigator.clipboard && window.isSecureContext) {
    navigator.clipboard.writeText(room).then(() => showToast('Код комнаты скопирован')).catch(() => fallbackCopy(room));
  } else {
    fallbackCopy(room);
  }
}
function fallbackCopy(text) {
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    showToast(ok ? 'Код комнаты скопирован' : 'Не удалось скопировать код');
  } catch (e) {
    showToast('Не удалось скопировать код');
  }
}

/* -----------------------------------------------------------
   Theme
   ----------------------------------------------------------- */
function setTheme(t) {
  const themes = window.WT_THEMES || {};
  if (!themes[t]) t = 'night';
  document.documentElement.setAttribute('data-theme', t);
  window.WT_ACCENTS = (window.WT_ACCENTS_BY_THEME || {})[t] || window.WT_ACCENTS;
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', themes[t].color);
  try { localStorage.setItem('wt_theme', t); localStorage.removeItem('wt_accent'); } catch (e) {}
  // Смена темы возвращает фирменный акцент этой темы
  applyAccent(themes[t].accent);
  updateThemeButtons();
  renderAccentSwatches();
}
function currentTheme() {
  const t = document.documentElement.getAttribute('data-theme');
  return (window.WT_THEMES || {})[t] ? t : 'night';
}
function updateThemeButtons() {
  const cur = currentTheme();
  document.querySelectorAll('[data-theme-btn]').forEach((b) => {
    b.classList.toggle('active', b.getAttribute('data-theme-btn') === cur);
  });
}

/* -----------------------------------------------------------
   Accent color
   ----------------------------------------------------------- */
function applyAccent(id) {
  const preset = (window.WT_ACCENTS || {})[id];
  if (!preset) return false;
  const root = document.documentElement.style;
  root.setProperty('--primary', preset.primary);
  root.setProperty('--primary-hover', preset.hover);
  root.setProperty('--primary-soft', preset.soft);
  root.setProperty('--primary-ink', preset.ink);
  return true;
}
function setAccent(id) {
  if (!applyAccent(id)) return;
  try { localStorage.setItem('wt_accent', id); } catch (e) {}
  renderAccentSwatches();
}
function renderAccentSwatches() {
  const wrap = document.getElementById('accentSwatches');
  if (!wrap) return;
  const accents = window.WT_ACCENTS || {};
  let current = ((window.WT_THEMES || {})[currentTheme()] || {}).accent || 'violet';
  try { const st = localStorage.getItem('wt_accent'); if (st && accents[st]) current = st; } catch (e) {}
  wrap.innerHTML = '';
  Object.keys(accents).forEach((id) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'accent-swatch ripple-host' + (id === current ? ' active' : '');
    btn.style.background = accents[id].primary;
    btn.setAttribute('aria-label', id);
    btn.onclick = () => setAccent(id);
    wrap.appendChild(btn);
  });
}

/* -----------------------------------------------------------
   Share room
   ----------------------------------------------------------- */
function shareRoom() {
  if (!room) return;
  const url = location.origin + location.pathname + '?room=' + encodeURIComponent(room);
  if (navigator.share) {
    navigator.share({ title: 'Roomly', text: 'Присоединяйся к комнате «' + room + '»', url })
      .catch(() => {});
  } else {
    copyRoomCode();
  }
}

/* -----------------------------------------------------------
   Notifications (sound + browser notification when tab hidden)
   ----------------------------------------------------------- */
function toggleNotifications() {
  if (!notificationsEnabled) {
    if ('Notification' in window && Notification.permission === 'default') {
      Notification.requestPermission().then(perm => {
        notificationsEnabled = true;
        try { localStorage.setItem('wt_notifications', '1'); } catch (e) {}
        updateNotifButton();
        showToast(perm === 'granted' ? 'Уведомления включены' : 'Уведомления включены (звук в приложении)');
        if (perm === 'granted') subscribeToPush();
      });
      return;
    }
    notificationsEnabled = true;
    showToast('Уведомления включены');
    if (Notification.permission === 'granted') subscribeToPush();
  } else {
    notificationsEnabled = false;
    showToast('Уведомления выключены');
    unsubscribeFromPush();
  }
  try { localStorage.setItem('wt_notifications', notificationsEnabled ? '1' : '0'); } catch (e) {}
  updateNotifButton();
}

/* -----------------------------------------------------------
   Push-уведомления (работают, даже если приложение полностью закрыто —
   показ идёт из service worker'а, см. public/sw.js)
   ----------------------------------------------------------- */
function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - base64String.length % 4) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)));
}

async function subscribeToPush() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) return;
  try {
    const reg = await navigator.serviceWorker.ready;
    let sub = await reg.pushManager.getSubscription();
    if (!sub) {
      const res = await fetch('/api/push-public-key');
      const { publicKey } = await res.json();
      sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(publicKey)
      });
    }
    await fetch('/api/push-subscribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ room, name, subscription: sub, clientId })
    });
  } catch (e) {
    console.warn('Не удалось подписаться на push-уведомления:', e.message);
  }
}

async function unsubscribeFromPush() {
  if (!('serviceWorker' in navigator)) return;
  try {
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    if (sub) {
      await fetch('/api/push-unsubscribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ room, name, clientId })
      });
      await sub.unsubscribe();
    }
  } catch (e) {
    console.warn('Не удалось отписаться от push-уведомлений:', e.message);
  }
}

function updateNotifButton() {
  const btn = document.getElementById('notifToggleBtn');
  const iconOn = document.getElementById('notifIconOn');
  const iconOff = document.getElementById('notifIconOff');
  if (!btn) return;
  btn.style.color = notificationsEnabled ? 'var(--primary)' : '';
  btn.style.borderColor = notificationsEnabled ? 'var(--primary)' : '';
  if (iconOn && iconOff) {
    iconOn.style.display = notificationsEnabled ? '' : 'none';
    iconOff.style.display = notificationsEnabled ? 'none' : '';
  }
}
function playPingSound() {
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(880, audioCtx.currentTime);
    gain.gain.setValueAtTime(0.001, audioCtx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.18, audioCtx.currentTime + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.35);
    osc.connect(gain).connect(audioCtx.destination);
    osc.start();
    osc.stop(audioCtx.currentTime + 0.36);
  } catch (e) {}
}
function notifyIncomingMessage(msg) {
  const isMention = !!(msg.mentions && msg.mentions.some((m) => m === name));
  const isReplyToMe = !!(msg.replyTo && msg.replyTo.name === name);

  // Лёгкая вибрация, когда кто-то отвечает именно на ваше сообщение.
  // Работает независимо от настройки уведомлений — это просто тактильный
  // отклик, а не push, и только на устройствах, которые это умеют.
  if (isReplyToMe && navigator.vibrate) {
    navigator.vibrate(35);
  }

  if ((isMention || isReplyToMe) && !document.hidden) {
    // Приложение открыто — упоминание/ответ всё равно заметно нужно показать
    playPingSound();
    showToast(isReplyToMe ? `${msg.name || 'Гость'} ответил(а) вам` : `${msg.name || 'Гость'} упомянул(а) вас`);
  }

  if (!notificationsEnabled) return;
  if (!document.hidden) return; // приложение открыто и на виду — незачем шуметь дальше
  playPingSound();
  if ('Notification' in window && Notification.permission === 'granted') {
    try {
      const title = isReplyToMe
        ? `${msg.name || 'Гость'} ответил(а) вам`
        : (isMention ? `${msg.name || 'Гость'} упомянул(а) вас` : (msg.name || 'Гость') + ' пишет');
      new Notification(title, { body: msg.text || (msg.gifUrl ? '🎞 GIF' : (msg.image ? '📷 Фото' : '')), tag: 'wt-chat-' + room });
    } catch (e) {}
  }
}

/* -----------------------------------------------------------
   Message reactions
   ----------------------------------------------------------- */
const MSG_REACTION_SET = ['👍','❤️','😂','😮','😢','🔥'];

function closeAllReactionPickers() {
  document.querySelectorAll('.msg-react-picker.show').forEach(p => p.classList.remove('show'));
}

function toggleMessageReactionPicker(messageId, btnEl) {
  const row = btnEl.closest('.msg-row');
  let picker = row.querySelector('.msg-react-picker');
  if (!picker) {
    picker = document.createElement('div');
    picker.className = 'msg-react-picker';
    MSG_REACTION_SET.forEach(em => {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = em;
      b.className = 'emoji-pick-btn';
      b.onclick = (ev) => {
        ev.stopPropagation();
        sendMessageReaction(messageId, em);
        triggerEmojiBurst(row.querySelector('.msg-body'), em);
        picker.classList.remove('show');
      };
      picker.appendChild(b);
    });
    row.appendChild(picker);
  }
  const willShow = !picker.classList.contains('show');
  closeAllReactionPickers();
  if (willShow) picker.classList.add('show');
}

function sendMessageReaction(messageId, emoji) {
  if (!socket || !messageId) return;
  socket.emit('message-reaction', { room, messageId, emoji });
}

function triggerEmojiBurst(bodyEl, emoji) {
  const old = bodyEl.querySelector('.msg-heart-burst');
  if (old) old.remove();
  const burst = document.createElement('div');
  burst.className = 'msg-heart-burst';
  burst.textContent = emoji || '❤️';
  bodyEl.appendChild(burst);
  burst.addEventListener('animationend', () => burst.remove());
  // Мягкая пульсация самого пузыря (перезапускаем при повторном тапе)
  bodyEl.classList.remove('msg-pulse');
  void bodyEl.offsetWidth;
  bodyEl.classList.add('msg-pulse');
  setTimeout(() => bodyEl.classList.remove('msg-pulse'), 750);
}
// Оставлено для обратной совместимости — сердце было единственной реакцией с анимацией
function triggerHeartBurst(bodyEl) { triggerEmojiBurst(bodyEl, '❤️'); }

function renderMessageReactions(row, reactions) {
  let box = row.querySelector('.msg-reactions');
  if (!box) {
    box = document.createElement('div');
    box.className = 'msg-reactions';
    row.querySelector('.msg-body').appendChild(box);
  }
  box.innerHTML = '';
  Object.keys(reactions || {}).forEach(emoji => {
    const users = reactions[emoji];
    if (!users || !users.length) return;
    const mine = users.includes(name);
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'reaction-chip' + (mine ? ' mine' : '');
    chip.title = users.join(', ');
    chip.innerHTML = `<span>${emoji}</span><span>${users.length}</span>`;
    chip.onclick = () => {
      sendMessageReaction(row.dataset.id, emoji);
      triggerEmojiBurst(row.querySelector('.msg-body'), emoji);
    };
    box.appendChild(chip);
  });
}

function updateMessageReactions(messageId, reactions) {
  const row = document.querySelector('.msg-row[data-id="' + CSS.escape(messageId) + '"]');
  if (!row) return;
  renderMessageReactions(row, reactions);
}

function leaveRoom() {
  closeSheet('settingsOverlay');
  if (socket) { socket.disconnect(); socket = null; }

  const player = document.getElementById('player');
  player.pause();
  player.removeAttribute('src');
  player.load();
  player.style.display = 'none';
  document.documentElement.style.setProperty('--video-ar', '16/9');
  document.getElementById('noVideo').style.display = 'flex';
  document.getElementById('streamLinkCard').style.display = 'none';
  hideStreamFrame();
  document.getElementById('expandBtn').style.display = 'none';
  document.getElementById('pipBtn').style.display = 'none';
  releaseWakeLock();
  if (document.fullscreenElement) document.exitFullscreen?.();
  exitFakeFullscreen();
  currentStreamLink = null;
  currentExternalVideo = null;
  destroyHlsInstance();
  document.getElementById('videoLoading').classList.remove('show');
  document.getElementById('videoSelect').innerHTML = '<option value="">— выбрать уже загруженное —</option>';
  document.getElementById('uploadProgress').textContent = '';
  clearChatAttachment();
  clearReply();
  closeImageLightbox();

  document.getElementById('chatMessagesInner').innerHTML = '';
  const emptyEl = document.getElementById('chatEmpty');
  if (emptyEl) emptyEl.classList.remove('hide');
  hideTyping();

  document.getElementById('room').style.display = 'none';
  document.getElementById('gate').style.display = 'flex';
  document.body.classList.remove('in-room');
  document.getElementById('roomRoot').classList.remove('theater-mode');
  { const l = document.getElementById('theaterMenuLabel'); if (l) l.textContent = 'Большой экран'; }
  renderRecentRooms();
}

/* -----------------------------------------------------------
   Ручная регулировка высоты видео на мобильном (перетаскиванием)
   ----------------------------------------------------------- */
(function initVideoResize() {
  const handle = document.getElementById('videoResizeHandle');
  if (!handle) return;

  let dragging = false;
  let startY = 0;
  let startVideoH = 0;

  // Те же границы, что использует автоматический расчёт в sizeVideoWrap —
  // руками нельзя схлопнуть видео или чат сильнее, чем позволяет авторежим.
  function getBounds() {
    const appH = window.visualViewport ? window.visualViewport.height : window.innerHeight;
    const kbOpen = document.body.classList.contains('kb-open');
    return { minH: kbOpen ? 90 : 160, maxH: appH * (kbOpen ? 0.62 : 0.72) };
  }

  function currentVideoH() {
    const v = getComputedStyle(document.documentElement).getPropertyValue('--video-h').trim();
    const parsed = parseFloat(v);
    return Number.isNaN(parsed) ? document.getElementById('videoWrap').getBoundingClientRect().height : parsed;
  }

  function moveDrag(clientY) {
    if (!dragging) return;
    const { minH, maxH } = getBounds();
    let h = startVideoH + (clientY - startY);
    h = Math.max(minH, Math.min(h, maxH));
    document.documentElement.style.setProperty('--video-h', h + 'px');
  }

  function endDrag() {
    if (!dragging) return;
    dragging = false;
    handle.classList.remove('dragging');
    const { minH, maxH } = getBounds();
    const h = currentVideoH();
    // Сохраняем не абсолютный пиксель, а долю между minH и maxH — так выбор
    // остаётся осмысленным при повороте экрана, открытии клавиатуры и на
    // другом устройстве, где эти границы отличаются.
    const ratio = maxH > minH ? Math.max(0, Math.min(1, (h - minH) / (maxH - minH))) : 0.5;
    manualVideoRatio = ratio;
    try { localStorage.setItem('wt_video_ratio', ratio.toFixed(3)); } catch (e) {}
  }

  handle.addEventListener('pointerdown', (e) => {
    dragging = true;
    startY = e.clientY;
    startVideoH = currentVideoH();
    handle.classList.add('dragging');
    try { handle.setPointerCapture(e.pointerId); } catch (err) {}
    e.preventDefault();
  });
  handle.addEventListener('pointermove', (e) => moveDrag(e.clientY));
  handle.addEventListener('pointerup', endDrag);
  handle.addEventListener('pointercancel', endDrag);

  // Двойной тап/клик по ручке — сброс к автоматической высоте
  handle.addEventListener('dblclick', () => {
    manualVideoRatio = null;
    try { localStorage.removeItem('wt_video_ratio'); } catch (e) {}
    sizeVideoWrap(window.visualViewport ? window.visualViewport.height : window.innerHeight);
  });
})();

/* -----------------------------------------------------------
   Desktop resizable chat panel
   ----------------------------------------------------------- */
(function initResize() {
  const handle = document.getElementById('resizeHandle');
  if (!handle) return;
  const saved = localStorage.getItem('wt_chat_width');
  if (saved) document.documentElement.style.setProperty('--chat-width', saved + 'px');

  let dragging = false;

  function startDrag(e) {
    dragging = true;
    handle.classList.add('dragging');
    e.preventDefault();
  }
  function moveDrag(clientX) {
    if (!dragging) return;
    const roomBody = document.querySelector('.room-body');
    const rect = roomBody.getBoundingClientRect();
    let w = rect.right - clientX;
    w = Math.max(300, Math.min(560, w));
    document.documentElement.style.setProperty('--chat-width', w + 'px');
  }
  function endDrag() {
    if (!dragging) return;
    dragging = false;
    handle.classList.remove('dragging');
    const w = getComputedStyle(document.documentElement).getPropertyValue('--chat-width').trim();
    localStorage.setItem('wt_chat_width', parseInt(w, 10));
  }

  handle.addEventListener('mousedown', startDrag);
  window.addEventListener('mousemove', (e) => moveDrag(e.clientX));
  window.addEventListener('mouseup', endDrag);
  // if the mouse button is released outside the window, stop dragging on the next move
  window.addEventListener('mousemove', (e) => { if (dragging && e.buttons === 0) endDrag(); });

  handle.addEventListener('touchstart', startDrag, { passive: false });
  window.addEventListener('touchmove', (e) => { if (dragging) moveDrag(e.touches[0].clientX); }, { passive: true });
  window.addEventListener('touchend', endDrag);
  window.addEventListener('touchcancel', endDrag);
})();
