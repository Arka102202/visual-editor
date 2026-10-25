// The tools Claude Code (or any MCP assistant) gets from the hub: read the map, the rules and the memory; propose
// changes, which wait in Review for the developer's OK; and remember notes, rules and decisions.
// No VS Code APIs here: everything comes through `HubHost`, so it can be tested with a real MCP client.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { relative, sep } from 'node:path';
import { z } from 'zod';
import type { Item, Plugin, PluginAgent, PluginTool, ToolAnswer, ToolInput } from '@visual-editor/contract';
import { forCard, rulesText, type MemoryEntry } from '../memory';
import type { ProjectState } from '../projectIndex';
import { newId, parseProposal, safePath, type Evidence, type FileChange, type Proposal } from '../proposals';
import { draftView, type Draft } from '../drafts';
import { current, JOB_MINUTES, newJob, nextStep, type Job } from '../jobs';

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
  /** Every plugin's tools (registry.tools()). */
  tools(): { plugin: Plugin; tool: PluginTool }[];
  drafts(root: string): Draft[];
  saveDraft(root: string, d: Draft): void;
  jobs(root: string): Job[];
  saveJob(root: string, j: Job): void;
  /** Every plugin's agents (registry.agents()). */
  agents(): { plugin: Plugin; agent: PluginAgent }[];
  /**
   * A picture of a card's Playground as the draft would leave it (the draft's own app), saved as `image` (absolute
   * path). A string says why it can't be taken.
   */
  pictures?(root: string, draft: Draft, card: string): Promise<DraftPicture | string>;
  /** The cards that can be previewed which a draft changes (their ids), as it would leave the project. */
  cardsTouched?(root: string, draft: Draft): Promise<string[]>;
  /**
   * A page of the app (`path`, e.g. "/") pictured from the real files and from the draft's own app, and compared: the
   * pictures (absolute paths; `diff` has what differs in red) and how much differs. A string says why it can't.
   */
  compareApp?(root: string, draft: Draft, path: string): Promise<AppComparison | string>;
}

export interface AppComparison {
  before: string;
  after: string;
  diff: string;
  differing: number;
  total: number;
  sizes?: { before: [number, number]; after: [number, number] };
  problems: string[];
}

export interface DraftPicture {
  image: string;
  card: string;
  /** The card's id. */
  cardId: string;
  designs: string[];
  states: string[];
  tiles: number;
  problems: string[];
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
- Nothing reaches Review unless Visual Editor's checks pass on it (propose_change and submit_draft run them first; if
  one fails you get the problems to fix instead).
- For bigger jobs, work in a draft: save_draft keeps the files apart (nothing changes), plugin tools given its id
  (draft) look at the project as it would leave it, read_draft shows it, and submit_draft sends it to Review.
