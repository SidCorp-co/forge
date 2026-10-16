// @vitest-environment jsdom
//
// ISS-1228 round 9 (coordinator): the sessions list named Step sessions release_batch, triage and
// drive while spend and Where time goes read the same kinds in words. Every surface that names a
// session's step kind reads it in the dashboard's words, from the one job-kinds source.

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { jobKindLabel } from "@/features/overview/job-kinds";
import { SessionsList } from "@/features/pipeline/components/sessions-list";
import { sessionName } from "@/features/pipeline/derive";
import type { LiveSession } from "@/features/pipeline/types";
import { deriveActivityFeed } from "@/features/runs/activity";
import type { PipelineRunAttempt } from "@/features/runs/types";
import { SessionsScreen } from "./components/sessions-screen";
import { type SessionRow, sessionStep, sessionTitle } from "./types";

vi.mock("next/link", () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a>,
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }), usePathname: () => "/projects/pair/agents" }));
vi.mock("@/features/projects/hooks", () => ({
  useProject: () => ({ data: { devicePool: [], defaultDeviceId: null } }),
  useProjects: () => ({ data: [{ id: "p1", slug: "pair", name: "Pair", role: "owner" }] }),
  useOrgScopedProjects: () => ({ projects: [], projectIds: new Set(["p1"]) }),
}));
vi.mock("@/features/runners/hooks", () => ({
  useDevices: () => ({ data: [] }),
  useProjectRunners: () => ({
    data: [{ runnerId: "r-d1", deviceId: "d1", deviceName: "box-a", platform: "linux", deviceStatus: "online", runnerStatus: "online", limitReason: null }],
    isError: false,
    error: null,
  }),
  useActiveRunners: () => ({ data: { runners: [], busy: 0 }, isError: false, error: null }),
}));
vi.mock("@/features/pipeline/hooks", () => ({
  useSessionsAndHolds: () => ({ data: { sessions: [], holds: [], readAt: "" }, isError: false, error: null }),
}));
vi.mock("@/lib/ws/use-room", () => ({ useRoom: () => undefined }));
const { mutation } = vi.hoisted(() => ({ mutation: () => ({ mutate: () => {}, isPending: false }) }));
vi.mock("./hooks", () => ({
  useQueueStats: () => ({ data: { devices: [] } }),
  useSessions: () => ({ data: { items: rows, totalCount: rows.length }, isLoading: false, isError: false }),
  useCancelSession: mutation,
  useRetrySession: mutation,
  useRerunSession: mutation,
  useAbortSession: mutation,
  useSweepZombies: mutation,
}));

const AT = "2026-10-16T10:00:00.000Z";
const RAW = /release_batch|review_followup|\bdrive\b|forge-code/;

function step(id: string, title: string, metadata: SessionRow["metadata"]): SessionRow {
  return {
    id,
    projectId: "p1",
    userId: null,
    deviceId: null,
    pipelineRunId: "r1",
    title,
    repoPath: null,
    status: "completed",
    kind: "pipeline",
    usage: null,
    metadata,
    failureReason: null,
    dispatchedAt: null,
    startedAt: AT,
    lastHeartbeatAt: AT,
    createdAt: AT,
    updatedAt: AT,
  } as SessionRow;
}

const rows: SessionRow[] = [
  {
    ...step("s0", "run: ISS-4", { type: "run_session" }),
    kind: "run_session",
    issues: [
      { id: "i4", displayId: "ISS-4", title: "Four" },
      { id: "i6", displayId: "ISS-6", title: "Six" },
    ],
  } as SessionRow,
  step("s1", "release_batch", { jobType: "release_batch" }),
  {
    ...step("s2", "forge-code: Fix the export", { jobType: "drive", skillName: "forge-code", issueId: "i2" }),
    issues: [{ id: "i2", displayId: "ISS-2", title: "Fix the export" }],
  } as SessionRow,
  { ...step("s5", "triage: Gone", { jobType: "triage", issueId: "i-gone" }), issues: [] } as SessionRow,
  step("s3", "review_followup_rework_after_codex_consult", { jobType: "review_followup_rework_after_codex_consult" }),
];

afterEach(cleanup);

