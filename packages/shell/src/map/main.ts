// The map page inside the editor tab: the cards and lines the shell laid out, drawn by a MapView (smooth with tens of
// thousands of cards; see mapView.ts), with a bar, a drawer for the chosen card, a legend, and Focus (one card with
// only its immediate neighbours, in a map of its own). Plain DOM, no framework.

import type { Layout, PlacedCard, Section } from '../layout';
import { MapView, type Look } from './mapView';
import { MAX_FIELDS } from '../layout';
import type { CardLines, CardMemory, FromMap, ShowMap, ToMap } from '../mapMessages';
import type { Item, Story, StoryStep } from '@visual-editor/contract';
import type { MemoryEntry } from '../memory';
import { addStyles, ago, el } from '../ui/dom';
import { iconButton, installTips, mapIcon, setIcon, tray, type Icon } from '../ui/buttons';
import { TYPE_CSS, typeText, useThemeTokens } from '../ui/typeText';
import { WINDOW_CSS } from '../ui/windows';
import { Frame, FRAME_CSS, type Layout as PanelLayout, type LayoutStore } from '../ui/frame';
import { WEBVIEW_CSS, Webview } from './webview';
import { PLAYGROUND_CSS, Playground } from './playground';
import { PREVIEW_CSS, PreviewWindow } from './previewWindow';
import { CONSOLE_CSS } from './consolePanel';
import { CSS_PANEL_CSS } from './cssPanel';
import { NETWORK_CSS } from './networkPanel';
import { PLUGIN_PANELS_CSS } from './pluginPanels';
import type { Tone } from '../styles';

declare function acquireVsCodeApi(): { postMessage(message: FromMap): void };
const vscode = acquireVsCodeApi();

