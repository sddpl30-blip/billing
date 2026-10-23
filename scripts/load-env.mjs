/**
 * Loads a `.env` file into process.env, if there is one.
 *
 * `dotenv` cannot be installed in the environment this was written in, and the
 * file format is small enough that depending on a package for it is not worth
 * the supply chain. This reads the same subset everything else does:
 * `KEY=value`, `export KEY=value`, optional single or double quotes, `#`
 * comments, blank lines.
 *
 * Two rules it does not break:
 *
 *  · A variable already in the environment wins. A `.env` left on a server
 *    must not quietly override what systemd, Docker or a shell set — that is
 *    how a deployment ends up pointing at the wrong database.
 *  · Nothing is logged. The file holds the database password; it reports how
 *    many variables it set and their names, never a value.
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export function loadEnv(file = '.env', { quiet = true } = {}) {
  const path = resolve(process.cwd(), file);
  if (!existsSync(path)) return { loaded: false, keys: [] };

  const keys = [];
  for (const rawLine of readFileSync(path, 'utf8').split('\n')) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;

    const withoutExport = line.startsWith('export ') ? line.slice(7).trim() : line;
    const at = withoutExport.indexOf('=');
    if (at <= 0) continue;

    const key = withoutExport.slice(0, at).trim();
    let value = withoutExport.slice(at + 1).trim();

    // Quotes are stripped; a value is otherwise taken literally, including the
    // '&' and '?' that a connection string is full of.
    if ((value.startsWith('"') && value.endsWith('"') && value.length > 1)
      || (value.startsWith("'") && value.endsWith("'") && value.length > 1)) {
      value = value.slice(1, -1);
    }

    if (process.env[key] === undefined || process.env[key] === '') {
      process.env[key] = value;
      keys.push(key);
    }
  }

  if (!quiet && keys.length > 0) {
    // Names only. Never values.
    console.log(`loaded ${keys.length} variable(s) from ${file}: ${keys.join(', ')}`);
  }
  return { loaded: true, keys };
}
