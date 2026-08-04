import { describe, expect, test } from "bun:test";
import {
  FormatRenderError,
  parseFmtSpec,
  renderFormat,
  renderFmtArg,
} from "../../src/on9log/render";
import type { On9logArg } from "../../src/on9log/packet";
import { On9logArgType } from "../../src/on9log/packet";

const B32 = (v: number): On9logArg => ({ type: On9logArgType.Bits32, value: v >>> 0 });
const B64 = (v: bigint): On9logArg => ({ type: On9logArgType.Bits64, value: v });
const PTR = (v: number): On9logArg => ({ type: On9logArgType.Pointer, value: v >>> 0 });
const STR = (s: string): On9logArg => ({
  type: On9logArgType.DynamicString,
  value: new TextEncoder().encode(s),
});
const NULL_STR: On9logArg = { type: On9logArgType.DynamicString, value: null };
const FLOAT = (v: number): On9logArg => {
  const buf = new ArrayBuffer(8);
  const view = new DataView(buf);
  view.setFloat64(0, v, true);
  return { type: On9logArgType.Bits64, value: view.getBigUint64(0, true) };
};

describe("printf-style rendering", () => {
  test("renders integer conversions", () => {
    expect(renderFormat("%d", [B32(42)])).toBe("42");
    expect(renderFormat("%d", [B32(-42)])).toBe("-42"); // sign-extended
    expect(renderFormat("%d", [B32(0xffffffd6)])).toBe("-42"); // two's complement
    expect(renderFormat("%u", [B32(-1)])).toBe("4294967295");
    expect(renderFormat("%x", [B32(0xfeedbeef)])).toBe("feedbeef");
    expect(renderFormat("%X", [B32(0xfeedbeef)])).toBe("FEEDBEEF");
    expect(renderFormat("%lld", [B64(-42n)])).toBe("-42");
    expect(renderFormat("%llu", [B64(0xffffffffffffffffn)])).toBe("18446744073709551615");
  });

  test("renders pointer, char and string conversions", () => {
    expect(renderFormat("%p", [PTR(0xb653c434)])).toBe("0xb653c434");
    expect(renderFormat("%c", [B32(90)])).toBe("Z");
    expect(renderFormat("%c", [B32(0x5a)])).toBe("Z");
    expect(renderFormat("%s", [STR("hello")])).toBe("hello");
    expect(renderFormat("%s", [NULL_STR])).toBe("(null)");
  });

  test("renders precision, width and flags", () => {
    expect(renderFormat("%5d", [B32(42)])).toBe("   42");
    expect(renderFormat("%-5d", [B32(42)])).toBe("42   ");
    expect(renderFormat("%05d", [B32(42)])).toBe("00042");
    expect(renderFormat("%+d", [B32(42)])).toBe("+42");
    expect(renderFormat("% d", [B32(42)])).toBe(" 42");
    expect(renderFormat("%#x", [B32(0xabad)])).toBe("0xabad");
    expect(renderFormat("%.3s", [STR("foobar")])).toBe("foo");
    expect(renderFormat("%.*s", [B32(3), STR("foobar")])).toBe("foo");
    expect(renderFormat("%*d", [B32(5), B32(42)])).toBe("   42");
    expect(renderFormat("%.2f", [FLOAT(3.14159)])).toBe("3.14");
    expect(renderFormat("%f", [FLOAT(3.14159)])).toBe("3.141590");
  });

  test("negative width means left-justify", () => {
    expect(renderFormat("%*d", [B32(-5), B32(42)])).toBe("42   ");
  });

  test("handles %% and bare text", () => {
    expect(renderFormat("100%% done", [])).toBe("100% done");
    expect(renderFormat("plain text", [])).toBe("plain text");
  });

  test("rejects malformed formats and mismatched args", () => {
    expect(() => renderFormat("%d", [])).toThrow(FormatRenderError);
    expect(() => renderFormat("%d", [B32(1), B32(2)])).toThrow(/unconsumed/);
    expect(() => renderFormat("%s", [B32(1)])).toThrow(/string/);
    expect(() => renderFormat("%q", [B32(1)])).toThrow(/unsupported/);
    expect(() => renderFormat("trailing %", [])).toThrow(/bare/);
    expect(() => renderFormat("%f", [B32(1)])).toThrow(/64-bit/);
    expect(() => renderFormat("%p", [STR("x")])).toThrow(/pointer/);
  });
});

