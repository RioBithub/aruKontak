import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { isIP } from 'node:net';
import { parseArgs, promisify } from 'node:util';
import * as store from './store.mjs';
import { validateRules } from './rules.mjs';

const { values: args } = parseArgs({
  options: { host: { type: 'string' }, port: { type: 'string' }, strictPort: { type: 'boolean' } },
});
const host = args.host || process.env.HOST || '127.0.0.1';
const port = Number(args.port || process.env.PORT || 3000);
const setupToken = process.env.JRCARE_SETUP_TOKEN || '';
const publicOrigin = process.env.JRCARE_ORIGIN ? new URL(process.env.JRCARE_ORIGIN).origin : '';
const secureCookies = publicOrigin.startsWith('https://');
const trustProxy = process.env.JRCARE_TRUST_PROXY === '1';
if (process.env.NODE_ENV === 'production' && !secureCookies) {
  throw new Error('JRCARE_ORIGIN harus berupa alamat HTTPS di produksi.');
}
if (setupToken && (setupToken.length < 32 || setupToken.length > 128)) {
  throw new Error('JRCARE_SETUP_TOKEN harus berisi 32–128 karakter.');
}

const db = store.openStore(process.env.JRCARE_DATABASE || './data/jrcare.sqlite');
const scryptAsync = promisify(scrypt);
const missingPasswordHash = `${'0'.repeat(32)}:${'0'.repeat(128)}`;
const staffCookie = 'jrcare_staff';
const visitorCookie = 'jrcare_visitor';
const staffAge = 12 * 60 * 60;
const visitorAge = 30 * 24 * 60 * 60;
const bodyLimit = 96 * 1024;
const rateBuckets = new Map();
let lastPruned = 0;
const updateStreams = new Set();
const updateEvent = 'data: refresh\n\n';
const updatesAfter = db.prepare(`SELECT id, chat_id AS chatId, previous_agent_id AS previousAgentId, agent_id AS agentId
  FROM assignment_events WHERE id > ? ORDER BY id`);
const chatAgent = db.prepare('SELECT assignee_id AS id FROM chats WHERE id = ?');
let lastPublishedAssignment = db.prepare('SELECT coalesce(max(id), 0) AS id FROM assignment_events').get().id;

const staticFiles = new Map([
  ['/', ['index.html', 'text/html']],
  ['/petugas', ['staff.html', 'text/html']],
  ['/style.css', ['style.css', 'text/css']],
  ['/common.js', ['common.js', 'text/javascript']],
  ['/visitor.js', ['visitor.js', 'text/javascript']],
  ['/staff.js', ['staff.js', 'text/javascript']],
  ['/assets/jrcare-logo.png', ['assets/jrcare-logo.png', 'image/png']],
  ['/assets/plus-jakarta-sans.woff2', ['assets/plus-jakarta-sans.woff2', 'font/woff2']],
].map(([path, [file, type]]) => [path, {
  bytes: readFileSync(new URL(`./public/${file}`, import.meta.url)),
  type: type.startsWith('text/') ? `${type}; charset=utf-8` : type,
}]));
for (const path of ['/chat', '/riwayat']) staticFiles.set(path, staticFiles.get('/'));

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function limit(request, action, max, duration) {
  const now = Date.now();
  if (now - lastPruned > 60_000) {
    for (const [key, bucket] of rateBuckets) if (bucket.until <= now) rateBuckets.delete(key);
    lastPruned = now;
  }
  const forwarded = request.headers['x-real-ip'];
  const ip = trustProxy && typeof forwarded === 'string' && isIP(forwarded)
    ? forwarded : request.socket.remoteAddress;
  const key = `${action}:${ip}`;
  let bucket = rateBuckets.get(key);
  if (!bucket || bucket.until <= now) {
    if (!bucket && rateBuckets.size >= 10_000) throw new HttpError(429, 'Terlalu banyak permintaan. Coba lagi sebentar.');
    bucket = { count: 0, until: now + duration };
    rateBuckets.set(key, bucket);
  }
  if (++bucket.count > max) throw new HttpError(429, 'Terlalu banyak permintaan. Coba lagi sebentar.');
}

function hash(value) {
  return createHash('sha256').update(value).digest('hex');
}

function newToken() {
  return randomBytes(32).toString('base64url');
}

