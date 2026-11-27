/**
 * Loopback bridge so the browser PWA can print to a LAN label printer.
 * Listens on 127.0.0.1 only. The laptop must be on the same network as the printer.
 *
 *   npm run print-bridge
 */
import http from 'node:http';
import net from 'node:net';

const HOST = '127.0.0.1';
const PORT = 47321;
const MAX_BODY = 8 * 1024 * 1024;

const ALLOWED_ORIGINS = new Set([
  'https://service.yesweigh.in',
  'http://localhost:5173',
  'http://localhost:5174',
  'http://127.0.0.1:5173',
  'http://127.0.0.1:5174',
]);

function isPrivateIpv4(host) {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!match) return false;
  const octets = match.slice(1).map(Number);
  if (octets.some(n => n > 255)) return false;
  const [a, b] = octets;
  if (a === 10) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  return false;
}

function applyCors(req, res) {
  const origin = req.headers.origin;
  if (typeof origin === 'string' && ALLOWED_ORIGINS.has(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Private-Network', 'true');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Max-Age', '600');
}

function sendJson(req, res, status, body) {
  applyCors(req, res);
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
  });
  res.end(payload);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', chunk => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(Object.assign(new Error('Payload too large.'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function originAllowed(req) {
  const origin = req.headers.origin;
  if (origin == null || origin === '') return true;
  return ALLOWED_ORIGINS.has(origin);
}

function parseTarget(raw) {
  const host = typeof raw.host === 'string' ? raw.host.trim() : '';
  const port = Number(raw.port ?? 9100);
  if (!host) {
    return { error: 'Printer host (IP) is required.', status: 400 };
  }
  if (!isPrivateIpv4(host)) {
    return { error: 'Printer host must be a private LAN IPv4 address.', status: 400 };
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return { error: 'Printer port must be between 1 and 65535.', status: 400 };
  }
  return { host, port };
}

function connectPrinter(host, port, timeoutMs) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host, port });
    let settled = false;
    const fail = err => {
      if (settled) return;
      settled = true;
      socket.destroy();
      const message = err?.message || 'connect failed';
      reject(new Error(`Could not reach printer at ${host}:${port} — ${message}`));
    };
    socket.setTimeout(timeoutMs);
    socket.once('error', fail);
    socket.once('timeout', () => fail(new Error('timed out')));
    socket.once('connect', () => {
      if (settled) return;
      settled = true;
      socket.setTimeout(0);
      socket.removeAllListeners('error');
      socket.removeAllListeners('timeout');
      resolve(socket);
    });
  });
}

function writeAll(socket, buf) {
  return new Promise((resolve, reject) => {
    const onError = err => {
      socket.off('error', onError);
      reject(err);
    };
    socket.on('error', onError);
    socket.write(buf, err => {
      socket.off('error', onError);
      if (err) reject(err);
      else resolve();
    });
  });
}

function closeQuietly(socket) {
  if (!socket) return;
  socket.destroy();
}

async function handleProbe(target, timeoutMs) {
  const socket = await connectPrinter(target.host, target.port, timeoutMs);
  closeQuietly(socket);
  return { ok: true, host: target.host, port: target.port };
}

async function handlePrint(target, dataBase64, timeoutMs) {
  let payload;
  try {
    payload = Buffer.from(String(dataBase64 ?? ''), 'base64');
  } catch {
    throw Object.assign(new Error('Print data is not valid base64.'), { status: 400 });
  }
  if (!payload.length) {
    throw Object.assign(new Error('Decoded print payload is empty.'), { status: 400 });
  }
  const socket = await connectPrinter(target.host, target.port, timeoutMs);
  try {
    socket.setTimeout(timeoutMs);
    await writeAll(socket, payload);
  } finally {
    closeQuietly(socket);
  }
  return { ok: true, bytesSent: payload.length };
}

const server = http.createServer(async (req, res) => {
  if (!originAllowed(req)) {
    sendJson(req, res, 403, { error: 'Origin is not allowed to use the print bridge.' });
    return;
  }
  if (req.method === 'OPTIONS') {
    applyCors(req, res);
    res.writeHead(204);
    res.end();
    return;
  }

  const url = new URL(req.url || '/', `http://${HOST}:${PORT}`);

  try {
    if (req.method === 'GET' && url.pathname === '/health') {
      sendJson(req, res, 200, { ok: true });
      return;
    }

    if (req.method !== 'POST' || (url.pathname !== '/probe' && url.pathname !== '/print')) {
      sendJson(req, res, 404, { error: 'Not found.' });
      return;
    }

    const rawText = (await readBody(req)).toString('utf8');
    let raw = {};
    if (rawText) {
      try {
        raw = JSON.parse(rawText);
      } catch {
        sendJson(req, res, 400, { error: 'Body must be JSON.' });
        return;
      }
    }

    const target = parseTarget(raw);
    if (target.error) {
      sendJson(req, res, target.status, { error: target.error });
      return;
    }

    const requestedTimeout = Number(raw.timeoutMs);
    const timeoutMs = url.pathname === '/print'
      ? Math.max(1000, Number.isFinite(requestedTimeout) ? requestedTimeout : 15000)
      : Math.max(500, Number.isFinite(requestedTimeout) ? requestedTimeout : 4000);

    if (url.pathname === '/probe') {
      sendJson(req, res, 200, await handleProbe(target, timeoutMs));
      return;
    }

    sendJson(req, res, 200, await handlePrint(target, raw.dataBase64, timeoutMs));
  } catch (err) {
    const status = Number(err?.status) || 502;
    const message = err instanceof Error ? err.message : 'Print bridge failed.';
    if (!res.headersSent) sendJson(req, res, status, { error: message });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`LAN print bridge listening on http://${HOST}:${PORT}`);
});

server.on('error', err => {
  if (err && err.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} is already in use. The print bridge may already be running.`);
  } else {
    console.error(err);
  }
  process.exit(1);
});
