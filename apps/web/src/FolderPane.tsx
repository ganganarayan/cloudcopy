import { useEffect, useState } from 'react';
import { api, formatBytes, type Account, type Entry } from './api.js';

interface Crumb {
  id: string | undefined;
  name: string;
}

export interface Selected {
  nodeId: string;
  path: string;
  isFolder: boolean;
}

interface Props {
  account: Account;
  mode: 'source' | 'dest';
  /** source: currently selected items; dest: unused. */
  selected?: Map<string, Selected>;
  onToggle?: (item: Selected) => void;
  /** dest: report the currently open folder as the destination. */
  onDestFolder?: (id: string, path: string) => void;
}

export function FolderPane({ account, mode, selected, onToggle, onDestFolder }: Props) {
  const [crumbs, setCrumbs] = useState<Crumb[]>([{ id: undefined, name: account.label }]);
  const [folders, setFolders] = useState<Entry[]>([]);
  const [files, setFiles] = useState<Entry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const current = crumbs[crumbs.length - 1]!;

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    api
      .browse(account.id, current.id)
      .then((r) => {
        if (cancelled) return;
        setFolders(r.folders);
        setFiles(r.files);
      })
      .catch((e) => !cancelled && setError((e as Error).message))
      .finally(() => !cancelled && setLoading(false));
    if (mode === 'dest') onDestFolder?.(current.id ?? 'root', crumbs.map((c) => c.name).join('/'));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [account.id, current.id]);

  const open = (e: Entry) => setCrumbs((c) => [...c, { id: e.id, name: e.name }]);
  const goTo = (i: number) => setCrumbs((c) => c.slice(0, i + 1));
  const pathOf = (name: string) => [...crumbs.slice(1).map((c) => c.name), name].join('/');

  return (
    <div className="flex flex-col h-full border border-slate-700 rounded-lg overflow-hidden bg-slate-900/40">
      <div className="px-3 py-2 border-b border-slate-700 flex items-center gap-1 text-sm flex-wrap">
        <span className="text-slate-400 uppercase text-xs mr-2">{mode}</span>
        {crumbs.map((c, i) => (
          <span key={i} className="flex items-center gap-1">
            {i > 0 && <span className="text-slate-600">/</span>}
            <button className="hover:text-sky-400 truncate max-w-[10rem]" onClick={() => goTo(i)}>
              {c.name}
            </button>
          </span>
        ))}
      </div>

      {mode === 'dest' && (
        <div className="px-3 py-1.5 bg-emerald-900/30 text-emerald-300 text-xs border-b border-slate-700">
          Destination: {current.name}
        </div>
      )}

      <div className="flex-1 overflow-auto">
        {loading && <div className="p-4 text-slate-500 text-sm">Loading…</div>}
        {error && <div className="p-4 text-red-400 text-sm">{error}</div>}
        {!loading && !error && folders.length === 0 && files.length === 0 && (
          <div className="p-4 text-slate-500 text-sm">Empty folder</div>
        )}
        <ul className="text-sm">
          {folders.map((f) => {
            const key = `folder:${f.id}`;
            const isSel = selected?.has(key);
            return (
              <li key={f.id} className="flex items-center gap-2 px-3 py-1.5 hover:bg-slate-800/60">
                {mode === 'source' && (
                  <input
                    type="checkbox"
                    checked={!!isSel}
                    onChange={() => onToggle?.({ nodeId: f.id, path: pathOf(f.name), isFolder: true })}
                  />
                )}
                <button className="flex-1 text-left flex items-center gap-2" onClick={() => open(f)}>
                  <span>📁</span>
                  <span className="truncate">{f.name}</span>
                </button>
              </li>
            );
          })}
          {files.map((f) => {
            const key = `file:${f.id}`;
            const isSel = selected?.has(key);
            return (
              <li key={f.id} className="flex items-center gap-2 px-3 py-1.5 hover:bg-slate-800/60">
                {mode === 'source' && (
                  <input
                    type="checkbox"
                    checked={!!isSel}
                    onChange={() => onToggle?.({ nodeId: f.id, path: pathOf(f.name), isFolder: false })}
                  />
                )}
                <span className="flex-1 flex items-center gap-2">
                  <span>📄</span>
                  <span className="truncate">{f.name}</span>
                </span>
                <span className="text-slate-500 text-xs">{formatBytes(f.size ?? 0)}</span>
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}
