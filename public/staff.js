import { api, byId, element, followUpdates, notice, postMessage, renderMessages, timeLabel } from './common.js';

const authForms = ['login', 'setup', 'change'].map(name => byId(`${name}-form`));
const navButtons = [...document.querySelectorAll('[data-view]')];
const filterButtons = [...document.querySelectorAll('[data-filter]')];
const statusFilters = {
  active: chat => !chat.closedAt,
  unassigned: chat => !chat.closedAt && !chat.assigneeId,
  closed: chat => Boolean(chat.closedAt),
};
const queue = byId('queue-list');
const assignment = byId('assign-select');
const officeNote = byId('office-notice');
const authNote = byId('auth-error');
const rulesNote = byId('rules-note');
const dialog = byId('password-dialog');
const connectionMessage = 'Koneksi terputus. Menyambungkan kembali…';
const agentStatus = { pending: 'Belum aktif', temporary: 'Menunggu aktivasi', active: 'Aktif' };
const agentList = byId('agent-list');
const autoRouting = byId('routing-enabled');
const acceptingChats = byId('agent-accepting');
const presenceLabel = byId('agent-presence-label');
const setupToken = byId('setup-token');
let activationCode = new URLSearchParams(location.hash.slice(1)).get('siapkan');
if (activationCode !== null) history.replaceState(null, '', location.pathname + location.search);
if (activationCode && (activationCode.length < 32 || activationCode.length > 128)) activationCode = null;

let user = null;
let view = 'inbox';
let viewVersion = 0;
let agents = [];
let chats = [];
let filter = 'active';
let selectedId = null;
let selectedChat = null;
let queueKey = '';
let agentOptionsKey = '';
let readRequest = null;
let inboxDirty = false;
let inboxUpdates = null;
let inboxRetry = null;
let teamRequest = null;
let presenceRequest = null;
let lastPresence = null;
let working = false;
let scrollAfterSend = false;

function cancelRead() {
  readRequest?.abort();
  readRequest = null;
  inboxDirty = false;
  clearTimeout(inboxRetry);
  teamRequest?.abort();
  teamRequest = null;
}

function selectChat(id) {
  if (id === selectedId) return;
  cancelRead();
  selectedId = id;
  selectedChat = null;
  byId('staff-reply').reset();
  byId('staff-messages').replaceChildren();
  delete byId('staff-messages').dataset.chat;
  byId('assignment-history').open = false;
  renderQueue();
  renderThread();
  void refreshInbox();
}

function initials(name) {
  return name.trim().split(/\s+/u).slice(0, 2).map(word => Array.from(word)[0]).join('').toLocaleUpperCase('id-ID');
}

function renderQueue() {
  const visible = chats.filter(statusFilters[filter]);
  for (const button of filterButtons) {
    const key = button.dataset.filter;
    button.setAttribute('aria-pressed', String(filter === key));
    byId(`count-${key}`).textContent = chats.filter(statusFilters[key]).length;
  }
  const key = JSON.stringify([filter, selectedId, visible]);
  if (key === queueKey) return;
  queueKey = key;
  const focused = queue.contains(document.activeElement) ? document.activeElement.dataset.chat : null;
  const scroll = queue.scrollTop;
  const rows = visible.map(chat => {
    const button = element('button', 'queue-item');
    button.type = 'button';
    button.dataset.chat = chat.id;
    if (chat.id === selectedId) button.setAttribute('aria-current', 'true');
    const heading = element('span', 'queue-item-top');
    heading.append(element('strong', '', chat.name), timeLabel(chat.updatedAt, true));
    const label = chat.closedAt ? 'Selesai' : chat.agentName || queueLabel(chat);
    const avatar = element('span', 'chat-avatar', initials(chat.name));
    avatar.setAttribute('aria-hidden', 'true');
    const badge = element('span', 'queue-meta', label);
    badge.dataset.chatStatus = chat.closedAt ? 'closed' : chat.agentName ? 'assigned' : chat.routingState === 'hold' ? 'hold' : 'waiting';
    const content = element('span', 'queue-content');
    content.append(heading, element('span', 'queue-preview', chat.preview), badge);
    button.append(avatar, content);
    return button;
  });
  queue.replaceChildren(...(rows.length ? rows : [element('p', 'queue-empty',
    filter === 'closed' ? 'Belum ada chat selesai.' : 'Belum ada chat dalam daftar ini.')]));
  queue.scrollTop = scroll;
  if (focused) queue.querySelector(`[data-chat="${focused}"]`)?.focus({ preventScroll: true });
}

