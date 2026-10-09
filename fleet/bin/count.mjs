import { readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export function countRunDirs(runsDirPath) {
  let n = 0;
  try {
    const entries = readdirSync(runsDirPath, { withFileTypes: true });
    for (const e of entries) {
      if (e.isDirectory()) n++;
    }
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  return n;
}

const here = dirname(fileURLToPath(import.meta.url));
const fleetDir = dirname(here);
const defaultRunsDir = join(fleetDir, 'runs');

const argv = process.argv.slice(2);
let runsDir = defaultRunsDir;
const fail = (msg) => { process.stderr.write('error: ' + msg + '\n'); process.exit(2); };

// Both forms are accepted. More importantly an argument we do not understand is
// an ERROR: silently ignoring it made `--dir=path` fall back to the default and
// report a wrong count with exit 0 (found by the fleet tester, 2026-10-04).
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--dir') {
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) fail('--dir requires a value');
    runsDir = next;
    i++;
  } else if (a.startsWith('--dir=')) {
    const v = a.slice('--dir='.length);
    if (!v) fail('--dir requires a value');
    runsDir = v;
  } else {
    fail('unrecognised argument: ' + a);
  }
}

process.stdout.write('runs: ' + countRunDirs(runsDir) + '\n');
