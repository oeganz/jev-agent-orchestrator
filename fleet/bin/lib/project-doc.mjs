// Pure, no-dependency helpers for the project-doc template + tooling:
//   extractClaims(html)        -> [{id, source, evidence, text, page}, ...]
//   validateDoc(html, {root})  -> {ok, errors[], warnings[]}
//   gapReport(claims, review)  -> counts/coverage/sections for `fleet doc-gap`
//   formatGapReport(report, meta?) -> markdown for the same
//
// All shape contracts are defined by fleet/bin/project-doc.test.mjs, which was
// written first (TDD). The parser is a small state machine so we can keep
// script/style/comment regions out without pulling in a real HTML dependency.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export const SOURCES = new Set(['code', 'config', 'doc', 'inferred']);

// ---------- HTML parser -----------------------------------------------------

// Split an HTML string into a flat token stream. We do not need a DOM - we
// just need to walk tokens in document order, recognise open/close/self-closing
// tags, comments, and text, and ignore the contents of <script>/<style>.
// Returns: [{kind: 'open'|'close'|'self'|'comment'|'text', text}]
function splitTags(html) {
  const out = [];
  let i = 0;
  while (i < html.length) {
    if (html[i] !== '<') {
      const next = html.indexOf('<', i);
      const end = next === -1 ? html.length : next;
      const text = html.slice(i, end);
      if (text) out.push({ kind: 'text', text });
      i = end;
      continue;
    }
    const close = html.indexOf('>', i);
    if (close === -1) {
      out.push({ kind: 'text', text: html.slice(i) });
      break;
    }
    const raw = html.slice(i, close + 1);
    if (raw.startsWith('<!--')) {
      const end = html.indexOf('-->', i + 4);
      const stop = end === -1 ? html.length : end + 3;
      out.push({ kind: 'comment', text: html.slice(i, stop) });
      i = stop;
      continue;
    }
    const isClose = /^<\s*\//.test(raw);
    const selfClose = /\/\s*>$/.test(raw);
    out.push({ kind: isClose ? 'close' : (selfClose ? 'self' : 'open'), text: raw });
    i = close + 1;
  }
  return out;
}

function tagName(tag) {
  const m = /<\s*\/?\s*([a-zA-Z][a-zA-Z0-9]*)/.exec(tag);
  return m ? m[1].toLowerCase() : '';
}

function tagId(tag) {
  const m = /\bid\s*=\s*["']([^"']+)["']/.exec(tag);
  return m ? m[1] : null;
}

// A claim tag is one whose class list contains the literal token "claim"
// (a complete class name, not a prefix like "claim-popover" or "claimish").
// It does NOT require data-claim; a tag without data-claim still counts as a
// claim element and validateDoc will flag it as missing an id.
function isClaimTag(tag) {
  const m = /\bclass\s*=\s*["']([^"']+)["']/i.exec(tag);
  if (!m) return false;
  return m[1].split(/\s+/).some(t => t === 'claim');
}

const ATTR_RE = /(\bdata-(?:claim|source|evidence))\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
function readClaimAttrs(tag) {
  const out = { claim: null, source: '', evidence: null };
  ATTR_RE.lastIndex = 0;
  let m;
  while ((m = ATTR_RE.exec(tag))) {
    const key = m[1].replace(/^data-/, '');
    const val = m[2] !== undefined ? m[2] : m[3];
    out[key] = val;
  }
  return out;
}

// Decode the small set of HTML entities a project-doc needs. Limiting the
// surface keeps test expectations stable - the doc writer is the only author.
function decodeEntities(s) {
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ');
}

// Returns the inner JSON string of the <script id="doc-meta" type="application/json">
// block, or null if not present.
function findDocMeta(html) {
  const re = /<script\b([^>]*?)>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html))) {
    const attrs = m[1];
    if (/\bid\s*=\s*["']doc-meta["']/.test(attrs) && /\btype\s*=\s*["']application\/json["']/.test(attrs)) {
      return m[2];
    }
  }
  return null;
}

const REQUIRED_META_KEYS = ['project', 'doc_version', 'generated_by', 'generated_at', 'commit'];

