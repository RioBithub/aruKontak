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

function chatHeaders(code) {
  return code ? { 'X-JRCare-Chat-Code': code } : {};
}

export async function api(path, body, signal, code) {
  const timeout = AbortSignal.timeout(body?.attachment ? 120_000 : 12_000);
  const options = { signal: signal ? AbortSignal.any([signal, timeout]) : timeout, headers: chatHeaders(code) };
  if (body !== undefined) {
    options.method = 'POST';
    options.headers['Content-Type'] = 'application/json';
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

export async function followUpdates(path, { signal, code, onUpdate }) {
  let streaming = false;
  let lastSync = 0;
  let delay = 800;
  const sync = () => {
    if (signal.aborted || document.hidden) return;
    lastSync = Date.now();
    onUpdate();
  };
  const fallback = setInterval(() => {
    if (Date.now() - lastSync >= (streaming ? 8_000 : 1_500)) sync();
  }, 750);
  window.addEventListener('online', sync);
  try {
    while (!signal.aborted) {
      const attempt = new AbortController();
      let timeout = setTimeout(() => attempt.abort(), 10_000);
      try {
        const response = await fetch(path, {
          headers: { Accept: 'text/event-stream', ...chatHeaders(code) }, cache: 'no-store',
          signal: AbortSignal.any([signal, attempt.signal]),
        });
        clearTimeout(timeout);
        if (!response.ok || !response.headers.get('content-type')?.startsWith('text/event-stream')) {
          await response.body?.cancel();
        } else {
          const reader = response.body.getReader();
          const decoder = new TextDecoder();
          let buffer = '';
          while (!signal.aborted) {
            timeout = setTimeout(() => attempt.abort(), 40_000);
            const { value, done } = await reader.read();
            clearTimeout(timeout);
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const end = buffer.lastIndexOf('\n\n');
            if (end < 0) continue;
            const frames = buffer.slice(0, end).split('\n\n');
            buffer = buffer.slice(end + 2);
            streaming = true;
            delay = 800;
            if (frames.includes('data: refresh')) sync();
          }
        }
      } catch {
        // Keep synchronizing through the API while reopening the stream.
      } finally {
        clearTimeout(timeout);
        attempt.abort();
        streaming = false;
      }
      if (signal.aborted) return;
      if (Date.now() - lastSync >= 750) sync();
      await new Promise(resolve => setTimeout(resolve, delay));
      delay = Math.min(delay * 2, 5_000);
    }
  } finally {
    clearInterval(fallback);
    window.removeEventListener('online', sync);
  }
}

export async function postMessage(path, form, payload, code) {
  const { attachment, ...fields } = payload;
  const signature = JSON.stringify([path, fields, attachment?.clientId]);
  let pending = pendingMessages.get(form);
  if (pending?.signature !== signature) {
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    const key = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
    pending = { signature, key };
    pendingMessages.set(form, pending);
  }
  const result = await api(path, { ...payload, requestKey: pending.key }, undefined, code);
  pendingMessages.delete(form);
  return result;
}

const sizes = new Intl.NumberFormat('id-ID', { maximumFractionDigits: 1 });
export function sizeLabel(bytes) {
  return bytes < 1024 * 1024 ? `${sizes.format(Math.max(1, bytes / 1024))} KB` : `${sizes.format(bytes / (1024 * 1024))} MB`;
}

function attachmentButton(file, perspective, code) {
  const button = element('button', 'message-attachment');
  button.type = 'button';
  const icon = element('span', 'file-symbol', file.type.startsWith('image/') ? 'IMG' : 'PDF');
  icon.setAttribute('aria-hidden', 'true');
  const label = element('span');
  const detail = element('small', '', `${sizeLabel(file.size)} · Unduh`);
  label.append(element('strong', '', file.name), detail);
  button.append(icon, label);
  button.setAttribute('aria-label', `Unduh ${file.name}`);
  button.addEventListener('click', async () => {
    button.disabled = true;
    detail.textContent = 'Mengunduh…';
    try {
      const response = await fetch(`/api/${perspective}/attachments/${file.id}`, {
        headers: chatHeaders(code), signal: AbortSignal.timeout(90_000),
      });
      if (!response.ok) throw new Error('Unduh gagal');
      const url = URL.createObjectURL(await response.blob());
      const link = element('a');
      link.href = url;
      link.download = file.name;
      document.body.append(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 30_000);
      detail.textContent = `${sizeLabel(file.size)} · Unduh lagi`;
    } catch {
      detail.textContent = 'Unduh gagal. Coba lagi.';
    } finally { button.disabled = false; }
  });
  return button;
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
    const sender = message.sender === 'auto' ? 'Bot JRCare' : message.senderName;
    const identity = element('span', 'message-identity');
    if (message.sender === 'auto' || (!own && message.sender === 'staff')) {
      const avatar = element('img', 'message-avatar');
      avatar.src = `/assets/jrcare-${message.sender === 'auto' ? 'bot' : 'agent'}.webp`;
      avatar.alt = '';
      avatar.width = avatar.height = 28;
      identity.append(avatar);
    }
    identity.append(element('strong', '', sender));
    info.append(identity, timeLabel(message.at, true));
    item.append(info);
    if (message.body) item.append(element('p', '', message.body));
    if (message.attachment) item.append(attachmentButton(message.attachment, perspective, chat.code));
    fragment.append(item);
  }
  list.append(fragment);
  if (fresh || nearBottom || forceScroll) list.scrollTop = list.scrollHeight;
}
