// @vitest-environment jsdom
/**
 * ISS-1421 — the Activity tab says a status move in the words a person reads ("Releasing →
 * Awaiting release"), never as the stored values.
 */

import * as matchers from "@testing-library/jest-dom/matchers";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { ActivityItem } from "../types";
import { ActivityFeed } from "./activity-feed";

expect.extend(matchers);
afterEach(cleanup);

const moved = (from: string, to: string): ActivityItem =>
  ({
    id: "a1",
    action: "issue.statusChanged",
    payload: { from, to },
    createdAt: "2026-10-16T18:00:00Z",
    actorType: "user",
    actorId: "u1",
  }) as unknown as ActivityItem;

describe("a status move in the Activity tab (ISS-1421)", () => {
  it("names both statuses by their labels", () => {
    render(<ActivityFeed items={[moved("releasing", "awaiting_release")]} />);
    expect(screen.getByText("Releasing")).toBeInTheDocument();
    expect(screen.getByText("Awaiting release")).toBeInTheDocument();
    expect(screen.queryByText("releasing")).toBeNull();
    expect(screen.queryByText("awaiting_release")).toBeNull();
  });
});

// ISS-1229 r22, judge-63: comment events showed their codes.
describe("a comment event in the Activity tab", () => {
  it("reads as a sentence naming who did it, never as its code", () => {
    const by = { type: "user", id: "u1", displayName: "Another member", isAgent: false };
    render(
      <ActivityFeed
        items={[
          { ...moved("open", "in_progress"), id: "c1", action: "comment.created", payload: {}, actor: by },
          { ...moved("open", "in_progress"), id: "c2", action: "comment.mentioned", payload: { mentionedUserIds: ["x"] }, actor: by },
        ] as ActivityItem[]}
      />,
    );
    expect(screen.getByText("Another member commented")).toBeInTheDocument();
    expect(screen.getByText("Another member mentioned a member in a comment")).toBeInTheDocument();
    expect(screen.queryByText(/comment\.(created|mentioned)/)).toBeNull();
  });
});

