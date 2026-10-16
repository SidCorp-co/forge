// @vitest-environment jsdom
//
// ISS-1228 round 8 — the session page itself, with a session its box reports blocked: the page's own
// composer takes no message, by key or by button, and says why; its chip and turn line say Blocked
// with no spinner. Driven through `SessionScreen`, so a page that stopped wiring the hold goes red.

import * as matchers from "@testing-library/jest-dom/matchers";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionRow } from "@/features/sessions/types";
import { SessionScreen } from "./session-screen";
import { BLOCKED_HOLD } from "./turn-stage";

expect.extend(matchers);

const NOW = Date.parse("2026-10-16T08:00:00.000Z");
const { send, idle, page } = vi.hoisted(() => ({
  send: vi.fn(),
  idle: () => ({ mutate: () => {}, mutateAsync: async () => {}, isPending: false }),
  page: { session: undefined as unknown },
}));

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
vi.mock("@/features/pipeline/hooks", () => ({ useSessionsAndHolds: () => ({ data: undefined }) }));
vi.mock("@/features/runs/hooks", () => ({ useRun: () => ({ data: undefined, isLoading: false }) }));
vi.mock("@/features/runners/hooks", () => ({ useDevices: () => ({ data: [] }) }));
vi.mock("@/features/sessions/hooks", () => ({
  useSessionCost: () => ({ data: undefined, isLoading: false }),
  useSessions: () => ({ data: { items: [], totalCount: 0 }, isLoading: false }),
}));
vi.mock("../hooks", () => ({
  useSession: () => ({ data: page.session, isLoading: false, isError: false }),
  useSessionTurns: () => ({ data: { turns: [] }, isLoading: false, isSuccess: true }),
  useSendMessage: () => ({ ...idle(), mutateAsync: send }),
  useRegenerateTurn: idle,
  useEditTurn: idle,
  useForkSession: idle,
  useCancelSession: idle,
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
      "Blocked · A person — approve the database restore in Coolify",
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
    const actions = screen.getByRole("button", { name: "Stop" }).parentElement;
    expect(actions?.className.split(/\s+/)).toContain("basis-full");
    expect(actions?.parentElement?.className.split(/\s+/)).toContain("flex-wrap");
  });
});
