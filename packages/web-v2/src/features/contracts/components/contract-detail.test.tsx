// @vitest-environment jsdom

import * as matchers from "@testing-library/jest-dom/matchers";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ContractStandingDetail } from "../types";
import { breaking, consumedYou, detailOf, row } from "./contract-fixtures";
import { ContractPage, type ContractTab } from "./contract-detail";

expect.extend(matchers);
afterEach(cleanup);
beforeEach(() => window.history.replaceState(null, "", "/projects/hop/contracts/bookings/book-follow-up"));

const push = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));

const wrap = (n: ReactNode) => <QueryClientProvider client={new QueryClient()}>{n}</QueryClientProvider>;
const page = (d: ContractStandingDetail, tab: ContractTab = "overview", onTab = vi.fn()) =>
  render(wrap(<ContractPage d={d} slug="hop" projectId="p" tab={tab} onTab={onTab} />));

describe("ContractPage", () => {
  it("states whom it waits on once, in the banner, with the item it points at", () => {
    page(detailOf(consumedYou));
    const banner = screen.getByTestId("contract-banner");
    expect(banner.textContent).toContain("Waiting on you:");
    expect(banner.textContent).toContain("adapt to 2.0.0 by 2099-11-02");
    expect(within(banner).getByRole("link", { name: "FB-37" })).toHaveAttribute("href", "/projects/hop/feedback/FB-37");
  });

  it("draws provider, contract and consumers with each consumer's adoption as a badge", () => {
    page(detailOf(consumedYou));
    const pcc = screen.getByTestId("pcc");
    expect(pcc.textContent).toContain("bookings");
    expect(screen.getAllByTestId("pcc-consumer").map((c) => c.textContent)).toEqual([
      "hopthis projecton 1.4.0⏳Must adapt",
      "clinic-crmon 1.3.0⏳Must adapt",
    ]);
    expect(screen.getAllByTestId("timeline-mark")).toHaveLength(2);
  });

  it("puts versions, adoption and measurements behind tabs, measurements only for the provider", () => {
    const onTab = vi.fn();
    page(detailOf(consumedYou), "overview", onTab);
    const tabs = screen.getByTestId("contract-tabs");
    expect(within(tabs).queryByText("Measurements")).toBeNull();
    fireEvent.click(within(tabs).getByText("Versions"));
    expect(onTab).toHaveBeenCalledWith("versions");
    cleanup();
    page(detailOf(breaking, { measurements: [] }));
    expect(within(screen.getByTestId("contract-tabs")).getByText("Measurements")).toBeInTheDocument();
  });

  it("lists every version with its measured classification and the changes behind an expander", () => {
    page(detailOf(consumedYou), "versions");
    const rows = screen.getAllByTestId("version-row");
    expect(rows).toHaveLength(2);
    expect(rows[0]?.textContent).toContain("Breaking");
    expect(rows[0]?.textContent).not.toContain("non-breaking");
    expect(within(rows[0] as HTMLElement).getByText("1 change").closest("details")).not.toHaveAttribute("open");
  });

  it("offers approve and return on a proposed version only where it waits on the viewer", () => {
    const pending = row("reminder-tools", {
      state: "proposed",
      attentionGroup: "needs_you",
      pending: { version: "1.7.0", recordedAt: "2026-10-03T00:00:00.000Z", classification: "non-breaking", approval: "proposed", decidedAt: null },
      waitingOn: { kind: "you", who: "You", act: "approve or return 1.7.0 · measured non-breaking", rule: "r", ref: "1.7.0" },
    });
    const proposed = { version: "1.7.0", recordedAt: "2026-10-03T00:00:00.000Z", classification: "non-breaking", approval: "proposed", decidedAt: null };
    const versions = [
      { ...proposed, previous: "1.6.0", changes: [], decisionReason: null },
      { version: "1.6.0", recordedAt: "2026-09-12T00:00:00.000Z", classification: "non-breaking", approval: "approved", decidedAt: "2026-09-12T00:00:00.000Z", previous: null, changes: [], decisionReason: null },
    ];
    page(detailOf(pending, { versions }), "versions");
    expect(screen.getByTestId("approve-version")).toHaveTextContent("Approve 1.7.0");
    cleanup();
    page(detailOf({ ...pending, attentionGroup: "waiting", waitingOn: { ...pending.waitingOn, kind: "person", who: "An org admin" } }, { versions }), "versions");
    expect(screen.queryByTestId("approve-version")).toBeNull();
  });

  it("keeps the rail to relations and properties: waits, feedback, requirement, thread", () => {
    page(detailOf(consumedYou));
    const rail = screen.getByTestId("relations-rail");
    expect(within(rail).getByTestId("facts-waits").textContent).toContain("ISS-1402");
    expect(within(rail).getByTestId("facts-feedback").textContent).toContain("FB-37");
    expect(within(rail).getByTestId("facts-requirement").textContent).toContain("bookings REQ-31");
    expect(within(rail).getByTestId("facts-thread").textContent).toContain("HOP-CR-3");
    expect(within(rail).getByTestId("facts-properties").textContent).toContain("We use 1.4.0");
  });

  it("counts a provider's consumer demand without naming the consumer's issues", () => {
    page(detailOf(breaking, { waits: [], feedback: [], demand: [{ project: { id: "c", slug: "clinic-crm", name: "clinic-crm" }, issues: 2, minVersions: ["2.0.0"] }] }));
    const demand = screen.getByTestId("facts-demand");
    expect(demand.textContent).toContain("clinic-crm2 issues need ≥ 2.0.0");
    expect(demand.textContent).not.toMatch(/ISS-/);
  });
});
