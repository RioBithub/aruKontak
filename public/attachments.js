import { element, notice, sizeLabel } from './common.js';

const fileLimit = 8 * 1024 * 1024;
const photoLimit = 20 * 1024 * 1024;
const mimeByExtension = { pdf: 'application/pdf', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };

function fileData(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener('load', () => resolve(reader.result.split(',')[1]));
    reader.addEventListener('error', reject);
    reader.readAsDataURL(blob);
  });
}

async function smallerPhoto(file) {
  let photo;
  let url;
  try {
    photo = await createImageBitmap(file);
  } catch {
    url = URL.createObjectURL(file);
    photo = new Image();
    photo.src = url;
    try { await photo.decode(); }
    catch (error) { URL.revokeObjectURL(url); throw error; }
  }
  try {
    const scale = Math.min(1, 1_920 / Math.max(photo.width, photo.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(photo.width * scale));
    canvas.height = Math.max(1, Math.round(photo.height * scale));
    canvas.getContext('2d').drawImage(photo, 0, 0, canvas.width, canvas.height);
    const compressed = await new Promise(resolve => canvas.toBlob(resolve, 'image/webp', 0.83));
    if (compressed && compressed.type === 'image/webp' && (scale < 1 || compressed.size < file.size)) return compressed;
    return file;
  } finally {
    photo.close?.();
    if (url) URL.revokeObjectURL(url);
  }
}

async function prepare(file) {
  const extension = file.name.split('.').at(-1)?.toLowerCase();
  const type = Object.hasOwn(mimeByExtension, extension) ? mimeByExtension[extension] : null;
  if (!type) throw new Error('Pilih PDF, JPG, PNG, atau WebP.');
  const image = type.startsWith('image/');
  if (!file.size || file.size > (image ? photoLimit : fileLimit)) {
    throw new Error(image ? 'Foto awal maksimal 20 MB.' : 'PDF maksimal 8 MB.');
  }
  const prepared = image ? await smallerPhoto(file) : file;
  if (prepared.size > fileLimit) throw new Error('Lampiran setelah dikompres maksimal 8 MB.');
  const converted = prepared !== file;
  const name = converted ? file.name.replace(/\.[^.]+$/u, '.webp') : file.name;
  let wire = prepared;
  if (!image && typeof CompressionStream === 'function') {
    const packed = await new Response(prepared.stream().pipeThrough(new CompressionStream('gzip'))).blob();
    if (packed.size < prepared.size) wire = packed;
  }
  return {
    image, preview: prepared, size: wire.size,
    payload: { clientId: crypto.randomUUID(), name, type: converted ? prepared.type : type, encoding: wire === prepared ? 'raw' : 'gzip', data: await fileData(wire) },
  };
}

export function attachmentPicker(form) {
  const root = form.querySelector('[data-upload]');
  const select = root.querySelector('[data-file-input]');
  const choose = root.querySelector('[data-choose-file]');
  const note = root.querySelector('[data-file-note]');
  const preview = root.querySelector('[data-file-preview]');
  const message = form.querySelector('textarea');
  let file = null;
  let previewUrl = null;
  let preparing = false;
  let locked = false;
  let sequence = 0;

  function sync() {
    choose.disabled = preparing || locked;
    select.disabled = preparing || locked;
    const remove = preview.querySelector('button');
    if (remove) remove.disabled = locked;
    message.required = !file;
  }

  function clear() {
    sequence++;
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    previewUrl = file = null;
    preparing = false;
    select.value = '';
    preview.hidden = true;
    preview.replaceChildren();
    notice(note);
    sync();
  }

  choose.addEventListener('click', () => select.click());
  select.addEventListener('change', async () => {
    const original = select.files?.[0];
    clear();
    if (!original) return;
    const version = sequence;
    preparing = true;
    sync();
    notice(note, 'Mengompres lampiran…');
    try {
      const ready = await prepare(original);
      if (version !== sequence) return;
      file = ready.payload;
      if (ready.image) {
        const photo = element('img', 'upload-thumbnail');
        previewUrl = URL.createObjectURL(ready.preview);
        photo.src = previewUrl;
        photo.alt = '';
        preview.append(photo);
      } else preview.append(element('span', 'file-symbol', 'PDF'));
      const copy = element('span', 'upload-copy');
      const size = sizeLabel(ready.size);
      const details = ready.size < original.size ? `${sizeLabel(original.size)} → ${size}` : size;
      copy.append(element('strong', '', file.name), element('small', '', details));
      const remove = element('button', 'secondary small', 'Hapus');
      remove.type = 'button';
      remove.setAttribute('aria-label', 'Hapus lampiran');
      remove.addEventListener('click', () => { clear(); choose.focus(); });
      preview.append(copy, remove);
      preview.hidden = false;
      notice(note, '');
    } catch (error) {
      if (version === sequence) notice(note, error instanceof Error ? error.message : 'Lampiran gagal disiapkan.', true);
    } finally {
      if (version === sequence) {
        preparing = false;
        sync();
      }
    }
  });
  form.addEventListener('reset', clear);
  return {
    get file() { return file; },
    get preparing() { return preparing; },
    lock(value) { locked = value; sync(); },
  };
}
