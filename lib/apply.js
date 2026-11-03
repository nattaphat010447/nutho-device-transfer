import {
  MODULE, parseJsonl, post, postJson, safeName, upload,
} from './util.js';
import { getState, remember, saveState } from './state.js';
import { applyPart } from './parts.js';
import { cardHash } from './sources.js';

export function copyName(name, deviceName) {
  return safeName(`${name} (จาก ${deviceName})`);
}

/**
 * Write the selected rows to this device.
 * @returns {{ ok: number, failed: { row: object, error: string }[], needsReload: boolean }}
 */
export async function applyRows(rows, { zip, manifest }, progress) {
  const state = getState();
  const deviceName = manifest.device?.name || 'อีกเครื่อง';
  const chosen = rows.filter(r => r.selected && r.status !== 'same' && r.status !== 'unavailable');
  for (const row of rows) {
    if (row.status === 'same') remember(state.synced, row.item.key, row.item.hash);
  }
  const failed = [];
  let ok = 0;
  let needsReload = false;
  const settingsRows = [];

  const done = (row, extraHashes = []) => {
    ok++;
    // A kept-both copy did not touch the original, so it must not be recorded as agreed.
    if (row.action !== 'copy' || row.status !== 'conflict') {
      remember(state.synced, row.item.key, row.item.hash, ...extraHashes);
    }
  };

  let n = 0;
  for (const row of chosen) {
    progress(row.item.name, ++n, chosen.length);
    try {
      if (row.item.type === 'settings') {
        settingsRows.push(row);
        continue;
      }
      await applyOne(row, zip, deviceName, done);
      if (['character', 'extension', 'group', 'background', 'avatar', 'theme', 'quickreply', 'movingui'].includes(row.item.type)) {
        needsReload = true;
      }
    } catch (error) {
      failed.push({ row, error: String(error?.message ?? error) });
    }
  }

  state.lastReceived = { packId: manifest.packId, at: Date.now(), from: deviceName };

  if (settingsRows.length) {
    progress('การตั้งค่า');
    try {
      // Writes settings.json including our own state, so no separate saveState() here:
      // ST's in-memory copy is stale and must not be flushed back before the reload.
      await applySettings(settingsRows, zip, done);
      return { ok, failed, needsReload: true, settingsWritten: true };
    } catch (error) {
      for (const row of settingsRows) failed.push({ row, error: String(error?.message ?? error) });
    }
  }

  saveState();
  return { ok, failed, needsReload, settingsWritten: false };
}

async function readJson(zip, item) {
  return JSON.parse(await zip.file(item.file).async('string'));
}

export async function applyOne(row, zip, deviceName, done) {
  const { item } = row;
  const asCopy = row.action === 'copy';

  switch (item.type) {
    case 'character': {
      const blob = await zip.file(item.file).async('blob');
      const base = item.meta.avatar.replace(/\.png$/i, '');
      const target = asCopy ? `${copyName(base, deviceName)}.png` : item.meta.avatar;
      const res = await upload('/api/characters/import', blob, target, {
        file_type: 'png',
        preserved_name: target,
      });
      if (!res?.file_name) throw new Error('นำเข้าตัวละครไม่สำเร็จ');
      const card = await postJson('/api/characters/get', { avatar_url: `${res.file_name}.png` }).catch(() => null);
      done(row, card ? [cardHash(card)] : []);
      return;
    }
    case 'chat':
    case 'groupchat': {
      const chat = parseJsonl(await zip.file(item.file).async('string'));
      if (item.type === 'chat') {
        const { avatar, charName, fileId } = item.meta;
        const target = asCopy ? copyName(fileId, deviceName) : fileId;
        await postJson('/api/chats/get', { ch_name: charName, file_name: target, avatar_url: avatar });
        await post('/api/chats/save', { ch_name: charName, file_name: target, avatar_url: avatar, chat, force: true });
      } else {
        await post('/api/chats/group/save', { id: item.meta.chatId, chat, force: true });
      }
      done(row);
      return;
    }
    case 'group': {
      await post('/api/groups/edit', await readJson(zip, item));
      done(row);
      return;
    }
    case 'world': {
      const name = asCopy ? copyName(item.key.slice('world/'.length), deviceName) : item.key.slice('world/'.length);
      await post('/api/worldinfo/edit', { name, data: await readJson(zip, item) });
      done(row);
      return;
    }
    case 'preset': {
      const name = asCopy ? copyName(item.name, deviceName) : item.name;
      const preset = await readJson(zip, item);
      if (asCopy && preset?.name) preset.name = name;
      await post('/api/presets/save', { apiId: item.meta.apiId, name, preset });
      done(row);
      return;
    }
    case 'theme':
    case 'quickreply':
    case 'movingui': {
      const route = { theme: '/api/themes/save', quickreply: '/api/quick-replies/save', movingui: '/api/moving-ui/save' }[item.type];
      const value = await readJson(zip, item);
      if (asCopy) value.name = copyName(item.name, deviceName);
      await post(route, value);
      done(row);
      return;
    }
    case 'background': {
      const blob = await zip.file(item.file).async('blob');
      await upload('/api/backgrounds/upload', blob, item.name);
      done(row);
      return;
    }
    case 'avatar': {
      const blob = await zip.file(item.file).async('blob');
      await upload('/api/avatars/upload', blob, item.name, { overwrite_name: item.name });
      done(row);
      return;
    }
    case 'extension': {
      const { url, branch } = item.meta;
      // Not retried: a 502 can arrive after the clone finished, and a second try would fail with "exists".
      await post('/api/extensions/install', { url, global: false, ...(branch ? { branch } : {}) }, { retries: 0 });
      done(row);
      return;
    }
    default:
      throw new Error(`ไม่รู้จักชนิด ${item.type}`);
  }
}

async function applySettings(rows, zip, done) {
  const state = getState();
  const all = await postJson('/api/settings/get');
  const settings = JSON.parse(all.settings);
  for (const row of rows) applyPart(settings, await readJson(zip, row.item));

  // Keep this device's own sync bookkeeping: the package must never overwrite it.
  for (const row of rows) done(row);
  settings.extension_settings = { ...(settings.extension_settings ?? {}), [MODULE]: structuredClone(state) };
  await post('/api/settings/save', settings);
}
