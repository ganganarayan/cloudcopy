import { NOTIFICATION_EVENT_TYPES, type EventType } from '@cloudcopy/shared';
import type { Db } from '../db/client.js';
import { events } from '../db/schema.js';

export interface StoredEvent {
  id: number;
  userId: string | null;
  type: string;
  payload: Record<string, unknown>;
  createdAt: Date;
}

type EventListener = (event: StoredEvent) => void;

/**
 * Append-only event store (event sourcing). Every state change of interest is
 * recorded here; notifications and daily summaries are derived from it.
 * In-process listeners let the realtime layer fan events out without polling.
 */
export class EventService {
  private listeners: EventListener[] = [];

  constructor(private readonly db: Db) {}

  async append(
    type: EventType,
    payload: Record<string, unknown>,
    userId?: string,
  ): Promise<StoredEvent> {
    const [row] = await this.db
      .insert(events)
      .values({ type, payload, userId: userId ?? null })
      .returning();
    if (!row) throw new Error('event insert returned no row');
    const stored: StoredEvent = {
      id: row.id,
      userId: row.userId,
      type: row.type,
      payload: (row.payload ?? {}) as Record<string, unknown>,
      createdAt: row.createdAt,
    };
    for (const listener of this.listeners) listener(stored);
    return stored;
  }

  /** True when this event type surfaces in the notification bell. */
  static isNotification(type: EventType): boolean {
    return NOTIFICATION_EVENT_TYPES.includes(type);
  }

  onEvent(listener: EventListener): () => void {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== listener);
    };
  }
}
