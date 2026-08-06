#!/usr/bin/env bash
# Runs the test suite against the isolated test database so the dev MQTT
# broker / QEMU firmware E2E can keep running without stealing command
# rows from concurrently running tests.
#
# Usage: bash scripts/test.sh [bun test args...]
set -euo pipefail
cd "$(dirname "$0")/.."

export TEST_DATABASE_URL="${TEST_DATABASE_URL:-postgres://soulcloud:soulcloud@127.0.0.1:5432/soulcloud_test}"

bun scripts/prepare-test-db.ts
# the web package has its own suite (happy-dom); exclude it here
DATABASE_URL="$TEST_DATABASE_URL" bun test --path-ignore-patterns="packages/web/**" "$@"
