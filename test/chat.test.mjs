import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { defaultMenu, defaultRules, validateRules } from '../rules.mjs';
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
  store.saveRules(db, { ...defaultRules, mode: 'custom' });
  const chat = store.startChat(db, 'original-browser', 'Pengunjung', 'Pesan sebelum pembaruan', 'legacy');
  db.prepare('UPDATE reply_settings SET rules = ? WHERE id = 1').run(JSON.stringify({
    welcome: defaultRules.welcome, away: defaultRules.away, keywords: [],
  }));
  db.exec(`
    DROP TABLE message_attachments;
    DROP TABLE visitor_departures;
    DROP TABLE workflow_settings;
    DROP INDEX chats_by_access_code;
    ALTER TABLE chats DROP COLUMN preferred_agent_id;
    ALTER TABLE chats DROP COLUMN bot_progress;
    ALTER TABLE chats DROP COLUMN bot_workflow;
    ALTER TABLE chats DROP COLUMN visitor_email;
    ALTER TABLE chats DROP COLUMN visitor_phone;
    ALTER TABLE chats DROP COLUMN access_code;
    ALTER TABLE chats DROP COLUMN bot_pending;
    ALTER TABLE chats DROP COLUMN bot_menu;
    PRAGMA user_version = 1;
  `);
  db.close();
  db = null;

  db = store.openStore(filename);
  const restored = store.visitorChat(db, { key: 'original-browser' });
  assert.match(restored.code, /^[a-f0-9]{32}$/);
  assert.equal(store.getRules(db).mode, 'workflow');
  assert.equal(restored.messages[0].body, 'Pesan sebelum pembaruan');
  assert.deepEqual(restored.choices, []);
  assert.equal(Object.hasOwn(store.inbox(db, admin, chat.id).chat, 'code'), false);
  db.close();
  db = null;

  db = store.openStore(filename);
  assert.deepEqual(store.visitorChat(db, { code: restored.code }), restored);
});

test('restarts the selected topic in the same chat until a petugas starts handling it', t => {
  const db = store.openStore(':memory:');
  t.after(() => db.close());
  const admin = store.setupAdmin(db, 'hash', session('admin'));
  const chat = store.startChat(db, 'owner', 'Pengunjung', 'Halo', 'start');
  const access = { code: chat.code };
  store.postVisitorMessage(db, access, chat.id, '1', 'choice');
  const before = store.visitorChat(db, access);
  assert.equal(before.botPending, false);
  assert.equal(before.canRestart, true);
  assert.equal(store.restartVisitorTopic(db, access, chat.id, 'restart'), 'ok');
  assert.equal(store.restartVisitorTopic(db, access, chat.id, 'restart'), 'ok');
  const reset = store.visitorChat(db, access);
  assert.equal(reset.id, chat.id);
  assert.equal(reset.code, chat.code);
  assert.equal(reset.botPending, true);
  assert.ok(reset.choices.length);
  assert.equal(reset.messages.length, before.messages.length + 2);
  assert.deepEqual(reset.messages.slice(0, before.messages.length), before.messages);

  store.postStaffMessage(db, admin, chat.id, 'Bisa dibantu?', 'staff-reply');
  assert.equal(store.visitorChat(db, access).canRestart, false);
  assert.equal(store.restartVisitorTopic(db, access, chat.id, 'late-restart'), 'connected');
});

