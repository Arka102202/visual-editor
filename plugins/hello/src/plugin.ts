// The Hello plugin itself (no VS Code imports, so it can be tested on its own).

import { CONTRACT_VERSION, type Plugin } from '@visual-editor/contract';

const FILES = ['package.json', 'README.md'];

export const helloPlugin: Plugin = {
  id: 'hello',
  name: 'Hello',
  version: '0.1.0',
  contract: CONTRACT_VERSION,
  description: 'An example plugin: adds one card to show that plugins work.',
  detect: () => ({ reason: 'Hello works with any folder.' }),
  maps: [{ id: 'hello', title: 'Hello', description: 'One card from the example plugin.' }],
  // What a plugin gives assistants (Claude Code): a tool it calls, know-how, and a job done by a worker and a checker.
  tools: [
    {
      name: 'hello_files',
      title: 'Count the project’s files',
      summary: 'Counts the files in your project (an example tool).',
      description: 'How many files the project has (the example plugin’s tool).',
      input: { ending: { type: 'string', description: 'Only files ending with this, e.g. ".md"', optional: true } },
      run: ({ ending }, { project }) => {
        const files = project.files.filter((f) => typeof ending !== 'string' || f.endsWith(ending));
        return `${project.name} has ${files.length} file(s)${typeof ending === 'string' ? ` ending with ${ending}` : ''}.`;
      },
    },
  ],
  skills: [
    {
      name: 'hello-greetings',
      title: 'How to say hello',
      summary: 'An example skill: how to greet in this project.',
      description: 'How to greet in this project (the example plugin’s know-how). Use when asked to say hello.',
      text: 'Greet in one short, friendly line, and say how many files the project has (the hello_files tool).',
    },
  ],
  agents: [
    {
      name: 'hello-note',
      title: 'Write a hello note',
      summary: 'An example agent: writes a one-line hello note for the README.',
      description: 'Drafts a one-line hello note for the README (the example plugin’s agent).',
      worker: { prompt: 'Draft one friendly line to add to the README that says hello and how many files the project has (use hello_files).', tools: ['hello_files', 'Read'] },
      checker: { prompt: 'Check the draft is a single friendly line, and that its file count matches hello_files.', tools: ['hello_files'] },
      rounds: 2,
    },
  ],
  readers: [
    {
      id: 'hello',
      wants: (path) => FILES.includes(path),
      read: (files, project) => ({
        items: [
          {
            id: 'hello:card',
            map: 'hello',
            kind: 'example',
            label: `Hello, ${project.name}`,
            sub: `${project.files.length} files in this project`,
            fields: files.map((f) => ({ name: f.path, value: `${f.text.split('\n').length} lines` })),
            // (The file it's read from: "Open code" opens it, and a summary describes it.)
            ...(files[0] ? { source: { path: files[0].path } } : {}),
          },
        ],
      }),
    },
  ],
};
