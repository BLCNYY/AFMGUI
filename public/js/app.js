import { renderMarkdown, renderInline, appendCaret, escapeHtml } from './markdown.js';
import { prepareImage, isImageFile } from './images.js';
import { dictationSupport, Dictation } from './dictation.js';
import { streamChat, fetchHealth, fetchAppInfo, lookup } from './api.js';
import { loadChats, saveChats, getPref, setPref } from './store.js';
import { attachSquircle } from './squircle.js';

const MAX_IMAGES = 4;
// Rough input budget for the on-device model (~4k token context, leave room
// for the reply). Older turns beyond this are left out before sending.
const CHAR_BUDGET = 11000;
const IMAGE_CHAR_COST = 2500;

const $ = (id) => document.getElementById(id);
const els = {
  app: $('app'),
  sidebar: $('sidebar'),
  scrim: $('scrim'),
  chatList: $('chatList'),
  sidebarToggle: $('sidebarToggle'),
  sidebarToggleInner: $('sidebarToggleInner'),
  tempToggle: $('tempToggle'),
  newChatSide: $('newChatSide'),
  devicesBtn: $('devicesBtn'),
  settingsBtn: $('settingsBtn'),
  settingsDialog: $('settingsDialog'),
  setInstructions: $('setInstructions'),
  setLength: $('setLength'),
  setReasoning: $('setReasoning'),
  setWeb: $('setWeb'),
  setReset: $('setReset'),
  serverStatus: $('serverStatus'),
  topbar: document.querySelector('.topbar'),
  chatTitle: $('chatTitle'),
  banner: $('banner'),
  bannerTitle: $('bannerTitle'),
  bannerDetail: $('bannerDetail'),
  bannerRetry: $('bannerRetry'),
  scroller: $('scroller'),
  thread: $('thread'),
  empty: $('empty'),
  emptyTitle: $('emptyTitle'),
  emptySub: $('emptySub'),
  jump: $('jump'),
  composerWrap: document.querySelector('.composer-wrap'),
  composer: $('composer'),
  attachments: $('attachments'),
  attachBtn: $('attachBtn'),
  fileInput: $('fileInput'),
  input: $('input'),
  modelBtn: $('modelBtn'),
  modelIcon: $('modelIcon'),
  modelLabel: $('modelLabel'),
  modelMenu: $('modelMenu'),
  micBtn: $('micBtn'),
  sendBtn: $('sendBtn'),
  dropOverlay: $('dropOverlay'),
  toasts: $('toasts'),
  devicesDialog: $('devicesDialog'),
  devicesBody: $('devicesBody'),
  lightbox: $('lightbox'),
  lightboxImg: $('lightboxImg'),
  confirmDialog: $('confirmDialog'),
  confirmTitle: $('confirmTitle'),
  confirmText: $('confirmText'),
  confirmOk: $('confirmOk'),
  confirmCancel: $('confirmCancel'),
};

const MODELS = {
  system: {
    label: 'On-device',
    title: 'On-device',
    sub: 'Apple’s Foundation Model, running privately on this Mac',
    icon: 'i-laptop',
  },
  pcc: {
    label: 'Private Cloud',
    title: 'Private Cloud Compute',
    sub: 'A larger Apple model on Private Cloud Compute',
    icon: 'i-cloud',
  },
};
const modelInfo = (name) => MODELS[name] || { label: name, title: name, sub: 'Custom model provider', icon: 'i-cube' };

const byUpdated = (a, b) => b.updatedAt - a.updatedAt;

const state = {
  chats: loadChats().sort(byUpdated),
  currentId: null,
  attachments: [],
  streaming: null,
  health: null,
  models: [{ name: 'system', available: true }],
  model: getPref('model', 'system'),
  fullImages: new Map(), // message id -> full-size data URLs (memory only)
  stick: true,
  healthTimer: 0,
  tempMode: false, // temporary chat: nothing is written to history
  temp: null, // the unsaved chat object while in temporary mode
  editingId: null, // user message being edited
  renamingId: null, // sidebar chat being renamed
  titleJob: null, // AbortController of a running auto-title request
};

const uid = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
const currentChat = () => {
  if (state.temp && state.temp.id === state.currentId) return state.temp;
  return state.chats.find((c) => c.id === state.currentId) || null;
};
const findLast = (arr, fn) => {
  for (let i = arr.length - 1; i >= 0; i--) if (fn(arr[i])) return arr[i];
  return undefined;
};
const isNarrow = () => matchMedia('(max-width: 899px)').matches;

function svgIcon(id, cls = 'i') {
  return `<svg class="${cls}" aria-hidden="true"><use href="#${id}"/></svg>`;
}

function persist() {
  if (!saveChats(state.chats)) toast('Couldn’t save chat history — browser storage is full.');
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function renderAll() {
  renderChatList();
  renderThread();
  updateComposer();
}

let listBusy = false;

function renderChatList() {
  const list = els.chatList;
  // Keep a rename in progress alive across re-renders.
  const oldInput = list.querySelector('.chat-rename');
  const draft = oldInput ? { value: oldInput.value, focused: document.activeElement === oldInput } : null;
  listBusy = true;
  list.textContent = '';
  listBusy = false;
  if (!state.chats.length) {
    const p = document.createElement('div');
    p.className = 'chat-list-empty';
    p.textContent = 'Your chats will appear here.';
    list.append(p);
    return;
  }
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const day = 864e5;
  const groups = [
    ['Today', today],
    ['Yesterday', today - day],
    ['Previous 7 Days', today - 7 * day],
    ['Previous 30 Days', today - 30 * day],
    ['Older', -Infinity],
  ];
  let current = -1;
  let groupEl = null;
  for (const chat of state.chats) {
    const g = groups.findIndex(([, t]) => chat.updatedAt >= t);
    if (g !== current) {
      current = g;
      groupEl = document.createElement('div');
      groupEl.className = 'chat-group';
      const title = document.createElement('div');
      title.className = 'chat-group-title';
      title.textContent = groups[g][0];
      groupEl.append(title);
      list.append(groupEl);
    }
    const item = document.createElement('div');
    item.className = 'chat-item' + (chat.id === state.currentId ? ' active' : '');
    groupEl.append(item);
    if (chat.id === state.renamingId) {
      item.classList.add('renaming');
      const input = renameInput(chat);
      item.append(input);
      if (draft) {
        input.value = draft.value;
        if (draft.focused) input.focus();
      }
      continue;
    }
    const link = document.createElement('button');
    link.type = 'button';
    link.className = 'chat-link';
    link.textContent = chat.title || 'New chat';
    link.title = chat.title || '';
    if (chat.id === state.currentId) link.setAttribute('aria-current', 'page');
    link.addEventListener('click', () => openChat(chat.id));
    const acts = document.createElement('div');
    acts.className = 'chat-acts';
    const edit = document.createElement('button');
    edit.type = 'button';
    edit.className = 'chat-act chat-edit';
    edit.title = 'Rename';
    edit.setAttribute('aria-label', `Rename “${chat.title}”`);
    edit.innerHTML = svgIcon('i-pencil');
    edit.addEventListener('click', () => startRename(chat.id));
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'chat-act chat-del';
    del.title = 'Delete';
    del.setAttribute('aria-label', `Delete “${chat.title}”`);
    del.innerHTML = svgIcon('i-trash');
    del.addEventListener('click', () => deleteChat(chat.id));
    acts.append(edit, del);
    item.append(link, acts);
  }
}

function startRename(id) {
  state.renamingId = id;
  renderChatList();
  const input = els.chatList.querySelector('.chat-rename');
  input?.focus();
  input?.select();
}

function renameInput(chat) {
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'chat-rename';
  input.value = chat.title || '';
  input.maxLength = 80;
  input.enterKeyHint = 'done';
  input.setAttribute('aria-label', 'Chat name');
  let done = false;
  const finish = (save) => {
    if (done || listBusy || !input.isConnected) return;
    done = true;
    const title = input.value.replace(/\s+/g, ' ').trim();
    state.renamingId = null;
    if (save && title && title !== chat.title) {
      chat.title = title;
      chat.titleManual = true; // AFM no longer renames this chat
      persist();
    }
    renderChatList();
    paintTitle();
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      finish(true);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      finish(false);
    }
  });
  input.addEventListener('blur', () => finish(true));
  return input;
}

function paintTitle() {
  const chat = currentChat();
  els.chatTitle.textContent = state.tempMode ? 'Temporary chat' : chat?.title || 'New chat';
  document.title = chat && !state.tempMode ? `${chat.title} – AFM Chat` : 'AFM Chat';
}

