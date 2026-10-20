using System.Text.Json;
using Xunit;

namespace MuteDeck.PluginClient.Tests;

public sealed class UnitTests
{
    [Fact]
    public void Hello_SerializesLikeTheSpecExample()
    {
        // components.schemas.WsHello.examples[0] in spec/openapi.yaml
        var hello = new WsHello
        {
            Client = new ClientInfo { Id = "streamdeck", Name = "Stream Deck", Version = "13.1.0", HostApp = "stream-deck", HostVersion = "6.8.1", Os = "mac" },
            InstanceId = "6f1c2e0a-8d6e-4c55-9d0e-0d4a3b7f2a91",
            Role = "controller",
            Token = "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
        };
        const string expected = """
            {"action":"hello","protocol":2,"client":{"id":"streamdeck","name":"Stream Deck","version":"13.1.0","host_app":"stream-deck","host_version":"6.8.1","os":"mac"},"instance_id":"6f1c2e0a-8d6e-4c55-9d0e-0d4a3b7f2a91","role":"controller","token":"9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08"}
            """;
        Assert.Equal(expected, JsonSerializer.Serialize(hello, Json.Options));
    }

    [Fact]
    public void Hello_OmitsMissingOptionalFields()
    {
        var hello = new WsHello { Client = new ClientInfo { Id = "x", Name = "X" }, InstanceId = "12345678" };
        Assert.Equal("""{"action":"hello","protocol":2,"client":{"id":"x","name":"X"},"instance_id":"12345678","role":"controller"}""",
            JsonSerializer.Serialize(hello, Json.Options));
    }

    [Fact]
    public void ServerMessages_Deserialize()
    {
        var welcome = JsonSerializer.Deserialize<WsWelcome>("""{"action":"welcome","protocol":2,"status":"ok","server_version":"4.12.0","licensed":true}""")!;
        Assert.Equal("ok", welcome.Status);
        Assert.True(welcome.Licensed);

        var denied = JsonSerializer.Deserialize<WsDenied>("""{"action":"denied","reason":"busy","retry_after":30}""")!;
        Assert.Equal("busy", denied.Reason);
        Assert.Equal(30, denied.RetryAfter);

        var status = JsonSerializer.Deserialize<WsStatusUpdate>("""{"action":"update-status","call":"active","control":"teams","mute":"active","video":"inactive","share":"disabled","record":"inactive","teams_extra":1}""")!;
        Assert.Equal("teams", status.Control);
        Assert.True(status.Extra!.ContainsKey("teams_extra"));

        var error = JsonSerializer.Deserialize<WsResponse>("""{"action":"error","status":401,"reason":"not_authenticated","message":"Authentication required.","id":7}""")!;
        Assert.Equal(401, error.Status);
        Assert.Equal(7, error.Id!.Value.GetInt32());

        var list = JsonSerializer.Deserialize<WsCustomActionList>("""{"action":"list-custom-actions","status":200,"custom_actions":[{"name":"Wave","application":"teams","shortcut":"ctrl+shift+w","type":"custom","icon":"x"},{"name":"Raise hand","type":"builtin","app_types":["zoom","teams"]}]}""")!;
        Assert.Equal("Wave", list.CustomActions[0].Name);
        Assert.Equal("teams", list.CustomActions[0].Application);
        Assert.Equal("ctrl+shift+w", list.CustomActions[0].Shortcut);
        Assert.Equal("custom", list.CustomActions[0].Type);
        Assert.True(list.CustomActions[0].Extra!.ContainsKey("icon"));
        Assert.Equal(new[] { "zoom", "teams" }, list.CustomActions[1].AppTypes);
    }

    [Fact]
    public void StatusReport_Serializes()
    {
        var json = JsonSerializer.Serialize(new StatusReport { Control = "google-meet", Status = "call", Mute = "muted" }, Json.Options);
        Assert.Equal("""{"control":"google-meet","status":"call","mute":"muted"}""", json);
    }

    [Fact]
    public void Redact_MasksTokens()
    {
        var token = new string('f', 64);
        Assert.DoesNotContain(token, MuteDeckClient.Redact(new WsHello { Client = new ClientInfo { Id = "x", Name = "X" }, InstanceId = "12345678", Token = token }));
        Assert.DoesNotContain(token, MuteDeckClient.Redact(new Dictionary<string, object?> { ["token"] = token }));
    }

    [Fact]
    public void Backoff_DoublesUpToTheCapAndResets()
    {
        var backoff = new Backoff(TimeSpan.FromSeconds(1), TimeSpan.FromSeconds(30), () => 1);
        var delays = Enumerable.Range(0, 7).Select(_ => backoff.Next().TotalMilliseconds).ToArray();
        Assert.Equal(new double[] { 1000, 2000, 4000, 8000, 16000, 30000, 30000 }, delays);
        backoff.Reset();
        Assert.Equal(1000, backoff.Next().TotalMilliseconds);
        Assert.Equal(500, new Backoff(TimeSpan.FromSeconds(1), TimeSpan.FromSeconds(30), () => 0).Next().TotalMilliseconds);
    }

    [Fact]
    public async Task FileTokenStore_RoundTrips()
    {
        var dir = Path.Combine(Path.GetTempPath(), "mutedeck-tests-" + Guid.NewGuid());
        var path = Path.Combine(dir, "nested", "credentials.json");
        try
        {
            var store = new FileTokenStore(path);
            Assert.Null((await store.LoadAsync()).Token);
            await store.SaveAsync(new StoredCredentials { Token = "t", InstanceId = "i" });
            var loaded = await new FileTokenStore(path).LoadAsync();
            Assert.Equal("t", loaded.Token);
            Assert.Equal("i", loaded.InstanceId);
            await store.SaveAsync(new StoredCredentials { InstanceId = "i" });
            Assert.Equal("""{"instanceId":"i"}""", File.ReadAllText(path));
            await store.ClearAsync();
            Assert.False(File.Exists(path));
            File.WriteAllText(path.Replace("credentials", "broken"), "{nope");
            Assert.Null((await new FileTokenStore(path.Replace("credentials", "broken")).LoadAsync()).InstanceId);
        }
        finally
        {
            if (Directory.Exists(dir)) Directory.Delete(dir, true);
        }
    }

    [Fact]
    public void SanitizeVersion_Works()
    {
        Assert.Equal("6.8.1", ClientInfo.SanitizeVersion("6.8.1 (21045)"));
        Assert.Equal("7.0+abc123", ClientInfo.SanitizeVersion("7.0+abc123"));
        Assert.Equal("7.0-beta-2", ClientInfo.SanitizeVersion("7.0 beta 2"));
        Assert.Null(ClientInfo.SanitizeVersion("  "));
        Assert.Equal(32, ClientInfo.SanitizeVersion(new string('1', 40))!.Length);
    }

    [Fact]
    public void ClientValidation_SanitizesVersionsInsteadOfThrowing()
    {
        var input = new ClientInfo { Id = "macro-deck", Name = "Macro Deck", Version = "7.0 beta", HostVersion = "2.14.1 (build 5)" };
        var sanitized = Validation.ValidateClient(input);
        Assert.Equal("7.0-beta", sanitized.Version);
        Assert.Equal("2.14.1", sanitized.HostVersion);
        Assert.Equal("7.0 beta", input.Version); // caller's object untouched
        Assert.Throws<ArgumentException>(() => Validation.ValidateClient(new ClientInfo { Id = "ok", Name = "n", HostApp = "Macro Deck" }));
    }
}
