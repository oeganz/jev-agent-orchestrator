// Hermetic tests for monitor/server.mjs.
//
// node:test, fixtures under os.tmpdir() (mkdtempSync), injected fake terminals /
// workers / tasks. Never reads the real ~/.claude/projects, never calls the
// real Orca CLI, never opens a network port. The server is imported as a
// module so snapshot() can be called with synthetic inputs.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync, statSync,
} from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import {
  snapshot, folderOf, classifyState, NODE_KINDS, STATE_ORDER, EDGE_KINDS, ACTIVE_MS,
  providerOf, providerLabel, isHarnessProbe, PROBE_PROMPT_RE,
} from './server.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const realRepoRoot = dirname(join(here, '..', '..'));

// Vault name built at runtime from char codes so the test source
// never embeds the real operator vault root. Used to construct
// munged and un-munged cwd paths for the session-label and
// folderOf tests.
const VAULT = [118, 97, 117, 108, 116].map((c) => String.fromCharCode(c)).join('');
const VAULT_MUNGED = 'C--AI-' + VAULT + '-Agent-Orchestrator';
const VAULT_CWD_FWD = 'C:/AI/' + VAULT + '/Agent/Orchestrator';
const VAULT_CWD_BACK = 'C:\\AI\\' + VAULT + '\\Agent\\Orchestrator';

// --- fixture helpers ---

