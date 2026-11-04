import { h } from './dom.js';
import { MODULE, timestampLabel } from './util.js';
import { getState } from './state.js';
import { getProvider, listProviders } from './cloud/providers.js';
import { applyDeletions, runSync } from './sync.js';
import { createPicker } from './picker.js';
import { openModal } from './modal.js';

const TYPE_LABEL = {
  character: 'ตัวละคร', chat: 'แชท', group: 'กลุ่ม', groupchat: 'แชทกลุ่ม', world: 'World Info',
  preset: 'Preset', quickreply: 'Quick Replies', background: 'พื้นหลัง', avatar: 'รูป Persona',
};

function currentProvider() {
  // A saved id can outlive its provider (removed, or never registered on this device): fall back, never crash the panel.
  return getProvider(getState().cloud.providerId) ?? getProvider('dropbox');
}

/** The "cloud sync" block of the settings panel. */
export function buildSyncSection() {
  const cloud = getState().cloud;

  const status = h('div', { class: 'ndt-muted' });
  const connectButton = h('div', { class: 'menu_button menu_button_icon' });
  const syncButton = h('div', { class: 'menu_button menu_button_icon ndt-primary ndt-bigsync' },
    h('i', { class: 'fa-solid fa-arrows-rotate' }), h('span', { text: 'ซิงค์เดี๋ยวนี้' }));
  const last = h('div', { class: 'ndt-muted' });

  const select = h('select', { class: 'text_pole' }, listProviders().map(p => h('option', { value: p.id, text: p.name })));
  select.value = currentProvider().id;
  select.addEventListener('change', () => {
    cloud.providerId = select.value;
    render();
  });

  function render() {
    const p = currentProvider();
    const connected = p.isConnected();
    connectButton.replaceChildren(
      h('i', { class: `fa-solid ${connected ? 'fa-link-slash' : 'fa-link'}` }),
      h('span', { text: connected ? 'ยกเลิกเชื่อมต่อ' : `เชื่อมต่อ ${p.name}` }));
    syncButton.classList.toggle('disabled', !connected);
    status.textContent = !p.configured()
      ? `${p.name} ยังไม่พร้อมใช้ (ยังไม่ได้ตั้ง app key)`
      : connected ? `เชื่อมต่อ ${p.name} แล้ว (เครื่องนี้)` : `ล็อกอิน ${p.name} ครั้งเดียวบนเครื่องนี้ แล้วกดซิงค์ได้เลย`;
    const excluded = getState().excluded.length;
    if (excluded) status.textContent += ` · ไม่ซิงค์ ${excluded} รายการที่ยกเว้นไว้`;
    const l = cloud.last;
    last.textContent = l
      ? `ซิงค์ล่าสุด ${timestampLabel(l.at)} · ส่งขึ้น ${l.pushed} · ดึงลง ${l.pulled}${l.copies ? ` · ชนกัน ${l.copies}` : ''}${l.failed ? ` · ล้มเหลว ${l.failed}` : ''}`
      : 'ยังไม่เคยซิงค์';
  }

  /* Fallback for browsers that cut the link to the login window: the callback page shows a code to paste here. */
  const manualBox = h('div', { class: 'ndt-pending', style: 'display:none' });
  function askForCode() {
    return new Promise((resolve, reject) => {
      const input = h('input', { class: 'text_pole', type: 'text', placeholder: 'รหัสจาก Dropbox' });
      const close = () => { manualBox.style.display = 'none'; manualBox.replaceChildren(); };
      const ok = h('div', { class: 'menu_button menu_button_icon' }, h('i', { class: 'fa-solid fa-check' }), h('span', { text: 'ยืนยัน' }));
      const cancel = h('div', { class: 'menu_button menu_button_icon' }, h('i', { class: 'fa-solid fa-xmark' }), h('span', { text: 'ยกเลิก' }));
      ok.addEventListener('click', () => { if (input.value.trim()) { close(); resolve(input.value); } });
      cancel.addEventListener('click', () => { close(); reject(new Error('ยกเลิกการเชื่อมต่อ')); });
      manualBox.replaceChildren(
        h('div', { class: 'ndt-muted', text: 'ล็อกอินที่หน้าต่าง Dropbox เสร็จแล้ว ถ้าหน้านั้นไม่ปิดเอง ให้คัดลอกรหัสที่แสดง แล้ววางที่นี่' }),
        h('div', { class: 'ndt-row' }, input, ok, cancel));
      manualBox.style.display = '';
    });
  }

  connectButton.addEventListener('click', async () => {
    const p = currentProvider();
    try {
      if (p.isConnected()) p.disconnect();
      else await p.connect({ manualCode: askForCode });
    } catch (error) {
      console.error(`[${MODULE}]`, error);
      toastr.error(String(error?.message ?? error), 'เชื่อมต่อไม่สำเร็จ');
    }
    render();
  });
  syncButton.addEventListener('click', () => {
    if (!syncButton.classList.contains('disabled')) openSyncWindow(render);
  });

  render();
  return h('div', { class: 'ndt-cloud' },
    h('h4', { text: 'ซิงค์ผ่านคลาวด์ของคุณ' }),
    h('div', { class: 'ndt-muted', text: 'ใช้พื้นที่คลาวด์ของคุณเอง ไม่ผ่านเซิร์ฟเวอร์ของใคร เล่นตัวเดียวกันได้ทุกเครื่องที่ล็อกอินบัญชีเดียวกัน' }),
    select, status,
    h('div', { class: 'ndt-row' }, connectButton),
    manualBox,
    syncButton, last);
}

