import { fileURLToPath } from 'node:url';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { validateDestination } from './destination.mjs';
import { createSshManager } from './manager.mjs';

const help = `Usage: npm run web:ssh -- [--host SSH_ALIAS] [--bridge-port 8765] [--port 8889]

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
  validateDestination(alias ?? 'setup', remotePort);
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
    const manager = await createSshManager({
      root,
      port: options.port,
      statePath: join(process.env.LOCALAPPDATA ?? join(homedir(), '.local', 'state'), 'ccpocket', 'web-ssh', 'destinations.json'),
      onError: error => console.error(`SSH Bridge connection failed: ${error.message}`),
    });
    try {
      for (const signal of ['SIGINT', 'SIGTERM']) {
        process.once(signal, async () => { await manager.close(); process.exit(0); });
      }
      const target = options.alias ? await manager.connect(options) : null;
      console.log(`CC Pocket: ${target?.url ?? manager.url}`);
      console.log(`SSH settings: ${manager.url} (Add Machine > SSH)`);
      console.log('Press Ctrl+C to stop the web server and SSH connections.');
    } catch (error) { await manager.close(); throw error; }
  }
} catch (error) {
  console.error(`${error.message}\n${help}`);
  process.exitCode = 1;
}
