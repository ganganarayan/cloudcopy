import type { ChunkState, FileState, JobState } from './enums.js';

/** Server → client WebSocket events. Progress events are throttled server-side. */
export type WsServerEvent =
  | { t: 'job.state'; jobId: string; state: JobState; error?: string }
  | {
      t: 'job.progress';
      jobId: string;
      transferredBytes: number;
      totalBytes: number;
      bps: number;
      etaSec: number | null;
      completedFiles: number;
      failedFiles: number;
    }
  | { t: 'file.state'; jobId: string; fileId: string; state: FileState; attempt: number; error?: string }
  | {
      t: 'file.progress';
      jobId: string;
      fileId: string;
      committedOffset: number;
      sizeBytes: number;
      bps: number;
      etaSec: number | null;
      currentChunk: number;
    }
  | { t: 'chunk.state'; jobId: string; fileId: string; chunkIndex: number; state: ChunkState }
  | { t: 'notification'; eventId: string; type: string; payload: Record<string, unknown>; createdAt: string }
  | { t: 'stats.tick'; bpsTotal: number; runningJobs: number; activeFiles: number };

/** Client → server WebSocket messages. */
export type WsClientMessage =
  | { type: 'subscribe'; jobId: string }
  | { type: 'unsubscribe'; jobId: string };
