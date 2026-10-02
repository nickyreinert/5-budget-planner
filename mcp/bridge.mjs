import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';

const POLL_MS = 20000;
const REQUEST_MS = 30000;

// Local bridge between the MCP server and the 5ive app running in a browser
// tab. The browser long-polls /poll for commands and answers on /result, so
// the server never needs to reach into browser storage itself. Only requests
// from allowed origins are served.
export function start_bridge({ port, allowedOrigins }) {
  const queue = [];
  const pending = new Map();
  let waiting = null;
  let lastSeen = 0;

  const send = (res, status, body, origin) => {
    res.writeHead(status, {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Allow-Private-Network': 'true',
      Vary: 'Origin'
    });
    res.end(body === undefined ? undefined : JSON.stringify(body));
  };

  const release = () => {
    if (!waiting || !queue.length) return;
    clearTimeout(waiting.timer);
    const { res, origin } = waiting;
    waiting = null;
    send(res, 200, queue.shift(), origin);
  };

  const server = createServer(async (req, res) => {
    const origin = req.headers.origin;
    if (!allowedOrigins.includes(origin)) { res.writeHead(403); res.end(); return; }
    if (req.method === 'OPTIONS') { send(res, 204, undefined, origin); return; }
    lastSeen = Date.now();
    if (req.method === 'GET' && req.url === '/ping') {
      send(res, 204, undefined, origin);
    } else if (req.method === 'GET' && req.url === '/poll') {
      // A newer tab replaces the previous poller.
      if (waiting) { clearTimeout(waiting.timer); send(waiting.res, 204, undefined, waiting.origin); }
      waiting = { res, origin, timer: setTimeout(() => { waiting = null; send(res, 204, undefined, origin); }, POLL_MS) };
      res.on('close', () => { if (waiting?.res === res) { clearTimeout(waiting.timer); waiting = null; lastSeen = Date.now(); } });
      release();
    } else if (req.method === 'POST' && req.url === '/result') {
      let text = '';
      for await (const chunk of req) text += chunk;
      let message;
      try { message = JSON.parse(text); } catch { send(res, 400, { error: 'invalid JSON' }, origin); return; }
      const entry = pending.get(message.id);
      if (entry) {
        pending.delete(message.id);
        clearTimeout(entry.timer);
        if (message.ok) entry.resolve(message.value); else entry.reject(new Error(message.error));
      }
      send(res, 204, undefined, origin);
    } else {
      send(res, 404, { error: 'not found' }, origin);
    }
  });

  const listening = new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve(server.address().port));
  });

  const connected = () => !!waiting || Date.now() - lastSeen < 5000;

  const request = (type, payload) => {
    if (!connected()) return Promise.reject(new Error('The 5ive app is not connected. Open the app and enable Settings > AI > Live connection.'));
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(new Error('The 5ive app did not answer in time.')); }, REQUEST_MS);
      pending.set(id, { resolve, reject, timer });
      queue.push({ id, type, payload });
      release();
    });
  };

  return { listening, request, close: () => server.close() };
}
