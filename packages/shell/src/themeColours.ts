// The code colours of the theme the developer has on now: found among the installed themes (VS Code's own included),
// read from its files (following "include"), with their own colour settings on top. Pages get them as CSS variables.

import * as vscode from 'vscode';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { customRules, parseJsonc, tmThemeRules, tokenColours, type ThemeFile, type TokenRule } from './themeTokens';

/** The id of the theme on now (the one chosen for light or dark when VS Code follows the system). */
export function currentThemeId(): string | undefined {
  const workbench = vscode.workspace.getConfiguration('workbench');
  const kind = vscode.window.activeColorTheme.kind;
  if (vscode.workspace.getConfiguration('window').get<boolean>('autoDetectColorScheme')) {
    const preferred =
      kind === vscode.ColorThemeKind.Light ? 'preferredLightColorTheme'
      : kind === vscode.ColorThemeKind.HighContrast ? 'preferredHighContrastColorTheme'
      : kind === vscode.ColorThemeKind.HighContrastLight ? 'preferredHighContrastLightColorTheme'
      : 'preferredDarkColorTheme';
    const id = workbench.get<string>(preferred);
    if (id) return id;
  }
  return workbench.get<string>('colorTheme');
}

/** Where the theme's file is, from the extension that brings it. */
function themePath(id: string): string | undefined {
  for (const ext of vscode.extensions.all) {
    const themes = (ext.packageJSON as { contributes?: { themes?: { id?: string; label?: string; path: string }[] } })?.contributes?.themes ?? [];
    const found = themes.find((t) => t.id === id || t.label === id);
    if (found) return join(ext.extensionPath, found.path);
  }
  return undefined;
}

/** A theme file's rules and semantic colours, with those of the files it includes first. */
async function load(path: string, depth = 0): Promise<{ rules: TokenRule[]; semantic: NonNullable<ThemeFile['semanticTokenColors']> }> {
  const text = await readFile(path, 'utf8');
  if (/\.tmTheme$/i.test(path)) return { rules: tmThemeRules(text), semantic: {} };
  const theme = parseJsonc(text) as ThemeFile;
  const base = theme.include && depth < 8 ? await load(join(dirname(path), theme.include), depth + 1) : { rules: [], semantic: {} };
  let rules: TokenRule[] = [];
  if (Array.isArray(theme.tokenColors)) rules = theme.tokenColors;
  else if (typeof theme.tokenColors === 'string') rules = (await load(join(dirname(path), theme.tokenColors), depth + 1)).rules;
  return { rules: [...base.rules, ...rules], semantic: { ...base.semantic, ...(theme.semanticTokenColors ?? {}) } };
}

/** The code colours of the theme on now ({} when it can't be read: pages then use VS Code's general colours). */
export async function themeTokenColours(): Promise<Record<string, string>> {
  const id = currentThemeId();
  const path = id && themePath(id);
  if (!id || !path) return {};
  try {
    const { rules, semantic } = await load(path);
    const editor = vscode.workspace.getConfiguration('editor');
    const custom = customRules(editor.get<Record<string, unknown>>('tokenColorCustomizations'), id);
    const semanticCustom = editor.get<{ rules?: Record<string, string | { foreground?: string }>; [theme: string]: unknown }>('semanticTokenColorCustomizations');
    const themeSemantic = (semanticCustom?.[`[${id}]`] as { rules?: Record<string, string | { foreground?: string }> } | undefined)?.rules;
    return tokenColours([...rules, ...custom], { ...semantic, ...(semanticCustom?.rules ?? {}), ...(themeSemantic ?? {}) });
  } catch {
    return {};
  }
}

/** Calls back whenever the theme, or the developer's own code colours, change. */
export function onThemeChange(listener: () => void): vscode.Disposable {
  return vscode.Disposable.from(
    vscode.window.onDidChangeActiveColorTheme(listener),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (['workbench.colorTheme', 'editor.tokenColorCustomizations', 'editor.semanticTokenColorCustomizations'].some((s) => e.affectsConfiguration(s))) listener();
    }),
  );
}
