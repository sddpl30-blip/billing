/**
 * Which books the app is running on.
 *
 * Two, and the difference is not cosmetic:
 *
 *  · **server** — a PostgreSQL database behind the API. Every figure is read
 *    from it and every write goes through it, with the server deciding what
 *    this account may do. This is the production path.
 *  · **demo** — the local engine with its sample society, kept in the
 *    browser. The published demonstration site has no backend behind it and
 *    has to keep working; this is that, and it is labelled as that.
 *
 * `VITE_DATA_SOURCE` forces one. Left unset, a production build expects the
 * server (see `configuredDataSource`) and a development build asks the server
 * whether it is there and uses it if so. When the server is expected and
 * cannot be reached, that is an error on screen — the app does not open — and
 * not a silent fall back to sample data, which is the failure worth
 * preventing: a committee looking at demo figures and believing them.
 */

import { createBooksStore, type BooksReader, type BooksStore } from './booksStore';
import { localActions, type BooksActions } from './actions';
import { browserStorage, resolveRepository } from './repository';
import { createServerStore, type ServerBooksStore } from './serverStore';
import { systemClock, type Clock } from '../accounting';
import { ApiClient } from '../api/client';
import { apiBase, configuredDataSource, probe, type Reachability } from '../api/session';
import type { SourceVendorInvoice } from '../accounting';

export type DataSourceKind = 'server' | 'demo';

export interface ResolvedDataSource {
  readonly kind: DataSourceKind;
  /** What every screen reads. */
  readonly store: BooksReader;
  /** Every write, awaited, whichever books they go to. */
  readonly actions: BooksActions;
  /** The local store itself. Present in demo mode only. */
  readonly local?: BooksStore;
  /** Present in server mode only. */
  readonly server?: ServerBooksStore;
  readonly client?: ApiClient;
  /** What the health check said, when one was made. */
  readonly health?: Reachability;
  /** In words, for the screen that shows where the books are. */
  readonly note: string;
  /** Set when the app wanted the server and could not have it. */
  readonly error?: string;
  /**
   * True when the server was required and did not answer. The app shows an
   * error and nothing else: no sample data, and no buttons that would act on
   * books that are not there.
   */
  readonly unavailable?: boolean;
}

export interface ResolveOptions {
  readonly clock?: Clock;
  readonly vendorInvoices?: readonly SourceVendorInvoice[];
  readonly onUnauthenticated?: () => void;
  readonly onProblem?: (message: string) => void;
  /** Overrides the configured choice. The tests use it. */
  readonly force?: DataSourceKind | 'auto';
}

function demoSource(store: BooksStore, reason: string): ResolvedDataSource {
  return { kind: 'demo', store, local: store, actions: localActions(store), note: reason };
}

export async function resolveDataSource(
  options: ResolveOptions = {},
): Promise<ResolvedDataSource> {
  const clock = options.clock ?? systemClock;
  const choice = options.force ?? configuredDataSource();

  const makeDemo = (): BooksStore => createBooksStore({
    clock,
    repository: resolveRepository(browserStorage()),
    mode: 'demo',
    ...(options.vendorInvoices === undefined ? {} : { vendorInvoices: options.vendorInvoices }),
  });

  if (choice === 'demo') {
    return demoSource(
      makeDemo(),
      'Demonstration data, kept in this browser. No server is configured for this build.',
    );
  }

  const client = new ApiClient({
    base: apiBase(),
    ...(options.onUnauthenticated === undefined ? {} : { onUnauthenticated: options.onUnauthenticated }),
  });
  const health = await probe(client);
  const server = (): ServerBooksStore => createServerStore({
    client,
    clock,
    ...(options.onProblem === undefined ? {} : { onProblem: options.onProblem }),
  });

  if (!health.reachable || !health.databaseReachable) {
    if (choice === 'server') {
      // Asked for the server, so this is an error and not a fallback. No demo
      // store is opened at all: sample data here is how a committee ends up
      // reading figures that belong to nobody, and demo buttons here would
      // look like they acted on the association's books.
      const empty = server();
      return {
        kind: 'server',
        store: empty,
        actions: empty.actions,
        server: empty,
        client,
        health,
        note: 'The SocietyBooks server could not be reached.',
        error: health.why ?? 'the API did not answer',
        unavailable: true,
      };
    }
    return {
      ...demoSource(
        makeDemo(),
        'Demonstration data, kept in this browser. No SocietyBooks server answered, so the ' +
        'sample society is being shown.',
      ),
      health,
    };
  }

  const connected = server();
  return {
    kind: 'server',
    store: connected,
    actions: connected.actions,
    server: connected,
    client,
    health,
    note: `Connected to the SocietyBooks server (schema ${health.schemaVersion ?? 'unknown'}).`,
  };
}
