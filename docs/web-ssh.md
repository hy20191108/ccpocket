# Web app over SSH

The local launcher serves the built Flutter app and manages OpenSSH connections
for its Bridge traffic. The browser does not receive SSH private keys. Existing
native SSH settings are unchanged.

## Start

Use the Flutter version pinned in `.mise.toml`, build the app, then start the
launcher from the repository root:

```sh
cd apps/mobile
flutter pub get
flutter build web --release --no-wasm-dry-run
cd ../..
npm run web:ssh -- --host my-ssh-alias --bridge-port 8765
```

The alias must already work with non-interactive OpenSSH authentication, such as
an SSH agent or an existing identity file. The remote Bridge must be running on
`127.0.0.1` at the chosen port. The launcher does not start, update or stop the
remote Bridge. Use a separate test Bridge port for verification.

Open the printed `http://ccp-….localhost:8889` URL. In CC Pocket, add a machine
with the printed hostname and port, leave secure connection off, and enter the
Bridge API key if required. SSH encrypts the connection to the remote host;
the browser-to-launcher connection stays on loopback. `--port` changes the local
port. Keep that port stable to retain the browser's settings.

Stopping the launcher closes the connections it owns and removes its temporary
SSH configuration and trust files. After a dropped SSH connection, the app can
reconnect through a new SSH process. Existing remote sessions remain managed
by the remote Bridge.

## Destination and trust

At startup, `ssh -G` supplies the effective target configuration. The launcher
freezes it in a temporary configuration and copies all configured user and global
known-hosts files, plus `RevokedHostKeys` if configured. OpenSSH evaluates hashed
hostnames, certificate authorities and revoked entries itself. The target's
normal host-key alias and nonstandard SSH-port behavior are preserved. Jump
hosts continue to use the user's existing SSH configuration.

The target connection uses strict host-key checking against the copied files,
with host-key updates, DNS trust, dynamic known-host commands and connection
multiplexing disabled. An untrusted target fails before any Bridge HTTP or
WebSocket bytes reach it. Each Bridge connection uses `ssh -W` standard streams,
so no independently owned local forwarding listener can receive its traffic.
The SSH process stays in the foreground with its standard input enabled.

The target configuration, SSH alias, Bridge port, and separate digests of the
host trust and revocation content determine a dedicated `.localhost` origin.
Changing any of these creates a different origin. The gateway rejects Host and
Origin headers for a previous destination, including requests from an old tab.
Changing an unrelated entry in a copied trust file also creates a new origin;
settings from the previous origin are not migrated automatically.

Trust changes take effect on the next launcher start. Restart the launcher after
revoking or changing a host key. An SSH host key identifies the server; it does
not distinguish a replacement Bridge service on the same server and port.

The launcher fails closed for `KnownHostsCommand` and trust paths whose expansion
it cannot snapshot, such as unresolved `%` or environment-variable expressions.
It never changes the original SSH configuration or known-hosts files.

The gateway binds only to `127.0.0.1`. It serves the app and Bridge traffic from
the same origin, and rejects cross-site Bridge requests. A top-level link
navigation to the static app is permitted. A trusted browser must resolve
`.localhost` to loopback and treat it as a secure context for browser storage;
this remains a browser requirement.

## Verification

```sh
npm run test:web-ssh
```

Tests cover HTTP forwarding, bidirectional WebSocket traffic and reconnects,
request origins, old destination tabs, link navigation, process stream behavior,
and separation of trust from revocation content.

On Windows OpenSSH through a real jump host, the launcher transport was also
verified against a separate Bridge: HTTP health, WebSocket session listing,
a forced SSH disconnect followed by reconnect, and a new Claude Code session
that returned a synthetic test reply. Existing sessions remained unchanged.
An empty copied known-hosts file failed before an HTTP response. The target and
jump host effective SSH configurations matched their original configurations.
Certificate and revoked-key contents are preserved and unit tested; actual
certificate and revoked-key SSH handshakes have not been exercised.

The Flutter release web build succeeded. Browser UI operation and browser secure
context/storage behavior have not yet been verified because the Windows browser
control tool could not determine the active browser URL.