addStyles(`
  /* One line always: when the space is too small the bar scrolls sideways; nothing in it wraps or changes shape. */
  .bar { position: absolute; inset: 0 0 auto 0; height: 40px; display: flex; align-items: center; gap: 8px; padding: 0 12px; border-bottom: 1px solid var(--vscode-panel-border, #8883); background: var(--vscode-editor-background); z-index: 2; overflow-x: auto; overflow-y: hidden; white-space: nowrap; scrollbar-width: thin; }
  .bar > * { flex: none; }
  .bar select, .bar button { font: inherit; color: var(--vscode-dropdown-foreground); background: var(--vscode-dropdown-background); border: 1px solid var(--vscode-dropdown-border, #8884); border-radius: 4px; padding: 3px 8px; }
  .bar button { cursor: pointer; color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground); border-color: transparent; }
  .bar .name { font-weight: 600; }
  .bar .chips { display: flex; gap: 4px; }
  .bar > .tabs { display: flex; gap: 2px; flex: 1 0 auto; margin-left: 8px; }
  .tabs button { background: transparent; color: var(--vscode-foreground); opacity: .7; padding: 3px 10px; border-radius: 4px; white-space: nowrap; }
  .tabs button.on { opacity: 1; background: var(--vscode-toolbar-activeBackground, #8883); font-weight: 600; }
  .tabs button .count { opacity: .6; font-weight: normal; }
  .bar input.find { width: 150px; color: var(--vscode-input-foreground); background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, #8884); border-radius: 4px; padding: 3px 8px; font: inherit; }
  /* A card chosen: the cards it has no line to step back. */
  .world.picked .card { opacity: .25; }
  .world.picked .card.near { opacity: 1; }
  .zoom { font-size: 11px; opacity: .7; min-width: 36px; text-align: right; }
  .stage { position: absolute; inset: 40px 0 0 0; }
  /* What the project still needs that an agent can do: a note under the bar, with its agent's button. */
  .nudges { position: absolute; top: 52px; left: 50%; transform: translateX(-50%); z-index: 3; display: flex; flex-direction: column; gap: 6px; width: min(640px, calc(100% - 32px)); }
  .nudge { display: flex; align-items: center; gap: 10px; padding: 8px 10px 8px 14px; border-radius: 8px; font-size: 12px; line-height: 1.4; background: var(--vscode-editorWidget-background, var(--vscode-editor-background)); border: 1px solid var(--vscode-focusBorder, #8886); box-shadow: 0 2px 8px #0003; }
  .nudge .words { flex: 1; min-width: 0; }
  .nudge .tray { display: flex; gap: 4px; flex: none; }
  .nudge button { font: inherit; cursor: pointer; border-radius: 4px; padding: 3px 8px; border: 1px solid transparent; color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground); }
  .nudge button.go { color: var(--vscode-button-foreground); background: var(--vscode-button-background); }
  .mv { overflow: hidden; cursor: grab; touch-action: none; }
  .mv.dragging { cursor: grabbing; }
  .world { position: absolute; left: 0; top: 0; transform-origin: 0 0; }
  .sky { position: absolute; inset: 0; width: 100%; height: 100%; pointer-events: none; }
  /* Folder names float above the map at reading size, pinned to their box (they don't scale with it). */
  .labels { position: absolute; inset: 0; pointer-events: none; overflow: hidden; }
  .labels .tag { position: absolute; font-size: 12px; font-weight: 700; padding: 2px 8px; border-radius: 6px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; background: color-mix(in srgb, var(--vscode-editor-background) 85%, transparent); transform: translateY(-50%); }
  .card .strip { position: absolute; left: 0; top: 0; bottom: 0; width: 5px; }
  .card .head, .card .field { padding-left: 16px !important; }
  .card .used { font-size: 10px; padding: 0 6px; border-radius: 6px; background: color-mix(in srgb, var(--vscode-foreground) 12%, transparent); white-space: nowrap; }
  .card.busy .label { font-weight: 700; }
  .card.lonely { opacity: .55; }
  .legend { position: absolute; left: 12px; bottom: 12px; z-index: 2; display: flex; flex-wrap: wrap; gap: 6px 14px; max-width: 60%; padding: 8px 12px; border-radius: 8px; font-size: 11px; background: color-mix(in srgb, var(--vscode-editor-background) 88%, transparent); border: 1px solid var(--vscode-panel-border, #8883); }
  .legend .k { display: inline-flex; align-items: center; gap: 5px; white-space: nowrap; }
  .legend .dot { width: 10px; height: 10px; border-radius: 3px; }
  .legend .ln { width: 18px; height: 3px; border-radius: 2px; }
  .legend .n { opacity: .6; }
  .legend .k, .card .kind { cursor: help; }
  .tip { position: fixed; z-index: 10; max-width: 280px; padding: 8px 11px; border-radius: 8px; font-size: 12px; line-height: 1.45; pointer-events: none; background: var(--vscode-editorHoverWidget-background, #252526); color: var(--vscode-editorHoverWidget-foreground, inherit); border: 1px solid var(--vscode-editorHoverWidget-border, #8885); box-shadow: 0 4px 14px #0006; }
  .tip .tt { display: flex; align-items: center; gap: 6px; font-weight: 700; margin-bottom: 3px; }
  .tip .sw { width: 10px; height: 10px; border-radius: 3px; flex: none; }
  .tip .sw.line { height: 3px; width: 16px; border-radius: 2px; }
  .tip .ct { opacity: .65; margin-top: 4px; }
  .arrange { display: flex; border-radius: 5px; overflow: hidden; flex: none; }
  .bar .arrange button { border-radius: 0; padding: 3px 9px; }
  .bar .arrange button.on { color: var(--vscode-button-foreground); background: var(--vscode-button-background); }
  .card { position: absolute; box-sizing: border-box; border-radius: 8px; background: var(--vscode-editorWidget-background, #2a2a2a); border: 1px solid var(--vscode-editorWidget-border, #8884); box-shadow: 0 1px 3px #0003; cursor: default; overflow: hidden; }
  .card.proposed { border: 2px solid #d9a400; }
  .card.changed { border: 2px solid #2f6fdb; }
  .card .mark { font-size: 10px; font-weight: 600; padding: 0 6px; border-radius: 6px; }
  .card.proposed .mark { background: #d9a400; color: #1e1e1e; }
  .card.changed .mark { background: #2f6fdb; color: #fff; }
  .bar .chip.proposed, .bar .chip.changed, .bar .chip.to-run, .bar .chip.held-back { cursor: pointer; border: 0; font: inherit; font-size: 11px; padding: 0 8px; height: 22px; }
  /* Test cases waiting for you (purple, like the test cases' window), held back by a check (red). */
  .bar .chip.to-run { background: #8a63d2; color: #fff; }
  .bar .chip.held-back { background: #c74e39; color: #fff; }
  .drawer { position: absolute; top: 40px; right: 0; bottom: 0; width: 300px; box-sizing: border-box; padding: 16px; overflow-y: auto; background: var(--vscode-sideBar-background, var(--vscode-editor-background)); border-left: 1px solid var(--vscode-panel-border, #8883); z-index: 3; }
  .drawer h2 { font-size: 15px; margin: 0 24px 2px 0; word-break: break-word; }
  .drawer .card-nudge { display: flex; align-items: flex-start; gap: 8px; margin: 10px 0 4px; padding: 8px 10px; border-radius: 4px; font-size: 12px; line-height: 1.45; background: color-mix(in srgb, var(--vscode-charts-purple, #b180d7) 10%, transparent); border-left: 2px solid var(--vscode-charts-purple, #b180d7); }
  .drawer .card-nudge span { flex: 1; }
  .drawer .summary .text { font-size: 13px; line-height: 1.5; }
  .drawer .story { margin: 4px 0; border-radius: 4px; }
  .drawer .story-head { display: flex; gap: 6px; align-items: baseline; padding: 4px 6px; border-radius: 4px; cursor: pointer; font-size: 12px; }
  .drawer .story-head:hover { background: var(--vscode-list-hoverBackground); }
  .drawer .story.open .story-head { font-weight: 600; }
  .drawer .story-arrow { opacity: .6; width: 10px; flex: none; }
  .drawer .story-tools { display: flex; gap: 4px; margin: 2px 0 2px 22px; }
  .drawer .story-steps { list-style: none; margin: 2px 0 8px 16px; padding: 0; font-size: 12px; line-height: 1.45; border-left: 1px solid var(--vscode-panel-border, #8884); }
  .drawer .story-steps .step { display: flex; gap: 6px; align-items: baseline; padding: 2px 6px; cursor: pointer; border-radius: 3px; }
  .drawer .story-steps .step:hover { background: var(--vscode-list-hoverBackground); }
  .drawer .story-steps .step .text { flex: 1; min-width: 0; }
  .drawer .story-steps .step button { flex: none; padding: 0 3px; }
  .drawer .story-steps .mark { width: 14px; flex: none; text-align: center; font-weight: 700; opacity: .85; }
  .drawer .step.action .mark { color: var(--vscode-charts-blue, #3794ff); }
  .drawer .step.ask .mark, .drawer .step.message .mark { color: var(--vscode-charts-yellow, #cca700); }
  .drawer .step.state .mark, .drawer .step.store .mark { color: var(--vscode-charts-purple, #b180d7); }
  .drawer .step.data .mark { color: var(--vscode-charts-green, #89d185); }
  .drawer .step.api .mark, .drawer .step.navigate .mark { color: var(--vscode-charts-orange, #d18616); }
  .drawer .step.prop .text { font-style: italic; opacity: .8; }
  .drawer .summary .metaline { display: flex; align-items: center; gap: 8px; margin-top: 4px; }
  .drawer .summary .meta, .drawer .summary .hint { flex: 1; font-size: 11px; opacity: .65; }
  .drawer .summary .meta.stale { color: var(--vscode-editorWarning-foreground, #cca700); opacity: 1; }
  .drawer .card-nudge button { flex: none; }
  .drawer .close { position: absolute; top: 10px; right: 10px; }
  .drawer .sub { font-size: 12px; opacity: .7; margin-bottom: 12px; word-break: break-all; }
  .drawer .buttons { margin-bottom: 14px; }
  .drawer h3 { font-size: 11px; font-weight: 600; letter-spacing: .05em; text-transform: uppercase; opacity: .6; margin: 16px 0 6px; }
  .drawer .entry { padding: 7px 9px; border-radius: 6px; background: var(--vscode-editorWidget-background, #8881); margin-bottom: 6px; font-size: 12px; }
  .drawer .entry.link { cursor: pointer; }
  .drawer .entry.link:hover { outline: 1px solid var(--vscode-focusBorder, #39f); }
  .drawer .entry .t { font-weight: 600; font-size: 13px; }
  .drawer .entry.in-use { box-shadow: inset 3px 0 0 var(--tok-function, #b180d7); }
  .drawer .states { font-size: 12px; line-height: 1.6; }
  .drawer .entry.problem { line-height: 1.45; box-shadow: inset 3px 0 0 var(--vscode-editorWarning-foreground, #cca700); }
  .drawer .entry .d { opacity: .85; margin-top: 2px; }
  .drawer .entry .m { opacity: .6; margin-top: 3px; font-size: 11px; }
  .drawer .none { font-size: 12px; opacity: .6; }
  .card.selected { border-color: var(--vscode-foreground); box-shadow: 0 0 0 2px var(--vscode-foreground); }
  .card .head { padding: 8px 12px 6px; border-bottom: 1px solid #8882; height: 56px; box-sizing: border-box; }
  .card .top { display: flex; align-items: center; gap: 6px; }
  .card .label { font-weight: 600; flex: 1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .card .kind { font-size: 10px; text-transform: uppercase; letter-spacing: .05em; opacity: .6; }
  .card .sub { font-size: 11px; opacity: .65; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .card .fields { padding: 4px 0; }
  .card .field { display: flex; gap: 6px; height: 22px; align-items: center; padding: 0 12px; font-size: 12px; }
  .card .field .n { flex: 1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .card .field .v { opacity: .65; font-family: var(--vscode-editor-font-family, monospace); font-size: 11px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 50%; }
  .card .field.previewable { color: var(--tok-function, #b180d7); border-top: 1px dashed color-mix(in srgb, currentColor 30%, transparent); }
  .card .field.previewable.problems .v { color: var(--vscode-editorWarning-foreground, #cca700); opacity: 1; }
  .card .field .t { font-size: 10px; padding: 0 5px; border-radius: 6px; background: #8883; }
  .card .more { opacity: .6; font-style: italic; }
  .map-empty { position: absolute; inset: 40px 0 0 0; display: flex; flex-direction: column; align-items: center; justify-content: center; text-align: center; padding: 24px; gap: 6px; }
  .map-empty h2 { margin: 0; font-size: 16px; font-weight: 600; }
  .map-empty p { margin: 0; opacity: .7; max-width: 420px; }
  /* Focus: one card's immediate neighbours, in a modal over the map. */
  /* Focus: one card's immediate neighbours, in a window over the map. */
  .nb-stage { position: absolute; inset: 0; }
  .nb-list { padding: 0 10px 10px; }
  .nb-list h3 { font-size: 11px; font-weight: 700; letter-spacing: .05em; text-transform: uppercase; color: var(--tint, inherit); margin: 0; padding: 10px 2px 6px; }
  .nb-list .none { font-size: 12px; opacity: .6; padding: 4px 2px; }
  .nb-row { position: relative; display: flex; gap: 8px; align-items: center; padding: 7px 8px 7px 13px; border-radius: 6px; margin-bottom: 4px; background: var(--vscode-editorWidget-background, #8881); font-size: 12px; overflow: hidden; }
  .nb-row.go { cursor: pointer; }
  .nb-row.go:hover { outline: 1px solid var(--vscode-focusBorder, #39f); }
  .nb-row .strip { position: absolute; left: 0; top: 0; bottom: 0; width: 4px; background: #8885; }
  .nb-row .what { flex: 1; min-width: 0; }
  .nb-row .t { display: flex; gap: 6px; align-items: baseline; }
  .nb-row .l { font-weight: 600; font-size: 13px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .nb-row .k { font-size: 10px; text-transform: uppercase; letter-spacing: .05em; opacity: .6; white-space: nowrap; }
  .nb-row .via { color: var(--line, inherit); margin-top: 2px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .nb-row .s { opacity: .55; font-size: 11px; margin-top: 1px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .nb-row .v { font-family: var(--vscode-editor-font-family, monospace); font-size: 11px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 55%; }
  .nb-row .tag { font-size: 10px; padding: 0 5px; border-radius: 6px; background: #8883; white-space: nowrap; }
  /* Props: callbacks in the theme's function colour, other props in its field colour; tags tinted to match. */
  .nb-row.prop { --prop: var(--tok-property, var(--vscode-symbolIcon-fieldForeground, #75beff)); }
  .nb-row.prop.callback { --prop: var(--tok-function, var(--vscode-symbolIcon-functionForeground, #b180d7)); }
  .nb-row.prop .strip { background: var(--prop); }
  .nb-row.prop .l { color: var(--prop); }
  .nb-row .tag { --t: var(--vscode-foreground); color: var(--t); background: color-mix(in srgb, var(--t) 18%, transparent); }
  /* Variants: designs in use marked in the tab's colour; states indented under their situation. */
  .nb-row.design.inuse .strip { background: var(--tint, #cca700); }
  .nb-row.design.inuse .tag { --t: var(--tint, #cca700); }
  .nb-list h4 { font-size: 10px; font-weight: 700; letter-spacing: .05em; text-transform: uppercase; opacity: .6; margin: 10px 2px 4px; }
  .nb-row .tag.callback { --t: var(--tok-function, var(--vscode-symbolIcon-functionForeground, #b180d7)); }
  .nb-row .tag.optional { --t: var(--tok-keyword, var(--vscode-charts-yellow, #cca700)); }
  .nb-row .tag.layout { --t: var(--tok-type, var(--vscode-charts-green, #89d185)); }
  .nb-row .acts { flex: none; max-width: 40%; }
  /* A prop whose value was cut short folds open to show all of it. */
  .nb-row.prop { display: block; }
  .nb-row.prop .line { display: flex; gap: 8px; align-items: center; min-width: 0; }
  .nb-row.prop .l { max-width: 45%; }
  .nb-row.prop .chev, .nb-row.prop .full { display: none; }
  .nb-row.prop.folds { cursor: pointer; }
  .nb-row.prop.folds:hover { outline: 1px solid var(--vscode-focusBorder, #39f); }
  .nb-row.prop.folds .chev { display: block; flex: none; width: 6px; height: 6px; border-right: 1.5px solid currentColor; border-bottom: 1.5px solid currentColor; transform: rotate(-45deg); opacity: .6; margin: 0 2px; transition: transform .15s; }
  .nb-row.prop.open .chev { transform: rotate(45deg); }
  .nb-row.prop.open .v { display: none; }
  .nb-row.prop.open .full { display: block; margin-top: 6px; padding: 6px 8px; border-radius: 4px; background: color-mix(in srgb, var(--vscode-foreground) 7%, transparent); font-family: var(--vscode-editor-font-family, monospace); font-size: 11px; white-space: pre-wrap; word-break: break-word; cursor: text; user-select: text; }
${TYPE_CSS}
${WINDOW_CSS}
${FRAME_CSS}
${WEBVIEW_CSS}
${PLAYGROUND_CSS}
${PREVIEW_CSS}
${CONSOLE_CSS}
${CSS_PANEL_CSS}
${NETWORK_CSS}
${PLUGIN_PANELS_CSS}
`);

