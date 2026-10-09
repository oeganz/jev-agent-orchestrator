// Dashboard broadcaster. Tails the run store (tasks.jsonl + gates.jsonl across
// all runs/), keeps an in-memory snapshot of the active run, and pushes every
// new event to every connected WebSocket client. Zero dependencies.
//
// Protocol (text frames, one JSON object per message):
//   {type:"hello", run:<id|null>, runs:[...], snapshot:{<run-id>:{meta,tasks,gates}}}
//   {type:"event", run:<id>, kind:"task"|"gate", row:{...}}
//   {type:"list",  runs:[...]}                                  -- on request "list"
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { watch, readFileSync, existsSync, readdirSync, statSync, openSync, readSync, closeSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadRun, runsRoot } from './runs.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const FLEET_DIR = process.env.FLEET_DIR || join(HERE, '..', '..');
const RUNS_DIR = runsRoot(FLEET_DIR);
const PORT = parseInt(process.env.PORT || '8788', 10);

const lastOffset = new Map();   // path -> byte length already read
const snapshot = new Map();     // run-id -> { meta, tasks, gates }
const sockets = new Set();      // active ws clients

function listRuns() {
  if (!existsSync(RUNS_DIR)) return [];
  return readdirSync(RUNS_DIR, { withFileTypes: true })
    .filter(d => d.isDirectory()).map(d => d.name).sort();
}

function readNewLines(path) {
  if (!existsSync(path)) return [];
  const total = statSync(path).size;
  const prev = lastOffset.get(path) ?? 0;
  if (total < prev) lastOffset.set(path, 0);
  if (total === (lastOffset.get(path) ?? 0)) return [];
  const from = lastOffset.get(path) ?? 0;
  const len = total - from;
  const fh = openSync(path, 'r');
  try {
    const buf = Buffer.alloc(len);
    readSync(fh, buf, 0, len, from);
    lastOffset.set(path, total);
    return buf.toString('utf8').split(/\r?\n/).filter(Boolean);
  } finally { closeSync(fh); }
}

function activeRunId() {
  let active = null, latest = 0;
  for (const [id, s] of snapshot) {
    const ts = Math.max(0, ...s.tasks.map(t => Date.parse(t.ts) || 0), ...s.gates.map(g => Date.parse(g.ts) || 0));
    if (ts > latest) { latest = ts; active = id; }
  }
  return active;
}

function broadcast(msg) {
  const data = JSON.stringify(msg);
  for (const ws of sockets) { try { ws.send(data); } catch {} }
}

function rebuild() {
  for (const id of listRuns()) {
    const r = loadRun(FLEET_DIR, id);
    if (!r) continue;
    snapshot.set(id, { meta: r.meta, tasks: r.tasks || [], gates: r.gates || [], reports: r.reports || [], hasSummary: r.hasSummary });
  }
  // set baselines for new files
  for (const id of listRuns()) {
    for (const f of ['tasks.jsonl', 'gates.jsonl']) {
      const p = join(RUNS_DIR, id, f);
      if (!lastOffset.has(p)) lastOffset.set(p, existsSync(p) ? statSync(p).size : 0);
    }
  }
}

function startWatchers() {
  rebuild();
  // detect new run directories
  try {
    watch(RUNS_DIR, { recursive: false }, (event, name) => {
      if (event !== 'rename' || !name) return;
      const full = join(RUNS_DIR, name);
      try { if (!statSync(full).isDirectory()) return; } catch { return; }
      if (!snapshot.has(name)) { rebuild(); broadcast({ type: 'list', runs: listRuns() }); }
    });
  } catch { /* watch may fail on some FS; the poll below still works */ }
  setInterval(() => {
    for (const id of listRuns()) {
      for (const [kind, fname] of [['task', 'tasks.jsonl'], ['gate', 'gates.jsonl']]) {
        const path = join(RUNS_DIR, id, fname);
        for (const line of readNewLines(path)) {
          let row; try { row = JSON.parse(line); } catch { continue; }
          const s = snapshot.get(id) || { meta: null, tasks: [], gates: [], reports: [], hasSummary: false };
          if (kind === 'task') s.tasks.push(row); else s.gates.push(row);
          snapshot.set(id, s);
          broadcast({ type: 'event', run: id, kind, row });
          if (id === activeRunId()) broadcast({ type: 'list', runs: listRuns() });
        }
      }
    }
  }, 500).unref();
}

