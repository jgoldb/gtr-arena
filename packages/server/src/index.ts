import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { WebSocketServer, WebSocket } from 'ws';
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

  // Serve static client files
  let filePath = path.join(CLIENT_DIR, req.url === '/' ? 'index.html' : req.url!);
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
    res.writeHead(200, { 'Content-Type': contentType });
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
const db = new GtrDatabase();
const auth = new AuthManager(db);
const lobby = new LobbyManager(auth, db);

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
      ws.send(encodeMessage({ type: 'pong', timestamp: msg.timestamp }));
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

    lobby.handleMessage(userId, msg);
  });

  ws.on('close', () => {
    if (userId) {
      lobby.removeUser(userId);
      auth.disconnect(userId);
    }
  });

  ws.on('error', () => {
    if (userId) {
      lobby.removeUser(userId);
      auth.disconnect(userId);
    }
  });
});

server.listen(PORT, () => {
  console.log(`GTR Arena server listening on port ${PORT}`);
});
