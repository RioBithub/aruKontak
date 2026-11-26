import { api, byId, element, followUpdates, notice, postMessage, renderMessages, timeLabel } from './common.js';

const startForm = byId('start-form');
const replyForm = byId('visitor-reply');
const choicePanel = byId('visitor-choices');
const messageInput = byId('visitor-message');
const status = byId('visitor-status');
const feedback = byId('visitor-error');
const panel = byId('customer-chat');
const leaveDialog = byId('leave-dialog');
const leaveForm = byId('leave-form');
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
let resume = null;
let resumeTimer = null;
let startingNew = false;
let leaveDestination = '/';
let leaving = false;

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

function renderChoices(choices) {
  const key = JSON.stringify(choices);
  if (choicePanel.dataset.options !== key) {
    const buttons = choices.map(({ code, label }) => {
      const button = element('button', 'secondary small', `${code} — ${label}`);
      button.type = 'button';
      button.dataset.choice = code;
      return button;
    });
    choicePanel.replaceChildren(...buttons);
    choicePanel.dataset.options = key;
  }
  choicePanel.hidden = !choices.length;
  for (const button of choicePanel.children) button.disabled = submitting;
  messageInput.placeholder = choices.length ? 'Ketik kode pilihan atau tulis pertanyaan' : 'Tulis pesan Anda';
}

function render(forceScroll = false) {
  const choices = chat?.choices ?? [];
  const saved = !viewingHistory && !chat ? resume : null;
  byId('visitor-loading').hidden = ready;
  byId('visitor-lookup').hidden = !viewingHistory;
  byId('quick-topics').hidden = viewingHistory || Boolean(choices.length) || Boolean(saved && !startingNew);
  byId('visitor-resume').hidden = !saved;
  startForm.hidden = !ready || viewingHistory || Boolean(chat) || (Boolean(saved) && !startingNew);
  if (saved) {
    const link = byId('resume-link');
    link.href = chatPath(saved.code);
    link.textContent = saved.closedAt ? 'Buka riwayat chat' : 'Kembali ke chat';
    const time = timeLabel(saved.expiresAt);
    byId('resume-until').textContent = `Bisa dibuka dari sini sampai ${time.title}.`;
    byId('resume-new').hidden = startingNew;
  }
  byId('visitor-thread').hidden = !chat;
  if (chat) {
    byId('visitor-code').textContent = chat.code;
    replyForm.hidden = Boolean(chat.closedAt);
    byId('visitor-closed').hidden = !chat.closedAt;
    byId('leave-chat').hidden = Boolean(chat.closedAt);
    byId('leave-chat').disabled = submitting;
    renderMessages(byId('visitor-messages'), chat, 'visitor', forceScroll);
  }
  renderChoices(choices);
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
    label = choices.length ? 'Pilih layanan' : 'Balasan otomatis';
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
  clearTimeout(resumeTimer);
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
    if (readRequest === controller && !viewingHistory) {
      resume = data.resume ?? null;
      clearTimeout(resumeTimer);
      if (resume) resumeTimer = setTimeout(() => {
        resume = null;
        render();
        void refresh();
      }, resume.remainingMs);
      showChat(data.chat);
    }
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

async function send(form, path, payload, clearDraft = true) {
  if (submitting) return;
  readRequest?.abort();
  readRequest = null;
  submitting = true;
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
    if (clearDraft) form.reset();
    showChat(result.chat, true);
    if (!chat.closedAt) messageInput.focus();
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

startForm.addEventListener('submit', event => {
  event.preventDefault();
  void send(startForm, '/api/visitor/chat', {
    name: byId('visitor-name').value,
    phone: byId('visitor-phone').value,
    email: byId('visitor-email').value,
    text: byId('visitor-first').value,
  });
});
replyForm.addEventListener('submit', event => {
  event.preventDefault();
  void send(replyForm, '/api/visitor/message', { chatId: chat?.id, text: messageInput.value });
});
choicePanel.addEventListener('click', event => {
  const choice = event.target.closest('[data-choice]');
  if (choice && chat?.botPending) {
    void send(replyForm, '/api/visitor/message', { chatId: chat.id, text: choice.dataset.choice }, false);
  }
});

byId('resume-new').addEventListener('click', () => {
  startingNew = true;
  render();
  byId('visitor-name').focus();
});

function askToLeave(destination) {
  leaveDestination = destination;
  notice(byId('leave-note'));
  leaveDialog.showModal();
  byId('cancel-leave').focus();
}

byId('leave-chat').addEventListener('click', () => askToLeave('/'));
byId('cancel-leave').addEventListener('click', () => leaveDialog.close());
leaveDialog.addEventListener('cancel', event => {
  if (leaving) event.preventDefault();
});
for (const link of document.querySelectorAll('.site-bar a')) {
  link.addEventListener('click', event => {
    if (!chat || chat.closedAt || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    if (!submitting) askToLeave(link.getAttribute('href'));
  });
}

leaveForm.addEventListener('submit', async event => {
  event.preventDefault();
  if (leaving || !chat) return;
  leaving = true;
  const buttons = [...leaveForm.querySelectorAll('button')];
  for (const button of buttons) button.disabled = true;
  try {
    await api('/api/visitor/leave', { chatId: chat.id }, undefined, code);
    location.assign(leaveDestination);
  } catch (error) {
    notice(byId('leave-note'), error.message, true);
  } finally {
    leaving = false;
    for (const button of buttons) button.disabled = false;
  }
});

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
  clearTimeout(resumeTimer);
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
