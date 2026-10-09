// REQ-41 BC-4..BC-9, run in a page: the list screens render beside the chat's action executor, and
// each action arrives as a stored ui_* tool call on the live turn, exactly as the dock receives one.
// Read at origin/dev 3262b434d, chat reached the Issues list only: no Requirements or Feedback route,
// ui.open took an issue key alone, no list filtered by whom a row waits on, and the page told the
// chat nothing of what the list showed.

import type { WaitingKind } from "@forge/contracts/standing";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { highlightStore } from "@/design/hooks/use-highlight";
import { assistantFilters } from "@/features/chat-dock/assistant-filters";
import { QueryClientProvider } from "@tanstack/react-query";
import { notifyLocationChange, useLocationSearch } from "@/lib/utils/use-location-search";
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
  useRequirementForecasts: () => ({ data: undefined }),
  useFeedbackForecasts: () => ({ data: undefined }),
}));

const { useUiActions, useUiSnapshot } = await import("./use-ui-actions");
const { RequirementsScreen } = await import("@/features/requirements/components/requirements-screen");
const { FeedbackScreen } = await import("@/features/feedback/components/feedback-screen");

const wait = (kind: WaitingKind) => waitingOn(kind, { who: say("standing.who.nobody"), act: say("standing.act.none"), rule: RULE });

const requirement = (seq: number, title: string, kind: WaitingKind, attentionGroup: string) => ({
  id: `r${seq}`,
  key: `REQ-${seq}`,
  title,
  currentRevision: 1,
  standing: {
    state: "agreed",
    attentionGroup,
    waitingOn: wait(kind),
    owner: null,
    touchedAt: "2026-10-08T10:00:00.000Z",
    facts: { criteria: 2, passing: 0, judged: 0, issuesTotal: 0, proposedRevision: null, draftRevision: null },
  },
});
const REQUIREMENTS = [
  requirement(34, "Chat is the way in", "you", "needs_you"),
  requirement(35, "Noise cut", "agent", "waiting"),
  requirement(36, "Previews", "person", "waiting"),
];

const feedback = (seq: number, kind: WaitingKind, attentionGroup: string, phase: string) => ({
  id: `f${seq}`,
  key: `FB-${seq}`,
  title: `Feedback ${seq}`,
  writtenLang: null,
  kind: "bug",
  severity: "high",
  status: "open",
  phase,
  target: { type: "project", ref: null, label: null },
  route: null,
  reporter: { id: "u-2", name: "Minh", agency: "human" },
  dueAt: null,
  snoozed: null,
  redacted: false,
  redactedAt: null,
  reporterNotTold: null,
  createdAt: "2026-10-08T10:00:00.000Z",
  updatedAt: "2026-10-08T10:00:00.000Z",
  attentionGroup,
  waitingOn: wait(kind),
  owner: null,
  touchedAt: "2026-10-08T10:00:00.000Z",
});
const FEEDBACK = [feedback(52, "you", "needs_you", "new"), feedback(53, "run", "moving", "triaged"), feedback(54, "agent", "waiting", "triaged")];

function core() {
  return fakeCore((c) => {
    if (c.method !== "GET") return undefined;
    if (c.path.includes("/suggestions")) return { body: { suggestions: [], open: 0 } };
    if (c.path.includes("/requirements")) return { body: { requirements: REQUIREMENTS } };
    if (c.path.includes("/feedback")) return { body: { feedback: FEEDBACK, untold: 0 } };
    return { body: {} };
  });
}

/** The dock's half: the live turn's tool calls applied, their cards, and the snapshot the next message carries. */
function Dock({ progress }: { progress: ConversationProgressEntry | null }) {
  const ui = useUiActions({ slug: "demo", ready: true, messages: [], progress });
  const page = useUiSnapshot("demo");
  return (
    <aside>
      <pre data-testid="snapshot">{JSON.stringify(page.snapshot)}</pre>
      <p data-testid="sees">{page.sees}</p>
      {ui.cardsFor("e1")}
    </aside>
  );
}

let n = 0;
/** One live turn holding the stored calls, as the asker's browser receives it. */
const turn = (...calls: { name: string; args: Record<string, unknown> }[]): ConversationProgressEntry => ({
  conversationId: "c1",
  rev: ++n,
  view: "asker",
  entry: {
    id: "e1",
    type: "assistant",
    timestamp: 0,
    content: "",
    blocks: calls.map((c, i) => {
      const id = `call-${n}-${i}`;
      return { type: "tool", toolCall: { id, name: c.name, input: c.args, output: JSON.stringify({ deferred: "browser", action: { name: c.name, params: c.args } }) } };
    }),
  },
});

