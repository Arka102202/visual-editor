// The tools Claude Code (or any MCP assistant) gets from the hub: read the map, the rules and the memory; propose
// changes, which wait in Review for the developer's OK; and remember notes, rules and decisions.
// No VS Code APIs here: everything comes through `HubHost`, so it can be tested with a real MCP client.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Item } from '@visual-editor/contract';
import { forCard, rulesText, type MemoryEntry } from '../memory';
import type { ProjectState } from '../projectIndex';
import { newId, parseProposal, type Proposal } from '../proposals';
import type { CardPicture, PictureOptions } from '../cardPictures';

export const SERVER_NAME = 'visual-editor';

/** What the hub needs from the shell. */
export interface HubHost {
  projects(): ProjectState[];
  /** The project on the map, used when a tool isn't told which one. */
  current(): ProjectState | undefined;
  /** Waits (up to `ms`) until the projects have been read once. */
  whenReady(ms: number): Promise<void>;
  proposals(root: string): Proposal[];
  memory(root: string): MemoryEntry[];
  /** A file's text as the developer sees it (unsaved edits included), or undefined when it doesn't exist. */
  readFile(root: string, path: string): Promise<string | undefined>;
  /** Saves a new proposal; Review shows it and tells the developer. */
  propose(root: string, p: Proposal): void;
  remember(root: string, e: MemoryEntry): void;
  /** Pictures of a card as its plugin draws it (saved in the project); undefined when pictures can't be taken here. */
  pictures?(root: string, id: string, opts: PictureOptions): Promise<CardPicture[]>;
}

/** Assistants send technical names ("claude-code"); show them nicely. */
export function friendlyClient(name: string): string {
  // Claude Code in a terminal says "claude-code"; its editor extensions use similar names.
  return /claude/i.test(name) ? 'Claude Code' : name;
}

/** Told to every assistant when it connects. */
export const INSTRUCTIONS = `Visual Editor keeps a live map of this project (cards for components, routes, tables… with lines
between them), its rules and decisions, and the history of reviewed changes.
- Start with overview. Use list_cards and card instead of searching files for what exists and how it connects.
- Read memory before proposing anything, and follow its rules.
- NEVER edit files directly. Every change goes through propose_change: the developer sees it in Review and approves,
  sends it back with a note, or rejects it. Then call proposal_status; if it was sent back, read the note and propose
  again.
- When you and the developer agree on something worth keeping, call remember.
- To see how a card looks (and its other versions), call pictures. Look before saying a change to what people see is
  done, and fix what looks wrong first.
Card ids look like "react:component:src/Card.tsx#Card". Several projects may be open: pass project (its name) when it
matters; otherwise the one on the map is used.`;

const READY_WAIT_MS = 5000;
const STATUS_WORDS: Record<Proposal['status'], string> = { proposed: 'waiting for review', applied: 'approved and applied', rejected: 'rejected', 'sent-back': 'sent back', undone: 'applied, then undone' };

