import { describe, expect, it } from "vitest";
import { browserHostInfo } from "../src/hosts/browser";
import { raycastHostInfo } from "../src/hosts/raycast";
import { streamDeckHostInfo } from "../src/hosts/streamdeck";
import { clientHeader, fromAsyncKeyValue, fromAsyncStringStorage, memoryTokenStore, sanitizeVersion, validateClientInfo } from "../src/index";

const CHROME_MAC =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.6723.92 Safari/537.36";
const EDGE_WIN =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.2849.68";
const FIREFOX_LINUX = "Mozilla/5.0 (X11; Linux x86_64; rv:131.0) Gecko/20100101 Firefox/131.0";
const SAFARI = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15";

describe("browser host", () => {
  it("detects Chrome", () => {
    expect(browserHostInfo({ userAgent: CHROME_MAC })).toEqual({ host_app: "chrome", host_version: "130.0.6723.92", os: "mac" });
  });

  it("detects Edge from the UA and from brands", () => {
    expect(browserHostInfo({ userAgent: EDGE_WIN })).toEqual({ host_app: "edge", host_version: "130.0.2849.68", os: "windows" });
    expect(
      browserHostInfo({
        userAgent: EDGE_WIN,
        userAgentData: { brands: [{ brand: "Chromium", version: "130" }, { brand: "Microsoft Edge", version: "130" }], platform: "Windows" },
      }),
    ).toEqual({ host_app: "edge", host_version: "130.0.2849.68", os: "windows" });
  });

  it("detects Brave", () => {
    expect(browserHostInfo({ userAgent: CHROME_MAC, isBrave: true })).toMatchObject({ host_app: "brave", host_version: "130.0.6723.92" });
    expect(
      browserHostInfo({ userAgent: CHROME_MAC, userAgentData: { brands: [{ brand: "Brave", version: "130" }], platform: "macOS" } }),
    ).toMatchObject({ host_app: "brave", os: "mac" });
  });

  it("detects Firefox from getBrowserInfo and from the UA", () => {
    expect(browserHostInfo({ userAgent: FIREFOX_LINUX, browserInfo: { name: "Firefox", version: "131.0.3" } })).toEqual({
      host_app: "firefox",
      host_version: "131.0.3",
      os: "linux",
    });
    expect(browserHostInfo({ userAgent: FIREFOX_LINUX })).toMatchObject({ host_app: "firefox", host_version: "131.0" });
  });

  it("detects Safari", () => {
    expect(browserHostInfo({ userAgent: SAFARI })).toEqual({ host_app: "safari", host_version: "18.1", os: "mac" });
  });

  it("returns nothing it cannot recognise", () => {
    expect(browserHostInfo({ userAgent: "curl/8.0" })).toEqual({});
  });
});

describe("Stream Deck and Raycast hosts", () => {
  it("maps streamDeck.info", () => {
    expect(
      streamDeckHostInfo({ application: { version: "6.8.1.21045", platform: "mac" }, plugin: { version: "13.1.0.0" } }),
    ).toEqual({ host_app: "stream-deck", host_version: "6.8.1.21045", os: "mac", version: "13.1.0.0" });
    expect(streamDeckHostInfo({ application: { platform: "windows" } })).toEqual({ host_app: "stream-deck", os: "windows" });
  });

  it("maps Raycast's environment", () => {
    expect(raycastHostInfo({ raycastVersion: "1.84.2" }, "darwin")).toEqual({ host_app: "raycast", host_version: "1.84.2", os: "mac" });
    expect(raycastHostInfo({})).toEqual({ host_app: "raycast" });
  });
});

describe("helpers", () => {
  it("sanitizes versions and builds the client header", () => {
    expect(sanitizeVersion("6.8.1 (build 21045)")).toBe("6.8.1");
    expect(sanitizeVersion("v1_2")).toBe("v12");
    expect(sanitizeVersion("7.0 beta")).toBe("7.0-beta");
    expect(sanitizeVersion("x".repeat(40))).toHaveLength(32);
    expect(sanitizeVersion("")).toBeUndefined();
    expect(clientHeader({ id: "raycast", name: "Raycast" })).toBe("raycast");
    expect(clientHeader({ id: "raycast", name: "Raycast", version: "1.3.0", host_app: "raycast" })).toBe("raycast/1.3.0 (raycast)");
  });

  it("validates ClientInfo limits", () => {
    expect(() => validateClientInfo({ id: "ok-id", name: "Fine" })).not.toThrow();
    expect(() => validateClientInfo({ id: "x".repeat(33), name: "Fine" })).toThrow(/client.id/);
    expect(() => validateClientInfo({ id: "ok", name: "" })).toThrow(/client.name/);
    expect(validateClientInfo({ id: "ok", name: "n", version: "7.0+abc123", host_version: "6.8.1 (21045)" })).toEqual({
      id: "ok",
      name: "n",
      version: "7.0+abc123",
      host_version: "6.8.1",
    });
    expect(validateClientInfo({ id: "ok", name: "n", version: "7.0 beta 2" }).version).toBe("7.0-beta-2");
    expect(validateClientInfo({ id: "ok", name: "n", version: "()" })).toEqual({ id: "ok", name: "n" });
    expect(() => validateClientInfo({ id: "ok", name: "n", host_app: "Stream Deck" })).toThrow(/client.host_app/);
  });

  it("adapts async key-value storage", async () => {
    const backing = new Map<string, unknown>();
    const store = fromAsyncKeyValue(
      async (k) => backing.get(k),
      async (k, v) => void backing.set(k, v),
      async (k) => void backing.delete(k),
    );
    expect(await store.load()).toEqual({});
    await store.save({ token: "t", instanceId: "i" });
    expect(backing.get("mutedeck.credentials")).toEqual({ token: "t", instanceId: "i" });
    expect(await store.load()).toEqual({ token: "t", instanceId: "i" });
    await store.clear();
    expect(backing.size).toBe(0);
  });

  it("adapts string storage", async () => {
    const backing = new Map<string, string>();
    const store = fromAsyncStringStorage(
      (k) => backing.get(k),
      (k, v) => void backing.set(k, v),
      (k) => void backing.delete(k),
      "md",
    );
    await store.save({ instanceId: "abc" });
    expect(backing.get("md")).toBe('{"instanceId":"abc"}');
    expect(await store.load()).toEqual({ instanceId: "abc" });
    backing.set("md", "{not json");
    expect(await store.load()).toEqual({});
  });

  it("memory store copies data", async () => {
    const store = memoryTokenStore({ instanceId: "a" });
    const loaded = await store.load();
    loaded.instanceId = "b";
    expect(await store.load()).toEqual({ instanceId: "a" });
  });
});
