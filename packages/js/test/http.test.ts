import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_CUSTOM_ACTIONS, type MockMuteDeck } from "@mutedeck/mock-server";
import {
  LegacyServerError,
  memoryTokenStore,
  MuteDeckHttpClient,
  MuteDeckUnreachableError,
  NotAuthenticatedError,
  PairingDeniedError,
  type MuteDeckHttpClientOptions,
} from "../src/index";
import { startMock } from "./helpers";

let mock: MockMuteDeck | undefined;
afterEach(async () => {
  await mock?.close();
  mock = undefined;
});

const RAYCAST = { id: "raycast", name: "Raycast", version: "1.3.0", host_app: "raycast", host_version: "1.84.2", os: "mac" } as const;

function http(m: MockMuteDeck, options: Partial<MuteDeckHttpClientOptions> = {}): MuteDeckHttpClient {
  return new MuteDeckHttpClient({ client: { ...RAYCAST }, host: m.host, port: m.httpPort, ...options });
}

describe("MuteDeckHttpClient", () => {
  it("pairs by polling, stores the token and calls /v2 with Bearer and X-MuteDeck-Client", async () => {
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
    const polls = mock.httpRequests.filter((r) => r.path.startsWith("/v2/pair/"));
    expect(polls.length).toBeGreaterThanOrEqual(2);
    expect(mock.httpRequests[0]!.body).toMatchObject({ client: RAYCAST, instance_id: (await store.load()).instanceId });

    const status = await client.getStatus();
    expect(status).toMatchObject({ status: 200, call: "active", version: "4.12.0" });
    const request = mock.httpRequests.at(-1)!;
    expect(request.headers.authorization).toBe(`Bearer ${token}`);
    expect(request.headers["x-mutedeck-client"]).toBe("raycast/1.3.0 (raycast 1.84.2)");

    expect(await client.mute("on")).toEqual({ status: 200 });
    expect(mock.httpRequests.at(-1)).toMatchObject({ method: "POST", path: "/v2/mute", query: { state: "on" } });
    expect(await client.whoami()).toMatchObject({ status: 200, client_id: "raycast", name: "Raycast" });
    expect(await client.listCustomActions()).toEqual(DEFAULT_CUSTOM_ACTIONS);
    expect(await client.customAction("Nope")).toMatchObject({ status: 404, reason: "not_found" });
    expect(await client.react("tada")).toEqual({ status: 200 });
    expect(client.isLegacyServer).toBe(false);
  });

  it("returns API rejections as bodies", async () => {
    mock = await startMock();
    mock.actionResponses.set("toggle_video", { status: 400, reason: "not_in_call", message: "Request invalid. Not in a call." });
    const token = mock.issueToken("1d1f8f4e-5f0a-4b5e-9c55-2f8f5a1d3c11");
    const client = http(mock, { tokenStore: memoryTokenStore({ token, instanceId: "1d1f8f4e-5f0a-4b5e-9c55-2f8f5a1d3c11" }) });
    expect(await client.video()).toMatchObject({ status: 400, reason: "not_in_call" });
  });

  it("throws NotAuthenticatedError on 401 and clears the token", async () => {
    mock = await startMock();
    const store = memoryTokenStore({ token: "c".repeat(64), instanceId: "1d1f8f4e-5f0a-4b5e-9c55-2f8f5a1d3c11" });
    const client = http(mock, { tokenStore: store });
    await expect(client.mute()).rejects.toBeInstanceOf(NotAuthenticatedError);
    expect(await store.load()).toEqual({ instanceId: "1d1f8f4e-5f0a-4b5e-9c55-2f8f5a1d3c11" });
    await expect(client.mute()).rejects.toBeInstanceOf(NotAuthenticatedError);
  });

  it("reports a denied pairing", async () => {
    mock = await startMock({ approve: "deny", pairPollAfter: 0, denyRetryAfter: 600 });
    const client = http(mock);
    const error = await client.pair().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PairingDeniedError);
    expect(error).toMatchObject({ reason: "user", retryAfter: 600 });
    // A second attempt is refused straight away (403 on POST).
    await expect(client.pair()).rejects.toMatchObject({ reason: "user" });
  });

  it("detects an old MuteDeck and falls back to /v1 with ?source=<client.id>", async () => {
    mock = await startMock({ mode: "v1" });
    const client = http(mock);
    expect(await client.probe()).toBe("v1");
    await expect(client.pair()).rejects.toBeInstanceOf(LegacyServerError);
    expect(client.isLegacyServer).toBe(true);

    expect(await client.mute("toggle")).toEqual({ status: 200 });
    expect(mock.httpRequests.at(-1)).toMatchObject({ method: "POST", path: "/v1/mute", query: { state: "toggle", source: "raycast" } });
    expect(await client.getStatus()).toMatchObject({ status: 200, call: "active" });
  });

  it("detects an old MuteDeck on the first call too", async () => {
    mock = await startMock({ mode: "v1" });
    const client = http(mock);
    expect(await client.leave()).toEqual({ status: 200 });
    expect(mock.httpRequests.map((r) => r.path)).toEqual(["/v2/leave", "/v1/leave"]);
  });

  it("can refuse the v1 fallback", async () => {
    mock = await startMock({ mode: "v1" });
    const client = http(mock, { legacyFallback: false });
    await expect(client.mute()).rejects.toBeInstanceOf(LegacyServerError);
  });

  it("probes a v2 server and an unreachable one", async () => {
    mock = await startMock();
    expect(await http(mock).probe()).toBe("v2");
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
    expect(mock.httpRequests.filter((r) => r.path === "/v2/pair")).toHaveLength(1);
    expect(await client.ensurePaired()).toBe(a);
    expect(mock.httpRequests.filter((r) => r.path === "/v2/pair")).toHaveLength(1);
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
