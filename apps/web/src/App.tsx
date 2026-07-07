import { useCallback, useEffect, useState } from 'react';
import { api, connectWs, formatBytes, type Account, type Job } from './api.js';
import { FolderPane, type Selected } from './FolderPane.js';

const ACTIVE = new Set(['queued', 'preparing', 'scanning', 'planning', 'running', 'retrying', 'paused']);

export function App() {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [notifications, setNotifications] = useState<{ id: string; type: string; at: string }[]>([]);
  const [bellPulse, setBellPulse] = useState(false);
  const [showBell, setShowBell] = useState(false);

  const [sourceId, setSourceId] = useState<string>('');
  const [destId, setDestId] = useState<string>('');
  const [selected, setSelected] = useState<Map<string, Selected>>(new Map());
  const [destFolder, setDestFolder] = useState<{ id: string; path: string }>({ id: 'root', path: '' });
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  const refreshAccounts = useCallback(() => api.listAccounts().then(setAccounts).catch(() => {}), []);
  const refreshJobs = useCallback(() => api.listJobs().then(setJobs).catch(() => {}), []);

  useEffect(() => {
    refreshAccounts();
    refreshJobs();
    const ws = connectWs((ev) => {
      const t = ev.t as string;
      if (t === 'notification') {
        setNotifications((n) => [{ id: String(ev.eventId), type: String(ev.type), at: String(ev.createdAt) }, ...n].slice(0, 30));
        setBellPulse(true);
        setTimeout(() => setBellPulse(false), 4000);
      }
      if (t === 'job.state' || t === 'file.state') refreshJobs();
    });
    return () => ws.close();
  }, [refreshAccounts, refreshJobs]);

  // Poll while jobs are active so progress bars move even between WS events.
  useEffect(() => {
    if (!jobs.some((j) => ACTIVE.has(j.state))) return;
    const t = setInterval(refreshJobs, 1200);
    return () => clearInterval(t);
  }, [jobs, refreshJobs]);

  // Drive OAuth returns to /?drive=connected — surface it and refresh.
  useEffect(() => {
    const p = new URLSearchParams(location.search);
    if (p.get('drive') === 'connected') {
      setToast('Google Drive connected');
      refreshAccounts();
      history.replaceState({}, '', '/');
    } else if (p.get('drive') === 'error') {
      setToast('Google Drive connection failed');
      history.replaceState({}, '', '/');
    }
  }, [refreshAccounts]);

  const megaAccounts = accounts.filter((a) => a.providerId === 'mega');
  const driveAccounts = accounts.filter((a) => a.providerId === 'gdrive');
  const source = accounts.find((a) => a.id === sourceId);
  const dest = accounts.find((a) => a.id === destId);

  const toggle = (item: Selected) => {
    const key = `${item.isFolder ? 'folder' : 'file'}:${item.nodeId}`;
    setSelected((m) => {
      const next = new Map(m);
      if (next.has(key)) next.delete(key);
      else next.set(key, item);
      return next;
    });
  };

  const startTransfer = async () => {
    if (!source || !dest || selected.size === 0) return;
    setBusy(true);
    try {
      await api.createJob({
        name: `${source.label} → ${dest.label}`,
        sourceAccountId: source.id,
        destAccountId: dest.id,
        sourceSelection: [...selected.values()],
        destFolderId: destFolder.id,
        destFolderPath: destFolder.path,
      });
      setSelected(new Map());
      setToast('Transfer started');
      refreshJobs();
    } catch (e) {
      setToast((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const unread = notifications.length;

  return (
    <div className="min-h-screen">
      <header className="flex items-center justify-between px-6 py-3 border-b border-slate-800 sticky top-0 bg-[#0b0f17]/90 backdrop-blur z-10">
        <h1 className="text-lg font-semibold flex items-center gap-2">
          <span>☁️</span> Cloud Copy
        </h1>
        <div className="relative">
          <button
            className={`relative text-2xl transition-transform ${bellPulse ? 'animate-bounce' : ''}`}
            onClick={() => setShowBell((s) => !s)}
            title="Notifications"
          >
            🔔
            {unread > 0 && (
              <span className="absolute -top-1 -right-1 flex h-4 w-4">
                {bellPulse && <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-red-500 opacity-75" />}
                <span className="relative inline-flex rounded-full h-4 w-4 bg-red-500 text-[10px] items-center justify-center">
                  {unread}
                </span>
              </span>
            )}
          </button>
          {showBell && (
            <div className="absolute right-0 mt-2 w-72 max-h-80 overflow-auto bg-slate-900 border border-slate-700 rounded-lg shadow-xl text-sm">
              {notifications.length === 0 ? (
                <div className="p-4 text-slate-500">No notifications</div>
              ) : (
                notifications.map((n) => (
                  <div key={n.id} className="px-3 py-2 border-b border-slate-800 last:border-0">
                    <div className="font-medium">{n.type}</div>
                    <div className="text-slate-500 text-xs">{new Date(n.at).toLocaleTimeString()}</div>
                  </div>
                ))
              )}
            </div>
          )}
        </div>
      </header>

      <main className="max-w-6xl mx-auto p-6 space-y-8">
        <Accounts
          megaAccounts={megaAccounts}
          driveAccounts={driveAccounts}
          onChange={refreshAccounts}
          onToast={setToast}
        />

        <section>
          <h2 className="text-sm font-semibold text-slate-400 uppercase mb-3">Transfer</h2>
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <select
                className="w-full bg-slate-800 border border-slate-700 rounded px-2 py-1.5 text-sm"
                value={sourceId}
                onChange={(e) => {
                  setSourceId(e.target.value);
                  setSelected(new Map());
                }}
              >
                <option value="">Select source (MEGA)…</option>
                {megaAccounts.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.label}
                  </option>
                ))}
              </select>
              <div className="h-96">
                {source ? (
                  <FolderPane account={source} mode="source" selected={selected} onToggle={toggle} />
                ) : (
                  <EmptyPane text="Pick a MEGA account to browse" />
                )}
              </div>
            </div>

            <div className="space-y-2">
              <select
                className="w-full bg-slate-800 border border-slate-700 rounded px-2 py-1.5 text-sm"
                value={destId}
                onChange={(e) => setDestId(e.target.value)}
              >
                <option value="">Select destination (Google Drive)…</option>
                {driveAccounts.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.label}
                  </option>
                ))}
              </select>
              <div className="h-96">
                {dest ? (
                  <FolderPane account={dest} mode="dest" onDestFolder={(id, path) => setDestFolder({ id, path })} />
                ) : (
                  <EmptyPane text="Pick a Drive account for the destination" />
                )}
              </div>
            </div>
          </div>

          <div className="mt-4 flex items-center justify-between">
            <div className="text-sm text-slate-400">{selected.size} item(s) selected</div>
            <button
              className="px-5 py-2 rounded-lg bg-sky-600 hover:bg-sky-500 disabled:opacity-40 disabled:cursor-not-allowed font-medium"
              disabled={!source || !dest || selected.size === 0 || busy}
              onClick={startTransfer}
            >
              {busy ? 'Starting…' : `Transfer →`}
            </button>
          </div>
        </section>

        <Jobs jobs={jobs} onAction={(id, a) => api.jobAction(id, a).then(refreshJobs)} />
      </main>

      {toast && (
        <div
          className="fixed bottom-6 left-1/2 -translate-x-1/2 bg-slate-800 border border-slate-600 px-4 py-2 rounded-lg shadow-lg text-sm cursor-pointer"
          onClick={() => setToast(null)}
        >
          {toast}
        </div>
      )}
    </div>
  );
}

