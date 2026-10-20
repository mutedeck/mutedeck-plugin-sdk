using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.IO;
using System.Net.WebSockets;
using System.Text;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;

namespace MuteDeck.PluginClient
{
    /// <summary>Options for <see cref="MuteDeckClient"/>.</summary>
    public sealed class MuteDeckClientOptions
    {
        /// <summary>Who this plugin is. Validated against the spec limits.</summary>
        public ClientInfo Client { get; set; } = new ClientInfo();

        /// <summary><c>controller</c> (default) or <c>status-source</c>.</summary>
        public string Role { get; set; } = "controller";

        public string Host { get; set; } = "localhost";
        public int Port { get; set; } = 3492;
        public int SecurePort { get; set; } = 3493;

        /// <summary>Use <c>wss://Host:SecurePort</c>.</summary>
        public bool Secure { get; set; }

        /// <summary>Token and instance id storage. Default: in memory.</summary>
        public ITokenStore? TokenStore { get; set; }

        /// <summary><c>source</c> used with an old (v1) MuteDeck: <c>plugin</c> (default) or <c>streamdeck-plugin</c>.</summary>
        public string V1Source { get; set; } = "plugin";

        /// <summary>Optional log sink. Tokens are never logged.</summary>
        public Action<MuteDeckLogLevel, string>? Log { get; set; }

        /// <summary>Creates the socket; override to set proxy or certificate options.</summary>
        public Func<ClientWebSocket> WebSocketFactory { get; set; } = () => new ClientWebSocket();

        public TimeSpan ConnectTimeout { get; set; } = TimeSpan.FromSeconds(5);

        /// <summary>Wait for <c>welcome</c> before falling back to v1. Default 3 s.</summary>
        public TimeSpan WelcomeTimeout { get; set; } = TimeSpan.FromSeconds(3);

        /// <summary>Wait for a response to <see cref="MuteDeckClient.SendAsync"/>. Default 5 s.</summary>
        public TimeSpan RequestTimeout { get; set; } = TimeSpan.FromSeconds(5);

        public TimeSpan ReconnectInitialDelay { get; set; } = TimeSpan.FromSeconds(1);
        public TimeSpan ReconnectMaxDelay { get; set; } = TimeSpan.FromSeconds(30);

        /// <summary>Minimum wait after <c>denied</c>. Default 30 s.</summary>
        public TimeSpan DeniedRetryMinimum { get; set; } = TimeSpan.FromSeconds(30);

        /// <summary>Consecutive rejections of a stored token before backing off. Default 3.</summary>
        public int MaxTokenRejections { get; set; } = 3;

        /// <summary>Back-off once <see cref="MaxTokenRejections"/> is reached. Default 60 s.</summary>
        public TimeSpan TokenRejectionBackoff { get; set; } = TimeSpan.FromSeconds(60);

        /// <summary>Send <c>keep-alive</c> this often while connected or pending approval; null (default) disables it.</summary>
        public TimeSpan? KeepAliveInterval { get; set; }

        /// <summary>Random source for jitter (0..1). Default <see cref="Random"/>.</summary>
        public Func<double>? Random { get; set; }
    }

    /// <summary>
    /// WebSocket client for the MuteDeck plugin protocol v2 with automatic fallback
    /// to v1. Events are raised on a background thread.
    /// </summary>
    /// <example>
    /// <code>
    /// var client = new MuteDeckClient(new MuteDeckClientOptions {
    ///     Client = new ClientInfo { Id = "loupedeck", Name = "Loupedeck", Version = "2.0.0" },
    ///     TokenStore = new FileTokenStore(Path.Combine(dataDir, "mutedeck.json")),
    /// });
    /// client.StatusReceived += (_, s) => Render(s);
    /// client.Start();
    /// await client.ToggleMuteAsync();
    /// </code>
    /// </example>
    public sealed class MuteDeckClient : IDisposable
    {
        private static readonly HashSet<string> ServerMessages = new HashSet<string>
        {
            "welcome", "approved", "denied", "revoked", "error", "update-status", "list-custom-actions",
        };

