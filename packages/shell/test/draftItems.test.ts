import assert from 'node:assert/strict';
import test from 'node:test';
import { CONTRACT_VERSION, type Plugin, type ProjectInfo } from '@visual-editor/contract';
import { draftItems } from '../src/draftItems';
import type { Draft } from '../src/drafts';
import { parseEvidence } from '../src/proposals';
import type { ProjectState } from '../src/projectIndex';

test('draft items: plugins read the draft’s files over the real ones, told it is a draft', async () => {
  const seen: { files: string[]; draft?: string }[] = [];
  const plugin: Plugin = {
    id: 'react', name: 'React', version: '0', contract: CONTRACT_VERSION, detect: () => ({ reason: 'r' }),
    readers: [{ id: 'r', wants: (p) => p.endsWith('.tsx'), read: (files, project: ProjectInfo) => {
      seen.push({ files: files.map((f) => `${f.path}=${f.text}`), draft: project.draft });
      return { items: files.map((f) => ({ id: `react:${f.path}`, map: 'components', kind: 'component', label: f.path })) };
    } }],
  };
  const state = { project: { root: '/p', name: 'p', files: ['a.tsx', 'b.tsx', 'c.css'] }, detected: [{ plugin, reason: 'r' }], items: [], links: [], cards: {}, problems: [] } as unknown as ProjectState;
  const draft: Draft = { id: 'd1', title: 't', why: 'w', by: { kind: 'assistant', name: 'C' }, createdAt: '', updatedAt: '', status: 'draft', revision: 2, evidence: [],
    changes: [{ path: 'a.tsx', before: 'A', after: 'A2' }, { path: 'b.tsx', before: 'B', after: null }, { path: 'n.tsx', before: null, after: 'N' }] };
  const real: Record<string, string> = { 'a.tsx': 'A', 'b.tsx': 'B', 'c.css': 'C' };
  const { project, items } = await draftItems(state, draft, async (p) => real[p]);
  assert.deepEqual(seen, [{ files: ['a.tsx=A2', 'n.tsx=N'], draft: 'd1' }]);
  assert.deepEqual(project.files, ['a.tsx', 'c.css', 'n.tsx']);
  assert.deepEqual(items.map((i) => i.id), ['react:a.tsx', 'react:n.tsx']);
});

test('proof read from a file: a picture only from a draft’s own folder', () => {
  const base = { kind: 'picture', title: 'P', text: 't', by: 'Visual Editor', at: '', revision: 1 };
  assert.equal(parseEvidence([{ ...base, image: '.visual-editor/drafts/d1/Card-v1.png' }])[0].image, '.visual-editor/drafts/d1/Card-v1.png');
  for (const bad of ['../secret.png', '/etc/x.png', '.visual-editor/drafts/../../x.png', 'src/a.png', '.visual-editor/drafts/d1/x.svg']) assert.equal(parseEvidence([{ ...base, image: bad }])[0].image, undefined, bad);
  assert.deepEqual(parseEvidence([{ kind: 'other', title: 'x', text: 'y' }, null]), []);
});
