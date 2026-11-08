import { spawn } from 'node:child_process';
import { isAbsolute } from 'node:path';
import { Duplex } from 'node:stream';
import { validateDestination } from './destination.mjs';

// One SSH process carries one Bridge connection. The caller owns the trust
// snapshot and must keep it immutable for the lifetime of the browser origin.
export function openSshStream({ alias, remotePort, knownHostsPath, revokedKeysPath,
  configPath, spawnProcess = spawn }) {
  validateDestination(alias, remotePort);
  if (typeof knownHostsPath !== 'string' || !isAbsolute(knownHostsPath)) {
    throw Error('An absolute known-hosts snapshot path is required');
  }
  const child = spawnProcess('ssh', [
    ...(configPath ? ['-F', configPath] : []),
    '-T', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10',
    '-o', 'ForkAfterAuthentication=no', '-o', 'StdinNull=no',
    '-o', 'StrictHostKeyChecking=yes', '-o', 'UpdateHostKeys=no',
    '-o', 'NoHostAuthenticationForLocalhost=no',
    '-o', 'ControlMaster=no', '-o', 'ControlPath=none',
    '-o', 'VerifyHostKeyDNS=no', '-o', 'GlobalKnownHostsFile=none',
    '-o', 'KnownHostsCommand=none', '-o', `UserKnownHostsFile="${knownHostsPath}"`,
    '-o', revokedKeysPath ? `RevokedHostKeys="${revokedKeysPath}"` : 'RevokedHostKeys=none',
    '-o', 'ServerAliveInterval=30', '-o', 'ServerAliveCountMax=3',
    '-W', `127.0.0.1:${remotePort}`, '--', alias,
  ], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });

  // Do not expose SSH diagnostics to the browser or accumulate them in memory.
  child.stderr.resume();
  const stream = new Duplex({
    read() { child.stdout.resume(); },
    write(chunk, encoding, done) { child.stdin.write(chunk, encoding, done); },
    final(done) { child.stdin.end(done); },
    destroy(error, done) {
      child.stdin.destroy();
      child.stdout.destroy();
      if (child.exitCode === null && child.signalCode === null) child.kill();
      done(error);
    },
  });
  child.stdout.on('data', data => { if (!stream.push(data)) child.stdout.pause(); });
  child.stdout.once('end', () => stream.push(null));
  child.stdout.on('error', error => stream.destroy(error));
  child.stdin.on('error', error => stream.destroy(error));
  child.once('error', error => stream.destroy(error));
  stream.completion = new Promise(resolve => child.once('close', resolve));
  child.once('close', (code, signal) => {
    if (code !== 0 && !stream.destroyed) {
      stream.destroy(Error(`SSH forwarding failed (${signal ?? code})`));
    }
  });
  return stream;
}
