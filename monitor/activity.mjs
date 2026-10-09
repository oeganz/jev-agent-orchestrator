// monitor/activity.mjs
//
// Pure (dependency-free) helpers that summarise the live activity of an
// agent / session node. The UI renders the result as a small "what are you
// doing right now?" speech bubble next to the node (T1-activity-extractor).
//
// Three exports:
//   summarizeTool(name, input) -> string
//     One-line label for a tool_use block. <= 80 chars, no newlines,
//     never returns null/empty (returns the tool name as fallback).
//
//   extractActivity(lines, opts) -> { action, said, ts } | null
//     Pick the most recent action and the most recent said from a parsed
//     transcript tail (newest last). `action` is the most recent tool_use;
//     `said` is the most recent assistant text. Each is independently
//     nullable; ts is the epoch ms of the most recent of the two (or now
//     as a final fallback). Returns null when nothing useful is present.
//
//   cleanPreview(preview) -> string | null
//     Clean an Orca terminal `preview` blob (a few trailing lines of the
//     agent's TUI) down to a single line of the agent's own prose.
//
// Privacy contract: never put tool RESULTS, file contents or command output
// into `activity`. Only the action summary and the agent's own words.

const ACTION_MAX = 80;
const SAID_MAX = 90;

// ---- summariseTool ----------------------------------------------------

const FALLBACK_SKIP_KEYS = new Set([
  'type', 'name', 'input', 'message', 'content', 'role', 'model',
  'stop_reason', 'stop_sequence', 'toolUseId', 'id', 'is_error',
  'error', 'metadata', '_meta',
]);

function firstStringValue(obj) {
  if (!obj || typeof obj !== 'object') return '';
  for (const k of Object.keys(obj)) {
    if (FALLBACK_SKIP_KEYS.has(k)) continue;
    const v = obj[k];
    if (typeof v === 'string' && v.length > 0) return v;
  }
  return '';
}

