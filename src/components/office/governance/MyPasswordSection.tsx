import { useState } from 'react';
import { changeOwnPassword } from '../../../api/office/governance';
import type { OfficeContext } from '../types';
import { Button, Card, inputClass, labelClass, refusalOf } from './ui';

/**
 * The signed-in account's own password.
 *
 * The office cannot set an office-bearer's password, so this is the only way
 * one changes: with the current password, which a session left open on a
 * shared computer does not supply. Every other session of the account ends.
 */
export function MyPasswordSection({ ctx }: { ctx: OfficeContext }) {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [again, setAgain] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (current === '') { setProblem('Enter your current password.'); return; }
    if (next.length < 12) { setProblem('A new password is at least 12 characters.'); return; }
    if (next !== again) { setProblem('The two entries of the new password do not match.'); return; }
    setProblem(null);
    setBusy(true);
    try {
      const result = await changeOwnPassword(ctx.client, current, next);
      setCurrent(''); setNext(''); setAgain('');
      ctx.toast(
        result.otherSessionsEnded > 0
          ? `Password changed. You were signed out on ${String(result.otherSessionsEnded)} other device(s).`
          : 'Password changed.',
        'info',
      );
    } catch (err) {
      setProblem(refusalOf(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card title="My password">
      <form
        className="space-y-3 max-w-sm"
        onSubmit={e => { e.preventDefault(); void submit(); }}
      >
        <p className="text-xs text-[var(--mv-muted)]">
          Nobody else can set an office-bearer&apos;s password, so keep yours to yourself. Changing it signs
          you out everywhere else.
        </p>
        <div>
          <label htmlFor="my-password-current" className={labelClass}>Current password</label>
          <input id="my-password-current" type="password" className={inputClass} value={current}
            onChange={e => setCurrent(e.target.value)} autoComplete="current-password" required />
        </div>
        <div>
          <label htmlFor="my-password-new" className={labelClass}>New password (12+ characters)</label>
          <input id="my-password-new" type="password" className={inputClass} value={next}
            onChange={e => setNext(e.target.value)} autoComplete="new-password" required />
        </div>
        <div>
          <label htmlFor="my-password-again" className={labelClass}>New password again</label>
          <input id="my-password-again" type="password" className={inputClass} value={again}
            onChange={e => setAgain(e.target.value)} autoComplete="new-password" required />
        </div>
        {problem !== null && <p role="alert" className="text-xs text-red-700">{problem}</p>}
        <Button tone="primary" type="submit" disabled={busy}>{busy ? 'Changing…' : 'Change password'}</Button>
      </form>
    </Card>
  );
}
