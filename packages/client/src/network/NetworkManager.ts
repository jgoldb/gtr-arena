import type { ClientMessage, ServerMessage } from '@gtr/shared';

export type ServerMessageHandler = (msg: ServerMessage) => void;
export type ConnectionState =
  | { status: 'disconnected' }
  | { status: 'reconnecting'; attempt: number; maxAttempts: number }
  | { status: 'reconnected' }
  | { status: 'failed' };
export type ConnectionStateHandler = (state: ConnectionState) => void;

export class NetworkManager {
  private ws: WebSocket | null = null;
  private handlers: ServerMessageHandler[] = [];
  private connectionStateHandler: ConnectionStateHandler | null = null;
  private reconnectTimer: number | null = null;
  private pingTimer: number | null = null;
  private staleCheckTimer: number | null = null;
  private lastMessageTime = 0;
  private reconnectAttempts = 0;
  private username: string;
  private password: string;
  private mode: 'login' | 'register';

  /** Latest round-trip time in milliseconds. */
  rtt = 0;

  private static readonly PING_INTERVAL = 3_000;
  private static readonly STALE_TIMEOUT = 20_000;
  private static readonly STALE_CHECK_INTERVAL = 5_000;
  private static readonly RECONNECT_BASE_DELAY = 1_000;
  private static readonly RECONNECT_MAX_DELAY = 30_000;
  private static readonly RECONNECT_MAX_ATTEMPTS = 10;
  private static readonly MAX_QUEUE_SIZE = 50;
  /** Message types that are ephemeral and should be dropped rather than queued. */
  private static readonly EPHEMERAL_TYPES: ReadonlySet<string> = new Set([
    'player_state',
    'ping',
  ]);
  private messageQueue: ClientMessage[] = [];

  constructor(username: string, password: string, mode: 'login' | 'register') {
    this.username = username;
    this.password = password;
    this.mode = mode;
  }

  onMessage(handler: ServerMessageHandler): void {
    this.handlers.push(handler);
  }

  onConnectionStateChange(handler: ConnectionStateHandler): void {
    this.connectionStateHandler = handler;
  }

  connect(): void {
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const url = `${protocol}//${location.host}/ws`;
    this.ws = new WebSocket(url);

    this.ws.onopen = () => {
      const wasReconnect = this.reconnectAttempts > 0;
      this.reconnectAttempts = 0;
      this.lastMessageTime = Date.now();
      this.startHeartbeat();
      if (wasReconnect) {
        this.connectionStateHandler?.({ status: 'reconnected' });
      }
      // Always use 'login' on reconnect — account already exists
      const authMode = wasReconnect ? 'login' : this.mode;
      this.send({ type: 'authenticate', username: this.username, password: this.password, mode: authMode });
      this.flushQueue();
    };

    this.ws.onmessage = (event) => {
      this.lastMessageTime = Date.now();
      const msg = JSON.parse(event.data) as ServerMessage;
      if (msg.type === 'pong') {
        if (msg.timestamp) this.rtt = Date.now() - msg.timestamp;
        return;
      }
      for (const handler of this.handlers) {
        handler(msg);
      }
    };

    this.ws.onclose = () => {
      this.ws = null;
      this.stopHeartbeat();
      if (this.reconnectAttempts === 0) {
        this.connectionStateHandler?.({ status: 'disconnected' });
      }
      this.scheduleReconnect();
    };

    this.ws.onerror = () => {
      this.ws?.close();
    };
  }

  send(msg: ClientMessage): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    } else if (
      !NetworkManager.EPHEMERAL_TYPES.has(msg.type) &&
      this.messageQueue.length < NetworkManager.MAX_QUEUE_SIZE
    ) {
      this.messageQueue.push(msg);
    }
  }

  disconnect(): void {
    this.messageQueue.length = 0;
    this.stopHeartbeat();
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.onclose = null;
      this.ws.close();
      this.ws = null;
    }
  }

  get connected(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }

  private flushQueue(): void {
    const queued = this.messageQueue.splice(0);
    for (const msg of queued) {
      this.send(msg);
    }
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.pingTimer = window.setInterval(() => {
      this.send({ type: 'ping', timestamp: Date.now() });
    }, NetworkManager.PING_INTERVAL);
    this.staleCheckTimer = window.setInterval(() => {
      if (Date.now() - this.lastMessageTime > NetworkManager.STALE_TIMEOUT) {
        this.ws?.close(); // triggers onclose → reconnect
      }
    }, NetworkManager.STALE_CHECK_INTERVAL);
  }

  private stopHeartbeat(): void {
    if (this.pingTimer !== null) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
    if (this.staleCheckTimer !== null) {
      clearInterval(this.staleCheckTimer);
      this.staleCheckTimer = null;
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer !== null) return;
    if (this.reconnectAttempts >= NetworkManager.RECONNECT_MAX_ATTEMPTS) {
      this.connectionStateHandler?.({ status: 'failed' });
      return;
    }
    const delay = Math.min(
      NetworkManager.RECONNECT_BASE_DELAY * 2 ** this.reconnectAttempts,
      NetworkManager.RECONNECT_MAX_DELAY,
    );
    this.reconnectAttempts++;
    this.connectionStateHandler?.({
      status: 'reconnecting',
      attempt: this.reconnectAttempts,
      maxAttempts: NetworkManager.RECONNECT_MAX_ATTEMPTS,
    });
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }
}
