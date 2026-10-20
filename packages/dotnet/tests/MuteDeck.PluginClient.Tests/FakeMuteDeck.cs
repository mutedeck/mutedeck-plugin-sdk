using System.Collections.Concurrent;
using System.Net.WebSockets;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Hosting.Server;
using Microsoft.AspNetCore.Hosting.Server.Features;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.Logging;

namespace MuteDeck.PluginClient.Tests;

public enum FakeMode { V2, V1 }
public enum FakeApprove { Auto, Manual, Deny }

/// <summary>In-process fake MuteDeck (WebSocket only), mirroring the Node mock server's behaviour.</summary>
public sealed class FakeMuteDeck : IAsyncDisposable
{
    public sealed class Connection
    {
        public required WebSocket Socket { get; init; }
        public required string Path { get; init; }
        public int Protocol { get; init; }
        public JsonObject? Hello { get; set; }
        public bool Authenticated { get; set; }
        public string? Token { get; set; }
        public ConcurrentQueue<JsonObject> Received { get; } = new();
        public SemaphoreSlim SendLock { get; } = new(1, 1);
    }

    private readonly WebApplication _app;
    private readonly ConcurrentDictionary<string, string> _tokens = new(); // token -> instance id
    private readonly ConcurrentDictionary<string, Connection> _pending = new(); // instance id -> socket

    public FakeMode Mode { get; set; }
    public FakeApprove Approve { get; set; }
    public int DenyRetryAfter { get; set; } = 600;
    public HashSet<string> SilentActions { get; } = new();
    public ConcurrentQueue<Connection> Connections { get; } = new();
    public int Port { get; private set; }

    private FakeMuteDeck(FakeMode mode, FakeApprove approve)
    {
        Mode = mode;
        Approve = approve;
        var builder = WebApplication.CreateSlimBuilder();
        builder.Logging.ClearProviders();
        builder.WebHost.UseUrls("http://127.0.0.1:0");
        _app = builder.Build();
        _app.UseWebSockets();
        _app.Run(async context =>
        {
            if (!context.WebSockets.IsWebSocketRequest)
            {
                context.Response.StatusCode = 426;
                return;
            }
            var socket = await context.WebSockets.AcceptWebSocketAsync();
            var path = context.Request.Path.Value ?? "/";
            var conn = new Connection { Socket = socket, Path = path, Protocol = path == "/v2" && Mode == FakeMode.V2 ? 2 : 1 };
            Connections.Enqueue(conn);
            await ServeAsync(conn);
        });
    }

    public static async Task<FakeMuteDeck> StartAsync(FakeMode mode = FakeMode.V2, FakeApprove approve = FakeApprove.Auto)
    {
        var server = new FakeMuteDeck(mode, approve);
        await server._app.StartAsync();
        var address = server._app.Services.GetService(typeof(IServer)) is IServer s
            ? s.Features.Get<IServerAddressesFeature>()!.Addresses.First()
            : throw new InvalidOperationException();
        server.Port = new Uri(address).Port;
        return server;
    }

    public string IssueToken(string instanceId)
    {
        var token = Convert.ToHexString(RandomNumberGenerator.GetBytes(32)).ToLowerInvariant();
        _tokens[token] = instanceId;
        return token;
    }

    public bool HasToken(string token) => _tokens.ContainsKey(token);

    public IEnumerable<JsonObject> Hellos => Connections.Where(c => c.Hello != null).Select(c => c.Hello!);

    public int PendingCount => _pending.Count;

    public async Task ApproveAllAsync()
    {
        foreach (var (instanceId, conn) in _pending.ToArray())
        {
            _pending.TryRemove(instanceId, out _);
            var token = IssueToken(instanceId);
            await SendAsync(conn, new JsonObject { ["action"] = "approved", ["token"] = token });
            await AuthenticateAsync(conn, token);
        }
    }

    public async Task DenyAllAsync()
    {
        foreach (var (instanceId, conn) in _pending.ToArray())
        {
            _pending.TryRemove(instanceId, out _);
            await SendAsync(conn, new JsonObject { ["action"] = "denied", ["reason"] = "user", ["retry_after"] = DenyRetryAfter });
            conn.Hello = null;
        }
    }

    public async Task RevokeAllAsync()
    {
        foreach (var token in _tokens.Keys.ToArray())
        {
            _tokens.TryRemove(token, out _);
            foreach (var conn in Connections.Where(c => c.Token == token && c.Socket.State == WebSocketState.Open))
            {
                await SendAsync(conn, new JsonObject { ["action"] = "revoked" });
                try { await conn.Socket.CloseAsync(WebSocketCloseStatus.PolicyViolation, "revoked", CancellationToken.None); }
                catch (Exception) { /* the client may close first */ }
            }
        }
    }

    public async Task PushStatusAsync(string mute)
    {
        foreach (var conn in Connections.Where(c => c.Authenticated && c.Socket.State == WebSocketState.Open))
            await SendAsync(conn, Status(mute));
    }

    private static JsonObject Status(string mute = "inactive") => new()
    {
        ["action"] = "update-status", ["call"] = "active", ["control"] = "zoom", ["mute"] = mute,
        ["video"] = "active", ["share"] = "inactive", ["record"] = "inactive",
    };

