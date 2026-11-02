import { MODULE, ctx, randomId } from './util.js';

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
  state.deviceName ||= defaultDeviceName();
  state.lastConfirmedAt ??= 0;
  state.pending ??= null;
  state.synced ??= {};
  state.exportCats ??= Object.fromEntries(Object.keys(CATEGORIES).map(k => [k, true]));
  state.exportMode ??= 'delta';
  return state;
}

export function saveState() {
  ctx().saveSettingsDebounced();
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
