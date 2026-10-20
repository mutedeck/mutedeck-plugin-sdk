using System.Collections.Concurrent;
using Xunit;

namespace MuteDeck.PluginClient.Tests;

public sealed class ClientTests
{
    private const string Instance = "6f1c2e0a-8d6e-4c55-9d0e-0d4a3b7f2a91";

    private static MuteDeckClientOptions Options(FakeMuteDeck server, ITokenStore? store = null, ConcurrentQueue<string>? log = null) => new()
    {
        Client = new ClientInfo { Id = "loupedeck", Name = "Loupedeck", Version = "2.0.0", HostApp = "logi-options-plus", HostVersion = "1.80.0", Os = "mac" },
        Host = "127.0.0.1",
        Port = server.Port,
        TokenStore = store,
        WelcomeTimeout = TimeSpan.FromMilliseconds(500),
        RequestTimeout = TimeSpan.FromMilliseconds(500),
        ReconnectInitialDelay = TimeSpan.FromMilliseconds(50),
        Log = log == null ? null : (level, message) => log.Enqueue($"{level} {message}"),
    };

    private static async Task Until(Func<bool> condition, int timeoutMs = 5000)
    {
        var start = DateTime.UtcNow;
        while (!condition())
        {
            if ((DateTime.UtcNow - start).TotalMilliseconds > timeoutMs) throw new TimeoutException("condition not met");
            await Task.Delay(10);
        }
    }

    [Fact]
    public async Task HappyPath_WithStoredToken()
    {
        await using var server = await FakeMuteDeck.StartAsync(approve: FakeApprove.Manual);
        var token = server.IssueToken(Instance);
        var log = new ConcurrentQueue<string>();
        using var client = new MuteDeckClient(Options(server, new InMemoryTokenStore(new StoredCredentials { Token = token, InstanceId = Instance }), log));
        var statuses = new ConcurrentQueue<WsStatusUpdate>();
        var lists = new ConcurrentQueue<IReadOnlyList<CustomAction>>();
        client.StatusReceived += (_, s) => statuses.Enqueue(s);
        client.CustomActionsReceived += (_, l) => lists.Enqueue(l);

        client.Start();
        await client.WaitUntilReadyAsync(TimeSpan.FromSeconds(5));
        await Until(() => statuses.Count == 1 && lists.Count == 1);

        Assert.Equal(ConnectionState.Authenticated, client.State);
        Assert.Equal("4.12.0", client.ServerVersion);
        var hello = server.Hellos.Single();
        Assert.Equal(token, (string?)hello["token"]);
        Assert.Equal("loupedeck", (string?)hello["client"]!["id"]);
        Assert.Equal("logi-options-plus", (string?)hello["client"]!["host_app"]);
        Assert.Equal("controller", (string?)hello["role"]);
        Assert.Equal("zoom", statuses.Single().Control);
        Assert.Equal("Wave", lists.Single()[0].Name);

        var response = await client.ToggleMuteAsync(ToggleState.On);
        Assert.Equal(200, response.Status);
        var sent = server.Connections.Single().Received.Last();
        Assert.Equal("toggle_mute", (string?)sent["action"]);
        Assert.Equal("on", (string?)sent["state"]);
        Assert.Equal(response.Id!.Value.GetInt32(), (int)sent["id"]!);
        Assert.Null(sent["source"]);

        var unknown = await client.SendAsync("nope");
        Assert.Equal(404, unknown.Status);
        Assert.Equal("unknown_action", unknown.Reason);
        Assert.Equal(2, (await client.ListCustomActionsAsync()).Count);

        await server.PushStatusAsync("active");
        await Until(() => client.LastStatus?.Mute == "active");
        Assert.DoesNotContain(log, line => line.Contains(token));
        await client.StopAsync();
        Assert.Equal(ConnectionState.Disconnected, client.State);
    }

    [Fact]
    public async Task Pending_ThenApproved_StoresToken()
    {
        await using var server = await FakeMuteDeck.StartAsync(approve: FakeApprove.Manual);
        var store = new InMemoryTokenStore();
        var log = new ConcurrentQueue<string>();
        using var client = new MuteDeckClient(Options(server, store, log));
        var approved = 0;
        client.Approved += (_, _) => Interlocked.Increment(ref approved);
        client.Start();

        await Until(() => client.State == ConnectionState.Pending);
        await Task.Delay(700); // longer than the welcome timeout: a pending welcome proves v2
        Assert.Equal(ConnectionState.Pending, client.State);
        Assert.Single(server.Connections);
        Assert.Single(server.Connections.Single().Received);

        await server.ApproveAllAsync();
        await Until(() => client.State == ConnectionState.Authenticated);
        var saved = await store.LoadAsync();
        Assert.Equal(1, approved);
        Assert.Matches("^[0-9a-f]{64}$", saved.Token);
        Assert.True(server.HasToken(saved.Token!));
        Assert.Matches("^[0-9a-f-]{36}$", saved.InstanceId);
        Assert.DoesNotContain(log, line => line.Contains(saved.Token!));
    }

    [Fact]
    public async Task Denied_RaisesEventAndDoesNotReconnect()
    {
        await using var server = await FakeMuteDeck.StartAsync(approve: FakeApprove.Deny);
        server.DenyRetryAfter = 600;
        using var client = new MuteDeckClient(Options(server));
        DeniedEventArgs? denied = null;
        client.Denied += (_, e) => denied = e;
        client.Start();

        await Until(() => denied != null);
        Assert.Equal("user", denied!.Reason);
        Assert.Equal(600, denied.RetryAfter);
        Assert.Equal(ConnectionState.Denied, client.State);
        await Task.Delay(500);
        Assert.Single(server.Connections);
        Assert.Equal(ConnectionState.Denied, client.State);
    }

