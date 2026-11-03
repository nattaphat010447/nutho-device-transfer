import { h } from './dom.js';
import { downloadBlob, packCode, timestampLabel } from './util.js';
import { CATEGORIES, getState, isExcluded, saveState, setExcluded } from './state.js';
import { TABS, createCatalog } from './catalog.js';
import { buildPackage } from './export.js';
import { createPicker } from './picker.js';
import { openModal } from './modal.js';

const selection = {
  isSelected: key => !isExcluded(key),
  set: (keys, selected) => setExcluded(keys, !selected),
};

/** The export window: pick what goes into the .nsync file, item by item. */
export function openExportWindow({ onExported }) {
  const state = getState();
  const catalog = createCatalog();
  const modal = openModal({ title: 'Export' });
  const prefs = Object.fromEntries(TABS.map(t => [t.id, {
    pageSize: state.pageSize,
    onPageSize: (n) => { state.pageSize = n; saveState(); },
  }]));
  const entriesByTab = {};
  const tabButtons = {};
  let active = TABS[0].id;
  let busy = false;

  /* ---- top: mode ---- */
  const modeDelta = h('input', { type: 'radio', name: 'ndt_mode', value: 'delta' });
  const modeAll = h('input', { type: 'radio', name: 'ndt_mode', value: 'all' });
  (state.exportMode === 'all' ? modeAll : modeDelta).checked = true;
  const modeInfo = h('div', { class: 'ndt-muted' });
  const renderMode = () => {
    modeInfo.textContent = state.exportMode === 'all' || !state.lastConfirmedAt
      ? 'ส่งทุกอย่างที่ติ๊กไว้'
      : `ส่งเฉพาะที่เปลี่ยนหลัง ${timestampLabel(state.lastConfirmedAt)} (ครั้งที่ยืนยันว่าอีกเครื่องรับแล้ว)`;
  };
  for (const radio of [modeDelta, modeAll]) {
    radio.addEventListener('change', () => {
      state.exportMode = radio.value;
      saveState();
      renderMode();
    });
  }
  renderMode();
  const modeBar = h('div', { class: 'ndt-modebar' },
    h('label', { class: 'checkbox_label ndt-check' }, modeDelta, h('span', { text: 'เฉพาะที่เปลี่ยนจากครั้งก่อน' })),
    h('label', { class: 'checkbox_label ndt-check' }, modeAll, h('span', { text: 'ส่งทั้งหมดใหม่' })),
    modeInfo);

  /* ---- footer ---- */
  const summary = h('div', { class: 'ndt-muted ndt-foot-info' });
  const progress = h('div', { class: 'ndt-progress' });
  const exportButton = h('div', { class: 'menu_button menu_button_icon ndt-primary' },
    h('i', { class: 'fa-solid fa-file-export' }), h('span', { text: 'Export' }));
  modal.footer.append(h('div', { class: 'ndt-foot-text' }, summary, progress), exportButton);

  function updateFooter() {
    const off = Object.values(state.exportCats).filter(v => v === false).length;
    summary.textContent = `ยกเว้นไว้ ${state.excluded.length} รายการ${off ? ` · ปิดทั้งหมวด ${off}` : ''} · แท็บที่ยังไม่เปิดจะส่งทุกอย่างที่ไม่ได้ยกเว้น`;
    for (const tab of TABS) {
      const entries = entriesByTab[tab.id];
      const label = tabButtons[tab.id];
      const on = state.exportCats[tab.id] !== false;
      label.classList.toggle('ndt-off', !on);
      label.querySelector('.ndt-tab-count').textContent = entries
        ? `${entries.filter(e => !isExcluded(e.key)).length}/${entries.length}`
        : '';
    }
  }

  /* ---- tabs ---- */
  const content = h('div', { class: 'ndt-tab-content' });
  modal.body.append(modeBar, content);

  for (const tab of TABS) {
    const button = h('div', { class: 'ndt-tab', onclick: () => show(tab.id) },
      h('span', { text: tab.label }), h('span', { class: 'ndt-tab-count' }));
    tabButtons[tab.id] = button;
    modal.tabs.append(button);
  }

  async function show(tabId) {
    active = tabId;
    for (const [id, b] of Object.entries(tabButtons)) b.classList.toggle('ndt-active', id === tabId);
    const token = {};
    show.token = token;

    const catSwitch = h('input', { type: 'checkbox' });
    catSwitch.checked = state.exportCats[tabId] !== false;
    catSwitch.addEventListener('change', () => {
      state.exportCats[tabId] = catSwitch.checked;
      saveState();
      content.classList.toggle('ndt-dim', !catSwitch.checked);
      updateFooter();
    });
    const head = h('label', { class: 'checkbox_label ndt-check ndt-catswitch' },
      catSwitch, h('span', { text: `ส่งหมวด "${CATEGORIES[tabId]}"` }));
    content.classList.toggle('ndt-dim', !catSwitch.checked);

    const status = h('div', { class: 'ndt-muted ndt-loading', text: 'กำลังโหลดรายการ…' });
    content.replaceChildren(head, status);
    try {
      const entries = await catalog.load(tabId, (done, total) => {
        if (show.token === token) status.textContent = `กำลังโหลดรายการ ${done}/${total}…`;
      });
      entriesByTab[tabId] = entries;
      updateFooter();
      if (show.token !== token) return;
      const tab = TABS.find(t => t.id === tabId);
      content.replaceChildren(head, createPicker({
        entries, grouped: tab.grouped, selection, prefs: prefs[tabId], onChange: updateFooter,
      }));
    } catch (error) {
      if (show.token !== token) return;
      status.className = 'ndt-error';
      status.textContent = `โหลดรายการไม่สำเร็จ: ${error?.message ?? error}`;
      status.append(' ', h('span', { class: 'ndt-link', text: 'ลองใหม่', onclick: () => show(tabId) }));
    }
  }

  /* ---- export ---- */
  exportButton.addEventListener('click', async () => {
    if (busy) return;
    const cats = { ...state.exportCats };
    if (!Object.values(cats).some(Boolean)) {
      toastr.warning('เลือกอย่างน้อยหนึ่งหมวด');
      return;
    }
    busy = true;
    exportButton.classList.add('disabled');
    try {
      const since = state.exportMode === 'all' ? 0 : state.lastConfirmedAt;
      const result = await buildPackage({
        since,
        cats,
        include: key => !isExcluded(key),
        progress: (label, done, total) => {
          progress.textContent = total ? `${label} ${done}/${total}` : label;
        },
      });
      downloadBlob(result.blob, result.filename);
      progress.textContent = result.failed.length
        ? `เสร็จบางส่วน: ${result.filename} (${result.summary}) — ขาด ${result.failed.length} หมวด`
        : `เสร็จแล้ว: ${result.filename} (${result.summary})`;
      for (const warning of result.manifest.warnings.slice(0, 5)) toastr.warning(warning, '', { timeOut: 10000 });
      onExported(result);
    } catch (error) {
      console.error('[nutho-device-transfer]', error);
      progress.textContent = '';
      toastr.error(String(error?.message ?? error), 'Export ไม่สำเร็จ');
    } finally {
      busy = false;
      exportButton.classList.remove('disabled');
    }
  });

  updateFooter();
  show(active);
  return { ...modal, packCode };
}