function queueLabel(chat) {
  if (chat.routingState === 'bot') return 'Balasan otomatis';
  return chat.routingState === 'hold' ? 'Ditahan admin' : 'Menunggu agen';
}

function renderAssignmentEvents(chat) {
  const history = byId('assignment-history');
  const events = chat.assignmentEvents ?? [];
  history.hidden = user.role !== 'admin' || !events.length;
  const key = `${chat.id}:${chat.assignmentVersion}`;
  if (history.dataset.version === key) return;
  history.dataset.version = key;
  const rows = events.map(event => {
    const label = {
      auto: `Ditugaskan otomatis ke ${event.agent}`,
      manual: `${event.actor} memilih ${event.agent}`,
      hold: `${event.actor} menahan chat di antrean`,
      queue: `${event.actor} mengembalikan chat ke antrean otomatis`,
      offline: `Kembali ke antrean karena ${event.previousAgent} terputus`,
    }[event.kind];
    const row = element('li');
    row.append(timeLabel(event.at, true), element('span', '', label));
    return row;
  });
  byId('assignment-events').replaceChildren(...rows);
}

function renderThread() {
  byId('inbox').dataset.threadOpen = String(Boolean(selectedId));
  byId('thread-empty').hidden = Boolean(selectedChat);
  byId('thread-view').hidden = !selectedChat;
  if (!selectedChat) {
    byId('thread-empty').querySelector('p').textContent = selectedId ? 'Memuat percakapan…' : 'Pilih chat dari kotak masuk.';
    return;
  }
  const { name, agentName, assigneeId, closedAt } = selectedChat;
  byId('thread-avatar').textContent = initials(name);
  byId('thread-name').textContent = name;
  byId('thread-status').textContent = closedAt ? 'Selesai' : agentName ? `Ditugaskan ke ${agentName}` : queueLabel(selectedChat);
  byId('thread-tools').hidden = Boolean(closedAt);
  byId('staff-reply').hidden = Boolean(closedAt);
  if (user.role === 'admin') {
    const botPending = selectedChat.routingState === 'bot';
    const options = JSON.stringify([botPending, agents.map(({ id, name, status }) => [id, name, status])]);
    if (options !== agentOptionsKey) {
      const choices = agents.map(agent => new Option(agent.status === 'active' ? agent.name : `${agent.name} · ${agentStatus[agent.status]}`, agent.id));
      assignment.replaceChildren(new Option('Antrean otomatis', ''), new Option('Tahan di antrean', 'hold'), ...choices);
      if (botPending) {
        const bot = new Option('Balasan otomatis', 'bot');
        bot.disabled = true;
        assignment.prepend(bot);
      }
      agentOptionsKey = options;
    }
    assignment.disabled = working || !agents.length || Boolean(assigneeId && !agents.some(agent => agent.id === assigneeId));
    const state = selectedChat.routingState;
    const value = assigneeId ? String(assigneeId) : ['bot', 'hold'].includes(state) ? state : '';
    if (assignment.value !== value) assignment.value = value;
  }
  renderAssignmentEvents(selectedChat);
  renderMessages(byId('staff-messages'), selectedChat, 'staff', scrollAfterSend);
}