        private readonly MuteDeckClientOptions _options;
        private readonly ClientInfo _client;
        private readonly Credentials _credentials;
        private readonly Backoff _backoff;
        private readonly SemaphoreSlim _sendLock = new SemaphoreSlim(1, 1);
        private readonly ConcurrentDictionary<string, TaskCompletionSource<JsonElement>> _pending =
            new ConcurrentDictionary<string, TaskCompletionSource<JsonElement>>();
        private readonly object _v1ListLock = new object();
        private readonly List<TaskCompletionSource<JsonElement>> _v1ListWaiters = new List<TaskCompletionSource<JsonElement>>();

        private CancellationTokenSource? _stop;
        private Task? _loop;
        private ClientWebSocket? _socket;
        private volatile ConnectionState _state = ConnectionState.Disconnected;
        private volatile bool _serverIsV1;
        private bool _helloHadToken;
        private int _tokenRejections;
        private int _nextId;

        /// <summary>Create a client. Call <see cref="Start"/> to connect.</summary>
        public MuteDeckClient(MuteDeckClientOptions options)
        {
            _options = options ?? throw new ArgumentNullException(nameof(options));
            _client = Validation.ValidateClient(options.Client);
            if (options.Role != "controller" && options.Role != "status-source")
                throw new ArgumentException("Role must be controller or status-source", nameof(options));
            _credentials = new Credentials(options.TokenStore ?? new InMemoryTokenStore());
            var random = new Random();
            _backoff = new Backoff(options.ReconnectInitialDelay, options.ReconnectMaxDelay, options.Random ?? (() => random.NextDouble()));
        }

        /// <summary>Raised when <see cref="State"/> changes.</summary>
        public event EventHandler<ConnectionStateChangedEventArgs>? StateChanged;

        /// <summary>A full status push (controllers only).</summary>
        public event EventHandler<WsStatusUpdate>? StatusReceived;

        /// <summary>The custom actions list (pushed after welcome, or a <see cref="ListCustomActionsAsync"/> answer).</summary>
        public event EventHandler<IReadOnlyList<CustomAction>>? CustomActionsReceived;

        /// <summary>A control forward for the <c>status-source</c> role.</summary>
        public event EventHandler<WsBrowserControl>? BrowserControlReceived;

        /// <summary>The raw <c>welcome</c>.</summary>
        public event EventHandler<WsWelcome>? WelcomeReceived;

        /// <summary>The user approved this client; the token is stored.</summary>
        public event EventHandler? Approved;

        /// <summary>The user denied this client, or the prompt expired.</summary>
        public event EventHandler<DeniedEventArgs>? Denied;

        /// <summary>The token was revoked in MuteDeck and discarded.</summary>
        public event EventHandler? Revoked;

        /// <summary>A server <c>error</c> message without a request id, or a storage failure.</summary>
        public event EventHandler<Exception>? Error;

        public ConnectionState State => _state;

        /// <summary>True when actions can be sent (<see cref="ConnectionState.Authenticated"/> or <see cref="ConnectionState.V1"/>).</summary>
        public bool IsReady => _state == ConnectionState.Authenticated || _state == ConnectionState.V1;

        /// <summary>True while the connected MuteDeck only speaks v1.</summary>
        public bool IsLegacyServer => _serverIsV1;

        public string? ServerVersion { get; private set; }
        public bool? Licensed { get; private set; }
        public WsStatusUpdate? LastStatus { get; private set; }
        public IReadOnlyList<CustomAction>? CustomActions { get; private set; }

        /// <summary>Start connecting and keep reconnecting until <see cref="StopAsync"/>. Idempotent.</summary>
        public void Start()
        {
            if (_loop != null) return;
            _stop = new CancellationTokenSource();
            _backoff.Reset();
            var token = _stop.Token;
            _loop = Task.Run(() => RunAsync(token));
        }

        /// <summary>Close the connection and stop reconnecting.</summary>
        public async Task StopAsync()
        {
            var loop = _loop;
            if (loop == null) return;
            _stop?.Cancel();
            _socket?.Abort();
            try { await loop.ConfigureAwait(false); } catch (OperationCanceledException) { }
            _loop = null;
            _stop?.Dispose();
            _stop = null;
            SetState(ConnectionState.Disconnected);
        }