test('keeps contact with the authorized chat and resumes a confirmed departure for 24 hours', t => {
  const db = store.openStore(':memory:');
  t.after(() => db.close());
  const admin = store.setupAdmin(db, 'hash', session('admin'));
  const contact = { phone: '+628123456789', email: 'pengunjung@example.test' };
  const first = store.startChat(db, 'owner', 'Pengunjung', 'Halo', 'start', contact);
  assert.deepEqual(store.inbox(db, admin, first.id).chat.contact, contact);
  assert.equal(Object.hasOwn(first, 'contact'), false);
  assert.equal(Object.hasOwn(store.inbox(db, admin).chats[0], 'contact'), false);

  const now = 123_456_789;
  const day = 86_400_000;
  assert.equal(store.leaveChat(db, { key: 'other-browser' }, first.id, now), 'missing');
  assert.equal(store.leaveChat(db, { key: 'other-browser', code: first.code }, first.id, now), 'ok');
  assert.deepEqual({ ...store.visitorSession(db, 'other-browser', now + day - 1).resume }, {
    code: first.code, closedAt: null, expiresAt: now + day, remainingMs: 1,
  });
  assert.equal(store.visitorSession(db, 'owner', now).chat.id, first.id);
  assert.deepEqual(store.visitorSession(db, 'other-browser', now + day), { chat: null, resume: null });

  store.leaveChat(db, { key: 'owner' }, first.id);
  const second = store.startChat(db, 'owner', 'Pengunjung', 'Ada pertanyaan lain', 'next', { phone: contact.phone });
  assert.notEqual(first.id, second.id);
  assert.equal(store.visitorSession(db, 'owner').chat.id, second.id);
  assert.equal(store.visitorChat(db, { code: first.code }).closedAt, null);
  assert.deepEqual(store.inbox(db, admin, second.id).chat.contact, { phone: contact.phone, email: null });
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
  assert.equal(closed.messages.filter(message => message.sender === 'visitor').at(-1).body, 'Dari browser lain');
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
    mode: 'custom',
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

test('sends two bot messages for the selected service and assigns only after the second', t => {
  const db = store.openStore(':memory:');
  t.after(() => db.close());
  const admin = store.setupAdmin(db, 'hash', session('admin'));
  const agent = store.staffByUsername(db, 'igun');
  store.setAgentPassword(db, agent.id, 'temporary');
  store.replaceTemporaryPassword(db, store.staffByUsername(db, 'igun'), 'permanent', session('igun'));
  store.updatePresence(db, agent.id, 'igun');

  const chat = store.startChat(db, 'visitor', 'Pengunjung', '2', 'start');
  const access = { code: chat.code };
  const thread = () => store.visitorChat(db, access);
  const bot = () => thread().messages.filter(message => message.sender === 'auto');
  assert.deepEqual(chat.choices.map(choice => choice.code), defaultMenu.choices.map(choice => choice.code));
  assert.equal(bot().length, 1);
  assert.ok(bot()[0].body.includes(defaultMenu.greeting));
  assert.ok(bot()[0].body.includes(defaultMenu.choices[1].label));
  assert.equal(store.inbox(db, admin, chat.id).chat.routingState, 'bot');
  assert.equal(store.inbox(db, agent, chat.id).chat, null);

  const updated = structuredClone(defaultRules);
  const chosen = defaultMenu.choices[1];
  updated.menu.choices[1].code = '99';
  updated.menu.choices[1].prompt = 'Format baru';
  store.saveRules(db, validateRules(updated));
  assert.equal(thread().choices[1].code, chosen.code);

  assert.equal(store.postVisitorMessage(db, access, chat.id, `Nomor ${chosen.code}.`, 'choose'), 'ok');
  assert.equal(store.postVisitorMessage(db, access, chat.id, `Nomor ${chosen.code}.`, 'choose'), 'ok');
  assert.equal(bot().length, 2);
  assert.ok(bot()[1].body.includes(chosen.prompt));
  assert.ok(bot()[1].body.includes(defaultMenu.waiting));
  assert.equal(store.inbox(db, agent, chat.id).chat.routingState, 'auto');
  assert.deepEqual(thread().choices, []);

  store.postVisitorMessage(db, access, chat.id, 'Data setelah penugasan', 'detail');
  store.postStaffMessage(db, agent, chat.id, 'Balasan petugas', 'agent-reply');
  store.closeChat(db, agent, chat.id);
  assert.equal(bot().length, 2);
  assert.ok(thread().closedAt);
});

test('combines notice and menu outside opening hours and queues free-text requests', t => {
  const db = store.openStore(':memory:');
  t.after(() => db.close());
  const admin = store.setupAdmin(db, 'hash', session('admin'));
  const weekday = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Jakarta', weekday: 'short' });
  const days = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  const today = days.indexOf(weekday.format(new Date())) + 1;
  const rules = { ...defaultRules, away: { ...defaultRules.away, enabled: true, days: [(today + 2) % 7 + 1] } };
  store.saveRules(db, validateRules(rules));
  const chat = store.startChat(db, 'visitor', 'Pengunjung', 'Halo', 'start');
  assert.deepEqual(chat.messages.map(message => message.sender), ['visitor', 'auto']);
  assert.ok(chat.messages[1].body.includes(rules.away.text));

  const access = { code: chat.code };
  store.postVisitorMessage(db, access, chat.id, 'Ada yang ingin saya tanyakan', 'free-text');
  const result = store.visitorChat(db, access);
  assert.deepEqual(result.messages.map(message => message.sender), ['visitor', 'auto', 'visitor', 'auto']);
  assert.equal(result.messages.at(-1).body, `${defaultMenu.fallback}\n\n${defaultMenu.waiting}`);
  assert.equal(store.inbox(db, admin, chat.id).chat.routingState, 'queued');

  const other = store.startChat(db, 'other-browser', 'Pengunjung Lain', 'Halo', 'start');
  const choice = defaultMenu.choices[0];
  store.postVisitorMessage(db, { key: 'other-browser' }, other.id, `Saya mau bertanya tentang ${choice.label}.`, 'message');
  const lastReply = store.visitorChat(db, { key: 'other-browser' }).messages.at(-1);
  assert.equal(lastReply.body, `${choice.label}\n${choice.prompt}\n\n${defaultMenu.waiting}`);
});