async function refreshInbox() {
  if (!user || view !== 'inbox' || working || document.hidden) return;
  if (readRequest) {
    inboxDirty = true;
    return;
  }
  inboxDirty = false;
  clearTimeout(inboxRetry);
  const controller = new AbortController();
  const path = selectedId ? `/api/staff/inbox?chat=${selectedId}` : '/api/staff/inbox';
  readRequest = controller;
  try {
    const data = await api(path, undefined, controller.signal);
    if (readRequest !== controller) return;
    if (officeNote.textContent === connectionMessage) notice(officeNote);
    chats = data.chats;
    selectedChat = data.chat;
    if (selectedId && !selectedChat) {
      selectedId = null;
      byId('staff-reply').reset();
      byId('staff-messages').replaceChildren();
      delete byId('staff-messages').dataset.chat;
    }
    renderQueue();
    renderThread();
    scrollAfterSend = false;
  } catch (error) {
    if (readRequest !== controller) return;
    if (error.status === 401) endSession();
    else {
      notice(officeNote, connectionMessage, true);
      inboxRetry = setTimeout(refreshInbox, 3_000);
    }
  } finally {
    if (readRequest === controller) {
      readRequest = null;
      if (inboxDirty) void refreshInbox();
    }
  }
}

function connectInbox() {
  if (inboxUpdates) return;
  inboxUpdates = new AbortController();
  void followUpdates('/api/staff/events', {
    signal: inboxUpdates.signal,
    onUpdate: () => void refreshInbox(),
    onDisconnect: () => notice(officeNote, connectionMessage, true),
    onInvalid: () => endSession(),
  });
}

function disconnectInbox() {
  inboxUpdates?.abort();
  inboxUpdates = null;
}

async function openView(next) {
  if (working) return;
  cancelRead();
  view = next;
  const version = ++viewVersion;
  for (const button of navButtons) {
    byId(button.dataset.view).hidden = button.dataset.view !== next;
    if (button.dataset.view === next) button.setAttribute('aria-current', 'page');
    else button.removeAttribute('aria-current');
  }
  notice(officeNote);
  if (view === 'inbox') {
    renderQueue();
    renderThread();
    connectInbox();
    void refreshInbox();
  } else disconnectInbox();
  if (user.role !== 'admin') return;
  if (view === 'agents') {
    byId('agent-form').hidden = true;
    byId('routing-form').hidden = true;
  }
  if (view === 'rules') byId('rules-form').hidden = true;
  try {
    if (view === 'rules') {
      const { rules } = await api('/api/staff/rules');
      if (version !== viewVersion) return;
      fillRules(rules);
      byId('rules-form').hidden = false;
    } else {
      const data = await api('/api/staff/agents');
      if (version !== viewVersion) return;
      agents = data.agents;
      if (view === 'agents') applyTeam(data);
      else renderThread();
    }
  } catch (error) {
    if (version !== viewVersion) return;
    if (error.status === 401) endSession();
    else notice(officeNote, error.message, true);
  }
}

function showSession(staff, setup = 'complete') {
  user = staff;
  if (setup !== 'ready') {
    activationCode = null;
    setupToken.value = '';
  }
  const signedIn = user && !user.mustChangePassword;
  byId('auth').hidden = Boolean(signedIn);
  byId('office').hidden = !signedIn;
  byId('agent-presence').hidden = !(signedIn && user.role === 'agent');
  byId('staff-account').hidden = !user;
  byId('account-name').textContent = user?.name ?? '';
  for (const form of authForms) form.hidden = true;
  if (signedIn) {
    for (const action of document.querySelectorAll('[data-admin]')) action.hidden = user.role !== 'admin';
    void openView('inbox');
    if (user.role === 'agent') void syncPresence();
    return;
  }

  const title = byId('auth-title');
  const intro = byId('auth-intro');
  if (user?.mustChangePassword) {
    title.textContent = 'Aktifkan akun agen';
    intro.textContent = `Halo, ${user.name}. Pilih sandi baru dengan minimal 12 karakter.`;
    byId('change-form').hidden = false;
  } else if (setup === 'ready') {
    title.textContent = 'Aktivasi admin JRCare';
    intro.textContent = activationCode
      ? 'Pilih sandi minimal 12 karakter untuk akun admin.'
      : 'Gunakan tautan aktivasi atau masukkan kode sekali pakai dari pengelola VPS. Setelah aktivasi, masuk dengan nama pengguna admin dan sandi pilihan Anda.';
    byId('setup-code-field').hidden = Boolean(activationCode);
    setupToken.value = activationCode ?? '';
    byId('setup-form').hidden = false;
  } else if (setup === 'waiting') {
    title.textContent = 'Aktivasi admin JRCare';
    intro.textContent = 'Hubungi pengelola VPS untuk mendapatkan tautan aktivasi admin.';
  } else {
    title.textContent = 'Masuk portal petugas';
    intro.textContent = 'Gunakan akun petugas JRCare Anda.';
    byId('login-form').hidden = false;
  }
}

