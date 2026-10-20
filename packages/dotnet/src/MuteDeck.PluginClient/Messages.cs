using System.Collections.Generic;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace MuteDeck.PluginClient
{
    /// <summary>Self-description sent in <c>hello</c> (spec: <c>ClientInfo</c>).</summary>
    public sealed class ClientInfo
    {
        /// <summary>Stable slug, <c>[a-z0-9-]{1,32}</c>; also the usage-stats source.</summary>
        [JsonPropertyName("id")] public string Id { get; set; } = "";

        /// <summary>Display name for the approval prompt, 1-64 characters.</summary>
        [JsonPropertyName("name")] public string Name { get; set; } = "";

        /// <summary>The plugin's own version, <c>[0-9A-Za-z.+-]{1,32}</c>.</summary>
        [JsonPropertyName("version")] public string? Version { get; set; }

        /// <summary>The software this plugin runs inside, e.g. <c>loupedeck</c> or <c>macro-deck</c>.</summary>
        [JsonPropertyName("host_app")] public string? HostApp { get; set; }

        /// <summary>Version of the host app.</summary>
        [JsonPropertyName("host_version")] public string? HostVersion { get; set; }

        /// <summary><c>mac</c>, <c>windows</c> or <c>linux</c>.</summary>
        [JsonPropertyName("os")] public string? Os { get; set; }

        /// <summary>
        /// Turns a free-form version into one the spec accepts (<c>[0-9A-Za-z.+-]</c>, at most
        /// 32 characters), or null when nothing usable is left: <c>"6.8.1 (21045)"</c> becomes
        /// <c>"6.8.1"</c>, <c>"7.0 beta 2"</c> becomes <c>"7.0-beta-2"</c>, <c>"7.0+abc123"</c> stays.
        /// The client applies this to <see cref="Version"/> and <see cref="HostVersion"/> itself.
        /// </summary>
        public static string? SanitizeVersion(string? version) => Validation.SanitizeVersion(version);

        internal ClientInfo Copy() => new ClientInfo { Id = Id, Name = Name, Version = Version, HostApp = HostApp, HostVersion = HostVersion, Os = Os };
    }

    /// <summary>First message on <c>/v2</c> (spec: <c>WsHello</c>).</summary>
    public sealed class WsHello
    {
        [JsonPropertyName("action")] public string Action { get; set; } = "hello";
        [JsonPropertyName("protocol")] public int Protocol { get; set; } = 2;
        [JsonPropertyName("client")] public ClientInfo Client { get; set; } = new ClientInfo();
        [JsonPropertyName("instance_id")] public string InstanceId { get; set; } = "";
        /// <summary><c>controller</c> or <c>status-source</c>.</summary>
        [JsonPropertyName("role")] public string Role { get; set; } = "controller";
        [JsonPropertyName("token")] public string? Token { get; set; }
        [JsonPropertyName("id")] public JsonElement? Id { get; set; }
    }

    /// <summary>Server answer to <c>hello</c> (spec: <c>WsWelcome</c>).</summary>
    public sealed class WsWelcome
    {
        [JsonPropertyName("action")] public string Action { get; set; } = "welcome";
        [JsonPropertyName("protocol")] public int Protocol { get; set; }
        /// <summary><c>ok</c> or <c>pending</c>.</summary>
        [JsonPropertyName("status")] public string Status { get; set; } = "";
        [JsonPropertyName("server_version")] public string? ServerVersion { get; set; }
        [JsonPropertyName("licensed")] public bool? Licensed { get; set; }
        [JsonPropertyName("id")] public JsonElement? Id { get; set; }
    }

    /// <summary>Spec: <c>WsApproved</c>.</summary>
    public sealed class WsApproved
    {
        [JsonPropertyName("action")] public string Action { get; set; } = "approved";
        [JsonPropertyName("token")] public string Token { get; set; } = "";
    }

    /// <summary>Spec: <c>WsDenied</c>.</summary>
    public sealed class WsDenied
    {
        [JsonPropertyName("action")] public string Action { get; set; } = "denied";
        /// <summary><c>user</c>, <c>expired</c> or <c>busy</c>.</summary>
        [JsonPropertyName("reason")] public string Reason { get; set; } = "user";
        /// <summary>Seconds before a new hello prompts the user again.</summary>
        [JsonPropertyName("retry_after")] public int? RetryAfter { get; set; }
    }

    /// <summary>Direct answer to an action (spec: <c>WsResponse</c>, also <c>WsError</c>).</summary>
    public sealed class WsResponse
    {
        [JsonPropertyName("action")] public string? Action { get; set; }
        [JsonPropertyName("status")] public int Status { get; set; }
        /// <summary>Machine-readable reason, e.g. <c>not_in_call</c>, <c>not_licensed</c>, <c>unknown_action</c>.</summary>
        [JsonPropertyName("reason")] public string? Reason { get; set; }
        [JsonPropertyName("message")] public string? Message { get; set; }
        [JsonPropertyName("retry_after")] public int? RetryAfter { get; set; }
        [JsonPropertyName("id")] public JsonElement? Id { get; set; }

        /// <summary>The whole message, for fields not modelled here.</summary>
        [JsonIgnore] public JsonElement Raw { get; internal set; }

        /// <summary>True for 2xx.</summary>
        [JsonIgnore] public bool IsSuccess => Status >= 200 && Status < 300;
    }

    /// <summary>Meeting status push (spec: <c>WsStatusUpdate</c> / <c>MeetingStatus</c>).</summary>
    public sealed class WsStatusUpdate
    {
        [JsonPropertyName("action")] public string Action { get; set; } = "update-status";
        /// <summary><c>active</c>, <c>inactive</c> or <c>disabled</c>.</summary>
        [JsonPropertyName("call")] public string? Call { get; set; }
        /// <summary>Controlled app, e.g. <c>zoom</c>, <c>teams</c>, <c>system</c>.</summary>
        [JsonPropertyName("control")] public string? Control { get; set; }
        [JsonPropertyName("mute")] public string? Mute { get; set; }
        [JsonPropertyName("video")] public string? Video { get; set; }
        [JsonPropertyName("share")] public string? Share { get; set; }
        [JsonPropertyName("record")] public string? Record { get; set; }
        /// <summary>Any other fields.</summary>
        [JsonExtensionData] public Dictionary<string, JsonElement>? Extra { get; set; }
    }

    /// <summary>Spec: <c>CustomAction</c>.</summary>
    public sealed class CustomAction
    {
        /// <summary>Pass this to <see cref="MuteDeckClient.CustomActionAsync"/>.</summary>
        [JsonPropertyName("name")] public string? Name { get; set; }
        /// <summary>Meeting app the action belongs to (user-defined actions).</summary>
        [JsonPropertyName("application")] public string? Application { get; set; }
        /// <summary>Keyboard shortcut (user-defined actions).</summary>
        [JsonPropertyName("shortcut")] public string? Shortcut { get; set; }
        /// <summary><c>builtin</c> or <c>custom</c>.</summary>
        [JsonPropertyName("type")] public string? Type { get; set; }
        /// <summary>Meeting apps a built-in action supports.</summary>
        [JsonPropertyName("app_types")] public List<string>? AppTypes { get; set; }
        [JsonExtensionData] public Dictionary<string, JsonElement>? Extra { get; set; }
    }

    /// <summary>Spec: <c>WsCustomActionList</c>.</summary>
    public sealed class WsCustomActionList
    {
        [JsonPropertyName("action")] public string Action { get; set; } = "list-custom-actions";
        [JsonPropertyName("status")] public int Status { get; set; }
        [JsonPropertyName("custom_actions")] public List<CustomAction> CustomActions { get; set; } = new List<CustomAction>();
        [JsonPropertyName("id")] public JsonElement? Id { get; set; }
    }

    /// <summary>Control forward for the <c>status-source</c> role (spec: <c>WsBrowserControl</c>).</summary>
    public sealed class WsBrowserControl
    {
        [JsonPropertyName("action")] public string Action { get; set; } = "";
        [JsonPropertyName("shortcut")] public string? Shortcut { get; set; }
        [JsonPropertyName("reaction")] public string? Reaction { get; set; }
        [JsonExtensionData] public Dictionary<string, JsonElement>? Extra { get; set; }
    }

    /// <summary>Report sent by a <c>status-source</c> (spec: <c>WsBrowserStatusReport</c> without <c>action</c>).</summary>
    public sealed class StatusReport
    {
        [JsonPropertyName("control")] public string? Control { get; set; }
        /// <summary><c>call</c> or <c>no-call</c>.</summary>
        [JsonPropertyName("status")] public string Status { get; set; } = "no-call";
        /// <summary><c>muted</c>, <c>unmuted</c> or <c>disabled</c>.</summary>
        [JsonPropertyName("mute")] public string? Mute { get; set; }
        /// <summary><c>started</c>, <c>stopped</c> or <c>disabled</c>.</summary>
        [JsonPropertyName("video")] public string? Video { get; set; }
        [JsonPropertyName("share")] public string? Share { get; set; }
        [JsonPropertyName("record")] public string? Record { get; set; }
        [JsonPropertyName("custom_svg_path")] public string? CustomSvgPath { get; set; }
    }

    /// <summary>Optional <c>state</c> of toggle actions.</summary>
    public enum ToggleState
    {
        Toggle,
        On,
        Off,
        Active,
        Inactive,
    }

    /// <summary>Reactions; <c>Applause</c> sends <c>react-applause</c>.</summary>
    public enum Reaction
    {
        Applause,
        Laugh,
        Like,
        Love,
        Wow,
        Tada,
        Sad,
        Thinking,
        Dislike,
    }

    internal static class Json
    {
        public static readonly JsonSerializerOptions Options = new JsonSerializerOptions
        {
            DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
        };
    }
}
