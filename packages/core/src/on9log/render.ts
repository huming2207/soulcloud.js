/**
 * Format renderer for on9log decoded log messages.
 *
 * The firmware encodes arguments by type (32-bit, 64-bit, pointer, dynamic
 * string), and the format string is recovered from the ELF. Two syntaxes are
 * supported, matching the on9log C macros and C++ wrapper:
 *
 *   - printf style:  %d %i %u %x %X %p %c %s %f %e %g, flags/width/precision,
 *     `%.*s` / `%*d` consume their width/precision from the argument list
 *   - fmt style:     `{}`, `{:d}` `{:x}` `{:#x}` `{:>10}` `{:.6f}`,
 *     `{:{}}`/`{:.{}f}` (nested width/precision from args), positional
 *     `{0}`/`{0:{1}}`, brace escaping `{{` `}}`
 *
 * Dynamic string arguments decode as UTF-8 (invalid bytes are replaced).
 */

import type { On9logArg } from "./packet";
import { On9logArgType } from "./packet";

/** Maximum field width accepted when rendering (guards against OOM from
 * malicious width/precision values like %*d with width=1e9). */
export const MAX_FORMAT_WIDTH = 4096;

/** Maximum total rendered output length. */
export const MAX_RENDER_OUTPUT = 1_000_000;

/** Maximum field precision (toFixed/toPrecision reject values above 100;
 * rejecting earlier keeps the error typed instead of a raw RangeError). */
export const MAX_FORMAT_PRECISION = 100;

export class FormatRenderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FormatRenderError";
  }
}

/**
 * Renders a format string with the given decoded arguments.
 *
 * @throws {FormatRenderError} when the argument list is inconsistent with
 * the format string (too few/too many, wrong types) or the format contains
 * an unsupported conversion.
 */