function endSession(message = 'Sesi berakhir. Silakan masuk kembali.') {
  cancelRead();
  disconnectInbox();
  presenceRequest?.abort();
  presenceRequest = null;
  lastPresence = null;
  acceptingChats.checked = false;
  acceptingChats.disabled = true;
  presenceLabel.textContent = 'Menyambungkan…';
  delete presenceLabel.dataset.ready;
  ++viewVersion;
  chats = [];
  agents = [];
  queueKey = '';
  agentOptionsKey = '';
  selectedId = null;
  selectedChat = null;
  filter = 'active';
  scrollAfterSend = false;
  queue.replaceChildren();
  assignment.replaceChildren();
  byId('staff-messages').replaceChildren();
  delete byId('staff-messages').dataset.chat;
  agentList.replaceChildren();
  byId('assignment-events').replaceChildren();
  delete byId('assignment-history').dataset.version;
  byId('keywords').replaceChildren();
  byId('menu-choices').replaceChildren();
  for (const id of ['staff-reply', 'agent-form', 'routing-form', 'rules-form']) byId(id).reset();
  if (dialog.open) dialog.close();
  showSession(null);
  notice(authNote, message, Boolean(message));
}

async function loadSession() {
  try {
    const { user: staff, setup } = await api('/api/staff/session');
    showSession(staff, setup);
  } catch (error) {
    byId('auth-intro').textContent = 'Muat ulang halaman untuk mencoba kembali.';
    notice(authNote, error.message, true);
  }
}

for (const form of authForms) {
  form.addEventListener('submit', async event => {
    event.preventDefault();
    const submit = form.querySelector('[type="submit"]');
    if (submit.disabled) return;
    submit.disabled = true;
    notice(authNote);
    const name = form.id.split('-')[0];
    const action = name === 'change' ? 'password' : name;
    try {
      const { user: staff } = await api(`/api/staff/${action}`, Object.fromEntries(new FormData(form)));
      form.reset();
      showSession(staff);
    } catch (error) {
      if (name === 'change' && error.status === 401) endSession(error.message);
      else {
        notice(authNote, error.message, true);
        if (name === 'setup' && error.status === 403 && activationCode) {
          activationCode = null;
          showSession(null, 'ready');
          setupToken.focus();
        }
        if (name === 'setup' && error.status === 409) void loadSession();
      }
    } finally { submit.disabled = false; }
  });
}

async function operate(button, task, feedback = officeNote) {
  if (working) return;
  cancelRead();
  working = true;
  button.disabled = true;
  notice(feedback);
  try { await task(); } catch (error) {
    if (error.status === 401) endSession();
    else notice(feedback, error.message, true);
  } finally {
    working = false;
    button.disabled = false;
    if (view === 'inbox') {
      renderThread();
      void refreshInbox();
    }
  }
}

byId('logout').addEventListener('click', event => void operate(event.currentTarget, async () => {
  await api('/api/staff/logout', {});
  endSession('');
}, user?.mustChangePassword ? authNote : officeNote));

