import { promisify } from 'node:util';
import { gzip, gunzip } from 'node:zlib';

export const maxAttachmentBytes = 8 * 1024 * 1024;
export const maxAttachmentRequest = 12 * 1024 * 1024;
const maxBase64 = Math.ceil(maxAttachmentBytes / 3) * 4;
const compress = promisify(gzip);
const expand = promisify(gunzip);
const pngHeader = Buffer.from('89504e470d0a1a0a', 'hex');
const formats = new Map([
  ['application/pdf', { ext: 'pdf', matches: data => data.subarray(0, 5).toString() === '%PDF-' }],
  ['image/jpeg', { ext: 'jpg', matches: data => data[0] === 255 && data[1] === 216 && data[2] === 255 }],
  ['image/png', { ext: 'png', matches: data => data.subarray(0, 8).equals(pngHeader) }],
  ['image/webp', { ext: 'webp', matches: data => data.subarray(0, 4).toString() === 'RIFF' && data.subarray(8, 12).toString() === 'WEBP' }],
]);

function safeName(value, ext) {
  const name = typeof value === 'string' ? value.split(/[\\/]/u).at(-1).normalize('NFC') : '';
  const base = name.replace(/[\p{Cc}\p{Cf}]/gu, '').replace(/\.[^.]*$/u, '').trim().slice(0, 116).toWellFormed();
  return `${base || 'lampiran'}.${ext}`;
}

export async function prepareAttachment(input) {
  if (input === undefined || input === null) return null;
  const format = formats.get(input.type);
  if (!format) throw new Error('Pilih lampiran PDF, JPG, PNG, atau WebP.');
  const { data, encoding } = input;
  if (typeof data !== 'string' || !data.length || data.length > maxBase64 || data.length % 4
      || /[^a-z\d+/=]/i.test(data) || (data.includes('=') && !/^={1,2}$/.test(data.slice(data.indexOf('='))))
      || !['raw', 'gzip'].includes(encoding)) {
    throw new Error('Lampiran tidak valid atau melebihi 8 MB.');
  }
  const wire = Buffer.from(data, 'base64');
  let raw = wire;
  if (encoding === 'gzip') {
    try { raw = await expand(wire, { maxOutputLength: maxAttachmentBytes }); }
    catch { throw new Error('Lampiran rusak atau melebihi 8 MB.'); }
  }
  if (!raw.length || raw.length > maxAttachmentBytes || !format.matches(raw)) {
    throw new Error('Format atau ukuran lampiran tidak sesuai. Gunakan file hingga 8 MB.');
  }
  const gzipped = encoding === 'gzip' ? wire : await compress(raw);
  const useGzip = gzipped.length < raw.length;
  return {
    name: safeName(input.name, format.ext), type: input.type, size: raw.length,
    encoding: useGzip ? 'gzip' : 'raw', data: useGzip ? gzipped : raw,
  };
}

export async function attachmentBytes(file) {
  return file.encoding === 'gzip' ? expand(file.data, { maxOutputLength: maxAttachmentBytes }) : file.data;
}
