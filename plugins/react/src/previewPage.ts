// Preview's page for a component made previewable (docs/variants.md): served at the app's address, so the dev server
// gives it the project's own styles and code. It loads the app's global CSS (what its entry file imports), Visual
// Editor's helper and the component's chooser, and draws every variant in every mock state with fixed data. Calls
// to the network are blocked (and reported: a variant must be static); the dev server's live reload is kept, so a
// saved variant shows at once. It talks to Preview (the window around it) with postMessage, source "ve-preview-page".

import { existsSync, readFileSync } from 'node:fs';
import { join, posix } from 'node:path';
import type { Item, ProjectInfo } from '@visual-editor/contract';

const HELPER = /(^|\/)visual-editor\.[cm]?[jt]sx?$/;

/** The project's helper file (src/visual-editor.tsx), if it has one. */
export function helperFile(project: ProjectInfo): string | undefined {
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

/** The page's HTML, or a page that says what's missing. */
export function previewPage(item: Item, project: ProjectInfo): string | undefined {
  if (!item.preview || !item.source) return undefined;
  const helper = helperFile(project);
  const css = globalCss(project);
  const columns = item.preview.variants.length;
  const config = { name: item.label, chooser: `/${item.source.path}`, helper: helper ? `/${helper}` : undefined, css, states: item.preview.states.length ? item.preview.states : ['default'], columns };
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
  #ve-note { font: 14px/1.6 ui-sans-serif, system-ui, sans-serif; max-width: 560px; opacity: .8; }
</style>
</head>
<body>
<div id="ve-preview"></div>
<script type="module">
const config = ${JSON.stringify(config)};
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
      const chooser = await import(/* @vite-ignore */ config.chooser);
      helper.mountPreview(document.getElementById('ve-preview'), chooser.default, { states: config.states, columns: config.columns });
      // Tell Preview what was drawn (and any variant that stopped), once it has settled.
      setTimeout(() => {
        const cells = [...document.querySelectorAll('[data-ve-variant]')];
        const broken = [...document.querySelectorAll('[data-ve-variant-error]')].map((e) => ({ id: e.getAttribute('data-ve-variant-error'), text: e.textContent }));
        tell({ type: 'drawn', cells: cells.length, broken, size: { w: document.body.scrollWidth, h: document.body.scrollHeight } });
      }, 600);
    }
  }
} catch (e) {
  note(config.name + ' couldn’t be drawn: ' + (e && e.message || e));
  tell({ type: 'error', text: String(e && e.message || e) });
}
</script>
</body>
</html>`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
}