// The page: a bar on top, the stage below, and a message for when there's nothing to draw.
const bar = el('div', 'bar');
const picker = el('select');
picker.title = 'Choose the project to show';
const projectName = el('span', 'name');
const chips = el('div', 'chips');
const zoomText = el('span', 'zoom');
const fitButton = iconButton('fitMap', 'Fit: show the whole map');
const proposedBadge = iconButton('proposed', 'Changes waiting for your OK: open Review', { cls: 'chip proposed' });
// Changes whose test cases wait for you to run them, and changes held back by a check: each opens Review at the first.
const toRunBadge = iconButton('preview', 'Test cases waiting for you to run: open Review', { cls: 'chip to-run' });
const heldBadge = iconButton('levelWarn', 'Held back by a check: open Review', { cls: 'chip held-back' });
let firstToRun: string | undefined;
let firstHeld: string | undefined;
const changedBadge = iconButton('changed', 'Changed outside review: click to clear the marks', { cls: 'chip changed' });
const tabs = el('div', 'tabs');
const find = el('input', 'find');
find.placeholder = 'Find a card…';
find.title = 'Type part of a name; Enter goes to the next match';
const arrangeGroup = el('div', 'arrange');
/** How each arrangement places the cards, and when it helps (shown on hover). */
const ARRANGE_HELP = {
  flow: 'Cards in columns that follow their lines, left to right: a component on the left, what it draws to its right, and so on. Best for following how one part leads to the next. Cards with no lines sit in a grid below.',
  folders: 'Cards grouped by the folder their file is in, one tinted box per folder (like "Editor › InspectorPanel"). Best for seeing the parts of the app at a glance. Lines still join the cards across boxes.',
} as const;
const arrangeButtons: [HTMLButtonElement, keyof typeof ARRANGE_HELP][] = [];
for (const [mode, words] of [['flow', 'Flow'], ['folders', 'Folders']] as const) {
  const b = iconButton(mode, words);
  // Its own popup says its name and what it does.
  delete b.dataset.tip;
  b.dataset.mode = mode;
  b.addEventListener('click', () => vscode.postMessage({ type: 'arrange', arrange: mode }));
  arrangeGroup.append(b);
  arrangeButtons.push([b, mode]);
}
const webviewButton = iconButton('preview', 'Webview: your running app, to try whole pages without a browser (Console, CSS, Network, App)');
webviewButton.addEventListener('click', () => webview.open());
const windowButton = iconButton('popOut', 'Pop out: the map in its own window');
windowButton.addEventListener('click', () => vscode.postMessage({ type: 'window' }));
bar.append(picker, projectName, chips, tabs, find, arrangeGroup, proposedBadge, toRunBadge, heldBadge, changedBadge, webviewButton, zoomText, fitButton, windowButton);
// One line always: when there's no room, the bar scrolls sideways (no scrollbar). Every button names itself on hover.
tray(bar);
installTips();
const legend = el('div', 'legend');
const tip = el('div', 'tip');
tip.hidden = true;
let meanings: ShowMap['meanings'] = { cards: {}, lines: {} };

/** A small popup above (or below) an element: what a colour means, in plain words. */
function hint(target: HTMLElement, what: { name: string; text: string; colour?: string; line?: boolean; count?: string }) {
  target.addEventListener('mouseenter', () => {
    tip.replaceChildren();
    const head = el('div', 'tt');
    if (what.colour) {
      const sw = el('span', what.line ? 'sw line' : 'sw');
      sw.style.background = what.colour;
      head.append(sw);
    }
    head.append(el('span', undefined, what.name));
    tip.append(head, el('div', undefined, what.text));
    if (what.count) tip.append(el('div', 'ct', what.count));
    tip.hidden = false;
    const r = target.getBoundingClientRect();
    const t = tip.getBoundingClientRect();
    const left = Math.min(Math.max(8, r.left + r.width / 2 - t.width / 2), window.innerWidth - t.width - 8);
    const above = r.top - t.height - 8;
    Object.assign(tip.style, { left: `${left}px`, top: `${above > 8 ? above : r.bottom + 8}px` });
  });
  target.addEventListener('mouseleave', () => (tip.hidden = true));
}

for (const [b, mode] of arrangeButtons) hint(b, { name: mode === 'flow' ? 'Flow' : 'Folders', text: ARRANGE_HELP[mode], count: 'Click to arrange the map this way' });

const cardMeaning = (kind: string) => meanings.cards[kind] ?? `Cards the plugin calls “${kind}”.`;
const lineMeaning = (kind: string) => meanings.lines[kind] ?? `Lines the plugin calls “${kind}”.`;
const stage = el('div', 'stage');
const empty = el('div', 'map-empty');
const emptyTitle = el('h2');
const emptyDetail = el('p');
empty.append(emptyTitle, emptyDetail);
const drawer = el('div', 'drawer');
drawer.hidden = true;
const nudges = el('div', 'nudges');
document.body.append(bar, stage, empty, nudges, drawer, legend, tip);

/** The plugins' nudges: what the project still needs, with the agent that does it (or close it for this project). */
function drawNudges(list: NonNullable<ShowMap['nudges']>) {
  nudges.replaceChildren(
    ...list.map((n) => {
      const box = el('div', 'nudge');
      box.dataset.key = n.key;
      const go = iconButton('play', `${n.title}: start it (it works in the background; its change comes to Review)`, { cls: 'go' });
      go.addEventListener('click', () => vscode.postMessage({ type: 'nudge', key: n.key, act: 'run' }));
      const close = iconButton('close', 'Not now: don’t show this again for this project (the agent stays in the Agents section)');
      close.addEventListener('click', () => vscode.postMessage({ type: 'nudge', key: n.key, act: 'close' }));
      box.append(el('span', 'words', n.text), tray(el('div', 'tray')));
      box.lastElementChild!.append(go, close);
      return box;
    }),
  );
  nudges.hidden = !list.length;
}

/** The project and map last fitted; a new one starts fitted, updates to the same one keep the view. */
let shownKey: string | undefined;
/** The colour of a tone for the current theme (VS Code marks the page's body with it). */
const paint = (t: Tone | undefined) => (t ? (document.body.classList.contains('vscode-light') ? t.light : t.dark) : undefined);
let selected: string | undefined;
let marks: ShowMap['marks'] = {};
let colours: ShowMap['colours'] = { cards: {}, lines: {} };
let used: ShowMap['usedBy'] = {};
/** Cards with at least one line. */
let linked = new Set<string>();
/** Used by this many cards or more: the card stands out. */
const BUSY = 3;
const look: Look = { paint, colours: () => colours, marks: () => marks, drawCard };
const openCode = (item: Item) => item.source && vscode.postMessage({ type: 'open', path: item.source.path, line: item.source.line });
const mv = new MapView(stage, look, {
  pick: (id) => select(id),
  open: openCode,
  moved: (v) => (zoomText.textContent = `${Math.round(v.k * 100)}%`),
});

/** Chooses a card (or none): highlights it and its lines, and asks for its notes and history. */
function select(id: string | undefined, tell = true) {
  const changed = selected !== id;
  selected = id;
  mv.select(id);
  if (!id) drawer.hidden = true;
  if (tell && changed) vscode.postMessage({ type: 'card', id });
}

/** Each card's stories (Story view), as its plugin last sent them; the stories opened; the card drawn last. */
const storiesOf = new Map<string, Story[]>();
const openStories = new Set<string>();
let lastCard: CardMemory | undefined;

const STEP_MARKS: Record<StoryStep['kind'], string> = { action: '▶', run: '↳', ask: '?', state: '●', store: '◆', data: '⛁', api: '⇄', navigate: '→', message: '✉', reload: '↻', prop: '⇡' };

