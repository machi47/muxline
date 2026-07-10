import path from "node:path";
import type { HarnessKind, LaunchProfile } from "@muxline/protocol";

export interface ProfileOverride {
  harness: HarnessKind;
  label?: string | undefined;
  provider?: string | undefined;
}

export function resolveLaunchProfile(
  id: string,
  command: string,
  overrides: Readonly<Record<string, ProfileOverride>>,
): LaunchProfile {
  const configured = overrides[id];
  if (configured) {
    return {
      id,
      label: configured.label ?? id,
      harness: configured.harness,
      provider: configured.provider ?? inferProvider(id),
      invocation: id,
    };
  }

  const target = path.basename(command).toLowerCase();
  const name = id.toLowerCase();
  const harness: HarnessKind = name.startsWith("codex") || target.includes("codex")
    ? "codex"
    : name.startsWith("claude") || target.includes("claude")
      ? "claude-code"
      : "generic";
  return {
    id,
    label: id,
    harness,
    provider: inferProvider(id),
    invocation: id,
  };
}

function inferProvider(profile: string): string | null {
  const lower = profile.toLowerCase();
  if (lower.includes("glm")) return "GLM";
  if (lower.includes("anthropic")) return "Anthropic";
  if (lower.includes("openai")) return "OpenAI";
  if (!lower.startsWith("claude") && lower.includes("claude")) return "Claude";
  if (lower.includes("local")) return "Local";
  return null;
}
