// Timing analysis over the run store. Answers "what made this run slow?"
// Phases are derived from event gaps, so the breakdown is measured rather than
// guessed: dispatch->gate is time waiting on a worker, gate->dispatch is
// orchestrator review + dispatch overhead.
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const jl = (p) => existsSync(p) ? readFileSync(p, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
const mins = (ms) => (ms / 60000).toFixed(1);

export function analyse(runDir) {
  const tasks = jl(join(runDir, 'tasks.jsonl'));
  const gates = jl(join(runDir, 'gates.jsonl'));
  const events = [];
  for (const t of tasks) if (t.ts) events.push({ ts: Date.parse(t.ts), kind: 'dispatch', who: t.task_id, role: t.role });
  for (const g of gates) if (g.ts) events.push({ ts: Date.parse(g.ts), kind: 'gate', who: g.task_id, label: g.gate, verdict: g.verdict });
  events.sort((a, b) => a.ts - b.ts);
  if (events.length < 2) return { events, phases: [], totalMs: 0, missing: true };

  const phases = [];
  for (let i = 1; i < events.length; i++) {
    const prev = events[i - 1], cur = events[i];
    const ms = cur.ts - prev.ts;
    // dispatch -> gate means we waited on a worker; gate -> dispatch is our own time
    const kind = prev.kind === 'dispatch' && cur.kind === 'gate' ? 'worker'
               : prev.kind === 'gate' && cur.kind === 'dispatch' ? 'orchestrator' : 'other';
    phases.push({ from: prev.kind + ':' + prev.who, to: cur.kind + ':' + cur.who, kind, ms });
  }
  const totalMs = events[events.length - 1].ts - events[0].ts;
  // A dispatch with no task row means the tester/worker duration is unmeasurable
  const gateTasks = new Set(gates.map(g => g.task_id));
  const taskIds = new Set(tasks.map(t => t.task_id));
  const missing = [...gateTasks].filter(id => id && !taskIds.has(id));
  return { events, phases, totalMs, missing };
}

export function report(runDir, name) {
  const a = analyse(runDir);
  console.log(`TIMING  ${name}`);
  if (a.missing === true) { console.log('  not enough timestamped events to analyse'); return a; }
  const byKind = {};
  for (const p of a.phases) byKind[p.kind] = (byKind[p.kind] || 0) + p.ms;
  console.log(`  wall clock        ${mins(a.totalMs)} min`);
  for (const [k, ms] of Object.entries(byKind).sort((x, y) => y[1] - x[1]))
    console.log(`  ${k.padEnd(17)} ${mins(ms)} min  (${(100 * ms / a.totalMs).toFixed(0)}%)`);
  console.log('  slowest segments:');
  for (const p of [...a.phases].sort((x, y) => y.ms - x.ms).slice(0, 3))
    console.log(`    ${mins(p.ms).padStart(6)} min  ${p.kind.padEnd(13)} ${p.from} -> ${p.to}`);
  if (a.missing.length) {
    console.log(`  INSTRUMENTATION GAP: verdicts for ${a.missing.join(', ')} have no dispatch row,`);
    console.log('  so that worker\'s duration cannot be measured. Record a task row per dispatch.');
  }
  return a;
}
