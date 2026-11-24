import { useEffect } from 'react';
import { ADDRESS, ASSOCIATION, POLICY_PAGES, type PolicyPage } from '../policies/content';

const base = (): string => ((import.meta as unknown as { env?: { BASE_URL?: string } }).env?.BASE_URL ?? '/').replace(/\/$/, '');
const href = (path: string): string => `${base()}${path}`;

/** The four links, for the sign-in screen and every page's footer. */
export function PolicyLinks({ className = '' }: { className?: string }) {
  return (
    <nav aria-label="Policies" className={`flex flex-wrap items-center justify-center gap-x-4 gap-y-1 text-[11px] ${className}`}>
      {POLICY_PAGES.map(p => (
        <a key={p.key} href={href(p.path)} className="text-[var(--mv-muted)] hover:text-[var(--mv-accent)] underline-offset-2 hover:underline">
          {p.navLabel}
        </a>
      ))}
    </nav>
  );
}

/** Appears under the whole app, so every screen carries the links. */
export function PolicyFooter() {
  return (
    <footer className="border-t border-[var(--mv-border)] bg-[var(--mv-page)] px-4 py-3 text-center space-y-1">
      <PolicyLinks />
      <p className="text-[10px] text-[var(--mv-muted)]">{ASSOCIATION}</p>
    </footer>
  );
}

/** One public page. No sign-in, no data: only the Association's own text. */
export function PolicyPageView({ page }: { page: PolicyPage }) {
  useEffect(() => { document.title = `${page.title} | ${ASSOCIATION}`; }, [page]);
  return (
    <div className="min-h-screen flex flex-col bg-[var(--mv-page)] text-[var(--mv-ink)]">
      <main className="flex-1 w-full max-w-3xl mx-auto px-4 py-6 space-y-5">
        <header className="space-y-1">
          <a href={href('/')} className="text-[11px] font-bold text-[var(--mv-accent)] hover:underline">&larr; Resident portal sign-in</a>
          <h1 className="text-2xl font-extrabold">{ASSOCIATION}</h1>
          <p className="text-xs text-[var(--mv-muted)]">{ADDRESS}</p>
        </header>
        <nav aria-label="Policy pages" className="flex flex-wrap gap-2">
          {POLICY_PAGES.map(p => (
            <a
              key={p.key} href={href(p.path)} aria-current={p.key === page.key ? 'page' : undefined}
              className={`px-3 py-1.5 rounded-lg border text-xs font-semibold ${p.key === page.key
                ? 'bg-[var(--mv-accent)] text-white border-[var(--mv-accent)]'
                : 'bg-[var(--mv-surface)] text-[var(--mv-ink)] border-[var(--mv-border)] hover:border-[var(--mv-accent)]'}`}
            >
              {p.navLabel}
            </a>
          ))}
        </nav>
        <article className="bg-[var(--mv-surface)] border border-[var(--mv-border)] rounded-2xl p-5 sm:p-6 space-y-3">
          <h2 className="text-xl font-bold">{page.title}</h2>
          {page.updated !== null && <p className="text-xs text-[var(--mv-muted)]">Last updated: {page.updated}</p>}
          {page.blocks.map((b, i) => (
            <section key={i} className="space-y-1">
              {b.heading !== undefined && <h3 className="text-sm font-bold text-[var(--mv-accent)] pt-2">{b.heading}</h3>}
              {b.text !== undefined && <p className="text-sm leading-relaxed whitespace-pre-line">{b.text}</p>}
              {b.list !== undefined && (
                <ul className="list-disc pl-5 text-sm leading-relaxed space-y-0.5">{b.list.map(item => <li key={item}>{item}</li>)}</ul>
              )}
            </section>
          ))}
        </article>
      </main>
      <PolicyFooter />
    </div>
  );
}
