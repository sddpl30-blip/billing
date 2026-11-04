import { useState } from 'react';
import {
  AREA_BASES, addFlat, editContact, listDispatches, listFlats, readBlockList, resendBill, setOwner, type AreaBasis, type FlatRow, type NewFlat, type OwnerChange,
} from '../../../api/office/governance';
import type { OfficeContext } from '../types';
import { FlatImportDialog, downloadFlatTemplate } from './FlatImportDialog';
import {
  Badge, Button, Card, FormDialog, LoadState, Table, cellClass, inputClass, labelClass,
  todayInIndia, useLoad, useWrite,
} from './ui';

/** Flats and who holds them. Dues stay with the flat when the owner changes. */
export function FlatsSection({ ctx }: { ctx: OfficeContext }) {
  const flats = useLoad(() => listFlats(ctx.client), [ctx]);
  const blockList = useLoad(() => (ctx.can('notice.send') || ctx.can('member.manage') ? readBlockList(ctx.client) : Promise.resolve(null)), [ctx]);
  const blockedFlats = new Set((blockList.data?.blocked ?? []).map(b => b.flatNo));
  const { busy, run } = useWrite(ctx, async () => { await Promise.all([flats.refresh(), blockList.refresh()]); });
  const [adding, setAdding] = useState(false);
  const [importing, setImporting] = useState(false);
  const [changing, setChanging] = useState<FlatRow | null>(null);
  const [contact, setContact] = useState<FlatRow | null>(null);
  const [resending, setResending] = useState<FlatRow | null>(null);
  const [filter, setFilter] = useState('');
  const list = (flats.data ?? []).filter(f => {
    const q = filter.trim().toLowerCase();
    return q === '' || f.flatNo.toLowerCase().includes(q) || (f.owner ?? '').toLowerCase().includes(q);
  });

  return (
    <Card
      title="Flats and owners"
      actions={(
        <>
          <Button onClick={downloadFlatTemplate}>Download template</Button>
          <Button onClick={() => setImporting(true)}>Import from CSV</Button>
          <Button tone="primary" onClick={() => setAdding(true)}>Add a flat</Button>
        </>
      )}
    >
      <div>
        <label htmlFor="gov-flat-filter" className={labelClass}>Find a flat or owner</label>
        <input id="gov-flat-filter" className={`${inputClass} sm:max-w-xs`} value={filter} onChange={e => setFilter(e.target.value)} placeholder="e.g. B-204" />
      </div>
      {blockList.data !== null && blockList.data.checked && blockList.data.blocked.length > 0 && (
        <div role="alert" className="rounded-xl border-2 border-red-300 bg-red-50 p-3 text-xs text-red-900 space-y-1">
          <p className="font-bold uppercase tracking-wider text-[10px]">Brevo block-list status: bills to these addresses will not arrive</p>
          <ul className="space-y-0.5">
            {blockList.data.blocked.map(b => (
              <li key={`${b.flatNo}-${b.email}`} className="break-all">
                <strong>{b.flatNo}</strong> {b.owner}: {b.email}{b.primary ? ' (primary)' : ' (additional)'} — {b.reason}
              </li>
            ))}
          </ul>
          <p>Correct the address with Edit contact if it was wrong, or remove it from Brevo (Transactional → Blocklist) if it is right, then press Resend bill.</p>
        </div>
      )}
      {blockList.data !== null && blockList.data.checked && blockList.data.blocked.length === 0 && (
        <p className="text-[11px] text-[var(--mv-muted)]">Brevo block-list status: none of the owners' addresses is blocked.</p>
      )}
      {blockList.data !== null && !blockList.data.checked && blockList.data.problem !== null && (
        <p className="text-[11px] text-amber-900 bg-amber-50 border border-amber-300 rounded-xl p-2">
          Brevo block-list status could not be read: {blockList.data.problem}
        </p>
      )}
      <LoadState loaded={flats} empty={filter === '' ? 'No flats are on record.' : 'No flat matches.'} isEmpty={list.length === 0} />
      {list.length > 0 && (
        <Table head={['Flat', 'Owner', 'Billing area', 'Status', '']}>
          {list.map(f => (
            <tr key={f.id}>
              <td className={`${cellClass} font-bold whitespace-nowrap`}>
                {f.flatNo}
                {(f.wing !== null || f.floor !== null) && (
                  <span className="block text-[10px] font-normal text-[var(--mv-muted)]">
                    {[f.wing === null ? null : `Wing ${f.wing}`, f.floor === null ? null : `Floor ${f.floor}`].filter(Boolean).join(' · ')}
                  </span>
                )}
              </td>
              <td className={`${cellClass} break-words`}>
                {f.owner ?? <span className="text-[var(--mv-muted)]">no current owner</span>}
                {f.ownerGstin !== undefined && f.ownerGstin !== null && f.ownerGstin !== '' && (
                  <span className="block text-[10px] text-[var(--mv-muted)] font-mono">GSTIN {f.ownerGstin}</span>
                )}
                {blockedFlats.has(f.flatNo) && <Badge tone="warn">E-mail blocked</Badge>}
                {f.ownerEmails !== undefined && f.owner !== null && (
                  <span className="block text-[10px] text-[var(--mv-muted)] break-all">{f.ownerEmails === null || f.ownerEmails === '' ? 'no e-mail' : f.ownerEmails}</span>
                )}
              </td>
              <td className={`${cellClass} whitespace-nowrap`}>
                {f.billingAreaSqFt === null ? '—' : `${f.billingAreaSqFt.toLocaleString('en-IN')} sq ft ${f.areaBasis ?? '· basis pending verification'}`}
              </td>
              <td className={cellClass}>
                <div className="flex flex-wrap gap-1">
                  {f.billable
                    ? <Badge tone="ok">Billable</Badge>
                    : <Badge tone="warn">{f.billingAreaSqFt === null ? 'No area — cannot bill' : 'Basis pending — cannot bill'}</Badge>}
                  {f.nonOccupied && <Badge tone="muted">Non-occupied</Badge>}
                </div>
              </td>
              <td className={`${cellClass} text-right whitespace-nowrap`}>
                <div className="flex flex-wrap gap-1 justify-end">
                  {f.owner !== null && <Button onClick={() => setContact(f)} aria-label={`Edit contact of ${f.flatNo}`}>Edit contact</Button>}
                  {f.owner !== null && ctx.can('billing.release') && <Button onClick={() => setResending(f)} aria-label={`Resend bill of ${f.flatNo}`}>Resend bill</Button>}
                  <Button onClick={() => setChanging(f)} aria-label={`Change owner of ${f.flatNo}`}>Change owner</Button>
                </div>
              </td>
            </tr>
          ))}
        </Table>
      )}
      {importing && (
        <FlatImportDialog
          ctx={ctx}
          onClose={() => setImporting(false)}
          onImported={async () => { await Promise.all([ctx.reload(), flats.refresh()]); }}
        />
      )}
      {adding && (
        <AddFlatDialog
          busy={busy === 'add'}
          onClose={() => setAdding(false)}
          onSubmit={async flat => {
            const done = await run(
              'add', () => addFlat(ctx.client, flat),
              result => (result as { billable: boolean }).billable
                ? `Flat ${flat.flatNo} added.`
                : `Flat ${flat.flatNo} added without a billing area; it cannot be billed until one is recorded.`,
            );
            if (done) setAdding(false);
          }}
        />
      )}
      {contact !== null && (
        <ContactDialog
          flat={contact}
          busy={busy === 'contact'}
          onClose={() => setContact(null)}
          onSubmit={async input => {
            const done = await run('contact', () => editContact(ctx.client, contact.id, input), r => (r as { note: string }).note);
            if (done) setContact(null);
          }}
        />
      )}
      {resending !== null && (
        <ResendDialog ctx={ctx} flat={resending} onClose={() => setResending(null)} />
      )}
      {changing !== null && (
        <OwnerDialog
          flat={changing}
          busy={busy === 'owner'}
          onClose={() => setChanging(null)}
          onSubmit={async change => {
            const done = await run(
              'owner', () => setOwner(ctx.client, changing.id, change),
              result => (result as { note: string }).note,
            );
            if (done) setChanging(null);
          }}
        />
      )}
    </Card>
  );
}

