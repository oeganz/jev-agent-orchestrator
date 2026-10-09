// Fleet monitor — a live graph of every agent Orca knows about.
//
// Polls the Orca CLI for terminals, joins them with subagent transcripts and the
// fleet run store, folds them into one node/edge graph, and pushes it to every
// connected client over a raw RFC 6455 WebSocket. Zero dependencies, same
// framing as fleet/bin/lib/dashboard-server.mjs.
//
//   node monitor/server.mjs            -> http://localhost:8790
//   MONITOR_PORT=9000 node monitor/server.mjs
//
// Sources, all verified on this machine 2026-10-07:
//   orca terminal list --json                 -> session nodes (badge 'orca')
//   orca orchestration worker-list --json     -> only for tasks.jsonl join (never liveness)
//   fleet/runs/*/tasks.jsonl                  -> subagent label and role via agent_id
//   ~/.claude/projects/<munged>/<sid>.jsonl   -> session nodes (badge 'claude') + subagent dirs
//   ~/.claude/projects/<munged>/<sid>/subagents/agent-*.jsonl
//                                           -> agent nodes (badge 'subagent')
//   GET :8080/health                           -> the ZenoA agent node
//
// The server is importable. snapshot() is pure (synthetic inputs in -> graph
// out). collect() does IO (calls orca(), reads fs, hits /health) and feeds
// snapshot(). The HTTP server binds only when this file is run as the program
// entry, so `node --test monitor/server.test.mjs` and
// `node -e "import('./monitor/server.mjs')"` never hold a port.
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync, openSync, closeSync, readSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname, basename, extname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { extractActivity, terminalActivity } from './activity.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ORCA_BIN = process.env.ORCA_BIN
  || process.env.ORCA_CLI
  || join(homedir(), 'AppData', 'Local', 'Programs', 'orca', 'resources', 'bin', 'orca.exe');
const ORCA = ORCA_BIN;
const PORT = parseInt(process.env.MONITOR_PORT || '8790', 10);
const POLL_MS = parseInt(process.env.MONITOR_POLL_MS || '2500', 10);
const HERMES_URL = process.env.HERMES_URL || 'http://127.0.0.1:8080';
// The fleet run store. It holds what Orca does not: the task id and role behind
// each subagent (Orca only knows terminals), and the gate verdicts.
const FLEET_DIR = process.env.FLEET_DIR || join(HERE, '..', 'fleet');
const FLEET_RUNS = join(FLEET_DIR, 'runs');
// Claude sessions, heard not hooked: the harness appends to every session's
// transcript on every turn, so the file system IS the event stream.
const CLAUDE_PROJECTS = process.env.CLAUDE_PROJECTS
  || join(process.env.USERPROFILE || process.env.HOME || '', '.claude', 'projects');
const SESSION_TTL_MS = parseInt(process.env.SESSION_TTL_MS || String(2 * 60 * 60 * 1000), 10);

// ---- frozen data model (exported) ----
export const ACTIVE_MS = 3 * 60 * 1000;             // "working now"
export const CONTAINER_STATE = 'container';          // folder + branch nodes only
export const STATE_ORDER = ['active', 'idle', 'monitoring']; // living states only
export const NODE_KINDS = Object.freeze({
  folder: 'folder', branch: 'branch', session: 'session', agent: 'agent', hermes: 'hermes',
});
export const EDGE_KINDS = Object.freeze({
  tree:   'tree',
  spawn:  'spawn',
  member: 'member',
});

// Provider labels: which agent product a terminal belongs to (claude,
// antigravity, codex, ...). Orca terminal list items carry `agentIdentity`.
// We map the raw lowercase value to a capitalised display name. A terminal
// without agentIdentity renders as 'unknown'. The lowercase id is what
// travels in the `provider` field; the UI looks the logo up by id and the
// label is read off `data.label`.
const PROVIDER_LABELS = Object.freeze({
  claude:      'Claude',
  antigravity: 'Antigravity',
  codex:       'Codex',
  cursor:      'Cursor',
  gemini:      'Gemini',
  kilocode:    'Kilocode',
  minimax:     'Minimax',
  openai:      'OpenAI',
  opencode:    'OpenCode',
  anthropic:   'Anthropic',
  hermes:      'Hermes',
});

// Return the provider id for a live terminal (lowercased agentIdentity),
// or 'unknown' when the field is missing/empty. FROZEN contract: never
// returns null/undefined.
export function providerOf(terminal) {
  const id = String((terminal && terminal.agentIdentity) || '').trim().toLowerCase();
  return id || 'unknown';
}

// Capitalised display name for a provider id, or 'Unknown' for unknowns.
export function providerLabel(id) {
  return PROVIDER_LABELS[String(id || '').toLowerCase()] || 'Unknown';
}

// Harness self-test probe: transcripts whose first real user prompt asks
// Claude Code to run a literal `echo PROBE<hex>` command. These are
// one-turn throwaway self-tests emitted by the harness; they should never
// become nodes on the monitor. The label reader already pulls the first
// real prompt off the transcript head, so callers pass that string in —
// no extra file read.
export const PROBE_PROMPT_RE = /^Using your Bash tool, run exactly this command:\s*echo PROBE[0-9A-F]{6}/i;
export function isHarnessProbe(firstPrompt) {
  if (!firstPrompt) return false;
  return PROBE_PROMPT_RE.test(String(firstPrompt));
}

// ---- helpers ----

// folderOf(mungedOrRealPath): { folder: <absolute repo path>, branch: <string|null> }
// Two rules per amendments A7:
//   1. <repo>--claude-worktrees-agent-<id>   -> folder = repo, branch = "agent-<id>"
//   2. <repo>\\.claude\\worktrees\\<id>      -> folder = repo, branch = <id>
//   3. otherwise                              -> folder = the path itself, branch = null
// The returned `folder` is always normalised: backslashes, upper-case drive
// letter, no trailing separator. Same directory from different sources
// (Orca `worktreePath` with forward slashes vs. transcript `cwd` with
// backslashes vs. a munged-dir fallback) collapses to one folder node.
export function folderOf(p) {
  if (!p) return { folder: '', branch: null };
  let s = String(p);
  // rule 1: munged form <repo>--claude-worktrees-agent-<id>
  let m = s.match(/^(.*?)--claude-worktrees-(.+)$/);
  if (m) {
    const repo = m[1];
    const tail = m[2];
    const branch = /^agent-(.+)$/.test(tail) ? tail : tail;
    return { folder: normFolder(mungeUnmung(repo)), branch };
  }
  // rule 2: real path <repo>\.claude\worktrees\<id>
  m = s.match(/^(.*?)[\\/]\.claude[\\/]worktrees[\\/]([^\\/]+)$/);
  if (m) return { folder: normFolder(m[1]), branch: m[2] };
  return { folder: normFolder(s), branch: null };
}

