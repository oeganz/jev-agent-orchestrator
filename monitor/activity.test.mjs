// Hermetic tests for monitor/activity.mjs.
//
// node:test. Pure module — no fs, no network, no env. The three exports
// (summarizeTool / extractActivity / cleanPreview) plus terminalActivity
// helper are pinned here so the UI half (T2) can build on top of them.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  summarizeTool, extractActivity, cleanPreview, terminalActivity,
} from './activity.mjs';

// --- summarizeTool -------------------------------------------------------

test('summarizeTool: Bash returns the command, collapsed and <=80 chars', () => {
  const out = summarizeTool('Bash', { command: 'node --test monitor/server.test.mjs' });
  assert.equal(out, 'node --test monitor/server.test.mjs');
});

test('summarizeTool: Bash collapses newlines and runs of whitespace into single spaces', () => {
  // Newline-heavy command from a real fixture: a multi-line bash script.
  const out = summarizeTool('Bash', {
    command: 'node -e "\n  import(\'./x\')\n  .then(y)\n  .catch(console.error)\n"',
  });
  // No newlines, single spaces, no leading/trailing whitespace.
  assert.ok(!/\n/.test(out), 'no newlines: ' + JSON.stringify(out));
  assert.ok(!/  /.test(out), 'no double spaces: ' + JSON.stringify(out));
  assert.ok(out.length <= 80, 'within 80 chars: ' + out.length);
  // First non-space char is real command content
  assert.ok(out.startsWith('node'), 'starts with `node`, got: ' + out);
});

test('summarizeTool: Bash truncates a very long command at 80 chars', () => {
  const cmd = 'echo ' + 'x'.repeat(500);
  const out = summarizeTool('Bash', { command: cmd });
  assert.ok(out.length <= 80, 'max 80 chars: ' + out.length);
  assert.ok(out.startsWith('echo '), 'starts with the command prefix');
});

test('summarizeTool: Bash strips two leading VAR=value assignments then runs the real command', () => {
  // Two plain assignments, then a real command. The real command should
  // surface in the bubble, not the assignments.
  const out = summarizeTool('Bash', {
    command: 'FOO=bar BAZ=qux node -e "console.log(1)"',
  });
  assert.ok(out.startsWith('node'), 'starts with `node`, got: ' + out);
  assert.ok(!/FOO=bar/.test(out), 'leading assignment stripped, got: ' + out);
  assert.ok(!/BAZ=qux/.test(out), 'second assignment stripped, got: ' + out);
});

test('summarizeTool: Bash strips `export VAR=$(...)` then keeps the real command', () => {
  // Real-world Playwright env exports. The export line should disappear so
  // the bubble shows the actual `node ...` invocation.
  const out = summarizeTool('Bash', {
    command: 'export NODE_PATH="$(cygpath -m /tmp)/pw-env/node_modules"; node monitor/server.mjs',
  });
  assert.ok(out.startsWith('node'), 'starts with `node`, got: ' + out);
  assert.ok(!/export/.test(out), 'export stripped, got: ' + out);
  assert.ok(!/NODE_PATH/.test(out), 'assignment stripped, got: ' + out);
});

test('summarizeTool: Bash keeps the original when nothing but assignments remain', () => {
  // Only assignments, no following real command. The stripper must not eat
  // the whole line — fall back to the original string so the bubble still
  // shows the assignments as-is.
  const out = summarizeTool('Bash', {
    command: 'FOO=bar BAZ=qux',
  });
  assert.ok(out.length > 0, 'non-empty result, got: ' + out);
  // The fallback is the original (or a collapsed variant) — must not crash
  // and must not be empty.
  assert.ok(/FOO=bar/.test(out) || /BAZ=qux/.test(out), 'fallback keeps something meaningful, got: ' + out);
});

