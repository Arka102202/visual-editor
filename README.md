# Visual Editor

See your project as maps, review every change before it happens, and keep a memory of why. Visual Editor is a small
**shell** for VS Code that grows through **plugins**: one per technology (React, Node.js, Express, SQL, MongoDB…).

## In this repository

| Folder | What it is |
|---|---|
| `packages/contract` | The plugin contract: what plugins give the shell, and what the shell gives back |
| `packages/shell` | The Visual Editor shell (a VS Code extension) |
| `plugins/hello` | The smallest plugin: adds one card. An example for writing real plugins |
| `scripts/build.mjs` | Builds every extension, and the tests |

## Try it

1. `npm install` (once)
2. Open this folder in VS Code, open **Run and Debug**, pick **Visual Editor + Hello plugin**, press **F5**.
3. In the new window, the status bar shows **Visual Editor · 1 plugin**, and the Visual Editor side panel lists it.
   Its **Projects** list shows each project found (one, several side by side, or a monorepo's packages), the plugins
   that suit it, and how many cards they found. Add or edit a file and the count follows.
4. Click **Visual Editor** in the status bar (or the map button on the Projects list) to open the **map**: the shown
   project's cards and lines. Drag to move, pinch or Ctrl+scroll to zoom, **Fit** to see everything, double-click a
   card to open its code. With several projects, pick one at the top of the map or click it in the Projects list.
5. Run **Visual Editor: Try Review with an Example Proposal**. A proposal waits in the **Review** tab: why, and what
   changes in each file. The status bar turns yellow, and the cards it touches are marked yellow on the map.
   **Approve and apply** changes the files (all or none), **Undo** puts them back, **Send back** and **Reject** keep a
   note. Edit a file by hand and its cards turn blue: changed outside review.

6. The **Memory** list in the side panel keeps the project's **rules**, **decisions** and **recent changes** (every
   approved, sent back, rejected or undone proposal, with its reason and your note). Click a card on the map to see
   its notes and history, and **Add a note**.

7. Click **Connect Claude Code** in the status bar. Start a new Claude Code session in the folder and ask in words
   ("give me an overview of this project", "add a subtitle to the card"). It reads the map, rules and memory through
   the **assistant hub**, and every change it wants arrives in Review as a proposal.

Proposals are files in the project's `.visual-editor/proposals/` folder, so assistants, agents and plugins all
propose the same way, and nothing changes the code without review. Memory lives in `.visual-editor/memory/entries/`,
one small file per entry, so it can go into git and the team shares it. The hub runs on this computer only, behind a
secret key kept in VS Code and in your own Claude Code settings (never in the project).

`npm run test:vscode` starts VS Code with the shell and Hello on a throwaway project and walks through all of this
(`SHOTS=<folder>` takes screenshots; `CLAUDE=1` also lets real Claude Code propose a change).

## Work on it

- `npm run build`: build everything
- `npm run typecheck`: check the types
- `npm test`: run the tests

## Branches

`main` holds finished, tested steps (tagged). The shell and the contract live on `shell`; each plugin on its own branch
(`plugin/react`, `plugin/node`, `plugin/express`, `plugin/sql`, `plugin/mongodb`). When the contract changes on
`shell`, merge it into every plugin branch first.
