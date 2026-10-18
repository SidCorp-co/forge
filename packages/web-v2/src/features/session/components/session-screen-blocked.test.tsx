// @vitest-environment jsdom
//
// ISS-1228 round 8 — the session page itself, with a session its box reports blocked: the page's own
// composer takes no message, by key or by button, and says why; its chip and turn line say Blocked
// with no spinner. Driven through `SessionScreen`, so a page that stopped wiring the hold goes red.

import * as matchers from "@testing-library/jest-dom/matchers";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionRow } from "@/features/sessions/types";
import { WORKING_WORD } from "@/design";
import { SessionScreen } from "./session-screen";
import { BLOCKED_HOLD } from "./turn-stage";
import { LAST_TURN_SHOWS_WHERE } from "./context-rail";

expect.extend(matchers);

const NOW = Date.parse("2026-10-16T08:00:00.000Z");
const { send, stopSession, idle, page, box } = vi.hoisted(() => ({
  send: vi.fn(),
  stopSession: vi.fn(),
  idle: () => ({ mutate: () => {}, mutateAsync: async () => {}, isPending: false }),
  page: { session: undefined as unknown },
  box: { status: "online" as "online" | "offline" },
}));
const read = (data: unknown) => ({ data, isError: false, error: null, isLoading: false });

