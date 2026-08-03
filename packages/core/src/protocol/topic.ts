/**
 * MQTT v1 topic constants, construction, parsing and device-UID validation.
 *
 * All topic strings for Soulcloud devices must be built or parsed through
 * this module; topic literals must not be scattered through the services.
 *
 * v1 topic scheme:
 *   Platform to device: soulcloud/v1/devices/{dev_uid}/ota
 *                       soulcloud/v1/devices/{dev_uid}/cmd/exec
 *   Device to platform: soulcloud/v1/devices/{dev_uid}/cmd/result
 *                       soulcloud/v1/devices/{dev_uid}/log
 *                       soulcloud/v1/devices/{dev_uid}/stat
 */

export const TOPIC_PREFIX = "soulcloud/v1/devices";

/** Device-to-platform subscription filters (all QoS 1). */
export const DEVICE_TO_PLATFORM_FILTERS = [
  `${TOPIC_PREFIX}/+/cmd/result`,
  `${TOPIC_PREFIX}/+/log`,
  `${TOPIC_PREFIX}/+/stat`,
] as const;

export type DeviceMessageKind = "cmd/result" | "log" | "stat";

export interface DeviceTopic {
  deviceUid: string;
  kind: DeviceMessageKind;
}

export class TopicError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TopicError";
  }
}

/**
 * A legal device UID is non-empty and contains no `/`, `+`, `#` or whitespace.
 */
export function isValidDeviceUid(deviceUid: string): boolean {
  return (
    deviceUid.length > 0 &&
    !deviceUid.includes("/") &&
    !deviceUid.includes("+") &&
    !deviceUid.includes("#") &&
    !/\s/.test(deviceUid)
  );
}

function requireValidDeviceUid(deviceUid: string): void {
  if (!isValidDeviceUid(deviceUid)) {
    throw new TopicError(
      `invalid device UID ${JSON.stringify(deviceUid)}: must be non-empty and contain no '/', '+', '#' or whitespace`,
    );
  }
}

/** Platform-to-device OTA command topic. */
export function otaCommand(deviceUid: string): string {
  requireValidDeviceUid(deviceUid);
  return `${TOPIC_PREFIX}/${deviceUid}/ota`;
}

/** Platform-to-device generic command execution topic. */
export function commandExecution(deviceUid: string): string {
  requireValidDeviceUid(deviceUid);
  return `${TOPIC_PREFIX}/${deviceUid}/cmd/exec`;
}

/**
 * Parses an inbound device-to-platform topic.
 *
 * @throws {TopicError} for an unknown shape or an unsafe device UID.
 */
export function parseDeviceTopic(topic: string): DeviceTopic {
  const segments = topic.split("/");
  const isPrefix = segments[0] === "soulcloud" && segments[1] === "v1" && segments[2] === "devices";
  if (!isPrefix) {
    throw new TopicError(`topic does not match the Soulcloud v1 device topic scheme: ${JSON.stringify(topic)}`);
  }
  const deviceUid = segments[3]!;
  let kind: DeviceMessageKind | undefined;
  if (segments.length === 5 && (segments[4] === "log" || segments[4] === "stat")) {
    kind = segments[4] as DeviceMessageKind;
  } else if (segments.length === 6 && segments[4] === "cmd" && segments[5] === "result") {
    kind = "cmd/result";
  }
  if (!kind) {
    throw new TopicError(`topic does not match the Soulcloud v1 device topic scheme: ${JSON.stringify(topic)}`);
  }
  if (!isValidDeviceUid(deviceUid)) {
    throw new TopicError(`invalid device UID in topic: ${JSON.stringify(topic)}`);
  }
  return { deviceUid, kind };
}
