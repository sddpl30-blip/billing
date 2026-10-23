/**
 * The hook the app gets its books from.
 *
 * Resolves the data source once, keeps the signed-in identity, and re-renders
 * on every change to either. The screens then read one `store` and one
 * `session` and do not know, or need to know, whether the books are in a
 * database or in this browser.
 *
 * The identity is the part that matters: `session.flats` comes from
 * `/api/auth/me`, which reads the owner record the account is linked to. In
 * demo mode there is no server to ask, so the sample flat is used and the
 * screen says it is a demonstration.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { BooksStore } from './booksStore';
import type { ServerBooksStore } from './serverStore';
import { resolveDataSource, type DataSourceKind, type ResolvedDataSource } from './dataSource';
import type { ApiClient, SessionUser } from '../api/client';
import {
  currentUser, requestCode, signInWithPassword, signOut as signOutApi, verifyCode,
  viewForRoles, viewsAvailable,
} from '../api/session';
import { systemClock, type SourceVendorInvoice } from '../accounting';

export type AppView = 'Resident' | 'Manager' | 'Committee';

export interface BooksSession {
  readonly email: string;
  readonly roles: readonly string[];
  readonly permissions: readonly string[];
  readonly flats: ReadonlyArray<{ id: string; flatNo: string }>;
  /** The flat the resident screens show. Empty when the account holds none. */
  readonly primaryFlatNo: string;
  readonly view: AppView;
  readonly availableViews: ReadonlyArray<AppView>;
}

export interface UseBooks {
  readonly status: 'resolving' | 'ready' | 'needs-sign-in';
  readonly kind: DataSourceKind | null;
  readonly store: BooksStore | null;
  readonly server: ServerBooksStore | null;
  readonly client: ApiClient | null;
  readonly session: BooksSession | null;
  readonly note: string;
  readonly error: string | null;
  /** Bumped on every store change, for the screens to re-read. */
  readonly version: number;
  can(permission: string): boolean;
  signIn(input: { email: string; password: string }): Promise<void>;
  requestLoginCode(email: string): Promise<{ delivered: boolean; message: string }>;
  signInWithCode(input: { email: string; code: string }): Promise<void>;
  signOut(): Promise<void>;
  reload(): Promise<void>;
}

export interface UseBooksOptions {
  readonly vendorInvoices?: readonly SourceVendorInvoice[];
  readonly force?: DataSourceKind | 'auto';
  /** The flat the demo shows. Only used when there is no server. */
  readonly demoFlatNo: string;
}

export function useBooks(options: UseBooksOptions): UseBooks {
  const [resolved, setResolved] = useState<ResolvedDataSource | null>(null);
  const [session, setSession] = useState<SessionUser | null>(null);
  const [status, setStatus] = useState<UseBooks['status']>('resolving');
  const [version, setVersion] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(true);

  useEffect(() => () => { mounted.current = false; }, []);

  // Resolved once. A second resolve would open a second store over the same
  // browser storage, which is how two stores end up disagreeing.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const source = await resolveDataSource({
        clock: systemClock,
        ...(options.vendorInvoices === undefined
          ? {}
          : { vendorInvoices: options.vendorInvoices }),
        ...(options.force === undefined ? {} : { force: options.force }),
        onUnauthenticated: () => {
          if (!cancelled && mounted.current) {
            setSession(null);
            setStatus('needs-sign-in');
          }
        },
      });
      if (cancelled) return;
      setResolved(source);
      setError(source.error ?? null);

      if (source.kind === 'demo') {
        setStatus('ready');
        return;
      }

      // Server mode: ask who is signed in before showing anything. A session
      // cookie may already be valid from a previous visit.
      const user = await currentUser(source.client as ApiClient);
      if (cancelled) return;
      if (user === null) {
        setStatus('needs-sign-in');
        return;
      }
      setSession(user);
      await (source.server as ServerBooksStore).refresh();
      if (!cancelled) setStatus('ready');
    })().catch((err: unknown) => {
      if (cancelled) return;
      setError(err instanceof Error ? err.message : String(err));
      setStatus('needs-sign-in');
    });

    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Re-render whenever the store changes, however it changed.
  useEffect(() => {
    if (resolved === null) return undefined;
    return resolved.store.subscribe(() => setVersion(v => v + 1));
  }, [resolved]);

  const afterSignIn = useCallback(async (source: ResolvedDataSource): Promise<void> => {
    const user = await currentUser(source.client as ApiClient);
    if (!mounted.current) return;
    setSession(user);
    if (user !== null) {
      await (source.server as ServerBooksStore).refresh();
      if (mounted.current) setStatus('ready');
    }
  }, []);

  const signIn = useCallback(async (input: { email: string; password: string }): Promise<void> => {
    if (resolved?.client === undefined) throw new Error('No server is configured for this build.');
    await signInWithPassword(resolved.client, input);
    await afterSignIn(resolved);
  }, [resolved, afterSignIn]);

  const requestLoginCode = useCallback(async (email: string) => {
    if (resolved?.client === undefined) throw new Error('No server is configured for this build.');
    const result = await requestCode(resolved.client, email);
    return { delivered: result.delivered, message: result.message };
  }, [resolved]);

  const signInWithCode = useCallback(async (input: { email: string; code: string }): Promise<void> => {
    if (resolved?.client === undefined) throw new Error('No server is configured for this build.');
    await verifyCode(resolved.client, input);
    await afterSignIn(resolved);
  }, [resolved, afterSignIn]);

  const signOut = useCallback(async (): Promise<void> => {
    if (resolved?.client !== undefined) await signOutApi(resolved.client);
    if (!mounted.current) return;
    setSession(null);
    setStatus(resolved?.kind === 'server' ? 'needs-sign-in' : 'ready');
  }, [resolved]);

  const reload = useCallback(async (): Promise<void> => {
    if (resolved?.server !== undefined) await resolved.server.refresh();
  }, [resolved]);

  const booksSession: BooksSession | null = resolved === null
    ? null
    : resolved.kind === 'demo'
      ? {
          email: 'demo@localhost',
          // In demo mode the browser holds every role, because there is no
          // server to enforce one and the demonstration has to show all three
          // views. Nothing is authorised by this: there is nothing to
          // authorise against.
          roles: ['resident', 'manager', 'treasurer'],
          permissions: [],
          flats: [{ id: 'demo', flatNo: options.demoFlatNo }],
          primaryFlatNo: options.demoFlatNo,
          view: 'Resident',
          availableViews: ['Resident', 'Manager', 'Committee'],
        }
      : session === null
        ? null
        : {
            email: session.email,
            roles: session.roles,
            permissions: session.permissions,
            flats: session.flats,
            // The signed-in member's own flat, from the owner record. No
            // constant, and no guess: an account with none gets an empty
            // string and the resident screens say there is no flat on record.
            primaryFlatNo: session.flats[0]?.flatNo ?? '',
            view: viewForRoles(session.roles),
            availableViews: viewsAvailable(session.roles),
          };

  const can = useCallback((permission: string): boolean => {
    if (resolved?.kind === 'demo') return true;
    return booksSession?.permissions.includes(permission) ?? false;
  }, [resolved, booksSession]);

  return {
    status,
    kind: resolved?.kind ?? null,
    store: resolved?.store ?? null,
    server: resolved?.server ?? null,
    client: resolved?.client ?? null,
    session: booksSession,
    note: resolved?.note ?? 'Opening the books…',
    error,
    version,
    can,
    signIn,
    requestLoginCode,
    signInWithCode,
    signOut,
    reload,
  };
}
