// Buttons on every page Visual Editor draws: icons only (a count where one helps), with the button's name shown on
// hover right away (and read out by screen readers). Rows of buttons never wrap: when there's no room they scroll
// sideways (the mouse wheel too), with no scrollbar showing.

import { el } from './dom';

/** Line icons on a 24×24 grid, drawn with the text colour. */
export const ICONS = {
  popOut: '<path d="M15 3h6v6M10 14L21 3M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>',
  back: '<path d="M4 14h6v6M3 21l7-7M14 4v6h6M21 3l-7 7"/>',
  choose: '<path d="M20 6L9 17l-5-5"/>',
  fitMap: '<path d="M8 3H5a2 2 0 0 0-2 2v3M21 8V5a2 2 0 0 0-2-2h-3M3 16v3a2 2 0 0 0 2 2h3M16 21h3a2 2 0 0 0 2-2v-3"/>',
  flow: '<rect x="3" y="3" width="6" height="6" rx="1"/><rect x="15" y="15" width="6" height="6" rx="1"/><path d="M9 6h4a2 2 0 0 1 2 2v7"/>',
  folders: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  proposed: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  changed: '<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="M14 6l4 4"/>',
  close: '<path d="M6 6l12 12M18 6L6 18"/>',
  code: '<path d="M8 8l-4 4 4 4M16 8l4 4-4 4M14 5l-4 14"/>',
  note: '<path d="M5 3h10l4 4v14H5z"/><path d="M9 12h6M9 16h6M15 3v4h4"/>',
  focus: '<circle cx="12" cy="12" r="7"/><circle cx="12" cy="12" r="2"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/>',
  onMap: '<path d="M12 21s-7-6.2-7-11a7 7 0 0 1 14 0c0 4.8-7 11-7 11z"/><circle cx="12" cy="10" r="2.5"/>',
  sendBack: '<path d="M9 14L4 9l5-5"/><path d="M4 9h10a6 6 0 0 1 6 6v4"/>',
  reject: '<circle cx="12" cy="12" r="9"/><path d="M9 9l6 6M15 9l-6 6"/>',
  undo: '<path d="M3 7v6h6"/><path d="M3 13a9 9 0 1 0 3-7.7L3 8"/>',
  example: '<path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z"/><path d="M19 16l.7 2 2 .7-2 .7-.7 2-.7-2-2-.7 2-.7z"/>',
  components: '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>',
  pages: '<path d="M6 3h8l4 4v14H6z"/><path d="M14 3v4h4"/>',
  api: '<circle cx="5" cy="12" r="2"/><path d="M7 12h12M15 8l4 4-4 4"/>',
  map: '<path d="M12 3l9 5-9 5-9-5z"/><path d="M3 13l9 5 9-5"/>',
  zoomIn: '<circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3M11 8v6M8 11h6"/>',
  zoomOut: '<circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3M8 11h6"/>',
  comesIn: '<path d="M3 12h11M10 8l4 4-4 4"/><path d="M15 4h4a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-4"/>',
  goesOut: '<path d="M10 12h11M17 8l4 4-4 4"/><path d="M9 4H5a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h4"/>',
  props: '<path d="M9 6h12M9 12h12M9 18h12"/><circle cx="4.5" cy="6" r="1"/><circle cx="4.5" cy="12" r="1"/><circle cx="4.5" cy="18" r="1"/>',
  sidePanel: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M15 4v16"/>',
  maximize: '<path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7"/>',
  restore: '<path d="M4 14h6v6M20 10h-6V4M14 10l7-7M3 21l7-7"/>',
} as const;

export type Icon = keyof typeof ICONS;

/** The icon for a map tab: known map kinds get their own; any other map gets a general one. */
export function mapIcon(id: string): Icon {
  if (/component/i.test(id)) return 'components';
  if (/page|route/i.test(id)) return 'pages';
  if (/api|call|endpoint/i.test(id)) return 'api';
  return 'map';
}

/** An icon-only button with a name (shown on hover, read out by screen readers), and a count when one helps. */
export function iconButton(icon: Icon, name: string, opts: { count?: string | number; cls?: string } = {}): HTMLButtonElement {
  const b = el('button', `icon${opts.cls ? ` ${opts.cls}` : ''}`);
  setIcon(b, icon, name, opts.count);
  return b;
}

/** Changes a button's icon, name and count. */
export function setIcon(b: HTMLElement, icon: Icon, name: string, count?: string | number) {
  b.innerHTML = `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[icon]}</svg>`;
  if (count !== undefined && count !== '') b.append(el('span', 'count', String(count)));
  b.setAttribute('aria-label', name);
  b.dataset.tip = name;
  b.removeAttribute('title');
}

/** A row of buttons that scrolls sideways when it doesn't fit (the mouse wheel too), never wrapping. */
export function tray<T extends HTMLElement>(row: T): T {
  row.classList.add('tray');
  row.addEventListener(
    'wheel',
    (e) => {
      if (row.scrollWidth <= row.clientWidth || Math.abs(e.deltaX) > Math.abs(e.deltaY)) return;
      row.scrollLeft += e.deltaY;
      e.preventDefault();
    },
    { passive: false },
  );
  return row;
}

let tip: HTMLElement | undefined;

/**
 * Names on hover, for every element with `data-tip` on the page: shown right away below it (above when there's no
 * room), kept on screen. (The browser's own tooltip is slow, and a scrolling row would cut a popup off.)
 */
export function installTips() {
  if (tip) return;
  tip = el('div', 've-tip');
  tip.hidden = true;
  document.body.append(tip);
  const hide = () => tip && (tip.hidden = true);
  document.addEventListener('mouseover', (e) => {
    const target = (e.target as Element | null)?.closest?.<HTMLElement>('[data-tip]');
    if (!target || !tip) return hide();
    tip.textContent = target.dataset.tip ?? '';
    tip.hidden = false;
    const r = target.getBoundingClientRect();
    const below = r.bottom + 6;
    const top = below + tip.offsetHeight > window.innerHeight - 4 ? r.top - tip.offsetHeight - 6 : below;
    tip.style.top = `${Math.max(4, top)}px`;
    tip.style.left = `${Math.max(4, Math.min(window.innerWidth - tip.offsetWidth - 4, r.left + r.width / 2 - tip.offsetWidth / 2))}px`;
  });
  document.addEventListener('mouseleave', hide);
  document.addEventListener('scroll', hide, true);
  document.addEventListener('pointerdown', hide);
}
