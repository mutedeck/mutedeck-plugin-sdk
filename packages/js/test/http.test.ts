import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_CUSTOM_ACTIONS, type MockMuteDeck } from "@mutedeck/mock-server";
import {
  LegacyServerError,
  memoryTokenStore,
  MuteDeckHttpClient,
  MuteDeckUnreachableError,
  NotAuthenticatedError,
  PairingDeniedError,
  PairingRequiredError,
  type MuteDeckHttpClientOptions,
} from "../src/index";
import { startMock } from "./helpers";

let mock: MockMuteDeck | undefined;
afterEach(async () => {
  await mock?.close();
  mock = undefined;
});

const RAYCAST = { id: "raycast", name: "Raycast", version: "1.3.0", host_app: "raycast", host_version: "1.84.2", os: "mac" } as const;
const INSTANCE = "1d1f8f4e-5f0a-4b5e-9c55-2f8f5a1d3c11";

function http(m: MockMuteDeck, options: Partial<MuteDeckHttpClientOptions> = {}): MuteDeckHttpClient {
  return new MuteDeckHttpClient({ client: { ...RAYCAST }, host: m.host, port: m.httpPort, ...options });
}

describe("MuteDeckHttpClient", () => {
  it("pairs via /v1/pair, then sends the token as Bearer on /v1 calls", async () => {
    mock = await startMock({ approve: "manual", pairPollAfter: 0 });
    const store = memoryTokenStore();
    const client = http(mock, { tokenStore: store });
    const pendings: unknown[] = [];
    const pairing = client.pair({ onPending: (p) => pendings.push(p) });
    await mock.waitFor("pending");
    await new Promise((r) => setTimeout(r, 250));
    mock.approve();
    const token = await pairing;

    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect((await store.load()).token).toBe(token);
    expect(pendings[0]).toMatchObject({ status: "pending", poll_after: 0, expires_in: 120 });
    expect(mock.httpRequests[0]).toMatchObject({ method: "POST", path: "/v1/pair" });
    expect(mock.httpRequests.filter((r) => r.path.startsWith("/v1/pair/")).length).toBeGreaterThanOrEqual(2);
    expect(mock.httpRequests[0]!.body).toMatchObject({ client: RAYCAST, instance_id: (await store.load()).instanceId });

    const status = await client.getStatus();
    expect(status).toMatchObject({ status: 200, call: "active", version: "4.12.0" });
    const request = mock.httpRequests.at(-1)!;
    expect(request.path).toBe("/v1/status");
    expect(request.headers.authorization).toBe(`Bearer ${token}`);
    expect(request.headers["x-mutedeck-client"]).toBe("raycast/1.3.0 (raycast 1.84.2)");
    expect(request.query.source).toBe("raycast");

    expect(await client.mute("on")).toEqual({ status: 200 });
    expect(mock.httpRequests.at(-1)).toMatchObject({ method: "POST", path: "/v1/mute", query: { state: "on", source: "raycast" } });
    expect(await client.whoami()).toMatchObject({ status: 200, client_id: "raycast", name: "Raycast" });
    expect(await client.listCustomActions()).toEqual(DEFAULT_CUSTOM_ACTIONS);
    expect(await client.customAction("Nope")).toMatchObject({ status: 404 });
    expect(await client.react("tada")).toEqual({ status: 200 });
    expect(client.isLegacyServer).toBe(false);
  });

  it("works without a token under the default policy, with the outcome in the body", async () => {
    mock = await startMock();
    mock.actionResponses.set("toggle_video", { status: 400, message: "Request invalid. Not in a call." });
    const client = http(mock);
    expect(await client.video()).toEqual({ status: 400, message: "Request invalid. Not in a call." });
    const request = mock.httpRequests.at(-1)!;
    expect(request.headers.authorization).toBeUndefined();
    expect(request.query.source).toBe("raycast");
  });

  it("clears a rejected token and throws NotAuthenticatedError (a PairingRequiredError)", async () => {
    mock = await startMock();
    const store = memoryTokenStore({ token: "c".repeat(64), instanceId: INSTANCE });
    const client = http(mock, { tokenStore: store });
    const error = await client.mute().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(NotAuthenticatedError);
    expect(error).toBeInstanceOf(PairingRequiredError);
    expect(await store.load()).toEqual({ instanceId: INSTANCE });
    // Without the token the default policy allows the call again.
    expect(await client.mute()).toEqual({ status: 200 });
  });

  it("throws PairingRequiredError for 426 (block) and 401 without a token (local only, remote)", async () => {
    mock = await startMock({ legacyPolicy: "block" });
    const blocked = await http(mock).mute().catch((e: unknown) => e);
    expect(blocked).toBeInstanceOf(PairingRequiredError);
    expect(blocked).not.toBeInstanceOf(NotAuthenticatedError);
    expect(blocked).toMatchObject({ reason: "upgrade_required" });

    mock.legacyPolicy = "local";
    mock.httpClientsAreRemote = true;
    await expect(http(mock).getStatus()).rejects.toMatchObject({ reason: "not_authenticated" });
    mock.httpClientsAreRemote = false;
    expect(await http(mock).getStatus()).toMatchObject({ status: 200 });
  });

  it("autoPair pairs and retries once when MuteDeck requires a token", async () => {
    mock = await startMock({ legacyPolicy: "block", approve: "auto", pairPollAfter: 0 });
    const client = http(mock, { autoPair: true });
    expect(await client.mute()).toEqual({ status: 200 });
    expect(await client.hasToken()).toBe(true);
    expect(mock.httpRequests.map((r) => r.path)).toEqual(
      expect.arrayContaining(["/v1/mute", "/v1/pair", "/v1/mute"]),
    );
    expect(mock.httpRequests.at(-1)!.headers.authorization).toMatch(/^Bearer /);
  });

  it("whoami needs a token", async () => {
    mock = await startMock();
    await expect(http(mock).whoami()).rejects.toBeInstanceOf(PairingRequiredError);
  });

  it("reports a denied pairing", async () => {
    mock = await startMock({ approve: "deny", pairPollAfter: 0, denyRetryAfter: 600 });
    const client = http(mock);
    const error = await client.pair().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PairingDeniedError);
    expect(error).toMatchObject({ reason: "user", retryAfter: 600 });
    await expect(client.pair()).rejects.toMatchObject({ reason: "user" });
  });

  it("detects an old MuteDeck by /v1/pair or /v1/whoami 404 and keeps calling /v1 without a token", async () => {
    mock = await startMock({ mode: "v1" });
    const client = http(mock);
    expect(await client.probe()).toBe("v1");
    expect(mock.httpRequests.at(-1)!.path).toBe("/v1/whoami");
    await expect(client.pair()).rejects.toBeInstanceOf(LegacyServerError);
    expect(await client.ensurePaired()).toBeUndefined();
    expect(client.isLegacyServer).toBe(true);

    expect(await client.mute("toggle")).toEqual({ status: 200 });
    expect(mock.httpRequests.at(-1)).toMatchObject({ method: "POST", path: "/v1/mute", query: { state: "toggle", source: "raycast" } });
    expect(await client.getStatus()).toMatchObject({ status: 200, call: "active" });
    await expect(client.whoami()).rejects.toBeInstanceOf(LegacyServerError);
  });

  it("ensurePaired resolves undefined on an old MuteDeck without probing first", async () => {
    mock = await startMock({ mode: "v1" });
    expect(await http(mock).ensurePaired()).toBeUndefined();
  });

  it("probes a current server and an unreachable one", async () => {
    mock = await startMock();
    expect(await http(mock).probe()).toBe("v2");
    expect(mock.pendingInstances).toEqual([]); // no prompt
    const port = mock.httpPort;
    await mock.close();
    mock = undefined;
    expect(await new MuteDeckHttpClient({ client: { ...RAYCAST }, host: "127.0.0.1", port }).probe()).toBe("unreachable");
  });

  it("ensurePaired dedupes concurrent pairing and returns the stored token afterwards", async () => {
    mock = await startMock({ approve: "auto", pairPollAfter: 0 });
    const client = http(mock);
    const [a, b] = await Promise.all([client.ensurePaired(), client.ensurePaired()]);
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(mock.httpRequests.filter((r) => r.path === "/v1/pair")).toHaveLength(1);
    expect(await client.ensurePaired()).toBe(a);
    expect(mock.httpRequests.filter((r) => r.path === "/v1/pair")).toHaveLength(1);
  });

  it("ensurePaired waits max(deniedRetryMinMs, retry_after) after a denial", async () => {
    mock = await startMock({ approve: "deny", pairPollAfter: 0, denyReason: "expired" });
    let now = 1_000_000;
    const client = http(mock, { now: () => now });
    await expect(client.ensurePaired()).rejects.toMatchObject({ reason: "expired" });
    const requests = mock.httpRequests.length;

    now += 29_000;
    await expect(client.ensurePaired()).rejects.toMatchObject({ reason: "expired", retryAfter: 1 });
    expect(mock.httpRequests.length).toBe(requests);

    now += 1_000;
    await expect(client.ensurePaired()).rejects.toBeInstanceOf(PairingDeniedError);
    expect(mock.httpRequests.length).toBeGreaterThan(requests);
  });

  it("accepts a full baseUrl", async () => {
    mock = await startMock();
    const client = new MuteDeckHttpClient({ client: { ...RAYCAST }, baseUrl: `${mock.httpUrl}/` });
    expect(await client.probe()).toBe("v2");
  });

  it("maps network failures and timeouts to MuteDeckUnreachableError", async () => {
    mock = await startMock();
    const port = mock.httpPort;
    await mock.close();
    mock = undefined;
    const refused = new MuteDeckHttpClient({ client: { ...RAYCAST }, host: "127.0.0.1", port });
    await expect(refused.getStatus()).rejects.toBeInstanceOf(MuteDeckUnreachableError);

    const hanging = new MuteDeckHttpClient({
      client: { ...RAYCAST },
      timeoutMs: 50,
      fetch: (_url, init) =>
        new Promise((_resolve, reject) => init.signal?.addEventListener("abort", () => reject(new Error("aborted")))),
    });
    await expect(hanging.getStatus()).rejects.toThrow(/did not answer within 50 ms/);
  });
});