// ---- minimal RFC 6455 WebSocket server (text frames, no compression) ----
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
function wsAccept(key) { return createHash('sha1').update(key + WS_GUID).digest('base64'); }
function sendText(socket, text) {
  const data = Buffer.from(text, 'utf8');
  const len = data.length;
  let header;
  if (len < 126) header = Buffer.from([0x81, len]);
  else if (len < 0x10000) header = Buffer.from([0x81, 126, (len >> 8) & 0xff, len & 0xff]);
  else header = Buffer.from([0x81, 127, 0,0,0,0, (len >>> 24) & 0xff, (len >>> 16) & 0xff, (len >>> 8) & 0xff, len & 0xff]);
  socket.write(Buffer.concat([header, data]));
}

const DASHBOARD_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>Fleet dashboard</title>
<style>
body{background:#0d0a0f;color:#f2eef4;font:14px -apple-system,Segoe UI,Roboto,sans-serif;margin:0;padding:16px}
.row{display:flex;gap:12px;align-items:flex-start}
.col{flex:1;background:#171218;border:1px solid #3a2f3a;border-radius:8px;padding:12px}
h2{font-size:13px;text-transform:uppercase;letter-spacing:.08em;color:#e551ba;margin:0 0 8px}
#log{height:55vh;overflow-y:auto;font:12.5px/1.5 ui-monospace,Consolas,monospace;background:#0a070d;padding:8px;border-radius:4px}
.log-t{color:#a89ba8}
.log-task{color:#3ddc97}.log-gate{color:#ffb454}.log-rework{color:#ff6b81}
.tag{display:inline-block;padding:1px 7px;border-radius:99px;font-size:11px;background:#241a2a;margin-right:4px}
select,button{background:#241a2a;color:#f2eef4;border:1px solid #3a2f3a;border-radius:4px;padding:4px 8px}
#obj{font-size:14px;line-height:1.4;color:#f2eef4;margin-bottom:8px}
#lane{position:relative;height:80px;background:#0a070d;border-radius:4px;overflow:hidden;margin:6px 0 4px}
.lane{position:absolute;top:0;bottom:0;background:#241a2a;border-left:2px solid #e551ba;border-radius:2px;font-size:11px;padding:2px 4px;color:#f2eef4;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.lane.gate{background:#241a10;border-color:#ffb454}
.lane.rework{background:#2f1015;border-color:#ff6b81}
.lane.worker-wait{background:#0a070d;border-color:#a89ba8;color:#a89ba8}
.ruler{position:absolute;top:0;bottom:0;width:1px;background:#3a2f3a}
.now{position:absolute;top:0;bottom:0;width:1px;background:#e551ba;z-index:2}
#pickrun{margin-bottom:8px}
small.dim{color:#a89ba8}
</style></head><body>
<div id="pickrun">run <select id="runs"></select> <button id="refresh">refresh</button> <small class="dim" id="conn"></small></div>
<div id="obj"></div>
<div class="row">
<div class="col" style="max-width:60%">
<h2>Timeline</h2>
<div id="lane"><div id="rulers"></div><div id="lanes"></div><div id="now" class="now"></div></div>
<small class="dim">events are drawn at their actual timestamp. the magenta line is "now".</small>
<h2 style="margin-top:14px">Events</h2>
<div id="log"></div>
</div>
<div class="col">
<h2>Goals / objective</h2>
<div id="goals"></div>
<h2 style="margin-top:14px">Agent comms</h2>
<div id="comms"></div>
</div>
</div>
<script>
const $ = (s) => document.querySelector(s);
const log = (m) => {
  const d = document.createElement('div');
  d.className = m.kind === 'task' ? 'log-task' : (m.row.verdict === 'rework' ? 'log-rework' : 'log-gate');
  const t = new Date(m.row.ts).toLocaleTimeString();
  d.innerHTML = '<span class="log-t">' + t + '</span> ' + (m.kind === 'task' ? '<span class="tag">task</span> ' + (m.row.role || '?') + ' - ' + m.row.task_id : '<span class="tag">gate</span> ' + m.row.gate + ' - ' + m.row.task_id + ' -> <b>' + m.row.verdict + '</b>');
  $('#log').prepend(d);
  while ($('#log').children.length > 200) $('#log').lastChild.remove();
};
let snap = { snapshot: {}, run: null };
let activeRun = null;
const select = $('#runs');
const renderTimeline = () => {
  const run = activeRun; if (!run || !snap.snapshot[run]) return;
  const s = snap.snapshot[run];
  const events = [
    ...s.tasks.map(t => ({ts:Date.parse(t.ts), kind:'task', role:t.role, id:t.task_id})),
    ...s.gates.map(g => ({ts:Date.parse(g.ts), kind:'gate', task:g.task_id, verdict:g.verdict}))
  ].sort((a,b)=>a.ts-b.ts);
  const t0 = events.length ? events[0].ts : Date.now();
  const tN = Date.now();
  const span = Math.max(60_000, tN - t0);
  $('#lanes').innerHTML = '';
  events.forEach(e => {
    const d = document.createElement('div');
    d.className = 'lane' + (e.kind === 'gate' ? ' gate' : '') + (e.verdict === 'rework' ? ' rework' : '');
    d.style.left = (100*(e.ts - t0)/span) + '%';
    d.style.width = '2px';
    d.title = e.kind + ' ' + (e.id || e.task) + ' @ ' + new Date(e.ts).toLocaleString();
    d.textContent = e.kind === 'gate' ? 'G' : (e.role||'?')[0];
    $('#lanes').appendChild(d);
  });
  $('#now').style.left = (100*(tN - t0)/span) + '%';
};
const renderComm = () => {
  const run = activeRun; if (!run || !snap.snapshot[run]) { $('#comms').innerHTML = '<small class="dim">no run selected</small>'; return; }
  const s = snap.snapshot[run];
  const items = [];
  s.tasks.forEach(t => items.push({ ts: t.ts, kind: 'task dispatched', body: t.role + ' / ' + t.task_id + ' (base ' + (t.base_sha||'?').slice(0,7) + ')' }));
  s.gates.forEach(g => items.push({ ts: g.ts, kind: 'gate ' + g.gate + ' -> ' + g.verdict, body: g.why || '' }));
  items.sort((a,b) => b.ts.localeCompare(a.ts));
  $('#comms').innerHTML = items.slice(0, 12).map(it => '<div style="margin:6px 0;padding:6px;background:#0a070d;border-radius:4px"><div style="color:#a89ba8;font-size:11px">' + new Date(it.ts).toLocaleTimeString() + ' - ' + it.kind + '</div>' + it.body + '</div>').join('');
};
const renderGoals = () => {
  const run = activeRun; if (!run || !snap.snapshot[run]) { $('#goals').innerHTML = '<small class="dim">no run selected</small>'; return; }
  const s = snap.snapshot[run];
  const rework = s.gates.filter(g => g.verdict === 'rework').length;
  const ok = s.gates.filter(g => g.verdict === 'accept').length;
  $('#goals').innerHTML = '<div id="obj">' + (s.meta?.objective || '?') + '</div><div style="margin-top:8px;font-size:12px;color:#a89ba8">status <b style="color:#f2eef4">' + (s.meta?.status || '?') + '</b> - gates ' + s.gates.length + ' (' + ok + ' ok / ' + rework + ' rework) - tasks ' + s.tasks.length + (s.meta?.planted_defect ? ' - planted defect' : '') + '</div>';
};
const refreshList = () => {
  const prev = select.value;
  select.innerHTML = '';
  Object.keys(snap.snapshot).sort().reverse().forEach(r => {
    const o = document.createElement('option');
    o.value = r;
    o.textContent = r + (snap.snapshot[r].meta?.planted_defect ? ' [planted]' : '');
    select.appendChild(o);
  });
  if (prev && snap.snapshot[prev]) activeRun = select.value = prev;
  else if (select.options.length) activeRun = select.value = select.options[0].value;
};
select.addEventListener('change', () => { activeRun = select.value; renderAll(); });
const renderAll = () => { refreshList(); renderGoals(); renderTimeline(); renderComm(); };
const ws = new WebSocket('ws://' + location.host);
ws.onopen = () => { $('#conn').textContent = 'connected'; };
ws.onclose = () => { $('#conn').textContent = 'disconnected - retry in 2s'; setTimeout(() => location.reload(), 2000); };
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.type === 'hello') { snap = m; renderAll(); }
  else if (m.type === 'event') {
    log(m);
    if (!snap.snapshot[m.run]) snap.snapshot[m.run] = { meta:null, tasks:[], gates:[], reports:[], hasSummary:false };
    if (m.kind === 'task') snap.snapshot[m.run].tasks.push(m.row);
    else snap.snapshot[m.run].gates.push(m.row);
    if (m.run === activeRun) renderAll(); else refreshList();
  }
};
setInterval(renderTimeline, 1000);
</script>
</body></html>`;

const server = createServer((req, res) => {
  if (req.url === '/' || req.url === '/index.html') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(DASHBOARD_HTML);
    return;
  }
  res.writeHead(404).end('not found');
});

server.on('upgrade', (req, socket) => {
  if ((req.headers.upgrade || '').toLowerCase() !== 'websocket') { socket.destroy(); return; }
  const key = req.headers['sec-websocket-key'];
  const accept = wsAccept(key || '');
  if (!accept) { socket.destroy(); return; }
  const res = [
    'HTTP/1.1 101 Switching Protocols',
    'Upgrade: websocket', 'Connection: Upgrade',
    'Sec-WebSocket-Accept: ' + accept,
    '', ''
  ].join('\r\n');
  socket.write(res);
  const ws = { socket, send: (text) => sendText(socket, text) };
  sockets.add(ws);
  let buf = Buffer.alloc(0);
  socket.on('data', (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    let off = 0;
    while (off < buf.length) {
      if (buf.length - off < 2) break;
      const b0 = buf[off]; const op = b0 & 0x0f;
      let len = buf[off + 1] & 0x7f;
      let hdr = 2;
      if (len === 126) { if (buf.length - off < 4) break; len = buf.readUInt16BE(off + 2); hdr = 4; }
      else if (len === 127) { if (buf.length - off < 10) break; len = Number(buf.readBigUInt64BE(off + 2)); hdr = 10; }
      if (buf.length - off < hdr + 4 + len) break;
      const mask = buf.slice(off + hdr, off + hdr + 4);
      const payload = Buffer.from(buf.slice(off + hdr + 4, off + hdr + 4 + len));
      for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
      if (op === 0x1) {
        try {
          const msg = JSON.parse(payload.toString('utf8'));
          if (msg.type === 'list') ws.send(JSON.stringify({ type: 'list', runs: listRuns() }));
        } catch {}
      } else if (op === 0x8) { socket.end(); }
      off += hdr + 4 + len;
    }
    buf = buf.slice(off);
  });
  socket.on('close', () => sockets.delete(ws));
  socket.on('error', () => sockets.delete(ws));
  ws.send(JSON.stringify({ type: 'hello', run: activeRunId(), runs: listRuns(), snapshot: Object.fromEntries(snapshot) }));
});

startWatchers();
server.listen(PORT, () => console.log('fleet dashboard on http://localhost:' + PORT + '  (FLEET_DIR=' + FLEET_DIR + ')'));
