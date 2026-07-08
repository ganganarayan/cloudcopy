import { z } from 'zod';

export const CONFLICT_POLICIES = ['skip', 'skip_if_same_size', 'overwrite', 'rename'] as const;
export type ConflictPolicy = (typeof CONFLICT_POLICIES)[number];

export const OPERATIONS = ['copy', 'move'] as const;
export type Operation = (typeof OPERATIONS)[number];

/** Per-job selective-transfer conditions (stored in jobs.options). */
export const transferOptionsSchema = z
  .object({
    conflictPolicy: z.enum(CONFLICT_POLICIES).default('skip'),
    includeExtensions: z.array(z.string()).default([]),
    excludeExtensions: z.array(z.string()).default([]),
    minSizeBytes: z.number().int().nonnegative().optional(),
    maxSizeBytes: z.number().int().nonnegative().optional(),
    skipEmpty: z.boolean().default(false),
    nameIncludes: z.array(z.string()).default([]),
    nameExcludes: z.array(z.string()).default([]),
    modifiedAfter: z.string().optional(), // ISO date
    modifiedBefore: z.string().optional(),
    recurse: z.boolean().default(true),
    verify: z.boolean().default(true),
    /** copy = leave source; move = delete source after a verified transfer. */
    operation: z.enum(OPERATIONS).default('copy'),
  })
  .default({});

export type TransferOptions = z.infer<typeof transferOptionsSchema>;

export function parseTransferOptions(raw: unknown): TransferOptions {
  return transferOptionsSchema.parse(raw ?? {});
}