function readCookie(request, key) {
  const prefix = `${key}=`;
  const cookie = request.headers.cookie?.split(/;\s*/).find(part => part.startsWith(prefix));
  const token = cookie?.slice(prefix.length);
  return token && /^[\w-]{43}$/.test(token) ? hash(token) : null;
}

function setCookie(response, name, token, age, path) {
  response.setHeader('Set-Cookie', `${name}=${token}; Path=${path}; Max-Age=${age}; HttpOnly; SameSite=Strict${secureCookies ? '; Secure' : ''}`);
}

function newStaffSession() {
  const token = newToken();
  return { token, hash: hash(token), expiresAt: Date.now() + staffAge * 1000 };
}

function staffProfile({ id, name, role, username, temporary }) {
  return { id, name, role, username, mustChangePassword: Boolean(temporary) };
}

function currentStaff(request) {
  return store.staffBySession(db, readCookie(request, staffCookie));
}

function requireStaff(request, { admin = false, temporary = false } = {}) {
  const user = currentStaff(request);
  if (!user) throw new HttpError(401, 'Masuk kembali untuk melanjutkan.');
  if (admin && user.role !== 'admin') throw new HttpError(403, 'Halaman ini hanya untuk admin.');
  if (!temporary && user.temporary) throw new HttpError(403, 'Buat sandi baru untuk melanjutkan.');
  return user;
}

async function passwordHash(password) {
  const salt = randomBytes(16).toString('hex');
  const derived = await scryptAsync(password, salt, 64);
  return `${salt}:${derived.toString('hex')}`;
}

async function passwordMatches(password, storedHash) {
  const [salt, derived] = (storedHash ?? missingPasswordHash).split(':');
  const candidate = await scryptAsync(password, salt, 64);
  return timingSafeEqual(candidate, Buffer.from(derived, 'hex')) && Boolean(storedHash);
}

function validPassword(value) {
  if (typeof value !== 'string' || value.length < 12 || value.length > 128) {
    throw new HttpError(400, 'Gunakan sandi 12–128 karakter.');
  }
  return value;
}

function usernameOf(value) {
  const username = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (!/^[a-z0-9][a-z0-9._-]{2,39}$/.test(username)) {
    throw new HttpError(400, 'Nama pengguna harus berisi 3–40 huruf, angka, titik, garis bawah, atau tanda hubung.');
  }
  return username;
}

function nameOf(value) {
  const name = typeof value === 'string' ? value.trim() : '';
  if (!name || name.length > 80 || /[\p{Cc}\u2028\u2029]/u.test(name)) {
    throw new HttpError(400, 'Masukkan nama dalam satu baris, maksimal 80 karakter.');
  }
  return name;
}

function messageOf(value) {
  const body = typeof value === 'string' ? value.trim() : '';
  if (!body || body.length > 2_000) throw new HttpError(400, 'Isi pesan, maksimal 2.000 karakter.');
  return body;
}

function requestKeyOf(value) {
  if (typeof value !== 'string' || !/^[a-f\d]{32}$/.test(value)) throw new HttpError(400, 'Identitas pesan tidak valid.');
  return value;
}

function idOf(value) {
  const number = Number(value);
  if (!/^\d+$/.test(String(value)) || !Number.isSafeInteger(number) || number < 1) {
    throw new HttpError(400, 'Nomor chat atau akun tidak valid.');
  }
  return number;
}

function checkChatResult(result) {
  if (result === 'missing') throw new HttpError(404, 'Chat tidak tersedia.');
  if (result === 'closed') throw new HttpError(409, 'Chat ini sudah selesai.');
  if (result === 'changed') throw new HttpError(409, 'Penugasan baru saja berubah. Periksa agen saat ini dan coba lagi.');
  if (result === 'agent') throw new HttpError(400, 'Pilih salah satu agen yang terdaftar.');
}

function visitorAccess(request) {
  const code = request.headers['x-jrcare-chat-code'];
  if (code !== undefined && !/^[a-f\d]{32}$/.test(code)) throw new HttpError(404, 'Chat tidak ditemukan. Periksa tautan atau kode chat Anda.');
  return { key: readCookie(request, visitorCookie), code };
}

function requireVisitorChat(chat) {
  if (!chat) throw new HttpError(404, 'Chat tidak ditemukan. Periksa tautan atau kode chat Anda.');
  return chat;
}

function writeUpdate(response, frame) {
  if (!response.destroyed && !response.write(frame)) response.destroy();
}

