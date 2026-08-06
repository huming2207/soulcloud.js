/**
 * API layer tests: URL / query / body construction for the typed helpers.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";

const calls: Array<{
  method: string;
  url: string;
  params?: Record<string, unknown>;
  data?: unknown;
}> = [];

const httpMock = {
  get: mock(async (url: string, config?: { params?: Record<string, unknown> }) => {
    calls.push({ method: "get", url, params: config?.params });
    return { data: {} };
  }),
  post: mock(
    async (
      url: string,
      data?: unknown,
      config?: { params?: Record<string, unknown> },
    ) => {
      calls.push({ method: "post", url, params: config?.params, data });
      return { data: {} };
    },
  ),
};
mock.module("./http", () => ({ http: httpMock, errorMessage: (e: unknown) => String(e) }));

const devices = await import("./devices");
const logs = await import("./logs");
const firmware = await import("./firmware");

beforeEach(() => {
  calls.length = 0;
  httpMock.get.mockClear();
  httpMock.post.mockClear();
});

describe("api/devices", () => {
  test("fetchDevices builds the project URL with pagination params", async () => {
    await devices.fetchDevices("p1", { limit: 25, offset: 50 });
    expect(httpMock.get).toHaveBeenCalledWith("/v1/projects/p1/devices", {
      params: { limit: 25, offset: 50 },
    });
  });

  test("createDevice posts the snake_case body", async () => {
    await devices.createDevice({
      project_id: "p1",
      assigned_id: "sensor-a",
      device_uid: "uid-1",
    });
    expect(httpMock.post).toHaveBeenCalledWith("/v1/devices", {
      project_id: "p1",
      assigned_id: "sensor-a",
      device_uid: "uid-1",
    });
  });

  test("fetchDeviceCommands omits the cursor when absent", async () => {
    await devices.fetchDeviceCommands("d1", { limit: 50 });
    expect(httpMock.get).toHaveBeenCalledWith("/v1/devices/d1/commands", {
      params: { limit: 50 },
    });
    calls.length = 0;
    await devices.fetchDeviceCommands("d1", { limit: 50, cursor: "42" });
    expect(httpMock.get).toHaveBeenCalledWith("/v1/devices/d1/commands", {
      params: { limit: 50, cursor: "42" },
    });
  });

  test("bindFirmwareState posts artifact_id", async () => {
    await devices.bindFirmwareState("d1", "a1");
    expect(httpMock.post).toHaveBeenCalledWith("/v1/devices/d1/firmware-state", {
      artifact_id: "a1",
    });
  });
});

describe("api/logs", () => {
  test("fetchDeviceLogs passes include_raw as 1", async () => {
    await logs.fetchDeviceLogs("d1", { limit: 100, includeRaw: true });
    expect(httpMock.get).toHaveBeenCalledWith("/v1/devices/d1/logs", {
      params: { limit: 100, include_raw: 1 },
    });
  });
});

describe("api/firmware", () => {
  test("fetchReleases passes the composite cursor", async () => {
    await firmware.fetchReleases("p1", { limit: 50, cursor: "2026-08-06T00:00:00Z|r1" });
    expect(httpMock.get).toHaveBeenCalledWith("/v1/firmware-releases", {
      params: { project_id: "p1", limit: 50, cursor: "2026-08-06T00:00:00Z|r1" },
    });
  });

  test("deployRelease posts device_ids", async () => {
    await firmware.deployRelease("r1", ["d1", "d2"]);
    expect(httpMock.post).toHaveBeenCalledWith("/v1/firmware-releases/r1/deploy", {
      device_ids: ["d1", "d2"],
    });
  });

  test("createRollout posts the strategy body to the release URL", async () => {
    await firmware.createRollout("r1", {
      strategy: "auto",
      device_ids: ["d1"],
      ratios: [1.0],
      success_ratio: 0.9,
      min_sample: 5,
      phase_timeout_hours: 24,
      stuck_hours: 6,
      manual_approval: true,
    });
    expect(httpMock.post).toHaveBeenCalledWith("/v1/firmware-releases/r1/rollouts", {
      strategy: "auto",
      device_ids: ["d1"],
      ratios: [1.0],
      success_ratio: 0.9,
      min_sample: 5,
      phase_timeout_hours: 24,
      stuck_hours: 6,
      manual_approval: true,
    });
  });

  test("uploadRelease builds a multipart form with bin and elf", async () => {
    const bin = new File([new Uint8Array(4)], "fw.bin");
    const elf = new File([new Uint8Array(4)], "fw.elf");
    await firmware.uploadRelease("p1", { bin, elf }, "v2.0.0");
    const args = httpMock.post.mock.calls[0] as unknown as [
      string,
      FormData,
    ];
    expect(args[0]).toBe("/v1/firmware-releases");
    const form = args[1] as FormData;
    expect(form.get("project_id")).toBe("p1");
    expect(form.get("version")).toBe("v2.0.0");
    expect(form.get("bin")).toBeInstanceOf(File);
    expect(form.get("elf")).toBeInstanceOf(File);
  });
});
