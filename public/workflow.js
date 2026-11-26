import { api, byId, element, notice } from './common.js';

const labels = {
  start: 'Mulai', message: 'Kirim pesan', menu: 'Pilihan menu', collect: 'Minta jawaban',
  condition: 'Kondisi', handoff: 'Tugaskan ke agen', close: 'Selesaikan chat',
};
const conditionTypes = [
  ['equals', 'Sama persis'], ['contains', 'Mengandung kata atau frasa'],
  ['present', 'Variabel terisi'], ['work-hours', 'Dalam jam layanan'],
];
const board = byId('flow-canvas');
const stage = byId('flow-stage');
const props = byId('flow-properties');
const flowNote = byId('flow-note');
const testDialog = byId('flow-test');
const testNote = byId('flow-test-note');
const cardWidth = 204;
const zoomLevels = [1, 0.75, 0.5];
let settings;
let flow;
let selected = 'start';
let linking = null;
let drag = null;
let dragged = false;
let dirty = false;
let busy = false;
let testBusy = false;
let testInput = [];
let testOptions;
let generation = 0;
let onUnauthorized;

function edges(node) {
  const output = (object, key, label) => ({ object, key, label });
  if (node.type === 'menu') return [
    ...node.choices.map((choice, index) => output(choice, 'next', choice.code || `Pilihan ${index + 1}`)),
    output(node, 'fallback', 'Lainnya'),
  ];
  if (node.type === 'condition') return [output(node, 'yes', 'Ya'), output(node, 'no', 'Tidak')];
  return 'next' in node ? [output(node, 'next', 'Lanjut')] : [];
}

function updateActions() {
  byId('flow-preview').disabled = !flow || busy;
  byId('flow-save').disabled = !flow || busy || !dirty;
  byId('flow-publish').disabled = !flow || busy;
  byId('flow-add').disabled = !flow || flow.nodes.length >= 64;
  byId('flow-workspace').inert = busy;
  const status = !settings ? 'Memuat diagram…'
    : settings.active ? `Versi ${settings.publishedVersion} aktif untuk chat baru`
      : settings.publishedVersion ? 'Mode balasan lain aktif' : 'Diagram belum diterbitkan';
  const text = dirty ? `${status} · Draf belum disimpan` : status;
  if (byId('workflow-status').textContent !== text) byId('workflow-status').textContent = text;
}

function markDirty() {
  dirty = true;
  updateActions();
}

function button(text, classes = 'secondary small') {
  const control = element('button', classes, text);
  control.type = 'button';
  return control;
}

function svg(tag, attrs) {
  const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
  return node;
}

function zoom() {
  return Number(byId('flow-zoom').value);
}

function drawEdges() {
  const width = Math.max(720, ...flow.nodes.map(node => node.x + cardWidth + 48));
  const height = Math.max(440, ...flow.nodes.map(node => node.y + 145));
  stage.style.width = `${width}px`;
  stage.style.height = `${height}px`;
  stage.style.transform = `scale(${zoom()})`;
  byId('flow-sizer').style.width = `${width * zoom()}px`;
  byId('flow-sizer').style.height = `${height * zoom()}px`;
  const lines = byId('flow-lines');
  lines.setAttribute('width', width);
  lines.setAttribute('height', height);

  const byNode = new Map(flow.nodes.map(node => [node.id, node]));
  const fragment = document.createDocumentFragment();
  for (const from of flow.nodes) {
    const outputs = edges(from);
    outputs.forEach(({ object, key, label }, index) => {
      const to = byNode.get(object[key]);
      if (!to) return;
      const sx = from.x + cardWidth;
      const spread = Math.min(15, 62 / Math.max(1, outputs.length - 1));
      const sy = from.y + 49 + (index - (outputs.length - 1) / 2) * spread;
      const ex = to.x - 3;
      const ey = to.y + 49;
      const curve = Math.max(30, (ex - sx) * 0.5);
      const turn = Math.max(sy, ey, from.y + 100, to.y + 100) + 20;
      const path = ex > sx
        ? `M${sx} ${sy} C${sx + curve} ${sy} ${ex - curve} ${ey} ${ex} ${ey}`
        : `M${sx} ${sy} C${sx + 45} ${sy} ${sx + 42} ${turn} ${sx} ${turn} L${ex - 24} ${turn} Q${ex - 42} ${turn} ${ex - 36} ${ey + 10} Q${ex - 33} ${ey} ${ex} ${ey}`;
      fragment.append(svg('path', { d: path, class: from.id === selected ? 'edge selected' : 'edge' }));
      if (outputs.length > 1 && (from.id === selected || outputs.length < 6)) {
        const caption = svg('text', { x: sx + 10, y: sy - 3 });
        caption.textContent = label.slice(0, 12);
        fragment.append(caption);
      }
    });
  }
  byId('flow-edges').replaceChildren(fragment);
}