function AddFlatDialog({ busy, onClose, onSubmit }: {
  busy: boolean; onClose: () => void; onSubmit: (flat: NewFlat) => void;
}) {
  const [flatNo, setFlatNo] = useState('');
  const [wing, setWing] = useState('');
  const [floor, setFloor] = useState('');
  const [area, setArea] = useState('');
  const [basis, setBasis] = useState<AreaBasis | ''>('');
  const [nonOccupied, setNonOccupied] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const submit = (): void => {
    if (flatNo.trim() === '') { setProblem('Enter the flat number.'); return; }
    if ((area.trim() === '') !== (basis === '')) {
      // The server refuses one without the other; saying so here saves a trip.
      setProblem('Give the billing area and its basis together, or neither.');
      return;
    }
    const areaN = Number(area);
    if (area.trim() !== '' && !(Number.isInteger(areaN) && areaN > 0)) { setProblem('The area is a whole number of square feet.'); return; }
    const floorN = Number(floor);
    if (floor.trim() !== '' && !Number.isInteger(floorN)) { setProblem('The floor is a whole number.'); return; }
    setProblem(null);
    onSubmit({
      flatNo: flatNo.trim(),
      ...(wing.trim() === '' ? {} : { wing: wing.trim() }),
      ...(floor.trim() === '' ? {} : { floor: floorN }),
      ...(area.trim() === '' || basis === '' ? {} : { billingAreaSqFt: areaN, areaBasis: basis }),
      ...(nonOccupied ? { nonOccupied: true } : {}),
    });
  };

  return (
    <FormDialog id="gov-add-flat" title="Add a flat" submitLabel="Add flat" busy={busy} onClose={onClose} onSubmit={submit}
      intro="A flat without a billing area and its basis is recorded but cannot be billed.">
      <div className="grid grid-cols-3 gap-3">
        <div>
          <label htmlFor="gov-flat-no" className={labelClass}>Flat no.</label>
          <input id="gov-flat-no" data-autofocus className={inputClass} value={flatNo} maxLength={20} onChange={e => setFlatNo(e.target.value)} required />
        </div>
        <div>
          <label htmlFor="gov-flat-wing" className={labelClass}>Wing</label>
          <input id="gov-flat-wing" className={inputClass} value={wing} maxLength={10} onChange={e => setWing(e.target.value)} />
        </div>
        <div>
          <label htmlFor="gov-flat-floor" className={labelClass}>Floor</label>
          <input id="gov-flat-floor" className={inputClass} inputMode="numeric" value={floor} onChange={e => setFloor(e.target.value)} />
        </div>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label htmlFor="gov-flat-area" className={labelClass}>Billing area (sq ft)</label>
          <input id="gov-flat-area" className={inputClass} inputMode="numeric" value={area} onChange={e => setArea(e.target.value)} />
        </div>
        <div>
          <label htmlFor="gov-flat-basis" className={labelClass}>Area basis</label>
          <select id="gov-flat-basis" className={inputClass} value={basis} onChange={e => setBasis(e.target.value as AreaBasis | '')}>
            <option value="">—</option>
            {AREA_BASES.map(b => <option key={b} value={b}>{b}</option>)}
          </select>
        </div>
      </div>
      <div className="flex items-center gap-2">
        <input id="gov-flat-nonocc" type="checkbox" checked={nonOccupied} onChange={e => setNonOccupied(e.target.checked)} className="w-4 h-4 accent-[var(--mv-accent)]" />
        <label htmlFor="gov-flat-nonocc" className="text-sm text-[var(--mv-ink)]">Non-occupied</label>
      </div>
      {problem !== null && <p role="alert" className="text-xs text-red-700">{problem}</p>}
    </FormDialog>
  );
}

