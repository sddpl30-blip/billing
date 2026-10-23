import React, { useState } from 'react';
import { Database, FileSpreadsheet, RefreshCw, CheckCircle, Download, ExternalLink, HelpCircle } from 'lucide-react';

interface BackupHubProps {
  backupHistory: any[];
  onTriggerBackup: (spreadsheetId: string) => void;
  onResetData: () => void;
}

export const BackupHub: React.FC<BackupHubProps> = ({
  backupHistory,
  onTriggerBackup,
  onResetData
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

  const handleExportCSV = () => {
    // Collect local database states
    const rawData = {
      members: localStorage.getItem('gm_rwa_members') || '[]',
      invoices: localStorage.getItem('gm_rwa_invoices') || '[]',
      tickets: localStorage.getItem('gm_rwa_tickets') || '[]',
      vendors: localStorage.getItem('gm_rwa_vendors') || '[]',
      journal: localStorage.getItem('gm_rwa_journal') || '[]'
    };
    
    const jsonString = `data:text/json;charset=utf-8,${encodeURIComponent(JSON.stringify(rawData, null, 2))}`;
    const downloadAnchor = document.createElement('a');
    downloadAnchor.setAttribute('href', jsonString);
    downloadAnchor.setAttribute('download', 'Green_Meadows_SecurityBackup_Full.json');
    document.body.appendChild(downloadAnchor);
    downloadAnchor.click();
    downloadAnchor.remove();

    setToastMsg('Database backup JSON exported successfully!');
    setTimeout(() => setToastMsg(''), 3000);
  };

  return (
    <div className="space-y-4 text-left">
      {/* Title */}
      <div className="bg-[var(--mv-accent-soft)] border border-[var(--mv-accent-border)] p-4 rounded-xl">
        <div className="flex items-start gap-2.5">
          <div className="p-2 bg-white text-[var(--mv-accent)] rounded-lg shadow-xs border border-[var(--mv-accent-soft)]">
            <FileSpreadsheet className="w-5 h-5" />
          </div>
          <div>
            <h4 className="font-bold text-sm text-[var(--mv-ink)] leading-tight">Google Sheets sync — not built yet</h4>
            <p className="text-[11px] text-[#6B7280] mt-0.5 leading-snug">
              The screen below is the intended flow. The sync button only writes to the
              local log; a real one needs a Google service account and a server to hold it.
              <span className="font-bold"> Database Export</span> further down is real — it
              downloads everything this browser holds.
            </p>
          </div>
        </div>
      </div>

      {/* Backup Setup Form */}
      <div className="bg-white border border-[var(--mv-border)] rounded-2xl p-4 space-y-3.5 shadow-sm">
        <div className="flex justify-between items-center pb-2 border-b border-[var(--mv-border)]">
          <span className="text-[10px] font-bold text-[#6B7280] uppercase tracking-wider">Cloud Configuration</span>
          <span className={`px-2 py-0.5 text-[9px] rounded-md font-bold flex items-center gap-1.5 ${
            connected ? 'bg-[#B45309] text-white' : 'bg-gray-200 text-gray-500'
          }`}>
            <span className="w-1.5 h-1.5 bg-white rounded-full animate-pulse" />
            {connected ? 'DEMO' : 'DISCONNECTED'}
          </span>
        </div>

        {connected ? (
          <div className="space-y-3.5 pt-1">
            <div className="space-y-1">
              <label className="text-[10px] font-bold text-[#6B7280] uppercase tracking-wider block">Backup Account Coordinator</label>
              <div className="bg-[var(--mv-page)] p-2.5 rounded-xl text-xs font-bold text-[var(--mv-ink)] flex justify-between items-center border border-[var(--mv-border)]">
                <span>accounts@greenmeadows.example</span>
                <span className="text-[10px] font-bold text-[#6B7280] bg-[var(--mv-soft)] px-2 py-0.5 rounded-md uppercase">Placeholder</span>
              </div>
            </div>

            <div className="space-y-1">
              <label className="text-[10px] font-bold text-[#6B7280] uppercase tracking-wider block">Google Sheets Spreadsheet ID</label>
              <input
                type="text"
                value={spreadsheetId}
                onChange={(e) => setSpreadsheetId(e.target.value)}
                placeholder="Spreadsheet ID URL slug"
                className="w-full bg-white border border-[var(--mv-border)] font-mono text-[11px] font-bold p-2.5 rounded-xl text-[var(--mv-ink)] focus:outline-[var(--mv-accent)]"
              />
              <span className="text-[9px] text-[#6B7280] mt-1 block leading-tight font-medium">
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
            <p className="text-xs text-[#6B7280]">Google Sheets account is not connected yet.</p>
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
      <div className="bg-white border border-[var(--mv-border)] rounded-2xl p-4 space-y-3 shadow-sm">
        <span className="text-[10px] font-bold text-[#6B7280] uppercase tracking-wider block mb-1">Local Database Utilities</span>
        
        <div className="grid grid-cols-2 gap-3">
          <button
            onClick={handleExportCSV}
            className="p-3 bg-[var(--mv-page)] border border-[var(--mv-border)] rounded-xl text-left text-xs space-y-1.5 hover:bg-gray-100 flex flex-col justify-between transition-all active:scale-95 cursor-pointer"
          >
            <Download className="w-4 h-4 text-[var(--mv-ink)]" />
            <div>
              <p className="font-bold text-[var(--mv-ink)] text-[11px]">Database Export</p>
              <p className="text-[9px] text-[#6B7280] leading-tight font-medium mt-0.5">Download Complete System JSON</p>
            </div>
          </button>

          <button
            onClick={onResetData}
            className="p-3 bg-[var(--mv-ink)] text-white rounded-xl text-left text-xs space-y-1.5 hover:bg-black flex flex-col justify-between transition-all active:scale-95 cursor-pointer"
          >
            <Database className="w-4 h-4 text-white" />
            <div>
              <p className="font-bold text-white text-[11px]">Reset Sandbox</p>
              <p className="text-[9px] text-gray-300 leading-tight font-medium mt-0.5">Wipe & Restore Defaults</p>
            </div>
          </button>
        </div>
      </div>

      {/* Cloud Sync History Logs */}
      <div className="bg-white border border-[var(--mv-border)] rounded-2xl p-4 space-y-3.5 shadow-sm">
        <span className="text-[10px] font-bold text-[#6B7280] uppercase tracking-wider block border-b border-[var(--mv-border)] pb-2">Backup History Log</span>
        
        <div className="space-y-2 max-h-[140px] overflow-y-auto pr-1 hide-scrollbar">
          {backupHistory.map((item) => (
            <div key={item.id} className="p-3 bg-[var(--mv-page)] rounded-xl border border-[var(--mv-border)] flex justify-between items-center text-xs">
              <div className="space-y-1">
                <div className="flex items-center gap-1.5">
                  <span className="font-bold text-[var(--mv-ink)]">Backup log entry</span>
                  <span className="text-[9px] font-bold text-[#B45309] bg-[#FFF7ED] px-1 rounded font-mono">{item.status}</span>
                </div>
                <div className="text-[9px] text-[#6B7280] font-mono leading-none font-medium">
                  Rows: {item.recordCount} • ID: {item.spreadsheetId || 'LocalExport'}
                </div>
              </div>
              <div className="text-right">
                <span className="text-[10px] text-[var(--mv-ink)] font-bold block">{item.date}</span>
                <span className="text-[9px] text-[#6B7280] font-mono block font-medium">reconciled</span>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Feedback Toast */}
      {toastMsg && (
        <div className="p-3 bg-[var(--mv-ink)] text-white text-xs font-bold rounded-xl text-center shadow-md animate-bounce">
          {toastMsg}
        </div>
      )}
    </div>
  );
};