function positionCard(card, node) {
  card.style.left = `${node.x}px`;
  card.style.top = `${node.y}px`;
}

function fillCard(card, node) {
  const branchCount = edges(node).filter(({ object, key }) => object[key]).length;
  const caption = node.text || (node.type === 'menu' ? `${node.choices.length} pilihan`
    : node.type === 'condition' ? conditionTypes.find(([key]) => key === node.operation)?.[1]
      : edges(node).length ? `${branchCount}/${edges(node).length} tersambung` : '');
  const title = node.title || labels[node.type];
  card.replaceChildren();
  if (title !== labels[node.type]) card.append(element('small', '', labels[node.type]));
  card.append(element('strong', '', title));
  if (caption) card.append(element('span', '', caption));
  card.setAttribute('aria-pressed', String(node.id === selected));
  card.title = title;
}

function paintGraph() {
  for (const card of stage.querySelectorAll('.flow-node')) card.remove();
  for (const node of flow.nodes) {
    const card = button('', 'flow-node');
    card.dataset.node = node.id;
    card.dataset.type = node.type;
    positionCard(card, node);
    fillCard(card, node);
    stage.append(card);
  }
  drawEdges();
}

function refreshCard(node) {
  const card = stage.querySelector(`[data-node="${node.id}"]`);
  if (card) fillCard(card, node);
  drawEdges();
}

function field(label, control) {
  const wrap = element('label', '', label);
  control.setAttribute('aria-label', label);
  wrap.append(control);
  return wrap;
}

function textInput(label, object, key, max, node, multiline = false) {
  const input = element(multiline ? 'textarea' : 'input');
  input.maxLength = max;
  input.value = object[key] ?? '';
  if (multiline) input.rows = 4;
  input.addEventListener('input', () => {
    object[key] = input.value;
    markDirty();
    refreshCard(node);
  });
  return field(label, input);
}

function selectInput(label, options, value, change) {
  const select = element('select');
  select.append(...options.map(([key, title]) => new Option(title, key)));
  select.value = value ?? '';
  select.addEventListener('change', () => change(select.value));
  return field(label, select);
}

function setLink(link) {
  linking = link;
  stage.classList.toggle('is-linking', Boolean(link));
  const tip = byId('flow-link-note');
  tip.hidden = !link;
  tip.textContent = link ? `Pilih blok tujuan untuk ${link.label}. Tekan Esc untuk batal.` : '';
}

function targetInput(node, object, key, label) {
  const row = element('div', 'flow-link-field');
  const options = [['', 'Pilih tujuan'], ...flow.nodes.filter(item => item.type !== 'start').map(item => [item.id, item.title || labels[item.type]])];
  const choose = selectInput(label, options, object[key], value => {
    object[key] = value || null;
    setLink(null);
    markDirty();
    refreshCard(node);
  });
  const connect = button('Hubungkan');
  connect.setAttribute('aria-label', `Hubungkan ${label}`);
  connect.addEventListener('click', () => setLink({ object, key, label }));
  row.append(choose, connect);
  return row;
}

function menuFields(node) {
  const areas = [];
  const checkbox = element('input');
  checkbox.type = 'checkbox';
  checkbox.checked = node.hoursNotice;
  checkbox.addEventListener('change', () => {
    node.hoursNotice = checkbox.checked;
    markDirty();
  });
  const hours = element('label', 'check');
  hours.append(checkbox, ' Tambahkan pesan di luar jam layanan');
  areas.push(hours);
  for (const [index, choice] of node.choices.entries()) {
    const branch = element('fieldset', 'flow-branch');
    const match = selectInput('Pencocokan kode', [['exact', 'Sama persis'], ['contains', 'Ada di dalam pesan']], choice.match, value => {
      choice.match = value;
      markDirty();
    });
    const remove = button('Hapus pilihan');
    remove.addEventListener('click', () => {
      node.choices.splice(index, 1);
      setLink(null);
      markDirty();
      showProperties();
      refreshCard(node);
    });
    branch.append(element('legend', '', `Pilihan ${index + 1}`), textInput('Kode', choice, 'code', 32, node),
      textInput('Nama pilihan', choice, 'label', 72, node), match, targetInput(node, choice, 'next', 'Tujuan pilihan'), remove);
    areas.push(branch);
  }
  const add = button('Tambah pilihan');
  add.disabled = node.choices.length >= 20;
  add.addEventListener('click', () => {
    node.choices.push({ code: '', label: '', match: 'exact', next: null });
    markDirty();
    showProperties();
    refreshCard(node);
    props.querySelector('.flow-branch:last-of-type input')?.focus();
  });
  areas.push(add, targetInput(node, node, 'fallback', 'Jika tidak cocok'));
  return areas;
}