for (const button of navButtons) button.addEventListener('click', () => void openView(button.dataset.view));
for (const button of filterButtons) button.addEventListener('click', () => {
  if (working) return;
  filter = button.dataset.filter;
  if (selectedChat && !statusFilters[filter](selectedChat)) selectChat(null);
  else renderQueue();
});
queue.addEventListener('click', event => {
  const button = event.target.closest('[data-chat]');
  if (!button || working) return;
  selectChat(Number(button.dataset.chat));
  const back = byId('thread-back');
  if (back.getClientRects().length) back.focus();
});

byId('thread-back').addEventListener('click', () => {
  if (working) return;
  selectChat(null);
  byId('queue-title').focus();
});

const staffReply = byId('staff-reply');
staffReply.addEventListener('submit', event => {
  event.preventDefault();
  if (!selectedChat || selectedChat.closedAt) return;
  void operate(staffReply.querySelector('[type="submit"]'), async () => {
    const message = byId('staff-message');
    message.readOnly = true;
    try {
      await postMessage(`/api/staff/chats/${selectedId}/message`, staffReply, { text: message.value });
      staffReply.reset();
      scrollAfterSend = true;
    } finally { message.readOnly = false; }
  });
});

assignment.addEventListener('change', () => {
  if (!selectedChat) return;
  const hold = assignment.value === 'hold';
  const agentId = assignment.value && !hold ? Number(assignment.value) : null;
  void operate(assignment, async () => {
    await api(`/api/staff/chats/${selectedId}/assign`, { agentId, hold, expectedVersion: selectedChat.assignmentVersion });
    if (filter === 'unassigned' && agentId) filter = 'active';
  });
});

byId('close-chat').addEventListener('click', event => {
  if (!selectedChat || !window.confirm('Selesaikan chat ini? Pelanggan dapat memulai chat baru.')) return;
  void operate(event.currentTarget, async () => {
    await api(`/api/staff/chats/${selectedId}/close`, {});
    filter = 'closed';
  });
});

function readiness(agent) {
  if (agent.status !== 'active') return agentStatus[agent.status];
  if (!agent.online) return 'Offline';
  if (!agent.accepting) return 'Jeda';
  return agent.activeChats < agent.capacity ? 'Siap' : 'Penuh';
}

function newAgentRow(agent) {
  const row = element('li', 'agent-row');
  row.dataset.row = agent.id;
  const info = element('div', 'agent-info');
  info.append(element('strong', '', agent.name), element('small'));
  const form = element('form', 'capacity-form');
  form.method = 'post';
  form.dataset.capacity = agent.id;
  const label = element('label', '', 'Kapasitas');
  const input = element('input');
  input.type = 'number';
  input.min = 1;
  input.max = 20;
  input.required = true;
  input.setAttribute('aria-label', `Kapasitas chat ${agent.name}`);
  label.append(input);
  const save = element('button', 'secondary small', 'Simpan');
  save.type = 'submit';
  save.setAttribute('aria-label', `Simpan kapasitas ${agent.name}`);
  form.append(label, save);
  const reset = element('button', 'secondary small');
  reset.type = 'button';
  reset.dataset.agent = agent.id;
  row.append(info, form, reset);
  agentList.append(row);
  return row;
}

function renderAgents() {
  const rows = new Map([...agentList.children].map(row => [Number(row.dataset.row), row]));
  for (const agent of agents) {
    const row = rows.get(agent.id) ?? newAgentRow(agent);
    rows.delete(agent.id);
    const summary = row.querySelector('small');
    const label = `${agent.username} · ${readiness(agent)} · ${agent.activeChats}/${agent.capacity} chat`;
    if (summary.textContent !== label) summary.textContent = label;
    const input = row.querySelector('input');
    const capacity = String(agent.capacity);
    if (input.defaultValue !== capacity) {
      if (input.value === input.defaultValue) input.value = capacity;
      input.defaultValue = capacity;
    }
    const reset = row.querySelector('[data-agent]');
    const action = agent.status === 'pending' ? 'Buat sandi sementara' : 'Atur ulang sandi';
    if (reset.textContent !== action) {
      reset.textContent = action;
      reset.setAttribute('aria-label', `${action} untuk ${agent.name}`);
    }
  }
  for (const row of rows.values()) row.remove();
}

