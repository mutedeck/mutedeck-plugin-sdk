import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_CUSTOM_ACTIONS, type MockMuteDeck } from "@mutedeck/mock-server";
import {
  ConnectionClosedError,
  memoryTokenStore,
  MuteDeckClient,
  NotConnectedError,
  RequestTimeoutError,
  type ConnectionState,
  type CustomAction,
  type TokenStore,
  type WsBrowserControl,
  type WsStatusUpdate,
} from "../src/index";
import { FakeSocket, FakeTimers, makeClient, recordingLogger, startMock, tick, until } from "./helpers";

const INSTANCE = "6f1c2e0a-8d6e-4c55-9d0e-0d4a3b7f2a91";

let mock: MockMuteDeck | undefined;
let client: MuteDeckClient | undefined;

afterEach(async () => {
  client?.disconnect();
  client = undefined;
  await mock?.close();
  mock = undefined;
});

function track(c: MuteDeckClient): ConnectionState[] {
  const states: ConnectionState[] = [];
  c.on("state", (s) => states.push(s));
  return states;
}

const hellos = (m: MockMuteDeck) => m.connections.filter((c) => c.hello).map((c) => c.hello!);

describe("v2 handshake", () => {
  it("authenticates with a stored token and receives status and custom actions", async () => {
    mock = await startMock({ approve: "manual" });
    const token = mock.issueToken(INSTANCE, { id: "streamdeck", name: "Stream Deck" });
    const store = memoryTokenStore({ token, instanceId: INSTANCE });
    client = makeClient(mock, { tokenStore: store });
    const statuses: WsStatusUpdate[] = [];
    const lists: CustomAction[][] = [];
    client.on("status", (s) => statuses.push(s));
    client.on("customActions", (a) => lists.push(a));

    client.connect();
    await until(() => client!.state === "authenticated", 3000, "authenticated");
    await until(() => statuses.length === 1 && lists.length === 1);

    const [hello] = hellos(mock);
    expect(hello).toMatchObject({
      action: "hello",
      protocol: 2,
      role: "controller",
      instance_id: INSTANCE,
      token,
      client: { id: "streamdeck", name: "Stream Deck", version: "13.1.0", host_app: "stream-deck", host_version: "6.8.1", os: "mac" },
    });
    expect(mock.connections[0]!.path).toBe("/v2");
    expect(statuses[0]).toMatchObject({ action: "update-status", call: "active", control: "zoom" });
    expect(lists[0]).toEqual(DEFAULT_CUSTOM_ACTIONS);
    expect(client.serverVersion).toBe("4.12.0");
    expect(client.licensed).toBe(true);
    expect(client.isLegacyServer).toBe(false);

    const response = await client.toggleMute("on");
    expect(response.status).toBe(200);
    const sent = mock.connections[0]!.received.at(-1)!;
    expect(sent).toMatchObject({ action: "toggle_mute", state: "on", id: response.id });
    expect(sent).not.toHaveProperty("source");

    mock.pushStatus({ mute: "active" });
    await until(() => statuses.length === 2);
    expect(statuses[1]!.mute).toBe("active");
    expect(client.lastStatus?.mute).toBe("active");
  });

  it("waits while pending, then stores the token on approval", async () => {
    mock = await startMock({ approve: "manual" });
    const store = memoryTokenStore();
    client = makeClient(mock, { tokenStore: store });
    const states = track(client);
    let approved = 0;
    client.on("approved", () => approved++);

    client.connect();
    await until(() => client!.state === "pending", 3000, "pending");
    const saved = await store.load();
    expect(saved.instanceId).toMatch(/^[0-9a-f-]{36}$/);
    expect(saved.token).toBeUndefined();
    expect(hellos(mock)[0]).not.toHaveProperty("token");

    // No re-hello while pending.
    await new Promise((r) => setTimeout(r, 100));
    expect(mock.connections[0]!.received.filter((m) => m.action === "hello")).toHaveLength(1);
    expect(mock.pendingInstances).toEqual([saved.instanceId]);

    expect(mock.approve()).toBe(1);
    await until(() => client!.state === "authenticated", 3000, "authenticated");
    expect(approved).toBe(1);
    const after = await store.load();
    expect(after.token).toMatch(/^[0-9a-f]{64}$/);
    expect(mock.tokens.get(after.token!)?.instanceId).toBe(saved.instanceId);
    expect(after.instanceId).toBe(saved.instanceId);
    expect(states).toEqual(["connecting", "pending", "authenticated"]);

    // The next connection replays the token and skips the prompt.
    client.disconnect();
    client = makeClient(mock, { tokenStore: store });
    client.connect();
    await until(() => client!.state === "authenticated", 3000, "re-authenticated");
    expect(hellos(mock).at(-1)!.token).toBe(after.token);
    expect(mock.pendingInstances).toEqual([]);
  });

  it("gets the decision on reconnect when the socket dropped while pending", async () => {
    mock = await startMock({ approve: "manual" });
    const store = memoryTokenStore();
    client = makeClient(mock, { tokenStore: store });
    client.connect();
    await until(() => client!.state === "pending");
    mock.dropConnections();
    await until(() => client!.state === "disconnected");
    mock.approve();
    await until(() => client!.state === "authenticated", 5000, "authenticated after reconnect");
    expect((await store.load()).token).toMatch(/^[0-9a-f]{64}$/);
  });

  it("stops asking after denial and waits retry_after before the next hello", async () => {
    mock = await startMock({ approve: "deny", denyRetryAfter: 45 });
    const timers = new FakeTimers();
    client = makeClient(mock, { timers });
    const denials: unknown[] = [];
    client.on("denied", (d) => denials.push(d));

    client.connect();
    await until(() => client!.state === "denied", 3000, "denied");
    expect(denials).toEqual([{ reason: "user", retryAfter: 45 }]);
    const connections = mock.connections.length;

    await timers.advance(44_999);
    await new Promise((r) => setTimeout(r, 50));
    expect(mock.connections.length).toBe(connections);
    expect(client.state).toBe("denied");

    await timers.advance(1);
    await until(() => mock!.connections.length === connections + 1, 3000, "new connection");
    // The mock remembers the denial, so the new hello is denied without a prompt.
    await until(() => denials.length === 2, 3000, "second denial");
    expect(mock.pendingInstances).toEqual([]);
  });

  it("waits at least 30 s after a denial without retry_after", async () => {
    const timers = new FakeTimers();
    const sockets: FakeSocket[] = [];
    client = new MuteDeckClient({
      client: { id: "test", name: "Test" },
      webSocketFactory: (url) => {
        const s = new FakeSocket(url);
        sockets.push(s);
        return s;
      },
      timers,
    });
    client.connect();
    sockets[0]!.open();
    await until(() => sockets[0]!.sent.length === 1);
    sockets[0]!.receive({ action: "welcome", protocol: 2, status: "pending" });
    sockets[0]!.receive({ action: "denied", reason: "expired" });
    expect(client.state).toBe("denied");
    expect(timers.pending).toEqual([30_000]);
  });

  it("discards the token when revoked and asks for approval again", async () => {
    mock = await startMock({ approve: "manual" });
    const token = mock.issueToken(INSTANCE);
    const store = memoryTokenStore({ token, instanceId: INSTANCE });
    client = makeClient(mock, { tokenStore: store });
    let revoked = 0;
    client.on("revoked", () => revoked++);
    client.connect();
    await until(() => client!.state === "authenticated");

    expect(mock.revoke({ instanceId: INSTANCE })).toBe(1);
    await until(() => revoked === 1, 3000, "revoked event");
    expect(await store.load()).toEqual({ instanceId: INSTANCE });

    await until(() => client!.state === "pending", 5000, "pending after revoke");
    expect(hellos(mock).at(-1)).not.toHaveProperty("token");
    expect(hellos(mock).at(-1)!.instance_id).toBe(INSTANCE);
  });

  it("clears an unknown token when the server answers pending", async () => {
    mock = await startMock({ approve: "manual" });
    const stale = "a".repeat(64);
    const store = memoryTokenStore({ token: stale, instanceId: INSTANCE });
    client = makeClient(mock, { tokenStore: store });
    client.connect();
    await until(() => client!.state === "pending");
    expect(hellos(mock)[0]!.token).toBe(stale);
    await tick();
    expect(await store.load()).toEqual({ instanceId: INSTANCE });

    mock.approve();
    await until(() => client!.state === "authenticated");
    expect((await store.load()).token).toMatch(/^[0-9a-f]{64}$/);
  });

  it("backs off 60 s after three consecutive token rejections (circuit breaker)", async () => {
    mock = await startMock({ approve: "auto" });
    const timers = new FakeTimers();
    const store = memoryTokenStore({ token: "b".repeat(64), instanceId: INSTANCE });
    client = makeClient(mock, { tokenStore: store, timers });

    // Simulate a broken server that forgets every token it issues.
    const rejectCycle = async (n: number) => {
      await until(() => client!.state === "authenticated", 3000, `authenticated #${n}`);
      mock!.tokens.clear();
      mock!.dropConnections();
      await until(() => client!.state === "disconnected", 3000, `disconnected #${n}`);
    };

    client.connect();
    await rejectCycle(1); // stored token rejected (1), new token approved, then forgotten
    await timers.advance(1000);
    await rejectCycle(2); // fresh token rejected (2)
    await timers.advance(1000);

    // Third rejection trips the breaker: the client closes and waits 60 s.
    await until(() => hellos(mock!).length === 3, 3000, "third hello");
    await until(() => client!.state === "disconnected" && timers.pending.includes(60_000), 3000, "breaker");
    expect(hellos(mock).map((h) => h.token !== undefined)).toEqual([true, true, true]);
    expect((await store.load()).token).toBeUndefined();

    const count = mock.connections.length;
    await timers.advance(59_999);
    await new Promise((r) => setTimeout(r, 50));
    expect(mock.connections.length).toBe(count);
    await timers.advance(1);
    await until(() => client!.state === "authenticated", 3000, "re-enrolled");
    expect(hellos(mock).at(-1)).not.toHaveProperty("token");
  });

  it("treats a pending welcome as proof of v2 (no fallback while waiting for approval)", async () => {
    const timers = new FakeTimers();
    const sockets: FakeSocket[] = [];
    client = new MuteDeckClient({
      client: { id: "test", name: "Test" },
      webSocketFactory: (url) => {
        const s = new FakeSocket(url);
        sockets.push(s);
        return s;
      },
      timers,
    });
    client.connect();
    sockets[0]!.open();
    await until(() => sockets[0]!.sent.length === 1);
    expect(timers.pending).toEqual([3000]);
    sockets[0]!.receive({ action: "welcome", protocol: 2, status: "pending" });
    await timers.advance(10_000);
    expect(client.state).toBe("pending");
    expect(sockets).toHaveLength(1);
    expect(sockets[0]!.sent).toHaveLength(1);
  });

  it("rejects malformed client info up front", () => {
    expect(
      () => new MuteDeckClient({ client: { id: "Stream Deck", name: "x" }, webSocketFactory: () => new FakeSocket("") }),
    ).toThrow(TypeError);
  });
});

