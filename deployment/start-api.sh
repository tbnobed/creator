#!/bin/sh
set -eu

echo "Applying versioned database migrations..."
node --enable-source-maps /app/artifacts/api-server/dist/migrate.mjs

echo "Starting OBTV API..."
exec node --enable-source-maps /app/artifacts/api-server/dist/index.mjs