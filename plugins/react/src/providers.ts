// The project's providers for previews (docs/variants.md): src/visual-editor.providers.tsx, what every preview is wrapped
// in. It's the project's own file (a theme, …), so Visual Editor only proposes it, when a preview needs something it
// can give: a router in memory, for pages with links (links in a preview then show where they'd go, and stay).

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ProjectInfo, ProposedChange } from '@visual-editor/contract';
import { providersFile } from './previewPage';

export const PROVIDERS_PATH = 'src/visual-editor.providers.tsx';

/** What a preview needs, from what stopped it (an error's words): "router", or nothing known. */
export function needOf(text: string): 'router' | undefined {
  return /context of a <Router>|may be used only in the context of a <Router>|useHref\(\)|useNavigate\(\) may be used only|useLocation\(\) may be used only|<Link> outside a <Router>|property 'basename'|reading 'basename'/i.test(text) ? 'router' : undefined;
}

export function previewFix(project: ProjectInfo, need: string, read: (p: string) => string | undefined = (p) => (existsSync(join(project.root, p)) ? readFileSync(join(project.root, p), 'utf8') : undefined)): ProposedChange | string {
  if (need !== 'router') return `Visual Editor doesn't know how to give previews “${need}”.`;
  const deps = { ...(project.packageJson?.dependencies ?? {}), ...(project.packageJson?.devDependencies ?? {}) } as Record<string, string>;
  const from = deps['react-router-dom'] ? 'react-router-dom' : deps['react-router'] ? 'react-router' : undefined;
  if (!from) return 'Something in this preview needs a router, but the project has no react-router: add the router your app uses to src/visual-editor.providers.tsx.';
  const existing = providersFile(project);
  if (existing) return `${existing} is there already: add a router to it (MemoryRouter from '${from}'), so links work in previews.`;
  if (read(PROVIDERS_PATH) !== undefined) return `${PROVIDERS_PATH} is there already: add a router to it (MemoryRouter from '${from}').`;
  return {
    title: 'Previews: a router in memory, for pages with links',
    why: `Links (and anything else from ${from}) only work inside a router; previews had none, so this page stopped drawing. This file wraps every preview in a router held in memory: links show where they'd go, and the preview stays on its one page. It's your file: add what else previews need (a theme, …).`,
    changes: [
      {
        path: PROVIDERS_PATH,
        before: null,
        after: `// What every Visual Editor preview (Preview, Playground) is wrapped in. Your file: add what previews need, such as a theme.
// The app itself doesn't use it.
import type { ReactNode } from 'react'
import { MemoryRouter } from '${from}'

export default function PreviewProviders({ children }: { children: ReactNode }) {
  return <MemoryRouter>{children}</MemoryRouter>
}
`,
      },
    ],
  };
}
