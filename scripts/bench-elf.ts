/**
 * ELF parser benchmark: parse speed, string extraction and address lookup.
 *
 * Uses the real on9log demo ELF (64-bit x86-64, ~1MB) plus a synthetic
 * 32-bit ELF. Run with: bun scripts/bench-elf.ts
 */

import { performance } from "node:perf_hooks";
import { readFileSync } from "node:fs";
import {
  parseElf,
  extractStrings,
  readStringAtVaddr,
} from "@soulcloud/core";
import { buildNoloadElf } from "../packages/core/tests/helpers/elf-builder";

function fmt(n: number): string {
  return n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : n.toFixed(1);
}

// --- fixtures ----------------------------------------------------------------

const demoElf = readFileSync("/tmp/on9log_unix_demo"); // 64-bit, ~1MB
const synth32 = buildNoloadElf(
  Array.from({ length: 200 }, (_, i) => `format_${i} value=%d arg=%s`),
  Array.from({ length: 200 }, (_, i) => `tag_${i}`),
  32,
  true,
);

const results: Array<[string, string]> = [];

function bench(name: string, iterations: number, fn: () => void): void {
  // warmup
  fn();
  const t0 = performance.now();
  for (let i = 0; i < iterations; i++) fn();
  const elapsed = performance.now() - t0;
  const perSec = iterations / (elapsed / 1000);
  results.push([name, `${fmt(perSec)}/s (${(elapsed / iterations * 1000).toFixed(1)}µs/op, ${iterations} iters)`]);
  console.log(`  ${name.padEnd(46)} ${fmt(perSec)}/s  (${(elapsed / iterations * 1000).toFixed(1)} µs/op)`);
}

console.log(`\n=== ELF parser benchmark ===`);
console.log(`demo ELF: ${(demoElf.length / 1024 / 1024).toFixed(2)} MB, 64-bit x86-64`);
console.log(`synth ELF32: ${synth32.length} bytes, ${(synth32.length / 1024).toFixed(1)} KB`);

// --- parse -------------------------------------------------------------------

const demo = parseElf(demoElf);
const synth = parseElf(synth32);
console.log(`\n[parse] demo: ${demo.sections.length} sections, ${demo.loads.length} PT_LOAD`);
console.log(`[parse] synth32: ${synth.sections.length} sections`);

bench("parseElf 64-bit (1MB real ELF)", 200, () => parseElf(demoElf));
bench("parseElf 32-bit (small synthetic)", 5000, () => parseElf(synth32));

// --- extract strings ---------------------------------------------------------

const noloadNames = demo.sections.filter((s) => s.name.startsWith(".noload_keep_in_elf")).map((s) => s.name);
console.log(`\n[extract] demo .noload sections: ${noloadNames.length}`);

bench(`extractStrings demo (${noloadNames.length} noload sections)`, 20, () => {
  for (const sec of demo.sections.filter((x) => x.name.startsWith(".noload_keep_in_elf"))) extractStrings(demo, demoElf, sec);
});
bench("extractStrings synth32", 1000, () => {
  extractStrings(synth, synth32, synth.sections.find((x) => x.name.startsWith(".noload_keep_in_elf"))!);
});

// --- address lookup ----------------------------------------------------------

// collect real format addresses from the demo
const fmtStrings = demo.sections.filter((x) => x.name.startsWith(".noload_keep_in_elf")).flatMap((sec) => extractStrings(demo, demoElf, sec));
console.log(`\n[lookup] demo dictionary strings: ${fmtStrings.length}`);

bench("readStringAtVaddr (first hit in PT_LOAD-less .noload)", 2000, () => {
  for (let i = 0; i < 50; i++) {
    const s = fmtStrings[i % fmtStrings.length]!;
    readStringAtVaddr(demo, demoElf, s.addr);
  }
});

// --- end-to-end decode path (parse + lookup + render) ------------------------

import { renderFormat, parseOn9logPacket } from "@soulcloud/core";
import { SlipDecoder } from "../packages/core/tests/helpers/slip";

const demoOutput = readFileSync("/tmp/on9log_demo_output.bin");
const decoder = new SlipDecoder();
decoder.push(demoOutput);
const packets = decoder
  .frames()
  .filter((f) => f.type === 1)
  .map((f) => {
    try {
      return parseOn9logPacket(f.payload);
    } catch {
      return null;
    }
  })
  .filter((p) => p !== null && p.kind === "log");

console.log(`\n[end-to-end] ${packets.length} decoded log packets`);

const fmtByAddr = new Map(fmtStrings.map((s) => [s.addr, s.value]));
bench("full decode (lookup + render)", 2000, () => {
  for (const p of packets) {
    const fmt = fmtByAddr.get(p.header.fmtId);
    if (fmt) renderFormat(fmt, p.args);
  }
});

console.log("\n=== summary ===");
for (const [name, value] of results) console.log(`  ${name.padEnd(46)} ${value}`);