function applyTeam(data) {
  agents = data.agents;
  if (autoRouting.checked === autoRouting.defaultChecked) autoRouting.checked = data.autoAssign;
  autoRouting.defaultChecked = data.autoAssign;
  renderAgents();
  byId('agent-form').hidden = false;
  byId('routing-form').hidden = false;
}

async function refreshTeam() {
  if (view !== 'agents' || user?.role !== 'admin' || working || teamRequest || document.hidden) return;
  const controller = new AbortController();
  teamRequest = controller;
  try {
    const data = await api('/api/staff/agents', undefined, controller.signal);
    if (teamRequest === controller) {
      applyTeam(data);
      if (officeNote.textContent === connectionMessage) notice(officeNote);
    }
  } catch (error) {
    if (teamRequest !== controller) return;
    if (error.status === 401) endSession();
    else notice(officeNote, connectionMessage, true);
  } finally {
    if (teamRequest === controller) teamRequest = null;
  }
}

async function syncPresence(accepting) {
  if (user?.role !== 'agent' || user.mustChangePassword || presenceRequest) return;
  const controller = new AbortController();
  presenceRequest = controller;
  acceptingChats.disabled = true;
  try {
    const body = accepting === undefined ? {} : { accepting };
    const { presence } = await api('/api/staff/presence', body, controller.signal);
    if (presenceRequest !== controller) return;
    lastPresence = presence;
    acceptingChats.checked = presence.accepting;
    const status = readiness(presence);
    const label = `${status} · ${presence.activeChats}/${presence.capacity} chat`;
    if (presenceLabel.textContent !== label) presenceLabel.textContent = label;
    presenceLabel.dataset.ready = String(status === 'Siap');
  } catch (error) {
    if (presenceRequest !== controller) return;
    if (error.status === 401) endSession();
    else {
      acceptingChats.checked = Boolean(lastPresence?.accepting);
      presenceLabel.textContent = connectionMessage;
      delete presenceLabel.dataset.ready;
    }
  } finally {
    if (presenceRequest === controller) {
      presenceRequest = null;
      acceptingChats.disabled = false;
    }
  }
}

acceptingChats.addEventListener('change', () => void syncPresence(acceptingChats.checked));

byId('routing-form').addEventListener('submit', event => {
  event.preventDefault();
  void operate(event.currentTarget.querySelector('[type="submit"]'), async () => {
    applyTeam(await api('/api/staff/routing', { enabled: autoRouting.checked }));
    notice(officeNote, 'Pengaturan penugasan tersimpan.');
  });
});

agentList.addEventListener('submit', event => {
  const form = event.target.closest('[data-capacity]');
  if (!form) return;
  event.preventDefault();
  const capacity = form.querySelector('input').valueAsNumber;
  void operate(form.querySelector('[type="submit"]'), async () => {
    applyTeam(await api(`/api/staff/agents/${form.dataset.capacity}/capacity`, { capacity }));
    notice(officeNote, 'Kapasitas agen tersimpan.');
  });
});

const agentForm = byId('agent-form');
agentForm.addEventListener('submit', event => {
  event.preventDefault();
  void operate(agentForm.querySelector('[type="submit"]'), async () => {
    const { agent } = await api('/api/staff/agents', Object.fromEntries(new FormData(agentForm)));
    agents.push(agent);
    agentForm.reset();
    renderAgents();
    notice(officeNote, `Akun ${agent.name} dibuat.`);
  });
});

