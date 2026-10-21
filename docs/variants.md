# Variants: how a component is made previewable

A component is shown in **Preview** only when its folder has this shape. Its **looks** (the variants) are kept apart
from its **data**, so:

- the app shows the variant in use, with real data;
- Preview shows every variant, with fixed (mock) data, and never calls an API;
- Visual Editor can propose **look changes** in variant files and **logic changes** in the data file.

## The folder

```
ProjectCard/
  index.tsx                         the chooser: what the rest of the app imports
  ProjectCard.types.ts              ProjectCardProps (what a parent passes) and ProjectCardView (what every variant gets)
  ProjectCard.data.tsx              the real data: hooks, API, stores → ProjectCardView → the switcher, as "real"
  ProjectCard.mock.ts               fixed data: named states (default, empty, long name…), each a ProjectCardView
  ProjectCard.switcher.tsx          which variant is in use (one line); every variant, for Preview only
  ProjectCard.variant.tsx           a variant: looks only (id "default")
  ProjectCard.compact.variant.tsx   another variant (id "compact")
```

And once per project: `src/visual-editor.tsx`, the small helper every folder uses (Visual Editor adds it when asked).

## The key

Every chooser and switcher follows one key, set from above:

| Key | Where | Data | Variants shown |
|---|---|---|---|
| `real` | the app (the default: nothing to set) | real | the one in use |
| `mock` | Preview, for the component you opened | fixed | every one |
| `mock-selected` | Preview, for anything inside it | fixed | the one in use |

So a child inside a previewed component always shows its own variant in use.

## The rules for each file

**`index.tsx` (the chooser)**
- With `real`, draws `Name.data.tsx`. Otherwise draws the fixed data (`Name.mock.ts`) into the switcher.
- Loads `Name.mock.ts` only in development (`import.meta.env.DEV`), so mock data never ships to users.

**`Name.types.ts`**
- `NameProps`: what a parent passes. `NameView`: what every variant gets, ready to show (text already formatted,
  callbacks already wired).
- Both the real data and the mock data must produce `NameView`; every variant must accept it. TypeScript then keeps
  them from drifting apart.

**`Name.data.tsx` (real data)**
- All hooks, API calls, stores and context reads live here. It turns them into `NameView` and draws the switcher
  with `mode="real"`.

**`Name.mock.ts` (fixed data)**
- `export const states: Record<string, NameView>`, with a `default` state. Every variant is shown with every state.
- Committed to git, like the rest of the code.
- In Preview, what a parent passes comes first; the child's own mock fills in the rest.

**`Name.switcher.tsx`**
- Imports the variant in use the normal way, on **one line** (choosing another design changes that line).
- Lists every variant as `import()` inside `import.meta.env.DEV ? … : undefined`, so the others never ship to users.

**`Name.variant.tsx`, `Name.<name>.variant.tsx` (a variant)**
- Exports `variant = { id, name }` (the id is unique within the component) and a default component taking `NameView`.
- Looks only. It may keep its own UI state (a menu open, hover) and use plain UI pieces and other components (which
  show their own variant in use).
- It may **not** call APIs, read or change stores, or use data hooks.

## In production

Only the chooser, the real data, the switcher and the variant in use are built into the app. Mock data and the other
variants are left out.