    private async Task ServeAsync(Connection conn)
    {
        var buffer = new byte[64 * 1024];
        try
        {
            while (conn.Socket.State == WebSocketState.Open)
            {
                var result = await conn.Socket.ReceiveAsync(buffer, CancellationToken.None);
                if (result.MessageType == WebSocketMessageType.Close) break;
                if (JsonNode.Parse(Encoding.UTF8.GetString(buffer, 0, result.Count)) is not JsonObject msg) continue;
                conn.Received.Enqueue(msg);
                if (conn.Protocol == 2) await OnV2Async(conn, msg);
                else await OnV1Async(conn, msg);
            }
        }
        catch (WebSocketException)
        {
        }
    }

    private async Task OnV2Async(Connection conn, JsonObject msg)
    {
        var action = (string?)msg["action"];
        var id = msg["id"]?.DeepClone();
        if (conn.Hello == null)
        {
            if (action != "hello")
            {
                await SendAsync(conn, WithId(new JsonObject { ["action"] = "error", ["status"] = 401, ["reason"] = "not_authenticated" }, id));
                return;
            }
            conn.Hello = msg;
            var instanceId = (string)msg["instance_id"]!;
            var token = (string?)msg["token"];
            if (token != null && _tokens.TryGetValue(token, out var owner) && owner == instanceId)
            {
                await AuthenticateAsync(conn, token);
                return;
            }
            await SendAsync(conn, new JsonObject { ["action"] = "welcome", ["protocol"] = 2, ["status"] = "pending" });
            _pending[instanceId] = conn;
            if (Approve == FakeApprove.Auto) await ApproveAllAsync();
            else if (Approve == FakeApprove.Deny) await DenyAllAsync();
            return;
        }
        if (!conn.Authenticated)
        {
            if (action == "keep-alive")
            {
                if (id != null) await SendAsync(conn, WithId(new JsonObject { ["status"] = 200 }, id));
                return;
            }
            await SendAsync(conn, WithId(new JsonObject { ["action"] = "error", ["status"] = 401, ["reason"] = "not_authenticated" }, id));
            return;
        }
        await DispatchAsync(conn, action, id, v2: true);
    }

    private async Task OnV1Async(Connection conn, JsonObject msg)
    {
        var source = (string?)msg["source"];
        if (source is not ("plugin" or "streamdeck-plugin" or "browser-extension-plugin")) return; // drops hello
        var action = (string?)msg["action"];
        if (action == "identify")
        {
            if (source != "browser-extension-plugin") await SendAsync(conn, Status());
            return;
        }
        await DispatchAsync(conn, action, null, v2: false);
    }

    private async Task DispatchAsync(Connection conn, string? action, JsonNode? id, bool v2)
    {
        if (action == null || SilentActions.Contains(action) || action == "update-status") return;
        if (action == "keep-alive")
        {
            if (id != null) await SendAsync(conn, WithId(new JsonObject { ["status"] = 200 }, id));
            return;
        }
        if (action == "list-custom-actions")
        {
            await SendAsync(conn, WithId(CustomActions(), v2 ? id : null));
            return;
        }
        if (action.StartsWith("toggle") || action.StartsWith("react-") || action is "leave_meeting" or "bring-to-front" or "raise-hand" or "custom-action")
        {
            await SendAsync(conn, WithId(new JsonObject { ["status"] = 200 }, v2 ? id : null));
            return;
        }
        if (v2) await SendAsync(conn, WithId(new JsonObject { ["status"] = 404, ["reason"] = "unknown_action" }, id));
    }

    private async Task AuthenticateAsync(Connection conn, string token)
    {
        conn.Authenticated = true;
        conn.Token = token;
        await SendAsync(conn, new JsonObject { ["action"] = "welcome", ["protocol"] = 2, ["status"] = "ok", ["server_version"] = "4.12.0", ["licensed"] = true });
        if ((string?)conn.Hello?["role"] != "status-source")
        {
            await SendAsync(conn, Status());
            await SendAsync(conn, CustomActions());
        }
    }

    private static JsonObject CustomActions() => new()
    {
        ["action"] = "list-custom-actions", ["status"] = 200,
        ["custom_actions"] = new JsonArray(new JsonObject { ["name"] = "Wave", ["application"] = "teams", ["shortcut"] = "ctrl+shift+w", ["type"] = "custom" },
            new JsonObject { ["name"] = "Raise hand", ["type"] = "builtin", ["app_types"] = new JsonArray("zoom", "teams") }),
    };

    private static JsonObject WithId(JsonObject body, JsonNode? id)
    {
        if (id != null) body["id"] = id;
        return body;
    }

    private static async Task SendAsync(Connection conn, JsonObject message)
    {
        var bytes = Encoding.UTF8.GetBytes(message.ToJsonString());
        await conn.SendLock.WaitAsync();
        try
        {
            if (conn.Socket.State == WebSocketState.Open)
                await conn.Socket.SendAsync(bytes, WebSocketMessageType.Text, true, CancellationToken.None);
        }
        catch (WebSocketException)
        {
        }
        finally
        {
            conn.SendLock.Release();
        }
    }

    public async ValueTask DisposeAsync()
    {
        foreach (var conn in Connections)
        {
            try { conn.Socket.Abort(); } catch (Exception) { /* request already finished */ }
        }
        using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(1));
        await _app.StopAsync(cts.Token);
        await _app.DisposeAsync();
    }
}