const session: SessionRow = {
  id: "s1",
  projectId: "p1",
  userId: null,
  deviceId: "d1",
  pipelineRunId: null,
  title: "run: ISS-3",
  repoPath: null,
  status: "running",
  kind: "run_session",
  usage: null,
  metadata: { type: "run_session" },
  failureReason: null,
  dispatchedAt: null,
  startedAt: new Date(NOW - 30 * 60_000).toISOString(),
  lastHeartbeatAt: new Date(NOW - 5_000).toISOString(),
  createdAt: new Date(NOW - 30 * 60_000).toISOString(),
  updatedAt: new Date(NOW - 5_000).toISOString(),
  report: {
    incarnation: "live",
    work: "blocked",
    blockerKind: "human",
    waitingOn: "approve the database restore in Coolify",
    observedAt: new Date(NOW - 5_000).toISOString(),
    since: new Date(NOW - 5_000).toISOString(),
  },
};
page.session = session;

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }), usePathname: () => "/projects/qa/agents/s1" }));
vi.mock("next/link", () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a>,
}));
vi.mock("@/providers/toast-provider", () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock("@/features/shell", () => ({ useRecents: () => ({ push: vi.fn() }), buildShareLink: (p: string) => p }));
vi.mock("@/features/projects/hooks", () => ({
  useProjects: () => ({ data: [{ id: "p1", slug: "qa", name: "QA", role: "owner" }] }),
}));
vi.mock("@/lib/ws/use-room", () => ({ useRoom: () => undefined }));
vi.mock("@/features/pipeline/hooks", () => ({ useSessionsAndHolds: () => read({ sessions: [], holds: [], runningChats: [] }) }));
vi.mock("@/features/runs/hooks", () => ({ useRun: () => ({ data: undefined, isLoading: false }) }));
vi.mock("@/features/runners/hooks", () => ({
  useDevices: () => read([{ id: "d1", name: "bravo", platform: "linux", agentVersion: "0.99.0", status: box.status }]),
  useProjectRunners: () =>
    read([{ runnerId: "r1", deviceId: "d1", deviceName: "bravo", platform: "linux", deviceStatus: box.status, runnerStatus: "online", limitReason: null, rateLimitedUntil: null, labels: [] }]),
  useActiveRunners: () => read({ runners: [] }),
}));
vi.mock("@/features/sessions/hooks", () => ({
  useSessionCost: () => ({ data: undefined, isLoading: false }),
  useQueueStats: () => read({ devices: [] }),
  useSessions: () => ({ data: { items: [], totalCount: 0 }, isLoading: false }),
}));
vi.mock("../hooks", () => ({
  useSession: () => ({ data: page.session, isLoading: false, isError: false }),
  useSessionTurns: () => ({ data: { turns: [] }, isLoading: false, isSuccess: true }),
  useSendMessage: () => ({ ...idle(), mutateAsync: send }),
  useRegenerateTurn: idle,
  useEditTurn: idle,
  useForkSession: idle,
  useCancelSession: () => ({ ...idle(), mutate: stopSession }),
  useRerunSession: idle,
}));

beforeEach(() => {
  // jsdom lays nothing out, so it has no scrollIntoView for the thread's bottom anchor.
  Element.prototype.scrollIntoView = () => {};
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  send.mockReset();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("a blocked session's own page (ISS-1228 criteria 40, 41)", () => {
  it("takes no message from its composer, by key or by button, and says why", () => {
    render(<SessionScreen sessionId="s1" projectSlug="qa" />);
    const box = screen.getByLabelText("Message");
    fireEvent.change(box, { target: { value: "are you there?" } });
    fireEvent.keyDown(box, { key: "Enter" });
    fireEvent.click(screen.getByLabelText("Send message"));
    expect(send).not.toHaveBeenCalled();
    expect(screen.getByLabelText("Send message")).toBeDisabled();
    expect(screen.getByText(BLOCKED_HOLD)).toBeVisible();
  });

  it("says Blocked in the box's words, and claims no work or spinner anywhere on the page", () => {
    render(<SessionScreen sessionId="s1" projectSlug="qa" />);
    expect(screen.getByTestId("turn-stage")).toHaveTextContent(
      "Blocked. Waiting on a person. Approve the database restore in Coolify.",
    );
    expect(screen.queryByText(/Working/)).not.toBeInTheDocument();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(screen.getAllByText("Blocked").length).toBeGreaterThan(0);
  });
});

// ISS-1228 r9: a step session's page at phone width drew Stop and Open issue over its title, so the
// step's words were on the page and nobody could read them.
describe("a session page's header at phone width", () => {
  it("lets its title wrap rather than truncate", () => {
    render(<SessionScreen sessionId="s1" projectSlug="qa" />);
    const title = screen.getByRole("heading", { name: "run: ISS-3" });
    expect(title.className).not.toMatch(/\btruncate\b/);
    expect(title.className).toContain("break-words");
  });

  it("puts its actions on a row of their own below sm", () => {
    render(<SessionScreen sessionId="s1" projectSlug="qa" />);
    const actions = screen.getByRole("button", { name: "Stop session" }).parentElement;
    expect(actions?.className.split(/\s+/)).toContain("basis-full");
    expect(actions?.parentElement?.className.split(/\s+/)).toContain("flex-wrap");
  });
});

// ISS-1228 round 13: judge-34's press of Stop session ended a running agent with nothing asked.
describe("stopping a session from its page", () => {
  it("asks first, naming the session and its box, and stops it only on the answer", () => {
    stopSession.mockClear();
    render(<SessionScreen sessionId="s1" projectSlug="qa" />);
    fireEvent.click(screen.getByRole("button", { name: "Stop session" }));
    expect(stopSession).not.toHaveBeenCalled();
    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveTextContent("Session ISS-3 on bravo stops now.");
    fireEvent.click(within(dialog).getByRole("button", { name: "Stop session" }));
    expect(stopSession).toHaveBeenCalledTimes(1);
  });
});

// ISS-1228 round 10: the page's chip and turn line said Working while the Pipeline page said what the
// session was doing; the page reads `sessionWord` like every other surface (criterion 62).
describe("a session's own page says what it is doing (ISS-1228 round 10)", () => {
  it.each([
    ["starting", "Starting"],
    ["awaiting_input", "Waiting for input"],
    ["checkpointing", "Checkpointing"],
    ["closed", "Closing"],
  ])("at %s, its chip and its turn line both say %s, and nothing says Working", (runtimeState, word) => {
    page.session = { ...session, runtimeState, report: null };
    try {
      render(<SessionScreen sessionId="s1" projectSlug="qa" />);
      expect(screen.getByTestId("turn-stage")).toHaveTextContent(word);
      expect(screen.getAllByText(word).length).toBeGreaterThan(1);
      expect(screen.queryByText(new RegExp(WORKING_WORD))).not.toBeInTheDocument();
    } finally {
      page.session = session;
    }
  });
});

// ISS-1228 r11 repair: an ended session's turn line ran its clock to the moment the page loaded while
// Run stats read started to ended, and its blocked card sent the reader to the session they were on
// and to a Retry the page does not have (criterion 70).
describe("a session that stopped checking in, on its own page", () => {
  const ended: SessionRow = {
    ...session,
    status: "failed",
    failureReason: "session_stopped_checking_in",
    report: null,
    startedAt: new Date(NOW - 41 * 60_000).toISOString(),
    updatedAt: new Date(NOW - 32_000).toISOString(),
  };

  it("shows one duration, started to ended, that does not move as time passes", () => {
    page.session = ended;
    try {
      const { rerender } = render(<SessionScreen sessionId="s1" projectSlug="qa" />);
      expect(screen.getByTestId("turn-stage")).toHaveTextContent(/Failed\s*· 40m 28s/);
      expect(screen.getByTitle("Duration")).toHaveTextContent("40m 28s");
      vi.setSystemTime(NOW + 3 * 60_000);
      rerender(<SessionScreen sessionId="s1" projectSlug="qa" />);
      expect(screen.getByTestId("turn-stage")).toHaveTextContent(/Failed\s*· 40m 28s/);
    } finally {
      page.session = session;
    }
  });

  it("names the button the page has, and points at no conversation it does not hold", () => {
    page.session = ended;
    try {
      render(<SessionScreen sessionId="s1" projectSlug="qa" />);
      const card = screen.getByText(/runner kept answering/).closest("[role]") ?? document.body;
      expect(screen.getByRole("button", { name: "Rerun" })).toBeVisible();
      expect(card).toHaveTextContent("Rerun");
      expect(card).not.toHaveTextContent(/Retry|open the session|conversation/);
    } finally {
      page.session = session;
    }
  });

  // ISS-1228 round 13: a person's stop read Failed on its page and "Blocked: Cancelled by a user" on
  // its rail, while the sessions list said Swept and the toast Session cancelled.
  it("calls a session a person stopped Stopped, on its chip and its rail, and draws no Failed turn line", () => {
    page.session = { ...ended, failureReason: "user_cancelled" };
    try {
      render(<SessionScreen sessionId="s1" projectSlug="qa" />);
      expect(screen.queryByTestId("turn-stage")).toBeNull();
      expect(screen.getAllByText("Stopped").length).toBeGreaterThan(0);
      expect(screen.getByText("Why it ended")).toBeVisible();
      expect(screen.getByText("A person stopped the session.")).toBeVisible();
      expect(document.body.textContent).not.toMatch(/Failed|Cancelled|Blocked:/);
    } finally {
      page.session = session;
    }
  });

  it("says why core ended a session as sentences under Why it ended, never under Blocked", () => {
    page.session = ended;
    try {
      render(<SessionScreen sessionId="s1" projectSlug="qa" />);
      expect(screen.getByText("Why it ended")).toBeVisible();
      expect(screen.getByText("The session ended. Stopped checking in.")).toBeVisible();
    } finally {
      page.session = session;
    }
  });

  it("sends the reader to the conversation's last turn where the page holds one", () => {
    page.session = { ...ended, messages: [{ role: "assistant", content: "Restoring the staging database" }] };
    try {
      render(<SessionScreen sessionId="s1" projectSlug="qa" />);
      expect(screen.getByText(LAST_TURN_SHOWS_WHERE)).toBeVisible();
    } finally {
      page.session = session;
    }
  });
});

// ISS-1228 r11 repair: the session page's Runner pill said bravo was Idle while the sessions strip, on the
// same box, said Offline. The pill reads the strip's own line now; an offline box is never Idle.
describe("the session page's Runner pill", () => {
  it.each([
    ["offline", "Offline"],
    ["online", "Free"],
  ] as const)("says what the sessions strip says of a box that is %s", (status, word) => {
    box.status = status;
    try {
      render(<SessionScreen sessionId="s1" projectSlug="qa" />);
      const runner = screen.getByText("bravo").closest("section") ?? document.body;
      expect(runner).toHaveTextContent(word);
      expect(runner).not.toHaveTextContent(/Idle|Healthy/);
    } finally {
      box.status = "online";
    }
  });
});

// ISS-1228 round 15 (judge-39): a session core still held, left idle, showed an ended time and Rerun
// (which answers 400) and no Stop; a Swept chat's "Why it ended" was a red alert beside a neutral
// chip; and a run whose box went offline after ten minutes was told "The runner never picked it up".
describe("a session's page reads core's state", () => {
  it("offers Stop and no ended time or Rerun on a session core holds while it is idle", () => {
    page.session = { ...session, kind: "chat", metadata: { type: "chat" }, status: "idle", report: null };
    try {
      render(<SessionScreen sessionId="s1" projectSlug="qa" />);
      expect(screen.getByRole("button", { name: "Stop session" })).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Rerun" })).not.toBeInTheDocument();
      expect(screen.getByTitle("Ended (last update on a terminal session)")).toHaveTextContent(/^—\s*ended$/);
    } finally {
      page.session = session;
    }
  });

  it("offers Rerun and an ended time once core has ended it", () => {
    page.session = { ...session, status: "failed", failureReason: "user_cancelled", report: null };
    try {
      render(<SessionScreen sessionId="s1" projectSlug="qa" />);
      expect(screen.getByRole("button", { name: "Rerun" })).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Stop session" })).not.toBeInTheDocument();
      expect(screen.getByTitle("Ended (last update on a terminal session)")).not.toHaveTextContent(/^—/);
    } finally {
      page.session = session;
    }
  });

  it("draws a Swept chat's Why it ended in the chip's neutral tone, and a failure's in red", () => {
    page.session = {
      ...session,
      kind: "chat",
      metadata: { type: "chat" },
      status: "failed",
      failureReason: "no_client_ack",
      report: null,
    };
    try {
      const { container, unmount } = render(<SessionScreen sessionId="s1" projectSlug="qa" />);
      const swept = within(container).getByText("The session ended. No acknowledgement.").closest("div[style]");
      expect(swept?.getAttribute("style")).toContain("--ink-600");
      unmount();
      page.session = { ...session, status: "failed", failureReason: "agent_killed", report: null };
      const failed = render(<SessionScreen sessionId="s1" projectSlug="qa" />).container;
      const red = within(failed).getByText(/^The session ended\./).closest("div[style]");
      expect(red?.getAttribute("style")).toContain("--red");
    } finally {
      page.session = session;
    }
  });

  it("tells a session that ran and then lost its box that the box stopped answering", () => {
    page.session = { ...session, status: "failed", failureReason: "runner_unreachable", report: null };
    try {
      render(<SessionScreen sessionId="s1" projectSlug="qa" />);
      expect(screen.getByText("The box stopped answering while the session ran. Check it's online, then Rerun.")).toBeInTheDocument();
      expect(screen.queryByText(/never picked it up/)).not.toBeInTheDocument();
    } finally {
      page.session = session;
    }
  });
});
