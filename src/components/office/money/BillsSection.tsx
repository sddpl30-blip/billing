import { useState } from 'react';
import { Plus } from 'lucide-react';
import { accountsOfClass, formatRupees, percentOf, type Paise } from '../../../accounting';
import {
  money, type BankAccount, type PaymentMethod, type Vendor, type VendorBill,
} from '../../../api/office/money';
import { problemOf, type OfficeContext } from '../types';
import {
  Card, Empty, Field, FormDialog, FormProblem, TableScroll,
  inputClass, numClass, parseRupees, primaryButton, secondaryButton, tdClass, thClass, todayIso,
} from './ui';

const EXPENSE_ACCOUNTS = accountsOfClass('expenditure');

/**
 * The statutory rates in basis points, for the preview only. The server
 * computes the deduction it records and the toast reports that figure.
 */
const STATUTORY_BPS: Record<string, { company: number; 'individual-or-huf': number }> = {
  '194C': { company: 200, 'individual-or-huf': 100 },
  '194J': { company: 1000, 'individual-or-huf': 1000 },
  '194I': { company: 1000, 'individual-or-huf': 1000 },
};

const METHODS: ReadonlyArray<{ value: PaymentMethod; label: string }> = [
  { value: 'neft', label: 'NEFT' }, { value: 'rtgs', label: 'RTGS' }, { value: 'imps', label: 'IMPS' },
  { value: 'upi', label: 'UPI' }, { value: 'cheque', label: 'Cheque' }, { value: 'cash', label: 'Cash' },
];

function stateLabel(bill: VendorBill): string {
  if (bill.state === 'booked') {
    if (bill.paidPaise >= bill.netPayablePaise) return 'Paid';
    return bill.paidPaise > 0 ? 'Part paid' : 'Booked';
  }
  return bill.state === 'awaiting-approval' ? 'Awaiting approval'
    : bill.state === 'approved' ? 'Approved'
    : 'Rejected';
}

