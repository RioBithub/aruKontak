import { api, byId, notice, postMessage, renderMessages } from './common.js';

const startForm = byId('start-form');
const replyForm = byId('visitor-reply');
const status = byId('visitor-status');
const feedback = byId('visitor-error');
let chat = null;
let readRequest = null;
let ready = false;
let connected = true;
let newChat = false;
let submitting = false;

function render(forceScroll = false) {
  const showingForm = ready && (!chat || (newChat && chat.closedAt));
  const showingThread = chat && !showingForm;
  startForm.hidden = !showingForm;
  byId('visitor-thread').hidden = !showingThread;
  if (showingThread) {
    replyForm.hidden = Boolean(chat.closedAt);
    byId('visitor-closed').hidden = !chat.closedAt;
    renderMessages(byId('visitor-messages'), chat, 'visitor', forceScroll);
  }
  let label = 'Menyambungkan…';
  if (!connected) label = 'Koneksi terputus. Menyambungkan kembali…';
  else if (showingForm) label = 'Mulai percakapan';
  else if (chat?.closedAt) label = 'Selesai';
  else if (chat?.agentName) label = `Ditangani oleh ${chat.agentName}`;
  else if (chat) label = 'Menunggu petugas';
  if (status.textContent !== label) status.textContent = label;
}

async function refresh() {
  if (readRequest || submitting || document.hidden) return;
  const controller = new AbortController();
  readRequest = controller;
  try {
    const data = await api('/api/visitor/chat', undefined, controller.signal);
    if (readRequest !== controller) return;
    chat = data.chat;
    ready = true;
    connected = true;
    if (chat && !chat.closedAt) newChat = false;
    render();
  } catch {
    if (readRequest !== controller) return;
    connected = false;
    render();
  } finally {
    if (readRequest === controller) readRequest = null;
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
  button.disabled = true;
  for (const field of fields) field.readOnly = true;
  notice(feedback);
  try {
    const result = await postMessage(path, form, payload);
    chat = result.chat;
    connected = true;
    newChat = false;
    form.reset();
    render(true);
    if (!chat.closedAt) byId('visitor-message').focus();
  } catch (error) {
    notice(feedback, error.message, true);
  } finally {
    submitting = false;
    button.disabled = false;
    for (const field of fields) field.readOnly = false;
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
byId('new-chat').addEventListener('click', () => {
  newChat = true;
  byId('visitor-name').value = chat.name;
  notice(feedback);
  render();
  byId('visitor-first').focus();
});

document.addEventListener('visibilitychange', refresh);
setInterval(refresh, 2_000);
void refresh();