    [Fact]
    public async Task OldDesktop_FallsBackToV1()
    {
        await using var server = await FakeMuteDeck.StartAsync(FakeMode.V1);
        var options = Options(server);
        options.V1Source = "plugin";
        using var client = new MuteDeckClient(options);
        var status = 0;
        client.StatusReceived += (_, _) => Interlocked.Increment(ref status);
        client.Start();

        await Until(() => client.State == ConnectionState.V1);
        Assert.True(client.IsLegacyServer);
        var connections = server.Connections.ToArray();
        Assert.Equal("/v2", connections[0].Path);
        Assert.Equal("hello", (string?)connections[0].Received.Single()["action"]);
        Assert.Equal("/", connections[1].Path);
        var identify = connections[1].Received.First();
        Assert.Equal("identify", (string?)identify["action"]);
        Assert.Equal("plugin", (string?)identify["source"]);
        Assert.Equal("Loupedeck", (string?)identify["identifier"]);
        await Until(() => status == 1);

        var response = await client.ToggleVideoAsync();
        Assert.Equal(202, response.Status);
        await Until(() => connections[1].Received.Count == 2);
        var sent = connections[1].Received.Last();
        Assert.Equal("toggle_video", (string?)sent["action"]);
        Assert.Equal("plugin", (string?)sent["source"]);
        Assert.Null(sent["id"]);
        Assert.Equal(2, (await client.ListCustomActionsAsync()).Count);
    }

    [Fact]
    public async Task Revoked_ClearsTokenAndReturnsToPending()
    {
        await using var server = await FakeMuteDeck.StartAsync(approve: FakeApprove.Manual);
        var token = server.IssueToken(Instance);
        var store = new InMemoryTokenStore(new StoredCredentials { Token = token, InstanceId = Instance });
        using var client = new MuteDeckClient(Options(server, store));
        var revoked = 0;
        client.Revoked += (_, _) => Interlocked.Increment(ref revoked);
        client.Start();
        await client.WaitUntilReadyAsync(TimeSpan.FromSeconds(5));

        await server.RevokeAllAsync();
        await Until(() => client.State == ConnectionState.Pending);
        Assert.Equal(1, revoked);
        var saved = await store.LoadAsync();
        Assert.Null(saved.Token);
        Assert.Equal(Instance, saved.InstanceId);
        Assert.Null(server.Hellos.Last()["token"]);
    }

    [Fact]
    public async Task UnknownToken_IsClearedWhenPending()
    {
        await using var server = await FakeMuteDeck.StartAsync(approve: FakeApprove.Manual);
        var store = new InMemoryTokenStore(new StoredCredentials { Token = new string('a', 64), InstanceId = Instance });
        using var client = new MuteDeckClient(Options(server, store));
        client.Start();
        await Until(() => client.State == ConnectionState.Pending);
        await Until(() => store.LoadAsync().Result.Token == null);
        Assert.Equal(Instance, (await store.LoadAsync()).InstanceId);
    }

    [Fact]
    public async Task Request_TimesOut()
    {
        await using var server = await FakeMuteDeck.StartAsync();
        server.SilentActions.Add("toggle_share");
        using var client = new MuteDeckClient(Options(server));
        client.Start();
        await client.WaitUntilReadyAsync(TimeSpan.FromSeconds(5));
        await Assert.ThrowsAsync<TimeoutException>(() => client.ToggleShareAsync());
        Assert.Equal(200, (await client.ToggleRecordAsync()).Status);
    }

    [Fact]
    public async Task ConcurrentRequests_AreCorrelatedById()
    {
        await using var server = await FakeMuteDeck.StartAsync();
        using var client = new MuteDeckClient(Options(server));
        client.Start();
        await client.WaitUntilReadyAsync(TimeSpan.FromSeconds(5));
        var responses = await Task.WhenAll(Enumerable.Range(0, 20).Select(_ => client.KeepAliveAsync()));
        Assert.All(responses, r => Assert.Equal(200, r.Status));
        Assert.Equal(20, responses.Select(r => r.Id!.Value.GetInt32()).Distinct().Count());
    }

    [Fact]
    public async Task KeepAlive_IsSentWhilePending()
    {
        await using var server = await FakeMuteDeck.StartAsync(approve: FakeApprove.Manual);
        var options = Options(server);
        options.KeepAliveInterval = TimeSpan.FromMilliseconds(100);
        using var client = new MuteDeckClient(options);
        client.Start();
        await Until(() => client.State == ConnectionState.Pending);
        var conn = server.Connections.Single();
        await Until(() => conn.Received.Count(m => (string?)m["action"] == "keep-alive") >= 2);
        Assert.All(conn.Received.Where(m => (string?)m["action"] == "keep-alive"), m => Assert.NotNull(m["id"]));
        Assert.Equal(ConnectionState.Pending, client.State);
        await client.ReportStatusAsync(new StatusReport { Status = "call" }); // no-op, must not throw
        Assert.Single(server.Hellos);
    }

    [Fact]
    public async Task NotReady_Throws()
    {
        await using var server = await FakeMuteDeck.StartAsync();
        using var client = new MuteDeckClient(Options(server));
        await Assert.ThrowsAsync<MuteDeckNotConnectedException>(() => client.ToggleMuteAsync());
    }

    [Fact]
    public void InvalidClientInfo_Throws()
    {
        Assert.Throws<ArgumentException>(() => new MuteDeckClient(new MuteDeckClientOptions { Client = new ClientInfo { Id = "Bad Id", Name = "x" } }));
    }
}
