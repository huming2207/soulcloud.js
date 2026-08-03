/**
 * SLIP framing for the on9log UART/stdio transport (verified against the
 * on9log_demo Unix build output).
 *
 * Frame: 0xa5 [type] [payload] [crc16_ccitt_le] 0xc0
 *
 *   type 0x01 = on9log binary packet (payload is on9log header + payload)
 *   type 0x02 = plain text stdout/stderr bytes
 *
 * Escapes inside the payload and CRC bytes:
 *   0xa5 -> 0xdb 0xde
 *   0xc0 -> 0xdb 0xdc
 *   0xdb -> 0xdb 0xdd
 *   0x0d -> 0xdb 0xd0   (CR, UART VFS newline conversion)
 *   0x0a -> 0xdb 0xd1   (LF, UART VFS newline conversion)
 *
 * CRC-16-CCITT, init 0xffff, over the unescaped type byte + payload bytes,
 * appended little-endian and SLIP-escaped before the ending 0xc0.
 */

export const ON9LOG_FRAME_START = 0xa5;
export const ON9LOG_FRAME_END = 0xc0;
export const ON9LOG_FRAME_TYPE_ON9LOG = 0x01;
export const ON9LOG_FRAME_TYPE_TEXT = 0x02;

export class SlipParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SlipParseError";
  }
}

/** CRC-16-CCITT (init 0xffff), table-driven. */
export function crc16Ccitt(data: Uint8Array, init = 0xffff): number {
  let crc = init;
  for (const byte of data) {
    crc ^= byte << 8;
    for (let i = 0; i < 8; i++) {
      crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc;
}

export interface SlipFrame {
  /** Frame type byte (0x01 on9log, 0x02 text). */
  type: number;
  /** Unescaped frame payload (without type byte and CRC). */
  payload: Uint8Array;
  /** Byte offset of the frame start in the input stream. */
  start: number;
  /** Byte offset just past the ending 0xc0. */
  end: number;
}

/**
 * Incremental SLIP frame decoder.
 *
 * Feed raw stream bytes with `push()`, then call `frames()` to collect all
 * complete frames parsed so far (consuming them from the buffer). Partial
 * frames are retained for the next push.
 */
export class SlipDecoder {
  private buf: number[] = [];

  /** Appends raw bytes to the decoder buffer. */
  push(bytes: Uint8Array): void {
    for (const b of bytes) this.buf.push(b);
  }

  /**
   * Extracts all complete frames from the buffered bytes.
   *
   * Bytes before a valid frame start are skipped (resync); an unterminated
   * frame is kept until the end marker arrives or the buffer overflows.
   */
  frames(maxBuffer = 1 << 20): SlipFrame[] {
    const out: SlipFrame[] = [];
    let i = 0;
    while (i < this.buf.length) {
      // resync to frame start
      if (this.buf[i] !== ON9LOG_FRAME_START) {
        i++;
        continue;
      }
      const start = i;
      const raw: number[] = [];
      let type: number | null = null;
      let j = i + 1;
      let ended = false;
      while (j < this.buf.length) {
        const b = this.buf[j]!;
        if (b === ON9LOG_FRAME_END) {
          ended = true;
          break;
        }
        if (b === 0xdb) {
          // escape sequence
          const next = this.buf[j + 1];
          if (next === undefined) break; // wait for more bytes
          const map: Record<number, number> = {
            0xde: 0xa5,
            0xdc: 0xc0,
            0xdd: 0xdb,
            0xd0: 0x0d,
            0xd1: 0x0a,
          };
          const decoded = map[next];
          if (decoded === undefined) {
            throw new SlipParseError(`invalid SLIP escape 0xdb 0x${next.toString(16)}`);
          }
          if (type === null) {
            type = decoded;
          } else {
            raw.push(decoded);
          }
          j += 2;
          continue;
        }
        if (type === null) {
          type = b;
        } else {
          raw.push(b);
        }
        j++;
      }
      if (!ended) break; // frame incomplete, wait for more data

      const payload = Uint8Array.from(raw);
      // last two payload bytes are the little-endian CRC
      if (payload.length < 2) {
        throw new SlipParseError("SLIP frame payload too short (no CRC)");
      }
      const crcBytes = payload.subarray(payload.length - 2);
      const crc = crcBytes[0]! | (crcBytes[1]! << 8);
      const body = payload.subarray(0, payload.length - 2);
      // `type` is non-null here: the frame ended, so the type byte was seen
      const computed = crc16Ccitt(Uint8Array.of(type as number), 0xffff);
      const full = crc16Ccitt(body, computed);
      if (full !== crc) {
        throw new SlipParseError(
          `SLIP frame CRC mismatch: got 0x${crc.toString(16)}, expected 0x${full.toString(16)}`,
        );
      }

      out.push({ type: type as number, payload: body, start, end: j + 1 });
      i = j + 1;
    }

    if (i > 0) this.buf.splice(0, i);
    if (this.buf.length > maxBuffer) {
      throw new SlipParseError("SLIP decoder buffer overflow");
    }
    return out;
  }
}
