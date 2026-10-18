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
