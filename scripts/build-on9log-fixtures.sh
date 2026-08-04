#!/usr/bin/env bash
# Builds the on9log Unix demo ELF and captures its SLIP output for tests.
# Prereqs: gcc, g++ (C++23), the on9log component sources.
set -euo pipefail

ON9LOG_DIR="${1:-$HOME/Projects/on9log_demo/components/on9log}"
OUT_DIR="${2:-/tmp}"
BUILD_DIR="$(mktemp -d)"

echo "building on9log unix demo from $ON9LOG_DIR"
gcc -std=gnu11 -O0 -g -D'ATOMIC_VAR_INIT(x)=(x)' -I"$ON9LOG_DIR" -c "$ON9LOG_DIR/on9log.c" -o "$BUILD_DIR/on9log.o"
gcc -std=gnu11 -O0 -g -D'ATOMIC_VAR_INIT(x)=(x)' -I"$ON9LOG_DIR" -c "$ON9LOG_DIR/on9log_unix_port.c" -o "$BUILD_DIR/on9log_unix_port.o"
gcc -std=gnu11 -O0 -g -D'ATOMIC_VAR_INIT(x)=(x)' -I"$ON9LOG_DIR" -c "$ON9LOG_DIR/on9log_unix_stdio.c" -o "$BUILD_DIR/on9log_unix_stdio.o"
g++ -std=c++23 -O0 -g -I"$ON9LOG_DIR" -I"$ON9LOG_DIR/external/fmt/include" \
  -c "$ON9LOG_DIR/examples/on9log_unix_demo.cpp" -o "$BUILD_DIR/demo.o"
g++ -no-pie -pthread "$BUILD_DIR"/*.o -o "$OUT_DIR/on9log_unix_demo"

echo "capturing SLIP output"
"$OUT_DIR/on9log_unix_demo" > "$OUT_DIR/on9log_demo_output.bin" 2>/dev/null

echo "fixtures ready:"
ls -la "$OUT_DIR/on9log_unix_demo" "$OUT_DIR/on9log_demo_output.bin"
