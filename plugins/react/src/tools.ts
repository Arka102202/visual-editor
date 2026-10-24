// The React plugin's tools for assistants (Claude Code calls them through the shell's hub). Pure: cards in, words out.

import type { Item, PluginTool } from '@visual-editor/contract';

/** Components and pages Preview can show (docs/variants.md), with their designs; and the ones it can't yet. */
export const previewableTool: PluginTool = {
  name: 'previewable',
  title: 'Components that can be previewed',
  description:
    'Which components and pages can be shown in Preview and the Playground: their designs (the one in use), fixed-data states, situations and what breaks the rules. Also lists the ones that cannot be previewed yet. Use before making something previewable or adding a design.',
  input: {
    search: { type: 'string', description: 'Part of a name or file path', optional: true },
  },
  run: ({ search }, { items }) => previewableText(items, typeof search === 'string' ? search : undefined),
};

/** How many not-yet-previewable names to list (the rest are counted). */
const MAX_OTHERS = 60;

export function previewableText(items: Item[], search?: string): string {
  const q = search?.toLowerCase();
  const components = items.filter((i) => i.map === 'components' && (!q || i.label.toLowerCase().includes(q) || i.source?.path.toLowerCase().includes(q)));
  if (!components.length) return q ? `No component or page matches "${search}".` : 'This project has no components yet.';
  const ready = components.filter((i) => i.preview);
  const others = components.filter((i) => !i.preview);
  const out: string[] = [];
  out.push(ready.length ? `Can be previewed (${ready.length}):` : 'None can be previewed yet: each needs its folder in the variant shape (docs/variants.md).');
  for (const i of ready) {
    const p = i.preview!;
    out.push(`- ${i.label} (${i.kind}) · ${i.id}${i.source ? ` · ${i.source.path}` : ''}`);
    const name = (v: (typeof p.variants)[number]) =>
      `${v.name}${v.inUseFor?.length ? ` (in use for ${v.inUseFor.join(', ')})` : v.inUse ? ' (in use)' : ''}${v.for?.length ? ` [made for ${v.for.join(', ')}]` : ''}`;
    out.push(`  Designs: ${p.variants.map(name).join(', ')}`);
    if (p.states.length) out.push(`  States: ${p.states.join(', ')}`);
    if (p.situations) out.push(`  Situations (picked by the prop "${p.situations.prop}"): ${p.situations.names.join(', ')}`);
    for (const problem of p.problems ?? []) out.push(`  Problem: ${problem}`);
  }
  if (others.length) {
    const byKind = new Map<string, number>();
    for (const i of others) byKind.set(i.kind, (byKind.get(i.kind) ?? 0) + 1);
    out.push('', `Not previewable yet (${others.length}: ${[...byKind].map(([k, n]) => `${n} ${k}`).join(', ')}):`);
    out.push(...others.slice(0, MAX_OTHERS).map((i) => `- ${i.label} (${i.kind})${i.source ? ` · ${i.source.path}` : ''}`));
    if (others.length > MAX_OTHERS) out.push(`…and ${others.length - MAX_OTHERS} more (narrow it with search).`);
  }
  return out.join('\n');
}
