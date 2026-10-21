// Visual Editor's variants: a component's looks kept apart from its data, so Preview can show every look with fixed
// data while the app shows the one in use with its real data. This file goes into the project once (Visual Editor adds
// it when asked); each component folder uses it:
//
//   index.tsx                 the chooser: what the app imports. Real data in the app; fixed data in Preview.
//   Name.types.ts             NameProps (what a parent passes) and NameView (what every variant gets).
//   Name.data.tsx             the real data: hooks, API, stores → NameView → the switcher, as "real".
//   Name.mock.ts              fixed data: named states (default, empty, long name…), each a NameView.
//   Name.switcher.tsx         the variant in use (one import line); every variant only in Preview.
//   Name.variant.tsx, Name.<name>.variant.tsx   looks only: NameView in, JSX out (UI state like "menu open" is fine;
//                             reading or changing app data is not).

import { Component, createContext, Fragment, lazy, Suspense, useContext, useMemo, type ComponentType, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';

/**
 * real: the app (real data, the variant in use).
 * mock: Preview of this component (fixed data, every variant).
 * mock-selected: inside a preview (fixed data, the variant in use).
 */
export type VariantKey = 'real' | 'mock' | 'mock-selected';

/** A variant's details (exported by each variant file as `variant`). */
export interface VariantInfo {
  /** Unique within the component, e.g. "default", "compact". */
  id: string;
  /** A name to show, e.g. "Compact". */
  name?: string;
}

/** A variant file: its looks (default export) and its details. */
export interface VariantModule<V> {
  default: ComponentType<V>;
  variant: VariantInfo;
}

const KeyContext = createContext<VariantKey>('real');
const StateContext = createContext<string>('default');

/** Sets the key (and the mock state) for everything inside. The app needs none: without one, it's "real". */
export function VariantKeyProvider({ value, state, children }: { value: VariantKey; state?: string; children: ReactNode }) {
  const inner = <KeyContext.Provider value={value}>{children}</KeyContext.Provider>;
  return state ? <StateContext.Provider value={state}>{inner}</StateContext.Provider> : inner;
}

export const useVariantKey = (): VariantKey => useContext(KeyContext);
export const useMockState = (): string => useContext(StateContext);

/**
 * Fixed data for a component (its Name.mock.ts, loaded only in Preview): the chosen state, with what the parent
 * passes on top (inside a preview, a parent's fixed data comes first; the child's own fills in the rest).
 */
export function MockData<P extends object, V extends object>({ load, props, render }: { load: () => Promise<{ states: Record<string, V> }>; props: P; render: (view: V) => ReactNode }) {
  const state = useMockState();
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
    // A new state is a new loading (the module itself is loaded once).
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [state],
  );
  return (
    <Suspense fallback={null}>
      <Loaded props={props} />
    </Suspense>
  );
}

/** One variant that stopped drawing doesn't take the others down (in Preview). */
class OneVariant extends Component<{ id: string; children: ReactNode }, { error: string | null }> {
  state = { error: null as string | null };
  static getDerivedStateFromError(e: unknown) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
  render() {
    return this.state.error ? <div data-ve-variant-error={this.props.id}>{this.state.error}</div> : this.props.children;
  }
}

/**
 * A component's switcher (its Name.switcher.tsx makes one): "real" and "mock-selected" draw the variant in use;
 * "mock" draws every variant, each marked with its id (data-ve-variant), and what they draw inside gets
 * "mock-selected". The other variants are loaded only then (`all` is left out of production builds).
 */
export function makeSwitcher<V extends object>(Selected: ComponentType<V>, selected: VariantInfo, all?: () => Promise<VariantModule<V>>[]) {
  const Every = all
    ? lazy(async () => {
        const modules = await Promise.all(all());
        return {
          default: (p: { view: V }) => (
            <KeyContext.Provider value="mock-selected">
              {modules.map((m) => (
                <div key={m.variant.id} data-ve-variant={m.variant.id} data-ve-variant-name={m.variant.name ?? m.variant.id} data-ve-selected={m.variant.id === selected.id ? '' : undefined}>
                  <OneVariant id={m.variant.id}>
                    <m.default {...p.view} />
                  </OneVariant>
                </div>
              ))}
            </KeyContext.Provider>
          ),
        };
      })
    : undefined;
  return function Switcher(props: V & { mode: VariantKey }) {
    const { mode, ...view } = props;
    if (mode !== 'mock' || !Every) return <Selected {...(view as V)} />;
    return (
      <Suspense fallback={null}>
        <Every view={view as V} />
      </Suspense>
    );
  };
}

/**
 * Preview's page (Visual Editor serves it): a component drawn with every variant (side by side) in every state (one
 * row each), with fixed data. Each variant is labelled; anything inside shows its own variant in use.
 */
export function mountPreview(container: HTMLElement, Chooser: ComponentType<Record<string, never>>, options: { states: string[]; columns: number }) {
  const root = createRoot(container);
  root.render(
    <div data-ve-grid="" style={{ display: 'grid', gridTemplateColumns: `max-content repeat(${Math.max(1, options.columns)}, max-content)`, gap: '28px 32px', alignItems: 'start' }}>
      {options.states.map((state) => (
        <Fragment key={state}>
          <div data-ve-state={state}>{state}</div>
          <VariantKeyProvider value="mock" state={state}>
            <Chooser />
          </VariantKeyProvider>
        </Fragment>
      ))}
    </div>,
  );
  return root;
}

