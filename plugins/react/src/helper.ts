// Visual Editor's helper in a project (src/visual-editor.tsx, docs/variants.md): added when it's missing, updated when
// it's older than the one this plugin ships (runtime/visual-editor.tsx), always as a change to review.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ProjectInfo, ProposedChange } from '@visual-editor/contract';
import { helperFile } from './previewPage';

/** The helper this plugin ships (next to its built code, or in the source tree when running tests). */
export function helperTemplate(): string | undefined {
  const at = [join(__dirname, '..', 'runtime', 'visual-editor.tsx'), join(__dirname, '..', '..', 'runtime', 'visual-editor.tsx'), join(process.cwd(), 'plugins', 'react', 'runtime', 'visual-editor.tsx')];
  const found = at.find((p) => existsSync(p));
  return found ? readFileSync(found, 'utf8') : undefined;
}

/** A helper's version (version 1 didn't say). */
export function helperVersion(text: string): number {
  const m = /export\s+const\s+HELPER_VERSION\s*=\s*(\d+)/.exec(text);
  return m ? Number(m[1]) : 1;
}

export function updateHelper(
  project: ProjectInfo,
  read: (path: string) => string | undefined = (p) => (existsSync(join(project.root, p)) ? readFileSync(join(project.root, p), 'utf8') : undefined),
  template: string | undefined = helperTemplate(),
): ProposedChange | string {
  if (!template) return 'Visual Editor’s helper couldn’t be found in the React plugin (reinstall it).';
  const path = helperFile(project) ?? 'src/visual-editor.tsx';
  const before = read(path);
  const next = helperVersion(template);
  if (before === undefined) {
    return {
      title: `Add Visual Editor’s helper (version ${next})`,
      why: 'Preview and the Playground need it: each previewable folder uses it to keep its designs apart from its data. It’s one file, used only by those folders; nothing else in the app changes.',
      changes: [{ path, before: null, after: template }],
    };
  }
  const now = helperVersion(before);
  if (before === template) return `Visual Editor’s helper is up to date (version ${now}).`;
  if (now > next) return `This project’s helper (version ${now}) is newer than the React plugin’s (version ${next}): update the plugin instead.`;
  return {
    title: now < next ? `Update Visual Editor’s helper (version ${now} → ${next})` : `Put Visual Editor’s helper back as it ships (version ${next})`,
    why:
      now < next
        ? 'Version 2 adds the static part as a working prototype (each tile keeps its own changes, Reset, links that show where they’d go instead of leaving) and situations (one design in use per situation). Folders made with version 1 keep working.'
        : 'The helper was changed by hand; this puts it back as Visual Editor ships it.',
    changes: [{ path, before, after: template }],
  };
}