/** "What happens when…": the card's stories; a click opens one's steps (each opens its line; another card's, its card). */
function drawStories(item: Item) {
  const stories = storiesOf.get(item.id);
  if (!stories?.length) return;
  drawer.append(el('h3', undefined, `What happens when… (${stories.length})`));
  for (const s of stories) {
    const open = openStories.has(s.id);
    const box = el('div', `story${open ? ' open' : ''}`);
    const head = el('div', 'story-head');
    head.title = open ? 'Close its steps' : 'See its steps';
    head.append(el('span', 'story-arrow', open ? '▾' : '▸'), el('span', 'story-title', s.title));
    head.addEventListener('click', () => {
      if (open) openStories.delete(s.id);
      else openStories.add(s.id);
      if (lastCard) showCard(lastCard);
    });
    box.append(head);
    if (open) {
      const cards = [...new Set([item.id, ...s.steps.map((x) => x.card).filter((c): c is string => !!c)])];
      const light = iconButton('focus', `Light up its path on the map: the ${cards.length} card${cards.length === 1 ? '' : 's'} it goes through (choosing another card ends it)`);
      light.addEventListener('click', () => mv.showPath(cards));
      const tools = tray(el('div', 'story-tools'));
      tools.append(light);
      box.append(tools);
      const list = el('ol', 'story-steps');
      let lastCardOfStep: string | undefined;
      for (const st of s.steps) {
        // (The way to another card shows where the story moves into it, not on each of its steps there.)
        const entersCard = !!st.card && st.card !== lastCardOfStep;
        if (st.card) lastCardOfStep = st.card;
        const li = el('li', `step ${st.kind}`);
        li.style.paddingLeft = `${(st.depth ?? 0) * 12}px`;
        li.append(el('span', 'mark', STEP_MARKS[st.kind]), el('span', 'text', st.text));
        if (entersCard && st.card && st.card !== item.id && mv.placedById.has(st.card)) {
          const other = mv.placedById.get(st.card)!.item.label;
          const go = iconButton('onMap', `Go to ${other}: the card this step is in`);
          go.addEventListener('click', (e) => {
            e.stopPropagation();
            focusCard(st.card!);
          });
          li.append(go);
        }
        if (st.at) {
          const where = st.at;
          li.title = `${where.path}:${where.line}: click to open it`;
          li.addEventListener('click', () => vscode.postMessage({ type: 'open', path: where.path, line: where.line }));
        }
        list.append(li);
      }
      box.append(list);
    }
    drawer.append(box);
  }
}

const OUTCOME_WORDS = { applied: 'applied', 'sent-back': 'sent back', rejected: 'rejected', undone: 'undone' } as const;

/** The drawer: the chosen card, what's noted about it, and the changes it went through. */
function showCard(m: CardMemory) {
  if (m.id !== selected) return;
  const item = mv.placedById.get(m.id)?.item;
  if (!item) return;
  drawer.replaceChildren();
  const close = iconButton('close', 'Close', { cls: 'close' });
  close.addEventListener('click', () => select(undefined));
  drawer.append(close, el('h2', undefined, item.label), el('div', 'sub', [item.kind, item.sub].filter(Boolean).join(' · ')));
  const buttons = tray(el('div', 'buttons'));
  if (item.source) {
    const open = iconButton('code', 'Open code');
    open.addEventListener('click', () => vscode.postMessage({ type: 'open', path: item.source!.path, line: item.source!.line }));
    buttons.append(open);
  }
  drawerToggles = [];
  // What its plugin suggests an agent could do for it (React: Make previewable): a line, and ▶ to start it.
  const nudgeLines: HTMLElement[] = [];
  for (const n of m.nudges ?? []) {
    const go = iconButton('play', `${n.title}: start it for ${item.label} (it works in the background; the change comes to Review)`);
    go.addEventListener('click', () => vscode.postMessage({ type: 'cardAgent', id: item.id, agent: n.agent }));
    const line = el('div', 'card-nudge');
    line.append(el('span', undefined, n.text), go);
    nudgeLines.push(line);
  }
  if (item.preview) {
    const one = iconButton('single', previewTip(item.label));
    one.addEventListener('click', () => preview.open(item));
    const all = iconButton('board', playgroundTip(item.label));
    all.addEventListener('click', () => playground.open(item));
    drawerToggles = [
      { button: one, id: () => item.id, win: preview },
      { button: all, id: () => item.id, win: playground },
    ];
    buttons.append(one, all);
    refreshToggles();
  }
  const inOut = iconButton('focus', 'Focus: only what comes into this card and what goes out of it (its immediate neighbours)');
  inOut.addEventListener('click', () => openNeighbours(item.id));
  buttons.append(inOut);
  const note = iconButton('note', 'Add a note: something to remember about this card (kept in the project, read by assistants)');
  note.addEventListener('click', () => vscode.postMessage({ type: 'addNote', id: item.id }));
  buttons.append(note);
  drawer.append(buttons, ...nudgeLines);

  // What it does: its summary (written only when asked for, then kept up to date), or a button to write one.
  if (m.canSummarize || m.summary) {
    drawer.append(el('h3', undefined, 'What it does'));
    const row = el('div', 'summary');
    if (m.summarizing) row.append(el('span', 'hint', m.summary ? 'Writing it again…' : 'Writing its summary… (one small Claude run)'));
    else if (m.summary) {
      row.append(el('div', 'text', m.summary.text));
      const meta = el('div', 'meta', `Written ${ago(m.summary.at)}${m.summary.stale ? ' · its code changed since: it may be out of date' : ''}`);
      if (m.summary.stale) meta.classList.add('stale');
      const again = iconButton('reload', 'Write it again from the code as it is now (one small Claude run)');
      again.addEventListener('click', () => vscode.postMessage({ type: 'summarize', id: item.id }));
      const line = el('div', 'metaline');
      line.append(meta, again);
      row.append(line);
    } else {
      const write = iconButton('example', 'Write a summary of what it does (one small Claude run; then kept up to date by itself)');
      write.addEventListener('click', () => vscode.postMessage({ type: 'summarize', id: item.id }));
      const line = el('div', 'metaline');
      line.append(el('span', 'hint', 'No summary yet.'), write);
      row.append(line);
    }
    drawer.append(row);
  }

  // What happens when someone does something on it (Story view).
  drawStories(item);

  // Its looks (variants) and the fixed-data states Preview shows them with.
  if (item.preview) {
    // What breaks the variant folder's rules, first: each says what to do.
    if (item.preview.problems?.length) {
      drawer.append(el('h3', undefined, `Problems (${item.preview.problems.length})`));
      for (const p of item.preview.problems) drawer.append(el('div', 'entry problem', p));
    }
    drawer.append(el('h3', undefined, 'Variants'));
    for (const v of item.preview.variants) {
      const row = el('div', `entry link${v.inUse ? ' in-use' : ''}`);
      const use = v.inUseFor?.length ? `In use for ${v.inUseFor.join(', ')}` : v.inUse ? 'In use' : '';
      row.append(el('div', 't', v.name), el('div', 'm', use ? `${use} · ${v.path.split('/').pop()}` : (v.path.split('/').pop() ?? v.path)));
      row.dataset.tip = `Open ${v.path}`;
      row.addEventListener('click', () => vscode.postMessage({ type: 'open', path: v.path }));
      drawer.append(row);
    }
    drawer.append(el('h3', undefined, `States (${item.preview.states.length})`));
    drawer.append(el('div', item.preview.states.length ? 'states' : 'none', item.preview.states.length ? item.preview.states.join(' · ') : 'No fixed-data states yet (Name.mock.ts).'));
  }

  const notes = m.entries.filter((e) => e.kind !== 'change');
  const changes = m.entries.filter((e) => e.kind === 'change');
  drawer.append(el('h3', undefined, 'Notes'));
  if (notes.length) for (const e of notes) drawer.append(entry(e));
  else drawer.append(el('div', 'none', 'No notes yet.'));
  drawer.append(el('h3', undefined, 'History'));
  if (changes.length) for (const e of changes) drawer.append(entry(e));
  else drawer.append(el('div', 'none', 'No reviewed changes yet. Approved, sent back and rejected changes appear here.'));
  drawer.hidden = false;
}

function entry(e: MemoryEntry): HTMLElement {
  const box = el('div', 'entry');
  box.append(el('div', 't', e.text));
  if (e.detail) box.append(el('div', 'd', e.detail));
  if (e.note) box.append(el('div', 'd', `Note: “${e.note}”`));
  const what = e.kind === 'change' ? OUTCOME_WORDS[e.outcome ?? 'applied'] : e.kind;
  box.append(el('div', 'm', `${what} · ${e.by.name} · ${ago(e.at)}`));
  if (e.proposal) {
    box.classList.add('link');
    box.title = 'Open in Review';
    box.addEventListener('click', () => vscode.postMessage({ type: 'openReview', proposal: e.proposal }));
  }
  return box;
}

