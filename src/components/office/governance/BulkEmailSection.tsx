import { useState } from 'react';
import type { OfficeContext } from '../types';
import {
  listBulkEmails, previewBulkEmail, sendBulkEmail, sendQueuedNow, type BulkAudience,
} from '../../../api/office/governance';
import { Button, Card, LoadState, Table, cellClass, inputClass, labelClass, refusalOf, useLoad } from './ui';

/**
 * One e-mail to many residents: every owner, everyone with a portal login,
 * or the owners of named flats. E-mail only; for the notice board use
 * Notices. Checked first ("Check recipients" says how many and to whom), then
 * sent in small batches with progress, and listed below with what went out.
 */
export function BulkEmailSection({ ctx }: { ctx: OfficeContext }) {
  const history = useLoad(() => listBulkEmails(ctx.client), [ctx]);
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [audience, setAudience] = useState<BulkAudience>('owners');
  const [flatsText, setFlatsText] = useState('');
  const [checked, setChecked] = useState<{ recipients: number; sample: string[] } | null>(null);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  const flats = flatsText.split(/[\s,;]+/).map(f => f.trim()).filter(f => f !== '');
  const input = () => ({
    subject: subject.trim(), body: body.trim(), audience,
    ...(audience === 'flats' ? { flats } : {}),
  });
  const valid = (): boolean => {
    if (subject.trim().length < 3) { setProblem('Write a subject of at least 3 letters.'); return false; }
    if (body.trim() === '') { setProblem('Write the message.'); return false; }
    if (audience === 'flats' && flats.length === 0) { setProblem('List the flat numbers.'); return false; }
    setProblem(null);
    return true;
  };

  const check = async () => {
    if (!valid()) return;
    setBusy(true);
    try { setChecked(await previewBulkEmail(ctx.client, input())); }
    catch (err) { setProblem(refusalOf(err)); }
    finally { setBusy(false); }
  };

  const send = async () => {
    if (!valid() || checked === null) return;
    if (!window.confirm(`Send "${subject.trim()}" to ${checked.recipients} address${checked.recipients === 1 ? '' : 'es'}?`)) return;
    setBusy(true);
    try {
      const queued = await sendBulkEmail(ctx.client, input());
      if (queued.queued > 0 && queued.emailDelivers) {
        const r = await sendQueuedNow(ctx.client, (n, left) => setProgress(`Sending… ${n} sent, ${left} to go`));
        ctx.toast(
          `${r.sent} e-mail${r.sent === 1 ? '' : 's'} sent` +
          (r.failed > 0 ? `, ${r.failed} could not be sent` : '') +
          (r.remaining !== null && r.remaining > 0 ? `; ${r.remaining} left for the 6 am run.` : '.'),
          r.failed > 0 ? 'error' : 'info',
        );
      } else {
        ctx.toast(queued.note, 'info');
      }
      setSubject(''); setBody(''); setChecked(null);
      await history.refresh();
    } catch (err) {
      setProblem(refusalOf(err));
    } finally {
      setBusy(false); setProgress(null);
    }
  };

  const sends = history.data?.sends ?? [];

  return (
    <Card title="E-mail residents">
      <form className="space-y-3 max-w-xl" onSubmit={e => { e.preventDefault(); void (checked === null ? check() : send()); }}>
        <p className="text-xs text-[var(--mv-muted)]">
          An e-mail to many residents at once. It does not go on the notice board; use Notices for that.
        </p>
        <fieldset className="space-y-1.5">
          <legend className={labelClass}>Send to</legend>
          {([
            ['owners', 'Every owner on record'],
            ['portal-users', 'Everyone with a portal login'],
            ['flats', 'Only these flats'],
          ] as const).map(([value, label]) => (
            <div key={value} className="flex items-center gap-2">
              <input id={`bulk-aud-${value}`} type="radio" name="bulk-audience" checked={audience === value}
                onChange={() => { setAudience(value); setChecked(null); }} className="w-4 h-4 accent-[var(--mv-accent)]" />
              <label htmlFor={`bulk-aud-${value}`} className="text-sm text-[var(--mv-ink)]">{label}</label>
            </div>
          ))}
        </fieldset>
        {audience === 'flats' && (
          <div>
            <label htmlFor="bulk-flats" className={labelClass}>Flat numbers (separated by commas or spaces)</label>
            <input id="bulk-flats" className={inputClass} value={flatsText}
              onChange={e => { setFlatsText(e.target.value); setChecked(null); }} placeholder="A-101, A-102, B-204" />
          </div>
        )}
        <div>
          <label htmlFor="bulk-subject" className={labelClass}>Subject</label>
          <input id="bulk-subject" className={inputClass} value={subject} maxLength={150}
            onChange={e => { setSubject(e.target.value); setChecked(null); }} />
        </div>
        <div>
          <label htmlFor="bulk-body" className={labelClass}>Message</label>
          <textarea id="bulk-body" className={`${inputClass} min-h-[160px]`} value={body} maxLength={10000}
            onChange={e => { setBody(e.target.value); setChecked(null); }} />
        </div>
        {checked !== null && (
          <p className="text-xs text-[var(--mv-ink)] bg-[var(--mv-page)] border border-[var(--mv-border)] rounded-lg p-2">
            Goes to <strong>{checked.recipients}</strong> address{checked.recipients === 1 ? '' : 'es'}
            {checked.sample.length > 0 ? `, e.g. ${checked.sample.join(', ')}` : ''}.
          </p>
        )}
        {problem !== null && <p role="alert" className="text-xs text-red-700">{problem}</p>}
        <div className="flex gap-2">
          <Button type="button" onClick={() => { void check(); }} disabled={busy}>Check recipients</Button>
          <Button tone="primary" type="button" onClick={() => { void send(); }}
            disabled={busy || checked === null || checked.recipients === 0}>
            {progress ?? (checked === null ? 'Send' : `Send to ${checked.recipients}`)}
          </Button>
        </div>
      </form>

      <div className="mt-6">
        <h4 className="text-xs font-bold uppercase tracking-wider text-[var(--mv-muted)] mb-2">Sent</h4>
        <LoadState loaded={history} empty="Nothing sent yet." isEmpty={sends.length === 0} />
        {sends.length > 0 && (
          <Table head={['Subject', 'When', 'By', 'Sent', 'Failed', 'Waiting']}>
            {sends.map(s => (
              <tr key={s.id}>
                <td className={`${cellClass} font-bold`}>{s.subject}</td>
                <td className={`${cellClass} whitespace-nowrap`}>{s.queuedAt.slice(0, 16)}</td>
                <td className={cellClass}>{s.by}</td>
                <td className={cellClass}>{s.sent}</td>
                <td className={`${cellClass} ${s.failed > 0 ? 'text-red-700 font-bold' : ''}`}>{s.failed}</td>
                <td className={cellClass}>{s.waiting}</td>
              </tr>
            ))}
          </Table>
        )}
      </div>
    </Card>
  );
}