export function createHubServer(host: HubHost, version = '0.0.1', client = 'Assistant'): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version }, { instructions: INSTRUCTIONS });
  const readOnly = { readOnlyHint: true, openWorldHint: false };
  const reply = (text: string) => ({ content: [{ type: 'text' as const, text }] });
  const fail = (text: string) => ({ content: [{ type: 'text' as const, text }], isError: true });
  const projectArg = z.string().optional().describe('Project name (from overview); default: the one on the map');

  /** The project a tool is about: by name or folder, else the one on the map. */
  const pick = async (name?: string): Promise<ProjectState | string> => {
    await host.whenReady(READY_WAIT_MS);
    const all = host.projects();
    if (!all.length) return 'No folder is open in VS Code.';
    if (!name) return host.current() ?? all[0];
    return all.find((s) => s.project.name === name || s.project.root === name) ?? `No project named "${name}". Projects: ${all.map((s) => s.project.name).join(', ')}.`;
  };

  server.registerTool(
    'overview',
    {
      title: 'Project overview',
      description: 'Start here. The projects open in VS Code, which plugins understand each, what is on their maps, waiting proposals, and the rules to follow.',
      annotations: readOnly,
    },
    async () => {
      await host.whenReady(READY_WAIT_MS);
      const shown = host.current()?.project.root;
      const all = host.projects();
      if (!all.length) return reply('No folder is open in VS Code.');
      const out: string[] = [];
      for (const s of all) {
        const p = s.project;
        out.push(`## ${p.name}${p.root === shown ? ' (on the map)' : ''}${p.group && p.group !== p.name ? ` · part of ${p.group}` : ''}`);
        out.push(`Folder: ${p.root} · ${p.files.length} files`);
        if (s.detected.length) out.push(`Plugins: ${s.detected.map((d) => `${d.plugin.name} (${d.reason})`).join('; ')}`);
        else out.push('No plugin understands this project yet, so its map is empty.');
        const byMap = new Map<string, number>();
        for (const i of s.items) byMap.set(i.map, (byMap.get(i.map) ?? 0) + 1);
        const titles = new Map(s.detected.flatMap((d) => d.plugin.maps ?? []).map((m) => [m.id, m.title]));
        if (byMap.size) out.push(`Map: ${[...byMap].map(([m, n]) => `${titles.get(m) ?? m} ${n}`).join(', ')} cards; ${s.links.length} lines`);
        const waiting = host.proposals(p.root).filter((x) => x.status === 'proposed').length;
        if (waiting) out.push(`${waiting} proposal(s) waiting for review.`);
        const rules = rulesText(host.memory(p.root));
        if (rules) out.push(rules);
        out.push('');
      }
      return reply(out.join('\n').trim());
    },
  );

  server.registerTool(
    'list_cards',
    {
      title: 'List cards on the map',
      description: 'Cards on a project\'s map (components, routes, tables…), optionally filtered. Returns id, kind, name and file for each; use card for details.',
      inputSchema: {
        project: projectArg,
        search: z.string().optional().describe('Part of a name or file path'),
        kind: z.string().optional().describe('e.g. component, route, table'),
        map: z.string().optional().describe('A map id'),
        page: z.number().int().min(1).optional().describe('Which 200 to show (1: the first 200, 2: the next…)'),
      },
      annotations: readOnly,
    },
    async ({ project, search, kind, map, page = 1 }) => {
      const s = await pick(project);
      if (typeof s === 'string') return fail(s);
      const q = search?.toLowerCase();
      const found = s.items.filter(
        (i) => (!kind || i.kind === kind) && (!map || i.map === map) && (!q || i.label.toLowerCase().includes(q) || i.source?.path.toLowerCase().includes(q) || i.id.toLowerCase().includes(q)),
      );
      if (!found.length) return reply(s.items.length ? 'No cards match.' : 'This project has no cards yet (no plugin found anything).');
      // A page at a time, so a big project (thousands of cards) never floods the conversation.
      const PER_PAGE = 200;
      const pages = Math.ceil(found.length / PER_PAGE);
      const from = (Math.min(page, pages) - 1) * PER_PAGE;
      const lines = found.slice(from, from + PER_PAGE).map((i) => `${i.id} · ${i.kind} · ${i.label}${i.source ? ` · ${i.source.path}${i.source.line ? `:${i.source.line}` : ''}` : ''}`);
      const where = pages > 1 ? `, page ${Math.min(page, pages)} of ${pages} (${from + 1}–${from + lines.length})${page < pages ? '. Narrow it with search, kind or map, or ask for the next page' : ''}` : '';
      return reply(`${found.length} card(s)${where}:\n${lines.join('\n')}`);
    },
  );

  server.registerTool(
    'card',
    {
      title: 'One card in detail',
      description: 'Everything about one card: its rows (props, columns…), where it is defined, its lines to other cards, notes on it and the reviewed changes that touched it.',
      inputSchema: { id: z.string().describe('The card id, from list_cards'), project: projectArg },
      annotations: readOnly,
    },
    async ({ id, project }) => {
      const s = await pick(project);
      if (typeof s === 'string') return fail(s);
      const item = s.items.find((i) => i.id === id);
      if (!item) return fail(`No card "${id}" in ${s.project.name}. Use list_cards to find it.`);
      const label = (other: string) => s.items.find((i: Item) => i.id === other)?.label ?? other;
      const out = [`${item.label} (${item.kind})${item.sub ? ` · ${item.sub}` : ''}`];
      if (item.source) out.push(`Defined in ${item.source.path}${item.source.line ? `:${item.source.line}` : ''}`);
      if (item.fields?.length) out.push('Rows:', ...item.fields.map((f) => `- ${f.name}${f.value ? `: ${f.value}` : ''}${f.tag ? ` [${f.tag}]` : ''}`));
      const out1 = s.links.filter((l) => l.from === id);
      const in1 = s.links.filter((l) => l.to === id);
      if (out1.length) out.push('Lines out:', ...out1.map((l) => `- ${l.kind} → ${label(l.to)} (${l.to})`));
      if (in1.length) out.push('Lines in:', ...in1.map((l) => `- ${label(l.from)} (${l.from}) ${l.kind} it`));
      const remembered = forCard(host.memory(s.project.root), item);
      if (remembered.length) out.push('Remembered:', ...remembered.slice(0, 15).map(entryLine));
      return reply(out.join('\n'));
    },
  );

  server.registerTool(
    'pictures',
    {
      title: 'Pictures of a card',
      description:
        "How a card looks, drawn by its plugin (as in the Preview tab): pictures at mobile, tablet and desktop width, in the situations asked for (normal, empty, loading, error…; 'all' for every one), and its other versions next to it when versions is true. Saved in .visual-editor/pictures/ too. Use it to check your own changes to what people see.",
      inputSchema: {
        id: z.string().describe('The card id, from list_cards'),
        project: projectArg,
        situations: z.union([z.array(z.string()), z.literal('all')]).optional().describe("Situations to draw it in; default its first (usually normal); 'all' for every one"),
        sizes: z.array(z.enum(['mobile', 'tablet', 'desktop'])).optional().describe('Default: all three'),
        versions: z.boolean().optional().describe('Its other versions too, next to how it is now'),
        theme: z.enum(['light', 'dark']).optional(),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ id, project, situations, sizes, versions, theme }) => {
      const s = await pick(project);
      if (typeof s === 'string') return fail(s);
      if (!host.pictures) return fail('Pictures can\'t be taken here.');
      if (!s.items.some((i) => i.id === id)) return fail(`No card "${id}" in ${s.project.name}. Use list_cards to find it.`);
      try {
        const pics = await host.pictures(s.project.root, id, { situations, sizes, versions, theme });
        const lines = pics.map((p) => `- ${p.label} · ${p.situation} · ${p.size}${p.width ? ` (${p.width}×${p.height})` : ''}${p.file ? ` → ${p.file}` : ''}${p.error ? ` · problem: ${p.error}` : ''}`);
        const images = pics.filter((p) => p.png).slice(0, 12);
        return {
          content: [
            { type: 'text' as const, text: [`${pics.length} picture${pics.length === 1 ? '' : 's'}${images.length < pics.filter((p) => p.png).length ? ` (the first ${images.length} shown; the rest are in the files)` : ''}:`, ...lines].join('\n') },
            ...images.map((p) => ({ type: 'image' as const, data: p.png!.toString('base64'), mimeType: 'image/png' })),
          ],
        };
      } catch (e) {
        return fail(e instanceof Error ? e.message : String(e));
      }
    },
  );

  server.registerTool(
    'memory',
    {
      title: 'Rules, decisions and history',
      description: "The project's rules (follow them), decisions with their reasons, and recent reviewed changes with the developer's notes. Read before proposing changes.",
      inputSchema: { project: projectArg },
      annotations: readOnly,
    },
    async ({ project }) => {
      const s = await pick(project);
      if (typeof s === 'string') return fail(s);
      const all = host.memory(s.project.root);
      const rules = rulesText(all);
      const changes = all.filter((e) => e.kind === 'change').slice(0, 15);
      const notes = all.filter((e) => e.kind === 'note').slice(0, 15);
      const out = [rules || 'No rules or decisions yet.'];
      if (notes.length) out.push('', 'Notes:', ...notes.map(entryLine));
      if (changes.length) out.push('', 'Recent reviewed changes:', ...changes.map(entryLine));
      return reply(out.join('\n'));
    },
  );

  server.registerTool(
    'propose_change',
    {
      title: 'Propose a change',
      description:
        'The only way to change code. Give each file\'s complete new content (or null to remove it). It waits in Review until the developer approves, sends it back or rejects it; nothing changes before that. Then check proposal_status.',
      inputSchema: {
        title: z.string().describe('Short, plain words: what changes, e.g. "Add an onOpen callback to PostCard"'),
        why: z.string().describe('Why, in plain words, for the developer'),
        changes: z
          .array(z.object({ path: z.string().describe('Relative to the project folder'), content: z.string().nullable().describe('The whole new file, or null to remove it') }))
          .min(1),
        cards: z.array(z.string()).optional().describe('Card ids this is about, so the map marks them'),
        project: projectArg,
      },
    },
    async ({ title, why, changes, cards, project }) => {
      const s = await pick(project);
      if (typeof s === 'string') return fail(s);
      const root = s.project.root;
      const files = [];
      for (const c of changes) {
        const before = (await host.readFile(root, c.path)) ?? null;
        if (before === null && c.content === null) return fail(`${c.path} doesn't exist, so it can't be removed.`);
        if (before === c.content) return fail(`${c.path} would stay the same; leave it out.`);
        files.push({ path: c.path, before, after: c.content });
      }
      const now = new Date().toISOString();
      const checked = parseProposal(
        JSON.stringify({ id: newId(), title, why, by: { kind: 'assistant', name: client }, createdAt: now, status: 'proposed', changes: files, items: cards, history: [{ at: now, status: 'proposed' }] }),
        newId(),
      );
      if (typeof checked === 'string') return fail(checked);
      host.propose(root, checked);
      return reply(`Proposal ${checked.id} is waiting in Review for the developer. Nothing has changed yet. Call proposal_status with id "${checked.id}" to see what they decided.`);
    },
  );

  server.registerTool(
    'proposal_status',
    {
      title: 'What happened to a proposal',
      description: 'Whether a proposal is still waiting, was approved and applied, sent back (with the developer\'s note: revise and propose again) or rejected. Without an id, lists recent proposals.',
      inputSchema: { id: z.string().optional(), project: projectArg },
      annotations: readOnly,
    },
    async ({ id, project }) => {
      const s = await pick(project);
      if (typeof s === 'string') return fail(s);
      const all = host.proposals(s.project.root);
      if (!id) return reply(all.length ? all.slice(0, 15).map((p) => `${p.id} · ${STATUS_WORDS[p.status]} · ${p.title}`).join('\n') : 'No proposals yet.');
      const p = all.find((x) => x.id === id);
      if (!p) return fail(`No proposal "${id}" in ${s.project.name}.`);
      const note = [...p.history].reverse().find((h) => h.note)?.note;
      return reply(`${p.title}: ${STATUS_WORDS[p.status]}.${note ? `\nThe developer's note: "${note}"` : ''}${p.status === 'sent-back' ? '\nRevise it and call propose_change again.' : ''}`);
    },
  );

  server.registerTool(
    'remember',
    {
      title: 'Remember something',
      description: "Keeps a note, rule or decision in the project's memory (the developer sees it and can remove it). Only for what you and the developer agreed on; never invent rules.",
      inputSchema: {
        kind: z.enum(['note', 'rule', 'decision']),
        text: z.string().describe('One sentence'),
        why: z.string().optional().describe('For decisions: the reasons'),
        cards: z.array(z.string()).optional().describe('Card ids it is about'),
        project: projectArg,
      },
    },
    async ({ kind, text, why, cards, project }) => {
      const s = await pick(project);
      if (typeof s === 'string') return fail(s);
      if (!text.trim()) return fail('Say what to remember.');
      const paths = (cards ?? []).map((c) => s.items.find((i) => i.id === c)?.source?.path).filter((p): p is string => !!p);
      host.remember(s.project.root, {
        id: newId(),
        at: new Date().toISOString(),
        kind,
        text: text.trim(),
        ...(why ? { detail: why } : {}),
        by: { kind: 'assistant', name: client },
        ...(cards?.length ? { items: cards } : {}),
        ...(paths.length ? { paths } : {}),
      });
      return reply(`Remembered (${kind}): ${text.trim()}`);
    },
  );

  return server;
}

function entryLine(e: MemoryEntry): string {
  const what = e.kind === 'change' ? (e.outcome === 'sent-back' ? 'sent back' : e.outcome ?? 'applied') : e.kind;
  return `- [${what}] ${e.text}${e.detail ? ` (${e.detail})` : ''}${e.note ? ` · developer's note: "${e.note}"` : ''} · ${e.by.name}, ${e.at.slice(0, 10)}`;
}
