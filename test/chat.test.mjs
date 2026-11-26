import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { defaultRules, validateRules } from '../rules.mjs';
import * as store from '../store.mjs';

function session(hash) {
  return { hash, expiresAt: Date.now() + 60_000 };
}

test('backfills stable links for existing chats and keeps codes out of the inbox', t => {
  const directory = mkdtempSync(join(tmpdir(), 'jrcare-migration-'));
  const filename = join(directory, 'test.sqlite');
  let db = store.openStore(filename);
  t.after(() => {
    db?.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const admin = store.setupAdmin(db, 'hash', session('admin'));
  const chat = store.startChat(db, 'original-browser', 'Pengunjung', 'Pesan sebelum pembaruan', 'legacy');
  db.exec(`
    DROP INDEX chats_by_access_code;
    ALTER TABLE chats DROP COLUMN access_code;
    ALTER TABLE chats DROP COLUMN bot_pending;
    PRAGMA user_version = 1;
  `);
  db.close();
  db = null;

  db = store.openStore(filename);
  const restored = store.visitorChat(db, { key: 'original-browser' });
  assert.match(restored.code, /^[a-f0-9]{32}$/);
  assert.equal(restored.messages[0].body, 'Pesan sebelum pembaruan');
  assert.equal(Object.hasOwn(store.inbox(db, admin, chat.id).chat, 'code'), false);
  db.close();
  db = null;

  db = store.openStore(filename);
  assert.deepEqual(store.visitorChat(db, { code: restored.code }), restored);
});

test('restores the exact closed chat after a new chat starts and only lets its owner send', t => {
  const db = store.openStore(':memory:');
  t.after(() => db.close());
  const admin = store.setupAdmin(db, 'hash', session('admin'));
  const first = store.startChat(db, 'visitor', 'Pengunjung', 'Chat pertama', 'start-first');
  assert.equal(store.postVisitorMessage(db, { code: first.code }, first.id, 'Dari browser lain', 'continue-first'), 'ok');
  store.closeChat(db, admin, first.id);
  const next = store.startChat(db, 'visitor', 'Pengunjung', 'Chat berikutnya', 'start-next');

  assert.notEqual(first.code, next.code);
  assert.equal(store.visitorChat(db, { key: 'visitor' }).id, next.id);
  const closed = store.visitorChat(db, { code: first.code });
  assert.equal(closed.id, first.id);
  assert.ok(closed.closedAt);
  assert.equal(closed.messages.at(-1).body, 'Dari browser lain');
  assert.deepEqual(store.visitorHistory(db, 'visitor').map(item => item.code), [next.code, first.code]);
  assert.deepEqual(store.visitorHistory(db, 'different-browser'), []);
  assert.equal(store.postVisitorMessage(db, { code: first.code }, first.id, 'Terlambat', 'late'), 'closed');
  assert.equal(store.postVisitorMessage(db, { code: first.code }, next.id, 'Lintas chat', 'wrong-chat'), 'missing');
  assert.equal(store.startChat(db, 'visitor', 'Pengunjung', 'Chat pertama', 'start-first').id, first.id);
});

test('waits for a handoff rule, assigns an available agent, and stops replying as the bot', t => {
  const db = store.openStore(':memory:');
  t.after(() => db.close());
  const admin = store.setupAdmin(db, 'hash', session('admin'));
  const igun = store.staffByUsername(db, 'igun');
  store.setAgentPassword(db, igun.id, 'temporary');
  store.replaceTemporaryPassword(db, store.staffByUsername(db, 'igun'), 'new-password', session('igun'));
  store.updatePresence(db, igun.id, 'igun');
  store.saveRules(db, validateRules({
    ...defaultRules,
    handoff: 'rules',
    keywords: [
      { keyword: '1', match: 'exact', text: 'Balasan pilihan 1' },
      { keyword: 'cek status', match: 'contains', text: 'Meneruskan ke agen', handoff: true },
    ],
  }));

  const chat = store.startChat(db, 'visitor', 'Pengunjung', 'Halo', 'start');
  const access = { code: chat.code };
  const thread = () => store.visitorChat(db, access);
  assert.equal(store.inbox(db, admin, chat.id).chat.routingState, 'bot');
  assert.equal(store.inbox(db, igun, chat.id).chat, null);

  const send = (message, key) => assert.equal(store.postVisitorMessage(db, access, chat.id, message, key), 'ok');
  send('Saya punya 1 pertanyaan', 'number-in-sentence');
  assert.equal(thread().messages.at(-1).sender, 'visitor');
  send(' １ ', 'number');
  assert.equal(thread().messages.at(-1).body, 'Balasan pilihan 1');
  assert.equal(thread().agentName, null);

  send('Bisa CEK STATUS?', 'handoff');
  send('Bisa CEK STATUS?', 'handoff');
  assert.equal(thread().agentName, 'Igun');
  assert.equal(thread().botPending, false);
  assert.equal(thread().messages.filter(message => message.body === 'Meneruskan ke agen').length, 1);
  send('1', 'after-handoff');
  assert.equal(thread().messages.at(-1).sender, 'visitor');
});
