// ISS-1148 (ISS-1137 outcome 6a): a project-wide wait is said once above the Feedback rows, never on
// each. Since ISS-1255 the steward has no daily budget: its runner jobs wait for the box's run slots
// like every other run, so the list says the slot wait the master standing's slot read gives, and a
// free slot (or no box read) says nothing.
// @direct-test-of packages/web-v2/src/features/feedback/components/feedback-screen.tsx
// @direct-test-of packages/web-v2/src/features/feedback/hooks.ts

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FeedbackScreen } from "@/features/feedback/components/feedback-screen";
import { FEEDBACK_SEED, P } from "@/test/vi-chrome-feedback";
import { Seeded } from "@/test/vi-chrome-requirements";

vi.mock("@/lib/navigation/router", async () => (await import("@/test/navigation")).navigationDouble());

afterEach(cleanup);

type Subagents = { held: number; inUse: number; waiting: number; capacity: number | null } | null;

const standing = (subagents: Subagents) => ({ projectId: P, state: "idle", slots: { inUse: 0, max: 2, runs: 0, undeclared: null, subagents } });

function list(subagents: Subagents) {
  return render(
    <Seeded data={[...FEEDBACK_SEED, [["runs-standing", P, "master"], standing(subagents)]]}>
      <FeedbackScreen projectId={P} slug="hop" />
    </Seeded>,
  );
}

describe("the Feedback list while the project's work waits for a run slot", () => {
  it("says once, above the rows, how much waits, with the slots in use on hover", async () => {
    list({ held: 1, inUse: 1, waiting: 2, capacity: 3 });
    const line = await screen.findByTestId("feedback-slot-wait");
    expect(line.textContent).toBe("Slot wait: 2");
    expect(line.getAttribute("title")).toBe("1 of 1 run slots in use");
    expect(screen.getAllByText(/Slot wait/)).toHaveLength(1);
  });

  it("says nothing while a slot is free, nothing waits, or the box is not read", async () => {
    for (const subagents of [{ held: 2, inUse: 1, waiting: 1, capacity: 3 }, { held: 1, inUse: 1, waiting: 0, capacity: 3 }, null]) {
      list(subagents);
      await screen.findByRole("button", { name: /new feedback/i });
      expect(screen.queryByTestId("feedback-slot-wait")).toBeNull();
      cleanup();
    }
  });
});