function conditionFields(node) {
  const choose = selectInput('Jenis kondisi', conditionTypes, node.operation, value => {
    node.operation = value;
    markDirty();
    showProperties();
    refreshCard(node);
    props.querySelector('select')?.focus();
  });
  const fields = [choose];
  if (node.operation !== 'work-hours') {
    fields.push(textInput('Variabel yang diperiksa', node, 'source', 32, node));
    fields.push(element('p', 'flow-field-hint', 'Gunakan last_message, name, phone, email, atau nama jawaban yang disimpan.'));
  }
  if (['equals', 'contains'].includes(node.operation)) fields.push(textInput('Nilai pembanding', node, 'value', 160, node));
  fields.push(targetInput(node, node, 'yes', 'Jika cocok'), targetInput(node, node, 'no', 'Jika tidak cocok'));
  return fields;
}

function showProperties() {
  const node = flow.nodes.find(item => item.id === selected);
  byId('flow-block-title').textContent = labels[node.type];
  byId('flow-delete').hidden = node.type === 'start';
  const fields = [textInput('Nama blok', node, 'title', 80, node)];
  if ('text' in node) {
    const title = ['handoff', 'close'].includes(node.type) ? 'Pesan (opsional)' : 'Isi pesan';
    fields.push(textInput(title, node, 'text', 2_400, node, true));
    fields.push(element('p', 'flow-field-hint', 'Sisipkan {{name}} atau {{nama_variabel}} untuk menampilkan nilai yang tersimpan.'));
  }
  if ('next' in node) fields.push(targetInput(node, node, 'next', 'Lanjut ke'));
  if (node.type === 'menu') fields.push(...menuFields(node));
  if (node.type === 'collect') fields.push(textInput('Simpan jawaban sebagai', node, 'key', 32, node));
  if (node.type === 'condition') fields.push(...conditionFields(node));
  if (node.type === 'handoff') {
    const agents = [['', 'Agen yang siap'], ...settings.agents.map(({ id, name }) => [String(id), name])];
    if (node.agentId && !agents.some(([id]) => Number(id) === node.agentId)) agents.push([String(node.agentId), 'Agen sebelumnya']);
    fields.push(selectInput('Agen prioritas', agents, String(node.agentId ?? ''), value => {
      node.agentId = value ? Number(value) : null;
      markDirty();
    }));
    fields.push(element('p', 'flow-field-hint', 'Jika agen prioritas belum siap, chat masuk ke agen lain yang siap atau menunggu di antrean.'));
  }
  props.replaceChildren(...fields);
}

function selectNode(id) {
  selected = id;
  for (const card of stage.querySelectorAll('.flow-node')) card.setAttribute('aria-pressed', String(card.dataset.node === id));
  showProperties();
  drawEdges();
}

function placeNode(node, card, x, y) {
  node.x = Math.min(10_000, Math.max(0, Math.round(x)));
  node.y = Math.min(10_000, Math.max(0, Math.round(y)));
  positionCard(card, node);
  markDirty();
  drawEdges();
}

stage.addEventListener('pointerdown', event => {
  const card = event.target.closest('.flow-node');
  if (!card || linking || event.button !== 0) return;
  const node = flow.nodes.find(item => item.id === card.dataset.node);
  drag = { card, node, pointer: event.pointerId, atX: event.clientX, atY: event.clientY, x: node.x, y: node.y };
  card.setPointerCapture(event.pointerId);
});
stage.addEventListener('pointermove', event => {
  if (drag?.pointer !== event.pointerId) return;
  const x = event.clientX - drag.atX;
  const y = event.clientY - drag.atY;
  if (!dragged && Math.hypot(x, y) < 5) return;
  dragged = true;
  placeNode(drag.node, drag.card, drag.x + x / zoom(), drag.y + y / zoom());
});
for (const type of ['pointerup', 'pointercancel']) stage.addEventListener(type, event => {
  if (drag?.pointer !== event.pointerId) return;
  if (dragged) selectNode(drag.node.id);
  drag = null;
  setTimeout(() => { dragged = false; }, 0);
});
stage.addEventListener('click', event => {
  const card = event.target.closest('.flow-node');
  if (!card || dragged) return;
  if (linking) {
    if (card.dataset.node === 'start') return;
    linking.object[linking.key] = card.dataset.node;
    setLink(null);
    markDirty();
    paintGraph();
    showProperties();
  } else selectNode(card.dataset.node);
});
byId('workflow').addEventListener('keydown', event => {
  if (event.key === 'Escape' && linking) setLink(null);
  const card = event.target.closest('.flow-node');
  const offsets = { ArrowUp: [0, -16], ArrowDown: [0, 16], ArrowLeft: [-16, 0], ArrowRight: [16, 0] };
  if (!card || !offsets[event.key]) return;
  event.preventDefault();
  const node = flow.nodes.find(item => item.id === card.dataset.node);
  const [x, y] = offsets[event.key];
  placeNode(node, card, node.x + x, node.y + y);
});

