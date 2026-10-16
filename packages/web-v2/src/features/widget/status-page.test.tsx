import { screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fakeCore, renderWithQuery } from "@/test/render";
import { WidgetStatusPage } from "./components/status-page";

// A visitor's status link: where what they sent stands, in core's one plain sentence, the phases so
// far marked, and an unknown or malformed link refused by its code.

const TOKEN = `fw_stat_${"z".repeat(43)}`;
const status = (phase: string) => ({
  feedbackKey: "FB-31",
  title: "Pay button does nothing",
  phase,
  says: "We're fixing this now.",
  filedAt: "2026-10-14T09:00:00.000Z",
  updatedAt: "2026-10-16T09:00:00.000Z",
});

afterEach(() => vi.unstubAllGlobals());

describe("the widget status page", () => {
  it("reads the token's status and marks the phases reached, the current one as the step", async () => {
    const calls = fakeCore((c) => (c.path === `/widget/status/${TOKEN}` ? { body: status("in_progress") } : undefined));
    renderWithQuery(<WidgetStatusPage token={TOKEN} />);
    expect(await screen.findByRole("heading", { name: "Pay button does nothing" })).toBeInTheDocument();
    expect(screen.getByTestId("widget-status-says")).toHaveTextContent("We're fixing this now.");
    const steps = within(screen.getByTestId("widget-status-steps")).getAllByRole("listitem");
    expect(steps.map((s) => [s.textContent, s.hasAttribute("data-done"), s.getAttribute("aria-current")])).toEqual([
      ["Received", true, null],
      ["Reviewed", true, null],
      ["In progress", true, "step"],
      ["Shipped", false, null],
    ]);
    expect(screen.getByText("Reference FB-31")).toBeInTheDocument();
    expect(calls).toHaveLength(1);
  });

  it("shows a closed one as closed, with no steps", async () => {
    fakeCore(() => ({ body: status("closed") }));
    renderWithQuery(<WidgetStatusPage token={TOKEN} />);
    expect(await screen.findByTestId("widget-status")).toHaveAttribute("data-phase", "closed");
    expect(screen.getByText("Closed")).toBeInTheDocument();
    expect(screen.queryByTestId("widget-status-steps")).toBeNull();
  });

  it("reads a link core does not know by its code", async () => {
    fakeCore(() => ({ status: 404, body: { code: "WIDGET_STATUS_UNKNOWN", message: "unknown" } }));
    renderWithQuery(<WidgetStatusPage token={TOKEN} />);
    expect(await screen.findByTestId("widget-refusal")).toHaveTextContent("We couldn't find this status link.");
  });

  it("refuses a token that is not one without asking core", async () => {
    const calls = fakeCore(() => undefined);
    renderWithQuery(<WidgetStatusPage token="fw_stat_short" />);
    expect(await screen.findByTestId("widget-refusal")).toHaveTextContent("We couldn't find this status link.");
    expect(calls).toEqual([]);
  });
});
