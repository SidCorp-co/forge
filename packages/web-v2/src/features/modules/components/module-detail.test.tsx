// @vitest-environment jsdom
//
// A module's full page: three views beside one rail. What core has no data for reads "Not available" with its
// reason on hover, never an invented value; each fact is stated in one place.

import * as matchers from "@testing-library/jest-dom/matchers";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ModuleDetail } from "../types";
import { detail, needsYou, standing } from "./module-fixtures";
import { ModulePage } from "./module-detail";

expect.extend(matchers);
afterEach(cleanup);
beforeEach(() => window.history.replaceState(null, "", "/projects/hop/modules/outreach"));

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));

const LANDING = {
  issueKey: "ISS-2",
  title: "Reminder schedule as states",
  landedAt: "2026-10-01T00:00:00.000Z",
  commitSha: "abcdef1234",
  target: "dev",
  landing: null,
  release: "1.4.0",
  modulePath: "outreach/zalo",
};

function page(d: ModuleDetail, tab: "overview" | "code" | "landings" = "overview") {
  return render(<ModulePage d={d} slug="hop" tab={tab} onTab={() => {}} />);
}

describe("ModulePage overview", () => {
  it("draws open issues by state, the 14-day activity, and no banner for a quiet module", () => {
    page(detail({ standing: standing() }));
    expect(screen.getByText("Nothing is open in this module.")).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "4 events in the last 14 days" })).toBeInTheDocument();
    expect(screen.queryByTestId("module-banner")).toBeNull();
  });

  it("draws the legend of what is open and the banner of what waits on you", () => {
    page(detail());
    const bar = screen.getByTestId("coverage-bar");
    expect(bar.textContent).toContain("Needs you 1");
    expect(bar.textContent).toContain("Moving 1");
    expect(screen.getByTestId("module-banner").textContent).toBe("Waiting on you: ISS-5 make a decision");
  });

  it("says no knowledge entry is linked, with the reason on hover, where there is no purpose", () => {
    page(detail());
    const n = within(screen.getByTestId("module-purpose")).getByTestId("not-available");
    expect(n.textContent).toBe("Not available: no knowledge entry is linked to this module");
    expect(n.getAttribute("title")).toBe("No knowledge entry is linked to this module");
  });

  it("shows the purpose from the knowledge entry, with the whole entry behind an expander", () => {
    page(
      detail({
        purpose: { available: true, value: { entrySlug: "module-outreach", title: "Outreach", summary: "Schedules the calls.", body: "# Outreach\n\nSchedules the calls.\n\nMore.", bodyTruncated: false, updatedAt: "2026-10-01T00:00:00.000Z" } },
      }),
    );
    const p = screen.getByTestId("module-purpose");
    expect(p.textContent).toContain("From module-outreach");
    expect(p.textContent).toContain("Schedules the calls.");
    expect(p.textContent).toContain("Read the whole entry");
  });
});

describe("ModulePage code", () => {
  it("lists the paths the entry cites, or says why it cannot", () => {
    const { unmount } = page(detail({ keyPaths: { available: true, value: ["src/a.ts", "src/b/"] } }), "code");
    expect(screen.getByTestId("key-paths").textContent).toBe("src/a.tssrc/b/");
    unmount();
    page(detail({ keyPaths: { available: false, reason: "the knowledge entry cites no file path in code spans" } }), "code");
    expect(within(screen.getByTestId("view-code")).getByTestId("not-available").getAttribute("title")).toBe("The knowledge entry cites no file path in code spans");
  });

  it("keeps declared couplings and those seen only in the issue stream apart", () => {
    const other = { id: "o", slug: "his", name: "HIS events", path: "intake/his" };
    page(
      detail({
        couplings: {
          declared: [{ module: other, source: "declared", predicate: "consumes", direction: "out", issueCount: null, recentIssueKeys: [] }],
          observed: [{ module: { ...other, slug: "zalo", path: "outreach/zalo" }, source: "issue_stream", predicate: null, direction: null, issueCount: 4, recentIssueKeys: ["ISS-11"] }],
        },
      }),
      "code",
    );
    const rows = screen.getAllByTestId("coupling-row");
    expect(rows[0]?.textContent).toContain("consumes →");
    expect(rows[0]?.textContent).toContain("intake/his");
    expect(rows[1]?.textContent).toContain("Shared by 4 issues");
    expect(within(rows[1] as HTMLElement).getByRole("link", { name: "ISS-11" })).toHaveAttribute("href", "/projects/hop/issues/ISS-11");
  });

  it("says nothing is coupled when nothing is", () => {
    page(detail(), "code");
    expect(screen.getByText("No coupling is declared, and the issue stream shows none.")).toBeInTheDocument();
  });
});