describe("fmt-style rendering", () => {
  test("bare {} placeholders", () => {
    expect(renderFormat("value={}", [B32(42)])).toBe("value=42");
    expect(renderFormat("{} {}", [STR("a"), STR("b")])).toBe("a b");
    expect(renderFormat("str={}", [NULL_STR])).toBe("str=(null)");
    expect(renderFormat("ptr={}", [PTR(0xb653c434)])).toBe("ptr=0xb653c434");
    // negative 32-bit renders signed
    expect(renderFormat("{}", [B32(-42)])).toBe("-42");
  });

  test("typed placeholders", () => {
    expect(renderFormat("{:d}", [B32(42)])).toBe("42");
    expect(renderFormat("{:x}", [B32(0xabad)])).toBe("abad");
    expect(renderFormat("{:X}", [B32(0xabad)])).toBe("ABAD");
    expect(renderFormat("{:o}", [B32(42)])).toBe("52");
    expect(renderFormat("{:b}", [B32(42)])).toBe("101010");
    expect(renderFormat("{:c}", [B32(90)])).toBe("Z");
    expect(renderFormat("{:s}", [STR("on9log")])).toBe("on9log");
    expect(renderFormat("{:p}", [PTR(0xb653c434)])).toBe("0xb653c434");
    expect(renderFormat("{:.6f}", [FLOAT(3.14159)])).toBe("3.141590");
    expect(renderFormat("{:f}", [FLOAT(3.14159)])).toBe("3.141590");
    expect(renderFormat("{:.2f}", [FLOAT(3.14159)])).toBe("3.14");
  });

  test("alternate form", () => {
    expect(renderFormat("{:#x}", [B32(0xabad)])).toBe("0xabad");
    expect(renderFormat("{:#X}", [B32(0xabad)])).toBe("0XABAD");
    expect(renderFormat("{:#o}", [B32(42)])).toBe("052");
    expect(renderFormat("{:#b}", [B32(42)])).toBe("0b101010");
  });

  test("alignment and fill", () => {
    expect(renderFormat("[{:>10}]", [B32(42)])).toBe("[        42]");
    expect(renderFormat("[{:<10}]", [STR("on9log")])).toBe("[on9log    ]");
    expect(renderFormat("[{:^10}]", [B32(42)])).toBe("[    42    ]");
    expect(renderFormat("[{:*>10}]", [B32(42)])).toBe("[********42]");
    expect(renderFormat("[{:*<10}]", [STR("on9log")])).toBe("[on9log****]");
    expect(renderFormat("{:010}", [B32(42)])).toBe("0000000042");
  });

  test("sign flags", () => {
    expect(renderFormat("{:+}", [B32(42)])).toBe("+42");
    expect(renderFormat("{: }", [B32(42)])).toBe(" 42");
    expect(renderFormat("{:+d}", [B32(-42)])).toBe("-42");
  });

  test("nested width and precision from args", () => {
    // fmt semantics: the value argument comes first, the nested width/
    // precision placeholder consumes the NEXT argument
    expect(renderFormat("[{:{}}]", [B32(42), B32(10)])).toBe("[        42]");
    expect(renderFormat("{:.{}f}", [FLOAT(3.14159), B32(2)])).toBe("3.14");
    expect(renderFormat("{:.{}s}", [STR("foobar"), B32(3)])).toBe("foo");
    expect(renderFormat("[{:{}.{}f}]", [FLOAT(3.14159), B32(8), B32(3)])).toBe("[   3.142]");
  });

  test("positional arguments", () => {
    expect(renderFormat("{0}-{1}-{0}", [STR("a"), STR("b")])).toBe("a-b-a");
    expect(renderFormat("{0:{1}}", [B32(42), B32(10)])).toBe("        42");
    expect(renderFormat("{0:.{1}f}", [FLOAT(3.14159), B32(2)])).toBe("3.14");
    expect(renderFormat("{0:{0}}", [B32(5)])).toBe("    5");
  });

  test("brace escaping", () => {
    expect(renderFormat("{{}} and {}", [B32(1)])).toBe("{} and 1");
    expect(renderFormat("{{literal}}", [])).toBe("{literal}");
  });

  test("float heuristics for bare 64-bit placeholders", () => {
    expect(renderFormat("{}", [FLOAT(3.14159)])).toBe("3.14159");
    expect(renderFormat("{}", [B64(-42n)])).toBe("-42"); // small int stays int
    expect(renderFormat("{}", [B64(42n)])).toBe("42");
    // NaN/Inf bit patterns
    const nan = new ArrayBuffer(8);
    new DataView(nan).setFloat64(0, NaN, true);
    expect(renderFormat("{}", [{ type: On9logArgType.Bits64, value: new DataView(nan).getBigUint64(0, true) }])).toBe("nan");
    const inf = new ArrayBuffer(8);
    new DataView(inf).setFloat64(0, Infinity, true);
    expect(renderFormat("{}", [{ type: On9logArgType.Bits64, value: new DataView(inf).getBigUint64(0, true) }])).toBe("inf");
  });

  test("64-bit integer rendering", () => {
    expect(renderFormat("{:d}", [B64(0x1122334455667788n)])).toBe("1234605616436508552");
    expect(renderFormat("{:x}", [B64(0x1122334455667788n)])).toBe("1122334455667788");
    expect(renderFormat("{}", [B64(0x1122334455667788n)])).toBe("1234605616436508552");
  });

  test("rejects malformed fmt specs", () => {
    expect(() => renderFormat("{", [])).toThrow(/unbalanced/);
    expect(() => renderFormat("}", [])).toThrow(/unbalanced/);
    expect(() => renderFormat("{}", [])).toThrow(/missing argument/);
    expect(() => renderFormat("{:z}", [B32(1)])).toThrow(/unsupported/);
    // {:>} is legal (right-align, no width)
    expect(renderFormat("{:>}", [B32(1)])).toBe("1");
    expect(() => renderFormat("{:>z}", [B32(1)])).toThrow(/unsupported/);
    expect(() => renderFormat("{}", [])).toThrow(FormatRenderError);
  });
});

