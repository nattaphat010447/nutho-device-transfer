import {
  FORMAT_VERSION, fetchBlob, formatBytes, hash, hashJson, headInfo, loadJSZip, mapPool,
  messageKeys, postJson, randomId, splitChat, toJsonl, getJson,
} from './util.js';
import { getState, knownHashes } from './state.js';
import { splitSettings } from './parts.js';
import {
  cardHash, cleanGroup, listCharacters, listSmallItems, loadAllSettings, stVersion,
} from './sources.js';

const POOL = 4;

/**
 * Build a .nsync package (a zip with manifest.json + files/…).
 * @param {{ since: number, cats: Record<string, boolean>, progress: (label: string, done?: number, total?: number) => void }} opts
 */
export async function buildPackage({ since, cats, progress }) {
  const JSZip = await loadJSZip();
  const state = getState();
  const zip = new JSZip();
  const items = [];
  const warnings = [];
  const startedAt = Date.now();
  let fileCount = 0;

  const add = (item, data, binary = false) => {
    item.file = `files/${++fileCount}`;
    zip.file(item.file, data, { compression: binary ? 'STORE' : 'DEFLATE' });
    items.push(item);
  };
  const addJson = (item, value) => {
    // Delta mode: leave out anything the other device already confirmed in exactly this form.
    if (since && knownHashes(item.key).includes(item.hash)) return;
    const text = JSON.stringify(value);
    item.size = text.length;
    add(item, text);
  };

  const all = await loadAllSettings();
  const needSmall = cats.presets || cats.appearance;

  if (cats.settings) {
    progress('การตั้งค่า');
    const counter = { n: 0 };
    const parts = splitSettings(JSON.parse(all.settings), counter);
    for (const [name, part] of Object.entries(parts)) {
      addJson({ type: 'settings', key: `settings/${name}`, name: part.label, hash: part.hash, meta: { part: name } }, part.value);
    }
    if (counter.n) warnings.push(`ข้ามค่าลับ ${counter.n} รายการในการตั้งค่า (API key/รหัสผ่าน) — ต้องกรอกใหม่ที่เครื่องปลายทาง`);
  }

  if (needSmall) {
    progress('Presets / ธีม');
    for (const small of listSmallItems(all)) {
      const category = small.type === 'preset' ? 'presets' : 'appearance';
      if (!cats[category]) continue;
      const item = {
        type: small.type, key: small.key, name: small.name, hash: hashJson(small.value),
        meta: small.apiId ? { apiId: small.apiId } : {},
      };
      addJson(item, small.value);
    }
  }

  if (cats.worlds) {
    progress('World Info');
    const list = await postJson('/api/worldinfo/list');
    await mapPool(list, POOL, async (world) => {
      const data = await postJson('/api/worldinfo/get', { name: world.file_id });
      addJson({ type: 'world', key: `world/${world.file_id}`, name: world.name || world.file_id, hash: hashJson(data), meta: {} }, data);
    });
  }

  const characters = cats.characters || cats.chats ? await listCharacters() : [];

  if (cats.characters) {
    let done = 0;
    await mapPool(characters, POOL, async (char) => {
      progress('ตัวละคร', ++done, characters.length);
      const url = `/characters/${encodeURIComponent(char.avatar)}`;
      const info = await headInfo(url);
      if (since && info.mtime && info.mtime <= since) return;
      const card = await postJson('/api/characters/get', { avatar_url: char.avatar });
      const blob = await fetchBlob(url);
      add({
        type: 'character', key: `character/${char.avatar}`, name: char.name, hash: cardHash(card),
        size: blob.size, meta: { avatar: char.avatar, mtime: info.mtime },
      }, blob, true);
    });
  }

  if (cats.chats) {
    let done = 0;
    await mapPool(characters, POOL, async (char) => {
      progress('แชทตัวละคร', ++done, characters.length);
      const list = await postJson('/api/characters/chats', { avatar_url: char.avatar });
      if (!Array.isArray(list)) return;
      for (const info of list) {
        if (!info.file_id) continue;
        const chat = await postJson('/api/chats/get', { ch_name: char.name, file_name: info.file_id, avatar_url: char.avatar });
        if (!Array.isArray(chat) || !chat.length) continue;
        const { messages } = splitChat(chat);
        const key = `chat/${char.avatar}/${info.file_id}`;
        const chatHash = hash(messageKeys(messages).join('\n'));
        // ST only reports a display string for the last message date, so "changed" is decided by
        // content: skip chats whose current hash is one the other device already confirmed.
        if (since && knownHashes(key).includes(chatHash)) continue;
        const text = toJsonl(chat);
        add({
          type: 'chat', key, name: `${char.name} › ${info.file_id}`, hash: chatHash, size: text.length,
          meta: { avatar: char.avatar, charName: char.name, fileId: info.file_id, count: messages.length },
        }, text);
      }
    });
  }

  if (cats.groups) {
    progress('กลุ่ม');
    const groups = await postJson('/api/groups/all');
    for (const group of groups ?? []) {
      const clean = cleanGroup(group);
      addJson({ type: 'group', key: `group/${group.id}`, name: group.name || group.id, hash: hashJson(clean), meta: {} }, clean);
      for (const chatId of group.chats ?? []) {
        const chat = await postJson('/api/chats/group/get', { id: chatId });
        if (!Array.isArray(chat) || !chat.length) continue;
        const { messages } = splitChat(chat);
        const key = `groupchat/${chatId}`;
        const chatHash = hash(messageKeys(messages).join('\n'));
        if (since && knownHashes(key).includes(chatHash)) continue;
        const text = toJsonl(chat);
        add({
          type: 'groupchat', key, name: `${group.name || group.id} › ${chatId}`, hash: chatHash, size: text.length,
          meta: { groupId: group.id, chatId, count: messages.length },
        }, text);
      }
    }
  }

  if (cats.appearance) {
    progress('พื้นหลัง / รูป Persona');
    const bgs = (await postJson('/api/backgrounds/all'))?.images ?? [];
    await mapPool(bgs, POOL, async (bg) => {
      const url = `/backgrounds/${encodeURIComponent(bg.filename)}`;
      const info = await headInfo(url);
      if (since && info.mtime && info.mtime <= since) return;
      const blob = await fetchBlob(url);
      add({ type: 'background', key: `background/${bg.filename}`, name: bg.filename, hash: String(blob.size), size: blob.size, meta: {} }, blob, true);
    });
    const avatars = (await postJson('/api/avatars/get')) ?? [];
    await mapPool(avatars, POOL, async (file) => {
      const url = `/User%20Avatars/${encodeURIComponent(file)}`;
      const info = await headInfo(url);
      if (since && info.mtime && info.mtime <= since) return;
      const blob = await fetchBlob(url);
      add({ type: 'avatar', key: `avatar/${file}`, name: file, hash: String(blob.size), size: blob.size, meta: {} }, blob, true);
    });
  }

  if (cats.extensions) {
    progress('Extensions (ตรวจ git URL)');
    const found = await getJson('/api/extensions/discover');
    const local = found.filter(e => e.type === 'local');
    let done = 0;
    await mapPool(local, 3, async (ext) => {
      progress('Extensions (ตรวจ git URL)', ++done, local.length);
      const folder = ext.name.split('/').pop();
      let info = null;
      try {
        info = await postJson('/api/extensions/version', { extensionName: folder, global: false });
      } catch {
        // offline or not a git repo
      }
      if (!info?.remoteUrl) {
        warnings.push(`Extension "${folder}" ไม่มี git URL — ต้องติดตั้งเองที่ปลายทาง`);
        return;
      }
      addJson({
        type: 'extension', key: `extension/${folder}`, name: folder, hash: hash(info.remoteUrl),
        meta: { folder, url: info.remoteUrl, branch: info.currentBranchName || '' },
      }, { url: info.remoteUrl });
    });
  }

  const manifest = {
    format: 'nsync',
    formatVersion: FORMAT_VERSION,
    packId: randomId(8),
    createdAt: startedAt,
    since,
    full: !since,
    device: { id: state.deviceId, name: state.deviceName },
    stVersion: await stVersion(),
    cats: Object.keys(cats).filter(k => cats[k]),
    warnings,
    items,
  };
  zip.file('manifest.json', JSON.stringify(manifest));

  progress('กำลังบีบอัดไฟล์…');
  const blob = await zip.generateAsync({ type: 'blob', streamFiles: true }, meta => {
    progress('กำลังบีบอัดไฟล์…', Math.round(meta.percent), 100);
  });

  const stamp = new Date(startedAt).toISOString().slice(0, 16).replace(/[-:T]/g, '');
  return {
    blob,
    manifest,
    filename: `nsync-${state.deviceName.replace(/[^\w.-]+/g, '_')}-${stamp}.nsync`,
    summary: `${items.length} รายการ · ${formatBytes(blob.size)}`,
  };
}
