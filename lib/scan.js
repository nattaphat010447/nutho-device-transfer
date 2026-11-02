import {
  getJson, hashJson, headInfo, loadJSZip, mapPool, messageKeys, parseJsonl, postJson, splitChat,
} from './util.js';
import { TYPE_CATEGORY, knownHashes } from './state.js';
import { splitSettings } from './parts.js';
import { cardHash, cleanGroup, listSmallItems, loadAllSettings } from './sources.js';

/**
 * Statuses: new | same | update | older | conflict | unavailable
 * Actions : import | copy | skip
 */
export const STATUS_LABEL = {
  new: 'ใหม่',
  same: 'เหมือนกัน',
  update: 'อัปเดต',
  older: 'เครื่องนี้ใหม่กว่า',
  conflict: 'ชนกัน',
  unavailable: 'ใช้ไม่ได้',
};

const COPYABLE = new Set(['character', 'chat', 'world', 'preset', 'theme', 'quickreply', 'movingui']);

export async function openPackage(file) {
  const JSZip = await loadJSZip();
  const zip = await JSZip.loadAsync(file);
  const entry = zip.file('manifest.json');
  if (!entry) throw new Error('ไม่ใช่ไฟล์ .nsync (ไม่พบ manifest.json)');
  const manifest = JSON.parse(await entry.async('string'));
  if (manifest.format !== 'nsync') throw new Error('ไฟล์นี้ไม่ใช่รูปแบบ nsync');
  if (manifest.formatVersion > 1) throw new Error('ไฟล์สร้างจาก extension เวอร์ชันใหม่กว่า กรุณาอัปเดตก่อน');
  return { zip, manifest };
}

/** Decide status from content hashes and what the other side last agreed on. */
function classifyByHash(item, localHash) {
  if (localHash === null) return 'new';
  if (localHash === item.hash) return 'same';
  const known = knownHashes(item.key);
  if (known.includes(localHash)) return 'update';
  if (known.includes(item.hash)) return 'older';
  return 'conflict';
}

function classifyChat(item, localMessages, packMessages) {
  if (localMessages === null) return 'new';
  const a = messageKeys(localMessages);
  const b = messageKeys(packMessages);
  if (a.length === b.length && a.every((k, i) => k === b[i])) return 'same';
  const isPrefix = (short, long) => short.length <= long.length && short.every((k, i) => k === long[i]);
  if (isPrefix(a, b)) return 'update';
  if (isPrefix(b, a)) return 'older';
  return 'conflict';
}

/** What happens when the row is ticked. Conflicts keep both sides whenever the type allows it. */
function defaultAction(status, item) {
  return status === 'conflict' && COPYABLE.has(item.type) ? 'copy' : 'import';
}

/** Rows ticked by default: everything that cannot destroy local data. */
function defaultSelected(status, item) {
  if (status === 'new' || status === 'update') return true;
  return status === 'conflict' && COPYABLE.has(item.type);
}

/** Compare every package item against this device and return rows for the review screen. */
export async function scanPackage({ zip, manifest }, progress) {
  const items = manifest.items;
  const need = type => items.some(i => i.type === type);
  const local = {};

  progress('อ่านข้อมูลเครื่องนี้…');
  const needAll = items.some(i => ['settings', 'preset', 'theme', 'quickreply', 'movingui'].includes(i.type));
  if (needAll) local.all = await loadAllSettings();
  if (local.all) {
    local.settingsParts = splitSettings(JSON.parse(local.all.settings), { n: 0 });
    local.small = new Map(listSmallItems(local.all).map(s => [s.key, hashJson(s.value)]));
  }
  if (need('world')) local.worlds = new Set((await postJson('/api/worldinfo/list')).map(w => w.file_id));
  if (need('group') || need('groupchat')) {
    local.groups = new Map(((await postJson('/api/groups/all')) ?? []).map(g => [String(g.id), g]));
  }
  if (need('background')) {
    local.backgrounds = new Set(((await postJson('/api/backgrounds/all'))?.images ?? []).map(i => i.filename));
  }
  if (need('avatar')) local.userAvatars = new Set((await postJson('/api/avatars/get')) ?? []);
  if (need('extension')) {
    local.extensions = new Set((await getJson('/api/extensions/discover')).map(e => e.name.split('/').pop()));
  }

  let done = 0;
  const rows = await mapPool(items, 4, async (item) => {
    progress('เทียบข้อมูล', ++done, items.length);
    let status = 'new';
    let note = '';
    try {
      status = await classify(item, zip, local);
    } catch (error) {
      status = 'unavailable';
      note = String(error?.message ?? error);
    }
    const row = {
      item,
      category: TYPE_CATEGORY[item.type],
      status,
      note,
      action: defaultAction(status, item),
      selected: defaultSelected(status, item),
      canCopy: COPYABLE.has(item.type),
    };
    if (item.type === 'extension' && status === 'new') row.note = item.meta.url;
    if (item.type === 'chat' && item.meta.count !== undefined) row.note = `${item.meta.count} ข้อความ`;
    return row;
  });
  return rows;
}

async function classify(item, zip, local) {
  const readText = () => zip.file(item.file).async('string');
  switch (item.type) {
    case 'settings': {
      const part = local.settingsParts[item.meta.part];
      return classifyByHash(item, part ? part.hash : null);
    }
    case 'preset':
    case 'theme':
    case 'quickreply':
    case 'movingui':
      return classifyByHash(item, local.small.get(item.key) ?? null);
    case 'world': {
      if (!local.worlds.has(item.key.slice('world/'.length))) return 'new';
      const data = await postJson('/api/worldinfo/get', { name: item.key.slice('world/'.length) });
      return classifyByHash(item, hashJson(data));
    }
    case 'character': {
      const exists = await headInfo(`/characters/${encodeURIComponent(item.meta.avatar)}`);
      if (!exists.ok) return 'new';
      const card = await postJson('/api/characters/get', { avatar_url: item.meta.avatar });
      return classifyByHash(item, cardHash(card));
    }
    case 'group': {
      const group = local.groups.get(String(item.key.slice('group/'.length)));
      return classifyByHash(item, group ? hashJson(cleanGroup(group)) : null);
    }
    case 'chat': {
      const { avatar, charName, fileId } = item.meta;
      const chat = await postJson('/api/chats/get', { ch_name: charName, file_name: fileId, avatar_url: avatar });
      const localMessages = Array.isArray(chat) && chat.length ? splitChat(chat).messages : null;
      const pack = splitChat(parseJsonl(await readText())).messages;
      return classifyChat(item, localMessages, pack);
    }
    case 'groupchat': {
      const chat = await postJson('/api/chats/group/get', { id: item.meta.chatId });
      const localMessages = Array.isArray(chat) && chat.length ? splitChat(chat).messages : null;
      const pack = splitChat(parseJsonl(await readText())).messages;
      return classifyChat(item, localMessages, pack);
    }
    case 'background': {
      if (!local.backgrounds.has(item.name)) return 'new';
      const info = await headInfo(`/backgrounds/${encodeURIComponent(item.name)}`);
      return info.size === item.size ? 'same' : 'conflict';
    }
    case 'avatar':
      return local.userAvatars.has(item.name) ? 'same' : 'new';
    case 'extension':
      return local.extensions.has(item.meta.folder) ? 'same' : 'new';
    default:
      return 'unavailable';
  }
}
