// The Playground: other versions of a component, to compare side by side with the one in the code, each with checks
// (does it reuse the project's components, keep to its design, type-check?). Versions live in one file per component,
// `.visual-editor/playground/<Name>/variants.tsx` (not committed): each exported component in it is a version, the
// comment above it says what's different. Assistants write it (or use the tools); the developer picks one, which
// becomes a proposal. No VS Code APIs, so it can be tested.

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Choice, Version } from '@visual-editor/contract';
import type { FeComponent, FeModel } from '../read/model';
import type { TypeView } from '../read/types';
import { checkVariants, projectPalette, type VersionChecks } from './checks';
import { chooseVersion } from './choose';
import { VARIANTS_FILE, labelOf, readVariantDecls } from './variantsFile';

export const PLAYGROUND_DIR = '.visual-editor/playground';

/** The folder of a component's versions: its name, or name and file when two components share a name. */
export function playgroundDir(c: FeComponent, model: FeModel): string {
  const twins = model.components.filter((x) => x.name === c.name && !x.parent);
  if (twins.length <= 1) return `${PLAYGROUND_DIR}/${c.name}`;
  return `${PLAYGROUND_DIR}/${c.name}-${createHash('sha256').update(c.path).digest('hex').slice(0, 6)}`;
}

/** The versions file of a component (project-relative), and its text when it exists. */
export function variantsOf(root: string, c: FeComponent, model: FeModel): { path: string; text?: string } {
  const path = `${playgroundDir(c, model)}/${VARIANTS_FILE}`;
  const full = join(root, path);
  if (!existsSync(full)) return { path };
  // Versions are work in progress: kept out of git, like the preview files.
  const ignore = join(root, PLAYGROUND_DIR, '.gitignore');
  if (!existsSync(ignore)) writeFileSync(ignore, '# Visual Editor playground: versions being tried, never committed.\n*\n');
  return { path, text: readFileSync(full, 'utf8') };
}

const checked = new Map<string, Record<string, VersionChecks>>();

/** A component's versions, with what the checks found (worked out again only when the file changes). */
export function versionsOf(root: string, c: FeComponent, model: FeModel, texts: Map<string, string>, view: TypeView | undefined): Version[] {
  const { path, text } = variantsOf(root, c, model);
  if (!text) return [];
  const decls = readVariantDecls(text);
  const key = createHash('sha256').update(`${root}\n${path}\n${text}`).digest('hex');
  let checks = checked.get(key);
  if (!checks) {
    const palette = projectPalette([...texts].map(([p, t]) => ({ path: p, text: t })));
    let typeErrors: { line: number; message: string }[] | { skipped: string };
    try {
      typeErrors = view ? view.errorsIn(path) : { skipped: "the project has no TypeScript to check with" };
    } catch (e) {
      typeErrors = { skipped: e instanceof Error ? e.message : String(e) };
    }
    checks = checkVariants({ text, path, decls, fe: model, palette, typeErrors });
    checked.set(key, checks);
  }
  return decls.map((d) => ({ id: d.exportName, label: versionLabel(d.exportName, c.name), ...(d.notes ? { notes: d.notes } : {}), ...(checks[d.exportName] ? { checks: checks[d.exportName] } : {}) }));
}

/** A version's name to show: without the component's name in front (EntityNodeAccentSpine → "Accent spine"). */
export function versionLabel(exportName: string, component: string): string {
  const rest = exportName.startsWith(component) && /^[A-Z]/.test(exportName.slice(component.length)) ? exportName.slice(component.length) : exportName;
  const label = labelOf(rest);
  return label[0].toUpperCase() + label.slice(1);
}

/** The change that makes a version the real component: its code in the component's file, under the component's name. */
export async function choiceFor(c: FeComponent, model: FeModel, version: string, read: (path: string) => Promise<string | undefined>, root: string): Promise<Choice> {
  const { path } = variantsOf(root, c, model);
  const variants = await read(path);
  const target = await read(c.path);
  if (!variants) throw new Error(`There are no versions of ${c.name} (${path} is missing).`);
  if (target === undefined) throw new Error(`${c.path} is missing.`);
  const decl = readVariantDecls(variants).find((d) => d.exportName === version);
  if (!decl) throw new Error(`There's no version ${version} of ${c.name}.`);
  const made = chooseVersion({ variants: { path, text: variants }, exportName: version, target: { path: c.path, name: c.name, text: target } });
  const extra = [made.helpers.length ? `brings ${made.helpers.join(', ')}` : '', made.imports.length ? `imports ${made.imports.join(', ')}` : ''].filter(Boolean).join('; ');
  return {
    title: `Use the "${versionLabel(version, c.name)}" version of ${c.name}`,
    why: [decl.notes, `Chosen in the Playground: its code replaces ${c.name} in ${c.path}, under the same name, so everything that uses it keeps working.`, extra ? `It ${extra}.` : ''].filter(Boolean).join(' '),
    changes: [{ path: c.path, after: made.text }],
  };
}
