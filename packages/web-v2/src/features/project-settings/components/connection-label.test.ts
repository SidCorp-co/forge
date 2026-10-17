// ISS-1421 r5 repair 1 — right after Connect, the Share section listed the new connection as
// "coolify · coolify.example.com · Coolify deploy": the provider's lower-case id, then its label.

import { describe, expect, it } from "vitest";
import { connectionLabel } from "./integrations-tab";

describe("connectionLabel", () => {
  it("names a connection by its host, then its provider as the tab names it", () => {
    expect(connectionLabel({ provider: "coolify", displayName: "coolify.example.com" })).toBe(
      "coolify.example.com · Coolify deploy",
    );
  });

  it("drops the lower-case provider id a name stored before kept at its front", () => {
    expect(
      connectionLabel({ provider: "coolify", displayName: "coolify · coolify.example.com" }),
    ).toBe("coolify.example.com · Coolify deploy");
  });

  it("keeps a name its owner chose whole, and says the provider where there is no name", () => {
    expect(connectionLabel({ provider: "coolify", displayName: "Prod box" })).toBe("Prod box · Coolify deploy");
    expect(connectionLabel({ provider: "coolify", displayName: null })).toBe("Coolify deploy");
  });
});
