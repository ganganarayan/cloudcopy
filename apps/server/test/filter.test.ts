import { describe, expect, it } from 'vitest';
import { parseTransferOptions } from '../src/engine/options.js';
import { basename, filterReason, uniqueName } from '../src/engine/filter.js';
import type { ScannedFile } from '../src/engine/scan.js';

const file = (path: string, size = 100, modified?: number): ScannedFile => ({
  sourceNodeId: 'n',
  sourcePath: path,
  sizeBytes: size,
  modified,
});

describe('filterReason', () => {
  it('passes everything with default options', () => {
    expect(filterReason(file('a/b/photo.jpg'), parseTransferOptions({}))).toBeNull();
  });

  it('filters by included extension', () => {
    const opts = parseTransferOptions({ includeExtensions: ['jpg', '.png'] });
    expect(filterReason(file('photo.jpg'), opts)).toBeNull();
    expect(filterReason(file('doc.pdf'), opts)).toBe('type not included');
  });

  it('filters by excluded extension', () => {
    const opts = parseTransferOptions({ excludeExtensions: ['tmp'] });
    expect(filterReason(file('x.tmp'), opts)).toBe('type excluded');
    expect(filterReason(file('x.jpg'), opts)).toBeNull();
  });

  it('filters by size bounds and empty', () => {
    expect(filterReason(file('a', 0), parseTransferOptions({ skipEmpty: true }))).toBe('empty file');
    expect(filterReason(file('a', 50), parseTransferOptions({ minSizeBytes: 100 }))).toBe('below min size');
    expect(filterReason(file('a', 500), parseTransferOptions({ maxSizeBytes: 100 }))).toBe('above max size');
  });

  it('filters by name include/exclude (case-insensitive)', () => {
    expect(filterReason(file('Invoice_2025.pdf'), parseTransferOptions({ nameIncludes: ['invoice'] }))).toBeNull();
    expect(filterReason(file('photo.jpg'), parseTransferOptions({ nameIncludes: ['invoice'] }))).toBe('name not matched');
    expect(filterReason(file('draft-copy.txt'), parseTransferOptions({ nameExcludes: ['draft'] }))).toBe('name excluded');
  });

  it('filters by modified date window', () => {
    const t = Date.parse('2025-06-01');
    expect(filterReason(file('a', 1, t), parseTransferOptions({ modifiedAfter: '2025-01-01' }))).toBeNull();
    expect(filterReason(file('a', 1, t), parseTransferOptions({ modifiedAfter: '2026-01-01' }))).toBe('older than filter');
    expect(filterReason(file('a', 1, t), parseTransferOptions({ modifiedBefore: '2025-01-01' }))).toBe('newer than filter');
  });
});

describe('uniqueName', () => {
  it('returns the name unchanged when free', () => {
    expect(uniqueName('report.pdf', new Set())).toBe('report.pdf');
  });
  it('appends an incrementing suffix before the extension', () => {
    expect(uniqueName('report.pdf', new Set(['report.pdf']))).toBe('report (1).pdf');
    expect(uniqueName('report.pdf', new Set(['report.pdf', 'report (1).pdf']))).toBe('report (2).pdf');
  });
  it('handles names without an extension', () => {
    expect(uniqueName('folder', new Set(['folder']))).toBe('folder (1)');
  });
});

describe('basename', () => {
  it('takes the last path segment', () => {
    expect(basename('a/b/c.txt')).toBe('c.txt');
    expect(basename('c.txt')).toBe('c.txt');
  });
});
