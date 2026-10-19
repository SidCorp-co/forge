import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// ISS-1421 r11: the turned-off agents line names Enabled in this drawer, so every drawer has it.
const PROVIDERS = dirname(fileURLToPath(import.meta.url));

const sections = readdirSync(PROVIDERS, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => join(PROVIDERS, d.name, "section.tsx"))
  .flatMap((file) => {
    try {
      return [[file.split("/").at(-2) ?? file, readFileSync(file, "utf8")] as const];
    } catch {
      return [];
    }
  });

describe("every drawer with a saved binding's agents switch has its Enabled switch", () => {
  it("reads the provider sections", () => {
    expect(sections.map(([name]) => name)).toContain("coolify");
  });

  it.each(sections.filter(([, src]) => src.includes("<AgentAccessControl")))(
    "the %s drawer renders IntegrationEnabledControl",
    (_name, src) => {
      expect(src).toContain("<IntegrationEnabledControl");
    },
  );
});
