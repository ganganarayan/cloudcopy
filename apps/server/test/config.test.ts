import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';

const baseEnv = {
  DATABASE_URL: 'postgres://localhost/test',
  CREDENTIALS_KEY: randomBytes(32).toString('base64'),
};

describe('loadConfig', () => {
  it('applies engine defaults', () => {
    const cfg = loadConfig({ ...baseEnv } as NodeJS.ProcessEnv);
    expect(cfg.engine).toMatchObject({ maxFiles: 4, chunksPerFile: 8, chunkSize: 8 * 1024 * 1024, clamped: false });
  });

  it('rejects a chunk size that is not a multiple of 256 KiB', () => {
    expect(() =>
      loadConfig({ ...baseEnv, ENGINE_CHUNK_SIZE: String(8 * 1024 * 1024 + 1) } as NodeJS.ProcessEnv),
    ).toThrow();
  });

  it('rejects a CREDENTIALS_KEY that is not 32 bytes', () => {
    expect(() => loadConfig({ ...baseEnv, CREDENTIALS_KEY: 'dG9vc2hvcnQ=' } as NodeJS.ProcessEnv)).toThrow();
  });

  it('clamps chunksPerFile to the memory budget', () => {
    // 4 files × 8 chunks × 8 MiB = 256 MiB > 128 MiB budget → clamp
    const cfg = loadConfig({ ...baseEnv, ENGINE_MEMORY_BUDGET_MB: '128' } as NodeJS.ProcessEnv);
    expect(cfg.engine.clamped).toBe(true);
    expect(cfg.engine.maxFiles * cfg.engine.chunksPerFile * cfg.engine.chunkSize).toBeLessThanOrEqual(128 * 1024 * 1024);
    expect(cfg.engine.chunksPerFile).toBeGreaterThanOrEqual(1);
  });
});