function drawCard(c: PlacedCard): HTMLElement {
  const { item } = c;
  const card = el('div', 'card');
  Object.assign(card.style, { left: `${c.x}px`, top: `${c.y}px`, width: `${c.w}px`, height: `${c.h}px` });
  const tone = colours.cards[item.kind];
  const colour = paint(tone);
  const strip = el('div', 'strip');
  if (colour) {
    strip.style.background = tone?.dashed ? `repeating-linear-gradient(180deg, ${colour} 0 6px, transparent 6px 10px)` : colour;
    card.style.setProperty('--kind', colour);
  }
  card.append(strip);
  const n = used[item.id] ?? 0;
  if (n >= BUSY) card.classList.add('busy');
  if (!linked.has(item.id)) card.classList.add('lonely');
  const head = el('div', 'head');
  const top = el('div', 'top');
  top.append(el('span', 'label', item.label));
  const mark = marks[item.id];
  if (mark) {
    card.classList.add(mark);
    top.append(el('span', 'mark', mark === 'proposed' ? 'proposed' : 'changed'));
  } else {
    const kind = el('span', 'kind', item.kind);
    if (colour) kind.style.color = colour;
    hint(kind, { name: item.kind, text: cardMeaning(item.kind), colour });
    top.append(kind);
  }
  if (n >= BUSY) top.append(Object.assign(el('span', 'used', `used in ${n}`), { title: `${n} other cards point at it` }));
  head.append(top);
  if (item.sub) head.append(el('div', 'sub', item.sub));
  card.append(head);
  if (item.fields?.length) {
    const fields = el('div', 'fields');
    for (const f of item.fields.slice(0, MAX_FIELDS)) {
      const row = el('div', 'field');
      row.append(el('span', 'n', f.name));
      if (f.tag) row.append(el('span', 't', f.tag));
      if (f.value) row.append(el('span', 'v', f.value));
      fields.append(row);
    }
    if (item.fields.length > MAX_FIELDS) fields.append(el('div', 'field more', `+ ${item.fields.length - MAX_FIELDS} more`));
    card.append(fields);
  }
  if (item.preview) {
    // It can be shown in Preview: how many looks, how many states, which look is in use.
    const p = item.preview;
    const inUse = p.variants.filter((v) => v.inUse);
    const fields = card.querySelector('.fields') ?? card.appendChild(el('div', 'fields'));
    const row = el('div', `field previewable${p.problems?.length ? ' problems' : ''}`);
    const situations = p.situations ? ` · ${p.situations.names.length} situation${p.situations.names.length === 1 ? '' : 's'}` : '';
    row.append(el('span', 'n', `${p.variants.length} variant${p.variants.length === 1 ? '' : 's'}${situations} · ${p.states.length} state${p.states.length === 1 ? '' : 's'}`));
    if (p.problems?.length) row.append(el('span', 'v', `${p.problems.length} problem${p.problems.length === 1 ? '' : 's'}`));
    else if (inUse.length) row.append(el('span', 'v', `${inUse.map((v) => v.name).join(', ')} in use`));
    fields.append(row);
  }
  card.title = [item.label, n ? `Used by ${n} card${n === 1 ? '' : 's'}` : linked.has(item.id) ? '' : 'No lines to other cards', item.source ? 'Double-click to open its code' : ''].filter(Boolean).join('\n');
  return card;
}

// ---------------------------------------------------------------------------
// Focus: one card with only its immediate neighbours — what comes in on the left, what goes out on the right — in a
// map of its own (the same MapView: drag, scroll, pinch or Ctrl/Cmd+scroll to zoom, smooth however many neighbours).
// Clicking a neighbour moves to it; double-clicking opens its code; Esc closes.
// ---------------------------------------------------------------------------

/** Each window's panel layout: kept here for this page, and by the extension for next time. */
let layouts: Record<string, PanelLayout> = {};
const layoutStore: LayoutStore = {
  get: (key) => layouts[key],
  set: (key, layout) => {
    layouts[key] = layout;
    vscode.postMessage({ type: 'layout', key, layout });
  },
};

// The window: the map of neighbours in the middle; its panels (what comes in, goes out, other maps, props) float on
// the right to start with, and go wherever the developer puts them.
const focus = new Frame('focus', layoutStore, { right: { panels: ['in', 'out', 'map:*', 'props'], float: true, size: 340 } });
const nbTitle = focus.title;
const nbCounts = focus.hint;
const nbZoom = el('span', 'zoom');
const nbOut = iconButton('zoomOut', 'Zoom out');
const nbIn = iconButton('zoomIn', 'Zoom in');
const nbFit = iconButton('fitMap', 'Fit: show all of it');
const nbOnMap = iconButton('onMap', 'Show on map: close this and go to the card on the map');
const nbPreview = iconButton('single', 'Preview');
const nbPlayground = iconButton('board', 'Playground');
focus.addTools(nbPreview, nbPlayground, nbZoom, nbOut, nbIn, nbFit, nbOnMap);

/** The Webview: the running app, over everything (from the map's top bar, or its command), to try whole pages. */
/** A previewable card on the map, by its name (for plugin panels: a design picked in the Webview). */
const previewable = (label: string) => [...mv.placedById.values()].map((p) => p.item).find((i) => i.label === label && i.preview);
const webview = new Webview({
  post: (m) => vscode.postMessage(m),
  store: layoutStore,
  previewCard: (label, variant) => {
    const item = previewable(label);
    if (item) preview.open(item, variant);
  },
  playgroundCard: (label) => {
    const item = previewable(label);
    if (item) playground.open(item);
  },
});
/** Preview: one variant of a card on its own, in one fixed-data state, at a screen size (for cards that have variants). */
const useVariant = (item: Item, variant: string, situation?: string) => vscode.postMessage({ type: 'useVariant', id: item.id, variant, situation });
const updateHelper = (item: Item) => vscode.postMessage({ type: 'updateHelper', id: item.id });
const previewFix = (item: Item, need: string) => vscode.postMessage({ type: 'previewFix', id: item.id, need });
/**
 * The address of the page a card is on: a page's own route, or the nearest page that draws it (up the map's lines).
 * A route with :params opens as written (fill them in, in the Webview's address bar).
 */
function pageOf(item: Item): string | undefined {
  const routeOf = (i: Item | undefined) => (i?.kind === 'page' && i.sub?.startsWith('/') ? i.sub.split(' · ')[0].split(', ')[0] : undefined);
  const byId = new Map([...mv.placedById.values()].map((p) => [p.item.id, p.item]));
  const parents = new Map<string, string[]>();
  for (const l of mv.layout.links) parents.set(l.to, [...(parents.get(l.to) ?? []), l.from]);
  const seen = new Set<string>();
  const queue = [item.id];
  while (queue.length && seen.size < 200) {
    const id = queue.shift()!;
    if (seen.has(id)) continue;
    seen.add(id);
    const route = routeOf(id === item.id ? item : byId.get(id));
    if (route) return route;
    queue.push(...(parents.get(id) ?? []));
  }
  return undefined;
}
const openWebview = (path: string) => webview.open(path);
const preview = new PreviewWindow({ post: (m) => vscode.postMessage(m), store: layoutStore, useVariant, updateHelper, previewFix, pageOf, openWebview });
/** Playground: a card's every variant in every fixed-data state; a chosen tile opens in Preview. */
const playground = new Playground({ post: (m) => vscode.postMessage(m), store: layoutStore, preview: (item, variant, state) => preview.open(item, variant, state), useVariant, updateHelper, previewFix, pageOf, openWebview });
const previewTip = (label: string) => `Preview: ${label} on its own (the variant in use), with fixed data, at a screen size`;
const playgroundTip = (label: string) => `Playground: ${label}’s every variant in every state, side by side, with fixed data`;

/** Buttons that open Preview or the Playground for a card (the drawer's, Focus's): each on only while its window shows that card. */
interface Toggle {
  button: HTMLButtonElement;
  id: () => string | undefined;
  win: { shows(id: string): boolean };
}
let drawerToggles: Toggle[] = [];
const focusToggles: Toggle[] = [
  { button: nbPreview, id: () => nbId, win: preview },
  { button: nbPlayground, id: () => nbId, win: playground },
];
function refreshToggles() {
  for (const t of [...drawerToggles, ...focusToggles]) {
    const id = t.id();
    t.button.classList.toggle('on', !!id && t.win.shows(id));
  }
}
preview.onToggle = refreshToggles;
playground.onToggle = refreshToggles;
nbPreview.addEventListener('click', () => {
  const item = nbId ? mv.placedById.get(nbId)?.item : undefined;
  if (item?.preview) preview.open(item);
});
nbPlayground.addEventListener('click', () => {
  const item = nbId ? mv.placedById.get(nbId)?.item : undefined;
  if (item?.preview) playground.open(item);
});
const nbStage = el('div', 'nb-stage');
focus.main.append(nbStage);
let nbId: string | undefined;
const nbView = new MapView(nbStage, look, {
  pick: (id) => id && id !== nbId && openNeighbours(id),
  open: openCode,
  moved: (v) => (nbZoom.textContent = `${Math.round(v.k * 100)}%`),
});
focus.onClose = () => {
  nbId = undefined;
  refreshToggles();
};
nbOut.addEventListener('click', () => nbView.zoomAt(undefined, undefined, 1 / 1.25));
nbIn.addEventListener('click', () => nbView.zoomAt(undefined, undefined, 1.25));
nbFit.addEventListener('click', () => nbView.fit());
nbOnMap.addEventListener('click', () => {
  const id = nbId;
  closeNeighbours();
  if (id) focusCard(id);
});

