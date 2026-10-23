import { useState } from 'react';
import { formatRupees, fromRupees } from '../../../accounting/money';
import {
  assignTicket, listTickets, listUsers, listVendors, resolveTicket, type Ticket,
} from '../../../api/office/governance';
import type { OfficeContext } from '../types';
import {
  Badge, Button, Card, FormDialog, LoadState, Table, cellClass, inputClass, labelClass,
  useLoad, useWrite,
} from './ui';

const DONE = new Set(['resolved', 'confirmed', 'closed']);

/** The staff side of the helpdesk: who picks a ticket up, and when it is done. */
export function HelpdeskSection({ ctx }: { ctx: OfficeContext }) {
  const tickets = useLoad(() => listTickets(ctx.client), [ctx]);
  const { busy, run } = useWrite(ctx, tickets.refresh);
  const [showDone, setShowDone] = useState(false);
  const [assigning, setAssigning] = useState<Ticket | null>(null);
  const [resolving, setResolving] = useState<Ticket | null>(null);
  const mayAssign = ctx.can('ticket.assign');
  const mayResolve = ctx.can('ticket.resolve');
  const all = tickets.data ?? [];
  const list = all.filter(t => showDone || !DONE.has(t.state));
  const breaching = all.filter(t => t.breachingSla).length;

  return (
    <Card title="Helpdesk queue">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-[var(--mv-muted)] flex-1 min-w-[200px]">
          {breaching > 0
            ? <strong className="text-red-700">{breaching} ticket{breaching === 1 ? ' is' : 's are'} past the SLA.</strong>
            : 'Nothing is past its SLA.'}{' '}
          A resolved ticket closes when the resident confirms it.
        </p>
        <div className="flex items-center gap-2">
          <input id="gov-tickets-done" type="checkbox" checked={showDone} onChange={e => setShowDone(e.target.checked)} className="w-4 h-4 accent-[var(--mv-accent)]" />
          <label htmlFor="gov-tickets-done" className="text-xs text-[var(--mv-ink)]">Show resolved and closed</label>
        </div>
      </div>
      <LoadState loaded={tickets} empty={showDone ? 'No tickets.' : 'No open tickets.'} isEmpty={list.length === 0} />
      {list.length > 0 && (
        <Table head={['Ticket', 'Flat', 'Issue', 'State', 'Due', '']}>
          {list.map(t => (
            <tr key={t.id}>
              <td className={`${cellClass} font-bold whitespace-nowrap`}>
                {t.ticketNo}
                <span className="block text-[10px] font-normal text-[var(--mv-muted)]">{t.priority}</span>
              </td>
              <td className={cellClass}>{t.flatNo ?? '—'}</td>
              <td className={`${cellClass} max-w-[260px] break-words`}>
                <span className="font-semibold">{t.category}</span>
                <span className="block text-[var(--mv-muted)]">{t.description}</span>
              </td>
              <td className={cellClass}>
                <Badge tone={DONE.has(t.state) ? 'ok' : t.state === 'assigned' ? 'muted' : 'warn'}>{t.state}</Badge>
              </td>
              <td className={`${cellClass} whitespace-nowrap`}>
                {t.dueAt.slice(0, 16)}
                {t.breachingSla && <span className="block text-[10px] font-bold text-red-700">past SLA</span>}
              </td>
              <td className={`${cellClass} text-right whitespace-nowrap space-x-2`}>
                {mayAssign && t.state !== 'closed' && !DONE.has(t.state) && (
                  <Button onClick={() => setAssigning(t)} aria-label={`Assign ${t.ticketNo}`}>{t.state === 'assigned' ? 'Reassign' : 'Assign'}</Button>
                )}
                {mayResolve && !DONE.has(t.state) && (
                  <Button tone="primary" onClick={() => setResolving(t)} aria-label={`Resolve ${t.ticketNo}`}>Resolve</Button>
                )}
              </td>
            </tr>
          ))}
        </Table>
      )}
      {assigning !== null && (
        <AssignDialog
          ctx={ctx}
          ticket={assigning}
          busy={busy === 'assign'}
          onClose={() => setAssigning(null)}
          onSubmit={async (to, label, note) => {
            const done = await run('assign', () => assignTicket(ctx.client, assigning.id, to, note), `${assigning.ticketNo} assigned to ${label}.`);
            if (done) setAssigning(null);
          }}
        />
      )}
      {resolving !== null && (
        <ResolveDialog
          ticket={resolving}
          busy={busy === 'resolve'}
          onClose={() => setResolving(null)}
          onSubmit={async (resolution, costPaise) => {
            const done = await run(
              'resolve', () => resolveTicket(ctx.client, resolving.id, resolution, costPaise),
              result => `${resolving.ticketNo}: ${(result as { note: string }).note}`,
            );
            if (done) setResolving(null);
          }}
        />
      )}
    </Card>
  );
}

interface Assignee { readonly value: string; readonly label: string; readonly to: { userId: string } | { vendorId: string } }

/**
 * Who a ticket can go to. Staff accounts come from the users list, which needs
 * user.manage; vendors need only report.read. An account without user.manage
 * can therefore assign to a vendor but not to a person — see the report.
 */
