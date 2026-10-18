import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PREVIEW_DIR } from '../src/preview/harness';
import { forgetRecordings, record, RECORDINGS_FILE, withRecordings } from '../src/preview/recordings';

test('recordings: real replies filed under the known request, used before worked-out ones, forgotten on request', () => {
  const root = mkdtempSync(join(tmpdir(), 've-rec-'));
  try {
    assert.equal(record(root, 'http://visual-editor.localhost:5200/api/orders/1042?x=1', { id: '1042', total: 12 }, ['/api/orders', '/api/orders/']), '/api/orders/');
    assert.equal(record(root, '/api/stats', { visits: 7 }, []), '/api/stats');
    const rules = withRecordings(root, [
      { match: '/api/orders/', reply: { id: 'made-up' } },
      { match: '/api/orders', reply: [] },
    ]);
    assert.deepEqual(rules.find((r) => r.match === '/api/orders/')?.reply, { id: '1042', total: 12 });
    assert.deepEqual(rules.find((r) => r.match === '/api/orders')?.reply, []);
    assert.deepEqual(rules.find((r) => r.match === '/api/stats')?.reply, { visits: 7 });
    // Only the data is kept: no headers, cookies or tokens anywhere in the file.
    const text = readFileSync(join(root, PREVIEW_DIR, RECORDINGS_FILE), 'utf8');
    assert.doesNotMatch(text, /authorization|cookie|bearer/i);
    forgetRecordings(root);
    assert.deepEqual(withRecordings(root, []), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
