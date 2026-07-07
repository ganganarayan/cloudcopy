import { z } from 'zod';

/** Health check response. */
export const healthzResponseSchema = z.object({
  status: z.literal('ok'),
  version: z.string(),
  uptimeSec: z.number(),
});
export type HealthzResponse = z.infer<typeof healthzResponseSchema>;

/** Standard error envelope returned by the API error handler. */
export const apiErrorSchema = z.object({
  statusCode: z.number(),
  error: z.string(),
  message: z.string(),
});
export type ApiError = z.infer<typeof apiErrorSchema>;

// DTOs grow phase by phase (accounts, browse, jobs, planner...). Only what the
// API actually serves belongs here — this package is consumed verbatim by the web app.
