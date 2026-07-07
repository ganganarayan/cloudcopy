import { z } from 'zod';

/** Drive resumable uploads require chunk sizes in multiples of 256 KiB. */
export const CHUNK_SIZE_MULTIPLE = 262_144;

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  HOST: z.string().default('0.0.0.0'),
  PORT: z.coerce.number().int().positive().default(8080),
  PUBLIC_URL: z.string().url().optional(),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent']).default('info'),

  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().optional(), // required from Phase 4B

  /** 32-byte base64 key for AES-256-GCM sealing of provider credentials. */
  CREDENTIALS_KEY: z.string().refine(
    (v) => {
      try {
        return Buffer.from(v, 'base64').length === 32;
      } catch {
        return false;
      }
    },
    { message: 'CREDENTIALS_KEY must be 32 bytes, base64-encoded (openssl rand -base64 32)' },
  ),
  SESSION_SECRET: z.string().min(32).optional(), // required from Phase 2

  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),

  ENGINE_MAX_FILES: z.coerce.number().int().min(1).max(64).default(4),
  ENGINE_CHUNKS_PER_FILE: z.coerce.number().int().min(1).max(64).default(8),
  ENGINE_CHUNK_SIZE: z.coerce
    .number()
    .int()
    .min(CHUNK_SIZE_MULTIPLE)
    .default(8 * 1024 * 1024)
    .refine((v) => v % CHUNK_SIZE_MULTIPLE === 0, {
      message: `ENGINE_CHUNK_SIZE must be a multiple of ${CHUNK_SIZE_MULTIPLE}`,
    }),
  ENGINE_MEMORY_BUDGET_MB: z.coerce.number().int().min(64).default(384),
});

export interface AppConfig extends z.infer<typeof envSchema> {
  /** chunksPerFile after clamping to the memory budget. */
  engine: {
    maxFiles: number;
    chunksPerFile: number;
    chunkSize: number;
    memoryBudgetMb: number;
    /** True when ENGINE_CHUNKS_PER_FILE was reduced to fit the budget. */
    clamped: boolean;
  };
}

/**
 * Parse and validate environment. Enforces the engine memory budget:
 * maxFiles × chunksPerFile × chunkSize must fit ENGINE_MEMORY_BUDGET_MB,
 * clamping chunksPerFile down if it does not.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = envSchema.parse(env);

  const budgetBytes = parsed.ENGINE_MEMORY_BUDGET_MB * 1024 * 1024;
  let chunksPerFile = parsed.ENGINE_CHUNKS_PER_FILE;
  let clamped = false;
  while (
    chunksPerFile > 1 &&
    parsed.ENGINE_MAX_FILES * chunksPerFile * parsed.ENGINE_CHUNK_SIZE > budgetBytes
  ) {
    chunksPerFile -= 1;
    clamped = true;
  }

  return {
    ...parsed,
    engine: {
      maxFiles: parsed.ENGINE_MAX_FILES,
      chunksPerFile,
      chunkSize: parsed.ENGINE_CHUNK_SIZE,
      memoryBudgetMb: parsed.ENGINE_MEMORY_BUDGET_MB,
      clamped,
    },
  };
}
