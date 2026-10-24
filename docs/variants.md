# Variants: how a component or page is made previewable

A component or page can be shown in **Preview** and the **Playground** only when its folder has the shape below.
Its **looks** (the designs) are kept apart from its **data**, and its data has **two parts**:

- **Dynamic:** the real data (hooks, API, stores). The app uses it.
- **Static:** a **working prototype** with no network. Preview and the Playground use it.

So:

- the app shows the design in use, with real data;
- Preview and the Playground show the designs with the static part: no API calls, but clicks work;
- Visual Editor can propose **look changes** in design files and **logic changes** in the data parts.

Nothing here changes how the app behaves for users. The static part, the starting data and the designs that aren't
in use are left out of production builds.

---

## The folder

```
ProjectList/
  index.tsx                        the chooser: what the rest of the app imports
  ProjectList.types.ts             Props, Start, View (and Situation, if any)
  ProjectList.data.tsx             dynamic: hooks, API, stores → View
  ProjectList.static.tsx           static: starting data + clicks that change it in memory → View
  ProjectList.mock.ts              the starting data, as named states (default, empty, many…)
  ProjectList.switcher.tsx         which design is in use (per situation, if any)
  ProjectList.variant.tsx          a design: looks only (id "default")
  ProjectList.cards.variant.tsx    another design (id "cards")
```

Once per project, kept in place by Visual Editor (you never edit it):

- `.visual-editor/react/visual-editor.tsx`: **the helper**, the small toolbox every folder uses, imported by its short
  name `@visual-editor/react`. As soon as Visual Editor opens a React project, it writes the helper and adds that short
  name to the project's TypeScript and Vite configs (one line each, in the project's own style), and says so in a
  notice. When a newer Visual Editor ships a newer helper, the file is updated the same way, never to an older one.
  Commit these with your next commit. (Folders made before this imported `src/visual-editor.tsx`; that still works.)
- `src/visual-editor.providers.tsx` **(optional)**: what every preview is wrapped in, such as a router in memory or a
  theme. Visual Editor offers it when a design needs it (links, for example).

---

## The three types (and situations)

In `Name.types.ts`:

| Type | What it is | ProjectCard (a child) | ProjectList (a page) |
|---|---|---|---|
| `NameProps` | what a parent passes | `project`, `accentColor`, `onOpen`, `onDelete` | nothing |
| `NameStart` **(new)** | what the static part starts from: example props, plus any data the component gets for itself | the same as its props | `projects` |
| `NameView` | what every design gets, ready to show: text formatted, callbacks wired | `name`, `updated` ("5m ago"), `onOpen`… | `projects` (as cards), `isEmpty`, `onCreate`… |

TypeScript checks that both data parts produce `NameView` and that every design accepts it, so they can't drift
apart.

---

## The key: what is shown where

Every chooser and switcher follows one key, set from above:

| Key | Where | Data part | Designs shown |
|---|---|---|---|
| `real` | the app (the default: nothing to set) | dynamic | the one in use |
| `mock` | Preview or the Playground, for the component you opened | static, from its own starting data | the Playground: every one · Preview: the one you picked |
| `mock-selected` | anything **inside** a preview | static, from **what its parent passes** | the one in use |

**Children get their parent's data (new).** On a page in Preview, each ProjectCard receives the project the page
gives it. Its static part shapes that, so every card is different, just as in the app. On its own (in its own
Playground), a child starts from its own starting data. If a child gets data for itself (not from its parent), that
part comes from the child's own starting data, in the same state as the page ("empty" page → "empty" child, when it
has one).

**Legacy children:** a child that isn't in this shape shows as it is. Nothing is noted or changed.

---

## The rules for each file

### `index.tsx` (the chooser)

- With `real`, it draws the dynamic part (`Name.data.tsx`). Otherwise it draws the static part, starting from
  `Name.mock.ts`, with what a parent passes on top.
- It loads the static part and the starting data only in development (`import.meta.env.DEV`), so neither reaches
  users.
- It's a short, plain component (so the map reads it like any other), using the helper's `StaticPart`:

```tsx
import { StaticPart, useVariantKey } from '@visual-editor/react'
import ProjectListData from './ProjectList.data'
import type { ProjectListProps } from './ProjectList.types'

// The static part and its starting data: development only (left out of production builds).
const preview = import.meta.env.DEV ? { start: () => import('./ProjectList.mock'), part: () => import('./ProjectList.static') } : undefined

/** The chooser: the dynamic part in the app; the static prototype in Preview and the Playground. */
export default function ProjectList(props: ProjectListProps) {
  if (useVariantKey() === 'real' || !preview) return <ProjectListData {...props} />
  return <StaticPart {...preview} props={props} />
}
```

### `Name.data.tsx` (dynamic)

- All hooks, API calls, stores, context and router reads live here.
- It turns them into `NameView` and draws the switcher.

### `Name.static.tsx` (static) (new)

- It gets `NameStart` (what a parent passed, or the starting data) and gives `NameView` to the switcher.
- It **is a prototype:** it keeps its data in memory (plain React state), and its callbacks change that data.
  "New project" adds a card, "Delete" removes one, typing works.
