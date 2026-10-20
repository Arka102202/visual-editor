// The colours the theme in use gives code (types, strings, keywords…), worked out from its theme file, so pages that
// show code-like text (a prop's type) colour it exactly as the editor does. Pure: reading the files is themeColours.ts.

/** One colouring rule of a theme ("tokenColors"). */
export interface TokenRule {
  scope?: string | string[];
  settings?: { foreground?: string };
}

/** The parts of a colour theme file that matter here. */
export interface ThemeFile {
  include?: string;
  /** Rules, or the path of a file that holds them (a .tmTheme or another .json). */
  tokenColors?: TokenRule[] | string;
  semanticHighlighting?: boolean;
  semanticTokenColors?: Record<string, string | { foreground?: string }>;
}

/** What the page colours, and where the editor would take each colour from (most specific first). */
export const WANTED: Record<string, { scopes: string[]; semantic?: string[] }> = {
  type: { scopes: ['entity.name.type.ts', 'support.type', 'entity.name.class'], semantic: ['type', 'class', 'interface'] },
  builtin: { scopes: ['support.type.primitive.ts', 'support.type.builtin', 'keyword.type', 'storage.type'] },
  literal: { scopes: ['constant.language.null.ts', 'constant.language'] },
  string: { scopes: ['string.quoted.single.ts', 'string'] },
  number: { scopes: ['constant.numeric.decimal.ts', 'constant.numeric'] },
  param: { scopes: ['variable.parameter.ts', 'variable.parameter', 'variable'], semantic: ['parameter'] },
  property: { scopes: ['variable.other.property.ts', 'variable.other.object.property', 'meta.object-literal.key', 'variable.other', 'variable'], semantic: ['property'] },
  function: { scopes: ['entity.name.function.ts', 'entity.name.function', 'support.function'], semantic: ['function', 'method'] },
  component: { scopes: ['support.class.component.tsx', 'entity.name.tag.tsx', 'entity.name.tag'] },
  keyword: { scopes: ['storage.type.function.arrow.ts', 'keyword.control', 'keyword', 'storage.type'] },
  punctuation: { scopes: ['punctuation.separator.parameter.ts', 'punctuation'] },
};

/** JSON with comments and trailing commas, as theme files are written. */
export function parseJsonc(text: string): unknown {
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      const start = i;
      for (i++; i < text.length && text[i] !== '"'; i++) if (text[i] === '\\') i++;
      out += text.slice(start, i + 1);
    } else if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      out += '\n';
    } else if (c === '/' && text[i + 1] === '*') {
      i = text.indexOf('*/', i + 2);
      if (i < 0) break;
      i++;
    } else {
      out += c;
    }
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1'));
}

/** The rules in a .tmTheme (a plist): each scope with its foreground colour. */
export function tmThemeRules(xml: string): TokenRule[] {
  const rules: TokenRule[] = [];
  for (const chunk of xml.split(/<key>\s*scope\s*<\/key>/).slice(1)) {
    const scope = /^\s*<string>([^<]*)<\/string>/.exec(chunk)?.[1];
    const foreground = /<key>\s*foreground\s*<\/key>\s*<string>([^<]*)<\/string>/.exec(chunk)?.[1];
    if (scope && foreground) rules.push({ scope, settings: { foreground: foreground.trim() } });
  }
  return rules;
}

/** The colour the rules give a scope: the most specific selector that covers it wins; on a tie, the later rule. */
function colourOf(rules: TokenRule[], scope: string): string | undefined {
  let best: { depth: number; colour: string } | undefined;
  for (const rule of rules) {
    const colour = rule.settings?.foreground;
    if (!colour) continue;
    const selectors = Array.isArray(rule.scope) ? rule.scope : (rule.scope ?? '').split(',');
    for (const raw of selectors) {
      const s = raw.trim();
      // Selectors that need a context ("meta.x string") apply only inside it; skip them.
      if (!s || /\s/.test(s)) continue;
      if (scope !== s && !scope.startsWith(`${s}.`)) continue;
      const depth = s.split('.').length;
      if (!best || depth >= best.depth) best = { depth, colour };
    }
  }
  return best?.colour;
}

/** The colours for what the page colours, from a theme's rules (and its semantic colours, which win when set). */
export function tokenColours(rules: TokenRule[], semantic: ThemeFile['semanticTokenColors'] = {}): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, want] of Object.entries(WANTED)) {
    const fromSemantic = want.semantic?.map((k) => semantic[k]).find(Boolean);
    const colour = (typeof fromSemantic === 'string' ? fromSemantic : fromSemantic?.foreground) ?? want.scopes.map((s) => colourOf(rules, s)).find(Boolean);
    if (colour && /^#[0-9a-f]{3,8}$/i.test(colour)) out[key] = colour;
  }
  return out;
}

/** The developer's own colours from settings ("editor.tokenColorCustomizations"), as rules added after the theme's. */
export function customRules(custom: Record<string, unknown> | undefined, themeId: string): TokenRule[] {
  if (!custom) return [];
  const rules: TokenRule[] = [];
  const SHORT: Record<string, string> = { comments: 'comment', strings: 'string', keywords: 'keyword', numbers: 'constant.numeric', types: 'entity.name.type', functions: 'entity.name.function', variables: 'variable' };
  for (const part of [custom, custom[`[${themeId}]`] as Record<string, unknown> | undefined]) {
    if (!part || typeof part !== 'object') continue;
    for (const [key, scope] of Object.entries(SHORT)) {
      const v = (part as Record<string, unknown>)[key] as string | { foreground?: string } | undefined;
      const foreground = typeof v === 'string' ? v : v?.foreground;
      if (foreground) rules.push({ scope, settings: { foreground } });
    }
    const more = (part as { textMateRules?: TokenRule[] }).textMateRules;
    if (Array.isArray(more)) rules.push(...more);
  }
  return rules;
}
