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

## Work on it

- `npm run build`: build everything
- `npm run typecheck`: check the types
- `npm test`: run the tests

## Branches

`main` holds finished, tested steps (tagged). The shell and the contract live on `shell`; each plugin on its own branch
(`plugin/react`, `plugin/node`, `plugin/express`, `plugin/sql`, `plugin/mongodb`). When the contract changes on
`shell`, merge it into every plugin branch first.