// ---------- extractClaims ---------------------------------------------------
//
// Document-order extractor. State machine with three nested concerns:
//   skipStack    : element names whose interior is ignored ('script', 'style').
//   pageStack    : ids of open `.page-pane` divs; the top is the page
//                  attribution for any claim opened while it sits there.
//   claimStack   : open claim tags, each with its own text accumulator. The
//                  top is "active"; its accumulated text is the live textBuf.
//
// Closing a claim pops it from the stack, INLINES its decoded text into the
// parent's accumulator (so a nested claim's words appear in the parent's
// plain-text projection), then emits the finished claim in document order.
// This matches the test fixture:
//   <div class="claim" data-claim="C-002">Block claim with
//     <span class="claim" data-claim="C-003">nested inferred</span>
//     inside.
//   </div>
// -> C-001, C-002 ("Block claim with nested inferred inside."), C-003, ...

export function extractClaims(html) {
  const tokens = splitTags(html);
  const claims = [];
  const skipStack = [];
  const pageStack = [];
  // Open claims, each with a private text accumulator.
  // On open: emit a row in `claims` (so the row order is the OPEN order), and
  // push the accumulator onto the stack. On close: capture the text (with any
  // inner claim words inlined) and write it into the previously-emitted row.
  // This makes the parent's text include its descendants' text AND lets the
  // parent appear before its children in the output, which is the contract
  // the test fixture pins down.
  const stack = [];   // [{ textBuf: string, claimIdx, tagName }]

  function pushSkip(name) { skipStack.push(name); }
  function popSkip(name) {
    if (skipStack[skipStack.length - 1] === name) skipStack.pop();
  }

  for (const tok of tokens) {
    const name = tagName(tok.text);

    if (tok.kind === 'comment') continue;

    if (tok.kind === 'open' && (name === 'script' || name === 'style')) {
      pushSkip(name);
      continue;
    }
    if (skipStack.length) {
      if (tok.kind === 'close' && (name === 'script' || name === 'style')) popSkip(name);
      continue;
    }

    if (tok.kind === 'open') {
      if (name === 'div' && /\bclass\s*=\s*["'][^"']*\bpage-pane\b/.test(tok.text)) {
        const id = tagId(tok.text);
        if (id) pageStack.push({ id, depth: 1 });
        else pageStack.push({ id: null, depth: 1 });
      } else if (name === 'div' && pageStack.length) {
        pageStack[pageStack.length - 1].depth++;
      }

      if (isClaimTag(tok.text)) {
        const attrs = readClaimAttrs(tok.text);
        const page = pageStack.length ? pageStack[pageStack.length - 1].id : null;
        const claimIdx = claims.length;
        claims.push({ id: attrs.claim, source: attrs.source, evidence: attrs.evidence, text: '', page });
        stack.push({ textBuf: '', claimIdx, tagName: name });
        continue;
      }
    }

    if (tok.kind === 'text') {
      if (stack.length) stack[stack.length - 1].textBuf += tok.text;
      continue;
    }

    if (tok.kind === 'close') {
      if (name === 'div' && pageStack.length) {
        const top = pageStack[pageStack.length - 1];
        top.depth--;
        if (top.depth === 0) pageStack.pop();
      }
      if ((name === 'span' || name === 'div') && stack.length) {
        const top = stack[stack.length - 1];
        if (top.tagName === name) {
          top.textBuf = top.textBuf.trim();
          const decoded = decodeEntities(top.textBuf);
          stack.pop();
          // Inline this claim's decoded text into its parent's accumulator,
          // collapsing any whitespace run between the existing text and the
          // child's words into a single space.
          if (stack.length) {
            const parent = stack[stack.length - 1];
            const trimmed = parent.textBuf.replace(/\s+$/, '');
            parent.textBuf = (trimmed ? trimmed + ' ' : '') + decoded;
          }
          // Patch the row that was queued on open with the now-known text.
          claims[top.claimIdx].text = decoded;
        }
      }
    }
  }
  return claims;
}

// ---------- validateDoc -----------------------------------------------------

export function validateDoc(html, opts = {}) {
  const { root } = opts;
  const errors = [];
  const warnings = [];

  const metaRaw = findDocMeta(html);
  if (metaRaw == null) {
    errors.push('doc-meta missing: no <script type="application/json" id="doc-meta"> found');
  } else {
    let meta = null;
    try { meta = JSON.parse(metaRaw); }
    catch (e) { errors.push('doc-meta invalid JSON: ' + (e?.message || e)); }
    if (meta) {
      for (const k of REQUIRED_META_KEYS) if (!(k in meta)) errors.push('doc-meta missing key: ' + k);
    }
  }

  let claims;
  try { claims = extractClaims(html); }
  catch (e) {
    errors.push('extractClaims threw: ' + (e?.message || e));
    return { ok: false, errors, warnings };
  }

  if (!claims.length) warnings.push('no claims found in document');

  const seen = new Map();
  for (const c of claims) {
    if (!c.id) { errors.push('claim without data-claim id found in document'); continue; }
    seen.set(c.id, (seen.get(c.id) || 0) + 1);
  }
  for (const [id, n] of seen) if (n > 1) errors.push(`duplicate claim id ${id} (${n} occurrences)`);

  for (const c of claims) {
    if (!c.id) continue;
    if (!SOURCES.has(c.source)) errors.push(`${c.id}: source "${c.source}" not in ${JSON.stringify([...SOURCES])}`);
    if (c.source !== 'inferred' && !c.evidence) errors.push(`${c.id}: missing data-evidence`);
    if (c.evidence && root) {
      const ev = validateEvidence(c.evidence, root);
      if (ev.err) errors.push(`${c.id}: ${ev.err}`);
      else if (c.source !== 'inferred' && ev.kind === 'line') {
        // For non-inferred claims, the cited line must actually carry the
        // statement. A blank/whitespace-only line means the evidence pointer
        // is wrong (a real bug shipped before this check existed - OV-10,
        // AR-6, LG-4, JV-1 in docs/project-doc.html all pointed at blank
        // lines). Error, not warn: a blank-line evidence pointer is never
        // the intended state.
        // Anchors have no line number, so this check only makes sense for
        // the line form.
        if (ev.line.trim() === '') errors.push(`${c.id}: cited line ${c.evidence} is blank or whitespace-only`);
        else checkUnsupportedNumber(c, ev, warnings);
      }
    }
    if (!c.page) warnings.push(`${c.id}: not inside a page-pane`);
    // Tiny text is usually noise ("x", "ab"). Keep it a warning so the
    // author can decide; it doesn't block the doc.
    if (c.source !== 'inferred' && c.text.trim().length > 0 && c.text.trim().length < 3) {
      warnings.push(`${c.id}: claim text is shorter than 3 characters ("${c.text}")`);
    }
  }
  if (root == null) warnings.push('no root supplied to validateDoc - evidence file checks skipped');
  return { ok: errors.length === 0, errors, warnings };
}

// validateEvidence returns {err} on failure or {rel, kind, ...} on success.
//
// Two evidence forms, dispatch on the first '#' separator:
//   - line form: "path:line" or "path:line-line"
//     -> returns {rel, start, line, window, kind: 'line'}.
//        window is the cited line plus +/-15 lines (the neighborhood a human
//        reviewer would scan). window lets the "number in claim text not in
//        the evidence" check see a useful slice without being tricked by a
//        too-narrow one-line look.
//   - anchor form: "path#anchor"  (anchor is a substring that must literally
//     exist in the file, after CRLF->LF normalisation so a checkout on
//     Windows with core.autocrlf=true still validates against LF text)
//     -> returns {rel, anchor, kind: 'anchor'}.
//
// We only call checkUnsupportedNumber on the line form; anchors are not
// positional, so blank-line / unsupported-number checks have no meaning.
function validateEvidence(ev, root) {
  const hashIdx = ev.indexOf('#');
  if (hashIdx !== -1) return validateAnchorEvidence(ev, hashIdx, root);
  return validateLineEvidence(ev, root);
}

function validateAnchorEvidence(ev, hashIdx, root) {
  const rel = ev.slice(0, hashIdx);
  const anchor = ev.slice(hashIdx + 1);
  if (rel === '' || rel.includes('..')) return { err: `evidence escapes root: ${rel || ev}` };
  if (/^[a-zA-Z]:[\\/]/.test(rel) || rel.startsWith('/')) return { err: `evidence escapes root (absolute path): ${rel}` };
  if (anchor === '' || anchor.trim() === '') return { err: `evidence anchor is empty or whitespace-only: ${ev}` };
  const abs = join(root, rel);
  if (!existsSync(abs)) return { err: `evidence file not found: ${rel}` };
  let text;
  try { text = readFileSync(abs, 'utf8'); } catch (e) { return { err: `evidence file unreadable: ${rel}` }; }
  // The worktree may have CRLF (core.autocrlf=true) while `git show` and the
  // anchor the spec pins are LF. Normalise so an LF-pinned anchor matches
  // either text encoding.
  const normalised = text.replace(/\r\n/g, '\n');
  if (!normalised.includes(anchor)) {
    return { err: `evidence anchor not found in ${rel}: ${JSON.stringify(anchor)}` };
  }
  return { rel, anchor, kind: 'anchor' };
}

function validateLineEvidence(ev, root) {
  // Permit a leading "-" so we can error on negative line numbers with a
  // meaningful message ("must be >= 1") instead of the generic "malformed
  // evidence". Real numbers in code are always positive, so this stays safe.
  const m = /^([^:#]+):(-?\d+)(?:-(-?\d+))?$/.exec(ev);
  if (!m) return { err: `malformed evidence (expected path:line, path:line-line, or path#anchor): ${ev}` };
  const rel = m[1];
  if (rel.includes('..')) return { err: `evidence escapes root: ${rel}` };
  if (/^[a-zA-Z]:[\\/]/.test(rel) || rel.startsWith('/')) return { err: `evidence escapes root (absolute path): ${rel}` };
  const abs = join(root, rel);
  if (!existsSync(abs)) return { err: `evidence file not found: ${rel}` };
  let text;
  try { text = readFileSync(abs, 'utf8'); } catch (e) { return { err: `evidence file unreadable: ${rel}` }; }
  // Count "lines" as content lines: a trailing newline doesn't add a phantom
  // line. The fixture writes `'line1\nline2\nline3\n'` and the test expects 3
  // lines, not 4.
  const content = text.replace(/\n$/, '');
  const lines = content.split('\n');
  const start = parseInt(m[2], 10);
  const end = m[3] ? parseInt(m[3], 10) : start;
  // Line numbers are 1-based. The regex `\d+` matches `0`; catch it here so
  // we never silently read lines[-1] (the last line).
  if (start < 1) return { err: `line number ${start} must be >= 1: ${ev}` };
  if (start > lines.length) return { err: `line ${start} beyond end of ${rel} (${lines.length} lines)` };
  if (end > lines.length) return { err: `line ${end} beyond end of ${rel}` };
  const startWindow = Math.max(1, start - 15);
  const endWindow = Math.min(lines.length, start + 15);
  const window = lines.slice(startWindow - 1, endWindow).join('\n');
  const line = lines[start - 1];
  return { rel, start, line, window, kind: 'line' };
}

// Heuristic: when a code/config claim's text contains a number, that number
// should appear in the cited line OR in the +/-15 region around it. If it
// doesn't, the claim is probably a "the line does not obviously support the
// number" case (see OP-14..OP-23 in docs/project-doc.html before T2c) - the
// number was obtained by running a command, which has no static line. Keep
// it a warning: the author may be right (a number computed by summing
// nearby blocks, a comment about the number, etc.) but a reviewer should
// confirm.
function checkUnsupportedNumber(c, ev, warnings) {
  if (c.source !== 'code' && c.source !== 'config') return;
  const text = c.text;
  const re = /\d+/g;
  let m;
  while ((m = re.exec(text))) {
    const num = m[0];
    if (ev.line.includes(num)) continue;
    if (ev.window.includes(num)) continue;
    warnings.push(`${c.id}: text contains number "${num}" not found near ${c.evidence} (reviewer should confirm)`);
  }
}

// ---------- gapReport -------------------------------------------------------

const VERDICTS = ['agree', 'wrong', 'unsure'];

export function gapReport(claims, review) {
  const total = claims.length;
  let rows = [];
  let meta = {};
  if (Array.isArray(review)) rows = review;
  else if (review && typeof review === 'object') {
    if (Array.isArray(review.reviews)) rows = review.reviews;
    meta = { project: review.project, doc_version: review.doc_version, reviewer: review.reviewer, reviewed_at: review.reviewed_at };
  }

  const verdictById = new Map();
  const invalid = [];
  for (const r of rows) {
    if (!r || typeof r !== 'object' || !r.id) continue;
    if (!VERDICTS.includes(r.verdict)) {
      invalid.push({ id: r.id, verdict: r.verdict });
      continue;
    }
    verdictById.set(r.id, r); // later rows win
  }
  const knownIds = new Set(claims.map(c => c.id));
  const reviewed = [...verdictById.keys()].filter(id => knownIds.has(id)).length;

  // Pre-initialise every known source so callers see consistent keys even when
  // a source has zero claims (matches the test fixture's expectation of an
  // empty `doc` bucket).
  const bySourceVerdict = {};
  for (const s of SOURCES) bySourceVerdict[s] = { agree: 0, wrong: 0, unsure: 0, unreviewed: 0 };

  const byVerdict = { agree: 0, wrong: 0, unsure: 0, unreviewed: 0 };
  for (const c of claims) {
    const v = verdictById.get(c.id);
    const verdict = v ? v.verdict : 'unreviewed';
    byVerdict[verdict]++;
    const bucket = bySourceVerdict[c.source] || (bySourceVerdict[c.source] = { agree: 0, wrong: 0, unsure: 0, unreviewed: 0 });
    bucket[verdict]++;
  }

  const wrong = [];
  const unsure = [];
  for (const c of claims) {
    const v = verdictById.get(c.id);
    if (!v) continue;
    const item = { id: c.id, note: v.note || '', text: c.text, source: c.source, evidence: c.evidence, page: c.page };
    if (v.verdict === 'wrong') wrong.push(item);
    else if (v.verdict === 'unsure') unsure.push(item);
  }
  const inferredWrong = wrong.filter(w => w.source === 'inferred');

  const unknownIds = [...new Set(rows.map(r => r?.id).filter(id => id && !knownIds.has(id)))];
  const coverage = total === 0 ? 0 : reviewed / total;
  return {
    total, reviewed, coverage,
    byVerdict, bySourceVerdict,
    wrong, unsure, inferredWrong, invalid, unknownIds,
    meta,
  };
}

// ---------- formatGapReport -------------------------------------------------

export function formatGapReport(report, meta) {
  const m = { ...(report.meta || {}), ...(meta || {}) };
  const pct = (n) => Math.round(n * 100);
  const lines = [];
  lines.push('# Gap report');
  lines.push('');
  if (m.project) lines.push(`Project: ${m.project}` + (m.doc_version ? ` (v${m.doc_version})` : ''));
  if (m.reviewer) lines.push(`Reviewer: ${m.reviewer}`);
  if (m.reviewed_at) lines.push(`Reviewed at: ${m.reviewed_at}`);
  lines.push('');
  lines.push(`Coverage: ${report.reviewed}/${report.total} (${pct(report.coverage)}%)`);
  const v = report.byVerdict;
  lines.push(`Verdicts: agree ${v.agree}, wrong ${v.wrong}, unsure ${v.unsure}, unreviewed ${v.unreviewed}`);
  lines.push('');
  const sources = Object.keys(report.bySourceVerdict).sort();
  if (sources.length) {
    lines.push('## Per source');
    lines.push('');
    lines.push('| source | agree | wrong | unsure | unreviewed |');
    lines.push('| --- | ---: | ---: | ---: | ---: |');
    for (const s of sources) {
      const r = report.bySourceVerdict[s];
      lines.push(`| ${s} | ${r.agree} | ${r.wrong} | ${r.unsure} | ${r.unreviewed} |`);
    }
    lines.push('');
  }
  const section = (title, items, fmt) => {
    if (!items.length) return;
    lines.push(`## ${title} (${items.length})`);
    lines.push('');
    for (const it of items) lines.push(fmt(it));
    lines.push('');
  };
  section('Wrong', report.wrong, (w) => `- **${w.id}** (${w.source}${w.evidence ? `, ${w.evidence}` : ''})${w.page ? ` — ${w.page}` : ''}: ${w.text}${w.note ? ` — note: ${w.note}` : ''}`);
  section('Unsure', report.unsure, (u) => `- **${u.id}** (${u.source}${u.evidence ? `, ${u.evidence}` : ''})${u.page ? ` — ${u.page}` : ''}: ${u.text}${u.note ? ` — note: ${u.note}` : ''}`);
  section('Inferred and wrong', report.inferredWrong, (w) => `- **${w.id}**: ${w.text}${w.note ? ` — note: ${w.note}` : ''}`);
  section('Unknown ids', report.unknownIds.map(id => ({ id })), (u) => `- **${u.id}** (not in doc)`);
  if (report.invalid?.length) {
    lines.push(`## Invalid verdicts (${report.invalid.length})`);
    lines.push('');
    for (const v of report.invalid) lines.push(`- ${v.id} verdict="${v.verdict}"`);
    lines.push('');
  }
  return lines.join('\n');
}