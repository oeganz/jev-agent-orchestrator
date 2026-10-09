// Token accounting from Claude Code transcripts (spec 7.1/7.4).
// Workers write to the REPO-ROOT project dir, not the fleet dir, because Orca's
// workspace is the git repo - so both are scanned.
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const DEFAULT_WEIGHTS = { input: 1.0, cache_write: 1.25, cache_read: 0.1, output: 3.0 };

export function projectDirFor(cwd) {
  return join(homedir(), '.claude', 'projects', cwd.replace(/[:\/]/g, '-').replace(/^-/, ''));
}

export function costScore(u, w = DEFAULT_WEIGHTS) {
  return (u.input || 0) * w.input
       + (u.cache_write || 0) * w.cache_write
       + (u.cache_read || 0) * w.cache_read
       + (u.output || 0) * w.output;
}

// One pass per file: aggregate usage per model, and capture the first user text
// so a session can be attributed to a dispatch by its spec fingerprint.
export function scanSession(file) {
  const out = { file, byModel: {}, usage: { input: 0, cache_write: 0, cache_read: 0, output: 0, thinking: 0 },
                firstUserText: null, firstTs: null, lastTs: null, role: null };
  let txt;
  try { txt = readFileSync(file, 'utf8'); } catch { return out; }
  for (const line of txt.split('\n')) {
    if (!line.includes('"usage"') && !line.includes('ROLE OVERRIDE')) continue;
    let o; try { o = JSON.parse(line); } catch { continue; }
    const ts = o.timestamp;
    if (ts) { if (!out.firstTs) out.firstTs = ts; out.lastTs = ts; }
    const u = o.message?.usage || o.usage;
    if (u && typeof u.input_tokens === 'number') {
      const model = o.message?.model || o.model || 'unknown';
      const add = {
        input: u.input_tokens || 0,
        cache_write: u.cache_creation_input_tokens || 0,
        cache_read: u.cache_read_input_tokens || 0,
        output: u.output_tokens || 0,
        thinking: u.output_tokens_details?.thinking_tokens || 0,
      };
      for (const k of Object.keys(out.usage)) out.usage[k] += add[k];
      out.byModel[model] = out.byModel[model] || { input: 0, cache_write: 0, cache_read: 0, output: 0, thinking: 0 };
      for (const k of Object.keys(add)) out.byModel[model][k] += add[k];
    }
    const m = o.message?.content;
    if (!out.firstUserText && o.type === 'user') {
      const s = typeof m === 'string' ? m : Array.isArray(m) ? (m.find(c => c.type === 'text')?.text || '') : '';
      if (s) {
        out.firstUserText = s.slice(0, 400);
        const rm = s.match(/ROLE OVERRIDE: You are an ([A-Z]+)/);
        if (rm) out.role = rm[1].toLowerCase();
        const fm = s.match(/fleet (\d{8}-\d{4}-[a-z0-9-]+)\/([a-z0-9-]+)/);
        if (fm) out.run = fm[1];
        if (fm) out.task = fm[2];
      }
    }
  }
  out.cost_score = costScore(out.usage);
  return out;
}

export function scanAll(dirs, { sinceMs = 0 } = {}) {
  const sessions = [];
  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir)) {
      if (!f.endsWith('.jsonl')) continue;
      const p = join(dir, f);
      try { if (statSync(p).mtimeMs < sinceMs) continue; } catch { continue; }
      const s = scanSession(p);
      if (s.usage.input || s.usage.output) sessions.push(s);
    }
  }
  return sessions;
}
