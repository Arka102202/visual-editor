// Preview's page for a component made previewable (docs/variants.md): served at the app's address, so the dev server
// gives it the project's own styles and code. It loads the app's global CSS (what its entry file imports), Visual
// Editor's helper and the component's chooser, and draws every variant in every mock state with fixed data. Calls
// to the network are blocked (and reported: a variant must be static); the dev server's live reload is kept, so a
// saved variant shows at once. Two ways: the Playground's board (every variant in every state), or, with ?variant=…&state=…
// in its address, Preview's one variant in one state, drawn like a page of the app; with ?compare=…,… Review's before
// and after (the variant in use, then the one proposed, in every state). It talks to the window around it with
// postMessage, source "ve-preview-page"; the Playground answers with source "ve-preview" (the tile chosen, Compare).

import { existsSync, readFileSync } from 'node:fs';
import { join, posix } from 'node:path';
import type { Item, ProjectInfo } from '@visual-editor/contract';
import { helperTemplate, helperVersion } from './helper';
import { HELPER_PATH } from './setup';

const HELPER = /(^|\/)visual-editor\.[cm]?[jt]sx?$/;

/** The project's providers for previews (src/visual-editor.providers.tsx: a router in memory, a theme…), if any. */
export function providersFile(project: ProjectInfo): string | undefined {
  return project.files.filter((f) => /(^|\/)visual-editor\.providers\.[cm]?[jt]sx?$/.test(f) && !f.includes('node_modules')).sort((a, b) => a.length - b.length)[0];
}

/** The project's helper file: in the extension's folder (.visual-editor/react/), or where version 1 put it (src/). */
export function helperFile(project: ProjectInfo): string | undefined {
  if (project.files.includes(HELPER_PATH) || (project.root && existsSync(join(project.root, HELPER_PATH)))) return HELPER_PATH;
  return project.files.filter((f) => HELPER.test(f) && !f.includes('node_modules')).sort((a, b) => a.length - b.length)[0];
}

/**
 * The app's global CSS: what its entry file (the module index.html loads) imports. Project files by their address
 * (/src/index.css); a package's CSS under /node_modules/ (as the dev server serves it).
 */
