// React's kinds of design session: a new design for a component, a change to one of its designs, a new component and
// a new page, each built in the previewable shape (docs/variants.md) so it shows in the Playground as it's made. Each
// gives Claude a brief: what to make, where, and the rules to keep (the "variant-rules" skill holds them all).

import type { Item, PluginSessionKind, SessionChoice } from '@visual-editor/contract';

/** The component's folder and file name stem: src/pages/ProjectList/index.tsx → src/pages/ProjectList, ProjectList. */
function folderOf(card: Item | undefined): { dir: string; stem: string } | undefined {
  const path = card?.source?.path;
  if (!path) return undefined;
  const dir = path.slice(0, path.lastIndexOf('/'));
  return { dir, stem: card.label };
}

/** The same in every brief: how to work in the session. */
const WAY = `Work in the session's draft: save each step with save_draft (the session's draft id), so the developer sees it
live in the session's tab; don't propose it (they press Done when they're happy). Keep to the "variant-rules" skill
("How previewable components are built"): designs are looks only, data stays in the data parts, the static part works
with no network. Look at it with draft_pictures as you go.`;

const designs = (card: Item | undefined) => (card?.preview?.variants ?? []).map((v) => `${v.name} (id "${v.id}"${v.inUse ? ', in use' : ''})`).join(', ');

export const newDesign: PluginSessionKind = {
  id: 'new-design',
  title: 'New design',
  summary: 'Another look for a component, next to the ones it has: tried in the Playground, the one in use stays.',
  needs: { card: 'previewable' },
  brief: ({ card }: SessionChoice) => {
    const f = folderOf(card);
    return `This session makes a NEW DESIGN for ${card?.label ?? 'the component'}: one more look, next to its designs (${designs(card) || 'none yet'}).
- Call variant_brief for ${card?.label ?? 'it'} first: what every design gets (its View), its states and situations.
- Add one file ${f ? `${f.dir}/${f.stem}.<id>.variant.tsx` : '<Name>.<id>.variant.tsx'} exporting variant = { id, name } (and for: […] if it's made for some situations only) and a default component taking the View.
- List it in the switcher's every() so the Playground shows it. Don't change which design is in use unless the developer asks.
${WAY}`;
  },
};

export const changeDesign: PluginSessionKind = {
  id: 'change-design',
  title: 'Change a design',
  summary: 'Change the look of one of a component’s designs: only that design changes.',
  needs: { card: 'previewable', design: true },
  brief: ({ card, design }: SessionChoice) => {
    const v = card?.preview?.variants.find((x) => x.id === design);
    return `This session CHANGES ONE DESIGN of ${card?.label ?? 'the component'}: "${v?.name ?? design}" (id "${design}", in ${v?.path ?? 'its variant file'}).
- Change only that file, and only its looks: keep its id and name, and what it gets (the View). The other designs, the data parts and the design in use stay as they are, unless the developer asks.
- If the look needs data the View doesn't have, say so and ask before changing the data parts.
${WAY}`;
  },
};

export const newComponent: PluginSessionKind = {
  id: 'new-component',
  title: 'New component',
  summary: 'A new component, made previewable from the start: its designs and states show in the Playground.',
  needs: { name: 'The new component’s name, e.g. ProjectBadge' },
  brief: ({ name }: SessionChoice) => `This session makes a NEW COMPONENT, ${name}, in the previewable shape from the start.
- Make its folder where the project keeps components like it (look at the map: list_cards), with the files the "variant-rules" skill lists: index.tsx (the chooser), ${name}.types.ts (Props, Start, View), ${name}.data.tsx, ${name}.static.tsx, ${name}.mock.ts (named states: default, and the ones that matter, e.g. empty, long text), ${name}.switcher.tsx and ${name}.variant.tsx (its first design).
- Don't use it anywhere in the app yet, unless the developer asks: first it is shaped in the Playground.
${WAY}`,
};

export const newPage: PluginSessionKind = {
  id: 'new-page',
  title: 'New page',
  summary: 'A new page at an address of the app, made previewable from the start: it works in the app and as a prototype.',
  needs: { name: 'The new page’s name, e.g. Billing', page: true },
  brief: ({ name, page }: SessionChoice) => `This session makes a NEW PAGE, ${name}, at ${page}, in the previewable shape from the start.
- Make its folder where the project keeps its pages (look at the map: list_cards, the "pages" map), with the files the "variant-rules" skill lists for a page: index.tsx (the chooser), ${name}.types.ts, ${name}.data.tsx (its real data), ${name}.static.tsx, ${name}.mock.ts (named states: default, empty, and the ones that matter), ${name}.switcher.tsx and ${name}.variant.tsx (its first design).
- Add its route to the app's router so ${page} shows it, the same way the other pages are routed. Add a link to it in the navigation only if the developer asks.
- It must work both ways: in the app at ${page} (real data) and in the Playground (its states, as a prototype).
${WAY}`,
};

export const sessionKinds: PluginSessionKind[] = [newDesign, changeDesign, newComponent, newPage];
