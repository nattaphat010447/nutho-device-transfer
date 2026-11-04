import {
  hash, mapPool, messageKeys, parseJsonl, splitChat,
} from './util.js';
import { getState, isExcluded, remember, saveStateNow } from './state.js';
import { SYNC_TYPES, deleteLocal, readPayload, scanLocal } from './local.js';
import { applyOne } from './apply.js';
import { postJson } from './util.js';
import { cardHash } from './sources.js';

const INDEX_PATH = '/index.json';
const COPYABLE = new Set(['character', 'chat', 'world', 'preset', 'quickreply', 'groupchat']);
const DELETABLE = new Set(['character', 'chat', 'groupchat', 'world', 'preset', 'quickreply', 'background', 'avatar']);
const POOL = 3;

const filePath = (key, h) => `/f/${hash(key)}-${h}`;

/** Look at an in-memory Blob/string the way applyOne reads files from a package. */
function payloadShim(data) {
  const blob = data instanceof Blob ? data : new Blob([data]);
  return {
    file: () => ({
      async: kind => (kind === 'string' ? blob.text() : Promise.resolve(blob)),
    }),
  };
}

async function readIndex(provider) {
  const found = await provider.read(INDEX_PATH);
  if (!found) return { index: { version: 1, items: {}, devices: {} }, rev: null };
  const index = JSON.parse(await found.data.text());
  index.items ??= {};
  index.devices ??= {};
  return { index, rev: found.rev };
}

/** Decide what to do with one key. */
function classify(key, L, R, known) {
  const lUnch = Boolean(L) && known.includes(L.hash);
  const remoteAlive = R && !R.deleted;
  const rUnch = remoteAlive && known.includes(R.hash);

  if (L && remoteAlive) {
    if (L.hash === R.hash) return 'same';
    if (lUnch && !rUnch) return 'pull';
    if (!lUnch && rUnch) return 'push';
    return 'conflict';
  }
  if (L && !remoteAlive) {
    if (R?.deleted && known.length && lUnch) return 'ask-delete-local';
    return 'push';
  }
  if (!L && remoteAlive) {
    if (known.length && rUnch) return 'ask-delete-remote';
    return 'pull';
  }
  return 'gone';
}

/**
 * One two-way sync. Nothing on either side is overwritten unless it is unchanged since the last sync;
 * anything that changed on both sides is kept as two copies.
 * @returns {Promise<object>} summary for the result window
 */
export async function runSync({ provider, progress }) {
  const state = getState();
  const cloud = state.cloud;
  const include = key => !isExcluded(key);
  const summary = {
    startedAt: Date.now(), pushed: [], pulled: [], copies: [], unresolved: [], failed: [],
    askDeleteLocal: [], askDeleteRemote: [], same: 0, reloadHint: false,
  };

  const local = await scanLocal({ include, cache: cloud.hc, progress });

  let plan;
  let index;
  for (let attempt = 0; ; attempt++) {
    progress('อ่านดัชนีบนคลาวด์');
    const read = await readIndex(provider);
    index = read.index;
    plan = await makePlan(local, index, cloud.base, include, provider, progress);

    // Upload new versions first; files are named by content hash, so a retry never clobbers anything.
    let done = 0;
    await mapPool(plan.push, POOL, async (entry) => {
      progress('อัปโหลด', ++done, plan.push.length, entry.name);
      const data = await readPayload(entry);
      const path = filePath(entry.key, entry.hash);
      await provider.write(path, data);
      plan.uploaded.set(entry.key, { path, size: data.size ?? data.length ?? 0 });
    });

    const device = getState();
    index.devices[device.deviceId] = { name: device.deviceName, lastSeen: Date.now() };
    for (const entry of plan.push) {
      const old = index.items[entry.key];
      if (old?.file) plan.garbage.push(old.file);
      index.items[entry.key] = {
        type: entry.type, name: entry.name, meta: entry.meta, hash: entry.hash,
        file: plan.uploaded.get(entry.key).path, size: plan.uploaded.get(entry.key).size,
        by: device.deviceId, at: Date.now(),
      };
    }
    try {
      progress('บันทึกดัชนี');
      await provider.write(INDEX_PATH, JSON.stringify(index), { rev: read.rev ?? undefined });
      break;
    } catch (error) {
      if (!provider.isRevConflict(error) || attempt >= 2) throw error;
      plan.garbage.length = 0; // another device synced meanwhile: plan again from its index
    }
  }

  // The index now says what the cloud holds. Apply the downloads to this device.
  const device = getState();
  let done = 0;
  const writes = [...plan.pull, ...plan.copy];
  await mapPool(writes, POOL, async (job) => {
    progress('ดึงลงเครื่อง', ++done, writes.length, job.remote.name);
    try {
      const remote = job.remote;
      const data = job.data ?? (await provider.read(remote.file))?.data;
      if (!data) throw new Error('ไม่พบไฟล์บนคลาวด์');
      const row = {
        action: job.copy ? 'copy' : 'import', status: job.copy ? 'conflict' : 'update',
        item: { type: remote.type, key: job.key, name: remote.name, file: 'payload', meta: remote.meta, hash: remote.hash },
      };
      const fromName = index.devices[remote.by]?.name ?? 'อีกเครื่อง';
      await applyOne(row, payloadShim(data), fromName, () => {});
      (job.copy ? summary.copies : summary.pulled).push({ key: job.key, name: remote.name, type: remote.type });
      if (!job.copy) {
        const hashes = [remote.hash];
        if (remote.type === 'character') {
          const card = await postJson('/api/characters/get', { avatar_url: remote.meta.avatar }).catch(() => null);
          if (card) hashes.push(cardHash(card));
          delete cloud.hc[job.key];
        }
        remember(cloud.base, job.key, ...hashes);
      }
      summary.reloadHint = true;
    } catch (error) {
      summary.failed.push({ key: job.key, name: job.remote.name, error: String(error?.message ?? error) });
    }
  });

  for (const entry of plan.push) {
    remember(cloud.base, entry.key, entry.hash);
    summary.pushed.push({ key: entry.key, name: entry.name, type: entry.type });
  }
  for (const key of plan.same) remember(cloud.base, key, ...[local.get(key).hash, index.items[key].hash]);
  summary.same = plan.same.length;
  summary.unresolved = plan.unresolved;
  summary.askDeleteLocal = plan.askDeleteLocal;
  summary.askDeleteRemote = plan.askDeleteRemote;

  // Best effort: drop the cloud files this sync replaced.
  await mapPool(plan.garbage, POOL, async (path) => { try { await provider.remove(path); } catch { /* leave it */ } });

  cloud.lastSyncAt = Date.now();
  cloud.last = {
    at: cloud.lastSyncAt, pushed: summary.pushed.length, pulled: summary.pulled.length, copies: summary.copies.length,
    unresolved: summary.unresolved.length, failed: summary.failed.length,
    askDelete: summary.askDeleteLocal.length + summary.askDeleteRemote.length,
  };
  await saveStateNow();
  return summary;
}

