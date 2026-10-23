// "Use this design": the change that makes another variant the one in use. The switcher says which, in one import
// line (docs/variants.md); only that line's address changes, so every other variant stays in the list and switching
// back is just as easy. Read from the code itself, so a commented-out line can't be the one changed.

import { existsSync, readFileSync } from 'node:fs';
import { join, posix } from 'node:path';
import { parse } from '@babel/parser';
import type { Item, ProjectInfo, ProposedChange } from '@visual-editor/contract';

export function useVariant(
  item: Item,
  variant: string,
  project: ProjectInfo,
  read: (path: string) => string | undefined = (p) => (existsSync(join(project.root, p)) ? readFileSync(join(project.root, p), 'utf8') : undefined),
): ProposedChange | string {
  const p = item.preview;
  if (!p || !item.source) return `${item.label} has no variants.`;
  const next = p.variants.find((v) => v.id === variant);
  if (!next) return `${item.label} has no variant “${variant}”.`;
  if (next.inUse) return `${next.name} is already the one in use.`;
  const now = p.variants.find((v) => v.inUse);
  const dir = posix.dirname(item.source.path);
  const switcher = project.files.find((f) => posix.dirname(f) === dir && /\.switcher\.[cm]?[jt]sx?$/.test(f));
  if (!switcher) return `${item.label} has no switcher file (${item.label}.switcher.tsx), so there's no line that says which variant is in use.`;
  const before = read(switcher);
  if (before === undefined) return `${switcher} couldn't be read.`;

  // The variant in use: the switcher's normal import of a variant file (not a type, not import()).
  let ast;
  try {
    ast = parse(before, { sourceType: 'module', plugins: ['typescript', 'jsx'] });
  } catch (e) {
    return `${posix.basename(switcher)} doesn't read as code right now (${e instanceof Error ? e.message : String(e)}). Fix it first.`;
  }
  const line = ast.program.body.find(
    (s) => s.type === 'ImportDeclaration' && s.importKind !== 'type' && s.source.value.startsWith('./') && /\.variant$/.test(s.source.value.replace(/\.[cm]?[jt]sx?$/, '')) && s.specifiers.some((x) => x.type === 'ImportDefaultSpecifier'),
  );
  if (!line || line.type !== 'ImportDeclaration' || line.source.start == null || line.source.end == null) return `${posix.basename(switcher)} doesn't import a variant the normal way, so there's no line to change.`;
  let address = posix.relative(dir, next.path).replace(/\.[cm]?[jt]sx?$/, '');
  if (!address.startsWith('.')) address = `./${address}`;
  const quote = before[line.source.start];
  const after = before.slice(0, line.source.start) + quote + address + quote + before.slice(line.source.end);
  if (after === before) return `${next.name} is already the one in use.`;

  const was = now ? now.name : 'the one in use';
  return {
    title: `${item.label}: use ${next.name} instead of ${was}`,
    why: `Chosen in the Playground. Only one line changes: the switcher's import of the variant in use. ${now ? `${now.name} stays in the list of variants, so switching back is just as easy.` : ''}`.trim(),
    changes: [{ path: switcher, before, after }],
    look: `/__ve/preview?item=${encodeURIComponent(item.id)}&compare=${encodeURIComponent([now?.id, next.id].filter(Boolean).join(','))}`,
  };
}
