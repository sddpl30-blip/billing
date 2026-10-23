import { useState } from 'react';
import { Plus } from 'lucide-react';
import { formatRupees } from '../../../accounting';
import { money, type PayeeKind, type TdsSection, type Vendor } from '../../../api/office/money';
import type { OfficeContext } from '../types';
import {
  Card, Empty, Field, FormDialog, FormProblem, TableScroll,
  inputClass, numClass, primaryButton, tdClass, thClass,
} from './ui';

const SECTION_LABEL: Record<TdsSection | 'none', string> = {
  '194C': '194C — contractor',
  '194J': '194J — professional',
  '194I': '194I — rent',
  none: 'No withholding',
};

export function VendorsSection({ ctx, vendors, error, onChanged }: {
  ctx: OfficeContext;
  vendors: readonly Vendor[] | null;
  error: string | null;
  onChanged: () => Promise<void>;
}) {
  const [adding, setAdding] = useState(false);
  const canManage = ctx.can('vendor.manage');

  return (
    <Card
      title="Vendors"
      action={canManage && (
        <button type="button" className={`${primaryButton} inline-flex items-center gap-1.5`} onClick={() => setAdding(true)}>
          <Plus className="w-3.5 h-3.5" aria-hidden="true" /> Add vendor
        </button>
      )}
    >
      {error !== null ? <Empty>{error}</Empty>
        : vendors === null ? <Empty>Loading…</Empty>
        : vendors.length === 0 ? <Empty>No vendors yet.</Empty>
        : (
          <TableScroll label="Vendors">
            <thead>
              <tr className="border-b border-[var(--mv-border)]">
                <th scope="col" className={thClass}>Name</th>
                <th scope="col" className={thClass}>Category</th>
                <th scope="col" className={thClass}>TDS</th>
                <th scope="col" className={thClass}>PAN</th>
                <th scope="col" className={thClass}>Bank</th>
                <th scope="col" className={`${thClass} text-right`}>Payable</th>
              </tr>
            </thead>
            <tbody>
              {vendors.map(v => (
                <tr key={v.id} className="border-b border-[var(--mv-border)] last:border-0">
                  <td className={`${tdClass} font-bold`}>{v.name}{!v.active && <span className="ml-1 text-[var(--mv-muted)]">(inactive)</span>}</td>
                  <td className={tdClass}>{v.category}</td>
                  <td className={tdClass}>
                    {v.tdsSection === null || v.tdsSection === 'none' ? 'None' : v.tdsSection}
                    {v.payeeKind === 'individual-or-huf' && <span className="text-[var(--mv-muted)]"> · individual</span>}
                  </td>
                  <td className={tdClass}>{v.pan ?? '—'}</td>
                  <td className={tdClass}>{v.bankLast4 === null ? '—' : `••${v.bankLast4}`}</td>
                  <td className={numClass}>{formatRupees(v.payablePaise)}</td>
                </tr>
              ))}
            </tbody>
          </TableScroll>
        )}
      {adding && (
        <AddVendorDialog
          ctx={ctx}
          onClose={() => setAdding(false)}
          onAdded={async () => { setAdding(false); await onChanged(); }}
        />
      )}
    </Card>
  );
}

function AddVendorDialog({ ctx, onClose, onAdded }: {
  ctx: OfficeContext; onClose: () => void; onAdded: () => Promise<void>;
}) {
  const [name, setName] = useState('');
  const [category, setCategory] = useState('');
  const [tdsSection, setTdsSection] = useState<TdsSection | 'none'>('194C');
  const [payeeKind, setPayeeKind] = useState<PayeeKind>('company');
  const [pan, setPan] = useState('');
  const [gstin, setGstin] = useState('');
  const [bankLast4, setBankLast4] = useState('');
  const [bankIfsc, setBankIfsc] = useState('');

  const submit = async () => {
    if (name.trim() === '' || category.trim() === '') {
      throw new FormProblem('A vendor needs a name and a category.');
    }
    // Optional fields are left out rather than sent empty: the server checks
    // the shape of anything it is given, and an empty PAN is not a PAN.
    const opt = (value: string) => (value.trim() === '' ? undefined : value.trim().toUpperCase());
    const panValue = opt(pan);
    const gstinValue = opt(gstin);
    const last4 = opt(bankLast4);
    const ifsc = opt(bankIfsc);
    await money.addVendor(ctx.client, {
      name: name.trim(),
      category: category.trim(),
      tdsSection,
      payeeKind,
      ...(panValue === undefined ? {} : { pan: panValue }),
      ...(gstinValue === undefined ? {} : { gstin: gstinValue }),
      ...(last4 === undefined ? {} : { bankLast4: last4 }),
      ...(ifsc === undefined ? {} : { bankIfsc: ifsc }),
    });
    ctx.toast(`${name.trim()} added to the vendor master.`);
    await onAdded();
  };

  return (
    <FormDialog id="add-vendor" title="Add vendor" submitLabel="Add vendor" onClose={onClose} onSubmit={submit} ctx={ctx}>
      <Field id="vendor-name" label="Name">
        <input id="vendor-name" data-autofocus className={inputClass} value={name} onChange={e => setName(e.target.value)} maxLength={200} />
      </Field>
      <Field id="vendor-category" label="Category" hint="What they supply, e.g. Security, Lift AMC.">
        <input id="vendor-category" aria-describedby="vendor-category-hint" className={inputClass} value={category} onChange={e => setCategory(e.target.value)} maxLength={100} />
      </Field>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <Field id="vendor-tds" label="TDS section">
          <select id="vendor-tds" className={inputClass} value={tdsSection} onChange={e => setTdsSection(e.target.value as TdsSection | 'none')}>
            {(Object.keys(SECTION_LABEL) as Array<TdsSection | 'none'>).map(s => (
              <option key={s} value={s}>{SECTION_LABEL[s]}</option>
            ))}
          </select>
        </Field>
        <Field id="vendor-kind" label="Payee">
          <select id="vendor-kind" className={inputClass} value={payeeKind} onChange={e => setPayeeKind(e.target.value as PayeeKind)}>
            <option value="company">Company / firm</option>
            <option value="individual-or-huf">Individual or HUF</option>
          </select>
        </Field>
        <Field id="vendor-pan" label="PAN (optional)">
          <input id="vendor-pan" className={inputClass} value={pan} onChange={e => setPan(e.target.value)} maxLength={10} autoCapitalize="characters" />
        </Field>
        <Field id="vendor-gstin" label="GSTIN (optional)">
          <input id="vendor-gstin" className={inputClass} value={gstin} onChange={e => setGstin(e.target.value)} maxLength={15} autoCapitalize="characters" />
        </Field>
        <Field id="vendor-last4" label="Account, last 4 (optional)">
          <input id="vendor-last4" className={inputClass} value={bankLast4} onChange={e => setBankLast4(e.target.value)} maxLength={4} inputMode="numeric" />
        </Field>
        <Field id="vendor-ifsc" label="IFSC (optional)">
          <input id="vendor-ifsc" className={inputClass} value={bankIfsc} onChange={e => setBankIfsc(e.target.value)} maxLength={11} autoCapitalize="characters" />
        </Field>
      </div>
      <p className="text-[10px] text-[var(--mv-muted)]">
        Only the last four digits of the account are kept. Nothing here can send money to it.
      </p>
    </FormDialog>
  );
}