function closeNeighbours() {
  focus.close();
}

/** Space between the three groups, between columns in a group, and between cards in a column. */
const NB_GAP_X = 220;
const NB_COL_GAP = 40;
const NB_GAP_Y = 18;
const NB_TITLE = 44;

/**
 * One card and its immediate neighbours: what comes in on the left, the card in the middle, what goes out on the
 * right. A side with many cards wraps into more columns, so the whole thing keeps about the shape of the window and
 * fits it readable rather than as one tall strip.
 */
function neighbourLayout(id: string): { layout: Layout; ins: number; outs: number } | undefined {
  const centre = mv.placedById.get(id);
  if (!centre) return undefined;
  const lines = mv.linksOf.get(id) ?? [];
  const byLabel = (a: string, b: string) => mv.placedById.get(a)!.item.label.localeCompare(mv.placedById.get(b)!.item.label);
  const ins = [...new Set(lines.filter((l) => l.to === id && l.from !== id).map((l) => l.from))].filter((x) => mv.placedById.has(x)).sort(byLabel);
  const outs = [...new Set(lines.filter((l) => l.from === id && l.to !== id).map((l) => l.to))].filter((x) => mv.placedById.has(x)).sort(byLabel);

  // A side split into `cols` columns of about equal height, in order.
  const pack = (list: string[], cols: number) => {
    const cards = list.map((x) => mv.placedById.get(x)!);
    const target = cards.reduce((h, c) => h + c.h + NB_GAP_Y, 0) / cols;
    const columns: PlacedCard[][] = [[]];
    let h = 0;
    for (const c of cards) {
      if (h > 0 && h + c.h / 2 > target && columns.length < cols) columns.push([]), (h = 0);
      columns[columns.length - 1].push(c);
      h += c.h + NB_GAP_Y;
    }
    const widths = columns.map((col) => Math.max(240, ...col.map((c) => c.w)));
    const heights = columns.map((col) => col.reduce((t, c) => t + c.h + NB_GAP_Y, 0));
    return { columns, widths, w: widths.reduce((t, w) => t + w, 0) + NB_COL_GAP * (columns.length - 1), h: Math.max(0, ...heights) };
  };
  // More columns for the taller side until the whole is about as wide (for its height) as the window.
  const aspect = Math.max(0.8, nbStage.clientWidth / Math.max(1, nbStage.clientHeight) || 1.6);
  let colsIn = 1;
  let colsOut = 1;
  let left = pack(ins, colsIn);
  let right = pack(outs, colsOut);
  const size = () => ({ w: left.w + centre.w + right.w + 2 * NB_GAP_X, h: NB_TITLE + Math.max(left.h, right.h, centre.h) });
  for (let guard = 0; guard < 200; guard++) {
    const { w, h } = size();
    if (w / h >= aspect) break;
    const growOut = right.h >= left.h ? colsOut < outs.length : colsIn >= ins.length;
    if (growOut && colsOut < outs.length) right = pack(outs, ++colsOut);
    else if (colsIn < ins.length) left = pack(ins, ++colsIn);
    else break;
  }
  const tall = Math.max(left.h, right.h, centre.h);
  const place = (side: ReturnType<typeof pack>, x0: number, title: string): Section => {
    const cards: PlacedCard[] = [];
    let x = x0;
    side.columns.forEach((col, i) => {
      // Each column sits in the middle of the height, so the lines fan out evenly.
      const colH = col.reduce((t, c) => t + c.h + NB_GAP_Y, 0);
      let y = NB_TITLE + Math.max(0, (tall - colH) / 2);
      for (const c of col) {
        cards.push({ item: c.item, x, y, w: c.w, h: c.h });
        y += c.h + NB_GAP_Y;
      }
      x += side.widths[i] + NB_COL_GAP;
    });
    return { map: { id: title, title }, x: x0, y: 0, w: side.w, h: NB_TITLE + tall, cards };
  };
  const leftSection = place(left, 0, `Comes in (${ins.length})`);
  const midX = left.w + NB_GAP_X;
  const mid: Section = { map: { id: 'here', title: '' }, x: midX, y: 0, w: centre.w, h: tall, cards: [{ item: centre.item, x: midX, y: NB_TITLE + Math.max(0, (tall - centre.h) / 2), w: centre.w, h: centre.h }] };
  const rightSection = place(right, midX + centre.w + NB_GAP_X, `Goes out (${outs.length})`);
  const keep = new Set([id, ...ins, ...outs]);
  const links = lines.filter((l) => keep.has(l.from) && keep.has(l.to) && (l.from === id || l.to === id));
  return { layout: { sections: [leftSection, mid, rightSection], links, width: rightSection.x + right.w, height: NB_TITLE + tall }, ins: ins.length, outs: outs.length };
}

function openNeighbours(id: string) {
  if (!mv.placedById.has(id)) return;
  // Shown first, so the layout can take the window's shape.
  focus.open();
  const made = neighbourLayout(id)!;
  nbId = id;
  const item = mv.placedById.get(id)!.item;
  nbTitle.textContent = item.label;
  // Preview and Playground, for a card that has variants.
  nbPreview.hidden = nbPlayground.hidden = !item.preview;
  for (const [b, tip] of [[nbPreview, previewTip(item.label)], [nbPlayground, playgroundTip(item.label)]] as const) {
    b.dataset.tip = tip;
    b.setAttribute('aria-label', tip);
  }
  refreshToggles();
  nbCounts.textContent = `${made.ins} in · ${made.outs} out`;
  nbView.setLayout(made.layout);
  // The card in focus is chosen: its lines show their kind and an arrow; every neighbour stays bright.
  nbView.select(id);
  requestAnimationFrame(() => nbView.fit());
  // Everything joined to it, on any map, comes from the shell for the panels.
  focus.setPanels([]);
  vscode.postMessage({ type: 'lines', id });
}

// The panels: what comes in and goes out on this map, what it's joined to on each other map (API calls, pages…),
// and its props.

/** Each tab's colour: one of the theme's own code colours (VS Code's chart colours until they arrive). */
const TINTS = {
  in: 'var(--tok-type, var(--vscode-charts-green, #89d185))',
  out: 'var(--tok-keyword, var(--vscode-charts-blue, #3794ff))',
  map: 'var(--tok-string, var(--vscode-charts-orange, #d18616))',
  props: 'var(--tok-function, var(--vscode-charts-purple, #b180d7))',
  variants: 'var(--tok-number, var(--vscode-charts-yellow, #cca700))',
};

interface SideTab {
  key: string;
  /** Its colour, from the VS Code theme. */
  tint: string;
  icon: Icon;
  name: string;
  count: number;
  fill(): HTMLElement[];
}

