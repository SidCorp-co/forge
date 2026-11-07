import { describe, expect, it } from "vitest";
import { groupNetworkFailure } from "./sentry";

const thrown = (type: string, value: string) => ({ exception: { values: [{ type, value }] } }) as { exception: { values: { type: string; value: string }[] }; fingerprint?: string[] };

describe("a fetch that got no answer is one Sentry issue, whatever bundle threw it", () => {
  it.each(["Failed to fetch", "NetworkError when attempting to fetch resource.", "Load failed"])("groups %s", (value) => {
    expect(groupNetworkFailure(thrown("TypeError", value)).fingerprint).toEqual(["browser-network-failure"]);
  });

  it("leaves every other error to Sentry's own grouping", () => {
    for (const event of [
      thrown("TypeError", "Failed to fetch dynamically imported module: https://x/assets/a.js"),
      thrown("TypeError", "Cannot read properties of undefined (reading 'id')"),
      thrown("Error", "Failed to fetch"),
      {} as ReturnType<typeof thrown>,
    ]) {
      expect(groupNetworkFailure(event).fingerprint).toBeUndefined();
    }
  });
});
