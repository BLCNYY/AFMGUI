// Chat history lives in this browser's localStorage. Only small image
// thumbnails are stored; full-size images are kept in memory for the turn
// they were sent with.

const CHATS_KEY = 'afmgui.chats.v1';
const PREFS_KEY = 'afmgui.prefs.v1';

function read(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function write(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

export function loadChats() {
  const chats = read(CHATS_KEY, []);
  if (!Array.isArray(chats)) return [];
  // A reply that was mid-stream when the page closed is no longer pending.
  for (const chat of chats) {
    for (const m of chat.messages || []) {
      if (m.pending) {
        delete m.pending;
        if (!m.content && !m.error) m.stopped = true;
      }
    }
  }
  return chats;
}

export function saveChats(chats) {
  const data = chats.map((c) => ({ ...c, messages: c.messages.map(({ pending, ...m }) => m) }));
  if (write(CHATS_KEY, data)) return true;
  // Out of space: drop thumbnails from the oldest chats until it fits.
  const sorted = [...data].sort((a, b) => a.updatedAt - b.updatedAt);
  for (const chat of sorted) {
    let changed = false;
    for (const m of chat.messages) {
      if (m.images?.length) {
        m.images = [];
        m.imagesRemoved = true;
        changed = true;
      }
    }
    if (changed && write(CHATS_KEY, data)) return true;
  }
  return false;
}

export function getPref(name, fallback) {
  const prefs = read(PREFS_KEY, {});
  return name in prefs ? prefs[name] : fallback;
}

export function setPref(name, value) {
  const prefs = read(PREFS_KEY, {});
  prefs[name] = value;
  write(PREFS_KEY, prefs);
}
