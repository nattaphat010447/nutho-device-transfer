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

// Reverse proxies on hosted servers answer 502/503/504 now and then (slow origin, restarts).
const RETRY_STATUS = new Set([502, 503, 504]);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/** fetch with retries on gateway errors and dropped connections. Other HTTP errors fail at once. */
async function request(path, init, retries) {
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt) await sleep(1000 * 2 ** (attempt - 1));
    try {
      const res = await fetch(path, { ...init, cache: 'no-cache' });
      if (res.ok) return res;
      lastError = new Error(`${path} → ${res.status}`);
      lastError.status = res.status;
      if (!RETRY_STATUS.has(res.status)) throw lastError;
    } catch (error) {
      if (error.status && !RETRY_STATUS.has(error.status)) throw error;
      lastError = error;
    }
  }
  throw lastError;
}

/** `retries: 0` for requests that are not safe to repeat (e.g. installing an extension). */
export async function post(path, body = {}, { retries = 3 } = {}) {
  return request(path, {
    method: 'POST',
    headers: ctx().getRequestHeaders(),
    body: JSON.stringify(body),
  }, retries);
}

export async function postJson(path, body = {}, options) {
  const res = await post(path, body, options);
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export async function getJson(path) {
  const res = await request(path, { headers: ctx().getRequestHeaders() }, 3);
  return res.json();
}

export async function fetchBlob(url) {
  const res = await request(url, { headers: ctx().getRequestHeaders({ omitContentType: true }) }, 3);
  return res.blob();
}

/**
 * Returns { ok, size, mtime } for a static file without downloading it.
 * `ok: false` means the file does not exist (404). Any other failure throws, so a flaky proxy
 * can never be mistaken for "missing" and turn an existing item into an overwrite.
 */
export async function headInfo(url) {
  // A CDN (Cloudflare) caches a 404 per URL for minutes. Probing a not-yet-imported file at its
  // real URL would leave the avatar zoom (/characters/<file>) returning that cached 404 after the
  // import, so every probe uses a one-off URL.
  const probe = `${url}${url.includes('?') ? '&' : '?'}nsync=${Date.now().toString(36)}${randomId(4)}`;
  try {
    const res = await request(probe, { method: 'HEAD', headers: ctx().getRequestHeaders({ omitContentType: true }) }, 3);
    const modified = res.headers.get('last-modified');
    return {
      ok: true,
      size: Number(res.headers.get('content-length') ?? 0),
      mtime: modified ? Date.parse(modified) : 0,
    };
  } catch (error) {
    if (error.status === 404) return { ok: false, size: 0, mtime: 0 };
    throw error;
  }
}

/** multipart upload. ST's multer only accepts the file under the field name `avatar`. */
export async function upload(path, blob, filename, fields = {}) {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.append(k, v);
  form.append('avatar', blob, filename);
  const res = await request(path, {
    method: 'POST',
    headers: ctx().getRequestHeaders({ omitContentType: true }),
    body: form,
  }, 2);
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
