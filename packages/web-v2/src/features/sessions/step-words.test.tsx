// @vitest-environment jsdom
//
// ISS-1228 round 9 (coordinator): the sessions list named Step sessions release_batch, triage and
// drive while spend and Where time goes read the same kinds in words. Every surface that names a
// session's step kind reads it in the dashboard's words, from the one job-kinds source.

import { cleanup, render } from "@testing-library/react";
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
vi.mock("@/features/runners/hooks", () => ({ useDevices: () => ({ data: [] }) }));
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
  step("s1", "release_batch", { jobType: "release_batch" }),
  step("s2", "forge-code: Fix the export", { jobType: "drive", skillName: "forge-code" }),
  step("s3", "review_followup_rework_after_codex_consult", { jobType: "review_followup_rework_after_codex_consult" }),
];

afterEach(cleanup);

describe("a session's step kind, wherever it is named", () => {
  it("reads a step session's title in words, keeping the issue it names", () => {
    expect(sessionTitle(rows[0])).toBe("Releases");
    expect(sessionTitle(rows[1])).toBe("Issue work: Fix the export");
    expect(sessionTitle(rows[2])).toBe("Review followup rework after codex consult");
  });

  it("prints a title someone wrote, or one with no recorded step, as written", () => {
    expect(sessionTitle(step("s4", "Nightly sweep", { jobType: "drive" }))).toBe("Nightly sweep");
    expect(sessionTitle({ ...rows[0], metadata: null })).toBe("release_batch");
    expect(sessionTitle({ ...rows[0], title: null })).toBeNull();
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
