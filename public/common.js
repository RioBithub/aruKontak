const localTime = new Intl.DateTimeFormat('id-ID', {
  timeZone: 'Asia/Jakarta', hour: '2-digit', minute: '2-digit',
});
const localDate = new Intl.DateTimeFormat('id-ID', {
  timeZone: 'Asia/Jakarta', day: 'numeric', month: 'short', year: 'numeric',
});
const pendingMessages = new WeakMap();

export const byId = id => document.getElementById(id);

export function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export function notice(node, message = '', error = false) {
  if (node.textContent !== message) node.textContent = message;
  node.hidden = !message;
  node.classList.toggle('error', error);
}

export async function api(path, body, signal) {
  const timeout = AbortSignal.timeout(12_000);
  const options = { signal: signal ? AbortSignal.any([signal, timeout]) : timeout };
  if (body !== undefined) {
    options.method = 'POST';
    options.headers = { 'Content-Type': 'application/json' };
    options.body = JSON.stringify(body);
  }
  let response;
  try {
    response = await fetch(path, options);
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new Error('Koneksi bermasalah. Coba lagi sebentar.');
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.error || 'Permintaan gagal. Coba lagi sebentar.');
    error.status = response.status;
    throw error;
  }
  return data;
}

export async function postMessage(path, form, payload) {
  const signature = JSON.stringify([path, payload]);
  let pending = pendingMessages.get(form);
  if (pending?.signature !== signature) {
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    const key = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
    pending = { signature, key };
    pendingMessages.set(form, pending);
  }
  const result = await api(path, { ...payload, requestKey: pending.key });
  pendingMessages.delete(form);
  return result;
}

export function timeLabel(timestamp, showDate = false) {
  const date = new Date(timestamp);
  const today = localDate.format(Date.now()) === localDate.format(date);
  const time = element('time', '', showDate && !today ? localDate.format(date) : localTime.format(date));
  time.dateTime = date.toISOString();
  time.title = `${localDate.format(date)} · ${localTime.format(date)} WIB`;
  return time;
}

export function renderMessages(list, chat, perspective, forceScroll = false) {
  const fresh = list.dataset.chat !== String(chat.id);
  const nearBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 75;
  if (fresh) {
    list.replaceChildren();
    list.dataset.chat = chat.id;
  }
  const added = chat.messages.slice(list.children.length);
  if (!added.length) return;
  const fragment = document.createDocumentFragment();
  for (const message of added) {
    const own = message.sender === perspective;
    const item = element('li', 'message');
    item.classList.toggle('own', own);
    item.classList.toggle('auto', message.sender === 'auto');
    const info = element('div', 'message-info');
    const sender = message.sender === 'auto' ? 'Balasan otomatis' : message.senderName;
    info.append(element('strong', '', sender), timeLabel(message.at));
    item.append(info, element('p', '', message.body));
    fragment.append(item);
  }
  list.append(fragment);
  if (fresh || nearBottom || forceScroll) list.scrollTop = list.scrollHeight;
}