/** Runs a sync inside a window and shows what happened. */
export async function openSyncWindow(onDone = () => {}) {
  const provider = currentProvider();
  const modal = openModal({ title: `ซิงค์ · ${provider.name}`, onClose: onDone });
  const progress = h('div', { class: 'ndt-muted ndt-loading', text: 'กำลังเริ่ม…' });
  modal.body.append(progress);

  let summary;
  try {
    summary = await runSync({
      provider,
      progress: (label, done, total) => { progress.textContent = total ? `${label} ${done}/${total}` : label; },
    });
  } catch (error) {
    console.error(`[${MODULE}]`, error);
    modal.body.replaceChildren(
      h('div', { class: 'ndt-result-hero ndt-partial' },
        h('div', { class: 'ndt-result-icon', text: '!' }),
        h('div', { class: 'ndt-result-title', text: 'ซิงค์ไม่สำเร็จ' }),
        h('div', { class: 'ndt-error', text: String(error?.message ?? error) }),
        h('div', { class: 'ndt-muted', text: 'ไม่มีอะไรถูกทับ ลองกดซิงค์ใหม่ได้' })));
    return;
  }
  renderSummary(modal, provider, summary);
}

function renderSummary(modal, provider, summary) {
  const failed = summary.failed.length;
  const parts = [
    ['ส่งขึ้น', summary.pushed.length], ['ดึงลง', summary.pulled.length],
    ['ชนกัน (เก็บทั้งสอง)', summary.copies.length], ['ข้ามเอง', summary.unresolved.length],
  ].filter(([, n]) => n > 0);

  const body = [
    h('div', { class: `ndt-result-hero${failed ? ' ndt-partial' : ''}` },
      h('div', { class: 'ndt-result-icon', text: failed ? '!' : '✓' }),
      h('div', { class: 'ndt-result-title', text: failed ? 'ซิงค์เสร็จบางส่วน' : 'ซิงค์เสร็จแล้ว' }),
      h('div', { class: 'ndt-muted', text: parts.length ? '' : `ทุกอย่างตรงกันแล้ว (${summary.same} รายการ)` })),
    parts.length ? h('div', { class: 'ndt-chips' }, parts.map(([label, n]) => h('span', { class: 'ndt-chip', text: `${label} ${n}` }))) : null,
  ];

  const section = (title, items, cls = '') => (!items.length ? null : h('div', { class: `ndt-card ndt-card-left ${cls}` },
    h('div', { class: 'ndt-card-label', text: title }),
    ...items.slice(0, 40).map(i => h('div', { class: 'ndt-line', text: `${TYPE_LABEL[i.type] ?? i.type ?? ''} ${i.name}${i.error ? ` — ${i.error}` : ''}`.trim() })),
    items.length > 40 ? h('div', { class: 'ndt-muted', text: `…และอีก ${items.length - 40}` }) : null));

  body.push(
    section('ชนกัน: เก็บทั้งสองไว้ (ของอีกเครื่องมีชื่อ "(จาก …)")', summary.copies),
    section('ชนกันแต่ผมแก้เองไม่ได้: ยังไม่ได้แตะ', summary.unresolved),
    section('ล้มเหลว', summary.failed, 'ndt-card-error'));

  // Deletions are never automatic: the user decides.
  const toHere = new Map();
  const fromHere = new Map();
  const askBlocks = [];
  const askList = (title, hint, items, chosen) => {
    if (!items.length) return;
    const entries = items.map(i => ({ key: i.key, name: i.name, kind: TYPE_LABEL[i.type] ?? i.type }));
    const selection = {
      isSelected: key => chosen.has(key),
      set: (keys, on) => keys.forEach(k => (on ? chosen.set(k, items.find(i => i.key === k)) : chosen.delete(k))),
    };
    askBlocks.push(h('div', { class: 'ndt-card ndt-card-left' },
      h('div', { class: 'ndt-card-label', text: title }),
      h('div', { class: 'ndt-muted', text: hint }),
      createPicker({ entries, selection, prefs: { pageSize: 25 }, onChange: updateConfirm })));
  };
  askList(`ถูกลบที่อีกเครื่อง ${summary.askDeleteLocal.length} รายการ`, 'ติ๊กอันที่อยากลบที่เครื่องนี้ด้วย (ไม่ติ๊ก = เก็บไว้)', summary.askDeleteLocal, toHere);
  askList(`ถูกลบที่เครื่องนี้ ${summary.askDeleteRemote.length} รายการ`, 'ติ๊กอันที่อยากลบบนคลาวด์ด้วย (ไม่ติ๊ก = เก็บไว้บนคลาวด์ และจะถามอีกครั้งหน้า)', summary.askDeleteRemote, fromHere);

  const confirmButton = h('div', { class: 'menu_button menu_button_icon disabled' },
    h('i', { class: 'fa-solid fa-trash' }), h('span', { text: 'ยืนยันการลบที่ติ๊ก' }));
  function updateConfirm() {
    confirmButton.classList.toggle('disabled', toHere.size + fromHere.size === 0);
  }
  confirmButton.addEventListener('click', async () => {
    if (confirmButton.classList.contains('disabled')) return;
    confirmButton.classList.add('disabled');
    try {
      const { failed: bad } = await applyDeletions({ provider, fromHere: [...fromHere.values()], toHere: [...toHere.values()] });
      toastr[bad.length ? 'warning' : 'success'](bad.length ? `ลบไม่สำเร็จ ${bad.length} รายการ` : 'ลบเรียบร้อย');
      summary.reloadHint = true;
      for (const block of askBlocks) block.remove();
      confirmButton.remove();
    } catch (error) {
      toastr.error(String(error?.message ?? error), 'ลบไม่สำเร็จ');
      confirmButton.classList.remove('disabled');
    }
  });
  body.push(...askBlocks);

  modal.tabs.replaceChildren();
  modal.body.replaceChildren(h('div', { class: 'ndt-result ndt-result-wide' }, ...body));
  modal.footer.replaceChildren(
    h('div', { class: 'ndt-foot-text' }, h('div', {
      class: 'ndt-muted ndt-foot-info',
      text: summary.reloadHint ? 'รีโหลดหน้าเพื่อให้เห็นของที่ดึงมา (แชทที่เปิดอยู่จะได้เป็นเวอร์ชันล่าสุด)' : 'ไม่ต้องรีโหลด',
    })),
    h('div', { class: 'ndt-foot-actions' },
      askBlocks.length ? confirmButton : null,
      h('div', { class: 'menu_button', text: 'ปิด', onclick: modal.close }),
      summary.reloadHint ? h('div', { class: 'menu_button menu_button_icon ndt-primary', onclick: () => location.reload() },
        h('i', { class: 'fa-solid fa-rotate' }), h('span', { text: 'รีโหลดตอนนี้' })) : null));
}
