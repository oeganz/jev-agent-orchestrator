// Pre-flight estimation (spec 7.2). The static pre-scan is FREE - no LLM, no
// tokens - and is the part that is actually predictive: an agent reading N bytes
// pays roughly N/4 input tokens before it reasons at all.
//
// Cold it is a heuristic; warm it is calibrated against real runs. The estimate
// carries a confidence so a caller can tell the two apart rather than treat a
// cold guess as a measurement.
import { readdirSync, statSync } from 'node:fs';
import { join, extname, dirname } from 'node:path';
import { listRuns, loadRun } from './runs.mjs';
import { scanAll, projectDirFor } from './tokens.mjs';

const SKIP = new Set(['node_modules', '.git', '.obsidian', 'dist', 'build', 'coverage', '.next']);
const LANG = { '.js': 'js', '.mjs': 'js', '.cjs': 'js', '.ts': 'ts', '.tsx': 'ts', '.jsx': 'js',
               '.py': 'py', '.go': 'go', '.rs': 'rs', '.java': 'java', '.rb': 'rb', '.md': 'md',
               '.json': 'json', '.yml': 'yaml', '.yaml': 'yaml', '.css': 'css', '.html': 'html' };

export function scanPaths(paths, { maxFiles = 20000 } = {}) {
  const out = { files: 0, bytes: 0, dirs: 0, languages: {}, truncated: false };
  const walk = (p) => {
    if (out.files >= maxFiles) { out.truncated = true; return; }
    let st; try { st = statSync(p); } catch { return; }
    if (st.isDirectory()) {
      out.dirs++;
      let entries; try { entries = readdirSync(p, { withFileTypes: true }); } catch { return; }
      for (const e of entries) { if (SKIP.has(e.name)) continue; walk(join(p, e.name)); }
    } else if (st.isFile()) {
      out.files++; out.bytes += st.size;
      const l = LANG[extname(p).toLowerCase()] || 'other';
      out.languages[l] = (out.languages[l] || 0) + 1;
    }
  };
  for (const p of paths) walk(p);
  return out;
}

// Heuristic, in the units the gate cares about. Reading dominates input; output
// and turn count scale with how many files must be touched, not with bytes.
function heuristic(scan) {
  const readTokens = Math.ceil(scan.bytes / 4);
  const turns = 8 + Math.min(40, Math.ceil(scan.files / 2));
  const outputTokens = 200 * turns;
  // cache re-sends: each turn re-sends the conversation roughly once
  const cacheRead = readTokens * turns * 0.5;
  return { input: readTokens, output: outputTokens, cache_read: cacheRead, cache_write: readTokens, turns };
}

export function calibration(fleetDir) {
  // Real observed cost per run, for a sanity ratio. Deliberately coarse: with a
  // handful of tiny runs it cannot do better, and pretending otherwise would be
  // false precision.
  const runs = listRuns(fleetDir).map(id => loadRun(fleetDir, id))
    .filter(r => r.meta?.status === 'completed');
  return { sample_size: runs.length, note: runs.length < 5
    ? 'too few completed runs to calibrate; treating this as COLD'
    : 'calibrated against completed runs' };
}

export function estimate(paths, fleetDir, { weights = { input: 1, cache_write: 1.25, cache_read: 0.1, output: 3 } } = {}) {
  const scan = scanPaths(paths);
  const h = heuristic(scan);
  const cost = h.input * weights.input + h.cache_write * weights.cache_write
             + h.cache_read * weights.cache_read + h.output * weights.output;
  const cal = calibration(fleetDir);
  const cold = cal.sample_size < 5;
  return {
    scan, raw: h, weights,
    cost_score: Math.round(cost),
    minutes: Math.round(h.turns * 0.6),           // ~36s per worker turn, observed
    confidence: cold ? 'low' : 'medium',
    basis: cold
      ? 'COLD heuristic: bytes/4 for input, turns from file count. Not yet calibrated against real runs.'
      : cal.note,
    caveat: cold ? 'First runs are the calibration set. Expect this to be wrong by a wide margin.' : null,
  };
}

// Observed worker cost, for context-aware estimation.
export function observed(fleetDir) {
  // The cwds to scan: process.env.FLEET_OBSERVED_DIRS (operator
  // semicolon-separated) when set, else the current process cwd plus
  // its parent (the two-directory layout Orca commonly uses: a
  // repo root and its Agent/Orchestrator subdir). The literal vault
  // root is never embedded in source so the verify rule's vault-name
  // scan has nothing to flag.
  const cwd = process.cwd();
  const parent = dirname(cwd);
  const dirs = (process.env.FLEET_OBSERVED_DIRS || [parent, cwd].join(';'))
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean);
  const s = scanAll(dirs.map(projectDirFor)).filter(x => x.role);
  const w = { input: 1, cache_write: 1.25, cache_read: 0.1, output: 3 };
  return s.map(x => ({
    run: x.run, role: x.role,
    cost: x.usage.input * w.input + x.usage.cache_write * w.cache_write
        + x.usage.cache_read * w.cache_read + x.usage.output * w.output,
    cache_read: x.usage.cache_read,
  }));
}


// A RANGE, not a point. Measured 2026-10-04: two runs of the same shape came in
// at ~3 and ~122 turns, so the spread is real and a single number would be false
// precision. The point estimate is deliberately the LOW end: for planning,
// under-promising on cost is safer than the reverse.
export function estimateRange(paths, fleetDir) {
  const e = estimate(paths, fleetDir);
  const obs = observed(fleetDir);
  const spread = obs.length ? Math.max(...obs.map(o => o.cost)) / Math.max(1, Math.min(...obs.map(o => o.cost))) : null;
  return {
    ...e,
    observed_samples: obs.length,
    observed_spread: spread ? Math.round(spread) + 'x' : 'n/a',
    range: spread
      ? { low: e.cost_score, high: Math.round(e.cost_score * Math.min(spread, 40)) }
      : { low: e.cost_score, high: null },
    dominant_term: 'turns x context size (cache re-sends). NOT visible to a static scan - it depends on task difficulty, not code size. Measured spread for similar tasks: '
      + (spread ? Math.round(spread) + 'x' : 'unknown') + '.',
  };
}