function collapseInline(s) {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

function trunc(s, max) {
  const t = String(s || '').trim();
  return t.length > max ? t.slice(0, max) : t;
}

function take(s, max) {
  const t = collapseInline(s);
  return t.length > max ? t.slice(0, max) : t;
}

// Shorten an absolute path so the LABEL stays under `max` characters while
// preserving the basename. If the path is already <= max, return it as-is.
// Otherwise: keep the last two segments ("<parent>/<basename>") so the
// basename remains identifying.
function shortenPath(p, max) {
  const s = String(p || '');
  if (!s) return '';
  if (s.length <= max) return s;
  const norm = s.replace(/[\\/]+/g, '/');
  const parts = norm.split('/').filter(Boolean);
  if (parts.length <= 1) return trunc(s, max);
  const tail = parts.slice(-2).join('/');
  return trunc(tail, max);
}

// For WebFetch: host + pathname (no query/fragment). Falls back to the raw
// input when the URL is unparseable.
function hostPathFromUrl(url) {
  try {
    const u = new URL(String(url || ''));
    const host = String(u.host || '');
    const path = String(u.pathname || '');
    return take(host + path, ACTION_MAX);
  } catch {
    return take(url, ACTION_MAX);
  }
}

// Strip leading env assignments and `export`/`cd`-only prefixes so a Bash
// command that begins with `T=$(cygpath ...); export NODE_PATH=...; node ...`
// surfaces as `node ...` in the bubble. The intent is readability, not
// rewriting semantics: the original must still be the fallback when nothing
// but assignments remain (so a script that ONLY sets vars is still visible).
//
// Approach: a tiny shell-prefix scanner. We walk the leading tokens, skipping
// any number of:
//   - `export VAR=value`    (optional)
//   - `VAR=value`           (optional, any number)
//   - `cd <path>`           (optional, any number)
// joined by `;` or `&&`. Quoted spans and $(...) / ${...} / backticks are
// tracked so a value with whitespace does not end the token early. The first
// non-assignment/non-cd/export token is the "real" command and is returned.
// If no such token is found, the collapsed original is returned so the bubble
// still shows SOMETHING.
function stripBashPrefix(s) {
  const collapsed = collapseInline(s);
  if (!collapsed) return '';
  let i = 0;
  const N = collapsed.length;
  // Returns the slice end index of a leading "word" starting at `i`, tracking
  // quotes and command substitution so `export FOO="hello world"` consumes
  // the whole quoted value, not just `export FOO=`.
  const skipWS = () => {
    while (i < N && /\s/.test(collapsed[i])) i++;
  };
  // Try to read a leading assignment (`VAR=value` or `export VAR=value`) at
  // position `i`. Returns true and advances `i` past the assignment + any
  // separator that follows (`;` or `&&`), or returns false without changing
  // `i`. Quotes / $() / ${} / backticks are tracked.
  const tryReadAssignment = () => {
    const start = i;
    // Optional `export` keyword.
    if (collapsed.slice(i, i + 7) === 'export ' || collapsed.slice(i, i + 7) === 'export\t') {
      i += 6; skipWS();
    }
    // VAR=
    const m = /^([A-Za-z_][A-Za-z0-9_]*)=/.exec(collapsed.slice(i));
    if (!m) { i = start; return false; }
    i += m[0].length;
    // Value: read until unquoted whitespace, tracking depth of " ' ( [ {.
    // `openers` is a name->kind map: each opener char maps to the matching
    // CLOSER char, so we can read `collapsed[closerIdx]` to find the
    // matching close. Depth is tracked by opener char (the same key the
    // close uses) so the increment/decrement balance is unambiguous.
    const openers = { '"': '"', "'": "'", '(': ')', '[': ']', '{': '}' };
    let depth = { '"': 0, "'": 0, '(': 0, '[': 0, '{': 0 };
    // Backticks nest: each ` toggles.
    let backtick = false;
    while (i < N) {
      const c = collapsed[i];
      if (c === '`') { backtick = !backtick; i++; continue; }
      if (!backtick) {
        if (depth['"'] + depth["'"] + depth['('] + depth['['] + depth['{'] === 0 && /\s/.test(c)) break;
        if (depth['"'] === 0 && depth["'"] === 0 && (c === '"' || c === "'")) { depth[c] = 1; i++; continue; }
        if (depth['"'] === 0 && depth["'"] === 0 && openers[c] && (c === '(' || c === '[' || c === '{')) {
          // Track by the opening char so the matching close decrements the
          // same counter.
          depth[c] = 1; i++; continue;
        }
        // Bare $(...) and ${...}: the `$` doesn't open a depth on its own,
        // but the following `(` or `{` does. Track it as if the user had
        // wrapped the value in quotes.
        if (depth['"'] === 0 && depth["'"] === 0 && depth['('] === 0 && depth['['] === 0 && depth['{'] === 0 && c === '$' &&
            (collapsed[i + 1] === '(' || collapsed[i + 1] === '{' || collapsed[i + 1] === '[')) {
          // The `$` itself is not a delimiter; advance and let the
          // following opener open a depth.
          i++; continue;
        }
        if (depth['"'] + depth["'"] + depth['('] + depth['['] + depth['{'] > 0) {
          if (c === '"' && depth['"'] > 0) depth['"']--;
          else if (c === "'" && depth["'"] > 0) depth["'"]--;
          else if (c === ')' && depth['('] > 0) depth['(']--;
          else if (c === ']' && depth['['] > 0) depth['[']--;
          else if (c === '}' && depth['{'] > 0) depth['{']--;
        }
      }
      i++;
    }
    // Optional separator: ';' or '&&' (we treat both as a soft break).
    skipWS();
    if (collapsed[i] === ';') { i++; skipWS(); }
    else if (collapsed[i] === '&' && collapsed[i + 1] === '&') { i += 2; skipWS(); }
    return true;
  };
  // Try to read a leading `cd <path>` (one arg, no flags) at position `i`.
  const tryReadCd = () => {
    const start = i;
    if (collapsed.slice(i, i + 3) !== 'cd ' && collapsed.slice(i, i + 3) !== 'cd\t') return false;
    i += 2; skipWS();
    // Read the path token (quoted or unquoted, no whitespace until close).
    const openers = { '"': '"', "'": "'" };
    if (openers[collapsed[i]]) {
      const q = openers[collapsed[i]]; i++;
      while (i < N && collapsed[i] !== q) i++;
      if (collapsed[i] === q) i++;
    } else {
      while (i < N && !/\s/.test(collapsed[i])) i++;
    }
    skipWS();
    if (collapsed[i] === ';') { i++; skipWS(); }
    else if (collapsed[i] === '&' && collapsed[i + 1] === '&') { i += 2; skipWS(); }
    return start !== i ? true : (i = start, false);
  };
  // Loop: keep consuming leading assignment / cd tokens.
  let progressed = true;
  let safety = 0;
  while (progressed && safety++ < 64) {
    progressed = false;
    const before = i;
    if (tryReadAssignment()) { if (i !== before) progressed = true; else { i = before; break; } }
    else if (tryReadCd()) { if (i !== before) progressed = true; else { i = before; break; } }
    else break;
  }
  const rest = collapsed.slice(i);
  // If we ate the whole string, fall back to the original so the bubble
  // still shows the user the assignments (better than a blank line).
  if (!rest || !rest.trim()) return collapsed;
  return rest;
}

// summariseTool(name, input) -> string
export function summarizeTool(name, input) {
  const n = String(name || '').trim();
  if (!n) return '';
  const inp = (input && typeof input === 'object') ? input : {};
  switch (n) {
    case 'Bash': {
      const stripped = stripBashPrefix(inp.command);
      return take(stripped, ACTION_MAX);
    }
    case 'Read':
    case 'Edit':
    case 'Write':
    case 'NotebookEdit': {
      const p = inp.file_path || inp.notebook_path || '';
      return shortenPath(String(p), 60);
    }
    case 'Grep':
    case 'Glob': {
      const s = inp.pattern || inp.query || inp.path || '';
      return take(s, ACTION_MAX);
    }
    case 'Task':
    case 'Agent': {
      const s = inp.description || inp.prompt || inp.task || '';
      return take(s, ACTION_MAX);
    }
    case 'WebSearch': {
      return take(inp.query, ACTION_MAX);
    }
    case 'WebFetch': {
      return hostPathFromUrl(inp.url || '');
    }
    case 'TodoWrite':
    case 'TodoRead': {
      const todos = inp.todos;
      if (Array.isArray(todos) && todos.length) {
        return take('Todos: ' + todos.length, ACTION_MAX);
      }
      return n;
    }
    default: {
      const s = firstStringValue(inp);
      if (s) return take(s, ACTION_MAX);
      return n;
    }
  }
}

// ---- cleanPreview -----------------------------------------------------

// Box-drawing + em/en dash + horizontal lines as a "separator" line.
const SEPARATOR_LINE_RE = /^[\s─-╿—–_-]+$/;
// A line that contains TUI chrome markers should be dropped wholesale.
// Each alternative carries its own internal word boundaries (e.g. \b after
// /clear, "esc to interrupt" ends on a word char). A wrapping pair of \b
// would break alternatives that end on a non-word char (e.g. "new task?").
const TUI_CHROME_LINE_RE = /(new task\?|\/clear\b|\/status\b|esc to interrupt|esc to exit|esc to cancel|\? for shortcuts|\[Request interrupted)/i;
// A line that is essentially a single bullet / punctuation glyph. Catches
// the lone "·", "•", and "…" emitted as TUI separators/status ticks.
// Allows optional surrounding whitespace and one trailing period.
const SINGLE_BULLET_LINE_RE = /^[\s ]*[·•‧․‥⁃⁌⁍…•·][\s ]*\.?[\s ]*$/u;
// Extra chrome that isn't already covered above: short token "1ct", a
// slash-hint "/artifact", and a TUI title that is just the product name.
// Each pattern is anchored to avoid swallowing real prose that happens to
// contain the same substring.
const EXTRA_CHROME_RE = /\b1ct\b|\/artifact\b/;
// Product-name-as-title lines (e.g. "✳ Claude Code" -> "Claude Code" after
// glyph strip; or just "Claude Code" with no surrounding prose). Match the
// whole line when it is JUST the product name (with optional leading glyph).
const PRODUCT_TITLE_CHROME_RE = /^[\s ]*(?:[✨✳✳✻✢◐◑◒◓]\s*)?Claude Code[\s ]*\.?[\s ]*$/u;
// Token counter alone (e.g. "428.1k tokens", "12k tokens used") on a line.
const TOKEN_ONLY_LINE_RE = /^[\s>]*\d+(?:\.\d+)?[kKmMbB]?\s*tokens?(?:\s+used)?[\s\d.]*$/i;
// Leading "✳ ◐ ◑ ◒ ◓" style glyphs (Orca title/icons).
const LEADING_GLYPH_RE = /^[✳✈✣✪✫✬✭✮✯✰✱✲✴✵✶✷✸✽✾✿❀❁❂❃❄❅❆❇❈❉❊❋❌❍❎❏❐❑❒❓❔❕❖❗❘❙❚❛❜❝❞❟❠❡❢❣❤❥❦❧❨❩❪❫❬❭❮❯❰❱❲❳❴❵❶❷❸❹❺❻❼❽❾❿➀➁➂➃➄◆◇◈◉◊○◌●◐◑◒◓◦◧◨◩◪◫◬◭◮◯◰◱◲◳◴◵◶◷☀☁☂☃☄★☆☇☈☉☊☋☌☍☎☏☐☑☒☓☔☕☖☗☘☙☚☛☜☝☞☟☠☡☢☣☤☥☦☧☨☩☪☫☬☭☮☯☰☱☲☳☴☵☶☷☸☹☺☻☼☽☾☿♀♁♂♃♄♅♆♇♈♉♊♋♌♍♎♏♐♑♒♓♔♕♖♗♘♙♚♛♜♝♞♟♠♡♢♣♤♥♦♧♨♩♪♫♬♭♮♯♰♱♲♳♴♵♶♷♸♹♺♻♼♽♾♿⚀⚁⚂⚃⚄⚅⚆⚇⚈⚉⚊⚋⚌⚍⚎⚏⚐⚑⚒⚓⚔⚕⚖⚗⚘⚙⚚⚛⚜⚝⚞⚟⚠⚡⚢⚣⚤⚥⚦⚧⚨⚩⚪⚫⚬⚭⚮⚯⚰⚱⚲⚳⚴⚵⚶⚷⚸⚹⚺⚻⚼⚽⚾⚿⛀⛁⛂⛃⛄⛅⛆⛇⛈⛉⛊⛋⛌⛍⛎⛏⛐⛑⛒⛓⛔⛕⛖⛗⛘⛙⛚⛛⛜⛝⛞⛟⛠⛡⛢⛣⛤⛥⛦⛧⛨⛩⛪⛫⛬⛭⛮⛯⛰⛱⛲⛳⛴⛵⛶⛷⛸⛹⛺⛻⛼⛽⛾⛿✀✁✂✃✄✅✆✇✈✉✊✋✌✍✎✏✐✑✒✓✔✕✖✗✘✙✚✛✜✝✞✟✠✡✢✣✤✥✦✧✨✩✪✫✬✭✮✯✰✱✲✳✴✵✶✷✸✹✺✻✼✽✾✿❀❁❂❃❄❅❆❇❈❉❊❋❌❍❎❏❐❑❒❓❔❕❖❗❘❙❚❛❜❝❞❟❠❡❢❣❤❥❦❧❨❩❪❫❬❭❮❯❰❱❲❳❴❵❶❷❸❹❺❻❼❽❾❿➀➁➂➃➄➅➆➇➈➉➊➋➌➍➎➏➐➑➒➓➔➕➖➗➘➙➚➛➜➝➞➟➠➡➢➣➤➥➦➧➨➩➪➫➬➭➮➯➰➱➲➳➴➵➶➷➸➹➺➻➼➽➾➿⟀⟁⟂⟃⟄⟅⟆⟇⟈⟉⟊⟋⟌⟍⟎⟏⟐⟑⟒⟓⟔⟕⟖⟗⟘⟙⟚⟛⟜⟝⟞⟟⟠⟡⟢⟣⟤⟥⟦⟧⟨⟩⟪⟫⟬⟭⟮⟯⟰⟱⟲⟳⟴⟵⟶⟷⟸⟹⟺⟻⟼⟽⟾⟿\u{1F300}-\u{1F6FF}\u{1F900}-\u{1F9FF}]+/u;

export function cleanPreview(preview) {
  if (preview == null) return null;
  const raw = String(preview);
  if (!raw || !raw.trim()) return null;
  const lines = raw.split(/\r?\n/);
  const kept = [];
  for (const ln of lines) {
    if (!ln || !ln.trim()) continue;
    if (SEPARATOR_LINE_RE.test(ln)) continue;
    if (TUI_CHROME_LINE_RE.test(ln)) continue;
    if (TOKEN_ONLY_LINE_RE.test(ln)) continue;
    // Strip leading glyph(s) used as Orca / TUI markers (e.g. "✳",
    // "◐", "◑", "◒", "◓", and various emoji-style markers).
    let t = ln.replace(/[\s]+/g, ' ').trim();
    t = t.replace(new RegExp('^' + LEADING_GLYPH_RE.source.slice(1) + '\\s*', 'u'), '');
    // Strip a few residual bracketed chrome tokens glued onto prose.
    t = t.replace(/^\s*\[esc[^\]]*\]\s*/i, '');
    t = t.replace(/^\s*\[Request interrupted[^\]]*\]\s*/i, '');
    t = t.replace(/^\s*\(esc to interrupt\)\s*/i, '');
    if (!t) continue;
    // NEW: a line that is just a single bullet / punctuation glyph.
    if (SINGLE_BULLET_LINE_RE.test(t)) continue;
    // NEW: a line whose MAX letter-run length is < 4 has no real prose.
    // Catches short standalone words ("ok", "yes", emoji + 2 letters) that
    // are not worth surfacing in a speech bubble.
    const letterRuns = t.match(/[A-Za-z]+/g) || [];
    let maxRun = 0;
    for (const r of letterRuns) if (r.length > maxRun) maxRun = r.length;
    if (maxRun < 4) continue;
    // NEW: a line that is dominated by "·" separators (status-bar fragments).
    // Two-or-more "·" is always rejected; one "·" is rejected when it claims
    // more than 30% of the non-space characters.
    const bulletCount = (t.match(/·/g) || []).length;
    if (bulletCount >= 2) continue;
    const nonSpace = t.replace(/\s/g, '').length;
    if (bulletCount > 0 && nonSpace > 0 && (bulletCount / nonSpace) > 0.3) continue;
    // NEW: extra chrome patterns (1ct, /artifact hint, "Claude Code" bare).
    if (EXTRA_CHROME_RE.test(t)) continue;
    // NEW: product-name as TUI title ("✳ Claude Code", "Claude Code", etc.)
    if (PRODUCT_TITLE_CHROME_RE.test(t)) continue;
    kept.push(t);
  }
  if (!kept.length) return null;
  const last = kept[kept.length - 1];
  // Final collapse (the TUI sometimes injects non-ascii whitespace) +
  // truncate to bubble width.
  const cleaned = String(last).replace(/\s+/g, ' ').trim();
  if (!cleaned) return null;
  return cleaned.length > SAID_MAX ? cleaned.slice(0, SAID_MAX) : cleaned;
}

