// REQ-41 BC-13: the project home opens on chat, and beside it are three flat tables: what needs you
// (the decisions read, with the buttons that answer them), what is running, and what is at risk.

import { needsYouDecisionsSchema } from "@forge/contracts/needs-you-decisions";
import type { ProjectStatus } from "@forge/contracts/project-status";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { STATUS } from "@/features/project-status/status-fixture";
import { fakeCore, renderWithQuery } from "@/test/render";
import { RULE, say, waitingOn } from "@/test/said";
import { atRiskRows, runningRows } from "./derive";
import { ProjectHome } from "./components/project-home";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("@/features/conversations/components/conversation-chat", () => ({
  ConversationChat: ({ conversationId }: { conversationId?: string }) => (
    <div data-testid="chat" data-conversation={conversationId ?? "new"}>
      <textarea aria-label="Composer" />
    </div>
  ),
}));

afterEach(() => vi.unstubAllGlobals());

const PROJECT = "6f0ee160-8432-4b84-98cf-956b6cd65a29";
const Q = "8d2a3f5e-21c4-4b8e-9d62-6a4e3c1f0b77";
const answer = (id: string, label: string, recommended: boolean) => ({
  id,
  label,
  act: "question.answer",
  path: `/api/questions/${Q}/answer`,
  body: { round: 1, optionId: id },
  needsReason: false,
  effect: null,
  recommended,
});
const decision = (key: string, group: "answer" | "approve", question: string) => ({
  group,
  area: "issues",
  entity: "issue",
  key,
  title: key,
  opens: { kind: "issue", key },
  question,
  recommended: { answerId: "yes", why: "The run that asked recommends it.", by: "asker" },
  noRecommendation: null,
  answers: [answer("yes", "Yes", true), answer("no", "No", false)],
  touchedAt: "2026-10-08T10:00:00.000Z",
});
const DECISIONS = needsYouDecisionsSchema.parse({
  generatedAt: "2026-10-09T12:00:00.000Z",
  total: 3,
  decisions: [decision("ISS-1", "answer", "Keep the old export?"), decision("ISS-2", "answer", "Ship the rename?"), decision("ISS-3", "approve", "Approve ISS-3's plan?")],
  notDecisions: [],
});

const running = (key: string, title: string) => ({
  key,
  title,
  titleLang: "en" as const,
  status: "in_progress" as const,
  waitingOn: waitingOn("agent", { who: say("standing.who.master"), act: say("issues.standing.act.working"), rule: RULE }),
});
const status = (over: Partial<ProjectStatus> = {}): ProjectStatus => ({
  ...STATUS,
  inFlight: { ...STATUS.inFlight, running: [running("ISS-20", "Referral screens"), running("ISS-21", "Export order")], runningCount: 2 },
  late: { asOf: STATUS.asOf, items: [{ kind: "requirement", key: "REQ-4", title: "Referrals", late: { reason: "p85_passed", since: "2026-10-07T08:00:00.000Z", byMinutes: 120 } }] },
  requirements: {
    ...STATUS.requirements,
    items: [{ ...(STATUS.requirements.items[0] as never as ProjectStatus["requirements"]["items"][number]), key: "REQ-7", title: "Checkout", state: "delivered", criteria: { proven: 3, total: 5 } }],
  },
  ...over,
});

const ROOM = {
  id: "c-1", adapter: "web", externalId: "c-1", shape: "direct", mode: "assistant", title: "Hello", updatedAt: "2026-10-08T10:00:00Z",
  archivedAt: null, ecosystemId: null, kind: null, threadStatus: "done", subjectKey: null,
};

function core(s: ProjectStatus = status()) {
  return fakeCore(({ path, method }) => {
    if (path.startsWith("/conversations?")) return { body: { items: [{ ...ROOM, projectId: PROJECT }], total: 1 } };
    if (path === `/projects/${PROJECT}/needs-you/decisions`) return { body: DECISIONS };
    if (path.startsWith(`/projects/${PROJECT}/status`)) return { body: s };
    if (method === "POST" && path === `/questions/${Q}/answer`) return { body: { ok: true } };
    return undefined;
  });
}

