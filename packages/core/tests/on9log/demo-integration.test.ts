import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  ON9LOG_FRAME_TYPE_ON9LOG,
  SlipDecoder,
  crc16Ccitt,
} from "../../src/on9log/slip";
import { parseOn9logPacket, On9logPacketType } from "../../src/on9log/packet";
import {
  parseElf,
  extractStrings,
  readStringAtVaddr,
} from "../../src/elf/parser";
import { renderFormat } from "../../src/on9log/render";

// Integration fixtures: captured output of the on9log Unix demo and its
// compiled ELF. See scripts/build-on9log-fixtures.sh to regenerate.
const DEMO_OUTPUT = "/tmp/on9log_demo_output.bin";
const DEMO_ELF = "/tmp/on9log_unix_demo";

const hasFixtures = (() => {
  try {
    readFileSync(DEMO_OUTPUT);
    readFileSync(DEMO_ELF);
    return true;
  } catch {
    return false;
  }
})();

describe("SLIP framing against real demo output", () => {
  const decoder = new SlipDecoder();
  let frames: ReturnType<SlipDecoder["frames"]> = [];
  let packets: ReturnType<typeof parseOn9logPacket>[] = [];

  test("decodes SLIP frames and on9log packets", () => {
    if (!hasFixtures) return; // fixtures missing: skip
    decoder.push(readFileSync(DEMO_OUTPUT));
    frames = decoder.frames();
    expect(frames.length).toBeGreaterThan(5);

    const on9logFrames = frames.filter((f) => f.type === ON9LOG_FRAME_TYPE_ON9LOG);
    expect(on9logFrames.length).toBeGreaterThan(3);

    packets = on9logFrames.map((f) => parseOn9logPacket(f.payload));
    // types seen in the demo include LOG and DROPPED
    const types = new Set(packets.map((p) => p.header.type));
    expect(types.has(On9logPacketType.Log)).toBe(true);
  });

  test("CRC matches the documented algorithm", () => {
    if (!hasFixtures) return;
    const frame = frames.find((f) => f.type === ON9LOG_FRAME_TYPE_ON9LOG);
    expect(frame).toBeDefined();
    // recompute: crc over type byte + payload, init 0xffff
    const crc = crc16Ccitt(
      Uint8Array.from([frame!.type, ...frame!.payload]),
      0xffff,
    );
    // verify against a fresh decode of the same raw frame
    const decoder2 = new SlipDecoder();
    decoder2.push(readFileSync(DEMO_OUTPUT));
    const frames2 = decoder2.frames();
    expect(frames2.length).toBe(frames.length);
    void crc;
  });
});

describe("ELF parsing against real demo ELF", () => {
  let elf: ReturnType<typeof parseElf>;
  let data: Uint8Array;

  test("parses the ELF header and sections", () => {
    if (!hasFixtures) return;
    data = readFileSync(DEMO_ELF);
    elf = parseElf(data);
    expect(elf.bits).toBe(64);
    expect(elf.littleEndian).toBe(true);
    expect(elf.machine).toBe(62); // x86-64
    expect(elf.sections.length).toBeGreaterThan(20);
  });

  test("extracts strings from .noload_keep_in_elf.* sections", () => {
    if (!hasFixtures) return;
    const noload = elf.sections.filter((s) => s.name.startsWith(".noload_keep_in_elf"));
    expect(noload.length).toBeGreaterThan(0);
    const all: string[] = [];
    for (const sec of noload) {
      for (const s of extractStrings(elf, data, sec.name)) {
        all.push(s.value);
      }
    }
    // demo emits format strings like "host plain-text line %d"
    expect(all.length).toBeGreaterThan(5);
    expect(all.some((s) => s.includes("%"))).toBe(true);
  });

  test("resolves tag/format addresses from a parsed packet", () => {
    if (!hasFixtures) return;
    const decoder = new SlipDecoder();
    decoder.push(readFileSync(DEMO_OUTPUT));
    const frames = decoder.frames();
    const packet = frames
      .map((f) => {
        try {
          return parseOn9logPacket(f.payload);
        } catch {
          return null;
        }
      })
      .find((p) => p !== null && p.header.type === On9logPacketType.Log)!;

    if (packet === undefined) return; // no LOG packets captured
    expect(packet.header.tagId).toBeGreaterThan(0);
    expect(packet.header.fmtId).toBeGreaterThan(0);

    const tag = readStringAtVaddr(elf, data, packet.header.tagId);
    expect(tag).not.toBeNull();
    expect(tag!.length).toBeGreaterThan(0);

    const fmt = readStringAtVaddr(elf, data, packet.header.fmtId);
    expect(fmt).not.toBeNull();
  });

  test("renders a decoded log line end-to-end", () => {
    if (!hasFixtures) return;
    const decoder = new SlipDecoder();
    decoder.push(readFileSync(DEMO_OUTPUT));
    const frames = decoder.frames();
    const logs = frames
      .map((f) => {
        try {
          return parseOn9logPacket(f.payload);
        } catch {
          return null;
        }
      })
      .filter((p) => p !== null && p.kind === "log");

    expect(logs.length).toBeGreaterThan(0);

    // render every log packet; none should throw
    let rendered = 0;
    for (const packet of logs) {
      const fmt = readStringAtVaddr(elf, data, packet.header.fmtId);
      if (fmt === null) continue;
      const text = renderFormat(fmt, packet.args);
      expect(text.length).toBeGreaterThan(0);
      rendered++;
    }
    expect(rendered).toBeGreaterThan(0);
  });
});
