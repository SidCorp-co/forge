// The Releases list's three groups and its fold (ISS-1001): what waits on the reader, what is going
// to production, the last few in production with the rest behind one row, and each release a later
// one carries folded under that release rather than drawn as a row of its own.

import type { ReleaseSummary } from "@forge/contracts/releases";
import { describe, expect, it } from "vitest";
import { PRODUCTION_SHOWN, releaseListOf, versionsOf } from "./release-list";

const kind = (k: "you" | "person" | "none") => ({ kind: k, who: "", act: "", rule: "r", ref: null, dueAt: null });

function release(version: string, state: ReleaseSummary["state"], waits: "you" | "person" | "none" = "none"): ReleaseSummary {
  const r = { key: version, version, state, waitingOn: kind(waits) };
  return r as unknown as ReleaseSummary;
}

const versions = (lines: { release: ReleaseSummary }[]) => lines.map((l) => l.release.version);

describe("the Releases list's groups (ISS-1001)", () => {
  it("puts what waits on the reader first, what goes out without them next, and production last", () => {
    const list = releaseListOf([release("0.4.0", "draft", "you"), release("0.3.1", "in_progress", "person"), release("0.3.0", "shipped")]);
    expect(versions(list.you)).toEqual(["0.4.0"]);
    expect(versions(list.going)).toEqual(["0.3.1"]);
    expect(versions(list.production)).toEqual(["0.3.0"]);
    expect(list.older).toEqual([]);
  });

  it("shows the last few in production and folds the rest behind one row, newest first", () => {
    const shipped = ["0.9.0", "0.8.0", "0.7.0", "0.6.0", "0.5.0"].map((v) => release(v, "shipped"));
    const list = releaseListOf(shipped);
    expect(versions(list.production)).toEqual(shipped.slice(0, PRODUCTION_SHOWN).map((r) => r.version));
    expect(versions(list.older)).toEqual(["0.6.0", "0.5.0"]);
  });

  it("folds fifty-one landings under the draft that carries them, never a row each (adminhub-fe 0.1.0 to 0.52.0 under 0.56.0)", () => {
    const landed = Array.from({ length: 51 }, (_, i) => release(`0.${52 - i}.0`, "landed"));
    const list = releaseListOf([release("0.56.0", "draft", "you"), ...landed, release("0.0.9", "shipped")]);
    expect(versions(list.you)).toEqual(["0.56.0"]);
    expect(list.you[0].carries.map((c) => c.version)).toEqual(landed.map((r) => r.version));
    expect(list.you[0].carries.at(-1)?.version).toBe("0.2.0");
    expect([...list.going, ...list.production, ...list.older].some((l) => l.release.state === "landed")).toBe(false);
    // each one it carries is still reported shown, so the chat can name it
    expect(versionsOf(list.you)).toHaveLength(52);
  });

  it("folds an attempt that ended unshipped under the newest release in production where nothing is on its way", () => {
    const list = releaseListOf([release("0.5.0", "shipped"), release("0.4.1", "aborted"), release("0.4.0", "shipped")]);
    expect(versions(list.production)).toEqual(["0.5.0", "0.4.0"]);
    expect(list.production[0].carries.map((c) => c.version)).toEqual(["0.4.1"]);
  });

  it("keeps a landing no later release carries as a row of its own, so nothing goes missing", () => {
    const list = releaseListOf([release("0.2.0", "landed")]);
    expect(versions(list.going)).toEqual(["0.2.0"]);
  });
});
