// Tool-call capability probe. A model that cannot produce valid tool calls emits
// TEXT describing a call instead of calling it - and a fleet worker on such a
// model fails while looking like it is working. That is the worst failure shape,
// so doctor checks for it.
//
// The probe asserts BEHAVIOUR: it asks for a tool call whose ONLY way to produce
// the expected output is to actually call a tool.
//
// Design note, learned the hard way: the first version asked the model to READ an
// arbitrary temp file and echo its contents. A capable model correctly REFUSED -
// "read this file and reply with only its contents" is the shape of an
// exfiltration probe, and a well-behaved agent should decline it. That is a false
// negative by design. Ask for something ordinary instead.
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';

export function probeToolCalls({ timeoutMs = 120000, cwd = process.cwd() } = {}) {
  const token = 'PROBE' + randomBytes(3).toString('hex').toUpperCase();
  const prompt = 'Using your Bash tool, run exactly this command: echo ' + token
    + '   Then reply with only the output of that command.';
  const cmdline = 'claude -p ' + JSON.stringify(prompt) + ' < /dev/null';
  const r = spawnSync('bash', ['-lc', cmdline], { cwd, encoding: 'utf8', timeout: timeoutMs });
  const out = String(r.stdout || '') + String(r.stderr || '');
  const called = out.includes(token);
  // These markers mean the model wrote a call instead of making one.
  const emittedAsText = out.includes('<invoke') || out.includes('<tool_call') || out.includes(']<]');
  const m = out.match(/\[claude-code:unrecognized_model\]\s*(\{[^}]*\})/);
  let model = null;
  if (m) { try { model = JSON.parse(m[1]).model; } catch { model = null; } }

  let note;
  if (called) note = 'model called a tool and returned its real output';
  else if (emittedAsText) note = 'model EMITTED A TOOL CALL AS TEXT instead of calling it - workers on this route will do nothing while appearing to work';
  else if (!out.trim()) note = 'no output - probe inconclusive';
  else note = 'model replied without calling the tool - do NOT dispatch workers on this route';

  return { ok: called, tool_called: called, emitted_call_as_text: emittedAsText, model_reported: model, ran: out.trim().length > 0, note };
}
