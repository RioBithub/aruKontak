import { randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { automationFor, defaultRules } from './rules.mjs';
import {
  agentIsOnline, agentStates, assignmentEvents, migrateRouting, queuePosition, recordAssignment, routeWaitingChats, routingEnabled,
} from './routing.mjs';
import { runWorkflow, twoMessageWorkflow, workflowChoices } from './workflow.mjs';

const initialAgents = ['Igun', 'Meri', 'Lingga'];
const resumeLifetime = 24 * 60 * 60 * 1000;
const staffFields = 'id, username, name, role, password_hash AS passwordHash, temporary';
const visitorFields = `id, visitor_name AS name, visitor_phone AS phone, visitor_email AS email,
  closed_at AS closedAt, bot_pending AS botPending, bot_menu AS botMenu, bot_workflow AS botWorkflow, bot_progress AS botProgress`;
const restartAllowed = `c.closed_at IS NULL AND c.assignee_id IS NULL
  AND (c.bot_menu IS NOT NULL OR c.bot_workflow IS NOT NULL)
  AND NOT EXISTS (SELECT 1 FROM messages m WHERE m.chat_id = c.id AND m.sender = 'staff')`;
const chatSummary = `
  SELECT c.id, c.visitor_name AS name, c.assignee_id AS assigneeId, a.name AS agentName,
         c.closed_at AS closedAt, c.updated_at AS updatedAt,
         CASE WHEN c.bot_pending THEN 'bot' ELSE c.routing_state END AS routingState,
         c.assignment_version AS assignmentVersion,
         (SELECT coalesce(nullif(substr(m.body, 1, 180), ''), f.file_name) FROM messages m
          LEFT JOIN message_attachments f ON f.message_id = m.id
          WHERE m.chat_id = c.id AND m.sender <> 'auto' ORDER BY m.id DESC LIMIT 1) AS preview
  FROM chats c LEFT JOIN users a ON a.id = c.assignee_id
`;
const visitorSummary = `
  SELECT c.id, c.visitor_name AS name, c.access_code AS code, c.closed_at AS closedAt,
         c.bot_pending AS botPending, c.bot_menu AS botMenu, c.bot_workflow AS botWorkflow,
         c.bot_progress AS botProgress, c.assignee_id AS assigneeId, a.name AS agentName,
         (${restartAllowed}) AS canRestart
  FROM chats c LEFT JOIN users a ON a.id = c.assignee_id
`;
const attachmentSummary = `SELECT f.file_name AS name, f.mime_type AS type, f.byte_count AS size, f.encoding, f.data
  FROM message_attachments f JOIN messages m ON m.id = f.message_id JOIN chats c ON c.id = m.chat_id`;

function chatCode() {
  return randomBytes(16).toString('hex');
}

function migrateChats(db) {
  const { user_version: version } = db.prepare('PRAGMA user_version').get();
  if (version < 2) {
    db.exec(`
      ALTER TABLE chats ADD COLUMN access_code TEXT;
      ALTER TABLE chats ADD COLUMN bot_pending INTEGER NOT NULL DEFAULT 0 CHECK (bot_pending IN (0, 1));
      CREATE UNIQUE INDEX chats_by_access_code ON chats(access_code);
      PRAGMA user_version = 2;
    `);
  }
  if (version < 3) {
    db.exec('ALTER TABLE chats ADD COLUMN bot_menu TEXT; PRAGMA user_version = 3;');
  }
  if (version < 4) {
    db.exec(`
      ALTER TABLE chats ADD COLUMN visitor_phone TEXT;
      ALTER TABLE chats ADD COLUMN visitor_email TEXT;
      DROP INDEX IF EXISTS open_chat_by_visitor;
      CREATE TABLE visitor_departures (
        visitor_key TEXT PRIMARY KEY,
        chat_id INTEGER NOT NULL REFERENCES chats(id),
        expires_at INTEGER NOT NULL
      );
      PRAGMA user_version = 4;
    `);
  }
  const setCode = db.prepare('UPDATE chats SET access_code = ? WHERE id = ?');
  for (const { id } of db.prepare('SELECT id FROM chats WHERE access_code IS NULL').all()) {
    setCode.run(chatCode(), id);
  }
}

function migrateWorkflow(db) {
  if (db.prepare('PRAGMA user_version').get().user_version >= 5) return;
  db.exec(`
    ALTER TABLE chats ADD COLUMN bot_workflow TEXT;
    ALTER TABLE chats ADD COLUMN bot_progress TEXT;
    ALTER TABLE chats ADD COLUMN preferred_agent_id INTEGER REFERENCES users(id);
    CREATE TABLE workflow_settings (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      draft TEXT NOT NULL,
      published TEXT,
      version INTEGER NOT NULL,
      published_version INTEGER
    );
    PRAGMA user_version = 5;
  `);
  const rules = getRules(db);
  const draft = JSON.stringify(twoMessageWorkflow(rules.menu));
  const useDiagram = rules.mode === 'two-message' || rules.mode === 'workflow';
  db.prepare('INSERT INTO workflow_settings (id, draft, published, version, published_version) VALUES (1, ?, ?, 1, ?)')
    .run(draft, useDiagram ? draft : null, useDiagram ? 1 : null);
  if (useDiagram) db.prepare('UPDATE reply_settings SET rules = ? WHERE id = 1')
    .run(JSON.stringify({ ...rules, mode: 'workflow' }));
}

function migrateAttachments(db) {
  if (db.prepare('PRAGMA user_version').get().user_version >= 6) return;
  db.exec(`
    CREATE TABLE message_attachments (
      message_id INTEGER PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
      file_name TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      byte_count INTEGER NOT NULL,
      encoding TEXT NOT NULL CHECK (encoding IN ('raw', 'gzip')),
      data BLOB NOT NULL
    );
    PRAGMA user_version = 6;
  `);
}

export function openStore(filename) {
  if (filename !== ':memory:') mkdirSync(dirname(filename), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(filename);
  db.exec(`
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 5000;
    PRAGMA journal_mode = WAL;

    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY,
      username TEXT NOT NULL UNIQUE COLLATE NOCASE,
      name TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('admin', 'agent')),
      password_hash TEXT,
      temporary INTEGER NOT NULL DEFAULT 0 CHECK (temporary IN (0, 1))
    );
    CREATE UNIQUE INDEX IF NOT EXISTS single_admin ON users(role) WHERE role = 'admin';

    CREATE TABLE IF NOT EXISTS staff_sessions (
      token_hash TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS sessions_by_user ON staff_sessions(user_id);

    CREATE TABLE IF NOT EXISTS chats (
      id INTEGER PRIMARY KEY,
      visitor_key TEXT NOT NULL,
      visitor_name TEXT NOT NULL,
      assignee_id INTEGER REFERENCES users(id),
      updated_at INTEGER NOT NULL,
      closed_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS chats_by_visitor ON chats(visitor_key, id DESC);
    CREATE INDEX IF NOT EXISTS chats_by_assignee ON chats(assignee_id, updated_at DESC);

    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY,
      chat_id INTEGER NOT NULL REFERENCES chats(id),
      sender TEXT NOT NULL CHECK (sender IN ('visitor', 'staff', 'auto')),
      sender_name TEXT NOT NULL,
      body TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      request_key TEXT,
      UNIQUE (chat_id, sender, request_key)
    );
    CREATE INDEX IF NOT EXISTS messages_by_chat ON messages(chat_id, id);

    CREATE TABLE IF NOT EXISTS reply_settings (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      rules TEXT NOT NULL
    );
  `);
  db.prepare('INSERT OR IGNORE INTO reply_settings (id, rules) VALUES (1, ?)').run(JSON.stringify(defaultRules));
  transaction(db, () => {
    migrateRouting(db);
    migrateChats(db);
    migrateWorkflow(db);
    migrateAttachments(db);
  });
  return db;
}

function transaction(db, action) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = action();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

export function hasAdmin(db) {
  return Boolean(db.prepare("SELECT 1 FROM users WHERE role = 'admin'").get());
}

export function staffByUsername(db, username) {
  return db.prepare(`SELECT ${staffFields} FROM users WHERE username = ?`).get(username);
}

export function staffBySession(db, tokenHash) {
  if (!tokenHash) return null;
  return db.prepare(`SELECT ${staffFields} FROM users WHERE id = (
    SELECT user_id FROM staff_sessions WHERE token_hash = ? AND expires_at > ?
  )`).get(tokenHash, Date.now()) ?? null;
}

function insertSession(db, userId, { hash, expiresAt }) {
  db.prepare('DELETE FROM staff_sessions WHERE expires_at <= ?').run(Date.now());
  db.prepare('INSERT INTO staff_sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)').run(hash, userId, expiresAt);
}

export function removeSession(db, tokenHash) {
  if (!tokenHash) return;
  transaction(db, () => {
    const result = db.prepare('DELETE FROM staff_sessions WHERE token_hash = ?').run(tokenHash);
    if (result.changes) routeWaitingChats(db);
  });
}

export function setupAdmin(db, passwordHash, session) {
  return transaction(db, () => {
    if (hasAdmin(db)) return null;
    db.prepare("INSERT INTO users (username, name, role, password_hash) VALUES ('admin', 'Admin JRCare', 'admin', ?)")
      .run(passwordHash);
    const insertAgent = db.prepare("INSERT INTO users (username, name, role) VALUES (?, ?, 'agent')");
    for (const name of initialAgents) insertAgent.run(name.toLowerCase(), name);
    const admin = staffByUsername(db, 'admin');
    insertSession(db, admin.id, session);
    return admin;
  });
}

export function loginStaff(db, user, session) {
  return transaction(db, () => {
    const current = staffByUsername(db, user.username);
    if (current?.passwordHash !== user.passwordHash) return null;
    insertSession(db, current.id, session);
    return current;
  });
}

export function replaceTemporaryPassword(db, user, passwordHash, session) {
  return transaction(db, () => {
    const current = db.prepare(`UPDATE users SET password_hash = ?, temporary = 0
      WHERE id = ? AND temporary = 1 AND password_hash = ? RETURNING ${staffFields}`)
      .get(passwordHash, user.id, user.passwordHash);
    if (!current) return null;
    db.prepare('DELETE FROM staff_sessions WHERE user_id = ?').run(user.id);
    insertSession(db, user.id, session);
    return current;
  });
}

export function listAgents(db) {
  return { agents: agentStates(db), autoAssign: routingEnabled(db) };
}

export function visitorService(agents) {
  return {
    online: agents.some(agent => agent.online),
    available: agents.some(agent => agent.online && agent.accepting && agent.activeChats < agent.capacity),
  };
}

export function createAgent(db, name, username) {
  const agent = db.prepare(`INSERT INTO users (username, name, role) VALUES (?, ?, 'agent')
    ON CONFLICT (username) DO NOTHING RETURNING id`).get(username, name);
  return agent ? agentStates(db).find(item => item.id === agent.id) : null;
}

export function setAgentPassword(db, id, passwordHash) {
  return transaction(db, () => {
    const agent = db.prepare(`UPDATE users SET password_hash = ?, temporary = 1
      WHERE id = ? AND role = 'agent' RETURNING id`).get(passwordHash, id);
    if (agent) {
      db.prepare('DELETE FROM staff_sessions WHERE user_id = ?').run(id);
      routeWaitingChats(db);
    }
    return agent ? agentStates(db).find(item => item.id === agent.id) : null;
  });
}

export function updatePresence(db, userId, tokenHash, accepting) {
  return transaction(db, () => {
    const now = Date.now();
    const session = db.prepare(`INSERT INTO agent_presence (token_hash, present_at)
      SELECT token_hash, ? FROM staff_sessions WHERE token_hash = ? AND user_id = ? AND expires_at > ?
      ON CONFLICT (token_hash) DO UPDATE SET present_at = excluded.present_at`)
      .run(now, tokenHash, userId, now);
    if (!session.changes) return null;
    if (accepting !== undefined) db.prepare('UPDATE users SET accepting_chats = ? WHERE id = ?').run(Number(accepting), userId);
    routeWaitingChats(db, now);
    return agentStates(db, now).find(agent => agent.id === userId);
  });
}

export function updateCapacity(db, agentId, capacity) {
  return transaction(db, () => {
    const result = db.prepare("UPDATE users SET chat_capacity = ? WHERE id = ? AND role = 'agent'").run(capacity, agentId);
    if (!result.changes) return null;
    routeWaitingChats(db);
    return listAgents(db);
  });
}

export function updateRouting(db, enabled) {
  return transaction(db, () => {
    db.prepare('UPDATE routing_settings SET enabled = ? WHERE id = 1').run(Number(enabled));
    routeWaitingChats(db);
    return listAgents(db);
  });
}

export function runRouting(db) {
  transaction(db, () => routeWaitingChats(db));
}

export function getRules(db) {
  const rules = JSON.parse(db.prepare('SELECT rules FROM reply_settings WHERE id = 1').get().rules);
  return {
    ...rules,
    mode: rules.mode ?? defaultRules.mode,
    menu: rules.menu ?? defaultRules.menu,
    handoff: rules.handoff ?? 'immediate',
    keywords: rules.keywords.map(rule => ({ match: 'contains', handoff: false, ...rule })),
  };
}

export function saveRules(db, rules) {
  return transaction(db, () => {
    db.prepare('UPDATE reply_settings SET rules = ? WHERE id = 1').run(JSON.stringify(rules));
    if (rules.handoff !== 'immediate') return [];
    const released = db.prepare(`UPDATE chats SET bot_pending = 0
      WHERE bot_pending = 1 AND bot_menu IS NULL AND bot_workflow IS NULL AND closed_at IS NULL RETURNING id`).all();
    if (released.length) routeWaitingChats(db);
    return released.map(chat => chat.id);
  });
}

export function diagramSettings(db) {
  const row = db.prepare('SELECT draft, version, published_version AS publishedVersion FROM workflow_settings WHERE id = 1').get();
  const rules = getRules(db);
  return {
    ...row, draft: JSON.parse(row.draft), active: rules.mode === 'workflow', template: twoMessageWorkflow(rules.menu),
    agents: agentStates(db).map(({ id, name }) => ({ id, name })),
  };
}

export function saveDiagram(db, flow, expectedVersion, publish) {
  return transaction(db, () => {
    const json = JSON.stringify(flow);
    const next = expectedVersion + 1;
    const result = publish
      ? db.prepare(`UPDATE workflow_settings SET draft = ?, published = ?, version = ?, published_version = ?
          WHERE id = 1 AND version = ?`).run(json, json, next, next, expectedVersion)
      : db.prepare('UPDATE workflow_settings SET draft = ?, version = ? WHERE id = 1 AND version = ?')
        .run(json, next, expectedVersion);
    if (!result.changes) return null;
    if (publish) db.prepare('UPDATE reply_settings SET rules = ? WHERE id = 1')
      .run(JSON.stringify({ ...getRules(db), mode: 'workflow' }));
    return diagramSettings(db);
  });
}

function messagesFor(db, chatId) {
  return db.prepare(`SELECT m.id, m.sender, m.sender_name AS senderName, m.body, m.created_at AS at,
      f.file_name AS fileName, f.mime_type AS fileType, f.byte_count AS fileSize
    FROM messages m LEFT JOIN message_attachments f ON f.message_id = m.id
    WHERE m.chat_id = ? ORDER BY m.id`).all(chatId).map(({ fileName, fileType, fileSize, ...message }) => {
    if (fileName) message.attachment = { id: message.id, name: fileName, type: fileType, size: fileSize };
    return message;
  });
}

function attachMessage(db, id, file) {
  if (!file) return;
  db.prepare(`INSERT INTO message_attachments (message_id, file_name, mime_type, byte_count, encoding, data)
    VALUES (?, ?, ?, ?, ?, ?)`).run(id, file.name, file.type, file.size, file.encoding, file.data);
}

export function visitorAttachment(db, id, { key, code }) {
  if (!key && !code) return null;
  const field = code ? 'access_code' : 'visitor_key';
  return db.prepare(`${attachmentSummary} WHERE f.message_id = ? AND c.${field} = ?`).get(id, code ?? key);
}

export function staffAttachment(db, id, user) {
  return db.prepare(`${attachmentSummary} WHERE f.message_id = ? AND (? = 'admin' OR c.assignee_id = ?)`)
    .get(id, user.role, user.id);
}

export function visitorHistory(db, key) {
  if (!key) return [];
  return db.prepare(`SELECT c.access_code AS code, c.closed_at AS closedAt, c.updated_at AS updatedAt,
      (SELECT coalesce(nullif(substr(m.body, 1, 120), ''), f.file_name) FROM messages m
        LEFT JOIN message_attachments f ON f.message_id = m.id WHERE m.chat_id = c.id AND m.sender = 'visitor'
        ORDER BY m.id LIMIT 1) AS preview
    FROM chats c WHERE c.visitor_key = ? ORDER BY c.id DESC`).all(key);
}

export function visitorChatId(db, { key, code, id }) {
  if (code) return db.prepare('SELECT id FROM chats WHERE access_code = ?').get(code)?.id;
  if (!key) return undefined;
  if (id) return db.prepare('SELECT id FROM chats WHERE visitor_key = ? AND id = ?').get(key, id)?.id;
  return db.prepare('SELECT id FROM chats WHERE visitor_key = ? ORDER BY id DESC LIMIT 1').get(key)?.id;
}

function visitorThread(db, id) {
  if (!id) return null;
  const { botMenu, botWorkflow, botProgress, assigneeId, ...chat } = db.prepare(`${visitorSummary} WHERE c.id = ?`).get(id);
  let choices = [];
  if (chat.botPending && !chat.closedAt) {
    if (botWorkflow) choices = workflowChoices(JSON.parse(botWorkflow).flow, JSON.parse(botProgress));
    else if (botMenu) choices = JSON.parse(botMenu).choices.map(({ code, label }) => ({ code, label }));
  }
  return {
    ...chat, botPending: Boolean(chat.botPending), canRestart: Boolean(chat.canRestart),
    queuePosition: queuePosition(db, id),
    agentOnline: assigneeId ? agentIsOnline(db, assigneeId) : null, choices, messages: messagesFor(db, id),
  };
}

export function visitorChat(db, access) {
  return visitorThread(db, visitorChatId(db, access));
}

export function visitorSession(db, key, now = Date.now()) {
  if (!key) return { chat: null, resume: null };
  const left = db.prepare(`SELECT c.access_code AS code, c.closed_at AS closedAt, d.expires_at AS expiresAt
    FROM visitor_departures d JOIN chats c ON c.id = d.chat_id WHERE d.visitor_key = ?`).get(key);
  if (left) return {
    chat: null,
    resume: left.expiresAt > now ? { ...left, remainingMs: left.expiresAt - now } : null,
  };
  return { chat: visitorChat(db, { key }), resume: null };
}

export function leaveChat(db, access, id, now = Date.now()) {
  return transaction(db, () => {
    if (visitorChatId(db, { ...access, id }) !== id) return 'missing';
    db.prepare(`INSERT INTO visitor_departures (visitor_key, chat_id, expires_at) VALUES (?, ?, ?)
      ON CONFLICT (visitor_key) DO UPDATE SET chat_id = excluded.chat_id, expires_at = excluded.expires_at`)
      .run(access.key, id, now + resumeLifetime);
    return 'ok';
  });
}

function addVisitorMessage(db, chat, body, requestKey, now, rules, isNewChat = false, file = null) {
  const { id, name, phone, email, botPending, botMenu, botWorkflow, botProgress } = chat;
  const date = new Date(now);
  let outcome;
  if (botWorkflow && botPending) {
    const { flow, away } = JSON.parse(botWorkflow);
    const input = body || 'Lampiran';
    outcome = runWorkflow(flow, JSON.parse(botProgress ?? 'null'), { input, name, phone, email, away, now: date });
  } else if (botWorkflow) {
    outcome = { replies: [] };
  } else {
    const menu = botMenu ? JSON.parse(botMenu) : null;
    outcome = automationFor(rules, body, { isNewChat, botPending, now: date, menu });
  }
  const handoff = outcome.handoff || outcome.action === 'handoff';
  const closed = outcome.action === 'close';
  const insertMessage = db.prepare('INSERT INTO messages (chat_id, sender, sender_name, body, created_at, request_key) VALUES (?, ?, ?, ?, ?, ?)');
  const { lastInsertRowid } = insertMessage.run(id, 'visitor', name, body, now, requestKey);
  attachMessage(db, lastInsertRowid, file);
  for (const reply of outcome.replies) insertMessage.run(id, 'auto', 'JRCare', reply, now, null);
  db.prepare(`UPDATE chats SET updated_at = ?, bot_pending = ?, bot_progress = coalesce(?, bot_progress),
    closed_at = coalesce(?, closed_at), preferred_agent_id = coalesce(?, preferred_agent_id) WHERE id = ?`)
    .run(now, Number(botPending && !handoff && !closed), outcome.progress ? JSON.stringify(outcome.progress) : null,
      closed ? now : null, outcome.agentId ?? null, id);
  if ((isNewChat && !botPending) || (botPending && handoff)) routeWaitingChats(db, now);
}

export function startChat(db, visitorKey, name, body, requestKey, { phone = null, email = null, attachment = null } = {}) {
  return transaction(db, () => {
    const retry = db.prepare(`SELECT c.id FROM chats c JOIN messages m ON m.chat_id = c.id
      WHERE c.visitor_key = ? AND m.sender = 'visitor' AND m.request_key = ? LIMIT 1`).get(visitorKey, requestKey);
    if (retry) return visitorThread(db, retry.id);

    const now = Date.now();
    const rules = getRules(db);
    const left = db.prepare('DELETE FROM visitor_departures WHERE visitor_key = ?').run(visitorKey).changes;
    const latest = db.prepare(`SELECT ${visitorFields} FROM chats WHERE visitor_key = ? ORDER BY id DESC LIMIT 1`).get(visitorKey);
    if (!left && latest && !latest.closedAt) {
      addVisitorMessage(db, latest, body, requestKey, now, rules, false, attachment);
      return visitorThread(db, latest.id);
    }

    const botMenu = rules.mode === 'two-message' ? JSON.stringify(rules.menu) : null;
    const published = rules.mode === 'workflow' ? db.prepare('SELECT published FROM workflow_settings WHERE id = 1').get().published : null;
    const botWorkflow = published ? JSON.stringify({ flow: JSON.parse(published), away: rules.away }) : null;
    const botPending = Boolean(botMenu || botWorkflow) || rules.handoff !== 'immediate';
    const { lastInsertRowid: id } = db.prepare(`INSERT INTO chats
      (visitor_key, visitor_name, visitor_phone, visitor_email, updated_at, access_code, bot_pending, bot_menu, bot_workflow)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(visitorKey, name, phone, email, now, chatCode(), Number(botPending), botMenu, botWorkflow);
    addVisitorMessage(db, { id, name, phone, email, botPending, botMenu, botWorkflow }, body, requestKey, now, rules, true, attachment);
    return visitorThread(db, id);
  });
}

export function postVisitorMessage(db, access, id, body, requestKey, file = null) {
  return transaction(db, () => {
    if (visitorChatId(db, { ...access, id }) !== id) return 'missing';
    const chat = db.prepare(`SELECT ${visitorFields} FROM chats WHERE id = ?`).get(id);
    if (db.prepare("SELECT 1 FROM messages WHERE chat_id = ? AND sender = 'visitor' AND request_key = ?")
      .get(id, requestKey)) return 'ok';
    if (chat.closedAt) return 'closed';
    addVisitorMessage(db, chat, body, requestKey, Date.now(), getRules(db), false, file);
    return 'ok';
  });
}

export function restartVisitorTopic(db, access, id, requestKey) {
  return transaction(db, () => {
    if (visitorChatId(db, { ...access, id }) !== id) return 'missing';
    if (db.prepare("SELECT 1 FROM messages WHERE chat_id = ? AND sender = 'visitor' AND request_key = ?")
      .get(id, requestKey)) return 'ok';
    const chat = db.prepare(`SELECT ${visitorFields} FROM chats c WHERE c.id = ? AND ${restartAllowed}`).get(id);
    if (!chat) return 'connected';
    db.prepare('UPDATE chats SET bot_pending = 1, bot_progress = NULL, preferred_agent_id = NULL WHERE id = ?').run(id);
    addVisitorMessage(db, { ...chat, botPending: true, botProgress: null }, 'Mulai ulang topik', requestKey, Date.now(), getRules(db), true);
    return 'ok';
  });
}

function staffChat(db, id, user) {
  return db.prepare(`${chatSummary} WHERE c.id = ? AND (? = 'admin' OR c.assignee_id = ?)`)
    .get(id, user.role, user.id);
}

export function inbox(db, user, id) {
  const chats = user.role === 'admin'
    ? db.prepare(`${chatSummary} ORDER BY c.updated_at DESC, c.id DESC`).all()
    : db.prepare(`${chatSummary} WHERE c.assignee_id = ? ORDER BY c.updated_at DESC, c.id DESC`).all(user.id);
  const chat = id ? staffChat(db, id, user) : null;
  if (!chat) return { chats, chat: null };
  const { phone, email, progress } = db.prepare(`SELECT visitor_phone AS phone, visitor_email AS email, bot_progress AS progress
    FROM chats WHERE id = ?`).get(id);
  chat.contact = { phone, email };
  chat.answers = progress ? JSON.parse(progress).answers : {};
  chat.agentOnline = chat.assigneeId ? agentIsOnline(db, chat.assigneeId) : null;
  chat.messages = messagesFor(db, id);
  if (user.role === 'admin') chat.assignmentEvents = assignmentEvents(db, id);
  return { chats, chat };
}

export function postStaffMessage(db, user, id, body, requestKey, file = null) {
  return transaction(db, () => {
    const chat = staffChat(db, id, user);
    if (!chat) return 'missing';
    if (db.prepare("SELECT 1 FROM messages WHERE chat_id = ? AND sender = 'staff' AND request_key = ?")
      .get(id, requestKey)) return 'ok';
    if (chat.closedAt) return 'closed';
    const now = Date.now();
    const { lastInsertRowid } = db.prepare("INSERT INTO messages (chat_id, sender, sender_name, body, created_at, request_key) VALUES (?, 'staff', ?, ?, ?, ?)")
      .run(id, user.name, body, now, requestKey);
    attachMessage(db, lastInsertRowid, file);
    db.prepare('UPDATE chats SET updated_at = ?, bot_pending = 0 WHERE id = ?').run(now, id);
    if (chat.routingState === 'bot') routeWaitingChats(db, now);
    return 'ok';
  });
}

export function assignChat(db, user, id, { agentId, hold, expectedVersion }) {
  return transaction(db, () => {
    const chat = staffChat(db, id, user);
    if (!chat) return 'missing';
    if (chat.closedAt) return 'closed';
    if (expectedVersion !== undefined && expectedVersion !== chat.assignmentVersion) return 'changed';
    if (agentId && !db.prepare("SELECT 1 FROM users WHERE id = ? AND role = 'agent'").get(agentId)) return 'agent';
    const state = agentId ? 'manual' : hold ? 'hold' : 'queued';
    if (chat.assigneeId !== agentId || chat.routingState !== state) {
      const kind = agentId ? 'manual' : hold ? 'hold' : 'queue';
      recordAssignment(db, chat, agentId, state, kind, user.id, Date.now());
    }
    routeWaitingChats(db);
    return 'ok';
  });
}

export function closeChat(db, user, id) {
  return transaction(db, () => {
    const chat = staffChat(db, id, user);
    if (!chat) return 'missing';
    if (!chat.closedAt) {
      const now = Date.now();
      db.prepare('UPDATE chats SET closed_at = ?, updated_at = ? WHERE id = ?').run(now, now, id);
      routeWaitingChats(db, now);
    }
    return 'ok';
  });
}