function newPosition() {
  const x = Math.min(10_000, Math.round(board.scrollLeft / zoom()) + 36);
  let y = Math.round(board.scrollTop / zoom()) + 32;
  for (const node of [...flow.nodes].sort((a, b) => a.y - b.y)) {
    if (Math.abs(x - node.x) < cardWidth + 16 && y < node.y + 114 && y + 114 > node.y) y = node.y + 116;
  }
  return { x, y: Math.min(10_000, y) };
}

byId('flow-add').addEventListener('click', () => {
  const type = byId('flow-type').value;
  const node = {
    id: `blok-${crypto.randomUUID()}`, type, title: labels[type], ...newPosition(),
  };
  if (['message', 'menu', 'collect', 'handoff', 'close'].includes(type)) node.text = '';
  if (['message', 'collect'].includes(type)) node.next = null;
  if (type === 'menu') Object.assign(node, { choices: [], fallback: null, hoursNotice: false });
  if (type === 'collect') node.key = '';
  if (type === 'condition') Object.assign(node, { operation: 'equals', source: 'last_message', value: '', yes: null, no: null });
  if (type === 'handoff') node.agentId = null;
  flow.nodes.push(node);
  selected = node.id;
  setLink(null);
  markDirty();
  paintGraph();
  showProperties();
  stage.querySelector(`[data-node="${node.id}"]`)?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  props.querySelector('input')?.focus();
});
byId('flow-delete').addEventListener('click', () => {
  flow.nodes = flow.nodes.filter(node => node.id !== selected);
  for (const node of flow.nodes) for (const { object, key } of edges(node)) if (object[key] === selected) object[key] = null;
  selected = 'start';
  setLink(null);
  markDirty();
  paintGraph();
  showProperties();
});
byId('flow-arrange').addEventListener('click', () => {
  const levels = new Map([['start', 0]]);
  const byNode = new Map(flow.nodes.map(node => [node.id, node]));
  for (const [id, level] of levels) {
    for (const { object, key } of edges(byNode.get(id))) {
      if (object[key] && !levels.has(object[key])) levels.set(object[key], level + 1);
    }
  }
  const rows = new Map();
  for (const node of flow.nodes) {
    const column = Math.min(34, levels.get(node.id) ?? 1);
    const line = rows.get(column) ?? 0;
    rows.set(column, line + 1);
    node.x = 36 + column * 268;
    node.y = 34 + line * 125;
  }
  markDirty();
  paintGraph();
  board.scrollTo(0, 0);
});
byId('flow-zoom').addEventListener('change', drawEdges);

function showSettings(data) {
  settings = data;
  flow = structuredClone(data.draft);
  selected = flow.nodes.some(node => node.id === selected) ? selected : 'start';
  dirty = false;
  setLink(null);
  byId('flow-workspace').hidden = false;
  const requiredWidth = Math.max(...flow.nodes.map(node => node.x + cardWidth + 48));
  byId('flow-zoom').value = String(zoomLevels.find(level => level * requiredWidth <= board.clientWidth) ?? 0.5);
  paintGraph();
  showProperties();
  updateActions();
}

function showError(error, where = flowNote) {
  if (error.status === 401) onUnauthorized?.();
  else notice(where, error.message, true);
}

async function readDiagram() {
  if (busy) return;
  const epoch = generation;
  busy = true;
  updateActions();
  notice(flowNote);
  try {
    const data = await api('/api/staff/workflow');
    if (epoch === generation) showSettings(data);
  } catch (error) {
    if (epoch === generation) {
      showError(error);
      if (!settings) byId('workflow-status').textContent = 'Diagram belum dapat dimuat.';
    }
  } finally {
    if (epoch === generation) {
      busy = false;
      updateActions();
      if (!settings && !flowNote.hidden) byId('workflow-status').textContent = 'Diagram belum dapat dimuat.';
    }
  }
}

