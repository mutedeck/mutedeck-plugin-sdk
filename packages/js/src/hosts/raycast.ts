/**
 * Raycast host metadata. Pass `environment` from `@raycast/api` (this module
 * does not import the SDK).
 */
import { osFromPlatform, sanitizeVersion } from "../identity";
import type { HostInfo } from "./common";

export type { HostInfo };

/** The parts of Raycast's `environment` that are used. */
export interface RaycastEnvironmentLike {
  raycastVersion?: string;
}

/**
 * `host_app: "raycast"` and the Raycast version. Pass `process.platform` as
 * `platform` to fill `os` (Raycast runs on macOS and Windows).
 */
export function raycastHostInfo(environment: RaycastEnvironmentLike, platform?: string): HostInfo {
  const result: HostInfo = { host_app: "raycast" };
  const version = sanitizeVersion(environment.raycastVersion);
  if (version) {
    result.host_version = version;
  }
  const os = osFromPlatform(platform);
  if (os) {
    result.os = os;
  }
  return result;
}
