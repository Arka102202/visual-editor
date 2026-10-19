import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chooseVersion } from '../src/playground/choose';
import { choiceFor, playgroundDir, versionLabel, versionsOf } from '../src/playground/playground';
import { readModel } from '../src/plugin';

// From No-Code Map's tests, with the playground in .visual-editor/playground/.
const card = `import { formatDate } from '../../lib/date';

export interface ProjectCardProps {
  project: { name: string; updatedAt: number };
  onOpen: () => void;
}

/** A project in the list. */
export function ProjectCard({ project, onOpen }: ProjectCardProps) {
  return <div onClick={onOpen}>{project.name} {formatDate(project.updatedAt)}</div>;
}
`;

const variants = `// Versions of ProjectCard
import { useState } from 'react'
import type { ProjectCardProps } from '../../../src/components/ProjectCard/ProjectCard'
import { Badge } from '../../../src/ui/Badge'
import * as Icons from 'lucide-react'

function BoldTitle({ text }: { text: string }) {
  return <h3 className="text-lg font-semibold">{text}</h3>
}

function Unused() {
  return null
}

/** compact */
export function Compact({ project }: ProjectCardProps) {
  return <Unused />
}

/** big title */
export function Bold({ project, onOpen }: ProjectCardProps) {
  const [open, setOpen] = useState(false)
  return <div onClick={() => (setOpen(!open), onOpen())}><BoldTitle text={project.name} /><Badge label="new" /><Icons.Star /></div>
}
`;

