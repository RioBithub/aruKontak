import { exactPhrase, matchingChoice, menuMessage, outsideHours, words } from './rules.mjs';

const types = ['start', 'message', 'menu', 'collect', 'condition', 'handoff', 'close'];
const operations = ['equals', 'contains', 'present', 'work-hours'];
const nodeId = /^[a-z0-9][a-z0-9_-]{0,47}$/;
const variable = /^[a-z][a-z0-9_]{0,31}$/;
const builtins = ['name', 'phone', 'email', 'last_message'];

export function twoMessageWorkflow(menu) {
  const dataX = 590;
  const agentY = 100 + menu.choices.length * 64;
  return {
    nodes: [
      { id: 'start', type: 'start', title: 'Chat dimulai', x: 36, y: 170, next: 'menu' },
      {
        id: 'menu', type: 'menu', title: 'Sapaan dan pilihan', x: 296, y: 170,
        text: menu.greeting, hoursNotice: true, fallback: 'data-other',
        choices: menu.choices.map(({ code, label }, index) => ({ code, label, match: 'exact', next: `data-${index + 1}` })),
      },
      ...menu.choices.map(({ label, prompt }, index) => ({
        id: `data-${index + 1}`, type: 'message', title: label, x: dataX, y: 40 + index * 132,
        text: `${label}\n${prompt}\n\n${menu.waiting}`, next: 'agent',
      })),
      {
        id: 'data-other', type: 'message', title: 'Pertanyaan lain', x: dataX, y: 40 + menu.choices.length * 132,
        text: `${menu.fallback}\n\n${menu.waiting}`, next: 'agent',
      },
      { id: 'agent', type: 'handoff', title: 'Tugaskan ke agen', x: 890, y: agentY, text: '', agentId: null },
    ],
  };
}

function textField(value, limit, label) {
  if (typeof value !== 'string' || value.length > limit) throw new Error(`${label} maksimal ${limit} karakter.`);
  return value.trim();
}

function destination(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'string' || !nodeId.test(value)) throw new Error('Tujuan sambungan tidak valid.');
  return value;
}

function position(value) {
  if (!Number.isInteger(value) || value < 0 || value > 10_000) throw new Error('Posisi blok berada di luar diagram.');
  return value;
}

function normalizeNode(raw) {
  if (typeof raw?.id !== 'string' || !nodeId.test(raw.id) || !types.includes(raw.type)) throw new Error('Blok alur tidak valid.');
  const { id, type } = raw;
  const node = { id, type, title: textField(raw.title, 80, 'Nama blok'), x: position(raw.x), y: position(raw.y) };
  if (['message', 'menu', 'collect', 'close', 'handoff'].includes(type)) node.text = textField(raw.text ?? '', 2_400, 'Isi pesan');
  if (['start', 'message', 'collect'].includes(type)) node.next = destination(raw.next);
  if (type === 'menu') {
    if (!Array.isArray(raw.choices) || raw.choices.length > 20) throw new Error('Gunakan maksimal 20 pilihan per menu.');
    node.hoursNotice = raw.hoursNotice === true;
    node.fallback = destination(raw.fallback);
    node.choices = raw.choices.map(choice => ({
      code: textField(choice?.code, 32, 'Kode pilihan'),
      label: textField(choice?.label, 72, 'Nama pilihan'),
      match: choice?.match === 'contains' ? 'contains' : 'exact',
      next: destination(choice?.next),
    }));
  }
  if (type === 'collect') node.key = textField(raw.key ?? '', 32, 'Nama variabel');
  if (type === 'condition') {
    if (!operations.includes(raw.operation)) throw new Error('Jenis kondisi tidak valid.');
    node.operation = raw.operation;
    node.source = textField(raw.source ?? 'last_message', 32, 'Variabel kondisi');
    node.value = textField(raw.value ?? '', 160, 'Nilai kondisi');
    node.yes = destination(raw.yes);
    node.no = destination(raw.no);
  }
  if (type === 'handoff') {
    node.agentId = raw.agentId ?? null;
    if (node.agentId !== null && (!Number.isSafeInteger(node.agentId) || node.agentId < 1)) {
      throw new Error('Agen prioritas tidak valid.');
    }
  }
  return node;
}

function targets(node) {
  switch (node.type) {
    case 'menu': return [...node.choices.map(choice => choice.next), node.fallback];
    case 'condition': return [node.yes, node.no];
    case 'handoff':
    case 'close': return [];
    default: return [node.next];
  }
}

