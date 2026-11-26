const presenceLifetime = 90_000;

export function migrateRouting(db) {
  if (db.prepare('PRAGMA user_version').get().user_version >= 1) return;
  db.exec(`
    ALTER TABLE users ADD COLUMN accepting_chats INTEGER NOT NULL DEFAULT 1 CHECK (accepting_chats IN (0, 1));
    ALTER TABLE users ADD COLUMN chat_capacity INTEGER NOT NULL DEFAULT 3 CHECK (chat_capacity BETWEEN 1 AND 20);
    ALTER TABLE users ADD COLUMN last_assignment_id INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE chats ADD COLUMN routing_state TEXT NOT NULL DEFAULT 'queued'
      CHECK (routing_state IN ('queued', 'hold', 'manual', 'auto'));
    ALTER TABLE chats ADD COLUMN assignment_version INTEGER NOT NULL DEFAULT 0;

    CREATE TABLE routing_settings (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      enabled INTEGER NOT NULL CHECK (enabled IN (0, 1))
    );
    INSERT INTO routing_settings (id, enabled) VALUES (1, 1);

    CREATE TABLE agent_presence (
      token_hash TEXT PRIMARY KEY REFERENCES staff_sessions(token_hash) ON DELETE CASCADE,
      present_at INTEGER NOT NULL
    );

    CREATE TABLE assignment_events (
      id INTEGER PRIMARY KEY,
      chat_id INTEGER NOT NULL REFERENCES chats(id),
      previous_agent_id INTEGER REFERENCES users(id),
      agent_id INTEGER REFERENCES users(id),
      actor_id INTEGER REFERENCES users(id),
      kind TEXT NOT NULL CHECK (kind IN ('auto', 'manual', 'queue', 'hold', 'offline')),
      created_at INTEGER NOT NULL
    );
    CREATE INDEX assignment_events_by_chat ON assignment_events(chat_id, id DESC);
    CREATE INDEX chats_waiting ON chats(id) WHERE closed_at IS NULL AND assignee_id IS NULL AND routing_state = 'queued';
    CREATE INDEX chats_active_by_agent ON chats(assignee_id) WHERE closed_at IS NULL;
    CREATE INDEX chats_routed_automatically ON chats(assignee_id) WHERE closed_at IS NULL AND routing_state = 'auto';
    CREATE INDEX staff_replies_by_chat ON messages(chat_id) WHERE sender = 'staff';
    PRAGMA user_version = 1;
  `);
}

export function routingEnabled(db) {
  return Boolean(db.prepare('SELECT enabled FROM routing_settings WHERE id = 1').get().enabled);
}

export function agentStates(db, now = Date.now()) {
  const agents = db.prepare(`SELECT u.id, u.username, u.name,
      CASE WHEN u.password_hash IS NULL THEN 'pending' WHEN u.temporary = 1 THEN 'temporary' ELSE 'active' END AS status,
      u.accepting_chats AS accepting, u.chat_capacity AS capacity, u.last_assignment_id AS lastAssignment,
      (SELECT count(*) FROM chats c WHERE c.assignee_id = u.id AND c.closed_at IS NULL) AS activeChats,
      EXISTS (SELECT 1 FROM staff_sessions s JOIN agent_presence p ON p.token_hash = s.token_hash
        WHERE s.user_id = u.id AND s.expires_at > ? AND p.present_at > ?) AS online
    FROM users u WHERE u.role = 'agent' ORDER BY u.id`).all(now, now - presenceLifetime);
  return agents.map(agent => ({
    ...agent, accepting: Boolean(agent.accepting), online: agent.status === 'active' && Boolean(agent.online),
  }));
}

export function assignmentEvents(db, chatId) {
  return db.prepare(`SELECT e.id, e.kind, e.created_at AS at, previous.name AS previousAgent,
      agent.name AS agent, actor.name AS actor
    FROM assignment_events e LEFT JOIN users previous ON e.previous_agent_id = previous.id
    LEFT JOIN users agent ON e.agent_id = agent.id LEFT JOIN users actor ON e.actor_id = actor.id
    WHERE e.chat_id = ? ORDER BY e.id DESC LIMIT 20`).all(chatId);
}

// Call while holding the write transaction that makes the routing decision.
export function recordAssignment(db, { id, assigneeId }, agentId, state, kind, actorId, now) {
  const { lastInsertRowid } = db.prepare(`INSERT INTO assignment_events
    (chat_id, previous_agent_id, agent_id, actor_id, kind, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
    .run(id, assigneeId, agentId, actorId, kind, now);
  db.prepare('UPDATE chats SET assignee_id = ?, routing_state = ?, assignment_version = ?, bot_pending = 0 WHERE id = ?')
    .run(agentId, state, lastInsertRowid, id);
  if (agentId) db.prepare('UPDATE users SET last_assignment_id = ? WHERE id = ?').run(lastInsertRowid, agentId);
  return Number(lastInsertRowid);
}

// Oldest waiting chat first. Compare active load as a share of each agent's capacity.
export function routeWaitingChats(db, now = Date.now()) {
  if (!routingEnabled(db)) return;
  const agents = agentStates(db, now);
  const online = new Set(agents.filter(agent => agent.online).map(agent => agent.id));
  const unanswered = db.prepare(`SELECT c.id, c.assignee_id AS assigneeId FROM chats c
    WHERE c.closed_at IS NULL AND c.routing_state = 'auto'
      AND NOT EXISTS (SELECT 1 FROM messages m WHERE m.chat_id = c.id AND m.sender = 'staff')`).all();
  for (const chat of unanswered) {
    if (!online.has(chat.assigneeId)) recordAssignment(db, chat, null, 'queued', 'offline', null, now);
  }

  const ready = agents.filter(agent => agent.online && agent.accepting && agent.activeChats < agent.capacity);
  const slots = ready.reduce((total, agent) => total + agent.capacity - agent.activeChats, 0);
  if (!slots) return;
  const waiting = db.prepare(`SELECT id, assignee_id AS assigneeId FROM chats
    WHERE closed_at IS NULL AND assignee_id IS NULL AND routing_state = 'queued' AND bot_pending = 0
    ORDER BY id LIMIT ?`).all(slots);
  for (const chat of waiting) {
    const [agent] = ready.sort((a, b) => a.activeChats * b.capacity - b.activeChats * a.capacity
      || a.lastAssignment - b.lastAssignment || a.id - b.id);
    agent.lastAssignment = recordAssignment(db, chat, agent.id, 'auto', 'auto', null, now);
    if (++agent.activeChats === agent.capacity) ready.shift();
  }
}
