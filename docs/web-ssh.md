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
npm run web:ssh
```

The SSH destination chosen in the app must already work with non-interactive
OpenSSH authentication, such as an SSH agent or an existing identity file. The remote Bridge must be running on
`127.0.0.1` at the chosen port. The launcher does not start, update or stop the
remote Bridge. Use a separate test Bridge port for verification.

Open the printed `http://ccpocket.localhost:8889/` URL. In CC Pocket, open
**Add Machine > SSH**, enter the SSH destination name from this computer's
OpenSSH configuration and the remote Bridge port, then select **Connect over
SSH**. No manual SSH forwarding or local hostname entry is needed. Jump hosts
and authentication use the existing local SSH configuration.

After connecting, **Settings > Connection and Bridge > SSH Configuration** also
shows the destination and port and lets you choose another connection.

The app opens a dedicated origin for that destination, registers the machine,
and connects automatically. If the Bridge requires an API key, enter it in the
machine settings on that destination's page. API keys are never transferred
when choosing another SSH destination. The current SSH destination and Bridge
port appear in the same SSH settings when editing the machine.

The launcher saves only the selected SSH aliases and Bridge ports in the user's
local application state directory. On restart it rebuilds their routes from new
trust snapshots. A previous tab whose trust identity changed is rejected.
`--port` changes the local web port; keep it stable to retain browser settings.
`--host my-ssh-alias --bridge-port 8765` remains available as an optional shortcut.

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
Changing any of these creates a different origin. Each origin can only reach
its own frozen destination. An old tab cannot send credentials to a newly
selected destination. After a launcher restart, origins whose trust identity
changed are no longer registered and are rejected.
Changing an unrelated entry in a copied trust file also creates a new origin;
settings from the previous origin are not migrated automatically.

Selecting Connect over SSH obtains a new trust snapshot. Existing destination
origins keep their frozen snapshots for that launcher run. Restart the launcher
after revoking a host key to remove all routes using the old trust. An SSH host key identifies the server; it does
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

The Flutter release web build succeeded. In Chrome, the SSH destination and
Bridge port were entered in the app, Connect over SSH opened the dedicated
origin, and the machine registered and connected automatically. A Claude session
created through the UI returned the synthetic test reply. Browser reload and
launcher restart both reconnected with the saved configuration. The test session
was then stopped; the original sessions remained active. Chrome reported the
`.localhost` page as a secure context and retained its machine settings.
