import { createServer } from 'node:http';
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { dirname } from 'node:path';
import { createGateway } from './gateway.mjs';
import { destinationOrigin, validateDestination } from './destination.mjs';
import { snapshotTrust } from './trust.mjs';
import { openSshStream } from './ssh-stream.mjs';

export const setupHost = 'ccpocket.localhost';
const endpoint = '/__ccpocket/ssh';

// Every destination shares the listening port but has a separate browser origin.
// The setup origin never forwards Bridge credentials to an SSH target.
export async function createSshManager({ root, port = 8889, statePath,
  takeSnapshot = snapshotTrust, openStream = openSshStream, onError = () => {} }) {
  const destinations = new Map();
  const openings = new Map();
  const sockets = new Set();
  const saved = new Map();
  let closed = false;
  let closing;
  let setupGateway;
  let saveQueue = Promise.resolve();
  const json = (res, status, body) => res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }).end(JSON.stringify(body));
  const find = req => {
    const host = req.headers.host;
    if (host === `${setupHost}:${port}`) return { gateway: setupGateway };
    return [...destinations.values()].find(entry => host === `${entry.hostname}:${port}`);
  };
  const allowed = req => {
    const origin = `http://${req.headers.host}`;
    return (!req.headers.origin || req.headers.origin === origin) &&
      (!req.headers['sec-fetch-site'] || ['same-origin', 'none'].includes(req.headers['sec-fetch-site']));
  };
  const server = createServer(async (req, res) => {
    if (!setupGateway) { json(res, 503, { error: 'Starting' }); return; }
    const entry = find(req);
    if (!entry) { json(res, 403, { error: 'Unknown destination' }); return; }
    if (req.url !== endpoint) { entry.gateway.handleRequest(req, res); return; }
    if (!allowed(req)) { json(res, 403, { error: 'Forbidden' }); return; }
    if (req.method === 'GET') {
      json(res, 200, { available: true, alias: entry.alias ?? null, remotePort: entry.remotePort ?? null });
      return;
    }
    if (req.method !== 'POST' || req.headers.origin !== `http://${req.headers.host}` ||
        req.headers['content-type'] !== 'application/json') {
      json(res, 403, { error: 'Forbidden' }); return;
    }
    try {
      let body = '';
      for await (const chunk of req) {
        body += chunk.toString();
        if (Buffer.byteLength(body) > 1024) throw Error('Request too large');
      }
      const { alias, remotePort } = JSON.parse(body);
      validateDestination(alias, remotePort);
      const target = await connect({ alias, remotePort });
      json(res, 200, { url: target.url });
    } catch (error) {
      onError(error);
      json(res, 502, { error: 'SSH connection failed. Check the SSH destination and authentication on this computer.' });
    }
  });
  server.on('upgrade', (req, socket, head) => {
    const entry = find(req);
    if (!entry?.alias) { socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); return; }
    entry.gateway.handleUpgrade(req, socket, head);
  });
  server.on('connection', socket => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  port = server.address().port;
  try {
    setupGateway = await createGateway({ root, port, hostname: setupHost, listen: false,
      openStream: () => { throw Error('Choose an SSH destination first'); }, onError });
  } catch (error) { await new Promise(resolve => server.close(resolve)); throw error; }
  async function register(options, { refresh = false } = {}) {
    const key = JSON.stringify([options.alias, options.remotePort]);
    if (refresh || !openings.has(key)) {
      const pending = (async () => {
        const trust = await takeSnapshot(options);
        try {
          if (closed) throw Error('Server is shutting down');
          const hostname = destinationOrigin(trust.identity);
          const existing = destinations.get(hostname);
          if (existing) { await trust.close(); return existing; }
          const gateway = await createGateway({ root, port, hostname, listen: false,
            openStream: () => openStream({ ...options, ...trust }), onError });
          const entry = { ...options, trust, hostname, gateway, url: `http://${hostname}:${port}/` };
          destinations.set(hostname, entry);
          return entry;
        } catch (error) { await trust.close(); throw error; }
      })().catch(error => { if (openings.get(key) === pending) openings.delete(key); throw error; });
      openings.set(key, pending);
    }
    return openings.get(key);
  }
  async function connect(options) {
    options = { alias: options.alias, remotePort: options.remotePort };
    validateDestination(options.alias, options.remotePort);
    const entry = await register(options, { refresh: true });
    await entry.gateway.connect();
    saved.set(JSON.stringify([options.alias, options.remotePort]), options);
    if (statePath) {
      saveQueue = saveQueue.catch(() => {}).then(async () => {
        await mkdir(dirname(statePath), { recursive: true });
        await writeFile(`${statePath}.tmp`, JSON.stringify({ version: 1, destinations: [...saved.values()] }), { mode: 0o600 });
        await rename(`${statePath}.tmp`, statePath);
      });
      await saveQueue;
    }
    return entry;
  }
  function close() {
    if (!closing) closing = (async () => {
      closed = true;
      for (const socket of sockets) socket.destroy();
      await Promise.allSettled([...openings.values()]);
      await Promise.all([...destinations.values()].map(async entry => { await entry.gateway.close(); await entry.trust.close(); }));
      await setupGateway.close();
      await new Promise(resolve => server.close(resolve));
    })();
    return closing;
  }
  try {
    if (statePath) {
      let state;
      try { state = JSON.parse(await readFile(statePath, 'utf8')); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (state) {
        if (state.version !== 1 || !Array.isArray(state.destinations)) throw Error('Invalid saved SSH destinations');
        for (const options of state.destinations) {
          try {
            validateDestination(options.alias, options.remotePort);
            saved.set(JSON.stringify([options.alias, options.remotePort]), { alias: options.alias, remotePort: options.remotePort });
            await register({ alias: options.alias, remotePort: options.remotePort });
          } catch (error) { onError(error); }
        }
      }
    }
  } catch (error) {
    // A damaged local preference must not lock the user out of the setup UI.
    // Unrestored destinations stay unregistered and cannot receive traffic.
    onError(error);
  }
  return { port, url: `http://${setupHost}:${port}/`, connect, close };
}
