const messageLimit = 1_000;
const keywordLimit = 20;
const weekdays = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const jakartaClock = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Asia/Jakarta', weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
});

export const defaultMenu = {
  greeting: 'Halo, selamat datang di Helpdesk JRCare. Pilih layanan yang Anda perlukan.',
  choices: [
    {
      code: '1', label: 'Pengajuan santunan',
      prompt: 'Ceritakan pengajuan yang ingin Anda tanyakan.\n- Tanggal dan lokasi kejadian\n- Tahap pengajuan saat ini\n- Pertanyaan atau kendala yang dialami',
    },
    {
      code: '2', label: 'Status pengajuan',
      prompt: 'Lengkapi data untuk pengecekan status.\n- Nomor pengajuan atau referensi (jika ada)\n- Tanggal pengajuan\n- Informasi yang ingin dicek',
    },
    {
      code: '3', label: 'Informasi layanan',
      prompt: 'Tuliskan layanan yang ingin diketahui dan pertanyaan Anda.',
    },
  ],
  fallback: 'Ceritakan kebutuhan Anda. Sertakan nomor pengajuan atau referensi bila relevan dan tersedia.',
  waiting: 'Mohon tunggu, chat Anda diteruskan ke petugas. Anda bisa melengkapi data di chat ini.',
};

export const defaultRules = {
  mode: 'two-message',
  menu: defaultMenu,
  welcome: {
    enabled: true,
    text: 'Halo, terima kasih sudah menghubungi JRCare. Pesan Anda sudah masuk dan akan kami tanggapi di sini.',
  },
  away: {
    enabled: false,
    text: 'Terima kasih sudah menghubungi JRCare. Saat ini di luar jam layanan. Pesan Anda sudah masuk dan akan kami tanggapi saat layanan kembali buka.',
    days: [1, 2, 3, 4, 5],
    start: '08:00',
    end: '17:00',
  },
  handoff: 'immediate',
  keywords: [],
};

function exactPhrase(text) {
  return text.normalize('NFKC').toLocaleLowerCase('id-ID').trim().replace(/\s+/gu, ' ');
}

function words(text) {
  return (text.normalize('NFKC').toLocaleLowerCase('id-ID').match(/[\p{L}\p{N}]+/gu) ?? []).join(' ');
}

function messageSetting(value, label) {
  if (typeof value?.enabled !== 'boolean' || typeof value.text !== 'string') {
    throw new Error(`${label} belum valid.`);
  }
  const text = value.text.trim();
  if (text.length > messageLimit || (value.enabled && !text)) {
    throw new Error(`Isi ${label.toLowerCase()} saat diaktifkan, maksimal ${messageLimit} karakter.`);
  }
  return { enabled: value.enabled, text };
}

function requiredText(value, max, label) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text || text.length > max) throw new Error(`Isi ${label}, maksimal ${max} karakter.`);
  return text;
}

function validateMenu(menu) {
  const greeting = requiredText(menu?.greeting, messageLimit, 'sapaan menu');
  const fallback = requiredText(menu.fallback, messageLimit, 'format data untuk pertanyaan lain');
  const waiting = requiredText(menu.waiting, messageLimit, 'pesan tunggu');
  if (!Array.isArray(menu.choices) || !menu.choices.length || menu.choices.length > keywordLimit) {
    throw new Error(`Isi 1–${keywordLimit} pilihan layanan.`);
  }
  const codes = new Set();
  const labels = new Set();
  const choices = menu.choices.map(choice => {
    const code = requiredText(choice?.code, 32, 'kode pilihan');
    const label = requiredText(choice.label, 72, 'nama layanan');
    const prompt = requiredText(choice.prompt, messageLimit, 'format data layanan');
    if (/[\p{Cc}\u2028\u2029]/u.test(`${code}${label}`) || !words(label)) {
      throw new Error('Masukkan kode pilihan dan nama layanan masing-masing dalam satu baris.');
    }
    const key = exactPhrase(code);
    const name = words(label);
    if (codes.has(key) || labels.has(name)) throw new Error('Gunakan kode dan nama yang berbeda untuk setiap pilihan layanan.');
    codes.add(key);
    labels.add(name);
    return { code, label, prompt };
  });
  return { greeting, choices, fallback, waiting };
}

