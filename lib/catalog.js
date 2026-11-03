import { ctx, getJson, mapPool, postJson } from './util.js';
import { splitSettings } from './parts.js';
import { listCharacters, listSmallItems, loadAllSettings } from './sources.js';

export const TABS = [
  { id: 'characters', label: 'ตัวละคร', grouped: false },
  { id: 'chats', label: 'แชท', grouped: true },
  { id: 'groups', label: 'กลุ่ม', grouped: true },
  { id: 'worlds', label: 'World Info', grouped: false },
  { id: 'presets', label: 'Presets', grouped: false },
  { id: 'appearance', label: 'หน้าตา', grouped: false },
  { id: 'extensions', label: 'Extensions', grouped: false },
  { id: 'settings', label: 'ตั้งค่า', grouped: false },
];

/** Tag names of a character (the avatar file name is the key ST uses in its tag map). */
export function tagNamesFor(avatar) {
  try {
    const { tags, tagMap } = ctx();
    const names = new Map((tags ?? []).map(t => [t.id, t.name]));
    return (tagMap?.[avatar] ?? []).map(id => names.get(id)).filter(Boolean);
  } catch {
    return [];
  }
}

/** "12.3 kB" / "1.2 MB" (the format ST reports for chat files) → bytes. */
export function parseSize(text) {
  const m = /([\d.,]+)\s*([kmg]?)i?b/i.exec(String(text ?? ''));
  if (!m) return 0;
  const power = { '': 0, k: 1, m: 2, g: 3 }[m[2].toLowerCase()];
  return Math.round(Number(m[1].replace(/,/g, '')) * 1024 ** power);
}

function toTime(value) {
  if (typeof value === 'number') return value;
  const t = Date.parse(value);
  return Number.isNaN(t) ? 0 : t;
}

/**
 * Lightweight list of everything a tab can export. Nothing heavy is read: chats come from the
 * per-character chat list, characters from /api/characters/all.
 * A session object caches results so switching tabs never repeats a request.
 */
export function createCatalog() {
  const cache = new Map();
  let allSettings = null;

  const settings = async () => (allSettings ??= loadAllSettings());

  const loaders = {
    async characters() {
      return (await listCharacters()).map(c => ({
        key: `character/${c.avatar}`,
        name: c.name || c.avatar,
        kind: 'ตัวละคร',
        tags: tagNamesFor(c.avatar),
        date: toTime(c.date_added),
        active: toTime(c.date_last_chat),
        size: Number(c.chat_size) || 0,
        sizeLabel: 'แชท',
      }));
    },

    async chats(progress) {
      const characters = await listCharacters();
      const out = [];
      let done = 0;
      await mapPool(characters, 4, async (c) => {
        progress?.(++done, characters.length);
        const list = await postJson('/api/characters/chats', { avatar_url: c.avatar });
        if (!Array.isArray(list)) return;
        for (const info of list) {
          if (!info.file_id) continue;
          out.push({
            key: `chat/${c.avatar}/${info.file_id}`,
            name: info.file_id,
            kind: 'แชท',
            group: c.avatar,
            groupName: c.name || c.avatar,
            tags: tagNamesFor(c.avatar),
            size: parseSize(info.file_size),
            count: Number(info.chat_items) || 0,
            active: toTime(info.last_mes),
          });
        }
      });
      return out;
    },

    async groups() {
      const groups = (await postJson('/api/groups/all')) ?? [];
      const out = [];
      for (const g of groups) {
        const name = g.name || g.id;
        out.push({
          key: `group/${g.id}`, name, kind: 'กลุ่ม', group: String(g.id), groupName: name,
          date: toTime(g.date_added), active: toTime(g.date_last_chat), size: Number(g.chat_size) || 0,
        });
        for (const chatId of g.chats ?? []) {
          out.push({ key: `groupchat/${chatId}`, name: chatId, kind: 'แชทกลุ่ม', group: String(g.id), groupName: name });
        }
      }
      return out;
    },

    async worlds() {
      return ((await postJson('/api/worldinfo/list')) ?? []).map(w => ({
        key: `world/${w.file_id}`, name: w.name || w.file_id, kind: 'World Info',
      }));
    },

    async presets() {
      return listSmallItems(await settings()).filter(s => s.type === 'preset').map(s => ({
        key: s.key, name: s.name, kind: s.apiId,
      }));
    },

    async appearance() {
      const labels = { theme: 'ธีม', quickreply: 'Quick Replies', movingui: 'Moving UI' };
      const out = listSmallItems(await settings()).filter(s => s.type !== 'preset').map(s => ({
        key: s.key, name: s.name, kind: labels[s.type],
      }));
      for (const bg of (await postJson('/api/backgrounds/all'))?.images ?? []) {
        out.push({ key: `background/${bg.filename}`, name: bg.filename, kind: 'พื้นหลัง' });
      }
      for (const file of (await postJson('/api/avatars/get')) ?? []) {
        out.push({ key: `avatar/${file}`, name: file, kind: 'รูป Persona' });
      }
      return out;
    },

    async extensions() {
      return (await getJson('/api/extensions/discover')).filter(e => e.type === 'local').map((e) => {
        const folder = e.name.split('/').pop();
        return { key: `extension/${folder}`, name: folder, kind: 'Extension' };
      });
    },

    async settings() {
      const parts = splitSettings(JSON.parse((await settings()).settings), { n: 0 });
      return Object.entries(parts).map(([name, part]) => ({
        key: `settings/${name}`, name: part.label, kind: name.startsWith('ext:') ? 'Extension' : 'ระบบ',
      }));
    },
  };

  return {
    /** Entries of a tab, loaded once per session. */
    load(tabId, progress) {
      if (!cache.has(tabId)) {
        const task = loaders[tabId](progress);
        task.catch(() => cache.delete(tabId)); // let a failed tab be retried
        cache.set(tabId, task);
      }
      return cache.get(tabId);
    },
    isLoaded: tabId => cache.has(tabId),
  };
}

