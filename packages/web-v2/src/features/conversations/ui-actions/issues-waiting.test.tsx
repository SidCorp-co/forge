// REQ-41 BC-5 on the Issues list: whom an issue waits on is read from its standing in the grouped
// views, set by the chat's ui.issues.filter or by the person's pills, and a filter sent while the
// paged Table is open moves to the grouped view, which is the one that reads it.

import type { IssueStandingRow } from "@forge/contracts/issue-standing";
import type { WaitingKind } from "@forge/contracts/standing";
import { QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { assistantFilters } from "@/features/chat-dock/assistant-filters";
import { notifyLocationChange } from "@/lib/utils/use-location-search";
import { fakeCore, renderWithQuery } from "@/test/render";
import { RULE, say, waitingOn } from "@/test/said";
import type { ConversationProgressEntry } from "../types";

const go = (href: string) => {
  window.history.pushState(null, "", href);
  notifyLocationChange();
};
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: go, replace: go }),
  usePathname: () => window.location.pathname,
  useSearchParams: () => new URLSearchParams(window.location.search),
}));
vi.mock("@/providers/auth-provider", () => ({ useAuth: () => ({ user: { id: "u-me" } }) }));
vi.mock("@/lib/i18n/eta-clock", () => ({ useEtaClock: () => ({ lang: "en", now: Date.parse("2026-10-09T12:00:00Z") }) }));
vi.mock("@/features/forecast/hooks", () => ({
  useEtaSort: () => [false, () => {}],
  useProjectForecast: () => ({ data: undefined }),
}));

const { useUiActions, useUiSnapshot } = await import("./use-ui-actions");
const { IssuesBoard } = await import("@/features/issues/components/issues-board");

const AT = "2026-10-08T10:00:00.000Z";
const issue = (n: number, kind: WaitingKind, attentionGroup: string): IssueStandingRow =>
  ({
    id: `i${n}`,
    key: `ISS-${n}`,
    title: `Issue ${n}`,
    writtenLang: null,
    status: "open",
    priority: "medium",
    category: "bug",
    complexity: "s",
    assigneeId: null,
    createdById: "u1",
    createdAt: AT,
    updatedAt: AT,
    standing: {
      state: "open",
      step: null,
      stepStartedAt: null,
      moves: [],
      tone: "ready",
      attentionGroup,
      waitingOn: waitingOn(kind, { who: say("standing.who.nobody"), act: say("standing.act.none"), rule: RULE }),
      criteria: { total: 0, passing: 0, failing: 0, skipped: 0 },
      requirement: null,
      module: null,
      feedback: [],
      blockedBy: [],
      blocks: [],
      lease: null,
      inFlight: false,
      branch: null,
      headSha: null,
      owner: null,
      wave: null,
      touchedAt: AT,
      withheld: null,
    },
  }) as unknown as IssueStandingRow;

// ISS-4 waits on another person: it answers to none of the three, and its Paused group starts folded
const ROWS = [issue(1, "you", "needs_you"), issue(2, "master", "queued"), issue(3, "run", "moving"), issue(4, "person", "paused")];

function Dock({ progress }: { progress: ConversationProgressEntry | null }) {
  const ui = useUiActions({ slug: "demo", ready: true, messages: [], progress });
  const page = useUiSnapshot("demo");
  return (
    <aside>
      <pre data-testid="snapshot">{JSON.stringify(page.snapshot)}</pre>
      {ui.cardsFor("e1")}
    </aside>
  );
}

let n = 0;
const turn = (name?: string, args?: Record<string, unknown>): ConversationProgressEntry => ({
  conversationId: "c1",
  rev: ++n,
  view: "asker",
  entry: {
    id: "e1",
    type: "assistant",
    timestamp: 0,
    content: "",
    blocks: name ? [{ type: "tool", toolCall: { id: `call-${n}`, name, input: args, output: JSON.stringify({ deferred: "browser", action: { name, params: args } }) } }] : [],
  },
});

const shownRows = () => screen.queryAllByTestId("list-row").map((r) => r.getAttribute("data-key"));

function page(path: string) {
  window.history.replaceState(null, "", path);
  fakeCore((c) =>
    c.path.startsWith("/projects/p1/issues/standing")
      ? { body: { issues: ROWS, counts: { open: 4, closed: 0, all: 4, needsYou: 1, blocked: 0, blocking: 0 }, returned: 4, limit: 500, releaseApproval: false } }
      : { body: {} },
  );
  const board = <IssuesBoard scope={{ projectId: "p1", slug: "demo" }} mode="attention" />;
  const view = renderWithQuery(
    <>
      {board}
      <Dock progress={null} />
    </>,
  );
  const send = (progress: ConversationProgressEntry) =>
    view.rerender(
      <QueryClientProvider client={view.client}>
        {board}
        <Dock progress={progress} />
      </QueryClientProvider>,
    );
  send(turn());
  return send;
}

beforeEach(() => assistantFilters.mark({}, true));
afterEach(() => vi.unstubAllGlobals());

describe("the Issues list filters by whom an issue waits on (BC-5)", () => {
  it("keeps only the issues waiting on an agent once the chat asks, marked as the assistant's", async () => {
    const send = page("/projects/demo/issues");
    await waitFor(() => expect(shownRows()).toEqual(["ISS-1", "ISS-3", "ISS-2"]));
    send(turn("ui_issues_filter", { mode: "merge", set: { waitingOn: "agent" } }));
    await waitFor(() => expect(shownRows()).toEqual(["ISS-2"]));
    const agent = within(screen.getByTestId("waiting-filter")).getByRole("button", { name: "An agent" });
    expect(agent).toHaveAttribute("data-assistant", "true");
    expect(JSON.parse(screen.getByTestId("snapshot").textContent ?? "{}")).toMatchObject({ route: "issues", filter: { waitingOn: "agent" }, shown: ["ISS-2"] });
  });

  it("narrows by running and by you from the person's own pills", async () => {
    page("/projects/demo/issues");
    await waitFor(() => expect(shownRows()).toEqual(["ISS-1", "ISS-3", "ISS-2"]));
    fireEvent.click(within(screen.getByTestId("waiting-filter")).getByRole("button", { name: "Running" }));
    await waitFor(() => expect(shownRows()).toEqual(["ISS-3"]));
    fireEvent.click(within(screen.getByTestId("waiting-filter")).getByRole("button", { name: "You" }));
    await waitFor(() => expect(shownRows()).toEqual(["ISS-1"]));
    fireEvent.click(within(screen.getByTestId("waiting-filter")).getByRole("button", { name: "Anyone" }));
    await waitFor(() => expect(shownRows()).toEqual(["ISS-1", "ISS-3", "ISS-2"]));
  });

  it("moves a waiting filter sent to the Table onto the grouped view that reads it", async () => {
    const send = page("/projects/demo/issues?group=table");
    send(turn("ui_issues_filter", { mode: "merge", set: { waitingOn: "you" } }));
    expect(window.location.search).toBe("?waiting=you");
  });
});
