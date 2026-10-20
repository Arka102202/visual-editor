# Visual Editor: rules for working on this repository

## UI rules (every page, panel, modal and toolbar the extension draws)

1. **Every button is icon-only**, and its name shows on hover. Make buttons with `iconButton()` / `setIcon()` from
   `packages/shell/src/ui/buttons.ts` (add new icons to `ICONS` there) and call `installTips()` once per page.
   A count next to the icon is fine (for example, how many proposals are waiting).
2. **Buttons never wrap** and never take two lines.
3. **A row of several buttons never wraps either**: make it a `tray()`, which scrolls sideways when the buttons
   don't fit (the mouse wheel scrolls it too).
4. **No scrollbar is ever shown**, anywhere. Scrolling still works; `ui/dom.ts` hides them for every page.

`packages/shell/test/ui.test.ts` checks these rules; keep it passing.