export function globalCss(project: ProjectInfo, read: (path: string) => string | undefined = (p) => (existsSync(join(project.root, p)) ? readFileSync(join(project.root, p), 'utf8') : undefined)): string[] {
  const html = read('index.html') ?? '';
  const src = /<script[^>]*type=["']module["'][^>]*src=["']([^"']+)["']/i.exec(html)?.[1] ?? /<script[^>]*src=["']([^"']+)["'][^>]*type=["']module["']/i.exec(html)?.[1];
  const entry = src ? src.replace(/^\//, '') : ['src/main.tsx', 'src/main.ts', 'src/main.jsx', 'src/index.tsx', 'src/index.jsx'].find((p) => read(p) !== undefined);
  const code = entry ? read(entry) : undefined;
  if (!entry || !code) return [];
  const out: string[] = [];
  for (const m of code.matchAll(/^\s*import\s+(?:[^'"]*from\s+)?['"]([^'"]+\.(?:css|scss|sass|less))['"]/gm)) {
    const spec = m[1];
    out.push(spec.startsWith('.') ? `/${posix.normalize(posix.join(posix.dirname(entry), spec))}` : spec.startsWith('/') ? spec : `/node_modules/${spec}`);
  }
  return out;
}

/** The component's fixed data (Name.mock.ts, next to its chooser), if it has one. */
export function mockFile(item: Item, project: ProjectInfo): string | undefined {
  if (!item.source) return undefined;
  const dir = posix.dirname(item.source.path);
  return project.files.find((f) => posix.dirname(f) === dir && /\.mock\.[cm]?[jt]sx?$/.test(f));
}

/** The page's HTML, or a page that says what's missing. */
export function previewPage(item: Item, project: ProjectInfo): string | undefined {
  if (!item.preview || !item.source) return undefined;
  const helper = helperFile(project);
  const css = globalCss(project);
  const columns = item.preview.variants.length;
  const mock = mockFile(item, project);
  const providers = providersFile(project);
  const config = {
    name: item.label,
    chooser: `/${item.source.path}`,
    helper: helper ? `/${helper}` : undefined,
    providers: providers ? `/${providers}` : undefined,
    mock: mock ? `/${mock}` : undefined,
    css,
    states: item.preview.states.length ? item.preview.states : ['default'],
    columns,
    variants: item.preview.variants.map((v) => v.id),
    // A page is seen at a screen's width; a component at its own size.
    page: item.kind === 'page',
    // Situations (Button: primary, danger…): the Playground groups its rows by them.
    situations: item.preview.situations,
    // The newest helper (an older one in the project is offered an update).
    latestHelper: helperVersion(helperTemplate() ?? ''),
  };
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Preview: ${escapeHtml(item.label)}</title>
<script>
// A variant must be static: calls to the network are blocked here, and Preview is told (the dev server's own are kept).
(() => {
  const tell = (m) => parent !== window && parent.postMessage({ source: 've-preview-page', ...m }, '*');
  const ours = (url) => { try { const u = new URL(url, location.href); return u.origin === location.origin && /^\\/(@vite|@react-refresh|__vite|node_modules\\/\\.vite|@id\\/__x00__)/.test(u.pathname); } catch { return false; } };
  const realFetch = window.fetch;
  window.fetch = (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (ours(url)) return realFetch(input, init);
    tell({ type: 'blocked', method: (init && init.method) || (input && input.method) || 'GET', url: String(url) });
    return Promise.reject(new TypeError('Preview is static: no network calls (Visual Editor blocked it)'));
  };
  const open = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url) { this.__veBlocked = !ours(url) && { method, url: String(url) }; return open.apply(this, arguments); };
  const send = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.send = function () {
    if (this.__veBlocked) { tell({ type: 'blocked', ...this.__veBlocked }); this.abort(); return; }
    return send.apply(this, arguments);
  };
  const RealSocket = window.WebSocket;
  window.WebSocket = function (url, protocols) {
    if (/vite-hmr|vite-ping/.test(String(protocols)) || new URL(url, location.href).host === location.host) return new RealSocket(url, protocols);
    tell({ type: 'blocked', method: 'SOCKET', url: String(url) });
    throw new Error('Preview is static: no sockets (Visual Editor blocked it)');
  };
  window.WebSocket.prototype = RealSocket.prototype;
  if (navigator.sendBeacon) navigator.sendBeacon = (url) => { tell({ type: 'blocked', method: 'BEACON', url: String(url) }); return false; };
  window.addEventListener('error', (e) => tell({ type: 'error', text: String(e.message || e.error) }));
  window.addEventListener('unhandledrejection', (e) => { const r = e.reason; if (!/Preview is static/.test(String(r && r.message || r))) tell({ type: 'error', text: String(r && r.message || r) }); });
})();
</script>
<script type="module">
// What the React plugin of the dev server expects before any component loads (as the app's own page has it).
try {
  const { default: RefreshRuntime } = await import('/@react-refresh');
  RefreshRuntime.injectIntoGlobalHook(window);
  window.$RefreshReg$ = () => {};
  window.$RefreshSig$ = () => (type) => type;
  window.__vite_plugin_react_preamble_installed__ = true;
} catch {}
</script>
<script type="module" src="/@vite/client"></script>
<style>
  body { margin: 0; padding: 24px 28px 48px; }
  [data-ve-state] { font: 600 11px/1.4 ui-sans-serif, system-ui, sans-serif; letter-spacing: .04em; text-transform: uppercase; opacity: .55; padding-top: 22px; max-width: 140px; }
  [data-ve-variant]::before { content: attr(data-ve-variant-name); display: block; font: 600 11px/1.4 ui-sans-serif, system-ui, sans-serif; opacity: .55; margin-bottom: 8px; }
  [data-ve-variant][data-ve-selected]::before { content: attr(data-ve-variant-name) "  · in use"; }
  [data-ve-variant-error] { font: 12px/1.5 ui-monospace, monospace; color: #b42318; max-width: 280px; white-space: pre-wrap; }
  [data-ve-grid] { width: max-content; }
  [data-ve-group] { font: 600 12px/1.4 ui-sans-serif, system-ui, sans-serif; letter-spacing: .04em; text-transform: uppercase; color: #3b82f6; padding: 14px 0 0; border-top: 1px solid rgba(128,128,128,.25); }
  [data-ve-group]:first-child { border-top: 0; padding-top: 0; }
  [data-ve-not-for] { font: 12px/1.5 ui-sans-serif, system-ui, sans-serif; opacity: .45; padding: 6px 0; min-width: 120px; }
  /* A page's tile is a laptop-wide screen (not squeezed to its content); Fit shrinks the board. */
  html[data-ve-page] [data-ve-variant] { width: 1280px; }
  /* Preview: one variant in one state, like a page of the app (no names, no board). */
  html[data-ve-single] body { padding: 16px; }
  html[data-ve-single] [data-ve-grid] { width: auto; display: block !important; }
  html[data-ve-single] [data-ve-state], html[data-ve-single] [data-ve-variant]::before { display: none !important; }
  html[data-ve-single] [data-ve-variant] { width: auto; }
  /* A tile is chosen by its name (or an empty spot in it); what's inside works as in the app. */
  [data-ve-state], [data-ve-variant]::before { cursor: pointer; }
  [data-ve-chosen] { outline: 2px solid #3b82f6; outline-offset: 8px; border-radius: 2px; }
  [data-ve-chosen]::before { color: #2563eb; opacity: 1; }
  #ve-note { font: 14px/1.6 ui-sans-serif, system-ui, sans-serif; max-width: 560px; opacity: .8; }
</style>
</head>
<body>
<div id="ve-preview"></div>
<script type="module">
const config = ${JSON.stringify(config)};
// Preview: one variant, one state (from the address); otherwise the Playground's board.
const asked = new URLSearchParams(location.search);
if (config.page) document.documentElement.setAttribute('data-ve-page', '');
const single = asked.get('variant') ? { variant: asked.get('variant'), state: asked.get('state') || config.states[0] } : undefined;
if (single) {
  document.documentElement.setAttribute('data-ve-single', '');
  const only = document.createElement('style');
  only.textContent = '[data-ve-variant]:not([data-ve-variant="' + CSS.escape(single.variant) + '"]) { display: none !important; }';
  document.head.append(only);
}
// Review: before and after, side by side in every state (each named, whichever the switcher says is in use).
const compared = !single && asked.get('compare') ? asked.get('compare').split(',').filter(Boolean).slice(0, 2) : undefined;
if (compared) {
  const both = document.createElement('style');
  const is = (v) => '[data-ve-variant][data-ve-variant="' + CSS.escape(v) + '"]';
  both.textContent = '[data-ve-variant]' + compared.map((v) => ':not([data-ve-variant="' + CSS.escape(v) + '"])').join('') + ' { display: none !important; }'
    + ' [data-ve-grid] { grid-template-columns: max-content repeat(' + compared.length + ', max-content) !important; }'
    + compared.map((v, i) => is(v) + '::before { content: "' + (compared.length > 1 ? (i ? 'After' : 'Before') : 'Proposed') + ' · " attr(data-ve-variant-name) !important; }').join(' ');
  document.head.append(both);
}
const tell = (m) => parent !== window && parent.postMessage({ source: 've-preview-page', ...m }, '*');
const note = (text) => { document.getElementById('ve-preview').innerHTML = '<p id="ve-note"></p>'; document.getElementById('ve-note').textContent = text; };
try {
  if (!config.helper) {
    note(config.name + ' can’t be drawn yet: the project doesn’t have Visual Editor’s helper (src/visual-editor.tsx).');
    tell({ type: 'missing', what: 'helper' });
  } else {
    for (const css of config.css) await import(/* @vite-ignore */ css).catch(() => {});
    const helper = await import(/* @vite-ignore */ config.helper);
    if (typeof helper.mountPreview !== 'function') {
      note('The project’s helper (' + config.helper + ') is older: it has no mountPreview. Visual Editor can update it.');
      tell({ type: 'missing', what: 'mountPreview' });
    } else {
      // An older helper is said first (with an update to offer): a folder made for a newer one can't load with it.
      const version = helper.HELPER_VERSION ?? 1;
      const v2 = version >= 2;
      if (version < config.latestHelper) tell({ type: 'old', what: 'helper', version, latest: config.latestHelper });
      const chooser = await import(/* @vite-ignore */ config.chooser).catch((e) => {
        if (v2) throw e;
        // Made for the newer helper (the note above says how to update it).
        note(config.name + ' is made for Visual Editor’s newer helper (version 2). Update the helper to see it.');
        throw new Error('ve-stop');
      });
      // Version 2: one tile per design, each its own prototype (what you change stays in that tile), Reset, and the
      // project's providers around it. Version 1: the designs of a state drawn together, and a note to update.
      const wrap = v2 && config.providers ? (await import(/* @vite-ignore */ config.providers).catch(() => ({}))).default : undefined;
      const tiles = single ? [single.variant] : compared ?? config.variants;
      // Situations: Review's before and after shows only the one that changes; the Playground groups rows by them.
      const sit = config.situations;
      const situated = asked.get('situation');
      const rowStates = single ? [single.state] : sit && situated ? config.states.filter((s) => sit.ofState[s] === situated) : config.states;
      const groups = sit && !single && !situated ? [...sit.names.map((n) => ({ title: n, states: config.states.filter((s) => sit.ofState[s] === n) })), { title: 'other', states: config.states.filter((s) => !sit.names.includes(sit.ofState[s])) }].filter((g) => g.states.length) : undefined;
      const drawn = helper.mountPreview(
        document.getElementById('ve-preview'),
        chooser.default,
        v2 ? { states: groups ? groups.flatMap((g) => g.states) : rowStates, variants: tiles.map((id) => ({ id })), wrap, groups } : single ? { states: [single.state], columns: 1 } : { states: rowStates, columns: config.columns },
      );
      // The static part "going" somewhere (or a link): a preview is one page, so it says where it would go.
      addEventListener('visual-editor:go', (e) => tell({ type: 'goto', path: String(e.detail) }));
      addEventListener('message', (e) => {
        if (!(e.source === parent && e.data && e.data.source === 've-preview' && e.data.type === 'reset')) return;
        if (!drawn || !drawn.reset) return location.reload();
        drawn.reset();
        // Drawn again from the starting data: the window puts back what was chosen.
        setTimeout(() => tell({ type: 'drawn', cells: document.querySelectorAll('[data-ve-variant]').length, broken: [] }), 400);
      });
      if (!single && !compared) board();
      // Review's before and after: both always in view, the page shrinking to fit its width (never growing).
      if (compared) {
        const fit = () => {
          const grid = document.querySelector('[data-ve-grid]');
          if (!grid) return;
          // Measured at full size (how a zoomed size is reported differs between browsers), then shrunk once.
          document.body.style.zoom = '1';
          const natural = grid.getBoundingClientRect().width + 56;
          document.body.style.zoom = String(Math.min(1, Math.max(0.2, innerWidth / natural)));
        };
        addEventListener('resize', fit);
        setTimeout(() => {
          const grid = document.querySelector('[data-ve-grid]');
          if (grid) new ResizeObserver(fit).observe(grid);
          fit();
        }, 300);
      }
      // Tell Preview what was drawn (and any variant that stopped), once it has settled.
      setTimeout(() => {
        const cells = [...document.querySelectorAll('[data-ve-variant]')];
        const broken = [...document.querySelectorAll('[data-ve-variant-error]')].map((e) => ({ id: e.getAttribute('data-ve-variant-error'), text: e.textContent })).filter((b) => !single || b.id === single.variant);
        tell({ type: 'drawn', cells: cells.length, broken, found: !single || cells.some((c) => c.getAttribute('data-ve-variant') === single.variant) });
        const grid = document.querySelector('[data-ve-grid]');
        if (grid) new ResizeObserver(size).observe(grid);
        size();
      }, 600);
      // The fixed data, for Preview's Details (functions and elements said in words).
      if (config.mock) import(/* @vite-ignore */ config.mock).then((m) => tell({ type: 'data', file: config.mock.slice(1), states: plain(m.states ?? {}) })).catch(() => {});
    }
  }
} catch (e) {
  if (!(e && e.message === 've-stop')) {
    note(config.name + ' couldn’t be drawn: ' + (e && e.message || e));
    tell({ type: 'error', text: String(e && e.message || e) });
  }
}

/** The board's size (what Preview's Fit uses), with the page's margins. */
function size() {
  const grid = document.querySelector('[data-ve-grid]');
  if (!grid) return;
  const r = grid.getBoundingClientRect();
  tell({ type: 'size', w: Math.ceil(r.width) + 56, h: Math.ceil(r.height) + 72 });
}

/** Choosing a tile (its name, or an empty spot in it; a state's name keeps the variant), and Compare from Preview. */
function board() {
  let chosen;
  const grid = () => document.querySelector('[data-ve-grid]');
  const stateOf = (cell) => {
    let n = cell;
    while (n.parentElement && n.parentElement !== grid()) n = n.parentElement;
    for (let s = n.previousElementSibling; s; s = s.previousElementSibling) if (s.hasAttribute('data-ve-state')) return s.getAttribute('data-ve-state');
    return config.states[0];
  };
  const mark = (scroll) => {
    for (const c of document.querySelectorAll('[data-ve-chosen]')) c.removeAttribute('data-ve-chosen');
    const cell = chosen && [...document.querySelectorAll('[data-ve-variant]')].find((c) => c.getAttribute('data-ve-variant') === chosen.variant && stateOf(c) === chosen.state);
    if (!cell) return;
    cell.setAttribute('data-ve-chosen', '');
    if (scroll) cell.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' });
  };
  const choose = (variant, state) => {
    chosen = { variant, state };
    mark(false);
    tell({ type: 'chosen', variant, state });
  };
  document.addEventListener('click', (e) => {
    const t = e.target;
    if (!(t instanceof Element)) return;
    const state = t.closest('[data-ve-state]');
    if (state) {
      const first = document.querySelector('[data-ve-variant][data-ve-selected]') ?? document.querySelector('[data-ve-variant]');
      const variant = chosen?.variant ?? first?.getAttribute('data-ve-variant');
      if (variant) choose(variant, state.getAttribute('data-ve-state'));
    } else if (t.hasAttribute('data-ve-variant')) choose(t.getAttribute('data-ve-variant'), stateOf(t));
  });
  const compare = document.createElement('style');
  document.head.append(compare);
  window.addEventListener('message', (e) => {
    const m = e.data;
    if (e.source !== parent || !m || m.source !== 've-preview') return;
    if (m.type === 'choose') {
      chosen = m.variant ? { variant: m.variant, state: m.state } : undefined;
      mark(true);
    } else if (m.type === 'compare') {
      // Only these variants, side by side (the one in use and the chosen one).
      compare.textContent = m.variants ? '[data-ve-variant]' + m.variants.map((v) => ':not([data-ve-variant="' + CSS.escape(v) + '"])').join('') + ' { display: none !important; } [data-ve-grid] { grid-template-columns: max-content repeat(' + m.variants.length + ', max-content) !important; }' : '';
    }
  });
}

/** Fixed data as plain values (what postMessage can carry and Details can show). */
function plain(v, depth = 0, seen = new WeakSet()) {
  if (typeof v === 'function') return '(a function)';
  if (v === undefined) return '(nothing)';
  if (v === null || typeof v !== 'object') return typeof v === 'bigint' || typeof v === 'symbol' ? String(v) : v;
  if (v instanceof Date) return v.toISOString();
  if (v.$$typeof) return '(a React element)';
  if (seen.has(v) || depth > 8) return '(…)';
  seen.add(v);
  if (Array.isArray(v)) return v.map((x) => plain(x, depth + 1, seen));
  return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, plain(x, depth + 1, seen)]));
}
</script>
</body>
</html>`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
}

