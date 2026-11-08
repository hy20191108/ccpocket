import { fileURLToPath } from 'node:url';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { createGateway } from './gateway.mjs';
import { destinationOrigin, validateDestination } from './destination.mjs';
import { snapshotTrust } from './trust.mjs';
import { openSshStream } from './ssh-stream.mjs';

const help = `Usage: npm run web:ssh -- --host SSH_ALIAS [--bridge-port 8765] [--port 8889]

Build the web app first: cd apps/mobile && flutter build web --release
The SSH alias uses your local OpenSSH configuration and authentication agent.
The remote Bridge must listen on 127.0.0.1 at the selected port.
`;
function readOptions(args) {
  const values = {};
  for (let i = 0; i < args.length; i++) {
    const key = args[i];
    if (key === '--help' || key === '-h') return null;
    if (!['--host', '--bridge-port', '--port'].includes(key) || i + 1 >= args.length || key in values) {
      throw Error(`Invalid argument: ${key}`);
    }
    values[key] = args[++i];
  }
  const alias = values['--host'];
  const remotePort = Number(values['--bridge-port'] ?? 8765);
  const port = Number(values['--port'] ?? 8889);
  if (!alias) throw Error('The --host SSH alias is required');
  validateDestination(alias, remotePort);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw Error('Invalid local port');
  return { alias, remotePort, port };
}
try {
  const options = readOptions(process.argv.slice(2));
  if (!options) {
    console.log(help);
  } else {
    const root = fileURLToPath(new URL('../../apps/mobile/build/web/', import.meta.url));
    const index = await stat(join(root, 'index.html')).catch(() => null);
    if (!index?.isFile()) throw Error('Web build is missing');
    const trust = await snapshotTrust(options);
    const hostname = destinationOrigin(trust.identity);
    let gateway;
    const close = async () => { await gateway?.close(); await trust.close(); };
    try {
    gateway = await createGateway({
      root,
      port: options.port,
      hostname,
      openStream: () => openSshStream({ ...options, ...trust }),
      onError: error => console.error(`SSH Bridge connection failed: ${error.message}`),
    });
    for (const signal of ['SIGINT', 'SIGTERM']) {
      process.once(signal, async () => { await close(); process.exit(0); });
    }
    console.log(`Connecting to SSH host ${options.alias}...`);
    await gateway.connect();
    console.log(`CC Pocket: http://${hostname}:${gateway.port}`);
    console.log(`Add a machine with host ${hostname} and port ${gateway.port}. Its Bridge connection uses SSH host ${options.alias}.`);
    console.log('Press Ctrl+C to stop the web server and SSH connection.');
    } catch (error) { await close(); throw error; }
  }
} catch (error) {
  console.error(`${error.message}\n${help}`);
  process.exitCode = 1;
}
