// The React plugin itself (no VS Code imports, so it can be tested on its own): finds React projects, reads their
// components, pages and API calls, and gives the shell three maps.

import { CONTRACT_VERSION, type MapDefinition, type Plugin } from '@visual-editor/contract';
import { ReactPreviews } from './preview/previewer';
import { reactPackage, SHARED_FROM_WORDS, wantsFile } from './cards';
import { readingWorker } from './workerClient';

export * from './cards';

/** Previews of components (one per window: it keeps the dev servers it started). */
export const previews = new ReactPreviews();

export const MAPS: MapDefinition[] = [
  {
    id: 'components',
    title: 'Components',
    description: 'Every component with its props; lines show what renders what.',
    kinds: {
      page: 'A whole screen: the component a route shows when someone opens its address.',
      layout: 'The frame around pages (header, sidebar, menus), with the page shown inside it.',
      shared: `A common building block, used by ${SHARED_FROM_WORDS} other components. Changing it changes all of them.`,
      'uses data': 'Talks to data: it calls an API, or reads a store, context or database.',
      component: 'A plain piece of the screen: it shows what it is given and has no data of its own.',
    },
    lines: {
      renders: 'The first component draws the second one inside itself.',
      uses: 'The first component passes the second one on without drawing it itself (for example as a node type or a route element).',
    },
  },
  {
    id: 'pages',
    title: 'Pages',
    description: 'The routes of the app; lines show which page sits inside which.',
    kinds: { route: 'An address in the app, like /settings, and the screen it opens.' },
    lines: { contains: 'The second route sits inside the first: its address starts with the first one.' },
  },
  {
    id: 'api',
    title: 'API calls',
    description: 'Each address the app calls, which components call it, and when (on load or on a click).',
    kinds: { 'api call': 'An address the app calls on a server, like GET /api/orders, with the components that call it.' },
  },
];

export const reactPlugin: Plugin = {
  id: 'react',
  name: 'React',
  version: '0.1.0',
  contract: CONTRACT_VERSION,
  description: 'Components and their props, pages, and API calls, for React apps.',
  detect: (project) => {
    const pkg = reactPackage(project);
    return pkg ? { reason: `${pkg} is in package.json` } : undefined;
  },
  maps: MAPS,
  readers: [
    {
      id: 'react',
      wants: wantsFile,
      // Read in a worker thread (in VS Code), so a big project never freezes the editor.
      read: async (files, project) => {
        const { model, result } = await readingWorker.read(files);
        previews.remember(project.root, model, files);
        return result;
      },
    },
  ],
  previews: [previews.previewer],
};
