// REQ-43 on the agent report page (ISS-496 part D): the person view is the report's state and its
// summary, with the agent's detail, suggestion, signal, ids and target ref behind the Developer view
// (BC-7), and each fact said once — the state, the act, who triaged it and where it went (BC-5).
//
// @direct-test-of packages/web-v2/src/features/automation/components/report-views.tsx
// @direct-test-of packages/web-v2/src/features/automation/components/automation-item-screens.tsx

import type { Said } from "@forge/contracts/said";
import { render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "@/providers/toast-provider";
import { RULE, say, waitingOn } from "@/test/said";
import { Seeded } from "@/test/vi-chrome-requirements";
import type { ReportStanding } from "../types";
import { ReportItemScreen } from "./automation-item-screens";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn() }), usePathname: () => "/", useParams: () => ({ slug: "hop" }) }));

afterEach(() => window.history.replaceState(null, "", "/"));

const P = "p-auto";
const AT = "2026-10-07T08:00:00.000Z";
const wait = (kind: "you" | "none", who: Said) => waitingOn(kind, { who, act: say("standing.act.triageReport"), rule: RULE });

const report = (over: Partial<ReportStanding> = {}): ReportStanding =>
  ({
    id: "a1b2c3d4-report-0001",
    projectId: P,
    issueId: null,
    runId: null,
    jobId: null,
    stage: null,
    kind: "friction",
    severity: "high",
    target: "skill",
    targetRef: "issue-flow/SKILL.md",
    summary: "The skill names a verb the CLI lacks",
    writtenLang: "en",
    detail: "Evidence: runner log 12:17Z, sha f90fe200",
    suggestion: "Rename the verb in plugin/skills",
    signalKey: "self_report:skill:issue-flow:friction",
    sessionId: "s9f8e7d6-session",
    scheduleRunId: "f5e4d3c2-fire-0001",
    triage: "new",
    triagedBy: null,
    triagedAt: null,
    triageReason: null,
    duplicateOf: null,
    linkedIssueId: null,
    feedback: null,
    createdAt: AT,
    fire: { id: "f5e4d3c2-fire-0001", scheduleId: "s1", scheduleName: "nightly-digest" },
    attentionGroup: "needs_you",
    waitingOn: wait("you", say("standing.who.you")),
    ...over,
  }) as unknown as ReportStanding;

function reportPage(r: ReportStanding, view: "person" | "developer" = "person") {
  window.history.replaceState(null, "", view === "developer" ? "/?view=developer" : "/");
  return render(
    <ToastProvider>
      <Seeded
        data={[
          [["automation", P, "report", r.id], { report: r }],
          [["automation", P, "standing"], { reports: [r] }],
        ]}
      >
        <ReportItemScreen access={{ projectId: P, slug: "hop", canWrite: true, canManage: true }} reportId={r.id} />
      </Seeded>
    </ToastProvider>,
  );
}

/** The phone title restates the header for a width where the header is cut down; a count reads the desktop page. */
const desktop = () => screen.queryByTestId("detail-mobile-title")?.remove();

const AGENT_TEXT = ["Evidence: runner log 12:17Z, sha f90fe200", "Rename the verb in plugin/skills", "self_report:skill:issue-flow:friction", "issue-flow/SKILL.md", "a1b2c3d4", "f5e4d3c2", "s9f8e7d6"];

describe("an agent report's page", () => {
  it("opens on the report's state and summary, with no agent text in the person view (BC-7)", async () => {
    reportPage(report());
    const page = await screen.findByTestId("report-detail");
    const all = document.body.textContent ?? "";
    expect(all).toContain("The skill names a verb the CLI lacks");
    for (const text of AGENT_TEXT) expect(all, `"${text}" is agent text, behind the Developer view`).not.toContain(text);
    expect(within(page).queryByRole("tab", { name: "Source" })).toBeNull();
    expect(screen.getByTestId("record-view-switch")).toBeInTheDocument();
  });

  it("draws the detail, suggestion, signal, ids and target ref in the Developer view (BC-7)", async () => {
    reportPage(report(), "developer");
    const page = await screen.findByTestId("report-detail");
    const all = document.body.textContent ?? "";
    for (const text of ["Evidence: runner log 12:17Z, sha f90fe200", "Rename the verb in plugin/skills", "issue-flow/SKILL.md", "a1b2c3d4", "f5e4d3c2"])
      expect(all, `the Developer view draws "${text}"`).toContain(text);
    expect(within(page).getByRole("tab", { name: "Source" })).toBeInTheDocument();
    expect(screen.getByTestId("record-view-switch")).toBeInTheDocument();
  });

  it("says a new report's state and its one act once each (BC-5)", async () => {
    reportPage(report());
    await screen.findByTestId("report-detail");
    desktop();
    expect(screen.getAllByText("New"), "the triage state, said by the header badge alone").toHaveLength(1);
    expect(screen.getAllByRole("button", { name: "File an issue" }), "the act, in the header alone").toHaveLength(1);
    expect(screen.queryByText("State")).toBeNull();
  });

  it("says who triaged a report, why and that it can reopen, once each (BC-5)", async () => {
    reportPage(
      report({
        triage: "dismissed",
        attentionGroup: "closed",
        triagedBy: { id: "u1", name: "Lan Tran" },
        triagedAt: AT,
        triageReason: "Fixed in ISS-12",
        waitingOn: wait("none", say("standing.who.nobody")),
      }),
    );
    await screen.findByTestId("report-detail");
    desktop();
    expect(screen.getAllByText(/Lan Tran/), "who triaged it").toHaveLength(1);
    expect(screen.getAllByText(/Fixed in ISS-12/), "why").toHaveLength(1);
    expect(screen.getAllByText("Dismissed"), "the state").toHaveLength(1);
    expect(screen.getAllByRole("button", { name: "Reopen" }), "the act").toHaveLength(1);
  });
});
