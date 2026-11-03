import { h } from './dom.js';
import { MODULE, packCode, timestampLabel } from './util.js';
import { getState, saveState } from './state.js';
import { TABS } from './catalog.js';
import { openPackage, scanPackage, STATUS_LABEL } from './scan.js';
import { applyRows } from './apply.js';
import { createPicker } from './picker.js';
import { openModal } from './modal.js';

const KIND = {
  settings: 'ตั้งค่า', character: 'ตัวละคร', chat: 'แชท', group: 'กลุ่ม', groupchat: 'แชทกลุ่ม', world: 'World Info',
  preset: 'Preset', theme: 'ธีม', quickreply: 'Quick Replies', movingui: 'Moving UI', background: 'พื้นหลัง',
  avatar: 'รูป Persona', extension: 'Extension',
};

/** Turn scan rows into list entries; chats cluster under their character, group chats under their group. */
function toEntries(rows) {
  const groupNames = new Map(rows.filter(r => r.item.type === 'group').map(r => [r.item.key.slice('group/'.length), r.item.name]));
  return rows.map((row) => {
    const { item } = row;
    const entry = {
      key: item.key, name: item.name, kind: KIND[item.type] ?? item.type, tags: item.meta?.tags ?? [],
      size: item.size, status: row.status, note: row.note,
      disabled: row.status === 'same' || row.status === 'unavailable', row,
    };
    if (item.type === 'chat') {
      entry.group = item.meta.avatar;
      entry.groupName = item.meta.charName;
      entry.count = item.meta.count;
      entry.note = '';
    } else if (item.type === 'groupchat' || item.type === 'group') {
      const id = item.type === 'group' ? item.key.slice('group/'.length) : String(item.meta.groupId);
      entry.group = id;
      entry.groupName = groupNames.get(id) ?? `กลุ่ม ${id}`;
      if (item.type === 'groupchat') {
        entry.count = item.meta.count;
        entry.note = '';
      }
    }
    return entry;
  });
}

/** Import window: scan the package against this device, then let the user pick what to bring in. */
export async function startImport(file) {
  const state = getState();
  const modal = openModal({ title: 'Import' });
  modal.body.append(h('div', { class: 'ndt-muted', text: 'กำลังอ่านไฟล์…' }));

  let pkg;
  let rows;
  try {
    pkg = await openPackage(file);
    rows = await scanPackage(pkg, (label, done, total) => {
      modal.body.replaceChildren(h('div', { class: 'ndt-muted', text: total ? `${label} ${done}/${total}` : label }));
    });
  } catch (error) {
    console.error(`[${MODULE}]`, error);
    modal.body.replaceChildren(h('div', { class: 'ndt-error', text: `อ่านไฟล์ไม่สำเร็จ: ${error?.message ?? error}` }));
    return;
  }

  const { manifest } = pkg;
  const entries = toEntries(rows);
  const byKey = new Map(rows.map(r => [r.item.key, r]));
  const selection = {
    isSelected: key => byKey.get(key)?.selected ?? false,
    set: (keys, selected) => {
      for (const key of keys) {
        const row = byKey.get(key);
        if (row && row.status !== 'same' && row.status !== 'unavailable') row.selected = selected;
      }
    },
  };
  const usable = r => r.status !== 'same' && r.status !== 'unavailable';

  const counts = {};
  for (const row of rows) counts[row.status] = (counts[row.status] ?? 0) + 1;
  const header = h('div', { class: 'ndt-head' },
    h('div', { class: 'ndt-title', text: `จาก "${manifest.device?.name ?? '?'}" · ${timestampLabel(manifest.createdAt)}` }),
    h('div', { class: 'ndt-muted', text: `${manifest.full ? 'ส่งเต็ม' : `ส่งเฉพาะที่เปลี่ยนหลัง ${timestampLabel(manifest.since)}`} · ${rows.length} รายการ · ${Object.entries(counts).map(([s, n]) => `${STATUS_LABEL[s]} ${n}`).join(' · ')}` }),
    ...manifest.warnings.slice(0, 6).map(w => h('div', { class: 'ndt-warn', text: `⚠ ${w}` })));

  const prefs = Object.fromEntries(TABS.map(t => [t.id, {
    status: '!same', pageSize: state.pageSize,
    onPageSize: (n) => { state.pageSize = n; saveState(); },
  }]));
  const content = h('div', { class: 'ndt-tab-content' });
  modal.body.replaceChildren(header, content);

  const applyButton = h('div', { class: 'menu_button menu_button_icon ndt-primary' },
    h('i', { class: 'fa-solid fa-download' }), h('span'));
  const progress = h('div', { class: 'ndt-progress' });
  const summary = h('div', { class: 'ndt-muted ndt-foot-info' });
  modal.footer.append(h('div', { class: 'ndt-foot-text' }, summary, progress), applyButton);

  const tabButtons = {};
  const present = TABS.filter(t => entries.some(e => e.row.category === t.id));
  const tabEntries = id => entries.filter(e => e.row.category === id);

  function updateFooter() {
    const n = rows.filter(r => r.selected && usable(r)).length;
    applyButton.querySelector('span').textContent = `นำเข้าที่เลือก (${n})`;
    applyButton.classList.toggle('disabled', n === 0);
    summary.textContent = 'ติ๊กไว้เริ่มต้น: ของใหม่ + อัปเดต + เก็บทั้งสองเมื่อชนกัน (ไม่ทับของเดิม)';
    for (const tab of present) {
      const list = tabEntries(tab.id).filter(e => !e.disabled);
      tabButtons[tab.id].querySelector('.ndt-tab-count').textContent = list.length
        ? `${list.filter(e => e.row.selected).length}/${list.length}` : '';
    }
  }

  function show(tabId) {
    for (const [id, b] of Object.entries(tabButtons)) b.classList.toggle('ndt-active', id === tabId);
    const tab = TABS.find(t => t.id === tabId);
    content.replaceChildren(createPicker({
      entries: tabEntries(tabId), grouped: tab.grouped, selection, prefs: prefs[tabId], onChange: updateFooter,
    }));
  }

  for (const tab of present) {
    const button = h('div', { class: 'ndt-tab', onclick: () => show(tab.id) },
      h('span', { text: tab.label }), h('span', { class: 'ndt-tab-count' }));
    tabButtons[tab.id] = button;
    modal.tabs.append(button);
  }

  if (!present.length) {
    content.replaceChildren(h('div', { class: 'ndt-muted', text: 'ไฟล์นี้ไม่มีรายการ' }));
    return;
  }
  updateFooter();
  show(present.find(t => tabEntries(t.id).some(e => !e.disabled))?.id ?? present[0].id);

  applyButton.addEventListener('click', async () => {
    if (applyButton.classList.contains('disabled')) return;
    applyButton.classList.add('disabled');
    try {
      const result = await applyRows(rows, pkg, (label, done, total) => {
        progress.textContent = total ? `${label} (${done}/${total})` : label;
      });
      showResult(modal, manifest, result, rows);
    } catch (error) {
      console.error(`[${MODULE}]`, error);
      progress.className = 'ndt-error';
      progress.textContent = `ล้มเหลว: ${error?.message ?? error}`;
      applyButton.classList.remove('disabled');
    }
  });
}

