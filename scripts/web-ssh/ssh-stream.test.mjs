import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { resolve } from 'node:path';
import { openSshStream } from './ssh-stream.mjs';

function fakeProcess() {
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.exitCode = null;
  child.signalCode = null;
  child.kill = () => { child.killed = true; };
  return child;
}

test('opens a stream with strict host checking and no local listener', async () => {
  const child = fakeProcess();
  let invocation;
  const knownHostsPath = resolve('snapshot');
  const stream = openSshStream({ alias: 'host-alias', remotePort: 8765, knownHostsPath,
    spawnProcess: (...args) => { invocation = args; return child; } });
  assert.equal(invocation[0], 'ssh');
  assert.ok(invocation[1].includes('StrictHostKeyChecking=yes'));
  assert.ok(invocation[1].includes('ForkAfterAuthentication=no'));
  assert.ok(invocation[1].includes('StdinNull=no'));
  assert.ok(invocation[1].includes('NoHostAuthenticationForLocalhost=no'));
  assert.ok(invocation[1].includes('ControlMaster=no'));
  assert.ok(invocation[1].includes('ControlPath=none'));
  assert.ok(invocation[1].includes(`UserKnownHostsFile="${knownHostsPath}"`));
  assert.ok(invocation[1].includes('KnownHostsCommand=none'));
  assert.ok(invocation[1].includes('127.0.0.1:8765'));
  assert.ok(!invocation[1].includes('-L'));
  const outbound = new Promise(resolveData => child.stdin.once('data', resolveData));
  stream.write('request');
  assert.equal((await outbound).toString(), 'request');
  const inbound = new Promise(resolveData => stream.once('data', resolveData));
  child.stdout.write('response');
  assert.equal((await inbound).toString(), 'response');
  stream.destroy();
  await new Promise(resolveClose => stream.once('close', resolveClose));
  assert.equal(child.killed, true);
});

test('rejects invalid destinations and an unqualified trust file', () => {
  assert.throws(() => openSshStream({ alias: '-bad', remotePort: 8765, knownHostsPath: resolve('snapshot') }));
  assert.throws(() => openSshStream({ alias: 'host', remotePort: 8765, knownHostsPath: 'relative' }));
});

test('reports SSH failure without sending its diagnostics to the browser', async () => {
  const child = fakeProcess();
  const stream = openSshStream({ alias: 'host', remotePort: 8765, knownHostsPath: resolve('snapshot'), spawnProcess: () => child });
  const failure = new Promise(resolveError => stream.once('error', resolveError));
  child.stderr.write('private diagnostic');
  child.exitCode = 255;
  child.emit('close', 255, null);
  assert.match((await failure).message, /^SSH forwarding failed/);
});
