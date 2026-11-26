import { api, byId, element, followUpdates, notice, postMessage, renderMessages, timeLabel } from './common.js';

const startForm = byId('start-form');
const replyForm = byId('visitor-reply');
const status = byId('visitor-status');
const feedback = byId('visitor-error');
const panel = byId('customer-chat');
const topicButtons = [...document.querySelectorAll('[data-topic]')];
const params = new URLSearchParams(location.search);
const chatPath = code => `/chat#${code}`;
let code = location.pathname === '/chat' ? parseCode(location.hash) : null;
let chat = null;
let readRequest = null;
let refreshPending = false;
let retryTimer = null;
let updates = null;
let viewingHistory = false;
let ready = false;
let connected = true;
let submitting = false;

function parseCode(value) {
  const input = value.trim();
  const candidate = input.replace(/^#/, '');
  if (/^[a-f\d]{32}$/i.test(candidate)) return candidate.toLowerCase();
  try {
    const url = new URL(input, location.origin);
    if (url.origin === location.origin && url.pathname === '/chat' && /^#[a-f\d]{32}$/i.test(url.hash)) {
      return url.hash.slice(1).toLowerCase();
    }
  } catch { /* A malformed input has no chat code. */ }
  return null;
}

function render(forceScroll = false) {
  byId('visitor-loading').hidden = ready;
  byId('visitor-lookup').hidden = !viewingHistory;
  byId('quick-topics').hidden = viewingHistory;
  startForm.hidden = !ready || viewingHistory || Boolean(chat);
  byId('visitor-thread').hidden = !chat;
  if (chat) {
    byId('visitor-code').textContent = chat.code;
    replyForm.hidden = Boolean(chat.closedAt);
    byId('visitor-closed').hidden = !chat.closedAt;
    renderMessages(byId('visitor-messages'), chat, 'visitor', forceScroll);
  }
  let state = 'loading';
  let label = 'Menyambungkan…';
  if (viewingHistory) {
    state = 'ready';
    label = 'Cek percakapan';
  } else if (chat?.closedAt) {
    state = 'closed';
    label = 'Selesai';
  } else if (!connected) {
    state = 'disconnected';
    label = 'Koneksi terputus. Menyambungkan kembali…';
  } else if (chat?.agentName) {
    state = 'active';
    label = `Ditangani oleh ${chat.agentName}`;
  } else if (chat?.botPending) {
    state = 'active';
    label = 'Balasan otomatis';
  } else if (chat) {
    state = 'waiting';
    label = 'Menunggu petugas';
  } else if (ready) {
    state = 'ready';
    label = 'Mulai percakapan';
  }
  panel.dataset.state = state;
  for (const button of topicButtons) button.disabled = !ready || submitting;
  if (status.textContent !== label) status.textContent = label;
}

async function loadHistory(message = '') {
  updates?.abort();
  updates = null;
  chat = null;
  code = null;
  ready = true;
  viewingHistory = true;
  if (location.pathname !== '/riwayat') history.replaceState(null, '', '/riwayat');
  notice(feedback, message, Boolean(message));
  render();
  const historyStatus = byId('history-status');
  try {
    const { chats } = await api('/api/visitor/history');
    const rows = chats.map(item => {
      const link = element('a', 'history-link');
      link.href = chatPath(item.code);
      const details = element('span', 'history-meta', item.closedAt ? 'Selesai' : 'Aktif');
      details.append(timeLabel(item.updatedAt, true));
      link.append(element('strong', '', item.preview || 'Percakapan JRCare'), details);
      const row = element('li');
      row.append(link);
      return row;
    });
    byId('visitor-history').replaceChildren(...rows);
    notice(historyStatus, chats.length ? '' : 'Belum ada chat di browser ini.');
  } catch (error) {
    notice(historyStatus, error.message, true);
  }
}

function connectUpdates() {
  if (updates || !chat || chat.closedAt) return;
  updates = new AbortController();
  void followUpdates('/api/visitor/events', {
    signal: updates.signal,
    code,
    onUpdate: () => void refresh(),
    onDisconnect: () => {
      connected = false;
      render();
    },
    onInvalid: () => void loadHistory('Chat tidak ditemukan. Periksa tautan atau kode chat Anda.'),
  });
}

function showChat(next, forceScroll = false) {
  ready = true;
  connected = true;
  if (next?.closedAt && !code && params.has('baru') && !forceScroll) {
    byId('visitor-name').value = next.name;
  } else if (next) {
    chat = next;
    code = chat.code;
    if (location.pathname !== '/chat' || location.hash !== `#${code}`) history.replaceState(null, '', chatPath(code));
    if (chat.closedAt) {
      updates?.abort();
      updates = null;
    } else connectUpdates();
  }
  render(forceScroll);
}

async function refresh() {
  if (viewingHistory || (chat?.closedAt && ready) || (document.hidden && ready)) return;
  if (readRequest || submitting) {
    refreshPending = true;
    return;
  }
  clearTimeout(retryTimer);
  refreshPending = false;
  const controller = new AbortController();
  readRequest = controller;
  try {
    const data = await api('/api/visitor/chat', undefined, controller.signal, code);
    if (readRequest === controller && !viewingHistory) showChat(data.chat);
  } catch (error) {
    if (readRequest !== controller || viewingHistory) return;
    if (error.status === 404 && code) {
      void loadHistory(error.message);
    } else {
      connected = false;
      render();
      retryTimer = setTimeout(refresh, 3_000);
    }
  } finally {
    if (readRequest === controller) {
      readRequest = null;
      if (refreshPending) void refresh();
    }
  }
}

async function send(event, path, payload) {
  event.preventDefault();
  if (submitting) return;
  readRequest?.abort();
  readRequest = null;
  submitting = true;
  const form = event.currentTarget;
  const button = form.querySelector('[type="submit"]');
  const fields = [...form.querySelectorAll('input, textarea')];
  const buttonLabel = button.textContent;
  button.disabled = true;
  button.textContent = 'Mengirim…';
  form.setAttribute('aria-busy', 'true');
  for (const field of fields) field.readOnly = true;
  notice(feedback);
  render();
  try {
    const result = await postMessage(path, form, payload, code);
    form.reset();
    showChat(result.chat, true);
    if (!chat.closedAt) byId('visitor-message').focus();
  } catch (error) {
    notice(feedback, error.message, true);
  } finally {
    submitting = false;
    button.disabled = false;
    button.textContent = buttonLabel;
    form.removeAttribute('aria-busy');
    for (const field of fields) field.readOnly = false;
    render();
    void refresh();
  }
}

startForm.addEventListener('submit', event => void send(event, '/api/visitor/chat', {
  name: byId('visitor-name').value,
  text: byId('visitor-first').value,
}));
replyForm.addEventListener('submit', event => void send(event, '/api/visitor/message', {
  chatId: chat?.id,
  text: byId('visitor-message').value,
}));

byId('lookup-form').addEventListener('submit', event => {
  event.preventDefault();
  const codeField = byId('lookup-code');
  const entered = parseCode(codeField.value);
  if (entered) location.assign(chatPath(entered));
  else {
    notice(feedback, 'Masukkan tautan JRCare atau kode chat dengan 32 karakter.', true);
    codeField.focus();
  }
});

byId('share-chat').addEventListener('click', async () => {
  const url = new URL(chatPath(chat.code), location.origin).href;
  try {
    await navigator.clipboard.writeText(url);
    notice(feedback, 'Tautan disalin. Simpan untuk membuka chat ini kembali.');
  } catch {
    notice(feedback, 'Salin alamat dari bilah browser atau gunakan kode chat di atas.');
  }
});

for (const [index, button] of topicButtons.entries()) {
  button.addEventListener('click', () => {
    if (!ready || submitting) return;
    if (chat?.closedAt) {
      location.assign(`/?baru=1&topik=${index + 1}`);
      return;
    }
    const draft = byId(chat ? 'visitor-message' : 'visitor-first');
    if (!draft.value.trim() || draft.value === draft.dataset.topicDraft) {
      draft.value = button.dataset.topic;
      draft.dataset.topicDraft = draft.value;
    }
    draft.focus();
  });
}

document.addEventListener('visibilitychange', () => void refresh());
window.addEventListener('hashchange', () => {
  if (location.pathname === '/chat' && parseCode(location.hash) !== code) location.reload();
});
window.addEventListener('pagehide', () => {
  updates?.abort();
  updates = null;
  readRequest?.abort();
  readRequest = null;
  clearTimeout(retryTimer);
});
window.addEventListener('pageshow', event => {
  if (!event.persisted) return;
  if (viewingHistory) void loadHistory();
  else void refresh();
});

if (location.pathname === '/riwayat') void loadHistory();
else if (location.pathname === '/chat' && !code) void loadHistory('Tautan chat belum lengkap. Masukkan kode chat Anda.');
else {
  const topic = topicButtons[Number(params.get('topik')) - 1]?.dataset.topic;
  if (topic) byId('visitor-first').value = topic;
  void refresh();
}
