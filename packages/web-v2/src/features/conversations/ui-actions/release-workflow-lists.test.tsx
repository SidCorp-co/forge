// REQ-41 BC-4, BC-5, BC-8 on the two Product lists the first render test leaves out: Releases and
// Workflows open from chat with their filter, narrow by whom a row waits on, and report their rows.

import type { WaitingKind } from "@forge/contracts/standing";
import { QueryClientProvider } from "@tanstack/react-query";
import { screen, waitFor, within } from "@testing-library/react";
import type { ReactElement } from "react";
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
vi.mock("@/features/forecast/hooks", () => ({ useComingNext: () => ({ data: undefined }) }));
// the release train, the coming-next strip and the system overview canvas are not what is judged here
vi.mock("@/features/releases/components/coming-next", () => ({ ComingNext: () => null }));
vi.mock("@/features/releases/components/release-train", () => ({ ReleaseTrain: () => null }));
vi.mock("@/features/workflows/components/system-overview", () => ({ SystemOverviewRegion: () => null }));

const { useUiActions, useUiSnapshot } = await import("./use-ui-actions");
const { ReleasesScreen } = await import("@/features/releases/components/releases-screen");
const { WorkflowsScreen } = await import("@/features/workflows/components/workflows-screen");

const AT = "2026-10-08T10:00:00.000Z";
const wait = (kind: WaitingKind) => waitingOn(kind, { who: say("standing.who.nobody"), act: say("standing.act.none"), rule: RULE });

const release = (version: string, kind: WaitingKind, attentionGroup: string, state: string) => ({
  version,
  headline: `Release ${version}`,
  issueCount: 1,
  requirements: [],
  criteria: { total: 0, proven: 0 },
  cutCount: 1,
  current: false,
  state,
  waitingOn: wait(kind),
  attentionGroup,
  owner: null,
  at: AT,
});
const RELEASES = [release("0.4.0-dev.218", "you", "needs_you", "draft"), release("0.4.0-dev.217", "run", "moving", "deploying")];

const workflow = (flow: string, title: string, kind: WaitingKind) => ({
  revision: 1,
  writer: "u1",
  writerName: "Lan",
  design: { shown: "approved", pendingRevision: null, waitingOn: wait(kind), status: "approved", approvedRevision: 1 },
  document: {
    id: `w-${flow}`,
    version: 2,
    project: "demo",
    flow,
    kind: "flow",
    title,
    summary: `${title} summary`,
    steps: [],
    template: { id: "flow", version: 1 },
    writtenBy: {},
    createdAt: AT,
    updatedAt: AT,
  },
  health: undefined,
});
const WORKFLOWS = [workflow("chat-turn", "Chat turn", "agent"), workflow("feedback-triage", "Feedback triage", "you")];

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
const turn = (name?: string, args?: unknown): ConversationProgressEntry => ({
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

function page(el: ReactElement, path: string) {
  window.history.replaceState(null, "", path);
  fakeCore((c) => {
    if (c.method !== "GET") return undefined;
    if (c.path.startsWith("/projects/p1/releases")) return { body: { releases: RELEASES, production: { ok: true } } };
    if (c.path.startsWith("/projects/p1/workflow-templates")) return { body: { templates: [] } };
    if (c.path.startsWith("/projects/p1/workflows")) return { body: { workflows: WORKFLOWS, returned: 2 } };
    return { body: {} };
  });
  const view = renderWithQuery(
    <>
      {el}
      <Dock progress={null} />
    </>,
  );
  const send = (progress: ConversationProgressEntry) =>
    view.rerender(
      <QueryClientProvider client={view.client}>
        {el}
        <Dock progress={progress} />
      </QueryClientProvider>,
    );
  send(turn());
  return send;
}

const snapshot = () => JSON.parse(screen.getByTestId("snapshot").textContent ?? "{}");

beforeEach(() => assistantFilters.mark({}, true));
afterEach(() => vi.unstubAllGlobals());

describe("Releases from chat (BC-4, BC-5)", () => {
  it("keeps the release that is running once the chat filters by running, and reports it", async () => {
    const send = page(<ReleasesScreen projectId="p1" slug="demo" />, "/projects/demo/releases");
    const rows = () => screen.queryAllByTestId("list-row").map((r) => r.getAttribute("data-key"));
    await waitFor(() => expect(rows()).toEqual(["0.4.0-dev.218", "0.4.0-dev.217"]));
    send(turn("ui_releases_filter", { mode: "merge", set: { waitingOn: "running" } }));
    await waitFor(() => expect(rows()).toEqual(["0.4.0-dev.217"]));
    expect(within(screen.getByTestId("waiting-filter")).getByRole("button", { name: "Running" })).toHaveAttribute("data-assistant", "true");
    expect(snapshot()).toMatchObject({ route: "releases", listFilter: { list: "releases", filter: { waitingOn: "running" } }, shown: ["0.4.0-dev.217"] });
  });
});

describe("Workflows from chat (BC-4, BC-5)", () => {
  it("keeps the designs waiting on you, and on the words the chat set", async () => {
    const send = page(<WorkflowsScreen projectId="p1" slug="demo" projectName="Demo" />, "/projects/demo/workflows");
    const rows = () => screen.queryAllByTestId("workflow-row").map((r) => r.getAttribute("data-flow"));
    await waitFor(() => expect(rows().sort()).toEqual(["chat-turn", "feedback-triage"]));
    send(turn("ui_workflows_filter", { mode: "replace", set: { waitingOn: "you" } }));
    await waitFor(() => expect(rows()).toEqual(["feedback-triage"]));
    expect(snapshot()).toMatchObject({ route: "workflows", listFilter: { list: "workflows", filter: { waitingOn: "you" } }, shown: ["feedback-triage"] });
    send(turn("ui_workflows_filter", { mode: "replace", set: { text: "chat" } }));
    await waitFor(() => expect(rows()).toEqual(["chat-turn"]));
    expect(screen.getByTestId("list-filter-chip")).toHaveAttribute("data-assistant", "true");
  });
});