export function openDiagram(expired) {
  onUnauthorized = expired;
  if (!settings || !dirty) void readDiagram();
  else updateActions();
}

export function resetDiagram() {
  ++generation;
  settings = flow = null;
  busy = testBusy = dirty = false;
  drag = null;
  selected = 'start';
  setLink(null);
  for (const node of stage.querySelectorAll('.flow-node')) node.remove();
  byId('flow-edges').replaceChildren();
  props.replaceChildren();
  byId('flow-workspace').hidden = true;
  if (testDialog.open) testDialog.close();
  notice(flowNote);
  updateActions();
}

async function saveDiagram(publish) {
  if (!flow || busy) return;
  const epoch = generation;
  busy = true;
  updateActions();
  notice(flowNote);
  try {
    const data = await api('/api/staff/workflow', { flow, version: settings.version, publish });
    if (epoch !== generation) return;
    showSettings(data);
    notice(flowNote, publish ? `Versi ${data.publishedVersion} diterbitkan untuk chat baru.` : 'Draf diagram tersimpan.');
  } catch (error) {
    if (epoch === generation) showError(error);
  } finally {
    if (epoch === generation) {
      busy = false;
      updateActions();
    }
  }
}

byId('flow-save').addEventListener('click', () => void saveDiagram(false));
byId('flow-publish').addEventListener('click', () => void saveDiagram(true));
byId('flow-reload').addEventListener('click', () => {
  if (!dirty || window.confirm('Muat ulang diagram dan buang perubahan yang belum disimpan?')) void readDiagram();
});
byId('flow-template').addEventListener('click', () => {
  if (!window.confirm('Ganti diagram yang sedang diedit dengan template dua bubble?')) return;
  flow = structuredClone(settings.template);
  selected = 'start';
  setLink(null);
  markDirty();
  paintGraph();
  showProperties();
  board.scrollTo(0, 0);
});

function renderTest(data) {
  const messages = byId('flow-test-messages');
  messages.replaceChildren(...data.messages.map(({ sender, body }) => {
    const row = element('li', `message ${sender === 'visitor' ? 'own' : 'auto'}`);
    row.append(element('strong', '', sender === 'visitor' ? 'Pengunjung uji' : 'JRCare'), element('p', '', body));
    return row;
  }));
  messages.scrollTop = messages.scrollHeight;
  const choices = byId('flow-test-choices');
  choices.replaceChildren(...data.choices.map(({ code, label }) => {
    const choice = button(`${code} — ${label}`);
    choice.addEventListener('click', () => void runTest([...testInput, code]));
    return choice;
  }));
  choices.hidden = !data.choices.length;
  byId('flow-test-reply').hidden = Boolean(data.action);
  if (data.action) notice(testNote, data.action === 'handoff' ? 'Chat masuk antrean penugasan.' : 'Chat selesai.');
  else notice(testNote);
}

async function runTest(messages) {
  if (testBusy || !flow) return;
  const epoch = generation;
  testBusy = true;
  const form = byId('flow-test-reply');
  form.querySelector('button').disabled = true;
  try {
    const data = await api('/api/staff/workflow/preview', { flow, messages, ...testOptions });
    if (epoch !== generation || !testDialog.open) return;
    testInput = messages;
    form.reset();
    renderTest(data);
  } catch (error) {
    if (epoch === generation) showError(error, testNote);
  } finally {
    if (epoch === generation) {
      testBusy = false;
      form.querySelector('button').disabled = false;
    }
  }
}

function startTest() {
  testOptions = { hours: byId('flow-test-hours').value, withEmail: byId('flow-test-email').checked };
  byId('flow-test-reply').hidden = true;
  byId('flow-test-choices').hidden = true;
  byId('flow-test-messages').replaceChildren();
  notice(testNote);
  void runTest([byId('flow-test-first').value.trim() || 'Halo']);
}
byId('flow-preview').addEventListener('click', () => {
  if (testBusy) return;
  testDialog.showModal();
  startTest();
});
byId('flow-test-start').addEventListener('submit', event => {
  event.preventDefault();
  if (!testBusy) startTest();
});
byId('flow-test-reply').addEventListener('submit', event => {
  event.preventDefault();
  const text = byId('flow-test-input').value.trim();
  if (text) void runTest([...testInput, text]);
});
