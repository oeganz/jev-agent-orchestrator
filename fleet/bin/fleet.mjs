#!/usr/bin/env node
// fleet - CLI for the agent fleet. Cross-platform, zero dependencies.
// Usage: node fleet/bin/fleet.mjs <status|runs|report|doctor> [args]
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { orcaStatus, resolveOrca, releaseAll, printReleaseResults, settleSnapshot, releaseTakeoverLeaks } from './lib/orca.mjs';
import { loadEnv } from './lib/env.mjs';
import { report as timingReport } from './lib/timing.mjs';
import { score as scoreAxis, print as printScore } from './lib/score.mjs';
import { loadConfig, todaySpend, budgetCheck, fmt } from './lib/ledger.mjs';
import { estimateRange } from './lib/estimate.mjs';
import { acquire, heartbeat, release, reconcile } from './lib/lease.mjs';
import { probeToolCalls } from './lib/probe.mjs';
import { fsChecks, commandResolves, milestoneStoreCheck } from './lib/doctor.mjs';
import { skillCatalog, buildRouteQuestions, routeDecision, routingConfig, askFromConfig, loadFleetConfig, route } from './lib/jev-router.mjs';
import { validateDoc, gapReport, formatGapReport, extractClaims } from './lib/project-doc.mjs';
import { docDriftCli } from './lib/docdrift.mjs';
loadEnv();

const HERE = dirname(fileURLToPath(import.meta.url));
const FLEET = dirname(HERE);
const ROOT = dirname(FLEET);            // Agent/Orchestrator
const RUNS = join(FLEET, 'runs');
const CONFIG = join(FLEET, 'config.json');