agentList.addEventListener('click', event => {
  const button = event.target.closest('[data-agent]');
  if (!button || working) return;
  const agent = agents.find(item => item.id === Number(button.dataset.agent));
  if (agent.status !== 'pending' && !window.confirm(`Atur ulang sandi ${agent.name}? Sesi masuk sebelumnya akan berakhir.`)) return;
  void operate(button, async () => {
    const data = await api(`/api/staff/agents/${agent.id}/password`, {});
    agents = agents.map(item => item.id === agent.id ? data.agent : item);
    renderAgents();
    byId('temporary-username').textContent = data.agent.username;
    byId('temporary-password').textContent = data.temporaryPassword;
    notice(byId('password-note'));
    dialog.showModal();
  });
});

dialog.addEventListener('close', () => {
  byId('temporary-password').textContent = '';
  byId('temporary-username').textContent = '';
});
byId('copy-password').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(`Nama pengguna: ${byId('temporary-username').textContent}\nSandi sementara: ${byId('temporary-password').textContent}`);
    notice(byId('password-note'), 'Kredensial disalin.');
  } catch { notice(byId('password-note'), 'Pilih teks kredensial untuk menyalinnya.', true); }
});
byId('copy-link').addEventListener('click', async () => {
  const url = new URL('/', location.origin).href;
  try {
    await navigator.clipboard.writeText(url);
    notice(officeNote, 'Tautan pelanggan disalin.');
  } catch { notice(officeNote, url); }
});

function addKeyword({ keyword = '', text = '', match = 'exact', handoff = false } = {}) {
  const row = byId('keyword-template').content.firstElementChild.cloneNode(true);
  row.querySelector('.keyword-word').value = keyword;
  row.querySelector('.keyword-reply').value = text;
  row.querySelector('.keyword-match').value = match;
  row.querySelector('.keyword-action').value = handoff ? 'handoff' : 'reply';
  byId('keywords').append(row);
  byId('add-keyword').disabled = byId('keywords').children.length >= 20;
  byId('example-menu').hidden = true;
  return row;
}

function updateChoiceControls() {
  const rows = byId('menu-choices').children;
  byId('add-choice').disabled = rows.length >= 20;
  for (const row of rows) row.querySelector('.remove-choice').disabled = rows.length === 1;
}

function addChoice({ code = '', label = '', prompt = '' } = {}) {
  const row = byId('choice-template').content.firstElementChild.cloneNode(true);
  row.querySelector('.choice-code').value = code;
  row.querySelector('.choice-label').value = label;
  row.querySelector('.choice-prompt').value = prompt;
  byId('menu-choices').append(row);
  return row;
}

function showAutomationMode() {
  const guided = byId('automation-mode').value === 'two-message';
  const guidedSettings = byId('guided-settings');
  const customSettings = byId('custom-settings');
  guidedSettings.hidden = guidedSettings.disabled = !guided;
  customSettings.hidden = customSettings.disabled = guided;
  byId('away-hint').textContent = guided
    ? 'Pesan di luar jam layanan ditambahkan ke balasan pertama.'
    : 'Pesan di luar jam layanan menggantikan sapaan pada chat baru.';
}

function fillRules({ mode, menu, welcome, away, handoff, keywords }) {
  byId('automation-mode').value = mode;
  byId('menu-greeting').value = menu.greeting;
  byId('menu-fallback').value = menu.fallback;
  byId('menu-waiting').value = menu.waiting;
  byId('menu-choices').replaceChildren();
  for (const choice of menu.choices) addChoice(choice);
  updateChoiceControls();
  byId('welcome-enabled').checked = welcome.enabled;
  byId('welcome-text').value = welcome.text;
  byId('away-enabled').checked = away.enabled;
  byId('away-text').value = away.text;
  byId('open-start').value = away.start;
  byId('open-end').value = away.end;
  byId('handoff-mode').value = handoff;
  for (const checkbox of byId('open-days').querySelectorAll('input')) checkbox.checked = away.days.includes(Number(checkbox.value));
  byId('keywords').replaceChildren();
  byId('add-keyword').disabled = false;
  byId('example-menu').hidden = false;
  for (const rule of keywords) addKeyword(rule);
  showAutomationMode();
}