describe("v1 fallback", () => {
  it("falls back to v1 after 3 s without welcome, and re-checks v2 after a disconnect", async () => {
    mock = await startMock({ mode: "v1" });
    const timers = new FakeTimers();
    client = makeClient(mock, { timers, v1Source: "streamdeck-plugin" });
    const statuses: WsStatusUpdate[] = [];
    client.on("status", (s) => statuses.push(s));

    client.connect();
    await until(() => mock!.connections[0]?.received.length === 1, 3000, "hello");
    expect(mock.connections[0]!.path).toBe("/v2");

    await timers.advance(2999);
    expect(client.state).toBe("connecting");
    expect(mock.connections).toHaveLength(1);

    await timers.advance(1);
    await until(() => client!.state === "v1", 3000, "v1 state");
    expect(client.isLegacyServer).toBe(true);
    const v1 = mock.connections[1]!;
    expect(v1.path).toBe("/");
    expect(v1.received[0]).toEqual({ source: "streamdeck-plugin", action: "identify", identifier: "Stream Deck" });
    await until(() => statuses.length === 1, 3000, "v1 status push");

    const response = await client.toggleMute();
    expect(response).toEqual({ status: 202 });
    await until(() => v1.received.length === 2);
    expect(v1.received[1]).toEqual({ action: "toggle_mute", source: "streamdeck-plugin" });

    const actions = await client.listCustomActions();
    expect(actions).toEqual(DEFAULT_CUSTOM_ACTIONS);

    // After a disconnect the next attempt tries v2 again.
    mock.dropConnections();
    await until(() => client!.state === "disconnected");
    expect(client.isLegacyServer).toBe(false);
    await timers.advance(1000);
    await until(() => mock!.connections.length === 3);
    expect(mock.connections[2]!.path).toBe("/v2");
  });

  it("uses the default v1 source 'plugin'", async () => {
    mock = await startMock({ mode: "v1" });
    const timers = new FakeTimers();
    client = makeClient(mock, { timers });
    client.connect();
    await until(() => mock!.connections[0]?.received.length === 1);
    await timers.advance(3000);
    await until(() => client!.state === "v1");
    expect(mock.connections[1]!.received[0]).toMatchObject({ source: "plugin", action: "identify" });
  });

  it("works as a v1 status-source (browser extension)", async () => {
    mock = await startMock({ mode: "v1" });
    const timers = new FakeTimers();
    client = makeClient(mock, {
      timers,
      role: "status-source",
      v1Source: "browser-extension-plugin",
      client: { id: "browser-extension", name: "MuteDeck for Chrome", host_app: "chrome" },
    });
    const controls: WsBrowserControl[] = [];
    client.on("browserControl", (c) => controls.push(c));
    client.connect();
    await until(() => mock!.connections[0]?.received.length === 1);
    await timers.advance(3000);
    await until(() => client!.state === "v1");

    client.reportStatus({ control: "google-meet", status: "call", mute: "muted", video: "started" });
    await until(() => mock!.browserStatus !== undefined);
    expect(mock.browserStatus).toEqual({
      action: "update-status",
      source: "browser-extension-plugin",
      control: "google-meet",
      status: "call",
      mute: "muted",
      video: "started",
    });
    expect(mock.pushBrowserControl({ action: "toggle_mute" })).toBe(1);
    await until(() => controls.length === 1);
    expect(controls[0]).toEqual({ action: "toggle_mute" });
  });
});

