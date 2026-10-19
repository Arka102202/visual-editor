import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nodeLookups } from '../src/preview/flow';

test('flow: a panel that looks up "its" node finds it by an id it is given, and reads its data as a type', () => {
  const text = `import { useNodes, useReactFlow } from '@xyflow/react'
import type { EntityNode } from '@entity'
export const useEntityInspector = ({ nodeId }: { nodeId: string }) => {
  const rfNodes = useNodes()
  const { getNodes } = useReactFlow()
  const rfNode = rfNodes.find(n => n.id === nodeId)
  const node = (rfNode?.data as unknown as EntityNode | undefined) ?? null
  const field = node?.fields.find((f) => f.id === fieldId)
  const other = getNodes().find((n) => { return otherId === n.id })
  return { node, field, other }
}`;
  const found = nodeLookups('src/useEntityInspector.ts', text);
  assert.deepEqual(found.map((f) => f.idFrom), ['nodeId', 'otherId']);
  // The typed variable is "node" (not the whole hook that contains it).
  assert.equal(text.slice(found[0].dataAt!, found[0].dataAt! + 4), 'node');
  assert.equal(found[1].dataAt, undefined);
  assert.deepEqual(nodeLookups('a.ts', 'const x = list.find((n) => n.id === id)'), []);
});
