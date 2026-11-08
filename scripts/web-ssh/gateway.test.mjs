import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { connect } from 'node:net';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createGateway } from './gateway.mjs';
import { destinationOrigin, validateDestination } from './destination.mjs';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'ccpocket-gateway-test-'));
  await writeFile(join(root, 'index.html'), 'the app');
  const bridge = createServer((req, res) => res.end(`bridge:${req.url}`));
  const connections = new Set();
  bridge.on('connection', socket => {
    connections.add(socket);
    socket.once('close', () => connections.delete(socket));
  });
  bridge.on('upgrade', (req, socket) => {
    socket.write('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n');
    socket.on('data', data => socket.write(data));
  });
  await new Promise(resolve => bridge.listen(0, '127.0.0.1', resolve));
  let opened = 0;
  const hostname = destinationOrigin('a'.repeat(64));
  const gateway = await createGateway({ root, port: 0, hostname, openStream: () => {
    opened++;
    return connect(bridge.address().port, '127.0.0.1');
  } });
  t.after(async () => {
    await gateway.close();
    for (const socket of connections) socket.destroy();
    await new Promise(resolve => bridge.close(resolve));
    await rm(root, { recursive: true, force: true });
  });
  const authority = `${hostname}:${gateway.port}`;
  const get = (path, headers = {}, method = 'GET') => new Promise((resolve, reject) => {
    const req = request({ hostname: '127.0.0.1', port: gateway.port, path, method,
      headers: { Host: authority, ...headers } }, res => {
      let body = '';
      res.on('data', data => { body += data; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject);
    req.end();
  });
  const upgrade = (origin = `http://${authority}`) => new Promise((resolve, reject) => {
    const socket = connect(gateway.port, '127.0.0.1', () => {
      socket.write(`GET / HTTP/1.1\r\nHost: ${authority}\r\nOrigin: ${origin}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n`);
    });
    socket.once('data', data => resolve({ socket, response: data.toString() }));
    socket.once('error', reject);
  });
  return { gateway, get, upgrade, opened: () => opened };
}

test('serves the app and carries Bridge HTTP, WebSocket data and reconnects', async t => {
  const { gateway, get, upgrade, opened } = await fixture(t);
  await gateway.connect();
  assert.equal((await get('/')).body, 'the app');
  assert.equal((await get('/health')).body, 'bridge:/health');
  assert.equal((await get('/version?x=1')).body, 'bridge:/version?x=1');
  for (let attempt = 0; attempt < 2; attempt++) {
    const { socket, response } = await upgrade();
    assert.match(response, /^HTTP\/1\.1 101/);
    const reply = new Promise(resolve => socket.once('data', resolve));
    socket.write('application frame');
    assert.equal((await reply).toString(), 'application frame');
    socket.destroy();
  }
  assert.equal(opened(), 5);
});

test('rejects other origins, old destination tabs and cross-site requests before opening SSH', async t => {
  const { get, upgrade, opened } = await fixture(t);
  assert.equal((await get('/health', { Origin: 'https://example.com' })).status, 403);
  assert.equal((await get('/health', { Host: 'old-destination.localhost:8889' })).status, 403);
  assert.equal((await get('/health', { 'Sec-Fetch-Site': 'cross-site' })).status, 403);
  const { socket, response } = await upgrade('http://old-destination.localhost:8889');
  assert.match(response, /^HTTP\/1\.1 403/);
  socket.destroy();
  assert.equal(opened(), 0);
});

test('allows a link navigation to the app while denying that navigation to Bridge endpoints', async t => {
  const { get, opened } = await fixture(t);
  const navigation = { 'Sec-Fetch-Site': 'cross-site', 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Dest': 'document' };
  assert.equal((await get('/', navigation)).status, 200);
  assert.equal((await get('/health', navigation)).status, 403);
  assert.equal(opened(), 0);
});

test('rejects option-shaped SSH aliases and out-of-range ports', () => {
  assert.doesNotThrow(() => validateDestination('host-alias', 8767));
  assert.throws(() => validateDestination('-oProxyCommand=x', 8767));
  assert.throws(() => validateDestination('host;command', 8767));
  assert.throws(() => validateDestination('host', 65536));
});
