import { h } from './dom.js';
import { formatBytes } from './util.js';
import { STATUS_LABEL } from './scan.js';

const PAGE_SIZES = [25, 50, 100, 200];

const SORTS = [
  { id: 'name', label: 'ชื่อ' },
  { id: 'date', label: 'วันที่เพิ่ม' },
  { id: 'active', label: 'ใช้ล่าสุด' },
  { id: 'size', label: 'ขนาด' },
  { id: 'count', label: 'จำนวนข้อความ' },
];

const collator = new Intl.Collator(['th', 'en'], { numeric: true, sensitivity: 'base' });

/**
 * Searchable, sortable, paged list with checkboxes. Used by both the export and the import window.
 *
 * entry: { key, name, kind?, group?, groupName?, tags?, size?, count?, date?, active?,
 *          status?, note?, disabled?, row? }
 * selection: { isSelected(key), set(keys, selected) }
 * prefs: view state owned by the caller so it survives switching tabs.
 */
export function createPicker({ entries, grouped = false, selection, onChange = () => {}, prefs }) {
  prefs.query ??= '';
  prefs.sort ??= 'name';
  prefs.desc ??= false;
  prefs.tag ??= '';
  prefs.status ??= '';
  prefs.page ??= 1;

  const selectable = e => !e.disabled;
  const has = field => entries.some(e => e[field]);
  const sorts = SORTS.filter(s => s.id === 'name' || has(s.id));
  if (!sorts.some(s => s.id === prefs.sort)) prefs.sort = 'name';
  const tagNames = [...new Set(entries.flatMap(e => e.tags ?? []))].sort(collator.compare);
  const statuses = [...new Set(entries.map(e => e.status).filter(Boolean))];

  const searchInput = h('input', { class: 'text_pole ndt-search', type: 'search', placeholder: 'ค้นหาชื่อ…', value: prefs.query });
  const sortSelect = h('select', { class: 'text_pole' }, sorts.map(s => h('option', { value: s.id, text: s.label })));
  sortSelect.value = prefs.sort;
  const dirButton = h('div', { class: 'menu_button ndt-icon-btn', title: 'สลับน้อย→มาก / มาก→น้อย' });
  const tagSelect = h('select', { class: 'text_pole' },
    h('option', { value: '', text: 'ทุกแท็ก' }), tagNames.map(t => h('option', { value: t, text: t })));
  tagSelect.value = prefs.tag;
  const statusSelect = h('select', { class: 'text_pole' },
    h('option', { value: '', text: 'ทุกสถานะ' }),
    statuses.includes('same') || prefs.status === '!same' ? h('option', { value: '!same', text: 'ไม่รวมที่เหมือนกัน' }) : null,
    statuses.map(s => h('option', { value: s, text: STATUS_LABEL[s] ?? s })));
  statusSelect.value = prefs.status;
  const sizeSelect = h('select', { class: 'text_pole' }, PAGE_SIZES.map(n => h('option', { value: n, text: `${n} / หน้า` })));
  sizeSelect.value = String(prefs.pageSize);

  const info = h('div', { class: 'ndt-muted ndt-count' });
  const list = h('div', { class: 'ndt-list' });
  const pager = h('div', { class: 'ndt-pager' });
  const checks = []; // [{ box, keys }] kept so a click only updates checkboxes, not the whole list

  const selectAll = h('div', { class: 'menu_button', text: 'เลือกทั้งหมดที่กรอง' });
  const selectNone = h('div', { class: 'menu_button', text: 'ไม่เลือกที่กรอง' });

  const toolbar = h('div', { class: 'ndt-toolbar' },
    searchInput,
    h('div', { class: 'ndt-toolbar-row' }, sortSelect, dirButton, tagNames.length ? tagSelect : null, statuses.length ? statusSelect : null, sizeSelect),
    h('div', { class: 'ndt-toolbar-row' }, selectAll, selectNone));

  function filtered() {
    const q = prefs.query.trim().toLowerCase();
    return entries.filter((e) => {
      if (q && !`${e.name} ${e.groupName ?? ''}`.toLowerCase().includes(q)) return false;
      if (prefs.tag && !(e.tags ?? []).includes(prefs.tag)) return false;
      if (prefs.status === '!same') return e.status !== 'same';
      if (prefs.status && e.status !== prefs.status) return false;
      return true;
    });
  }

  const sortValue = (e, field) => (field === 'name' ? e.name : e[field] ?? 0);

  function compare(field, a, b) {
    const av = sortValue(a, field);
    const bv = sortValue(b, field);
    const r = field === 'name' ? collator.compare(av, bv) : av - bv;
    return prefs.desc ? -r : r;
  }

  /** Units shown on a page: single entries, or whole groups (one character with all its chats). */
  function units(items) {
    if (!grouped) {
      return [...items].sort((a, b) => compare(prefs.sort, a, b)).map(e => ({ entries: [e] }));
    }
    const map = new Map();
    for (const e of items) {
      const id = e.group ?? e.key;
      if (!map.has(id)) map.set(id, { id, name: e.groupName ?? e.name, entries: [] });
      map.get(id).entries.push(e);
    }
    const out = [...map.values()];
    const agg = (u) => {
      if (prefs.sort === 'name') return u.name;
      const values = u.entries.map(e => e[prefs.sort] ?? 0);
      return ['size', 'count'].includes(prefs.sort) ? values.reduce((s, v) => s + v, 0) : Math.max(...values);
    };
    out.sort((a, b) => {
      const r = prefs.sort === 'name' ? collator.compare(agg(a), agg(b)) : agg(a) - agg(b);
      return prefs.desc ? -r : r;
    });
    for (const u of out) u.entries.sort((a, b) => compare(prefs.sort === 'name' ? 'name' : prefs.sort, a, b));
    return out;
  }

  function rowFor(e) {
    const box = h('input', { type: 'checkbox', disabled: !selectable(e) });
    box.checked = selectable(e) && selection.isSelected(e.key);
    box.addEventListener('change', () => {
      selection.set([e.key], box.checked);
      syncChecks();
      onChange();
    });
    checks.push({ box, keys: [e.key], entries: [e] });

    const picker = e.row && e.status === 'conflict' && e.row.canCopy
      ? h('select', { class: 'text_pole ndt-action', onchange: (ev) => { e.row.action = ev.target.value; } },
        h('option', { value: 'copy', text: 'เก็บทั้งสอง', selected: e.row.action === 'copy' }),
        h('option', { value: 'import', text: 'ทับของเครื่องนี้', selected: e.row.action === 'import' }))
      : null;
    const meta = [
      e.size ? `${e.sizeLabel ? `${e.sizeLabel} ` : ''}${formatBytes(e.size)}` : '',
      e.count ? `${e.count} ข้อความ` : '',
    ].filter(Boolean).join(' · ');

    return h('label', { class: `ndt-item${e.status ? ` ndt-${e.status}` : ''}` },
      box,
      h('span', { class: 'ndt-name', text: e.name }),
      e.status ? h('span', { class: 'ndt-badge', text: STATUS_LABEL[e.status] ?? e.status }) : null,
      !grouped && e.kind && e.kind !== 'ตัวละคร' ? h('span', { class: 'ndt-kind', text: e.kind }) : null,
      ...(e.tags ?? []).slice(0, 3).map(t => h('span', { class: 'ndt-tag', text: t })),
      meta ? h('span', { class: 'ndt-note', text: meta }) : null,
      e.note ? h('span', { class: 'ndt-note', text: e.note }) : null,
      picker);
  }

  function groupFor(unit) {
    const keys = unit.entries.filter(selectable).map(e => e.key);
    const box = h('input', { type: 'checkbox', disabled: !keys.length });
    box.addEventListener('change', () => {
      selection.set(keys, box.checked);
      syncChecks();
      onChange();
    });
    checks.push({ box, keys, entries: unit.entries.filter(selectable), group: true });
    const totalSize = unit.entries.reduce((s, e) => s + (e.size ?? 0), 0);
    const tags = unit.entries[0].tags ?? [];
    const head = h('summary', { class: 'ndt-group-head' },
      box,
      h('span', { class: 'ndt-name', text: unit.name }),
      h('span', { class: 'ndt-note', text: `${unit.entries.length} ไฟล์${totalSize ? ` · ${formatBytes(totalSize)}` : ''}` }),
      ...tags.slice(0, 2).map(t => h('span', { class: 'ndt-tag', text: t })));
    // Keep the checkbox from toggling the <details> when clicked.
    box.addEventListener('click', ev => ev.stopPropagation());
    return h('details', { class: 'ndt-group' }, head, ...unit.entries.map(rowFor));
  }

  function syncChecks() {
    for (const c of checks) {
      const on = c.keys.filter(k => selection.isSelected(k)).length;
      c.box.checked = c.keys.length > 0 && on === c.keys.length;
      c.box.indeterminate = on > 0 && on < c.keys.length;
    }
  }

  function render() {
    const items = filtered();
    const all = units(items);
    const pages = Math.max(1, Math.ceil(all.length / prefs.pageSize));
    prefs.page = Math.min(Math.max(1, prefs.page), pages);
    const slice = all.slice((prefs.page - 1) * prefs.pageSize, prefs.page * prefs.pageSize);

    checks.length = 0;
    list.replaceChildren(...(slice.length
      ? slice.map(u => (grouped ? groupFor(u) : rowFor(u.entries[0])))
      : [h('div', { class: 'ndt-muted ndt-empty', text: entries.length ? 'ไม่พบรายการที่ตรงกับตัวกรอง' : 'ไม่มีรายการ' })]));
    syncChecks();

    const picked = items.filter(e => selectable(e) && selection.isSelected(e.key)).length;
    info.textContent = `แสดง ${items.length}/${entries.length} รายการ · ติ๊กไว้ ${picked} (ในผลกรอง)`;

    const go = (page) => () => { prefs.page = page; render(); list.scrollIntoView({ block: 'nearest' }); };
    const btn = (label, page, disabled) => h('div', { class: `menu_button ndt-icon-btn${disabled ? ' disabled' : ''}`, text: label, onclick: disabled ? null : go(page) });
    pager.replaceChildren(
      btn('«', 1, prefs.page === 1), btn('‹', prefs.page - 1, prefs.page === 1),
      h('span', { class: 'ndt-pageno', text: `${prefs.page}/${pages}` }),
      btn('›', prefs.page + 1, prefs.page === pages), btn('»', pages, prefs.page === pages));
    pager.style.display = pages > 1 ? '' : 'none';
    dirButton.textContent = prefs.desc ? '↓' : '↑';
  }

  searchInput.addEventListener('input', () => { prefs.query = searchInput.value; prefs.page = 1; render(); });
  sortSelect.addEventListener('change', () => { prefs.sort = sortSelect.value; prefs.page = 1; render(); });
  dirButton.addEventListener('click', () => { prefs.desc = !prefs.desc; render(); });
  tagSelect.addEventListener('change', () => { prefs.tag = tagSelect.value; prefs.page = 1; render(); });
  statusSelect.addEventListener('change', () => { prefs.status = statusSelect.value; prefs.page = 1; render(); });
  sizeSelect.addEventListener('change', () => { prefs.pageSize = Number(sizeSelect.value); prefs.page = 1; prefs.onPageSize?.(prefs.pageSize); render(); });
  selectAll.addEventListener('click', () => { selection.set(filtered().filter(selectable).map(e => e.key), true); syncChecks(); onChange(); });
  selectNone.addEventListener('click', () => { selection.set(filtered().filter(selectable).map(e => e.key), false); syncChecks(); onChange(); });

  const root = h('div', { class: 'ndt-picker' }, toolbar, info, list, pager);
  render();
  return root;
}
