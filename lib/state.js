import { MODULE, ctx, post, postJson, randomId } from './util.js';

export const CATEGORIES = {
  settings: 'การตั้งค่า',
  characters: 'ตัวละคร (การ์ด + รูป)',
  chats: 'แชทตัวละคร',
  groups: 'กลุ่ม + แชทกลุ่ม',
  worlds: 'World Info',
  presets: 'Presets (Chat Completion, Instruct ฯลฯ)',
  appearance: 'ธีม / พื้นหลัง / รูป Persona / Quick Replies',
  extensions: 'รายการ Extensions',
};

export const TYPE_CATEGORY = {
  settings: 'settings',
  character: 'characters',
  chat: 'chats',
  group: 'groups',
  groupchat: 'groups',
  world: 'worlds',
  preset: 'presets',
  theme: 'appearance',
  quickreply: 'appearance',
  movingui: 'appearance',
  background: 'appearance',
  avatar: 'appearance',
  extension: 'extensions',
};

const MAX_KNOWN = 4;

function defaultDeviceName() {
  return /android/i.test(navigator.userAgent) ? 'Android' : 'PC';
}

export function getState() {
  const store = ctx().extensionSettings;
  const state = (store[MODULE] ??= {});
  state.deviceId ||= randomId(10);
  // The suffix keeps two PCs apart in the "(จาก …)" names given to conflicting copies.
  state.deviceName ||= `${defaultDeviceName()}-${state.deviceId.slice(0, 3)}`;
  state.lastConfirmedAt ??= 0;
  state.pending ??= null;
  state.synced ??= {};
  state.exportCats ??= Object.fromEntries(Object.keys(CATEGORIES).map(k => [k, true]));
  state.exportMode ??= 'delta';
  state.excluded ??= [];
  state.pageSize ??= 50;
  state.cloud ??= {};
  state.cloud.providerId ??= 'dropbox';
  state.cloud.base ??= {};
  state.cloud.hc ??= {};
  state.cloud.lastSyncAt ??= 0;
  state.cloud.last ??= null;
  return state;
}

export function saveState() {
  ctx().saveSettingsDebounced();
}

/**
 * Write our state to settings.json right now. ST only offers a debounced save, so a page reload
 * right after a sync (which the result window suggests) would otherwise lose what the sync learned
 * and the next one would report false conflicts.
 */
export async function saveStateNow() {
  saveState();
  try {
    const all = await postJson('/api/settings/get');
    const settings = JSON.parse(all.settings);
    settings.extension_settings = { ...(settings.extension_settings ?? {}), [MODULE]: structuredClone(getState()) };
    await post('/api/settings/save', settings);
  } catch (error) {
    console.warn(`[${MODULE}] could not save state immediately`, error);
  }
}

/** Hashes this device knows the other side already agreed on for an item. */
export function knownHashes(key) {
  return getState().synced[key] ?? [];
}

export function remember(map, key, ...hashes) {
  const list = map[key] ?? [];
  for (const h of hashes) {
    if (!h) continue;
    const at = list.indexOf(h);
    if (at !== -1) list.splice(at, 1);
    list.push(h);
  }
  map[key] = list.slice(-MAX_KNOWN);
}

let excludedCache = null;

function excludedSet() {
  const list = getState().excluded;
  if (!excludedCache || excludedCache.list !== list) excludedCache = { list, set: new Set(list) };
  return excludedCache.set;
}

/** Items the user left out of exports. Kept per device and applied to every later export. */
export function isExcluded(key) {
  return excludedSet().has(key);
}

export function setExcluded(keys, excluded) {
  const set = excludedSet();
  for (const key of keys) {
    if (excluded) set.add(key);
    else set.delete(key);
  }
  const state = getState();
  state.excluded = [...set];
  excludedCache = { list: state.excluded, set };
  saveState();
}
