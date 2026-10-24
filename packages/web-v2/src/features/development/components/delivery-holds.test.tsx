import type { OverviewHold, OverviewHolds } from "@forge/contracts/development-overview";
import type { Said } from "@forge/contracts/said";
import { fireEvent, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { renderWithQuery } from "@/test/render";
import { say, sentence, verbatim, waitingOn } from "@/test/said";
import { DeliveryHolds } from "./delivery-holds";

vi.mock("@/lib/navigation/router", async () => (await import("@/test/navigation")).navigationDouble({ useRouter: () => ({ push: vi.fn(), replace: vi.fn() }), usePathname: () => "/", useParams: () => ({ slug: "hop" }) }));

// ISS-684 (REQ-74 BC-4): the Delivery page lists each hold under its issue and under its release,
// with its cause and the agent that acts next.

const AT = "2026-10-07T08:00:00.000Z";

function holdOf(kind: OverviewHold["kind"], issue: string, release: string | null, code: string, cause: Said): OverviewHold {
  return {
    kind,
    runId: `run-${issue}`,
    issues: [issue],
    release,
    cause: sentence(cause),
    code,
    waitingOn: waitingOn("gate", { who: say("overview.hold.who.forge"), act: say("overview.hold.act.resumesWhenClear"), rule: verbatim("r") }),
    since: AT,
    says: { cause },
  };
}

const JOB = holdOf("job", "ISS-1", null, "all_devices_exhausted", say("overview.hold.cause.gate.allDevicesExhausted"));
const REL = holdOf("release", "ISS-2", "0.3.0", "NO_RUNNER_ONLINE", say("issues.releaseHold.cause.noRunnerOnline"));
const HOLDS: OverviewHolds = {
  count: 2,
  issues: [
    { key: "ISS-1", title: "First", holds: [JOB] },
    { key: "ISS-2", title: "Second", holds: [REL] },
  ],
  releases: [{ key: "0.3.0", title: "0.3.0", holds: [REL] }],
};

describe("the Delivery page's held list", () => {
  it("names each hold's kind, cause and who acts, under its issue", () => {
    renderWithQuery(<DeliveryHolds holds={HOLDS} slug="hop" />);
    const holds = screen.getAllByTestId("delivery-hold");
    expect(holds.map((h) => h.dataset.kind)).toEqual(["job", "release"]);
    expect(screen.getAllByTestId("hold-group").map((g) => g.dataset.key)).toEqual(["ISS-1", "ISS-2"]);
    expect(holds[0]?.textContent).toContain("Job hold");
    expect(holds[0]?.textContent).toContain("Every runner was busy; it retries by itself");
    expect(holds[0]?.textContent).toContain("Forge");
    expect(holds[0]?.textContent).toContain("resume it once the gate clears");
    expect(holds[1]?.textContent).toContain("No runner serving this project is online");
  });

  it("keeps each cause's code off the line, in its title for the technical reader", () => {
    renderWithQuery(<DeliveryHolds holds={HOLDS} slug="hop" />);
    const causes = screen.getAllByTestId("hold-cause");
    expect(causes.map((c) => c.getAttribute("title"))).toEqual(["all_devices_exhausted", "NO_RUNNER_ONLINE"]);
    for (const c of causes) expect(c.textContent).not.toMatch(/[a-z]+_[a-z_]+|[A-Z]{3,}_[A-Z_]+/);
  });

  it("regroups by release, leaving out a hold no release carries", () => {
    renderWithQuery(<DeliveryHolds holds={HOLDS} slug="hop" />);
    fireEvent.click(screen.getByRole("button", { name: /By release/ }));
    expect(screen.getAllByTestId("hold-group").map((g) => g.dataset.key)).toEqual(["0.3.0"]);
    expect(screen.getAllByTestId("delivery-hold").map((h) => h.dataset.kind)).toEqual(["release"]);
    expect(screen.getByText("Release 0.3.0")).toBeTruthy();
    expect(screen.getAllByTestId("delivery-hold")[0]?.textContent).toContain("ISS-2");
  });

  it("says nothing is held when no hold stands", () => {
    renderWithQuery(<DeliveryHolds holds={{ count: 0, issues: [], releases: [] }} slug="hop" />);
    expect(screen.getByText("Nothing held")).toBeTruthy();
    expect(screen.queryByTestId("delivery-holds")).toBeNull();
  });
});
