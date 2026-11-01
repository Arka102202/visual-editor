// The tools Claude Code (or any MCP assistant) gets from the hub: read the map, the rules and the memory; propose
// changes, which wait in Review for the developer's OK; and remember notes, rules and decisions.
// No VS Code APIs here: everything comes through `HubHost`, so it can be tested with a real MCP client.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { relative, sep } from 'node:path';
import { z } from 'zod';
import type { Item, Plugin, PluginAgent, PluginTool, ToolAnswer, ToolInput } from '@visual-editor/contract';
import { forCard, rulesText, type MemoryEntry } from '../memory';
import type { ProjectState } from '../projectIndex';
import { holdsBack, LOOKS_SAME, newId, parseProposal, safePath, type Evidence, type FileChange, type Proposal } from '../proposals';
import { applyEdits, BUILT_IN_CHECKS, choicesText, progressOf, type AvailableCheck, type CheckPlan, type PlanEdits } from './checkPlan';
import { sessionWords as sessionText, type OpenSession } from './claudeLock';
import { draftView, type Draft, type ProgressItem } from '../drafts';
import { current, JOB_MINUTES, newJob, nextStep, type Job } from '../jobs';
import { logicText, type LogicVerdict } from './logicCheck';

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
  /** The logic check (logicCheck.ts): does the draft do exactly what was asked, soundly. A string says why it couldn't run. */
  /** The check planner (checkPlan.ts): the plan for a finished change (which checks apply, the scenarios); or why none. */
  planChecks?(root: string, draft: Draft, available: AvailableCheck[]): Promise<CheckPlan | string>;
  /** Runs a plan's scenarios: the developer's own read in the code, then those that can be tried in the app. */
  runPlannedCases?(root: string, draft: Draft, plan: CheckPlan, progress?: (index: number, state: ProgressItem['state']) => void): Promise<LogicVerdict | string>;
  /** A finished change's test cases are written: the developer looks at them and runs them. */
  planned?(root: string, draft: Draft): void;
  /** How long a call waits for a check before saying it goes on in the background (default CHECK_WAIT_MS). */
  checkWaitMs?: number;
  /** The design session open in the developer's editor for a project, if one: its draft, title and its kind's brief. */
  session?(root: string): OpenSession | undefined;
  /**
   * Opens a design session with what was asked: of a kind (a plugin's), about a card, with a name, page or design as
   * the kind needs. Its draft and its kind's brief, or why it couldn't.
   */
  startSession?(root: string, choice: { asked: string; kind?: string; card?: string; name?: string; page?: string; design?: string }): { draft: string; brief?: string } | string;
  /** The kinds of design session the project's plugins offer. */
  sessionKinds?(root: string): { id: string; title: string; summary: string; needs: { card?: string; design?: boolean; name?: string; page?: boolean } }[];
  /** Continues a waiting (or sent-back, held-back) proposal in a design session; its draft, or why it couldn't. */
  continueProposal?(root: string, id: string): { draft: string } | string;
  /** A card's summary ("what it does"), if one was written: its text, when, and whether its code changed since. */
  summary?(root: string, item: Item): { text: string; at: string; stale: boolean } | undefined;
  /** Whether a session's tab is open in the developer's editor (only then is it worked in). */
  sessionOpen?(root: string, draft: string): boolean;
  /** Opens a closed session's tab again (the developer agreed); why not, if it can't. */
  openSession?(root: string, draft: string): string | undefined;
  /** A draft's check ended (sent: its proposal; or why it was held back). */
  checked?(root: string, draft: Draft, result: { proposal: Proposal } | string): void;
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
- Design sessions: the developer and you shape a change together, live, in a tab. While one is open, put every change
  for it into its draft with save_draft (draft: its id), adding each new request as asked, and don't propose: nothing
  is checked until the developer is done (they press Done, or say "done" and you call submit_draft). start_session
  opens one ("let's design a new look for ProjectCard"); to change a proposal that is waiting in Review, use
  continue_proposal instead of proposing a replacement.
- When you send a change (propose_change, submit_draft), Visual Editor's check planner writes its test cases: which
  checks apply, and scenarios that hold it to what the developer asked (give that, in their words, as asked). The
  developer looks at them, changes them if they like, and runs them; passing, it reaches Review, else you get what to
  fix. Sending answers at once: don't wait or send it again; follow it with proposal_status.
- For bigger jobs, work in a draft: save_draft keeps the files apart (nothing changes), plugin tools given its id
  (draft) look at the project as it would leave it, read_draft shows it, and submit_draft sends it to Review.
