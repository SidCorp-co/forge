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
