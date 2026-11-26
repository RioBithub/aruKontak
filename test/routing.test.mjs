import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as store from '../store.mjs';

function session(hash) {
  return { hash, expiresAt: Date.now() + 60 * 60 * 1000 };
}

function desk(t) {
  const db = store.openStore(':memory:');
  t.after(() => db.close());
  const admin = store.setupAdmin(db, 'admin-test-hash', session('admin'));
  const { agents } = store.listAgents(db);
  const activate = ({ id, username }) => {
    store.setAgentPassword(db, id, 'temporary-test-hash');
    const temporary = store.staffByUsername(db, username);
    return store.replaceTemporaryPassword(db, temporary, 'agent-test-hash', session(username));
  };
  const igun = activate(agents[0]);
  const meri = activate(agents[1]);
  const ready = (agent, accepting) => store.updatePresence(db, agent.id, agent.username, accepting);
  let nextVisitor = 0;
  const visitor = () => {
    const key = `visitor-${++nextVisitor}`;
    return store.startChat(db, key, 'Pengunjung Uji', 'Halo', key).id;
  };
  const chat = id => store.inbox(db, admin, id).chat;
  return { db, admin, igun, meri, ready, visitor, chat };
}

test('distributes waiting chats in order, using capacity, active load and last assignment', t => {
  const { db, igun, meri, ready, visitor, chat } = desk(t);
  store.updateCapacity(db, igun.id, 2);
  store.updateCapacity(db, meri.id, 4);
  ready(igun);
  ready(meri);
  const chats = Array.from({ length: 8 }, visitor);
  assert.deepEqual(chats.map(id => chat(id).assigneeId), [igun.id, meri.id, meri.id, igun.id, meri.id, meri.id, null, null]);

  store.closeChat(db, meri, chats[1]);
  assert.equal(chat(chats[6]).assigneeId, meri.id);
  assert.equal(chat(chats[7]).assigneeId, null);
  assert.equal(chat(chats[6]).assignmentEvents[0].kind, 'auto');
  ready(igun, false);
  store.closeChat(db, igun, chats[0]);
  assert.equal(chat(chats[7]).assigneeId, null);
  ready(igun, true);
  assert.equal(chat(chats[7]).assigneeId, igun.id);
});

test('requeues unanswered automatic chats when an agent loses the last online session', t => {
  const { db, admin, igun, meri, ready, visitor, chat } = desk(t);
  ready(igun);
  const answered = visitor();
  const waiting = visitor();
  const manual = visitor();
  store.postStaffMessage(db, igun, answered, 'Saya bantu.', 'reply');
  assert.equal(store.assignChat(db, admin, manual, { agentId: igun.id, expectedVersion: chat(manual).assignmentVersion }), 'ok');
  ready(meri);
  ready(igun, false);
  assert.equal(chat(waiting).assigneeId, igun.id);

  const otherSession = session('second-igun-session');
  store.loginStaff(db, igun, otherSession);
  store.updatePresence(db, igun.id, otherSession.hash);
  store.removeSession(db, igun.username);
  assert.equal(chat(waiting).assigneeId, igun.id);

  db.prepare('UPDATE agent_presence SET present_at = ? WHERE token_hash = ?').run(Date.now() - 91_000, otherSession.hash);
  store.runRouting(db);
  assert.equal(chat(waiting).assigneeId, meri.id);
  assert.deepEqual(chat(waiting).assignmentEvents.map(event => event.kind), ['auto', 'offline', 'auto']);
  assert.equal(chat(answered).assigneeId, igun.id);
  assert.equal(chat(manual).assigneeId, igun.id);
  assert.equal(store.inbox(db, igun, waiting).chat, null);
});

test('respects automatic routing settings, manual queue holds and changed assignments', t => {
  const { db, admin, igun, meri, ready, visitor, chat } = desk(t);
  store.updateRouting(db, false);
  ready(igun);
  const held = visitor();
  const automatic = visitor();
  assert.equal(chat(automatic).assigneeId, null);
  assert.equal(store.assignChat(db, admin, held, { agentId: null, hold: true, expectedVersion: 0 }), 'ok');
  store.updateRouting(db, true);
  assert.equal(chat(held).assigneeId, null);
  assert.equal(chat(held).routingState, 'hold');
  assert.equal(chat(automatic).assigneeId, igun.id);

  assert.equal(store.assignChat(db, admin, automatic, { agentId: meri.id, expectedVersion: 0 }), 'changed');
  assert.equal(chat(automatic).assigneeId, igun.id);
  assert.equal(store.assignChat(db, admin, held, {
    agentId: null, hold: false, expectedVersion: chat(held).assignmentVersion,
  }), 'ok');
  assert.equal(chat(held).assigneeId, igun.id);
  assert.deepEqual(chat(held).assignmentEvents.map(event => event.kind), ['auto', 'queue', 'hold']);
});