        /// <summary>Wait until actions can be sent.</summary>
        public async Task WaitUntilReadyAsync(TimeSpan timeout, CancellationToken cancellationToken = default)
        {
            if (IsReady) return;
            var tcs = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
            void Handler(object? s, ConnectionStateChangedEventArgs e)
            {
                if (IsReady) tcs.TrySetResult(true);
            }
            StateChanged += Handler;
            try
            {
                if (IsReady) return;
                using (cancellationToken.Register(() => tcs.TrySetCanceled()))
                {
                    var done = await Task.WhenAny(tcs.Task, Task.Delay(timeout, cancellationToken)).ConfigureAwait(false);
                    if (done != tcs.Task) throw new TimeoutException("MuteDeck connection not ready in time");
                    await tcs.Task.ConfigureAwait(false);
                }
            }
            finally
            {
                StateChanged -= Handler;
            }
        }

        /// <summary>Forget the token and instance id; the next connection enrolls as a new install.</summary>
        public async Task ResetPairingAsync()
        {
            await _credentials.ResetAsync().ConfigureAwait(false);
            _socket?.Abort();
        }

        // ------------------------------------------------------------- requests

        /// <summary>
        /// Send an action and wait for the response with the same id. In v1 mode
        /// the old server sends no correlated responses, so this returns
        /// <c>Status = 202</c> ("sent, not confirmed") right away. API-level failures
        /// (<c>not_in_call</c> and so on) are returned, not thrown.
        /// </summary>
        /// <exception cref="MuteDeckNotConnectedException">Not ready.</exception>
        /// <exception cref="TimeoutException">No response within <see cref="MuteDeckClientOptions.RequestTimeout"/>.</exception>
        /// <exception cref="WebSocketException">The connection closed first.</exception>
        public async Task<WsResponse> SendAsync(string action, IDictionary<string, object?>? fields = null, CancellationToken cancellationToken = default)
        {
            var element = await SendForElementAsync(action, fields, cancellationToken).ConfigureAwait(false);
            return ToResponse(element);
        }

        /// <summary>Send an action without waiting for a response.</summary>
        public Task NotifyAsync(string action, IDictionary<string, object?>? fields = null, CancellationToken cancellationToken = default)
        {
            var state = _state;
            if (state != ConnectionState.Authenticated && state != ConnectionState.V1)
                throw new MuteDeckNotConnectedException($"Cannot send \"{action}\" while {state}");
            var message = BuildMessage(action, fields, state == ConnectionState.V1);
            return SendRawAsync(message, cancellationToken);
        }

        public Task<WsResponse> ToggleMuteAsync(ToggleState? state = null, CancellationToken ct = default) => SendAsync("toggle_mute", StateField(state), ct);
        public Task<WsResponse> ToggleVideoAsync(ToggleState? state = null, CancellationToken ct = default) => SendAsync("toggle_video", StateField(state), ct);
        public Task<WsResponse> ToggleShareAsync(ToggleState? state = null, CancellationToken ct = default) => SendAsync("toggle_share", StateField(state), ct);
        public Task<WsResponse> ToggleRecordAsync(ToggleState? state = null, CancellationToken ct = default) => SendAsync("toggle_record", StateField(state), ct);
        public Task<WsResponse> LeaveMeetingAsync(CancellationToken ct = default) => SendAsync("leave_meeting", null, ct);
        public Task<WsResponse> BringToFrontAsync(CancellationToken ct = default) => SendAsync("bring-to-front", null, ct);
        public Task<WsResponse> RaiseHandAsync(CancellationToken ct = default) => SendAsync("raise-hand", null, ct);
        public Task<WsResponse> BackgroundBlurAsync(CancellationToken ct = default) => SendAsync("background-blur", null, ct);
        public Task<WsResponse> ToggleChatWindowAsync(CancellationToken ct = default) => SendAsync("toggle-chat-window", null, ct);
        public Task<WsResponse> ToggleParticipantsAsync(CancellationToken ct = default) => SendAsync("toggle-participants", null, ct);
        public Task<WsResponse> ReactAsync(Reaction reaction, CancellationToken ct = default) => SendAsync("react-" + reaction.ToString().ToLowerInvariant(), null, ct);
        public Task<WsResponse> CustomActionAsync(string name, CancellationToken ct = default) =>
            SendAsync("custom-action", new Dictionary<string, object?> { ["name"] = name }, ct);
        public Task<WsResponse> KeepAliveAsync(CancellationToken ct = default) => SendAsync("keep-alive", null, ct);

