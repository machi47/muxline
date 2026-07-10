import { constants as fsConstants, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

export interface ShimResult {
  name: string;
  target: string;
  shimPath: string;
}

export async function installShims(
  names: readonly string[],
  environment: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): Promise<{ binDir: string; shims: ShimResult[] }> {
  if (names.length === 0) {
    throw new Error("Provide at least one command name to wrap");
  }
  const dataDir = environment.MUXLINE_HOME
    ? path.resolve(environment.MUXLINE_HOME)
    : path.join(os.homedir(), ".muxline");
  const binDir = path.join(dataDir, "bin");
  await fs.mkdir(binDir, { recursive: true, mode: 0o700 });
  const pathValue = environment.PATH ?? "";
  const searchPath = pathValue
    .split(path.delimiter)
    .filter((entry) => path.resolve(entry) !== path.resolve(binDir));

  const shims: ShimResult[] = [];
  for (const name of names) {
    validateCommandName(name);
    const target = await resolveExecutable(name, searchPath, environment, platform);
    const shimPath = platform === "win32"
      ? path.join(binDir, `${name}.cmd`)
      : path.join(binDir, name);
    const content = platform === "win32"
      ? windowsShim(name, target)
      : posixShim(name, target);
    await fs.writeFile(shimPath, content, { mode: 0o700 });
    if (platform !== "win32") {
      await fs.chmod(shimPath, 0o700);
    }
    shims.push({ name, target, shimPath });
  }
  return { binDir, shims };
}

export async function resolveExecutable(
  name: string,
  searchPath: readonly string[],
  environment: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): Promise<string> {
  const extensions = platform === "win32"
    ? (environment.PATHEXT ?? ".COM;.EXE;.BAT;.CMD;.PS1")
        .split(";")
        .filter(Boolean)
    : [""];
  for (const directory of searchPath) {
    for (const extension of extensions) {
      const candidate = path.resolve(directory || ".", platform === "win32" ? `${name}${extension}` : name);
      try {
        await fs.access(candidate, platform === "win32" ? fsConstants.F_OK : fsConstants.X_OK);
        return candidate;
      } catch {
        // Continue searching PATH.
      }
    }
  }
  throw new Error(
    `Cannot resolve executable ${name}. Shell aliases/functions need an executable adapter before they can be wrapped.`,
  );
}

export function posixShim(name: string, target: string): string {
  return `#!/bin/sh\nexec muxline run --profile ${shellQuote(name)} -- ${shellQuote(target)} "$@"\n`;
}

export function windowsShim(name: string, target: string): string {
  const escapedName = name.replaceAll("%", "%%").replaceAll("\"", "\"\"");
  const escapedTarget = target.replaceAll("%", "%%").replaceAll("\"", "\"\"");
  return `@echo off\r\nmuxline run --profile "${escapedName}" -- "${escapedTarget}" %*\r\nexit /b %ERRORLEVEL%\r\n`;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function validateCommandName(value: string): void {
  if (!/^[A-Za-z0-9._-]+$/.test(value)) {
    throw new Error(`Invalid shim name: ${value}`);
  }
}
