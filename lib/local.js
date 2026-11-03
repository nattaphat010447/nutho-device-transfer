import {
  fetchBlob, hash, hashJson, headInfo, mapPool, messageKeys, post, postJson, splitChat, toJsonl,
} from './util.js';
import { cardHash, cleanGroup, listCharacters, listSmallItems, loadAllSettings } from './sources.js';

/** What the cloud sync carries: play content only. API, UI and extension settings stay per device. */
export const SYNC_TYPES = new Set([
  'character', 'chat', 'group', 'groupchat', 'world', 'preset', 'quickreply', 'background', 'avatar',
]);

const POOL = 4;

/**
 * Hash everything syncable on this device without downloading it twice: items that look unchanged
 * (same fingerprint as last time) reuse their cached hash.
 * @param {{ include: (key: string) => boolean, cache: Record<string, { fp: string, hash: string }>, progress: (label: string, done?: number, total?: number) => void }} opts
 * @returns {Promise<Map<string, object>>}
 */
export async function scanLocal({ include, cache, progress }) {
  const entries = new Map();
  const add = (entry) => entries.set(entry.key, entry);
  const cached = (key, fp) => (cache[key]?.fp === fp ? cache[key].hash : null);
  const remember = (key, fp, value) => { cache[key] = { fp, hash: value }; return value; };

  progress('อ่านการตั้งค่า');
  const all = await loadAllSettings();
  for (const small of listSmallItems(all)) {
    if (!['preset', 'quickreply'].includes(small.type) || !include(small.key)) continue;
    add({
      type: small.type, key: small.key, name: small.name, hash: hashJson(small.value),
      meta: small.apiId ? { apiId: small.apiId } : {}, value: small.value,
    });
  }

  progress('World Info');
  for (const world of (await postJson('/api/worldinfo/list')) ?? []) {
    const key = `world/${world.file_id}`;
    if (!include(key)) continue;
    const data = await postJson('/api/worldinfo/get', { name: world.file_id });
    add({ type: 'world', key, name: world.name || world.file_id, hash: hashJson(data), meta: {}, value: data });
  }

  progress('รายชื่อตัวละคร');
  const characters = await listCharacters();

  let done = 0;
  await mapPool(characters, POOL, async (char) => {
    progress('ตัวละคร', ++done, characters.length);
    const key = `character/${char.avatar}`;
    if (!include(key)) return;
    const info = await headInfo(`/characters/${encodeURIComponent(char.avatar)}`);
    const fp = `${info.mtime}|${info.size}`;
    let h = cached(key, fp);
    if (!h) h = remember(key, fp, cardHash(await postJson('/api/characters/get', { avatar_url: char.avatar })));
    add({ type: 'character', key, name: char.name || char.avatar, hash: h, meta: { avatar: char.avatar }, fp });
  });

  done = 0;
  await mapPool(characters, POOL, async (char) => {
    progress('แชท', ++done, characters.length);
    const list = await postJson('/api/characters/chats', { avatar_url: char.avatar });
    if (!Array.isArray(list)) return;
    for (const info of list) {
      if (!info.file_id) continue;
      const key = `chat/${char.avatar}/${info.file_id}`;
      if (!include(key)) continue;
      const fp = `${info.file_size}|${info.chat_items}|${info.last_mes}`;
      let h = cached(key, fp);
      if (!h) {
        const chat = await postJson('/api/chats/get', { ch_name: char.name, file_name: info.file_id, avatar_url: char.avatar });
        if (!Array.isArray(chat) || !chat.length) continue;
        h = remember(key, fp, hash(messageKeys(splitChat(chat).messages).join('\n')));
      }
      add({
        type: 'chat', key, name: `${char.name} › ${info.file_id}`, hash: h, fp,
        meta: { avatar: char.avatar, charName: char.name, fileId: info.file_id },
      });
    }
  });

  progress('กลุ่ม');
  for (const group of (await postJson('/api/groups/all')) ?? []) {
    const gKey = `group/${group.id}`;
    const clean = cleanGroup(group);
    if (include(gKey)) {
      add({ type: 'group', key: gKey, name: group.name || String(group.id), hash: hashJson(clean), meta: {}, value: clean });
    }
    for (const chatId of group.chats ?? []) {
      const key = `groupchat/${chatId}`;
      if (!include(key)) continue;
      const chat = await postJson('/api/chats/group/get', { id: chatId });
      if (!Array.isArray(chat) || !chat.length) continue;
      add({
        type: 'groupchat', key, name: `${group.name || group.id} › ${chatId}`,
        hash: hash(messageKeys(splitChat(chat).messages).join('\n')), meta: { groupId: group.id, chatId },
      });
    }
  }

  progress('พื้นหลัง / รูป Persona');
  const bgs = (await postJson('/api/backgrounds/all'))?.images ?? [];
  await mapPool(bgs, POOL, async (bg) => {
    const key = `background/${bg.filename}`;
    if (!include(key)) return;
    const info = await headInfo(`/backgrounds/${encodeURIComponent(bg.filename)}`);
    add({ type: 'background', key, name: bg.filename, hash: String(info.size), meta: {} });
  });
  for (const file of (await postJson('/api/avatars/get')) ?? []) {
    const key = `avatar/${file}`;
    if (!include(key)) continue;
    const info = await headInfo(`/User%20Avatars/${encodeURIComponent(file)}`);
    add({ type: 'avatar', key, name: file, hash: String(info.size), meta: {} });
  }

  return entries;
}

/** The bytes (Blob) or text to upload for a scanned item. */
export async function readPayload(entry) {
  switch (entry.type) {
    case 'character':
      return fetchBlob(`/characters/${encodeURIComponent(entry.meta.avatar)}`);
    case 'chat': {
      const { avatar, charName, fileId } = entry.meta;
      return toJsonl(await postJson('/api/chats/get', { ch_name: charName, file_name: fileId, avatar_url: avatar }));
    }
    case 'groupchat':
      return toJsonl(await postJson('/api/chats/group/get', { id: entry.meta.chatId }));
    case 'group':
    case 'world':
    case 'preset':
    case 'quickreply':
      return JSON.stringify(entry.value);
    case 'background':
      return fetchBlob(`/backgrounds/${encodeURIComponent(entry.name)}`);
    case 'avatar':
      return fetchBlob(`/User%20Avatars/${encodeURIComponent(entry.name)}`);
    default:
      throw new Error(`ไม่รู้จักชนิด ${entry.type}`);
  }
}

/** Remove an item from this device (only ever called after the user confirmed it). */
export async function deleteLocal(entry) {
  const { meta } = entry;
  switch (entry.type) {
    case 'character':
      return post('/api/characters/delete', { avatar_url: meta.avatar, delete_chats: false });
    case 'chat':
      return post('/api/chats/delete', { chatfile: `${meta.fileId}.jsonl`, avatar_url: meta.avatar });
    case 'groupchat':
      return post('/api/chats/group/delete', { id: meta.chatId });
    case 'world':
      return post('/api/worldinfo/delete', { name: entry.key.slice('world/'.length) });
    case 'preset':
      return post('/api/presets/delete', { apiId: meta.apiId, name: entry.name });
    case 'quickreply':
      return post('/api/quick-replies/delete', { name: entry.name });
    case 'background':
      return post('/api/backgrounds/delete', { bg: entry.name });
    case 'avatar':
      return post('/api/avatars/delete', { avatar: entry.name });
    default:
      throw new Error(`ลบชนิด ${entry.type} ไม่ได้`);
  }
}
