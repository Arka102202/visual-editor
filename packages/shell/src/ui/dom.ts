// Small helpers shared by the pages shown inside VS Code (the map, review). Plain DOM, no framework.

/** Makes an element with a class and text (text is never read as HTML). */
export function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

/** Adds the page's styles, after the base every page shares (VS Code's colours and font). */
export function addStyles(css: string) {
  const style = document.createElement('style');
  style.textContent = `
  :root { color-scheme: light dark; }
  html, body { margin: 0; height: 100%; overflow: hidden; background: var(--vscode-editor-background); color: var(--vscode-foreground); font: var(--vscode-font-size, 13px) / 1.4 var(--vscode-font-family, system-ui); }
  button, select { font: inherit; }
  button { cursor: pointer; border-radius: 4px; padding: 4px 10px; border: 1px solid transparent; color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground); }
  button:hover { background: var(--vscode-button-secondaryHoverBackground, var(--vscode-button-secondaryBackground)); }
  button.primary { color: var(--vscode-button-foreground); background: var(--vscode-button-background); }
  button.primary:hover { background: var(--vscode-button-hoverBackground, var(--vscode-button-background)); }
  .chip { font-size: 11px; padding: 1px 7px; border-radius: 10px; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); white-space: nowrap; }
  .chip.proposed { background: #d9a400; color: #1e1e1e; }
  .chip.changed { background: #2f6fdb; color: #fff; }
  [hidden] { display: none !important; }
${css}`;
  document.head.append(style);
}

/** "3 minutes ago", "yesterday", or the date. */
export function ago(iso: string): string {
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (!Number.isFinite(s)) return '';
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  if (s < 172800) return 'yesterday';
  return new Date(iso).toLocaleDateString();
}