function AssignDialog({ ctx, ticket, busy, onClose, onSubmit }: {
  ctx: OfficeContext; ticket: Ticket; busy: boolean; onClose: () => void;
  onSubmit: (to: Assignee['to'], label: string, note: string | undefined) => void;
}) {
  const mayListUsers = ctx.can('user.manage');
  const options = useLoad(async (): Promise<Assignee[]> => {
    const [users, vendors] = await Promise.all([
      mayListUsers ? listUsers(ctx.client).then(r => r.users) : Promise.resolve([]),
      listVendors(ctx.client),
    ]);
    return [
      ...users
        .filter(u => u.active && u.roles.some(r => r !== 'resident'))
        .map(u => ({ value: `u:${u.id}`, label: `${u.email} (${u.roles.join(', ')})`, to: { userId: u.id } })),
      ...vendors
        .filter(v => v.active)
        .map(v => ({ value: `v:${v.id}`, label: `${v.name} — vendor, ${v.category}`, to: { vendorId: v.id } })),
    ];
  }, [ctx, mayListUsers]);
  const [choice, setChoice] = useState('');
  const [note, setNote] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const list = options.data ?? [];

  return (
    <FormDialog
      id="gov-assign-ticket"
      title={`Assign ${ticket.ticketNo}`}
      intro={<>{ticket.category}: {ticket.description}</>}
      submitLabel="Assign"
      busy={busy}
      onClose={onClose}
      onSubmit={() => {
        const picked = list.find(o => o.value === choice);
        if (picked === undefined) { setProblem('Choose who takes it.'); return; }
        setProblem(null);
        onSubmit(picked.to, picked.label, note.trim() === '' ? undefined : note.trim());
      }}
    >
      <div>
        <label htmlFor="gov-assign-to" className={labelClass}>Assign to</label>
        <select id="gov-assign-to" data-autofocus className={inputClass} value={choice} onChange={e => setChoice(e.target.value)} disabled={options.data === null}>
          <option value="">{options.data === null ? 'Loading…' : list.length === 0 ? 'Nobody available' : 'Choose…'}</option>
          {list.some(o => 'userId' in o.to) && (
            <optgroup label="Staff">
              {list.filter(o => 'userId' in o.to).map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
            </optgroup>
          )}
          {list.some(o => 'vendorId' in o.to) && (
            <optgroup label="Vendors">
              {list.filter(o => 'vendorId' in o.to).map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
            </optgroup>
          )}
        </select>
        {options.error !== null && <p role="alert" className="text-xs text-red-700 mt-1">{options.error}</p>}
        {!mayListUsers && (
          <p className="text-[11px] text-[var(--mv-muted)] mt-1">
            Staff accounts are listed only for someone who manages users, so only vendors are offered here.
          </p>
        )}
      </div>
      <div>
        <label htmlFor="gov-assign-note" className={labelClass}>Note (optional)</label>
        <input id="gov-assign-note" className={inputClass} value={note} maxLength={500} onChange={e => setNote(e.target.value)} />
      </div>
      {problem !== null && <p role="alert" className="text-xs text-red-700">{problem}</p>}
    </FormDialog>
  );
}

function ResolveDialog({ ticket, busy, onClose, onSubmit }: {
  ticket: Ticket; busy: boolean; onClose: () => void;
  onSubmit: (resolution: string, costPaise: number | undefined) => void;
}) {
  const [resolution, setResolution] = useState('');
  const [cost, setCost] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  return (
    <FormDialog
      id="gov-resolve-ticket"
      title={`Resolve ${ticket.ticketNo}`}
      intro="The resident is asked to confirm. If they say it is not fixed, the ticket reopens."
      submitLabel="Mark resolved"
      busy={busy}
      onClose={onClose}
      onSubmit={() => {
        if (resolution.trim() === '') { setProblem('A resolution needs a note.'); return; }
        let costPaise: number | undefined;
        if (cost.trim() !== '') {
          try {
            costPaise = fromRupees(Number(cost));
            if (costPaise < 0) throw new Error('negative');
          } catch {
            setProblem('The cost is an amount in rupees, to at most two decimals.');
            return;
          }
        }
        setProblem(null);
        onSubmit(resolution.trim(), costPaise);
      }}
    >
      <div>
        <label htmlFor="gov-resolve-note" className={labelClass}>What was done</label>
        <textarea id="gov-resolve-note" data-autofocus className={inputClass} rows={3} maxLength={2000}
          value={resolution} onChange={e => setResolution(e.target.value)} required />
      </div>
      <div>
        <label htmlFor="gov-resolve-cost" className={labelClass}>Cost (₹, optional)</label>
        <input id="gov-resolve-cost" className={inputClass} inputMode="decimal" value={cost} onChange={e => setCost(e.target.value)} placeholder="0.00" />
        {cost.trim() !== '' && Number.isFinite(Number(cost)) && Number(cost) >= 0 && (
          <p className="text-[11px] text-[var(--mv-muted)] mt-1">{safeFormat(cost)}</p>
        )}
      </div>
      {problem !== null && <p role="alert" className="text-xs text-red-700">{problem}</p>}
    </FormDialog>
  );
}

function safeFormat(rupees: string): string {
  try { return formatRupees(fromRupees(Number(rupees)), { paise: true }); } catch { return ''; }
}