function renderThread() {
  const chat = currentChat();
  const msgs = chat ? chat.messages : [];
  els.thread.textContent = '';
  els.empty.hidden = msgs.length > 0;
  els.thread.hidden = msgs.length === 0;
  els.emptyTitle.textContent = state.tempMode ? 'What are you curious about?' : 'How can I help?';
  els.emptySub.hidden = !state.tempMode;
  els.tempToggle.setAttribute('aria-pressed', String(state.tempMode));
  els.tempToggle.dataset.tip = state.tempMode ? 'Turn off temporary chat' : 'Temporary chat';
  const lastAssistant = findLast(msgs, (m) => m.role === 'assistant');
  let prev = 0;
  for (const m of msgs) {
    // A centred time header opens the chat and follows every long pause.
    if (m.role === 'user' && m.createdAt && m.createdAt - prev > STAMP_GAP) els.thread.append(stampEl(m.createdAt));
    prev = m.createdAt || prev;
    const el = messageEl(m, m === lastAssistant);
    if (!m.pending && Date.now() - (m.createdAt || 0) > 1500) el.classList.add('no-anim');
    els.thread.append(el);
  }
  paintTitle();
  if (state.streaming && state.streaming.chat === chat) state.streaming.body = null;
  onScroll();
}

// Swap one message's element in place, without replaying the entrance animation.
function refreshMessage(m) {
  const old = els.thread.querySelector(`[data-id="${m.id}"]`);
  if (!old) return;
  const el = messageEl(m, old.classList.contains('last'));
  el.classList.add('no-anim');
  old.replaceWith(el);
}

function messageEl(m, isLast) {
  const el = document.createElement('article');
  el.className = `msg ${m.role}${isLast ? ' last' : ''}`;
  el.dataset.id = m.id;

  if (m.role === 'user') {
    if (m.images?.length) {
      const wrap = document.createElement('div');
      wrap.className = 'msg-images' + (m.images.length > 1 ? ' multi' : '');
      m.images.forEach((src, i) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.setAttribute('aria-label', 'View image');
        const img = new Image();
        img.src = src;
        img.alt = 'Attached image';
        img.decoding = 'async';
        b.append(img);
        b.addEventListener('click', () => openLightbox(state.fullImages.get(m.id)?.[i] || src));
        wrap.append(b);
      });
      el.append(wrap);
    } else if (m.imagesRemoved) {
      el.append(note('Image removed to save space'));
    }
    if (state.editingId === m.id) {
      el.classList.add('editing');
      el.append(editorEl(m));
      return el;
    }
    if (m.content) {
      const bubble = document.createElement('div');
      bubble.className = 'bubble';
      bubble.textContent = m.content;
      attachSquircle(bubble, { radius: 20 });
      el.append(bubble);
    }
    el.append(userFootEl(m));
    return el;
  }

  if (m.trimmed) el.append(note('Earlier messages were left out to fit the model’s context window.', 'i-alert'));
  const card = document.createElement('div');
  card.className = 'answer';
  const body = document.createElement('div');
  body.className = 'md';
  card.append(body);
  attachSquircle(card, { radius: 20 });
  el.append(card);
  paintBody(body, m.content, Boolean(m.pending));
  if (m.pending) el.setAttribute('aria-busy', 'true');
  if (m.error) el.append(errorEl(m, isLast));
  if (!m.pending && m.content && m.sources?.length) el.append(sourcesEl(m.sources));
  if (!m.pending && (m.content || !m.error)) el.append(footEl(m, isLast));
  return el;
}

function paintBody(body, text, live) {
  const card = body.parentElement?.classList.contains('answer') ? body.parentElement : body;
  if (!text) {
    body.innerHTML = live ? '<div class="typing" role="img" aria-label="Thinking"><span></span><span></span><span></span></div>' : '';
    card.hidden = !live;
    return;
  }
  card.hidden = false;
  body.innerHTML = renderMarkdown(text);
  if (live) appendCaret(body);
}

function note(text, icon) {
  const p = document.createElement('p');
  p.className = 'msg-note';
  p.innerHTML = (icon ? svgIcon(icon) : '') + `<span>${escapeHtml(text)}</span>`;
  return p;
}

function errorEl(m, isLast) {
  const box = document.createElement('div');
  box.className = 'err';
  box.setAttribute('role', 'alert');
  box.innerHTML =
    svgIcon('i-alert') +
    `<div class="err-body"><div class="err-title">${escapeHtml(m.error.title)}</div>` +
    `<div class="err-detail">${renderInline(m.error.detail || '')}</div></div>`;
  if (isLast) {
    const retry = document.createElement('button');
    retry.type = 'button';
    retry.className = 'pill-btn';
    retry.textContent = 'Try again';
    retry.addEventListener('click', () => regenerate(m.id));
    box.querySelector('.err-body').append(retry);
  }
  return box;
}

function footEl(m, isLast) {
  const foot = document.createElement('div');
  foot.className = isLast ? 'msg-foot' : 'msg-foot floaty';
  if (m.versions?.length > 1) foot.append(versionSwitcher(m));
  if (m.content) {
    const copy = actButton('i-copy', 'Copy');
    copy.addEventListener('click', async () => {
      if (await copyText(m.content)) flashCopied(copy);
    });
    foot.append(copy);
  }
  if (isLast && !m.error && state.currentId) {
    const again = actButton('i-refresh', 'Regenerate');
    again.addEventListener('click', () => regenerate(m.id));
    foot.append(again);
  }
  const meta = document.createElement('span');
  meta.className = 'msg-meta';
  if (m.createdAt) {
    const when = new Date(m.createdAt);
    const time = document.createElement('time');
    time.dataset.ts = String(m.createdAt);
    time.dateTime = when.toISOString();
    time.textContent = timeLabel(m.createdAt);
    time.title = `${when.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })} · ${modelInfo(m.model || 'system').title}`;
    meta.append(time);
  }
  const bits = [];
  if (m.stopped) bits.push('Stopped');
  if (m.truncated) bits.push('Reached the length limit');
  if (bits.length) meta.append((m.createdAt ? ' · ' : '') + bits.join(' · '));
  foot.append(meta);
  return foot;
}

// "just now", "3 minutes ago", then the clock time once it is older than 15 minutes.
function timeLabel(ts) {
  const mins = Math.floor((Date.now() - ts) / 60000);
  if (mins < 1) return 'just now';
  if (mins <= 15) return mins === 1 ? '1 minute ago' : `${mins} minutes ago`;
  const then = new Date(ts);
  const now = new Date();
  const clock = then.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  if (then.toDateString() === now.toDateString()) return clock;
  const date = { month: 'short', day: 'numeric' };
  if (then.getFullYear() !== now.getFullYear()) date.year = 'numeric';
  return `${then.toLocaleDateString([], date)}, ${clock}`;
}

