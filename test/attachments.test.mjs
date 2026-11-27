import assert from 'node:assert/strict';
import { test } from 'node:test';
import { gzipSync } from 'node:zlib';
import { attachmentBytes, maxAttachmentBytes, prepareAttachment } from '../attachments.mjs';
import * as store from '../store.mjs';

const pdf = Buffer.from(`%PDF-1.7\n${'sample document\n'.repeat(400)}%%EOF`);
const payload = { name: 'dokumen.pdf', type: 'application/pdf', encoding: 'raw', data: pdf.toString('base64') };

test('preserves compressed PDF bytes and checks file format and expanded size', async () => {
  const compressed = await prepareAttachment({ ...payload, encoding: 'gzip', data: gzipSync(pdf).toString('base64') });
  assert.equal(compressed.encoding, 'gzip');
  assert.ok(compressed.data.length < pdf.length);
  assert.deepEqual(await attachmentBytes(compressed), pdf);
  assert.equal((await prepareAttachment({ ...payload, name: 'folder/berkas.html' })).name, 'berkas.pdf');
  await assert.rejects(prepareAttachment({ ...payload, type: 'image/png' }), /Format/);
  const oversized = Buffer.alloc(maxAttachmentBytes + 1, 0);
  await assert.rejects(prepareAttachment({ ...payload, encoding: 'gzip', data: gzipSync(oversized).toString('base64') }), /8 MB/);
});

test('stores a file with its message once and authorizes download by conversation', async t => {
  const db = store.openStore(':memory:');
  t.after(() => db.close());
  const admin = store.setupAdmin(db, 'hash', { hash: 'admin', expiresAt: Date.now() + 60_000 });
  const agent = store.staffByUsername(db, 'igun');
  const other = store.staffByUsername(db, 'meri');
  const file = await prepareAttachment(payload);
  const chat = store.startChat(db, 'visitor', 'Pengunjung', '', 'first', { attachment: file });
  store.startChat(db, 'visitor', 'Pengunjung', '', 'first', { attachment: file });
  const message = chat.messages[0];
  assert.equal(message.attachment.name, payload.name);
  assert.equal(Object.hasOwn(message.attachment, 'data'), false);
  assert.equal(db.prepare('SELECT count(*) AS count FROM message_attachments').get().count, 1);
  assert.equal(store.visitorAttachment(db, message.id, { key: 'another-visitor' }), undefined);
  assert.equal(store.staffAttachment(db, message.id, agent), undefined);
  assert.equal(store.assignChat(db, admin, chat.id, { agentId: agent.id }), 'ok');
  assert.equal(store.visitorChat(db, { code: chat.code }).canRestart, false);
  assert.equal(store.staffAttachment(db, message.id, other), undefined);
  assert.deepEqual(await attachmentBytes(store.visitorAttachment(db, message.id, { code: chat.code })), pdf);
  assert.deepEqual(await attachmentBytes(store.staffAttachment(db, message.id, agent)), pdf);
  assert.equal(store.postStaffMessage(db, agent, chat.id, '', 'response', file), 'ok');
  assert.ok(store.visitorChat(db, { code: chat.code }).messages.at(-1).attachment);
});