function OwnerDialog({ flat, busy, onClose, onSubmit }: {
  flat: FlatRow; busy: boolean; onClose: () => void; onSubmit: (change: OwnerChange) => void;
}) {
  const [fullName, setFullName] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [role, setRole] = useState<OwnerChange['role']>('owner');
  const [heldFrom, setHeldFrom] = useState(todayInIndia());
  const [replaceCurrent, setReplaceCurrent] = useState(true);
  const [problem, setProblem] = useState<string | null>(null);

  return (
    <FormDialog
      id="gov-owner"
      title={`Change holder of ${flat.flatNo}`}
      intro={<>Current owner: <strong>{flat.owner ?? 'none'}</strong>. Anything already outstanding stays against the flat — the new holder does not inherit it and it is not cleared.</>}
      submitLabel="Record change"
      busy={busy}
      onClose={onClose}
      onSubmit={() => {
        if (fullName.trim() === '' || email.trim() === '') { setProblem('Enter the name and email.'); return; }
        setProblem(null);
        onSubmit({
          fullName: fullName.trim(), email: email.trim(), role, heldFrom, replaceCurrent,
          ...(phone.trim() === '' ? {} : { phone: phone.trim() }),
        });
      }}
    >
      <div>
        <label htmlFor="gov-owner-name" className={labelClass}>Full name</label>
        <input id="gov-owner-name" data-autofocus className={inputClass} value={fullName} maxLength={200} onChange={e => setFullName(e.target.value)} required />
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div>
          <label htmlFor="gov-owner-email" className={labelClass}>Email</label>
          <input id="gov-owner-email" type="email" className={inputClass} value={email} onChange={e => setEmail(e.target.value)} required />
        </div>
        <div>
          <label htmlFor="gov-owner-phone" className={labelClass}>Phone (optional)</label>
          <input id="gov-owner-phone" type="tel" className={inputClass} value={phone} onChange={e => setPhone(e.target.value)} />
        </div>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label htmlFor="gov-owner-role" className={labelClass}>Holds as</label>
          <select id="gov-owner-role" className={inputClass} value={role} onChange={e => setRole(e.target.value as OwnerChange['role'])}>
            <option value="owner">owner</option>
            <option value="co-owner">co-owner</option>
            <option value="tenant">tenant</option>
          </select>
        </div>
        <div>
          <label htmlFor="gov-owner-from" className={labelClass}>From</label>
          <input id="gov-owner-from" type="date" className={inputClass} value={heldFrom} onChange={e => setHeldFrom(e.target.value)} required />
        </div>
      </div>
      <div className="flex items-start gap-2">
        <input id="gov-owner-replace" type="checkbox" checked={replaceCurrent} onChange={e => setReplaceCurrent(e.target.checked)} className="w-4 h-4 mt-0.5 accent-[var(--mv-accent)]" />
        <label htmlFor="gov-owner-replace" className="text-sm text-[var(--mv-ink)]">
          Replaces the current {role} (a sale or a move): their tenure ends the day before
        </label>
      </div>
      {problem !== null && <p role="alert" className="text-xs text-red-700">{problem}</p>}
    </FormDialog>
  );
}

