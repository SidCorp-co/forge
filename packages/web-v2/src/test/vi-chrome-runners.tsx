import type { QueryKey } from "@tanstack/react-query";
import { fireEvent } from "@testing-library/react";
import { PoolReadBanner } from "@/features/runners/components/pool-read";
import { ProjectRunnersScreen } from "@/features/runners/components/project-runners-screen";
import { RunnerRow } from "@/features/runners/components/runner-row/runner-row";
import { RunnersScreen } from "@/features/runners/components/runners-screen";
import type { DeviceRow, ProjectRunner, RunnerPoolRead } from "@/features/runners/types";
import { type ProductCopyKey, productCopy } from "@/lib/i18n/product-copy";
import { Seeded } from "./vi-chrome-requirements";

// The Runners screens for the vi walking test: the device fleet, a device's detail, a project's
// runners with every condition a row can carry. Content is placeholder names; a box's own refusal
// text (a limit detail, a failed read's status) stays as the box wrote it.

const P = "p1";
const NOW = Date.now();
const ago = (min: number) => new Date(NOW - min * 60_000).toISOString();
const ahead = (min: number) => new Date(NOW + min * 60_000).toISOString();

const device = (n: number, over: Partial<DeviceRow> = {}): DeviceRow =>
  ({
    ownedByMe: true,
    id: `d${n}`,
    name: `box-${n}`,
    platform: "linux",
    agentVersion: "0.4.0",
    agentCommit: "abc1234",
    latestAgentVersion: "0.4.1",
    latestAgentCommit: "def5678",
    mainRunnerHead: "def5678",
    agentBuildState: "behind",
    runnerReleaseState: "current",
    agentBuildDetail: "",
    agentOutdated: false,
    status: "online",
    disabledAt: null,
    lastSeenAt: ago(2),
    pairedAt: ago(60 * 24 * 3),
    capabilities: null,
    gate: { verdict: "failing_open", count: 12, trimmed: false, perDay: 4, windowMs: 3 * 86_400_000, sinceLastMs: 60_000, byReason: [{ reason: "core-unreachable", count: 9 }, { reason: "timeout", count: 3 }], receivedAt: ago(30) },
    binaries: { missing: [{ name: "node", detail: "ENOENT node" }], receivedAt: ago(30) },
    disk: {
      receivedAt: ago(30),
      verdict: "tight",
      tightFreePercent: 15,
      criticalFreePercent: 5,
      roots: [
        { root: "/tmp", bytesFree: 2 * 1024 ** 3, bytesTotal: 20 * 1024 ** 3, inodesFree: 90_000, inodesTotal: 1_000_000, bytesFreePercent: 10, inodesFreePercent: 9, verdict: "tight", axis: "inodes" },
        { root: "/srv", refused: "statfs EACCES", bytesFreePercent: null, inodesFreePercent: null, verdict: "unmeasurable", axis: null },
      ],
    },
    createdAt: ago(60 * 24 * 3),
    ...over,
  }) as DeviceRow;

const DEVICES = [
  device(1, { agentOutdated: true }),
  device(2, { agentBuildState: "unknown", agentVersion: null, status: "offline", disabledAt: ago(10), binaries: null, gate: null, disk: null }),
  device(3, { status: "revoked", ownedByMe: false }),
];

const runner = (n: number, over: Partial<ProjectRunner> = {}): ProjectRunner =>
  ({
    runnerId: `r${n}`,
    deviceId: `d${n}`,
    deviceName: `box-${n}`,
    platform: "linux",
    deviceStatus: "online",
    agentVersion: "0.4.0",
    deviceDisabledAt: null,
    runnerStatus: "online",
    lastError: null,
    limitReason: null,
    rateLimitedUntil: null,
    limitDetail: null,
    limitRefusedAt: null,
    limitPrintedResetAt: null,
    repoPath: "/srv/hop",
    branch: "main",
    labels: [],
    lastSeenAt: ago(1),
    provisionStatus: "ready",
    provisionDetail: null,
    provisionedAt: ago(100),
    residentMaster: null,
    poolRead: null,
    ...over,
  }) as ProjectRunner;

const RUNNERS = [
  runner(1, { limitReason: "usage_limit", limitRefusedAt: ago(18), rateLimitedUntil: ahead(3), limitPrintedResetAt: ahead(190), limitDetail: "session limit · resets 2:30am", labels: ["gpu"], residentMaster: { sessionId: "s1", name: "hop-master", lastHeartbeatAt: ago(1) } as never }),
  runner(2, { deviceDisabledAt: ago(5), provisionStatus: "syncing_skills", repoPath: null, lastError: "exit 1", runnerStatus: "draining", residentMaster: undefined, agentVersion: null }),
  runner(3, { limitReason: "auth", provisionStatus: "failed", provisionDetail: null, runnerStatus: "disabled" }),
  runner(4, { provisionStatus: null, deviceName: null, lastSeenAt: null }),
];

