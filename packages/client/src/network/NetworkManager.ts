import type { ClientMessage, ServerMessage } from '@gtr/shared';
import { encodeMessage, decodeMessage } from '@gtr/shared';
import { ClockSync } from './ClockSync';

export type ServerMessageHandler = (msg: ServerMessage) => void;
export type ConnectionState =
  | { status: 'disconnected' }
  | { status: 'reconnecting'; attempt: number; maxAttempts: number }
  | { status: 'reconnected' }
  | { status: 'failed' };
export type ConnectionStateHandler = (state: ConnectionState) => void;

/** Message types routed through the unreliable DataChannel when available. */
const UNRELIABLE_SEND_TYPES: ReadonlySet<string> = new Set([
  'player_state',
]);

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

  /** NTP-style clock synchronization with the server. */
  readonly clockSync = new ClockSync();

  // ── WebRTC DataChannel (unreliable) ──────────────────────────────────
  private pc: RTCPeerConnection | null = null;
  private dc: RTCDataChannel | null = null;
  /** True when the unreliable DataChannel is open and usable. */
  private dcOpen = false;

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
    this.ws.binaryType = 'arraybuffer';

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
      const msg = event.data instanceof ArrayBuffer
        ? decodeMessage<ServerMessage>(event.data)
        : JSON.parse(event.data) as ServerMessage;
      if (msg.type === 'pong') {
        if (msg.timestamp) {
          this.clockSync.processPong(msg.timestamp, msg.serverTime);
          this.rtt = this.clockSync.rtt;
        }
        return;
      }
      // WebRTC signaling — handle before dispatching to game handlers
      if (msg.type === 'rtc_offer') {
        this.handleRtcOffer(msg.sdp);
        return;
      }
      if (msg.type === 'rtc_candidate') {
        this.handleRtcCandidate(msg.candidate, msg.mid);
        return;
      }
      for (const handler of this.handlers) {
        handler(msg);
      }
    };

    this.ws.onclose = () => {
      this.ws = null;
      this.teardownWebRTC();
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
    // Route unreliable messages through DataChannel when available
    if (UNRELIABLE_SEND_TYPES.has(msg.type) && this.dcOpen && this.dc) {
      try {
        const data = encodeMessage(msg);
        this.dc.send(data);
        return;
      } catch {
        // DC failed — fall through to WebSocket
      }
    }

    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(encodeMessage(msg));
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
    this.teardownWebRTC();
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

  /** Whether the unreliable DataChannel is currently active. */
  get unreliableConnected(): boolean {
    return this.dcOpen;
  }

  // ── WebRTC signaling ──────────────────────────────────────────────────

  private async handleRtcOffer(sdp: string): Promise<void> {
    try {
      // Clean up any previous connection (reconnect scenario)
      this.teardownWebRTC();

      this.pc = new RTCPeerConnection({
        iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
      });

      // Server creates the DataChannel — we receive it here
      this.pc.ondatachannel = (event) => {
        this.dc = event.channel;
        this.dc.binaryType = 'arraybuffer';

        this.dc.onopen = () => {
          this.dcOpen = true;
        };

        this.dc.onclose = () => {
          this.dcOpen = false;
        };

        this.dc.onerror = () => {
          this.dcOpen = false;
        };

        this.dc.onmessage = (evt) => {
          // Incoming unreliable message from server (position_update, position_relay)
          try {
            const msg = decodeMessage<ServerMessage>(evt.data as ArrayBuffer);
            for (const handler of this.handlers) {
              handler(msg);
            }
          } catch { /* ignore malformed */ }
        };
      };

      // Trickle ICE candidates to server via WebSocket
      this.pc.onicecandidate = (event) => {
        if (event.candidate && this.ws?.readyState === WebSocket.OPEN) {
          this.ws.send(encodeMessage({
            type: 'rtc_candidate',
            candidate: event.candidate.candidate,
            mid: event.candidate.sdpMid ?? '',
          }));
        }
      };

      // Set the server's offer and send our answer
      await this.pc.setRemoteDescription(new RTCSessionDescription({ type: 'offer', sdp }));
      const answer = await this.pc.createAnswer();
      await this.pc.setLocalDescription(answer);

      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.send(encodeMessage({
          type: 'rtc_answer',
          sdp: answer.sdp!,
        }));
      }
    } catch {
      // WebRTC failed — no problem, everything still works over WebSocket
      this.teardownWebRTC();
    }
  }

  private async handleRtcCandidate(candidate: string, mid: string): Promise<void> {
    try {
      await this.pc?.addIceCandidate(new RTCIceCandidate({
        candidate,
        sdpMid: mid,
      }));
    } catch {
      // Non-fatal — ICE negotiation may still succeed with other candidates
    }
  }

  private teardownWebRTC(): void {
    this.dcOpen = false;
    if (this.dc) {
      try { this.dc.close(); } catch { /* ignore */ }
      this.dc = null;
    }
    if (this.pc) {
      try { this.pc.close(); } catch { /* ignore */ }
      this.pc = null;
    }
  }

  // ── Internals ─────────────────────────────────────────────────────────

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