        /// <summary>
        /// <c>status-source</c> only: report the meeting site's status. Never answered by the server.
        /// Does nothing while not ready.
        /// </summary>
        public Task ReportStatusAsync(StatusReport report, CancellationToken ct = default)
        {
            if (!IsReady)
            {
                Log(MuteDeckLogLevel.Debug, $"not reporting status while {_state}");
                return Task.CompletedTask;
            }
            var fields = JsonSerializer.Deserialize<Dictionary<string, object?>>(JsonSerializer.Serialize(report, Json.Options))!;
            return NotifyAsync("update-status", fields, ct);
        }

        /// <summary>Fetch the configured custom actions.</summary>
        /// <exception cref="MuteDeckRequestFailedException">MuteDeck refused (e.g. <c>not_licensed</c>).</exception>
        public async Task<IReadOnlyList<CustomAction>> ListCustomActionsAsync(CancellationToken cancellationToken = default)
        {
            JsonElement element;
            if (_state == ConnectionState.V1)
            {
                var waiter = new TaskCompletionSource<JsonElement>(TaskCreationOptions.RunContinuationsAsynchronously);
                lock (_v1ListLock) _v1ListWaiters.Add(waiter);
                await NotifyAsync("list-custom-actions", null, cancellationToken).ConfigureAwait(false);
                element = await WithTimeout(waiter.Task, () => { lock (_v1ListLock) _v1ListWaiters.Remove(waiter); }, "list-custom-actions", cancellationToken).ConfigureAwait(false);
            }
            else
            {
                element = await SendForElementAsync("list-custom-actions", null, cancellationToken).ConfigureAwait(false);
            }
            var list = element.Deserialize<WsCustomActionList>(Json.Options);
            if (list == null || list.Status != 200 || !element.TryGetProperty("custom_actions", out _))
                throw new MuteDeckRequestFailedException(ToResponse(element));
            return list.CustomActions;
        }

        private async Task<JsonElement> SendForElementAsync(string action, IDictionary<string, object?>? fields, CancellationToken cancellationToken)
        {
            var state = _state;
            if (state == ConnectionState.V1)
            {
                await SendRawAsync(BuildMessage(action, fields, v1: true), cancellationToken).ConfigureAwait(false);
                using var doc = JsonDocument.Parse("{\"status\":202}");
                return doc.RootElement.Clone();
            }
            var allowed = state == ConnectionState.Authenticated || (state == ConnectionState.Pending && action == "keep-alive");
            if (!allowed)
                throw new MuteDeckNotConnectedException($"Cannot send \"{action}\" while {state}");

            var id = Interlocked.Increment(ref _nextId);
            var key = id.ToString(System.Globalization.CultureInfo.InvariantCulture);
            var tcs = new TaskCompletionSource<JsonElement>(TaskCreationOptions.RunContinuationsAsynchronously);
            _pending[key] = tcs;
            var message = BuildMessage(action, fields, v1: false);
            message["id"] = id;
            try
            {
                await SendRawAsync(message, cancellationToken).ConfigureAwait(false);
            }
            catch
            {
                _pending.TryRemove(key, out _);
                throw;
            }
            return await WithTimeout(tcs.Task, () => _pending.TryRemove(key, out _), action, cancellationToken).ConfigureAwait(false);
        }

        private async Task<JsonElement> WithTimeout(Task<JsonElement> task, Action onTimeout, string action, CancellationToken cancellationToken)
        {
            using (var delayCts = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken))
            {
                var done = await Task.WhenAny(task, Task.Delay(_options.RequestTimeout, delayCts.Token)).ConfigureAwait(false);
                if (done != task)
                {
                    onTimeout();
                    cancellationToken.ThrowIfCancellationRequested();
                    throw new TimeoutException($"No response to \"{action}\" within {_options.RequestTimeout.TotalMilliseconds} ms");
                }
                delayCts.Cancel();
                return await task.ConfigureAwait(false);
            }
        }