describe("parseFmtSpec", () => {
  const noNested = () => {
    throw new Error("unexpected nested read");
  };

  test("parses simple specs", () => {
    expect(parseFmtSpec(":x", noNested)).toMatchObject({ type: "x" });
    expect(parseFmtSpec(":>10", noNested)).toMatchObject({ align: ">", width: 10 });
    expect(parseFmtSpec(":*<10", noNested)).toMatchObject({ fill: "*", align: "<", width: 10 });
    expect(parseFmtSpec(":#x", noNested)).toMatchObject({ alternate: true, type: "x" });
    expect(parseFmtSpec(":.6f", noNested)).toMatchObject({ precision: 6, type: "f" });
    expect(parseFmtSpec(":010", noNested)).toMatchObject({ zero: true, width: 10 });
    expect(parseFmtSpec("", noNested)).toMatchObject({ type: "" });
  });

  test("resolves nested specs through the callback", () => {
    let calls = 0;
    const spec = parseFmtSpec(":{}", () => {
      calls++;
      return 7n;
    });
    expect(spec.width).toBe(7);
    expect(calls).toBe(1);
  });
});

describe("renderFmtArg direct", () => {
  test("default presentation per type", () => {
    expect(renderFmtArg(STR("x"), parseFmtSpec("", () => 0n))).toBe("x");
    expect(renderFmtArg(B32(42), parseFmtSpec("", () => 0n))).toBe("42");
    expect(renderFmtArg(PTR(1), parseFmtSpec("", () => 0n))).toBe("0x00000001");
  });
});

