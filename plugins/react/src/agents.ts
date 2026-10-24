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