        private Dictionary<string, object?> BuildMessage(string action, IDictionary<string, object?>? fields, bool v1)
        {
            var message = new Dictionary<string, object?>();
            if (fields != null)
            {
                foreach (var pair in fields)
                {
                    if (pair.Value != null) message[pair.Key] = pair.Value;
                }
            }
            message["action"] = action;
            if (v1) message["source"] = _options.V1Source;
            return message;
        }

        private static IDictionary<string, object?>? StateField(ToggleState? state) =>
            state == null ? null : new Dictionary<string, object?> { ["state"] = state.Value.ToString().ToLowerInvariant() };

        // ------------------------------------------------------------- connection loop

        private enum Mode { V1, V2 }

        /// <summary>What the receive loop asks for when it ends.</summary>
        private sealed class SessionEnd
        {
            public TimeSpan? Delay;
            public bool FellBackToV1;
        }

        private async Task RunAsync(CancellationToken stop)
        {
            while (!stop.IsCancellationRequested)
            {
                var mode = _serverIsV1 ? Mode.V1 : Mode.V2;
                var end = new SessionEnd();
                SetState(ConnectionState.Connecting);
                using (var socket = _options.WebSocketFactory())
                {
                    _socket = socket;
                    try
                    {
                        await ConnectAsync(socket, mode, stop).ConfigureAwait(false);
                        await RunSessionAsync(socket, mode, end, stop).ConfigureAwait(false);
                    }
                    catch (OperationCanceledException) when (stop.IsCancellationRequested)
                    {
                        break;
                    }
                    catch (Exception ex) when (ex is WebSocketException || ex is IOException || ex is OperationCanceledException || ex is ObjectDisposedException)
                    {
                        Log(MuteDeckLogLevel.Debug, "socket closed: " + ex.Message);
                    }
                    finally
                    {
                        _socket = null;
                        FailPending();
                    }
                }

                if (mode == Mode.V1)
                {
                    // Check for v2 again next time (MuteDeck may have been updated).
                    _serverIsV1 = false;
                }
                if (end.FellBackToV1) _serverIsV1 = true;

                var delay = end.Delay ?? _backoff.Next();
                if (_state != ConnectionState.Denied && delay > TimeSpan.Zero) SetState(ConnectionState.Disconnected);
                try
                {
                    if (delay > TimeSpan.Zero) await Task.Delay(delay, stop).ConfigureAwait(false);
                }
                catch (OperationCanceledException)
                {
                    break;
                }
            }
        }

        private async Task ConnectAsync(ClientWebSocket socket, Mode mode, CancellationToken stop)
        {
            var scheme = _options.Secure ? "wss" : "ws";
            var port = _options.Secure ? _options.SecurePort : _options.Port;
            var uri = new Uri($"{scheme}://{_options.Host}:{port}{(mode == Mode.V2 ? "/v2" : "/")}");
            Log(MuteDeckLogLevel.Debug, "connecting to " + uri);
            using (var timeout = CancellationTokenSource.CreateLinkedTokenSource(stop))
            {
                timeout.CancelAfter(_options.ConnectTimeout);
                await socket.ConnectAsync(uri, timeout.Token).ConfigureAwait(false);
            }
        }

