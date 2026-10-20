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
  preview: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
  goBack: '<path d="M15 6l-6 6 6 6"/>',
  goForward: '<path d="M9 6l6 6-6 6"/>',
  reload: '<path d="M21 12a9 9 0 1 1-2.6-6.4L21 8"/><path d="M21 3v5h-5"/>',
  fill: '<path d="M3 9V5a2 2 0 0 1 2-2h4M15 3h4a2 2 0 0 1 2 2v4M21 15v4a2 2 0 0 1-2 2h-4M9 21H5a2 2 0 0 1-2-2v-4"/><path d="M8 12h8M12 8v8"/>',
  phone: '<rect x="7" y="2" width="10" height="20" rx="2"/><path d="M11 18h2"/>',
  tablet: '<rect x="4" y="2" width="16" height="20" rx="2"/><path d="M11 18h2"/>',
  laptop: '<rect x="4" y="4" width="16" height="11" rx="1.5"/><path d="M2 19h20"/>',
  desktop: '<rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/>',
  rotate: '<path d="M4 12a8 8 0 0 1 13.7-5.7L20 8.5"/><path d="M20 4v4.5h-4.5"/><path d="M20 12a8 8 0 0 1-13.7 5.7L4 15.5"/><path d="M4 20v-4.5h4.5"/>',
  console: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7 9l3 3-3 3M12 15h5"/>',
  clear: '<circle cx="12" cy="12" r="9"/><path d="M5.6 5.6l12.8 12.8"/>',
  levelError: '<circle cx="12" cy="12" r="9"/><path d="M12 7v6M12 16.5v.5"/>',
  levelWarn: '<path d="M12 3l10 18H2z"/><path d="M12 10v5M12 18v.5"/>',
  levelInfo: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7.5V8"/>',
  levelLog: '<path d="M5 7h14M5 12h14M5 17h9"/>',
  levelDebug: '<rect x="8" y="6" width="8" height="12" rx="4"/><path d="M12 6V3M5 9l3 1M19 9l-3 1M4 14h4M16 14h4M5 19l3-2M19 19l-3-2"/>',
  pick: '<path d="M4 4l7 17 2.5-7.5L21 11z"/><path d="M14 14l6 6"/>',
  css: '<path d="M8 4c-2 0-3 1-3 3v2c0 1.5-1 2.5-2 3 1 .5 2 1.5 2 3v2c0 2 1 3 3 3M16 4c2 0 3 1 3 3v2c0 1.5 1 2.5 2 3-1 .5-2 1.5-2 3v2c0 2-1 3-3 3"/>',
  fake: '<path d="M4 7c0-1.7 1.3-3 3-3h10c1.7 0 3 1.3 3 3v3c0 5-3.6 9-8 10-4.4-1-8-5-8-10z"/><path d="M8.5 10.5h2M13.5 10.5h2M9 15c1.7 1.3 4.3 1.3 6 0"/>',
  contract: '<path d="M6 3h9l4 4v14H6z"/><path d="M15 3v4h4M9 12h7M9 16h4"/><path d="M14 17.5l1.5 1.5 3-3"/>',
  key: '<circle cx="8" cy="15" r="4"/><path d="M11 12l9-9M17 6l3 3M14.5 8.5l2 2"/>',
  trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>',
  add: '<path d="M12 5v14M5 12h14"/>',
  panels: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9h18M8 9v11"/>',
  dockLeft: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 4h6v16H3"/>',
  dockRight: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M15 4h6v16h-6"/>',
  dockBottom: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 14h18v6H3"/>',
  float: '<rect x="3" y="4" width="18" height="16" rx="2"/><rect x="11" y="8" width="7" height="9" rx="1"/>',
  hide: '<path d="M3 3l18 18M10.6 5.1A10 10 0 0 1 12 5c6.5 0 10 7 10 7a17 17 0 0 1-3.2 4.2M6.6 6.6A17 17 0 0 0 2 12s3.5 7 10 7a10 10 0 0 0 5.4-1.6"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/>',
  maximize: '<path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7"/>',
  restore: '<path d="M4 14h6v6M20 10h-6V4M14 10l7-7M3 21l7-7"/>',
} as const;

export type Icon = keyof typeof ICONS;

/** Icons plugins bring (their Preview panels' tabs), by name. */
const pluginIcons = new Map<string, string>();

/** Adds a plugin's icon (SVG drawing for a 24×24 box, in lines): only shapes and lines are kept, never scripts. */
export function addIcon(name: string, svg: string) {
  pluginIcons.set(name, svg.replace(/<\/?(script|foreignObject|iframe|image|use|a)\b[^>]*>/gi, '').replace(/\son\w+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '').replace(/(href|src)\s*=/gi, 'data-x='));
}

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
  b.innerHTML = `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[icon] ?? pluginIcons.get(icon) ?? ''}</svg>`;
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
