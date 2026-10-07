import { describe, expect, it } from "vitest";
import { tourById } from "./registry";
import { offersHint, standingOf, tourStatesOf } from "./state";

const tour = { ...(tourById("integrations") as NonNullable<ReturnType<typeof tourById>>), revision: 2 };
const at = "2026-10-07T09:00:00Z";

describe("a tour's standing is per person and per revision", () => {
  it("reads finished at this revision as Seen, an older revision as Updated, and nothing or a dismissal as Not seen", () => {
    expect(standingOf(tour, { revision: 2, outcome: "completed", at })).toBe("seen");
    expect(standingOf(tour, { revision: 1, outcome: "completed", at })).toBe("updated");
    expect(standingOf(tour, { revision: 2, outcome: "dismissed", step: 2, at })).toBe("not_seen");
    expect(standingOf(tour, undefined)).toBe("not_seen");
  });

  it("offers the inline hint until the tour was finished or set aside at this revision, and again when the revision rises", () => {
    expect(offersHint(tour, undefined)).toBe(true);
    expect(offersHint(tour, { revision: 2, outcome: "dismissed", at })).toBe(false);
    expect(offersHint(tour, { revision: 2, outcome: "completed", at })).toBe(false);
    expect(offersHint(tour, { revision: 1, outcome: "completed", at })).toBe(true);
  });

  it("reads tour outcomes out of the person's product state and nothing else", () => {
    const states = tourStatesOf([
      { key: "whats_new_seen_at", value: { at }, updatedAt: at },
      { key: "tour:integrations", value: { revision: 1, outcome: "completed", at }, updatedAt: at },
    ]);
    expect([...states.keys()]).toEqual(["integrations"]);
  });
});
