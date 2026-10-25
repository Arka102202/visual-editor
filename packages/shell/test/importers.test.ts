import assert from 'node:assert/strict';
import test from 'node:test';
import { importersOf } from '../src/importers';

test('importers: the files that import what a change added or removed (an index file by its folder)', () => {
  const files = [
    { path: 'src/components/shared/index.ts', text: "export { ThemeToggle } from './ThemeToggle'\nexport { Toggle } from './Toggle'\n" },
    { path: 'src/pages/Editor/EditorHeader.tsx', text: "import { ThemeToggle } from '@components/shared/ThemeToggle'\n" },
    { path: 'src/pages/Lazy.tsx', text: "const T = lazy(() => import('../components/shared/ThemeToggle/ThemeToggle.tsx'))\n" },
    { path: 'src/pages/Other.tsx', text: "import { ThemeToggleIcon } from './ThemeToggleIcon'\n// ThemeToggle is mentioned here\n" },
    { path: 'src/components/shared/ThemeToggle/ThemeToggle.data.tsx', text: "import { useThemeToggle } from './useThemeToggle'\n" },
  ];
  assert.deepEqual(
    importersOf(['src/components/shared/ThemeToggle/index.ts', 'src/components/shared/ThemeToggle/index.tsx', 'src/components/shared/ThemeToggle/ThemeToggle.tsx'], files),
    ['src/components/shared/index.ts', 'src/pages/Editor/EditorHeader.tsx', 'src/pages/Lazy.tsx'],
    'not a similar name, a mention in a comment, or a file of the change',
  );
  assert.deepEqual(importersOf(['README.md'], files), []);
});