        private async Task RunSessionAsync(ClientWebSocket socket, Mode mode, SessionEnd end, CancellationToken stop)
        {
            CancellationTokenSource? keepAlive = null;
            CancellationTokenSource? welcomeTimer = null;
            var welcomeReceived = false;
            try
            {
                if (mode == Mode.V1)
                {
                    await SendRawAsync(new Dictionary<string, object?>
                    {
                        ["source"] = _options.V1Source,
                        ["action"] = "identify",
                        ["identifier"] = _client.Name,
                    }, stop).ConfigureAwait(false);
                    _backoff.Reset();
                    SetState(ConnectionState.V1);
                    keepAlive = StartKeepAlive(stop);
                }
                else
                {
                    var credentials = await _credentials.GetAsync().ConfigureAwait(false);
                    var hello = new WsHello
                    {
                        Client = _client,
                        InstanceId = credentials.InstanceId!,
                        Role = _options.Role,
                        Token = credentials.Token,
                    };
                    _helloHadToken = credentials.Token != null;
                    await SendRawAsync(hello, stop).ConfigureAwait(false);
                    welcomeTimer = new CancellationTokenSource();
                    welcomeTimer.Token.Register(() =>
                    {
                        if (welcomeReceived) return;
                        Log(MuteDeckLogLevel.Info, "no welcome within the timeout; falling back to protocol v1");
                        end.FellBackToV1 = true;
                        end.Delay = TimeSpan.Zero;
                        socket.Abort();
                    });
                    welcomeTimer.CancelAfter(_options.WelcomeTimeout);
                }

                while (!stop.IsCancellationRequested)
                {
                    var text = await ReceiveTextAsync(socket, stop).ConfigureAwait(false);
                    if (text == null) return;
                    JsonElement message;
                    try
                    {
                        using var doc = JsonDocument.Parse(text);
                        if (doc.RootElement.ValueKind != JsonValueKind.Object) continue;
                        message = doc.RootElement.Clone();
                    }
                    catch (JsonException)
                    {
                        Log(MuteDeckLogLevel.Warning, "ignoring a message that is not JSON");
                        continue;
                    }

                    var action = GetString(message, "action");
                    if (action == "welcome")
                    {
                        welcomeReceived = true;
                        welcomeTimer?.Dispose();
                        welcomeTimer = null;
                    }
                    var stopAfter = await HandleMessageAsync(message, action, end).ConfigureAwait(false);
                    if ((_state == ConnectionState.Authenticated || _state == ConnectionState.Pending) && keepAlive == null) keepAlive = StartKeepAlive(stop);
                    if (stopAfter)
                    {
                        socket.Abort();
                        return;
                    }
                }
            }
            finally
            {
                welcomeTimer?.Dispose();
                keepAlive?.Cancel();
                keepAlive?.Dispose();
            }
        }

        /// <summary>Returns true when the session must end (denied, revoked, breaker).</summary>
        private async Task<bool> HandleMessageAsync(JsonElement message, string? action, SessionEnd end)
        {
            if (action != "update-status") Log(MuteDeckLogLevel.Debug, "received " + (action ?? "response")); // status pushes are frequent

            if (message.TryGetProperty("id", out var idElement) && idElement.ValueKind != JsonValueKind.Null)
            {
                var key = idElement.ValueKind == JsonValueKind.String ? idElement.GetString()! : idElement.GetRawText();
                if (_pending.TryRemove(key, out var request))
                {
                    if (action == "list-custom-actions") OnCustomActions(message, resolveV1Waiters: false);
                    request.TrySetResult(message);
                    return false;
                }
            }

            switch (action)
            {
                case "welcome":
                    return await OnWelcomeAsync(message.Deserialize<WsWelcome>(Json.Options)!, end).ConfigureAwait(false);
                case "approved":
                    await OnApprovedAsync(GetString(message, "token")).ConfigureAwait(false);
                    return false;
                case "denied":
                {
                    var denied = message.Deserialize<WsDenied>(Json.Options)!;
                    var wait = TimeSpan.FromSeconds(denied.RetryAfter ?? 0);
                    if (wait < _options.DeniedRetryMinimum) wait = _options.DeniedRetryMinimum;
                    Log(MuteDeckLogLevel.Warning, $"access denied ({denied.Reason}); asking again in {wait.TotalSeconds:0} s");
                    SetState(ConnectionState.Denied);
                    Raise(() => Denied?.Invoke(this, new DeniedEventArgs(denied.Reason, denied.RetryAfter)));
                    end.Delay = wait;
                    return true;
                }
                case "revoked":
                    Log(MuteDeckLogLevel.Warning, "access was revoked; discarding the token");
                    _helloHadToken = false;
                    await ClearTokenSafelyAsync().ConfigureAwait(false);
                    Raise(() => Revoked?.Invoke(this, EventArgs.Empty));
                    return true;
                case "error":
                {
                    var error = ToResponse(message);
                    Log(MuteDeckLogLevel.Warning, $"server error: {error.Status} {error.Reason} {error.Message}");
                    Raise(() => Error?.Invoke(this, new MuteDeckRequestFailedException(error)));
                    return false;
                }
                case "update-status":
                    LastStatus = message.Deserialize<WsStatusUpdate>(Json.Options);
                    Raise(() => StatusReceived?.Invoke(this, LastStatus!));
                    return false;
                case "list-custom-actions":
                    OnCustomActions(message, resolveV1Waiters: true);
                    return false;
                case null:
                    return false; // v1 acknowledgement
                default:
                    if (_options.Role == "status-source" && !ServerMessages.Contains(action))
                    {
                        var control = message.Deserialize<WsBrowserControl>(Json.Options)!;
                        Raise(() => BrowserControlReceived?.Invoke(this, control));
                    }
                    return false;
            }
        }

