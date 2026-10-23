import React, { useState } from 'react';
import { Database, FileSpreadsheet, RefreshCw, Download } from 'lucide-react';
import { saveBlob } from '../invoiceExport';

interface BackupHubProps {
  backupHistory: any[];
  onTriggerBackup: (spreadsheetId: string) => void;
  onResetData: () => void;
  /**
   * True when the books are on the server. The Sheets demo, the local backup
   * log and the sandbox reset are demonstration features and are not shown;
   * the export is, because a copy of the books is a read.
   */
  onServer: boolean;
  /** The books as JSON, from the store — the same records the screens show. */
  exportJson: () => string;
}

export const BackupHub: React.FC<BackupHubProps> = ({
  backupHistory,
  onTriggerBackup,
  onResetData,
  onServer,
  exportJson,
}) => {
  const [spreadsheetId, setSpreadsheetId] = useState('1p4GmeAdowSMBilLiNgAcCoUntS88');
  const [syncing, setSyncing] = useState(false);
  // Nothing here talks to Google. There is no Sheets client, no OAuth token and
  // no network call anywhere in this file — `handleSync` is a 2s timer that writes
  // a row to the local backup log. The copy below says that, so the screen cannot
  // be mistaken for a working sync in a demo.
  const [connected, setConnected] = useState(true);
  const [toastMsg, setToastMsg] = useState('');

  const handleSync = () => {
    if (!spreadsheetId.trim()) return;
    setSyncing(true);
    setTimeout(() => {
      onTriggerBackup(spreadsheetId);
      setSyncing(false);
      setToastMsg('Demo only — the backup log got a row. Nothing was sent to Google Sheets.');
      setTimeout(() => setToastMsg(''), 4000);
    }, 2000);
  };

  const handleExport = () => {
    // The books from the store: the ledger and the documents, which is what
    // every figure on screen is derived from. This used to read the old demo
    // keys out of localStorage — empty on the server — under another
    // society's name.
    let json: string;
    try {
      json = exportJson();
    } catch (err) {
      setToastMsg(err instanceof Error ? err.message : 'The books could not be exported.');
      setTimeout(() => setToastMsg(''), 4000);
      return;
    }
    const stamp = new Date().toISOString().slice(0, 10);
    saveBlob(
      new Blob([json], { type: 'application/json;charset=utf-8' }),
      `ManiVista_books_${onServer ? 'server' : 'demo'}_${stamp}.json`,
    );
    setToastMsg(onServer
      ? 'The books as the server sent them, saved as JSON.'
      : 'The demonstration books, saved as JSON.');
    setTimeout(() => setToastMsg(''), 3000);
  };

  if (onServer) {
    return (
      <div className="space-y-3 text-left">
        <div className="bg-[var(--mv-surface)] border border-[var(--mv-border)] rounded-2xl p-4 space-y-3 shadow-sm">
          <span className="text-[10px] font-bold text-[var(--mv-muted)] uppercase tracking-wider block">Export</span>
          <p className="text-[11px] text-[var(--mv-muted)] leading-snug">
            A copy of the ledger and the billing documents, as this account can see them. The
            database itself is backed up on the server; nothing here changes it.
          </p>
          <button
            onClick={handleExport}
            className="w-full p-3 bg-[var(--mv-page)] border border-[var(--mv-border)] rounded-xl text-left text-xs flex items-center gap-2 hover:bg-[var(--mv-soft)] transition-all cursor-pointer"
          >
            <Download className="w-4 h-4 text-[var(--mv-ink)]" aria-hidden="true" />
            <span className="font-bold text-[var(--mv-ink)] text-[11px]">Download the books (JSON)</span>
          </button>
        </div>
        {toastMsg && (
          <div role="status" className="p-3 bg-[var(--mv-ink)] text-white text-xs font-bold rounded-xl text-center shadow-md">
            {toastMsg}
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-4 text-left">
      {/* Title */}
      <div className="bg-[var(--mv-accent-soft)] border border-[var(--mv-accent-border)] p-4 rounded-xl">
        <div className="flex items-start gap-2.5">
          <div className="p-2 bg-[var(--mv-surface)] text-[var(--mv-accent)] rounded-lg shadow-xs border border-[var(--mv-accent-soft)]">
            <FileSpreadsheet className="w-5 h-5" />
          </div>
          <div>
            <h4 className="font-bold text-sm text-[var(--mv-ink)] leading-tight">Google Sheets sync — not built yet</h4>
            <p className="text-[11px] text-[var(--mv-muted)] mt-0.5 leading-snug">
              The screen below is the intended flow. The sync button only writes to the
              local log; a real one needs a Google service account and a server to hold it.
              <span className="font-bold"> Database Export</span> further down is real — it
              downloads everything this browser holds.
            </p>
          </div>
        </div>
      </div>

      {/* Backup Setup Form */}
      <div className="bg-[var(--mv-surface)] border border-[var(--mv-border)] rounded-2xl p-4 space-y-3.5 shadow-sm">
        <div className="flex justify-between items-center pb-2 border-b border-[var(--mv-border)]">
          <span className="text-[10px] font-bold text-[var(--mv-muted)] uppercase tracking-wider">Cloud Configuration</span>
          <span className={`px-2 py-0.5 text-[9px] rounded-md font-bold flex items-center gap-1.5 ${
            connected ? 'bg-[#B45309] text-white' : 'bg-[var(--mv-soft)] text-[var(--mv-muted)]'
          }`}>
            <span className="w-1.5 h-1.5 bg-[var(--mv-surface)] rounded-full animate-pulse" />
            {connected ? 'DEMO' : 'DISCONNECTED'}
          </span>
        </div>

        {connected ? (
          <div className="space-y-3.5 pt-1">
            <div className="space-y-1">
              <span className="text-[10px] font-bold text-[var(--mv-muted)] uppercase tracking-wider block">Backup Account Coordinator</span>
              <div className="bg-[var(--mv-page)] p-2.5 rounded-xl text-xs font-bold text-[var(--mv-ink)] flex justify-between items-center border border-[var(--mv-border)]">
                <span>accounts@example.invalid</span>
                <span className="text-[10px] font-bold text-[var(--mv-muted)] bg-[var(--mv-soft)] px-2 py-0.5 rounded-md uppercase">Placeholder</span>
              </div>
            </div>

            <div className="space-y-1">
              <label htmlFor="backup-sheet-id" className="text-[10px] font-bold text-[var(--mv-muted)] uppercase tracking-wider block">Google Sheets Spreadsheet ID</label>
              <input
                id="backup-sheet-id"
                type="text"
                value={spreadsheetId}
                onChange={(e) => setSpreadsheetId(e.target.value)}
                placeholder="Spreadsheet ID URL slug"
                className="w-full bg-[var(--mv-surface)] border border-[var(--mv-border)] font-mono text-[11px] font-bold p-2.5 rounded-xl text-[var(--mv-ink)] focus:outline-[var(--mv-accent)]"
              />
              <span className="text-[9px] text-[var(--mv-muted)] mt-1 block leading-tight font-medium">
                Target Google sheet where financial ledgers are appended on backup release.
              </span>
            </div>

            <button
              onClick={handleSync}
              disabled={syncing}
              className="w-full py-2.5 px-4 bg-[var(--mv-accent)] text-white rounded-xl text-xs font-bold hover:brightness-90 transition-all flex items-center justify-center gap-2 shadow-xs active:scale-98 disabled:opacity-75 cursor-pointer"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${syncing ? 'animate-spin' : ''}`} />
              {syncing ? 'Running the demo sync...' : 'Run the sync (demo — writes to the log only)'}
            </button>
          </div>
        ) : (
          <div className="py-4 text-center space-y-2">
            <p className="text-xs text-[var(--mv-muted)]">Google Sheets account is not connected yet.</p>
            <button
              onClick={() => setConnected(true)}
              className="py-2 px-3 bg-black text-white rounded-lg text-[10px] font-bold uppercase transition-all"
            >
              Sign In with Google
            </button>
          </div>
        )}
      </div>

      {/* Database Utilities */}
      <div className="bg-[var(--mv-surface)] border border-[var(--mv-border)] rounded-2xl p-4 space-y-3 shadow-sm">
        <span className="text-[10px] font-bold text-[var(--mv-muted)] uppercase tracking-wider block mb-1">Local Database Utilities</span>

        <div className="grid grid-cols-2 gap-3">
          <button
            onClick={handleExport}
            className="p-3 bg-[var(--mv-page)] border border-[var(--mv-border)] rounded-xl text-left text-xs space-y-1.5 hover:bg-[var(--mv-soft)] flex flex-col justify-between transition-all active:scale-95 cursor-pointer"
          >
            <Download className="w-4 h-4 text-[var(--mv-ink)]" />
            <div>
              <p className="font-bold text-[var(--mv-ink)] text-[11px]">Database Export</p>
              <p className="text-[9px] text-[var(--mv-muted)] leading-tight font-medium mt-0.5">The ledger and documents, as JSON</p>
            </div>
          </button>

          <button
            onClick={onResetData}
            className="p-3 bg-[var(--mv-ink)] text-white rounded-xl text-left text-xs space-y-1.5 hover:bg-black flex flex-col justify-between transition-all active:scale-95 cursor-pointer"
          >
            <Database className="w-4 h-4 text-white" />
            <div>
              <p className="font-bold text-white text-[11px]">Reset Sandbox</p>
              <p className="text-[9px] text-[var(--mv-muted)] leading-tight font-medium mt-0.5">Wipe & Restore Defaults</p>
            </div>
          </button>
        </div>
      </div>

      {/* Cloud Sync History Logs */}
      <div className="bg-[var(--mv-surface)] border border-[var(--mv-border)] rounded-2xl p-4 space-y-3.5 shadow-sm">
        <span className="text-[10px] font-bold text-[var(--mv-muted)] uppercase tracking-wider block border-b border-[var(--mv-border)] pb-2">Backup History Log</span>

        <div className="space-y-2 max-h-[140px] overflow-y-auto pr-1 hide-scrollbar">
          {backupHistory.map((item) => (
            <div key={item.id} className="p-3 bg-[var(--mv-page)] rounded-xl border border-[var(--mv-border)] flex justify-between items-center text-xs">
              <div className="space-y-1">
                <div className="flex items-center gap-1.5">
                  <span className="font-bold text-[var(--mv-ink)]">Backup log entry</span>
                  <span className="text-[9px] font-bold text-[#B45309] bg-[#FFF7ED] px-1 rounded font-mono">{item.status}</span>
                </div>
                <div className="text-[9px] text-[var(--mv-muted)] font-mono leading-none font-medium">
                  Rows: {item.recordCount} • ID: {item.spreadsheetId || 'LocalExport'}
                </div>
              </div>
              <div className="text-right">
                <span className="text-[10px] text-[var(--mv-ink)] font-bold block">{item.date}</span>
                <span className="text-[9px] text-[var(--mv-muted)] font-mono block font-medium">reconciled</span>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Feedback Toast */}
      {toastMsg && (
        <div role="status" className="p-3 bg-[var(--mv-ink)] text-white text-xs font-bold rounded-xl text-center shadow-md">
          {toastMsg}
        </div>
      )}
    </div>
  );
};
