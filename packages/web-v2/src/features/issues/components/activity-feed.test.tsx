// @vitest-environment jsdom
//
// An `issue.updated` row carries the paths a write moved, never the fields' values: the line
// names those paths, and a row whose payload is not that shape says so instead of guessing.

import * as matchers from "@testing-library/jest-dom/matchers";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ActivityFeed } from "./activity-feed";
import type { ActivityItem } from "../types";

expect.extend(matchers);
afterEach(cleanup);

function updated(payload: Record<string, unknown>): ActivityItem {
  return {
    id: "a1",
    issueId: "i1",
    action: "issue.updated",
    actorType: "user",
    actorId: "u1",
    actor: { type: "user", id: "u1", displayName: "forge-dev agent", isAgent: true },
    payload,
    createdAt: new Date().toISOString(),
  };
}

describe("ActivityFeed — issue.updated", () => {
  it("names the paths a write moved and counts the rest", () => {
    render(
      <ActivityFeed
        items={[
          updated({
            fields: ["sessionContext", "title"],
            changes: [
              { path: ["sessionContext", "lease", "renewedAt"], op: "set", before: "a", after: "b" },
              { path: ["sessionContext", "lease", "history", 4], op: "add", after: {} },
              { path: ["title"], op: "set", before: "x", after: "y" },
              { path: ["sessionContext", "worklog", "head"], op: "set", before: "1", after: "2" },
            ],
          }),
        ]}
      />,
    );
    expect(screen.getByText("sessionContext.lease.renewedAt")).toBeInTheDocument();
    expect(screen.getByText("sessionContext.lease.history[4]")).toBeInTheDocument();
    expect(screen.getByText("title")).toBeInTheDocument();
    expect(screen.getByText("+1 more")).toBeInTheDocument();
    expect(screen.getByText("Agent")).toBeInTheDocument();
  });

  it("says no change was recorded for a payload that is not the change shape", () => {
    render(<ActivityFeed items={[updated({ fields: ["title"], before: {}, after: {} })]} />);
    expect(screen.getByText("Updated (no change recorded)")).toBeInTheDocument();
  });
});

describe("ActivityFeed — a status move", () => {
  it("draws a move once, from its status line, never again from its transition record", () => {
    const at = new Date().toISOString();
    const base = { issueId: "i1", actorType: "user", actorId: "u1", createdAt: at } as const;
    render(
      <ActivityFeed
        items={[
          { ...base, id: "a1", action: "issue.statusChanged", payload: { from: "in_progress", to: "closed" } },
          {
            ...base,
            id: "a2",
            action: "record.transition",
            payload: { writer: "core", fields: [{ key: "from", value: "in_progress" }] },
          },
        ]}
      />,
    );
    expect(screen.getAllByRole("listitem")).toHaveLength(1);
    expect(screen.queryByText(/record\.transition/i)).not.toBeInTheDocument();
  });
});