export function validateRules(input) {
  const mode = input.mode === undefined ? defaultRules.mode : input.mode;
  if (!['two-message', 'custom'].includes(mode)) throw new Error('Pilih alur balasan otomatis yang valid.');
  const menu = validateMenu(input.menu === undefined ? defaultMenu : input.menu);
  const welcome = messageSetting(input.welcome, 'Sapaan');
  const away = messageSetting(input.away, 'Pesan di luar jam layanan');
  const { days, start, end } = input.away;
  if (!Array.isArray(days) || days.some(day => !Number.isInteger(day) || day < 1 || day > 7)
      || (away.enabled && !days.length)) {
    throw new Error('Pilih hari layanan sebelum mengaktifkan pesan di luar jam layanan.');
  }
  const clockTime = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
  if (typeof start !== 'string' || typeof end !== 'string'
      || !clockTime.test(start) || !clockTime.test(end) || start >= end) {
    throw new Error('Masukkan jam mulai dan selesai. Jam selesai harus setelah jam mulai.');
  }

  const handoff = input.handoff === undefined ? 'immediate' : input.handoff;
  if (!['immediate', 'rules', 'rules-or-unmatched'].includes(handoff)) {
    throw new Error('Pilih alur penerusan chat yang valid.');
  }
  if (!Array.isArray(input.keywords) || input.keywords.length > keywordLimit) {
    throw new Error(`Gunakan maksimal ${keywordLimit} aturan balasan.`);
  }
  const seen = new Set();
  const keywords = input.keywords.map(rule => {
    const keyword = typeof rule?.keyword === 'string' ? rule.keyword.trim() : '';
    const text = typeof rule?.text === 'string' ? rule.text.trim() : '';
    const match = rule?.match === undefined ? 'contains' : rule.match;
    const forward = rule?.handoff === undefined ? false : rule.handoff;
    if (!['exact', 'contains'].includes(match) || typeof forward !== 'boolean') {
      throw new Error('Pilih cara pencocokan dan tindakan yang valid untuk setiap aturan.');
    }
    const normalized = match === 'exact' ? exactPhrase(keyword) : words(keyword);
    if (!normalized || keyword.length > 64 || !text || text.length > messageLimit) {
      throw new Error('Isi pemicu dan balasannya. Maksimal 64 karakter untuk pemicu dan 1.000 untuk balasan.');
    }
    const key = `${match}:${normalized}`;
    if (seen.has(key)) throw new Error('Pemicu dengan cara pencocokan yang sama harus berbeda.');
    seen.add(key);
    return { keyword, text, match, handoff: forward };
  });
  return { mode, menu, welcome, away: { ...away, days: [...new Set(days)].sort(), start, end }, handoff, keywords };
}

function outsideHours(away, now) {
  const parts = Object.fromEntries(jakartaClock.formatToParts(now).map(({ type, value }) => [type, value]));
  const day = weekdays.indexOf(parts.weekday) + 1;
  const time = `${parts.hour}:${parts.minute}`;
  return !away.days.includes(day) || time < away.start || time >= away.end;
}

function menuAutomation(menu, away, text, { isNewChat, botPending, now }) {
  if (isNewChat) {
    const choices = menu.choices.map(({ code, label }) => `${code} — ${label}`).join('\n');
    const instructions = 'Balas dengan kode pilihan atau tuliskan kebutuhan Anda.';
    const hours = away.enabled && outsideHours(away, now) ? away.text : '';
    const greeting = [menu.greeting, choices, instructions, hours].filter(Boolean).join('\n\n');
    return { replies: [greeting], handoff: false };
  }
  if (!botPending) return { replies: [], handoff: false };

  const input = exactPhrase(text);
  const numeric = input.match(/^(?:(?:pilih(?:an)?|nomor)\s+)?(\d+)[.)]?$/u)?.[1];
  const normalized = words(text);
  const phrase = ` ${normalized} `;
  const choice = menu.choices.find(option => [input, numeric].includes(exactPhrase(option.code)))
    ?? menu.choices.find(option => words(option.label) === normalized)
    ?? menu.choices.find(option => phrase.includes(` ${words(option.label)} `));
  const data = choice ? `${choice.label}\n${choice.prompt}` : menu.fallback;
  return { replies: [`${data}\n\n${menu.waiting}`], handoff: true };
}

export function automationFor(rules, text, context) {
  const { isNewChat, botPending, now, menu } = context;
  if (menu) return menuAutomation(menu, rules.away, text, context);
  const replies = [];
  if (isNewChat) {
    if (rules.away.enabled && outsideHours(rules.away, now)) replies.push(rules.away.text);
    else if (rules.welcome.enabled) replies.push(rules.welcome.text);
  }
  if (!botPending && rules.handoff !== 'immediate') return { replies, handoff: false };

  const exact = exactPhrase(text);
  const phrase = ` ${words(text)} `;
  const match = rules.keywords.find(rule => rule.match === 'exact'
    ? exact === exactPhrase(rule.keyword)
    : phrase.includes(` ${words(rule.keyword)} `));
  if (match) replies.push(match.text);
  return {
    replies,
    handoff: rules.handoff === 'immediate' || Boolean(match?.handoff)
      || (rules.handoff === 'rules-or-unmatched' && !match),
  };
}
