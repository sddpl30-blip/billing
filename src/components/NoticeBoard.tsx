import { useEffect, useState } from 'react';
import { Megaphone } from 'lucide-react';
import type { ApiClient } from '../api/client';

/** The society's notices, newest first. Server mode only; anyone signed in reads it. */

export interface Notice {
  readonly id: string;
  readonly title: string;
  readonly body: string;
  readonly by: string;
  readonly publishedAt: string;
}

export function listNotices(client: ApiClient): Promise<{ notices: Notice[] }> {
  return client.get('/api/notices');
}

const when = (iso: string): string => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? iso.slice(0, 10)
    : d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' });
};

export function NoticeBoard({ client, limit = 5 }: { client: ApiClient; limit?: number }) {
  const [notices, setNotices] = useState<Notice[] | null>(null);
  const [open, setOpen] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    listNotices(client)
      .then(r => { if (live) setNotices(r.notices); })
      // An older server without notices: show nothing rather than an error.
      .catch(() => { if (live) setNotices([]); });
    return () => { live = false; };
  }, [client]);

  if (notices === null || notices.length === 0) return null;
  const shown = notices.slice(0, limit);

  return (
    <section
      aria-labelledby="notice-board-title"
      className="bg-[var(--mv-surface)] border border-[var(--mv-border)] rounded-2xl p-5 shadow-xs text-left"
    >
      <h3 id="notice-board-title" className="font-bold text-xs uppercase tracking-wider text-[var(--mv-ink)] flex items-center gap-2 mb-3">
        <Megaphone className="w-4 h-4 text-[var(--mv-accent)]" aria-hidden="true" /> Notices from the Association
      </h3>
      <ul className="divide-y divide-[var(--mv-border)]">
        {shown.map(n => (
          <li key={n.id} className="py-2.5">
            <button
              type="button"
              onClick={() => setOpen(open === n.id ? null : n.id)}
              aria-expanded={open === n.id}
              className="w-full flex items-start justify-between gap-3 text-left"
            >
              <span className="font-bold text-sm text-[var(--mv-ink)]">{n.title}</span>
              <span className="text-[10px] text-[var(--mv-muted)] whitespace-nowrap mt-0.5">{when(n.publishedAt)}</span>
            </button>
            {open === n.id && (
              <p className="mt-2 text-xs text-[var(--mv-ink)] whitespace-pre-wrap leading-relaxed">{n.body}</p>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