export function BillsSection({ ctx, bills, vendors, bankAccounts, error, onChanged }: {
  ctx: OfficeContext;
  bills: readonly VendorBill[] | null;
  vendors: readonly Vendor[] | null;
  bankAccounts: readonly BankAccount[];
  error: string | null;
  onChanged: () => Promise<void>;
}) {
  const [entering, setEntering] = useState(false);
  const [booking, setBooking] = useState<VendorBill | null>(null);
  const [paying, setPaying] = useState<VendorBill | null>(null);
  const [approving, setApproving] = useState<string | null>(null);

  const canEnter = ctx.can('vendor.manage');
  const canApprove = ctx.can('vendor.bill.approve');
  const canBook = ctx.can('vendor.bill.book');
  const canPay = ctx.can('vendor.pay');

  const approve = async (bill: VendorBill) => {
    setApproving(bill.id);
    try {
      const result = await money.approveBill(ctx.client, bill.id);
      ctx.toast(`${bill.billNo}: ${result.note}`);
      await onChanged();
    } catch (err) {
      ctx.toast(problemOf(err), 'error');
    } finally {
      setApproving(null);
    }
  };

  return (
    <Card
      title="Vendor bills"
      action={canEnter && (
        <button
          type="button"
          className={`${primaryButton} inline-flex items-center gap-1.5`}
          onClick={() => setEntering(true)}
          disabled={vendors === null || vendors.length === 0}
          title={vendors !== null && vendors.length === 0 ? 'Add a vendor first' : undefined}
        >
          <Plus className="w-3.5 h-3.5" aria-hidden="true" /> Enter bill
        </button>
      )}
    >
      <p className="text-[11px] text-[var(--mv-muted)]">
        Entered, approved, booked and paid are separate steps, and only payment moves the bank.
        Whoever enters a bill cannot approve it.
      </p>
      {error !== null ? <Empty>{error}</Empty>
        : bills === null ? <Empty>Loading…</Empty>
        : bills.length === 0 ? <Empty>No vendor bills yet.</Empty>
        : (
          <TableScroll label="Vendor bills">
            <thead>
              <tr className="border-b border-[var(--mv-border)]">
                <th scope="col" className={thClass}>Bill</th>
                <th scope="col" className={thClass}>Vendor</th>
                <th scope="col" className={thClass}>Date</th>
                <th scope="col" className={`${thClass} text-right`}>Gross</th>
                <th scope="col" className={`${thClass} text-right`}>TDS</th>
                <th scope="col" className={`${thClass} text-right`}>Net payable</th>
                <th scope="col" className={`${thClass} text-right`}>Paid</th>
                <th scope="col" className={thClass}>Status</th>
                <th scope="col" className={thClass}><span className="sr-only">Actions</span></th>
              </tr>
            </thead>
            <tbody>
              {bills.map(b => {
                const outstanding = b.netPayablePaise - b.paidPaise;
                return (
                  <tr key={b.id} className="border-b border-[var(--mv-border)] last:border-0">
                    <td className={`${tdClass} font-bold`}>{b.billNo}</td>
                    <td className={tdClass}>{b.vendor}</td>
                    <td className={tdClass}>{b.billDate}</td>
                    <td className={numClass}>{formatRupees(b.grossPaise)}</td>
                    <td className={numClass}>{formatRupees(b.tdsPaise)}</td>
                    <td className={numClass}>{formatRupees(b.netPayablePaise)}</td>
                    <td className={numClass}>{formatRupees(b.paidPaise)}</td>
                    <td className={tdClass}>{stateLabel(b)}</td>
                    <td className={`${tdClass} space-x-1.5`}>
                      {b.state === 'awaiting-approval' && canApprove && (
                        <button type="button" className={secondaryButton} disabled={approving === b.id}
                          onClick={() => void approve(b)} aria-label={`Approve bill ${b.billNo}`}>
                          {approving === b.id ? 'Approving…' : 'Approve'}
                        </button>
                      )}
                      {b.state === 'approved' && canBook && (
                        <button type="button" className={secondaryButton} onClick={() => setBooking(b)}
                          aria-label={`Book bill ${b.billNo}`}>Book</button>
                      )}
                      {b.state === 'booked' && outstanding > 0 && canPay && (
                        <button type="button" className={secondaryButton} onClick={() => setPaying(b)}
                          aria-label={`Pay bill ${b.billNo}`}>Pay</button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </TableScroll>
        )}
      {entering && vendors !== null && (
        <EnterBillDialog ctx={ctx} vendors={vendors} onClose={() => setEntering(false)}
          onDone={async () => { setEntering(false); await onChanged(); }} />
      )}
      {booking !== null && (
        <BookBillDialog ctx={ctx} bill={booking} onClose={() => setBooking(null)}
          onDone={async () => { setBooking(null); await onChanged(); }} />
      )}
      {paying !== null && (
        <PayBillDialog ctx={ctx} bill={paying} bankAccounts={bankAccounts} onClose={() => setPaying(null)}
          onDone={async () => { setPaying(null); await onChanged(); }} />
      )}
    </Card>
  );
}

function EnterBillDialog({ ctx, vendors, onClose, onDone }: {
  ctx: OfficeContext; vendors: readonly Vendor[]; onClose: () => void; onDone: () => Promise<void>;
}) {
  const active = vendors.filter(v => v.active);
  const [vendorId, setVendorId] = useState(active[0]?.id ?? '');
  const [billNo, setBillNo] = useState('');
  const [billDate, setBillDate] = useState(todayIso());
  const [expenseAccount, setExpenseAccount] = useState(EXPENSE_ACCOUNTS[0]?.code ?? '');
  const [gross, setGross] = useState('');
  const [gst, setGst] = useState('');
  const [override, setOverride] = useState('');

  const vendor = active.find(v => v.id === vendorId);
  const section = vendor?.tdsSection ?? 'none';
  const statutoryBps = section === 'none' ? 0 : STATUTORY_BPS[section]?.[vendor?.payeeKind ?? 'company'] ?? 0;
  const grossPaise = parseRupees(gross);
  const gstPaise = gst.trim() === '' ? 0 : parseRupees(gst);
  const overrideBps = override.trim() === '' ? null : Math.round(Number(override) * 100);
  const rateBps = overrideBps ?? statutoryBps;
  // Withholding is on the value of the service, not on GST shown separately.
  const previewTds: Paise | null = grossPaise !== null && gstPaise !== null && gstPaise <= grossPaise && Number.isFinite(rateBps)
    ? (rateBps === 0 ? 0 : percentOf(grossPaise - gstPaise, rateBps / 100))
    : null;

  const submit = async () => {
    if (vendor === undefined) throw new FormProblem('Choose a vendor.');
    if (billNo.trim() === '') throw new FormProblem("Enter the vendor's bill number.");
    if (grossPaise === null || grossPaise <= 0) throw new FormProblem('Enter the bill amount in rupees, e.g. 25000 or 25000.50.');
    if (gstPaise === null) throw new FormProblem('Enter the GST in rupees, or leave it blank.');
    if (overrideBps !== null && (!Number.isFinite(overrideBps) || overrideBps < 0 || overrideBps > 3000)) {
      throw new FormProblem('A certificate rate is a percentage between 0 and 30.');
    }
    const result = await money.enterBill(ctx.client, vendor.id, {
      billNo: billNo.trim(),
      billDate,
      expenseAccount,
      grossPaise,
      ...(gstPaise > 0 ? { inputGstPaise: gstPaise } : {}),
      ...(overrideBps === null ? {} : { tdsRateBps: overrideBps }),
    });
    ctx.toast(
      `${billNo.trim()} entered: TDS ${formatRupees(result.tdsPaise)} at ${result.tdsRateBps / 100}%, ` +
      `net payable ${formatRupees(result.netPayablePaise)}. ${result.note}`,
    );
    await onDone();
  };

  return (
    <FormDialog id="enter-bill" title="Enter vendor bill" submitLabel="Enter for approval" onClose={onClose} onSubmit={submit} ctx={ctx}>
      <Field id="bill-vendor" label="Vendor">
        <select id="bill-vendor" data-autofocus className={inputClass} value={vendorId} onChange={e => setVendorId(e.target.value)}>
          {active.map(v => <option key={v.id} value={v.id}>{v.name}</option>)}
        </select>
      </Field>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <Field id="bill-no" label="Vendor's bill no.">
          <input id="bill-no" className={inputClass} value={billNo} onChange={e => setBillNo(e.target.value)} maxLength={100} />
        </Field>
        <Field id="bill-date" label="Bill date">
          <input id="bill-date" type="date" className={inputClass} value={billDate} onChange={e => setBillDate(e.target.value)} />
        </Field>
      </div>
      <Field id="bill-account" label="Expense head">
        <select id="bill-account" className={inputClass} value={expenseAccount} onChange={e => setExpenseAccount(e.target.value)}>
          {EXPENSE_ACCOUNTS.map(a => <option key={a.code} value={a.code}>{a.code} · {a.name}</option>)}
        </select>
      </Field>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <Field id="bill-gross" label="Bill total incl. GST (₹)">
          <input id="bill-gross" inputMode="decimal" className={inputClass} value={gross} onChange={e => setGross(e.target.value)} />
        </Field>
        <Field id="bill-gst" label="GST on the bill (₹)">
          <input id="bill-gst" inputMode="decimal" className={inputClass} value={gst} onChange={e => setGst(e.target.value)} placeholder="0" />
        </Field>
      </div>
      <Field
        id="bill-rate"
        label="Lower-deduction certificate rate (%)"
        hint={section === 'none'
          ? 'This vendor is recorded as not subject to withholding.'
          : `Leave blank for the statutory ${statutoryBps / 100}% under ${section}.`}
      >
        <input id="bill-rate" aria-describedby="bill-rate-hint" inputMode="decimal" className={inputClass}
          value={override} onChange={e => setOverride(e.target.value)} disabled={section === 'none'} />
      </Field>
      <p className="text-[11px] text-[var(--mv-muted)]" aria-live="polite">
        {previewTds === null
          ? 'TDS is worked out on the bill less its GST.'
          : `About ${formatRupees(previewTds)} TDS, ${formatRupees((grossPaise ?? 0) - previewTds)} net payable. The server's figure is final.`}
      </p>
    </FormDialog>
  );
}

function BookBillDialog({ ctx, bill, onClose, onDone }: {
  ctx: OfficeContext; bill: VendorBill; onClose: () => void; onDone: () => Promise<void>;
}) {
  const [on, setOn] = useState(todayIso());
  const submit = async () => {
    const result = await money.bookBill(ctx.client, bill.id, on);
    ctx.toast(`${bill.billNo}: ${result.note}`);
    await onDone();
  };
  return (
    <FormDialog id="book-bill" title={`Book ${bill.billNo} to the ledger`} submitLabel="Book" onClose={onClose} onSubmit={submit} ctx={ctx}>
      <p className="text-xs text-[var(--mv-muted)]">
        Records the expense at {formatRupees(bill.grossPaise)}, a payable of {formatRupees(bill.netPayablePaise)} to {bill.vendor},
        and {formatRupees(bill.tdsPaise)} of TDS withheld. The TDS falls in the quarter of the booking date.
      </p>
      <Field id="book-on" label="Booking date">
        <input id="book-on" data-autofocus type="date" className={inputClass} value={on} onChange={e => setOn(e.target.value)} />
      </Field>
    </FormDialog>
  );
}

function PayBillDialog({ ctx, bill, bankAccounts, onClose, onDone }: {
  ctx: OfficeContext; bill: VendorBill; bankAccounts: readonly BankAccount[];
  onClose: () => void; onDone: () => Promise<void>;
}) {
  const outstanding = bill.netPayablePaise - bill.paidPaise;
  const [amount, setAmount] = useState((outstanding / 100).toFixed(2));
  const [paidOn, setPaidOn] = useState(todayIso());
  const [method, setMethod] = useState<PaymentMethod>('neft');
  const [paymentRef, setPaymentRef] = useState('');
  const [bankAccountId, setBankAccountId] = useState('');
  // One key for as long as this dialog is open: pressing Pay again after a
  // timeout is a retry of the same payment, which the server answers once.
  const [idempotencyKey] = useState(() => crypto.randomUUID());

  const submit = async () => {
    const amountPaise = parseRupees(amount);
    if (amountPaise === null || amountPaise <= 0) throw new FormProblem('Enter the amount paid in rupees.');
    if (paymentRef.trim() === '') throw new FormProblem('Enter the UTR, cheque number or other reference.');
    const result = await money.payBill(ctx.client, bill.id, {
      amountPaise, paidOn, method, paymentRef: paymentRef.trim(),
      ...(bankAccountId === '' ? {} : { bankAccountId }),
    }, idempotencyKey);
    ctx.toast(`${formatRupees(amountPaise)} to ${bill.vendor}. ${result.note}`);
    await onDone();
  };

  return (
    <FormDialog id="pay-bill" title={`Record payment of ${bill.billNo}`} submitLabel="Record payment" onClose={onClose} onSubmit={submit} ctx={ctx}>
      <p className="text-xs text-[var(--mv-muted)]">
        {formatRupees(outstanding)} outstanding to {bill.vendor}. This records a payment already made from the society's bank;
        it does not instruct the bank.
      </p>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <Field id="pay-amount" label="Amount (₹)">
          <input id="pay-amount" data-autofocus inputMode="decimal" className={inputClass} value={amount} onChange={e => setAmount(e.target.value)} />
        </Field>
        <Field id="pay-on" label="Paid on">
          <input id="pay-on" type="date" className={inputClass} value={paidOn} onChange={e => setPaidOn(e.target.value)} />
        </Field>
        <Field id="pay-method" label="Method">
          <select id="pay-method" className={inputClass} value={method} onChange={e => setMethod(e.target.value as PaymentMethod)}>
            {METHODS.map(m => <option key={m.value} value={m.value}>{m.label}</option>)}
          </select>
        </Field>
        <Field id="pay-ref" label="Reference">
          <input id="pay-ref" className={inputClass} value={paymentRef} onChange={e => setPaymentRef(e.target.value)} maxLength={100} />
        </Field>
      </div>
      {bankAccounts.length > 0 && (
        <Field id="pay-bank" label="Paid from">
          <select id="pay-bank" className={inputClass} value={bankAccountId} onChange={e => setBankAccountId(e.target.value)}>
            <option value="">Operating account (default)</option>
            {bankAccounts.filter(a => a.active).map(a => (
              <option key={a.id} value={a.id}>{a.label} · {a.bankName} ••{a.accountLast4}</option>
            ))}
          </select>
        </Field>
      )}
    </FormDialog>
  );
}
