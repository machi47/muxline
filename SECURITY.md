# Security model

Muxline remote control is remote code execution as the signed-in user on a host computer. A person who can take control of a live session can run commands, read terminal output, use already-authenticated CLI credentials, and potentially change files. A person who can read saved records can learn workspace paths, native re-entry IDs, and terminal content.

Treat Muxline as private infrastructure for one trusted tailnet—not as a public terminal service.

## Security goals

- Only explicitly authorized tailnet identities can view the web UI.
- Only enrolled host agents can relay live terminal sessions.
- A browser cannot send terminal input without an explicit, short-lived attachment grant and a live control lease.
- Host agents, hub, and browser have separate trust boundaries.
- Saved-record data is retained honestly and never misrepresented as harmless metadata.

## Required deployment rules

- Run every host agent and the hub as an ordinary user. Do not run as root, Administrator, or a Windows Session 0 service.
- Bind the hub only to `127.0.0.1` or `::1`. The application rejects a non-loopback bind unless an explicit development escape hatch is set.
- Publish the hub through **Tailscale Serve** to its loopback listener. Do not use Tailscale Funnel, a router port-forward, or a public reverse proxy.
- In `tailscale` mode, set an explicit `MUXLINE_ALLOWED_TAILSCALE_USERS` allowlist and enforce tailnet grants/ACLs for the hub device.
- Use a random hub agent token of at least 32 bytes; never paste it into issues, screenshots, shell history shared with others, or the web UI.
- Protect the accounts and disks of every host and hub with normal OS login security and full-disk encryption.
- Keep the hub and agents updated alongside Node.js, Tailscale, the browser, Claude Code, and Codex.

Tailscale identity headers are trusted only because the Muxline backend stays loopback-only and Tailscale Serve is the boundary that injects them. If an untrusted network peer can reach the backend directly, it can attempt to spoof those headers. That deployment is unsupported.

## Authentication and authorization

### Browser access

The hub supports three modes:

| Mode | Use | Security posture |
| --- | --- | --- |
| `tailscale` | Normal private-tailnet deployment | Allows only the configured Tailscale login allowlist. Requires HTTPS origin checks. |
| `token` | Controlled environments without Tailscale identity headers | Requires an explicit long web bearer token. Treat it like a password. |
| `dev` | Local development only | Deliberately not safe to expose to a tailnet or network. |

In Tailscale mode, the web API receives the authenticated identity from Tailscale Serve and maps it to the allowlist. In token mode, the bearer token authorizes the HTTP request that creates the terminal attachment grant; the grant itself then authorizes the WebSocket. There is no multi-user role system yet—an authorized viewer can request control of any live session they can see.

### Host agents

Current host enrollment uses a shared bearer token between the hub and all configured agents. The agent connects outward over WSS and identifies its stable host UUID in the WebSocket handshake. This is suitable only for a small, personally controlled deployment.

It is **not** equivalent to individual host keys or revocable enrollment. Rotate the shared token manually on the hub and every agent if one host is lost or the token might have leaked. Per-host public-key enrollment is a planned hardening item.

### Browser terminal attachment

Opening a terminal is deliberately more constrained than listing records:

1. The browser makes a same-origin request for a 256-bit attachment nonce scoped to its identity, host, and logical session.
2. The hub stores only a SHA-256 hash of that nonce for 20 seconds.
3. The browser presents the nonce once as a WebSocket subprotocol, not a query parameter.
4. The nonce is consumed on use. The hub only attaches it if the target host is connected and the record is live.
5. The agent still accepts input only from the current control-lease holder.

State-changing routes require same-host `Origin` plus same-origin Fetch Metadata when supplied. Cross-origin resource sharing is not enabled.

## Data that is retained

Muxline's durable storage is useful precisely because it retains context. It must be protected accordingly.

| Location | Retained data | Not retained by Muxline |
| --- | --- | --- |
| Host agent ledger | Logical session metadata, host/workspace/profile data, timestamps, native reference/source path/re-entry hint when known, and last-known ANSI screen snapshot. | Original launch argv/environment, a Muxline-created native conversation, or an intentional full transcript database. |
| Live runner descriptor | While a managed runtime is live: a private loopback endpoint/token and launch envelope, including its child environment. The descriptor drops the launch envelope after finalization. | Hub-visible data or a long-term transcript. |
| Hub catalogue | A synchronized copy of host/session metadata and saved ANSI snapshots so offline hosts can still be inspected. | Original launch argv/environment and live frame-by-frame transcript logging. |
| Native harness storage | Whatever Claude Code or Codex itself stores for its own sessions. | Controlled by the harness, not copied or rewritten by Muxline. |