export function renderFormat(
  format: string,
  args: On9logArg[],
): string {
  const out: string[] = [];
  let totalOutput = 0;
  const state = { argIndex: 0, positional: false };
  let i = 0;

  const push = (text: string): void => {
    totalOutput += text.length;
    if (totalOutput > MAX_RENDER_OUTPUT) {
      throw new FormatRenderError("rendered output exceeds limit");
    }
    out.push(text);
  };

  while (i < format.length) {
    const ch = format[i]!;

    if (ch === "{") {
      if (format[i + 1] === "{") {
        push("{");
        i += 2;
        continue;
      }
      const close = findClosingBrace(format, i + 1);
      if (close === -1) {
        throw new FormatRenderError("unbalanced '{' in format");
      }
      const inner = format.slice(i + 1, close);
      i = close + 1;

      // positional index {0}, {0:...}
      const idxMatch = /^(\d+)(?=:|$)/.exec(inner);
      let specStr = inner;
      let useIndex: number;
      if (idxMatch) {
        state.positional = true;
        useIndex = Number(idxMatch[1]);
        specStr = inner.slice(idxMatch[0].length);
      } else {
        useIndex = state.argIndex++;
      }

      const spec = parseFmtSpec(specStr, (nested) => {
        const v = readNestedArg(nested, args, state);
        return v;
      });
      const arg = args[useIndex];
      if (!arg) {
        throw new FormatRenderError(`missing argument for {${inner}}`);
      }
      push(renderFmtArg(arg, spec));
      continue;
    }

    if (ch === "}") {
      if (format[i + 1] === "}") {
        push("}");
        i += 2;
        continue;
      }
      throw new FormatRenderError("unbalanced '}' in format");
    }

    if (ch !== "%") {
      push(ch);
      i++;
      continue;
    }
    if (format[i + 1] === "%") {
      push("%");
      i += 2;
      continue;
    }

    // --- printf conversion --------------------------------------------------

    let j = i + 1;
    while (j < format.length && "-+ #0".includes(format[j]!)) j++;
    let flags = format.slice(i + 1, j);

    let width = 0;
    while (j < format.length && /\d/.test(format[j]!)) {
      width = width * 10 + Number(format[j]);
      if (width > MAX_FORMAT_WIDTH) {
        throw new FormatRenderError("field width exceeds limit");
      }
      j++;
    }
    if (format[j] === "*") {
      width = Number(nextIntArg(args, state.argIndex++, "width"));
      j++;
    }
    // printf: a negative width means left-justify with the absolute value
    const signedWidth = width | 0;
    if (signedWidth < 0) {
      width = -signedWidth;
      if (!flags.includes("-")) flags += "-";
    }
    if (width > MAX_FORMAT_WIDTH) {
      throw new FormatRenderError("field width exceeds limit");
    }

    let precision: number | null = null;
    if (format[j] === ".") {
      j++;
      if (format[j] === "*") {
        precision = Number(nextIntArg(args, state.argIndex++, "precision"));
        j++;
      } else {
        let p = 0;
        while (j < format.length && /\d/.test(format[j]!)) {
          p = p * 10 + Number(format[j]);
          if (p > MAX_FORMAT_PRECISION) {
            throw new FormatRenderError("field precision exceeds limit");
          }
          j++;
        }
        precision = p;
      }
    }
    if (precision !== null && precision > MAX_FORMAT_PRECISION) {
      throw new FormatRenderError("field precision exceeds limit");
    }

    while (j < format.length && "hlLjzt".includes(format[j]!)) j++;

    const conv = format[j];
    if (conv === undefined) {
      throw new FormatRenderError("format ends with bare '%'");
    }
    i = j + 1;

    switch (conv) {
      case "d":
      case "i": {
        const v = nextIntArg(args, state.argIndex++, `%${conv}`);
        push(formatSigned(v, width, flags, false));
        break;
      }
      case "u": {
        const v = nextIntArg(args, state.argIndex++, "%u");
        push(formatSigned(v, width, flags, true));
        break;
      }
      case "x":
      case "X": {
        const v = nextIntArg(args, state.argIndex++, `%${conv}`);
        push(formatHex(v, width, flags, conv === "X"));
        break;
      }
      case "p": {
        const arg = nextArg(args, state.argIndex++, "%p");
        if (arg.type !== On9logArgType.Pointer && arg.type !== On9logArgType.Bits32) {
          throw new FormatRenderError("%p requires a pointer/32-bit argument");
        }
        const hex = (arg.value >>> 0).toString(16).padStart(8, "0");
        push(`0x${hex}`);
        break;
      }
      case "c": {
        const v = nextIntArg(args, state.argIndex++, "%c");
        push(String.fromCodePoint(Number(v) & 0xff));
        break;
      }
      case "s": {
        const arg = nextArg(args, state.argIndex++, "%s");
        if (
          arg.type !== On9logArgType.DynamicString &&
          arg.type !== On9logArgType.DynamicStringView
        ) {
          throw new FormatRenderError("%s requires a string argument");
        }
        const text = argToString(arg);
        let s = text;
        // C semantics: a negative precision is treated as absent
        if (precision !== null && precision >= 0) s = s.slice(0, precision);
        push(padString(s, width, flags));
        break;
      }
      case "f":
      case "F": {
        const arg = nextArg(args, state.argIndex++, `%${conv}`);
        const value = doubleArgValue(arg, `%${conv}`);
        push(formatFloat(value, width, precision, flags));
        break;
      }
      case "e":
      case "E":
      case "g":
      case "G": {
        const arg = nextArg(args, state.argIndex++, `%${conv}`);
        const value = doubleArgValue(arg, `%${conv}`);
        let rendered = value.toExponential(precision ?? 6);
        if (conv === "E" || conv === "G") rendered = rendered.toUpperCase();
        push(padString(rendered, width, flags));
        break;
      }
      default:
        throw new FormatRenderError(`unsupported format conversion '%${conv}'`);
    }
  }

  if (!state.positional && state.argIndex < args.length) {
    throw new FormatRenderError(
      `${args.length - state.argIndex} unconsumed argument(s)`,
    );
  }
  return out.join("");
}

/** Finds the closing brace matching the brace at `start - 1`, honoring nested placeholders. */
function findClosingBrace(format: string, start: number): number {
  let depth = 0;
  for (let i = start; i < format.length; i++) {
    const ch = format[i];
    if (ch === "{") {
      depth++;
    } else if (ch === "}") {
      if (depth === 0) return i;
      depth--;
    }
  }
  return -1;
}

// --- helpers -----------------------------------------------------------------

function nextArg(args: On9logArg[], index: number, what: string): On9logArg {
  const arg = args[index];
  if (!arg) {
    throw new FormatRenderError(`missing argument for ${what}`);
  }
  return arg;
}

function nextIntArg(args: On9logArg[], index: number, what: string): bigint {
  const arg = nextArg(args, index, what);
  if (arg.type === On9logArgType.Bits32) return BigInt(arg.value >>> 0);
  if (arg.type === On9logArgType.Bits64) return arg.value;
  if (arg.type === On9logArgType.Pointer) return BigInt(arg.value);
  throw new FormatRenderError(`${what} requires a numeric argument`);
}