function openUpdateStream(request, response, path) {
  let scope;
  if (path === '/api/visitor/events') {
    scope = { chatId: requireVisitorChat(store.visitorChatId(db, visitorAccess(request))) };
  } else {
    const user = requireStaff(request);
    scope = { staffId: user.id, admin: user.role === 'admin', session: readCookie(request, staffCookie) };
  }
  if (updateStreams.size >= 512) throw new HttpError(503, 'Koneksi live chat sedang penuh. Coba lagi sebentar.');
  const stream = { response, ...scope };
  updateStreams.add(stream);
  response.on('close', () => updateStreams.delete(stream));
  response.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-store, no-transform',
    'X-Accel-Buffering': 'no',
  });
  writeUpdate(response, updateEvent);
}

function publishUpdates(changedChats = new Set()) {
  const agentIds = new Set();
  for (const id of changedChats) agentIds.add(chatAgent.get(id)?.id);
  for (const { id, chatId, previousAgentId, agentId } of updatesAfter.all(lastPublishedAssignment)) {
    lastPublishedAssignment = id;
    changedChats.add(chatId);
    agentIds.add(previousAgentId);
    agentIds.add(agentId);
  }
  if (!changedChats.size) return;
  for (const { response, chatId, staffId, admin } of updateStreams) {
    if (changedChats.has(chatId) || admin || (staffId && agentIds.has(staffId))) writeUpdate(response, updateEvent);
  }
}

function verifyOrigin(request) {
  const expected = publicOrigin || `http://${request.headers.host}`;
  if (request.headers.origin !== expected) throw new HttpError(403, 'Permintaan harus berasal dari aplikasi JRCare.');
}

