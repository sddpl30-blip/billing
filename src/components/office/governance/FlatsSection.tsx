import { useState } from 'react';
import {
  AREA_BASES, addFlat, listFlats, setOwner, type AreaBasis, type FlatRow, type NewFlat, type OwnerChange,
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
  const { busy, run } = useWrite(ctx, flats.refresh);
  const [adding, setAdding] = useState(false);
  const [importing, setImporting] = useState(false);
  const [changing, setChanging] = useState<FlatRow | null>(null);
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
              <td className={`${cellClass} break-words`}>{f.owner ?? <span className="text-[var(--mv-muted)]">no current owner</span>}</td>
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
                <Button onClick={() => setChanging(f)} aria-label={`Change owner of ${f.flatNo}`}>Change owner</Button>
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
