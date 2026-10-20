using System;
using System.IO;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Threading;
using System.Threading.Tasks;

namespace MuteDeck.PluginClient
{
    /// <summary>What a token store persists.</summary>
    public sealed class StoredCredentials
    {
        /// <summary>64-hex token issued by MuteDeck. Treat it like a password.</summary>
        [JsonPropertyName("token")] public string? Token { get; set; }

        /// <summary>Per-install id, generated once and kept when the token is dropped.</summary>
        [JsonPropertyName("instanceId")] public string? InstanceId { get; set; }

        internal StoredCredentials Copy() => new StoredCredentials { Token = Token, InstanceId = InstanceId };
    }

    /// <summary>Persistence for the token and instance id.</summary>
    public interface ITokenStore
    {
        /// <summary>Load the stored credentials (empty when none).</summary>
        Task<StoredCredentials> LoadAsync(CancellationToken cancellationToken = default);

        /// <summary>Replace the stored credentials (a null token means "no token").</summary>
        Task SaveAsync(StoredCredentials credentials, CancellationToken cancellationToken = default);

        /// <summary>Remove everything, including the instance id.</summary>
        Task ClearAsync(CancellationToken cancellationToken = default);
    }

    /// <summary>Keeps credentials in memory only.</summary>
    public sealed class InMemoryTokenStore : ITokenStore
    {
        private StoredCredentials _data;
        private readonly object _lock = new object();

        /// <summary>Create a store, optionally pre-filled.</summary>
        public InMemoryTokenStore(StoredCredentials? initial = null) => _data = initial?.Copy() ?? new StoredCredentials();

        /// <inheritdoc />
        public Task<StoredCredentials> LoadAsync(CancellationToken cancellationToken = default)
        {
            lock (_lock) { return Task.FromResult(_data.Copy()); }
        }

        /// <inheritdoc />
        public Task SaveAsync(StoredCredentials credentials, CancellationToken cancellationToken = default)
        {
            lock (_lock) { _data = credentials.Copy(); }
            return Task.CompletedTask;
        }

        /// <inheritdoc />
        public Task ClearAsync(CancellationToken cancellationToken = default)
        {
            lock (_lock) { _data = new StoredCredentials(); }
            return Task.CompletedTask;
        }
    }

    /// <summary>
    /// Stores credentials as JSON in a file (written atomically). Put it in the
    /// plugin's data folder, e.g. Loupedeck's <c>GetPluginDataDirectory()</c>.
    /// </summary>
    public sealed class FileTokenStore : ITokenStore
    {
        private readonly string _path;
        private readonly SemaphoreSlim _lock = new SemaphoreSlim(1, 1);

        /// <summary>Create a store backed by <paramref name="path"/>.</summary>
        public FileTokenStore(string path) => _path = path ?? throw new ArgumentNullException(nameof(path));

        /// <inheritdoc />
        public async Task<StoredCredentials> LoadAsync(CancellationToken cancellationToken = default)
        {
            await _lock.WaitAsync(cancellationToken).ConfigureAwait(false);
            try
            {
                if (!File.Exists(_path)) return new StoredCredentials();
                var json = File.ReadAllText(_path);
                return JsonSerializer.Deserialize<StoredCredentials>(json) ?? new StoredCredentials();
            }
            catch (JsonException)
            {
                return new StoredCredentials();
            }
            finally
            {
                _lock.Release();
            }
        }

        /// <inheritdoc />
        public async Task SaveAsync(StoredCredentials credentials, CancellationToken cancellationToken = default)
        {
            await _lock.WaitAsync(cancellationToken).ConfigureAwait(false);
            try
            {
                var directory = Path.GetDirectoryName(Path.GetFullPath(_path));
                if (!string.IsNullOrEmpty(directory)) Directory.CreateDirectory(directory);
                var temp = _path + ".tmp";
                File.WriteAllText(temp, JsonSerializer.Serialize(credentials, Json.Options));
                if (File.Exists(_path)) File.Delete(_path);
                File.Move(temp, _path);
            }
            finally
            {
                _lock.Release();
            }
        }

        /// <inheritdoc />
        public async Task ClearAsync(CancellationToken cancellationToken = default)
        {
            await _lock.WaitAsync(cancellationToken).ConfigureAwait(false);
            try
            {
                if (File.Exists(_path)) File.Delete(_path);
            }
            finally
            {
                _lock.Release();
            }
        }
    }
}
