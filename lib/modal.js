import { h } from './dom.js';

/**
 * Full-screen window built on <dialog>. showModal() puts it in the browser's top layer, so it is
 * not affected by the transform ST puts on <html> (which breaks position: fixed on phones).
 */
export function openModal({ title, onClose }) {
  const closeButton = h('div', { class: 'menu_button ndt-icon-btn', title: 'ปิด', text: '✕' });
  const titleEl = h('div', { class: 'ndt-modal-title', text: title });
  const tabs = h('div', { class: 'ndt-tabs' });
  const body = h('div', { class: 'ndt-modal-body' });
  const footer = h('div', { class: 'ndt-modal-foot' });
  const dialog = h('dialog', { class: 'ndt-modal' },
    h('div', { class: 'ndt-modal-head' }, titleEl, closeButton),
    tabs, body, footer);

  const close = () => {
    if (dialog.open) dialog.close();
  };
  closeButton.addEventListener('click', close);
  dialog.addEventListener('close', () => {
    dialog.remove();
    onClose?.();
  });
  // Clicking the dimmed area around the window closes it too.
  dialog.addEventListener('mousedown', (e) => {
    if (e.target === dialog) close();
  });

  document.body.append(dialog);
  dialog.showModal();
  return { dialog, titleEl, tabs, body, footer, close };
}
