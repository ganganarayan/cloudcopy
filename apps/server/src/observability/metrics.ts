import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from 'prom-client';

/**
 * Prometheus metrics registry. Engine/provider metrics are registered here up
 * front so dashboards keep stable series names as phases land.
 */
export function createMetrics() {
  const registry = new Registry();
  collectDefaultMetrics({ register: registry });

  return {
    registry,
    transferBytesTotal: new Counter({
      name: 'cloudcopy_transfer_bytes_total',
      help: 'Bytes durably committed at destinations',
      labelNames: ['provider'] as const,
      registers: [registry],
    }),
    chunkLatency: new Histogram({
      name: 'cloudcopy_chunk_latency_seconds',
      help: 'Per-chunk end-to-end latency (fetch + commit)',
      labelNames: ['provider', 'op'] as const,
      buckets: [0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60],
      registers: [registry],
    }),
    retriesTotal: new Counter({
      name: 'cloudcopy_retries_total',
      help: 'Retries by provider and error code',
      labelNames: ['provider', 'code'] as const,
      registers: [registry],
    }),
    providerErrorsTotal: new Counter({
      name: 'cloudcopy_provider_errors_total',
      help: 'Provider errors by code',
      labelNames: ['provider', 'code'] as const,
      registers: [registry],
    }),
    queueDepth: new Gauge({
      name: 'cloudcopy_queue_depth',
      help: 'Pending file tasks in the queue',
      registers: [registry],
    }),
    activeFiles: new Gauge({
      name: 'cloudcopy_active_files',
      help: 'Files currently being transferred',
      registers: [registry],
    }),
    workerHeartbeat: new Gauge({
      name: 'cloudcopy_worker_heartbeat_timestamp_seconds',
      help: 'Last heartbeat per worker',
      labelNames: ['worker'] as const,
      registers: [registry],
    }),
  };
}

export type Metrics = ReturnType<typeof createMetrics>;
