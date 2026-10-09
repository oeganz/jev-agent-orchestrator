// Daily budget ledger (spec 7.3/7.4). Sums the weighted cost_score of today's
// sessions and answers "may I dispatch?" before any worker starts.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { scanAll, projectDirFor, DEFAULT_WEIGHTS } from './tokens.mjs';

export function loadConfig(path = new URL('../../config.json', import.meta.url)) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

export function startOfToday(now = new Date()) {
  const d = new Date(now); d.setHours(0, 0, 0, 0); return d.getTime();
}

export function todaySpend(cfg, now = new Date()) {
  const w = cfg.cost_weights || DEFAULT_WEIGHTS;
  // The cwds to scan: process.env.FLEET_OBSERVED_DIRS (operator
  // semicolon-separated) when set, else the current process cwd plus
  // its parent (the two-directory layout Orca commonly uses). The
  // literal vault root is never embedded in source.
  const cwd = process.cwd();
  const parent = dirname(cwd);
  const dirs = (process.env.FLEET_OBSERVED_DIRS || [parent, cwd].join(';'))
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean)
    .map(projectDirFor);
  const sessions = scanAll(dirs, { sinceMs: startOfToday(now) });
  let total = 0; const bySession = [];
  for (const s of sessions) {
    const u = s.usage;
    const score = u.input * (w.input ?? 1) + u.cache_write * (w.cache_write ?? 1.25)
                + u.cache_read * (w.cache_read ?? 0.1) + u.output * (w.output ?? 3);
    total += score;
    bySession.push({ file: s.file.split(/[\/]/).pop(), role: s.role, run: s.run, score, models: Object.keys(s.byModel) });
  }
  return { total, bySession, sessions: sessions.length };
}

export function budgetCheck(cfg, { estimate = 0, now = new Date() } = {}) {
  const cap = cfg.budget?.daily_cap;
  // An unset cap means the limit is unknown, not zero. Report, never block.
  if (!cap) return { spent: todaySpend(cfg, now).total, estimate, cap: null, calibrated: false, level: 'uncalibrated', allow: true };
  const warnPct = cfg.budget?.warn_pct ?? 80;
  const stopPct = cfg.budget?.hard_stop_pct ?? 100;
  const reservePct = cfg.budget?.reserve_pct ?? 10;
  const { total } = todaySpend(cfg, now);
  const usable = cap * (1 - reservePct / 100);
  const after = total + estimate;
  const pct = cap ? (100 * after) / cap : 0;
  return {
    spent: total, estimate, after, cap, usable: Math.round(usable), pct,
    level: pct >= stopPct ? 'stop' : pct >= warnPct ? 'warn' : 'ok',
    allow: after <= usable,
  };
}

export const fmt = (n) => n.toLocaleString('en-US', { maximumFractionDigits: 0 });
