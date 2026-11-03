import { lazy, useEffect, useState, type ComponentType, type LazyExoticComponent } from 'react';

/**
 * A screen's code is downloaded the first time it opens. After a new release
 * the file it asks for (named by a hash of its contents) may no longer exist,
 * for a browser still holding the previous version, and the screen sat on
 * "Loading…" for good. So: if the download fails, reload the page once to get
 * the current version; if it fails again, say so with a Reload button, rather
 * than waiting silently.
 */
const FLAG = 'sb-chunk-reload';

function ReloadNotice() {
  return (
    <div role="alert" className="py-10 text-center text-xs text-[var(--mv-ink)] space-y-3">
      <p>This screen could not be loaded. The portal may have been updated.</p>
      <button type="button" onClick={() => window.location.reload()}
        className="px-4 py-2 rounded-xl bg-[var(--mv-ink)] text-white text-xs font-bold uppercase tracking-wider">
        Reload
      </button>
    </div>
  );
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function lazyWithRetry<T extends ComponentType<any>>(
  load: () => Promise<{ default: T }>,
): LazyExoticComponent<T> {
  return lazy(async () => {
    try {
      return await load();
    } catch (err) {
      // Reload once, but not again within a minute: a screen that still
      // cannot load after a fresh page gets the message instead of a loop.
      let recent = false;
      try {
        const last = Number(sessionStorage.getItem(FLAG) ?? '0');
        recent = Date.now() - last < 60_000;
        if (!recent) sessionStorage.setItem(FLAG, String(Date.now()));
      } catch { recent = true; }
      if (!recent) {
        window.location.reload();
        // Never resolves: the page is reloading.
        return new Promise<never>(() => undefined);
      }
      void err;
      return { default: ReloadNotice as unknown as T };
    }
  });
}

/** "Loading…", which after 15 seconds says it is taking long and offers Reload. */
export function SlowLoading({ className = '' }: { className?: string }) {
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setSlow(true), 15_000);
    return () => clearTimeout(timer);
  }, []);
  return (
    <div role="status" className={`text-sm text-[var(--mv-muted)] ${className}`}>
      <p>Loading…</p>
      {slow && (
        <p className="mt-2 text-xs">
          This is taking longer than it should.{' '}
          <button type="button" onClick={() => window.location.reload()} className="underline font-bold text-[var(--mv-ink)]">
            Reload the page
          </button>
        </p>
      )}
    </div>
  );
}
