/**
 * Stream Deck host metadata. Pass `streamDeck.info` from `@elgato/streamdeck`
 * (this module does not import the SDK).
 */
import { osFromPlatform, sanitizeVersion } from "../identity";
import type { ClientInfo } from "../types";
import type { HostInfo } from "./common";

export type { HostInfo };

/** The parts of `streamDeck.info` (RegistrationInfo) that are used. */
export interface StreamDeckInfoLike {
  application?: { version?: string; platform?: string };
  plugin?: { version?: string };
}

/**
 * `host_app: "stream-deck"`, the Stream Deck app version and OS, plus the
 * plugin's own `version` from the manifest when present.
 */
export function streamDeckHostInfo(info: StreamDeckInfoLike): HostInfo & Pick<ClientInfo, "version"> {
  const result: HostInfo & Pick<ClientInfo, "version"> = { host_app: "stream-deck" };
  const hostVersion = sanitizeVersion(info.application?.version);
  if (hostVersion) {
    result.host_version = hostVersion;
  }
  const os = osFromPlatform(info.application?.platform);
  if (os) {
    result.os = os;
  }
  const version = sanitizeVersion(info.plugin?.version);
  if (version) {
    result.version = version;
  }
  return result;
}
