# Delivery plan

## Milestone 1 — current MVP

- TypeScript workspaces for shared protocol, host agent, hub, and mobile web client.
- macOS PTY and Windows ConPTY through `node-pty`.
- Transparent PATH shims and exact argv/cwd/environment forwarding.
- Non-TTY bypass for scripts and automation.
- Local detach/reattach and original child exit-code propagation.
- Outbound multi-host federation through the M1.
- Headless terminal snapshots plus sequence-numbered output.
- One-writer control and resize lease.
- Tailscale identity allowlist, strict Origin checks, one-use attachment nonces, and no hub transcript.
- Phone session list, stable-grid terminal, control takeover, key strip, and guarded paste.

## Milestone 2 — reliability boundary

- One detached runner process per PTY.
- Per-user Unix sockets on macOS and named pipes with current-user DACLs on Windows.
- Supervisor runner discovery after restart.
- Bounded delta rings with ACK/resume and forced snapshot fallback.
- LaunchAgent and per-user Scheduled Task installers.
- Clean upgrade and crash tests while a 30-minute TUI remains alive.

## Milestone 3 — host parity

- Windows `.cmd`/`.ps1` round-trip integration suite on Windows Terminal.
- macOS Terminal, iTerm2, Ghostty, and Windows Terminal compatibility matrix.
- Alternate screen, truecolor, Unicode width, mouse, bracketed paste, cursor, signal, and resize fixtures.
- Structured import for the existing `claude-glm` proxy.
- Process discovery that labels pre-existing unwrapped Claude/Codex sessions as visible-but-unattachable.

## Milestone 4 — hardened personal deployment

- One-time host enrollment and persistent Ed25519 host keys instead of one shared agent token.
- OS keychain/DPAPI secret storage.
- Optional passkey unlock for terminal control and destructive actions.
- Tailnet grant template and automated Tailscale Serve validation.
- OSC/DCS filtering policy, OSC 52 disabled by default, and safe-link confirmation.
- Signed macOS/Windows artifacts and automatic updates that preserve runners.

## Milestone 5 — CLI-aware quality of life

- Honest activity states: producing output, idle, exited, host offline.
- Local notifications for completed or input-needed sessions where detection is reliable.
- Claude/Codex-aware recovery buttons that call each harness's own resume flow.
- Optional Zellij 0.44 provider/import and tmux control-mode import on Unix.
- Optional encrypted, host-local recording; never enabled by default.
