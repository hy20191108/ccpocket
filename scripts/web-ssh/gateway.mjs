import { Agent, createServer, request } from 'node:http';
import { readFile, realpath, stat } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';

const contentTypes = {
  '.html': 'text/html; charset=utf-8', '.js': 'application/javascript',
  '.mjs': 'application/javascript', '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.css': 'text/css', '.wasm': 'application/wasm', '.png': 'image/png',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.ttf': 'font/ttf',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.otf': 'font/otf',
};

// A single same-origin loopback endpoint serves the app and forwards Bridge
// requests. In particular, a page on an unrelated origin cannot use this as
// a tunnel into the user's remote host.
export async function createGateway({ root, port, hostname = '127.0.0.1', openStream, onError = () => {} }) {
  const appRoot = await realpath(root);
  const sockets = new Set();
  const upstreamStreams = new Set();
  let closed = false;
  let closing;
  const trackedStream = () => {
    if (closed) throw Error('Server is shutting down');
    const stream = openStream();
    stream.on('error', onError);
    upstreamStreams.add(stream);
    stream.once('close', () => upstreamStreams.delete(stream));
    return stream;
  };
  const streamAgent = new Agent({ keepAlive: false });
  streamAgent.createConnection = trackedStream;
  const allowed = (req, navigation = false) => {
    const authority = `${hostname}:${server.address().port}`;
    const origin = req.headers.origin;
    const site = req.headers['sec-fetch-site'];
    return req.headers.host === authority &&
      (!origin || origin === `http://${authority}`) &&
      (!site || site === 'same-origin' || site === 'none' ||
        (navigation && ['GET', 'HEAD'].includes(req.method) &&
          req.headers['sec-fetch-mode'] === 'navigate' && req.headers['sec-fetch-dest'] === 'document'));
  };
  const staticFile = async path => {
    const name = decodeURIComponent(new URL(path, 'http://127.0.0.1').pathname);
    const candidate = resolve(appRoot, `.${name === '/' ? '/index.html' : name}`);
    if (!candidate.startsWith(appRoot + sep)) return null;
    try {
      const actual = await realpath(candidate);
      if (!actual.startsWith(appRoot + sep) || !(await stat(actual)).isFile()) return null;
      return actual;
    } catch (error) {
      if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return null;
      throw error;
    }
  };
  const server = createServer(async (req, res) => {
    if (!allowed(req, true)) { res.writeHead(403).end(); return; }
    try {
      if (req.method === 'GET' || req.method === 'HEAD') {
        const file = await staticFile(req.url);
        if (file) {
          const data = await readFile(file);
          res.writeHead(200, {
            'Content-Type': contentTypes[extname(file)] || 'application/octet-stream',
            'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff',
          });
          res.end(req.method === 'HEAD' ? undefined : data);
          return;
        }
      }
      if (!allowed(req)) { res.writeHead(403).end(); return; }
      const upstream = request({
        agent: streamAgent, path: req.url, method: req.method, headers: req.headers,
      }, response => {
        res.writeHead(response.statusCode, response.headers);
        response.pipe(res);
      });
      upstream.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end('Bridge unavailable'); });
      req.on('aborted', () => upstream.destroy());
      res.on('close', () => { if (!res.writableEnded) upstream.destroy(); });
      req.pipe(upstream);
    } catch (error) {
      onError(error);
      if (!res.headersSent) res.writeHead(502);
      res.end('SSH connection failed. Check the launcher output.');
    }
  });
  server.on('connection', socket => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  server.on('upgrade', async (req, socket, head) => {
    socket.on('error', () => socket.destroy());
    if (!allowed(req) || !req.headers.origin) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      return;
    }
    try {
      if (socket.destroyed) return;
      const upstream = trackedStream();
      upstream.once('error', () => socket.destroy());
      socket.once('error', () => upstream.destroy());
      socket.once('close', () => upstream.destroy());
      const forwardRequest = () => {
        const headers = [];
        for (let i = 0; i < req.rawHeaders.length; i += 2) {
          headers.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`);
        }
        upstream.write(`${req.method} ${req.url} HTTP/${req.httpVersion}\r\n${headers.join('\r\n')}\r\n\r\n`);
        if (head.length) upstream.write(head);
        socket.pipe(upstream).pipe(socket);
      };
      forwardRequest();
    } catch (error) {
      onError(error);
      socket.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n');
    }
  });
  await new Promise((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolveListen);
  });
  return {
    port: server.address().port,
    connect: () => new Promise((resolveProbe, reject) => {
      const probe = request({ agent: streamAgent, path: '/health' }, response => {
        response.resume();
        response.once('end', () => response.statusCode === 200 ? resolveProbe() : reject(Error('Bridge health check failed')));
      });
      const timer = setTimeout(() => probe.destroy(Error('Bridge health check timed out')), 20000);
      probe.once('close', () => clearTimeout(timer));
      probe.once('error', reject);
      probe.end();
    }),
    close() {
      if (!closing) {
        closed = true;
        for (const socket of sockets) socket.destroy();
        streamAgent.destroy();
        const streams = [...upstreamStreams];
        for (const stream of streams) stream.destroy();
        closing = Promise.all([
          new Promise(resolveClose => server.close(resolveClose)),
          ...streams.map(stream => stream.completion),
        ]);
      }
      return closing;
    },
  };
}
