import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { countRunDirs } from './count.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const scriptPath = join(here, 'count.mjs');

test('countRunDirs returns 0 when the runs directory does not exist', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'count-test-'));
  try {
    const missing = join(tmp, 'does-not-exist');
    assert.equal(countRunDirs(missing), 0);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('countRunDirs counts immediate subdirectories only', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'count-test-'));
  try {
    mkdirSync(join(tmp, 'a'));
    mkdirSync(join(tmp, 'b'));
    mkdirSync(join(tmp, 'c'));
    writeFileSync(join(tmp, 'stray.txt'), 'not a dir');
    mkdirSync(join(tmp, 'a', 'nested-1'));
    mkdirSync(join(tmp, 'a', 'nested-2'));
    assert.equal(countRunDirs(tmp), 3);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('countRunDirs does not count files at the runs root (only directories)', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'count-test-'));
  try {
    mkdirSync(join(tmp, 'one'));
    writeFileSync(join(tmp, '.gitkeep'), '');
    writeFileSync(join(tmp, 'stray.txt'), '');
    assert.equal(countRunDirs(tmp), 1);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('countRunDirs returns 0 for an empty runs directory', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'count-test-'));
  try {
    assert.equal(countRunDirs(tmp), 0);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('count.mjs prints "runs: <n>" as a single line and resolves paths relative to script location', () => {
  const result = spawnSync(process.execPath, [scriptPath], {
    cwd: tmpdir(),
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, `count.mjs exited non-zero: ${result.stderr}`);
  const stdout = result.stdout;
  const lines = stdout.split(/\r?\n/);
  assert.match(lines[0], /^runs: \d+$/, `unexpected first line: ${JSON.stringify(lines[0])}`);
  assert.equal(lines[1], '', `expected exactly one line, got: ${JSON.stringify(stdout)}`);
});

test('count.mjs with --dir <path> counts run directories under that path', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'count-test-dir-'));
  try {
    mkdirSync(join(tmp, 'r1'));
    mkdirSync(join(tmp, 'r2'));
    mkdirSync(join(tmp, 'r3'));
    mkdirSync(join(tmp, 'r4'));
    mkdirSync(join(tmp, 'r5'));
    writeFileSync(join(tmp, 'note.txt'), '');
    const result = spawnSync(process.execPath, [scriptPath, '--dir', tmp], {
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, `count.mjs exited non-zero: ${result.stderr}`);
    assert.equal(result.stdout, 'runs: 5\n');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('count.mjs with --dir and no value fails: non-zero exit and an error on stderr', () => {
  const result = spawnSync(process.execPath, [scriptPath, '--dir'], {
    encoding: 'utf8',
  });
  assert.notEqual(result.status, 0, `expected non-zero exit, got ${result.status}`);
  assert.ok(
    result.stderr.trim().length > 0,
    'expected a non-empty stderr message when --dir has no value',
  );
});

test('count.mjs accepts the --dir=path equals form', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'count-test-'));
  try {
    mkdirSync(join(tmp, 'x'));
    mkdirSync(join(tmp, 'y'));
    const result = spawnSync(process.execPath, [scriptPath, '--dir=' + tmp], { encoding: 'utf8' });
    assert.equal(result.status, 0, 'expected zero exit, got ' + result.status + ' stderr=' + result.stderr);
    assert.equal(result.stdout.trim(), 'runs: 2', 'equals form was ignored - got ' + JSON.stringify(result.stdout));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('count.mjs rejects an unrecognised argument instead of ignoring it', () => {
  const result = spawnSync(process.execPath, [scriptPath, '--bogus'], { encoding: 'utf8' });
  assert.notEqual(result.status, 0, 'unknown args must not exit 0');
  assert.ok(result.stderr.length > 0, 'unknown args must write to stderr');
});
