#!/bin/sh
set -e

# Apply pending Postgres migrations before starting the API. The DATABASE_URL
# is built from DB_* by scripts/migrate.mjs when it is not provided directly.
if [ -n "$DATABASE_URL" ] || { [ -n "$DB_USER" ] && [ -n "$DB_NAME" ]; }; then
  node scripts/migrate.mjs
else
  echo "Postgres não configurado; pulando migrações."
fi

exec "$@"
