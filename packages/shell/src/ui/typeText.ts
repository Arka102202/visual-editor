// A type as the developer wrote it (e.g. "(id: string, v: QueryType | null) => void"), coloured exactly as the editor
// colours code in the theme on now: the shell reads the theme's own code colours and the page sets them as --tok-*
// variables (useThemeTokens). Until they arrive, VS Code's general colours stand in.

import { el } from './dom';

/** The styles for typeText(); add them to the page once. */
export const TYPE_CSS = `
  .ts-str { color: var(--tok-string, var(--vscode-debugTokenExpression-string, #ce9178)); }
  .ts-num { color: var(--tok-number, var(--vscode-debugTokenExpression-number, #b5cea8)); }
  .ts-builtin { color: var(--tok-builtin, var(--vscode-debugTokenExpression-boolean, #4e94ce)); }
  .ts-lit { color: var(--tok-literal, var(--vscode-debugTokenExpression-boolean, #4e94ce)); }
  .ts-type { color: var(--tok-type, var(--vscode-symbolIcon-classForeground, #ee9d28)); }
  .ts-param { color: var(--tok-param, var(--vscode-symbolIcon-variableForeground, #75beff)); }
  .ts-arrow { color: var(--tok-keyword, inherit); }
  .ts-punc { color: var(--tok-punctuation, inherit); opacity: .75; }
`;

const TOKEN =
  /('[^']*'|"[^"]*"|`[^`]*`)|(\b\d+(?:\.\d+)?\b)|(\b(?:string|number|boolean|void|any|unknown|never|object|bigint|symbol|keyof|typeof|readonly)\b)|(\b(?:null|undefined|true|false)\b)|(\b[A-Z][\w$]*)|([A-Za-z_$][\w$]*(?=\??\s*:))|(=>)|([(){}[\]<>|&,;:?.=]+)/g;
const KINDS = ['ts-str', 'ts-num', 'ts-builtin', 'ts-lit', 'ts-type', 'ts-param', 'ts-arrow', 'ts-punc'];

/** Sets the theme's code colours on the page (from the shell's 'theme' message); missing ones fall back. */
export function useThemeTokens(tokens: Record<string, string>) {
  const root = document.documentElement.style;
  for (const name of [...root].filter((n) => n.startsWith('--tok-'))) root.removeProperty(name);
  for (const [key, colour] of Object.entries(tokens)) root.setProperty(`--tok-${key}`, colour);
}

/** The type's text, in coloured pieces (plain text in between). */
export function typeText(text: string): DocumentFragment {
  const out = document.createDocumentFragment();
  let at = 0;
  for (const m of text.matchAll(TOKEN)) {
    if (m.index > at) out.append(text.slice(at, m.index));
    const kind = KINDS[m.slice(1).findIndex((g) => g !== undefined)];
    out.append(el('span', kind, m[0]));
    at = m.index + m[0].length;
  }
  if (at < text.length) out.append(text.slice(at));
  return out;
}
