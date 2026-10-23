declare namespace JSX {
  interface Element { readonly __jsx: unique symbol }
  interface ElementClass { render(): unknown }
  interface IntrinsicElements { [k: string]: Record<string, unknown> }
}

declare module 'react' {
  export type Key = string | number;
  export type ReactNode =
    | JSX.Element
    | string
    | number
    | boolean
    | null
    | undefined
    | Iterable<ReactNode>;

  export interface FC<P = Record<string, never>> {
    // Real @types/react threads `key` through every component's props; the
    // stub has to as well or a keyed element fails to typecheck here while
    // building fine against the real types.
    (props: P & { key?: Key }): JSX.Element | null;
  }
  export type ElementType = unknown;

  export interface MutableRefObject<T> { current: T }

  export interface SyntheticEvent<T = Element> { currentTarget: T; target: T; preventDefault(): void }
  export interface ChangeEvent<T = Element> extends SyntheticEvent<T> { target: T & { value: string } }
  export interface KeyboardEvent<T = Element> extends SyntheticEvent<T> { key: string }
  export interface FormEvent<T = Element> extends SyntheticEvent<T> {}
  export interface MouseEvent<T = Element> extends SyntheticEvent<T> {}
  export const StrictMode: (props: { children?: ReactNode }) => JSX.Element;
  export interface SVGProps<T> extends Record<string, unknown> { className?: string }

  export function useState<S>(initial: S | (() => S)): [S, (v: S | ((p: S) => S)) => void];
  export function useRef<T>(initial: T): MutableRefObject<T>;
  export function useEffect(fn: () => void | (() => void), deps?: readonly unknown[]): void;
  export function useCallback<T extends (...a: never[]) => unknown>(fn: T, deps: readonly unknown[]): T;
  export function useMemo<T>(fn: () => T, deps: readonly unknown[]): T;

  const React: {
    FC: FC;
    ElementType: ElementType;
  };
  export default React;
}

declare module 'react/jsx-runtime' {
  export function jsx(type: unknown, props: unknown, key?: unknown): JSX.Element;
  export function jsxs(type: unknown, props: unknown, key?: unknown): JSX.Element;
  export const Fragment: unknown;
}

// `React.FC` / `React.ReactNode` are used as a namespace in the app, which is
// how @types/react exposes them.
declare namespace React {
  type ReactNode = import('react').ReactNode;
  type FC<P = Record<string, never>> = import('react').FC<P>;
  type ElementType = import('react').ElementType;
  type ChangeEvent<T = Element> = import('react').ChangeEvent<T>;
  type KeyboardEvent<T = Element> = import('react').KeyboardEvent<T>;
  type FormEvent<T = Element> = import('react').FormEvent<T>;
  type MouseEvent<T = Element> = import('react').MouseEvent<T>;
}
