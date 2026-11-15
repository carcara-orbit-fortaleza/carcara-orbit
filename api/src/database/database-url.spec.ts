import { describe, expect, it } from 'vitest';
import { resolveDatabaseUrl } from './database-url.js';

describe('resolveDatabaseUrl', () => {
  it('prefers an explicit DATABASE_URL', () => {
    expect(
      resolveDatabaseUrl({
        DATABASE_URL: 'postgresql://user:pass@example:5432/db',
        DB_USER: 'ignored',
        DB_PASSWORD: 'ignored',
        DB_NAME: 'ignored',
      }),
    ).toBe('postgresql://user:pass@example:5432/db');
  });

  it('builds a URL from DB_* and percent-encodes credentials', () => {
    expect(
      resolveDatabaseUrl({
        DB_USER: 'carcara',
        DB_PASSWORD: 'p@ss:word',
        DB_NAME: 'orbit',
        DB_HOST: 'db',
        DB_PORT: '5433',
      }),
    ).toBe('postgresql://carcara:p%40ss%3Aword@db:5433/orbit');
  });

  it('returns null when the database is not configured', () => {
    expect(resolveDatabaseUrl({})).toBeNull();
    expect(resolveDatabaseUrl({ DB_USER: 'carcara', DB_NAME: 'orbit' })).toBeNull();
  });
});
