import { useState } from 'react';
import type { ConflictPolicy, TransferOptions } from './api.js';

const PRESETS: Record<string, string[]> = {
  Images: ['jpg', 'jpeg', 'png', 'gif', 'webp', 'heic', 'bmp', 'svg', 'tiff'],
  Videos: ['mp4', 'mkv', 'mov', 'avi', 'webm', 'flv', 'wmv', 'm4v'],
  Documents: ['pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'txt', 'csv', 'odt'],
  Audio: ['mp3', 'wav', 'flac', 'aac', 'ogg', 'm4a'],
  Archives: ['zip', 'rar', '7z', 'tar', 'gz'],
};

const CONFLICT_LABELS: Record<ConflictPolicy, string> = {
  skip: 'Skip if it already exists',
  skip_if_same_size: 'Skip only if same size',
  overwrite: 'Overwrite existing',
  rename: 'Keep both (rename)',
};

const csv = (s: string) => s.split(',').map((x) => x.trim()).filter(Boolean);
const mb = (bytes?: number) => (bytes != null ? String(Math.round(bytes / (1024 * 1024))) : '');

export function TransferOptionsPanel({
  value,
  onChange,
}: {
  value: TransferOptions;
  onChange: (o: TransferOptions) => void;
}) {
  const [open, setOpen] = useState(false);
  const set = (patch: Partial<TransferOptions>) => onChange({ ...value, ...patch });

  const activePreset = (exts: string[]) => exts.every((e) => value.includeExtensions.includes(e));
  const togglePreset = (exts: string[]) => {
    const has = activePreset(exts);
    const next = new Set(value.includeExtensions);
    for (const e of exts) has ? next.delete(e) : next.add(e);
    set({ includeExtensions: [...next] });
  };

  const summary = [
    CONFLICT_LABELS[value.conflictPolicy],
    value.includeExtensions.length ? `${value.includeExtensions.length} type(s)` : null,
    value.skipEmpty ? 'no empty' : null,
    value.minSizeBytes ? `≥${mb(value.minSizeBytes)}MB` : null,
    value.maxSizeBytes ? `≤${mb(value.maxSizeBytes)}MB` : null,
    value.recurse ? null : 'top-level only',
  ]
    .filter(Boolean)
    .join(' · ');

  return (
    <div className="border border-slate-700 rounded-lg bg-slate-900/40 text-sm">
      <button className="w-full flex items-center justify-between px-3 py-2" onClick={() => setOpen((o) => !o)}>
        <span className="font-medium">Transfer options</span>
        <span className="text-slate-400 text-xs truncate ml-3 max-w-[60%]">{summary}</span>
        <span className="ml-2 text-slate-500">{open ? '▲' : '▼'}</span>
      </button>

      {open && (
        <div className="px-3 pb-3 space-y-4 border-t border-slate-800 pt-3">
          <div>
            <div className="text-xs uppercase text-slate-500 mb-1">Operation</div>
            <div className="flex gap-2">
              {(['copy', 'move'] as const).map((op) => (
                <button
                  key={op}
                  onClick={() => set({ operation: op })}
                  className={`px-3 py-1.5 rounded border capitalize ${
                    value.operation === op ? 'bg-sky-600 border-sky-500' : 'bg-slate-800 border-slate-700'
                  }`}
                >
                  {op}
                </button>
              ))}
            </div>
            {value.operation === 'move' && (
              <div className="mt-2 text-xs text-red-300 bg-red-950/40 border border-red-900 rounded px-2 py-1.5">
                ⚠ Move deletes each source file from MEGA <b>after</b> it is transferred and verified.
                This is permanent. Requires delete permission on the source account.
              </div>
            )}
          </div>

          <div>
            <div className="text-xs uppercase text-slate-500 mb-1">If a file already exists</div>
            <select
              className="w-full bg-slate-800 border border-slate-700 rounded px-2 py-1.5"
              value={value.conflictPolicy}
              onChange={(e) => set({ conflictPolicy: e.target.value as ConflictPolicy })}
            >
              {(Object.keys(CONFLICT_LABELS) as ConflictPolicy[]).map((k) => (
                <option key={k} value={k}>
                  {CONFLICT_LABELS[k]}
                </option>
              ))}
            </select>
          </div>

          <div>
            <div className="text-xs uppercase text-slate-500 mb-1">File types (leave empty for all)</div>
            <div className="flex flex-wrap gap-1.5 mb-2">
              {Object.entries(PRESETS).map(([label, exts]) => (
                <button
                  key={label}
                  onClick={() => togglePreset(exts)}
                  className={`px-2 py-1 rounded text-xs border ${
                    activePreset(exts) ? 'bg-sky-600 border-sky-500' : 'bg-slate-800 border-slate-700'
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
            <input
              className="w-full bg-slate-800 border border-slate-700 rounded px-2 py-1.5"
              placeholder="Custom included extensions, e.g. psd, ai, raw"
              value={value.includeExtensions.join(', ')}
              onChange={(e) => set({ includeExtensions: csv(e.target.value) })}
            />
            <input
              className="w-full bg-slate-800 border border-slate-700 rounded px-2 py-1.5 mt-1.5"
              placeholder="Excluded extensions, e.g. tmp, ds_store"
              value={value.excludeExtensions.join(', ')}
              onChange={(e) => set({ excludeExtensions: csv(e.target.value) })}
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <div className="text-xs uppercase text-slate-500 mb-1">Min size (MB)</div>
              <input
                type="number"
                min={0}
                className="w-full bg-slate-800 border border-slate-700 rounded px-2 py-1.5"
                value={mb(value.minSizeBytes)}
                onChange={(e) => set({ minSizeBytes: e.target.value ? Number(e.target.value) * 1024 * 1024 : undefined })}
              />
            </div>
            <div>
              <div className="text-xs uppercase text-slate-500 mb-1">Max size (MB)</div>
              <input
                type="number"
                min={0}
                className="w-full bg-slate-800 border border-slate-700 rounded px-2 py-1.5"
                value={mb(value.maxSizeBytes)}
                onChange={(e) => set({ maxSizeBytes: e.target.value ? Number(e.target.value) * 1024 * 1024 : undefined })}
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <div className="text-xs uppercase text-slate-500 mb-1">Name contains (any)</div>
              <input
                className="w-full bg-slate-800 border border-slate-700 rounded px-2 py-1.5"
                placeholder="invoice, 2025"
                value={value.nameIncludes.join(', ')}
                onChange={(e) => set({ nameIncludes: csv(e.target.value) })}
              />
            </div>
            <div>
              <div className="text-xs uppercase text-slate-500 mb-1">Name excludes (any)</div>
              <input
                className="w-full bg-slate-800 border border-slate-700 rounded px-2 py-1.5"
                placeholder="draft, temp"
                value={value.nameExcludes.join(', ')}
                onChange={(e) => set({ nameExcludes: csv(e.target.value) })}
              />
            </div>
          </div>

          <div className="flex items-center gap-6">
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={value.skipEmpty} onChange={(e) => set({ skipEmpty: e.target.checked })} />
              Skip empty (0 B) files
            </label>
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={value.recurse} onChange={(e) => set({ recurse: e.target.checked })} />
              Include subfolders
            </label>
          </div>
        </div>
      )}
    </div>
  );
}