describe("ModulePage landings", () => {
  it("lists what landed with its release and, for a child module, where", () => {
    page(detail({ landings: { total: 12, recent: [LANDING] } }), "landings");
    const row = screen.getByTestId("landing-row");
    expect(row.textContent).toContain("ISS-2");
    expect(row.textContent).toContain("Reminder schedule as states");
    expect(row.textContent).toContain("1.4.0");
    expect(row.textContent).toContain("outreach/zalo");
    expect(screen.getByText("The latest 1 of 12 landings.")).toBeInTheDocument();
  });

  it("says nothing has landed, and that a landing is not yet in a release", () => {
    const { unmount } = page(detail(), "landings");
    expect(screen.getByText("Nothing has landed in this module yet.")).toBeInTheDocument();
    unmount();
    page(detail({ landings: { total: 1, recent: [{ ...LANDING, release: null, modulePath: "outreach" }] } }), "landings");
    expect(screen.getByTestId("landing-row").textContent).toContain("Not yet");
  });
});

describe("ModulePage rail", () => {
  it("says Not available, with each reason, for contracts and the owner", () => {
    page(detail());
    const titles = screen.getAllByTestId("not-available").map((n) => n.getAttribute("title"));
    expect(titles).toContain("A contract names no module in its interface document");
    expect(titles).toContain("A module label records no owner");
  });

  it("lists active issues, traced requirements with their criteria, and open feedback", () => {
    page(
      detail({
        standing: { ...needsYou, requirements: [{ key: "REQ-12", title: "Care journey", criteria: ["BC-1", "BC-3"] }] },
        issues: [{ key: "ISS-5", title: "Decide the template", status: "needs_info", tone: "you", step: null, attentionGroup: "needs_you", waitingOn: needsYou.waitingOn, modulePath: "outreach" }],
        feedback: [{ key: "FB-3", title: "Wrong time", phase: "triaged" }],
      }),
    );
    const rail = screen.getByTestId("relations-rail");
    expect(within(rail).getByRole("link", { name: "ISS-5" })).toHaveAttribute("href", "/projects/hop/issues/ISS-5");
    expect(within(rail).getByRole("link", { name: "REQ-12" })).toHaveAttribute("href", "/projects/hop/requirements/REQ-12");
    expect(within(rail).getByTestId("rail-requirement").textContent).toContain("BC-1 BC-3");
    expect(within(rail).getByRole("link", { name: "FB-3" })).toHaveAttribute("href", "/projects/hop/feedback/FB-3");
  });

  it("folds issues past the eighth behind one expander", () => {
    const issues = Array.from({ length: 11 }, (_, i) => ({
      key: `ISS-${i + 1}`,
      title: `t${i}`,
      status: "open" as const,
      tone: "ready" as const,
      step: null,
      attentionGroup: "queued" as const,
      waitingOn: needsYou.waitingOn,
      modulePath: "outreach",
    }));
    page(detail({ issues }));
    expect(screen.getByText("Show 3 more")).toBeInTheDocument();
    expect(screen.getAllByTestId("rail-issue")).toHaveLength(11);
    fireEvent.click(screen.getByText("Show 3 more"));
  });

  it("links the parent and children by path and names the linked knowledge entry", () => {
    page(
      detail({
        module: { ...detail().module, parent: { id: "p", slug: "intake", name: "Intake", path: "intake" }, children: [{ id: "c", slug: "zalo", name: "Zalo", path: "outreach/zalo" }] },
        purpose: { available: true, value: { entrySlug: "module-outreach", title: "Outreach", summary: "s", body: "s", bodyTruncated: false, updatedAt: "2026-10-01T00:00:00.000Z" } },
      }),
    );
    const props = screen.getByTestId("facts-properties");
    expect(within(props).getByRole("link", { name: "intake" })).toHaveAttribute("href", "/projects/hop/modules/intake");
    expect(within(props).getByRole("link", { name: "outreach/zalo" })).toHaveAttribute("href", "/projects/hop/modules/zalo");
    expect(props.textContent).toContain("module-outreach");
  });
});
