# Test fixtures

- `on9log_demo_output.bin`: SLIP-framed output of the on9log Unix demo
  (ESP-IDF component, examples/on9log_unix_demo.cpp), captured from a
  Linux x86-64 build. ~8KB. Used by `demo-integration.test.ts` to verify
  the decoder against real firmware output.

The matching ELF (`/tmp/on9log_unix_demo`, ~1MB) is NOT checked in because
of its size. Regenerate it locally with:

```sh
scripts/build-on9log-fixtures.sh
```

Tests that need the real ELF skip gracefully when it is absent; the
synthetic-ELF tests in `logging.test.ts` and `elf/` do not need it.
