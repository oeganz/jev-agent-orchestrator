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
const repoRoot = dirname(dirname(here));
const runsDir = join(repoRoot, 'fleet', 'runs');

process.stdout.write(`runs: ${countRunDirs(runsDir)}\n`);