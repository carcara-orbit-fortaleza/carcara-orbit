import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Minimal .env loader for local development. Existing process environment
 * variables take precedence, so production deployments can inject secrets.
 */
export function loadEnvFile(file = join(process.cwd(), '.env')): void {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return;
  }

  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) continue;
    let value = match[2].trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[match[1]] === undefined || process.env[match[1]] === '') {
      process.env[match[1]] = value;
    }
  }
}
