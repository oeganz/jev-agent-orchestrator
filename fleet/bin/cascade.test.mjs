import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { pickSlot, resolveSlot, shouldEscalate, nextSlot, bucketByScan, LADDER } from './lib/cascade.mjs';

const cfg = JSON.parse(readFileSync(new URL('../config.json', import.meta.url), 'utf8'));
const esc = cfg.models.escalation;

test('escalates on gate rejection', () => {
  assert.equal(shouldEscalate({ gateVerdict: 'rework' }, esc).escalate, true);
});
test('escalates on test failure', () => {
  assert.equal(shouldEscalate({ testVerdict: 'rework-needed' }, esc).escalate, true);
});
test('escalates on a JEV flag over threshold', () => {
  assert.equal(shouldEscalate({ jevVerdict: { maxFlag: 0.80 } }, esc).escalate, true);
});
test('does NOT escalate when everything is clean', () => {
  const r = shouldEscalate({ gateVerdict: 'accept', testVerdict: 'verified' }, esc);
  assert.equal(r.escalate, false);
  assert.equal(r.reason, 'clean');
});
test('stops escalating at max_escalations', () => {
  assert.equal(shouldEscalate({ gateVerdict: 'rework', escalations: 2 }, esc).reason, 'max_escalations_reached');
});
test('never claims a model id from the policy - slots only', () => {
  // The policy must contain slot names, not provider ids (spec 15.8).
  for (const role of Object.keys(cfg.models.policy))
    for (const v of Object.values(cfg.models.policy[role]))
      assert.ok(LADDER.includes(v), 'policy value is not a slot: ' + v);
});
test('an unmapped slot omits --model rather than guessing', () => {
  assert.deepEqual(resolveSlot('sonnet', {}), { model: null, path: 'unknown-slot' });
  const noEnv = resolveSlot('haiku', { haiku: { env: 'NOT_SET_ANYWHERE' } }, {});
  assert.equal(noEnv.model, null);
  assert.equal(noEnv.path, 'inherit');
});
test('scan bucket escalates with size', () => {
  assert.equal(bucketByScan({ files: 1, bytes: 100 }), 'trivial');
  assert.equal(bucketByScan({ files: 200, bytes: 2000000 }), 'large');
});
test('ladder tops out', () => {
  assert.equal(nextSlot('sonnet'), 'opus');
  assert.equal(nextSlot('fable'), null);
});
test('engineer policy maps a small task to a slot', () => {
  assert.equal(pickSlot('engineer', 'small', cfg.models.policy), 'sonnet');
});
