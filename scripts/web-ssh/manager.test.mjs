import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { connect } from 'node:net';
import { createHash } from 'node:crypto';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createSshManager, setupHost } from './manager.mjs';

test('configures SSH from the app, isolates destinations, and restores saved targets safely', async t => {
  const root = await mkdtemp(join(tmpdir(), 'ccpocket-manager-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'index.html'), 'app');
  let forwarded = 0;
  const bridge = createServer((req, res) => { forwarded++; res.end('bridge'); });
  await new Promise(resolve => bridge.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => bridge.close(resolve)));
  let trustVersion = 1;
  let failedAlias;
  const options = { root, port: 0, statePath: join(root, 'destinations.json'),
    takeSnapshot: async destination => {
      if (destination.alias === failedAlias) throw Error('Cannot read trust configuration');
      return { identity: createHash('sha256').update(JSON.stringify([destination, trustVersion])).digest('hex'), close: async () => {} };
    },
    openStream: () => connect(bridge.address().port, '127.0.0.1') };
  let manager = await createSshManager(options);
  t.after(() => manager.close());
  const call = (host, path, body, headers = {}) => new Promise((resolve, reject) => {
    const req = request({ hostname: '127.0.0.1', port: manager.port, path,
      method: body ? 'POST' : 'GET', headers: { Host: `${host}:${manager.port}`,
        ...(body ? { Origin: `http://${host}:${manager.port}`, 'Content-Type': 'application/json' } : {}), ...headers } }, res => {
      let text = ''; res.on('data', data => { text += data; });
      res.on('end', () => resolve({ status: res.statusCode, text }));
    });
    req.on('error', reject); req.end(body ? JSON.stringify(body) : undefined);
  });
  assert.equal((await call(setupHost, '/__ccpocket/ssh')).status, 200);
  assert.equal((await call(setupHost, '/__ccpocket/ssh', { alias: 'first', remotePort: 8765 }, { Origin: 'https://example.com' })).status, 403);
  assert.equal(forwarded, 0);
  const first = JSON.parse((await call(setupHost, '/__ccpocket/ssh', { alias: 'first', remotePort: 8765 })).text);
  const firstHost = new URL(first.url).hostname;
  assert.equal((await call(firstHost, '/health')).text, 'bridge');
  const info = JSON.parse((await call(firstHost, '/__ccpocket/ssh')).text);
  assert.equal(info.alias, 'first');
  assert.equal(info.remotePort, 8765);
  const second = JSON.parse((await call(firstHost, '/__ccpocket/ssh', { alias: 'second', remotePort: 8765 })).text);
  assert.notEqual(new URL(second.url).hostname, firstHost);
  assert.equal((await call(firstHost, '/health', null, { Origin: second.url.slice(0, -1) })).status, 403);
  trustVersion++;
  const changed = JSON.parse((await call(setupHost, '/__ccpocket/ssh', { alias: 'first', remotePort: 8765 })).text);
  assert.notEqual(new URL(changed.url).hostname, firstHost);
  trustVersion--;
  await manager.close();
  manager = await createSshManager(options);
  assert.equal((await call(firstHost, '/health')).status, 200);
  await manager.close();
  failedAlias = 'first';
  manager = await createSshManager(options);
  assert.equal((await call(setupHost, '/__ccpocket/ssh')).status, 200);
  assert.equal((await call(firstHost, '/health')).status, 403);
  assert.equal((await call(new URL(second.url).hostname, '/health')).status, 200);
  await manager.close();
  failedAlias = null;
  trustVersion++;
  manager = await createSshManager(options);
  assert.equal((await call(firstHost, '/health')).status, 403);
  await manager.close();
  await writeFile(options.statePath, '{');
  manager = await createSshManager(options);
  assert.equal((await call(setupHost, '/__ccpocket/ssh')).status, 200);
  assert.equal((await call(firstHost, '/health')).status, 403);
});
