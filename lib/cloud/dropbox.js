import { randomId } from '../util.js';
import { CALLBACK_URL, DROPBOX_APP_KEY } from './config.js';

const STORE = 'nutho-device-transfer:dropbox';
const TOKEN_URL = 'https://api.dropboxapi.com/oauth2/token';

/* Tokens live in this browser's localStorage, never in settings.json (any extension can read that,
   and it would travel to the other device). Every device signs in once for itself. */
function loadTokens() {
  try {
    return JSON.parse(localStorage.getItem(STORE) ?? 'null');
  } catch {
    return null;
  }
}
function saveTokens(tokens) {
  try {
    if (tokens) localStorage.setItem(STORE, JSON.stringify(tokens));
    else localStorage.removeItem(STORE);
  } catch {
    // storage blocked: the sign-in only lasts for this page load
  }
}

let memoryTokens = null;
const tokens = () => memoryTokens ?? (memoryTokens = loadTokens());
const setTokens = (t) => { memoryTokens = t; saveTokens(t); };

function base64Url(bytes) {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function pkcePair() {
  const verifier = base64Url(crypto.getRandomValues(new Uint8Array(48)));
  if (globalThis.crypto?.subtle) {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
    return { verifier, challenge: base64Url(new Uint8Array(digest)), method: 'S256' };
  }
  // crypto.subtle only exists in secure contexts (https / localhost). Dropbox accepts "plain" as a fallback.
  return { verifier, challenge: verifier, method: 'plain' };
}

async function tokenRequest(params) {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: DROPBOX_APP_KEY, ...params }),
  });
  if (!res.ok) throw new Error(`Dropbox sign-in failed (${res.status}): ${await res.text()}`);
  return res.json();
}

async function accessToken() {
  const t = tokens();
  if (!t) throw new Error('ยังไม่ได้เชื่อมต่อ Dropbox');
  if (t.expiresAt - 60_000 > Date.now()) return t.access;
  const fresh = await tokenRequest({ grant_type: 'refresh_token', refresh_token: t.refresh });
  setTokens({ ...t, access: fresh.access_token, expiresAt: Date.now() + fresh.expires_in * 1000 });
  return tokens().access;
}

async function api(url, { arg, body, retries = 3, headers = {} } = {}) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${await accessToken()}`,
        ...(arg ? { 'Dropbox-API-Arg': JSON.stringify(arg).replace(/[\u007f-￿]/g, c => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`) } : {}),
        ...headers,
      },
      body,
    });
    if (res.ok) return res;
    const retryable = [429, 500, 502, 503, 504].includes(res.status);
    if (!retryable || attempt >= retries) {
      const text = await res.text();
      const error = new Error(`Dropbox ${res.status}: ${text.slice(0, 200)}`);
      error.status = res.status;
      error.body = text;
      throw error;
    }
    const wait = Number(res.headers.get('retry-after')) * 1000 || 1000 * 2 ** attempt;
    await new Promise(r => setTimeout(r, wait));
  }
}

export const dropbox = {
  id: 'dropbox',
  name: 'Dropbox',

  configured: () => Boolean(DROPBOX_APP_KEY),
  isConnected: () => Boolean(tokens()?.refresh),

  /** Opens the Dropbox consent window; resolves once this device holds a refresh token. */
  async connect() {
    if (!DROPBOX_APP_KEY) throw new Error('ยังไม่ได้ตั้งค่า Dropbox app key');
    const { verifier, challenge, method } = await pkcePair();
    const state = randomId(16);
    const url = new URL('https://www.dropbox.com/oauth2/authorize');
    url.search = new URLSearchParams({
      client_id: DROPBOX_APP_KEY, response_type: 'code', token_access_type: 'offline',
      code_challenge: challenge, code_challenge_method: method, redirect_uri: CALLBACK_URL, state,
    }).toString();

    const popup = window.open(url.toString(), 'nutho-dropbox', 'width=520,height=700');
    if (!popup) throw new Error('เบราว์เซอร์บล็อกหน้าต่างล็อกอิน (popup) กรุณาอนุญาตแล้วลองใหม่');

    const code = await new Promise((resolve, reject) => {
      const done = (fn, value) => {
        window.removeEventListener('message', onMessage);
        clearInterval(timer);
        fn(value);
      };
      const onMessage = (event) => {
        const data = event.data;
        if (!data || data.source !== 'nutho-device-transfer' || data.state !== state) return;
        if (data.error) done(reject, new Error(data.error));
        else done(resolve, data.code);
      };
      window.addEventListener('message', onMessage);
      const timer = setInterval(() => {
        if (popup.closed) done(reject, new Error('ปิดหน้าต่างล็อกอินก่อนเสร็จ'));
      }, 600);
    });

    const token = await tokenRequest({
      grant_type: 'authorization_code', code, code_verifier: verifier, redirect_uri: CALLBACK_URL,
    });
    setTokens({ access: token.access_token, refresh: token.refresh_token, expiresAt: Date.now() + token.expires_in * 1000 });
  },

  disconnect: () => setTokens(null),

  /** @returns {Promise<{ data: Blob, rev: string } | null>} null when the file does not exist */
  async read(path) {
    try {
      const res = await api('https://content.dropboxapi.com/2/files/download', { arg: { path } });
      const meta = JSON.parse(res.headers.get('dropbox-api-result') ?? '{}');
      return { data: await res.blob(), rev: meta.rev };
    } catch (error) {
      if (error.status === 409 && /not_found/.test(error.body)) return null;
      throw error;
    }
  },

  /** `rev` makes the write conditional: it fails with status 409 'conflict' if someone else wrote first. */
  async write(path, data, { rev } = {}) {
    const mode = rev ? { '.tag': 'update', update: rev } : { '.tag': 'overwrite' };
    const res = await api('https://content.dropboxapi.com/2/files/upload', {
      arg: { path, mode, mute: true, autorename: false },
      body: data,
      headers: { 'Content-Type': 'application/octet-stream' },
    });
    return (await res.json()).rev;
  },

  async remove(path) {
    try {
      await api('https://api.dropboxapi.com/2/files/delete_v2', {
        arg: undefined, body: JSON.stringify({ path }), headers: { 'Content-Type': 'application/json' },
      });
    } catch (error) {
      if (error.status === 409 && /not_found/.test(error.body)) return;
      throw error;
    }
  },

  isRevConflict: error => error?.status === 409 && /conflict/.test(error.body ?? ''),
};