async function makePlan(local, index, base, include, provider, progress) {
  const plan = {
    push: [], pull: [], copy: [], same: [], unresolved: [], askDeleteLocal: [], askDeleteRemote: [],
    garbage: [], uploaded: new Map(),
  };
  const keys = new Set([...local.keys(), ...Object.keys(index.items)]);
  const conflicts = [];

  for (const key of keys) {
    if (!include(key)) continue;
    const L = local.get(key);
    const R = index.items[key];
    const type = L?.type ?? R?.type;
    if (!SYNC_TYPES.has(type)) continue;
    const verdict = classify(key, L, R, base[key] ?? []);
    if (verdict === 'same') plan.same.push(key);
    else if (verdict === 'push') plan.push.push(L);
    else if (verdict === 'pull') plan.pull.push({ key, remote: R });
    else if (verdict === 'conflict') conflicts.push({ key, L, R });
    else if (verdict === 'ask-delete-local' && DELETABLE.has(type)) plan.askDeleteLocal.push({ key, name: L.name, type, entry: L });
    else if (verdict === 'ask-delete-remote' && DELETABLE.has(type)) plan.askDeleteRemote.push({ key, name: R.name, type, remote: R });
  }

  let done = 0;
  await mapPool(conflicts, POOL, async ({ key, L, R }) => {
    progress('แก้ข้อขัดแย้ง', ++done, conflicts.length, L.name);
    if (L.type === 'chat' || L.type === 'groupchat') {
      const remoteBlob = (await provider.read(R.file))?.data;
      const remote = splitChat(parseJsonl(await remoteBlob.text())).messages;
      const mine = splitChat(parseJsonl(await readPayload(L))).messages;
      const a = messageKeys(mine);
      const b = messageKeys(remote);
      const isPrefix = (short, long) => short.length <= long.length && short.every((k, i) => k === long[i]);
      if (isPrefix(a, b)) { plan.pull.push({ key, remote: R, data: remoteBlob }); return; }
      if (isPrefix(b, a)) { plan.push.push(L); return; }
      plan.copy.push({ key, remote: R, data: remoteBlob, copy: true });
      plan.push.push(L);
    } else if (COPYABLE.has(L.type)) {
      const remoteBlob = (await provider.read(R.file))?.data;
      plan.copy.push({ key, remote: R, data: remoteBlob, copy: true });
      plan.push.push(L);
    } else {
      plan.unresolved.push({ key, name: L.name, type: L.type });
    }
  });
  return plan;
}

/**
 * Carry out the deletions the user confirmed after a sync.
 * `fromHere`: items deleted on this device that should also leave the cloud.
 * `toHere`: items deleted elsewhere that should be removed from this device too.
 */
export async function applyDeletions({ provider, fromHere = [], toHere = [] }) {
  const cloud = getState().cloud;
  const failed = [];
  for (const item of toHere) {
    try {
      await deleteLocal(item.entry ?? { type: item.type, key: item.key, name: item.name, meta: item.remote?.meta ?? item.meta ?? {} });
      delete cloud.base[item.key];
    } catch (error) {
      failed.push({ name: item.name, error: String(error?.message ?? error) });
    }
  }
  if (fromHere.length) {
    for (let attempt = 0; attempt < 3; attempt++) {
      const { index, rev } = await readIndex(provider);
      const gone = [];
      for (const item of fromHere) {
        const old = index.items[item.key];
        if (old?.file) gone.push(old.file);
        index.items[item.key] = { type: item.type, name: item.name, deleted: true, at: Date.now(), by: getState().deviceId };
      }
      try {
        await provider.write(INDEX_PATH, JSON.stringify(index), { rev: rev ?? undefined });
        for (const path of gone) { try { await provider.remove(path); } catch { /* leave it */ } }
        for (const item of fromHere) delete cloud.base[item.key];
        break;
      } catch (error) {
        if (!provider.isRevConflict(error) || attempt === 2) throw error;
      }
    }
  }
  await saveStateNow();
  return { failed };
}