export function showResult(modal, manifest, result, rows = []) {
  const failedKeys = new Set(result.failed.map(f => f.row.item.key));
  const done = rows.filter(r => r.selected && r.status !== 'same' && r.status !== 'unavailable' && !failedKeys.has(r.item.key));
  const perTab = TABS.map(t => [t.label, done.filter(r => r.category === t.id).length]).filter(([, n]) => n > 0);
  const failed = result.failed.length;
  const code = packCode(manifest.packId);

  const copyButton = h('div', { class: 'menu_button ndt-icon-btn', title: 'คัดลอกรหัส', text: 'คัดลอก' });
  copyButton.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(code);
      toastr.success('คัดลอกรหัสแล้ว');
    } catch {
      toastr.info(`รหัส: ${code}`);
    }
  });

  const body = [
    h('div', { class: `ndt-result-hero${failed ? ' ndt-partial' : ''}` },
      h('div', { class: 'ndt-result-icon', text: failed ? '!' : '✓' }),
      h('div', { class: 'ndt-result-title', text: failed ? 'นำเข้าเสร็จบางส่วน' : 'นำเข้าเสร็จแล้ว' }),
      h('div', { class: 'ndt-muted', text: `สำเร็จ ${result.ok} รายการ${failed ? ` · ล้มเหลว ${failed}` : ''}` })),
    perTab.length
      ? h('div', { class: 'ndt-chips' }, perTab.map(([label, n]) => h('span', { class: 'ndt-chip', text: `${label} ${n}` })))
      : null,
    h('div', { class: 'ndt-card' },
      h('div', { class: 'ndt-card-label', text: 'รหัสยืนยัน' }),
      h('div', { class: 'ndt-code-row' }, h('div', { class: 'ndt-code-big', text: code }), copyButton),
      h('div', { class: 'ndt-muted', text: 'กดยืนยัน (หรือพิมพ์รหัสนี้) ที่เครื่องต้นทาง เพื่อให้ครั้งหน้าส่งเฉพาะที่เปลี่ยน' })),
  ];
  if (failed) {
    body.push(h('div', { class: 'ndt-card ndt-card-error' },
      h('div', { class: 'ndt-card-label', text: `ล้มเหลว ${failed} รายการ` }),
      ...result.failed.slice(0, 30).map(f => h('div', { class: 'ndt-error', text: `${f.row.item.name} — ${f.error}` }))));
  }

  const reloadNote = result.needsReload
    ? h('div', { class: 'ndt-muted ndt-foot-info', text: result.settingsWritten ? 'เขียนการตั้งค่าแล้ว กำลังรีโหลดหน้าใน 4 วินาที…' : 'รีโหลดหน้าเพื่อให้เห็นตัวละคร/ธีมที่เพิ่งนำเข้า' })
    : h('div', { class: 'ndt-muted ndt-foot-info', text: 'ไม่ต้องรีโหลด' });
  const actions = h('div', { class: 'ndt-foot-actions' },
    h('div', { class: 'menu_button', text: 'ปิด', onclick: modal.close }),
    result.needsReload ? h('div', { class: 'menu_button menu_button_icon ndt-primary', onclick: () => location.reload() },
      h('i', { class: 'fa-solid fa-rotate' }), h('span', { text: 'รีโหลดตอนนี้' })) : null);

  modal.tabs.replaceChildren();
  modal.footer.replaceChildren(h('div', { class: 'ndt-foot-text' }, reloadNote), actions);
  modal.body.replaceChildren(h('div', { class: 'ndt-result' }, ...body));
  if (result.settingsWritten && !failed) setTimeout(() => location.reload(), 4000);
}