const STAMP_GAP = 60 * 60 * 1000;
const clockTime = (ts) => new Date(ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

// "Today 9:41 AM", "Yesterday 9:41 AM", "Monday 9:41 AM", "Mon, Nov 2 at 9:41 AM"
function dayLabel(ts) {
  const then = new Date(ts);
  const now = new Date();
  const startOf = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((startOf(now) - startOf(then)) / 86400000);
  if (days <= 0) return 'Today';
  if (days === 1) return 'Yesterday';
  if (days < 7) return then.toLocaleDateString([], { weekday: 'long' });
  const date = { weekday: 'short', month: 'short', day: 'numeric' };
  if (then.getFullYear() !== now.getFullYear()) date.year = 'numeric';
  return `${then.toLocaleDateString([], date)} at`;
}

function stampEl(ts) {
  const el = document.createElement('div');
  el.className = 'stamp';
  const day = document.createElement('strong');
  day.textContent = dayLabel(ts);
  el.append(day, ` ${clockTime(ts)}`);
  return el;
}

// Under the latest message you sent: "Delivered", then "Read · 9:41 AM" once
// the model starts answering.
function statusEl(m) {
  const msgs = currentChat()?.messages || [];
  if (findLast(msgs, (x) => x.role === 'user') !== m) return null;
  const reply = msgs[msgs.indexOf(m) + 1];
  const el = document.createElement('span');
  el.className = 'status';
  if (m.readAt) {
    const read = document.createElement('strong');
    read.textContent = 'Read';
    const sameDay = new Date(m.readAt).toDateString() === new Date().toDateString();
    el.append(read, ` · ${sameDay ? clockTime(m.readAt) : dayLabel(m.readAt).replace(/ at$/, '')}`);
  } else if (reply?.content) {
    // Answered before read times were recorded.
    const read = document.createElement('strong');
    read.textContent = 'Read';
    el.append(read);
  } else if (reply?.error) {
    el.classList.add('failed');
    el.textContent = 'Not Delivered';
  } else {
    el.textContent = 'Delivered';
  }
  return el;
}

function markRead(chat, asst) {
  const m = chat.messages[chat.messages.indexOf(asst) - 1];
  if (!m || m.role !== 'user') return;
  m.readAt = Date.now();
  paintStatus(chat, m);
}

function paintStatus(chat, m) {
  if (!m || state.currentId !== chat.id) return;
  const old = els.thread.querySelector(`[data-id="${m.id}"] .status`);
  const next = statusEl(m);
  if (old && next) old.replaceWith(next);
}

function refreshTimes() {
  for (const el of els.thread.querySelectorAll('time[data-ts]')) {
    const label = timeLabel(Number(el.dataset.ts));
    if (el.textContent !== label) el.textContent = label;
  }
}

function versionSwitcher(m) {
  const n = m.versions.length;
  const i = Math.min(m.v ?? n - 1, n - 1);
  const wrap = document.createElement('div');
  wrap.className = 'versions';
  const prev = actButton('i-chev-left', 'Previous answer');
  const next = actButton('i-chev-right', 'Next answer');
  prev.disabled = i === 0;
  next.disabled = i === n - 1;
  prev.addEventListener('click', () => switchVersion(m, i - 1));
  next.addEventListener('click', () => switchVersion(m, i + 1));
  const label = document.createElement('span');
  label.className = 'versions-label';
  label.textContent = `${i + 1}/${n}`;
  label.setAttribute('aria-label', `Answer ${i + 1} of ${n}`);
  wrap.append(prev, label, next);
  return wrap;
}

function userFootEl(m) {
  const foot = document.createElement('div');
  foot.className = 'msg-foot user-foot';
  if (m.content) {
    const copy = actButton('i-copy', 'Copy');
    copy.addEventListener('click', async () => {
      if (await copyText(m.content)) flashCopied(copy);
    });
    foot.append(copy);
  }
  const edit = actButton('i-pencil', 'Edit');
  edit.addEventListener('click', () => startEdit(m.id));
  foot.append(edit);
  const status = statusEl(m);
  if (status) foot.append(status);
  else foot.classList.add('floaty');
  return foot;
}

function editorEl(m) {
  const form = document.createElement('form');
  form.className = 'edit-box';
  const ta = document.createElement('textarea');
  ta.className = 'edit-input';
  ta.rows = 1;
  ta.value = m.content || '';
  ta.enterKeyHint = 'send';
  ta.setAttribute('aria-label', 'Edit message');
  const row = document.createElement('div');
  row.className = 'edit-actions';
  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.className = 'pill-btn';
  cancel.textContent = 'Cancel';
  const save = document.createElement('button');
  save.type = 'submit';
  save.className = 'pill-btn primary';
  save.textContent = 'Send';
  row.append(cancel, save);
  form.append(ta, row);
  attachSquircle(form, { radius: 22 });
  const fit = () => {
    ta.style.height = 'auto';
    ta.style.height = `${Math.min(ta.scrollHeight, 260)}px`;
    save.disabled = !ta.value.trim() && !m.images?.length;
  };
  ta.addEventListener('input', fit);
  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      form.requestSubmit();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      cancelEdit();
    }
  });
  cancel.addEventListener('click', cancelEdit);
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    submitEdit(m, ta.value);
  });
  requestAnimationFrame(fit);
  return form;
}

function actButton(icon, label) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'act';
  b.setAttribute('aria-label', label);
  b.title = label;
  b.innerHTML = svgIcon(icon);
  return b;
}

function flashCopied(btn) {
  const use = btn.querySelector('use');
  const label = btn.querySelector('span');
  const prevIcon = use?.getAttribute('href');
  const prevText = label?.textContent;
  use?.setAttribute('href', '#i-check');
  if (label) label.textContent = 'Copied';
  clearTimeout(btn._t);
  btn._t = setTimeout(() => {
    use?.setAttribute('href', prevIcon);
    if (label) label.textContent = prevText;
  }, 1400);
}

// ---------------------------------------------------------------------------
// Scrolling
// ---------------------------------------------------------------------------

function onScroll() {
  const s = els.scroller;
  const distance = s.scrollHeight - s.scrollTop - s.clientHeight;
  state.stick = distance < 64;
  els.jump.hidden = state.stick || els.thread.hidden;
  els.topbar.classList.toggle('scrolled', s.scrollTop > 2);
}

function scrollToBottom(force = false, smooth = false) {
  if (force) state.stick = true;
  if (!state.stick) return;
  els.scroller.scrollTo({ top: els.scroller.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });
  els.jump.hidden = true;
}

// ---------------------------------------------------------------------------
// Chats
// ---------------------------------------------------------------------------

// Throws away the temporary chat, if there is one. Nothing of it was stored.
function dropTemp() {
  const temp = state.temp;
  if (!temp) return;
  if (state.streaming?.chat === temp) state.streaming.controller.abort();
  for (const m of temp.messages) state.fullImages.delete(m.id);
  state.temp = null;
}

function startFresh(tempMode) {
  dropTemp();
  state.tempMode = tempMode;
  state.currentId = null;
  state.editingId = null;
  sessionStorage.removeItem('afmgui.current');
  renderAll();
  els.input.focus({ preventScroll: true });
}

function newChat() {
  startFresh(false);
  closeSidebarIfNarrow();
}

const SWAP_OUT = [
  { opacity: 1, transform: 'scale(1)', filter: 'blur(0px)' },
  { opacity: 0, transform: 'scale(0.97)', filter: 'blur(10px)' },
];
const SWAP_IN = [
  { opacity: 0, transform: 'scale(1.03)', filter: 'blur(10px)' },
  { opacity: 1, transform: 'scale(1)', filter: 'blur(0px)' },
];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

// The view blurs out, switches, and settles back in.
async function toggleTemp() {
  const next = !state.tempMode;
  if (state.swapping) return;
  const targets = [els.scroller, els.chatTitle];
  if (reducedMotion() || !els.scroller.animate) {
    startFresh(next);
    return;
  }
  state.swapping = true;
  els.tempToggle.classList.toggle('turning-on', next);
  const out = targets.map((t) => t.animate(SWAP_OUT, { duration: 170, easing: 'ease-in', fill: 'forwards' }));
  // The timer covers a hidden tab, where animations don't advance.
  await Promise.race([Promise.all(out.map((a) => a.finished)).catch(() => {}), sleep(260)]);
  startFresh(next);
  out.forEach((a) => a.cancel());
  for (const t of targets) t.animate(SWAP_IN, { duration: 420, easing: 'cubic-bezier(0.32, 0.72, 0, 1)' });
  state.swapping = false;
}

function openChat(id) {
  dropTemp();
  state.tempMode = false;
  state.editingId = null;
  state.currentId = id;
  try {
    sessionStorage.setItem('afmgui.current', id);
  } catch {}
  renderAll();
  closeSidebarIfNarrow();
  scrollToBottom(true);
}

function confirmAction({ title, text, label = 'Delete' }) {
  const dlg = els.confirmDialog;
  if (dlg.open) return Promise.resolve(false);
  els.confirmTitle.textContent = title;
  els.confirmText.textContent = text;
  els.confirmOk.textContent = label;
  dlg.returnValue = '';
  return new Promise((resolve) => {
    dlg.addEventListener('close', () => resolve(dlg.returnValue === 'ok'), { once: true });
    dlg.showModal();
    els.confirmCancel.focus();
  });
}

async function deleteChat(id) {
  const target = state.chats.find((c) => c.id === id);
  if (!target) return;
  const ok = await confirmAction({
    title: 'Delete this conversation?',
    text: `“${target.title}” will be deleted from this device.`,
  });
  if (!ok) return;
  const idx = state.chats.findIndex((c) => c.id === id);
  if (idx < 0) return;
  if (state.streaming?.chat.id === id) state.streaming.controller.abort();
  const [chat] = state.chats.splice(idx, 1);
  const wasCurrent = state.currentId === id;
  if (wasCurrent) state.currentId = null;
  persist();
  renderAll();
  toast('Chat deleted', {
    action: {
      label: 'Undo',
      onClick: () => {
        state.chats.push(chat);
        state.chats.sort(byUpdated);
        if (wasCurrent) state.currentId = chat.id;
        persist();
        renderAll();
      },
    },
  });
}

