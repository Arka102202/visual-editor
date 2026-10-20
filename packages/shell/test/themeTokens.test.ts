import { test } from 'node:test';
import assert from 'node:assert/strict';
import { customRules, parseJsonc, tmThemeRules, tokenColours } from '../src/themeTokens';

test('theme files: comments and trailing commas are fine, and "//" inside a string stays', () => {
  const theme = parseJsonc(`{
    // a comment
    "name": "x", /* another */
    "url": "https://example.com",
    "tokenColors": [{ "scope": "string", "settings": { "foreground": "#ce9178", }, },],
  }`) as { url: string; tokenColors: unknown[] };
  assert.equal(theme.url, 'https://example.com');
  assert.equal(theme.tokenColors.length, 1);
});

test('theme colours: the most specific rule wins, later rules win ties, and context rules are skipped', () => {
  const colours = tokenColours([
    { scope: 'entity.name', settings: { foreground: '#111111' } },
    { scope: ['entity.name.type', 'support.type'], settings: { foreground: '#222222' } },
    { scope: 'meta.tag entity.name.type', settings: { foreground: '#999999' } },
    { scope: 'string, constant.numeric', settings: { foreground: '#333333' } },
    { scope: 'string', settings: { foreground: '#444444' } },
    { scope: 'variable.parameter', settings: { foreground: '#555555' } },
  ]);
  assert.equal(colours.type, '#222222');
  assert.equal(colours.string, '#444444');
  assert.equal(colours.number, '#333333');
  assert.equal(colours.param, '#555555');
  // Nothing more specific for function names: the general rule covers them, as in the editor.
  assert.equal(colours.function, '#111111');
  assert.equal(colours.component, '#111111');
  assert.equal(colours.literal, undefined);
});

test('theme colours: semantic colours win over the rules, as in the editor', () => {
  const colours = tokenColours([{ scope: 'entity.name.type', settings: { foreground: '#222222' } }], { type: { foreground: '#abcdef' }, parameter: '#123456' });
  assert.equal(colours.type, '#abcdef');
  assert.equal(colours.param, '#123456');
});

test('theme colours: old .tmTheme files are read too', () => {
  const rules = tmThemeRules(`<dict><key>scope</key><string>string</string><key>settings</key><dict><key>foreground</key><string>#A31515</string></dict></dict>
    <dict><key>scope</key><string>comment</string><key>settings</key><dict><key>fontStyle</key><string>italic</string></dict></dict>`);
  assert.deepEqual(rules, [{ scope: 'string', settings: { foreground: '#A31515' } }]);
});

test("theme colours: the developer's own colours from settings come on top, for all themes or just this one", () => {
  const custom = customRules({ strings: '#00ff00', '[My Theme]': { textMateRules: [{ scope: 'entity.name.type', settings: { foreground: '#ff00ff' } }] }, '[Other]': { types: '#000000' } }, 'My Theme');
  const colours = tokenColours([{ scope: 'string', settings: { foreground: '#444444' } }, ...custom]);
  assert.equal(colours.string, '#00ff00');
  assert.equal(colours.type, '#ff00ff');
});
