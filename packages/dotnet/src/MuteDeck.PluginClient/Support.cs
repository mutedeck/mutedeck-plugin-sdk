using System;
using System.Collections.Generic;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;

namespace MuteDeck.PluginClient
{
    /// <summary>Connection state of <see cref="MuteDeckClient"/>.</summary>
    public enum ConnectionState
    {
        /// <summary>Not connected; a reconnect may be scheduled.</summary>
        Disconnected,
        /// <summary>Opening a socket or waiting for <c>welcome</c>.</summary>
        Connecting,
        /// <summary>Waiting for the user to approve this client in MuteDeck.</summary>
        Pending,
        /// <summary>v2 session ready for actions.</summary>
        Authenticated,
        /// <summary>The user denied this client; waiting before asking again.</summary>
        Denied,
        /// <summary>Connected to an old MuteDeck that only speaks v1.</summary>
        V1,
    }

    /// <summary>Log levels for <see cref="MuteDeckClientOptions.Log"/>.</summary>
    public enum MuteDeckLogLevel
    {
        Debug,
        Info,
        Warning,
        Error,
    }

    /// <summary>Arguments of <see cref="MuteDeckClient.StateChanged"/>.</summary>
    public sealed class ConnectionStateChangedEventArgs : EventArgs
    {
        internal ConnectionStateChangedEventArgs(ConnectionState state, ConnectionState previous)
        {
            State = state;
            Previous = previous;
        }

        public ConnectionState State { get; }
        public ConnectionState Previous { get; }
    }

    /// <summary>Arguments of <see cref="MuteDeckClient.Denied"/>.</summary>
    public sealed class DeniedEventArgs : EventArgs
    {
        internal DeniedEventArgs(string reason, int? retryAfter)
        {
            Reason = reason;
            RetryAfter = retryAfter;
        }

        /// <summary><c>user</c>, <c>expired</c> or <c>busy</c>.</summary>
        public string Reason { get; }

        /// <summary>Seconds the server asked to wait, if given.</summary>
        public int? RetryAfter { get; }
    }

    /// <summary>Thrown when an action is sent while no session is open.</summary>
    public sealed class MuteDeckNotConnectedException : InvalidOperationException
    {
        public MuteDeckNotConnectedException(string message) : base(message) { }
    }

    /// <summary>Thrown when MuteDeck refuses a request that must succeed (e.g. listing custom actions).</summary>
    public sealed class MuteDeckRequestFailedException : Exception
    {
        public MuteDeckRequestFailedException(WsResponse response)
            : base($"MuteDeck refused the request ({response.Status} {response.Reason})") => Response = response;

        public WsResponse Response { get; }
    }

    /// <summary>Exponential backoff with equal jitter.</summary>
    internal sealed class Backoff
    {
        private readonly TimeSpan _initial;
        private readonly TimeSpan _max;
        private readonly Func<double> _random;
        private int _attempt;

        public Backoff(TimeSpan initial, TimeSpan max, Func<double> random)
        {
            _initial = initial;
            _max = max;
            _random = random;
        }

        public TimeSpan Next()
        {
            var baseMs = Math.Min(_max.TotalMilliseconds, _initial.TotalMilliseconds * Math.Pow(2, _attempt));
            _attempt = Math.Min(_attempt + 1, 30);
            return TimeSpan.FromMilliseconds(Math.Round(baseMs / 2 + baseMs / 2 * _random()));
        }

        public void Reset() => _attempt = 0;
    }

    internal static class Validation
    {
        private static readonly Regex Slug = new Regex("^[a-z0-9-]{1,32}$");
        private static readonly Regex Version = new Regex("^[0-9A-Za-z.+-]{1,32}$");
        private static readonly Regex InstanceIdPattern = new Regex("^[A-Za-z0-9-]{8,64}$");
        private static readonly Regex TokenPattern = new Regex("^[0-9a-f]{64}$");

