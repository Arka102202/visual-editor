// Small stand-ins for the packages' own types (this test app has no node_modules).
declare module 'react' {
  export function useState<T>(initial: T | (() => T)): [T, (v: T) => void]
  export function useEffect(fn: () => void | (() => void), deps?: unknown[]): void
}
declare module 'react/jsx-runtime' {
  export const jsx: any, jsxs: any, Fragment: any
}
declare namespace JSX {
  interface IntrinsicElements { [name: string]: any }
  interface Element {}
}
declare module '@tanstack/react-query' {
  export function useQuery<T>(options: { queryKey: unknown[]; queryFn: () => Promise<T> }): { data: T | undefined; isLoading: boolean; error: unknown }
}
declare module 'react-router-dom' {
  export function useParams(): Record<string, string | undefined>
}
interface ImportMeta { env: Record<string, string | undefined> }
declare module 'zustand' {
  export interface StoreApi<T> { getState(): T; setState(partial: Partial<T> | T, replace?: boolean): void }
  export type UseBoundStore<S> = (<U>(select: (state: S extends StoreApi<infer T> ? T : never) => U) => U) & S
  export function create<T>(): (init: (set: (partial: Partial<T>) => void, get: () => T) => T) => UseBoundStore<StoreApi<T>>
}
declare module '@reduxjs/toolkit' {
  export function configureStore<S>(options: { reducer: { [K in keyof S]: (state: S[K] | undefined, action: unknown) => S[K] } }): { getState(): S; dispatch(action: unknown): void }
}
declare module 'jotai' {
  export interface PrimitiveAtom<V> { init: V; read(get: unknown): V }
  export function atom<V>(init: V): PrimitiveAtom<V>
}
declare module 'valtio' {
  export function proxy<T extends object>(initial: T): T
}