describe("a session's step kind, wherever it is named", () => {
  it("reads a step session's title in words, keeping the issue it names", () => {
    expect(sessionTitle(rows[1])).toBe("Releases");
    expect(sessionTitle(rows[2])).toBe("Issue work: Fix the export");
    expect(sessionTitle(rows[4])).toBe("Review followup rework after codex consult");
  });

  it("prints a title someone wrote, or one with no recorded step, as written", () => {
    expect(sessionTitle(step("s4", "Nightly sweep", { jobType: "drive" }))).toBe("Nightly sweep");
    expect(sessionTitle({ ...rows[1], metadata: null })).toBe("release_batch");
    expect(sessionTitle({ ...rows[1], title: null })).toBeNull();
  });

  it("names the step a session records in words", () => {
    expect(sessionStep({ step: "release_batch" })).toBe("Releases");
    expect(sessionStep({ stage: "verify_skill" })).toBe("Skill checks");
  });

  it("names no step kind by its stored name on the sessions list", () => {
    const { container } = render(<SessionsScreen scope={{ projectId: "p1" }} />);
    expect(container.textContent).not.toMatch(RAW);
    expect(container.textContent).toContain("Releases");
    expect(container.textContent).toContain("Issue work: Fix the export");
  });

  // ISS-1228 r9: each row also wore its stored kind, `run_session` or `pipeline`, beside the words.
  it("names a session's kind only in words on the sessions list", () => {
    const { container } = render(<SessionsScreen scope={{ projectId: "p1" }} />);
    const said = container.querySelector("table")?.textContent ?? container.textContent ?? "";
    expect(said).not.toMatch(/run_session|\bpipeline\b/);
    expect(said).toContain("Run");
    expect(said).toContain("Step");
  });

  // ISS-1228 r9: "Review followup rework after codex consult: Rename the …" was cut with nothing to
  // show the rest, on a phone or anywhere else.
  it("wraps a session's title below sm and says it whole on hover where it is cut", () => {
    render(<SessionsScreen scope={{ projectId: "p1" }} />);
    for (const el of screen.getAllByText("Issue work: Fix the export")) {
      const tokens = el.className.split(/\s+/);
      expect(tokens).not.toContain("truncate");
      expect(tokens).toEqual(expect.arrayContaining(["break-words", "sm:truncate"]));
      expect(el.getAttribute("title")).toBe("Issue work: Fix the export");
    }
  });

  // ISS-1228 r9: a step row's issue chip read "Issue", naming no issue, for a session on ISS-2.
  it("names a step row's issue by its key, linking to it, and draws no chip for an issue core could not name", () => {
    const { container } = render(<SessionsScreen scope={{ projectId: "p1" }} />);
    const keys = screen.getAllByRole("link", { name: "ISS-2" });
    expect(keys.length).toBeGreaterThan(0);
    for (const key of keys) expect(key.getAttribute("href")).toBe("/projects/pair/issues/i2");
    expect(container.textContent).not.toMatch(/\bIssue\b(?! work| ·)/);
    expect(container.textContent).not.toContain("i-gone");
  });

  // ISS-1228 r10: a run session named no issue on the list, where the Pipeline page named its leases.
  it("names every issue a run session holds, each linking to that issue's page", () => {
    render(<SessionsScreen scope={{ projectId: "p1" }} />);
    for (const [key, id] of [
      ["ISS-4", "i4"],
      ["ISS-6", "i6"],
    ]) {
      const links = screen.getAllByRole("link", { name: key });
      expect(links.length).toBeGreaterThan(0);
      for (const link of links) expect(link.getAttribute("href")).toBe(`/projects/pair/issues/${id}`);
    }
  });

  it("names no step kind by its stored name on the Pipeline page", () => {
    const live = {
      id: "s1",
      kind: "pipeline",
      title: "forge-code: Fix the export",
      jobType: "drive",
      skillName: "forge-code",
      status: "running",
      runtimeState: "working",
      deviceId: null,
      deviceName: null,
      parentSessionId: null,
      startedAt: AT,
      lastHeartbeatAt: AT,
      createdAt: AT,
      issues: [],
      report: null,
    } as LiveSession;
    expect(sessionName(live)).toBe("Issue work: Fix the export");
    const { container } = render(<SessionsList sessions={[live]} slug="pair" now={Date.parse(AT)} />);
    expect(container.textContent).not.toMatch(RAW);
  });

  it("names each attempt's step in words in a run's activity", () => {
    const attempt = { jobId: "j1", jobType: "release_batch", status: "succeeded", startedAt: AT, finishedAt: AT } as PipelineRunAttempt;
    expect(deriveActivityFeed([attempt])[0]?.object).toBe(jobKindLabel("release_batch"));
  });
});
