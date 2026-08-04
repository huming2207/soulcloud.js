/**
 * ota/result protocol tests: strict MessagePack decoding of device
 * acknowledgements (structure pre-check, schema validation, no trailing
 * bytes, bounded message length, unknown keys rejected).
 */

import { describe, expect, test } from "bun:test";
import { encode } from "@msgpack/msgpack";
import {
  MAX_OTA_RESULT_MESSAGE,
  OTA_RESULT_CODES,
  OtaResultPayloadError,
  decodeOtaResult,
} from "../../src/protocol/ota-result";

const RELEASE_ID = "3f4d9a2e-8c1b-4f5e-9a2b-0c1d2e3f4a5b";
const JOB_ID = "9a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d";

function packet(payload: Record<string, unknown>): Uint8Array {
  return encode(payload);
}

describe("decodeOtaResult", () => {
  test("decodes a valid downloaded ack", () => {
    const result = decodeOtaResult(
      packet({ release_id: RELEASE_ID, job_id: JOB_ID, state: "downloaded", code: 0 }),
    );
    expect(result).toEqual({
      release_id: RELEASE_ID,
      job_id: JOB_ID,
      state: "downloaded",
      code: 0,
    });
  });

  test("decodes a failed ack with message", () => {
    const result = decodeOtaResult(
      packet({
        release_id: RELEASE_ID,
        job_id: JOB_ID,
        state: "failed",
        code: -2,
        message: "sha256 mismatch",
      }),
    );
    expect(result.message).toBe("sha256 mismatch");
  });

  test("message at the 512-byte boundary is accepted, longer is rejected", () => {
    const ok = decodeOtaResult(
      packet({
        release_id: RELEASE_ID,
        job_id: JOB_ID,
        state: "failed",
        code: -5,
        message: "x".repeat(MAX_OTA_RESULT_MESSAGE),
      }),
    );
    expect(ok.message?.length).toBe(MAX_OTA_RESULT_MESSAGE);
    expect(() =>
      decodeOtaResult(
        packet({
          release_id: RELEASE_ID,
          job_id: JOB_ID,
          state: "failed",
          code: -5,
          message: "x".repeat(MAX_OTA_RESULT_MESSAGE + 1),
        }),
      ),
    ).toThrow(OtaResultPayloadError);
  });

  test("unknown keys are rejected", () => {
    expect(() =>
      decodeOtaResult(
        packet({
          release_id: RELEASE_ID,
          job_id: JOB_ID,
          state: "downloaded",
          code: 0,
          extra: 1,
        }),
      ),
    ).toThrow(OtaResultPayloadError);
  });

  test("bad uuid, unknown state, missing fields are rejected", () => {
    expect(() =>
      decodeOtaResult(packet({ release_id: "not-a-uuid", job_id: JOB_ID, state: "downloaded", code: 0 })),
    ).toThrow(OtaResultPayloadError);
    expect(() =>
      decodeOtaResult(packet({ release_id: RELEASE_ID, job_id: JOB_ID, state: "booting", code: 0 })),
    ).toThrow(OtaResultPayloadError);
    expect(() =>
      decodeOtaResult(packet({ release_id: RELEASE_ID, job_id: JOB_ID, code: 0 })),
    ).toThrow(OtaResultPayloadError);
    expect(() =>
      decodeOtaResult(packet({ release_id: RELEASE_ID, job_id: JOB_ID, state: "downloaded" })),
    ).toThrow(OtaResultPayloadError);
  });

  test("trailing bytes are rejected", () => {
    const body = packet({ release_id: RELEASE_ID, job_id: JOB_ID, state: "downloaded", code: 0 });
    const padded = new Uint8Array(body.length + 1);
    padded.set(body);
    padded[body.length] = 0x00;
    expect(() => decodeOtaResult(padded)).toThrow(OtaResultPayloadError);
  });

  test("garbage bytes are rejected", () => {
    expect(() => decodeOtaResult(new Uint8Array([0xff, 0xfe, 0xfd]))).toThrow(
      OtaResultPayloadError,
    );
  });

  test("failure code registry covers the documented v1 set", () => {
    expect(OTA_RESULT_CODES).toEqual({
      SUCCESS: 0,
      DOWNLOAD_FAILED: -1,
      CHECKSUM_MISMATCH: -2,
      FLASH_FAILED: -3,
      INVALID_IMAGE: -4,
      OTHER: -5,
      DELIVERY_WINDOW_TIMEOUT: -7,
    });
  });
});
