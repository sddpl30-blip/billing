import { useState } from 'react';
import type { OfficeContext } from '../types';
import { listNotices } from '../../NoticeBoard';
import { Button, Card, LoadState, inputClass, labelClass, refusalOf, useLoad } from './ui';

/**
 * The secretary's notices to residents: written here, shown on every
 * member's Home screen, and, if asked, e-mailed to every current owner. The
 * e-mails go out only once an e-mail service is set up; the server says so.
 */
export function NoticesSection({ ctx }: { ctx: OfficeContext }) {
  const loaded = useLoad(() => listNotices(ctx.client), [ctx]);
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [email, setEmail] = useState(true);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const notices = loaded.data?.notices ?? [];

  const publish = async () => {
    if (title.trim().length < 3) { setProblem('Give the notice a title of at least 3 letters.'); return; }
    if (body.trim() === '') { setProblem('Write the notice.'); return; }
    setProblem(null);
    setBusy(true);
    try {
      const r = await ctx.client.post<{ note: string }>('/api/notices', { title: title.trim(), body: body.trim(), email });
      ctx.toast(r.note, 'info');
      setTitle(''); setBody('');
      await loaded.refresh();
    } catch (err) {
      setProblem(refusalOf(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card title="Notices to residents">
      <form className="space-y-3 max-w-xl" onSubmit={e => { e.preventDefault(); void publish(); }}>
        <p className="text-xs text-[var(--mv-muted)]">
          A notice appears on every member&apos;s Home screen at once. Tick the box to e-mail it to every owner too.
        </p>
        <div>
          <label htmlFor="notice-title" className={labelClass}>Title</label>
          <input id="notice-title" className={inputClass} value={title} maxLength={120}
            onChange={e => setTitle(e.target.value)} placeholder="e.g. Water supply off on Sunday" />
        </div>
        <div>
          <label htmlFor="notice-body" className={labelClass}>Notice</label>
          <textarea id="notice-body" className={`${inputClass} min-h-[140px]`} value={body} maxLength={4000}
            onChange={e => setBody(e.target.value)} placeholder="What residents need to know, when, and whom to contact." />
        </div>
        <div className="flex items-center gap-2">
          <input id="notice-email" type="checkbox" checked={email} onChange={e => setEmail(e.target.checked)}
            className="w-4 h-4 accent-[var(--mv-accent)]" />
          <label htmlFor="notice-email" className="text-sm text-[var(--mv-ink)]">Also e-mail it to every owner</label>
        </div>
        {problem !== null && <p role="alert" className="text-xs text-red-700">{problem}</p>}
        <Button tone="primary" type="submit" disabled={busy}>{busy ? 'Publishing…' : 'Publish notice'}</Button>
      </form>

      <div className="mt-6">
        <h4 className="text-xs font-bold uppercase tracking-wider text-[var(--mv-muted)] mb-2">Published</h4>
        <LoadState loaded={loaded} empty="No notices yet." isEmpty={notices.length === 0} />
        <ul className="divide-y divide-[var(--mv-border)]">
          {notices.map(n => (
            <li key={n.id} className="py-2.5">
              <p className="font-bold text-sm text-[var(--mv-ink)]">{n.title}</p>
              <p className="text-[10px] text-[var(--mv-muted)]">{n.publishedAt.slice(0, 16)} · {n.by}</p>
              <p className="text-xs text-[var(--mv-ink)] mt-1 whitespace-pre-wrap">{n.body}</p>
            </li>
          ))}
        </ul>
      </div>
    </Card>
  );
}
