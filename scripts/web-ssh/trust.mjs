import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { promisify } from 'node:util';
import { validateDestination } from './destination.mjs';

const execute = promisify(execFile);
const readSshConfig = async alias => (await execute('ssh', ['-G', '--', alias], { windowsHide: true, timeout: 15000 })).stdout;

function paths(value = '') {
  return [...value.matchAll(/"([^"]*)"|'([^']*)'|([^\s]+)/g)]
    .map(match => match[1] ?? match[2] ?? match[3]).filter(path => path !== 'none').map(path => {
      const expanded = path.replace(/^~(?=[/\\]|$)/, homedir())
        .replace(/^__PROGRAMDATA__/, process.env.ProgramData ?? '__PROGRAMDATA__');
      // Fail closed for expansion syntax we cannot snapshot faithfully.
      if (!isAbsolute(expanded) || /[%$"\r\n]/.test(expanded)) throw Error('Unsupported SSH trust file path');
      return expanded;
    });
}

export async function snapshotTrust({ alias, remotePort, readConfig = readSshConfig }) {
  validateDestination(alias, remotePort);
  const rawConfig = await readConfig(alias);
  const config = Object.fromEntries(rawConfig.trim().split(/\r?\n/).map(line => {
    const space = line.indexOf(' ');
    return [line.slice(0, space), line.slice(space + 1)];
  }));
  if (config.knownhostscommand && config.knownhostscommand !== 'none') {
    throw Error('KnownHostsCommand cannot be frozen for this web launcher');
  }
  const destination = {
    hostname: config.hostname, user: config.user, port: Number(config.port),
    hostKeyAlias: config.hostkeyalias,
  };
  if (![destination.hostname, destination.user, ...(destination.hostKeyAlias ? [destination.hostKeyAlias] : [])].every(value =>
    typeof value === 'string' && /^[A-Za-z0-9_.:@-]+$/.test(value)) ||
    !Number.isInteger(destination.port) || destination.port < 1 || destination.port > 65535) {
    throw Error('Unsupported SSH destination configuration');
  }
  // Keep complete files: OpenSSH, rather than a custom parser, evaluates hashed
  // names, wildcards, certificates and revocations on the actual connection.
  const sources = [];
  for (const path of [...paths(config.userknownhostsfile), ...paths(config.globalknownhostsfile)]) {
    try { sources.push(await readFile(path)); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  const revokedPath = paths(config.revokedhostkeys)[0];
  const revoked = revokedPath ? await readFile(revokedPath) : null;
  const knownHosts = Buffer.concat(sources.flatMap(source => [source, Buffer.from('\n')]));
  if (!knownHosts.toString().trim()) throw Error('No trusted SSH hosts are available; connect with OpenSSH first');
  const digest = value => value === null ? null : createHash('sha256').update(value).digest('hex');
  const identity = digest(JSON.stringify([alias, remotePort, rawConfig, digest(knownHosts), digest(revoked)]));
  const directory = await mkdtemp(join(tmpdir(), 'ccpocket-ssh-'));
  try {
    const knownHostsPath = join(directory, 'known_hosts');
    const revokedKeysPath = revoked ? join(directory, 'revoked_keys') : null;
    const configPath = join(directory, 'ssh_config');
    const systemConfig = process.platform === 'win32'
      ? join(process.env.ProgramData, 'ssh', 'ssh_config') : '/etc/ssh/ssh_config';
    const includes = [join(homedir(), '.ssh', 'config'), systemConfig]
      .map(path => `Include "${path.replaceAll('\\', '/')}"`).join('\n');
    // Freeze the target's effective configuration without changing default
    // HostKeyAlias / nonstandard-port / certificate semantics. ProxyJump's ssh
    // child inherits -F and still reads the original configuration for its host.
    await writeFile(configPath, `Host ${alias}\n${rawConfig}\nHost * !${alias}\n${includes}\n`, { mode: 0o600 });
    await writeFile(knownHostsPath, knownHosts, { mode: 0o600 });
    if (revoked) await writeFile(revokedKeysPath, revoked, { mode: 0o600 });
    return {
      identity, knownHostsPath, revokedKeysPath, configPath,
      close: () => rm(directory, { recursive: true, force: true }),
    };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}
