// @vitest-environment jsdom
//
// ISS-1411 — the product-map empty states open Automation at `?tab=improve`, so the screen must
// show the Improve tab, where the Standing product-map refresh switch lives, from that URL alone.

import * as matchers from "@testing-library/jest-dom/matchers";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AutomationScreen } from "./automation-screen";

expect.extend(matchers);

vi.mock("next/navigation", () => ({
  usePathname: () => "/projects/forge-dev/automation",
}));
vi.mock("@/features/schedules/components/schedules-screen", () => ({
  SchedulesScreen: () => <p>schedules tab</p>,
}));
vi.mock("@/features/improvement-messages/components/improve-screen", () => ({
  ImproveScreen: () => <p>improve tab</p>,
}));
vi.mock("@/features/feedback/components/feedback-screen", () => ({
  FeedbackScreen: () => <p>feedback tab</p>,
}));
vi.mock("./pm-screen", () => ({ PmScreen: () => <p>pm tab</p> }));

afterEach(() => {
  cleanup();
  window.history.replaceState(null, "", "/");
});

function openAt(search: string) {
  window.history.replaceState(null, "", `/projects/forge-dev/automation${search}`);
  render(<AutomationScreen scope={{ projectId: "p1", canManage: true }} />);
}

describe("Automation tab from the URL", () => {
  it("opens the Improve tab from ?tab=improve", () => {
    openAt("?tab=improve");
    expect(screen.getByText("improve tab")).toBeInTheDocument();
    expect(screen.queryByText("schedules tab")).toBeNull();
  });

  it("opens Schedules with no tab", () => {
    openAt("");
    expect(screen.getByText("schedules tab")).toBeInTheDocument();
    expect(screen.queryByText("improve tab")).toBeNull();
  });

  it("falls back to Schedules for a tab it does not have", () => {
    openAt("?tab=standing");
    expect(screen.getByText("schedules tab")).toBeInTheDocument();
  });
});