function EmptyPane({ text }: { text: string }) {
  return (
    <div className="h-full border border-dashed border-slate-700 rounded-lg flex items-center justify-center text-slate-600 text-sm">
      {text}
    </div>
  );
}

function Accounts({
  megaAccounts,
  driveAccounts,
  onChange,
  onToast,
}: {
  megaAccounts: Account[];
  driveAccounts: Account[];
  onChange: () => void;
  onToast: (s: string) => void;
}) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);

  const addMega = async () => {
    if (!email || !password) return;
    setBusy(true);
    try {
      await api.addMega(email, password);
      setEmail('');
      setPassword('');
      onToast('MEGA account connected');
      onChange();
    } catch (e) {
      onToast((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const connectDrive = async () => {
    try {
      const url = await api.driveConnectUrl();
      location.href = url;
    } catch (e) {
      onToast((e as Error).message);
    }
  };

  const remove = async (id: string) => {
    await api.deleteAccount(id);
    onChange();
  };

  return (
    <section>
      <h2 className="text-sm font-semibold text-slate-400 uppercase mb-3">Accounts</h2>
      <div className="grid grid-cols-2 gap-4">
        <div className="border border-slate-700 rounded-lg p-4 bg-slate-900/40">
          <div className="font-medium mb-2">MEGA</div>
          <div className="flex gap-2 mb-3">
            <input
              className="flex-1 bg-slate-800 border border-slate-700 rounded px-2 py-1.5 text-sm"
              placeholder="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
            <input
              className="flex-1 bg-slate-800 border border-slate-700 rounded px-2 py-1.5 text-sm"
              placeholder="password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
            <button className="px-3 py-1.5 rounded bg-sky-600 hover:bg-sky-500 text-sm disabled:opacity-40" disabled={busy} onClick={addMega}>
              Add
            </button>
          </div>
          <AccountList accounts={megaAccounts} onRemove={remove} />
        </div>

        <div className="border border-slate-700 rounded-lg p-4 bg-slate-900/40">
          <div className="font-medium mb-2 flex items-center justify-between">
            Google Drive
            <button className="px-3 py-1.5 rounded bg-emerald-600 hover:bg-emerald-500 text-sm" onClick={connectDrive}>
              Connect
            </button>
          </div>
          <AccountList accounts={driveAccounts} onRemove={remove} />
        </div>
      </div>
    </section>
  );
}

function AccountList({ accounts, onRemove }: { accounts: Account[]; onRemove: (id: string) => void }) {
  if (accounts.length === 0) return <div className="text-slate-600 text-sm">None connected</div>;
  return (
    <ul className="space-y-1 text-sm">
      {accounts.map((a) => (
        <li key={a.id} className="flex items-center justify-between bg-slate-800/50 rounded px-2 py-1">
          <span className="truncate">
            {a.label} {a.status !== 'active' && <span className="text-amber-400">({a.status})</span>}
          </span>
          <button className="text-slate-500 hover:text-red-400" onClick={() => onRemove(a.id)}>
            ✕
          </button>
        </li>
      ))}
    </ul>
  );
}

function Jobs({ jobs, onAction }: { jobs: Job[]; onAction: (id: string, a: 'pause' | 'resume' | 'cancel' | 'retry') => void }) {
  if (jobs.length === 0) return null;
  return (
    <section>
      <h2 className="text-sm font-semibold text-slate-400 uppercase mb-3">Jobs</h2>
      <div className="space-y-3">
        {jobs.map((j) => {
          const pct = j.totalBytes > 0 ? Math.min(100, Math.round((j.transferredBytes / j.totalBytes) * 100)) : 0;
          return (
            <div key={j.id} className="border border-slate-700 rounded-lg p-3 bg-slate-900/40">
              <div className="flex items-center justify-between mb-2">
                <div className="font-medium">{j.name}</div>
                <div className="flex items-center gap-2">
                  <StateBadge state={j.state} />
                  {j.state === 'running' && <ActionBtn label="Pause" onClick={() => onAction(j.id, 'pause')} />}
                  {j.state === 'paused' && <ActionBtn label="Resume" onClick={() => onAction(j.id, 'resume')} />}
                  {(j.state === 'failed' || j.failedFiles > 0) && <ActionBtn label="Retry" onClick={() => onAction(j.id, 'retry')} />}
                  {ACTIVE.has(j.state) && <ActionBtn label="Cancel" onClick={() => onAction(j.id, 'cancel')} />}
                </div>
              </div>
              <div className="h-2 bg-slate-800 rounded overflow-hidden">
                <div className="h-full bg-sky-500 transition-all" style={{ width: `${pct}%` }} />
              </div>
              <div className="flex justify-between text-xs text-slate-400 mt-1">
                <span>
                  {j.completedFiles}/{j.totalFiles} files{j.failedFiles > 0 && <span className="text-red-400"> · {j.failedFiles} failed</span>}
                </span>
                <span>
                  {formatBytes(j.transferredBytes)} / {formatBytes(j.totalBytes)} ({pct}%)
                </span>
              </div>
              {j.error && <div className="text-red-400 text-xs mt-1">{j.error}</div>}
            </div>
          );
        })}
      </div>
    </section>
  );
}

function StateBadge({ state }: { state: string }) {
  const color =
    state === 'completed'
      ? 'bg-emerald-900 text-emerald-300'
      : state === 'failed'
        ? 'bg-red-900 text-red-300'
        : state === 'running'
          ? 'bg-sky-900 text-sky-300'
          : 'bg-slate-700 text-slate-300';
  return <span className={`text-xs px-2 py-0.5 rounded ${color}`}>{state}</span>;
}

function ActionBtn({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button className="text-xs px-2 py-0.5 rounded bg-slate-700 hover:bg-slate-600" onClick={onClick}>
      {label}
    </button>
  );
}
