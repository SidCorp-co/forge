// ISS-1421 r8, criterion 96 — judge-40 read "Turned off." beside a "Needs re-auth" pill on a
// binding turned off whose last check asked for sign-in. One state per row, and turned off wins.

import { describe, expect, it } from "vitest";
import { DIRECTORY_STATUS_META, deriveConnectionStatus, deriveDirectoryStatus, STATE_WORDS } from "./derive";

describe("the state a provider's row, drawer header and badge name", () => {
  it.each(["needs_reauth", "needs_scope", "error", "ok", null])(
    "reads a turned-off binding as Turned off whatever its last check found (%s)",
    (lastHealthStatus) => {
      const status = deriveDirectoryStatus({ status: "disabled", meta: { lastHealthStatus } });
      expect(status).toBe("disabled");
      expect(DIRECTORY_STATUS_META[status].label).toBe(STATE_WORDS.off);
    },
  );

  it("reads a connection the same way the binding is read", () => {
    expect(
      deriveConnectionStatus({ active: false, lastHealthStatus: "needs_reauth", breakerOpenedAt: null }),
    ).toBe("disabled");
  });

  it("still names a binding that is on and asks for sign-in", () => {
    expect(
      deriveDirectoryStatus({ status: "connected", meta: { lastHealthStatus: "needs_reauth" } }),
    ).toBe("needs_reauth");
  });
});
