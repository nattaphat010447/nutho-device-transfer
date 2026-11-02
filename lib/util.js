export const MODULE = 'nutho-device-transfer';
export const FORMAT_VERSION = 1;

export const ctx = () => SillyTavern.getContext();

function cyrb53(str, seed = 0) {
  let h1 = 0xdeadbeef ^ seed;
  let h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}

/** Same result on every device (no crypto.subtle: it is missing on plain-http LAN origins). */
export function hash(str) {
  return cyrb53(str, 0).toString(36) + cyrb53(str, 7).toString(36);
}

export function canon(value) {
  if (Array.isArray(value)) return '[' + value.map(canon).join(',') + ']';
  if (value && typeof value === 'object') {
    return '{' + Object.keys(value).sort().filter(k => value[k] !== undefined)
      .map(k => JSON.stringify(k) + ':' + canon(value[k])).join(',') + '}';
  }
  return JSON.stringify(value);
}

export const hashJson = value => hash(canon(value));

export function pick(obj, filter) {
  const out = {};
  for (const [k, v] of Object.entries(obj ?? {})) if (filter(k)) out[k] = v;
  return out;
}

export async function post(path, body = {}) {
  const res = await fetch(path, {
    method: 'POST',
    headers: ctx().getRequestHeaders(),
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${path} → ${res.status}`);
  return res;
}

export async function postJson(path, body = {}) {
  const res = await post(path, body);
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export async function getJson(path) {
  const res = await fetch(path, { headers: ctx().getRequestHeaders() });
  if (!res.ok) throw new Error(`${path} → ${res.status}`);
  return res.json();
}

export async function fetchBlob(url) {
  const res = await fetch(url, { headers: ctx().getRequestHeaders({ omitContentType: true }) });
  if (!res.ok) throw new Error(`${url} → ${res.status}`);
  return res.blob();
}

/** Returns { ok, size, mtime } for a static file without downloading it. */
export async function headInfo(url) {
  try {
    const res = await fetch(url, { method: 'HEAD', headers: ctx().getRequestHeaders({ omitContentType: true }) });
    if (!res.ok) return { ok: false, size: 0, mtime: 0 };
    const modified = res.headers.get('last-modified');
    return {
      ok: true,
      size: Number(res.headers.get('content-length') ?? 0),
      mtime: modified ? Date.parse(modified) : 0,
    };
  } catch {
    return { ok: false, size: 0, mtime: 0 };
  }
}

/** multipart upload. ST's multer only accepts the file under the field name `avatar`. */
export async function upload(path, blob, filename, fields = {}) {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.append(k, v);
  form.append('avatar', blob, filename);
  const res = await fetch(path, {
    method: 'POST',
    headers: ctx().getRequestHeaders({ omitContentType: true }),
    body: form,
  });
  if (!res.ok) throw new Error(`${path} → ${res.status}`);
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export async function mapPool(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}

export async function loadJSZip() {
  if (!window.JSZip) await import('/lib/jszip.min.js');
  if (!window.JSZip) throw new Error('JSZip ไม่พร้อมใช้งาน');
  return window.JSZip;
}

export function formatBytes(n) {
  if (!n) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  return `${(n / 1024 ** i).toFixed(i ? 1 : 0)} ${units[i]}`;
}

export function safeName(name) {
  return String(name).replace(/[\\/:*?"<>|]/g, '_').trim();
}

export function randomId(len = 8) {
  const chars = 'abcdefghjkmnpqrstuvwxyz23456789';
  let out = '';
  const bytes = crypto.getRandomValues(new Uint8Array(len));
  for (const b of bytes) out += chars[b % chars.length];
  return out;
}

export function parseJsonl(text) {
  return text.split('\n').map(line => {
    try {
      return line.trim() ? JSON.parse(line) : null;
    } catch {
      return null;
    }
  }).filter(Boolean);
}

export const toJsonl = chat => chat.map(m => JSON.stringify(m)).join('\n');

/** Split a chat array into its header line (chat_metadata) and the messages. */
export function splitChat(chat) {
  const first = chat[0];
  const hasHeader = first && 'chat_metadata' in first && !('mes' in first);
  return { header: hasHeader ? first : null, messages: hasHeader ? chat.slice(1) : chat };
}

export function messageKeys(messages) {
  return messages.map(m => `${m.send_date ?? ''}|${m.name ?? ''}|${hash(String(m.mes ?? ''))}`);
}

export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    URL.revokeObjectURL(url);
    a.remove();
  }, 60000);
}

export function timestampLabel(ms) {
  if (!ms) return '—';
  const d = new Date(ms);
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
