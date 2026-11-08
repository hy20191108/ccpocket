import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { snapshotTrust } from './trust.mjs';

test('freezes all host trust sources and isolates browser credentials when trust or destination changes', async t => {
  const root = await mkdtemp(join(tmpdir(), 'ccpocket-trust-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const userFile = join(root, 'user_hosts');
  const globalFile = join(root, 'global_hosts');
  const revokedFile = join(root, 'revoked_keys');
  await writeFile(userFile, '|1|hashed|entry ssh-ed25519 AAAA\n');
  await writeFile(globalFile, '@cert-authority *.example ssh-ed25519 BBBB\n@revoked host ssh-rsa CCCC\n');
  await writeFile(revokedFile, Buffer.from([0, 1, 2, 255]));
  let hostname = 'server.example';
  const config = () => `hostname ${hostname}\nuser tester\nport 22\nuserknownhostsfile "${userFile}"\nglobalknownhostsfile "${globalFile}"\nrevokedhostkeys "${revokedFile}"\n`;
  const snapshots = [];
  t.after(() => Promise.all(snapshots.map(snapshot => snapshot.close())));
  const take = async (remotePort = 8767) => {
    const snapshot = await snapshotTrust({ alias: 'test', remotePort, readConfig: async () => config() });
    snapshots.push(snapshot);
    return snapshot;
  };
  const first = await take();
  assert.match(await readFile(first.knownHostsPath, 'utf8'), /@cert-authority/);
  assert.match(await readFile(first.knownHostsPath, 'utf8'), /@revoked/);
  assert.match(await readFile(first.knownHostsPath, 'utf8'), /\|1\|hashed/);
  assert.deepEqual(await readFile(first.revokedKeysPath), Buffer.from([0, 1, 2, 255]));
  assert.equal((await take()).identity, first.identity);
  assert.notEqual((await take(8766)).identity, first.identity);
  hostname = 'different.example';
  assert.notEqual((await take()).identity, first.identity);
  hostname = 'server.example';
  await writeFile(userFile, 'changed ssh-ed25519 DDDD\n');
  assert.notEqual((await take()).identity, first.identity);
  assert.match(await readFile(first.knownHostsPath, 'utf8'), /\|1\|hashed/);
});

test('refuses dynamic trust providers and unreadable configured revocations', async () => {
  await assert.rejects(snapshotTrust({ alias: 'test', remotePort: 8767,
    readConfig: async () => 'hostname example\nuser tester\nport 22\nknownhostscommand custom-command\n' }), /KnownHostsCommand/);
  await assert.rejects(snapshotTrust({ alias: 'test', remotePort: 8767,
    readConfig: async () => 'hostname example\nuser tester\nport 22\nrevokedhostkeys /missing-ccpocket-revocations\n' }), /ENOENT/);
});

test('distinguishes host trust from revocations even when their concatenation is identical', async t => {
  const root = await mkdtemp(join(tmpdir(), 'ccpocket-trust-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const known = join(root, 'known_hosts');
  const revoked = join(root, 'revoked');
  const options = { alias: 'test', remotePort: 8765, readConfig: async () =>
    `hostname example\nuser tester\nport 22\nuserknownhostsfile "${known}"\nrevokedhostkeys "${revoked}"\n` };
  await writeFile(known, 'example ssh-ed25519 BBBB\n');
  await writeFile(revoked, 'ssh-ed25519 AAAA\n\n');
  const first = await snapshotTrust(options);
  t.after(() => first.close());
  await writeFile(known, 'example ssh-ed25519 BBBB\n\nssh-ed25519 AAAA\n');
  await writeFile(revoked, '');
  const second = await snapshotTrust(options);
  t.after(() => second.close());
  assert.notEqual(first.identity, second.identity);
});