        /// <summary>Returns a sanitized copy; throws for fields that can't be fixed.</summary>
        public static ClientInfo ValidateClient(ClientInfo input)
        {
            if (input == null) throw new ArgumentNullException(nameof(input));
            var client = input.Copy();
            client.Version = SanitizeVersion(client.Version);
            client.HostVersion = SanitizeVersion(client.HostVersion);
            var problems = new List<string>();
            if (!Slug.IsMatch(client.Id ?? "")) problems.Add("Id must match [a-z0-9-]{1,32}");
            if (string.IsNullOrEmpty(client.Name) || client.Name.Length > 64) problems.Add("Name must be 1-64 characters");
            if (client.Version != null && !Version.IsMatch(client.Version)) problems.Add("Version must match [0-9A-Za-z.+-]{1,32}");
            if (client.HostApp != null && !Slug.IsMatch(client.HostApp)) problems.Add("HostApp must match [a-z0-9-]{1,32}");
            if (client.HostVersion != null && !Version.IsMatch(client.HostVersion)) problems.Add("HostVersion must match [0-9A-Za-z.+-]{1,32}");
            if (client.Os != null && client.Os != "mac" && client.Os != "windows" && client.Os != "linux") problems.Add("Os must be mac, windows or linux");
            if (problems.Count > 0) throw new ArgumentException("Invalid ClientInfo: " + string.Join("; ", problems), nameof(input));
            return client;
        }

        public static bool IsToken(string? token) => token != null && TokenPattern.IsMatch(token);

        public static bool IsInstanceId(string? id) => id != null && InstanceIdPattern.IsMatch(id);

        /// <summary>Turns a free-form version into one the spec accepts, or null.</summary>
        public static string? SanitizeVersion(string? version)
        {
            if (string.IsNullOrWhiteSpace(version)) return null;
            var cleaned = Regex.Replace(version!.Trim(), @"\s*\(.*$", "");
            cleaned = Regex.Replace(cleaned, @"\s+", "-");
            cleaned = Regex.Replace(cleaned, "[^0-9A-Za-z.+-]", "");
            if (cleaned.Length > 32) cleaned = cleaned.Substring(0, 32);
            return cleaned.Length == 0 ? null : cleaned;
        }
    }

    /// <summary>Token and instance id cached over an <see cref="ITokenStore"/>; writes are serialized.</summary>
    internal sealed class Credentials
    {
        private readonly ITokenStore _store;
        private readonly SemaphoreSlim _lock = new SemaphoreSlim(1, 1);
        private StoredCredentials? _current;

        public Credentials(ITokenStore store) => _store = store;

        public async Task<StoredCredentials> GetAsync()
        {
            await _lock.WaitAsync().ConfigureAwait(false);
            try
            {
                return (await EnsureLoadedAsync().ConfigureAwait(false)).Copy();
            }
            finally
            {
                _lock.Release();
            }
        }

        public Task SetTokenAsync(string token) => MutateAsync(c => { c.Token = token; return true; });

        public Task ClearTokenAsync() => MutateAsync(c =>
        {
            if (c.Token == null) return false;
            c.Token = null;
            return true;
        });

        public async Task ResetAsync()
        {
            await _lock.WaitAsync().ConfigureAwait(false);
            try
            {
                _current = null;
                await _store.ClearAsync().ConfigureAwait(false);
            }
            finally
            {
                _lock.Release();
            }
        }

        private async Task MutateAsync(Func<StoredCredentials, bool> change)
        {
            await _lock.WaitAsync().ConfigureAwait(false);
            try
            {
                var current = await EnsureLoadedAsync().ConfigureAwait(false);
                if (change(current)) await _store.SaveAsync(current.Copy()).ConfigureAwait(false);
            }
            finally
            {
                _lock.Release();
            }
        }

        private async Task<StoredCredentials> EnsureLoadedAsync()
        {
            if (_current != null) return _current;
            StoredCredentials loaded;
            try
            {
                loaded = await _store.LoadAsync().ConfigureAwait(false) ?? new StoredCredentials();
            }
            catch (Exception)
            {
                loaded = new StoredCredentials();
            }
            var current = new StoredCredentials
            {
                InstanceId = Validation.IsInstanceId(loaded.InstanceId) ? loaded.InstanceId : Guid.NewGuid().ToString(),
                Token = Validation.IsToken(loaded.Token) ? loaded.Token : null,
            };
            if (current.InstanceId != loaded.InstanceId || current.Token != loaded.Token)
            {
                await _store.SaveAsync(current.Copy()).ConfigureAwait(false);
            }
            _current = current;
            return current;
        }
    }
}
