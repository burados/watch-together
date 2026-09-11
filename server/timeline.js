// --- Таймлайн комнаты и "живая" активность ---
// Таймлайн — это компактная история важных событий комнаты (для панели
// "Активность"). Живая активность — короткие тосты о том, что происходит
// прямо сейчас; часть событий таймлайна дублируется туда, часть — нет
// (чтобы не заваливать экран).

const { randomUUID } = require('crypto');

const TIMELINE_LIMIT = 150;

// Эти типы событий одновременно попадают и в таймлайн, и во всплывающий тост.
// Остальные (например REACTION_SENT) видны только в истории — иначе экран
// был бы завален всплывающими уведомлениями на каждую реакцию.
const LIVE_ACTIVITY_TYPES = new Set([
  'USER_JOINED', 'USER_LEFT', 'USER_RECONNECTED',
  'VIDEO_STARTED', 'VIDEO_PAUSED', 'VIDEO_SELECTED', 'VIDEO_CHANGED'
]);

// roomState — это объект rooms[room] из server.js (мутируется на месте).
function addTimelineEvent(io, room, roomState, type, actor, data) {
  if (!roomState.timeline) roomState.timeline = [];
  const event = { id: randomUUID(), type, actor: actor || null, timestamp: Date.now(), data: data || null };
  roomState.timeline.push(event);
  if (roomState.timeline.length > TIMELINE_LIMIT) {
    roomState.timeline = roomState.timeline.slice(-TIMELINE_LIMIT);
  }
  io.to(room).emit('room-timeline-event', event);
  if (LIVE_ACTIVITY_TYPES.has(type)) {
    io.to(room).emit('room-activity', event);
  }
  return event;
}

module.exports = { addTimelineEvent, TIMELINE_LIMIT };
