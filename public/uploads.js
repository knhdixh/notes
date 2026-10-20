// Uploading files: big photos are scaled down in the browser first, then sent as raw bytes.
import { api, toast } from '/ui.js';

const MAX_SIDE = 2400;
const MAX_BYTES = 10 * 1024 * 1024;
const RESIZABLE = /^image\/(jpeg|png|webp)$/;

export const isImage = (type) => /^image\//.test(type);

async function shrink(file) {
  if (!RESIZABLE.test(file.type)) return file;
  let bmp;
  try { bmp = await createImageBitmap(file); } catch { return file; }
  const scale = Math.min(1, MAX_SIDE / Math.max(bmp.width, bmp.height));
  if (scale === 1 && file.size <= 1.5 * 1024 * 1024) { bmp.close(); return file; }
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bmp.width * scale);
  canvas.height = Math.round(bmp.height * scale);
  canvas.getContext('2d').drawImage(bmp, 0, 0, canvas.width, canvas.height);
  bmp.close();
  const blob = await new Promise((r) => canvas.toBlob(r, 'image/webp', 0.86));
  if (!blob || blob.size >= file.size) return file;
  return new File([blob], file.name.replace(/\.[^.]+$/, '') + '.webp', { type: 'image/webp' });
}

export async function uploadFile(file) {
  const f = await shrink(file);
  if (f.size > MAX_BYTES) throw new Error(`${file.name} is over 10 MB.`);
  return api('/api/files', {
    method: 'POST', raw: f,
    headers: { 'Content-Type': f.type || 'application/octet-stream', 'X-File-Name': encodeURIComponent(f.name || 'file') },
  });
}

const label = (name) => name.replace(/\.[^.]+$/, '').replace(/[[\]]/g, '');

export const markdownFor = (f) => (isImage(f.type) ? `![${label(f.name)}](${f.url})` : `[${f.name.replace(/[[\]]/g, '')}](${f.url})`);

// Drops placeholders into the editor right away, then swaps in the real links as uploads finish.
export async function insertFiles(editor, files, pos) {
  const jobs = files.map((file) => ({
    file,
    token: `${isImage(file.type) ? '!' : ''}[Uploading ${label(file.name)}…](#up-${Math.random().toString(36).slice(2, 10)})`,
  }));
  editor.insertBlock(pos ?? editor.cursor, jobs.map((j) => j.token).join('\n'));
  await Promise.all(jobs.map(async (j) => {
    try {
      const f = await uploadFile(j.file);
      if (!editor.replaceText(j.token, markdownFor(f))) toast(`${j.file.name} uploaded; it's in Files.`);
    } catch (e) {
      editor.replaceText(j.token, '');
      toast(e.message, true);
    }
  }));
}
