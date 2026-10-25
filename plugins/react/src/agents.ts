// The React plugin's agents (each a worker and a checker; Visual Editor runs them as jobs and adds what every worker and
// checker must do). Their tools are the plugin's and the hub's, by name.

import type { PluginAgent } from '@visual-editor/contract';

const LOOK = ['variant_brief', 'check_variant_files', 'draft_pictures', 'card', 'Read', 'Grep', 'Glob'];

/** A new design for a previewable component or page, from the developer's words. */
export const newVariantAgent: PluginAgent = {
  name: 'new-variant',
  title: 'New variant',
  summary: 'Makes a new design for a component from your words, for example “a one-line row with the colour as a dot”. The design you use now stays the same until you choose the new one.',
  description:
    'Makes a new design for a component or page that can be previewed, from the developer\'s words (for example "a one-line row with the colour as a dot"): a new design file, shown in the Playground; the design in use stays as it is. Use when the developer asks for a new look, layout or style of an existing component.',
  rounds: 3,
  worker: {
    tools: LOOK,
    prompt: `Make a new design for the component (or page) the developer names, from their words.

1. Call variant_brief for the component. If it isn't previewable yet, don't hand anything in: say so in your answer (it
   has to be made previewable first).
2. Follow the variant rules (the visual-editor:variant-rules skill): a new file \`Name.<id>.variant.tsx\` next to the
   other designs, with \`export const variant = { id: '<id>', name: '<Name>' }\`, taking \`NameView\` and showing looks
   only (no data: no hooks that load anything, no API calls, no stores). Read the other designs first and use the same
   styles, classes and colours the project uses.
3. Add it to the switcher's list for Preview (its import() list), without changing the design in use. With situations,
   give it \`for: [...]\` only if the developer asked for it in particular situations.
4. Save it as a draft. Run check_variant_files with the draft and fix what it finds. Take draft_pictures for the
   component and look at the picture (open it with Read): the new design must show what was asked, in every state.
5. Hand it in.`,
  },
  checker: {
    tools: LOOK,
    prompt: `Prove the new design is what the developer asked for and follows the rules, or send it back.

1. Read the draft, and call variant_brief for the component with the draft.
2. Run check_variant_files with the draft (card: the component). It must say PASSED.
3. Take draft_pictures for the component with the draft and look at the picture (open it with Read). Compare the new
   design with the request in every state: what was asked for is there; nothing was added that wasn't asked for; long
   text doesn't break it; it sits well next to the other designs.
4. Check the design in use didn't change, and that the draft changes only the new design file and the switcher's list.

When anything is off, send it back with specific reasons the worker can act on, e.g. "in the 'long name' state the name
wraps onto two lines: keep it on one line and end it with an ellipsis".`,
  },
};

const PROVE = [...LOOK, 'check_types', 'compare_app'];

/** An existing component or page split into its two parts (docs/variants.md), looking and working exactly as before. */
export const makePreviewableAgent: PluginAgent = {
  name: 'make-previewable',
  title: 'Make previewable',
  summary:
    'Rebuilds an existing component or page in the previewable shape: its look kept apart from its data, so you can see it in Preview and the Playground and give it new designs. Your app looks and works exactly as before.',
  description:
    'Turns an existing component or page that is not previewable yet into its variant folder (docs/variants.md): today\'s look as the first design, the real data in the dynamic part, a working prototype with data in memory as the static part, starting data, and the chooser that the rest of the app imports. The app must look and work exactly as before. Use when the developer wants a component or page in Preview or the Playground, or wants new designs for one that isn\'t previewable yet.',
  rounds: 3,
  worker: {
    tools: PROVE,
    prompt: `Rebuild the component (or page) the developer names in the previewable shape, without changing how the app looks
or works.

1. Call variant_brief for it: it says what it is given, who uses it, the data it uses, where it is seen in the app, and
   the folder it becomes. Read its files in full (and the hooks it calls), and the rules (the
   visual-editor:variant-rules skill). If it is previewable already, say so and hand nothing in.
2. Make the folder, in one draft:
   - \`Name.types.ts\`: NameProps (what it is given today, unchanged), NameView (everything the look needs: values and
     callbacks), NameStart (what the static part starts from: usually NameProps).
   - \`Name.variant.tsx\` (id "default"): today's markup, moved as it is (the same elements, classes and text), taking
     NameView. Looks only: no hooks that load or store anything.
   - \`Name.data.tsx\`: today's data and behaviour (hooks, stores, database, API, side effects such as setting the page's
     theme), unchanged, giving the switcher the NameView.
   - \`Name.static.tsx\`: a working prototype: the same clicks and changes, with its data kept in memory (React state)
     starting from NameStart; no network, no stores, no database, no changes outside itself.
   - \`Name.mock.ts\`: starting data as named states: "default" first, then the ones that show its other looks (empty,
     long text, on/off…).
   - \`Name.switcher.tsx\`: Default in use, and the list for Preview.
   - \`index.tsx\`: the chooser, exporting exactly what the old entry exported (default and named exports, and types), so
     nothing that imports it changes. If the folder already has an index.ts, it becomes this index.tsx (remove the old
     one in the draft). If the old file is replaced, remove it in the draft, and update anything that imported it by its
     own path.
3. Check it yourself with the draft: check_variant_files (card: the component) and check_types must say PASSED;
   draft_pictures must draw every state; compare_app on a page where it is seen must say the page looks the same. Fix
   what they find and check again.
4. Hand it in.`,
  },
  checker: {
    tools: PROVE,
    prompt: `Prove the component was rebuilt in the previewable shape without changing how the app looks or works, or send it
back.

1. Read the draft, and call variant_brief for the component with the draft: the folder must be complete.
2. check_variant_files with the draft (card: the component) must say PASSED, and check_types with the draft must say
   PASSED (no new TypeScript problems).
3. compare_app with the draft on the page(s) where the brief says it is seen: the app must look the same (PASSED). If it
   is seen nowhere, say so.
4. draft_pictures for the component with the draft: every state draws, without errors. Look at the picture (open it
   with Read): the default state must look like the component does in the app today.
5. Read the old file(s) and the new ones side by side: the design's markup must be today's (same elements, classes and
   text); the dynamic part must keep every bit of today's data and behaviour (each hook, store, database call and side
   effect); the static part must not use the network, stores or the database; everything that imported the component
   must still find it.

When anything is off, send it back with specific reasons the worker can act on (which file, what is wrong, what to do).`,
  },
};
