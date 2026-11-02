import { MODULE, ctx, downloadBlob, formatBytes, timestampLabel } from './lib/util.js';
import { CATEGORIES, getState, remember, saveState } from './lib/state.js';
import { buildPackage } from './lib/export.js';
import { openPackage, scanPackage, STATUS_LABEL } from './lib/scan.js';
import { applyRows } from './lib/apply.js';

function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (v !== false && v != null) el.setAttribute(k, v === true ? '' : v);
  }
  for (const child of children.flat()) {
    if (child == null || child === false) continue;
    el.append(child);
  }
  return el;
}

const packCode = packId => String(packId).slice(0, 4).toUpperCase();

/* ------------------------------------------------------------------ settings panel */

function buildPanel() {
  const state = getState();

  const deviceInput = h('input', { class: 'text_pole', type: 'text', value: state.deviceName, maxlength: '40' });
  deviceInput.addEventListener('input', () => {
    state.deviceName = deviceInput.value.trim() || state.deviceName;
    saveState();
  });

  const catBoxes = Object.entries(CATEGORIES).map(([key, label]) => {
    const box = h('input', { type: 'checkbox' });
    box.checked = state.exportCats[key] !== false;
    box.addEventListener('change', () => {
      state.exportCats[key] = box.checked;
      saveState();
    });
    return h('label', { class: 'checkbox_label ndt-check' }, box, h('span', { text: label }));
  });

  const modeDelta = h('input', { type: 'radio', name: 'ndt_mode', value: 'delta' });
  const modeAll = h('input', { type: 'radio', name: 'ndt_mode', value: 'all' });
  (state.exportMode === 'all' ? modeAll : modeDelta).checked = true;
  for (const radio of [modeDelta, modeAll]) {
    radio.addEventListener('change', () => {
      state.exportMode = radio.value;
      saveState();
      renderInfo();
    });
  }

  const info = h('div', { class: 'ndt-info' });
  const progress = h('div', { class: 'ndt-progress' });
  const pendingBox = h('div', { class: 'ndt-pending' });
  const exportButton = h('div', { class: 'menu_button menu_button_icon' },
    h('i', { class: 'fa-solid fa-file-export' }), h('span', { text: 'Export เป็นไฟล์ .nsync' }));

  function renderInfo() {
    const since = state.exportMode === 'all' ? 0 : state.lastConfirmedAt;
    info.textContent = since
      ? `จะส่งเฉพาะที่เปลี่ยนหลัง ${timestampLabel(since)} (ครั้งล่าสุดที่ยืนยันว่าอีกเครื่องรับแล้ว)`
      : 'จะส่งทุกอย่างที่เลือก (ยังไม่เคยยืนยันการรับ หรือเลือกส่งทั้งหมด)';
  }

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
      state.lastConfirmedAt = pending.at;
      state.pending = null;
      saveState();
      renderPending();
      renderInfo();
      toastr.success('บันทึกแล้ว ครั้งถัดไปจะส่งเฉพาะที่เปลี่ยนต่อจากนี้');
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
      h('div', { class: 'ndt-row' }, codeInput, confirmButton, discardButton),
    );
  }

  exportButton.addEventListener('click', async () => {
    if (exportButton.classList.contains('disabled')) return;
    const cats = { ...state.exportCats };
    if (!Object.values(cats).some(Boolean)) {
      toastr.warning('เลือกอย่างน้อยหนึ่งหมวด');
      return;
    }
    exportButton.classList.add('disabled');
    try {
      const since = state.exportMode === 'all' ? 0 : state.lastConfirmedAt;
      const result = await buildPackage({
        since,
        cats,
        progress: (label, done, total) => {
          progress.textContent = total ? `${label} ${done}/${total}` : label;
        },
      });
      downloadBlob(result.blob, result.filename);
      state.pending = {
        packId: result.manifest.packId,
        code: packCode(result.manifest.packId),
        at: result.manifest.createdAt,
        filename: result.filename,
        summary: result.summary,
        hashes: Object.fromEntries(result.manifest.items.map(i => [i.key, i.hash])),
      };
      saveState();
      renderPending();
      progress.textContent = `เสร็จแล้ว: ${result.filename} (${result.summary})`;
      for (const warning of result.manifest.warnings.slice(0, 5)) toastr.warning(warning, '', { timeOut: 8000 });
    } catch (error) {
      console.error(`[${MODULE}]`, error);
      progress.textContent = '';
      toastr.error(String(error?.message ?? error), 'Export ไม่สำเร็จ');
    } finally {
      exportButton.classList.remove('disabled');
    }
  });

  const fileInput = h('input', { type: 'file', class: 'displayNone', accept: '.nsync,.zip,application/zip,application/octet-stream' });
  fileInput.addEventListener('change', async () => {
    const file = fileInput.files?.[0];
    fileInput.value = '';
    if (file) await startImport(file);
  });
  const importButton = h('div', { class: 'menu_button menu_button_icon' },
    h('i', { class: 'fa-solid fa-file-import' }), h('span', { text: 'Import จากไฟล์ .nsync' }));
  importButton.addEventListener('click', () => fileInput.click());

  const root = h('div', { class: 'ndt-root inline-drawer' },
    h('div', { class: 'inline-drawer-toggle inline-drawer-header' },
      h('b', { text: 'Nutho Device Transfer' }),
      h('div', { class: 'inline-drawer-icon fa-solid fa-circle-chevron-down down' })),
    h('div', { class: 'inline-drawer-content' },
      h('label', { class: 'ndt-field' }, h('span', { text: 'ชื่อเครื่องนี้' }), deviceInput),
      h('h4', { text: 'Export (เครื่องต้นทาง)' }),
      h('div', { class: 'ndt-cats' }, catBoxes),
      h('label', { class: 'checkbox_label ndt-check' }, modeDelta, h('span', { text: 'เฉพาะที่เปลี่ยนตั้งแต่ครั้งที่ยืนยันล่าสุด' })),
      h('label', { class: 'checkbox_label ndt-check' }, modeAll, h('span', { text: 'ส่งทั้งหมดใหม่' })),
      info,
      exportButton,
      progress,
      pendingBox,
      h('h4', { text: 'Import (เครื่องปลายทาง)' }),
      h('div', { class: 'ndt-muted', text: 'ระบบจะสแกนเทียบก่อน แล้วให้เลือกทีละรายการ ไม่ทับอะไรโดยไม่บอก API key ไม่ถูกย้าย' }),
      importButton,
      fileInput,
    ));

  renderInfo();
  renderPending();
  return root;
}