test('summarizeTool: Read/Edit/Write/NotebookEdit return the path, shortened to last two segments when long', () => {
  // Short path: returned as-is.
  assert.equal(summarizeTool('Read', { file_path: 'short.js' }), 'short.js');
  assert.equal(summarizeTool('Edit', { file_path: 'short.js' }), 'short.js');
  assert.equal(summarizeTool('Write', { file_path: 'short.js' }), 'short.js');
  // Medium path (under 60 chars): kept verbatim.
  const med = 'C:/Users/me/projects/x.js';
  assert.equal(summarizeTool('Read', { file_path: med }), med);
  // Long path: shortened to last two segments.
  const long = String.raw`C:\Users\me\projects\myrepo\src\components\navigation\deep\feature\file.ts`;
  const longRes = summarizeTool('Read', { file_path: long });
  assert.ok(longRes.length <= 60, 'shortened path <=60 chars, got ' + longRes.length);
  assert.ok(/file\.ts$/.test(longRes), 'ends with the basename, got: ' + longRes);
  // Last two segments preserved (parent dir + basename).
  assert.ok(/feature\/file\.ts$/.test(longRes), 'last two segments preserved, got: ' + longRes);
  // Read with backslash separators normalises to forward slashes -> identical result.
  assert.equal(summarizeTool('Read', { file_path: long }), summarizeTool('Read', {
    file_path: long.replace(/[\\/]/g, '/'),
  }));
  // NotebookEdit prefers notebook_path.
  assert.equal(summarizeTool('NotebookEdit', {
    notebook_path: '/path/to/notebook.ipynb',
  }), '/path/to/notebook.ipynb');
});

test('summarizeTool: Grep/Glob return the pattern', () => {
  assert.equal(summarizeTool('Grep', { pattern: 'TODO.*urgent' }), 'TODO.*urgent');
  assert.equal(summarizeTool('Glob', { pattern: '**/test/*.mjs' }), '**/test/*.mjs');
  // Grep falls back to `query` then `path`
  assert.equal(summarizeTool('Grep', { query: 'fallback-query' }), 'fallback-query');
});

test('summarizeTool: Task/Agent return the description', () => {
  assert.equal(summarizeTool('Task', { description: 'verify fleet doc-drift' }), 'verify fleet doc-drift');
  // Agent may carry prompt or task instead of description
  assert.equal(summarizeTool('Agent', { prompt: 'run audit' }), 'run audit');
  assert.equal(summarizeTool('Agent', { task: 'fallback task' }), 'fallback task');
});

test('summarizeTool: WebSearch returns the query', () => {
  const out = summarizeTool('WebSearch', { query: 'jest async test best practices 2026' });
  assert.equal(out, 'jest async test best practices 2026');
});

test('summarizeTool: WebFetch returns host + path (no query/fragment)', () => {
  const out = summarizeTool('WebFetch', { url: 'https://docs.anthropic.com/claude-code/mcp?ref=foo#x' });
  assert.equal(out, 'docs.anthropic.com/claude-code/mcp');
  // Unparseable URL falls back to the raw input
  assert.equal(summarizeTool('WebFetch', { url: 'not a url' }), 'not a url');
});

test('summarizeTool: TodoWrite returns "Todos: <count>", empty -> "TodoWrite"', () => {
  assert.equal(summarizeTool('TodoWrite', {
    todos: [
      { content: 'a', active_form: 'a', status: 'pending' },
      { content: 'b', active_form: 'b', status: 'in_progress' },
    ],
  }), 'Todos: 2');
  assert.equal(summarizeTool('TodoWrite', { todos: [] }), 'TodoWrite');
  assert.equal(summarizeTool('TodoRead', {}), 'TodoRead');
});

