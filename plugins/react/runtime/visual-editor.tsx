// Visual Editor's helper, version 4 (docs/variants.md). A component's looks (designs) are kept apart from its data, and
// its data has two parts: dynamic (the real data, in the app) and static (a working prototype with no network, in
// Preview and the Playground). Visual Editor keeps this file in place (.visual-editor/react/, imported as
// @visual-editor/react) and updates it when it ships a newer version: don't edit it. Each component folder uses it:
//
//   index.tsx                 the chooser: what the app imports. The dynamic part in the app; the static part in Preview.
//   Name.types.ts             NameProps (what a parent passes), NameStart (what the static part starts from), NameView
//                             (what every design gets), and NameSituation if it has situations.
//   Name.data.tsx             dynamic: hooks, API, stores → NameView → the switcher.
//   Name.static.tsx           static: NameStart → data kept in memory, changed by clicks → NameView → the switcher.
//   Name.mock.ts              the starting data: named states (default, empty, many…), each a NameStart.
//   Name.switcher.tsx         the design in use (one import line, or one line per situation); every design only in
//                             development.
//   Name.variant.tsx, Name.<name>.variant.tsx   designs: looks only (UI state like "menu open" is fine; app data is not).
//
// Folders made with version 1 (a mock of views, MockData in the chooser) keep working. Version 3: the Playground groups
// rows by situation, and a design not made for a row's situation says so in its tile. Version 4: a big board draws only
// the tiles near the screen (the others wait as light placeholders), so many designs and states stay smooth.