- Visual Editor's agents (a worker, then a checker) run as jobs: job_start, then follow job_status's next step.
- When you and the developer agree on something worth keeping, call remember.
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
        'The only way to change code. Give each file\'s complete new content (or null to remove it). Visual Editor checks it first (the plugins\' checks, and a picture of any component it changes that can be previewed): if a check fails, it does not go to Review and you get the problems to fix; if it passes, it waits in Review, with that proof, until the developer approves, sends it back or rejects it. Nothing changes before that. Then check proposal_status.',
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
      const files: FileChange[] = [];
      for (const c of changes) {
        const path = c.path.replace(/\\/g, '/').replace(/^\.\//, '');
        if (!safePath(path)) return fail(`${c.path} isn't a place in the project a change can go.`);
        const before = (await host.readFile(root, path)) ?? null;
        if (before === null && c.content === null) return fail(`${path} doesn't exist, so it can't be removed.`);
        if (before === c.content) return fail(`${path} would stay the same; leave it out.`);
        files.push({ path, before, after: c.content });
      }
      // Checked before it reaches Review, as a draft would be: the plugins' checks and pictures, kept as its proof.
      const now = new Date().toISOString();
      const d: Draft = { id: newId(), title, why, by: { kind: 'assistant', name: client }, createdAt: now, updatedAt: now, status: 'draft', changes: files, ...(cards?.length ? { items: cards } : {}), revision: 1, evidence: [] };
      host.saveDraft(root, d);
      const blocked = await provenOrWhy(s, d, 'call propose_change again with the corrected files');
      if (blocked) return fail(blocked);
      const sent = await submit(root, host.drafts(root).find((x) => x.id === d.id) ?? d);
      if (typeof sent === 'string') return fail(sent);
      const said = sent.evidence.map((e) => `${mark(e)} ${e.title}`).join('; ');
      return reply(`Proposal ${sent.proposal.id} is waiting in Review for the developer, with its proof: ${said}. Nothing has changed yet. Call proposal_status with id "${sent.proposal.id}" to see what they decided.`);
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

  /**
   * Proves a draft the way Visual Editor can on its own: every check its plugins have (on the project as the draft
   * leaves it), and a picture of each component it changes that can be previewed (up to 3). Returns the proof kept.
   */
  const proveDraft = async (s: ProjectState, d: Draft, missingOnly = false): Promise<Evidence[]> => {
    const root = s.project.root;
    const kept = () => (host.drafts(root).find((x) => x.id === d.id) ?? d).evidence.filter((e) => e.revision === d.revision);
    // (missingOnly: what was already run on this version, by Claude or before, isn't run again.)
    const ran = (title: string) => missingOnly && kept().some((e) => e.by === 'Visual Editor' && (e.title === title || e.title.startsWith(`${title} (`)));
    for (const { plugin, tool } of host.tools()) {
      if (!tool.checks || !s.detected.some((x) => x.plugin.id === plugin.id) || ran(tool.title)) continue;
      try {
        await runTool(s, tool, {}, d);
      } catch (e) {
        addProof(root, d, { kind: 'note', title: `${tool.title}: couldn't run`, text: `A bug in the ${plugin.name} plugin: ${e instanceof Error ? e.message : e}`, by: 'Visual Editor', at: new Date().toISOString(), revision: d.revision });
      }
    }
    // Pictures only for a change that passed its checks (a failed one goes back to be fixed first).
    if (kept().some((e) => e.passed === false)) return kept();
    const cards = (await host.cardsTouched?.(root, d).catch(() => [])) ?? [];
    for (const card of cards.slice(0, 3)) {
      if (missingOnly && kept().some((e) => e.kind === 'picture' && e.card === card)) continue;
      const p = await picture(root, d, card);
      if (typeof p === 'string') addProof(root, d, { kind: 'note', title: `No picture of ${card.split('#').pop()}`, text: p, by: 'Visual Editor', at: new Date().toISOString(), revision: d.revision });
    }
    return kept();
  };

  /**
   * The one rule for reaching Review: Visual Editor's checks ran on this version of the draft (any missing are run now)
   * and nothing on it failed. Undefined when it may go; else why not, with the problems to fix.
   */
  const provenOrWhy = async (s: ProjectState, d: Draft, again = 'save_draft with the draft id, then submit_draft again'): Promise<string | undefined> => {
    const proof = await proveDraft(s, d, true);
    const failed = proof.filter((e) => e.passed === false);
    if (failed.length) return [`Not sent to Review: ${failed.map((e) => e.title).join(', ')} did not pass.`, ...failed.map((e) => `--- ${e.title}\n${e.text}`), `Fix it (${again}; it is draft ${d.id}).`].join('\n');
    if (!proof.length) addProof(s.project.root, d, { kind: 'note', title: 'No checks apply to these files', text: 'None of Visual Editor\'s plugins check files like these.', by: 'Visual Editor', at: new Date().toISOString(), revision: d.revision });
    return undefined;
  };

  /** A draft to Review as a proposal, with its proof for its current version; a string says why not. */
  const submit = async (root: string, d: Draft): Promise<{ proposal: Proposal; evidence: Evidence[] } | string> => {
    if (d.status === 'submitted') return `Draft ${d.id} is already in Review as proposal ${d.proposal}.`;
    const moved: string[] = [];
    for (const c of d.changes) if (((await host.readFile(root, c.path)) ?? null) !== c.before) moved.push(c.path);
    if (moved.length) return `These files changed in the project since the draft was saved: ${moved.join(', ')}. Read them again, save the draft again with save_draft (draft: "${d.id}"), check it, then submit it.`;
    const now = new Date().toISOString();
    // Its proof goes with it: what was checked on this version.
    const evidence = d.evidence.filter((e) => e.revision === d.revision);
    const checked = parseProposal(
      JSON.stringify({ id: newId(), title: d.title, why: d.why, by: d.by, createdAt: now, status: 'proposed', changes: d.changes, items: d.items, history: [{ at: now, status: 'proposed' }], evidence }),
      newId(),
    );
    if (typeof checked === 'string') return checked;
    host.propose(root, checked);
    host.saveDraft(root, { ...d, status: 'submitted', proposal: checked.id, updatedAt: now });
    return { proposal: checked, evidence };
  };

  server.registerTool(
    'save_draft',
    {
      title: 'Save a draft',
      description:
        'Keeps proposed files apart as a draft, without changing anything in the project: for work that is checked before the developer sees it. Give each file\'s complete new content (or null to remove it). With draft (an id), changes that draft: these files replace or join its files. Plugin tools given the draft id look at the project as the draft would leave it; submit_draft sends it to Review.',
      inputSchema: {
        title: z.string().describe('Short, plain words: what changes'),
        why: z.string().describe('Why, in plain words, for the developer'),
        changes: z.array(z.object({ path: z.string().describe('Relative to the project folder'), content: z.string().nullable().describe('The whole new file, or null to remove it') })).min(1),
        cards: z.array(z.string()).optional().describe('Card ids it is about'),
        draft: z.string().optional().describe('A draft id to change, from an earlier save_draft'),
        project: projectArg,
      },
    },
    async ({ title, why, changes, cards, draft, project }) => {
      const s = await pick(project);
      if (typeof s === 'string') return fail(s);
      const root = s.project.root;
      const old = draft ? host.drafts(root).find((d) => d.id === draft) : undefined;
      if (draft && !old) return fail(`No draft "${draft}" in ${s.project.name}. Leave draft out to start a new one.`);
      if (old?.status === 'submitted') return fail(`Draft ${old.id} was already sent to Review (proposal ${old.proposal}). Save a new draft instead.`);
      const files = new Map((old?.changes ?? []).map((c) => [c.path, c]));
      for (const c of changes) {
        const path = c.path.replace(/\\/g, '/').replace(/^\.\//, '');
        if (!safePath(path)) return fail(`${c.path} isn't a place in the project a change can go.`);
        // What the file was when the draft first touched it (submit_draft checks it's still so).
        const before = files.get(path)?.before ?? (await host.readFile(root, path)) ?? null;
        if (before === null && c.content === null) return fail(`${path} doesn't exist, so it can't be removed.`);
        if (before === c.content) files.delete(path);
        else files.set(path, { path, before, after: c.content });
      }
      if (!files.size) return fail('Every file would stay the same: there is nothing to save.');
      const now = new Date().toISOString();
      const next = [...files.values()].sort((a, b) => a.path.localeCompare(b.path));
      // A new version when its files change: proof is about one version.
      const same = !!old && JSON.stringify(old.changes) === JSON.stringify(next);
      const revision = same ? old!.revision : (old?.revision ?? 0) + 1;
      const d: Draft = {
        id: old?.id ?? newId(),
        title,
        why,
        by: old?.by ?? { kind: 'assistant', name: client },
        createdAt: old?.createdAt ?? now,
        updatedAt: now,
        status: 'draft',
        changes: next,
        ...(cards?.length ? { items: cards } : old?.items ? { items: old.items } : {}),
        revision,
        evidence: old?.evidence ?? [],
      };
      host.saveDraft(root, d);
      const stale = old && !same && old.evidence.some((e) => e.revision === old.revision) ? '\nIts earlier proof was for the previous version: check it again.' : '';
      return reply(`Draft ${d.id} saved (version ${revision}): ${changeWords(d.changes)}. Nothing in the project changed.${stale}\nPlugin tools given draft "${d.id}" look at the project as it would leave it; checks among them are kept with it as proof for Review. read_draft shows it; submit_draft sends it to Review.`);
    },
  );

  server.registerTool(
    'read_draft',
    {
      title: 'Read a draft',
      description: 'A draft\'s title, why, files and their new content (or one file with path). Without an id, lists the drafts.',
      inputSchema: { id: z.string().optional(), path: z.string().optional().describe('Only this file'), project: projectArg },
      annotations: readOnly,
    },
    async ({ id, path, project }) => {
      const s = await pick(project);
      if (typeof s === 'string') return fail(s);
      const root = s.project.root;
      const all = host.drafts(root);
      if (!id) return reply(all.length ? all.slice(0, 20).map((d) => `${d.id} · ${d.status === 'submitted' ? `sent to Review (${d.proposal})` : 'draft'} · ${d.title} · ${changeWords(d.changes)}`).join('\n') : 'No drafts yet.');
      const d = all.find((x) => x.id === id);
      if (!d) return fail(`No draft "${id}" in ${s.project.name}.`);
      const out = [`${d.title} (${d.status === 'submitted' ? `sent to Review as proposal ${d.proposal}` : 'a draft'}, version ${d.revision}, by ${d.by.name})`, `Why: ${d.why}`];
      const proof = d.evidence.filter((e) => e.revision === d.revision);
      out.push(proof.length ? `Proof for this version: ${proof.map((e) => `${mark(e)} ${e.title}`).join('; ')}` : 'No proof for this version yet: run a check on it (a plugin tool with draft), or add_evidence.');
      out.push('Files:');
      for (const c of d.changes) {
        const now = (await host.readFile(root, c.path)) ?? null;
        out.push(`- ${c.path} (${c.before === null ? 'new' : c.after === null ? 'removed' : 'changed'}${c.after !== null ? `, ${c.after.split('\n').length} lines` : ''})${now !== c.before && d.status === 'draft' ? ' · changed in the project since: save it again' : ''}`);
      }
      const shown = path ? d.changes.filter((c) => c.path === path) : d.changes;
      if (path && !shown.length) return fail(`Draft ${d.id} doesn't change ${path}.`);
      const size = shown.reduce((n, c) => n + (c.after?.length ?? 0), 0);
      if (size > 60_000) out.push('', 'Too long to show together: ask for one file at a time with path.');
      else for (const c of shown) if (c.after !== null) out.push('', `--- ${c.path}`, c.after);
      return reply(out.join('\n'));
    },
  );

  server.registerTool(
    'submit_draft',
    {
      title: 'Send a draft to Review',
      description:
        'Sends a draft to Review as a proposal. Visual Editor first runs any check (and picture) not yet run on its current version; if anything on that version did not pass, it is not sent and you get the problems to fix (save_draft with the draft id, then submit again). Once in Review it waits until the developer approves, sends it back or rejects it. Then check proposal_status.',
      inputSchema: { id: z.string(), project: projectArg },
    },
    async ({ id, project }) => {
      const s = await pick(project);
      if (typeof s === 'string') return fail(s);
      const root = s.project.root;
      const d = host.drafts(root).find((x) => x.id === id);
      if (!d) return fail(`No draft "${id}" in ${s.project.name}.`);
      if (d.status === 'submitted') return fail(`Draft ${d.id} is already in Review as proposal ${d.proposal}.`);
      const blocked = await provenOrWhy(s, d);
      if (blocked) return fail(blocked);
      const sent = await submit(root, host.drafts(root).find((x) => x.id === d.id) ?? d);
      if (typeof sent === 'string') return fail(sent);
      const { proposal, evidence } = sent;
      return reply(`Draft ${d.id} is now proposal ${proposal.id}, waiting in Review for the developer, with its proof: ${evidence.map((e) => `${mark(e)} ${e.title}`).join('; ')}. Nothing has changed yet.\nCall proposal_status with id "${proposal.id}" to see what they decided.`);
    },
  );

  server.registerTool(
    'add_evidence',
    {
      title: 'Add proof to a draft',
      description:
        'Adds a note to a draft\'s proof, for the developer to see in Review next to the change: something you checked yourself and how (it shows as said by you; checks Visual Editor runs are added by themselves). It is about the draft\'s current version.',
      inputSchema: {
        draft: z.string().describe('The draft id'),
        title: z.string().describe('What was checked, in a few words'),
        text: z.string().describe('How, and what came out'),
        passed: z.boolean().optional().describe('Whether it passed, when it was a check'),
        project: projectArg,
      },
    },
    async ({ draft, title, text, passed, project }) => {
      const s = await pick(project);
      if (typeof s === 'string') return fail(s);
      const d = host.drafts(s.project.root).find((x) => x.id === draft);
      if (!d) return fail(`No draft "${draft}" in ${s.project.name}.`);
      if (d.status === 'submitted') return fail(`Draft ${d.id} is already in Review: proof can't be added to it any more.`);
      const e: Evidence = { kind: 'note', title: title.trim(), text: text.trim(), ...(passed === undefined ? {} : { passed }), by: client, at: new Date().toISOString(), revision: d.revision };
      host.saveDraft(s.project.root, { ...d, evidence: [...d.evidence, e] });
      return reply(`Added to the proof of draft ${d.id} (version ${d.revision}).`);
    },
  );

  /** A picture of a card's Playground as a draft leaves it, kept with the draft as proof; a string says why there's none. */
  const picture = async (root: string, d: Draft, card: string): Promise<(DraftPicture & { text: string }) | string> => {
    if (!host.pictures) return 'Pictures can’t be taken here.';
    let p: DraftPicture | string;
    try {
      p = await host.pictures(root, d, card);
    } catch (e) {
      return `The picture couldn't be taken: ${e instanceof Error ? e.message : e}`;
    }
    if (typeof p === 'string') return p;
    const image = relative(root, p.image).split(sep).join('/');
    const words = `${p.designs.length} design${p.designs.length === 1 ? '' : 's'} (${p.designs.join(', ')}) × ${p.states.length} state${p.states.length === 1 ? '' : 's'} (${p.states.join(', ')}); ${p.tiles} drawn.`;
    const text = `${words}${p.problems.length ? `\nProblems on the page:\n${p.problems.map((x) => `- ${x}`).join('\n')}` : ''}`;
    const title = `Playground: ${p.card}`;
    const e: Evidence = { kind: 'picture', title, text, ...(p.problems.length ? { passed: false } : {}), by: 'Visual Editor', at: new Date().toISOString(), revision: d.revision, image, card: p.cardId };
    addProof(root, d, e, (x) => x.kind === 'picture' && x.title === title);
    return { ...p, text };
  };

  /** Adds proof to a draft (replacing what `same` matches on its version). */
  const addProof = (root: string, d: Draft, e: Evidence, same: (x: Evidence) => boolean = () => false) => {
    const now = host.drafts(root).find((x) => x.id === d.id) ?? d;
    if (now.status === 'draft') host.saveDraft(root, { ...now, evidence: [...now.evidence.filter((x) => !(x.revision === e.revision && same(x))), e] });
  };

  /** Runs a plugin's tool (with a draft: on the project as it would leave it; a check's answer is kept as proof). */
  const runTool = async (s: ProjectState, tool: PluginTool, input: Record<string, unknown>, draft?: Draft): Promise<ToolAnswer> => {
    const root = s.project.root;
    const real = (path: string) => host.readFile(root, path);
    const view = draft ? draftView(s.project.files, draft, real) : undefined;
    const answer = await tool.run(input, {
      project: view ? { ...s.project, files: view.files } : s.project,
      items: s.items,
      links: s.links,
      read: view?.read ?? real,
      ...(draft ? { draft: { id: draft.id, title: draft.title, changes: draft.changes.map((c) => ({ path: c.path, after: c.after })) } } : {}),
    });
    // A check on a draft is kept with it as proof (the latest answer for the same question on the same version).
    if (draft && tool.checks && typeof answer === 'string') {
      const last = answer.trim().split('\n').pop() ?? '';
      const asked = Object.entries(input).filter(([, v]) => v !== undefined && v !== '').map(([k, v]) => `${k}: ${String(v)}`).join(', ');
      const title = `${tool.title}${asked ? ` (${asked})` : ''}`;
      addProof(root, draft, { kind: 'check', title, text: answer.slice(0, 8000), ...(last === 'PASSED' ? { passed: true } : last === 'PROBLEMS' ? { passed: false } : {}), by: 'Visual Editor', at: new Date().toISOString(), revision: draft.revision }, (x) => x.kind === 'check' && x.title === title);
    }
    return answer;
  };

  server.registerTool(
    'draft_pictures',
    {
      title: 'Picture of a draft in the Playground',
      description:
        'Draws a component\'s Playground (every design in every state) as the draft would leave it, in the draft\'s own copy of the app (nothing changes in the project), and saves a picture. Look at the picture (it is a PNG file: open it with your Read tool) to see whether the designs look as asked. The picture and any problems on the page are kept with the draft as proof. Vite projects only.',
      inputSchema: { draft: z.string().describe('The draft id'), card: z.string().describe('The component\'s card id or name, e.g. "ProjectCard"'), project: projectArg },
    },
    async ({ draft, card, project }) => {
      const s = await pick(project);
      if (typeof s === 'string') return fail(s);
      const root = s.project.root;
      const d = host.drafts(root).find((x) => x.id === draft);
      if (!d) return fail(`No draft "${draft}" in ${s.project.name}.`);
      if (d.status === 'submitted') return fail(`Draft ${d.id} is already in Review.`);
      const p = await picture(root, d, card);
      if (typeof p === 'string') return fail(p);
      return reply(`Picture of ${p.card}'s Playground in draft ${d.id} (version ${d.revision}): ${p.image}\nOpen it with your Read tool to look at it. ${p.text}\nIt is kept with the draft as proof.`);
    },
  );

  server.registerTool(
    'compare_app',
    {
      title: 'Does the app look the same with a draft?',
      description:
        'Pictures a page of the running app twice, from the real files and with the draft on top (its own copy of the app; nothing changes in the project), and compares them pixel by pixel. For changes that must not change how the app looks (making a component previewable, tidying code). The result is kept with the draft as proof: passed when they match. Open the pictures with Read (the difference picture marks what changed in red). Vite projects only.',
      inputSchema: {
        draft: z.string().describe('The draft id'),
        path: z.string().describe('The page\'s address in the app, e.g. "/" or "/settings" (a page that shows what the draft changes)'),
        project: projectArg,
      },
    },
    async ({ draft, path, project }) => {
      const s = await pick(project);
      if (typeof s === 'string') return fail(s);
      const root = s.project.root;
      const d = host.drafts(root).find((x) => x.id === draft);
      if (!d) return fail(`No draft "${draft}" in ${s.project.name}.`);
      if (d.status === 'submitted') return fail(`Draft ${d.id} is already in Review.`);
      if (!host.compareApp) return fail('The app can’t be compared here.');
      const page = path.startsWith('/') ? path : `/${path}`;
      let c: AppComparison | string;
      try {
        c = await host.compareApp(root, d, page);
      } catch (e) {
        return fail(`The app couldn't be compared: ${e instanceof Error ? e.message : e}`);
      }
      if (typeof c === 'string') return fail(c);
      const share = c.total ? c.differing / c.total : 0;
      // The same: at most a few stray pixels apart (changing a word changes about a thousand), and the same size.
      const same = c.differing <= 25 && !c.sizes;
      const words = same
        ? `The page ${page} looks the same with the draft (${c.differing.toLocaleString('en')} of ${c.total.toLocaleString('en')} pixels differ).`
        : `The page ${page} looks different with the draft: ${c.differing.toLocaleString('en')} of ${c.total.toLocaleString('en')} pixels differ (${(share * 100).toFixed(1)}%)${c.sizes ? `, and its size changed from ${c.sizes.before.join('×')} to ${c.sizes.after.join('×')}` : ''}. What differs is marked in red in the difference picture.`;
      const text = [words, ...c.problems.map((p) => `Problem on the page: ${p}`)].join('\n');
      const title = `Looks the same in the app: ${page}`;
      addProof(root, d, { kind: 'check', title, text, passed: same && !c.problems.length, by: 'Visual Editor', at: new Date().toISOString(), revision: d.revision, image: relative(root, c.diff).split(sep).join('/') }, (x) => x.title === title);
      return reply(`${text}\nBefore: ${c.before}\nAfter: ${c.after}\nDifference: ${c.diff}\n${same && !c.problems.length ? 'PASSED' : 'PROBLEMS'}`);
    },
  );

  // ---- Agent jobs: the worker → checker loop, kept by Visual Editor (jobs.ts) ----

  /** A job of the project, as it is now (out of time once past its limit); a string says why there's none. */
  const jobOf = (root: string, id: string): Job | string => {
    const j = host.jobs(root).find((x) => x.id === id);
    if (!j) return `No job "${id}". Start one with job_start.`;
    const now = current(j);
    if (now !== j) host.saveJob(root, now);
    return now;
  };
  const roleNames = (agent: string) => `the worker is visual-editor:${agent}-worker, the checker visual-editor:${agent}-checker`;

  server.registerTool(
    'job_start',
    {
      title: 'Start an agent job',
      description:
        'Starts a job for one of Visual Editor\'s agents (worker and checker): Visual Editor keeps its rounds, time limit and Stop. Call it first, then run the worker with the job id; job_status always says what to do next.',
      inputSchema: { agent: z.string().describe('The agent\'s name, e.g. "new-variant"'), request: z.string().describe('What the developer asked for, in their words'), project: projectArg },
    },
    async ({ agent, request, project }) => {
      const s = await pick(project);
      if (typeof s === 'string') return fail(s);
      const found = host.agents().find((a) => a.agent.name === agent);
      if (!found) return fail(`No agent "${agent}". Agents: ${host.agents().map((a) => a.agent.name).join(', ') || 'none'}.`);
      if (!s.detected.some((d) => d.plugin.id === found.plugin.id)) return fail(`${s.project.name} isn't a ${found.plugin.name} project, so ${found.agent.title} can't work on it.`);
      const j = newJob(found.agent, request, client, newId());
      host.saveJob(s.project.root, j);
      return reply(`Job ${j.id} started (${j.title}; at most ${j.rounds} round${j.rounds === 1 ? '' : 's'}, ${JOB_MINUTES} minutes; ${roleNames(agent)}).\nNext: ${nextStep(j)} Give it the job id ${j.id} and the request.`);
    },
  );

  server.registerTool(
    'job_status',
    {
      title: 'An agent job: where it is and what next',
      description: 'Where a job is (working, checking, passed, failed, stopped, out of time), its round, its draft, what happened so far, and what to do next.',
      inputSchema: { id: z.string(), project: projectArg },
      annotations: readOnly,
    },
    async ({ id, project }) => {
      const s = await pick(project);
      if (typeof s === 'string') return fail(s);
      const j = jobOf(s.project.root, id);
      if (typeof j === 'string') return fail(j);
      return reply(
        [
          `${j.title}: ${j.status}, round ${j.round} of ${j.rounds}${j.draft ? `, draft ${j.draft}` : ''}${j.proposal ? `, proposal ${j.proposal}` : ''}.`,
          `Request: ${j.request}`,
          'So far:',
          ...j.history.map((h) => `- ${h.who}: ${h.what}`),
          `Next: ${nextStep(j)}`,
        ].join('\n'),
      );
    },
  );

  server.registerTool(
    'job_hand_in',
    {
      title: 'Hand in a draft (the worker)',
      description: 'The worker hands in the draft it made for a job, for the checker. Call it last, once the draft is saved (save_draft); then end your answer.',
      inputSchema: { job: z.string(), draft: z.string(), note: z.string().optional().describe('What you did, in a sentence'), project: projectArg },
    },
    async ({ job, draft, note, project }) => {
      const s = await pick(project);
      if (typeof s === 'string') return fail(s);
      const root = s.project.root;
      const j = jobOf(root, job);
      if (typeof j === 'string') return fail(j);
      if (j.status !== 'working') return fail(`${j.title} isn't waiting for the worker (it's ${j.status}). ${nextStep(j)}`);
      const d = host.drafts(root).find((x) => x.id === draft);
      if (!d) return fail(`No draft "${draft}". Save your files with save_draft first.`);
      if (d.status === 'submitted') return fail(`Draft ${d.id} is already in Review. Save a new draft.`);
      const next: Job = { ...j, status: 'checking', draft: d.id, history: [...j.history, { at: new Date().toISOString(), who: 'worker', what: `Handed in draft ${d.id} (version ${d.revision})${note ? `: ${note.trim()}` : ''}` }] };
      host.saveJob(root, next);
      return reply(`Handed in. The checker takes it from here: end your answer now with what you did.`);
    },
  );

  server.registerTool(
    'job_verdict',
    {
      title: 'Pass or send back a draft (the checker)',
      description:
        'The checker\'s verdict on a job\'s draft. passed: true needs proof on the draft\'s current version that passed (run the checks with the draft first; nothing that failed); the draft then goes to Review. passed: false sends it back to the worker with reasons (each one specific, so it can be fixed). Call it last; then end your answer.',
      inputSchema: {
        job: z.string(),
        passed: z.boolean(),
        reasons: z.string().optional().describe('When sent back: what is wrong and how to fix it. When passed: a sentence on what proves it.'),
        project: projectArg,
      },
    },
    async ({ job, passed, reasons, project }) => {
      const s = await pick(project);
      if (typeof s === 'string') return fail(s);
      const root = s.project.root;
      const j = jobOf(root, job);
      if (typeof j === 'string') return fail(j);
      if (j.status !== 'checking') return fail(`${j.title} isn't waiting for the checker (it's ${j.status}). ${nextStep(j)}`);
      const d = j.draft ? host.drafts(root).find((x) => x.id === j.draft) : undefined;
      if (!d) return fail(`The job's draft (${j.draft}) is gone.`);
      const at = new Date().toISOString();
      if (!passed) {
        if (!reasons?.trim()) return fail('Say what is wrong and how to fix it (reasons), so the worker can fix it.');
        const round = j.round + 1;
        const out = round > j.rounds;
        const next: Job = { ...j, status: out ? 'failed' : 'working', round: out ? j.round : round, history: [...j.history, { at, who: 'checker', what: `Sent back: ${reasons.trim()}` }] };
        host.saveJob(root, next);
        return reply(out ? `Sent back, and that was the last round: the job failed. ${nextStep(next)}` : `Sent back for round ${round} of ${j.rounds}. End your answer now with what you found.`);
      }
      // A pass needs proof: checks on this version of the draft, all passed.
      const proof = d.evidence.filter((e) => e.revision === d.revision);
      const failedProof = proof.filter((e) => e.passed === false);
      if (failedProof.length) return fail(`It can't pass: on this version, ${failedProof.map((e) => e.title).join(', ')} did not pass. Send it back with what to fix.`);
      if (!proof.some((e) => e.passed === true)) return fail('A pass needs proof: run the checks on the draft (plugin check tools with draft, e.g. check_variant_files) until one passes on this version, then give the verdict again.');
      const sent = await submit(root, d);
      if (typeof sent === 'string') return fail(sent);
      const next: Job = { ...j, status: 'passed', proposal: sent.proposal.id, history: [...j.history, { at, who: 'checker', what: `Passed${reasons?.trim() ? `: ${reasons.trim()}` : ''}` }, { at, who: 'Visual Editor', what: `Sent to Review as proposal ${sent.proposal.id}` }] };
      host.saveJob(root, next);
      return reply(`Passed: it is in Review as proposal ${sent.proposal.id}, with its proof (${sent.evidence.length}). End your answer now.`);
    },
  );

  // Plugins' tools: run only for projects their plugin detected; with a draft, they see the project as it would be.
  const draftArg = z.string().optional().describe('A draft id (from save_draft): look at the project as that draft would leave it');
  for (const { plugin, tool } of host.tools()) {
    const inputSchema: Record<string, z.ZodTypeAny> = { project: projectArg, draft: draftArg };
    for (const [name, input] of Object.entries(tool.input ?? {})) inputSchema[name] = zodOf(input);
    server.registerTool(tool.name, { title: tool.title, description: `(${plugin.name}) ${tool.description}`, inputSchema, annotations: readOnly }, async (args) => {
      const { project, draft: draftId, ...input } = args as Record<string, unknown> & { project?: string; draft?: string };
      const s = await pick(project);
      if (typeof s === 'string') return fail(s);
      if (!s.detected.some((d) => d.plugin.id === plugin.id)) return fail(`${s.project.name} isn't a ${plugin.name} project, so ${tool.name} can't be used for it.`);
      const root = s.project.root;
      const draft = draftId ? host.drafts(root).find((d) => d.id === draftId) : undefined;
      if (draftId && !draft) return fail(`No draft "${draftId}" in ${s.project.name}.`);
      try {
        const answer = await runTool(s, tool, input, draft);
        return typeof answer === 'string' ? reply(answer) : fail(answer.problem);
      } catch (e) {
        return fail(`${tool.name} stopped with an error (a bug in the ${plugin.name} plugin): ${e instanceof Error ? e.message : e}`);
      }
    });
  }

  return server;
}

/** ✓ passed, ✗ didn't, • a note or a check that didn't say. */
const mark = (e: Evidence) => (e.passed === true ? '✓' : e.passed === false ? '✗' : e.kind === 'picture' ? '▣' : '•');

/** "3 files (2 new, 1 changed)" */
function changeWords(changes: FileChange[]): string {
  const n = (what: string, k: number) => (k ? [`${k} ${what}`] : []);
  const made = changes.filter((c) => c.before === null).length;
  const gone = changes.filter((c) => c.after === null).length;
  return `${changes.length} file${changes.length === 1 ? '' : 's'} (${[...n('new', made), ...n('changed', changes.length - made - gone), ...n('removed', gone)].join(', ')})`;
}

function zodOf(input: ToolInput): z.ZodTypeAny {
  const base =
    input.type === 'strings' ? z.array(z.string())
    : input.type === 'boolean' ? z.boolean()
    : input.type === 'integer' ? z.number().int()
    : input.type === 'number' ? z.number()
    : input.oneOf?.length ? z.enum(input.oneOf as [string, ...string[]])
    : z.string();
  const described = base.describe(input.description);
  return input.optional ? described.optional() : described;
}

function entryLine(e: MemoryEntry): string {
  const what = e.kind === 'change' ? (e.outcome === 'sent-back' ? 'sent back' : e.outcome ?? 'applied') : e.kind;
  return `- [${what}] ${e.text}${e.detail ? ` (${e.detail})` : ''}${e.note ? ` · developer's note: "${e.note}"` : ''} · ${e.by.name}, ${e.at.slice(0, 10)}`;
}