function makeTitle(text, nImages) {
  const t = text.replace(/\s+/g, ' ').trim();
  if (!t) return nImages > 1 ? 'Images' : 'Image';
  if (t.length <= 44) return t;
  const cut = t.slice(0, 44);
  const space = cut.lastIndexOf(' ');
  return `${space > 24 ? cut.slice(0, space) : cut}…`;
}

// ---------------------------------------------------------------------------
// Sending and streaming
// ---------------------------------------------------------------------------

async function send() {
  if (state.streaming) return;
  const text = els.input.value.trim();
  if (state.attachments.some((a) => a.status === 'loading')) {
    toast('Images are still being prepared…');
    return;
  }
  const ready = state.attachments.filter((a) => a.status === 'ready');
  if (!text && !ready.length) return;

  if (dictation?.active) dictation.stop();

  let chat = currentChat();
  if (!chat) {
    chat = { id: uid(), title: makeTitle(text, ready.length), createdAt: Date.now(), updatedAt: Date.now(), messages: [] };
    state.currentId = chat.id;
    if (state.tempMode) {
      // Kept in memory only: never added to the history or to storage.
      state.temp = chat;
    } else {
      state.chats.unshift(chat);
      try {
        sessionStorage.setItem('afmgui.current', chat.id);
      } catch {}
    }
  }
  state.editingId = null;

  const msg = { id: uid(), role: 'user', content: text, createdAt: Date.now() };
  if (ready.length) {
    msg.images = ready.map((a) => a.thumb);
    state.fullImages.set(msg.id, ready.map((a) => a.full));
  }
  chat.messages.push(msg);

  els.input.value = '';
  clearAttachments();
  autosize();
  await generate(chat);
}

// --- Answer versions --------------------------------------------------------
// Regenerating keeps the earlier answers. `m.versions` holds every answer and
// `m.v` is the one on screen; the message's own fields mirror that version.

const VERSION_KEYS = ['content', 'model', 'createdAt', 'stopped', 'truncated', 'trimmed', 'sources'];
const MAX_VERSIONS = 8;

function snapshot(m) {
  const v = {};
  for (const k of VERSION_KEYS) if (m[k] !== undefined) v[k] = m[k];
  return v;
}

function applyVersion(m, i) {
  const v = m.versions[i];
  for (const k of VERSION_KEYS) {
    if (v[k] === undefined) delete m[k];
    else m[k] = v[k];
  }
  delete m.error;
  m.v = i;
}

function switchVersion(m, i) {
  if (m.pending || !m.versions?.[i]) return;
  applyVersion(m, i);
  persist();
  refreshMessage(m);
}

function regenerate(msgId) {
  if (state.streaming) return;
  const chat = currentChat();
  if (!chat) return;
  const idx = chat.messages.findIndex((m) => m.id === msgId);
  if (idx < 0) return;
  const m = chat.messages[idx];
  if (m.content && !m.versions) {
    m.versions = [snapshot(m)];
    m.v = 0;
  }
  chat.messages.splice(idx + 1);
  state.editingId = null;
  generate(chat, m);
}

// --- Editing a sent message -------------------------------------------------

function startEdit(id) {
  if (state.streaming) {
    toast('Wait for the reply to finish, or stop it first.');
    return;
  }
  const chat = currentChat();
  const prev = state.editingId;
  state.editingId = id;
  for (const mid of [prev, id]) {
    const m = mid && chat?.messages.find((x) => x.id === mid);
    if (m) refreshMessage(m);
  }
  const ta = els.thread.querySelector('.edit-input');
  if (!ta) return;
  ta.dispatchEvent(new Event('input'));
  ta.focus();
  ta.setSelectionRange(ta.value.length, ta.value.length);
}

function cancelEdit() {
  const id = state.editingId;
  state.editingId = null;
  const m = currentChat()?.messages.find((x) => x.id === id);
  if (m) refreshMessage(m);
}

// Resends an edited message: everything after it is replaced by a new answer.
function submitEdit(m, value) {
  const chat = currentChat();
  if (!chat || state.streaming) return;
  const idx = chat.messages.indexOf(m);
  const text = value.trim();
  if (idx < 0 || (!text && !m.images?.length)) return;

  const before = { content: m.content, title: chat.title, titledAt: chat.titledAt };
  const removed = chat.messages.splice(idx + 1);
  m.content = text;
  state.editingId = null;
  if (idx === 0 && !chat.titleManual) {
    chat.title = makeTitle(text, m.images?.length || 0);
    chat.titledAt = 0;
  }

  if (removed.length > 1) {
    toast('Later messages were replaced.', {
      action: {
        label: 'Undo',
        onClick: () => {
          if (!chat.messages.includes(m)) return;
          if (state.streaming?.chat === chat) state.streaming.controller.abort();
          m.content = before.content;
          chat.title = before.title;
          chat.titledAt = before.titledAt;
          chat.messages.splice(chat.messages.indexOf(m) + 1, Infinity, ...removed);
          persist();
          renderAll();
          scrollToBottom(true);
        },
      },
    });
  }
  generate(chat);
}

function stop() {
  state.streaming?.controller.abort();
}

function buildMessages(chat, end) {
  const src = chat.messages.slice(0, end);
  const lastUser = findLast(src, (m) => m.role === 'user');
  const out = [];
  for (const m of src) {
    if (m.role === 'assistant') {
      if (m.content) out.push({ role: 'assistant', content: m.content });
      continue;
    }
    // Images are only sent with the turn they were attached to; the model's
    // own reply carries what it saw into later turns.
    const imgs = m === lastUser ? state.fullImages.get(m.id) || m.images || [] : [];
    let content;
    if (imgs.length) {
      content = [];
      if (m.content) content.push({ type: 'text', text: m.content });
      for (const url of imgs) content.push({ type: 'image_url', image_url: { url } });
    } else {
      content = m.content || (m.images?.length || m.imagesRemoved ? '[The user shared an image]' : '');
    }
    const prev = out[out.length - 1];
    // fm serve only honours the last of several user turns in a row, so merge.
    if (prev && prev.role === 'user') prev.content = mergeContent(prev.content, content);
    else out.push({ role: 'user', content });
  }
  return out;
}

function mergeContent(a, b) {
  const parts = (c) => (typeof c === 'string' ? (c ? [{ type: 'text', text: c }] : []) : c);
  const all = [...parts(a), ...parts(b)];
  return all.every((p) => p.type === 'text') ? all.map((p) => p.text).join('\n\n') : all;
}

const costOf = (msg) =>
  typeof msg.content === 'string'
    ? msg.content.length
    : msg.content.reduce((n, p) => n + (p.type === 'text' ? p.text.length : IMAGE_CHAR_COST), 0);

// Index of the first message to send so the input fits the budget. Always
// starts on a user turn and always keeps the latest one.
// --- Settings ---------------------------------------------------------------
// Everything here is off or empty by default, so a fresh install sends the
// model exactly what the user typed.

function requestSettings(model) {
  const instructions = String(getPref('instructions', '')).trim();
  const system = instructions ? [{ role: 'system', content: instructions }] : [];
  const options = {};
  const maxTokens = Number(getPref('maxTokens', 0));
  if (maxTokens > 0) options.max_completion_tokens = maxTokens;
  const effort = getPref('reasoning', '');
  if (effort && model === 'pcc') options.reasoning_effort = effort;
  return { system, options };
}

function plainText(content) {
  if (typeof content === 'string') return content;
  return content.filter((p) => p.type === 'text').map((p) => p.text).join('\n');
}