describe("security guards", () => {
  test("rejects excessive field widths (OOM guard)", () => {
    // %*d with a huge width must throw instead of allocating
    expect(() => renderFormat("%*d", [B32(2_000_000_000), B32(1)])).toThrow(
      /width exceeds limit/,
    );
    expect(() => renderFormat("{:>{}}", [B32(1), B32(2_000_000_000)])).toThrow(
      /width exceeds limit/,
    );
    expect(() => renderFormat("{:01000000000d}", [B32(1)])).toThrow(
      /width exceeds limit/,
    );
    // literal huge precision
    expect(() => renderFormat("%1000000000d", [B32(1)])).toThrow(
      /width exceeds limit/,
    );
  });

  test("rejects oversized dynamic strings in packets", () => {
    const { parseOn9logPacket } = require("../../src/on9log/packet") as typeof import("../../src/on9log/packet");
    // header + arg_count 1 + type 4 + length 0xFFFFFFFF (a huge declared len)
    const bytes = new Uint8Array([
      0x9a, 0x03, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
      0x00, 0x00, 0x00, 0x00, 0xff, 0xff, // streaming
      0x01, 0x04, 0xff, 0xff, 0xff, 0x7f, // len 0x7fffffff
    ]);
    expect(() => parseOn9logPacket(bytes)).toThrow(/exceeds limit/);
  });
});

describe("printf float paths", () => {
  test("%e and %g conversions", () => {
    // printf %e: 6 fractional digits by default
    expect(renderFormat("%e", [FLOAT(3.14159)])).toBe("3.141590e+0");
    expect(renderFormat("%E", [FLOAT(3.14159)])).toBe("3.141590E+0");
    // %g is simplified to exponential form (documented deviation)
    expect(renderFormat("%g", [FLOAT(3.14159)])).toBe("3.141590e+0");
    expect(renderFormat("%.2e", [FLOAT(3.14159)])).toBe("3.14e+0");
  });

  test("float precision and width", () => {
    expect(renderFormat("%8.2f", [FLOAT(3.14159)])).toBe("    3.14");
    expect(renderFormat("%08.2f", [FLOAT(3.14159)])).toBe("00003.14");
    expect(renderFormat("%.0f", [FLOAT(3.7)])).toBe("4");
    expect(renderFormat("%f", [FLOAT(-2.5)])).toBe("-2.500000");
  });

  test("64-bit negative floats", () => {
    expect(renderFormat("%.1f", [FLOAT(-3.5)])).toBe("-3.5");
  });
});

describe("S3: {:g} trailing-zero regression", () => {
  test("integer-valued floats keep significant zeros", () => {
    expect(renderFormat("{:g}", [FLOAT(100000.0)])).toBe("100000");
    expect(renderFormat("{:g}", [FLOAT(250000.0)])).toBe("250000");
    expect(renderFormat("{:g}", [FLOAT(42.0)])).toBe("42");
  });

  test("fractional values still trim", () => {
    expect(renderFormat("{:g}", [FLOAT(3.14159)])).toBe("3.14159");
    expect(renderFormat("{:g}", [FLOAT(3.0)])).toBe("3");
    expect(renderFormat("{:g}", [FLOAT(0.5)])).toBe("0.5");
  });
});

describe("M10: precision/output guards", () => {
  test("excessive fmt precision is rejected, not RangeError", () => {
    expect(() => renderFormat("{:.500f}", [FLOAT(3.14)])).toThrow(
      FormatRenderError,
    );
    expect(() => renderFormat("{:.200}", [B32(1)])).toThrow(FormatRenderError);
  });

  test("excessive printf precision is rejected, not RangeError", () => {
    expect(() => renderFormat("%.500f", [FLOAT(3.14)])).toThrow(
      FormatRenderError,
    );
  });
});