test('summarizeTool: fallback returns the first string value, truncated; tool name when no string fields', () => {
  // Generic fallback: first string value in the input map.
  const out = summarizeTool('MyCustomTool', { foo: 1, bar: 'hello world', baz: 'second' });
  assert.equal(out, 'hello world');
  // First string wins, regardless of position (object key iteration order).
  const out2 = summarizeTool('Tool', { keyword: 'late', alpha: 'early' });
  assert.ok(out2 === 'late' || out2 === 'early', 'first-string picked, got: ' + out2);
  // Long string is truncated to ACTION_MAX (80 chars).
  const longStr = 'x'.repeat(200);
  const outLong = summarizeTool('Tool', { value: longStr });
  assert.ok(outLong.length <= 80, 'long input truncated to 80 chars, got ' + outLong.length);
  // No string fields at all -> the tool name itself.
  assert.equal(summarizeTool('Nondescript', { count: 3, enabled: true, ratio: 1.5 }), 'Nondescript');
  // Empty name -> empty string (guards downstream).
  assert.equal(summarizeTool('', {}), '');
  assert.equal(summarizeTool(null, {}), '');
  // Null/undefined input -> still safe.
  assert.equal(summarizeTool('Tool', null), 'Tool');
  assert.equal(summarizeTool('Tool', undefined), 'Tool');
});

// --- extractActivity -----------------------------------------------------

test('extractActivity: picks the most recent tool_use over older prose', () => {
  const lines = [
    { type: 'user', message: { content: 'hi' }, timestamp: 1000 },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'hello there' }] }, timestamp: 1100 },
    { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'node --test foo.test.mjs' } }] }, timestamp: 1200 },
  ];
  const a = extractActivity(lines, { now: 2000 });
  assert.ok(a, 'activity exists');
  assert.equal(a.action, 'node --test foo.test.mjs');
  assert.equal(a.said, 'hello there');
  // ts = max(actionTs, saidTs) = 1200
  assert.equal(a.ts, 1200);
});

test('extractActivity: returns prose when there is no tool_use', () => {
  const lines = [
    { type: 'user', message: { content: 'hi' }, timestamp: 1000 },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'thinking aloud here' }] }, timestamp: 1100 },
  ];
  const a = extractActivity(lines, { now: 2000 });
  assert.ok(a);
  assert.equal(a.action, null, 'no action when no tool_use');
  assert.equal(a.said, 'thinking aloud here');
  assert.equal(a.ts, 1100);
});

test('extractActivity: returns null for an empty / no-assistant transcript', () => {
  assert.equal(extractActivity([], { now: 2000 }), null);
  assert.equal(extractActivity(null, { now: 2000 }), null);
  assert.equal(extractActivity(undefined, { now: 2000 }), null);
  // Only user messages: nothing useful.
  const onlyUser = [
    { type: 'user', message: { content: 'hi' }, timestamp: 1000 },
    { type: 'user', message: { content: 'hi again' }, timestamp: 1100 },
  ];
  assert.equal(extractActivity(onlyUser, { now: 2000 }), null);
  // Tool-result-only (no assistant text and no tool_use) -> null.
  const onlyResults = [
    { type: 'user', message: { content: 'hi' }, timestamp: 1000 },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'x' }] }, timestamp: 1100 },
  ];
  assert.equal(extractActivity(onlyResults, { now: 2000 }), null);
});

test('extractActivity: walks back <= 40-ish useful lines; picks action and said independently', () => {
  // A pre-canned transcript (newest last). The most recent assistant has a
  // tool_use but NO text. The assistant before that has text but no tool_use.
  // extractActivity must return action from the newer, said from the older.
  const lines = [
    { type: 'user', message: { content: 'hi' }, timestamp: 1000 },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'I will plan this' }] }, timestamp: 1100 },
    { type: 'user', message: { content: 'go' }, timestamp: 1200 },
    { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read', input: { file_path: 'src/x.js' } }] }, timestamp: 1300 },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'a' }] }, timestamp: 1400 },
    { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Edit', input: { file_path: 'src/x.js' } }] }, timestamp: 1500 },
  ];
  const a = extractActivity(lines, { now: 5000 });
  assert.ok(a);
  assert.equal(a.action, 'src/x.js', 'most recent Edit (longer than 60? no -> as-is)');
  assert.equal(a.said, 'I will plan this', 'falls back to older prose when newer has none');
  assert.equal(a.ts, 1500);
});