async function jsonBody(request) {
  if (request.headers['content-type']?.split(';', 1)[0] !== 'application/json') {
    throw new HttpError(415, 'Gunakan format JSON.');
  }
  if (Number(request.headers['content-length']) > bodyLimit) throw new HttpError(413, 'Ukuran kiriman terlalu besar.');
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > bodyLimit) throw new HttpError(413, 'Ukuran kiriman terlalu besar.');
    chunks.push(chunk);
  }
  let value;
  try { value = JSON.parse(Buffer.concat(chunks)); } catch { throw new HttpError(400, 'Isi permintaan tidak valid.'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new HttpError(400, 'Isi permintaan tidak valid.');
  return value;
}

function readApi(request, response, url) {
  switch (url.pathname) {
    case '/api/visitor/chat': {
      const access = visitorAccess(request);
      if (!access.key && !access.code) setCookie(response, visitorCookie, newToken(), visitorAge, '/api/visitor');
      const chat = store.visitorChat(db, access);
      return { chat: access.code ? requireVisitorChat(chat) : chat };
    }
    case '/api/visitor/history':
      return { chats: store.visitorHistory(db, readCookie(request, visitorCookie)) };
    case '/api/staff/session': {
      const user = currentStaff(request);
      const setup = store.hasAdmin(db) ? 'complete' : setupToken ? 'ready' : 'waiting';
      return { user: user ? staffProfile(user) : null, setup };
    }
    case '/api/staff/inbox': {
      const user = requireStaff(request);
      const id = url.searchParams.has('chat') ? idOf(url.searchParams.get('chat')) : null;
      return store.inbox(db, user, id);
    }
    case '/api/staff/agents':
      requireStaff(request, { admin: true });
      return store.listAgents(db);
    case '/api/staff/rules':
      requireStaff(request, { admin: true });
      return { rules: store.getRules(db) };
    default:
      throw new HttpError(404, 'Halaman tidak ditemukan.');
  }
}

async function writeApi(request, response, path, body, changedChats) {
  switch (path) {
    case '/api/visitor/chat':
    case '/api/visitor/message': {
      limit(request, 'visitor', 180, 60_000);
      const access = visitorAccess(request);
      if (!access.key && (path === '/api/visitor/chat' || !access.code)) {
        throw new HttpError(409, 'Sesi chat belum siap. Muat ulang halaman lalu coba lagi.');
      }
      const message = messageOf(body.text);
      const requestKey = requestKeyOf(body.requestKey);
      if (path === '/api/visitor/chat') {
        const chat = store.startChat(db, access.key, nameOf(body.name), message, requestKey);
        changedChats.add(chat.id);
        return { chat };
      }
      const id = idOf(body.chatId);
      checkChatResult(store.postVisitorMessage(db, access, id, message, requestKey));
      changedChats.add(id);
      return { chat: store.visitorChat(db, { ...access, id }) };
    }
    case '/api/staff/setup': {
      limit(request, 'setup', 8, 300_000);
      if (store.hasAdmin(db)) throw new HttpError(409, 'Akun admin sudah dibuat.');
      if (!setupToken || typeof body.token !== 'string'
          || !timingSafeEqual(Buffer.from(hash(body.token), 'hex'), Buffer.from(hash(setupToken), 'hex'))) {
        throw new HttpError(403, 'Kode aktivasi salah. Gunakan kode dari pengelola VPS.');
      }
      const digest = await passwordHash(validPassword(body.password));
      const session = newStaffSession();
      const admin = store.setupAdmin(db, digest, session);
      if (!admin) throw new HttpError(409, 'Akun admin sudah dibuat.');
      setCookie(response, staffCookie, session.token, staffAge, '/api/staff');
      return { user: staffProfile(admin) };
    }
    case '/api/staff/login': {
      limit(request, 'login', 16, 300_000);
      const username = usernameOf(body.username);
      const password = typeof body.password === 'string' && body.password.length <= 128 ? body.password : '';
      const user = store.staffByUsername(db, username);
      if (!await passwordMatches(password, user?.passwordHash)) throw new HttpError(401, 'Nama pengguna atau sandi salah.');
      const session = newStaffSession();
      const loggedIn = store.loginStaff(db, user, session);
      if (!loggedIn) throw new HttpError(401, 'Nama pengguna atau sandi salah.');
      setCookie(response, staffCookie, session.token, staffAge, '/api/staff');
      return { user: staffProfile(loggedIn) };
    }
    case '/api/staff/logout':
      store.removeSession(db, readCookie(request, staffCookie));
      setCookie(response, staffCookie, '', 0, '/api/staff');
      return {};
    case '/api/staff/password': {
      const user = requireStaff(request, { temporary: true });
      if (!user.temporary) throw new HttpError(409, 'Akun ini sudah menggunakan sandi tetap.');
      const password = validPassword(body.password);
      if (await passwordMatches(password, user.passwordHash)) throw new HttpError(400, 'Pilih sandi baru yang berbeda.');
      const digest = await passwordHash(password);
      const session = newStaffSession();
      const updated = store.replaceTemporaryPassword(db, user, digest, session);
      if (!updated) throw new HttpError(401, 'Sandi sementara berubah. Silakan masuk kembali.');
      setCookie(response, staffCookie, session.token, staffAge, '/api/staff');
      return { user: staffProfile(updated) };
    }
    case '/api/staff/agents': {
      requireStaff(request, { admin: true });
      const agent = store.createAgent(db, nameOf(body.name), usernameOf(body.username));
      if (!agent) throw new HttpError(409, 'Nama pengguna sudah dipakai.');
      return { agent };
    }
    case '/api/staff/presence': {
      const user = requireStaff(request);
      if (user.role !== 'agent') throw new HttpError(403, 'Status ketersediaan hanya untuk agen.');
      if (body.accepting !== undefined && typeof body.accepting !== 'boolean') {
        throw new HttpError(400, 'Status ketersediaan tidak valid.');
      }
      const presence = store.updatePresence(db, user.id, readCookie(request, staffCookie), body.accepting);
      if (!presence) throw new HttpError(401, 'Masuk kembali untuk melanjutkan.');
      return { presence };
    }
    case '/api/staff/routing':
      requireStaff(request, { admin: true });
      if (typeof body.enabled !== 'boolean') throw new HttpError(400, 'Pengaturan penugasan tidak valid.');
      return store.updateRouting(db, body.enabled);
    case '/api/staff/rules': {
      requireStaff(request, { admin: true });
      let rules;
      try { rules = validateRules(body); } catch (error) { throw new HttpError(400, error.message); }
      for (const id of store.saveRules(db, rules)) changedChats.add(id);
      return { rules };
    }
  }

  const reset = path.match(/^\/api\/staff\/agents\/(\d+)\/password$/);
  if (reset) {
    requireStaff(request, { admin: true });
    const id = idOf(reset[1]);
    const temporaryPassword = randomBytes(18).toString('base64url');
    const agent = store.setAgentPassword(db, id, await passwordHash(temporaryPassword));
    if (!agent) throw new HttpError(404, 'Akun agen tidak ditemukan.');
    return { agent, temporaryPassword };
  }

  const capacity = path.match(/^\/api\/staff\/agents\/(\d+)\/capacity$/);
  if (capacity) {
    requireStaff(request, { admin: true });
    if (!Number.isInteger(body.capacity) || body.capacity < 1 || body.capacity > 20) {
      throw new HttpError(400, 'Kapasitas agen harus 1–20 chat aktif.');
    }
    const data = store.updateCapacity(db, idOf(capacity[1]), body.capacity);
    if (!data) throw new HttpError(404, 'Akun agen tidak ditemukan.');
    return data;
  }

  const thread = path.match(/^\/api\/staff\/chats\/(\d+)\/(message|assign|close)$/);
  if (thread) {
    const [, rawId, action] = thread;
    const id = idOf(rawId);
    const user = requireStaff(request, { admin: action === 'assign' });
    if (action === 'message') checkChatResult(store.postStaffMessage(db, user, id, messageOf(body.text), requestKeyOf(body.requestKey)));
    if (action === 'assign') {
      const agentId = body.agentId === null ? null : idOf(body.agentId);
      const { hold, expectedVersion } = body;
      if ((hold !== undefined && (typeof hold !== 'boolean' || (hold && agentId)))
          || (expectedVersion !== undefined && (!Number.isSafeInteger(expectedVersion) || expectedVersion < 0))) {
        throw new HttpError(400, 'Pilihan penugasan tidak valid.');
      }
      checkChatResult(store.assignChat(db, user, id, { agentId, hold, expectedVersion }));
    }
    if (action === 'close') checkChatResult(store.closeChat(db, user, id));
    changedChats.add(id);
    return {};
  }

  throw new HttpError(404, 'Halaman tidak ditemukan.');
}

function sendJson(response, status, data) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(data));
}