/* ------------------------------------------------------------------ import review */

async function startImport(file) {
  const { Popup, POPUP_TYPE } = ctx();
  const body = h('div', { class: 'ndt-review' }, h('div', { class: 'ndt-muted', text: 'กำลังอ่านไฟล์…' }));
  const popup = new Popup(body, POPUP_TYPE.TEXT, '', {
    wide: true, large: true, allowVerticalScrolling: true, okButton: 'ปิด', cancelButton: false,
  });
  popup.show();
  try {
    const pkg = await openPackage(file);
    const rows = await scanPackage(pkg, (label, done, total) => {
      body.replaceChildren(h('div', { class: 'ndt-muted', text: total ? `${label} ${done}/${total}` : label }));
    });
    renderReview(body, pkg, rows);
  } catch (error) {
    console.error(`[${MODULE}]`, error);
    body.replaceChildren(h('div', { class: 'ndt-error', text: `อ่านไฟล์ไม่สำเร็จ: ${error?.message ?? error}` }));
  }
}

function renderReview(body, pkg, rows) {
  const { manifest } = pkg;
  const counts = {};
  for (const row of rows) counts[row.status] = (counts[row.status] ?? 0) + 1;

  let showSame = false;
  const list = h('div', { class: 'ndt-list' });
  const applyButton = h('div', { class: 'menu_button menu_button_icon ndt-apply' },
    h('i', { class: 'fa-solid fa-download' }), h('span'));

  const updateApply = () => {
    const n = rows.filter(r => r.selected && r.status !== 'same' && r.status !== 'unavailable').length;
    applyButton.querySelector('span').textContent = `นำเข้าที่เลือก (${n})`;
    applyButton.classList.toggle('disabled', n === 0);
  };

  function renderList() {
    list.replaceChildren();
    for (const [catKey, catLabel] of Object.entries(CATEGORIES)) {
      const group = rows.filter(r => r.category === catKey && (showSame || r.status !== 'same'));
      if (!group.length) continue;
      const selectable = group.filter(r => r.status !== 'unavailable');
      const master = h('input', { type: 'checkbox' });
      master.checked = selectable.length > 0 && selectable.every(r => r.selected);
      const checkboxes = [];
      master.addEventListener('change', () => {
        for (const [i, row] of selectable.entries()) {
          row.selected = master.checked;
          checkboxes[i].checked = master.checked;
        }
        updateApply();
      });
      const details = h('details', { class: 'ndt-group', open: group.length <= 60 || null },
        h('summary', {}, master, h('span', { text: ` ${catLabel} · ${group.length}` })));
      for (const row of group) {
        const box = h('input', { type: 'checkbox', disabled: row.status === 'unavailable' });
        box.checked = row.selected;
        box.addEventListener('change', () => {
          row.selected = box.checked;
          master.checked = selectable.every(r => r.selected);
          updateApply();
        });
        if (row.status !== 'unavailable') checkboxes.push(box);
        const picker = row.status === 'conflict' && row.canCopy
          ? h('select', {
            class: 'text_pole ndt-action',
            onchange: (e) => { row.action = e.target.value; },
          },
          h('option', { value: 'copy', text: 'เก็บทั้งสอง', selected: row.action === 'copy' }),
          h('option', { value: 'import', text: 'ทับของเครื่องนี้', selected: row.action === 'import' }))
          : null;
        details.append(h('label', { class: `ndt-item ndt-${row.status}` },
          box,
          h('span', { class: 'ndt-name', text: row.item.name }),
          h('span', { class: 'ndt-badge', text: STATUS_LABEL[row.status] }),
          row.note ? h('span', { class: 'ndt-note', text: row.note }) : null,
          picker));
      }
      list.append(details);
    }
    if (!list.childElementCount) list.append(h('div', { class: 'ndt-muted', text: 'ไม่มีรายการที่ต้องนำเข้า' }));
    updateApply();
  }

  const sameToggle = h('input', { type: 'checkbox' });
  sameToggle.addEventListener('change', () => {
    showSame = sameToggle.checked;
    renderList();
  });

  const summary = Object.entries(counts).map(([s, n]) => `${STATUS_LABEL[s]} ${n}`).join(' · ');
  const header = h('div', { class: 'ndt-head' },
    h('div', { class: 'ndt-title', text: `จาก "${manifest.device?.name ?? '?'}" · ${timestampLabel(manifest.createdAt)}` }),
    h('div', { class: 'ndt-muted', text: `${manifest.full ? 'ส่งเต็ม' : `ส่งเฉพาะที่เปลี่ยนหลัง ${timestampLabel(manifest.since)}`} · ${rows.length} รายการ · ${summary}` }),
    ...manifest.warnings.slice(0, 6).map(w => h('div', { class: 'ndt-warn', text: `⚠ ${w}` })),
    h('label', { class: 'checkbox_label ndt-check' }, sameToggle, h('span', { text: 'แสดงรายการที่เหมือนกันแล้ว' })));

  applyButton.addEventListener('click', async () => {
    if (applyButton.classList.contains('disabled')) return;
    applyButton.classList.add('disabled');
    const status = h('div', { class: 'ndt-muted' });
    body.replaceChildren(header, status);
    try {
      const result = await applyRows(rows, pkg, (label, done, total) => {
        status.textContent = total ? `${label} (${done}/${total})` : label;
      });
      renderResult(body, manifest, result);
    } catch (error) {
      console.error(`[${MODULE}]`, error);
      status.className = 'ndt-error';
      status.textContent = `ล้มเหลว: ${error?.message ?? error}`;
    }
  });

  body.replaceChildren(header, list, h('div', { class: 'ndt-foot' }, applyButton));
  renderList();
}

