const messageLimit = 1_000;
const keywordLimit = 20;
const weekdays = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const jakartaClock = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Asia/Jakarta', weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
});

export const defaultRules = {
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
  keywords: [],
};

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

export function validateRules(input) {
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

  if (!Array.isArray(input.keywords) || input.keywords.length > keywordLimit) {
    throw new Error(`Gunakan maksimal ${keywordLimit} kata kunci.`);
  }
  const seen = new Set();
  const keywords = input.keywords.map(rule => {
    const keyword = typeof rule?.keyword === 'string' ? rule.keyword.trim() : '';
    const text = typeof rule?.text === 'string' ? rule.text.trim() : '';
    const normalized = words(keyword);
    if (!normalized || keyword.length > 64 || !text || text.length > messageLimit) {
      throw new Error('Isi kata kunci dan balasannya. Maksimal 64 karakter untuk kata kunci dan 1.000 untuk balasan.');
    }
    if (seen.has(normalized)) throw new Error('Gunakan kata kunci yang berbeda untuk setiap aturan.');
    seen.add(normalized);
    return { keyword, text };
  });
  return { welcome, away: { ...away, days: [...new Set(days)].sort(), start, end }, keywords };
}

function outsideHours(away, now) {
  const parts = Object.fromEntries(jakartaClock.formatToParts(now).map(({ type, value }) => [type, value]));
  const day = weekdays.indexOf(parts.weekday) + 1;
  const time = `${parts.hour}:${parts.minute}`;
  return !away.days.includes(day) || time < away.start || time >= away.end;
}

export function automaticReplies(rules, text, isNewChat, now) {
  const replies = [];
  if (isNewChat) {
    if (rules.away.enabled && outsideHours(rules.away, now)) replies.push(rules.away.text);
    else if (rules.welcome.enabled) replies.push(rules.welcome.text);
  }
  if (rules.keywords.length) {
    const phrase = ` ${words(text)} `;
    const match = rules.keywords.find(rule => phrase.includes(` ${words(rule.keyword)} `));
    if (match) replies.push(match.text);
  }
  return replies;
}