An ANSI/xterm snapshot may include visible prompts, source code, command output, secrets printed to a terminal, and serialized buffer content. It is not a harmless thumbnail. Current retention has no automatic expiry, deletion UI, encryption-at-rest layer, or key rotation. Keep the host and hub data directories out of cloud-sync folders unless that is an intentional, secured choice; protect backups just as you would terminal recordings.

On POSIX systems Muxline requests private directories and `0600` files for config/ledger writes. On Windows, protection depends on the user's profile ACLs. Verify filesystem permissions in your own environment; the project does not yet install platform-specific hardened ACL policies.

## What a host agent changes

For a registered interactive launch, Muxline starts the target in a PTY/ConPTY and adds its own runtime environment variables. It preserves the user's user-supplied argv, cwd, and environment rather than parsing harness options.

The PTY owner is a detached, one-session local runner. Its descriptor and launch envelope are kept only under the host user's private Muxline directory (`0600` requested on POSIX) and are never sent to the hub. The agent talks to that runner only over authenticated `127.0.0.1` HTTP/WebSocket endpoints. This is a portability-first loopback transport; it is not a claim of a hardened Unix-socket or Windows named-pipe ACL implementation.

For managed Claude Code launches, Muxline supplies a generated private plugin directory through `--plugin-dir` so a lifecycle hook can report the native session ID. It does not edit `~/.claude/settings.json`, project `.claude` files, or the Claude executable. This still means Muxline code runs as the same local user inside a Claude launch; review the code and pin releases before trusting it with important credentials.

## Terminal output is hostile input

Terminal output can be produced by repositories, shell tools, and model responses. It may contain escape sequences designed for terminal emulators or browsers.

Current mitigations include:

- no clipboard-read addon or automatic terminal-link opening;
- a user gesture for clipboard read and confirmation for multiline/control-character paste;
- DOM construction with `textContent` for session metadata instead of `innerHTML`;
- strict Content Security Policy, no-store responses, frame denial, and a restrictive permissions policy;
- payload-size limits and WebSocket backpressure caps.

Important limitation: broker-side OSC/DCS filtering and an explicit OSC 52 policy are not complete yet. Do not assume arbitrary terminal escape output is benign. The web UI is safer when used with an up-to-date browser, but it is not a substitute for a full terminal-emulation security review.

## Process and availability boundaries

- A hub outage does not intentionally end local PTYs, but it makes remote access unavailable until reconnect.
- A browser disconnect releases its viewer/control connection; it does not stop the host process.
- A host-agent restart can rediscover a healthy detached runner through its private authenticated descriptor. A runner that cannot be reached after recovery, or a host reboot, is marked `interrupted` and is never treated as controllable.
- A host sleep pauses processes; a reboot ends them. Muxline may still show a saved record and native re-entry hint afterward, but cannot restore a dead process itself.
- A saved/unreachable record is intentionally read-only. It is not a backdoor to write to an offline host.

## Operational guidance

- Use a separate, private hub device/account if possible; anyone with administrator-level access to the hub storage can read saved records and snapshots.
- Keep only trusted users in the Tailscale allowlist. Review tailnet sharing, ACLs, and device posture regularly.
- Prefer short-lived personal devices; revoke Tailscale access and rotate the hub token when a device is lost.
- Do not expose the dev authentication mode, and do not put a web token in a URL or browser bookmark.
- Consider disabling shell history around token-generation/configuration commands or use a secure secret manager.
- Test with non-sensitive sessions first and inspect exactly what appears in the hub's stored catalogue/snapshots before enabling it for work containing secrets.

## Reporting a vulnerability

Do not open a public issue containing agent tokens, web tokens, terminal output, prompts, source paths, native session IDs, or snapshots. Revoke/rotate exposed credentials first, then provide a minimal reproduction through the repository maintainer's private contact channel once one is published.

The current codebase has not received an external security audit. Please report vulnerabilities privately and avoid testing against systems you do not own or administer.