describe("status-source role (v2)", () => {
  it("reports status and receives control forwards, without status pushes", async () => {
    mock = await startMock({ approve: "auto" });
    client = makeClient(mock, {
      role: "status-source",
      client: { id: "browser-extension", name: "MuteDeck for Chrome", version: "3.0.0", host_app: "chrome", host_version: "130.0.6723.92" },
    });
    const statuses: unknown[] = [];
    const controls: WsBrowserControl[] = [];
    client.on("status", (s) => statuses.push(s));
    client.on("browserControl", (c) => controls.push(c));
    client.connect();
    await until(() => client!.state === "authenticated");
    expect(hellos(mock)[0]!.role).toBe("status-source");

    client.reportStatus({ control: "teams-web", status: "call", mute: "unmuted" });
    await until(() => mock!.browserStatus !== undefined);
    expect(mock.browserStatus).toEqual({ action: "update-status", control: "teams-web", status: "call", mute: "unmuted" });

    mock.pushBrowserControl({ action: "send_reaction", reaction: "like" });
    await until(() => controls.length === 1);
    expect(controls[0]).toEqual({ action: "send_reaction", reaction: "like" });
    expect(statuses).toEqual([]);
  });
});

describe("requests", () => {
  it("correlates concurrent responses by id", async () => {
    mock = await startMock({ approve: "auto" });
    mock.actionResponses.set("toggle_video", { status: 400, reason: "not_in_call", message: "Request invalid. Not in a call." });
    client = makeClient(mock);
    client.connect();
    await until(() => client!.state === "authenticated");

    const [mute, video, unknown, list, keepAlive] = await Promise.all([
      client.toggleMute(),
      client.toggleVideo(),
      client.send("no-such-action"),
      client.listCustomActions(),
      client.keepAlive(),
    ]);
    expect(mute).toMatchObject({ status: 200 });
    expect(video).toMatchObject({ status: 400, reason: "not_in_call" });
    expect(unknown).toMatchObject({ status: 404, reason: "unknown_action" });
    expect(list).toEqual(DEFAULT_CUSTOM_ACTIONS);
    expect(keepAlive).toMatchObject({ status: 200 });
    const ids = [mute.id, video.id, unknown.id, keepAlive.id];
    expect(new Set(ids).size).toBe(4);
    expect(ids.every((id) => typeof id === "number")).toBe(true);

    await client.react("applause");
    await client.customAction("Wave");
    await client.raiseHand();
    const actions = mock.connections[0]!.received.map((m) => m.action);
    expect(actions).toEqual(expect.arrayContaining(["react-applause", "custom-action", "raise-hand"]));
    expect(mock.connections[0]!.received.find((m) => m.action === "custom-action")).toMatchObject({ name: "Wave" });
  });

  it("times out after 5 s without a response", async () => {
    mock = await startMock({ approve: "auto" });
    mock.silentActions.add("toggle_share");
    const timers = new FakeTimers();
    client = makeClient(mock, { timers });
    client.connect();
    await until(() => client!.state === "authenticated");

    const pending = client.toggleShare();
    const outcome = pending.then(
      () => "resolved",
      (e: unknown) => e,
    );
    await until(() => mock!.connections[0]!.received.some((m) => m.action === "toggle_share"));
    await timers.advance(4999);
    expect(await Promise.race([outcome, Promise.resolve("still pending")])).toBe("still pending");
    await timers.advance(1);
    expect(await outcome).toBeInstanceOf(RequestTimeoutError);
  });

  it("rejects pending requests when the socket drops and refuses sends while not ready", async () => {
    mock = await startMock({ approve: "manual" });
    mock.silentActions.add("toggle_record");
    const token = mock.issueToken(INSTANCE);
    client = makeClient(mock, { tokenStore: memoryTokenStore({ token, instanceId: INSTANCE }) });
    await expect(client.toggleMute()).rejects.toBeInstanceOf(NotConnectedError);
    client.connect();
    await client.whenReady(3000);
    const pending = client.toggleRecord();
    mock.dropConnections();
    await expect(pending).rejects.toBeInstanceOf(ConnectionClosedError);
  });
});

