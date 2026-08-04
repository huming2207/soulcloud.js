# Test fixtures

- `on9log_demo_output.bin`: SLIP-framed output of the on9log Unix demo
  (ESP-IDF component, examples/on9log_unix_demo.cpp), captured from a
  Linux x86-64 build. ~8KB.
- `on9log_unix_demo`: the compiled demo ELF (x86-64, ~1MB) whose addresses
  the output packets reference.

Both are used by `demo-integration.test.ts` to verify the decoder against
real firmware output (no /tmp dependency, no silent skips). Regenerate them
when the demo changes:

```sh
scripts/build-on9log-fixtures.sh
```