- It may **not** call APIs, read or change stores, read the router, or use data hooks. It never touches the network.
- **One page only:** to "go" somewhere, it calls the helper's `goTo('/editor/abc')`, which shows a small note
  ("Would open /editor/abc") instead of leaving. Links in designs do the same inside a preview.
- For a child that only shapes what its parent passes (like ProjectCard), it is short: the same shaping as the
  dynamic part, without any hooks.

```tsx
/** The prototype: the projects in memory; New adds one, Delete removes one, Open shows where it would go. */
export default function ProjectListStatic({ projects: start }: ProjectListStart) {
  const [projects, setProjects] = useState(start)
  const [isModalOpen, setModalOpen] = useState(false)
  return (
    <ProjectListSwitcher
      projects={projects}
      isEmpty={projects.length === 0}
      isModalOpen={isModalOpen}
      onNew={() => setModalOpen(true)}
      onCreate={(input) => { setProjects([{ id: crypto.randomUUID(), ...input, updatedAt: Date.now() }, ...projects]); setModalOpen(false) }}
      onDelete={(id) => setProjects(projects.filter((p) => p.id !== id))}
      onOpen={(id) => goTo(`/editor/${id}`)}
      onCloseModal={() => setModalOpen(false)}
    />
  )
}
```

### `Name.mock.ts` (the starting data)

- `export const states: Record<string, NameStart>`, with a `default` state. Name each state after a case worth
  seeing: `empty`, `many`, `long name`, `no description`…
- Committed to git, like the rest of the code.
- Every design is shown with every state. Each tile is its own prototype: what you change in one tile doesn't
  change another, and **Reset** puts it back to its starting data.

### `Name.switcher.tsx`

- It imports the design in use the normal way, on **one line**. "Use this design" changes that line.
- It lists every design as `import()` inside `import.meta.env.DEV ? … : undefined`, so the others never reach
  users.

### `Name.variant.tsx`, `Name.<name>.variant.tsx` (a design)

- It exports `variant = { id, name }`, where the id is unique within the component, and a default component taking
  `NameView`.
- **Looks only.** It may keep its own UI state (a menu open, hover) and use plain UI pieces and other components.
  Those show their own design in use, with the data this design passes them.
- It may **not** call APIs, read or change stores, or use data hooks.

---

## Situations (new): Button, Toast…

Most components have **one design in use**. Some need several at once, picked by the parent: a Button can be
`primary`, `secondary` or `danger`, and a Toast can be `success`, `error` or `info`. These are **situations**.

- `Name.types.ts` declares them, as the prop the parent sets:
  `export type ButtonSituation = 'primary' | 'secondary' | 'danger'` (and `kind: ButtonSituation` in `ButtonProps`).
- **Each situation has its own design in use.** The switcher has **one line per situation**. One design can serve
  several situations:

```tsx
// The design in use for each situation: change a line to use another.
export default makeSwitcher<ButtonView, ButtonSituation>({
  situation: 'kind',
  inUse: {
    primary: Rounded,
    secondary: Rounded,
    danger: Sharp,
  },
  every: import.meta.env.DEV ? () => [import('./Button.variant'), import('./Button.sharp.variant')] : undefined,
})
```

- A design may say which situations it's made for: `variant = { id: 'sharp', name: 'Sharp', for: ['danger'] }`.
  Without `for`, it can serve any of them.
- Each state shows one situation (its value for that prop: `kind: 'danger'`), so states are usually named after
  them (`primary`, `danger`, `danger disabled`); with situations, a `default` state isn't needed.
- The Playground groups its rows by situation; a design not made for a row's situation says so in its tile. Preview
  shows the situation of the state you pick. "Use this design" works for the situation of the tile you chose, and
  changes only that line (importing the design if needed, and dropping the import of a design no situation uses any
  more, so it doesn't ship).

---

## Pages

A page has the same shape. Usually it has no props, and its starting data is what it shows: the projects, the
settings…

- In Preview, the whole page is a prototype at a screen size (Phone, Tablet, Laptop, Desktop). Clicks, modals and
  forms work. **One page only:** going to another page shows a note.
- Its children get the page's data (see "Children get their parent's data" above).
- If its designs use links or a theme, `src/visual-editor.providers.tsx` wraps the preview (a router in memory, the
  theme).

---

## What Visual Editor checks

Each problem shows on the card, in words, with what to do:

- **Missing pieces:** chooser, types, dynamic part, static part, starting data, switcher, at least one design.
- **Each design:** has a unique id, takes `NameView`, and uses no data.
- **The static part:** no API, store, router or data hooks; navigation through `goTo` only.
- **The starting data:** has a `default` state (not needed with situations), and each state has everything `NameStart`
  needs.
- **Situations:** every situation has a design in use, made for it, and at least one state that shows it.
- **What ships to users:** the static part, the starting data and the designs that aren't in use are loaded only in
  development.
- **The switcher:** imports a design in use the normal way (for every situation, if there are situations), and lists
  every design for development.

---

## In production

Only the chooser, the dynamic part, the switcher and the designs in use are built into the app. The static part, the
starting data and the other designs are left out.

---

## Who writes these files

You, or Claude when you ask:

- "Make it previewable" splits an existing component or page into this shape.
- "New variant" adds a design.
- "New component" and "New page" build both parts from the start.

Claude's work always arrives as a **proposal in Review**, checked first. Nothing changes until you approve it.
