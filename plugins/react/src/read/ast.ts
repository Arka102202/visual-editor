// Shared JavaScript/TypeScript parsing for every code reader (components, APIs, data models).
// Pure: no VS Code APIs.

import { parse, type ParserPlugin } from '@babel/parser';
import type * as t from '@babel/types';

export interface SourceFile {
  /** Workspace-relative path with forward slashes. */
  path: string;
  text: string;
}

type N = t.Node;

/**
 * Parsed files, kept until their text changes: the component reader, the data-model readers and the API scanner all
 * parse the same files, and a save changes only a few. Nothing changes the parsed trees, so they can be shared.
 */
const parsed = new Map<string, { text: string; ast: t.File | undefined }>();
const MAX_KEPT = 8000;

/** Parses JS/TS/JSX. Tolerates broken files; returns undefined only if nothing can be read. */
export function parseSource(source: SourceFile): t.File | undefined {
  const kept = parsed.get(source.path);
  if (kept && kept.text === source.text) return kept.ast;
  const ast = parseFresh(source);
  if (parsed.size >= MAX_KEPT) parsed.delete(parsed.keys().next().value!);
  parsed.set(source.path, { text: source.text, ast });
  return ast;
}

function parseFresh(source: SourceFile): t.File | undefined {
  const isTs = /\.[cm]?tsx?$/.test(source.path);
  const isPlainTs = /\.[cm]?ts$/.test(source.path);
  const base: ParserPlugin[] = ['decorators-legacy', 'classProperties', 'exportDefaultFrom'];
  const attempts: ParserPlugin[][] = isPlainTs
    ? [['typescript', ...base]]
    : isTs
      ? [['typescript', 'jsx', ...base]]
      : [['jsx', 'flow', ...base], ['jsx', 'typescript', ...base], ['jsx', ...base]];
  for (const plugins of attempts) {
    try {
      return parse(source.text, {
        sourceType: 'module',
        plugins,
        errorRecovery: true,
        allowReturnOutsideFunction: true,
        allowImportExportEverywhere: true,
        allowAwaitOutsideFunction: true,
        allowUndeclaredExports: true,
      });
    } catch {
      // try the next plugin set
    }
  }
  return undefined;
}

const SKIP_KEYS = new Set(['loc', 'start', 'end', 'extra', 'leadingComments', 'trailingComments', 'innerComments', 'range', 'comments', 'tokens', 'errors']);

/** Calls `fn` for each direct child node, with the property name it sits under. */
export function forEachChild(node: N, fn: (child: N, key: string) => void) {
  for (const key in node) {
    if (SKIP_KEYS.has(key)) continue;
    const value = (node as unknown as Record<string, unknown>)[key];
    if (Array.isArray(value)) {
      for (const v of value) if (v && typeof v === 'object' && typeof (v as N).type === 'string') fn(v as N, key);
    } else if (value && typeof value === 'object' && typeof (value as N).type === 'string') {
      fn(value as N, key);
    }
  }
}

/** Visits every node, depth first. */
export function walk(node: N, fn: (n: N) => void) {
  fn(node);
  forEachChild(node, (c) => walk(c, fn));
}

/** The source text of a node on one line, shortened for display. */
export function sliceText(text: string, node: N): string {
  if (node.start == null || node.end == null) return '';
  const s = text.slice(node.start, node.end).replace(/\s+/g, ' ');
  return s.length > 140 ? `${s.slice(0, 137)}…` : s;
}

/** 0-based line of a node. */
export function line(node: N): number {
  return (node.loc?.start.line ?? 1) - 1;
}
