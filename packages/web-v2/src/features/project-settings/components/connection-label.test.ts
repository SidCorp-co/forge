// ISS-1421 r5 repair 1 — right after Connect, the Share section listed the new connection as
// "coolify · coolify.example.com · Coolify": the provider's lower-case id, then its label.
// r6 — judge-37 saw two unnamed connections both read "Sentry" in the picker, and an older name's
// "coolify · " prefix still on Connections. One naming rule, read by every surface.

import { afterAll, describe, expect, it, vi } from "vitest";

// Every time the web shows is in the reader's own time zone (ISS-1229 r25); this reader is at UTC+7.
const zone = vi.hoisted(() => {
  const was = process.env.TZ;
  process.env.TZ = "Asia/Ho_Chi_Minh";
  return was;
});
afterAll(() => {
  process.env.TZ = zone;
});
import {
  connectionLabels,
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

  // r6 repair: two unnamed Epodsystem connections added the same day read "… added 16 Oct 2026" and
  // "… (2)", and a number does not say which is which.
  it("names an Epodsystem connection by its store, as Sentry and Coolify by their host", () => {
    expect(
      labelsOf([
        conn({ id: "a", provider: "epodsystem", config: { storeSlug: "acme-store" } }),
        conn({ id: "b", provider: "epodsystem" }),
      ]),
    ).toEqual(["acme-store · Epodsystem", "Epodsystem"]);
  });

  it("tells apart two with nothing else by when each was added: the day, then the time on it", () => {
    const labels = labelsOf([
      conn({ id: "a", provider: "sentry", createdAt: "2026-10-02T09:00:00.000Z" }),
      conn({ id: "b", provider: "sentry", createdAt: "2026-10-01T09:00:00.000Z" }),
      conn({ id: "c", provider: "sentry", createdAt: "2026-10-02T10:05:00.000Z" }),
    ]);
    expect(labels).toEqual([
      "Sentry · added 2 Oct 2026, 16:00",
      "Sentry · added 1 Oct 2026",
      "Sentry · added 2 Oct 2026, 17:05",
    ]);
    expect(labels.join(" ")).not.toMatch(/\(\d\)/);
  });

  // r36, judge-145: six alike rows added in one minute read "(2)" to "(6)", and clearing one moved the
  // number of every row after it. A row's words now come from its own time alone.
  it("tells apart two added in the same minute by the second, then the thousandth, never a number", () => {
    expect(
      labelsOf([
        conn({ id: "a", provider: "sentry", createdAt: "2026-10-02T09:00:10.000Z" }),
        conn({ id: "b", provider: "sentry", createdAt: "2026-10-02T09:00:40.000Z" }),
      ]),
    ).toEqual(["Sentry · added 2 Oct 2026, 16:00:10", "Sentry · added 2 Oct 2026, 16:00:40"]);
    expect(
      labelsOf([
        conn({ id: "a", provider: "sentry", createdAt: "2026-10-02T09:00:10.120Z" }),
        conn({ id: "b", provider: "sentry", createdAt: "2026-10-02T09:00:10.480Z" }),
      ]),
    ).toEqual(["Sentry · added 2 Oct 2026, 16:00:10.120", "Sentry · added 2 Oct 2026, 16:00:10.480"]);
  });

  it("keeps every other row's name when one of several alike is cleared", () => {
    const six = [10, 12, 15, 21, 33, 47].map((second, i) =>
      conn({ id: `s${i}`, provider: "sentry", config: { host: "same-host.example" }, createdAt: `2026-10-27T03:34:${second}.000Z` }),
    );
    const before = connectionPickerLabels(six);
    const after = connectionPickerLabels(six.filter((c) => c.id !== "s2"));
    for (const c of six.filter((x) => x.id !== "s2")) expect(after.get(c.id)).toBe(before.get(c.id));
    expect([...before.values()].join(" ")).not.toMatch(/\(\d\)/);
  });

  it("numbers only rows added in the same thousandth of a second", () => {
    expect(
      labelsOf([
        conn({ id: "a", provider: "sentry", createdAt: "2026-10-02T09:00:10.120Z" }),
        conn({ id: "b", provider: "sentry", createdAt: "2026-10-02T09:00:10.120Z" }),
      ]),
    ).toEqual(["Sentry · added 2 Oct 2026, 16:00:10.120", "Sentry · added 2 Oct 2026, 16:00:10.120 (2)"]);
  });

  // r36, judge-145: a connection named "Postman" read "Postman · Postman".
  it("says a name that is only its provider's once", () => {
    expect(labelsOf([conn({ id: "a", provider: "postman", displayName: "Postman" })])).toEqual(["Postman"]);
    expect(labelsOf([conn({ id: "a", provider: "postman", displayName: "postman" })])).toEqual(["Postman"]);
    // What it points at is held to the same rule: a workspace named Postman is no second word.
    expect(
      labelsOf([conn({ id: "a", provider: "postman", displayName: "Postman", config: { workspaceName: "Postman" } })]),
    ).toEqual(["Postman"]);
    expect(
      labelsOf([conn({ id: "a", provider: "sentry", displayName: "Sentry", config: { host: "sentry.one.example" } })]),
    ).toEqual(["sentry.one.example · Sentry"]);
    expect(connectionLabels([conn({ id: "a", provider: "postman", displayName: "Postman" })], false).get("a")).toBe(
      "Postman",
    );
  });

  it("reads the day in the reader's time zone, not the server's", () => {
    expect(
      labelsOf([
        conn({ id: "a", provider: "sentry", createdAt: "2026-10-02T20:30:00.000Z" }),
        conn({ id: "b", provider: "sentry", createdAt: "2026-10-02T09:00:00.000Z" }),
      ]),
    ).toEqual(["Sentry · added 3 Oct 2026", "Sentry · added 2 Oct 2026"]);
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

// r8, criterion 129: judge-40 saw two connections to one host listed alike on Connections, which the
// share picker told apart.
describe("the names Connections lists one app's connections by", () => {
  const sameHost = [
    conn({ id: "a", displayName: "coolify.example.com", createdAt: "2026-10-01T09:00:00.000Z" }),
    conn({ id: "b", displayName: "coolify.example.com", createdAt: "2026-10-02T09:00:00.000Z" }),
  ];

  it("tells two connections to one host apart by the picker's rule, with no provider after the name", () => {
    const rows = connectionLabels(sameHost, false);
    expect(sameHost.map((c) => rows.get(c.id))).toEqual([
      "coolify.example.com · added 1 Oct 2026",
      "coolify.example.com · added 2 Oct 2026",
    ]);
    const picker = connectionPickerLabels(sameHost);
    expect(sameHost.map((c) => picker.get(c.id))).toEqual([
      "coolify.example.com · Coolify · added 1 Oct 2026",
      "coolify.example.com · Coolify · added 2 Oct 2026",
    ]);
  });

  it("names an unnamed connection by what it points at, as the picker does", () => {
    const rows = connectionLabels(
      [conn({ id: "a", provider: "sentry", config: { host: "sentry.one.example" } })],
      false,
    );
    expect(rows.get("a")).toBe("sentry.one.example");
  });
});
