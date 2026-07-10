import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import {
  ServerTerminalMessageSchema,
  type ClientTerminalMessage,
  type ServerTerminalMessage,
  type SessionSummary,
} from "@muxline/protocol";
import "./style.css";

interface HostView {
  id: string;
  name: string;
  platform: string;
  agentVersion: string;
  online: boolean;
  connectedAt: string | null;
  lastSeenAt: string;
  sessions: SessionSummary[];
}

interface SessionsResponse {
  identity: { id: string; displayName: string };
  hosts: HostView[];
}

const app = requiredElement("app");
let webToken = "";
let refreshTimer: number | undefined;
let terminalCleanup: (() => void) | undefined;

void showDashboard();

async function showDashboard(): Promise<void> {
  terminalCleanup?.();
  terminalCleanup = undefined;
  if (refreshTimer !== undefined) window.clearInterval(refreshTimer);
  app.replaceChildren();

  const shell = element("section", "dashboard");
  const header = element("header", "dashboard-header");
  const brand = element("div", "brand");
  brand.append(element("span", "brand-mark", "M"), element("h1", "", "Muxline"));
  const subtitle = element("p", "subtitle", "Every live session. No tmux archaeology.");
  const refresh = button("Refresh", "button subtle", () => void refreshDashboard(shell));
  header.append(brand, subtitle, refresh);
  shell.append(header, element("div", "loading", "Finding your computers…"));
  app.append(shell);

  await refreshDashboard(shell);
  refreshTimer = window.setInterval(() => void refreshDashboard(shell, true), 2_500);
}

async function refreshDashboard(shell: HTMLElement, quiet = false): Promise<void> {
  try {
    const response = await apiFetch("/v1/sessions");
    if (response.status === 403 && !webToken) {
      const supplied = window.prompt("Muxline web token (leave blank when using Tailscale identity):") ?? "";
      if (supplied) {
        webToken = supplied;
        return refreshDashboard(shell);
      }
    }
    if (!response.ok) throw new Error(await responseError(response));
    const payload = await response.json() as SessionsResponse;
    renderHosts(shell, payload);
  } catch (error) {
    if (!quiet) {
      shell.querySelector(".loading, .host-list, .empty")?.remove();
      shell.append(element("div", "error-panel", errorMessage(error)));
    }
  }
}

function renderHosts(shell: HTMLElement, payload: SessionsResponse): void {
  shell.querySelector(".loading, .host-list, .empty, .error-panel")?.remove();
  const list = element("div", "host-list");
  let sessionCount = 0;

  for (const host of payload.hosts) {
    const section = element("section", `host ${host.online ? "online" : "offline"}`);
    const heading = element("div", "host-heading");
    const titleWrap = element("div", "host-title");
    titleWrap.append(
      element("span", "status-dot"),
      element("h2", "", host.name),
      element("span", "host-platform", host.platform),
    );
    heading.append(
      titleWrap,
      element("span", "host-state", host.online ? "online" : `offline · ${relativeTime(host.lastSeenAt)}`),
    );
    section.append(heading);

    if (host.sessions.length === 0) {
      section.append(element("p", "host-empty", "No managed sessions on this computer."));
    } else {
      const cards = element("div", "session-grid");
      for (const session of host.sessions) {
        sessionCount += 1;
        cards.append(sessionCard(host, session));
      }
      section.append(cards);
    }
    list.append(section);
  }

  if (payload.hosts.length === 0) {
    shell.append(
      element("div", "empty", "No agents are connected yet. Start `muxline agent` on a computer."),
    );
  } else {
    const subtitle = shell.querySelector(".subtitle");
    if (subtitle) {
      subtitle.textContent = `${sessionCount} session${sessionCount === 1 ? "" : "s"} across ${payload.hosts.length} computer${payload.hosts.length === 1 ? "" : "s"}`;
    }
    shell.append(list);
  }
}

function sessionCard(host: HostView, session: SessionSummary): HTMLElement {
  const card = button("", "session-card", () => {
    if (host.online) void showTerminal(host, session);
  });
  card.disabled = !host.online;
  const top = element("div", "session-card-top");
  top.append(
    element("span", `session-state ${session.state}`, session.state),
    element("span", "session-age", relativeTime(session.lastOutputAt)),
  );
  const name = element("h3", "", session.displayName);
  const metadata = element("div", "session-metadata");
  metadata.append(
    badge(session.profile),
    badge(session.cwdLabel),
    badge(`${session.cols}×${session.rows}`),
    badge(session.controller ? `${session.controller.source} control` : "unclaimed"),
  );
  card.append(top, name, metadata);
  return card;
}

