/**
 * Resolves the Postgres connection string.
 *
 * DATABASE_URL wins when provided. Otherwise the compose-style DB_* variables
 * are used, with the Docker network hostname as the default.
 */
export function resolveDatabaseUrl(
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const explicit = env.DATABASE_URL?.trim();
  if (explicit) return explicit;

  const user = env.DB_USER?.trim();
  const password = env.DB_PASSWORD;
  const name = env.DB_NAME?.trim();
  if (!user || !password || !name) return null;

  const host = env.DB_HOST?.trim() || 'db';
  const port = env.DB_PORT?.trim() || '5432';
  const encodedUser = encodeURIComponent(user);
  const encodedPassword = encodeURIComponent(password);
  return `postgresql://${encodedUser}:${encodedPassword}@${host}:${port}/${name}`;
}