byId('automation-mode').addEventListener('change', showAutomationMode);
byId('add-choice').addEventListener('click', () => {
  addChoice().querySelector('input').focus();
  updateChoiceControls();
});
byId('menu-choices').addEventListener('click', event => {
  if (!event.target.matches('.remove-choice')) return;
  event.target.closest('.menu-choice').remove();
  updateChoiceControls();
  byId('add-choice').focus();
});
byId('add-keyword').addEventListener('click', () => addKeyword().querySelector('input').focus());
byId('example-menu').addEventListener('click', () => {
  byId('welcome-enabled').checked = true;
  byId('welcome-text').value = 'Halo, selamat datang di JRCare.\nBalas 1 untuk pengajuan santunan, 2 untuk status pengajuan, atau 0 untuk bicara dengan petugas.';
  byId('handoff-mode').value = 'rules';
  addKeyword({ keyword: '1', text: 'Petugas akan membantu pertanyaan Anda tentang pengajuan santunan. Anda bisa melanjutkan pertanyaan di sini.', handoff: true });
  addKeyword({ keyword: '2', text: 'Petugas akan membantu pertanyaan Anda tentang status pengajuan. Anda bisa melanjutkan pertanyaan di sini.', handoff: true });
  addKeyword({ keyword: '0', text: 'Baik, chat Anda diteruskan ke antrean petugas.', handoff: true });
  byId('handoff-mode').focus();
});
byId('keywords').addEventListener('click', event => {
  if (!event.target.matches('.remove-keyword')) return;
  event.target.closest('.keyword-row').remove();
  byId('add-keyword').disabled = false;
  byId('example-menu').hidden = Boolean(byId('keywords').children.length);
  byId('add-keyword').focus();
});
function automationSettings(mode) {
  if (mode === 'two-message') {
    return {
      menu: {
        greeting: byId('menu-greeting').value,
        fallback: byId('menu-fallback').value,
        waiting: byId('menu-waiting').value,
        choices: [...byId('menu-choices').children].map(row => ({
          code: row.querySelector('.choice-code').value,
          label: row.querySelector('.choice-label').value,
          prompt: row.querySelector('.choice-prompt').value,
        })),
      },
    };
  }
  return {
    welcome: { enabled: byId('welcome-enabled').checked, text: byId('welcome-text').value },
    handoff: byId('handoff-mode').value,
    keywords: [...byId('keywords').children].map(row => ({
      keyword: row.querySelector('.keyword-word').value,
      text: row.querySelector('.keyword-reply').value,
      match: row.querySelector('.keyword-match').value,
      handoff: row.querySelector('.keyword-action').value === 'handoff',
    })),
  };
}

byId('rules-form').addEventListener('submit', event => {
  event.preventDefault();
  const button = event.currentTarget.querySelector('[type="submit"]');
  void operate(button, async () => {
    const mode = byId('automation-mode').value;
    const { rules } = await api('/api/staff/rules', {
      mode,
      ...automationSettings(mode),
      away: {
        enabled: byId('away-enabled').checked,
        text: byId('away-text').value,
        start: byId('open-start').value,
        end: byId('open-end').value,
        days: [...byId('open-days').querySelectorAll('input:checked')].map(day => Number(day.value)),
      },
    });
    fillRules(rules);
    notice(rulesNote, 'Balasan otomatis tersimpan.');
  }, rulesNote);
});

document.addEventListener('visibilitychange', refreshInbox);
document.addEventListener('visibilitychange', () => {
  if (document.hidden) return;
  void refreshTeam();
  void syncPresence();
});
window.addEventListener('pagehide', disconnectInbox);
window.addEventListener('pageshow', event => {
  if (event.persisted && user && !user.mustChangePassword && view === 'inbox') connectInbox();
});
setInterval(refreshTeam, 5_000);
setInterval(syncPresence, 20_000);
void loadSession();