const blind: RunnerPoolRead = {
  verdict: "blind",
  failures: 7,
  countIsFloor: false,
  windowMs: 86_400_000,
  unreadSince: NOW - 20 * 60_000,
  consecutive: 7,
  recoveredAt: null,
  lastFailure: { at: NOW - 60_000, status: 503, what: "503 Service Unavailable", reason: "x" },
  receivedAt: new Date(NOW - 60_000).toISOString(),
};

const fleet = (): [QueryKey, unknown][] => [[["devices", "me", null], DEVICES]];
const projectQueries = (): [QueryKey, unknown][] => [
  [["devices", "me", null], DEVICES],
  [["projects", P, "runners"], RUNNERS],
  [["projects", P, "active-runners"], { runners: [{ runnerId: "r1", name: "box-1", status: "online", lastSeenAt: ago(1), current: { jobId: "j1", stage: "code", startedAt: ago(4), issueId: "i1", issueRef: "ISS-1", issueTitle: "Muc mot" } }], busy: 1, total: 4 }],
  [["project", P], { id: P, slug: "hop", name: "Hop" }],
  [["runners", "r2", "activity"], { events: [{ id: "e1", oldStatus: "offline", newStatus: "online", reason: "operator_patch", ts: ago(30) }], sessions: [{ id: "s1", title: null, status: "failed", failureReason: "provider_usage_limit", errorExcerpt: "API Error: 429", updatedAt: ago(20) }], retentionDays: 30 }],
  [["runners", "r1", "activity"], { events: [], sessions: [], retentionDays: 30 }],
  [["devices", "d1", "runners"], [{ runnerId: "r1", projectId: P, slug: "hop", name: "Hop", repoPath: "/srv/hop", branch: "main", status: "online", lastSeenAt: ago(1), baseBranch: "main" }]],
];

// a button found by its label in either language: the rail test draws each screen in en as well
const clickKey = (key: ProductCopyKey, nth = 0) => () => {
  const labels = [productCopy("vi")(key), productCopy("en")(key)];
  const hits = [...document.querySelectorAll("button")].filter((b) => labels.includes(b.textContent?.trim() ?? ""));
  const el = hits[nth];
  if (!el) throw new Error(`nothing to open labelled ${key}`);
  fireEvent.click(el);
};

export const RUNNER_SCREENS = [
  { name: "Runners", render: () => <Seeded data={fleet()}><RunnersScreen /></Seeded> },
  { name: "Runners · device detail", render: () => <Seeded data={projectQueries()}><RunnersScreen /></Seeded>, act: clickKey("runners.device.manage") },
  { name: "Runners · revoke", render: () => <Seeded data={fleet()}><RunnersScreen /></Seeded>, act: clickKey("runners.device.revoke") },
  { name: "Runners · empty", render: () => <Seeded data={[[["devices", "me", null], []]]}><RunnersScreen /></Seeded> },
  { name: "Project runners", render: () => <Seeded data={projectQueries()}><ProjectRunnersScreen projectId={P} canEdit /></Seeded> },
  { name: "Project runners · empty", render: () => <Seeded data={[[["projects", P, "runners"], []], [["devices", "me", null], []]]}><ProjectRunnersScreen projectId={P} canEdit={false} /></Seeded> },
  {
    name: "Runner row · activity and labels",
    render: () => (
      <Seeded data={projectQueries()}>
        <RunnerRow runner={RUNNERS[1] as ProjectRunner} current={null} projectId={P} canEdit slug="hop" />
        <PoolReadBanner poolRead={blind} now={NOW} />
        <PoolReadBanner poolRead={{ ...blind, receivedAt: new Date(NOW - 3_600_000).toISOString() }} now={NOW} />
        <PoolReadBanner poolRead={{ ...blind, verdict: "intermittent", countIsFloor: true, recoveredAt: NOW - 30_000 }} now={NOW} />
        <PoolReadBanner poolRead={{ ...blind, verdict: "intermittent", windowMs: 1_800_000, recoveredAt: NOW - 30_000, receivedAt: new Date(NOW - 3_600_000).toISOString() }} now={NOW} />
      </Seeded>
    ),
    act: () => {
      clickKey("runners.row.activity")();
      clickKey("runners.labels.add")();
    },
  },
  { name: "Runner row · unassign", render: () => <Seeded data={projectQueries()}><RunnerRow runner={RUNNERS[0] as ProjectRunner} current={null} projectId={P} canEdit slug="hop" /></Seeded>, act: clickKey("runners.row.unassign") },
];
