// Run-store access (spec 4.1). One place that knows the layout, so the CLI,
// metrics and future resume all read runs/ the same way.
import { readFileSync, readdirSync, existsSync, appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const runsRoot = (fleetDir) => join(fleetDir, 'runs');
const readJson = (p) => { try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; } };
export const jl = (p) => existsSync(p) ? readFileSync(p, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];

export function listRuns(fleetDir) {
  const root = runsRoot(fleetDir);
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => d.name)
    .sort();
}

export function loadRun(fleetDir, id) {
  const dir = join(runsRoot(fleetDir), id);
  if (!existsSync(dir)) return null;
  return {
    id, dir,
    meta: readJson(join(dir, 'run.json')),
    tasks: jl(join(dir, 'tasks.jsonl')),
    gates: jl(join(dir, 'gates.jsonl')),
      lifecycle: jl(join(dir, 'lifecycle.jsonl')),
    reports: existsSync(join(dir, 'reports')) ? readdirSync(join(dir, 'reports')) : [],
    hasSummary: existsSync(join(dir, 'summary.md')),
  };
}

export function createRun(fleetDir, id, meta) {
  const dir = join(runsRoot(fleetDir), id);
  mkdirSync(join(dir, 'reports'), { recursive: true });
  writeFileSync(join(dir, 'run.json'), JSON.stringify(meta, null, 1));
  writeFileSync(join(dir, 'tasks.jsonl'), '');
  writeFileSync(join(dir, 'gates.jsonl'), '');
  return dir;
}

export const appendTask = (dir, row) => appendFileSync(join(dir, 'tasks.jsonl'), JSON.stringify(row) + '\n');
export const appendGate = (dir, row) => appendFileSync(join(dir, 'gates.jsonl'), JSON.stringify(row) + '\n');