const server = createServer({ headersTimeout: 10_000, requestTimeout: 30_000 }, async (request, response) => {
  response.setHeader('Content-Security-Policy', "default-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('Referrer-Policy', 'no-referrer');
  if (secureCookies) response.setHeader('Strict-Transport-Security', 'max-age=31536000');

  try {
    const url = new URL(request.url, 'http://localhost');
    if (url.pathname === '/healthz' && (request.method === 'GET' || request.method === 'HEAD')) {
      db.prepare('SELECT 1').get();
      return sendJson(response, 200, { status: 'ok', service: 'jrcare' });
    }
    const file = staticFiles.get(url.pathname);
    if (file && (request.method === 'GET' || request.method === 'HEAD')) {
      if (url.pathname === '/chat' || url.pathname === '/riwayat') response.setHeader('X-Robots-Tag', 'noindex');
      response.writeHead(200, { 'Content-Type': file.type, 'Cache-Control': 'no-cache' });
      response.end(request.method === 'HEAD' ? undefined : file.bytes);
      return;
    }
    if (!url.pathname.startsWith('/api/')) throw new HttpError(404, 'Halaman tidak ditemukan.');
    if (request.method === 'GET' && ['/api/visitor/events', '/api/staff/events'].includes(url.pathname)) {
      return openUpdateStream(request, response, url.pathname);
    }
    if (request.method === 'GET') return sendJson(response, 200, readApi(request, response, url));
    if (request.method !== 'POST') throw new HttpError(405, 'Metode tidak didukung.');
    verifyOrigin(request);
    const body = await jsonBody(request);
    const changedChats = new Set();
    const result = await writeApi(request, response, url.pathname, body, changedChats);
    publishUpdates(changedChats);
    sendJson(response, 200, result);
  } catch (error) {
    if (error instanceof HttpError) return sendJson(response, error.status, { error: error.message });
    console.error(error);
    sendJson(response, 500, { error: 'Layanan sedang bermasalah. Coba lagi sebentar.' });
  }
});

server.listen(port, host, () => console.log(`JRCare siap di http://${host}:${server.address().port}`));

const routingTimer = setInterval(() => {
  try {
    store.runRouting(db);
    publishUpdates();
  } catch (error) { console.error('Penugasan JRCare gagal', error); }
}, 15_000).unref();

const heartbeat = setInterval(() => {
  for (const { response, session } of updateStreams) {
    if (session && !store.staffBySession(db, session)) response.end();
    else writeUpdate(response, ': heartbeat\n\n');
  }
}, 12_000).unref();

function shutdown() {
  clearInterval(routingTimer);
  clearInterval(heartbeat);
  for (const { response } of updateStreams) response.end();
  server.close(() => db.close());
}
process.once('SIGTERM', shutdown);
process.once('SIGINT', shutdown);