function showLines(m: CardLines) {
  if (m.id !== nbId) return;
  const item = mv.placedById.get(m.id)?.item;
  if (!item) return;
  const here = item.map;
  m.lines.sort((a, b) => a.other.label.localeCompare(b.other.label));
  const sameMap = m.lines.filter((l) => l.other.map === here);
  const ins = sameMap.filter((l) => l.dir === 'in');
  const outs = sameMap.filter((l) => l.dir === 'out');
  const others = new Map<string, CardLines['lines']>();
  for (const l of m.lines) if (l.other.map !== here) others.set(l.other.map, [...(others.get(l.other.map) ?? []), l]);
  const props = item.fields ?? [];
  const title = (map: string) => m.maps[map] ?? map;
  const tabs: SideTab[] = [
    { key: 'in', tint: TINTS.in, icon: 'comesIn', name: `Comes in: cards on this map with a line into ${item.label}`, count: ins.length, fill: () => ins.map((l) => lineRow(l)) },
    { key: 'out', tint: TINTS.out, icon: 'goesOut', name: `Goes out: cards on this map that ${item.label} has a line to`, count: outs.length, fill: () => outs.map((l) => lineRow(l)) },
    ...[...others].map(([map, list]): SideTab => ({ key: `map:${map}`, tint: TINTS.map, icon: mapIcon(map), name: `${title(map)}: what ${item.label} is joined to on that map`, count: list.length, fill: () => list.map((l) => lineRow(l)) })),
    {
      key: 'props',
      tint: TINTS.props,
      icon: 'props',
      name: `Props: what ${item.label} takes`,
      count: props.length,
      fill: () =>
        props.map((f) => {
          const row = el('div', `nb-row prop${f.tag === 'callback' ? ' callback' : ''}`);
          const line = el('div', 'line');
          line.append(el('span', 'l', f.name));
          if (f.tag) line.append(el('span', `tag ${f.tag.replace(/\W/g, '')}`, f.tag));
          line.append(el('span', 'what'));
          row.append(el('span', 'strip'), line);
          if (f.value) {
            const v = el('span', 'v');
            v.append(typeText(f.value));
            const full = el('div', 'full');
            full.append(typeText(f.value));
            line.append(v, el('span', 'chev'));
            row.append(full);
          }
          return row;
        }),
    },
  ];
  // Variants: a previewable card's designs (in use, per situation) and states; each opens in Preview.
  const pv = item.preview;
  if (pv) {
    const designRow = (v: NonNullable<Item['preview']>['variants'][number]) => {
      const row = el('div', `nb-row go design${v.inUse ? ' inuse' : ''}`);
      const line = el('div', 'what');
      const t = el('div', 't');
      t.append(el('span', 'l', v.name));
      if (v.inUseFor?.length) t.append(el('span', 'tag', `in use for ${v.inUseFor.join(', ')}`));
      else if (v.inUse) t.append(el('span', 'tag', 'in use'));
      line.append(t, el('div', 's', v.path.split('/').pop() ?? v.path));
      row.append(el('span', 'strip'), line);
      row.dataset.tip = `Preview ${v.name} on its own`;
      row.addEventListener('click', () => preview.open(item, v.id));
      return row;
    };
    const stateRow = (s: string) => {
      const row = el('div', 'nb-row go');
      const line = el('div', 'what');
      line.append(el('div', 'l', s));
      row.append(el('span', 'strip'), line);
      const design = pv.variants.find((v) => (pv.situations ? v.inUseFor?.includes(pv.situations.ofState[s]) : v.inUse)) ?? pv.variants[0];
      row.dataset.tip = `Preview ${design?.name ?? ''} in “${s}”`;
      row.addEventListener('click', () => preview.open(item, design?.id, s));
      return row;
    };
    tabs.push({
      key: 'variants',
      tint: TINTS.variants,
      icon: 'board',
      name: `Variants: ${item.label}’s designs and states (click one to preview it)`,
      count: pv.variants.length,
      fill: () => {
        const out: HTMLElement[] = [el('h4', undefined, 'Designs'), ...pv.variants.map(designRow)];
        const sit = pv.situations;
        if (sit) for (const name of sit.names) out.push(el('h4', undefined, name), ...pv.states.filter((s) => sit.ofState[s] === name).map(stateRow));
        else out.push(el('h4', undefined, 'States'), ...pv.states.map(stateRow));
        return out;
      },
    });
  }
  focus.setPanels(
    tabs.map((t) => {
      const rows = t.fill();
      const body = el('div', 'nb-list');
      body.append(el('h3', undefined, `${t.name.split(':')[0]} (${t.count})`), ...(rows.length ? rows : [el('div', 'none', 'Nothing here.')]));
      return { id: t.key, icon: t.icon, name: t.name, count: t.count, tint: t.tint, body, onShow: () => cutShort(body) };
    }),
  );
}

/**
 * Text the side panel had to cut short: a name shows in full on hover; a prop's value opens in full under it (the row
 * folds open and shut, like an accordion).
 */
function cutShort(list: HTMLElement) {
  const cut = (e: Element | null): e is HTMLElement => !!e && (e as HTMLElement).scrollWidth > (e as HTMLElement).clientWidth + 1;
  for (const e of list.querySelectorAll<HTMLElement>('.nb-row .l, .nb-row .via, .nb-row .s')) if (cut(e)) e.dataset.tip = e.textContent ?? '';
  for (const row of list.querySelectorAll<HTMLElement>('.nb-row.prop')) {
    if (row.classList.contains('folds') || !cut(row.querySelector('.v'))) continue;
    row.classList.add('folds');
    // Selecting the full value (to copy it) doesn't fold it shut.
    row.querySelector('.full')?.addEventListener('click', (e) => e.stopPropagation());
    row.tabIndex = 0;
    row.setAttribute('role', 'button');
    row.setAttribute('aria-expanded', 'false');
    const toggle = () => row.setAttribute('aria-expanded', String(row.classList.toggle('open')));
    row.addEventListener('click', toggle);
    row.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        toggle();
      }
    });
  }
}

/** One line in the side panel: the card at the other end, the kind of line and which way it goes, and what to do. */
function lineRow(l: CardLines['lines'][number]): HTMLElement {
  const o = l.other;
  const onFocusMap = nbView.placedById.has(o.id);
  const row = el('div', onFocusMap ? 'nb-row go' : 'nb-row');
  const strip = el('span', 'strip');
  const colour = paint(colours.cards[o.kind]);
  if (colour) strip.style.background = colour;
  const what = el('div', 'what');
  const t = el('div', 't');
  const kindTag = el('span', 'k', o.kind);
  if (colour) kindTag.style.color = colour;
  t.append(el('span', 'l', o.label), kindTag);
  const kind = l.label ?? l.kind;
  // The line's own colour when the map gives it one; otherwise the colour of the way it goes.
  row.style.setProperty('--line', paint(colours.lines[l.kind]) ?? (l.dir === 'in' ? TINTS.in : TINTS.out));
  what.append(t, el('div', 'via', l.dir === 'in' ? `→ ${kind} this` : `this ${kind} →`));
  if (o.sub) what.append(el('div', 's', o.sub));
  row.title = [o.label, o.sub, onFocusMap ? 'Click to find it in the map here' : '', o.source ? 'Double-click to open its code' : ''].filter(Boolean).join('\n');
  const acts = tray(el('div', 'acts'));
  if (onFocusMap) {
    const focus = iconButton('focus', `Focus on ${o.label}: its own neighbours`);
    focus.addEventListener('click', (e) => {
      e.stopPropagation();
      openNeighbours(o.id);
    });
    acts.append(focus);
  } else {
    const goTo = iconButton('onMap', `Show on its map: close this and go to ${o.label}`);
    goTo.addEventListener('click', (e) => {
      e.stopPropagation();
      closeNeighbours();
      vscode.postMessage({ type: 'goTo', id: o.id });
    });
    acts.append(goTo);
  }
  if (o.source) {
    const code = iconButton('code', 'Open code');
    code.addEventListener('click', (e) => {
      e.stopPropagation();
      openCode(o);
    });
    acts.append(code);
  }
  row.append(strip, what, acts);
  if (onFocusMap) row.addEventListener('click', () => nbView.centre(o.id));
  row.addEventListener('dblclick', () => openCode(o));
  return row;
}

/** Chooses a card and moves the view so it's in the middle. */
function focusCard(id: string) {
  if (!mv.placedById.has(id)) return;
  select(id);
  // Close enough to read it, clear of the drawer.
  mv.centre(id, 300);
}

/** What the colours mean: each kind of card (with how many) and each kind of line. */
function drawLegend(m: ShowMap) {
  legend.replaceChildren();
  const counts = new Map<string, number>();
  for (const s of m.layout.sections) for (const c of s.cards) counts.set(c.item.kind, (counts.get(c.item.kind) ?? 0) + 1);
  for (const [kind, tone] of Object.entries(m.colours.cards)) {
    const k = el('span', 'k');
    const dot = el('span', 'dot');
    dot.style.background = paint(tone)!;
    const n = counts.get(kind) ?? 0;
    k.append(dot, el('span', undefined, kind), el('span', 'n', String(n)));
    hint(k, { name: kind, text: cardMeaning(kind), colour: paint(tone), count: `${n} card${n === 1 ? '' : 's'} on this map` });
    legend.append(k);
  }
  for (const [kind, tone] of Object.entries(m.colours.lines)) {
    const k = el('span', 'k');
    const ln = el('span', 'ln');
    ln.style.background = paint(tone)!;
    k.append(ln, el('span', undefined, kind));
    const n = m.layout.links.filter((l) => l.kind === kind).length;
    hint(k, { name: kind, text: lineMeaning(kind), colour: paint(tone), line: true, count: `${n} line${n === 1 ? '' : 's'} on this map` });
    legend.append(k);
  }
  legend.hidden = !!m.empty || !legend.childElementCount;
}

let lastDrawMs = 0;

/** Frame times while something moves the view each frame (for the performance test). */
async function frames(n: number, step: (i: number) => void) {
  const times: number[] = [];
  let prev = performance.now();
  for (let i = 0; i < n; i++) {
    step(i);
    mv.applyView();
    await new Promise((r) => requestAnimationFrame(r));
    const now = performance.now();
    times.push(now - prev);
    prev = now;
  }
  return stats(times);
}

function stats(times: number[]) {
  times.sort((a, b) => a - b);
  const round = (x: number) => Math.round(x * 10) / 10;
  return { avg: round(times.reduce((a, b) => a + b, 0) / times.length), p95: round(times[Math.floor(times.length * 0.95)]), max: round(times[times.length - 1]) };
}

