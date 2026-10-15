// @vitest-environment jsdom
//
// One running session, silent ninety seconds: every surface that shows it names that silence with
// the word the Pipeline page uses, so a surface carrying a word of its own goes red here.

import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { StatusChip } from "@/design";
import { silenceText } from "@/features/agents/run-state";
import type { RunSessionRow } from "@/features/agents/types";
import { SessionsList } from "@/features/pipeline/components/sessions-list";
import type { LiveSession } from "@/features/pipeline/types";
import { LiveSessionsCard } from "@/features/project-dashboard/components/live-sessions-card";
import { FleetStrip } from "./components/fleet-strip";
import { deriveSessionDisplayStatus, type SessionRow, statusToChip } from "./types";

vi.mock("next/link", () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a>,
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("@/features/projects/hooks", () => ({
  useProject: () => ({
    data: { devicePool: [{ id: "d1", name: "box-a", platform: "linux", status: "online" }], defaultDeviceId: "d1" },
  }),
}));
vi.mock("./hooks", () => ({ useQueueStats: () => ({ data: { devices: [] } }) }));

const NOW = Date.parse("2026-10-15T10:00:00.000Z");
const SILENT_SINCE = new Date(NOW - 90_000).toISOString();
const STARTED = new Date(NOW - 30 * 60_000).toISOString();

const live: LiveSession = {
  id: "s1",
  kind: "run_session",
  title: "run: ISS-3",
  status: "running",
  runtimeState: "working",
  deviceId: "d1",
  deviceName: "box-a",
  parentSessionId: null,
  startedAt: STARTED,
  lastHeartbeatAt: SILENT_SINCE,
  createdAt: STARTED,
  issues: [],
  report: null,
};

const row: SessionRow = {
  id: "s1",
  projectId: "p1",
  userId: null,
  deviceId: "d1",
  pipelineRunId: "r1",
  title: "run: ISS-3",
  repoPath: null,
  status: "running",
  kind: "run_session",
  usage: null,
  metadata: { type: "run_session" },
  failureReason: null,
  dispatchedAt: null,
  startedAt: STARTED,
  lastHeartbeatAt: SILENT_SINCE,
  createdAt: STARTED,
  updatedAt: SILENT_SINCE,
};

const run = {
  incarnation: "live",
  lastActivityAt: SILENT_SINCE,
} as RunSessionRow;

/** The word a surface puts before its " · " qualifier, or its whole text where it has none. */
function wordOf(text: string): string {
  return text.split(" · ")[0].trim();
}

afterEach(cleanup);

describe("the word for a running session gone silent", () => {
  it("is the Pipeline page's word on the session chip, the dashboard, the runner strip and the Agents runs line", () => {
    const { container: pipeline } = render(<SessionsList sessions={[live]} slug="pair" now={NOW} />);
    const quiet = [...pipeline.querySelectorAll("span")].find((s) => /^\S+ · \d+\S* ago$/.test(s.textContent ?? ""));
    const word = wordOf(quiet?.textContent ?? "");
    cleanup();

    render(<StatusChip status={statusToChip(deriveSessionDisplayStatus(row, NOW))} domain="session" />);
    const chip = document.body.textContent ?? "";
    cleanup();

    const { container: card } = render(<LiveSessionsCard sessions={[live]} slug="pair" now={NOW} read={{ read: "ok" }} />);
    const cardWord = [...card.querySelectorAll("span")].map((s) => s.textContent ?? "").find((t) => /^\S+ · \d+\S* ago$/.test(t));
    cleanup();

    const { container: fleet } = render(
      <FleetStrip projectId="p1" rows={[row]} displays={[deriveSessionDisplayStatus(row, NOW)]} now={NOW} />,
    );
    // The strip marks a silent box with one amber word beside its step.
    const strip = [...fleet.querySelectorAll<HTMLElement>("span.fg-caption")].find((s) =>
      s.style.color.includes("amberw-600"),
    )?.textContent;
    cleanup();

    expect({
      chip: wordOf(chip),
      dashboard: wordOf(cardWord ?? ""),
      runnerStrip: strip,
      agentsRuns: wordOf(silenceText(run, NOW) ?? ""),
    }).toEqual({ chip: word, dashboard: word, runnerStrip: word, agentsRuns: word });
    expect(word).not.toBe("");
  });
});
