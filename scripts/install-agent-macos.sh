#!/usr/bin/env bash
set -euo pipefail

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "This installer is for macOS." >&2
  exit 1
fi

muxline_bin="$(command -v muxline || true)"
if [[ -z "$muxline_bin" ]]; then
  echo "muxline is not on PATH. Build the repository and run npm link first." >&2
  exit 1
fi

data_dir="${MUXLINE_HOME:-$HOME/.muxline}"
launch_agents="$HOME/Library/LaunchAgents"
plist="$launch_agents/dev.muxline.agent.plist"
mkdir -p "$data_dir" "$launch_agents"
chmod 700 "$data_dir"

escaped_bin="${muxline_bin//&/&amp;}"
escaped_bin="${escaped_bin//</&lt;}"
escaped_bin="${escaped_bin//>/&gt;}"

cat >"$plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>dev.muxline.agent</string>
  <key>ProgramArguments</key>
  <array>
    <string>$escaped_bin</string>
    <string>agent</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ProcessType</key>
  <string>Background</string>
  <key>StandardOutPath</key>
  <string>$data_dir/agent.stdout.log</string>
  <key>StandardErrorPath</key>
  <string>$data_dir/agent.stderr.log</string>
</dict>
</plist>
PLIST

chmod 600 "$plist"
launchctl bootout "gui/$UID/dev.muxline.agent" 2>/dev/null || true
launchctl bootstrap "gui/$UID" "$plist"
launchctl kickstart -k "gui/$UID/dev.muxline.agent"
echo "Muxline agent installed and started: $plist"