/** Fixes a typo in how to reach the owner. It is not a sale or a move, and nothing else changes. */
function ContactDialog({ flat, busy, onClose, onSubmit }: {
  flat: FlatRow; busy: boolean; onClose: () => void;
  onSubmit: (input: { emails: string; phone: string; gstin: string; reason?: string }) => void;
}) {
  const [emails, setEmails] = useState(flat.ownerEmails ?? '');
  const [phone, setPhone] = useState(flat.ownerPhone ?? '');
  const [gstin, setGstin] = useState(flat.ownerGstin ?? '');
  const [reason, setReason] = useState('');
  return (
    <FormDialog
      id="gov-edit-contact" title={`Edit contact: flat ${flat.flatNo}`} submitLabel="Save contact" busy={busy}
      intro={`For ${flat.owner ?? 'the owner'} (to change the name, use Corrections). This corrects the details only: no change of ownership, no ledger entry. The old and new values are written to the audit trail.`}
      onClose={onClose}
      onSubmit={() => onSubmit({ emails: emails.trim(), phone: phone.trim(), gstin: gstin.trim(), ...(reason.trim() === '' ? {} : { reason: reason.trim() }) })}
    >
      <div>
        <label htmlFor="ct-emails" className={labelClass}>E-mail address(es)</label>
        <textarea id="ct-emails" data-autofocus className={inputClass} rows={2} maxLength={1000} value={emails} onChange={e => setEmails(e.target.value)} />
        <p className="text-[10px] text-[var(--mv-muted)] mt-1">Separate several with a comma or semicolon. The first is the primary address; bills go to all of them.</p>
      </div>
      <div>
        <label htmlFor="ct-phone" className={labelClass}>Phone</label>
        <input id="ct-phone" className={inputClass} inputMode="tel" maxLength={20} value={phone} onChange={e => setPhone(e.target.value)} />
      </div>
 <div>
        <label htmlFor="ct-gstin" className={labelClass}>GSTIN (only if the owner is a registered business)</label>
        <input id="ct-gstin" className={`${inputClass} uppercase font-mono`} maxLength={15} value={gstin}
          onChange={e => setGstin(e.target.value.toUpperCase().replace(/\s+/g, ''))} placeholder="e.g. 19AAAAA0000A1Z5" />
        <p className="text-[10px] text-[var(--mv-muted)] mt-1">15 characters; the server checks the state code and the last character. Printed with the name under "Bill to" on the proforma and tax invoice. Leave blank for an individual; clear it to remove.</p>
      </div>
      <div>
        <label htmlFor="ct-reason" className={labelClass}>Note (optional)</label>
        <input id="ct-reason" className={inputClass} maxLength={300} value={reason} onChange={e => setReason(e.target.value)} placeholder="e.g. typo corrected as told by the owner" />
      </div>
    </FormDialog>
  );
}

