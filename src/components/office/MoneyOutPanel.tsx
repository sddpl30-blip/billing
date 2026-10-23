/**
 * Vendors & notes: the money going out, and adjustments to money coming in.
 *
 * The vendor master, vendor bills through their four separate steps (entered,
 * approved, booked, paid), the TDS those bills withheld and its remittance,
 * and credit and debit notes against tax invoices. Every figure is the
 * server's; after any write the panel re-reads its lists and asks the rest of
 * the app to reload, so no screen is left showing the books as they were.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  money, type BankAccount, type InvoiceNote, type TdsSummary, type Vendor, type VendorBill,
} from '../../api/office/money';
import { problemOf, type OfficeContext } from './types';
import { BillsSection } from './money/BillsSection';
import { NotesSection } from './money/NotesSection';
import { TdsSection, previousQuarter, quarterOf } from './money/TdsSection';
import { VendorsSection } from './money/VendorsSection';
import { todayIso } from './money/ui';

interface Loaded<T> { readonly value: T | null; readonly error: string | null }

const pending = { value: null, error: null } as const;

function settle<T>(result: PromiseSettledResult<T>): Loaded<T> {
  return result.status === 'fulfilled'
    ? { value: result.value, error: null }
    : { value: null, error: problemOf(result.reason) };
}

/** 'Q3-FY26-27' sorts after 'Q4-FY25-26'. */
function quarterKey(quarter: string): number {
  const match = /^Q([1-4])-FY(\d{2})-/.exec(quarter);
  return match === null ? 0 : Number(match[2]) * 10 + Number(match[1]);
}

export default function MoneyOutPanel({ ctx }: { ctx: OfficeContext }) {
  const [vendors, setVendors] = useState<Loaded<readonly Vendor[]>>(pending);
  const [bills, setBills] = useState<Loaded<readonly VendorBill[]>>(pending);
  const [notes, setNotes] = useState<Loaded<readonly InvoiceNote[]>>(pending);
  const [tds, setTds] = useState<Loaded<readonly TdsSummary[]>>(pending);
  const [bankAccounts, setBankAccounts] = useState<readonly BankAccount[]>([]);
  // Quarters someone asked to see beyond the recent ones, kept across reloads.
  const extraQuarters = useRef<string[]>([]);
  const canRead = ctx.can('report.read');

  const loadTds = useCallback(async (): Promise<Loaded<readonly TdsSummary[]>> => {
    try {
      // The server's own current quarter first, since its calendar is the one
      // the booking dates were checked against; then the year before it, and
      // the browser's quarter in case the two disagree.
      const current = await money.tds(ctx.client);
      const wanted = new Set<string>([quarterOf(todayIso()), ...extraQuarters.current]);
      let q: string | null = current.quarter;
      for (let i = 0; i < 3 && q !== null; i++) {
        q = previousQuarter(q);
        if (q !== null) wanted.add(q);
      }
      wanted.delete(current.quarter);
      const rest = await Promise.all([...wanted].map(quarter => money.tds(ctx.client, quarter)));
      const all = [current, ...rest].sort((a, b) => quarterKey(b.quarter) - quarterKey(a.quarter));
      return { value: all, error: null };
    } catch (err) {
      return { value: null, error: problemOf(err) };
    }
  }, [ctx]);

  const load = useCallback(async () => {
    if (!canRead) return;
    const [v, b, n, banks, t] = await Promise.allSettled([
      money.vendors(ctx.client),
      money.bills(ctx.client),
      money.notes(ctx.client),
      money.bankAccounts(ctx.client),
      loadTds(),
    ]);
    setVendors(settle(v));
    setBills(settle(b));
    setNotes(settle(n));
    // Choosing a bank account is optional on the server, so a failure here
    // only means the default operating account is used.
    setBankAccounts(banks.status === 'fulfilled' ? banks.value : []);
    setTds(t.status === 'fulfilled' ? t.value : { value: null, error: problemOf(t.reason) });
  }, [ctx, canRead, loadTds]);

  useEffect(() => { void load(); }, [load]);

  const afterWrite = useCallback(async () => {
    await Promise.all([load(), ctx.reload()]);
  }, [load, ctx]);

  const lookupQuarter = useCallback((quarter: string) => {
    if (!extraQuarters.current.includes(quarter)) extraQuarters.current.push(quarter);
    void loadTds().then(setTds);
  }, [loadTds]);

  if (!canRead) {
    return (
      <p className="text-sm text-[var(--mv-muted)]">
        Reading vendors, bills and notes needs report access, which this account does not have.
      </p>
    );
  }

  return (
    <div className="space-y-5 min-w-0">
      <VendorsSection ctx={ctx} vendors={vendors.value} error={vendors.error} onChanged={afterWrite} />
      <BillsSection
        ctx={ctx}
        bills={bills.value}
        vendors={vendors.value}
        bankAccounts={bankAccounts}
        error={bills.error}
        onChanged={afterWrite}
      />
      <TdsSection
        ctx={ctx}
        summaries={tds.value}
        error={tds.error}
        bankAccounts={bankAccounts}
        onLookup={lookupQuarter}
        onChanged={afterWrite}
      />
      <NotesSection ctx={ctx} notes={notes.value} error={notes.error} onChanged={afterWrite} />
    </div>
  );
}
