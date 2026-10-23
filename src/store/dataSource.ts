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
 * `VITE_DATA_SOURCE` forces one. Left unset, the app asks the server whether
 * it is there and uses it if so. A deployment that means to be production
 * should set `VITE_DATA_SOURCE=server`, because then a server that cannot be
 * reached is an error on screen rather than a silent fall back to sample data
 * — which is the failure worth preventing: a committee looking at demo
 * figures and believing them.
 */

import { createBooksStore, type BooksStore } from './booksStore';
import { browserStorage, resolveRepository } from './repository';
import { createServerStore, type ServerBooksStore } from './serverStore';
import { systemClock, type Clock } from '../accounting';
import { ApiClient } from '../api/client';
import { apiBase, configuredDataSource, probe, type Reachability } from '../api/session';
import type { SourceVendorInvoice } from '../accounting';

export type DataSourceKind = 'server' | 'demo';

export interface ResolvedDataSource {
  readonly kind: DataSourceKind;
  readonly store: BooksStore;
  /** Present in server mode only. */
  readonly server?: ServerBooksStore;
  readonly client?: ApiClient;
  /** What the health check said, when one was made. */
  readonly health?: Reachability;
  /** In words, for the screen that shows where the books are. */
  readonly note: string;
  /** Set when the app wanted the server and could not have it. */
  readonly error?: string;
}

export interface ResolveOptions {
  readonly clock?: Clock;
  readonly vendorInvoices?: readonly SourceVendorInvoice[];
  readonly onUnauthenticated?: () => void;
  readonly onProblem?: (message: string) => void;
  /** Overrides the configured choice. The tests use it. */
  readonly force?: DataSourceKind | 'auto';
}

function demoSource(reason: string, error?: string): ResolvedDataSource {
  return {
    kind: 'demo',
    store: lastDemoStore as BooksStore,
    note: reason,
    ...(error === undefined ? {} : { error }),
  };
}

let lastDemoStore: BooksStore | null = null;

export async function resolveDataSource(
  options: ResolveOptions = {},
): Promise<ResolvedDataSource> {
  const clock = options.clock ?? systemClock;
  const choice = options.force ?? configuredDataSource();

  const makeDemo = (): BooksStore => {
    lastDemoStore = createBooksStore({
      clock,
      repository: resolveRepository(browserStorage()),
      mode: 'demo',
      ...(options.vendorInvoices === undefined ? {} : { vendorInvoices: options.vendorInvoices }),
    });
    return lastDemoStore;
  };

  if (choice === 'demo') {
    makeDemo();
    return demoSource(
      'Demonstration data, kept in this browser. No server is configured for this build.',
    );
  }

  const client = new ApiClient({
    base: apiBase(),
    ...(options.onUnauthenticated === undefined ? {} : { onUnauthenticated: options.onUnauthenticated }),
  });
  const health = await probe(client);

  if (!health.reachable || !health.databaseReachable) {
    if (choice === 'server') {
      // Asked for the server explicitly, so this is an error and not a
      // fallback. Showing sample data here is how a committee ends up
      // reading figures that belong to nobody.
      makeDemo();
      return {
        ...demoSource(
          'The server could not be reached, so nothing here is this association’s data.',
          health.why ?? 'the API did not answer',
        ),
        health,
      };
    }
    makeDemo();
    return {
      ...demoSource(
        'Demonstration data, kept in this browser. No SocietyBooks server answered, so the ' +
        'sample society is being shown.',
      ),
      health,
    };
  }

  const server = createServerStore({
    client,
    clock,
    ...(options.onProblem === undefined ? {} : { onProblem: options.onProblem }),
  });

  return {
    kind: 'server',
    store: server,
    server,
    client,
    health,
    note: `Connected to the SocietyBooks server (schema ${health.schemaVersion ?? 'unknown'}).`,
  };
}