// Finds Wikipedia passages for the latest question. The model first names the
// article to look for, so a follow-up such as "how old is he?" still works.
async function webLookup(history, model, signal) {
  const last = history[history.length - 1];
  const question = last?.role === 'user' ? plainText(last.content).trim() : '';
  if (question.length < 3) return [];
  if (question.length < 25 && /^(hi|hello|hey|thanks|thank you|ok|okay|merhaba|selam)\b/i.test(question)) return [];
  let query = question;
  const recent = history
    .slice(-5)
    .map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${plainText(m.content).slice(0, 400)}`)
    .join('\n');
  let out = '';
  try {
    await streamChat({
      model,
      messages: [
        {
          role: 'user',
          content: `${recent}\n\nWhich Wikipedia article would best answer the user's last message? Reply with the article title only.`,
        },
      ],
      options: { max_completion_tokens: 24 },
      signal,
      onDelta: (t) => (out += t),
    });
  } catch (err) {
    if (err.name === 'AbortError') throw err;
  }
  out = out.split('\n')[0].replace(/\([^)]*\)/g, '').replace(/["“”*`]/g, '').trim();
  if (out.length >= 2 && out.length <= 80) query = out;
  const lang = /[^\u0000-\u024f]|[ğışçöüİĞŞ]/.test(question) ? (navigator.language || 'en').slice(0, 2).toLowerCase() : 'en';
  // Search for the article and for the question itself, then take the best of both.
  const searches = [...new Set([query, question])].map((q) =>
    lookup(q.slice(0, 200), lang, signal).catch((err) => {
      if (err.name === 'AbortError') throw err;
      return []; // Wikipedia unreachable: answer without it.
    }),
  );
  const lists = await Promise.all(searches);
  const found = [];
  for (let i = 0; i < 3; i++) {
    for (const list of lists) {
      if (list[i] && !found.some((r) => r.url === list[i].url)) found.push(list[i]);
    }
  }
  return found.slice(0, 3);
}

// Puts the passages in front of the latest question, for this request only.
function addLookup(history, found) {
  const last = history[history.length - 1];
  const passages = found.map((r, i) => `[${i + 1}] ${r.title}: ${r.text}`).join('\n\n');
  const wrap = (q) =>
    `Wikipedia search results:\n\n${passages}\n\nAnswer the question below. Use the results above when they help. If they do not contain the answer, ignore them and answer from what you know.\n\nQuestion: ${q}`;
  if (typeof last.content === 'string') last.content = wrap(last.content);
  else {
    const part = last.content.find((p) => p.type === 'text');
    if (part) part.text = wrap(part.text);
  }
}

function sourcesEl(sources) {
  const p = document.createElement('p');
  p.className = 'msg-sources';
  p.append('Wikipedia: ');
  sources.forEach((s, i) => {
    if (i) p.append(' · ');
    const a = document.createElement('a');
    a.href = /^https:\/\//.test(s.url) ? s.url : '#';
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    a.textContent = s.title;
    p.append(a);
  });
  return p;
}

function openSettings() {
  els.setInstructions.value = getPref('instructions', '');
  els.setLength.value = String(getPref('maxTokens', 0));
  els.setReasoning.value = getPref('reasoning', '');
  els.setWeb.checked = Boolean(getPref('web', false));
  els.settingsDialog.showModal();
}

function bindSettings() {
  els.settingsBtn.addEventListener('click', openSettings);
  els.setInstructions.addEventListener('input', () => setPref('instructions', els.setInstructions.value));
  els.setLength.addEventListener('change', () => setPref('maxTokens', Number(els.setLength.value)));
  els.setReasoning.addEventListener('change', () => setPref('reasoning', els.setReasoning.value));
  els.setWeb.addEventListener('change', () => setPref('web', els.setWeb.checked));
  els.setReset.addEventListener('click', () => {
    setPref('instructions', '');
    setPref('maxTokens', 0);
    setPref('reasoning', '');
    setPref('web', false);
    els.settingsDialog.close();
    openSettings();
  });
}

function budgetStart(history) {
  let total = 0;
  let start = history.length - 1;
  for (let i = history.length - 1; i >= 0; i--) {
    total += costOf(history[i]);
    if (total > CHAR_BUDGET && i < history.length - 1) break;
    if (history[i].role === 'user') start = i;
  }
  return start;
}

function nextStart(history, skip) {
  for (let i = skip + 1; i < history.length; i++) {
    if (history[i].role === 'user') return i;
  }
  return -1;
}

// Streams a reply into a new assistant message, or into `target` when an
// existing answer is being regenerated.
async function generate(chat, target) {
  state.titleJob?.abort();
  let asst = target;
  if (asst) {
    for (const k of ['stopped', 'truncated', 'trimmed', 'error', 'sources']) delete asst[k];
    Object.assign(asst, { content: '', model: state.model, createdAt: Date.now(), pending: true });
  } else {
    asst = { id: uid(), role: 'assistant', content: '', model: state.model, createdAt: Date.now(), pending: true };
    chat.messages.push(asst);
  }
  chat.updatedAt = Date.now();
  state.chats.sort(byUpdated);
  persist();

  const controller = new AbortController();
  const run = { controller, chat, msg: asst, body: null };
  state.streaming = run;
  renderAll();
  scrollToBottom(true);

  const reveal = new Revealer((text, live) => paintStreaming(run, text, live));
  const history = buildMessages(chat, chat.messages.indexOf(asst));
  const { system, options } = requestSettings(asst.model);
  let skip = 0;

  try {
    if (getPref('web', false)) {
      const found = await webLookup(history, asst.model, controller.signal);
      if (found.length) {
        addLookup(history, found);
        asst.sources = found.map(({ title, url }) => ({ title, url }));
      }
    }
    skip = budgetStart(history);
    if (skip > 0) asst.trimmed = true;
    for (;;) {
      try {
        const result = await streamChat({
          model: asst.model,
          messages: [...system, ...history.slice(skip)],
          options,
          signal: controller.signal,
          onDelta: (t) => {
            if (!asst.content) markRead(chat, asst);
            asst.content += t;
            reveal.push(asst.content);
          },
        });
        if (result.finishReason === 'length') asst.truncated = true;
        break;
      } catch (err) {
        if (err.kind === 'context' && !asst.content) {
          const next = nextStart(history, skip);
          if (next !== -1) {
            skip = next;
            asst.trimmed = true;
            continue;
          }
        }
        throw err;
      }
    }
  } catch (err) {
    if (err.name === 'AbortError') asst.stopped = true;
    else asst.error = describeError(err, asst.model);
  }

  if (asst.stopped || asst.error) reveal.flush();
  await reveal.drain();

  delete asst.pending;
  asst.createdAt = Date.now();
  if (asst.versions) {
    if (asst.content) {
      asst.versions.push(snapshot(asst));
      if (asst.versions.length > MAX_VERSIONS) asst.versions.shift();
      asst.v = asst.versions.length - 1;
    } else {
      // Nothing came back: keep showing the answer that was there before.
      const failed = asst.error;
      applyVersion(asst, Math.min(asst.v ?? 0, asst.versions.length - 1));
      if (failed) toast(failed.title);
    }
  }
  chat.updatedAt = Date.now();
  if (state.streaming === run) state.streaming = null;
  persist();

  const live = chat.messages.includes(asst);
  if (live && state.currentId === chat.id) {
    refreshMessage(asst);
    if (asst.error) paintStatus(chat, chat.messages[chat.messages.indexOf(asst) - 1]);
    scrollToBottom();
  }
  updateComposer();
  if (live && asst.content && !asst.error) maybeAutoTitle(chat);
}

// --- Chat names written by the model ---------------------------------------
// AFM names a chat after the first exchange and once more after the third.

function maybeAutoTitle(chat) {
  if (chat === state.temp || chat.titleManual) return;
  const turns = chat.messages.filter((m) => m.role === 'user').length;
  const stage = turns >= 3 ? 3 : 1;
  if ((chat.titledAt || 0) >= stage) return;
  autoTitle(chat, stage);
}

async function autoTitle(chat, stage) {
  const lines = [];
  for (const m of chat.messages.slice(0, 6)) {
    const text = (m.content || (m.images?.length ? '[image]' : '')).replace(/\s+/g, ' ').trim();
    if (text) lines.push(`${m.role === 'user' ? 'User' : 'Assistant'}: ${text.slice(0, 320)}`);
  }
  if (!lines.length) return;
  const prompt =
    'Write a short title for the conversation below. Use 2 to 5 words, in the same language as the conversation. ' +
    'Reply with the title only: no quotes, no full stop, no explanation.\n\n' +
    lines.join('\n');
  const onDevice = state.models.some((m) => m.name === 'system' && m.available !== false);
  const job = new AbortController();
  state.titleJob = job;
  let raw = '';
  try {
    await streamChat({
      model: onDevice ? 'system' : state.model,
      messages: [{ role: 'user', content: prompt }],
      signal: job.signal,
      onDelta: (t) => {
        raw += t;
      },
    });
  } catch {
    return; // The first-message title stays; the next milestone tries again.
  } finally {
    if (state.titleJob === job) state.titleJob = null;
  }
  const title = cleanTitle(raw);
  if (!title || chat.titleManual || !state.chats.includes(chat)) return;
  chat.title = title;
  chat.titledAt = stage;
  persist();
  renderChatList();
  paintTitle();
}

function cleanTitle(raw) {
  let t = String(raw).split('\n').find((line) => line.trim()) || '';
  t = t.replace(/[*_`#]/g, '').trim();
  t = t.replace(/^(chat |conversation )?title\s*[:–-]\s*/i, '');
  t = t.replace(/^["'“”‘’«»]+|["'“”‘’«»]+$/g, '').replace(/[.。]+$/, '');
  t = t.replace(/\s+/g, ' ').trim();
  if (!t || t.length > 60 || t.split(' ').length > 9) return '';
  return t;
}

function paintStreaming(run, text, live) {
  if (state.currentId !== run.chat.id) return;
  if (!run.body || !run.body.isConnected) {
    run.body = els.thread.querySelector(`[data-id="${run.msg.id}"] .md`);
  }
  if (!run.body) return;
  paintBody(run.body, text, live);
  scrollToBottom();
}

// Reveals streamed text word by word at a pace that follows the model, so
// large chunks don't pop in all at once.
class Revealer {
  constructor(paint) {
    this.paint = paint;
    this.target = '';
    this.pos = 0;
    this.carry = 0;
    this.raf = 0;
    this.last = 0;
    this.ending = false;
    this.waiters = [];
  }

  push(text) {
    this.target = text;
    if (document.hidden) return this.flush(true);
    this.schedule();
  }

  flush(live = false) {
    this.pos = this.target.length;
    this.paint(this.target, live);
  }

  drain() {
    this.ending = true;
    if (this.pos >= this.target.length || document.hidden) {
      this.pos = this.target.length;
      return Promise.resolve();
    }
    this.schedule();
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  schedule() {
    if (this.raf) return;
    this.last = performance.now();
    this.raf = requestAnimationFrame((t) => this.tick(t));
  }

  tick(now) {
    this.raf = 0;
    const dt = Math.min(64, now - this.last);
    this.last = now;
    const rest = this.target.slice(this.pos);
    const backlog = (rest.match(/\S+/g) || []).length;
    if (backlog > 0) {
      const wordsPerSecond = this.ending ? Math.max(80, backlog * 8) : Math.max(14, backlog * 3.2);
      this.carry += (wordsPerSecond * dt) / 1000;
      const n = Math.floor(this.carry);
      if (n > 0) {
        this.carry -= n;
        this.pos = advanceWords(this.target, this.pos, n);
        this.paint(this.target.slice(0, this.pos), true);
      }
      this.raf = requestAnimationFrame((t) => this.tick(t));
      this.last = now;
      return;
    }
    this.pos = this.target.length;
    this.carry = 0;
    if (this.ending) this.waiters.splice(0).forEach((resolve) => resolve());
  }
}

function advanceWords(s, pos, n) {
  const re = /\s*\S+/y;
  re.lastIndex = pos;
  for (let k = 0; k < n; k++) {
    if (!re.exec(s)) return s.length;
  }
  return re.lastIndex;
}

function describeError(err, model) {
  const name = modelInfo(model).title;
  switch (err.kind) {
    case 'network':
      return {
        title: 'Lost connection to the AFM Chat server',
        detail: 'Make sure the server is still running on your Mac (`npm start`) and that this device is on the same network.',
      };
    case 'fm_unreachable':
      return { title: 'fm serve isn’t running', detail: 'Start it on your Mac with `fm serve`, then try again.' };
    case 'context':
      return {
        title: 'Too long for the model',
        detail: 'This message doesn’t fit in the model’s context window (about 4,000 tokens). Shorten it, attach fewer images, or start a new chat.',
      };
    case 'guardrail':
      return { title: 'The model can’t respond to that', detail: 'Apple’s safety guardrails were triggered. Try rephrasing your message.' };
    case 'unavailable':
      return model === 'pcc'
        ? {
            title: 'Private Cloud Compute isn’t available',
            detail: 'It only works when `fm serve` is started from Terminal.app. Start it there, or switch to On-device.',
          }
        : { title: `${name} isn’t available`, detail: err.message };
    case 'rate':
      return { title: 'Too many requests', detail: `${err.message} Wait a moment and try again.` };
    case 'forbidden':
      return { title: 'Request blocked', detail: err.message };
    default:
      return { title: 'Something went wrong', detail: err.message || 'fm serve returned an unexpected error.' };
  }
}

// ---------------------------------------------------------------------------
// Composer
// ---------------------------------------------------------------------------

function autosize() {
  const t = els.input;
  t.style.height = 'auto';
  t.style.height = `${t.scrollHeight}px`;
}

function updateComposer() {
  const streaming = Boolean(state.streaming);
  const hasContent = els.input.value.trim().length > 0 || state.attachments.some((a) => a.status === 'ready');
  els.sendBtn.classList.toggle('stop', streaming);
  els.sendBtn.disabled = !streaming && !hasContent;
  // Like Messages: the send button takes the dictation button's place once there is something to send.
  const showSend = streaming || hasContent;
  els.sendBtn.hidden = !showSend;
  els.micBtn.hidden = showSend && !els.micBtn.classList.contains('recording');
  els.sendBtn.setAttribute('aria-label', streaming ? 'Stop generating' : 'Send');
  els.sendBtn.querySelector('use').setAttribute('href', streaming ? '#i-stop' : '#i-arrow-up');
  els.attachBtn.setAttribute('aria-disabled', String(state.attachments.length >= MAX_IMAGES));
}

function renderAttachments() {
  const box = els.attachments;
  box.textContent = '';
  box.hidden = state.attachments.length === 0;
  for (const att of state.attachments) {
    const t = document.createElement('div');
    t.className = 'thumb' + (att.status === 'loading' ? ' loading' : '');
    const src = att.thumb || att.preview;
    if (src) {
      const img = new Image();
      img.src = src;
      img.alt = 'Attachment preview';
      img.addEventListener('click', () => openLightbox(att.full || src));
      t.append(img);
    }
    const rm = document.createElement('button');
    rm.type = 'button';
    rm.className = 'thumb-remove';
    rm.setAttribute('aria-label', 'Remove image');
    rm.innerHTML = svgIcon('i-x');
    rm.addEventListener('click', () => removeAttachment(att.id));
    t.append(rm);
    box.append(t);
  }
}

function removeAttachment(id) {
  const att = state.attachments.find((a) => a.id === id);
  if (att?.preview) URL.revokeObjectURL(att.preview);
  state.attachments = state.attachments.filter((a) => a.id !== id);
  renderAttachments();
  updateComposer();
  els.input.focus({ preventScroll: true });
}

function clearAttachments() {
  for (const a of state.attachments) if (a.preview) URL.revokeObjectURL(a.preview);
  state.attachments = [];
  renderAttachments();
}

function addFiles(fileList) {
  const all = [...(fileList || [])];
  const files = all.filter(isImageFile);
  if (!files.length) {
    if (all.length) toast('Only images can be attached.');
    return;
  }
  const room = MAX_IMAGES - state.attachments.length;
  if (room <= 0 || files.length > room) toast(`You can attach up to ${MAX_IMAGES} images.`);
  for (const file of files.slice(0, Math.max(0, room))) {
    const att = { id: uid(), status: 'loading', preview: URL.createObjectURL(file), thumb: null, full: null };
    state.attachments.push(att);
    prepareImage(file)
      .then(({ full, thumb }) => {
        att.full = full;
        att.thumb = thumb;
        att.status = 'ready';
        URL.revokeObjectURL(att.preview);
        att.preview = null;
      })
      .catch(() => {
        state.attachments = state.attachments.filter((a) => a !== att);
        URL.revokeObjectURL(att.preview);
        toast(`Couldn’t read “${file.name || 'image'}”. Try a JPEG or PNG.`);
      })
      .finally(() => {
        renderAttachments();
        updateComposer();
      });
  }
  renderAttachments();
  updateComposer();
}

// ---------------------------------------------------------------------------
// Dictation
// ---------------------------------------------------------------------------

const speech = dictationSupport();
let dictation = null;
let dictBase = null;

function setupDictation() {
  const mic = els.micBtn;
  if (!speech.ok) {
    mic.setAttribute('aria-disabled', 'true');
    mic.dataset.tip = speech.reason;
    mic.setAttribute('aria-label', `Dictate — ${speech.reason}`);
    return;
  }
  dictation = new Dictation(speech.SR, {
    onStart: () => setRecording(true),
    onText: applyTranscript,
    onEnd: () => setRecording(false),
    onError: (message) => toast(message),
  });
}

function toggleDictation() {
  if (!speech.ok) {
    if (speech.insecure) openDevicesDialog({ dictation: true });
    else flashTip(els.micBtn);
    return;
  }
  if (dictation.active) {
    dictation.stop();
    return;
  }
  const v = els.input.value;
  const s = els.input.selectionStart ?? v.length;
  const e = els.input.selectionEnd ?? v.length;
  dictBase = { before: v.slice(0, s), after: v.slice(e) };
  setRecording(true);
  dictation.start();
}

function applyTranscript(text) {
  if (!dictBase) return;
  const { before, after } = dictBase;
  const pre = before && text && !/\s$/.test(before) ? ' ' : '';
  const post = after && text && !/^\s/.test(after) ? ' ' : '';
  els.input.value = before + pre + text + post + after;
  const caret = (before + pre + text).length;
  els.input.setSelectionRange(caret, caret);
  autosize();
  updateComposer();
}

function setRecording(on) {
  els.micBtn.classList.toggle('recording', on);
  els.composer.classList.toggle('dictating', on);
  els.micBtn.setAttribute('aria-pressed', String(on));
  els.micBtn.setAttribute('aria-label', on ? 'Stop dictation' : 'Dictate');
  els.micBtn.dataset.tip = on ? 'Stop dictation' : 'Dictate';
  els.input.placeholder = on ? 'Listening…' : 'Type a message';
  if (!on) dictBase = null;
  updateComposer();
}

function flashTip(el) {
  el.classList.add('show-tip');
  clearTimeout(el._tip);
  el._tip = setTimeout(() => el.classList.remove('show-tip'), 2400);
}

// ---------------------------------------------------------------------------
// Model picker
// ---------------------------------------------------------------------------

function updateModelButton() {
  const info = modelInfo(state.model);
  els.modelLabel.textContent = info.label;
  els.modelIcon.querySelector('use').setAttribute('href', `#${info.icon}`);
  els.modelBtn.setAttribute('aria-label', `Model: ${info.title}`);
  els.modelBtn.title = info.title;
}

function renderModelMenu() {
  const menu = els.modelMenu;
  menu.innerHTML = '<div class="menu-title" aria-hidden="true">Model</div>';
  for (const m of state.models) {
    const info = modelInfo(m.name);
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'menu-item';
    item.setAttribute('role', 'option');
    item.tabIndex = -1;
    item.dataset.model = m.name;
    item.setAttribute('aria-selected', String(m.name === state.model));
    if (!m.available) item.setAttribute('aria-disabled', 'true');
    const sub = m.available
      ? info.sub
      : m.name === 'pcc'
        ? 'Unavailable here. Start fm serve from Terminal.app to use it.'
        : m.reason || 'Unavailable';
    item.innerHTML =
      svgIcon(info.icon) +
      `<span class="mi-text"><span class="mi-title">${escapeHtml(info.title)}</span><span class="mi-sub">${escapeHtml(sub)}</span></span>` +
      svgIcon('i-check', 'i mi-check');
    item.addEventListener('click', () => {
      if (m.available) selectModel(m.name);
    });
    menu.append(item);
  }
}

function openModelMenu() {
  renderModelMenu();
  const menu = els.modelMenu;
  menu.hidden = false;
  const wrap = els.composerWrap.getBoundingClientRect();
  const btn = els.modelBtn.getBoundingClientRect();
  const width = menu.offsetWidth;
  let right = wrap.right - btn.right - 6;
  const leftEdge = wrap.right - right - width;
  if (leftEdge < 12) right = Math.max(12, wrap.right - 12 - width);
  menu.style.right = `${right}px`;
  menu.style.bottom = `${wrap.bottom - btn.top + 8}px`;
  els.modelBtn.setAttribute('aria-expanded', 'true');
  const selected = menu.querySelector('[aria-selected="true"]') || menu.querySelector('.menu-item');
  selected?.focus({ preventScroll: true });
}

function closeModelMenu(refocus = false) {
  if (els.modelMenu.hidden) return;
  els.modelMenu.hidden = true;
  els.modelBtn.setAttribute('aria-expanded', 'false');
  if (refocus) els.modelBtn.focus();
}

function selectModel(name) {
  state.model = name;
  setPref('model', name);
  updateModelButton();
  closeModelMenu();
  els.input.focus({ preventScroll: true });
}

function onMenuKey(e) {
  const items = [...els.modelMenu.querySelectorAll('.menu-item')];
  const i = items.indexOf(document.activeElement);
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    const d = e.key === 'ArrowDown' ? 1 : -1;
    items[(i + d + items.length) % items.length]?.focus();
  } else if (e.key === 'Escape') {
    e.preventDefault();
    closeModelMenu(true);
  } else if (e.key === 'Tab') {
    closeModelMenu();
  }
}

// ---------------------------------------------------------------------------
// Health
// ---------------------------------------------------------------------------

async function pollHealth() {
  clearTimeout(state.healthTimer);
  const h = await fetchHealth();
  state.health = h;
  if (h.ok && h.models.length) {
    state.models = h.models;
    const chosen = h.models.find((m) => m.name === state.model);
    if (!chosen?.available) {
      const fallback = h.models.find((m) => m.available);
      if (fallback && fallback.name !== state.model) {
        state.model = fallback.name;
        updateModelButton();
      }
    }
  }
  renderHealth();
  if (!els.modelMenu.hidden) renderModelMenu();
  state.healthTimer = setTimeout(pollHealth, h.ok ? 30000 : 4000);
}

function renderHealth() {
  const h = state.health;
  const status = els.serverStatus;
  status.classList.toggle('ok', Boolean(h?.ok));
  status.classList.toggle('bad', Boolean(h && !h.ok));
  const label = status.querySelector('.label');
  if (!h) label.textContent = 'Connecting…';
  else if (h.ok) label.textContent = 'Connected to fm serve';
  else if (h.kind === 'network') label.textContent = 'Server unreachable';
  else label.textContent = 'fm serve isn’t running';

  if (!h || h.ok) {
    els.banner.hidden = true;
    return;
  }
  let title;
  let detail;
  if (h.kind === 'network') {
    title = 'Can’t reach the AFM Chat server';
    detail = 'Make sure `npm start` is still running on your Mac. Reconnecting…';
  } else if (h.kind === 'fm_unreachable') {
    title = 'fm serve isn’t running';
    detail = 'Start it on your Mac with `fm serve`. This page reconnects automatically.';
  } else {
    title = 'fm serve isn’t responding';
    detail = h.message || 'Try restarting it with `fm serve`.';
  }
  els.bannerTitle.textContent = title;
  els.bannerDetail.innerHTML = renderInline(detail);
  els.banner.hidden = false;
}

// ---------------------------------------------------------------------------
// Sidebar, dialogs, toasts, clipboard
// ---------------------------------------------------------------------------

function toggleSidebar(open) {
  if (isNarrow()) {
    const next = open ?? !els.app.classList.contains('sidebar-open');
    els.app.classList.toggle('sidebar-open', next);
  } else {
    const collapsed = open === undefined ? !els.app.classList.contains('sidebar-collapsed') : !open;
    els.app.classList.toggle('sidebar-collapsed', collapsed);
    setPref('sidebarCollapsed', collapsed);
  }
}

function closeSidebarIfNarrow() {
  if (isNarrow()) els.app.classList.remove('sidebar-open');
}

function toast(message, { action, duration = 3400 } = {}) {
  while (els.toasts.children.length >= 3) els.toasts.firstElementChild.remove();
  const t = document.createElement('div');
  t.className = 'toast';
  t.setAttribute('role', 'status');
  const span = document.createElement('span');
  span.textContent = message;
  t.append(span);
  const dismiss = () => {
    clearTimeout(timer);
    t.classList.add('out');
    setTimeout(() => t.remove(), 200);
  };
  if (action) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = action.label;
    b.addEventListener('click', () => {
      action.onClick();
      dismiss();
    });
    t.append(b);
  }
  els.toasts.append(t);
  const timer = setTimeout(dismiss, action ? 6000 : duration);
  return dismiss;
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Clipboard API needs a secure context; fall back for plain-HTTP LAN use.
  }
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.setAttribute('readonly', '');
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  ta.style.pointerEvents = 'none';
  document.body.append(ta);
  ta.select();
  let ok = false;
  try {
    ok = document.execCommand('copy');
  } catch {}
  ta.remove();
  if (!ok) toast('Couldn’t copy to the clipboard.');
  return ok;
}