function argToString(arg: On9logArg): string {
  if (
    arg.type === On9logArgType.DynamicString ||
    arg.type === On9logArgType.DynamicStringView
  ) {
    if (arg.value === null) return "(null)";
    return new TextDecoder().decode(arg.value);
  }
  if (arg.type === On9logArgType.Bits32) return String(arg.value >>> 0);
  if (arg.type === On9logArgType.Bits64) return arg.value.toString();
  if (arg.type === On9logArgType.Pointer) return `0x${arg.value.toString(16)}`;
  return "";
}

function doubleArgValue(arg: On9logArg, what: string): number {
  if (arg.type !== On9logArgType.Bits64) {
    throw new FormatRenderError(`${what} requires a 64-bit (double) argument`);
  }
  return doubleFromBits(arg.value);
}

/** Reinterprets the 64-bit integer bits as an IEEE-754 double. */
function doubleFromBits(bits: bigint): number {
  const buf = new ArrayBuffer(8);
  const view = new DataView(buf);
  view.setBigUint64(0, bits, true);
  return view.getFloat64(0, true);
}

function formatSigned(
  v: bigint,
  width: number,
  flags: string,
  unsigned: boolean,
): string {
  let s: string;
  if (unsigned) {
    s = v.toString(10);
  } else {
    s = displaySigned(v).toString(10);
  }
  if (flags.includes("+") && !s.startsWith("-")) s = `+${s}`;
  else if (flags.includes(" ") && !s.startsWith("-")) s = ` ${s}`;
  return padString(s, width, flags);
}

function formatHex(
  v: bigint,
  width: number,
  flags: string,
  upper: boolean,
): string {
  let s = v.toString(16);
  if (upper) s = s.toUpperCase();
  if (flags.includes("#")) s = `${upper ? "0X" : "0x"}${s}`;
  return padString(s, width, flags);
}

function formatFloat(
  value: number,
  width: number,
  precision: number | null,
  flags: string,
): string {
  let s = value.toFixed(precision ?? 6);
  if (flags.includes("+") && !s.startsWith("-")) s = `+${s}`;
  return padString(s, width, flags);
}

function padString(s: string, width: number, flags: string): string {
  if (width <= s.length) return s;
  const pad = width - s.length;
  if (flags.includes("0") && !flags.includes("-")) {
    // zero padding goes after the sign (C semantics: %+08d -> "+0000042")
    const signMatch = /^([+-]|0[xX])/.exec(s);
    if (signMatch) {
      const sign = signMatch[0];
      return sign + "0".repeat(pad) + s.slice(sign.length);
    }
    return "0".repeat(pad) + s;
  }
  const padChar = " ";
  if (flags.includes("-")) return s + padChar.repeat(pad);
  return padChar.repeat(pad) + s;
}

// --- fmt-style `{...}` placeholders ------------------------------------------

interface FmtSpec {
  fill: string;
  align: "<" | ">" | "^" | null;
  sign: "+" | "-" | " " | null;
  alternate: boolean;
  zero: boolean;
  width: number;
  precision: number | null;
  type: string;
}

/**
 * Parses the content between `{` and `}` of a fmt placeholder.
 *
 * Nested `{}` / `{n}` placeholders for dynamic width/precision are resolved
 * through the `readNested` callback (which consumes arguments).
 */