// Normalise an absolute path: forward slashes -> backslashes, drive letter
// upper-case, no trailing separator. Defect 2 fix: a folder coming from
// Orca's `worktreePath` ('C:/X/Repo') and the same folder from a transcript's
// `cwd` ('C:\\X\\Repo') now compare equal as `folder` values.
function normFolder(p) {
  if (!p) return '';
  let s = String(p);
  s = s.replace(/\//g, '\\');
  s = s.replace(/^([a-z]):/, (_, c) => c.toUpperCase() + ':');
  s = s.replace(/[\\]+$/, '');
  return s;
}

// Inverse of Claude's munging. The munged form replaces each path separator
// (`\` or `/`) with `--`, AND replaces every `-` inside a segment with `-`
// (lossy). On this machine every observed munged name uses single `-`
// between words and `--` between segments; the canonical conversion that
// produces the expected absolute path is to expand every `-` to `\` (lossy
// but predictable for the cases we care about).
//
// Example: "C--AI-<vault>-Agent-Orchestrator" -> "C:\AI\<vault>\Agent\Orchestrator"
//          "C--Users-<user>-orca-workspaces-<client>-tools-<project>-<n>"
//                                       -> "C:\Users\<user>\orca\workspaces\<client>\tools\<project>\<n>"
function mungeUnmung(munged) {
  if (!munged) return '';
  let s = munged;
  // Drive letter prefix: "C--" -> "C:\"
  s = s.replace(/^([A-Z])--/, '$1:\\');
  // the rest are path separators (lossy)
  s = s.replace(/-/g, '\\');
  return s;
}

// Two terminals sharing folder+branch are NOT merged unless titles match.
// A transcript + terminal sharing folder+branch AND stripped-title are the
// SAME process (one node, badge 'orca', carrying sessionId and terminal).
function stripTitleGlyph(t) {
  return String(t || '').replace(/^[◐◑◒◓✳✻✢]/, '').trim();
}

// True when the folder/branch pair of a terminal matches a transcript's
// real path + gitBranch and titles align. We require both conditions:
// identicals would need an exact key.
function titleMatch(terminal, transcriptTitle) {
  const t = stripTitleGlyph(terminal && terminal.title);
  return t && transcriptTitle && t === transcriptTitle;
}

function readJsonl(path) {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8').split(/\r?\n/).filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean);
}

// Cache meta.json and titles by (path, size). Avoids re-reading a 5MB transcript
// every poll. The cache lives for the lifetime of the process; a hit is exact.
const metaCache = new Map();    // key: path -> { size, parsed|null }
const titlesCache = new Map();  // key: path -> { size, aiTitle, firstPrompt }

function getMeta(path) {
  let st;
  try { st = statSync(path); } catch { return null; }
  const size = st.size;
  const k = path + '|' + size;
  const cached = metaCache.get(k);
  if (cached !== undefined) return cached;
  let parsed = null;
  try { parsed = JSON.parse(readFileSync(path, 'utf8')); } catch { /* ignore */ }
  metaCache.set(k, parsed);
  return parsed;
}

// Cap on how many bytes we scan from the head for the first real user prompt.
// A short cap was the T3 D1 defect: two live sessions (df2da31b, f0ba63f2) had
// their first usable prompt ~13 KB into a transcript full of attachments, so
// an 8KB cap missed it and the label fell back to "session <sid8>". We now scan
// up to 256 KB or until a usable prompt is found, whichever comes first.
const LABEL_HEAD_MAX = 256 * 1024;

// Read the LAST ai-title from a transcript, then fall back to the first real
// user prompt. Returns { aiTitle, firstPrompt }. Cached by (path, size).
// Head scan: up to 256 KB looking for the first non-A5-skipped user prompt.
// Tail scan: last 64 KB for the LATEST ai-title. A 30 MB transcript therefore
// costs ~256 KB + 64 KB per cold read, ~320 KB - still a fraction of the file
// and cached by (path, size) so the 2.5 s poll re-uses it.
function readLabels(path) {
  let st;
  try { st = statSync(path); } catch { return { aiTitle: '', firstPrompt: '' }; }
  const size = st.size;
  const k = path + '|' + size;
  const cached = titlesCache.get(k);
  if (cached !== undefined) return cached;
  let aiTitle = '';
  let firstPrompt = '';
  try {
    const head = readFileBytes(path, LABEL_HEAD_MAX);
    if (head) {
      const lines = head.toString('utf8').split(/\r?\n/);
      for (const line of lines) {
        if (!line.trim()) continue;
        let o; try { o = JSON.parse(line); } catch { continue; }
        if (o.type !== 'user' || !o.message) continue;
        const c = o.message.content;
        const t = typeof c === 'string' ? c
          : Array.isArray(c) ? c.filter((p) => p && p.type === 'text').map((p) => p.text).join(' ') : '';
        let s = (t || '').replace(/\s+/g, ' ').trim();
        if (s.length < 12) continue;
        // Per amendment A5: skip candidate prompts that start with '<', '/',
        // 'claude ' or '[Request interrupted'. f0ba63f2's first prompt is
        // "claude --resume ..." which must NOT become the label; the next
        // prompt is the real one.
        if (/^(<|\/|claude |\[Request interrupted)/.test(s)) continue;
        firstPrompt = s.slice(0, 64);
        break;
      }
    }
    const tail = readFileTail(path, 65536);
    if (tail) {
      const lines = tail.toString('utf8').split(/\r?\n/);
      for (let i = lines.length - 1; i >= 0; i--) {
        if (!lines[i].trim()) continue;
        try {
          const o = JSON.parse(lines[i]);
          if (o && o.type === 'ai-title' && o.aiTitle) { aiTitle = String(o.aiTitle); break; }
        } catch { /* ignore */ }
      }
    }
  } catch { /* unreadable */ }
  const out = { aiTitle, firstPrompt };
  titlesCache.set(k, out);
  return out;
}

// Read the cwd/gitBranch/branch fields from the first user or attachment line
// that carries them. Returns { cwd, gitBranch }. We only need the head of the
// file: cwd appears on the first user/attachment line, so 8KB is plenty.
function readTranscriptCtx(path) {
  try {
    const buf = readFileBytes(path, 8192);
    if (!buf) return { cwd: '', gitBranch: '' };
    const text = buf.toString('utf8');
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim()) continue;
      let o; try { o = JSON.parse(line); } catch { continue; }
      if (o && (o.cwd || o.gitBranch)) return { cwd: o.cwd || '', gitBranch: o.gitBranch || '' };
    }
  } catch { /* unreadable */ }
  return { cwd: '', gitBranch: '' };
}

// Read at most `n` bytes from the head of a file. Returns a Buffer or null.
function readFileBytes(path, n) {
  try {
    const st = statSync(path);
    if (st.size <= n) return readFileSync(path);
    const fh = openSync(path, 'r');
    try {
      const buf = Buffer.alloc(n);
      readSync(fh, buf, 0, n, 0);
      return buf;
    } finally { closeSync(fh); }
  } catch { return null; }
}

// Read the last `n` bytes of a file (looking for ai-title). Buffer-friendly.
function readFileTail(path, n) {
  try {
    const st = statSync(path);
    const start = Math.max(0, st.size - n);
    const len = st.size - start;
    const fh = openSync(path, 'r');
    try {
      const buf = Buffer.alloc(len);
      readSync(fh, buf, 0, len, start);
      return buf;
    } finally { closeSync(fh); }
  } catch { return null; }
}

// Read the latest <task-id><agentId></task-id> <status>X</status> from the
// parent transcript. Returns the set of agent ids the parent has already
// acknowledged as completed/failed/killed. The parent transcript can be very
// long (a 4+ MB orchestrator session), so a 128 KB tail misses the
// notifications for subagents that finished early. We scan the whole file
// but incrementally: per-path cache holds the file size and a
// id->latestStatus map; on each call we re-read only the bytes appended
// since the cached size (plus a 4 KB overlap to keep line boundaries safe).
// A shrunk file (rotation) triggers a full re-scan.
const COMPLETED_OVERLAP_BYTES = 4096;
const completedCache = new Map(); // path -> { size, latest: Map<id,status> }

function readCompletedAgents(path) {
  let st;
  try { st = statSync(path); } catch { return new Set(); }
  const size = st.size;
  const cached = completedCache.get(path);
  let latest;
  let scanFrom = 0;
  if (cached && cached.size === size) {
    // no change: just rebuild the done set from the cached latest map
    return doneFromLatest(cached.latest);
  }
  if (cached && cached.size < size) {
    // grew: keep the cached latest map, re-read from size-OVERLAP
    latest = new Map(cached.latest);
    scanFrom = Math.max(0, cached.size - COMPLETED_OVERLAP_BYTES);
  } else {
    // cold or shrunk: scan from 0
    latest = new Map();
  }
  const fh = openSync(path, 'r');
  try {
    const len = size - scanFrom;
    const buf = Buffer.alloc(len);
    readSync(fh, buf, 0, len, scanFrom);
    let text = buf.toString('utf8');
    // Skip a partial first line (the overlap may have started mid-line): the
    // regex needs the opening <task-id> tag, which would be in the previous
    // read. Move past the first newline so the scan starts on a whole line.
    if (scanFrom > 0) {
      const nl = text.indexOf('\n');
      if (nl >= 0 && nl < text.length - 1) text = text.slice(nl + 1);
    }
    for (const m of text.matchAll(/<task-id>([^<]+)<\/task-id>[\s\S]*?<status>([^<]+)<\/status>/g)) {
      latest.set(m[1], m[2]);
    }
  } catch { /* ignore */ } finally { closeSync(fh); }
  completedCache.set(path, { size, latest });
  return doneFromLatest(latest);
}