function openLightbox(src) {
  els.lightboxImg.src = src;
  els.lightbox.showModal();
}

async function openDevicesDialog({ dictation = false } = {}) {
  const body = els.devicesBody;
  body.innerHTML = '<p>Loading…</p>';
  els.devicesDialog.showModal();
  closeSidebarIfNarrow();
  const info = await fetchAppInfo();
  const ip = info?.lanAddresses?.[0];
  if (!info) {
    body.innerHTML = '<p>Couldn’t load the server’s network details.</p>';
    return;
  }
  if (!ip) {
    body.innerHTML = '<p>This Mac isn’t on a network right now. Connect to Wi-Fi and try again.</p>';
    return;
  }
  const row = (url) =>
    `<div class="url-row"><span>${escapeHtml(url)}</span><button type="button" class="act" data-copy-url="${escapeHtml(url)}" aria-label="Copy address">${svgIcon('i-copy')}</button></div>`;
  let html = '<p>On the same Wi-Fi, open:</p>' + row(`http://${ip}:${info.httpPort}`);
  if (info.httpsPort) {
    html += `<details${dictation ? ' open' : ''}><summary>Set up dictation</summary><ol>`;
    html += '<li><a href="/ca.crt">Download the profile</a> in Safari on the device.</li>';
    html += '<li>Install it in <strong>Settings › Profile Downloaded</strong>.</li>';
    html += '<li>Turn on <strong>AFMGUI Local CA</strong> in <strong>Settings › General › About › Certificate Trust Settings</strong>.</li>';
    html += `<li>Open the secure address:${row(`https://${ip}:${info.httpsPort}`)}</li>`;
    html += '</ol></details>';
  }
  body.innerHTML = html;
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

function bindEvents() {
  els.composer.addEventListener('submit', (e) => {
    e.preventDefault();
    if (state.streaming) stop();
    else send();
  });

  els.input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.altKey && !e.isComposing && e.keyCode !== 229) {
      e.preventDefault();
      if (!state.streaming) send();
    } else if (e.key === 'Escape') {
      if (dictation?.active) dictation.stop();
      else if (state.streaming) stop();
    }
  });

  els.input.addEventListener('input', (e) => {
    // Typing while dictating hands control back to the keyboard.
    if (dictation?.active && e.isTrusted) dictation.stop();
    autosize();
    updateComposer();
  });

  els.attachBtn.addEventListener('click', () => {
    if (state.attachments.length >= MAX_IMAGES) {
      toast(`You can attach up to ${MAX_IMAGES} images.`);
      return;
    }
    els.fileInput.click();
  });
  els.fileInput.addEventListener('change', () => {
    addFiles(els.fileInput.files);
    els.fileInput.value = '';
  });

  document.addEventListener('paste', (e) => {
    const files = [...(e.clipboardData?.files || [])].filter(isImageFile);
    if (!files.length) return;
    const text = e.clipboardData.getData('text/plain');
    if (!text || e.target !== els.input) e.preventDefault();
    addFiles(files);
  });

  let dragDepth = 0;
  const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
  window.addEventListener('dragenter', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dragDepth++;
    els.dropOverlay.hidden = false;
    els.composer.classList.add('dragging');
  });
  window.addEventListener('dragover', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  });
  window.addEventListener('dragleave', (e) => {
    if (!hasFiles(e)) return;
    dragDepth = Math.max(0, dragDepth - 1);
    if (!dragDepth) {
      els.dropOverlay.hidden = true;
      els.composer.classList.remove('dragging');
    }
  });
  window.addEventListener('drop', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dragDepth = 0;
    els.dropOverlay.hidden = true;
    els.composer.classList.remove('dragging');
    addFiles(e.dataTransfer.files);
  });

  els.micBtn.addEventListener('click', toggleDictation);

  els.modelBtn.addEventListener('click', () => {
    if (els.modelMenu.hidden) openModelMenu();
    else closeModelMenu();
  });
  els.modelMenu.addEventListener('keydown', onMenuKey);
  document.addEventListener('pointerdown', (e) => {
    if (!els.modelMenu.hidden && !els.modelMenu.contains(e.target) && !els.modelBtn.contains(e.target)) closeModelMenu();
  });
  window.addEventListener('resize', () => closeModelMenu());

  els.scroller.addEventListener('scroll', onScroll, { passive: true });
  els.jump.addEventListener('click', () => scrollToBottom(true, true));

  els.thread.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-copy-code]');
    if (!btn) return;
    const code = btn.closest('.code-block')?.querySelector('code')?.textContent || '';
    if (await copyText(code)) flashCopied(btn);
  });

  els.sidebarToggle.addEventListener('click', () => toggleSidebar(true));
  els.sidebarToggleInner.addEventListener('click', () => toggleSidebar(false));
  els.scrim.addEventListener('click', () => toggleSidebar(false));
  els.tempToggle.addEventListener('click', toggleTemp);
  els.newChatSide.addEventListener('click', newChat);
  els.devicesBtn.addEventListener('click', () => openDevicesDialog());
  bindSettings();
  els.bannerRetry.addEventListener('click', pollHealth);

  for (const dlg of [els.devicesDialog, els.settingsDialog, els.lightbox]) {
    dlg.addEventListener('click', (e) => {
      if (e.target === dlg || e.target.closest('[data-close]')) dlg.close();
    });
  }
  els.devicesBody.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-copy-url]');
    if (b && (await copyText(b.dataset.copyUrl))) flashCopied(b);
  });

  document.addEventListener('keydown', (e) => {
    const mod = e.metaKey || e.ctrlKey;
    if (mod && e.shiftKey && e.key.toLowerCase() === 'o') {
      e.preventDefault();
      newChat();
    }
  });

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) return;
    pollHealth();
    refreshTimes();
  });
  setInterval(refreshTimes, 20000);
  window.addEventListener('online', pollHealth);

  new ResizeObserver(() => {
    document.querySelector('.main').style.setProperty('--composer-h', `${els.composerWrap.offsetHeight}px`);
    scrollToBottom();
  }).observe(els.composerWrap);

  // Keep the conversation clear of the status banner.
  new ResizeObserver(() => {
    const h = els.banner.hidden ? 0 : els.banner.offsetHeight + 8;
    document.querySelector('.main').style.setProperty('--banner-h', `${h}px`);
  }).observe(els.banner);

  // Text re-wraps when the field's width changes (sidebar, rotation, first layout).
  let inputWidth = 0;
  new ResizeObserver((entries) => {
    const w = Math.round(entries[0].contentRect.width);
    if (w !== inputWidth) {
      inputWidth = w;
      autosize();
    }
  }).observe(els.input);
}