- Visual Editor's agents (a worker, then a checker) run as jobs: job_start, then follow job_status's next step.
- When you and the developer agree on something worth keeping, call remember.
Card ids look like "react:component:src/Card.tsx#Card". Several projects may be open: pass project (its name) when it
matters; otherwise the one on the map is used.`;

const READY_WAIT_MS = 5000;
const STATUS_WORDS: Record<Proposal['status'], string> = { 'awaiting-checks': 'its test cases wait for the developer to run them', proposed: 'waiting for review', applied: 'approved and applied', rejected: 'rejected', 'sent-back': 'sent back', undone: 'applied, then undone', 'held-back': 'held back by a check (it never reached the developer)' };

export function createHubServer(host: HubHost, version = '0.0.1', client = 'Assistant'): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version }, { instructions: INSTRUCTIONS });
  const readOnly = { readOnlyHint: true, openWorldHint: false };
  const reply = (text: string) => ({ content: [{ type: 'text' as const, text }] });
  const fail = (text: string) => ({ content: [{ type: 'text' as const, text }], isError: true });
  const projectArg = z.string().optional().describe('Project name (from overview); default: the one on the map');

  /** The project a tool is about: by name or folder, else the one on the map. */
  /** A session's draft whose tab is closed isn't worked in: why not, in words for Claude (undefined: it can be). */
  const closedSession = (root: string, d: Draft): string | undefined =>
    d.session && d.status === 'draft' && host.sessionOpen && !host.sessionOpen(root, d.id)
      ? `The design session “${d.title}” (draft ${d.id}) is closed: its tab isn't open in the developer's editor, so it isn't worked in. Ask the developer whether to open it again (then call open_session with draft "${d.id}"), or make this a normal change (propose_change).`
      : undefined;

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
      const summary = host.summary?.(s.project.root, item);
      if (summary) out.push(`What it does (Visual Editor's summary, written ${summary.at.slice(0, 10)}${summary.stale ? '; its code changed since, so check it' : ''}): ${summary.text}`);
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
        'The only way to change code. Give each file\'s complete new content (or null to remove it). Visual Editor\'s check planner then writes its test cases (which checks apply, scenarios that try to break it); the developer looks at them and runs them; passing, it waits in Review, with that proof, until they approve, send it back or reject it; failing, you get what to fix. Nothing changes before that. Answers at once: follow it with proposal_status (the id it gives).',
      inputSchema: {
        title: z.string().describe('Short, plain words: what changes, e.g. "Add an onOpen callback to PostCard"'),
        why: z.string().describe('Why, in plain words, for the developer'),
        changes: z
          .array(z.object({ path: z.string().describe('Relative to the project folder'), content: z.string().nullable().describe('The whole new file, or null to remove it') }))
          .min(1),
        cards: z.array(z.string()).optional().describe('Card ids this is about, so the map marks them'),
        asked: z.string().describe('What the developer asked for, in their own words (the logic check holds the change to it)'),
        cases: z.array(z.string()).optional().describe('Cases the developer added for the logic check (from proposal_status, when they sent it back): keep them'),
        project: projectArg,
      },
    },
    async ({ title, why, changes, cards, asked, cases, project }) => {
      const s = await pick(project);
      if (typeof s === 'string') return fail(s);
      const root = s.project.root;
      // A design session is open: changes go into it, checked once when the developer is done.
      const open = host.session?.(root);
      if (open) return fail(sessionWords(open));
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
      const d: Draft = { id: newId(), title, why, by: { kind: 'assistant', name: client }, createdAt: now, updatedAt: now, status: 'draft', changes: files, ...(cards?.length ? { items: cards } : {}), asked: [asked.trim()], ...(cases?.length ? { cases } : {}), revision: 1, evidence: [] };
      host.saveDraft(root, d);
      void requestChecks(s, d.id);
      return reply(sentForChecks(d.id));
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
      // A draft being checked on its way to Review: where its check is, or how it ended.
      const d = p ? undefined : host.drafts(s.project.root).find((x) => x.id === id);
      if (d?.check) {
        const c = d.check;
        if (c.sent) return reply(`It reached Review as proposal ${c.sent}: ${STATUS_WORDS[all.find((x) => x.id === c.sent)?.status ?? 'proposed']}. Call proposal_status with id "${c.sent}" later to see what the developer decided.`);
        if (c.held) return reply(`It did not reach Review. ${c.held}`);
        if (c.step === PLAN_STEP) return reply('Visual Editor\'s check planner is writing its test cases. Ask again later; don\'t send it again.');
        if (c.step === WAITING) return reply('Its test cases are written: it waits for the developer to look at them and press Run. Nothing for you to do now; ask again later.');
        return reply(`Still being checked (version ${c.revision}): now ${c.step}, started ${Math.round((Date.now() - Date.parse(c.at)) / 1000)} s ago. Ask again in a minute; don't send it again.`);
      }
      if (!p) return fail(`No proposal "${id}" in ${s.project.name}.`);
      const note = [...p.history].reverse().find((h) => h.note)?.note;
      // The developer's own cases, and how they (and any other case) did: kept when it's proposed again.
      const logic = p.evidence?.find((e) => e.logic)?.logic;
      const broke = logic?.cases.filter((c) => !c.ok) ?? [];
      const out = [`${p.title}: ${STATUS_WORDS[p.status]}.`];
      if (note) out.push(`The developer's note: "${note}"`);
      if (p.cases?.length) out.push(`The developer's own cases (pass them as cases when you propose again; they must all pass):\n${p.cases.map((c) => `- ${c}`).join('\n')}`);
      if (broke.length) out.push(`Cases that broke:\n${broke.map((c) => `- ${c.case}: expected ${c.expected}, but ${c.found}`).join('\n')}`);
      if (p.status === 'sent-back') out.push('Revise it and call propose_change again.');
      return reply(out.join('\n'));
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

  const { picture, runTool, requestChecks, compare, lookMustStay, stale } = draftFlow(host);
  const sentForChecks = (id: string) =>
    `Sent. Visual Editor's check planner is writing its test cases; the developer looks at them and presses Run, then it reaches Review (or comes back with what to fix). Nothing to wait for and don't send it again: call proposal_status with id "${id}" later to see where it is.`;
  const sessionWords = (open: OpenSession) => sessionText(open).replace(/^Visual Editor: /, '');

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
        asked: z.string().optional().describe('What the developer asked for, in their own words: needed to start a draft; when changing one, only a new request (it is added to the list the logic check holds the change to)'),
        project: projectArg,
      },
    },
    async ({ title, why, changes, cards, draft, asked, project }) => {
      const s = await pick(project);
      if (typeof s === 'string') return fail(s);
      const root = s.project.root;
      const old = draft ? host.drafts(root).find((d) => d.id === draft) : undefined;
      if (draft && !old) return fail(`No draft "${draft}" in ${s.project.name}. Leave draft out to start a new one.`);
      if (old?.status === 'submitted') return fail(`Draft ${old.id} was already sent to Review (proposal ${old.proposal}). Save a new draft instead.`);
      if (old?.status === 'discarded') return fail(`Draft ${old.id} is a session the developer discarded. Save a new draft (or propose_change) instead.`);
      if (old) {
        const closed = closedSession(root, old);
        if (closed) return fail(closed);
      }
      if (!old && !asked?.trim()) return fail('Say what the developer asked for (asked), in their own words: every change is checked against it.');
      const files = new Map((old?.changes ?? []).map((c) => [c.path, c]));
      for (const c of changes) {
        const path = c.path.replace(/\\/g, '/').replace(/^\.\//, '');
        if (!safePath(path)) return fail(`${c.path} isn't a place in the project a change can go.`);
        // What the file is in the project now, as this content was written on top of it (submit_draft checks it's still
        // so). Saving a file again after it changed in the project takes the new one: that's how a draft catches up.
        const before = (await host.readFile(root, path)) ?? null;
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
        asked: [...(old?.asked ?? []), ...(asked?.trim() && !old?.asked?.includes(asked.trim()) ? [asked.trim()] : [])],
        // (What belongs to the draft itself stays: the developer's own cases, and the design session working in it.)
        ...(old?.cases?.length ? { cases: old.cases } : {}),
        revision,
        evidence: old?.evidence ?? [],
        ...(old?.session ? { session: old.session } : {}),
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
        'Sends a finished draft on its way to Review: Visual Editor\'s check planner writes its test cases (which checks apply, and scenarios that try to break it), the developer looks at them and presses Run, and if they pass it waits in Review for approval (if not, you get what to fix: save_draft with the draft id, then submit again). Answers at once; follow it with proposal_status (the draft id). For a design session\'s draft, only when the developer says they are done.',
      inputSchema: { id: z.string(), project: projectArg },
    },
    async ({ id, project }) => {
      const s = await pick(project);
      if (typeof s === 'string') return fail(s);
      const d = host.drafts(s.project.root).find((x) => x.id === id);
      if (!d) return fail(`No draft "${id}" in ${s.project.name}.`);
      if (d.status === 'submitted') return fail(`Draft ${id} is already in Review as proposal ${d.proposal}.`);
      if (d.status === 'discarded') return fail(`Draft ${id} is a session the developer discarded: it can't be sent.`);
      const closed = closedSession(s.project.root, d);
      if (closed) return fail(closed);
      // (Files that moved on first: no test cases for a draft that can't be sent as it is.)
      const moved = await stale(s.project.root, d);
      if (moved) return fail(moved);
      void requestChecks(s, id);
      return reply(sentForChecks(id));
    },
  );

  // (The kinds of session the plugins offer, for start_session's description.)
  const KIND_WORDS = (() => {
    const s = host.current();
    const kinds = s && host.sessionKinds ? host.sessionKinds(s.project.root) : [];
    return kinds.length ? kinds.map((k) => `"${k.id}" (${k.title}: ${k.summary} Needs: ${[k.needs.card ? 'card' : '', k.needs.design ? 'design' : '', k.needs.name ? 'name' : '', k.needs.page ? 'page' : ''].filter(Boolean).join(', ') || 'nothing'})`).join('; ') : 'none here.';
  })();
  server.registerTool(
    'start_session',
    {
      title: 'Open a design session',
      description:
        `Opens a design session in the developer\'s editor: a tab that shows a draft live (a component\'s Playground, or the app) while you and the developer shape a change together. Put every change for it into its draft with save_draft (draft: the id this returns); nothing is checked until the developer is done. Use it when the developer wants to design or try something out ("let\'s design a new look for ProjectCard", "a new Billing page"). Give its kind when one fits: ${KIND_WORDS}`,
      inputSchema: {
        asked: z.string().describe('What the developer asked for, in their own words'),
        kind: z.string().optional().describe('The kind of session, by id (see the description), when one fits'),
        card: z.string().optional().describe('The component\'s card id (or name) it is about, if one'),
        name: z.string().optional().describe('For a new component or page: its name, e.g. "Billing"'),
        page: z.string().optional().describe('For a new page: its address, e.g. "/billing"'),
        design: z.string().optional().describe('For changing a design: its id'),
        project: projectArg,
      },
    },
    async ({ asked, kind, card, name, page, design, project }) => {
      const s = await pick(project);
      if (typeof s === 'string') return fail(s);
      if (!host.startSession) return fail('Design sessions can\'t be opened here.');
      const item = card ? s.items.find((i) => i.id === card) ?? s.items.find((i) => i.label === card && i.preview) ?? s.items.find((i) => i.label === card) : undefined;
      if (card && !item) return fail(`No card "${card}" (use list_cards to find its id).`);
      const r = host.startSession(s.project.root, { asked: asked.trim(), ...(kind ? { kind } : {}), ...(item ? { card: item.id } : {}), ...(name ? { name } : {}), ...(page ? { page } : {}), ...(design ? { design } : {}) });
      if (typeof r === 'string') return fail(r);
      return reply(`A design session is open in the developer's editor (draft ${r.draft}). Put each change into it with save_draft (draft: "${r.draft}"), giving each file's whole new content and each new request as asked; it shows live. Don't propose it: when the developer is done they press Done (or say "done", and you call submit_draft with id "${r.draft}").${r.brief ? `\n${r.brief}` : ''}`);
    },
  );

  server.registerTool(
    'continue_proposal',
    {
      title: 'Change a proposal in a design session',
      description:
        'For more changes to a proposal that is waiting in Review (or was sent back or held back): opens a design session that starts from it, instead of proposing a replacement. Put the changes into its draft with save_draft (draft: the id this returns); when the developer is done, the result goes back into the same proposal.',
      inputSchema: { id: z.string().describe('The proposal id'), project: projectArg },
    },
    async ({ id, project }) => {
      const s = await pick(project);
      if (typeof s === 'string') return fail(s);
      if (!host.continueProposal) return fail('Design sessions can\'t be opened here.');
      const r = host.continueProposal(s.project.root, id);
      if (typeof r === 'string') return fail(r);
      return reply(`Proposal ${id} is open in a design session (draft ${r.draft}), with its changes. Put more changes into it with save_draft (draft: "${r.draft}"), each new request as asked; it shows live. When the developer is done (Done in the session, or "done" and you call submit_draft with id "${r.draft}"), the result goes back into proposal ${id}.`);
    },
  );

  server.registerTool(
    'open_session',
    {
      title: 'Open a closed design session',
      description:
        'Opens a design session whose tab is closed, in the developer\'s editor, so you can work in it again. Only after the developer agreed: when their message seems to continue a closed session, ask them first ("shall I open it and continue there, or make a normal change?"). Then put changes into its draft with save_draft.',
      inputSchema: { draft: z.string().describe('The session\'s draft id'), project: projectArg },
    },
    async ({ draft, project }) => {
      const s = await pick(project);
      if (typeof s === 'string') return fail(s);
      const d = host.drafts(s.project.root).find((x) => x.id === draft);
      if (!d?.session) return fail(`No design session with draft "${draft}" in ${s.project.name}.`);
      if (d.status !== 'draft') return fail(`That session is finished (${d.status === 'submitted' ? `sent to Review as proposal ${d.proposal}` : 'discarded'}): it can't be worked in. Start a new one, or continue the proposal (continue_proposal).`);
      if (!host.openSession) return fail('Design sessions can\'t be opened here.');
      const why = host.openSession(s.project.root, draft);
      if (why) return fail(why);
      return reply(`The session “${d.title}” is open in the developer's editor again (draft ${draft}). Put changes into it with save_draft (draft: "${draft}"), adding the request as asked; it shows live. Nothing is checked until the developer is done.`);
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
        'Pictures a page of the running app twice, from the real files and with the draft on top (its own copy of the app; nothing changes in the project), and compares them pixel by pixel. Only for changes that must not change how the app looks (making a component previewable, tidying code): never for a change to a design, which is meant to look different. In an agent\'s job that promises the look stays, it is proof (passed when they match); otherwise it is kept as information only. Open the pictures with Read (the difference picture marks what changed in red). Vite projects only.',
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
      const r = await compare(root, d, page, lookMustStay(root, d));
      if (typeof r === 'string') return fail(r);
      return reply(`${r.text}\nBefore: ${r.before}\nAfter: ${r.after}\nDifference: ${r.diff}\n${r.passed ? 'PASSED' : 'PROBLEMS'}`);
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
      // The job's request is what was asked (the logic check holds the draft to it).
      if (!d.asked?.length) host.saveDraft(root, { ...d, asked: [j.request] });
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
      // Then, like any finished change: its test cases are planned, and wait in Review for the developer to run them.
      void requestChecks(s, d.id);
      host.saveJob(root, { ...j, status: 'passed', proposal: `held-${d.id}`, history: [...j.history, { at, who: 'checker', what: `Passed${reasons?.trim() ? `: ${reasons.trim()}` : ''}` }, { at, who: 'Visual Editor', what: 'Waiting in Review for the developer to look at its test cases and run them' }] });
      return reply('Passed: it waits in Review for the developer to look at its test cases and run them. End your answer now.');
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

/** The logic check's proof title. */
const LOGIC = 'Logic check: does exactly what was asked';

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

type Finished = { proposal: Proposal; evidence: Evidence[] } | string;
/** Checks running now, by project and draft (in this VS Code). */
const RUNNING = new Map<string, Promise<Finished>>();
/** Test cases being written now, by project and draft. */
const RUNNING_PLANS = new Map<string, Promise<CheckPlan | string>>();
/** A draft's check steps, as proposal_status and the session tab tell them. */
export const PLAN_STEP = 'writing the test cases (the check planner reads the change)';
export const WAITING = 'waiting for you to look at the test cases and run them';
/** Files the scenarios are for (code). */
const CODE = /\.(m?[jt]sx?|vue|svelte|css|scss|html)$/;

/** The plan for a change with no code in it: the checks that always run, no scenarios (no planner needed). */
function basicPlan(available: AvailableCheck[], revision: number): CheckPlan {
  return { revision, at: new Date().toISOString(), means: [], looksOnly: false, cases: [], fixes: [], checks: available.map((a) => ({ id: a.id, title: a.title, why: a.always ? 'Always checked.' : 'Not for files like these (no code changed).', use: !!a.always, ...(a.always ? { always: true } : {}) })) };
}
/** How long a call waits for its check before saying it's still running (assistants' tools give up after a minute). */
export const CHECK_WAIT_MS = 45_000;

/**
 * What happens to a draft on its way to Review, the same however it's sent (submit_draft, propose_change, a design
 * session's Done): its checks and pictures as proof, the one rule for reaching Review, holding it back, and sending it.
 */
export function draftFlow(host: HubHost) {
  /**
   * The one rule for reaching Review: the checks the developer approved in this version's plan ran, and nothing that
   * holds a change back failed (or they bypassed it). Undefined when it may go; else why not, with the problems to fix.
   */
  const provenOrWhy = async (s: ProjectState, d: Draft, again = 'save_draft with the draft id, then submit_draft again', step: (what: string) => void = () => {}, mark: (id: string, state: ProgressItem['state']) => void = () => {}): Promise<string | undefined> => {
    const root = s.project.root;
    const latest = () => host.drafts(root).find((x) => x.id === d.id) ?? d;
    const plan = latest().plan;
    if (!plan || plan.revision !== d.revision) return 'Not sent to Review: its test cases haven\'t been planned and run for this version yet.';
    const now = () => new Date().toISOString();
    const note = (title: string, text: string) => addProof(root, d, { kind: 'note', title, text, by: 'Visual Editor', at: now(), revision: d.revision }, (x) => x.title === title);
    const choices = choicesText(plan);
    if (choices) note('Your choices on the checks', choices);
    if (plan.skipAll) return undefined;
    // Held back: the developer can see it (and why) in Review, though it never reached them for approval.
    const blocked = (failed: Evidence[]) => {
      // (A design session shows why in its own tab: it isn't listed as held back too.)
      if (!d.session) holdBack(root, latest());
      return [`Not sent to Review: ${failed.map((e) => e.title).join(', ')} did not pass.`, ...failed.map((e) => `--- ${e.title}\n${e.text}`), `Fix it (${again}; it is draft ${d.id}).`].join('\n');
    };
    const kept = () => latest().evidence.filter((e) => e.revision === d.revision);
    // (What already ran on this version isn't run again.)
    const ran = (title: string) => kept().some((e) => e.by.startsWith('Visual Editor') && (e.title === title || e.title.startsWith(`${title} (`)));
    // How a check came out, from its proof on this version (for the live list).
    const outcome = (found: Evidence[]): ProgressItem['state'] => (found.some((e) => e.passed === false && !e.bypassed) ? 'failed' : found.some((e) => e.passed === true) ? 'passed' : 'done');
    for (const c of plan.checks.filter((x) => x.use)) {
      mark(`check:${c.id}`, 'running');
      if (c.id === 'pictures') {
        // (Pictures only for a change that passed its checks so far: a failed one goes back to be fixed first.)
        if (kept().some((e) => holdsBack(e, false))) {
          mark(`check:${c.id}`, 'not run');
          continue;
        }
        step('pictures in the Playground');
        const cards = (await host.cardsTouched?.(root, d).catch(() => [])) ?? [];
        for (const card of cards.slice(0, 3)) {
          // (A picture that showed problems is taken again: the run may have been fixed since.)
          if (kept().some((e) => e.kind === 'picture' && e.card === card && e.passed !== false)) continue;
          const p = await picture(root, d, card);
          if (typeof p === 'string') note(`No picture of ${card.split('#').pop()}`, p);
        }
        mark(`check:${c.id}`, outcome(kept().filter((e) => e.kind === 'picture')));
      } else if (c.id === 'looks_same') {
        if (c.page && !ran(`${LOOKS_SAME}: ${c.page}`)) {
          step('comparing the app');
          const r = await compare(root, d, c.page, true);
          if (typeof r === 'string') note(`${LOOKS_SAME}: ${c.page} couldn't run`, r);
        }
        mark(`check:${c.id}`, outcome(kept().filter((e) => e.title === `${LOOKS_SAME}: ${c.page}`)));
      } else {
        const found = host.tools().find(({ tool }) => tool.name === c.id);
        if (found && !ran(found.tool.title)) {
          step(found.tool.title);
          try {
            await runTool(s, found.tool, {}, d);
          } catch (e) {
            note(`${found.tool.title}: couldn't run`, `A bug in the ${found.plugin.name} plugin: ${e instanceof Error ? e.message : e}`);
          }
        }
        mark(`check:${c.id}`, found ? outcome(kept().filter((e) => e.title === found.tool.title || e.title.startsWith(`${found.tool.title} (`))) : 'done');
      }
    }
    const mustStay = plan.checks.some((c) => c.id === 'looks_same' && c.use) || lookMustStay(root, d);
    const failed = kept().filter((e) => holdsBack(e, mustStay));
    const used = plan.cases.filter((c) => c.use);
    if (failed.length) {
      // (Stopped before the scenarios.)
      used.forEach((_, i) => mark(`case:${i}`, 'not run'));
      return blocked(failed);
    }
    // Then the scenarios: read in the code, and tried in the app where they can be (once per version).
    if (plan.cases.some((c) => c.use) && !kept().some((e) => e.title === LOGIC && (e.passed === true || e.bypassed))) {
      const asked = d.asked?.length ? d.asked : [d.title];
      step('the scenarios (read in the code, and tried in the app)');
      const verdict = host.runPlannedCases ? await host.runPlannedCases(root, { ...d, asked }, plan, (i, state) => mark(`case:${i}`, state)) : 'The scenarios can\'t be run here.';
      if (typeof verdict === 'string') {
        used.forEach((_, i) => mark(`case:${i}`, 'not run'));
        return `Not sent to Review: ${verdict} Press Run again in a moment.`;
      }
      verdict.cases.forEach((c, i) => mark(`case:${i}`, c.ok || c.overruled ? 'passed' : 'failed'));
      const { passed, cost: _cost, ...logic } = verdict;
      const e: Evidence = { kind: 'check', title: LOGIC, text: logicText(asked, logic), passed, by: 'Visual Editor (logic checker)', at: now(), revision: d.revision, logic };
      addProof(root, d, e, (x) => x.title === LOGIC);
      if (!passed) return blocked([e]);
    }
    if (!kept().length) note('No checks apply to these files', 'None of Visual Editor\'s checks apply to a change like this.');
    return undefined;
  };

  /** The checks Visual Editor can run on a project's changes: its plugins' checks, then its own. */
  const available = (s: ProjectState): AvailableCheck[] => [
    ...host.tools().filter(({ plugin, tool }) => tool.checks && s.detected.some((x) => x.plugin.id === plugin.id)).map(({ tool }) => ({ id: tool.name, title: tool.title, description: tool.description, ...(tool.always ? { always: true } : {}) })),
    ...BUILT_IN_CHECKS,
  ];

  /**
   * A finished change waiting for the developer: listed in Review (one entry per draft, which becomes its proposal), its
   * test cases being written or ready to run.
   */
  const awaitChecks = (root: string, d: Draft) => {
    const id = `held-${d.id}`;
    const had = host.proposals(root).find((p) => p.id === id);
    const now = new Date().toISOString();
    const entry = parseProposal(
      JSON.stringify({ id, title: d.title, why: d.why, asked: d.asked, cases: d.cases, by: d.by, createdAt: had?.createdAt ?? now, status: 'awaiting-checks', changes: d.changes, items: d.items, history: [...(had?.history ?? []), ...(had?.status === 'awaiting-checks' ? [] : [{ at: now, status: 'awaiting-checks' }])], evidence: d.evidence.filter((e) => e.revision === d.revision) }),
      id,
    );
    if (typeof entry !== 'string') host.propose(root, entry);
  };

  /**
   * A finished change: the check planner writes its test cases (in the background: one Claude run), and they wait for
   * the developer to run them. A change with no code in it gets the checks that always run, without the planner.
   */
  const requestChecks = (s: ProjectState, id: string): Promise<CheckPlan | string> => {
    const root = s.project.root;
    const key = `${root}#plan#${id}`;
    const had = RUNNING_PLANS.get(key);
    if (had) return had;
    const d0 = host.drafts(root).find((x) => x.id === id);
    if (!d0) return Promise.resolve(`No draft "${id}".`);
    const at = new Date().toISOString();
    const record = (check: Partial<NonNullable<Draft['check']>>, plan?: CheckPlan) => {
      const now = host.drafts(root).find((x) => x.id === id);
      if (now) host.saveDraft(root, { ...now, check: { at, revision: d0.revision, step: 'starting', ...check }, ...(plan ? { plan } : {}) });
    };
    record({ step: PLAN_STEP });
    if (!d0.session) awaitChecks(root, d0);
    const promise = (async (): Promise<CheckPlan | string> => {
      const avail = available(s);
      const code = d0.changes.some((c) => CODE.test(c.path));
      const plan = code && host.planChecks ? await host.planChecks(root, { ...d0, asked: d0.asked?.length ? d0.asked : [d0.title] }, avail) : basicPlan(avail, d0.revision);
      if (typeof plan === 'string') {
        record({ step: 'done', held: `Its test cases couldn't be written: ${plan} Send it again in a moment.` });
        return plan;
      }
      record({ step: WAITING }, plan);
      const d = host.drafts(root).find((x) => x.id === id);
      if (d) {
        if (!d.session) awaitChecks(root, d);
        host.planned?.(root, d);
      }
      return plan;
    })()
      .catch((e: unknown) => `The test cases couldn't be written: ${e instanceof Error ? e.message : String(e)}`)
      .finally(() => RUNNING_PLANS.delete(key));
    RUNNING_PLANS.set(key, promise);
    return promise;
  };

  /**
   * The developer ran a plan (with their changes to it): the approved checks run in the background, and it goes to
   * Review or is held back. A string says why it can't run now.
   */
  const runChecks = (s: ProjectState, id: string, edits: PlanEdits, again?: string): string | { promise: Promise<Finished> } => {
    const root = s.project.root;
    const d = host.drafts(root).find((x) => x.id === id);
    if (!d) return `No draft "${id}".`;
    if (d.status !== 'draft') return 'It has already gone to Review.';
    if (!d.plan || d.plan.revision !== d.revision) return 'Its test cases aren\'t written for this version yet.';
    if (RUNNING.has(`${root}#${id}`)) return 'Its checks are running already.';
    const plan = applyEdits(d.plan, edits);
    if (typeof plan === 'string') return plan;
    // A run redoes what it runs: the scenarios' earlier result, and what its own checks found failing before, are tried
    // again (pictures that showed problems are taken again). What passed, what the developer bypassed, and what other
    // checks found stay.
    const rerun = new Set([LOGIC, ...plan.checks.filter((c) => c.use).flatMap((c) => (c.id === 'looks_same' && c.page ? [`${LOOKS_SAME}: ${c.page}`] : host.tools().filter(({ tool }) => tool.name === c.id).map(({ tool }) => tool.title)))]);
    const evidence = d.evidence.filter((e) => e.revision !== d.revision || e.bypassed || !(e.title === LOGIC || (e.passed === false && rerun.has(e.title))));
    host.saveDraft(root, { ...d, plan, evidence });
    return { promise: checkInBackground(s, id, again).promise };
  };

  /**
   * A draft a check stopped, kept as a held-back proposal (one per draft: the latest try), so the developer sees what
   * was stopped and why. There's nothing to approve.
   */
  const holdBack = (root: string, d: Draft) => {
    const now = new Date().toISOString();
    const evidence = d.evidence.filter((e) => e.revision === d.revision);
    const held = parseProposal(
      JSON.stringify({ id: `held-${d.id}`, title: d.title, why: d.why, asked: d.asked, cases: d.cases, by: d.by, createdAt: now, status: 'held-back', changes: d.changes, items: d.items, history: [{ at: now, status: 'held-back' }], evidence }),
      `held-${d.id}`,
    );
    if (typeof held !== 'string') host.propose(root, held);
  };

  /** Files of a draft that changed in the project since it was saved, in words; undefined when none did. */
  const stale = async (root: string, d: Draft): Promise<string | undefined> => {
    const moved: string[] = [];
    for (const c of d.changes) if (((await host.readFile(root, c.path)) ?? null) !== c.before) moved.push(c.path);
    return moved.length ? `These files changed in the project since the draft was saved: ${moved.join(', ')}. Read them again, save the draft again with save_draft (draft: "${d.id}"), check it, then submit it.` : undefined;
  };

  /** A draft to Review as a proposal, with its proof for its current version; a string says why not. */
  const submit = async (root: string, d: Draft): Promise<{ proposal: Proposal; evidence: Evidence[] } | string> => {
    if (d.status === 'submitted') return `Draft ${d.id} is already in Review as proposal ${d.proposal}.`;
    const moved = await stale(root, d);
    if (moved) return moved;
    const now = new Date().toISOString();
    // Its proof goes with it: what was checked on this version.
    const evidence = d.evidence.filter((e) => e.revision === d.revision);
    // A design session that continued a proposal puts its result back into that proposal (waiting again, with the new
    // changes and proof, and a line in its history), instead of making a second one.
    const into = d.session?.proposal ? host.proposals(root).find((p) => p.id === d.session!.proposal) : undefined;
    if (into) {
      const { session: _session, ...rest } = into;
      const updated = parseProposal(
        JSON.stringify({ ...rest, title: d.title, why: d.why, asked: d.asked, cases: d.cases, status: 'proposed', changes: d.changes, items: d.items, evidence, history: [...into.history, { at: now, status: 'proposed', note: 'Changed in a design session' }] }),
        into.id,
      );
      if (typeof updated === 'string') return updated;
      host.propose(root, updated);
      host.saveDraft(root, { ...d, status: 'submitted', proposal: updated.id, updatedAt: now });
      return { proposal: updated, evidence };
    }
    // (A change that waited in Review for its checks keeps its entry: it becomes the proposal.)
    const pid = host.proposals(root).some((p) => p.id === `held-${d.id}`) ? `held-${d.id}` : newId();
    const checked = parseProposal(
      JSON.stringify({ id: pid, title: d.title, why: d.why, asked: d.asked, cases: d.cases, by: d.by, createdAt: now, status: 'proposed', changes: d.changes, items: d.items, history: [{ at: now, status: 'proposed' }], evidence }),
      newId(),
    );
    if (typeof checked === 'string') return checked;
    host.propose(root, checked);
    host.saveDraft(root, { ...d, status: 'submitted', proposal: checked.id, updatedAt: now });
    return { proposal: checked, evidence };
  };

  /** Whether a draft must leave the look alone: it's the draft of a job whose agent promises it (it compares the app). */
  const lookMustStay = (root: string, d: Draft): boolean => {
    const job = host.jobs(root).find((j) => j.draft === d.id);
    const agent = job && host.agents().find(({ agent: a }) => a.name === job.agent)?.agent;
    return !!agent && [...(agent.worker.tools ?? []), ...(agent.checker.tools ?? [])].includes('compare_app');
  };

  /**
   * Compares an app page with and without a draft, kept as proof (`counts`: passed or failed, for a change that must
   * keep the look; otherwise information only). A string says why it couldn't.
   */
  const compare = async (root: string, d: Draft, page: string, counts: boolean): Promise<{ text: string; passed: boolean; before: string; after: string; diff: string } | string> => {
    if (!host.compareApp) return 'The app can’t be compared here.';
    let c: AppComparison | string;
    try {
      c = await host.compareApp(root, d, page);
    } catch (e) {
      return `The app couldn't be compared: ${e instanceof Error ? e.message : e}`;
    }
    if (typeof c === 'string') return c;
    const share = c.total ? c.differing / c.total : 0;
    // The same: at most a few stray pixels apart (changing a word changes about a thousand), and the same size.
    const same = c.differing <= 25 && !c.sizes;
    const words = same
      ? `The page ${page} looks the same with the draft (${c.differing.toLocaleString('en')} of ${c.total.toLocaleString('en')} pixels differ).`
      : `The page ${page} looks different with the draft: ${c.differing.toLocaleString('en')} of ${c.total.toLocaleString('en')} pixels differ (${share < 0.001 ? 'less than 0.1%' : `${(share * 100).toFixed(1)}%`})${c.sizes ? `, and its size changed from ${c.sizes.before.join('×')} to ${c.sizes.after.join('×')}` : ''}. What differs is marked in red in the difference picture.`;
    const text = [words, ...c.problems.map((p) => `Problem on the page: ${p}`)].join('\n');
    const title = `${LOOKS_SAME}: ${page}`;
    const passed = same && !c.problems.length;
    // (Only a change that must leave the look alone passes or fails on it; for others it's information.)
    addProof(root, d, { kind: 'check', title, text: counts ? text : `For information only (this change isn't meant to keep the look): ${text}`, ...(counts ? { passed } : {}), by: 'Visual Editor', at: new Date().toISOString(), revision: d.revision, image: relative(root, c.diff).split(sep).join('/') }, (x) => x.title === title);
    return { text, passed, before: c.before, after: c.after, diff: c.diff };
  };

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

  /** Sends a draft to Review the one way: files that moved on first, then its proof (checks, logic check), then Review. */
  const finish = async (s: ProjectState, id: string, again?: string, step?: (what: string) => void, mark?: (id: string, state: ProgressItem['state']) => void): Promise<Finished> => {
    const root = s.project.root;
    const d = host.drafts(root).find((x) => x.id === id);
    if (!d) return `No draft "${id}" in ${s.project.name}.`;
    if (d.status === 'submitted') return `Draft ${d.id} is already in Review as proposal ${d.proposal}.`;
    // (Files that moved on first: no checks, least of all the logic check, on a draft that can't be sent as it is.)
    const moved = await stale(root, d);
    if (moved) return moved;
    const blocked = await provenOrWhy(s, d, again, step, mark);
    if (blocked) return blocked;
    return submit(root, host.drafts(root).find((x) => x.id === d.id) ?? d);
  };

  /**
   * finish, in the background: an assistant's call can't wait the minute or two a logic check takes (its tools give up
   * after about a minute). The draft keeps where its check is and how it ended (proposal_status, job_status and a
   * session tab read it). One check per draft at a time: asking again while one runs gets that one. `after`: told how
   * it ended.
   */
  const checkInBackground = (s: ProjectState, id: string, again?: string, after?: (r: Finished) => void): { promise: Promise<Finished>; already: boolean } => {
    const root = s.project.root;
    const key = `${root}#${id}`;
    const had = RUNNING.get(key);
    if (had) return { promise: had, already: true };
    const at = new Date().toISOString();
    const d0 = host.drafts(root).find((x) => x.id === id);
    const revision = d0?.revision ?? 1;
    // The run's list (each check and scenario, and where it is), kept with the check for Review and the session.
    let items = d0?.plan?.revision === revision ? progressOf(d0.plan) : [];
    let step = 'starting';
    const record = (check: Partial<NonNullable<Draft['check']>>) => {
      const now = host.drafts(root).find((x) => x.id === id);
      if (now) host.saveDraft(root, { ...now, check: { at, revision, step, ...(items.length ? { items } : {}), ...check } });
    };
    const mark = (itemId: string, state: ProgressItem['state']) => {
      const now = new Date();
      items = items.map((i) => {
        if (i.id !== itemId) return i;
        // When it started, and (once it ends) how long it took.
        if (state === 'running') return { ...i, state, at: i.at ?? now.toISOString() };
        const took = i.at && i.state === 'running' ? Math.max(0, Math.round((now.getTime() - Date.parse(i.at)) / 1000)) : i.took;
        return { ...i, state, ...(took !== undefined ? { took } : {}) };
      });
      record({});
    };
    record({});
    const promise = finish(s, id, again, (what) => ((step = what), record({})), mark)
      .catch((e: unknown) => `The check couldn't finish: ${e instanceof Error ? e.message : String(e)}`)
      .then((r) => {
        items = items.map((i) => (i.state === 'waiting' || i.state === 'running' ? { ...i, state: 'not run' } : i));
        step = 'done';
        record(typeof r === 'string' ? { held: r } : { sent: r.proposal.id });
        // Stopped before its checks could say anything (out of date, its test cases missing, an error): held back
        // with the reason, so the developer sees why (a session shows it in its tab).
        const stopped = host.drafts(root).find((x) => x.id === id);
        if (typeof r === 'string' && stopped && !stopped.session && host.proposals(root).find((p) => p.id === `held-${id}`)?.status === 'awaiting-checks') {
          addProof(root, stopped, { kind: 'note', title: 'Why its checks stopped', text: r, by: 'Visual Editor', at: new Date().toISOString(), revision: stopped.revision }, (x) => x.title === 'Why its checks stopped');
          holdBack(root, host.drafts(root).find((x) => x.id === id) ?? stopped);
        }
        after?.(r);
        const d = host.drafts(root).find((x) => x.id === id);
        if (d) host.checked?.(root, d, r);
        return r;
      })
      .finally(() => RUNNING.delete(key));
    RUNNING.set(key, promise);
    return { promise, already: false };
  };

  return { provenOrWhy, holdBack, stale, submit, picture, addProof, runTool, finish, checkInBackground, lookMustStay, requestChecks, runChecks, compare, available };
}
