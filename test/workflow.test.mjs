import assert from 'node:assert/strict';
import { test } from 'node:test';
import { defaultRules } from '../rules.mjs';
import * as store from '../store.mjs';
import { previewWorkflow, twoMessageWorkflow, validateWorkflow } from '../workflow.mjs';

function desk(t) {
  const db = store.openStore(':memory:');
  t.after(() => db.close());
  const session = hash => ({ hash, expiresAt: Date.now() + 60_000 });
  const admin = store.setupAdmin(db, 'hash', session('admin'));
  const agents = store.listAgents(db).agents.slice(0, 2);
  for (const { id, username } of agents) {
    store.setAgentPassword(db, id, 'temporary');
    store.replaceTemporaryPassword(db, store.staffByUsername(db, username), 'changed', session(username));
    store.updatePresence(db, id, username);
  }
  return { db, admin, agents };
}

function intake(agentId) {
  const node = (id, type, fields) => ({ id, type, title: id, x: 15, y: 30, ...fields });
  return validateWorkflow({ nodes: [
    node('start', 'start', { next: 'collect' }),
    node('collect', 'collect', { text: 'Nomor pengajuan Anda?', key: 'referensi', next: 'check' }),
    node('check', 'condition', { operation: 'present', source: 'email', value: '', yes: 'handoff', no: 'close' }),
    node('handoff', 'handoff', { text: 'Terima kasih {{name}}. Kami cek {{referensi}}.', agentId }),
    node('close', 'close', { text: 'Percakapan uji selesai.' }),
  ] }, { complete: true });
}

test('keeps incomplete drafts separate and rejects unconnected or automatic loops at publication', () => {
  const flow = twoMessageWorkflow(defaultRules.menu);
  flow.nodes[0].next = null;
  assert.doesNotThrow(() => validateWorkflow(flow));
  assert.throws(() => validateWorkflow(flow, { complete: true }), /Hubungkan/);
  flow.nodes[0].next = 'menu';
  flow.nodes.find(node => node.id === 'data-1').next = 'data-1';
  assert.throws(() => validateWorkflow(flow, { complete: true }), /tanpa menunggu balasan/);
  flow.nodes.find(node => node.id === 'data-1').next = 'menu';
  assert.doesNotThrow(() => validateWorkflow(flow, { complete: true }));
});

test('publishes versioned workflows for new chats and routes collected answers through conditions', t => {
  const { db, admin, agents: [first, preferred] } = desk(t);
  const original = store.startChat(db, 'legacy', 'Pengunjung Lama', 'Halo', 'start');
  const next = intake(preferred.id);
  const draft = store.saveDiagram(db, next, 1, false);
  assert.equal(draft.publishedVersion, 1);
  assert.ok(store.startChat(db, 'before-publish', 'Pengunjung', 'Halo', 'start').choices.length);
  assert.equal(store.saveDiagram(db, next, 1, true), null);
  assert.equal(store.saveDiagram(db, next, draft.version, true).publishedVersion, 3);

  const visitor = store.startChat(db, 'new-browser', 'Pengunjung Baru', 'Halo', 'start', {
    phone: '0812345678', email: 'pengunjung@example.test',
  });
  assert.equal(visitor.messages.at(-1).body, 'Nomor pengajuan Anda?');
  assert.equal(store.postVisitorMessage(db, { code: visitor.code }, visitor.id, 'REF-12', 'answer'), 'ok');
  const assigned = store.inbox(db, admin, visitor.id).chat;
  assert.equal(assigned.assigneeId, preferred.id);
  assert.deepEqual(assigned.answers, { referensi: 'REF-12' });
  assert.equal(assigned.messages.at(-1).body, 'Terima kasih Pengunjung Baru. Kami cek REF-12.');

  const other = store.startChat(db, 'other', 'Pengunjung Baru', 'Halo', 'start', { phone: '0812345678' });
  store.postVisitorMessage(db, { code: other.code }, other.id, 'REF-13', 'answer');
  assert.ok(store.visitorChat(db, { code: other.code }).closedAt);

  store.postVisitorMessage(db, { code: original.code }, original.id, '1', 'answer');
  const legacy = store.inbox(db, admin, original.id).chat;
  assert.equal(legacy.assigneeId, first.id);
  assert.equal(legacy.messages.filter(message => message.sender === 'auto').length, 2);
});

test('simulates working-hours branches and menu matches with the published runtime', () => {
  const flow = twoMessageWorkflow(defaultRules.menu);
  flow.nodes[0].next = 'hours';
  flow.nodes.push({
    id: 'hours', type: 'condition', title: 'Jam layanan', x: 10, y: 10,
    operation: 'work-hours', yes: 'menu', no: 'data-other',
  });
  const preview = date => previewWorkflow(validateWorkflow(flow, { complete: true }), ['Halo', 'Nomor 2.'],
    { name: 'Uji', phone: '0812345678', email: '' }, defaultRules.away, new Date(date));
  const open = preview('2026-01-05T09:00:00+07:00');
  assert.equal(open.action, 'handoff');
  assert.match(open.messages.at(-1).body, /Status pengajuan/);
  const closed = preview('2026-01-04T09:00:00+07:00');
  assert.equal(closed.action, 'handoff');
  assert.deepEqual(closed.messages.map(item => item.sender), ['visitor', 'auto']);
});
