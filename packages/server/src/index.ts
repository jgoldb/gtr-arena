import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { WebSocketServer, WebSocket } from 'ws';
import { AuthManager } from './auth/AuthManager.js';
import { LobbyManager } from './lobby/LobbyManager.js';
import type { ClientMessage } from '@gtr/shared';

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
const auth = new AuthManager();
const lobby = new LobbyManager();

wss.on('connection', (ws: WebSocket) => {
  let userId: string | null = null;

  ws.on('message', (data) => {
    let msg: ClientMessage;
    try {
      msg = JSON.parse(data.toString()) as ClientMessage;
    } catch {
      return;
    }

    // Authentication must come first
    if (msg.type === 'authenticate') {
      const result = auth.authenticate(msg.username, msg.token, ws);
      if (result.success) {
        userId = result.userId;
        ws.send(JSON.stringify({
          type: 'auth_result',
          success: true,
          userId: result.userId,
        }));
        lobby.addUser(result.userId, msg.username, ws);
      } else {
        ws.send(JSON.stringify({
          type: 'auth_result',
          success: false,
          userId: '',
          error: result.error,
        }));
      }
      return;
    }

    // All other messages require authentication
    if (!userId) {
      ws.send(JSON.stringify({ type: 'error', message: 'Not authenticated' }));
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
