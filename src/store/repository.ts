/**
 * Where the books are kept.
 *
 * One interface, so the store does not know whether it is talking to
 * localStorage or to a server. Phase 2 kept everything in memory and a refresh
 * lost it; this is the seam that fixes that and the same seam the Postgres
 * backend plugs into.
 *
 * Synchronous on purpose for the browser implementation: localStorage is
 * synchronous, and pretending otherwise would add an await to every call site
 * for no benefit. The server implementation is async, which is why
 * `AsyncBooksRepository` exists alongside it and the store accepts either.
 */

import type { BooksSnapshotData } from '../accounting';

export class RepositoryError extends Error {}

export interface BooksRepository {
  /** The saved books, or null when there are none yet. */
  load(): BooksSnapshotData | null;
  save(snapshot: BooksSnapshotData): void;
  /** Removes the saved books. Used by "reset to the seed". */
  clear(): void;
  /** Where this is storing things, for the screens to state plainly. */
  describe(): string;
  /** False when a write will not survive — a private window, blocked storage. */
  isDurable(): boolean;
}

export interface AsyncBooksRepository {
  load(): Promise<BooksSnapshotData | null>;
  save(snapshot: BooksSnapshotData): Promise<void>;
  clear(): Promise<void>;
  describe(): string;
  isDurable(): boolean;
}

const KEY = 'sb_books_snapshot_v3';
/** Older keys, read once so an existing install is not stranded. */
const LEGACY_KEYS = ['sb_books_snapshot_v2', 'sb_books_snapshot', 'gm_rwa_books'];

/** The slice of the Storage API this uses. Passed in, so it can be faked. */
export interface KeyValueStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/**
 * Books in a key-value store, normally the browser's localStorage.
 *
 * The store is a parameter rather than reached for through `window`, both so a
 * test can hand in a fake and so this module does not assume it is running in
 * a browser at all.
 *
 * Every read and write is wrapped: a private window, cleared site data or a
 * quota can each make localStorage throw, and the books screens going blank is
 * worse than them saying they could not be saved.
 */
export function localStorageRepository(storage: KeyValueStore): BooksRepository {
  const available = (): boolean => {
    try {
      const probe = '__sb_probe__';
      storage.setItem(probe, '1');
      storage.removeItem(probe);
      return true;
    } catch {
      return false;
    }
  };

  let lastError: string | null = null;

  return {
    load() {
      try {
        let text = storage.getItem(KEY);
        if (text === null) {
          for (const legacy of LEGACY_KEYS) {
            const old = storage.getItem(legacy);
            if (old !== null) { text = old; break; }
          }
        }
        if (text === null) return null;
        return JSON.parse(text) as BooksSnapshotData;
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
        // A corrupt or unreadable value is reported by `describe` and treated
        // as "no saved books" rather than taking the screen down. It is not
        // deleted: a human may want to recover it.
        return null;
      }
    },

    save(snapshot) {
      try {
        storage.setItem(KEY, JSON.stringify(snapshot));
        lastError = null;
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
        throw new RepositoryError(
          `The books could not be saved to this browser: ${lastError}. ` +
          `Anything posted since the last successful save will be lost on reload.`,
        );
      }
    },

    clear() {
      try {
        storage.removeItem(KEY);
        for (const legacy of LEGACY_KEYS) storage.removeItem(legacy);
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
      }
    },

    describe() {
      if (!available()) {
        return 'This browser is not allowing local storage, so nothing is being saved. ' +
               'Everything posted in this session will be lost when the tab closes.';
      }
      if (lastError !== null) {
        return `Saved in this browser only, and the last attempt reported: ${lastError}`;
      }
      return 'Saved in this browser only. It does not reach any server, is not backed up, ' +
             'and is not visible to anyone else — including the committee.';
    },

    isDurable() {
      return available();
    },
  };
}

/**
 * Books held in memory. What the tests use, and the honest fallback when a
 * browser refuses storage.
 */
export function memoryRepository(): BooksRepository {
  let held: BooksSnapshotData | null = null;
  return {
    load: () => held,
    save: (snapshot) => { held = snapshot; },
    clear: () => { held = null; },
    describe: () =>
      'Held in memory for this session only. Nothing is written anywhere and a reload loses it.',
    isDurable: () => false,
  };
}

/**
 * Picks a repository for the current environment.
 *
 * Falls back to memory where localStorage is unavailable, and says so through
 * `describe()` rather than appearing to persist.
 */
export function resolveRepository(storage?: KeyValueStore): BooksRepository {
  if (storage === undefined) return memoryRepository();
  const candidate = localStorageRepository(storage);
  return candidate.isDurable() ? candidate : memoryRepository();
}

/**
 * The browser's localStorage, or undefined where there is none.
 *
 * Reading `window.localStorage` can itself throw in a locked-down browser, so
 * even getting hold of it goes through a try.
 */
export function browserStorage(): KeyValueStore | undefined {
  try {
    const w = globalThis as { localStorage?: KeyValueStore };
    return w.localStorage;
  } catch {
    return undefined;
  }
}