const snapshot = () => JSON.parse(screen.getByTestId("snapshot").textContent ?? "{}");
const shownRows = () => screen.queryAllByTestId("list-row").map((r) => r.getAttribute("data-key"));

function page(screenEl: React.ReactElement, path: string) {
  window.history.replaceState(null, "", path);
  core();
  const view = renderWithQuery(
    <>
      {screenEl}
      <Dock progress={null} />
    </>,
  );
  const rerender = (ui: React.ReactElement) => view.rerender(<QueryClientProvider client={view.client}>{ui}</QueryClientProvider>);
  const send = (progress: ConversationProgressEntry) =>
    rerender(
      <>
        {screenEl}
        <Dock progress={progress} />
      </>,
    );
  // the first render reads the room's history; calls after it are live
  return { ...view, rerender, send };
}

beforeEach(() => {
  assistantFilters.mark({}, true);
  highlightStore.clear();
});
afterEach(() => vi.unstubAllGlobals());

describe("chat filters a Product list by whom a row waits on (BC-4, BC-5, BC-7, BC-8)", () => {
  it("opens Requirements waiting on you, marks the filter, and tells the next message what the list shows", async () => {
    const p = page(<RequirementsScreen projectId="p1" slug="demo" />, "/projects/demo/requirements");
    await waitFor(() => expect(shownRows()).toEqual(["REQ-34", "REQ-35", "REQ-36"]));
    p.send(turn());
    p.send(turn({ name: "ui_requirements_filter", args: { mode: "merge", set: { waitingOn: "you" } } }));
    await waitFor(() => expect(shownRows()).toEqual(["REQ-34"]));
    expect(window.location.search).toBe("?waiting=you");
    const you = within(screen.getByTestId("waiting-filter")).getByRole("button", { name: "You" });
    expect(you).toHaveAttribute("aria-pressed", "true");
    expect(you).toHaveAttribute("data-assistant", "true");
    expect(snapshot()).toMatchObject({ route: "requirements", listFilter: { list: "requirements", filter: { waitingOn: "you" } }, shown: ["REQ-34"] });
    expect(screen.getByTestId("sees")).toHaveTextContent("requirements · waiting on you · showing REQ-34");
    expect(screen.getByTestId("ui-action-card")).toHaveTextContent("Opened requirements");
  });

  it("drops the orange once the person changes the filter by hand", async () => {
    const p = page(<RequirementsScreen projectId="p1" slug="demo" />, "/projects/demo/requirements");
    await waitFor(() => expect(shownRows()).toHaveLength(3));
    p.send(turn());
    p.send(turn({ name: "ui_requirements_filter", args: { mode: "merge", set: { waitingOn: "you" } } }));
    await waitFor(() => expect(shownRows()).toEqual(["REQ-34"]));
    fireEvent.click(within(screen.getByTestId("waiting-filter")).getByRole("button", { name: "An agent" }));
    await waitFor(() => expect(shownRows()).toEqual(["REQ-35"]));
    const agent = within(screen.getByTestId("waiting-filter")).getByRole("button", { name: "An agent" });
    expect(agent).toHaveAttribute("aria-pressed", "true");
    expect(agent).not.toHaveAttribute("data-assistant");
    fireEvent.click(within(screen.getByTestId("waiting-filter")).getByRole("button", { name: "You" }));
    await waitFor(() => expect(shownRows()).toEqual(["REQ-34"]));
    // the person picked the assistant's old value by hand: it is theirs now, not the assistant's
    expect(within(screen.getByTestId("waiting-filter")).getByRole("button", { name: "You" })).not.toHaveAttribute("data-assistant");
  });

  it("navigates to Feedback and filters it by running and phase, each field a chip", async () => {
    const p = page(<FeedbackScreen projectId="p1" slug="demo" />, "/projects/demo/feedback");
    await waitFor(() => expect(shownRows()).toHaveLength(3));
    p.send(turn());
    p.send(turn({ name: "ui_feedback_filter", args: { mode: "replace", set: { waitingOn: "running", phase: ["triaged"] } } }));
    await waitFor(() => expect(shownRows()).toEqual(["FB-53"]));
    const chip = screen.getByTestId("list-filter-chip");
    expect(chip).toHaveTextContent("Phase triaged");
    expect(chip).toHaveAttribute("data-assistant", "true");
    expect(snapshot().listFilter).toEqual({ list: "feedback", filter: { waitingOn: "running", phase: ["triaged"] } });
    fireEvent.click(within(chip).getByRole("button"));
    await waitFor(() => expect(shownRows()).toEqual(["FB-53"]));
    expect(screen.queryByTestId("list-filter-chip")).toBeNull();
    expect(window.location.search).toBe("?waiting=running");
  });

  it("navigates to the Requirements and Feedback routes", async () => {
    const p = page(<div />, "/projects/demo");
    p.send(turn());
    p.send(turn({ name: "ui_navigate", args: { route: "feedback" } }));
    expect(window.location.pathname).toBe("/projects/demo/feedback");
    p.send(turn({ name: "ui_navigate", args: { route: "requirements" } }));
    expect(window.location.pathname).toBe("/projects/demo/requirements");
  });
});