async function showTerminal(host: HostView, initialSession: SessionSummary): Promise<void> {
  if (refreshTimer !== undefined) window.clearInterval(refreshTimer);
  app.replaceChildren();
  let session = initialSession;
  let hasControl = false;
  let readableMode = false;
  let socket: WebSocket | undefined;
  let pingTimer: number | undefined;

  const screen = element("section", "terminal-screen");
  const header = element("header", "terminal-header");
  const back = button("‹ Sessions", "button subtle", () => void showDashboard());
  const identity = element("div", "terminal-identity");
  identity.append(
    element("strong", "", session.displayName),
    element("span", "", `${host.name} · ${session.cwdLabel}`),
  );
  const control = button("Take control", "button control", () => {
    send({ type: "claim-control", force: true });
  });
  header.append(back, identity, control);

  const status = element("div", "terminal-status", "Connecting…");
  const viewport = element("div", "terminal-viewport");
  const terminalElement = element("div", "terminal");
  viewport.append(terminalElement);
  const toolbar = element("div", "terminal-toolbar");
  const keys: Array<[string, string]> = [
    ["Esc", "\u001b"],
    ["Tab", "\t"],
    ["←", "\u001b[D"],
    ["↑", "\u001b[A"],
    ["↓", "\u001b[B"],
    ["→", "\u001b[C"],
    ["⌃C", "\u0003"],
    ["⌃D", "\u0004"],
    ["Enter", "\r"],
  ];
  for (const [label, data] of keys) {
    toolbar.append(button(label, "key", () => sendInput(data)));
  }
  toolbar.append(
    button("Keyboard", "key wide", () => terminal.focus()),
    button("Paste", "key wide", () => void pasteFromClipboard()),
    button("Fit phone", "key wide", () => {
      if (!hasControl) {
        status.textContent = "Take control before changing the PTY size.";
        return;
      }
      readableMode = true;
      fit.fit();
    }),
  );

  const composer = element("form", "composer");
  const input = document.createElement("input");
  input.type = "text";
  input.placeholder = "Type a line…";
  input.autocomplete = "off";
  input.autocapitalize = "off";
  input.spellcheck = false;
  input.setAttribute("data-1p-ignore", "true");
  const sendButton = button("Send", "button send", () => undefined);
  sendButton.type = "submit";
  composer.append(input, sendButton);
  composer.addEventListener("submit", (event) => {
    event.preventDefault();
    if (!input.value) return;
    sendInput(`${input.value}\r`);
    input.value = "";
  });

  screen.append(header, status, viewport, toolbar, composer);
  app.append(screen);

  const terminal = new Terminal({
    cols: session.cols,
    rows: session.rows,
    cursorBlink: true,
    cursorStyle: "bar",
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
    fontSize: stableGridFontSize(session.cols, viewport.clientWidth),
    lineHeight: 1.12,
    scrollback: 10_000,
    allowTransparency: false,
    convertEol: false,
    theme: {
      background: "#080b12",
      foreground: "#dce4f4",
      cursor: "#79f2c0",
      selectionBackground: "#315c70aa",
      black: "#111725",
      red: "#ff6b7a",
      green: "#79f2c0",
      yellow: "#ffd166",
      blue: "#75a7ff",
      magenta: "#c99cff",
      cyan: "#66d9ef",
      white: "#e8eef8",
    },
  });
  const fit = new FitAddon();
  terminal.loadAddon(fit);
  terminal.open(terminalElement);
  terminal.focus();

  terminal.onData((data) => {
    if (hasControl) send({ type: "input", data });
  });
  terminal.onResize(({ cols, rows }) => {
    if (hasControl && readableMode) send({ type: "resize", cols, rows });
  });

  try {
    const grantResponse = await apiFetch("/v1/attachments", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ hostId: host.id, sessionId: session.id }),
    });
    if (!grantResponse.ok) throw new Error(await responseError(grantResponse));
    const grant = await grantResponse.json() as { nonce: string };
    const wsUrl = new URL("/v1/terminal", window.location.href);
    wsUrl.protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    socket = new WebSocket(wsUrl, ["muxline.v1", `muxline.nonce.${grant.nonce}`]);
    socket.addEventListener("open", () => {
      status.textContent = "Live · view only";
      pingTimer = window.setInterval(() => send({ type: "ping", at: Date.now() }), 10_000);
    });
    socket.addEventListener("message", (event) => {
      try {
        handleServerMessage(ServerTerminalMessageSchema.parse(JSON.parse(String(event.data))));
      } catch {
        status.textContent = "Received an invalid terminal frame.";
        socket?.close();
      }
    });
    socket.addEventListener("close", (event) => {
      hasControl = false;
      control.textContent = "Disconnected";
      control.disabled = true;
      status.textContent = event.code === 1000 ? "Session closed" : "Disconnected · return to sessions and reopen";
    });
    socket.addEventListener("error", () => {
      status.textContent = "Terminal connection failed.";
    });
  } catch (error) {
    status.textContent = errorMessage(error);
  }

  terminalCleanup = () => {
    if (pingTimer !== undefined) window.clearInterval(pingTimer);
    socket?.close(1000, "Leaving terminal");
    terminal.dispose();
  };

  function handleServerMessage(message: ServerTerminalMessage): void {
    switch (message.type) {
      case "snapshot":
        session = message.session;
        hasControl = message.hasControl;
        terminal.resize(session.cols, session.rows);
        terminal.reset();
        terminal.write(message.data);
        updateControl();
        return;
      case "output":
        terminal.write(message.data);
        return;
      case "control":
        hasControl = message.hasControl;
        updateControl(message.reason);
        return;
      case "session":
        session = message.session;
        return;
      case "exit":
        status.textContent = `Exited with code ${message.exitCode}`;
        control.disabled = true;
        return;
      case "error":
        status.textContent = message.message;
        return;
      case "pong":
        return;
    }
  }

  function updateControl(reason?: string): void {
    control.textContent = hasControl ? "Release control" : "Take control";
    control.classList.toggle("active", hasControl);
    control.onclick = () => {
      send(hasControl
        ? { type: "release-control" }
        : { type: "claim-control", force: true });
    };
    status.textContent = reason ?? (hasControl ? "Live · you have control" : "Live · view only");
    if (!hasControl) readableMode = false;
  }

  function send(message: ClientTerminalMessage): void {
    if (socket?.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(message));
    }
  }

  function sendInput(data: string): void {
    if (!hasControl) {
      status.textContent = "Take control before typing.";
      return;
    }
    send({ type: "input", data });
    terminal.focus();
  }

  async function pasteFromClipboard(): Promise<void> {
    if (!hasControl) {
      status.textContent = "Take control before pasting.";
      return;
    }
    try {
      const text = await navigator.clipboard.readText();
      if (!text) return;
      const risky = text.includes("\n") || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text);
      if (risky && !window.confirm(`Paste ${text.split(/\r?\n/).length} lines into this terminal?`)) {
        return;
      }
      terminal.paste(text);
    } catch {
      status.textContent = "Clipboard access was denied by the browser.";
    }
  }
}