function doneFromLatest(latest) {
  const done = new Set();
  for (const [id, st] of latest) {
    if (st === 'completed' || st === 'failed' || st === 'killed') done.add(id);
  }
  return done;
}

// Read the last assistant message.model for an agent transcript (real model).
// Tail-only — model field is on assistant lines and we just need the latest.
function readLastModel(path) {
  try {
    const tail = readFileTail(path, 32768);
    if (!tail) return '';
    const lines = tail.toString('utf8').split(/\r?\n/);
    for (let i = lines.length - 1; i >= 0; i--) {
      if (!lines[i].trim()) continue;
      let o; try { o = JSON.parse(lines[i]); } catch { continue; }
      if (o && o.type === 'assistant' && o.message && o.message.model) return o.message.model;
    }
  } catch { /* ignore */ }
  return '';
}

// Cached tail-line reader for the activity bubble (T1-activity-extractor).
// Keyed by path+size — same pattern as metaCache / titlesCache — so each
// 2.5 s poll re-uses the parsed tail until the transcript grows (size bumps
// the key). Privacy: only assistant text / tool_use summaries are surfaced
// downstream; tool_result blocks and command output are never read into the
// shape.
const ACTIVITY_TAIL_BYTES = 65536;
const activityCache = new Map(); // key: path|size -> parsed lines[]

function readActivityTail(path) {
  let st;
  try { st = statSync(path); } catch { return []; }
  const size = st.size;
  const key = path + '|' + size;
  const cached = activityCache.get(key);
  if (cached) return cached;
  const tail = readFileTail(path, ACTIVITY_TAIL_BYTES);
  if (!tail) {
    activityCache.set(key, []);
    return [];
  }
  const lines = tail.toString('utf8').split(/\r?\n/);
  const parsed = [];
  for (const line of lines) {
    if (!line || !line.trim()) continue;
    let o;
    try { o = JSON.parse(line); } catch { continue; }
    parsed.push(o);
  }
  activityCache.set(key, parsed);
  return parsed;
}

// --- IO ---

function orca(args) {
  return new Promise((resolve) => {
    execFile(ORCA, args, { timeout: 9000, maxBuffer: 16 * 1024 * 1024, windowsHide: true },
      (_err, stdout) => {
        if (!stdout) return resolve(null);
        try {
          const j = JSON.parse(stdout);
          resolve(j && j.ok ? j.result : null);
        } catch { resolve(null); }
      });
  });
}

// Every task across every fleet run, each tagged with the run dir.
function readFleetTasks(fleetRuns) {
  if (!fleetRuns || !existsSync(fleetRuns)) return [];
  const out = [];
  for (const d of readdirSync(fleetRuns, { withFileTypes: true })) {
    if (!d.isDirectory()) continue;
    const dir = join(fleetRuns, d.name);
    for (const t of readJsonl(join(dir, 'tasks.jsonl'))) out.push({ ...t, runDir: d.name });
  }
  return out;
}

// worker-list is a role/task join, NOT a liveness source (verified
// 2026-10-07). We use it only to join tasks.jsonl rows to live terminals via
// agentTerminalHandle / dispatchId; never to decide whether a node is alive.
function readWorkers(fleetRuns) {
  return readFleetTasks(fleetRuns);
}

async function hermesAlive() {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 1200);
    const r = await fetch(HERMES_URL + '/health', { signal: ctrl.signal });
    clearTimeout(t);
    return r.ok;
  } catch { return false; }
}

// ---- pure snapshot ----

// Scan transcripts (sessions + subagents) into raw rows. The browser of the
// project tree: every project dir's <sid>.jsonl is a session; every
// <sid>/subagents/agent-<agent-id>.jsonl is a subagent; .meta.json carries
// description/model/parentAgentId/spawnDepth. mtime is the liveness clock.
//
// Performance: TTL filter happens before any read (cwd/gitBranch, meta, etc.),
// so the cold-cache path never touches stale transcripts.
export function scanTranscripts(now, projectsDir) {
  if (!projectsDir || !existsSync(projectsDir)) return { sessions: [], agents: [], completedByParent: {} };
  const sessions = [];
  const agents = [];
  const completedByParent = {};
  let projects;
  try { projects = readdirSync(projectsDir, { withFileTypes: true }); } catch { return { sessions: [], agents: [], completedByParent: {} }; }
  for (const p of projects) {
    if (!p.isDirectory()) continue;
    const dir = join(projectsDir, p.name);
    let files;
    try { files = readdirSync(dir); } catch { continue; }
    for (const f of files) {
      if (!f.endsWith('.jsonl')) continue;
      const path = join(dir, f);
      let st; try { st = statSync(path); } catch { continue; }
      if (now - st.mtimeMs > SESSION_TTL_MS) continue; // skip stale sessions
      const sid = basename(f, '.jsonl');
      const ctx = readTranscriptCtx(path);
      sessions.push({
        id: 'session:' + sid,
        sid, proj: p.name, path, mtime: st.mtimeMs,
        cwd: ctx.cwd, gitBranch: ctx.gitBranch,
      });
      // subagents in <sid>/subagents/
      const saDir = join(dir, sid, 'subagents');
      if (existsSync(saDir)) {
        try {
          const saf = readdirSync(saDir);
          for (const saf1 of saf) {
            if (!saf1.endsWith('.jsonl') || !saf1.startsWith('agent-')) continue;
            const agentId = saf1.replace(/^agent-/, '').replace(/\.jsonl$/, '');
            const saPath = join(saDir, saf1);
            const metaPath = join(saDir, saf1.replace(/\.jsonl$/, '.meta.json'));
            let saSt; try { saSt = statSync(saPath); } catch { continue; }
            // Only enumerate subagents within TTL — saves reading meta.json
            // for the long tail of completed-for-weeks subagents.
            if (now - saSt.mtimeMs > SESSION_TTL_MS) continue;
            const meta = getMeta(metaPath) || {};
            agents.push({
              id: 'agent:sub:' + agentId,
              agentId,
              parentSid: sid,
              parentAgentId: meta.parentAgentId || null,
              spawnDepth: meta.spawnDepth || 1,
              path: saPath, mtime: saSt.mtimeMs,
              meta,
            });
          }
        } catch { /* ignore */ }
        // completed-by-parent map: agent ids the parent has acknowledged.
        // Only relevant for sessions that have subagents within TTL.
        const done = readCompletedAgents(path);
        if (done.size) completedByParent[sid] = done;
      }
    }
  }
  return { sessions, agents, completedByParent };
}

// classifyState for living nodes (NOT containers).
// Inputs: mtime (last touch), ttl age, child-active count, ttl window.
export function classifyState({ now, mtime, ttlMs, hasActiveChild }) {
  if (mtime && now - mtime < ACTIVE_MS) return 'active';
  if (mtime && now - mtime < ttlMs) return hasActiveChild ? 'monitoring' : 'idle';
  return 'hidden'; // caller treats hidden as "do not include"
}

// ---- snapshot ----

export function snapshot(opts = {}) {
  const { now = Date.now(), projectsDir = CLAUDE_PROJECTS, fleetRuns = FLEET_RUNS, terminals = [], workers = [], hermesOnline = false, tasks: tasksOpt, scan: preScan } = opts;
  // If the caller pre-computed a scan (collect() does, for performance), use it;
  // otherwise run scanTranscripts synchronously here.
  const scan = preScan || scanTranscripts(now, projectsDir);
  // If the caller passed tasks, use them; otherwise load from fleetRuns. This
  // lets collect() run readFleetTasks in parallel with the Orca CLI.
  const tasks = tasksOpt || readFleetTasks(fleetRuns);
  return buildGraph({ now, scan, terminals, tasks, workers, hermesOnline });
}