// ---- extractActivity ---------------------------------------------------

// Light markdown strip: keep speech-bubble-friendly prose. Not exhaustive —
// just removes the worst offenders (code fences, inline code, link markup,
// bold/italic markers, leading list/heading markers).
function stripMdForBubble(s) {
  let t = String(s || '');
  t = t.replace(/```[\s\S]*?```/g, ' ');   // fenced code blocks
  t = t.replace(/`([^`]+)`/g, '$1');         // inline `code`
  t = t.replace(/\*\*([^*]+)\*\*/g, '$1');   // **bold**
  t = t.replace(/__([^_]+)__/g, '$1');       // __bold__
  t = t.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1$2'); // *italic*
  t = t.replace(/(^|[^_])_([^_\n]+)_(?!_)/g, '$1$2');     // _italic_
  t = t.replace(/^\s*#{1,6}\s+/gm, '');      // # heading
  t = t.replace(/^\s*[-*+]\s+/gm, '');       // - bullet
  t = t.replace(/^\s*\d+\.\s+/gm, '');       // 1. numbered
  t = t.replace(/^\s*>\s?/gm, '');           // > quote
  t = t.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1'); // [text](url) -> text
  t = t.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '$1'); // ![alt](url) -> alt
  t = t.replace(/<br\s*\/?>/gi, ' ');
  t = t.replace(/\s+/g, ' ').trim();
  return t;
}

function pickTs(o) {
  if (!o || typeof o !== 'object') return null;
  if (typeof o.timestamp === 'number' && Number.isFinite(o.timestamp)) return o.timestamp;
  if (typeof o.timestamp === 'string') {
    const n = Date.parse(o.timestamp);
    if (!Number.isNaN(n)) return n;
  }
  if (o.message && typeof o.message === 'object') {
    if (typeof o.message.ts === 'number') return o.message.ts;
  }
  return null;
}

// Pick the most-recent assistant action (tool_use summary) and most-recent
// assistant said (text, markdown-stripped). Each is independent — a tool-only
// assistant gives just `action`, a prose-only assistant gives just `said`.
// ts is the maximum of the two timestamps, or `now` when both are missing.
export function extractActivity(lines, opts) {
  const optsObj = opts || {};
  const now = (typeof optsObj.now === 'number') ? optsObj.now : Date.now();
  if (!Array.isArray(lines) || lines.length === 0) return null;
  let action = null;
  let said = null;
  let actionTs = null;
  let saidTs = null;
  // Walk newest -> oldest so the FIRST assistant we encounter with each kind
  // is the most recent.
  for (let i = lines.length - 1; i >= 0; i--) {
    const o = lines[i];
    if (!o || typeof o !== 'object') continue;
    if (o.type !== 'assistant') continue;
    const msg = o.message;
    if (!msg) continue;
    const ts = pickTs(o);
    const content = msg.content;
    if (Array.isArray(content)) {
      for (const block of content) {
        if (!block || typeof block !== 'object') continue;
        if (action === null && block.type === 'tool_use' && block.name) {
          const a = summarizeTool(block.name, block.input || {});
          if (a) { action = a; actionTs = ts; }
        }
        if (said === null && block.type === 'text' && typeof block.text === 'string' && block.text) {
          const stripped = stripMdForBubble(block.text);
          if (stripped) {
            const out = stripped.length > SAID_MAX ? stripped.slice(0, SAID_MAX) : stripped;
            said = out; saidTs = ts;
          }
        }
      }
    } else if (typeof content === 'string' && content) {
      if (said === null) {
        const stripped = stripMdForBubble(content);
        if (stripped) {
          said = stripped.length > SAID_MAX ? stripped.slice(0, SAID_MAX) : stripped;
          saidTs = ts;
        }
      }
    }
    if (action !== null && said !== null) break;
  }
  if (action === null && said === null) return null;
  let ts = null;
  const aTs = typeof actionTs === 'number' ? actionTs : null;
  const sTs = typeof saidTs === 'number' ? saidTs : null;
  if (aTs != null && sTs != null) ts = Math.max(aTs, sTs);
  else if (aTs != null) ts = aTs;
  else if (sTs != null) ts = sTs;
  if (typeof ts !== 'number' || !Number.isFinite(ts)) ts = now;
  return { action, said, ts };
}

// Build a terminal-preview-shaped activity. Helper so server.mjs doesn't have
// to repeat the shape; spec calls this out specifically.
export function terminalActivity(terminal, now) {
  if (!terminal || typeof terminal !== 'object') return null;
  const said = cleanPreview(terminal.preview);
  const lo = Number(terminal.lastOutputAt);
  const ts = (Number.isFinite(lo) && lo > 0) ? lo : (typeof now === 'number' ? now : Date.now());
  if (!said) return null;
  return { action: null, said, ts };
}
