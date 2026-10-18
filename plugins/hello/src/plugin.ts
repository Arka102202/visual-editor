// The Hello plugin itself (no VS Code imports, so it can be tested on its own).

import { CONTRACT_VERSION, type Plugin, type PreviewRequest } from '@visual-editor/contract';

const FILES = ['package.json', 'README.md'];

/** The card as a small page: the project's name and its files with their line counts. */
async function helloPage(req: PreviewRequest): Promise<{ html: string }> {
  const rows = req.situation === 'empty' ? [] : (await Promise.all(FILES.map(async (f) => [f, await req.read(f)] as const))).filter(([, t]) => t !== undefined);
  const dark = req.theme === 'dark';
  const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
  const list = rows.length
    ? `<ul>${rows.map(([f, t]) => `<li><span>${esc(f)}</span><b>${t!.split('\n').length} lines</b></li>`).join('')}</ul>`
    : '<p class="none">No files to show.</p>';
  return {
    html: `<!doctype html><html><head><meta charset="utf-8"><style>
body{margin:0;padding:24px;font:15px/1.5 system-ui,sans-serif;background:${dark ? '#1e1e1e' : '#fff'};color:${dark ? '#ddd' : '#222'}}
.card{max-width:520px;margin:auto;border-radius:12px;padding:20px 24px;background:${dark ? '#2b2d30' : '#f5f6f8'};box-shadow:0 2px 8px #0002}
h1{font-size:22px;margin:0 0 4px}small{opacity:.65}ul{list-style:none;padding:0;margin:16px 0 0}
li{display:flex;justify-content:space-between;padding:8px 0;border-top:1px solid #8883}.none{opacity:.6;margin-top:16px}
</style></head><body><div class="card"><h1>Hello, ${esc(req.project.name)}</h1><small>${req.project.files.length} files · ${req.width}px wide</small>${list}</div></body></html>`,
  };
}

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
          },
        ],
      }),
    },
  ],
  previews: [{ id: 'hello', wants: (item) => item.id === 'hello:card', situations: () => ['normal', 'empty'], render: helloPage }],
};
