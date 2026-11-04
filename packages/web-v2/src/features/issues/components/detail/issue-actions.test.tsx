// ISS-441: the issue page's Ask about this opens a fresh draft with no issue key typed into it; the
// issue reaches the turn as the page's record (REQ-30 BC-6). Read at e523c4b0f it typed
// "About issue ISS-n: " into the draft.
// ISS-687 (REQ-68 BC-6): the header asks no person to act on the issue. Judge K163 read a primary
// "Run pipeline" on a needs_info issue and a "Pause" on a running one at 0.4.0-dev.480; the menu
// also offered "Pause (hold)" and "Reopen". Only the manual-intake start a policy names stays.

import { fireEvent, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { type ChatDockApi, ChatDockProvider, useChatDockState } from "@/features/chat-dock";
import { renderWithQuery } from "@/test/render";
import type { IssueDetail, IssueStatus } from "../../types";
import type { StartReading } from "../start-issue-action";
import { IssueActions } from "./issue-actions";

vi.mock("@/lib/navigation/router", async () => (await import("@/test/navigation")).navigationDouble({
  usePathname: () => "/projects/forge/issues/ISS-441",
  useRouter: () => ({ push: () => undefined }),
}));

function Header({ status, isRunActive = false, start = { kind: "none" }, onDock }: { status: IssueStatus; isRunActive?: boolean; start?: StartReading; onDock?: (d: ChatDockApi) => void }) {
  const state = useChatDockState("p1");
  onDock?.(state);
  const issue = { id: "i-1", displayId: "ISS-441", status } as unknown as IssueDetail;
  // a writer's header as the old one read it: these props are what drew its acts, and must draw none now
  const asWriter = { canWrite: true, pending: false, exitsHere: ["on_hold", "reopen", "dropped"], onTransition: () => undefined } as object;
  return (
    <ChatDockProvider value={state}>
      <IssueActions issue={issue} slug="forge" linkId="ISS-441" start={start} isRunActive={isRunActive} onStarted={() => undefined} {...asWriter} />
    </ChatDockProvider>
  );
}

describe("the issue header's Ask about this", () => {
  it("opens a draft with no issue key typed into it", () => {
    let dock: ChatDockApi | null = null;
    renderWithQuery(<Header status="in_progress" onDock={(d) => (dock = d)} />);
    fireEvent.click(screen.getByRole("button", { name: "Ask about this" }));
    const opened = (dock as ChatDockApi | null)?.target;
    expect(opened).toEqual({ kind: "draft", projectId: "p1", draft: undefined });
    expect(JSON.stringify(opened)).not.toContain("ISS-441");
  });
});

const ACTS = /^(Run pipeline|View pipeline|Pause|Pause \(hold\)|Reopen|Resume|Release now)$/;
const STATUSES: IssueStatus[] = ["draft", "open", "in_progress", "needs_info", "on_hold", "reopen", "awaiting_release", "closed"];

describe("the issue header asks no person to act on the issue (ISS-687)", () => {
  it.each(STATUSES.flatMap((s) => [[s, false], [s, true]] as [IssueStatus, boolean][]))(
    "a %s issue (run live: %s) draws no run, pause, resume, reopen or release",
    (status, isRunActive) => {
      renderWithQuery(<Header status={status} isRunActive={isRunActive} />);
      const header = screen.getByTestId("issue-actions");
      expect(within(header).queryAllByRole("button", { name: ACTS })).toEqual([]);
      fireEvent.click(within(header).getByRole("button", { name: "Issue actions" }));
      const menu = screen.getAllByRole("menuitem").map((i) => i.textContent?.trim() ?? "");
      expect(menu).toEqual(["Open session", "Open pipeline", "Copy link"]);
    },
  );

  it("keeps the start a manual-intake policy names a person's", () => {
    renderWithQuery(<Header status="open" start={{ kind: "start" }} />);
    expect(within(screen.getByTestId("issue-actions")).getByRole("button", { name: "Start" })).toBeInTheDocument();
  });
});
