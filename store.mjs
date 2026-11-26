import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { automaticReplies, defaultRules } from './rules.mjs';
import { agentStates, assignmentEvents, migrateRouting, recordAssignment, routeWaitingChats, routingEnabled } from './routing.mjs';

const initialAgents = ['Igun', 'Meri', 'Lingga'];
const staffFields = 'id, username, name, role, password_hash AS passwordHash, temporary';
const chatSummary = `
  SELECT c.id, c.visitor_name AS name, c.assignee_id AS assigneeId, a.name AS agentName,
         c.closed_at AS closedAt, c.updated_at AS updatedAt, c.routing_state AS routingState,
         c.assignment_version AS assignmentVersion,
         (SELECT substr(body, 1, 180) FROM messages
          WHERE chat_id = c.id AND sender <> 'auto' ORDER BY id DESC LIMIT 1) AS preview
  FROM chats c LEFT JOIN users a ON a.id = c.assignee_id
`;

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
    CREATE UNIQUE INDEX IF NOT EXISTS open_chat_by_visitor ON chats(visitor_key) WHERE closed_at IS NULL;
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
  transaction(db, () => migrateRouting(db));
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
  return JSON.parse(db.prepare('SELECT rules FROM reply_settings WHERE id = 1').get().rules);
}

export function saveRules(db, rules) {
  db.prepare('UPDATE reply_settings SET rules = ? WHERE id = 1').run(JSON.stringify(rules));
}

function messagesFor(db, chatId) {
  return db.prepare(`SELECT id, sender, sender_name AS senderName, body, created_at AS at
    FROM messages WHERE chat_id = ? ORDER BY id`).all(chatId);
}

function visitorSummary(db, visitorKey) {
  return db.prepare(`${chatSummary} WHERE c.visitor_key = ? ORDER BY c.id DESC LIMIT 1`).get(visitorKey);
}

export function visitorChat(db, visitorKey) {
  const chat = visitorSummary(db, visitorKey);
  if (!chat) return null;
  const { id, name, agentName, closedAt } = chat;
  return { id, name, agentName, closedAt, messages: messagesFor(db, id) };
}

function addVisitorMessage(db, id, name, body, requestKey, now, isNewChat) {
  const insertMessage = db.prepare('INSERT INTO messages (chat_id, sender, sender_name, body, created_at, request_key) VALUES (?, ?, ?, ?, ?, ?)');
  insertMessage.run(id, 'visitor', name, body, now, requestKey);
  for (const reply of automaticReplies(getRules(db), body, isNewChat, new Date(now))) {
    insertMessage.run(id, 'auto', 'JRCare', reply, now, null);
  }
  db.prepare('UPDATE chats SET updated_at = ? WHERE id = ?').run(now, id);
}

export function startChat(db, visitorKey, name, body, requestKey) {
  return transaction(db, () => {
    const latest = visitorSummary(db, visitorKey);
    const retry = db.prepare(`SELECT 1 FROM chats c JOIN messages m ON m.chat_id = c.id
      WHERE c.visitor_key = ? AND m.sender = 'visitor' AND m.request_key = ? LIMIT 1`).get(visitorKey, requestKey);
    if (retry) return visitorChat(db, visitorKey);

    const now = Date.now();
    if (latest && !latest.closedAt) {
      addVisitorMessage(db, latest.id, latest.name, body, requestKey, now, false);
    } else {
      const { lastInsertRowid: id } = db.prepare('INSERT INTO chats (visitor_key, visitor_name, updated_at) VALUES (?, ?, ?)')
        .run(visitorKey, name, now);
      addVisitorMessage(db, id, name, body, requestKey, now, true);
      routeWaitingChats(db, now);
    }
    return visitorChat(db, visitorKey);
  });
}

export function postVisitorMessage(db, visitorKey, id, body, requestKey) {
  return transaction(db, () => {
    const chat = db.prepare('SELECT visitor_name AS name, closed_at AS closedAt FROM chats WHERE id = ? AND visitor_key = ?')
      .get(id, visitorKey);
    if (!chat) return 'missing';
    if (db.prepare("SELECT 1 FROM messages WHERE chat_id = ? AND sender = 'visitor' AND request_key = ?")
      .get(id, requestKey)) return 'ok';
    if (chat.closedAt) return 'closed';
    addVisitorMessage(db, id, chat.name, body, requestKey, Date.now(), false);
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
  chat.messages = messagesFor(db, id);
  if (user.role === 'admin') chat.assignmentEvents = assignmentEvents(db, id);
  return { chats, chat };
}

export function postStaffMessage(db, user, id, body, requestKey) {
  return transaction(db, () => {
    const chat = staffChat(db, id, user);
    if (!chat) return 'missing';
    if (db.prepare("SELECT 1 FROM messages WHERE chat_id = ? AND sender = 'staff' AND request_key = ?")
      .get(id, requestKey)) return 'ok';
    if (chat.closedAt) return 'closed';
    const now = Date.now();
    db.prepare("INSERT INTO messages (chat_id, sender, sender_name, body, created_at, request_key) VALUES (?, 'staff', ?, ?, ?, ?)")
      .run(id, user.name, body, now, requestKey);
    db.prepare('UPDATE chats SET updated_at = ? WHERE id = ?').run(now, id);
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