        private async Task<bool> OnWelcomeAsync(WsWelcome welcome, SessionEnd end)
        {
            if (welcome.ServerVersion != null) ServerVersion = welcome.ServerVersion;
            if (welcome.Licensed != null) Licensed = welcome.Licensed;
            _backoff.Reset();
            Raise(() => WelcomeReceived?.Invoke(this, welcome));

            if (welcome.Status == "ok")
            {
                if (_helloHadToken) _tokenRejections = 0;
                SetState(ConnectionState.Authenticated);
                return false;
            }

            if (_helloHadToken)
            {
                _helloHadToken = false;
                _tokenRejections++;
                Log(MuteDeckLogLevel.Warning, $"stored token was rejected ({_tokenRejections}/{_options.MaxTokenRejections}); discarding it");
                await ClearTokenSafelyAsync().ConfigureAwait(false);
                if (_tokenRejections >= _options.MaxTokenRejections)
                {
                    _tokenRejections = 0;
                    Log(MuteDeckLogLevel.Error, $"tokens keep being rejected; waiting {_options.TokenRejectionBackoff.TotalSeconds:0} s before enrolling again");
                    end.Delay = _options.TokenRejectionBackoff;
                    return true;
                }
            }
            SetState(ConnectionState.Pending);
            return false;
        }

        private async Task OnApprovedAsync(string? token)
        {
            if (!Validation.IsToken(token))
            {
                Log(MuteDeckLogLevel.Error, "received 'approved' without a valid token");
                return;
            }
            Log(MuteDeckLogLevel.Info, "approved by the user; storing token");
            try
            {
                await _credentials.SetTokenAsync(token!).ConfigureAwait(false);
            }
            catch (Exception ex)
            {
                Log(MuteDeckLogLevel.Error, "could not store token: " + ex.Message);
                Raise(() => Error?.Invoke(this, ex));
            }
            Raise(() => Approved?.Invoke(this, EventArgs.Empty));
        }

        private void OnCustomActions(JsonElement message, bool resolveV1Waiters)
        {
            var list = message.Deserialize<WsCustomActionList>(Json.Options);
            if (list == null || !message.TryGetProperty("custom_actions", out _)) return;
            CustomActions = list.CustomActions;
            Raise(() => CustomActionsReceived?.Invoke(this, list.CustomActions));
            if (!resolveV1Waiters) return;
            List<TaskCompletionSource<JsonElement>> waiters;
            lock (_v1ListLock)
            {
                waiters = new List<TaskCompletionSource<JsonElement>>(_v1ListWaiters);
                _v1ListWaiters.Clear();
            }
            foreach (var waiter in waiters) waiter.TrySetResult(message);
        }

        private CancellationTokenSource? StartKeepAlive(CancellationToken stop)
        {
            var interval = _options.KeepAliveInterval;
            if (interval == null || interval <= TimeSpan.Zero) return null;
            var cts = CancellationTokenSource.CreateLinkedTokenSource(stop);
            var token = cts.Token;
            _ = Task.Run(async () =>
            {
                while (!token.IsCancellationRequested)
                {
                    try
                    {
                        await Task.Delay(interval.Value, token).ConfigureAwait(false);
                        if (_state == ConnectionState.V1) await NotifyAsync("keep-alive", null, token).ConfigureAwait(false);
                        else if (_state == ConnectionState.Authenticated || _state == ConnectionState.Pending) await KeepAliveAsync(token).ConfigureAwait(false);
                    }
                    catch (OperationCanceledException)
                    {
                        return;
                    }
                    catch (Exception)
                    {
                        // the receive loop handles disconnects
                    }
                }
            });
            return cts;
        }

        // ------------------------------------------------------------- helpers