import { Component, createContext, Fragment, lazy, Suspense, useContext, useEffect, useMemo, useRef, useState, type ComponentType, type Context, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';

/** Which version of this helper the project has (Visual Editor offers an update when it's older). */
export const HELPER_VERSION = 4;

/**
 * real: the app (the dynamic part, the design in use).
 * mock: Preview or the Playground, for the component opened (the static part from its starting data; the designs).
 * mock-selected: anything inside a preview (the static part from what its parent passes; the design in use).
 */
export type VariantKey = 'real' | 'mock' | 'mock-selected';

/** A design's details (exported by each design file as `variant`). */
export interface VariantInfo {
  /** Unique within the component, e.g. "default", "compact". */
  id: string;
  /** A name to show, e.g. "Compact". */
  name?: string;
  /** The situations it's made for (e.g. ["danger"]); without it, any. */
  for?: string[];
}

/** A design file: its looks (default export) and its details. */
export interface VariantModule<V> {
  default: ComponentType<V>;
  variant: VariantInfo;
}

/**
 * Shared by every copy of this file on the page: after the file changes, the dev server gives it a new address for
 * its importers (?t=…), so the preview page and a component can each load their own copy. Both must agree on these.
 */
const shared = ((globalThis as { __visualEditor?: unknown }).__visualEditor ??= {
  key: createContext<VariantKey>('real'),
  state: createContext<string>('default'),
  only: createContext<string | undefined>(undefined),
}) as { key: Context<VariantKey>; state: Context<string>; only: Context<string | undefined> };
const KeyContext = shared.key;
const StateContext = shared.state;
/** In a preview, one tile shows one design (each tile its own prototype): which one. */
const OnlyContext = shared.only;

/** Sets the key (and the starting state) for everything inside. The app needs none: without one, it's "real". */
export function VariantKeyProvider({ value, state, children }: { value: VariantKey; state?: string; children: ReactNode }) {
  const inner = <KeyContext.Provider value={value}>{children}</KeyContext.Provider>;
  return state ? <StateContext.Provider value={state}>{inner}</StateContext.Provider> : inner;
}

export const useVariantKey = (): VariantKey => useContext(KeyContext);
export const useMockState = (): string => useContext(StateContext);

/**
 * The static part's way to "go" to another page. A preview is one page only: it shows where it would go, and stays.
 * (Only the static part calls it; the app's own navigation lives in the dynamic part.)
 */
export function goTo(path: string) {
  window.dispatchEvent(new CustomEvent('visual-editor:go', { detail: String(path) }));
}

/**
 * The static part of a component (version 2), for the chooser: loaded only in development. It starts from the
 * starting data's state (the tile's), with what the parent passes on top: inside a page, each child gets the page's
 * data; on its own, it starts from its own.
 */
export function StaticPart<P extends object>({ start, part, props }: { start: () => Promise<{ states: Record<string, object> }>; part: () => Promise<{ default: ComponentType<any> }>; props: P }) {
  const state = useMockState();
  const waiting = useWaiting();
  const Loaded = useMemo(
    () =>
      lazy(async () => {
        const [{ states }, { default: Part }] = await Promise.all([start(), part()]);
        return {
          default: (p: { props: P }) => {
            const chosen = states[state] ?? states.default ?? Object.values(states)[0] ?? {};
            return <Part {...chosen} {...p.props} />;
          },
        };
      }),
    // A new state is a new start (the modules themselves load once).
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [state],
  );
  return (
    <Suspense fallback={waiting}>
      <Loaded props={props} />
    </Suspense>
  );
}

/**
 * While a board tile's code loads, it keeps a placeholder's size (so the board doesn't shrink and pull far tiles into
 * view); anything inside a preview (a page's parts) shows nothing meanwhile, as in the app.
 */
function useWaiting(): ReactNode {
  return useVariantKey() === 'mock' ? <div data-ve-waiting="" /> : null;
}

/**
 * Version 1: fixed views for Preview (the chooser drew them into the switcher). Kept so folders made with version 1
 * still work; new folders use StaticPart.
 */
export function MockData<P extends object, V extends object>({ load, props, render }: { load: () => Promise<{ states: Record<string, V> }>; props: P; render: (view: V) => ReactNode }) {
  const state = useMockState();
  const waiting = useWaiting();
  const Loaded = useMemo(
    () =>
      lazy(async () => {
        const { states } = await load();
        return {
          default: (p: { props: P }) => {
            const chosen = states[state] ?? states.default ?? Object.values(states)[0];
            return <>{render({ ...chosen, ...p.props } as V)}</>;
          },
        };
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [state],
  );
  return (
    <Suspense fallback={waiting}>
      <Loaded props={props} />
    </Suspense>
  );
}

/** One design that stopped drawing doesn't take the others down (in a preview). */
class OneVariant extends Component<{ id: string; children: ReactNode }, { error: string | null }> {
  state = { error: null as string | null };
  static getDerivedStateFromError(e: unknown) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
  render() {
    return this.state.error ? <div data-ve-variant-error={this.props.id}>{this.state.error}</div> : this.props.children;
  }
}

type Every<V> = () => Promise<VariantModule<V>>[];

/** With situations: which prop picks the situation, the design in use for each, and every design (development only). */
export interface Situations<V, S extends string> {
  situation: keyof V & string;
  inUse: Record<S, ComponentType<V>>;
  every?: Every<V>;
}

/**
 * A component's switcher (its Name.switcher.tsx makes one). In the app and inside a preview it draws the design in use
 * (for the situation the parent picked, when there are situations). For the component opened in a preview it draws the
 * designs, each marked with its id (data-ve-variant): one per tile, or every one. What they draw inside gets
 * "mock-selected". The other designs load only then (`every` is left out of production builds).
 *
 *   makeSwitcher(Selected, variant, every)                      one design in use
 *   makeSwitcher({ situation: 'kind', inUse: { … }, every })   one design in use per situation
 */
export function makeSwitcher<V extends object, S extends string = string>(designOrSituations: ComponentType<V> | Situations<V, S>, selected?: VariantInfo, all?: Every<V>) {
  const bySituation = typeof designOrSituations === 'object' && designOrSituations !== null && 'inUse' in designOrSituations ? (designOrSituations as Situations<V, S>) : undefined;
  const single = bySituation ? undefined : (designOrSituations as ComponentType<V>);
  const every = bySituation ? bySituation.every : all;
  /** The design in use for this view (its situation's, when there are situations). */
  const inUseFor = (view: V): ComponentType<V> => {
    if (single) return single;
    const s = String((view as Record<string, unknown>)[bySituation!.situation]);
    const map = bySituation!.inUse as Record<string, ComponentType<V>>;
    return map[s] ?? Object.values(map)[0];
  };
  const Designs = every
    ? lazy(async () => {
        const modules = await Promise.all(every());
        return {
          default: (p: { view: V; only?: string }) => {
            const inUse = inUseFor(p.view);
            const situation = bySituation ? String((p.view as Record<string, unknown>)[bySituation.situation]) : undefined;
            const shown = modules.filter((m) => (!p.only || m.variant.id === p.only) && (!situation || !m.variant.for || m.variant.for.includes(situation)));
            // One tile for a design not made for this situation: it says so (the board keeps its columns).
            const notFor = p.only && !shown.length ? modules.find((m) => m.variant.id === p.only) : undefined;
            if (notFor)
              return (
                <div data-ve-variant={notFor.variant.id} data-ve-variant-name={notFor.variant.name ?? notFor.variant.id} data-ve-not-for={situation}>
                  Not made for “{situation}”
                </div>
              );
            return (
              <KeyContext.Provider value="mock-selected">
                {shown.map((m) => {
                  const isInUse = m.default === inUse || (!!selected && m.variant.id === selected.id);
                  return (
                    <div key={m.variant.id} data-ve-variant={m.variant.id} data-ve-variant-name={m.variant.name ?? m.variant.id} data-ve-selected={isInUse ? '' : undefined}>
                      <OneVariant id={m.variant.id}>
                        <m.default {...p.view} />
                      </OneVariant>
                    </div>
                  );
                })}
              </KeyContext.Provider>
            );
          },
        };
      })
    : undefined;
  return function Switcher(props: V & { mode?: VariantKey }) {
    const { mode, ...rest } = props;
    const fromAbove = useVariantKey();
    const only = useContext(OnlyContext);
    const view = rest as V;
    const key = mode ?? fromAbove;
    if (key !== 'mock' || !Designs) {
      const InUse = inUseFor(view);
      return <InUse {...view} />;
    }
    return (
      <Suspense fallback={<div data-ve-waiting="" />}>
        <Designs view={view} only={only} />
      </Suspense>
    );
  };
}

/** A tile drawn once it's near the screen (and kept after): a board of many tiles stays light. */
function WhenNear({ children }: { children: ReactNode }) {
  const [near, setNear] = useState(false);
  const spot = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (near || !spot.current) return;
    const seen = new IntersectionObserver((all) => {
      if (all.some((e) => e.isIntersecting)) {
        setNear(true);
        seen.disconnect();
      }
      // Measured from this page itself (not the window around the frame, where a zoomed-out board's margin grows).
    }, { root: document, rootMargin: '400px' });
    seen.observe(spot.current);
    return () => seen.disconnect();
  }, [near]);
  return near ? <>{children}</> : <div ref={spot} data-ve-waiting="" />;
}

/** From how many tiles a board draws only those near the screen. */
const MANY_TILES = 12;

/** What a preview can be told: draw again from the starting data. */
export interface PreviewHandle {
  reset(): void;
}

/**
 * The page Visual Editor serves for Preview and the Playground: a component drawn in every state (one row each) and,
 * with `variants`, one tile per design, each its own prototype (what you change in one tile stays in that tile).
 * Each design is labelled; anything inside shows its own design in use. Links don't leave the page: they show where
 * they'd go. `wrap` is the project's providers (src/visual-editor.providers.tsx), when it has them.
 */
export function mountPreview(
  container: HTMLElement,
  Chooser: ComponentType<Record<string, never>>,
  options: { states: string[]; columns?: number; variants?: { id: string }[]; wrap?: ComponentType<{ children: ReactNode }>; groups?: { title: string; states: string[] }[] },
): PreviewHandle & { root: ReturnType<typeof createRoot> } {
  const root = createRoot(container);
  container.addEventListener(
    'click',
    (e) => {
      const link = e.target instanceof Element ? e.target.closest('a[href]') : null;
      if (!link || e.defaultPrevented) return;
      e.preventDefault();
      goTo(link.getAttribute('href') ?? '');
    },
    true,
  );
  const tiles: (string | undefined)[] = options.variants?.length ? options.variants.map((v) => v.id) : [undefined];
  const columns = options.variants?.length ?? Math.max(1, options.columns ?? 1);
  const Wrap = options.wrap ?? Fragment;
  let round = 0;
  // A big board draws only the tiles near the screen (each waits as a light placeholder until then).
  const many = tiles.length * options.states.length > MANY_TILES;
  const tile = (id: string | undefined, state: string) => {
    const drawn = (
      <OnlyContext.Provider value={id}>
        <VariantKeyProvider value="mock" state={state}>
          <Chooser />
        </VariantKeyProvider>
      </OnlyContext.Provider>
    );
    return <Fragment key={id ?? 'every'}>{many ? <WhenNear>{drawn}</WhenNear> : drawn}</Fragment>;
  };
  const row = (state: string) => (
    <Fragment key={state}>
      <div data-ve-state={state}>{state}</div>
      {tiles.map((id) => tile(id, state))}
    </Fragment>
  );
  // With situations, the rows come in groups: a heading across the board, then that situation's states.
  const groups = options.groups?.length ? options.groups : [{ title: '', states: options.states }];
  const draw = () =>
    root.render(
      <Wrap>
        <div key={round} data-ve-grid="" style={{ display: 'grid', gridTemplateColumns: `max-content repeat(${columns}, max-content)`, gap: '28px 32px', alignItems: 'start' }}>
          {groups.map((g) => (
            <Fragment key={g.title || 'all'}>
              {g.title ? (
                <div data-ve-group={g.title} style={{ gridColumn: '1 / -1' }}>
                  {g.title}
                </div>
              ) : null}
              {g.states.map(row)}
            </Fragment>
          ))}
        </div>
      </Wrap>,
    );
  draw();
  return {
    root,
    reset() {
      round++;
      draw();
    },
  };
}