test('extractActivity: markdown-stripped said, <= 90 chars', () => {
  const lines = [
    { type: 'assistant', message: { content: [
      { type: 'text', text: 'Here is **bold**, *italic*, `inline`, [link](http://x), a fence:\n```js\nfoo()\n```\nand # heading.' },
    ] }, timestamp: 1100 },
  ];
  const a = extractActivity(lines, { now: 2000 });
  assert.ok(a);
  // No `**`, no `*`, no backticks, no link target, no code fence, no leading `#`.
  assert.ok(!/\*\*/.test(a.said), 'no bold markers, got: ' + a.said);
  assert.ok(!/[`*]/.test(a.said), 'no inline markdown, got: ' + a.said);
  assert.ok(!/^#\s/.test(a.said), 'no leading heading marker, got: ' + a.said);
  // Long input -> truncated to 90 chars (no newline)
  const longOut = 'a'.repeat(200);
  const linesLong = [
    { type: 'assistant', message: { content: [{ type: 'text', text: longOut }] }, timestamp: 1100 },
  ];
  const al = extractActivity(linesLong, { now: 2000 });
  assert.ok(al);
  assert.ok(al.said.length <= 90, 'said <= 90 chars, got ' + al.said.length);
});

test('extractActivity: falls back to `now` when both timestamps are missing', () => {
  const lines = [
    { type: 'assistant', message: { content: [{ type: 'text', text: 'no timestamp' }] } },
  ];
  const a = extractActivity(lines, { now: 9999999 });
  assert.ok(a);
  assert.equal(a.ts, 9999999);
});

// --- cleanPreview -------------------------------------------------------

test('cleanPreview: antigravity sample — prose kept, separator dropped, long line truncated to 90', () => {
  const preview =
    'now print a much longer error message detailing exactly what part of the "body" it didn\'t like. Let me know what it says!\n─────';
  const out = cleanPreview(preview);
  assert.ok(out);
  assert.ok(out.length <= 90, 'truncated to 90 chars, got ' + out.length);
  // The full input is 113 chars; the kept half should start with "now print".
  assert.ok(out.startsWith('now print'), 'starts with the prose, got: ' + out);
  assert.ok(/error message/i.test(out), 'preserves the agent\'s message: ' + out);
  // No box-drawing characters in the result.
  assert.ok(!/[\u2500-\u257f]/.test(out), 'no box-drawing separator leaked, got: ' + out);
  assert.ok(!/────/.test(out), 'no em-dash separator leaked, got: ' + out);
});

test('cleanPreview: claude sample — "...push to stg01." kept, "new task? /clear to save 428.1k tokens" and separators dropped', () => {
  const preview =
    '...push to stg01.\nnew task? /clear to save 428.1k tokens\n──────';
  const out = cleanPreview(preview);
  assert.equal(out, '...push to stg01.');
  // And the chrome markers must NOT leak through.
  assert.ok(!/new task/.test(out));
  assert.ok(!/clear to save/.test(out));
  assert.ok(!/tokens/.test(out));
  assert.ok(!/[\u2500\u2014]/.test(out));
});

test('cleanPreview: truncation case — a single very long non-chrome line is truncated to <= 90 chars', () => {
  const long = 'a'.repeat(400);
  const out = cleanPreview(long);
  assert.ok(out);
  assert.ok(out.length <= 90, 'long single line truncated, got ' + out.length);
});

test('cleanPreview: leading glyph is stripped (e.g. "✳ hello" -> "hello")', () => {
  const preview = '✳ hello there\n─────';
  const out = cleanPreview(preview);
  assert.equal(out, 'hello there');
});

test('cleanPreview: empty / only-separator / null inputs return null', () => {
  assert.equal(cleanPreview(null), null);
  assert.equal(cleanPreview(undefined), null);
  assert.equal(cleanPreview(''), null);
  assert.equal(cleanPreview('   '), null);
  assert.equal(cleanPreview('─────\n──────'), null);
  assert.equal(cleanPreview('new task? /clear to save 428.1k tokens\n──────'), null);
  // A standalone token counter is dropped -> nothing remains -> null.
  assert.equal(cleanPreview('428.1k tokens'), null);
});

test('cleanPreview: keeps the LAST non-empty non-chrome line, not the first', () => {
  // The spec collapses to the LAST remaining line. Two prose lines, no chrome.
  // The second (last) is kept; the first is dropped.
  const preview = 'first line of agent prose\nsecond line of agent prose';
  const out = cleanPreview(preview);
  assert.equal(out, 'second line of agent prose');
});

// --- terminalActivity ---------------------------------------------------

test('terminalActivity: builds an activity with said from preview and ts from lastOutputAt, no action', () => {
  const t = {
    preview: '...push to stg01.\nnew task? /clear to save 428.1k tokens\n──────',
    lastOutputAt: 1234567890,
  };
  const out = terminalActivity(t, 999);
  assert.ok(out);
  assert.equal(out.action, null, 'no action for terminal-derived activity');
  assert.equal(out.said, '...push to stg01.');
  assert.equal(out.ts, 1234567890);
});

test('terminalActivity: missing/empty preview returns null', () => {
  assert.equal(terminalActivity({ preview: '', lastOutputAt: 1000 }, 999), null);
  assert.equal(terminalActivity({ lastOutputAt: 1000 }, 999), null);
});

test('terminalActivity: missing/invalid lastOutputAt falls back to `now`', () => {
  const out = terminalActivity({ preview: 'just one line\n─────' }, 42424242);
  assert.ok(out);
  assert.equal(out.ts, 42424242);
});

// --- cleanPreview hardening (T1-truthful-server) -----------------------

test('cleanPreview: rejects "1ct · /artifact to review" (truncated token + slash-hint chrome)', () => {
  // Real bad sample from the running machine: a status-bar fragment whose
  // tokens are too short to be prose and whose slash-hint "/artifact" looks
  // like a help-menu indicator.
  assert.equal(cleanPreview('1ct · /artifact to review'), null);
});

test('cleanPreview: rejects a single "·" bullet alone', () => {
  // Real bad sample: terminal emits a lone bullet as a status tick.
  assert.equal(cleanPreview('·'), null);
});

test('cleanPreview: rejects "✳ Claude Code" (leading glyph + product-name TUI title)', () => {
  // Real bad sample: TUI title line with a leading glyph and the product
  // name. The hardened cleaner must strip the glyph first AND recognise
  // the remaining "Claude Code" as TUI chrome (no real prose).
  assert.equal(cleanPreview('✳ Claude Code'), null);
});

test('cleanPreview: rejects "Claude Code" alone (no leading glyph)', () => {
  // Same pattern as the TUI title but without the glyph - some terminals
  // emit just the product name. The standing seam is "Claude Code" with
  // nothing else around it.
  assert.equal(cleanPreview('Claude Code'), null);
});

test('cleanPreview: keeps "Zigzagging…" (real short agent prose)', () => {
  // Real good sample: short agent phrase with a 9-letter verb.
  assert.equal(cleanPreview('Zigzagging…'), 'Zigzagging…');
});

test('cleanPreview: keeps "The frontend check finished its last search, and nothing in"', () => {
  // Real good sample: long agent prose; the word "search" must NOT be
  // confused with the "/artifact" hint pattern (they are different
  // substrings). The chrome rule only matches literal "/artifact".
  const out = cleanPreview('The frontend check finished its last search, and nothing in');
  assert.equal(out, 'The frontend check finished its last search, and nothing in');
});

test('cleanPreview: keeps "Push failing tests into a fresh claude subagent run"', () => {
  // Real good sample: short agent prose that mentions the product name
  // mid-sentence - must NOT trip the "Claude Code" product-title chrome.
  const out = cleanPreview('Push failing tests into a fresh claude subagent run');
  assert.equal(out, 'Push failing tests into a fresh claude subagent run');
});
