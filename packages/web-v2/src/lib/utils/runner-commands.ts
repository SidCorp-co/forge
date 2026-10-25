// The runner's own commands, shown and copied verbatim on the screens that tell a person what to run.
// They are the CLI's words, never translated, so they live here rather than in a copy file.

import { CORE_URL } from "./core-url";

export const RUNNER_SETUP = "forge-runner setup";

/** Core's own origin: the configured API's, or this page's where the API is served beside it. */
function coreOrigin(): string {
  return /^https?:\/\//i.test(CORE_URL) ? CORE_URL : window.location.origin;
}

/** One pasted command: installs forge-runner from this core and goes straight on to `forge-runner setup`. */
export function runnerInstallCommand(origin: string = coreOrigin()): string {
  return `curl -fsSL ${origin}/api/install.sh | sh -s -- --setup`;
}
