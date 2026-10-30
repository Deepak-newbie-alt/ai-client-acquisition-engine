#!/bin/sh
# Creates a separate database for the automated test suite.
set -eu
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
  -c "CREATE DATABASE ace_test OWNER \"$POSTGRES_USER\";"