function validateReachable(byId) {
  const reachable = new Set();
  const pending = ['start'];
  while (pending.length) {
    const id = pending.pop();
    if (reachable.has(id)) continue;
    const node = byId.get(id);
    const label = node.title || id;
    reachable.add(id);
    if (!node.title) throw new Error(`Isi nama blok ${id}.`);
    if (['message', 'menu', 'collect'].includes(node.type) && !node.text) throw new Error(`Isi teks untuk blok “${label}”.`);
    if (node.type === 'menu') {
      const codes = node.choices.map(({ code }) => exactPhrase(code));
      const names = node.choices.map(({ label }) => words(label));
      if (!codes.length || new Set(codes).size !== codes.length || new Set(names).size !== names.length
        || node.choices.some(({ code, label, match }) => !code || !words(label) || /[\p{Cc}\u2028\u2029]/u.test(code + label)
          || (match === 'contains' && !words(code)))) {
        throw new Error(`Isi pilihan dengan kode berbeda dan nama yang jelas pada blok “${label}”.`);
      }
    }
    if (node.type === 'collect' && (!variable.test(node.key) || builtins.includes(node.key))) {
      throw new Error(`Gunakan nama variabel huruf kecil, angka, atau garis bawah pada blok “${label}”.`);
    }
    if (node.type === 'condition' && node.operation !== 'work-hours'
      && (!variable.test(node.source) || (node.operation === 'equals' && !node.value)
        || (node.operation === 'contains' && !words(node.value)))) {
      throw new Error(`Lengkapi variabel dan nilai pada kondisi “${label}”.`);
    }
    const edges = targets(node);
    if (edges.some(target => !target)) throw new Error(`Hubungkan semua keluaran blok “${label}”.`);
    pending.push(...edges);
  }

  const finished = new Set();
  const visiting = new Set();
  function check(id) {
    if (finished.has(id)) return;
    const node = byId.get(id);
    if (['menu', 'collect'].includes(node.type)) return;
    if (visiting.has(id)) throw new Error(`Alur berulang di blok “${node.title}” tanpa menunggu balasan pelanggan.`);
    visiting.add(id);
    for (const target of targets(node)) check(target);
    visiting.delete(id);
    finished.add(id);
  }
  for (const id of reachable) check(id);
}

export function validateWorkflow(input, { complete = false } = {}) {
  if (!Array.isArray(input?.nodes) || !input.nodes.length || input.nodes.length > 64) {
    throw new Error('Gunakan 1–64 blok dalam satu diagram.');
  }
  const nodes = input.nodes.map(normalizeNode);
  const byId = new Map(nodes.map(node => [node.id, node]));
  if (byId.size !== nodes.length || byId.get('start')?.type !== 'start' || nodes.some(node => node.type === 'start' && node.id !== 'start')) {
    throw new Error('Setiap blok harus berbeda dan diagram memiliki satu blok Mulai.');
  }
  if (nodes.some(node => targets(node).some(target => target && (target === 'start' || !byId.has(target))))) {
    throw new Error('Sambungkan blok ke tujuan yang tersedia.');
  }
  if (complete) validateReachable(byId);
  return { nodes };
}

function renderText(text, values) {
  return text.replace(/\{\{\s*([a-z][a-z0-9_]*)\s*\}\}/g, (_, key) => values[key] ?? '').slice(0, 8_000);
}

function matches(node, values, away, now) {
  if (node.operation === 'work-hours') return !outsideHours(away, now);
  const actual = values[node.source] ?? '';
  if (node.operation === 'present') return Boolean(actual.trim());
  if (node.operation === 'equals') return exactPhrase(actual) === exactPhrase(node.value);
  return ` ${words(actual)} `.includes(` ${words(node.value)} `);
}

export function runWorkflow(flow, progress, { input, name, phone, email, away, now }) {
  const nodes = new Map(flow.nodes.map(node => [node.id, node]));
  const answers = Object.assign(Object.create(null), progress?.answers);
  const wait = nodes.get(progress?.nodeId);
  let id = 'start';
  if (wait?.type === 'menu') id = matchingChoice(wait.choices, input)?.next ?? wait.fallback;
  if (wait?.type === 'collect') {
    answers[wait.key] = input;
    id = wait.next;
  }
  const values = Object.assign(Object.create(null), answers, { name, phone, email, last_message: input });
  const replies = [];
  for (let step = 0; step < nodes.size; step++) {
    const node = nodes.get(id);
    if (!node) break;
    if (node.type === 'condition') {
      id = matches(node, values, away, now) ? node.yes : node.no;
      continue;
    }
    const text = renderText(node.text ?? '', values);
    if (node.type === 'menu') {
      const hours = node.hoursNotice && away.enabled && outsideHours(away, now) ? renderText(away.text, values) : '';
      replies.push(menuMessage(text, node.choices, hours));
      return { replies, progress: { nodeId: id, answers }, action: null };
    }
    if (text) replies.push(text);
    if (node.type === 'collect') return { replies, progress: { nodeId: id, answers }, action: null };
    if (node.type === 'handoff' || node.type === 'close') {
      return { replies, progress: { nodeId: null, answers }, action: node.type, agentId: node.agentId ?? null };
    }
    id = node.next;
  }
  throw new Error('Alur tidak dapat menemukan langkah berikutnya.');
}

export function workflowChoices(flow, progress) {
  const node = flow.nodes.find(item => item.id === progress?.nodeId);
  return node?.type === 'menu' ? node.choices.map(({ code, label }) => ({ code, label })) : [];
}

export function previewWorkflow(flow, messages, contact, away, now) {
  const transcript = [];
  let progress = null;
  let action = null;
  for (const input of messages) {
    transcript.push({ sender: 'visitor', body: input });
    const step = runWorkflow(flow, progress, { ...contact, input, away, now });
    transcript.push(...step.replies.map(body => ({ sender: 'auto', body })));
    progress = step.progress;
    action = step.action;
    if (action) break;
  }
  return { messages: transcript, action, nodeId: progress?.nodeId ?? null, choices: workflowChoices(flow, progress) };
}
