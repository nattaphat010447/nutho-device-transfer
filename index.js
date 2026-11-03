import { MODULE, ctx, packCode, timestampLabel } from './lib/util.js';
import { getState, remember, saveState } from './lib/state.js';
import { h } from './lib/dom.js';
import { openExportWindow } from './lib/export-ui.js';
import { startImport } from './lib/import-ui.js';

/* The settings panel stays small: device name, the two entry buttons and the "other side received it" box.
   Everything you pick lives in the full-screen windows (lib/export-ui.js, lib/import-ui.js). */

function buildPanel() {
  const state = getState();

  const deviceInput = h('input', { class: 'text_pole', type: 'text', value: state.deviceName, maxlength: '40' });
  deviceInput.addEventListener('input', () => {
    state.deviceName = deviceInput.value.trim() || state.deviceName;
    saveState();
  });

  const pendingBox = h('div', { class: 'ndt-pending' });

  function renderPending() {
    pendingBox.replaceChildren();
    const pending = state.pending;
    if (!pending) return;
    const codeInput = h('input', {
      class: 'text_pole ndt-code', type: 'text', maxlength: '4', placeholder: 'รหัส 4 ตัว (ไม่บังคับ)',
    });
    const confirmButton = h('div', { class: 'menu_button menu_button_icon' },
      h('i', { class: 'fa-solid fa-check' }), h('span', { text: 'อีกเครื่องรับแล้ว' }));
    confirmButton.addEventListener('click', () => {
      const typed = codeInput.value.trim().toUpperCase();
      if (typed && typed !== pending.code) {
        toastr.error('รหัสไม่ตรงกับไฟล์ที่ Export ล่าสุด');
        return;
      }
      for (const [key, hash] of Object.entries(pending.hashes)) remember(state.synced, key, hash);
      // A package with a failed category must not move the "sent up to here" mark, or the
      // missing part would never be sent again.
      if (!pending.partial) state.lastConfirmedAt = pending.at;
      state.pending = null;
      saveState();
      renderPending();
      toastr.success(pending.partial
        ? 'บันทึกแล้ว แต่ไฟล์นี้ขาดบางหมวด ครั้งหน้าจะส่งส่วนที่ขาดซ้ำ'
        : 'บันทึกแล้ว ครั้งถัดไปจะส่งเฉพาะที่เปลี่ยนต่อจากนี้');
    });
    const discardButton = h('div', { class: 'menu_button menu_button_icon' },
      h('i', { class: 'fa-solid fa-xmark' }), h('span', { text: 'ยกเลิก' }));
    discardButton.addEventListener('click', () => {
      state.pending = null;
      saveState();
      renderPending();
    });
    pendingBox.append(
      h('div', { class: 'ndt-pending-title', text: `ไฟล์ล่าสุดที่ส่งออก: ${pending.filename}` }),
      h('div', { class: 'ndt-muted', text: `${pending.summary} · รหัสยืนยัน ${pending.code} (แสดงบนเครื่องปลายทางหลังนำเข้าเสร็จ)` }),
      h('div', { class: 'ndt-muted', text: 'ยังไม่ได้ยืนยัน: ถ้า Export อีกรอบ จะส่งช่วงเดิมซ้ำ ไม่มีข้อมูลหาย' }),
      pending.partial ? h('div', { class: 'ndt-warn', text: '⚠ ไฟล์นี้ขาดบางหมวด (เซิร์ฟเวอร์ตอบ error) ลอง Export ใหม่เพื่อให้ครบ' }) : null,
      h('div', { class: 'ndt-row' }, codeInput, confirmButton, discardButton),
    );
  }

  const exportButton = h('div', { class: 'menu_button menu_button_icon' },
    h('i', { class: 'fa-solid fa-file-export' }), h('span', { text: 'Export…' }));
  exportButton.addEventListener('click', () => {
    openExportWindow({
      onExported: (result) => {
        state.pending = {
          packId: result.manifest.packId,
          code: packCode(result.manifest.packId),
          at: result.manifest.createdAt,
          filename: result.filename,
          summary: result.summary,
          partial: result.failed.length > 0,
          hashes: Object.fromEntries(result.manifest.items.map(i => [i.key, i.hash])),
        };
        saveState();
        renderPending();
      },
    });
  });

  const fileInput = h('input', { type: 'file', class: 'displayNone', accept: '.nsync,.zip,application/zip,application/octet-stream' });
  fileInput.addEventListener('change', async () => {
    const file = fileInput.files?.[0];
    fileInput.value = '';
    if (file) await startImport(file);
  });
  const importButton = h('div', { class: 'menu_button menu_button_icon' },
    h('i', { class: 'fa-solid fa-file-import' }), h('span', { text: 'Import…' }));
  importButton.addEventListener('click', () => fileInput.click());

  const last = state.lastConfirmedAt
    ? `ยืนยันรับล่าสุด ${timestampLabel(state.lastConfirmedAt)}`
    : 'ยังไม่เคยยืนยันการรับ (Export ครั้งแรกจะส่งทั้งหมด)';

  const root = h('div', { class: 'ndt-root inline-drawer' },
    h('div', { class: 'inline-drawer-toggle inline-drawer-header' },
      h('b', { text: 'Nutho Device Transfer' }),
      h('div', { class: 'inline-drawer-icon fa-solid fa-circle-chevron-down down' })),
    h('div', { class: 'inline-drawer-content' },
      h('label', { class: 'ndt-field' }, h('span', { text: 'ชื่อเครื่องนี้' }), deviceInput),
      h('div', { class: 'ndt-muted', text: last }),
      h('div', { class: 'ndt-row' }, exportButton, importButton),
      fileInput,
      pendingBox,
      h('div', { class: 'ndt-muted', text: 'API key ไม่ถูกย้าย · ไฟล์ .nsync เป็น zip ธรรมดา ไม่เข้ารหัส' }),
    ));

  renderPending();
  return root;
}

jQuery(() => {
  const { eventSource, event_types } = ctx();
  const mount = () => {
    if (document.querySelector('.ndt-root')) return;
    document.querySelector('#extensions_settings2')?.append(buildPanel());
  };
  if (document.querySelector('#extensions_settings2')) mount();
  else eventSource.on(event_types.APP_READY, mount);
});