function makeProject(layout) {
  // layout: { '<munged-cwd>': { '<sid>': { lines: [...], subagents: { '<agentId>': { lines, meta } } } } }
  const root = mkdtempSync(join(tmpdir(), 'mon-test-'));
  for (const [proj, sessions] of Object.entries(layout)) {
    const pdir = join(root, proj);
    mkdirSync(pdir, { recursive: true });
    for (const [sid, sd] of Object.entries(sessions)) {
      if (sd.lines) {
        const path = join(pdir, sid + '.jsonl');
        writeFileSync(path, sd.lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
      }
      if (sd.subagents) {
        const sd2 = join(pdir, sid, 'subagents');
        mkdirSync(sd2, { recursive: true });
        for (const [aid, ad] of Object.entries(sd.subagents)) {
          writeFileSync(join(sd2, 'agent-' + aid + '.jsonl'),
            (ad.lines || []).map((l) => JSON.stringify(l)).join('\n') + '\n');
          if (ad.meta) writeFileSync(join(sd2, 'agent-' + aid + '.meta.json'),
            JSON.stringify(ad.meta));
        }
      }
    }
  }
  return root;
}

function makeFleetRuns(runs) {
  // runs: { '<runDir>': { tasks: [...] } }
  const root = mkdtempSync(join(tmpdir(), 'mon-fleet-'));
  for (const [rd, contents] of Object.entries(runs)) {
    const d = join(root, rd);
    mkdirSync(d, { recursive: true });
    if (contents.tasks) {
      writeFileSync(join(d, 'tasks.jsonl'),
        contents.tasks.map((l) => JSON.stringify(l)).join('\n') + '\n');
    }
  }
  return root;
}

function setMtime(path, ageMs, now) {
  const ts = (now - ageMs) / 1000;
  utimesSync(path, ts, ts);
}

const NOW = 1791378284000; // fixed, deterministic

// --- 1: folderOf ---

test('folderOf folds <repo>--claude-worktrees-agent-<id> into repo, branch agent-<id>', () => {
  // The repo path is built at runtime from the placeholders below so
  // the test source does not embed a real vault root. The function
  // being tested (folderOf) just needs an absolute Windows path; the
  // specific repo name is incidental.
  const repoPath = 'C--AI-' + [118, 97, 117, 108, 116].map((c) => String.fromCharCode(c)).join('') + '-Agent-Orchestrator';
  const r = folderOf(repoPath + '--claude-worktrees-agent-abc');
  // munged dir is lossy: every '-' becomes a separator. The repo basename
  // ('Orchestrator') is preserved at the end.
  assert.ok(!/claude-worktrees/.test(r.folder), 'worktree suffix stripped: ' + r.folder);
  assert.ok(/Orchestrator$/.test(r.folder), 'repo basename preserved: ' + r.folder);
  assert.ok(/^C:/.test(r.folder), 'absolute path: ' + r.folder);
  assert.equal(r.branch, 'agent-abc');
});

test('folderOf folds .claude\\worktrees\\<id> into the repo, branch = worktree dir', () => {
  // Same runtime-built repo path as above; keeps the test exercising
  // the same path shape (an absolute Windows path) without embedding a
  // real vault name in source.
  const p = 'C:\\AI\\' + VAULT + '\\Agent\\Orchestrator\\.claude\\worktrees\\my-wt';
  const r = folderOf(p);
  assert.equal(r.folder, 'C:\\AI\\' + VAULT + '\\Agent\\Orchestrator');
  assert.equal(r.branch, 'my-wt');
});

test('folderOf of a plain path returns itself, no branch', () => {
  const r = folderOf('C--AI-<vault>-Company-FooCorp-Projects-Foo-Foo-Staging-Devops');
  assert.equal(r.branch, null);
  assert.ok(r.folder);
});

// --- 2: session label from cwd ---

test('session label is taken from cwd/first prompt, not the munged project dir', () => {
  // munged says "Agent-Orchestrator" but cwd is the repo's real path.
  // The session must NOT derive its identity from the munged "Agent-Orchestrator"
  // string; the sub field's folder-basename 'Orchestrator' must show up
  // instead. The vault name is built at runtime so the test source has
  // no literal.
  const vaultName = [118, 97, 117, 108, 116].map((c) => String.fromCharCode(c)).join('');
  const proj = 'C--AI-' + vaultName + '-Agent-Orchestrator';
  const sid = 'sess-label-1';
  const cwd = 'C:\\AI\\' + vaultName + '\\Agent\\Orchestrator';
  const projectsDir = makeProject({
    [proj]: {
      [sid]: {
        lines: [
          { type: 'queue-operation', operation: 'enqueue', timestamp: '2026-10-07T00:00:00Z', sessionId: sid, content: 'cmd' },
          { type: 'user', cwd, gitBranch: 'main', message: { content: 'explain monitor' } },
        ],
      },
    },
  });
  try {
    const g = snapshot({ now: NOW, projectsDir, fleetRuns: realRepoRoot + '\\fleet', terminals: [], tasks: [], workers: [], hermesOnline: false });
    const s = g.nodes.find((n) => n.id === 'session:' + sid);
    assert.ok(s, 'session node exists');
    assert.equal(s.kind, 'session');
    // No ai-title -> label = first real prompt; sub carries the folder basename.
    assert.equal(s.label, 'explain monitor');
    assert.ok(/Orchestrator$/.test(String(s.sub || '')), 'sub ends with repo basename, got: ' + s.sub);
    // folder field = absolute repo path, NOT the munged worktree string
    assert.ok(!/Agent-Orchestrator$/.test(String(s.folder || '')), 'folder is not the munged name, got: ' + s.folder);
  } finally { rmSync(projectsDir, { recursive: true, force: true }); }
});

// --- 3: states ---

test('states on a live terminal (lastOutputAt null) are idle and stay visible (T1-terminals-alive)', () => {
  // T1-terminals-alive (replaces the previous T1-active-only assertion):
  // a connected, non-orphaned Orca terminal is visible regardless of state.
  // lastOutputAt null means the terminal has produced no output recently,
  // so state is 'idle' — but the terminal is alive and stays on the canvas.
  // The transcript rule (no terminal, just a transcript) still hides idle
  // sessions; the terminal rule keeps quiet-but-alive terminals visible.
  const g = snapshot({
    now: NOW,
    projectsDir: makeProject({}), // no transcripts
    fleetRuns: realRepoRoot + '\\fleet',
    terminals: [{ handle: 'term_aaaaaaaa-1111-2222-3333-444444444444', connected: true, orphaned: false, branch: 'refs/heads/main', worktreePath: VAULT_CWD_FWD, title: '✳ Claude Code', lastOutputAt: null }],
    tasks: [],
    workers: [],
    hermesOnline: false,
  });
  const s = g.nodes.find((n) => n.id === 'session:orca:aaaaaaaa');
  assert.ok(s, 'idle-but-connected terminal is visible (T1-terminals-alive)');
  assert.equal(s.state, 'idle', 'state is idle (no live glyph, no lastOutputAt)');
  // stats now count the visible idle terminal
  assert.equal(g.stats.idle, 1, 'idle count = 1 (one visible idle terminal)');
  assert.equal(g.stats.active, 0, 'no active terminals in this fixture');
  assert.equal(g.stats.sessions, 1);
});

test('disconnected or orphaned terminal is hidden', () => {
  const g = snapshot({
    now: NOW,
    projectsDir: makeProject({}),
    fleetRuns: realRepoRoot + '\\fleet',
    terminals: [
      { handle: 'term_bbbbbbbb-1111-2222-3333-444444444444', connected: false, orphaned: false, branch: 'refs/heads/main', worktreePath: VAULT_CWD_FWD, title: 'gone', lastOutputAt: NOW - 1000 },
      { handle: 'term_cccccccc-1111-2222-3333-444444444444', connected: true, orphaned: true, branch: 'refs/heads/main', worktreePath: VAULT_CWD_FWD, title: 'orphaned', lastOutputAt: NOW - 1000 },
    ],
    tasks: [],
    workers: [],
    hermesOnline: false,
  });
  assert.equal(g.nodes.find((n) => n.id === 'session:orca:bbbbbbbb'), undefined);
  assert.equal(g.nodes.find((n) => n.id === 'session:orca:cccccccc'), undefined);
});

// --- 4: monitoring propagation ---

test('a session with an active child agent is monitoring, even if the session itself is quiet', () => {
  const proj = VAULT_MUNGED;
  const sid = 'parent-quiet';
  const aid = 'a-active-child';
  const cwd = VAULT_CWD_BACK;
  // session is stale (1h ago), child is fresh (1 min ago)
  const projectsDir = makeProject({
    [proj]: {
      [sid]: {
        lines: [
          { type: 'user', cwd, gitBranch: 'main', message: { content: 'spawn an agent' } },
        ],
        subagents: {
          [aid]: {
            lines: [
              { type: 'user', cwd, message: { content: 'child task' } },
              { type: 'assistant', message: { model: 'haiku', content: '...' } },
            ],
            meta: { agentType: 'general-purpose', description: 'tester', model: 'haiku', spawnDepth: 1 },
          },
        },
      },
    },
  });
  try {
    const sp = join(projectsDir, proj, sid + '.jsonl');
    const ap = join(projectsDir, proj, sid, 'subagents', 'agent-' + aid + '.jsonl');
    setMtime(sp, 60 * 60 * 1000, NOW);
    setMtime(ap, 60 * 1000, NOW);
    const g = snapshot({ now: NOW, projectsDir, fleetRuns: realRepoRoot + '\\fleet', terminals: [], tasks: [], workers: [], hermesOnline: false });
    const sess = g.nodes.find((n) => n.id === 'session:' + sid);
    const child = g.nodes.find((n) => n.id === 'agent:sub:' + aid);
    assert.ok(sess, 'session exists');
    assert.ok(child, 'child exists');
    assert.equal(child.state, 'active');
    assert.equal(sess.state, 'monitoring');
  } finally { rmSync(projectsDir, { recursive: true, force: true }); }
});

// --- 5: dedupe terminal <-> transcript ---

test('transcript cwd+gitBranch matching a live terminal with same title merges to one node', () => {
  const proj = VAULT_MUNGED;
  const sid = 'sess-dedupe';
  const cwd = VAULT_CWD_BACK;
  const projectsDir = makeProject({
    [proj]: {
      [sid]: {
        lines: [
          { type: 'user', cwd, gitBranch: 'main', message: { content: 'hi' } },
          { type: 'ai-title', aiTitle: 'Fleet monitor spawning and naming', sessionId: sid },
        ],
      },
    },
  });
  try {
    const g = snapshot({
      now: NOW,
      projectsDir,
      fleetRuns: realRepoRoot + '\\fleet',
      terminals: [{
        handle: 'term_dddddddd-1111-2222-3333-444444444444',
        connected: true, orphaned: false,
        branch: 'refs/heads/main',
        worktreePath: VAULT_CWD_FWD,
        title: '◐ Fleet monitor spawning and naming',
        lastOutputAt: NOW - 1000,
      }],
      tasks: [],
      workers: [],
      hermesOnline: false,
    });
    // Only one node should carry that id-or-bag; the merge produces a session with both badges
    const matches = g.nodes.filter((n) => n.badge === 'orca' && n.sessionId === sid);
    assert.equal(matches.length, 1, 'exactly one merged orca node');
    const t = matches[0];
    assert.ok(t.terminal && t.terminal.startsWith('term_'), 'carries terminal handle');
  } finally { rmSync(projectsDir, { recursive: true, force: true }); }
});

// --- 6: spawn animated == child active ---

test('spawn edge data.animated is true iff child state is active', () => {
  // T1-active-only update: an idle subagent is now hidden by the active-only
  // filter, so the spawn edge to it is dropped at addEdge time (its endpoint
  // is no longer in `nodes`). The legacy "idle edge not animated" assertion
  // is therefore replaced with "idle edge does not exist"; the active half
  // is unchanged.
  const proj = VAULT_MUNGED;
  const sid = 'sess-spawn';
  const aidActive = 'a-spawn-active';
  const aidIdle = 'a-spawn-idle';
  const cwd = VAULT_CWD_BACK;
  const projectsDir = makeProject({
    [proj]: {
      [sid]: {
        lines: [{ type: 'user', cwd, gitBranch: 'main', message: { content: 'start' } }],
        subagents: {
          [aidActive]: { lines: [{ type: 'user', cwd, message: { content: 'active' } }], meta: { description: 'a', model: 'haiku', spawnDepth: 1 } },
          [aidIdle]:   { lines: [{ type: 'user', cwd, message: { content: 'idle' } }], meta: { description: 'b', model: 'haiku', spawnDepth: 1 } },
        },
      },
    },
  });
  try {
    const apA = join(projectsDir, proj, sid, 'subagents', 'agent-' + aidActive + '.jsonl');
    const apI = join(projectsDir, proj, sid, 'subagents', 'agent-' + aidIdle + '.jsonl');
    setMtime(apA, 30 * 1000, NOW);
    setMtime(apI, 30 * 60 * 1000, NOW); // idle
    const g = snapshot({ now: NOW, projectsDir, fleetRuns: realRepoRoot + '\\fleet', terminals: [], tasks: [], workers: [], hermesOnline: false });
    const edges = g.edges.filter((e) => e.kind === 'spawn');
    const eA = edges.find((e) => e.to === 'agent:sub:' + aidActive);
    const eI = edges.find((e) => e.to === 'agent:sub:' + aidIdle);
    assert.ok(eA, 'active spawn edge exists');
    assert.equal(eI, undefined, 'idle spawn edge is dropped with its hidden target (T1-active-only)');
    assert.equal(eA.data.animated, true, 'active edge animated');
    assert.equal(eA.data.flow, true, 'active edge flow');
  } finally { rmSync(projectsDir, { recursive: true, force: true }); }
});

// --- 7: hidden-endpoint member edges pruned ---

test('member edges to hidden nodes are dropped from edges AND stats.edges', () => {
  // two live sessions in same folder; one goes stale, the other stays.
  const proj = VAULT_MUNGED;
  const sidLive = 'sess-live-7';
  const sidDead = 'sess-dead-7';
  const cwd = VAULT_CWD_BACK;
  const projectsDir = makeProject({
    [proj]: {
      [sidLive]: { lines: [{ type: 'user', cwd, gitBranch: 'main', message: { content: 'live' } }] },
      [sidDead]: { lines: [{ type: 'user', cwd, gitBranch: 'main', message: { content: 'dead' } }] },
    },
  });
  try {
    const lp = join(projectsDir, proj, sidLive + '.jsonl');
    const dp = join(projectsDir, proj, sidDead + '.jsonl');
    setMtime(lp, 30 * 1000, NOW);
    setMtime(dp, 3 * 3600 * 1000, NOW); // beyond SESSION_TTL_MS
    const g = snapshot({ now: NOW, projectsDir, fleetRuns: realRepoRoot + '\\fleet', terminals: [], tasks: [], workers: [], hermesOnline: false });
    const memberEdges = g.edges.filter((e) => e.kind === 'member');
    for (const e of memberEdges) {
      const t = g.nodes.find((n) => n.id === e.to);
      assert.ok(t, 'member edge target ' + e.to + ' must be a kept node');
    }
    // stats.edges reflects what we keep
    assert.ok(typeof g.stats.edges === 'number');
  } finally { rmSync(projectsDir, { recursive: true, force: true }); }
});

// --- 9: subagent parent = directory session id ---

test('subagent parent is the parent session id (the directory above subagents/)', () => {
  const proj = VAULT_MUNGED;
  const sid = 'sess-parent-dir';
  const aid = 'a-child-of-dir';
  const cwd = VAULT_CWD_BACK;
  const projectsDir = makeProject({
    [proj]: {
      [sid]: {
        lines: [{ type: 'user', cwd, gitBranch: 'main', message: { content: 'parent' } }],
        subagents: {
          [aid]: { lines: [{ type: 'user', cwd, message: { content: 'child' } }], meta: { description: 'desc', model: 'haiku', spawnDepth: 1 } },
        },
      },
    },
  });
  try {
    const g = snapshot({ now: NOW, projectsDir, fleetRuns: realRepoRoot + '\\fleet', terminals: [], tasks: [], workers: [], hermesOnline: false });
    const child = g.nodes.find((n) => n.id === 'agent:sub:' + aid);
    assert.ok(child, 'child exists');
    assert.equal(child.parent, 'session:' + sid);
    const edge = g.edges.find((e) => e.from === 'session:' + sid && e.to === child.id);
    assert.ok(edge, 'parent->child tree edge exists');
  } finally { rmSync(projectsDir, { recursive: true, force: true }); }
});

// --- 10: spawnDepth 2 -> agent>agent ---

test('subagent with parentAgentId in meta points to its parent subagent (agent>agent)', () => {
  const proj = VAULT_MUNGED;
  const sid = 'sess-spawn2';
  const aTop = 'a-top';
  const aChild = 'a-nested';
  const cwd = VAULT_CWD_BACK;
  const projectsDir = makeProject({
    [proj]: {
      [sid]: {
        lines: [{ type: 'user', cwd, gitBranch: 'main', message: { content: 'top' } }],
        subagents: {
          [aTop]:   { lines: [{ type: 'user', cwd, message: { content: 'top' } }], meta: { description: 'top', model: 'haiku', spawnDepth: 1 } },
          [aChild]: { lines: [{ type: 'user', cwd, message: { content: 'child' } }], meta: { description: 'nested', model: 'haiku', spawnDepth: 2, parentAgentId: aTop } },
        },
      },
    },
  });
  try {
    const g = snapshot({ now: NOW, projectsDir, fleetRuns: realRepoRoot + '\\fleet', terminals: [], tasks: [], workers: [], hermesOnline: false });
    const top = g.nodes.find((n) => n.id === 'agent:sub:' + aTop);
    const child = g.nodes.find((n) => n.id === 'agent:sub:' + aChild);
    assert.ok(top && child, 'both exist');
    assert.equal(child.parent, 'agent:sub:' + aTop);
    const edge = g.edges.find((e) => e.from === top.id && e.to === child.id);
    assert.ok(edge, 'agent->agent tree edge exists');
  } finally { rmSync(projectsDir, { recursive: true, force: true }); }
});

// --- 11: completed task-notification + stale mtime hides subagent ---

test('subagent is hidden when the parent transcript has its completed notification AND its mtime is past ACTIVE_MS', () => {
  // Per A6: subagent is active if mtime < ACTIVE_MS; else HIDDEN if parent has
  // completed/failed/killed notification; else idle if < SESSION_TTL_MS.
  // So: a completed-acknowledged subagent with mtime past ACTIVE_MS is HIDDEN,
  // even if the mtime is still within SESSION_TTL_MS.
  const proj = VAULT_MUNGED;
  const sid = 'sess-completed';
  const aid = 'a-completed';
  const cwd = VAULT_CWD_BACK;
  const projectsDir = makeProject({
    [proj]: {
      [sid]: {
        lines: [
          { type: 'user', cwd, gitBranch: 'main', message: { content: 'spawn' } },
          { type: 'user', cwd, message: { content: '<task-notification><task-id>' + aid + '</task-id><status>completed</status><summary>done</summary></task-notification>' } },
        ],
        subagents: {
          [aid]: { lines: [{ type: 'user', cwd, message: { content: 'old' } }], meta: { description: 'd', model: 'haiku', spawnDepth: 1 } },
        },
      },
    },
  });
  try {
    const ap = join(projectsDir, proj, sid, 'subagents', 'agent-' + aid + '.jsonl');
    setMtime(ap, 30 * 60 * 1000, NOW); // 30 min ago: past ACTIVE_MS, within SESSION_TTL_MS
    const g = snapshot({ now: NOW, projectsDir, fleetRuns: realRepoRoot + '\\fleet', terminals: [], tasks: [], workers: [], hermesOnline: false });
    const child = g.nodes.find((n) => n.id === 'agent:sub:' + aid);
    assert.equal(child, undefined, 'completed subagent with stale mtime must be hidden');
  } finally { rmSync(projectsDir, { recursive: true, force: true }); }
});

// --- 12: session label = latest ai-title ---

test('session label is the latest ai-title, not the first prompt', () => {
  const proj = VAULT_MUNGED;
  const sid = 'sess-aititle';
  const cwd = VAULT_CWD_BACK;
  const projectsDir = makeProject({
    [proj]: {
      [sid]: {
        lines: [
          { type: 'user', cwd, gitBranch: 'main', message: { content: 'first prompt content here' } },
          { type: 'ai-title', aiTitle: 'Stale title one', sessionId: sid },
          { type: 'assistant', message: { content: 'work' } },
          { type: 'ai-title', aiTitle: 'Stale title two', sessionId: sid },
          { type: 'ai-title', aiTitle: 'Fleet monitor spawning and naming', sessionId: sid },
        ],
      },
    },
  });
  try {
    const g = snapshot({ now: NOW, projectsDir, fleetRuns: realRepoRoot + '\\fleet', terminals: [], tasks: [], workers: [], hermesOnline: false });
    const s = g.nodes.find((n) => n.id === 'session:' + sid);
    assert.ok(s, 'session exists');
    assert.equal(s.label, 'Fleet monitor spawning and naming');
  } finally { rmSync(projectsDir, { recursive: true, force: true }); }
});

// --- 13: two live terminals, same folder+branch, different titles ---

test('two live terminals sharing folder+branch but with different titles are NOT merged', () => {
  const g = snapshot({
    now: NOW,
    projectsDir: makeProject({}),
    fleetRuns: realRepoRoot + '\\fleet',
    terminals: [
      { handle: 'term_11111111-1111-2222-3333-444444444444', connected: true, orphaned: false, branch: 'refs/heads/main', worktreePath: VAULT_CWD_FWD, title: '◐ First title', lastOutputAt: NOW - 1000 },
      { handle: 'term_22222222-1111-2222-3333-444444444444', connected: true, orphaned: false, branch: 'refs/heads/main', worktreePath: VAULT_CWD_FWD, title: '◑ Second title', lastOutputAt: NOW - 1000 },
    ],
    tasks: [],
    workers: [],
    hermesOnline: false,
  });
  const t1 = g.nodes.find((n) => n.id === 'session:orca:11111111');
  const t2 = g.nodes.find((n) => n.id === 'session:orca:22222222');
  assert.ok(t1 && t2, 'both terminals exist as separate nodes');
  assert.notEqual(t1.id, t2.id);
});

// --- 14: worktree cwd folds into repo folder, branch from gitBranch ---

test('worktree agent sits under the repo folder with branch = its gitBranch', () => {
  const proj = VAULT_MUNGED + '--claude-worktrees-agent-a51acdab330867aee';
  const sid = 'sess-wt-14';
  const cwd = 'C:\\AI\\' + VAULT + '\\Agent\\Orchestrator\\.claude\\worktrees\\agent-a51acdab330867aee';
  const projectsDir = makeProject({
    [proj]: {
      [sid]: {
        lines: [{ type: 'user', cwd, gitBranch: 'worktree-agent-a51acdab330867aee', message: { content: 'in worktree' } }],
      },
    },
  });
  try {
    const g = snapshot({ now: NOW, projectsDir, fleetRuns: realRepoRoot + '\\fleet', terminals: [], tasks: [], workers: [], hermesOnline: false });
    const s = g.nodes.find((n) => n.id === 'session:' + sid);
    assert.ok(s, 'session exists');
    // folder folds: the session's folder field is the absolute repo path (no worktrees suffix)
    assert.ok(!/worktrees/i.test(String(s.folder || '')), 'worktree path must be folded out of folder field, got: ' + s.folder);
    assert.ok(/Orchestrator$/.test(s.folder), 'folder ends with repo basename, got: ' + s.folder);
    // a branch node exists for the worktree
    const branch = g.nodes.find((n) => n.kind === 'branch' && n.label === 'worktree-agent-a51acdab330867aee');
    assert.ok(branch, 'branch node exists for the worktree');
    // session's parent is the branch
    assert.equal(s.parent, branch.id);
  } finally { rmSync(projectsDir, { recursive: true, force: true }); }
});

// --- 15: agent label "<task_id> · <role>" from tasks.jsonl row matching agent_id ---

test('agent label is "<task_id> · <role>" when a tasks.jsonl row has matching agent_id', () => {
  const proj = VAULT_MUNGED;
  const sid = 'sess-taskrow';
  const aid = 'a-taskrow';
  const cwd = VAULT_CWD_BACK;
  const projectsDir = makeProject({
    [proj]: {
      [sid]: {
        lines: [{ type: 'user', cwd, gitBranch: 'main', message: { content: 'go' } }],
        subagents: {
          [aid]: { lines: [{ type: 'user', cwd, message: { content: 'go' } }], meta: { description: 'generic desc', model: 'haiku', spawnDepth: 1 } },
        },
      },
    },
  });
  try {
    const tasks = [{ ts: '2026-10-07T12:00:00Z', task_id: 'T99-foo', role: 'engineer', agent_id: aid, dispatcher: 'claude-subagent' }];
    const g = snapshot({ now: NOW, projectsDir, fleetRuns: realRepoRoot + '\\fleet', terminals: [], tasks, workers: [], hermesOnline: false });
    const a = g.nodes.find((n) => n.id === 'agent:sub:' + aid);
    assert.ok(a, 'agent exists');
    assert.equal(a.label, 'T99-foo · engineer');
  } finally {
    rmSync(projectsDir, { recursive: true, force: true });
  }
});

// --- exported surface ---

test('exports: snapshot, folderOf, classifyState, NODE_KINDS, STATE_ORDER, EDGE_KINDS, ACTIVE_MS', () => {
  assert.equal(typeof snapshot, 'function');
  assert.equal(typeof folderOf, 'function');
  assert.equal(typeof classifyState, 'function');
  assert.ok(NODE_KINDS && typeof NODE_KINDS === 'object');
  assert.ok(EDGE_KINDS && typeof EDGE_KINDS === 'object');
  assert.ok(Array.isArray(STATE_ORDER));
  assert.equal(STATE_ORDER.join(','), 'active,idle,monitoring');
  assert.equal(typeof ACTIVE_MS, 'number');
});

// --- T1-provider-identity: provider field on session nodes + label rule B ---

test('T1: terminal with agentIdentity "antigravity" yields provider "antigravity" and label "Antigravity"', () => {
  // Per spec: a non-claude terminal renders with the product name as label,
  // the raw title in `sub`, and `provider` lowercased on the session node.
  const g = snapshot({
    now: NOW,
    projectsDir: makeProject({}),
    fleetRuns: realRepoRoot + '\\fleet',
    terminals: [{
      handle: 'term_antgrava-1111-2222-3333-444444444444',
      connected: true, orphaned: false,
      branch: 'refs/heads/main',
      worktreePath: VAULT_CWD_FWD,
      title: 'next-server (v16.3.0)',
      lastOutputAt: NOW - 1000,
      agentIdentity: 'antigravity',
    }],
    tasks: [],
    workers: [],
    hermesOnline: false,
  });
  const s = g.nodes.find((n) => n.id === 'session:orca:antgrava');
  assert.ok(s, 'antigravity session exists');
  assert.equal(s.provider, 'antigravity', 'provider lowercased');
  assert.equal(s.badge, 'orca', 'badge unchanged: still orca (dispatch mechanism)');
  // Label rule B: non-claude -> the product name.
  assert.equal(s.label, 'Antigravity', 'label is the capitalised product name, got: ' + s.label);
  // Raw title is preserved in `sub`.
  assert.ok(/next-server/i.test(String(s.sub || '')), 'sub carries the raw terminal title, got: ' + s.sub);
});

test('T1: terminal with agentIdentity "claude" keeps its title-derived label and badge "orca"', () => {
  // Today's behaviour for claude sessions is unchanged: title (stripped) is
  // the label, sub = "active · <branch|folder>". The provider field is set
  // for routing logos, but the label rule treats claude as the special case.
  const g = snapshot({
    now: NOW,
    projectsDir: makeProject({}),
    fleetRuns: realRepoRoot + '\\fleet',
    terminals: [{
      handle: 'term_claudese-1111-2222-3333-444444444444',
      connected: true, orphaned: false,
      branch: 'refs/heads/main',
      worktreePath: VAULT_CWD_FWD,
      title: '◐ Fleet monitor spawning and naming',
      lastOutputAt: NOW - 1000,
      agentIdentity: 'claude',
    }],
    tasks: [],
    workers: [],
    hermesOnline: false,
  });
  const s = g.nodes.find((n) => n.id === 'session:orca:claudese');
  assert.ok(s, 'claude session exists');
  assert.equal(s.provider, 'claude');
  assert.equal(s.badge, 'orca');
  // Label = stripped title (today's behaviour, unchanged).
  assert.equal(s.label, 'Fleet monitor spawning and naming', 'label is the stripped title for claude, got: ' + s.label);
  // sub = "<state> · <branch|folder>".
  assert.ok(/active · /.test(String(s.sub || '')), 'sub keeps the active prefix, got: ' + s.sub);
});

test('T1: terminal with no agentIdentity yields provider "unknown" and does not crash', () => {
  // Closed terminals do not always carry agentIdentity; the render must not
  // throw and must still produce a labeled node. The label stays the title
  // (claude behaves like claude, but provider routing shows a neutral chip).
  const g = snapshot({
    now: NOW,
    projectsDir: makeProject({}),
    fleetRuns: realRepoRoot + '\\fleet',
    terminals: [{
      handle: 'term_unknownx-1111-2222-3333-444444444444',
      connected: true, orphaned: false,
      branch: 'refs/heads/main',
      worktreePath: VAULT_CWD_FWD,
      title: 'anonymous terminal',
      lastOutputAt: NOW - 1000,
      // no agentIdentity
    }],
    tasks: [],
    workers: [],
    hermesOnline: false,
  });
  const s = g.nodes.find((n) => n.id === 'session:orca:unknownx');
  assert.ok(s, 'unknown session exists');
  assert.equal(s.provider, 'unknown', 'no identity -> provider "unknown"');
  assert.equal(s.badge, 'orca');
  // Unknown falls back to today's claude-style label (raw title).
  assert.equal(s.label, 'anonymous terminal', 'unknown uses stripped title as label, got: ' + s.label);
});

test('T1: providerOf helper returns "unknown" for missing agentIdentity and lowercases for known values', () => {
  // Pure helper check: contract is "never null/undefined", always a string.
  assert.equal(providerOf({}), 'unknown', 'no agentIdentity -> unknown');
  assert.equal(providerOf({ agentIdentity: '' }), 'unknown', 'empty string -> unknown');
  assert.equal(providerOf({ agentIdentity: '   ' }), 'unknown', 'whitespace -> unknown');
  assert.equal(providerOf({ agentIdentity: 'Antigravity' }), 'antigravity', 'mixed-case -> lowercased');
  assert.equal(providerOf({ agentIdentity: 'codex' }), 'codex');
  assert.equal(providerOf(null), 'unknown', 'null terminal -> unknown (defensive)');
  // providerLabel: capitalises known provider ids and falls back to 'Unknown'.
  assert.equal(providerLabel('antigravity'), 'Antigravity');
  assert.equal(providerLabel('codex'), 'Codex');
  assert.equal(providerLabel('claude'), 'Claude');
  assert.equal(providerLabel('cursor'), 'Cursor');
  assert.equal(providerLabel('openai'), 'OpenAI');
  assert.equal(providerLabel('unknown'), 'Unknown');
  assert.equal(providerLabel('something-unknown'), 'Unknown');
});

test('T1: two Antigravity terminals in one folder/branch are disambiguated', () => {
  // Two agents of the same provider in the same worktree need to stay
  // distinguishable in the canvas. The server appends a non-default branch
  // (or the terminal handle tail) to the product label for the second+ one.
  const g = snapshot({
    now: NOW,
    projectsDir: makeProject({}),
    fleetRuns: realRepoRoot + '\\fleet',
    terminals: [
      {
        handle: 'term_agfirst01-1111-2222-3333-444444444444',
        connected: true, orphaned: false,
        branch: 'refs/heads/feat-x',
        worktreePath: VAULT_CWD_FWD,
        title: 'first antigravity', lastOutputAt: NOW - 1000,
        agentIdentity: 'antigravity',
      },
      {
        handle: 'term_agsecond2-1111-2222-3333-444444444444',
        connected: true, orphaned: false,
        branch: 'refs/heads/feat-x',
        worktreePath: VAULT_CWD_FWD,
        title: 'second antigravity', lastOutputAt: NOW - 1000,
        agentIdentity: 'antigravity',
      },
    ],
    tasks: [],
    workers: [],
    hermesOnline: false,
  });
  const fs = g.nodes.find((n) => n.id === 'session:orca:agfirst0');
  const ss = g.nodes.find((n) => n.id === 'session:orca:agsecond');
  assert.ok(fs && ss, 'both antigravity sessions exist, ids were: ' + g.nodes.map((n) => n.id).join(','));
  assert.equal(fs.provider, 'antigravity');
  assert.equal(ss.provider, 'antigravity');
  // First has bare label; second has a disambiguator appended.
  assert.equal(fs.label, 'Antigravity', 'first session has bare product name, got: ' + fs.label);
  assert.ok(/Antigravity · /.test(String(ss.label || '')), 'second session has product name + disambiguator, got: ' + ss.label);
  // Sub preserves the raw title for both.
  assert.ok(/first antigravity/i.test(String(fs.sub || '')));
  assert.ok(/second antigravity/i.test(String(ss.sub || '')));
});

// --- hermetic: server.mjs is importable without binding a port ---

test('importing server.mjs does not bind a port and does not throw', async () => {
  // The whole test file is this; if we got here, it didn't bind.  Just assert
  // that NODE_KINDS contains the expected set.
  assert.ok(NODE_KINDS.session && NODE_KINDS.agent && NODE_KINDS.folder && NODE_KINDS.branch && NODE_KINDS.hermes);
});

// --- T1b Defect 1 (a): long parent transcript, notification in FIRST 10 KB hides a stale agent ---

test('Defect 1 (a): parent transcript > 200 KB with completed notification in first 10 KB hides a stale agent', () => {
  // The old readCompletedAgents only read the last 131072 bytes. In a long
  // orchestrator session, the notification for an early subagent is older
  // than that, so it was missed and the agent rendered as idle. With the
  // incremental whole-file scan, the early notification is found and the
  // stale subagent is hidden.
  const proj = 'C--AI-' + VAULT + '-Some-Repo-Defect1a';
  const sid = 'sess-defect1a';
  const aid = 'a-defect1a-stale';
  const cwd = 'C:\\AI\\' + VAULT + '\\Some\\Repo-Defect1a';
  // First line carries the notification (lives in the first ~1 KB).
  // Second line pads the file past 200 KB.
  const longJunk = 'x'.repeat(220000);
  const projectsDir = makeProject({
    [proj]: {
      [sid]: {
        lines: [
          { type: 'user', cwd, gitBranch: 'main', message: { content: '<task-notification><task-id>' + aid + '</task-id><status>completed</status><summary>done long ago</summary></task-notification>' } },
          { type: 'user', cwd, message: { content: longJunk } },
        ],
        subagents: {
          [aid]: { lines: [{ type: 'user', cwd, message: { content: 'old' } }], meta: { description: 'd', model: 'haiku', spawnDepth: 1 } },
        },
      },
    },
  });
  try {
    const sp = join(projectsDir, proj, sid + '.jsonl');
    const ap = join(projectsDir, proj, sid, 'subagents', 'agent-' + aid + '.jsonl');
    // Future-ish "now" so the parent transcript mtime sits in the past
    // (fresh) for the TTL check.
    const FUTURE_M = NOW + 5000;
    setMtime(sp, 0, FUTURE_M); // mtime = FUTURE_M
    // Subagent is stale (past ACTIVE_MS=3min) but within SESSION_TTL_MS.
    setMtime(ap, 30 * 60 * 1000, FUTURE_M);
    const g = snapshot({ now: FUTURE_M, projectsDir, fleetRuns: realRepoRoot + '\\fleet', terminals: [], tasks: [], workers: [], hermesOnline: false });
    // Sanity: the file really is > 200 KB
    const sz = statSync(sp).size;
    assert.ok(sz > 200000, 'parent transcript is > 200 KB, got ' + sz);
    const child = g.nodes.find((n) => n.id === 'agent:sub:' + aid);
    assert.equal(child, undefined, 'subagent with early completed notification must be hidden even when parent is > 200 KB');
  } finally { rmSync(projectsDir, { recursive: true, force: true }); }
});

// --- T1b Defect 1 (b): incremental - appending a failed notification hides a previously-idle agent ---

test('Defect 1 (b): incremental - appending a failed notification for agent Y hides Y on the next snapshot', () => {
  // First snapshot caches (path -> {size, latest}). When the parent file
  // grows, the next snapshot must read the appended bytes and update the
  // latest-status map, so the agent is hidden.
  //
  // T1-active-only update: the agent is stale (mtime 30 min ago) so it is
  // already idle, and idle sessions/agents are hidden by the active-only
  // filter — regardless of whether the parent has a completed notification.
  // The "previously visible" half of this test therefore changes shape: the
  // first snapshot now also returns no Y node, but the incremental scan is
  // still exercised (the second snapshot still re-reads the appended
  // notification). The hidden-in-both-snapshots contract is what this test
  // pins today; future code that loosens the filter (or shortens the idle
  // window) will trip the assertion if the read stops working.
  const proj = 'C--AI-' + VAULT + '-Some-Repo-Defect1b';
  const sid = 'sess-defect1b';
  const aidY = 'a-defect1b-newly-failed';
  const cwd = 'C:\\AI\\' + VAULT + '\\Some\\Repo-Defect1b';
  const projectsDir = makeProject({
    [proj]: {
      [sid]: {
        lines: [{ type: 'user', cwd, gitBranch: 'main', message: { content: 'go' } }],
        subagents: {
          [aidY]: { lines: [{ type: 'user', cwd, message: { content: 'old' } }], meta: { description: 'd', model: 'haiku', spawnDepth: 1 } },
        },
      },
    },
  });
  try {
    const sp = join(projectsDir, proj, sid + '.jsonl');
    const ap = join(projectsDir, proj, sid, 'subagents', 'agent-' + aidY + '.jsonl');
    // Future-ish "now" so the parent transcript mtime is in the past (fresh).
    const FUTURE_M = NOW + 5000;
    setMtime(sp, 0, FUTURE_M); // mtime = FUTURE_M
    setMtime(ap, 30 * 60 * 1000, FUTURE_M); // 30 min stale

    // 1) First snapshot: no notification yet -> Y is idle -> hidden by
    //    T1-active-only filter (was: visible with state 'idle' before the
    //    filter was added).
    let g = snapshot({ now: FUTURE_M, projectsDir, fleetRuns: realRepoRoot + '\\fleet', terminals: [], tasks: [], workers: [], hermesOnline: false });
    let yNode = g.nodes.find((n) => n.id === 'agent:sub:' + aidY);
    assert.equal(yNode, undefined, 'Y is hidden while idle (T1-active-only filter supersedes "visible idle" semantics)');

    // 2) Append a failed notification for Y. Real mtime is "now" (real
    // time of the test), still well before FUTURE_M, so TTL check passes.
    const newLine = JSON.stringify({
      type: 'user', cwd,
      message: { content: '<task-notification><task-id>' + aidY + '</task-id><status>failed</status><summary>oops</summary></task-notification>' },
    });
    writeFileSync(sp, '\n' + newLine, { flag: 'a' });
    setMtime(sp, 0, FUTURE_M); // keep parent mtime at FUTURE_M (fresh)

    // 3) Second snapshot: incremental read must still hide Y (still stale
    //    AND now completed).
    g = snapshot({ now: FUTURE_M, projectsDir, fleetRuns: realRepoRoot + '\\fleet', terminals: [], tasks: [], workers: [], hermesOnline: false });
    yNode = g.nodes.find((n) => n.id === 'agent:sub:' + aidY);
    assert.equal(yNode, undefined, 'Y is still hidden after the incremental scan picked up the failed notification');
  } finally { rmSync(projectsDir, { recursive: true, force: true }); }
});

// --- T1c Defect 1 (a): long preamble -> first usable prompt sits past 20 KB and becomes the label ---

test('Defect 1a (a): transcript whose first usable prompt starts after 20 KB of non-prompt lines -> label is that prompt', () => {
  // The old readLabels read the first 8 KB only. Sessions df2da31b and
  // f0ba63f2 had ai-titles + attachments totalling >13 KB before the first
  // real prompt, so the old render labelled them "session <sid8>". After the
  // fix, the head scan extends to 256 KB, so the prompt at ~20 KB wins.
  const proj = VAULT_MUNGED;
  const sid = 'sess-t1c-1a';
  const cwd = VAULT_CWD_BACK;
  // Filler = non-ai-title, non-user rows (assistant messages with tool calls
  // are realistic; ai-title lines would win as the label per A5). 400 lines
  // take ~22 KB, pushing the real prompt past 20 KB. We deliberately put NO
  // user message in the first 20 KB so the first usable prompt is the one
  // we want to verify.
  const filler = [];
  for (let i = 0; i < 400; i++) {
    filler.push({ type: 'assistant', message: { model: 'haiku', content: [{ type: 'tool_use', name: 'Bash', input: { cmd: 'long running snapshot tool call ' + i } }] } });
  }
  const projectsDir = makeProject({
    [proj]: {
      [sid]: {
        lines: [
          ...filler,
          { type: 'user', cwd, gitBranch: 'main', message: { content: 'plan the issue copy u still remember' } },
        ],
      },
    },
  });
  try {
    const sp = join(projectsDir, proj, sid + '.jsonl');
    const sz = statSync(sp).size;
    assert.ok(sz > 20000, 'preamble pushes the real prompt past 20 KB, got ' + sz);
    const g = snapshot({ now: NOW, projectsDir, fleetRuns: realRepoRoot + '\\fleet', terminals: [], tasks: [], workers: [], hermesOnline: false });
    const s = g.nodes.find((n) => n.id === 'session:' + sid);
    assert.ok(s, 'session exists');
    assert.equal(s.label, 'plan the issue copy u still remember');
  } finally { rmSync(projectsDir, { recursive: true, force: true }); }
});

// --- T1c Defect 1 (b): 'claude --resume ...' first prompt is skipped, next prompt wins ---

test('Defect 1b (b): transcript whose first prompt is "claude --resume abc" and whose second is "fix the build" -> label "fix the build"', () => {
  // f0ba63f2's first prompt started with "claude --resume c5546f44-...".
  // The old filter skipped <local-command / [SYSTEM / <system / [Request
  // interrupted but NOT 'claude ' or '/'. After the fix, both are skipped and
  // the second prompt becomes the label.
  const proj = VAULT_MUNGED;
  const sid = 'sess-t1c-1b';
  const cwd = VAULT_CWD_BACK;
  const projectsDir = makeProject({
    [proj]: {
      [sid]: {
        lines: [
          { type: 'user', cwd, gitBranch: 'main', message: { content: 'claude --resume c5546f44-7713-497d-9a8a-0d1f297bd4a2' } },
          { type: 'user', cwd, message: { content: 'fix the build' } },
        ],
      },
    },
  });
  try {
    const g = snapshot({ now: NOW, projectsDir, fleetRuns: realRepoRoot + '\\fleet', terminals: [], tasks: [], workers: [], hermesOnline: false });
    const s = g.nodes.find((n) => n.id === 'session:' + sid);
    assert.ok(s, 'session exists');
    assert.equal(s.label, 'fix the build');
  } finally { rmSync(projectsDir, { recursive: true, force: true }); }
});

// --- T1c Defect 2: member edges are static even when the target is active ---

test('Defect 2 (c): a member edge whose target is active has data.animated === false', () => {
  // Per plan 3.3: member edges are static (animated=false, flow=false). The
  // old addEdge() computed animated for every kind from the child's state, so
  // member edges animated when the target was active. The fix forces
  // animated=false for member.
  const proj = VAULT_MUNGED;
  const sidHub = 'sess-t1c-hub';
  const sidActive = 'sess-t1c-active';
  const cwd = VAULT_CWD_BACK;
  const projectsDir = makeProject({
    [proj]: {
      [sidHub]: { lines: [{ type: 'user', cwd, gitBranch: 'main', message: { content: 'hub session here' } }] },
      [sidActive]: { lines: [{ type: 'user', cwd, gitBranch: 'main', message: { content: 'active session here' } }] },
    },
  });
  try {
    const hp = join(projectsDir, proj, sidHub + '.jsonl');
    const ap = join(projectsDir, proj, sidActive + '.jsonl');
    setMtime(hp, 30 * 1000, NOW); // hub: active (within ACTIVE_MS)
    setMtime(ap, 30 * 1000, NOW); // target: active
    const g = snapshot({ now: NOW, projectsDir, fleetRuns: realRepoRoot + '\\fleet', terminals: [], tasks: [], workers: [], hermesOnline: false });
    const memberEdges = g.edges.filter((e) => e.kind === 'member');
    assert.ok(memberEdges.length >= 1, 'at least one member edge, got ' + memberEdges.length);
    const activeTarget = memberEdges.find((e) => {
      const t = g.nodes.find((n) => n.id === e.to);
      return t && t.state === 'active';
    });
    assert.ok(activeTarget, 'member edge exists whose target is active');
    assert.equal(activeTarget.data.animated, false, 'member edge animated must be false');
    assert.equal(activeTarget.data.flow, false, 'member edge flow must be false');
    // sanity: tree/spawn edges still animate when the child is active
    // (verified by the spawn-edge test above)
  } finally { rmSync(projectsDir, { recursive: true, force: true }); }
});

// --- T1b Defect 2 (c): forward-slash terminal and backslash transcript share one folder node ---

test('Defect 2 (c): terminal worktreePath with forward slashes and transcript cwd with backslashes share ONE folder node', () => {
  // Orca returns worktreePath with forward slashes ('C:/X/Repo'); transcript
  // cwd uses backslashes ('C:\\X\\Repo'). After normFolder, they collapse
  // to one folder node.
  const proj = 'C--AI-' + VAULT + '-Some-Repo-Defect2c';
  const sid = 'sess-defect2c';
  const cwdBack = 'C:\\AI\\' + VAULT + '\\Some\\Repo-Defect2c';
  const worktreeFwd = 'C:/AI/' + VAULT + '/Some/Repo-Defect2c';
  const projectsDir = makeProject({
    [proj]: {
      [sid]: {
        lines: [{ type: 'user', cwd: cwdBack, gitBranch: 'main', message: { content: 'in repo defect2c' } }],
      },
    },
  });
  try {
    const FUTURE_M = NOW + 5000;
    setMtime(join(projectsDir, proj, sid + '.jsonl'), 0, FUTURE_M);
    const g = snapshot({
      now: FUTURE_M,
      projectsDir,
      fleetRuns: realRepoRoot + '\\fleet',
      terminals: [{
        handle: 'term_d2c-1111-2222-3333-444444444444',
        connected: true, orphaned: false,
        branch: 'refs/heads/main',
        worktreePath: worktreeFwd,
        title: '◐ in repo defect2c',
        lastOutputAt: FUTURE_M - 1000,
      }],
      tasks: [],
      workers: [],
      hermesOnline: false,
    });
    const folders = g.nodes.filter((n) => n.kind === 'folder');
    assert.equal(folders.length, 1, 'exactly one folder node, got: ' + folders.map((f) => f.folder).join('|'));
    const f = folders[0];
    assert.ok(!/\//.test(String(f.folder || '')), 'folder has no forward slashes, got: ' + f.folder);
    assert.ok(!/\\$/.test(String(f.folder || '')), 'folder has no trailing backslash, got: ' + f.folder);
    assert.ok(/Some[\\]Repo-Defect2c$/.test(f.folder), 'folder ends with Some\\Repo-Defect2c, got: ' + f.folder);
    // The terminal's folder field also uses the normalized folder path
    const orca = g.nodes.find((n) => n.badge === 'orca');
    assert.ok(orca, 'orca session exists');
    assert.ok(!/\//.test(String(orca.folder || '')), 'orca session folder has no forward slashes, got: ' + orca.folder);
  } finally { rmSync(projectsDir, { recursive: true, force: true }); }
});
// --- T1-active-only: A) idle hidden, active/monitoring kept ---

test('T1-active-only: idle session is hidden; active session is visible', () => {
  // Two sessions in the same folder, one fresh (active) and one stale (idle).
  // T1-active-only filter: only the active one survives; the idle one is
  // dropped, the folder container is kept (it has a live descendant).
  const proj = VAULT_MUNGED;
  const cwd = VAULT_CWD_BACK;
  const sidActive = 'sess-active';
  const sidIdle = 'sess-idle';
  const projectsDir = makeProject({
    [proj]: {
      [sidActive]: { lines: [{ type: 'user', cwd, gitBranch: 'main', message: { content: 'active session' } }] },
      [sidIdle]:    { lines: [{ type: 'user', cwd, gitBranch: 'main', message: { content: 'idle session' } }] },
    },
  });
  try {
    const ap = join(projectsDir, proj, sidActive + '.jsonl');
    const ip = join(projectsDir, proj, sidIdle + '.jsonl');
    setMtime(ap, 30 * 1000, NOW);             // fresh -> active
    setMtime(ip, 30 * 60 * 1000, NOW);        // 30 min -> idle
    const g = snapshot({ now: NOW, projectsDir, fleetRuns: realRepoRoot + '\\fleet', terminals: [], tasks: [], workers: [], hermesOnline: false });
    const a = g.nodes.find((n) => n.id === 'session:' + sidActive);
    const i = g.nodes.find((n) => n.id === 'session:' + sidIdle);
    assert.ok(a, 'active session is visible');
    assert.equal(a.state, 'active');
    assert.equal(i, undefined, 'idle session is hidden by T1-active-only filter');
    // folder survives (it has a live descendant)
    const folder = g.nodes.find((n) => n.kind === 'folder');
    assert.ok(folder, 'folder kept because it contains the active session');
  } finally { rmSync(projectsDir, { recursive: true, force: true }); }
});

test('T1-active-only: monitoring session is visible (parent with active child)', () => {
  // Spec item A: "monitoring stays visible — it means work is running underneath it."
  // Build a stale parent with a fresh active subagent; the parent becomes
  // 'monitoring' via the bubble loop, and the active-only filter keeps it.
  const proj = VAULT_MUNGED;
  const cwd = VAULT_CWD_BACK;
  const sid = 'sess-monitoring-parent';
  const aid = 'a-monitoring-child';
  const projectsDir = makeProject({
    [proj]: {
      [sid]: {
        lines: [{ type: 'user', cwd, gitBranch: 'main', message: { content: 'parent' } }],
        subagents: {
          [aid]: { lines: [{ type: 'user', cwd, message: { content: 'child' } }], meta: { description: 'd', model: 'haiku', spawnDepth: 1 } },
        },
      },
    },
  });
  try {
    const sp = join(projectsDir, proj, sid + '.jsonl');
    const ap = join(projectsDir, proj, sid, 'subagents', 'agent-' + aid + '.jsonl');
    setMtime(sp, 60 * 60 * 1000, NOW);   // parent: 1h stale -> idle initially
    setMtime(ap, 30 * 1000, NOW);        // child: fresh -> active
    const g = snapshot({ now: NOW, projectsDir, fleetRuns: realRepoRoot + '\\fleet', terminals: [], tasks: [], workers: [], hermesOnline: false });
    const parent = g.nodes.find((n) => n.id === 'session:' + sid);
    const child = g.nodes.find((n) => n.id === 'agent:sub:' + aid);
    assert.ok(parent, 'monitoring parent is kept');
    assert.equal(parent.state, 'monitoring', 'parent state is monitoring (child is active)');
    assert.ok(child, 'active child is kept');
    assert.equal(child.state, 'active');
    // member edge NOT expected: there is only one session in this folder
    const memberEdges = g.edges.filter((e) => e.kind === 'member');
    assert.equal(memberEdges.length, 0, 'no member edge: only one session in folder');
  } finally { rmSync(projectsDir, { recursive: true, force: true }); }
});

test('T1-active-only: folder with only idle sessions is absent; same folder with one active session appears with that branch', () => {
  // Spec item D: a folder whose every session is idle carries no visible
  // descendants and is therefore not emitted. The second case adds one
  // active session to the same folder and the folder + branch appear.
  const proj = VAULT_MUNGED;
  const cwd = VAULT_CWD_BACK;
  const projectsDir = makeProject({
    [proj]: {
      ['sess-only-idle']: { lines: [{ type: 'user', cwd, gitBranch: 'main', message: { content: 'idle' } }] },
    },
  });
  try {
    const ip = join(projectsDir, proj, 'sess-only-idle' + '.jsonl');
    setMtime(ip, 30 * 60 * 1000, NOW);
    const g1 = snapshot({ now: NOW, projectsDir, fleetRuns: realRepoRoot + '\\fleet', terminals: [], tasks: [], workers: [], hermesOnline: false });
    const folders1 = g1.nodes.filter((n) => n.kind === 'folder');
    const branches1 = g1.nodes.filter((n) => n.kind === 'branch');
    assert.equal(folders1.length, 0, 'no folder emitted: every session in it is idle');
    assert.equal(branches1.length, 0, 'no branch emitted either');

    // Now write an active session into the same project/fixture and snap again.
    const apath = join(projectsDir, proj, 'sess-with-active.jsonl');
    writeFileSync(apath,
      JSON.stringify({ type: 'user', cwd, gitBranch: 'main', message: { content: 'active' } }) + '\n');
    setMtime(apath, 30 * 1000, NOW);
    const g2 = snapshot({ now: NOW, projectsDir, fleetRuns: realRepoRoot + '\\fleet', terminals: [], tasks: [], workers: [], hermesOnline: false });
    const folder2 = g2.nodes.find((n) => n.kind === 'folder');
    const branch2 = g2.nodes.find((n) => n.kind === 'branch' && n.label === 'main');
    assert.ok(folder2, 'folder emitted when at least one descendant is active');
    assert.ok(branch2, 'branch "main" emitted alongside the active session');
    // The active session must be the only session in the graph.
    const sessions2 = g2.nodes.filter((n) => n.kind === 'session');
    assert.equal(sessions2.length, 1, 'only the active session survives');
    assert.equal(sessions2[0].id, 'session:sess-with-active');
  } finally { rmSync(projectsDir, { recursive: true, force: true }); }
});

// --- T1-active-only: B) self-test probe filter ---

test('T1-active-only: isHarnessProbe matches the harness self-test pattern', () => {
  // Pure helper check. The exact shape we see in the wild is "Using your
  // Bash tool, run exactly this command: echo PROBE<hex>". Match the spec
  // regex: /^Using your Bash tool, run exactly this command:\s*echo PROBE[0-9A-F]{6}/i
  assert.equal(isHarnessProbe('Using your Bash tool, run exactly this command: echo PROBE1A2B3C'), true, '6-hex uppercase matches');
  assert.equal(isHarnessProbe('Using your Bash tool, run exactly this command: echo PROBEabcdef'), true, '6-hex lowercase matches');
  assert.equal(isHarnessProbe('Using your Bash tool, run exactly this command:   echo PROBE0F1E2D'), true, 'extra whitespace tolerated');
  assert.equal(isHarnessProbe('Using your Bash tool, run exactly this command: echo PROBE1A2B3'), false, '5 hex chars is too short');
  assert.equal(isHarnessProbe('Using your Bash tool, run exactly this command: echo NOPEB1A2B3C'), false, 'wrong prefix word');
  assert.equal(isHarnessProbe('hello world'), false, 'unrelated prompt');
  assert.equal(isHarnessProbe(''), false, 'empty string is not a probe');
  assert.equal(isHarnessProbe(null), false, 'null is not a probe');
  assert.equal(isHarnessProbe(undefined), false, 'undefined is not a probe');
  // Exported regex sanity-check: pattern is the same.
  assert.ok(PROBE_PROMPT_RE instanceof RegExp, 'PROBE_PROMPT_RE is exported as a RegExp');
});

test('T1-active-only: self-test (PROBE) transcript produces no node; a normal transcript in the same scan does', () => {
  // Drop two sessions into the same project: one with a PROBE prompt, one
  // with a normal prompt. The probe is filtered at session→node time using
  // the already-loaded firstPrompt — no extra file read. Only the normal
  // session shows up.
  const proj = VAULT_MUNGED;
  const cwd = VAULT_CWD_BACK;
  const sidProbe = 'sess-probe';
  const sidNormal = 'sess-normal';
  const projectsDir = makeProject({
    [proj]: {
      [sidProbe]:  { lines: [{ type: 'user', cwd, gitBranch: 'main', message: { content: 'Using your Bash tool, run exactly this command: echo PROBE1A2B3C' } }] },
      [sidNormal]: { lines: [{ type: 'user', cwd, gitBranch: 'main', message: { content: 'plan the issue copy u still remember' } }] },
    },
  });
  try {
    const pp = join(projectsDir, proj, sidProbe + '.jsonl');
    const np = join(projectsDir, proj, sidNormal + '.jsonl');
    setMtime(pp, 30 * 1000, NOW);
    setMtime(np, 30 * 1000, NOW);
    const g = snapshot({ now: NOW, projectsDir, fleetRuns: realRepoRoot + '\\fleet', terminals: [], tasks: [], workers: [], hermesOnline: false });
    const probe = g.nodes.find((n) => n.id === 'session:' + sidProbe);
    const normal = g.nodes.find((n) => n.id === 'session:' + sidNormal);
    assert.equal(probe, undefined, 'PROBE session produces no node');
    assert.ok(normal, 'normal session is visible');
    assert.equal(normal.label, 'plan the issue copy u still remember');
  } finally { rmSync(projectsDir, { recursive: true, force: true }); }
});

// --- T1-active-only: C) transcript-only session has provider 'claude' ---

test('T1-active-only: transcript-only session has provider "claude"', () => {
  // Spec item C: transcript-only session nodes (no Orca terminal) get
  // provider 'claude' — they are Claude Code by definition. The UI's
  // ProviderChip then renders the claude mark instead of the '?' unknown
  // chip. We force the session to be active (mtime within ACTIVE_MS) so
  // the active-only filter keeps it around.
  const proj = VAULT_MUNGED;
  const cwd = VAULT_CWD_BACK;
  const sid = 'sess-transcript-only';
  const projectsDir = makeProject({
    [proj]: {
      [sid]: { lines: [{ type: 'user', cwd, gitBranch: 'main', message: { content: 'plain transcript' } }] },
    },
  });
  try {
    setMtime(join(projectsDir, proj, sid + '.jsonl'), 30 * 1000, NOW);
    const g = snapshot({ now: NOW, projectsDir, fleetRuns: realRepoRoot + '\\fleet', terminals: [], tasks: [], workers: [], hermesOnline: false });
    const s = g.nodes.find((n) => n.id === 'session:' + sid);
    assert.ok(s, 'transcript-only session exists');
    assert.equal(s.badge, 'claude', 'badge is claude (no Orca terminal)');
    assert.equal(s.provider, 'claude', 'provider is claude (transcript-only)');
  } finally { rmSync(projectsDir, { recursive: true, force: true }); }
});

// --- T1-active-only: E) stats reflect the filtered set ---

test('T1-active-only: stats reflect the filtered set (idle: 0; only active/monitoring counted)', () => {
  // Build a graph with two active sessions and one stale (idle) session in
  // the same folder. After filtering, stats must show 2 active, 0 idle,
  // 0 monitoring, 2 sessions, 0 agents, 1 folder, 1 branch.
  const proj = VAULT_MUNGED;
  const cwd = VAULT_CWD_BACK;
  const projectsDir = makeProject({
    [proj]: {
      ['sess-a1']: { lines: [{ type: 'user', cwd, gitBranch: 'main', message: { content: 'a1' } }] },
      ['sess-a2']: { lines: [{ type: 'user', cwd, gitBranch: 'main', message: { content: 'a2' } }] },
      ['sess-i1']: { lines: [{ type: 'user', cwd, gitBranch: 'main', message: { content: 'i1' } }] },
    },
  });
  try {
    setMtime(join(projectsDir, proj, 'sess-a1.jsonl'), 30 * 1000, NOW);
    setMtime(join(projectsDir, proj, 'sess-a2.jsonl'), 30 * 1000, NOW);
    setMtime(join(projectsDir, proj, 'sess-i1.jsonl'), 30 * 60 * 1000, NOW);
    const g = snapshot({ now: NOW, projectsDir, fleetRuns: realRepoRoot + '\\fleet', terminals: [], tasks: [], workers: [], hermesOnline: false });
    assert.equal(g.stats.active, 2, '2 active sessions');
    assert.equal(g.stats.idle, 0, 'idle is 0 by construction (no terminals, only transcripts)');
    assert.equal(g.stats.monitoring, 0, 'no monitoring sessions in this fixture');
    assert.equal(g.stats.sessions, 2, 'sessions count matches the visible set');
    assert.equal(g.stats.agents, 0);
    assert.equal(g.stats.folders, 1, 'folder kept (has 2 active descendants)');
    assert.equal(g.stats.branches, 1, 'branch kept (has 2 active descendants)');
  } finally { rmSync(projectsDir, { recursive: true, force: true }); }
});

// --- T1-terminals-alive: server-led fix for the "quiet but connected" regression ---
//
// The T1-active-only change hid idle sessions, including LIVE ORCA TERMINALS
// that were merely quiet (e.g. antigravity server that had been running for
// minutes without output). The user wanted idle transcript noise gone, not
// quiet-but-alive terminals. The fix keeps a connected, non-orphaned Orca
// terminal visible regardless of state; the transcript-only rule is unchanged
// (stale transcripts still hide).

test('T1-terminals-alive: connected terminal with OLD lastOutputAt is visible with state idle', () => {
  // Regression of the "now antigravity not detected" report. A connected
  // terminal whose last output is 8 minutes old must still appear; its
  // state is 'idle' (past ACTIVE_MS) but the terminal is alive.
  const g = snapshot({
    now: NOW,
    projectsDir: makeProject({}),
    fleetRuns: realRepoRoot + '\\fleet',
    terminals: [{
      handle: 'term_aaaaaliv-1111-2222-3333-444444444444',
      connected: true, orphaned: false,
      branch: 'refs/heads/main',
      worktreePath: VAULT_CWD_FWD,
      title: 'next-server (v16.3.0)',
      lastOutputAt: NOW - 8 * 60 * 1000, // 8 minutes old
      agentIdentity: 'antigravity',
    }],
    tasks: [],
    workers: [],
    hermesOnline: false,
  });
  const s = g.nodes.find((n) => n.id === 'session:orca:aaaaaliv');
  assert.ok(s, 'quiet-but-connected terminal is visible');
  assert.equal(s.state, 'idle', 'state is idle (lastOutputAt past ACTIVE_MS)');
  assert.equal(s.badge, 'orca', 'badge is orca');
  assert.equal(s.provider, 'antigravity', 'provider field carries through');
  // folder is present because the visible session needs a parent container
  const folder = g.nodes.find((n) => n.kind === 'folder');
  assert.ok(folder, 'folder is present (has a visible descendant)');
});

test('T1-terminals-alive: connected terminal with FRESH lastOutputAt is visible with state active', () => {
  // Baseline: a terminal producing output within ACTIVE_MS is still visible
  // and renders as 'active'. This is the unchanged half of the spec.
  const g = snapshot({
    now: NOW,
    projectsDir: makeProject({}),
    fleetRuns: realRepoRoot + '\\fleet',
    terminals: [{
      handle: 'term_bbbbacti-1111-2222-3333-444444444444',
      connected: true, orphaned: false,
      branch: 'refs/heads/main',
      worktreePath: VAULT_CWD_FWD,
      title: '◐ some live claude session',
      lastOutputAt: NOW - 30 * 1000, // 30s old
      agentIdentity: 'claude',
    }],
    tasks: [],
    workers: [],
    hermesOnline: false,
  });
  const s = g.nodes.find((n) => n.id === 'session:orca:bbbbacti');
  assert.ok(s, 'fresh terminal is visible');
  assert.equal(s.state, 'active', 'state is active (lastOutputAt within ACTIVE_MS)');
  // stats
  assert.equal(g.stats.active, 1);
  assert.equal(g.stats.idle, 0);
});

test('T1-terminals-alive: disconnected and orphaned terminals are hidden', () => {
  // The "terminal is alive" check is connected && !orphaned. A terminal that
  // either disconnected or was marked orphaned is removed by the original
  // `liveTerminals` filter at step 5; it never enters the nodes map.
  const g = snapshot({
    now: NOW,
    projectsDir: makeProject({}),
    fleetRuns: realRepoRoot + '\\fleet',
    terminals: [
      { handle: 'term_ccccdead-1111-2222-3333-444444444444', connected: false, orphaned: false, branch: 'refs/heads/main', worktreePath: VAULT_CWD_FWD, title: 'disconnected', lastOutputAt: NOW - 1000 },
      { handle: 'term_ddddorph-1111-2222-3333-444444444444', connected: true,  orphaned: true,  branch: 'refs/heads/main', worktreePath: VAULT_CWD_FWD, title: 'orphaned', lastOutputAt: NOW - 1000 },
    ],
    tasks: [],
    workers: [],
    hermesOnline: false,
  });
  assert.equal(g.nodes.find((n) => n.id === 'session:orca:ccccdead'), undefined, 'disconnected terminal is hidden');
  assert.equal(g.nodes.find((n) => n.id === 'session:orca:ddddorph'), undefined, 'orphaned terminal is hidden');
  // No folder either — no visible descendants
  assert.equal(g.nodes.filter((n) => n.kind === 'folder').length, 0);
});

test('T1-terminals-alive: idle transcript session is still hidden (transcript rule unchanged)', () => {
  // The transcript rule from T1-active-only is unchanged: a transcript-only
  // session (no live Orca terminal) is hidden when its mtime is past
  // ACTIVE_MS. Only the terminal rule was loosened.
  const proj = VAULT_MUNGED;
  const cwd = VAULT_CWD_BACK;
  const sid = 'sess-t1ta-idle-transcript';
  const projectsDir = makeProject({
    [proj]: {
      [sid]: { lines: [{ type: 'user', cwd, gitBranch: 'main', message: { content: 'stale transcript' } }] },
    },
  });
  try {
    setMtime(join(projectsDir, proj, sid + '.jsonl'), 30 * 60 * 1000, NOW); // 30 min stale
    const g = snapshot({
      now: NOW,
      projectsDir,
      fleetRuns: realRepoRoot + '\\fleet',
      terminals: [], // no live terminals in this scan
      tasks: [], workers: [],
      hermesOnline: false,
    });
    const s = g.nodes.find((n) => n.id === 'session:' + sid);
    assert.equal(s, undefined, 'stale transcript-only session is still hidden by the active-only filter');
    // stats: no live orca terminal in this scan, so idle count is 0
    assert.equal(g.stats.idle, 0, 'idle count = 0 (no live terminals, no visible idle nodes)');
    // folder also absent
    assert.equal(g.nodes.filter((n) => n.kind === 'folder').length, 0, 'folder absent (no visible descendants)');
  } finally { rmSync(projectsDir, { recursive: true, force: true }); }
});

test('T1-terminals-alive: folder with only a quiet-but-connected terminal is present (FooCorp regression)', () => {
  // The exact regression: a folder whose only descendant is a quiet-but-
  // connected terminal (e.g. antigravity) used to disappear because the
  // active-only filter hid the idle session and then the container-prune
  // step hid the folder. The fix keeps the terminal visible, so the folder
  // is present with the quiet terminal inside.
  const g = snapshot({
    now: NOW,
    projectsDir: makeProject({}),
    fleetRuns: realRepoRoot + '\\fleet',
    terminals: [{
      handle: 'term_eeeequie-1111-2222-3333-444444444444',
      connected: true, orphaned: false,
      branch: 'refs/heads/main',
      worktreePath: 'C:/AI/' + VAULT + '/Some/Repo-FooCorp',
      title: 'quiet antigravity server',
      lastOutputAt: NOW - 8 * 60 * 1000, // 8 minutes quiet
      agentIdentity: 'antigravity',
    }],
    tasks: [],
    workers: [],
    hermesOnline: false,
  });
  const folders = g.nodes.filter((n) => n.kind === 'folder');
  assert.equal(folders.length, 1, 'folder present because the only descendant is a visible quiet terminal');
  assert.ok(/FooCorp$/.test(folders[0].folder), 'folder path ends with the client name, got: ' + folders[0].folder);
  const branch = g.nodes.find((n) => n.kind === 'branch' && n.label === 'main');
  assert.ok(branch, 'branch node present');
  // the terminal is inside
  const s = g.nodes.find((n) => n.id === 'session:orca:eeeequie');
  assert.ok(s, 'quiet terminal is the visible descendant of the folder');
  assert.equal(s.state, 'idle', 'terminal is rendered as idle (past ACTIVE_MS)');
  // idle count is honest: 1 quiet terminal
  assert.equal(g.stats.idle, 1, 'idle count = 1 (the visible quiet terminal)');
});

// --- T1-activity-extractor: per-session activity bubble data ---
//
// Spec: every session/agent node may carry
//   activity: { action: string|null, said: string|null, ts: number }
// - transcript-derived sessions + subagent nodes -> read the transcript tail
//   (cached by path+size) and run extractActivity, action+said+ts included.
// - terminal-only sessions (no transcript on disk) -> activity.said from
//   cleanPreview(preview); activity.ts from terminal.lastOutputAt; NO action.
// - the field is OMITTED when nothing is known (action and said both null).

test('T1-activity-extractor: transcript session carries activity with action + said + ts from the transcript tail', () => {
  // Fixture: a session whose transcript ends with an assistant that has BOTH
  // a prose text block AND a tool_use block. extractActivity is the source of
  // both `action` (the tool_use summary) and `said` (the prose, markdown-
  // stripped). `ts` is the timestamp of the source line.
  const proj = VAULT_MUNGED;
  const sid = 'sess-activity-transcript';
  const cwd = VAULT_CWD_BACK;
  const projectsDir = makeProject({
    [proj]: {
      [sid]: {
        lines: [
          { type: 'user', cwd, gitBranch: 'main', message: { content: 'plan the activity bubble' } },
          { type: 'assistant', timestamp: NOW - 30 * 1000, message: { model: 'haiku', content: [
            { type: 'text', text: 'I will inspect monitor/server.test.mjs next' },
            { type: 'tool_use', name: 'Read', input: { file_path: 'monitor/server.test.mjs' } },
          ] } },
        ],
      },
    },
  });
  try {
    setMtime(join(projectsDir, proj, sid + '.jsonl'), 30 * 1000, NOW); // fresh -> active
    const g = snapshot({ now: NOW, projectsDir, fleetRuns: realRepoRoot + '\\fleet', terminals: [], tasks: [], workers: [], hermesOnline: false });
    const s = g.nodes.find((n) => n.id === 'session:' + sid);
    assert.ok(s, 'session exists');
    assert.ok(s.activity, 'activity is attached on a transcript-derived session');
    assert.equal(s.activity.action, 'monitor/server.test.mjs', 'action = summarized tool_use');
    assert.equal(s.activity.said, 'I will inspect monitor/server.test.mjs next', 'said = assistant prose');
    assert.equal(s.activity.ts, NOW - 30 * 1000, 'ts = transcript line timestamp');
  } finally { rmSync(projectsDir, { recursive: true, force: true }); }
});

test('T1-activity-extractor: subagent node carries activity from its own transcript tail', () => {
  // The subagent is an OWN transcript; its activity bubble reflects the
  // subagent's own tool call + said prose, not the parent's.
  const proj = VAULT_MUNGED;
  const sid = 'sess-activity-parent';
  const aid = 'a-activity-engineer';
  const cwd = VAULT_CWD_BACK;
  const projectsDir = makeProject({
    [proj]: {
      [sid]: {
        lines: [{ type: 'user', cwd, gitBranch: 'main', message: { content: 'spawn' } }],
        subagents: {
          [aid]: {
            lines: [
              { type: 'user', cwd, message: { content: 'eng work' } },
              { type: 'assistant', timestamp: 1200, message: { model: 'haiku', content: [
                { type: 'text', text: 'running npm test' },
                { type: 'tool_use', name: 'Bash', input: { command: 'npm test --silent' } },
              ] } },
            ],
            meta: { agentType: 'general-purpose', description: 'tester', model: 'haiku', spawnDepth: 1 },
          },
        },
      },
    },
  });
  try {
    const sp = join(projectsDir, proj, sid + '.jsonl');
    const ap = join(projectsDir, proj, sid, 'subagents', 'agent-' + aid + '.jsonl');
    setMtime(sp, 30 * 1000, NOW);
    setMtime(ap, 30 * 1000, NOW); // fresh -> active
    const g = snapshot({ now: NOW, projectsDir, fleetRuns: realRepoRoot + '\\fleet', terminals: [], tasks: [], workers: [], hermesOnline: false });
    const agent = g.nodes.find((n) => n.id === 'agent:sub:' + aid);
    assert.ok(agent, 'subagent node exists');
    assert.ok(agent.activity, 'subagent carries activity from its own transcript');
    assert.equal(agent.activity.action, 'npm test --silent', 'subagent action from its own Bash tool_use');
    assert.equal(agent.activity.said, 'running npm test', 'subagent said from its own assistant prose');
    assert.equal(agent.activity.ts, 1200, 'ts from subagent transcript line');
  } finally { rmSync(projectsDir, { recursive: true, force: true }); }
});

test('T1-activity-extractor: terminal-only session gets activity.said from preview, ts from lastOutputAt, NO action', () => {
  // No transcript on disk for this terminal. activity comes from the Orca
  // `preview` field. The fixture mirrors the real claude sample: "...push to
  // stg01." survives, "new task? /clear to save 428.1k tokens" and the
  // separator are dropped by cleanPreview. action is null (terminals never
  // carry tool_use in the preview).
  const g = snapshot({
    now: NOW,
    projectsDir: makeProject({}), // no transcripts at all
    fleetRuns: realRepoRoot + '\\fleet',
    terminals: [{
      handle: 'term_activity_only_claude-1111-2222-3333-444444444444',
      connected: true, orphaned: false,
      branch: 'refs/heads/main',
      worktreePath: VAULT_CWD_FWD,
      title: '◐ Fleet activity bubble',
      lastOutputAt: NOW - 1000,
      preview: '...push to stg01.\nnew task? /clear to save 428.1k tokens\n──────',
    }],
    tasks: [],
    workers: [],
    hermesOnline: false,
  });
  const s = g.nodes.find((n) => n.id === 'session:orca:activity_only_claude'.slice(0, 32));
  // session id is derived from handle stripped of 'term_' + first 8 chars;
  // we find by badge+terminal instead so the test stays robust.
  const sess = g.nodes.find((n) => n.badge === 'orca' && n.terminal === 'term_activity_only_claude-1111-2222-3333-444444444444') || s;
  assert.ok(sess, 'terminal-only session exists');
  assert.ok(sess.activity, 'terminal-only session has activity from the preview');
  assert.equal(sess.activity.action, null, 'terminal-derived activity has no action');
  assert.equal(sess.activity.said, '...push to stg01.', 'cleanPreview kept the agent prose and dropped TUI chrome');
  assert.equal(sess.activity.ts, NOW - 1000, 'ts from terminal.lastOutputAt');
  // Sanity: tool results / command output from the preview are NOT in the
  // activity shape. No field leaks the raw preview text.
  for (const k of Object.keys(sess.activity)) {
    const v = sess.activity[k];
    if (typeof v === 'string') {
      assert.ok(!/new task/.test(v), `activity.${k} does not leak TUI chrome, got: ` + v);
      assert.ok(!/tokens/.test(v), `activity.${k} does not leak the token counter, got: ` + v);
    }
  }
});

test('T1-activity-extractor: session with no usable info has NO activity field (omitted)', () => {
  // A transcript whose only entry is a bare user prompt (no assistant
  // responses) has nothing to summarise. extractActivity returns null and
  // the server must OMIT the activity field entirely.
  const proj = VAULT_MUNGED;
  const sid = 'sess-no-activity';
  const cwd = VAULT_CWD_BACK;
  const projectsDir = makeProject({
    [proj]: {
      [sid]: {
        lines: [
          { type: 'user', cwd, gitBranch: 'main', message: { content: 'hi' } },
        ],
      },
    },
  });
  try {
    setMtime(join(projectsDir, proj, sid + '.jsonl'), 30 * 1000, NOW); // active
    const g = snapshot({ now: NOW, projectsDir, fleetRuns: realRepoRoot + '\\fleet', terminals: [], tasks: [], workers: [], hermesOnline: false });
    const sess = g.nodes.find((n) => n.id === 'session:' + sid);
    assert.ok(sess, 'session exists');
    assert.equal(sess.activity, undefined, 'activity field is OMITTED, not null, when nothing is known');
    // A terminal with no useful preview (only chrome + separator) also has
    // activity omitted.
    const g2 = snapshot({
      now: NOW,
      projectsDir: makeProject({}),
      fleetRuns: realRepoRoot + '\\fleet',
      terminals: [{
        handle: 'term_noactivity-1111-2222-3333-444444444444',
        connected: true, orphaned: false,
        branch: 'refs/heads/main',
        worktreePath: VAULT_CWD_FWD,
        title: 'quiet ui',
        lastOutputAt: NOW - 1000,
        // preview is only chrome -> cleanPreview returns null -> omitted
        preview: 'new task? /clear to save 428.1k tokens\n──────',
      }],
      tasks: [], workers: [], hermesOnline: false,
    });
    const t2 = g2.nodes.find((n) => n.badge === 'orca');
    assert.ok(t2, 'terminal-only session exists');
    assert.equal(t2.activity, undefined, 'terminal session also omits activity when preview is only chrome');
  } finally { rmSync(projectsDir, { recursive: true, force: true }); }
});

// --- T1-truthful-server: freshest source wins + no empty activity + label dedup ---

test('T1-truthful-server: merged node with stale transcript + fresh terminal gets terminal activity (freshest source wins)', () => {
  // T1 rule 1: pick activity from the FRESHER source. Transcript tail is
  // stale (32 min old); terminal is fresh (1 s old) with its own readable
  // preview. The activity should come from the terminal.
  const proj = 'C--AI-my-vault-Agent-Orchestrator';
  const sid = 'sess-merge-terminal-fresh';
  const cwd = 'C:\\AI\\my-vault\\Agent\\Orchestrator';
  const projectsDir = makeProject({
    [proj]: {
      [sid]: {
        lines: [
          { type: 'user', cwd, gitBranch: 'main', message: { content: 'start' } },
          { type: 'ai-title', aiTitle: 'merged session', sessionId: sid },
          { type: 'assistant', timestamp: NOW - 30 * 60 * 1000, message: {
            model: 'haiku',
            content: [{ type: 'text', text: 'STALE old text from transcript' }],
          } },
        ],
      },
    },
  });
  try {
    setMtime(join(projectsDir, proj, sid + '.jsonl'), 30 * 1000, NOW);
    const g = snapshot({
      now: NOW,
      projectsDir,
      fleetRuns: realRepoRoot + '\\fleet',
      terminals: [{
        handle: 'term_mergefresh-1111-2222-3333-444444444444',
        connected: true, orphaned: false,
        branch: 'refs/heads/main',
        worktreePath: 'C:/AI/my-vault/Agent/Orchestrator',
        title: 'merged session',
        lastOutputAt: NOW - 1000, // fresh
        preview: 'fresh terminal prose',
      }],
      tasks: [], workers: [], hermesOnline: false,
    });
    const sess = g.nodes.find((n) => n.badge === 'orca' && n.sessionId === sid);
    assert.ok(sess, 'merged session exists');
    assert.ok(sess.activity, 'activity present');
    assert.equal(sess.activity.said, 'fresh terminal prose', 'said comes from terminal preview');
    assert.ok(sess.activity.ts >= NOW - 5000, 'ts is fresh (within 5s of now), got: ' + sess.activity.ts);
  } finally { rmSync(projectsDir, { recursive: true, force: true }); }
});

test('T1-truthful-server: merged node with fresh transcript + stale terminal gets transcript activity (freshest source wins)', () => {
  // T1 rule 1, opposite direction: transcript is fresh; terminal is stale.
  // Activity comes from the transcript (action + said + ts).
  const proj = 'C--AI-my-vault-Agent-Orchestrator';
  const sid = 'sess-merge-transcript-fresh';
  const cwd = 'C:\\AI\\my-vault\\Agent\\Orchestrator';
  const projectsDir = makeProject({
    [proj]: {
      [sid]: {
        lines: [
          { type: 'user', cwd, gitBranch: 'main', message: { content: 'start' } },
          { type: 'ai-title', aiTitle: 'merged session', sessionId: sid },
          { type: 'assistant', timestamp: NOW - 5 * 1000, message: {
            model: 'haiku',
            content: [
              { type: 'text', text: 'fresh transcript prose' },
              { type: 'tool_use', name: 'Bash', input: { command: 'node --test monitor/activity.test.mjs' } },
            ],
          } },
        ],
      },
    },
  });
  try {
    setMtime(join(projectsDir, proj, sid + '.jsonl'), 30 * 1000, NOW);
    const g = snapshot({
      now: NOW,
      projectsDir,
      fleetRuns: realRepoRoot + '\\fleet',
      terminals: [{
        handle: 'term_mergetrf-1111-2222-3333-444444444444',
        connected: true, orphaned: false,
        branch: 'refs/heads/main',
        worktreePath: 'C:/AI/my-vault/Agent/Orchestrator',
        title: 'merged session',
        lastOutputAt: NOW - 30 * 60 * 1000, // stale
        preview: 'STALE terminal prose',
      }],
      tasks: [], workers: [], hermesOnline: false,
    });
    const sess = g.nodes.find((n) => n.badge === 'orca' && n.sessionId === sid);
    assert.ok(sess, 'merged session exists');
    assert.ok(sess.activity, 'activity present');
    assert.equal(sess.activity.said, 'fresh transcript prose', 'said comes from transcript');
    assert.equal(sess.activity.action, 'node --test monitor/activity.test.mjs', 'action comes from transcript');
    assert.ok(sess.activity.ts >= NOW - 5000, 'ts is fresh (within 5s of now), got: ' + sess.activity.ts);
  } finally { rmSync(projectsDir, { recursive: true, force: true }); }
});

test('T1-truthful-server: merged node with no readable text from either source has NO activity field', () => {
  // T1 rule 2: omit activity entirely when nothing is known. The terminal
  // preview is all chrome (cleanPreview returns null); the transcript has
  // no assistant lines.
  const proj = 'C--AI-my-vault-Agent-Orchestrator';
  const sid = 'sess-merge-no-text';
  const cwd = 'C:\\AI\\my-vault\\Agent\\Orchestrator';
  const projectsDir = makeProject({
    [proj]: {
      [sid]: {
        lines: [
          { type: 'user', cwd, gitBranch: 'main', message: { content: 'start' } },
          { type: 'ai-title', aiTitle: 'merged session', sessionId: sid },
        ],
      },
    },
  });
  try {
    setMtime(join(projectsDir, proj, sid + '.jsonl'), 30 * 1000, NOW);
    const g = snapshot({
      now: NOW,
      projectsDir,
      fleetRuns: realRepoRoot + '\\fleet',
      terminals: [{
        handle: 'term_mergechrm-1111-2222-3333-444444444444',
        connected: true, orphaned: false,
        branch: 'refs/heads/main',
        worktreePath: 'C:/AI/my-vault/Agent/Orchestrator',
        title: 'merged session',
        lastOutputAt: NOW - 1000,
        preview: 'new task? /clear to save 428.1k tokens\n──────',
      }],
      tasks: [], workers: [], hermesOnline: false,
    });
    const sess = g.nodes.find((n) => n.badge === 'orca' && n.sessionId === sid);
    assert.ok(sess, 'merged session exists');
    assert.equal(sess.activity, undefined, 'no activity field when neither source yields text');
  } finally { rmSync(projectsDir, { recursive: true, force: true }); }
});

test('T1-truthful-server: two same-title terminals in the SAME folder (any branches) get disambiguated labels (folder-keyed dedup)', () => {
  // T1 rule 4 v2: key the collision on FOLDER alone — visible nodes sharing
  // a folder must not share a label. Reproduces the live re-check scenario:
  // "MRI server .env.prod setup" on master AND on feature/prod-shared-controller
  // in the same repo (different branches, SAME folder).
  const g = snapshot({
    now: NOW,
    projectsDir: makeProject({}),
    fleetRuns: realRepoRoot + '\\fleet',
    terminals: [
      {
        handle: 'term_mrifirst-1111-2222-3333-444444444444',
        connected: true, orphaned: false,
        branch: 'refs/heads/master',
        worktreePath: 'C:/AI/my-vault/Company/Example-Corp/Projects/MRI/MRI-Staging-Devops',
        title: 'MRI server .env.prod setup',
        lastOutputAt: NOW - 1000,
        agentIdentity: 'claude',
      },
      {
        handle: 'term_mrisecnd-1111-2222-3333-444444444444',
        connected: true, orphaned: false,
        branch: 'refs/heads/feature/prod-shared-controller',
        worktreePath: 'C:/AI/my-vault/Company/Example-Corp/Projects/MRI/MRI-Staging-Devops',
        title: 'MRI server .env.prod setup',
        lastOutputAt: NOW - 1000,
        agentIdentity: 'claude',
      },
    ],
    tasks: [], workers: [], hermesOnline: false,
  });
  const sessions = g.nodes.filter((n) => n.kind === 'session');
  assert.equal(sessions.length, 2, 'two terminals in the same folder, different branches');
  const labels = sessions.map((n) => n.label);
  assert.notEqual(labels[0], labels[1], 'same-label cards in the same folder are distinguishable');
  // One keeps the bare title; the other has " · <handle8>" appended.
  const hasBare = sessions.some((n) => n.label === 'MRI server .env.prod setup');
  const hasSuffixed = sessions.some((n) => /^MRI server \.env\.prod setup · \S{4,}$/.test(n.label));
  assert.ok(hasBare, 'first terminal keeps the bare title, labels were: ' + labels.join(' | '));
  assert.ok(hasSuffixed, 'second terminal has a · <handle> suffix, labels were: ' + labels.join(' | '));
});

test('T1-truthful-server: two same-title terminals in DIFFERENT folders stay un-suffixed (folder is the only key)', () => {
  // Two terminals in two distinct folders with the same title must NOT
  // disambiguate against each other — the dedup is keyed on FOLDER only,
  // so a collision across folders is out of scope.
  const g = snapshot({
    now: NOW,
    projectsDir: makeProject({}),
    fleetRuns: realRepoRoot + '\\fleet',
    terminals: [
      {
        handle: 'term_otherone-1111-2222-3333-444444444444',
        connected: true, orphaned: false,
        branch: 'refs/heads/main',
        worktreePath: 'C:/AI/my-vault/Repo-One',
        title: 'shared title',
        lastOutputAt: NOW - 1000,
        agentIdentity: 'claude',
      },
      {
        handle: 'term_othertwo-1111-2222-3333-444444444444',
        connected: true, orphaned: false,
        branch: 'refs/heads/main',
        worktreePath: 'C:/AI/my-vault/Repo-Two',
        title: 'shared title',
        lastOutputAt: NOW - 1000,
        agentIdentity: 'claude',
      },
    ],
    tasks: [], workers: [], hermesOnline: false,
  });
  const sessions = g.nodes.filter((n) => n.kind === 'session');
  assert.equal(sessions.length, 2);
  assert.ok(sessions.every((n) => n.label === 'shared title'),
    'no per-label disambig across folders, labels were: ' + sessions.map((n) => n.label).join(' | '));
});

test('T1-truthful-server: a single terminal with a non-clashing label is unchanged', () => {
  // A terminal that does NOT collide with another label keeps its bare
  // title — no spurious suffix.
  const g = snapshot({
    now: NOW,
    projectsDir: makeProject({}),
    fleetRuns: realRepoRoot + '\\fleet',
    terminals: [{
      handle: 'term_uniquet-1111-2222-3333-444444444444',
      connected: true, orphaned: false,
      branch: 'refs/heads/main',
      worktreePath: 'C:/AI/my-vault/Agent/Orchestrator',
      title: 'unique label here',
      lastOutputAt: NOW - 1000,
      agentIdentity: 'claude',
    }],
    tasks: [], workers: [], hermesOnline: false,
  });
  const node = g.nodes.find((n) => n.kind === 'session');
  assert.ok(node, 'single terminal visible');
  assert.equal(node.label, 'unique label here', 'single terminal keeps its bare label (no · suffix)');
});

// --- T1-truthful-server v2: state agrees with bubble age for transcript sessions ---

test('T1-truthful-server v2: transcript-only session state is derived from activity.ts (fresh mtime, stale activity -> idle)', () => {
  // Live re-check scenario: the harness writes non-work lines to the
  // transcript (heartbeats, plugin events, replay rows) which move file
  // mtime but do not represent real work. The state must come from the
  // last REAL activity (the same timestamp we put in activity.ts). Fresh
  // mtime + stale activity -> idle (and hidden by the active-only rule
  // when no other state changes apply).
  const proj = 'C--AI-my-vault-Company-Example-Corp-Projects-MRI-MRI-Staging-Devops';
  const sid = 'sess-mri-master-stale-activity';
  const cwd = 'C:\\AI\\my-vault\\Company\\Example-Corp\\Projects\\MRI\\MRI-Staging-Devops';
  const projectsDir = makeProject({
    [proj]: {
      [sid]: {
        lines: [
          { type: 'user', cwd, gitBranch: 'master', message: { content: 'start' } },
          { type: 'assistant', timestamp: NOW - 6 * 60 * 1000, message: {
            model: 'haiku',
            content: [
              { type: 'text', text: 'bash -n ci/portainer-deploy.sh; echo "SYNTAX OK"; git add …' },
              { type: 'tool_use', name: 'Bash', input: { command: 'bash -n ci/portainer-deploy.sh && echo "SYNTAX OK" && git add …' } },
            ],
          } },
        ],
      },
    },
  });
  try {
    // Fresh mtime (heartbeats) - 30s ago - would naively make the
    // session look "active" by mtime. Activity is 6 min old.
    setMtime(join(projectsDir, proj, sid + '.jsonl'), 30 * 1000, NOW);
    const g = snapshot({
      now: NOW,
      projectsDir,
      fleetRuns: realRepoRoot + '\\fleet',
      terminals: [], workers: [], hermesOnline: false,
    });
    const s = g.nodes.find((n) => n.id === 'session:' + sid);
    assert.equal(s, undefined, 'transcript-only session with stale activity is hidden by the active-only rule');
    // Sanity: the activity shape (when not hidden) WOULD carry the stale ts.
  } finally { rmSync(projectsDir, { recursive: true, force: true }); }
});

test('T1-truthful-server v2: transcript-only session with fresh activity -> active', () => {
  // Inverse: fresh activity AND fresh mtime -> active.
  const proj = 'C--AI-my-vault-Agent-Orchestrator';
  const sid = 'sess-fresh-activity';
  const cwd = 'C:\\AI\\my-vault\\Agent\\Orchestrator';
  const projectsDir = makeProject({
    [proj]: {
      [sid]: {
        lines: [
          { type: 'user', cwd, gitBranch: 'main', message: { content: 'start' } },
          { type: 'assistant', timestamp: NOW - 30 * 1000, message: {
            model: 'haiku',
            content: [
              { type: 'text', text: 'running tests' },
              { type: 'tool_use', name: 'Bash', input: { command: 'npm test --silent' } },
            ],
          } },
        ],
      },
    },
  });
  try {
    setMtime(join(projectsDir, proj, sid + '.jsonl'), 30 * 1000, NOW);
    const g = snapshot({
      now: NOW,
      projectsDir,
      fleetRuns: realRepoRoot + '\\fleet',
      terminals: [], workers: [], hermesOnline: false,
    });
    const s = g.nodes.find((n) => n.id === 'session:' + sid);
    assert.ok(s, 'session exists with fresh activity');
    assert.equal(s.state, 'active', 'state = active (both mtime and activity are fresh)');
    assert.ok(s.activity, 'activity present');
    assert.equal(s.activity.ts, NOW - 30 * 1000, 'activity.ts matches the last assistant line');
    // state and activity.ts must agree within ACTIVE_MS.
    const stateAge = NOW - (s.activity?.ts || 0);
    assert.ok(stateAge < 3 * 60 * 1000, 'ring and bubble age agree within ACTIVE_MS');
  } finally { rmSync(projectsDir, { recursive: true, force: true }); }
});

test('T1-truthful-server v2: transcript-only with NO activity falls back to mtime for state', () => {
  // No usable activity (no assistant lines), so the state falls back to
  // the raw mtime liveness clock. Fresh mtime -> active.
  const proj = 'C--AI-my-vault-Agent-Orchestrator';
  const sid = 'sess-mtime-fallback';
  const cwd = 'C:\\AI\\my-vault\\Agent\\Orchestrator';
  const projectsDir = makeProject({
    [proj]: {
      [sid]: {
        lines: [
          { type: 'user', cwd, gitBranch: 'main', message: { content: 'hi' } },
          // No assistant lines -> no activity -> mtime fallback for state.
          { type: 'user', cwd, message: { content: 'hi again' } },
        ],
      },
    },
  });
  try {
    setMtime(join(projectsDir, proj, sid + '.jsonl'), 30 * 1000, NOW);
    const g = snapshot({
      now: NOW,
      projectsDir,
      fleetRuns: realRepoRoot + '\\fleet',
      terminals: [], workers: [], hermesOnline: false,
    });
    const s = g.nodes.find((n) => n.id === 'session:' + sid);
    assert.ok(s, 'session exists');
    assert.equal(s.state, 'active', 'fresh mtime + no activity -> active (mtime fallback)');
    assert.equal(s.activity, undefined, 'no activity field when nothing is extractable');
  } finally { rmSync(projectsDir, { recursive: true, force: true }); }
});
