// What previews need to know beyond the components (worked out only when a preview is first opened, not on every
// read): the shapes of the data the code reads (for example replies), the app's stores, the data it saves in the
// browser, and its GraphQL operations. Pure: files in, plain data out, so it can run in the reading worker.

import type { SourceFile } from '@visual-editor/contract';
import { readShapesAndBindings, type Binding, type ReplyShape } from '../read/shapes';
import { readGraphql, type GraphqlRead } from '../read/graphql';
import { replyRules, type ReplyRule } from './replies';
import { findStores, type FoundStore } from './stores';
import { findSaved, type FoundSaved } from './saved';

export interface Extras {
  /** Reply shapes from how the code uses the data, and where the variables holding them are declared. */
  used: ReplyShape[];
  bindings: Binding[];
  /** Example replies worked out from usage alone (before types). */
  replies: ReplyRule[];
  stores: FoundStore[];
  saved: FoundSaved[];
  graphql: GraphqlRead;
}

export function computeExtras(files: SourceFile[]): Extras {
  const code = files.filter((f) => /\.[cm]?[jt]sx?$/.test(f.path));
  const { replies: used, bindings } = readShapesAndBindings(code);
  return { used, bindings, replies: replyRules(used), stores: findStores(code), saved: findSaved(code), graphql: readGraphql(code) };
}
