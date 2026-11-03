import { listMailLog, sendQueuedNow } from '../../../api/office/governance';
import type { OfficeContext } from '../types';
import { Badge, Button, Card, LoadState, Table, cellClass, refusalOf, useLoad } from './ui';

/**
 * Every e-mail the portal has tried to send, with the answer of the mail
 * service. A message "failed" carries the exact error the service gave, which
 * is what to send when something does not arrive. A failed message is not
 * retried by itself: fix the cause, then send it again from where it came
 * from (the Welcome button on the account, for a welcome).
 */
export function MailLogSection({ ctx }: { ctx: OfficeContext }) {
  const log = useLoad(() => listMailLog(ctx.client), [ctx]);
  const rows = log.data?.messages ?? [];
  const waiting = rows.filter(r => r.state === 'queued').length;

  const sendWaiting = async () => {
    try {
      const r = await sendQueuedNow(ctx.client);
      ctx.toast(
        r.delivered ? `${r.sent} sent, ${r.failed} failed.` : 'No e-mail service is set up, so nothing was sent.',
        r.failed > 0 || !r.delivered ? 'error' : 'info',
      );
    } catch (err) {
      ctx.toast(refusalOf(err), 'error');
    }
    await log.refresh();
  };

  return (
    <Card
      title="E-mail log"
      actions={<Button onClick={() => { void log.refresh(); }}>Refresh</Button>}
    >
      <p className="text-xs text-[var(--mv-muted)] mb-3">
        {log.data === null ? '' : log.data.emailDelivers
          ? `The e-mail service is on (${log.data.provider}).`
          : 'No e-mail service is set up: nothing can be sent.'}
        {' '}Newest first, the last 100. A failed message shows the exact error the service gave.
      </p>
      {waiting > 0 && log.data?.emailDelivers === true && (
        <div className="mb-3 p-3 rounded-xl bg-amber-50 border border-amber-300 text-xs text-amber-900 flex flex-wrap items-center gap-2">
          <span className="flex-1 min-w-0">{waiting} message{waiting === 1 ? ' is' : 's are'} waiting to go out. Check who they are for before sending.</span>
          <Button onClick={() => { void sendWaiting(); }}>Send the waiting messages</Button>
        </div>
      )}
      <LoadState loaded={log} empty="Nothing has been sent or queued yet." isEmpty={rows.length === 0} />
      {rows.length > 0 && (
        <Table head={['When', 'To', 'About', 'State', 'What the service said']}>
          {rows.map(r => (
            <tr key={r.id}>
              <td className={`${cellClass} whitespace-nowrap`}>{r.queuedAt.slice(0, 16)}</td>
              <td className={`${cellClass} break-all`}>{r.to}</td>
              <td className={`${cellClass} break-words max-w-[220px]`}>{r.subject ?? r.template}</td>
              <td className={cellClass}>
                <Badge tone={r.state === 'sent' ? 'ok' : r.state === 'failed' ? 'warn' : 'muted'}>{r.state}</Badge>
              </td>
              <td className={`${cellClass} break-words max-w-[320px] ${r.state === 'failed' ? 'text-red-700 font-mono text-[11px]' : ''}`}>
                {r.state === 'failed' ? r.error
                  : r.state === 'sent' ? `${r.provider ?? ''} accepted it${r.sentAt ? ` at ${r.sentAt.slice(0, 16)}` : ''}`
                  : r.state === 'queued' ? 'Waiting to be sent' : ''}
              </td>
            </tr>
          ))}
        </Table>
      )}
    </Card>
  );
}
