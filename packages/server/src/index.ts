import http from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { AuthManager } from './auth/AuthManager.js';
import { LobbyManager } from './lobby/LobbyManager.js';
import type { ClientMessage } from '@gtr/shared';

const PORT = parseInt(process.env.PORT || '3001', 10);

const server = http.createServer((_req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('GTR Arena Server');
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
