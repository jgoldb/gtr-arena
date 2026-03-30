import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { WebSocketServer, WebSocket } from 'ws';
import ndc from 'node-datachannel';
import type { DataChannel as NDCDataChannel, PeerConnection as NDCPeerConnection } from 'node-datachannel';
import { AuthManager } from './auth/AuthManager.js';
import { LobbyManager } from './lobby/LobbyManager.js';
import { GtrDatabase } from './db/Database.js';
import type { ClientMessage } from '@gtr/shared';
import { encodeMessage, decodeMessage } from '@gtr/shared';

const PORT = parseInt(process.env.PORT || '3001', 10);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLIENT_DIR = path.resolve(__dirname, '../../client/dist');
const SERVE_STATIC = fs.existsSync(CLIENT_DIR);

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html',
  '.js':   'application/javascript',
  '.css':  'text/css',
  '.json': 'application/json',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.svg':  'image/svg+xml',
  '.woff': 'font/woff',
  '.woff2':'font/woff2',
  '.glb':  'model/gltf-binary',
  '.gltf': 'model/gltf+json',
  '.wasm': 'application/wasm',
};

const server = http.createServer((req, res) => {
  if (!SERVE_STATIC) {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('GTR Arena Server');
    return;
  }

  // Strip query string before resolving file path (cache-busting params like ?_=123)
  const pathname = new URL(req.url!, `http://${req.headers.host}`).pathname;
  let filePath = path.join(CLIENT_DIR, pathname === '/' ? 'index.html' : pathname);
  if (!fs.existsSync(filePath)) {
    // SPA fallback — serve index.html for client-side routes
    filePath = path.join(CLIENT_DIR, 'index.html');
  }

  const ext = path.extname(filePath);
  const contentType = MIME_TYPES[ext] || 'application/octet-stream';

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }
    const headers: Record<string, string> = { 'Content-Type': contentType };
    const basename = path.basename(filePath);
    // Prevent caching of index.html and version.json so deploys are detected immediately
    if (basename === 'index.html' || basename === 'version.json') {
      headers['Cache-Control'] = 'no-cache, no-store, must-revalidate';
    }
    res.writeHead(200, headers);
    res.end(data);
  });
});

const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  if (req.url === '/ws') {
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req);
    });
  } else {
    socket.destroy();
  }
});
// ── WebRTC DataChannels for unreliable game traffic ──────────────────────
// Position updates and relays bypass TCP head-of-line blocking via unordered,
// unreliable SCTP DataChannels. Falls back to WebSocket if WebRTC fails.

/** Active DataChannels keyed by userId — used by GameSession for unreliable sends. */
const dataChannels = new Map<string, NDCDataChannel>();

const peerConnections = new Map<string, NDCPeerConnection>();

const db = new GtrDatabase();
const auth = new AuthManager(db);
const lobby = new LobbyManager(auth, db);
lobby.setDataChannelMap(dataChannels);

function setupWebRTC(userId: string, ws: WebSocket): void {
  // Clean up any existing connection for this user (e.g. reconnect)
  teardownWebRTC(userId);

  const pc = new ndc.PeerConnection(userId, {
    iceServers: ['stun:stun.l.google.com:19302'],
  });

  peerConnections.set(userId, pc);

  // Create unreliable, unordered DataChannel — the whole point of this work.
  // Lost packets are simply skipped (dead reckoning covers the gap).
  const dc = pc.createDataChannel('game-unreliable', {
    unordered: true,
    maxRetransmits: 0,
  });

  dc.onOpen(() => {
    dataChannels.set(userId, dc);
  });

  dc.onClosed(() => {
    dataChannels.delete(userId);
  });

  dc.onError((err) => {
    console.warn(`[WebRTC] DataChannel error for ${userId}:`, err);
    dataChannels.delete(userId);
  });

  dc.onMessage((msg) => {
    // Incoming unreliable message from client (player_state)
    try {
      const buf = typeof msg === 'string' ? Buffer.from(msg) : Buffer.from(msg);
      const decoded = decodeMessage<ClientMessage>(buf);
      if (decoded.type === 'player_state') {
        lobby.handleMessage(userId, decoded);
      }
    } catch { /* ignore malformed */ }
  });

  // Signaling: server generates offer, sends to client via WebSocket
  pc.onLocalDescription((sdp, type) => {
    if (type === 'offer' && ws.readyState === ws.OPEN) {
      ws.send(encodeMessage({ type: 'rtc_offer', sdp }));
    }
  });

  pc.onLocalCandidate((candidate, mid) => {
    if (ws.readyState === ws.OPEN) {
      ws.send(encodeMessage({ type: 'rtc_candidate', candidate, mid }));
    }
  });

  // Trigger the offer generation
  pc.setLocalDescription();
}

