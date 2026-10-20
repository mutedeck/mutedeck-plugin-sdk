import type { ClientInfo } from "../types";

/** The `ClientInfo` fields a host helper fills in. */
export type HostInfo = Pick<ClientInfo, "host_app" | "host_version" | "os">;
