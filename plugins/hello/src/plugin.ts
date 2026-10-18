// The Hello plugin itself (no VS Code imports, so it can be tested on its own).

import { CONTRACT_VERSION, type Plugin } from '@visual-editor/contract';

export const helloPlugin: Plugin = {
  id: 'hello',
  name: 'Hello',
  version: '0.1.0',
  contract: CONTRACT_VERSION,
  description: 'An example plugin: adds one card to show that plugins work.',
  detect: () => ({ reason: 'Hello works with any folder.' }),
  maps: [{ id: 'hello', title: 'Hello', description: 'One card from the example plugin.' }],
  readers: [
    {
      id: 'hello',
      wants: (path) => path === 'package.json' || path === 'README.md',
      read: (files, project) => ({
        items: [
          {
            id: 'hello:card',
            map: 'hello',
            kind: 'example',
            label: `Hello, ${project.name}`,
            sub: `${project.files.length} files in this project`,
            fields: files.map((f) => ({ name: f.path, value: `${f.text.split('\n').length} lines` })),
          },
        ],
      }),
    },
  ],
};