function renderResult(body, manifest, result) {
  const out = [
    h('div', { class: 'ndt-title', text: `นำเข้าแล้ว ${result.ok} รายการ` }),
    h('div', { class: 'ndt-code-big', text: `รหัสยืนยัน: ${packCode(manifest.packId)}` }),
    h('div', { class: 'ndt-muted', text: 'พิมพ์รหัสนี้ (หรือกดยืนยันเฉยๆ) ที่เครื่องต้นทาง เพื่อให้ครั้งหน้าส่งเฉพาะที่เปลี่ยน' }),
  ];
  if (result.failed.length) {
    out.push(h('div', { class: 'ndt-error', text: `ล้มเหลว ${result.failed.length} รายการ:` }));
    for (const f of result.failed.slice(0, 30)) {
      out.push(h('div', { class: 'ndt-error', text: `${f.row.item.name} — ${f.error}` }));
    }
  }
  if (result.needsReload) {
    out.push(h('div', { class: 'ndt-muted', text: result.settingsWritten ? 'เขียนการตั้งค่าแล้ว กำลังรีโหลดหน้า…' : 'ต้องรีโหลดหน้าเพื่อให้เห็นตัวละคร/ธีมที่เพิ่งนำเข้า' }));
    out.push(h('div', { class: 'menu_button', onclick: () => location.reload(), text: 'รีโหลดตอนนี้' }));
    if (result.settingsWritten && !result.failed.length) setTimeout(() => location.reload(), 4000);
  }
  body.replaceChildren(...out);
}

/* ------------------------------------------------------------------ boot */

jQuery(() => {
  const { eventSource, event_types } = ctx();
  const mount = () => {
    if (document.querySelector('.ndt-root')) return;
    document.querySelector('#extensions_settings2')?.append(buildPanel());
  };
  if (document.querySelector('#extensions_settings2')) mount();
  else eventSource.on(event_types.APP_READY, mount);
});
