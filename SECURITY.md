# Security model

Interactive terminal control is remote code execution as the logged-in host user. Muxline assumes that risk explicitly and narrows the network and browser boundaries around it.

## Required deployment rules

- Run agents and the hub as ordinary users, never root or Administrator.
- Bind the hub to `127.0.0.1` or `::1`.
- Publish it with Tailscale **Serve**, never Funnel or a router port-forward.
- Set an explicit `MUXLINE_ALLOWED_TAILSCALE_USERS` allowlist.
- Restrict the hub device with tailnet grants/ACLs.
- Use a random agent token of at least 32 bytes.
- Keep host agent config readable only by that OS user.

Tailscale Serve strips spoofed identity headers and inserts authenticated `Tailscale-User-*` headers. Those headers are trusted only because Muxline binds the backend to loopback. A directly reachable backend would let a caller spoof them.

## Browser attachment

- State-changing requests require a same-host Origin and same-origin Fetch Metadata.
- The browser first requests a 256-bit attachment nonce scoped to identity, host, and session.
- The nonce expires after 20 seconds, is stored only as a SHA-256 hash, and is consumed once.
- The nonce travels as a WebSocket subprotocol, not a URL query parameter.
- Terminal input is rejected unless the attachment owns the control lease.
- Cross-origin resource sharing is not enabled.

## Data retention

- The hub keeps safe session metadata in memory.
- The hub does not persist terminal bytes, prompts, argv, or environments.
- Logs redact authorization fields and never log terminal frames.
- Agent environment values exist only in the launch process memory and child environment.
- Transcript recording is not implemented and must remain opt-in when added.

## Terminal output is hostile

Repositories, tools, and models can emit escape sequences. The web client does not load a clipboard addon or automatically open terminal links. Clipboard reads require a user gesture, and multiline/control-character paste asks for confirmation.

Before a public release, add broker-side OSC/DCS payload caps and an explicit OSC 52 policy. Never render session metadata with `innerHTML`; the current UI constructs nodes with `textContent`.

## Reporting

Do not open a public issue containing tokens, terminal output, prompts, paths, or environment values. Revoke the affected agent/web secret before sharing a minimal reproduction.
