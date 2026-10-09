import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

import { countRunDirs } from './hello.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const scriptPath = join(here, 'hello.mjs');

test('countRunDirs returns 0 when the runs directory does not exist', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'hello-test-'));
  try {
    const missing = join(tmp, 'does-not-exist');
    assert.equal(countRunDirs(missing), 0);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('countRunDirs counts immediate subdirectories only', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'hello-test-'));
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

test('countRunDirs returns 0 for an empty runs directory', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'hello-test-'));
  try {
    assert.equal(countRunDirs(tmp), 0);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('hello.mjs prints "runs: <n>" as a single line and resolves paths relative to repo root', () => {
  const result = spawnSync(process.execPath, [scriptPath], {
    cwd: tmpdir(),
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, `hello.mjs exited non-zero: ${result.stderr}`);
  const stdout = result.stdout;
  const lines = stdout.split(/\r?\n/);
  assert.match(lines[0], /^runs: \d+$/, `unexpected first line: ${JSON.stringify(lines[0])}`);
  assert.equal(lines[1], '', `expected exactly one line, got: ${JSON.stringify(stdout)}`);
});