export function parseFmtSpec(
  raw: string,
  readNested: (inner: string) => bigint,
): FmtSpec {
  let s = raw.startsWith(":") ? raw.slice(1) : raw;
  const out: FmtSpec = {
    fill: " ",
    align: null,
    sign: null,
    alternate: false,
    zero: false,
    width: 0,
    precision: null,
    type: "",
  };
  if (s.length >= 2 && (s[1] === "<" || s[1] === ">" || s[1] === "^")) {
    out.fill = s[0]!;
    out.align = s[1] as FmtSpec["align"];
    s = s.slice(2);
  } else if (s.length >= 1 && (s[0] === "<" || s[0] === ">" || s[0] === "^")) {
    out.align = s[0] as FmtSpec["align"];
    s = s.slice(1);
  }
  if (s[0] === "+" || s[0] === "-" || s[0] === " ") {
    out.sign = s[0] as FmtSpec["sign"];
    s = s.slice(1);
  }
  if (s[0] === "#") {
    out.alternate = true;
    s = s.slice(1);
  }
  if (s[0] === "0") {
    out.zero = true;
    s = s.slice(1);
  }
  // width: digits or nested {}/{n}
  if (s[0] === "{") {
    const close = s.indexOf("}");
    out.width = Number(readNested(s.slice(1, close)));
    s = s.slice(close + 1);
  } else {
    const widthMatch = /^\d+/.exec(s);
    if (widthMatch) {
      out.width = Number(widthMatch[0]);
      s = s.slice(widthMatch[0].length);
    }
  }
  if (out.width > MAX_FORMAT_WIDTH) {
    throw new FormatRenderError("field width exceeds limit");
  }
  if (s[0] === ".") {
    s = s.slice(1);
    if (s[0] === "{") {
      const close = s.indexOf("}");
      out.precision = Number(readNested(s.slice(1, close)));
      s = s.slice(close + 1);
    } else {
      const precMatch = /^\d+/.exec(s);
      out.precision = precMatch ? Number(precMatch[0]) : 0;
      if (precMatch) s = s.slice(precMatch[0].length);
    }
  }
  if (s.length === 1) {
    out.type = s;
  } else if (s.length > 1) {
    throw new FormatRenderError(`unsupported fmt spec '{${raw}}'`);
  }
  if (out.precision !== null && out.precision > MAX_FORMAT_PRECISION) {
    throw new FormatRenderError("field precision exceeds limit");
  }
  return out;
}

/** Reads a nested width/precision argument (`{}` auto or `{n}` positional). */
function readNestedArg(
  inner: string,
  args: On9logArg[],
  state: { argIndex: number; positional: boolean },
): bigint {
  let index: number;
  if (inner === "") {
    index = state.argIndex++;
  } else {
    const n = Number(inner);
    if (!Number.isInteger(n)) {
      throw new FormatRenderError(`invalid nested fmt argument '{${inner}}'`);
    }
    state.positional = true;
    index = n;
  }
  return nextIntArg(args, index, `nested {${inner}}`);
}

/** Renders one argument according to a fmt spec. */
export function renderFmtArg(arg: On9logArg, spec: FmtSpec): string {
  const type = spec.type;
  switch (type) {
    case "d":
    case "i":
      return fmtInt(arg, 10, false, spec, false);
    case "u":
      return fmtInt(arg, 10, true, spec, false);
    case "x":
      return fmtInt(arg, 16, false, spec, false);
    case "X":
      return fmtInt(arg, 16, false, spec, true);
    case "o":
      return fmtInt(arg, 8, false, spec, false);
    case "b":
      return fmtInt(arg, 2, false, spec, false);
    case "B":
      return fmtInt(arg, 2, false, spec, true);
    case "c":
      return String.fromCodePoint(Number(intValue(arg)) & 0xff);
    case "s": {
      let text = argToString(arg);
      if (spec.precision !== null) text = text.slice(0, spec.precision);
      return fmtPad(text, spec);
    }
    case "p": {
      if (arg.type !== On9logArgType.Pointer && arg.type !== On9logArgType.Bits32) {
        throw new FormatRenderError("{:p} requires a pointer argument");
      }
      return `0x${(arg.value >>> 0).toString(16).padStart(8, "0")}`;
    }
    case "f":
    case "F":
    case "e":
    case "E":
    case "g":
    case "G": {
      const value = doubleArgValue(arg, `{:${type}}`);
      let s: string;
      if (type === "f" || type === "F") {
        s = value.toFixed(spec.precision ?? 6);
      } else if (type === "e" || type === "E") {
        s = value.toExponential(spec.precision ?? 6);
      } else {
        s = value.toPrecision(spec.precision ?? 6);
        s = s.includes(".") ? s.replace(/0+$/, "").replace(/\.$/, "") : s;
      }
      if (spec.sign === "+" && !s.startsWith("-")) s = `+${s}`;
      if (spec.alternate && !s.includes(".")) s += ".";
      return fmtPad(s, spec);
    }
    case "": {
      // default presentation by argument type
      if (
        arg.type === On9logArgType.DynamicString ||
        arg.type === On9logArgType.DynamicStringView
      ) {
        return fmtPad(argToString(arg), spec);
      }
      if (arg.type === On9logArgType.Pointer) {
        return `0x${(arg.value >>> 0).toString(16).padStart(8, "0")}`;
      }
      if (arg.type === On9logArgType.Bits64) {
        // 64-bit args carry no int/double distinction on the wire. Heuristic:
        // only magnitudes >= 2^53 (signed) can plausibly be doubles; NaN/Inf
        // and non-integer double interpretations then render as floats.
        // Small values (including -42's two's-complement bits, which would
        // look like a NaN pattern) always render as integers.
        const signed = signExtend64(arg.value);
        const magnitude = signed < 0n ? -signed : signed;
        if (magnitude >= 0x20000000000000n) {
          const asDouble = doubleFromBits(arg.value);
          if (Number.isNaN(asDouble)) return fmtPad("nan", spec);
          if (asDouble === Infinity) return fmtPad("inf", spec);
          if (asDouble === -Infinity) return fmtPad("-inf", spec);
          // require a plausible float exponent: doubles in logs are within
          // ~2^-253 .. 2^253 (encoded exponent 0x300..0x500); big integers
          // like 0x1122334455667788 decode to ~1e-225 (exponent 0x112)
          const exp = (arg.value >> 52n) & 0x7ffn;
          if (exp >= 0x300n && exp <= 0x500n && !Number.isInteger(asDouble)) {
            return fmtPad(trimFloat(asDouble.toPrecision(6)), spec);
          }
        }
      }
      return fmtInt(arg, 10, false, spec, false);
    }
    default:
      throw new FormatRenderError(`unsupported fmt type '{:${type}}'`);
  }
}

