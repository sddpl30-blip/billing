/**
 * Draws a `ReportView`: status lines, headline figures, notes and tables.
 *
 * Tables scroll sideways inside their own card, so a wide ledger on a phone
 * never pushes the page wider than the screen.
 */

import { displayCell, type Cell, type ReportView, type StatusLine, type TableSpec } from './format';

const TONE: Record<StatusLine['tone'], string> = {
  good: 'bg-emerald-50 text-emerald-800 border-emerald-200',
  bad: 'bg-red-50 text-red-700 border-red-200',
  info: 'bg-[var(--mv-accent-soft)] text-[var(--mv-ink)] border-[var(--mv-accent-border)]',
};

const MARK: Record<StatusLine['tone'], string> = { good: '✓', bad: '✗', info: 'i' };

function isNumeric(cell: Cell): boolean {
  return typeof cell === 'number' || (typeof cell === 'object' && cell !== null);
}

function Table({ table, showTitle }: { table: TableSpec; showTitle: boolean }) {
  const align = (i: number) => (table.columns[i]?.numeric ? 'text-right' : 'text-left');
  return (
    <div className="bg-[var(--mv-surface)] border border-[var(--mv-border)] rounded-2xl shadow-xs sb-print-card">
      {showTitle && (
        <h4 className="px-4 pt-4 text-xs font-bold uppercase tracking-wider text-[var(--mv-muted)]">{table.title}</h4>
      )}
      <div className="overflow-x-auto sb-print-scroll">
        <table className="w-full text-xs text-[var(--mv-ink)] border-collapse">
          <caption className="sr-only">{table.title}</caption>
          <thead>
            <tr className="border-b border-[var(--mv-border)]">
              {table.columns.map((c, i) => (
                <th
                  key={c.label}
                  scope="col"
                  className={`px-4 py-3 text-[10px] font-bold uppercase tracking-wider text-[var(--mv-muted)] whitespace-nowrap ${align(i)}`}
                >
                  {c.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {table.rows.length === 0 && (
              <tr>
                <td colSpan={table.columns.length} className="px-4 py-6 text-center text-[var(--mv-muted)]">
                  {table.empty ?? 'Nothing to show.'}
                </td>
              </tr>
            )}
            {table.rows.map((row, r) => (
              <tr key={r} className="border-b border-[var(--mv-border)] last:border-b-0 align-top">
                {row.map((cell, i) => {
                  const text = displayCell(cell);
                  // The first text column names the row, so it is the row header.
                  if (i === 0) {
                    return (
                      <th key={i} scope="row" className={`px-4 py-2.5 font-semibold whitespace-nowrap ${align(i)}`}>
                        {text}
                      </th>
                    );
                  }
                  return (
                    <td
                      key={i}
                      className={`px-4 py-2.5 ${isNumeric(cell) ? 'font-mono whitespace-nowrap' : ''} ${align(i)} ${
                        typeof cell === 'string' && cell.length > 60 ? 'min-w-[16rem] max-w-[32rem] [overflow-wrap:anywhere]' : ''
                      }`}
                    >
                      {text}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
          {table.footer && table.footer.length > 0 && (
            <tfoot>
              {table.footer.map((row, r) => (
                <tr key={r} className={`font-bold ${r === 0 ? 'border-t-2 border-[var(--mv-ink)]' : ''}`}>
                  {row.map((cell, i) => {
                    const text = displayCell(cell);
                    return i === 0 || (text !== '' && !isNumeric(cell)) ? (
                      <th key={i} scope="row" className={`px-4 py-2.5 whitespace-nowrap ${align(i)}`}>{text}</th>
                    ) : (
                      <td key={i} className={`px-4 py-2.5 font-mono whitespace-nowrap ${align(i)}`}>{text}</td>
                    );
                  })}
                </tr>
              ))}
            </tfoot>
          )}
        </table>
      </div>
    </div>
  );
}

export function ReportOutput({ view }: { view: ReportView }) {
  return (
    <div className="space-y-4">
      <header>
        <h3 className="text-lg font-bold text-[var(--mv-ink)]">{view.title}</h3>
        <p className="text-xs text-[var(--mv-muted)]">{view.period}</p>
      </header>

      {view.status && view.status.length > 0 && (
        <ul className="space-y-2" aria-label="Checks">
          {view.status.map(s => (
            <li key={s.text} className={`flex items-start gap-2 border rounded-xl px-3 py-2 text-xs font-semibold ${TONE[s.tone]}`}>
              <span aria-hidden="true" className="font-bold">{MARK[s.tone]}</span>
              <span>{s.text}</span>
            </li>
          ))}
        </ul>
      )}

      {view.tiles && view.tiles.length > 0 && (
        <dl className="grid grid-cols-2 sm:grid-cols-3 gap-3">
          {view.tiles.map(t => (
            <div key={t.label} className="bg-[var(--mv-surface)] border border-[var(--mv-border)] p-4 rounded-2xl shadow-xs sb-print-card">
              <dt className="text-[10px] font-bold uppercase tracking-wider text-[var(--mv-muted)]">{t.label}</dt>
              <dd className="mt-1 text-base font-bold font-mono text-[var(--mv-ink)] break-words">{displayCell(t.value)}</dd>
            </div>
          ))}
        </dl>
      )}

      {view.notes?.map(n => (
        <p key={n} className="text-xs text-[var(--mv-muted)]">{n}</p>
      ))}

      {view.tables.map(t => (
        <Table key={t.title} table={t} showTitle={view.tables.length > 1} />
      ))}
    </div>
  );
}