const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));
const jl = (p) => existsSync(p) ? readFileSync(p, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
// Run dirs, excluding fleet/runs/_archive (settle's terminal-output archive -
// real worker output, but not a run).
const runDirs = () => existsSync(RUNS) ? readdirSync(RUNS, { withFileTypes: true }).filter(d => d.isDirectory() && d.name !== '_archive').map(d => d.name).sort() : [];

// Reuse the same modules for both the human and JSON surfaces. Each value is
// computed once and the printer just renders the result - no second pass.
// `readRun` / `settleSnapshot` / the runsDir are injectable so the tests
// never touch the real fleet/runs directory or live Orca.
export function buildStatusState({
  cfg,
  env = process.env,
  // Tests pass their own list of run ids (string[]) here to avoid touching
  // the filesystem. The live path passes nothing -> runDirs() handles it
  // (and excludes fleet/runs/_archive, the terminal-output archive).
  runDirs: runsFn = runDirs,
  readRun = (id) => safeRun(id),
  settleSnapshot: settleSnapshotFn = settleSnapshot,
} = {}) {
  const ids = runsFn();
  const active = ids.filter((id) => { const r = readRun(id); return r && r.status === 'active'; });
  // Hard rule 2: never end with a reclaimable worker. Surface it here so the
  // leak is visible at a glance - each is a live agent process doing nothing.
  // user_takeover leaks count toward the same total: worker-release refuses
  // them, so without counting them `fleet settle` could "settle" while
  // processes still remain.
  // Only LIVE takeover terminals are leaks; records whose terminal is already
  // gone are informational, and an unavailable liveness check is reported as
  // unknown - never as a confirmed violation.
  const snap = settleSnapshotFn();
  const reclaimable = snap === null ? null : snap.reclaimable.length;
  const userTakeoverLeaks = snap === null ? null : snap.leaks.length;
  // Mirror the EXACT human-output branching so the JSON info surface and the
  // printed info lines stay in sync. Each entry carries the original column
  // label so printStatus can recreate the human line byte-for-byte; the
  // JSON surface exposes just the message (callers don't need the label
  // when they have structured fields to work with).
  const info = [];
  if (snap && snap.leakCheck === 'unavailable') {
    info.push({
      label: 'leaks     ',
      text: `leak check unavailable (orca terminal list failed) - ${snap.unverified.length} user_takeover candidate(s) unverified`,
    });
  }
  if (snap && snap.gone.length > 0) {
    info.push({
      label: 'info       ',
      text: `${snap.gone.length} user_takeover dispatch(es) whose terminal is already gone (not a leak): ${snap.gone.map((w) => w.dispatchId).join(', ')}`,
    });
  }
  return {
    runs: ids.length,
    active,
    jev: { key_set: !!env[cfg.jev.api_key_env] },
    terminals: { reclaimable, user_takeover_leaks: userTakeoverLeaks },
    info,
  };
}

// Renders a buildStatusState() result in the original human format. Anything
// that adds a line MUST land in buildStatusState().info first so the JSON
// output and the printed lines never drift.
function printStatus(state, ctx) {
  console.log('ORCA');
  console.log(`  binary     ${ctx.st.cmd}  (${resolveOrca().why})`);
  console.log(`  app        ${ctx.st.app ? 'running' : 'NOT RUNNING'}`);
  console.log(`  runtime    ${ctx.st.runtime || 'unknown'}${ctx.st.version ? '  v' + ctx.st.version : ''}`);
  console.log('FLEET');
  console.log(`  mode       ${ctx.cfg.mode}  (JE v authority: ${ctx.cfg.jev.authority})`);
  console.log(`  runs       ${state.runs}`);
  if (state.active.length) console.log(`  ACTIVE     ${state.active.join(', ')}`);
  console.log(`  JEV key    ${state.jev.key_set ? 'set' : 'NOT SET (' + ctx.cfg.jev.api_key_env + ')'}`);
  // Terminals line - same 3-branch decision as the human output used.
  const t = state.terminals;
  if (t.reclaimable === null) {
    console.log('  terminals  ?  (orca worker-list unavailable)');
  } else if (t.reclaimable === 0 && t.user_takeover_leaks === 0) {
    console.log('  terminals  0 reclaimable, 0 user_takeover leaks');
  } else {
    const parts = [];
    if (t.reclaimable > 0) parts.push(`${t.reclaimable} RECLAIMABLE`);
    if (t.user_takeover_leaks > 0) parts.push(`${t.user_takeover_leaks} live user_takeover leak${t.user_takeover_leaks === 1 ? '' : 's'}`);
    console.log(`  terminals  ${parts.join(' + ')}  <-- hard rule 2 violated: run 'fleet settle'`);
  }
  for (const entry of state.info) console.log(`  ${entry.label}${entry.text}`);
}

function cmdStatus(args) {
  const cfg = readJson(CONFIG);
  const st = orcaStatus();
  const state = buildStatusState({ cfg });
  if (args && args.includes('--json')) {
    // JSON mode prints ONLY the JSON object - no banner, no trailing text.
    // Build it from the same state the human lines are rendered from so the
    // two views cannot drift.
    process.stdout.write(JSON.stringify({
      runs: state.runs,
      active: state.active,
      jev: { key_set: state.jev.key_set },
      terminals: {
        reclaimable: state.terminals.reclaimable,
        user_takeover_leaks: state.terminals.user_takeover_leaks,
      },
      info: state.info.map((e) => e.text),
    }) + '\n');
    return;
  }
  printStatus(state, { cfg, st });
}

function cmdRuns() {
  const dirs = runDirs();
  if (!dirs.length) return console.log('no runs');
  console.log('run_id'.padEnd(30) + 'status'.padEnd(11) + 'gates  tasks  summary');
  for (const id of dirs) {
    const r = safeRun(id);
    const g = jl(join(RUNS, id, 'gates.jsonl')).length;
    const t = jl(join(RUNS, id, 'tasks.jsonl')).length;
    console.log(id.padEnd(30) + String(r?.status || '?').padEnd(11) + String(g).padEnd(7) + String(t).padEnd(7) +
      (existsSync(join(RUNS, id, 'summary.md')) ? 'yes' : 'NO'));
  }
}

function cmdReport(id) {
  if (!id) return console.log('usage: fleet report <run-id>');
  const dir = join(RUNS, id);
  if (!existsSync(dir)) return console.log('no such run: ' + id);
  const r = safeRun(id);
  console.log(`RUN ${id}`);
  console.log(`  objective  ${r?.objective || '?'}`);
  console.log(`  status     ${r?.status || '?'}`);
  for (const g of jl(join(dir, 'gates.jsonl'))) {
    const mark = g.verdict === 'accept' || g.verdict === 'verified' ? 'OK  ' : 'REWORK';
    const jev = g.jev_shadow ? `  jev=${g.jev_shadow.policy_verdict}${g.agreement === false ? ' (DISAGREE)' : ''}` : '';
    console.log(`  ${mark} ${String(g.gate).padEnd(11)} ${g.task_id || ''}${jev}`);
  }
  const s = join(dir, 'summary.md');
  if (existsSync(s)) console.log('\n--- summary.md ---\n' + readFileSync(s, 'utf8').split('\n').slice(0, 12).join('\n'));
}

function cmdSettle() {
  // Mechanical enforcement of spec section 9 / hard rule 2. The orchestrator
  // session is supposed to release each worker after its gate, but across runs
  // it skipped that step and terminals piled up (14 live claude processes,
  // 4.4 GB). This makes settling one command instead of discipline.
  //
  // Two leak classes, two release paths:
  //  - terminalState 'reclaimable' -> Orca's own worker-release (archives the
  //    transcript and closes the agent process itself).
  //  - terminalState 'retained' + retainedReason 'user_takeover' -> Orca
  //    REFUSES worker-release; the only way out is archiving the output
  //    (worker-read) and then closing the terminal tab directly. Never close
  //    without an archive; never close the coordinator's own terminal
  //    (ORCA_TERMINAL_HANDLE).
  //  Liveness: a takeover record whose terminal no longer exists in `orca
  //  terminal list` is not a leak and is never closed. If the terminal list
  //  itself fails, nothing is closed and the outcome is unknown (exit 1).
  const snap = settleSnapshot();
  if (snap === null) return console.log('orca worker-list unavailable - cannot settle');
  const { reclaimable: rc, leaks } = snap;
  if (snap.gone.length) {
    console.log(`info: ${snap.gone.length} user_takeover dispatch(es) whose terminal is already gone - not a leak, skipped: ${snap.gone.map((w) => w.dispatchId).join(', ')}`);
  }
  if (snap.leakCheck === 'unavailable') {
    console.log(`leak check unavailable (orca terminal list failed) - ${snap.unverified.length} user_takeover candidate(s) NOT closed: ${snap.unverified.map((w) => w.dispatchId).join(', ')}`);
    process.exitCode = 1;
  }
  if (!rc.length && !leaks.length) {
    return console.log(`nothing to settle: 0 reclaimable, 0 live user_takeover leaks${snap.leakCheck === 'unavailable' ? ' confirmed (liveness unknown)' : ''}`);
  }
  let allOk = true;
  if (rc.length) {
    console.log(`releasing ${rc.length} reclaimable worker(s)...`);
    // printReleaseResults() absorbs the release-LEVEL failure shape: when
    // worker-list is unavailable releaseAll() returns {ok:false,error} with
    // no results array, and the old `for (const r of res.results)` crashed
    // with "res.results is not iterable" before the leak section could run.
    const res = releaseAll();
    const printed = printReleaseResults(res);
    for (const line of printed.lines) console.log(line);
    if (!printed.allOk) allOk = false;
    if (printed.releaseFailed) process.exitCode = 1;
  }
  if (leaks.length) {
    console.log(`closing ${leaks.length} live user_takeover leak(s) (archive first)...`);
    const results = releaseTakeoverLeaks(leaks, { archiveDir: join(RUNS, '_archive') });
    for (const r of results) {
      console.log(`${r.ok ? 'ok  ' : 'FAIL'}  ${r.dispatch}${r.note ? '  ' + r.note : ''}`);
    }
    if (!results.every((r) => r.ok)) allOk = false;
  }
  const after = settleSnapshot();
  const leftRc = after === null ? '?' : after.reclaimable.length;
  const leftLeaks = after === null || after.leakCheck === 'unavailable' ? '?' : after.leaks.length;
  const known = after === null ? null : after.reclaimable.length + after.leaks.length;
  console.log(`\n${allOk ? 'settled' : 'PARTIAL'}: ${leftRc}${leftRc === '?' ? '' : ' still reclaimable'}, ${leftLeaks}${leftLeaks === '?' ? ' (leak check unavailable)' : ' live user_takeover leaks remaining'}`);
  if (known && known > 0) process.exitCode = 1;
  if (after && after.leakCheck === 'unavailable') process.exitCode = 1;
}

// Pure, testable row evaluation for `cmdDoctor`. The cmd builds the rows
// (filesystem + runtime) and prints them; this function classifies them
// and returns the bad/advisory-missing counts + the human-readable lines
// so tests can assert the exit-code and the wording without spawning a
// subprocess.
//
// Rows are 2/3/4-tuples:
//   [label, ok]                              - 2-tuple, severity defaults to 'fail'
//   [label, ok, severity]                    - 3-tuple, severity 'fail' or 'advisory'
//   [label, ok, severity, note]              - 4-tuple, 'note' is the indented
//                                              second-line text printed below an
//                                              advisory row so a reader cannot
//                                              mistake it for a failure. When
//                                              omitted, a generic default is used.
//
// severity:
//   'fail'     - the default; a non-ok row counts toward bad and the exit code.
//   'advisory' - the row is reported (with a 'note ' tag) but NEVER counts
//                toward bad. An advisory row that is not ok is reported as
//                "absent" and counted as `advisoryMissing` so the summary
//                line can distinguish it from a real failure.
//
//   evaluateDoctorChecks(checks) -> { bad, advisoryMissing, lines }
//     bad               number of failing rows (severity 'advisory' rows excluded).
//     advisoryMissing   number of advisory rows where ok=false (i.e. optional
//                       items that are documented in the README but not present
//                       in this environment). Never affects the exit code.
//     lines             human-readable lines the printer would produce.
//
// The lines are the EXACT strings cmdDoctor would print for the same rows:
// each row gets a 'tag  name' line (3 characters of 'ok   ' / 'FAIL ' /
// 'note ', two spaces, name) and an advisory row additionally gets an
// indented note line explaining what the row means. The closing summary
// line ('all checks pass' / 'N problem(s)' / 'all checks pass (M optional
// item(s) not present)' / 'N problem(s), M optional item(s) not present')
// is included so a test can assert the final wording too.
export function evaluateDoctorChecks(checks) {
  const lines = [];
  let bad = 0;
  let advisoryMissing = 0;
  for (const row of checks) {
    const [name, ok, severity = 'fail', note = null] = row;
    const tag = severity === 'advisory' ? 'note' : (ok ? 'ok  ' : 'FAIL');
    lines.push(`${tag}  ${name}`);
    if (severity === 'advisory') {
      // Caller-supplied note wins when present (lets the cmdDoctor rows point
      // at the README section that documents the option). The default keeps
      // the existing CLAUDE.md wording for callers that pass severity only.
      const defaultNote = ok
        ? 'present (optional - documented in README; not required for a working install)'
        : 'absent - OPTIONAL per the README; this is not required for a working install';
      lines.push(`       ${note || defaultNote}`);
      if (!ok) advisoryMissing++;
    }
    if (!ok && severity !== 'advisory') bad++;
  }
  // The blank-line-then-summary shape is the same the printer always used:
  // emit a blank line, then the closing sentence. Keeping the lines as
  // distinct entries means a test can assert the last entry with a clean
  // regex, and the printer (console.log per line) reproduces the original
  // spacing exactly. The summary distinguishes the two counts so a reader
  // never confuses an optional item not being present for a real failure.
  lines.push('');
  if (bad === 0 && advisoryMissing === 0) {
    lines.push('all checks pass');
  } else if (bad === 0) {
    lines.push(`all checks pass (${advisoryMissing} optional item${advisoryMissing === 1 ? '' : 's'} not present)`);
  } else if (advisoryMissing === 0) {
    lines.push(`${bad} problem(s)`);
  } else {
    lines.push(`${bad} problem(s), ${advisoryMissing} optional item${advisoryMissing === 1 ? '' : 's'} not present`);
  }
  return { bad, advisoryMissing, lines };
}

function cmdDoctor() {
  // Rows are 2/3/4-tuples: [label, ok, severity?, note?] where severity is
  // 'fail' (the default - the row counts toward the exit code) or
  // 'advisory' (the row never counts; the summary still reports the count
  // so a reader can tell an optional-absent row from a real failure). A
  // 2-tuple [label, ok] defaults to 'fail' so the helper rows from
  // fsChecks() keep their old behaviour unchanged.
  //
  // REQUIRED vs OPTIONAL classification (run 20261009-1105-doctor-portable
  // T1-doctor-optional): a check is OPTIONAL iff its absence does not break
  // a run. The README documents the four optional items below as such; a
  // clean-machine / fresh-CI-runner install must not be reported as broken.
  // The role skills, config.json, run store, reviewer-settings.json and the
  // milestone-store structural check are REQUIRED - a missing role skill
  // means the orchestrator cannot be activated at all, the others mean a
  // real run will misbehave. The model probe is REQUIRED for the full
  // doctor (a model that cannot tool-call makes a worker fail while
  // looking like it is working); --fast skips it on purpose.
  const checks = [];
  const cfgOk = existsSync(CONFIG);
  // A malformed config.json must fail the same way as a missing one: a
  // config the orchestrator cannot parse is exactly as broken as no config
  // at all. readJson() throws on parse error; treat that as a failure of
  // the row, not an uncaught exception that masks every later check.
  let cfgParseOk = cfgOk;
  if (cfgOk) {
    try { readJson(CONFIG); } catch { cfgParseOk = false; }
  }
  checks.push(['config.json', cfgOk && cfgParseOk]);
  checks.push(['run store', existsSync(RUNS)]);
  // File-system skill checks live in a pure helper so they can be tested
  // without Orca or a model. The six role skills are REQUIRED - without
  // them the orchestrator cannot be activated at all. The global
  // orchestration skill is OPTIONAL (the orchestrator skill has a local
  // fallback to the role skills; the global skill is a machine-level
  // extra documented in the README).
  for (const row of fsChecks({ root: ROOT, home: homedir() })) {
    if (row[0] === 'skill orchestration (global)') {
      // Reclassify as advisory so a fresh public-tree install (no global
      // skills directory under $HOME) does not report as broken. The
      // .claude/skills/fleet-orchestrator/SKILL.md row above is the real
      // activation path and remains required.
      checks.push([
        row[0] + ' (optional - the fleet-orchestrator skill is the real activation path; the global skill is a machine-level extra)',
        row[1],
        'advisory',
        'OPTIONAL per the README; the fleet-orchestrator skill (above) is the real activation path. The global orchestration skill is a machine-level extra; install it under ~/.claude/skills/orchestration/ if you want the orchestrator to use it.',
      ]);
    } else {
      checks.push(row);
    }
  }
  // Run 20261009-0015-public-repo T12-doctor-advisory-claude: a repo-root
  // CLAUDE.md is a CONVENIENCE FILE the private development checkout ships -
  // it carries repo-private instructions that are not part of the public
  // tree. The real mechanism that turns a session into the orchestrator is
  // the fleet-orchestrator skill, which fsChecks() above already asserts
  // as a real, exit-code-affecting check. Reclassify this row as advisory
  // so a contributor in a fresh public checkout does not see their install
  // reported as broken. The note text is the specific activation path so
  // a reader who sees the advisory knows what to do.
  const claudeOk = existsSync(join(ROOT, 'CLAUDE.md'));
  checks.push([
    'CLAUDE.md (advisory - private checkout convenience file; the fleet-orchestrator skill is the real dependency)',
    claudeOk,
    'advisory',
    claudeOk
      ? 'present (private checkout convenience file - loaded by Claude Code automatically)'
      : 'absent - PRIVATE checkout convenience file, not the public tree dependency; load .claude/skills/fleet-orchestrator/SKILL.md to activate the orchestrator',
  ]);
  checks.push(['reviewer-settings.json', existsSync(join(FLEET, 'reviewer-settings.json'))]);
  // The orca CLI is resolved either via ORCA_CLI_COMMAND (env override) or by
  // the same `resolveOrca()` path that orcaStatus() uses. resolveOrca() only
  // NAMES a command (it never checks the filesystem), so the check would be
  // vacuous on its own - commandResolves() makes it real by requiring the
  // resolved command to actually exist on PATH / PATHEXT (or, for
  // ORCA_CLI_COMMAND, at the path it names). The README documents orca as
  // optional ("Optionally, the orca CLI on PATH ... the default subagent
  // dispatcher does not need it"), so a missing orca CLI must be reported
  // as advisory, not a failure - the same defect class as the CLAUDE.md
  // check fixed earlier.
  const resolved = resolveOrca();
  const cliOk = commandResolves(resolved && resolved.cmd);
  checks.push([
    'orca cli on PATH or ORCA_CLI_COMMAND (optional - the default subagent dispatcher does not need it)',
    cliOk,
    'advisory',
    'OPTIONAL per the README: the default subagent dispatcher does not need orca. Install orca or set ORCA_CLI_COMMAND only if you want the isolation-grade dispatcher.',
  ]);
  // orca reachable -> also advisory for the same reason. Without orca
  // installed the command above is already absent, so this row is doubly
  // redundant on a clean machine, but it would still be wrong to fail on
  // a separate "can we talk to orca?" check that an install with orca but
  // no running app can pass.
  const st = orcaStatus();
  checks.push([
    'orca reachable (optional - orca runs the isolation-grade dispatcher; not required when it is absent)',
    !!st.ok,
    'advisory',
    'OPTIONAL per the README: orca is the isolation-grade dispatcher. A reachable orca matters only when the CLI above is also present; without orca there is nothing to be unreachable.',
  ]);
  const cfg = cfgOk && cfgParseOk ? readJson(CONFIG) : null;
  // JEV is documented as optional in the README ("JEV is optional. If it is
  // unreachable or the key is unset, every gate falls back to a full
  // orchestrator review"). The key being absent therefore MUST be advisory.
  // A fleet run with no JEV key still works; gates are just reviewed by the
  // orchestrator instead of JEV first-pass.
  checks.push([
    'JEV key set (optional - the README documents JEV as optional; missing key falls back to full orchestrator review)',
    !!(cfg && process.env[cfg.jev.api_key_env]),
    'advisory',
    'OPTIONAL per the README: "JEV is optional. If it is unreachable or the key is unset, every gate falls back to a full orchestrator review." A missing key makes JEV a no-op, not a broken install.',
  ]);
  // Run 20261008-1722-lite-track T4-doctor-milestones: enforce the milestone
  // protocol's run-store shape (milestones.json + per-row `milestone` field
  // on tasks and gates). Legacy runs are advisory, not a failure. A
  // structurally broken milestones.json is a real defect, so this row is
  // required.
  const [msOk, msDetail] = milestoneStoreCheck({ runsDir: RUNS });
  checks.push(['milestone-store ' + msDetail, msOk]);
  // A model that cannot tool-call makes a worker fail while looking like it is
  // working, so this is checked before anyone is dispatched. Skip with --fast.
  // Required: the orchestrator refuses to dispatch a worker with a model
  // that cannot actually call tools, regardless of optional tooling.
  if (!process.argv.includes("--fast")) {
    const p = probeToolCalls();
    checks.push(["model can tool-call", p.ok]);
    if (!p.ok) console.log("       " + p.note);
    if (p.model_reported) console.log("       route: " + p.model_reported);
  }

  let bad = 0;
  // The render + classify step lives in evaluateDoctorChecks() so tests can
  // exercise the wording and the bad-count logic without spawning a doctor
  // subprocess. cmdDoctor passes the rows through unchanged and uses the
  // helper's lines + bad count directly.
  const out = evaluateDoctorChecks(checks);
  for (const line of out.lines) console.log(line);
  bad = out.bad;
  if (bad) process.exitCode = 1;
}

// Five-axis scorecard (cost, time, price, quality, error rate). Pure data +
// a printer in the same style as cost/timing. --json for machine output. The
// price axis is UNPRICED unless fleet/config.json carries a model_rates map
// with at least one entry > 0 - then it never invents numbers, it sums the
// priced subset.
function cmdScore(args) {
  const id = args.find((a) => !a.startsWith('--'));
  if (!id) return console.log('usage: fleet score <run-id> [--json]');
  const dir = join(RUNS, id);
  if (!existsSync(dir)) { console.log('no such run: ' + id); process.exitCode = 1; return; }
  // Read model_rates from config; absent or all-zero -> UNPRICED axis.
  const rates = (() => { try { return JSON.parse(readFileSync(CONFIG, 'utf8')).model_rates || null; } catch { return null; } })();
  const s = scoreAxis(dir, { rates });
  if (args.includes('--json')) {
    console.log(JSON.stringify({ run: id, ...s }, null, 2));
    return;
  }
  printScore(id, s);
}

function cmdTiming(id) {
  const ids = id ? [id] : runDirs();
  if (!ids.length) return console.log('no runs');
  let tw = 0, to = 0;
  for (const r of ids) { const a = timingReport(join(RUNS, r), r);
    for (const p of (a.phases||[])) { if (p.kind==='worker') tw += p.ms; if (p.kind==='orchestrator') to += p.ms; } }
  if (ids.length > 1) {
    const pct = tw + to > 0 ? (100 * tw / (tw + to)).toFixed(0) : "n/a";
    console.log("");
    console.log("TOTAL across " + ids.length + " runs: worker " + (tw / 60000).toFixed(1)
      + " min, orchestrator " + (to / 60000).toFixed(1) + " min -> worker is " + pct + "% of measured time");
  }
}

function cmdCost() {
  const cfg = loadConfig(new URL("../config.json", import.meta.url));
  const s = todaySpend(cfg);
  const b = budgetCheck(cfg);
  console.log("COST today (weighted tokens, spec 7.4)");
  console.log("  spend             " + fmt(b.spent));
  if (b.calibrated === false) {
    console.log("  daily cap         NOT CALIBRATED - budget gate is advisory, it cannot block");
    console.log("                    (the proxy meter is not readable; set budget.daily_cap from the provider dashboard)");
  } else {
    console.log("  daily cap         " + fmt(b.cap) + "   (usable after " + cfg.budget.reserve_pct + "% reserve: " + fmt(b.usable) + ")");
    console.log("  used              " + b.pct.toFixed(1) + "%   [" + b.level + "]");
  }
  const fleet = s.bySession.filter(x => x.role);
  if (fleet.length) {
    console.log("  fleet sessions:");
    for (const x of fleet.sort((a, b2) => b2.score - a.score))
      console.log("    " + String(x.role).padEnd(10) + String(x.run || "-").padEnd(26) + fmt(x.score).padStart(14) + "  " + x.models.join(","));
  }
  const workers = fleet.reduce((a, x) => a + x.score, 0);
  if (b.spent > 0) {
    console.log("  split             workers " + (100 * workers / b.spent).toFixed(0) + "%  /  everything else " + (100 * (b.spent - workers) / b.spent).toFixed(0) + "%");
    console.log("                    note: the orchestrator is cheap in TIME and expensive in TOKENS");
    console.log("                    (cache re-sends), so optimise them differently.");
  }
}
function cmdEstimate(paths) {
  if (!paths.length) return console.log("usage: fleet estimate <path...>");
  const r = estimateRange(paths, FLEET);
  console.log("ESTIMATE (spec 7.2) - a RANGE, not a point");
  console.log("  scanned     " + r.scan.files + " files, " + r.scan.bytes.toLocaleString("en-US") + " bytes");
  console.log("  cost        " + fmt(r.range.low) + "  ..  " + (r.range.high ? fmt(r.range.high) : "?") + "   (weighted tokens)");
  console.log("  minutes     ~" + r.minutes);
  console.log("  confidence  " + r.confidence + "  (samples: " + r.observed_samples + ", observed spread: " + r.observed_spread + ")");
  console.log("  dominant    " + r.dominant_term);
  if (r.caveat) console.log("  caveat      " + r.caveat);
}
function cmdResume(args) {
  const id = args[0];
  if (!id) return console.log("usage: fleet resume <run-id> [--takeover]");
  const dir = join(RUNS, id);
  if (!existsSync(dir)) return console.log("no such run: " + id);
  const takeover = args.includes("--takeover");
  const session = "sess_" + Date.now().toString(36);
  const got = acquire(dir, session, { takeover });
  if (!got.ok) {
    console.log("REFUSED: lease held by " + got.holder + " for another " + Math.round(got.expires_in_ms / 60000) + " min");
    console.log("  another orchestrator may be alive. Re-run with --takeover only if you know it is dead.");
    return;
  }
  console.log("lease acquired by " + session + (got.took_over ? "  (TOOK OVER an existing lease)" : ""));
  const run = safeRun(id);
  const r = reconcile(dir, run?.orca_run || "unknown");
  console.log("RUN " + id + "  status=" + (run?.status || "?"));
  if (!r.ok) { console.log("  reconcile failed: " + r.reason + " - do not improvise, report and stop (spec 16.4)"); release(dir, session); return; }
  console.log("  intended dispatches " + r.intended + " | live terminals " + r.live);
  if (r.orphans.length) console.log("  ORPHANS (live, unrecorded): " + r.orphans.join(", "));
  if (r.missing.length) console.log("  MISSING (recorded, not live): " + r.missing.join(", "));
  console.log("  next: " + r.next_action);
}
function safeRun(id) { try { return readJson(join(RUNS, id, 'run.json')); } catch { return null; } }

// doc-check / doc-gap back the project-doc template (see
// fleet/templates/project-doc.template.html + fleet/bin/lib/project-doc.mjs).
// doc-check validates the static HTML and its claim evidence pointers; doc-gap
// reads a review.json produced by a human reviewer and emits the gap report
// markdown. Both exit 0 on a clean run and exit 1 on errors - doc-gap never
// errors on review content (an invalid verdict is reported, not fatal).
function cmdDocCheck(args) {
  const positional = args.filter(a => !a.startsWith('--'));
  const rootArg = (args.find(a => a.startsWith('--root=')) || '').slice('--root='.length);
  const rootIdx = args.indexOf('--root');
  const root2 = rootIdx !== -1 ? args[rootIdx + 1] : '';
  const html = positional[0];
  const root = rootArg || root2;
  if (!html) return console.log('usage: fleet doc-check <html> [--root <dir>]');
  const abs = resolve(html);
  if (!existsSync(abs)) { console.log('no such file: ' + html); process.exitCode = 1; return; }
  let text;
  try { text = readFileSync(abs, 'utf8'); }
  catch (e) { console.log('read failed: ' + (e?.message || e)); process.exitCode = 1; return; }
  const r = validateDoc(text, root ? { root: resolve(root) } : {});
  for (const w of r.warnings) console.log('warning: ' + w);
  for (const e of r.errors) console.log('error:   ' + e);
  if (r.errors.length) {
    console.log(`\n${r.errors.length} error(s), ${r.warnings.length} warning(s)`);
    process.exitCode = 1;
    return;
  }
  console.log(`ok (${r.warnings.length} warning(s))`);
}
function cmdDocGap(args) {
  const positional = args.filter(a => !a.startsWith('--'));
  const html = positional[0];
  const reviewPath = positional[1];
  if (!html || !reviewPath) return console.log('usage: fleet doc-gap <html> <review.json>');
  const htmlAbs = resolve(html);
  const revAbs = resolve(reviewPath);
  if (!existsSync(htmlAbs)) { console.log('no such file: ' + html); process.exitCode = 1; return; }
  if (!existsSync(revAbs)) { console.log('no such file: ' + reviewPath); process.exitCode = 1; return; }
  let htmlText, revText;
  try { htmlText = readFileSync(htmlAbs, 'utf8'); }
  catch (e) { console.log('read failed: ' + (e?.message || e)); process.exitCode = 1; return; }
  try { revText = readFileSync(revAbs, 'utf8'); }
  catch (e) { console.log('read failed: ' + (e?.message || e)); process.exitCode = 1; return; }
  let review;
  try { review = JSON.parse(revText); }
  catch (e) { console.log('review.json invalid JSON: ' + (e?.message || e)); process.exitCode = 1; return; }
  const claims = extractClaims(htmlText);
  const report = gapReport(claims, review);
  console.log(formatGapReport(report));
}

// T7-router-wiring: `fleet route "<task text>"` - one JEV skill-routing decision
// on ONE JSON line. Uses exactly the SKILL.md 5c recipe (skillCatalog ->
// buildRouteQuestions -> route with askFromConfig -> routeDecision with
// routingConfig), so the CLI and the doc cannot drift apart. Escalation is a
// VALID answer (exit 0 - the orchestrator picks the worker); only a degraded
// call is a failure (exit 2). --multi adds the per-skill nouls so multi is
// computed; without it multi stays uncalibrated.
async function cmdRoute(args) {
  const multi = args.includes("--multi");
  const task = args.filter(a => !a.startsWith("--")).join(" ").trim();
  if (!task) return console.log('usage: fleet route "<task text>" [--multi]');
  try {
    const cfg = loadFleetConfig(CONFIG);
    const catalog = skillCatalog({ dirs: [join(ROOT, '.claude', 'skills'), join(homedir(), '.claude', 'skills')] });
    if (!Object.keys(catalog).length) {
      console.log(JSON.stringify({ pick: null, prob: null, decided_by: 'escalate', branch: 'no-skills', multi: null, fingerprint: null, model: null }));
      return;
    }
    const questions = buildRouteQuestions({
      id: 'route',
      instructions: 'Which single skill should the worker load to do this task? Judge from the skill descriptions.',
      options: catalog,
      multi,
    });
    const r = await route({ state: { task }, questions, ask: askFromConfig(cfg) });
    if (r.raw.degraded || !r.raw.ok) {
      // Degraded (no provider reached) is the only failure: exit 2. A fatal auth
      // error stops the run loudly, same policy as jev.mjs.
      console.log(JSON.stringify({
        pick: null, prob: null, decided_by: r.raw.fatal ? 'fatal' : 'degraded',
        branch: r.raw.reason, detail: r.raw.detail ?? null, tried: r.raw.tried ?? undefined,
        multi: null, fingerprint: r.fingerprint, model: r.raw.model ?? null,
      }));
      process.exitCode = 2;
      return;
    }
    const d = routeDecision(r.raw.answers, { ...routingConfig(cfg), options: catalog });
    const ch = r.raw.answers.route;
    const top3 = Object.entries(ch?.probabilities ?? {})
      .sort((a, b) => b[1] - a[1]).slice(0, 3)
      .map(([name, p]) => ({ name, prob: p }));
    console.log(JSON.stringify({
      pick: d.pick, prob: d.prob, decided_by: d.decided_by, branch: d.branch,
      multi: d.multi, multiNote: d.multiNote, top3, fingerprint: r.fingerprint,
      model: r.raw.model, provider: r.raw.provider,
    }));
  } catch (err) {
    // A config/catalog bug must fail loudly, not masquerade as an escalation.
    console.log(JSON.stringify({ pick: null, prob: null, decided_by: 'error', branch: String(err?.message || err) }));
    process.exitCode = 2;
  }
}

// T3-doc-drift: compare every citation in a project-doc HTML against a base
// commit and report which lines have drifted, moved, or vanished. Exits 1
// when any claim is moved or gone (doc-check only catches blank-line hits;
// this catches the dangerous "wrong line" case - 61 inserted lines broke 56
// of 65 citations earlier this week and doc-check stayed green).
async function cmdDocDrift(args) {
  const code = await docDriftCli(args);
  if (code) process.exitCode = code;
}
const [cmd, ...rest] = process.argv.slice(2);
const help = [
  'fleet <command>',
  '  status             orca + fleet state (flags reclaimable terminals)',
  '  status --json      same data as one JSON object to stdout',
  '  settle             release every reclaimable worker (hard rule 2)',
  '  runs               list runs',
  '  report <run-id>    gate verdicts + summary',
  '  timing [run-id]    where the time went (worker vs orchestrator)',
  '  score <run-id>     five-axis scorecard (cost, time, price, quality, error rate); --json for machine output',
  '  cost               today spend vs the daily cap',
  '  estimate <path..>  pre-flight cost RANGE for a set of paths',
  '  route "<task>"     JEV skill-routing decision (one JSON line; exit 2 only if degraded)',
  '  resume <run-id>    take the lease and reconcile state',
  '  doctor             check the install',
  '  doc-check <html> [--root <dir>]  validate a project-doc HTML and its evidence pointers',
  '  doc-gap <html> <review.json>     human-vs-AI gap report (markdown)',
  '  doc-drift <doc.html> <base-sha> [--json] [--fix]  drift between a doc\'s citations and <base-sha> (exit 1 on moved/gone)',
].join('\n');
const cmds = {
  status: () => cmdStatus(rest), runs: cmdRuns, doctor: cmdDoctor, settle: cmdSettle,
  report: () => cmdReport(rest[0]),
  timing: () => cmdTiming(rest[0]),
  score: () => cmdScore(rest),
  cost: cmdCost,
  estimate: () => cmdEstimate(rest),
  route: () => cmdRoute(rest),
  resume: () => cmdResume(rest),
  'doc-check': () => cmdDocCheck(rest),
  'doc-gap': () => cmdDocGap(rest),
  'doc-drift': () => cmdDocDrift(rest),
};
// Only run a command when this file is the entry point. Being imported by a
// test must not dump the help banner into the test process.
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isMain) (cmds[cmd] || (() => console.log(help)))();
