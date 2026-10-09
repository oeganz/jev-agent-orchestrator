// Minimal .env loader. Zero dependencies.
// Real environment variables always win - .env only fills what is missing, so a
// shell export overrides the file rather than being clobbered by it.
import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_ENV = join(HERE, '..', '..', '..', '.env');   // Agent/Orchestrator/.env
const DEFAULT_SETTINGS = join(homedir(), '.claude', 'settings.json');

export function loadEnv(path = DEFAULT_ENV, env = process.env) {
  if (!existsSync(path)) return { loaded: false, path, keys: [] };
  const keys = [];
  for (const raw of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 1) continue;
    const k = line.slice(0, eq).trim();
    let v = line.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (!(k in env)) { env[k] = v; keys.push(k); }
  }
  return { loaded: true, path, keys };
}

// Also read the env block of ~/.claude/settings.json, which is where the user
// keeps JEV_API_KEY. Precedence, weakest first: settings.json env < .env <
// real process env. A shell export always wins over both files.
export function loadSettingsEnv(path = DEFAULT_SETTINGS, env = process.env) {
  if (!existsSync(path)) return { loaded: false, keys: [] };
  let cfg; try { cfg = JSON.parse(readFileSync(path, "utf8")); } catch (e) { return { loaded: false, error: String(e.message) }; }
  const keys = [];
  for (const [k, v] of Object.entries(cfg.env || {})) {
    if (!(k in env)) { env[k] = String(v); keys.push(k); }
  }
  return { loaded: true, keys };
}