describe("reconnect", () => {
  it("backs off exponentially from 1 s to 30 s and resets after a successful welcome", async () => {
    const timers = new FakeTimers();
    const sockets: FakeSocket[] = [];
    let accept = false;
    client = new MuteDeckClient({
      client: { id: "test", name: "Test" },
      webSocketFactory: (url) => {
        const socket = new FakeSocket(url);
        sockets.push(socket);
        queueMicrotask(() => (accept ? socket.open() : socket.fail()));
        return socket;
      },
      timers,
      random: () => 1,
    });

    client.connect();
    await tick();
    const delays: number[] = [];
    for (let i = 0; i < 7; i++) {
      delays.push(timers.pending[0]!);
      await timers.advance(timers.pending[0]!);
      await tick();
    }
    expect(delays).toEqual([1000, 2000, 4000, 8000, 16000, 30000, 30000]);

    accept = true;
    await timers.advance(timers.pending[0]!);
    const socket = sockets.at(-1)!;
    await until(() => socket.sent.length === 1, 1000, "hello");
    socket.receive({ action: "welcome", protocol: 2, status: "ok" });
    expect(client.state).toBe("authenticated");
    accept = false;
    socket.fail();
    expect(timers.pending).toEqual([1000]);
  });

  it("applies jitter between half and the full delay", async () => {
    const timers = new FakeTimers();
    client = new MuteDeckClient({
      client: { id: "test", name: "Test" },
      webSocketFactory: (url) => {
        const socket = new FakeSocket(url);
        queueMicrotask(() => socket.fail());
        return socket;
      },
      timers,
      random: () => 0,
    });
    client.connect();
    await tick();
    expect(timers.pending).toEqual([500]);
  });
});

