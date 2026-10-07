// JU-5: decisions sat on each issue, workflow and requirement with no project log. The log lists
// them newest first, each naming what it sits on, and every filter it shows is the one core reads.

import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { fakeCore, renderWithQuery } from "@/test/render";
import { ProjectDecisions } from "./project-decisions";

const decision = (id: string, key: string, scope: string, text: string) => ({
  id,
  target: { scope, id: `t-${id}`, key, title: `title ${key}` },
  intent: "decision",
  body: null,
  format: "markdown",
  decision: { decision: text, reason: "because" },
  parentId: null,
  author: { id: "u1", name: "Dana", agency: "human" },
  withheld: false,
  edited: false,
  createdAt: "2026-10-07T10:00:00Z",
  updatedAt: "2026-10-07T10:00:00Z",
});

const options = {
  requirements: [{ value: "REQ-14", label: "REQ-14 Referral reports" }],
  workflows: [{ value: "intake", label: "Intake" }],
  who: [{ value: "u1", label: "Dana" }],
};

afterEach(() => window.history.replaceState(null, "", "/"));

describe("the project's decision log", () => {
  it("lists every decision with what it sits on, and narrows to a requirement through core's own filter", async () => {
    const calls = fakeCore((c) =>
      c.path.startsWith("/projects/p1/decisions")
        ? {
            body: {
              decisions: c.path.includes("requirement=REQ-14")
                ? [decision("d1", "ISS-110", "issue", "Feedback is its own purpose")]
                : [decision("d1", "ISS-110", "issue", "Feedback is its own purpose"), decision("d2", "intake", "workflow", "Intake keeps two lanes")],
              returned: 1,
              limit: 200,
            },
          }
        : undefined,
    );
    const user = userEvent.setup();
    renderWithQuery(<ProjectDecisions projectId="p1" slug="hop" options={options} />);
    expect(await screen.findAllByTestId("decision-row")).toHaveLength(2);
    expect(screen.getAllByTestId("decision-target").map((a) => a.getAttribute("href"))).toEqual([
      "/projects/hop/issues/ISS-110",
      "/projects/hop/workflows/intake",
    ]);
    await user.click(screen.getByRole("combobox", { name: "Requirement" }));
    await user.click(await screen.findByRole("option", { name: "REQ-14 Referral reports" }));
    await waitFor(() => expect(calls.map((c) => c.path)).toContain("/projects/p1/decisions?requirement=REQ-14&limit=200"));
    await waitFor(() => expect(screen.getAllByTestId("decision-row")).toHaveLength(1));
  });

  it("reads its filters from the address, so a narrowed log can be shared", async () => {
    window.history.replaceState(null, "", "/?who=u1&since=2026-10-01&until=2026-10-07");
    const calls = fakeCore(() => ({ body: { decisions: [], returned: 0, limit: 200 } }));
    renderWithQuery(<ProjectDecisions projectId="p1" slug="hop" options={options} />);
    expect(await screen.findByText("No decision matches these filters.")).toBeInTheDocument();
    expect(calls[0]?.path).toBe("/projects/p1/decisions?who=u1&since=2026-10-01&until=2026-10-07&limit=200");
  });
});
