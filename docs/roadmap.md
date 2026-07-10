# Roadmap

Muxline's first-pass product contract is intentionally narrower than “make every terminal immortal.” It is:

> After one-time installation on a supported host, every registered interactive Claude Code, Codex, or executable proxy launch is discoverable from the private web UI. It is remotely viewable and controllable only while its host-local runner owns a live PTY. After it stops, its host/workspace/profile/native-session identity and last-known screen remain visible truthfully.

That contract is more useful than a terminal multiplexer on a phone because it preserves the context needed to answer: *which computer, which folder, which harness/profile, which actual session, and is it live right now?*

## First-pass acceptance contract

The implementation should satisfy all of the following without requiring users to remember a tmux prefix or deliberately prepare a session before leaving their desk:

1. Install a host agent, put selected executable shims first in `PATH`, and start `claude`, `codex`, or a registered proxy normally.
2. A distinct logical record appears under the correct **host → workspace → harness/profile** group. Multiple launches in the same directory remain distinct.
3. While the broker-owned PTY is alive and the host is reachable, any authorized Tailnet browser can inspect it and explicitly take the sole input/resize lease.
4. Closing the local terminal detaches that viewer instead of intentionally killing the managed CLI.
5. When the CLI exits, the record becomes saved and retains its last-known screen plus a native re-entry hint when Muxline has enough evidence.
6. If the hub or browser disappears temporarily, local work keeps running; the remote UI shows the source host as unreachable instead of pretending the session closed.
7. If the same host resumes an exactly known native Claude/Codex session through Muxline, the earlier logical record can rebind to the new PTY runtime and become live again.
8. If any inference is uncertain, the UI says unresolved/observed rather than fabricating a native session or an interactive terminal.

The data model behind those points is in [session-model.md](session-model.md).

## Delivered baseline

The current repository implements the initial functional surface.

### Host and launch path

- TypeScript workspaces for shared protocol, host agent, hub, and responsive web client.
- macOS PTYs and Windows ConPTY via `node-pty`.
- Command-specific PATH shims with exact argv/cwd/environment forwarding for interactive launches.
- Non-TTY bypass so scripts and pipelines retain normal standard I/O and exit codes.
- Safe Windows `.cmd`/`.bat`/`.ps1` launch adapter that avoids concatenating untrusted argv into shell code.
- Per-user macOS LaunchAgent and Windows interactive-user Scheduled Task installers.
- One detached, authenticated loopback runner per managed PTY/ConPTY; a restarted supervisor rediscovers healthy runners instead of deliberately terminating their sessions.

### Durable session model

- Stable host identity; canonical-workspace grouping with optional Git labels; profiles separated from harnesses.
- File-per-session host ledger, lifecycle events, bounded ANSI snapshot retention, and atomic writes.
- Durable hub catalogue and synchronized last-known screen so offline host records remain browseable.
- Explicit `live`, `saved`, and `interrupted` record states; derived `unreachable` presentation; same-host rebind event/runtime identity.
- Claude lifecycle-hook correlation without modifying Claude settings; conservative Codex native-session observation and exact explicit-resume handling.

### Remote interface

- Outbound multi-host agent connection through a loopback-only Tailnet hub.
- xterm headless snapshot plus sequence-numbered live output for correct attach/reconnect.
- Host/workspace/harness/profile/session dashboard hierarchy.
- Read-only-first live view, one-writer control lease, stable-grid mobile layout, touch key strip, phone fit only for the controller, and guarded multiline/control-character paste.
- Read-only saved-record inspector with native re-entry pointer and last-known screen.

### Security baseline

- Tailscale identity allowlist or token authentication, strict same-origin checks, one-use attachment nonces, loopback hub binding, and bounded WebSocket queues.
- Hub/agent logs redact credentials and do not log live terminal frames.
- No automatic terminal-link execution or clipboard-read addon.

## Next: runtime resilience hardening

The detached-runner boundary is implemented with authenticated loopback TCP/WebSocket endpoints and private runtime descriptors. The remaining work is production hardening, not a different session model:

- Real macOS and Windows restart/upgrade smoke tests while long-lived TUIs remain open.
- Runner descriptor cleanup, stale-process diagnostics, and durable event-stream acknowledgements.
- Optional Unix-domain socket/named-pipe transports only after their permission models are implemented and verified.
- Explicit handoff/reconnect UX for a local terminal client whose supervisor is restarted mid-attachment.

This improves the survival of **live terminal processes**. It does not turn saved snapshots into Claude/Codex contexts or make native sessions portable between hosts.

## Next: native-adapter quality

Native integrations should become more reliable without weakening the rule that the harness owns its own context.

- Versioned, documented adapters for current Claude Code and Codex native session storage/CLI behavior.
- Integration fixtures against real harness builds on macOS and Windows, including resume, concurrent sessions in one workspace, and custom config directories.
- Better user-visible correlation evidence: exact hook/argv link, observed local artifact, missing artifact, and unresolved ambiguity.
- Optional adapter support for additional executable proxies while retaining the profile-versus-harness distinction.
- Safe native re-entry affordances that are shown or copied locally; never automatically executed from an unrelated host.

## Next: operational and UX polish

- Record lifecycle controls: delete/archive/export from the UI, retention policies, and a clear storage-size view.
- Host health diagnostics, reconnect history, and human-readable explanation of `saved`, `interrupted`, and `unreachable`.
- Stronger installation flow for PATH precedence, executable proxy validation, and Tailnet Serve validation.
- Desktop/mobile browser compatibility matrix; keyboard, mouse, bracketed-paste, Unicode width, alternate screen, truecolor, resize, and scrollback regressions.
- Optional activity indicators and notifications only where they can be detected honestly.
- Accessibility pass for keyboard navigation, touch targets, contrast, and reduced-motion behavior.

## Next: security hardening

- Replace the shared hub agent token with one-time host enrollment and persistent per-host public keys.
- OS keychain/DPAPI storage for secrets rather than relying only on per-user files.
- Encryption at rest for catalogue/ANSI snapshot data, with an explicit key-management story.
- Optional passkey or local-device confirmation before remote terminal control/destructive actions.
- Broker-side terminal escape-sequence policy, especially OSC 52 and oversized OSC/DCS payloads.
- Signed macOS/Windows artifacts, update verification, and a reproducible release process.
- External threat modeling and security review before any broad distribution.

## Explicit non-goals for this pass

- Cross-device native Claude/Codex resume or migrating a live PTY from one host to another.
- Capturing processes that were launched outside Muxline before their command was shimmed.
- Treating a static terminal snapshot as a remotely controllable session.
- Public internet exposure, Tailscale Funnel, or a general-purpose cloud terminal service.
- Replacing a person's local terminal emulator, fonts, graphics protocols, or native harness persistence format.
- Making shell-only aliases/functions magically discoverable; executable adapters are intentional.

## Definition of production-ready

Muxline should not call itself production-ready until the native-adapter integration matrix, explicit snapshot retention/encryption decision, host enrollment, and real-device failure testing are complete. The first-pass product experience can still be useful now, as long as the live-versus-saved boundary is communicated accurately and the deployment remains private.
