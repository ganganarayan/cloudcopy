import { EventEmitter } from 'node:events';
import type { WsServerEvent } from '@cloudcopy/shared';

/**
 * In-process progress bus. The engine publishes WsServerEvents; the WebSocket hub
 * subscribes and fans them out to connected clients. When we add Redis later, this
 * becomes a thin wrapper over Redis pub/sub with the same interface.
 */
export class ProgressBus {
  private emitter = new EventEmitter();

  constructor() {
    this.emitter.setMaxListeners(0);
  }

  publish(event: WsServerEvent): void {
    this.emitter.emit('event', event);
  }

  subscribe(listener: (event: WsServerEvent) => void): () => void {
    this.emitter.on('event', listener);
    return () => this.emitter.off('event', listener);
  }
}
