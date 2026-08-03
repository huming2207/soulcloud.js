import { describe, expect, test } from "bun:test";
import {
  DEVICE_TO_PLATFORM_FILTERS,
  TopicError,
  commandExecution,
  isValidDeviceUid,
  otaCommand,
  parseDeviceTopic,
} from "../src/protocol/topic";

describe("parseDeviceTopic", () => {
  test("parses device-to-platform topics", () => {
    expect(parseDeviceTopic("soulcloud/v1/devices/dev-42/log")).toEqual({
      deviceUid: "dev-42",
      kind: "log",
    });
    expect(parseDeviceTopic("soulcloud/v1/devices/dev-42/stat")).toEqual({
      deviceUid: "dev-42",
      kind: "stat",
    });
    expect(parseDeviceTopic("soulcloud/v1/devices/dev-42/cmd/result")).toEqual({
      deviceUid: "dev-42",
      kind: "cmd/result",
    });
  });

  test("rejects wildcards and unknown topics", () => {
    expect(() => parseDeviceTopic("soulcloud/v1/devices/+/log")).toThrow(TopicError);
    expect(() => parseDeviceTopic("soulcloud/v1/devices/dev-42/ota")).toThrow(TopicError);
    expect(() => parseDeviceTopic("soulcloud/v1/devices/dev-42/ota/status")).toThrow(TopicError);
    expect(() => parseDeviceTopic("soulcloud/v1/devices/dev-42/cmd/exec")).toThrow(TopicError);
    expect(() => parseDeviceTopic("soulcloud/v1/devices/dev-42/unknown")).toThrow(TopicError);
    expect(() => parseDeviceTopic("other/v1/devices/dev-42/log")).toThrow(TopicError);
  });
});

describe("topic builders", () => {
  test("builds platform-to-device topics", () => {
    expect(otaCommand("dev-42")).toBe("soulcloud/v1/devices/dev-42/ota");
    expect(commandExecution("dev-42")).toBe(
      "soulcloud/v1/devices/dev-42/cmd/exec",
    );
  });

  test("rejects unsafe device UIDs", () => {
    expect(() => otaCommand("bad/device")).toThrow(TopicError);
    expect(() => commandExecution("bad/device")).toThrow(TopicError);
    expect(() => commandExecution("")).toThrow(TopicError);
    expect(() => commandExecution("has space")).toThrow(TopicError);
    expect(() => commandExecution("has+plus")).toThrow(TopicError);
    expect(() => commandExecution("has#hash")).toThrow(TopicError);
  });
});

describe("isValidDeviceUid", () => {
  test("accepts safe UIDs", () => {
    expect(isValidDeviceUid("dev-42")).toBe(true);
    expect(isValidDeviceUid("a.b_c:1")).toBe(true);
  });

  test("rejects unsafe UIDs", () => {
    expect(isValidDeviceUid("")).toBe(false);
    expect(isValidDeviceUid("a/b")).toBe(false);
    expect(isValidDeviceUid("a+b")).toBe(false);
    expect(isValidDeviceUid("a#b")).toBe(false);
    expect(isValidDeviceUid("a b")).toBe(false);
    expect(isValidDeviceUid("a\tb")).toBe(false);
  });
});

describe("DEVICE_TO_PLATFORM_FILTERS", () => {
  test("contains the three uplink filters", () => {
    expect(DEVICE_TO_PLATFORM_FILTERS).toEqual([
      "soulcloud/v1/devices/+/cmd/result",
      "soulcloud/v1/devices/+/log",
      "soulcloud/v1/devices/+/stat",
    ]);
  });
});
