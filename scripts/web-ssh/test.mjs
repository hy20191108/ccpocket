import { spawn } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const directory = new URL('./', import.meta.url);
const tests = (await readdir(directory)).filter(name => name.endsWith('.test.mjs'));
const child = spawn(process.execPath, ['--test', ...tests.map(name => fileURLToPath(new URL(name, directory)))], { stdio: 'inherit' });
child.on('exit', code => { process.exitCode = code ?? 1; });