// Pure post-scan graph builder. Tests and `collect()` route through here.
// steps 2-15 of the old monolithic snapshot() live here; step 1 (scan) is the
// caller's responsibility now, so collect() can parallelise it with the
// Orca CLI call.
function buildGraph({ now, scan, terminals, tasks, workers, hermesOnline }) {
  const completedByParent = scan.completedByParent;

  // 2) index tasks by agent_id and by terminal
  const taskByAgentId = new Map();
  const taskByTerminal = new Map();
  for (const t of tasks || []) {
    if (t.agent_id) taskByAgentId.set(t.agent_id, t);
    if (t.terminal) taskByTerminal.set(t.terminal, t);
  }
  // workers (from orca worker-list) is a role/task join only; fold into taskByAgentId/taskByTerminal via their dispatch
  for (const w of workers || []) {
    if (w.agentTerminalHandle && taskByTerminal.has(w.agentTerminalHandle)) continue;
    // workers carry agentTerminalHandle and may also carry dispatchId -> row in tasks.jsonl has dispatch
    if (w.dispatchId) {
      const t = (tasks || []).find((x) => x.dispatch === w.dispatchId);
      if (t && t.terminal) taskByTerminal.set(t.terminal, t);
    }
  }

  // 3) determine folders. Per amendment A7: folders are FLAT, no nesting, no
  // folder:root. folder = the cwd with `.claude\worktrees\<x>` suffix stripped.
  // For terminals, folder = worktreePath (folded).
  const nodes = new Map();

  const folderKey = (absPath) => {
    const f = folderOf(absPath);
    return f.folder;
  };
  // id stability: encode the absolute folder in a stable slug. Windows drive
  // letters and backslashes/forward-slashes -> '-'.
  const folderSlug = (absPath) => {
    if (!absPath) return 'unknown';
    return String(absPath).replace(/[\\:]/g, '-').replace(/\//g, '-').toLowerCase();
  };
  // branch id: folderSlug@branch
  const branchId = (absPath, branch) => 'branch:' + folderSlug(absPath) + '@' + (branch || 'detached');

  const ensureFolderBranch = (absPath, branch) => {
    const fo = folderOf(absPath);
    const fid = 'folder:' + folderSlug(fo.folder);
    if (!nodes.has(fid)) {
      nodes.set(fid, {
        id: fid, kind: NODE_KINDS.folder, label: basename(fo.folder) || fo.folder || 'folder',
        sub: fo.folder, state: CONTAINER_STATE, folder: fo.folder, branch: null,
      });
    }
    let bid = null;
    if (branch) {
      bid = branchId(fo.folder, branch);
      if (!nodes.has(bid)) {
        nodes.set(bid, {
          id: bid, kind: NODE_KINDS.branch, label: branch,
          sub: fo.folder, state: CONTAINER_STATE, folder: fo.folder, branch,
          parent: fid,
        });
      }
    }
    return { folderId: fid, branchId: bid, absFolder: fo.folder, branch };
  };

  // 4) Build session nodes from terminals (badge 'orca') AND from
  // transcripts (badge 'claude'). Dedupe per amendment A4: when terminal
  // (stripped title) matches transcript latest aiTitle AND they share
  // folder+branch, ONE node with both badges.
  // Pre-load labels only for sessions within SESSION_TTL_MS; stale ones are
  // hidden anyway and we never read their transcripts. cwd/gitBranch come
  // from the session row (already populated by scanTranscripts).
  const transcriptLabel = new Map();
  // T1-activity-extractor: also pre-load the activity bubble data once per
  // session (cached by path+size in readActivityTail). A merged session
  // (transcript+terminal) and a transcript-only session over the same path
  // share the same cache entry, so there is no extra read at step 6.
  const transcriptActivity = new Map();
  for (const s of scan.sessions) {
    if (now - s.mtime > SESSION_TTL_MS) continue;
    const labels = readLabels(s.path);
    transcriptLabel.set(s.sid, {
      aiTitle: labels.aiTitle,
      firstPrompt: labels.firstPrompt,
      cwd: s.cwd, gitBranch: s.gitBranch,
    });
    const a = extractActivity(readActivityTail(s.path), { now });
    if (a) transcriptActivity.set(s.sid, a);
  }

  // 5) Sessions from terminals. Only live (connected && !orphaned).
  const liveTerminals = (terminals || []).filter((t) => t && t.connected && !t.orphaned);
  // Provider de-dup counter: per (folder, branch, provider) how many terminals
  // we've placed so far. When a non-claude provider's second+ terminal lands
  // in the same folder/branch, we append a disambiguator to its product label
  // so the two cards stay readable in the canvas.
  const providerCountByPair = new Map();
  const providerDupKey = (folder, branch, provider) =>
    String(folder || '').toLowerCase() + '|' + String(branch || '') + '|' + String(provider || '');
  // Build a quick index: per (folder|branch) -> terminals (for dedupe).
  const termByPair = new Map();
  for (const t of liveTerminals) {
    const fo = folderOf(t.worktreePath || '');
    const branch = (t.branch || '').replace(/^refs\/heads\//, '');
    const key = folderSlug(fo.folder) + '|' + branch;
    if (!termByPair.has(key)) termByPair.set(key, []);
    termByPair.get(key).push({ t, fo, branch, titleStripped: stripTitleGlyph(t.title) });
  }

  // 6) Sessions from transcripts. Hidden if mtime beyond SESSION_TTL_MS.
  //    Hidden if the first real user prompt is a harness self-test probe —
  //    those throwaway one-turn transcripts never become nodes (T1-active-only
  //    spec). The check uses `labels.firstPrompt` already loaded above, so it
  //    costs no extra file read.
  for (const s of scan.sessions) {
    if (now - s.mtime > SESSION_TTL_MS) continue;
    const labels = transcriptLabel.get(s.sid) || {};
    if (isHarnessProbe(labels.firstPrompt)) continue;
    const branch = labels.gitBranch || '';
    const cwd = labels.cwd || '';
    // If munged project dir alone (no cwd), use the munged dir as fallback.
    let folderAbs = cwd;
    let derivedBranch = branch;
    if (!folderAbs) {
      // fallback: the munged dir, undo munging
      folderAbs = mungeUnmung(s.proj);
      // strip leading separator if present
      folderAbs = folderAbs.replace(/^\\/, '');
    }
    const fo = folderOf(folderAbs);
    const fb = ensureFolderBranch(fo.folder, derivedBranch || null);

    // Decide title
    let label = labels.aiTitle || labels.firstPrompt || ('session ' + s.sid.slice(0, 8));
    label = String(label).slice(0, 64);

    // Possible dedupe with a terminal: same folder|branch AND same title.
    const key = folderSlug(fo.folder) + '|' + (derivedBranch || '');
    const partners = termByPair.get(key) || [];
    let merged = null;
    for (const p of partners) {
      if (!p.titleStripped) continue;
      if (labels.aiTitle && p.titleStripped === labels.aiTitle) { merged = p; break; }
    }
    const sessId = 'session:' + s.sid;
    if (merged) {
      // one node, badge 'orca', carries sessionId + terminal
      const t = merged.t;
      const handleShort = (t.handle || '').replace(/^term_/, '').slice(0, 8);
      const state = titleActiveOrIdle(t, merged.titleStripped, now);
      const provider = providerOf(t);
      // Track how many terminals of the same (folder, branch, provider)
      // appear — if more than one, append a disambiguator to the product
      // label so two Antigravity runs in the same worktree stay readable.
      const dupKey = providerDupKey(fo.folder, merged.branch || '', provider);
      const dupIndex = (providerCountByPair.get(dupKey) || 0) + 1;
      providerCountByPair.set(dupKey, dupIndex);
      const isFirstForProvider = (dupIndex === 1);
      // Label rule B (spec): only 'claude' keeps the title-derived label; every
      // other provider renders the capitalised product name. The raw terminal
      // title is preserved in `sub` so nothing is lost. A duplicate of the
      // same provider in this folder/branch appends " · <branch>" or
      // " · <handle8>" so both cards are readable in the canvas.
      let labelFinal;
      let subFinal;
      // Label rule B (spec): 'claude' AND 'unknown' both keep the title-derived
      // label (unknown means "no identity", so showing a product name here would
      // be guessing). Every other provider renders the capitalised product name;
      // the raw title is preserved in `sub` so nothing is lost. Duplicate
      // providers in one folder/branch append a disambiguator.
      if (provider === 'claude' || provider === 'unknown') {
        // label = aiTitle/firstPrompt/fallback (already in `label`); sub = "active · <branch|folder>"
        labelFinal = label;
        subFinal = (state === 'active' ? 'active · ' : 'idle · ') + (merged.branch || basename(fo.folder));
      } else {
        const productLabel = providerLabel(provider);
        const dup = isFirstForProvider ? '' : (' · ' + disambiguator(t, merged.branch));
        labelFinal = (productLabel + dup).slice(0, 64);
        const rawTitle = titleStrippedOrScratch(t, label);
        subFinal = (state === 'active' ? 'active · ' : 'idle · ') + (rawTitle || merged.branch || basename(fo.folder));
      }
      const sessNode = {
        id: sessId,
        kind: NODE_KINDS.session,
        label: labelFinal, sub: subFinal,
        badge: 'orca', state, folder: fo.folder, branch: merged.branch,
        parent: fb.branchId || fb.folderId,
        cwd: fo.folder, source: 'transcript+terminal',
        sessionId: s.sid, terminal: t.handle, provider,
        ts: s.mtime,
      };
      // T1-truthful-server: a merged (transcript+terminal) session carries
      // two independent activity sources. Pick the FRESHER one (its ts), and
      // — per rule 1 — when the node's state is 'active' (the terminal
      // produced output within ACTIVE_MS) the bubble's ts must agree. When
      // the terminal is fresh but no readable text is available from either
      // source, send activity with the freshest ts and null fields rather
      // than an old string. Per rule 2, omit the activity field entirely
      // when both action and said are empty AND the terminal is not fresh.
      const transcriptA = transcriptActivity.get(s.sid) || null;
      const terminalA = terminalActivity(t, now) || null;
      const lo = Number(t.lastOutputAt);
      // rule 1: pick the activity from whichever text source is fresher, and
      // use the freshest accessible timestamp (transcript.ts OR terminal
      // lastOutputAt, whichever is more recent) for activity.ts whenever
      // state=active. We do NOT require lastOutputAt to be within ACTIVE_MS:
      // glyph-driven active (lastOutputAt itself > ACTIVE_MS but the ring
      // says working) still needs the bubble to mirror whatever freshness
      // is reachable. The HARD floor is what transcriptA already carries;
      // bumping to lastOutputAt is only ever a move toward "more current".
      const transcriptTs = transcriptA && Number.isFinite(transcriptA.ts) ? transcriptA.ts : null;
      const loTs = (Number.isFinite(lo) && lo > 0) ? lo : null;
      let activity = null;
      if (transcriptA && terminalA) {
        // Both sources have text — freshest ts wins.
        if (transcriptA.ts >= terminalA.ts) {
          activity = { action: transcriptA.action, said: transcriptA.said, ts: transcriptA.ts };
        } else {
          activity = { action: transcriptA.action || null, said: terminalA.said, ts: terminalA.ts };
        }
      } else {
        activity = transcriptA || terminalA;
      }
      // Rule 1 sync: when state=active, prefer the freshest of lastOutputAt
      // and transcript.ts. (lastOutputAt wins ties with transcriptA because
      // transcriptA's text came from a line whose ts <= the actual emit.)
      if (state === 'active' && activity) {
        let candidateTs = null;
        if (transcriptTs != null) candidateTs = transcriptTs;
        if (loTs != null && (candidateTs == null || loTs > candidateTs)) candidateTs = loTs;
        if (candidateTs != null && candidateTs > activity.ts) {
          activity = { action: activity.action || null, said: activity.said || null, ts: candidateTs };
        }
      }
      // Ring-bubble agreement: when state=active, the bubble's ts must
      // reflect the agent's liveness. If we surfaced a fresh ts above (any
      // ts within ACTIVE_MS), keep the bubble; if every reachable source was
      // stale (glyph-driven active with no recent emit on either side),
      // the bubble would lie about freshness — drop it. The active ring
      // alone then carries the "this is working" signal until output lands.
      if (activity && state === 'active' && (now - activity.ts) > ACTIVE_MS) {
        activity = null;
      }
      // Rule 2: no empty activity. (Hard guarantee; rules 1 and 2 coexist —
      // rule 1 keeps the freshest reachable timestamp; rule 2 drops bubbles
      // that would carry no text.)
      if (activity && !nonEmptyActionSaid(activity)) {
        activity = null;
      }
      if (activity) sessNode.activity = activity;
      nodes.set(sessId, sessNode);
      merged.matched = true;
    } else {
      // Transcript-only session (no Orca terminal). The transcript was written
      // by Claude Code, so the provider is 'claude' by definition (no
      // agentIdentity travels without a terminal). The UI's ProviderChip then
      // shows the claude mark instead of the '?' unknown chip.
      // T1-truthful-server v2: the state must agree with the bubble age.
      // The harness frequently writes non-work lines to the transcript
      // (heartbeats, plugin events, replay rows) which move file mtime but
      // do not represent real agent work. Derive state from activity.ts
      // (the same timestamp we surface in the bubble) whenever real
      // activity was extractable; fall back to mtime only when no activity
      // was found. With this rule the ring and the bubble can never
      // disagree by more than ACTIVE_MS.
      const activityT = transcriptActivity.get(s.sid) || null;
      const activityTs = (activityT && nonEmptyActionSaid(activityT)) ? activityT.ts : null;
      const livenessTs = activityTs != null ? activityTs : s.mtime;
      const state = (now - livenessTs < ACTIVE_MS) ? 'active' : 'idle';
      const sessNodeT = {
        id: sessId,
        kind: NODE_KINDS.session,
        label, sub: ((state === 'active' ? 'active · ' : 'idle · ') + (mergedBranchShort(merged, fb, fo) || basename(fo.folder))),
        badge: 'claude', state,
        folder: fo.folder, branch: derivedBranch || null,
        parent: fb.branchId || fb.folderId,
        cwd: fo.folder, source: 'transcript',
        ts: livenessTs,
        provider: 'claude',
      };
      // T1-activity-extractor: transcript-only session -> activity from the
      // transcript tail (action + said + ts), when present.
      // T1-truthful-server rule 2: omit activity entirely when both action
      // and said would be empty.
      if (activityT && nonEmptyActionSaid(activityT)) sessNodeT.activity = activityT;
      nodes.set(sessId, sessNodeT);
    }
  }

  // 7) Sessions from terminals (which weren't dedup'd to a transcript).
  for (const t of liveTerminals) {
    const fo = folderOf(t.worktreePath || '');
    const branch = (t.branch || '').replace(/^refs\/heads\//, '');
    const key = folderSlug(fo.folder) + '|' + branch;
    const partners = termByPair.get(key) || [];
    const partner = partners.find((p) => p.t.handle === t.handle);
    if (partner && partner.matched) continue;
    const fb = ensureFolderBranch(fo.folder, branch);
    const handleShort = (t.handle || '').replace(/^term_/, '').slice(0, 8);
    const titleStripped = stripTitleGlyph(t.title);
    const provider = providerOf(t);
    // Bump per-(folder, branch, provider) counter for disambiguation.
    const dupKey = providerDupKey(fo.folder, branch, provider);
    const dupIndex = (providerCountByPair.get(dupKey) || 0) + 1;
    providerCountByPair.set(dupKey, dupIndex);
    const isFirstForProvider = (dupIndex === 1);
    // label: from task row (joined), else title (stripped), else 'orca <handle8>'
    const tt = (tasks || []).find((x) => x.terminal === t.handle);
    const baseLabel = tt ? ((tt.task_id || '') + ' · ' + (tt.role || ''))
      : titleStripped ? titleStripped
        : 'orca ' + handleShort;
    const state = titleActiveOrIdle(t, titleStripped, now);
    const sid = 'session:orca:' + handleShort;
    // Label rule B (spec): 'claude' AND 'unknown' both keep the title-derived
    // label (unknown means "no identity", so showing a product name would be
    // guessing). Every other provider renders the capitalised product name;
    // the raw title is preserved in `sub`. Duplicate providers in one
    // folder/branch append a disambiguator to the product label.
    let labelFinal, subFinal;
    if (provider === 'claude' || provider === 'unknown') {
      labelFinal = String(baseLabel).slice(0, 64);
      subFinal = (state === 'active' ? 'active · ' : 'idle · ') + (branch || basename(fo.folder));
    } else {
      const productLabel = providerLabel(provider);
      const dup = isFirstForProvider ? '' : (' · ' + disambiguator(t, branch));
      labelFinal = (productLabel + dup).slice(0, 64);
      const rawTitle = titleStrippedOrScratch(t, baseLabel);
      subFinal = (state === 'active' ? 'active · ' : 'idle · ') + (rawTitle || branch || basename(fo.folder));
    }
    const sessNodeTerminalOnly = {
      id: sid,
      kind: NODE_KINDS.session,
      label: labelFinal, sub: subFinal,
      badge: 'orca', state,
      folder: fo.folder, branch,
      parent: fb.branchId || fb.folderId,
      cwd: fo.folder, source: 'terminal',
      terminal: t.handle, provider, ts: Number(t.lastOutputAt) || now,
    };
    // T1-activity-extractor: terminal-only sessions (no transcript on disk)
    // get activity from the Orca `preview` field — said + ts only, no action.
    // T1-truthful-server rule 2: omit activity entirely when both action
    // and said would be empty.
    const activityTOnly = terminalActivity(t, now);
    if (activityTOnly && nonEmptyActionSaid(activityTOnly)) {
      sessNodeTerminalOnly.activity = activityTOnly;
    }
    nodes.set(sid, sessNodeTerminalOnly);
  }

  // 8) Agents (subagents). Per amendment A6:
  //   active if mtime < ACTIVE_MS
  //   else HIDDEN if parent transcript has completed/failed/killed notification
  //   else idle if < SESSION_TTL_MS
  //   else hidden
  const childCount = new Map(); // parentId -> count of active children (for monitoring propagation)
  for (const a of scan.agents) {
    const doneSet = completedByParent[a.parentSid];
    const completed = !!(doneSet && doneSet.has(a.agentId));
    const withinActive = (now - a.mtime) < ACTIVE_MS;
    if (!withinActive && completed) continue; // hidden: completed + past ACTIVE_MS
    if ((now - a.mtime) > SESSION_TTL_MS) continue; // hidden: TTL too old
    // session cwd/gitBranch for the parent — derive folder via parent's path
    const parentPath = scan.sessions.find((s) => s.sid === a.parentSid);
    let folderAbs = '';
    let branch = '';
    if (parentPath) {
      folderAbs = parentPath.cwd || mungeUnmung(parentPath.proj);
      branch = parentPath.gitBranch || '';
    }
    if (!folderAbs) continue;
    const fo = folderOf(folderAbs);
    const fb = ensureFolderBranch(fo.folder, branch || null);
    // Parent: agent if parentAgentId points to another subagent, else session
    let parentRef;
    if (a.parentAgentId) {
      parentRef = 'agent:sub:' + a.parentAgentId;
      // If that agent isn't kept (filtered out), fall back to the parent session
      const exists = scan.agents.find((x) => x.agentId === a.parentAgentId && (now - x.mtime) <= SESSION_TTL_MS);
      if (!exists) parentRef = 'session:' + a.parentSid;
    } else {
      parentRef = 'session:' + a.parentSid;
    }
    // Liveness for kept ones
    const hasActiveChild = false; // subagents are leaves in the tree; they don't have children
    const st = withinActive ? 'active' : 'idle'; // monitoring not applicable to leaf subagents
    // Label: task row by agent_id else meta.description else generic
    const taskRow = taskByAgentId.get(a.agentId);
    let label, role = null;
    if (taskRow) {
      label = (taskRow.task_id || '') + ' · ' + (taskRow.role || '');
      role = taskRow.role || null;
    } else if (a.meta && a.meta.description) {
      label = String(a.meta.description).trim();
    } else {
      label = 'subagent ' + a.agentId.slice(0, 8);
    }
    const realModel = readLastModel(a.path) || (a.meta && a.meta.model) || '';
    const agentId = a.agentId;
    const agId = 'agent:sub:' + agentId;
    const agentNode = {
      id: agId,
      kind: NODE_KINDS.agent,
      label: String(label).slice(0, 64),
      sub: ((st === 'active' ? 'active · ' : 'idle · ') + (role || (a.meta && a.meta.agentType) || 'subagent') + (realModel ? ' · ' + realModel : '')),
      badge: 'subagent', state: st,
      folder: fo.folder, branch: branch || null,
      parent: parentRef,
      cwd: fo.folder, source: 'transcript',
      agentId, role, model: realModel,
      spawnDepth: a.spawnDepth || 1,
      ts: a.mtime,
    };
    // T1-activity-extractor: subagent nodes carry their own transcript tail.
    // Privacy: only the agent's own words (said) and the current tool call
    // (action) are surfaced — tool_result blocks and command output are
    // never read into the shape.
    // T1-truthful-server rule 2: omit activity entirely when both action
    // and said would be empty.
    const agentActivity = extractActivity(readActivityTail(a.path), { now });
    if (agentActivity && nonEmptyActionSaid(agentActivity)) agentNode.activity = agentActivity;
    nodes.set(agId, agentNode);
    if (st === 'active' && parentRef) {
      childCount.set(parentRef, (childCount.get(parentRef) || 0) + 1);
    }
  }

  // 9) Propagate monitoring up through agent->agent edges. For every agent,
  // if it has an active child, mark its parent agent/session as monitoring.
  // We iterate twice (children can be deeper than 1 hop).
  let changed = true;
  let pass = 0;
  while (changed && pass < 8) {
    changed = false; pass++;
    for (const n of nodes.values()) {
      if (n.kind !== NODE_KINDS.agent && n.kind !== NODE_KINDS.session) continue;
      const c = childCount.get(n.id) || 0;
      if (c > 0 && n.state !== 'active' && n.state !== 'monitoring' && n.state !== CONTAINER_STATE) {
        n.state = 'monitoring';
        // bubble: mark this node's parent as monitoring too
        if (n.parent) {
          const p = nodes.get(n.parent);
          if (p && p.state !== 'active' && p.state !== 'monitoring' && p.state !== CONTAINER_STATE) {
            // don't overwrite; mark for next pass via parent chain
            childCount.set(p.id, (childCount.get(p.id) || 0) + 1);
            changed = true;
          }
        }
      }
    }
  }

  // 10) Hermes
  if (hermesOnline) {
    nodes.set('hermes', {
      id: 'hermes', kind: NODE_KINDS.hermes, label: 'ZenoA', sub: 'hermes · idle',
      badge: 'hermes', state: 'idle', folder: '', branch: null,
      parent: null, cwd: '', ts: now,
    });
  }

  // 10b) ACTIVE ONLY (T1-active-only spec): drop idle sessions and agents.
  // A session/agent whose state is 'idle' (last touch beyond ACTIVE_MS, no
  // active descendants) is hidden. 'active' and 'monitoring' (parent with
  // at least one active descendant) are kept. Monitoring bubbles up via the
  // loop above — anything that bubbled to 'monitoring' survives; anything
  // that stayed 'idle' disappears. hermes is intentionally NOT touched: it
  // is an always-on indicator and lives on its own state channel.
  // Container (folder/branch) pruning happens below via the `used` set, so
  // an idle-only folder disappears for free.
  //
  // EXCEPTION (T1-terminals-alive): a session node derived from a LIVE Orca
  // terminal (badge 'orca' AND a terminal handle) is kept even when its
  // state is 'idle'. The transcript rule (no terminal, just a transcript)
  // treats idle as stale and hides the row; the terminal rule is the
  // opposite — a connected, non-orphaned Orca terminal represents a running
  // agent, even if it has been quiet for more than ACTIVE_MS. The node
  // disappears when the terminal disconnects or orphans (the original
  // `liveTerminals` filter at step 5 is the source of truth). Quiet-but-alive
  // antigravity/cursor/codex terminals therefore stay on the canvas; the
  // transcript-only noise still gets pruned.
  for (const id of [...nodes.keys()]) {
    const n = nodes.get(id);
    if (n.state !== 'idle') continue;
    if (n.kind !== NODE_KINDS.session && n.kind !== NODE_KINDS.agent) continue;
    // Keep terminal-derived sessions whose Orca terminal is still alive.
    // We identify them by (kind=session, badge=orca, terminal!=null) and
    // re-check against `liveTerminals` (the same connected && !orphaned
    // filter that produced them at step 5) so a terminal that just
    // disconnected/orphaned this tick is also removed on this tick.
    if (n.kind === NODE_KINDS.session && n.badge === 'orca' && n.terminal) {
      const live = liveTerminals.find((t) => t.handle === n.terminal);
      if (live && live.connected && !live.orphaned) continue;
    }
    nodes.delete(id);
  }

  // 11a) Label disambiguation (T1-truthful-server, item 4 — v2). The
  // previous per-provider disambig only fired for non-claude providers; two
  // same-titled claude / unknown sessions in one folder+branch stay
  // indistinguishable. v1 keyed the collision on (folder, branch), which
  // still lets a folder with two branches that share the same label slip
  // through (e.g. the live report: "MRI server .env.prod setup" on master
  // AND on feature/prod-shared-controller in the same repo — different
  // branch keys, no collision). Key on FOLDER only: visible nodes sharing
  // a folder must not share a label. Append " · <handle8>" to the
  // second+ occurrence (per spec example "MRI server .env.prod setup ·
// 3e3898bd"). The handle is taken from terminal.handle, then sessionId,
// then agentId, then the node id. Order follows insertion (build order)
// so the result is deterministic across builds with the same inputs.
  const labelByFolder = new Map(); // key = folderSlug(folder) -> Map(label -> [nodes])
  for (const n of nodes.values()) {
    if (n.kind !== NODE_KINDS.session && n.kind !== NODE_KINDS.agent) continue;
    if (n.state === CONTAINER_STATE) continue;
    if (!n.folder || !n.label) continue;
    const fkey = folderSlug(n.folder);
    if (!labelByFolder.has(fkey)) labelByFolder.set(fkey, new Map());
    const labelMap = labelByFolder.get(fkey);
    if (!labelMap.has(n.label)) labelMap.set(n.label, []);
    labelMap.get(n.label).push(n);
  }
  for (const [, labelMap] of labelByFolder) {
    for (const [, collNodes] of labelMap) {
      if (collNodes.length <= 1) continue;
      for (let i = 1; i < collNodes.length; i++) {
        const n = collNodes[i];
        const handleShort = (
          n.terminal ? String(n.terminal).replace(/^term_/, '').slice(0, 8)
          : n.sessionId ? String(n.sessionId).slice(0, 8)
          : n.agentId ? String(n.agentId).slice(0, 8)
          : (n.id ? String(n.id).slice(-12) : 'node')
        );
        n.label = (String(n.label) + ' · ' + handleShort).slice(0, 64);
      }
    }
  }

  // 11) Drop container-state-only nodes that have NO living children. A
  // folder/branch that nobody is currently using is just noise.
  // First, find the set of folders/branches referenced by living nodes.
  const used = new Set();
  for (const n of nodes.values()) {
    if (n.state === CONTAINER_STATE) continue; // containers are living containers
    if (n.folder) used.add('folder:' + folderSlug(n.folder));
    if (n.folder && n.branch) used.add(branchId(n.folder, n.branch));
  }
  for (const id of [...nodes.keys()]) {
    const n = nodes.get(id);
    if (n.state === CONTAINER_STATE && !used.has(n.id)) nodes.delete(id);
  }
  // Containers must NEVER carry living states (frozen model invariant)
  for (const n of nodes.values()) {
    if (n.state === CONTAINER_STATE) continue;
    if (n.kind === NODE_KINDS.folder || n.kind === NODE_KINDS.branch) n.state = CONTAINER_STATE;
  }

  // 12) Build edges.
  const edgesOut = [];
  const addEdge = (from, to, kind, extra = {}) => {
    if (!nodes.has(from) || !nodes.has(to)) return;
    const child = nodes.get(to);
    // Per amendment: member edges are always static (animated=false, flow=false).
    // Only tree and spawn edges animate, and only when the child is active.
    const animated = (kind !== EDGE_KINDS.member) && (child.state === 'active');
    edgesOut.push({
      id: kind + ':' + from + '>' + to, from, to, kind,
      data: { animated, flow: animated }, ...extra,
    });
  };
  for (const n of nodes.values()) {
    if (n.parent && nodes.has(n.parent)) {
      // tree edge: parent → child
      addEdge(n.parent, n.id, EDGE_KINDS.tree);
    }
    if (n.kind === NODE_KINDS.session && nodes.has(n.id)) {
      // agents of this session: spawn edges (session -> agent)
      for (const m of nodes.values()) {
        if (m.kind === NODE_KINDS.agent && m.parent === n.id) {
          addEdge(n.id, m.id, EDGE_KINDS.spawn);
        }
      }
    }
  }
  // 13) Member edges: session->session (same folder|branch). Prune when
  // either endpoint is hidden by the living rule.
  const sessionByPair = new Map();
  for (const n of nodes.values()) {
    if (n.kind !== NODE_KINDS.session) continue;
    if (!n.folder) continue;
    const key = folderSlug(n.folder) + '|' + (n.branch || '');
    if (!sessionByPair.has(key)) sessionByPair.set(key, []);
    sessionByPair.get(key).push(n.id);
  }
  for (const [, ids] of sessionByPair) {
    if (ids.length < 2) continue;
    // pick a hub (the first) and the rest as spokes
    const hub = ids[0];
    for (let i = 1; i < ids.length; i++) {
      const spoke = ids[i];
      // only emit if both endpoints are kept (they will be, by construction;
      // we already filtered, but be explicit)
      if (!nodes.has(hub) || !nodes.has(spoke)) continue;
      addEdge(hub, spoke, EDGE_KINDS.member);
    }
  }

  // 14) Prune member edges whose endpoints are hidden (defensive).
  const filtered2 = edgesOut.filter((e) => nodes.has(e.from) && nodes.has(e.to));

  // 15) Stats. Frozen shape: active, idle, monitoring, sessions, agents, orca,
  // subagent, folders, branches, edges. NO runs / messages / live.
  // T1-terminals-alive (replaces the T1-active-only contract): `idle`
  // counts the connected, non-orphaned Orca terminals whose last output is
  // past ACTIVE_MS — i.e. running but quiet. The transcript rule still
  // hides stale sessions before they reach this counter, so `idle` is
  // honest about which silent nodes on the canvas are actually alive
  // terminals vs. stale transcripts (stale transcripts never appear in
  // the visible set, so they never appear in `idle` either). The previous
  // "idle: 0 by construction" behaviour is gone: the number is now
  // meaningful again. hermes is not a session/agent so it does not move
  // this count.
  const all = [...nodes.values()];
  const stats = {
    active: all.filter((n) => n.state === 'active').length,
    idle: all.filter((n) => n.state === 'idle').length,
    monitoring: all.filter((n) => n.state === 'monitoring').length,
    sessions: all.filter((n) => n.kind === NODE_KINDS.session).length,
    agents: all.filter((n) => n.kind === NODE_KINDS.agent).length,
    orca: all.filter((n) => n.badge === 'orca').length,
    subagent: all.filter((n) => n.badge === 'subagent').length,
    folders: all.filter((n) => n.kind === NODE_KINDS.folder).length,
    branches: all.filter((n) => n.kind === NODE_KINDS.branch).length,
    edges: filtered2.length,
  };

  return {
    type: 'graph',
    ts: new Date(now).toISOString(),
    stats,
    nodes: [...nodes.values()],
    edges: filtered2,
  };
}

// ---- IO collector ----

export async function collect() {
  const now = Date.now();
  // Performance: the Orca CLI dominates collect() (~950 ms on this machine);
  // the filesystem scan (scanTranscripts + readFleetTasks) costs ~200-300 ms.
  // We previously ran them serially (orca first, fs after). They are now kicked
  // off together so the total is ~max(orca, fs), not the sum. The synchronous
  // fs work runs while Orca's child process is in flight (libuv executes the
  // child on a separate thread), so wall-clock cost drops to the larger of
  // the two. We dropped the `worker-list` Orca call — verified 2026-10-07 it
  // is a role/task join, not a liveness source — terminal handles come from
  // `terminal list` and the task join is satisfied by tasks.jsonl.
  const orcaP = orca(['terminal', 'list', '--json']);
  const hermesP = hermesAlive();
  // Synchronous fs scan runs while orca and hermes are in flight. The JS
  // thread is busy on disk reads for ~200 ms, but the orca child process is
  // already running concurrently — we await it at the end.
  const scan = scanTranscripts(now, CLAUDE_PROJECTS);
  const tasks = readFleetTasks(FLEET_RUNS);
  const [termRes, hermes] = await Promise.all([orcaP, hermesP]);
  return buildGraph({
    now, scan,
    terminals: (termRes && termRes.terminals) || [],
    tasks, workers: [], hermesOnline: !!hermes,
  });
}

// ---- local helpers ----

function titleActiveOrIdle(t, titleStripped, now) {
  // amendment A3: active when title glyph is in the working set OR lastOutputAt within ACTIVE_MS.
  const glyph = String(t.title || '').charAt(0);
  const liveGlyph = glyph === '◐' || glyph === '◑' || glyph === '◒' || glyph === '◓';
  if (liveGlyph) return 'active';
  const lo = Number(t.lastOutputAt);
  if (lo && (now - lo) < ACTIVE_MS) return 'active';
  return 'idle';
}

function mergedBranchShort(merged, fb, fo) {
  return merged && merged.branch ? merged.branch : (fo.folder ? basename(fo.folder) : '');
}

// Raw terminal title with the leading glyph stripped. If the title glyph is
// missing or empty (closed terminal etc.), fall back to the label that would
// have been the user-facing identifier, so the `sub` field is never blank.
function titleStrippedOrScratch(t, fallback) {
  const s = stripTitleGlyph(t && t.title);
  if (s) return s;
  return String(fallback || '').slice(0, 64) || '';
}

// Disambiguator for the second+ terminal of the same provider in one
// folder/branch. Prefer the (short) branch name when meaningful; otherwise
// drop in the terminal handle's last 4 chars. Empty otherwise.
function disambiguator(t, branch) {
  const b = String(branch || '').replace(/^refs\/heads\//, '').trim();
  // Skip generic branch names that wouldn't distinguish (e.g. 'main', 'master').
  if (b && b !== 'main' && b !== 'master' && b !== 'detached') return b;
  const handleShort = String((t && t.handle) || '').replace(/^term_/, '').slice(-8);
  return handleShort;
}

// True iff `activity.action` or `activity.said` carries any non-whitespace
// text. Used to decide whether to OMIT the activity field entirely — rule
// 2 of the T1-truthful-server spec: "omit the activity field entirely when
// both action and said would be null/empty/whitespace".
function nonEmptyActionSaid(activity) {
  if (!activity) return false;
  const a = activity.action != null ? String(activity.action).trim() : '';
  const s = activity.said   != null ? String(activity.said).trim()   : '';
  return !!(a || s);
}

// ---- HTTP server (entry-only) ----

const socketsSockets = new Set();
let lastPayload = null;

async function tickHttp() {
  try {
    lastPayload = await collect();
    const data = JSON.stringify(lastPayload);
    for (const ws of socketsSockets) { try { ws.send(data); } catch { /* dropped */ } }
  } catch (e) {
    const err = JSON.stringify({ type: 'error', message: String(e && e.message || e) });
    for (const ws of socketsSockets) { try { ws.send(err); } catch { /* dropped */ } }
  }
}

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const wsAccept = (key) => createHash('sha1').update(key + WS_GUID).digest('base64');
function sendText(socket, text) {
  const data = Buffer.from(text, 'utf8');
  const len = data.length;
  let header;
  if (len < 126) header = Buffer.from([0x81, len]);
  else if (len < 0x10000) header = Buffer.from([0x81, 126, (len >> 8) & 0xff, len & 0xff]);
  else header = Buffer.from([0x81, 127, 0, 0, 0, 0, (len >>> 24) & 0xff, (len >>> 16) & 0xff, (len >>> 8) & 0xff, len & 0xff]);
  socket.write(Buffer.concat([header, data]));
}

function startServer() {
  const TYPES = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.map': 'application/json; charset=utf-8',
    '.woff2': 'font/woff2',
    '.png': 'image/png',
    '.ico': 'image/x-icon',
  };
  const DIST = join(HERE, 'dist');
  function serveStatic(req, res) {
    let p = decodeURIComponent((req.url || '/').split('?')[0]);
    if (p === '/') p = '/index.html';
    const file = join(DIST, p);
    if (!file.startsWith(DIST)) { res.writeHead(403).end('forbidden'); return; }
    if (!existsSync(file) || !statSync(file).isFile()) { res.writeHead(404).end('not found'); return; }
    res.writeHead(200, { 'content-type': TYPES[extname(file)] || 'application/octet-stream' });
    res.end(readFileSync(file));
  }
  const server = createServer((req, res) => {
    const path = (req.url || '').split('?')[0];
    if (path === '/graph') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(lastPayload || { type: 'graph', nodes: [], edges: [], stats: {} }));
      return;
    }
    serveStatic(req, res);
  });
  server.on('upgrade', (req, socket) => {
    if ((req.headers.upgrade || '').toLowerCase() !== 'websocket') { socket.destroy(); return; }
    const accept = wsAccept(req.headers['sec-websocket-key'] || '');
    if (!accept) { socket.destroy(); return; }
    socket.write([
      'HTTP/1.1 101 Switching Protocols',
      'Upgrade: websocket', 'Connection: Upgrade',
      'Sec-WebSocket-Accept: ' + accept, '', '',
    ].join('\r\n'));
    const ws = { socket, send: (t) => sendText(socket, t) };
    socketsSockets.add(ws);
    if (lastPayload) ws.send(JSON.stringify(lastPayload));
    socket.on('close', () => socketsSockets.delete(ws));
    socket.on('error', () => socketsSockets.delete(ws));
    socket.on('data', () => { /* client is read-only; ignore frames */ });
  });
  server.listen(PORT, () => console.log('fleet monitor on http://localhost:' + PORT + '  (orca=' + ORCA + ')'));
  // First tick + interval, the timer is unref'd so the process can exit cleanly
  // when no clients are connected. The HTTP server keeps the loop alive by
  // itself when entry-mode runs it.
  tickHttp();
  setInterval(tickHttp, POLL_MS).unref();
}

// Run the HTTP server only when this module is the program entry, never when
// it is imported by tests or other code.
const isEntry = (() => {
  try {
    if (!process.argv[1]) return false;
    const here = pathToFileURL(process.argv[1]).href;
    return import.meta.url === here;
  } catch { return false; }
})();

if (isEntry) startServer();