interface FlatBill { id: string; proformaNo: string; taxInvoiceNo: string | null; flatNo: string; period: string; state: string }

/** Sends a released bill again to the addresses on record now, and shows what was sent before. */
function ResendDialog({ ctx, flat, onClose }: { ctx: OfficeContext; flat: FlatRow; onClose: () => void }) {
  const docs = useLoad(
    async () => (await ctx.client.get<{ documents: FlatBill[] }>('/api/billing/documents')).documents
      .filter(d => d.flatNo === flat.flatNo && (d.state === 'released' || d.state === 'tax-invoice') && !d.proformaNo.startsWith('OB/')),
    [ctx, flat.id],
  );
  const [chosen, setChosen] = useState('');
  const history = useLoad(() => (chosen === '' ? Promise.resolve([]) : listDispatches(ctx.client, chosen)), [ctx, chosen]);
  const { busy, run } = useWrite(ctx, history.refresh);
  const list = docs.data ?? [];
  return (
    <FormDialog
      id="gov-resend-bill" title={`Resend bill: flat ${flat.flatNo}`} submitLabel="Send again" busy={busy === 'resend'}
      intro={`Goes to: ${flat.ownerEmails ?? 'no e-mail on record'}. Only a bill already released can be sent again; the PDF is the copy that was issued.`}
      onClose={onClose}
      onSubmit={() => {
        if (chosen === '') return;
        void run('resend', () => resendBill(ctx.client, chosen), r => (r as { note: string }).note);
      }}
    >
      <LoadState loaded={docs} empty="This flat has no released bill." isEmpty={list.length === 0} />
      {list.length > 0 && (
        <div>
          <label htmlFor="rs-doc" className={labelClass}>Bill</label>
          <select id="rs-doc" data-autofocus className={inputClass} value={chosen} onChange={e => setChosen(e.target.value)}>
            <option value="">Choose…</option>
            {list.map(d => <option key={d.id} value={d.id}>{d.taxInvoiceNo ?? d.proformaNo} · {d.period}</option>)}
          </select>
        </div>
      )}
      {chosen !== '' && (
        <div className="space-y-1">
          <p className={labelClass}>Sent so far</p>
          {(history.data ?? []).length === 0
            ? <p className="text-xs text-[var(--mv-muted)]">Nothing recorded yet.</p>
            : (
              <ul className="text-xs space-y-1 max-h-40 overflow-y-auto">
                {(history.data ?? []).map((d, i) => (
                  <li key={i} className="break-words">
                    {d.at.slice(0, 16).replace('T', ' ')} · {d.channel} · {d.delivered ? <Badge tone="ok">sent</Badge> : <Badge tone="warn">not delivered</Badge>}
                    <span className="block text-[var(--mv-muted)]">{d.failure ?? d.note}{d.by === null ? '' : ` — ${d.by}`}</span>
                  </li>
                ))}
              </ul>
            )}
        </div>
      )}
    </FormDialog>
  );
}