describe("logging", () => {
  it("never logs the token", async () => {
    mock = await startMock({ approve: "manual", log: () => undefined });
    const logger = recordingLogger();
    const store: TokenStore = memoryTokenStore();
    client = makeClient(mock, { tokenStore: store, logger });
    client.connect();
    await until(() => client!.state === "pending");
    mock.approve();
    await until(() => client!.state === "authenticated");
    const { token } = await store.load();
    expect(token).toBeDefined();

    // Reconnect so the hello carries the token, then revoke it.
    mock.dropConnections();
    await until(() => client!.state === "authenticated" && hellos(mock!).length === 2, 5000, "reconnected");
    expect(hellos(mock)[1]!.token).toBe(token);
    await client.toggleMute();
    mock.revoke();
    await until(() => client!.state === "pending", 5000, "pending after revoke");

    expect(logger.lines.length).toBeGreaterThan(10);
    expect(logger.lines.some((l) => l.includes('"action":"hello"'))).toBe(true);
    for (const line of logger.lines) {
      expect(line).not.toContain(token!);
    }
  });
});

describe("follow-up behaviour", () => {
  it("sends keep-alives while pending when keepAliveIntervalMs is set", async () => {
    mock = await startMock({ approve: "manual" });
    const timers = new FakeTimers();
    client = makeClient(mock, { timers, keepAliveIntervalMs: 20_000 });
    client.connect();
    await until(() => client!.state === "pending");
    const conn = mock.connections[0]!;
    await timers.advance(20_000);
    await until(() => conn.received.some((m) => m.action === "keep-alive"), 3000, "keep-alive");
    expect(conn.received.find((m) => m.action === "keep-alive")).toHaveProperty("id");
    // The answer arrives and nothing else (no 401 error).
    await new Promise((r) => setTimeout(r, 50));
    expect(client.state).toBe("pending");
    await timers.advance(20_000);
    await until(() => conn.received.filter((m) => m.action === "keep-alive").length === 2, 3000, "second keep-alive");
    expect(conn.received.filter((m) => m.action === "hello")).toHaveLength(1);
  });

  it("exposes the last close code and reason", async () => {
    mock = await startMock({ approve: "manual" });
    client = makeClient(mock);
    const closes: unknown[] = [];
    client.on("close", (c) => closes.push(c));
    client.connect();
    await until(() => client!.state === "pending");
    mock.connections[0]!.socket.close(4321, "bye");
    await until(() => closes.length === 1);
    expect(client.lastClose).toEqual({ code: 4321, reason: "bye", byClient: false });
    client.disconnect();
    await until(() => client!.state === "disconnected");
  });

  it("records client-initiated closes (denied)", async () => {
    mock = await startMock({ approve: "deny" });
    client = makeClient(mock);
    client.connect();
    await until(() => client!.state === "denied");
    expect(client.lastClose).toEqual({ reason: "denied", byClient: true });
  });

  it("reportStatus is a no-op while not ready", async () => {
    const logger = recordingLogger();
    client = new MuteDeckClient({ client: { id: "test", name: "Test" }, role: "status-source", webSocketFactory: (u) => new FakeSocket(u), logger });
    expect(() => client!.reportStatus({ status: "call" })).not.toThrow();
    expect(logger.lines.some((l) => l.startsWith("debug") && l.includes("not reporting status"))).toBe(true);
  });

  it("StoredCredentialsJson fits JSON object types (Stream Deck settings)", () => {
    type JsonPrimitive = boolean | number | string | null | undefined;
    type JsonValue = JsonObject | JsonPrimitive | JsonValue[];
    type JsonObject = { [key: string]: JsonValue };
    const creds: import("../src/index").StoredCredentialsJson = { token: "t", instanceId: "i" };
    const asJson: JsonObject = creds; // compile-time check
    expect(asJson).toEqual(creds);
  });
});
