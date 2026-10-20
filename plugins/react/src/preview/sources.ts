// Where one component's data comes from, read from its code: every hook it calls that brings data in (its own hooks
// like useEditor(), store selectors, the router, context, data libraries) is a source; so is state that an effect
// fills from somewhere else (`useState(null)` + `fetch(…).then(setOrder)`). In the preview each source is replaced by
// a value from the data list, the effects that fill state are left out, and nothing else runs: the component is
// drawn from static data. React's own state and memo hooks stay real, so clicking around still works. Pure: code in,
// plan out, so it can be tested.

import type * as t from '@babel/types';
import { forEachChild, line as lineOf, sliceText } from '../read/ast';

type N = t.Node;

/** React's own hooks: local state and memory, which stay real in the preview (effects are decided one by one). */
const REACT_KEPT = new Set(['useState', 'useReducer', 'useMemo', 'useCallback', 'useRef', 'useId', 'useTransition', 'useDeferredValue', 'useImperativeHandle', 'useDebugValue', 'useOptimistic', 'useActionState', 'useInsertionEffect']);
const EFFECTS = new Set(['useEffect', 'useLayoutEffect']);
/** Signs that an effect brings data in (it waits for something, or calls something that does). */
const BRINGS_DATA = /\bawait\b|\.then\(|\bfetch\(|\baxios\b|\bdb\.|\.get\(|\.toArray\(|\bnavigate\(|localStorage|sessionStorage|indexedDB|\.subscribe\(|setInterval\(|setTimeout\(/;

/** One source of data in a component: replaced by a value from the data list in the preview. */
export interface Source {
  /** Unique within the component and lasting: the variable it's kept in (`editor`), or the hook and its count. */
  local: string;
  kind: 'hook' | 'state';
  /** The code, shortened: `useCanvasStore(s => s.nodes)`, `useState<Order | null>(null)`. */
  label: string;
  /** The name a value is made for (`nodes`, `order`), which helps make it look right. */
  name: string;
  /** The code replaced by the value: a hook call, or a state's starting value (`at` is where to put it when there's none). */
  start: number;
  end: number;
  /** For state: where its starting value goes when it has none (inside `useState(|)`). */
  insertAt?: number;
  /** Where TypeScript is asked the type: the call (hooks), or the state variable. */
  typeStart: number;
  typeEnd: number;
  line: number;
}

/** What the preview does with one component: its sources, and the code it leaves out. */
export interface Plan {
  sources: Source[];
  /** Effects that bring data in (and hooks called only for what they do): left out. */
  drops: { start: number; end: number }[];
}

const isFn = (n: N | null | undefined): n is t.ArrowFunctionExpression | t.FunctionExpression | t.FunctionDeclaration =>
  !!n && (n.type === 'ArrowFunctionExpression' || n.type === 'FunctionExpression' || n.type === 'FunctionDeclaration');

/** The hook a call calls (`useX(…)`, `React.useX(…)`), when it is one. */
function hookOf(e: N | null | undefined): { name: string; call: t.CallExpression } | undefined {
  if (!e) return undefined;
  if (e.type === 'TSNonNullExpression' || e.type === 'TSAsExpression' || e.type === 'ParenthesizedExpression' || e.type === 'TSSatisfiesExpression') return hookOf(e.expression);
  if (e.type !== 'CallExpression') return undefined;
  const c = e.callee;
  const name = c.type === 'Identifier' ? c.name : c.type === 'MemberExpression' && c.property.type === 'Identifier' ? c.property.name : undefined;
  return name && /^use[A-Z0-9]/.test(name) ? { name, call: e } : undefined;
}

/** The names a piece of code mentions. */
function namesIn(node: N): Set<string> {
  const out = new Set<string>();
  const visit = (n: N) => {
    if (n.type === 'Identifier') out.add(n.name);
    forEachChild(n, visit);
  };
  visit(node);
  return out;
}

/** The plan for one component function (`text` is its file's text, for labels). */
export function planOf(fn: t.Function, text: string): Plan {
  const sources: Source[] = [];
  const drops: Plan['drops'] = [];
  if (fn.body.type !== 'BlockStatement') return { sources, drops };
  const statements = fn.body.body;
  const count = new Map<string, number>();
  const nameOnce = (hook: string) => {
    const n = (count.get(hook) ?? 0) + 1;
    count.set(hook, n);
    return n === 1 ? hook : `${hook}#${n}`;
  };
  const short = (n: N) => {
    const s = sliceText(text, n);
    return s.length > 90 ? `${s.slice(0, 87)}…` : s;
  };

  // State: its variable, setter and starting value (an effect may fill it).
  const states: { value: string; setter: string; call: t.CallExpression; id: t.ArrayPattern; decl: N }[] = [];
  // Functions defined in the component that bring data in and fill state (`const load = async () => …`).
  const fillers = new Map<string, N>();

  for (const st of statements) {
    if (st.type === 'VariableDeclaration') {
      for (const d of st.declarations) {
        const hook = hookOf(d.init);
        if (hook) {
          if (hook.name === 'useState' || hook.name === 'useReducer') {
            if (d.id.type === 'ArrayPattern' && d.id.elements[0]?.type === 'Identifier' && d.id.elements[1]?.type === 'Identifier') {
              states.push({ value: d.id.elements[0].name, setter: d.id.elements[1].name, call: hook.call, id: d.id, decl: d });
            }
            continue;
          }
          if (REACT_KEPT.has(hook.name)) continue;
          // A hook that brings data in: its value comes from the data list.
          const variable = d.id.type === 'Identifier' ? d.id.name : undefined;
          const local = variable ?? nameOnce(hook.name);
          sources.push({
            local,
            kind: 'hook',
            label: short(hook.call),
            name: variable ?? hook.name.replace(/^use/, '').replace(/^./, (x) => x.toLowerCase()),
            start: hook.call.start ?? 0,
            end: hook.call.end ?? 0,
            typeStart: hook.call.start ?? 0,
            typeEnd: hook.call.end ?? 0,
            line: lineOf(hook.call),
          });
          continue;
        }
        // const load = async () => { … setOrders(…) }
        if (d.id.type === 'Identifier' && isFn(d.init) && BRINGS_DATA.test(sliceText(text, d.init))) fillers.set(d.id.name, d.init);
      }
    } else if (st.type === 'FunctionDeclaration' && st.id && BRINGS_DATA.test(sliceText(text, st))) {
      fillers.set(st.id.name, st);
    } else if (st.type === 'ExpressionStatement') {
      const hook = hookOf(st.expression);
      if (!hook || REACT_KEPT.has(hook.name)) continue;
      if (EFFECTS.has(hook.name)) continue; // decided below, once every state is known
      // A hook called only for what it does (useHotkeys(…), useClickOutside(…)): left out.
      drops.push({ start: st.start ?? 0, end: st.end ?? 0 });
    }
  }

  // Effects: one that brings data in (waits, fetches, reads storage, navigates, fills state) is left out; the state
  // it fills from elsewhere becomes a source. Effects that only work with the page (focus, scroll, listeners) stay.
  const filled = new Set<string>();
  for (const st of statements) {
    if (st.type !== 'ExpressionStatement') continue;
    const hook = hookOf(st.expression);
    if (!hook || !EFFECTS.has(hook.name)) continue;
    const body = hook.call.arguments[0] as N | undefined;
    if (!body) continue;
    const code = sliceText(text, body);
    const mentioned = namesIn(body);
    const viaFillers = [...fillers.entries()].filter(([name]) => mentioned.has(name)).map(([, f]) => f);
    // A setter called, or handed on (`.then(setOrder)`).
    const setsState = states.some((s) => mentioned.has(s.setter));
    if (!BRINGS_DATA.test(code) && !viaFillers.length && !setsState) continue;
    drops.push({ start: st.start ?? 0, end: st.end ?? 0 });
    // State it fills after waiting for something (directly, or through a function of the component) is a source.
    const waits = BRINGS_DATA.test(code);
    for (const s of states) {
      if ((waits && mentioned.has(s.setter)) || viaFillers.some((f) => namesIn(f).has(s.setter))) filled.add(s.value);
    }
  }
  for (const s of states) {
    if (!filled.has(s.value)) continue;
    const init = s.call.arguments[0] as N | undefined;
    const valueId = s.id.elements[0] as t.Identifier;
    sources.push({
      local: s.value,
      kind: 'state',
      label: short(s.decl),
      name: s.value,
      start: init?.start ?? 0,
      end: init?.end ?? 0,
      ...(init ? {} : { insertAt: (s.call.end ?? 1) - 1 }),
      typeStart: valueId.start ?? 0,
      typeEnd: (valueId.start ?? 0) + valueId.name.length,
      line: lineOf(s.decl),
    });
  }
  return { sources, drops };
}
