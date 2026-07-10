import path from "node:path";

export interface LaunchSpec {
  command: string;
  args: string[];
  env: Record<string, string>;
}

const WINDOWS_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$json = [Text.Encoding]::UTF8.GetString(
  [Convert]::FromBase64String($env:MUXLINE_WINDOWS_LAUNCH_B64)
)
$items = @($json | ConvertFrom-Json)
if ($items.Count -lt 1) { exit 127 }
$target = [string]$items[0]
$arguments = if ($items.Count -gt 1) { @($items[1..($items.Count - 1)] | ForEach-Object { [string]$_ }) } else { @() }
& $target @arguments
if ($null -ne $LASTEXITCODE) { exit $LASTEXITCODE }
exit 0
`.trim();

export function buildLaunchSpec(
  command: string,
  args: readonly string[],
  env: Readonly<Record<string, string>>,
  platform: NodeJS.Platform = process.platform,
): LaunchSpec {
  assertLaunchValues([command, ...args]);
  const childEnv = { ...env, MUXLINE_WRAPPED: "1" };

  if (platform !== "win32") {
    return { command, args: [...args], env: childEnv };
  }

  const extension = path.win32.extname(command).toLowerCase();
  if (extension !== ".cmd" && extension !== ".bat" && extension !== ".ps1") {
    return { command, args: [...args], env: childEnv };
  }

  const encodedLaunch = Buffer.from(
    JSON.stringify([command, ...args]),
    "utf8",
  ).toString("base64");
  const encodedScript = Buffer.from(WINDOWS_SCRIPT, "utf16le").toString("base64");
  return {
    command: env.SystemRoot
      ? path.win32.join(env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
      : "powershell.exe",
    args: [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-EncodedCommand",
      encodedScript,
    ],
    env: { ...childEnv, MUXLINE_WINDOWS_LAUNCH_B64: encodedLaunch },
  };
}

function assertLaunchValues(values: readonly string[]): void {
  for (const value of values) {
    if (value.includes("\0") || value.includes("\r") || value.includes("\n")) {
      throw new Error("Commands and arguments cannot contain NUL or newline characters");
    }
  }
}

export const windowsLaunchScriptForTest = WINDOWS_SCRIPT;