describe("the project home (REQ-41 BC-13)", () => {
  it("leads with the composer, then three flat tables: 3 decisions, 2 running, 1 at risk beside 1 short", async () => {
    core();
    renderWithQuery(<ProjectHome projectId={PROJECT} slug="hop" />);
    const home = await screen.findByTestId("project-home");
    await screen.findAllByTestId("needs-you-decision");
    await screen.findAllByTestId("home-running-row");
    // the composer is the first control on the page, ahead of any button the sections carry
    expect(home.querySelector("textarea, button, a, input")).toBe(screen.getByLabelText("Composer"));
    expect(screen.getByTestId("chat")).toHaveAttribute("data-conversation", "c-1");
    expect(within(screen.getByTestId("home-needs-you")).getAllByTestId("needs-you-decision")).toHaveLength(3);
    expect(screen.getAllByTestId("home-running-row").map((r) => r.getAttribute("data-key"))).toEqual(["ISS-20", "ISS-21"]);
    expect(screen.getAllByTestId("home-at-risk-row").map((r) => r.getAttribute("data-key"))).toEqual(["REQ-4", "REQ-7"]);
    expect(screen.getAllByTestId("home-at-risk-why").map((n) => n.textContent)).toEqual([
      "2.0 h past the latest similar work took",
      "3 of 5 criteria proven on the running build",
    ]);
    // flat: tables and hairlines, no card or shadow
    const surfaces = [...home.querySelectorAll("section, table, ul, li, div")].map((n) => n.className).join(" ");
    expect(surfaces).not.toMatch(/shadow|rounded|\bcard\b|bg-surface-raised/);
    expect(screen.getAllByRole("table")).toHaveLength(2);
  });

  it("stacks on one column below lg and puts the chat column first", async () => {
    core();
    renderWithQuery(<ProjectHome projectId={PROJECT} slug="hop" />);
    const home = await screen.findByTestId("project-home");
    expect(home.className).toContain("grid-cols-1");
    expect(home.className).toContain("lg:grid-cols-[minmax(0,1fr)_26rem]");
    expect(home.firstElementChild).toBe(screen.getByTestId("home-chat"));
  });

  it("posts a decision button's filled path as the person, and the row's request is the one the page sends", async () => {
    const calls = core();
    renderWithQuery(<ProjectHome projectId={PROJECT} slug="hop" />);
    const first = (await screen.findAllByTestId("needs-you-decision"))[0] as HTMLElement;
    fireEvent.click(within(first).getByRole("button", { name: "Yes" }));
    await waitFor(() => expect(calls.some((c) => c.method === "POST")).toBe(true));
    expect(calls.filter((c) => c.method === "POST")).toEqual([{ method: "POST", path: `/questions/${Q}/answer`, body: { round: 1, optionId: "yes" } }]);
  });

  it("reads the decisions through the one route the chat reads, and no other needs-you read", async () => {
    const calls = core();
    renderWithQuery(<ProjectHome projectId={PROJECT} slug="hop" />);
    await screen.findAllByTestId("needs-you-decision");
    const needs = calls.map((c) => c.path).filter((p) => p.includes("needs-you"));
    expect(needs).toEqual([`/projects/${PROJECT}/needs-you/decisions`]);
  });

  it("says so when nothing runs and nothing is at risk, and when no decision waits", async () => {
    fakeCore(({ path }) => {
      if (path.startsWith("/conversations?")) return { body: { items: [], total: 0 } };
      if (path.endsWith("/needs-you/decisions")) return { body: { ...DECISIONS, total: 0, decisions: [] } };
      if (path.includes("/status")) return { body: status({ inFlight: { ...STATUS.inFlight, running: [], runningCount: 0 }, late: { asOf: STATUS.asOf, items: [] }, requirements: { ...STATUS.requirements, items: [] } }) };
      return undefined;
    });
    renderWithQuery(<ProjectHome projectId={PROJECT} slug="hop" />);
    expect(await screen.findByText("No run is on an issue right now.")).toBeInTheDocument();
    expect(screen.getByText(/Nothing is late/)).toBeInTheDocument();
    expect(screen.getByText("Nothing waits on you to decide.")).toBeInTheDocument();
    expect(screen.getByTestId("chat")).toHaveAttribute("data-conversation", "new");
  });

  it("refuses to call a requirement at risk that core did not call late or that holds every criterion", () => {
    const s = status({ late: { asOf: STATUS.asOf, items: [] } });
    const item = s.requirements.items[0] as ProjectStatus["requirements"]["items"][number];
    const held = { ...s, requirements: { ...s.requirements, items: [{ ...item, criteria: { proven: 5, total: 5 } }, { ...item, key: "REQ-8", state: "in_delivery" as const }] } };
    expect(atRiskRows(held, "hop")).toEqual([]);
    expect(runningRows(undefined)).toEqual([]);
  });

  it("names a requirement once where it is both late and short", () => {
    const s = status();
    const item = s.requirements.items[0] as ProjectStatus["requirements"]["items"][number];
    const both = { ...s, requirements: { ...s.requirements, items: [{ ...item, key: "REQ-4" }] } };
    const rows = atRiskRows(both, "hop");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.reasons.map((r) => r.kind)).toEqual(["late", "short"]);
  });
});