function teardownWebRTC(userId: string): void {
  const dc = dataChannels.get(userId);
  if (dc) {
    try { dc.close(); } catch { /* ignore */ }
    dataChannels.delete(userId);
  }
  const pc = peerConnections.get(userId);
  if (pc) {
    try { pc.close(); } catch { /* ignore */ }
    peerConnections.delete(userId);
  }
}

// ── Server-side heartbeat: detect dead clients via protocol-level ping/pong ──
const aliveSockets = new Set<WebSocket>();
const heartbeatInterval = setInterval(() => {
  for (const ws of wss.clients) {
    if (!aliveSockets.has(ws)) {
      ws.terminate();
      continue;
    }
    aliveSockets.delete(ws);
    ws.ping();
  }
}, 30_000);
wss.on('close', () => clearInterval(heartbeatInterval));

wss.on('connection', (ws: WebSocket) => {
  // Disable Nagle's algorithm — send small WebSocket frames immediately
  // instead of buffering up to 40ms. Critical for low-latency game state updates.
  const rawSocket = (ws as any)._socket;
  if (rawSocket?.setNoDelay) rawSocket.setNoDelay(true);

  aliveSockets.add(ws);
  ws.on('pong', () => aliveSockets.add(ws));

  let userId: string | null = null;

  ws.on('message', (data) => {
    let msg: ClientMessage;
    try {
      // Support both binary (MessagePack) and text (JSON) for backwards compatibility
      if (typeof data === 'string') {
        msg = JSON.parse(data) as ClientMessage;
      } else {
        const buf = data instanceof ArrayBuffer ? data : (data as Buffer);
        msg = decodeMessage<ClientMessage>(buf);
      }
    } catch {
      return;
    }

    // Heartbeat — respond immediately regardless of auth state
    if (msg.type === 'ping') {
      ws.send(encodeMessage({ type: 'pong', timestamp: msg.timestamp, serverTime: Date.now() }));
      return;
    }

    // Authentication must come first
    if (msg.type === 'authenticate') {
      const result = auth.authenticate(msg.username, msg.password, msg.mode, ws);
      if (result.success) {
        userId = result.userId;
        const displayUsername = result.username!;
        const dbId = auth.getDbId(result.userId)!;
        ws.send(encodeMessage({
          type: 'auth_result',
          success: true,
          userId: result.userId,
          username: displayUsername,
          isAdmin: result.isAdmin || false,
          xp: db.getUserXp(dbId),
        }));
        lobby.addUser(result.userId, displayUsername, ws);
        // Initiate WebRTC DataChannel for unreliable game traffic
        setupWebRTC(result.userId, ws);
      } else {
        ws.send(encodeMessage({
          type: 'auth_result',
          success: false,
          userId: '',
          bannedUntil: result.bannedUntil,
          banReason: result.banReason,
          error: result.error,
        }));
      }
      return;
    }

    // All other messages require authentication
    if (!userId) {
      ws.send(encodeMessage({ type: 'error', message: 'Not authenticated' }));
      return;
    }

    // WebRTC signaling — handle before lobby routing
    if (msg.type === 'rtc_answer') {
      const pc = peerConnections.get(userId);
      if (pc) pc.setRemoteDescription(msg.sdp, 'answer');
      return;
    }
    if (msg.type === 'rtc_candidate') {
      const pc = peerConnections.get(userId);
      if (pc) pc.addRemoteCandidate(msg.candidate, msg.mid);
      return;
    }

    lobby.handleMessage(userId, msg);
  });

  ws.on('close', () => {
    if (userId) {
      teardownWebRTC(userId);
      lobby.removeUser(userId);
      auth.disconnect(userId);
    }
  });

  ws.on('error', () => {
    if (userId) {
      teardownWebRTC(userId);
      lobby.removeUser(userId);
      auth.disconnect(userId);
    }
  });
});

server.listen(PORT, () => {
  console.log(`GTR Arena server listening on port ${PORT}`);
});