async function measure() {
  const v = mv.view;
  const start = { ...v };
  const panStep = () => {
    mv.view.x -= 12;
    mv.view.y -= 4;
  };
  const zoomStep = (rate: number) => (i: number) => {
    mv.lastZoomAt = performance.now();
    mv.view.k = Math.min(2, Math.max(mv.minZoom, mv.view.k * (i < 30 ? rate : 1 / rate)));
  };
  // Painting alone (no waiting for the screen), for each step of a pan and a zoom.
  const paintTimes = (n: number, step: (i: number) => void) => {
    const times: number[] = [];
    for (let i = 0; i < n; i++) {
      step(i);
      mv.applyView();
      const t = performance.now();
      mv.render();
      times.push(performance.now() - t);
    }
    return stats(times);
  };
  const paintPan = paintTimes(60, panStep);
  mv.view = { ...start };
  const paintZoom = paintTimes(60, zoomStep(1.08));
  mv.view = { ...start };
  const base = { drawMs: Math.round(lastDrawMs), cards: mv.cardEls.size, lines: mv.layout.links.length, elements: document.querySelectorAll('*').length };
  vscode.postMessage({ type: 'measured', partial: true, pan: paintPan, zoom: paintZoom, paintPan, paintZoom, ...base });
  const pan = await frames(60, panStep);
  mv.view = { ...start };
  const zoom = await frames(60, zoomStep(1.05));
  // Zoomed in (cards as elements, made and removed while moving), in the middle of the map.
  mv.view = { k: 0.9, x: stage.clientWidth / 2 - (mv.layout.width / 2) * 0.9, y: stage.clientHeight / 2 - (mv.layout.height / 2) * 0.9 };
  mv.applyView();
  await new Promise((r) => requestAnimationFrame(r));
  const nearPan = await frames(60, () => {
    mv.view.x -= 25;
    mv.view.y -= 8;
  });
  const nearCards = mv.cardEls.size;
  mv.view = start;
  mv.applyView();
  vscode.postMessage({ type: 'measured', pan, zoom, paintPan, paintZoom, nearPan, nearCards, ...base, elements: document.querySelectorAll('*').length });
}



function show(m: ShowMap) {
  const started = performance.now();
  picker.replaceChildren(
    ...m.projects.map((p) => {
      const o = el('option', undefined, `${p.group && p.group !== p.name ? `${p.group} › ` : ''}${p.name}${p.cards ? ` (${p.cards})` : ''}`);
      o.value = p.root;
      o.selected = p.root === m.current;
      return o;
    }),
  );
  // One project: no choice to make, just its name.
  picker.hidden = m.projects.length < 2;
  projectName.hidden = m.projects.length >= 2;
  projectName.textContent = m.projects.find((p) => p.root === m.current)?.name ?? '';
  chips.replaceChildren(...m.plugins.map((name) => el('span', 'chip', name)));
  tabs.replaceChildren(
    ...m.maps.map((t) => {
      const b = iconButton(mapIcon(t.id), `${t.title} (${t.cards} card${t.cards === 1 ? '' : 's'})${t.description ? `: ${t.description}` : ''}`, { count: t.cards, cls: t.id === m.map ? 'on' : undefined });
      b.addEventListener('click', () => vscode.postMessage({ type: 'chooseMap', id: t.id }));
      return b;
    }),
  );
  tabs.hidden = m.maps.length < 2;
  empty.hidden = !m.empty;
  stage.hidden = !!m.empty;
  fitButton.hidden = !!m.empty;
  zoomText.hidden = !!m.empty;
  emptyTitle.textContent = m.empty?.title ?? '';
  emptyDetail.textContent = m.empty?.detail ?? '';
  marks = m.marks;
  colours = m.colours;
  meanings = m.meanings;
  tip.hidden = true;
  used = m.usedBy;
  linked = new Set(m.layout.links.flatMap((l) => [l.from, l.to]));
  for (const b of arrangeGroup.querySelectorAll('button')) b.classList.toggle('on', b.dataset.mode === m.arrange);
  setIcon(windowButton, m.floating ? 'back' : 'popOut', m.floating ? 'Back into the main window' : 'Pop out: the map in its own window (full screen there, or on another screen)');
  drawLegend(m);
  drawNudges(m.empty ? [] : (m.nudges ?? []));
  setIcon(proposedBadge, 'proposed', `${m.proposed} change${m.proposed === 1 ? '' : 's'} waiting for your OK: open Review`, m.proposed);
  proposedBadge.hidden = !m.proposed;
  setIcon(toRunBadge, 'preview', `${m.toRun.count} change${m.toRun.count === 1 ? '' : 's'} with test cases waiting for you to look at and run: open Review`, m.toRun.count);
  toRunBadge.hidden = !m.toRun.count;
  firstToRun = m.toRun.first;
  setIcon(heldBadge, 'levelWarn', `${m.held.count} change${m.held.count === 1 ? '' : 's'} held back by a check (fix it, bypass it or run it again): open Review`, m.held.count);
  heldBadge.hidden = !m.held.count;
  firstHeld = m.held.first;
  setIcon(changedBadge, 'changed', `${m.changed} file${m.changed === 1 ? '' : 's'} changed outside review (by hand, a formatter, git…): click to clear the marks`, m.changed);
  changedBadge.hidden = !m.changed;
  mv.setLayout(m.layout);
  if (selected && !mv.placedById.has(selected)) select(undefined);
  // The Playground and Preview follow their card (e.g. another variant is now in use).
  for (const w of [playground, preview]) {
    const item = w.itemId ? mv.placedById.get(w.itemId)?.item : undefined;
    if (item) w.refresh(item);
  }
  // A new project starts fitted; updates to the same one keep where you were looking.
  if (`${m.current}|${m.map}` !== shownKey) {
    shownKey = `${m.current}|${m.map}`;
    mv.fit();
  }
  lastDrawMs = performance.now() - started;
}

fitButton.addEventListener('click', () => mv.fit());

// Find a card by name: each Enter goes to the next match.
let found: Item[] = [];
let foundAt = 0;
find.addEventListener('input', () => {
  const q = find.value.trim().toLowerCase();
  found = q ? mv.layout.sections.flatMap((s) => s.cards.map((c) => c.item)).filter((i) => i.label.toLowerCase().includes(q)) : [];
  foundAt = 0;
  find.style.outline = q && !found.length ? '1px solid var(--vscode-inputValidation-errorBorder, #e55)' : '';
  if (found[0]) focusCard(found[0].id);
});
find.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && found.length) {
    foundAt = (foundAt + 1) % found.length;
    focusCard(found[foundAt].id);
  } else if (e.key === 'Escape') {
    find.value = '';
    found = [];
    select(undefined);
  }
});
proposedBadge.addEventListener('click', () => vscode.postMessage({ type: 'openReview' }));
toRunBadge.addEventListener('click', () => vscode.postMessage({ type: 'openReview', proposal: firstToRun }));
heldBadge.addEventListener('click', () => vscode.postMessage({ type: 'openReview', proposal: firstHeld }));
changedBadge.addEventListener('click', () => vscode.postMessage({ type: 'clearChanged' }));
picker.addEventListener('change', () => vscode.postMessage({ type: 'choose', root: picker.value }));

window.addEventListener('message', (e: MessageEvent<ToMap>) => {
  // The app in the Webview talks through the inspector the proxy adds to its pages.
  const fromPage = e.data as unknown as { source?: string } | undefined;
  if (fromPage?.source === 've-inspector') return webview.fromPage(e.data as unknown as Record<string, unknown>, e.source);
  if (fromPage?.source === 've-preview-page') {
    playground.fromPage(e.data as unknown as Record<string, unknown>, e.source);
    return preview.fromPage(e.data as unknown as Record<string, unknown>, e.source);
  }
  if (e.data?.type === 'show') show(e.data);
  else if (e.data?.type === 'card') {
    lastCard = e.data;
    showCard(e.data);
  } else if (e.data?.type === 'stories') {
    storiesOf.set(e.data.id, e.data.stories);
    if (lastCard?.id === e.data.id) showCard(lastCard);
  }
  else if (e.data?.type === 'lines') showLines(e.data);
  else if (e.data?.type === 'theme') useThemeTokens(e.data.tokens);
  else if (e.data?.type === 'layouts') layouts = { ...e.data.layouts, ...layouts };
  else if (e.data?.type === 'app') {
    webview.receiveApp(e.data);
    playground.receiveApp(e.data);
    preview.receiveApp(e.data);
  }
  else if (e.data?.type === 'webview') webview.open(e.data.path);
  else if (e.data?.type === 'panels') webview.setPluginPanels(e.data.panels);
  else if (e.data?.type === 'panelAnswer') webview.pluginAnswer(e.data);
  else if (e.data?.type === 'calls' || e.data?.type === 'fakes' || e.data?.type === 'contracts' || e.data?.type === 'contractExample') webview.receiveNetwork(e.data);
  else if (e.data?.type === 'focus') focusCard(e.data.id);
  else if (e.data?.type === 'measure') void measure();
});
mv.applyView();
vscode.postMessage({ type: 'ready' });