// On iPhone/iPad the on-screen keyboard doesn't resize the page; Safari pans
// it instead, pushing the header and conversation off-screen. Size the app to
// the visible area so everything stays above the keyboard.
function setupViewport() {
  const vv = window.visualViewport;
  if (!vv) return;
  const root = document.documentElement;
  const sync = () => {
    if (vv.scale > 1.01) return; // user is pinch-zooming; leave layout alone
    root.style.setProperty('--app-h', `${Math.round(vv.height)}px`);
    if (window.scrollY || vv.offsetTop) window.scrollTo(0, 0);
  };
  vv.addEventListener('resize', sync);
  vv.addEventListener('scroll', sync);
  sync();
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

function init() {
  setupViewport();
  if (getPref('sidebarCollapsed', false)) els.app.classList.add('sidebar-collapsed');
  const remembered = sessionStorage.getItem('afmgui.current');
  if (remembered && state.chats.some((c) => c.id === remembered)) state.currentId = remembered;

  // A reload in the middle of a regeneration leaves an empty answer: show the
  // version that was selected before.
  for (const chat of state.chats) {
    for (const m of chat.messages) {
      if (m.versions?.length) applyVersion(m, Math.min(m.v ?? 0, m.versions.length - 1));
    }
  }

  attachSquircle(els.composer, { radius: 26, smoothing: 0.6 });

  setupDictation();
  updateModelButton();
  bindEvents();
  renderAll();
  autosize();
  scrollToBottom(true);
  pollHealth();
  if (!matchMedia('(hover: none)').matches) els.input.focus({ preventScroll: true });
}

init();
