import type { TransferOptions } from './options.js';
import type { ScannedFile } from './scan.js';

export function basename(path: string): string {
  return path.split('/').pop() ?? path;
}

function extOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
}

const normExt = (e: string) => e.trim().toLowerCase().replace(/^\./, '');

/**
 * Decide whether a scanned file passes the selective-transfer filters
 * (type / size / name / date). Returns null if it passes, or a short reason
 * string describing why it was excluded.
 */
export function filterReason(f: ScannedFile, opts: TransferOptions): string | null {
  const name = basename(f.sourcePath);
  const lname = name.toLowerCase();
  const ext = extOf(name);

  if (opts.skipEmpty && f.sizeBytes === 0) return 'empty file';
  if (opts.minSizeBytes != null && f.sizeBytes < opts.minSizeBytes) return 'below min size';
  if (opts.maxSizeBytes != null && f.sizeBytes > opts.maxSizeBytes) return 'above max size';

  const include = opts.includeExtensions.map(normExt).filter(Boolean);
  if (include.length && !include.includes(ext)) return 'type not included';
  const exclude = opts.excludeExtensions.map(normExt).filter(Boolean);
  if (exclude.length && exclude.includes(ext)) return 'type excluded';

  const includes = opts.nameIncludes.map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (includes.length && !includes.some((s) => lname.includes(s))) return 'name not matched';
  const excludes = opts.nameExcludes.map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (excludes.some((s) => lname.includes(s))) return 'name excluded';

  if (opts.modifiedAfter && f.modified != null && f.modified < Date.parse(opts.modifiedAfter)) return 'older than filter';
  if (opts.modifiedBefore && f.modified != null && f.modified > Date.parse(opts.modifiedBefore)) return 'newer than filter';

  return null;
}

/** Compute a non-colliding name by appending " (n)" before the extension. */
export function uniqueName(name: string, taken: Set<string>): string {
  if (!taken.has(name.toLowerCase())) return name;
  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  for (let i = 1; i < 10_000; i++) {
    const candidate = `${stem} (${i})${ext}`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
  return `${stem} (${Date.now()})${ext}`;
}