async function apiFetch(path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(path, {
    ...init,
    credentials: "same-origin",
    headers: {
      ...(webToken ? { authorization: `Bearer ${webToken}` } : {}),
      ...init.headers,
    },
  });
}

function stableGridFontSize(columns: number, width: number): number {
  if (!width) return 11;
  return Math.max(6, Math.min(15, Math.floor(width / (columns * 0.62))));
}

function relativeTime(value: string): string {
  const seconds = Math.round((Date.parse(value) - Date.now()) / 1000);
  const formatter = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
  if (Math.abs(seconds) < 60) return formatter.format(seconds, "second");
  const minutes = Math.round(seconds / 60);
  if (Math.abs(minutes) < 60) return formatter.format(minutes, "minute");
  const hours = Math.round(minutes / 60);
  if (Math.abs(hours) < 24) return formatter.format(hours, "hour");
  return formatter.format(Math.round(hours / 24), "day");
}

function requiredElement(id: string): HTMLElement {
  const value = document.getElementById(id);
  if (!value) throw new Error(`Missing #${id}`);
  return value;
}

function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className = "",
  text = "",
): HTMLElementTagNameMap[K] {
  const value = document.createElement(tag);
  value.className = className;
  value.textContent = text;
  return value;
}

function button(text: string, className: string, action: () => void): HTMLButtonElement {
  const value = element("button", className, text);
  value.type = "button";
  value.addEventListener("click", action);
  return value;
}

function badge(text: string): HTMLElement {
  return element("span", "badge", text);
}

async function responseError(response: Response): Promise<string> {
  try {
    const body = await response.json() as { error?: string };
    return body.error ?? `HTTP ${response.status}`;
  } catch {
    return `HTTP ${response.status}`;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
