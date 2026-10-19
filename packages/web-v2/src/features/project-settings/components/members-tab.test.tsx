// ISS-1421 round 3 — the add door refuses an agent account, so the picker never offers one.

import { describe, expect, it } from "vitest";
import { orgCandidatesFor } from "./members-tab";

const person = { userId: "u-1", email: "a.person@example.test" };
const agent = { userId: "u-2", email: "reviewer.0a1b2c3d4e5f@agents.forge.invalid" };
const shouted = { userId: "u-3", email: "SomeAgent@Agents.Forge.INVALID" };
const already = { userId: "u-4", email: "on.it@example.test" };

describe("the add-from-organization picker", () => {
  it("offers the org's people who are not on the project, and no agent account", () => {
    expect(orgCandidatesFor([person, agent, shouted, already], new Set(["u-4"]))).toEqual([person]);
  });
});