/** Reinterprets an unsigned 64-bit value as signed. */
function signExtend64(v: bigint): bigint {
  if (v >= 0x8000000000000000n) return v - 0x10000000000000000n;
  return v;
}

/** Displays a value with 32-bit sign semantics when it fits in 32 bits. */
function displaySigned(v: bigint): bigint {
  if (v <= 0xffffffffn) {
    const s32 = v;
    return s32 >= 0x80000000n ? s32 - 0x100000000n : s32;
  }
  return signExtend64(v);
}

/** Removes trailing zeros from a fixed-notation float string. */
function trimFloat(s: string): string {
  if (s.includes("e") || s.includes("E")) return s;
  return s.replace(/\.?0+$/, "");
}

function intValue(arg: On9logArg): bigint {
  if (arg.type === On9logArgType.Bits32) return BigInt(arg.value >>> 0);
  if (arg.type === On9logArgType.Bits64) return arg.value;
  if (arg.type === On9logArgType.Pointer) return BigInt(arg.value);
  throw new FormatRenderError("integer fmt argument required");
}

function fmtInt(
  arg: On9logArg,
  base: number,
  unsigned: boolean,
  spec: FmtSpec,
  upper: boolean,
): string {
  const raw = intValue(arg);
  // 32-bit args are zero-extended on the wire; 64-bit args are full values
  const is32 = arg.type === On9logArgType.Bits32 || arg.type === On9logArgType.Pointer;
  let v: bigint;
  if (is32) {
    if (unsigned || base === 16 || base === 8 || base === 2) {
      v = raw & 0xffffffffn;
    } else {
      const s32 = raw & 0xffffffffn;
      v = s32 >= 0x80000000n ? s32 - 0x100000000n : s32;
    }
  } else {
    v = unsigned || base === 16 || base === 8 || base === 2 ? raw : displaySigned(raw);
  }
  let s = v.toString(base);
  if (upper) s = s.toUpperCase();
  if (spec.alternate) {
    if (base === 16) s = `${upper ? "0X" : "0x"}${s}`;
    else if (base === 8 && !s.startsWith("0")) s = `0${s}`;
    else if (base === 2) s = `${upper ? "0B" : "0b"}${s}`;
  }
  if (spec.sign === "+" && !s.startsWith("-")) s = `+${s}`;
  else if (spec.sign === " " && !s.startsWith("-")) s = ` ${s}`;
  return fmtPad(s, spec);
}

function fmtPad(s: string, spec: FmtSpec): string {
  if (spec.width <= s.length) return s;
  const padLen = spec.width - s.length;
  const fill = spec.fill;
  if (spec.align === "<") return s + fill.repeat(padLen);
  if (spec.align === "^") {
    const left = Math.floor(padLen / 2);
    return fill.repeat(left) + s + fill.repeat(padLen - left);
  }
  // default/right align; zero flag pads zeros after any sign/prefix
  if (spec.zero) {
    const prefixMatch = /^([+-]|0[xXbB])/.exec(s);
    if (prefixMatch) {
      const prefix = prefixMatch[0];
      const rest = s.slice(prefix.length);
      return prefix + "0".repeat(padLen) + rest;
    }
    return "0".repeat(padLen) + s;
  }
  return fill.repeat(padLen) + s;
}