test('choose: the version replaces the component in its own file, under its own name', () => {
  const out = chooseVersion({
    variants: { path: '.visual-editor/playground/ProjectCard/variants.tsx', text: variants },
    exportName: 'Bold',
    target: { path: 'src/components/ProjectCard/ProjectCard.tsx', name: 'ProjectCard', text: card },
  });
  const t = out.text;
  assert.match(t, /\/\*\* A project in the list\. \*\/\nfunction BoldTitle/, 'its helper goes just before it');
  assert.match(t, /export function ProjectCard\(\{ project, onOpen \}: ProjectCardProps\) \{\n  const \[open, setOpen\] = useState\(false\)/, 'renamed, export kept');
  assert.doesNotMatch(t, /function Bold\b|Unused|Compact/, 'not the other versions or helpers it does not use');
  assert.match(t, /export interface ProjectCardProps/, 'the rest of the file stays');
  assert.match(t, /^import \{ Badge \} from '\.\.\/\.\.\/ui\/Badge';$/m, 'paths from the component\'s folder, in the file\'s style');
  assert.match(t, /^import \{ useState \} from 'react';$/m);
  assert.match(t, /^import \* as Icons from 'lucide-react';$/m);
  assert.doesNotMatch(t, /ProjectCard\/ProjectCard'/, 'the props type comes from the file itself');
  assert.deepEqual(out.helpers, ['BoldTitle']);
  assert.deepEqual(out.imports.sort(), ['Badge', 'Icons', 'useState']);
});

test('choose: default exports, arrow functions and clashes', () => {
  const target = "import { useState } from 'react';\n\nexport default function Card() {\n  return null;\n}\n";
  const v = "import { useState } from 'react'\n/** x */\nexport const Slim = () => {\n  const [a] = useState(1)\n  return <p>{a}</p>\n}\n";
  const out = chooseVersion({ variants: { path: '.visual-editor/playground/Card/variants.tsx', text: v }, exportName: 'Slim', target: { path: 'src/Card.tsx', name: 'Card', text: target } });
  assert.match(out.text, /const Card = \(\) => \{[\s\S]*\}\n\nexport default Card\n/);
  assert.equal(out.text.match(/import \{ useState \}/g)?.length, 1, 'an import it already has is not added again');

  // A helper with the name of one the file has: only the old component used it, so the version's replaces it.
  const clash = "function Row() { return null }\nexport function Card() { return <Row /> }\n";
  const v2 = '/** y */\nexport function Wide() { return <Row /> }\nfunction Row() { return <hr /> }\n';
  const replaced = chooseVersion({ variants: { path: '.visual-editor/playground/Card/variants.tsx', text: v2 }, exportName: 'Wide', target: { path: 'src/Card.tsx', name: 'Card', text: clash } });
  assert.equal(replaced.text, 'function Row() { return <hr /> }\nexport function Card() { return <Row /> }\n');
  // Something else still uses the old one: the version's gets a name of its own (its uses too, not object keys).
  const shared = "function Row() { return null }\nexport function Card() { return <Row /> }\nexport function Other() { return <Row /> }\n";
  const v3 = '/** z */\nexport function Wide() { const s = { Row: 1 }; return <Row n={s.Row} /> }\nfunction Row({ n }: { n: number }) { return <hr data-n={n} /> }\n';
  const renamed = chooseVersion({ variants: { path: '.visual-editor/playground/Card/variants.tsx', text: v3 }, exportName: 'Wide', target: { path: 'src/Card.tsx', name: 'Card', text: shared } });
  assert.match(renamed.text, /^function Row\(\) \{ return null \}\nfunction Row2\(\{ n \}: \{ n: number \}\) \{ return <hr data-n=\{n\} \/> \}\n\nexport function Card\(\) \{ const s = \{ Row: 1 \}; return <Row2 n=\{s\.Row\} \/> \}/);
  assert.match(renamed.text, /export function Other\(\) \{ return <Row \/> \}/);
  assert.deepEqual(renamed.helpers, ['Row2']);
  // The very same helper: the file's own is used, nothing is added.
  const twin = chooseVersion({ variants: { path: '.visual-editor/playground/Card/variants.tsx', text: '/** w */\nexport function Wide() { return <div><Row /></div> }\nfunction Row() { return null }\n' }, exportName: 'Wide', target: { path: 'src/Card.tsx', name: 'Card', text: shared } });
  assert.equal(twin.text, "function Row() { return null }\nexport function Card() { return <div><Row /></div> }\nexport function Other() { return <Row /> }\n");

  // An older playground: one file with a default export.
  const old = chooseVersion({ variants: { path: '.visual-editor/playground/Card/v1-old.tsx', text: 'export default function Old() { return <i /> }\n' }, target: { path: 'src/Card.tsx', name: 'Card', text: target } });
  assert.match(old.text, /export default function Card\(\) \{ return <i \/> \}/);
});

test("choose: a client version makes the component's file a client component", () => {
  const target = "import type { P } from './types';\n\nexport function Header({ title }: P) {\n  return <h1>{title}</h1>;\n}\n";
  const v = "'use client'\n\nimport { useState } from 'react'\n/** x */\nexport function Toggle({ title }: { title: string }) {\n  const [on, set] = useState(false)\n  return <h1 onClick={() => set(!on)}>{title}</h1>\n}\n";
  const out = chooseVersion({ variants: { path: '.visual-editor/playground/Header/variants.tsx', text: v }, exportName: 'Toggle', target: { path: 'src/Header.tsx', name: 'Header', text: target } });
  assert.match(out.text, /^'use client';\n\nimport type \{ P \} from '\.\/types';/);
  assert.match(out.text, /export function Header\(\{ title \}: \{ title: string \}\)/);
});

test('playground: versions are listed with their notes and checks; choosing one is a change to the real file', async () => {
  const root = mkdtempSync(join(tmpdir(), 've-pg-'));
  const files = [
    { path: 'src/ui/Button.tsx', text: 'export function Button(p: { children: unknown }) { return <button>{p.children as never}</button> }' },
    { path: 'src/Cart.tsx', text: "import { Button } from './ui/Button'\nexport function Cart() { return <div className=\"bg-indigo-600\"><Button>Pay</Button></div> }" },
  ];
  for (const f of files) {
    mkdirSync(join(root, f.path, '..'), { recursive: true });
    writeFileSync(join(root, f.path), f.text);
  }
  const model = readModel(files);
  const cart = model.components.find((c) => c.name === 'Cart')!;
  assert.equal(playgroundDir(cart, model), '.visual-editor/playground/Cart');
  assert.deepEqual(versionsOf(root, cart, model, new Map(files.map((f) => [f.path, f.text])), undefined), []);
  mkdirSync(join(root, '.visual-editor/playground/Cart'), { recursive: true });
  writeFileSync(
    join(root, '.visual-editor/playground/Cart/variants.tsx'),
    "import { Button } from '../../../src/ui/Button'\n\n/** Uses the project's button. */\nexport function Tidy() { return <div className=\"bg-indigo-600\"><Button>Pay now</Button></div> }\n\n/** A plain button, a colour the project never uses. */\nexport function Loud() { return <div className=\"bg-pink-500\"><button>PAY</button></div> }\n",
  );
  const versions = versionsOf(root, cart, model, new Map(files.map((f) => [f.path, f.text])), undefined);
  assert.deepEqual(versions.map((v) => [v.id, v.label, v.notes]), [['Tidy', 'Tidy', "Uses the project's button."], ['Loud', 'Loud', 'A plain button, a colour the project never uses.']]);
  assert.equal(versions[0].checks!.problems, 0);
  assert.match(versions[0].checks!.summary, /Uses 1 component/);
  const loud = versions[1].checks!.items.filter((i) => !i.ok).map((i) => i.text);
  assert.ok(loud.some((t) => /A plain <button>: the project has Button/.test(t)), loud.join(' | '));
  assert.ok(loud.some((t) => /Colour pink-500 isn't used anywhere in the project; closest it uses: indigo-600/.test(t)), loud.join(' | '));
  // The playground stays out of git.
  assert.ok(require('node:fs').existsSync(join(root, '.visual-editor/playground/.gitignore')));
  const read = async (p: string) => { try { return require('node:fs').readFileSync(join(root, p), 'utf8') as string } catch { return undefined } };
  const choice = await choiceFor(cart, model, 'Tidy', read, root);
  assert.equal(choice.title, 'Use the "Tidy" version of Cart');
  assert.deepEqual(choice.changes.map((c) => c.path), ['src/Cart.tsx']);
  assert.match(choice.changes[0].after!, /export function Cart\(\) \{ return <div className="bg-indigo-600"><Button>Pay now<\/Button><\/div> \}/);
  await assert.rejects(choiceFor(cart, model, 'Nope', read, root), /There's no version Nope of Cart/);
});

test('playground: a version\'s label leaves out the component\'s name', () => {
  assert.equal(versionLabel('EntityNodeAccentSpine', 'EntityNode'), 'Accent spine');
  assert.equal(versionLabel('Compact', 'Cart'), 'Compact');
  assert.equal(versionLabel('Cartography', 'Cart'), 'Cartography');
});
