import { describe, expect, it } from "vitest";
import { runnerInstallCommand } from "./runner-commands";

describe("REQ-73 BC-5: one command installs the runner and pairs it", () => {
  it("installs from the named core and goes straight on to setup", () => {
    expect(runnerInstallCommand("https://forge.example")).toBe(
      "curl -fsSL https://forge.example/api/install.sh | sh -s -- --setup",
    );
  });

  it("names this page's origin where the API is served beside the web", () => {
    expect(runnerInstallCommand()).toBe(
      `curl -fsSL ${window.location.origin}/api/install.sh | sh -s -- --setup`,
    );
  });
});