describe("chat opens any record by key and highlights on it (BC-6)", () => {
  it("opens a requirement, a feedback item, a workflow and a release, each on its own page", () => {
    const p = page(<div />, "/projects/demo");
    p.send(turn());
    const opened: string[] = [];
    for (const args of [{ key: "REQ-34" }, { key: "FB-52" }, { kind: "workflow", key: "chat-turn" }, { kind: "release", key: "0.4.0-dev.217" }, { key: "ISS-495" }]) {
      p.send(turn({ name: "ui_open", args }));
      opened.push(window.location.pathname);
    }
    expect(opened).toEqual([
      "/projects/demo/requirements/REQ-34",
      "/projects/demo/feedback/FB-52",
      "/projects/demo/workflows/chat-turn",
      "/projects/demo/releases/0.4.0-dev.217",
      "/projects/demo/issues/ISS-495",
    ]);
  });

  it("highlights a row the list shows, says so in the snapshot, and refuses one it does not show", async () => {
    const p = page(<RequirementsScreen projectId="p1" slug="demo" />, "/projects/demo/requirements?waiting=you");
    await waitFor(() => expect(shownRows()).toEqual(["REQ-34"]));
    p.send(turn());
    p.send(turn({ name: "ui_highlight", args: { target: "row", key: "REQ-34" } }));
    const row = screen.getAllByTestId("list-row")[0] as HTMLElement;
    expect(row).toHaveClass("forge-highlight");
    expect(row).toHaveAttribute("data-highlighted", "true");
    await waitFor(() => expect(snapshot().highlight).toEqual({ target: "row", key: "REQ-34" }));
    expect(screen.getByTestId("sees")).toHaveTextContent("highlighting REQ-34");
    p.send(turn({ name: "ui_highlight", args: { target: "row", key: "REQ-35" } }));
    expect(screen.getByTestId("ui-action-refused")).toHaveTextContent("UI_ACTION_NOT_ON_PAGE: ui.highlight names row REQ-35, which the list beside the chat is not showing");
  });

  it("switches a requirement page to the tab that shows the section, then marks it", async () => {
    function RequirementPage() {
      const tab = new URLSearchParams(useLocationSearch()).get("tab");
      return tab === "criteria" ? <section data-testid="view-criteria">criteria</section> : <section data-testid="view-overview" />;
    }
    const p = page(<RequirementPage />, "/projects/demo/requirements/REQ-34");
    p.send(turn());
    p.send(turn({ name: "ui_highlight", args: { target: "section", section: "criteria" } }));
    expect(window.location.search).toBe("?tab=criteria");
    p.send(turn());
    await waitFor(() => expect(screen.getByTestId("view-criteria")).toHaveAttribute("data-highlighted", "true"));
    await waitFor(() => expect(snapshot()).toMatchObject({ item: { kind: "requirement", key: "REQ-34" }, highlight: { target: "section", section: "criteria" } }));
  });

  it("marks the question a requirement page asks, and step check of an open workflow", async () => {
    const p = page(<section data-testid="requirement-unclear">question</section>, "/projects/demo/requirements/REQ-34");
    p.send(turn());
    p.send(turn({ name: "ui_highlight", args: { target: "section", section: "question" } }));
    expect(screen.getByTestId("requirement-unclear")).toHaveAttribute("data-highlighted", "true");
    act(() => go("/projects/demo/workflows/chat-turn?tab=steps"));
    p.rerender(
      <>
        <ul>
          <li data-testid="design-step-row" data-step="check">
            check
          </li>
        </ul>
        <Dock progress={turn({ name: "ui_highlight", args: { target: "step", step: "check" } })} />
      </>,
    );
    expect(screen.getByTestId("design-step-row")).toHaveAttribute("data-highlighted", "true");
  });

  it("marks an issue's live preview, which its overview draws", () => {
    const p = page(
      <section data-testid="view-overview">
        <div data-highlight="preview" data-testid="issue-preview" />
      </section>,
      "/projects/demo/issues/ISS-495",
    );
    p.send(turn());
    p.send(turn({ name: "ui_highlight", args: { target: "section", section: "preview" } }));
    expect(screen.getByTestId("issue-preview")).toHaveAttribute("data-highlighted", "true");
    expect(screen.queryByTestId("ui-action-refused")).toBeNull();
    expect(window.location.pathname).toBe("/projects/demo/issues/ISS-495");
  });
});