        private async Task SendRawAsync(object message, CancellationToken cancellationToken)
        {
            var socket = _socket;
            if (socket == null || socket.State != WebSocketState.Open) throw new MuteDeckNotConnectedException("WebSocket is not open");
            var json = JsonSerializer.Serialize(message, Json.Options);
            Log(MuteDeckLogLevel.Debug, "sending " + Redact(message));
            var bytes = Encoding.UTF8.GetBytes(json);
            await _sendLock.WaitAsync(cancellationToken).ConfigureAwait(false);
            try
            {
                await socket.SendAsync(new ArraySegment<byte>(bytes), WebSocketMessageType.Text, true, cancellationToken).ConfigureAwait(false);
            }
            finally
            {
                _sendLock.Release();
            }
        }

        private static async Task<string?> ReceiveTextAsync(ClientWebSocket socket, CancellationToken cancellationToken)
        {
            var buffer = new byte[8192];
            using (var stream = new MemoryStream())
            {
                while (true)
                {
                    var result = await socket.ReceiveAsync(new ArraySegment<byte>(buffer), cancellationToken).ConfigureAwait(false);
                    if (result.MessageType == WebSocketMessageType.Close) return null;
                    stream.Write(buffer, 0, result.Count);
                    if (stream.Length > 1024 * 1024) throw new WebSocketException("Message too large");
                    if (result.EndOfMessage)
                    {
                        if (result.MessageType != WebSocketMessageType.Text) return string.Empty;
                        return Encoding.UTF8.GetString(stream.ToArray());
                    }
                }
            }
        }

        private void FailPending()
        {
            foreach (var key in _pending.Keys)
            {
                if (_pending.TryRemove(key, out var request))
                    request.TrySetException(new WebSocketException("Connection to MuteDeck closed"));
            }
            lock (_v1ListLock)
            {
                foreach (var waiter in _v1ListWaiters) waiter.TrySetException(new WebSocketException("Connection to MuteDeck closed"));
                _v1ListWaiters.Clear();
            }
        }

        private async Task ClearTokenSafelyAsync()
        {
            try
            {
                await _credentials.ClearTokenAsync().ConfigureAwait(false);
            }
            catch (Exception ex)
            {
                Log(MuteDeckLogLevel.Error, "could not clear token: " + ex.Message);
                Raise(() => Error?.Invoke(this, ex));
            }
        }

        private static WsResponse ToResponse(JsonElement element)
        {
            var response = element.Deserialize<WsResponse>(Json.Options) ?? new WsResponse();
            response.Raw = element;
            return response;
        }

        private static string? GetString(JsonElement element, string name) =>
            element.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.String ? value.GetString() : null;

        /// <summary>Message as JSON with any token masked, safe to log.</summary>
        internal static string Redact(object message)
        {
            if (message is WsHello hello && hello.Token != null)
            {
                return JsonSerializer.Serialize(new WsHello
                {
                    Client = hello.Client,
                    InstanceId = hello.InstanceId,
                    Role = hello.Role,
                    Token = "<redacted>",
                }, Json.Options);
            }
            if (message is IDictionary<string, object?> dict && dict.ContainsKey("token"))
            {
                var copy = new Dictionary<string, object?>(dict) { ["token"] = "<redacted>" };
                return JsonSerializer.Serialize(copy, Json.Options);
            }
            return JsonSerializer.Serialize(message, Json.Options);
        }

        private void SetState(ConnectionState next)
        {
            var previous = _state;
            if (previous == next) return;
            _state = next;
            Log(MuteDeckLogLevel.Debug, $"state {previous} -> {next}");
            Raise(() => StateChanged?.Invoke(this, new ConnectionStateChangedEventArgs(next, previous)));
        }

        private void Raise(Action raise)
        {
            try
            {
                raise();
            }
            catch (Exception ex)
            {
                Log(MuteDeckLogLevel.Error, "event handler threw: " + ex.Message);
            }
        }

        private void Log(MuteDeckLogLevel level, string message) => _options.Log?.Invoke(level, "MuteDeck: " + message);

        /// <summary>Stops the client without waiting.</summary>
        public void Dispose()
        {
            _stop?.Cancel();
            _socket?.Abort();
        }
    }
}
