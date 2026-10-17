// ISS-1421 r5 repair 1 — right after Connect, the Share section listed the new connection as
// "coolify · coolify.example.com · Coolify": the provider's lower-case id, then its label.
// r6 — judge-37 saw two unnamed connections both read "Sentry" in the picker, and an older name's
// "coolify · " prefix still on Connections. One naming rule, read by every surface.

import { describe, expect, it } from "vitest";
import {
  connectionName,
  connectionPickerLabels,
  connectionTitle,
} from "@/features/integrations/connection-identity";

type C = Parameters<typeof connectionPickerLabels>[0][number];
const conn = (over: Partial<C> & { id: string }): C => ({
  provider: "coolify",
  displayName: null,
  config: {},
  createdAt: "2026-10-01T09:00:00.000Z",
  ...over,
});
const labelsOf = (list: C[]) => {
  const labels = connectionPickerLabels(list);
  return list.map((c) => labels.get(c.id));
};

describe("the picker's labels", () => {
  it("names a connection by its host, then its provider as the tab names it", () => {
    expect(labelsOf([conn({ id: "a", displayName: "coolify.example.com" })])).toEqual([
      "coolify.example.com · Coolify",
    ]);
  });

  it("drops the lower-case provider id a name stored before kept at its front", () => {
    expect(labelsOf([conn({ id: "a", displayName: "coolify · coolify.example.com" })])).toEqual([
      "coolify.example.com · Coolify",
    ]);
  });

  it("keeps a name its owner chose whole, and says the provider where there is nothing else", () => {
    expect(labelsOf([conn({ id: "a", displayName: "Prod box" })])).toEqual(["Prod box · Coolify"]);
    expect(labelsOf([conn({ id: "a" })])).toEqual(["Coolify"]);
  });

  it("names an unnamed connection by what it points at", () => {
    expect(
      labelsOf([
        conn({ id: "a", provider: "sentry", config: { host: "sentry.one.example" } }),
        conn({ id: "b", provider: "sentry", config: { host: "sentry.two.example" } }),
      ]),
    ).toEqual(["sentry.one.example · Sentry", "sentry.two.example · Sentry"]);
  });

  it("never lists two in the same words: the day each was added, then a number in adding order", () => {
    const labels = labelsOf([
      conn({ id: "a", provider: "sentry", createdAt: "2026-10-02T09:00:00.000Z" }),
      conn({ id: "b", provider: "sentry", createdAt: "2026-10-01T09:00:00.000Z" }),
      conn({ id: "c", provider: "sentry", createdAt: "2026-10-02T10:00:00.000Z" }),
    ]);
    expect(labels).toEqual([
      "Sentry · added 2 Oct 2026",
      "Sentry · added 1 Oct 2026",
      "Sentry · added 2 Oct 2026 (2)",
    ]);
    expect(new Set(labels).size).toBe(3);
  });
});

describe("the name Connections and the drawer show", () => {
  it("drops the provider's lower-case id there too", () => {
    expect(connectionTitle({ provider: "coolify", displayName: "coolify · box.example" })).toBe(
      "box.example",
    );
    expect(connectionName({ provider: "coolify", displayName: null })).toBeNull();
    expect(connectionTitle({ provider: "coolify", displayName: null })).toBe("Coolify");
  });
});
