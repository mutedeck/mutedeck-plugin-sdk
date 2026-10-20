/**
 * Browser host metadata (`host_app`, `host_version`, `os`) for extensions.
 * Pure functions; nothing here touches extension APIs unless you call
 * {@link detectBrowserHost}, which only reads globals that exist.
 */
import { osFromPlatform, sanitizeVersion } from "../identity";
import type { HostInfo } from "./common";

export type { HostInfo };

export type BrowserName = "chrome" | "edge" | "brave" | "firefox" | "safari" | "opera" | "vivaldi";

/** Inputs for {@link browserHostInfo}; pass what you have. */
export interface BrowserHostInput {
  /** `navigator.userAgent` */
  userAgent?: string;
  /** `navigator.userAgentData` (Chromium) */
  userAgentData?: {
    brands?: ReadonlyArray<{ brand: string; version: string }>;
    platform?: string;
  };
  /** Result of `browser.runtime.getBrowserInfo()` (Firefox) */
  browserInfo?: { name?: string; version?: string };
  /** Whether `navigator.brave` exists (Brave hides itself in the user agent) */
  isBrave?: boolean;
}

const BRANDS: Array<[RegExp, BrowserName]> = [
  [/^brave$/i, "brave"],
  [/^microsoft edge$/i, "edge"],
  [/^opera$/i, "opera"],
  [/^vivaldi$/i, "vivaldi"],
  [/^google chrome$/i, "chrome"],
];

/** Work out browser, version and OS from the given inputs. */
export function browserHostInfo(input: BrowserHostInput): HostInfo {
  const ua = input.userAgent ?? "";
  const os = osFromPlatform(input.userAgentData?.platform) ?? osFromUserAgent(ua);
  const result = (host_app: BrowserName, version?: string): HostInfo => {
    const info: HostInfo = { host_app };
    const host_version = sanitizeVersion(version);
    if (host_version) {
      info.host_version = host_version;
    }
    if (os) {
      info.os = os;
    }
    return info;
  };

  if (input.browserInfo?.name && /firefox/i.test(input.browserInfo.name)) {
    return result("firefox", input.browserInfo.version);
  }

  const chromeVersion = match(ua, /(?:Chrome|CriOS)\/([\d.]+)/);
  if (input.isBrave) {
    return result("brave", brandVersion(input, /^brave$/i) ?? chromeVersion);
  }
  for (const brand of input.userAgentData?.brands ?? []) {
    for (const [pattern, name] of BRANDS) {
      if (pattern.test(brand.brand)) {
        // Brand versions are major-only; prefer the full version from the UA when it is the same browser.
        const uaVersion = name === "chrome" ? chromeVersion : name === "edge" ? match(ua, /Edg\/([\d.]+)/) : undefined;
        return result(name, uaVersion ?? brand.version);
      }
    }
  }

  const edge = match(ua, /Edg(?:e|A|iOS)?\/([\d.]+)/);
  if (edge) {
    return result("edge", edge);
  }
  const opera = match(ua, /OPR\/([\d.]+)/);
  if (opera) {
    return result("opera", opera);
  }
  const vivaldi = match(ua, /Vivaldi\/([\d.]+)/);
  if (vivaldi) {
    return result("vivaldi", vivaldi);
  }
  const firefox = match(ua, /(?:Firefox|FxiOS)\/([\d.]+)/);
  if (firefox) {
    return result("firefox", firefox);
  }
  if (chromeVersion) {
    return result("chrome", chromeVersion);
  }
  const safari = /Safari\//.test(ua) ? match(ua, /Version\/([\d.]+)/) : undefined;
  if (safari) {
    return result("safari", safari);
  }
  return os ? { os } : {};
}

/**
 * Reads `navigator` and, in Firefox, `browser.runtime.getBrowserInfo()`, then
 * calls {@link browserHostInfo}. Safe to call where those globals are missing.
 */
export async function detectBrowserHost(): Promise<HostInfo> {
  const g = globalThis as {
    navigator?: { userAgent?: string; userAgentData?: BrowserHostInput["userAgentData"]; brave?: unknown };
    browser?: { runtime?: { getBrowserInfo?: () => Promise<{ name?: string; version?: string }> } };
  };
  let browserInfo: BrowserHostInput["browserInfo"];
  try {
    browserInfo = await g.browser?.runtime?.getBrowserInfo?.();
  } catch {
    browserInfo = undefined;
  }
  return browserHostInfo({
    userAgent: g.navigator?.userAgent,
    userAgentData: g.navigator?.userAgentData,
    browserInfo,
    isBrave: g.navigator?.brave !== undefined,
  });
}

function brandVersion(input: BrowserHostInput, pattern: RegExp): string | undefined {
  return input.userAgentData?.brands?.find((b) => pattern.test(b.brand))?.version;
}

function osFromUserAgent(ua: string): HostInfo["os"] {
  if (/Windows/.test(ua)) {
    return "windows";
  }
  if (/Macintosh|Mac OS X/.test(ua)) {
    return "mac";
  }
  if (/Linux|CrOS|X11/.test(ua) && !/Android/.test(ua)) {
    return "linux";
  }
  return undefined;
}

function match(text: string, pattern: RegExp): string | undefined {
  return pattern.exec(text)?.[1];
}
