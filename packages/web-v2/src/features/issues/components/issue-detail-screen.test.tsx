// REQ-43 BC-3, BC-9: an issue page opens on what is true now and shows at most 300 words at 1440 by
// 900 in the person's view, however long the record behind it. ISS-451's page was 2,325 words: a plan
// of rounds, thirteen file chips, a voided question on top, "Running" three times. The fixture is that
// shape (18 criteria, a 26-step plan, 13 files, a voided question, a run, two relations).

import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fakeCore, renderWithQuery, type Call } from "@/test/render";
import { IssueDetailScreen } from "./issue-detail-screen";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/projects/forge/issues/ISS-451",
  useSearchParams: () => new URLSearchParams(window.location.search),
}));

afterEach(() => {
  vi.unstubAllGlobals();
  window.history.replaceState(null, "", "/");
});

const AT = "2026-10-10T08:00:00.000Z";
const P = "p1";
const ID = "11111111-1111-4111-8111-111111111111";

const criteria = Array.from({ length: 18 }, (_, i) => ({
  id: `k${i + 1}`,
  n: i + 1,
  statement: `A gated move stops only on an unanswered blocking question, and the refusal names that question through every door: web, API, agent tool and run (${i + 1}).`,
  position: i,
  requirementCriterionId: `w${i + 1}`,
  latest:
    i < 8
      ? { verdict: "pass", reason: "Seen at the running build.", identityKind: "commit", commitSha: "a".repeat(40), authorAgency: "agent", evidence: [], backfilled: false, createdAt: AT }
      : i < 12
        ? { verdict: "fail", reason: "The refusal names no question.", identityKind: "commit", commitSha: "b".repeat(40), authorAgency: "agent", evidence: [], backfilled: false, createdAt: AT }
        : null,
}));

const plan = [
  "Goal: one checklist contract from which the form, the agent input and the kernel guard are all derived, as REQ-34 round 2 asked after judge run 804f655a.",
  ...Array.from({ length: 26 }, (_, i) => `${i + 1}. Step ${i + 1}: packages/contracts/src/checklists.ts holds the registry; lifecycle/transition.ts runs the guard and records kernel_refused_moves.`),
].join("\n");

const files = Array.from({ length: 13 }, (_, i) => ({
  id: `f${i}`,
  issueId: ID,
  uploaderId: null,
  name: `qa-witness-evidence-screenshot-${i}.png`,
  mime: "text/plain",
  size: 2048 + i,
  url: `/api/attachments/f${i}/download`,
  createdAt: AT,
}));

const standing = {
  state: "in_progress",
  step: "build",
  stepStartedAt: AT,
  moves: [],
  tone: "run",
  attentionGroup: "moving",
  waitingOn: {
    kind: "run",
    who: "A run",
    act: "Build for 35 min",
    rule: "A run holds a live lease",
    says: {
      who: { key: "issues.standing.who.run", vars: {} },
      act: { key: "issues.standing.act.stepFor", vars: { step: "build", n: 35 } },
      rule: { key: "issues.rule.leaseHeld", vars: { holder: "box-1" } },
    },
  },
  criteria: { total: 18, passing: 8, failing: 4, skipped: 0 },
  requirement: { key: "REQ-34", title: "Checklists", criteria: ["BC-1"], staleCriteria: [], plannedRevision: 2, currentRevision: 2, changedSincePlan: false },
  module: null,
  feedback: [],
  feedbackDropped: [],
  blockedBy: [],
  blocks: [],
  owner: { id: "u1", name: "orchestrator", kind: "human" },
  touchedAt: AT,
  withheld: null,
};

const issue = {
  id: ID,
  projectId: P,
  issSeq: 451,
  displayId: "ISS-451",
  title: "No checklist contract exists, so forms, agent tools and guards each restate or omit the questions a step requires",
  status: "in_progress",
  priority: "high",
  category: "feature",
  complexity: "xl",
  agentStatus: "running",
  assigneeId: null,
  createdById: "u1",
  creatorLabel: "orchestrator",
  reopenCount: 0,
  mergedAt: null,
  createdAt: "2026-10-09T08:00:00.000Z",
  updatedAt: AT,
  description: "There is no checklist concept: forms, agent tools and guards each restate the questions a step needs, or omit them.",
  descriptionFormat: "markdown",
  plan,
  acceptanceCriteria: null,
  labels: [],
  releaseNotes: { userFacing: "A draft opens only when its checklist is complete.", section: "Added" },
  workState: { step: "build" },
  agentSessions: [{ id: "s1", status: "running", metadata: null, createdAt: AT, updatedAt: AT, title: "build run", deviceName: "box-1", pipelineRunId: "r1", heartbeat: "alive", continuity: "unknown", freshReason: null }],
  pipelineHealth: null,
  moves: [],
  sessionContext: null,
};

const edge = (id: string, from: string, to: string) => ({ id, kind: "blocks", fromIssueId: from, toIssueId: to, fromDisplayId: `ISS-${from}`, toDisplayId: `ISS-${to}`, fromTitle: `Issue ${from} waits on a long and detailed title`, toTitle: `Issue ${to} is held up by this one, long title`, fromStatus: "open", toStatus: "open", expired: false });

const U = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const PREVIEW = {
  id: U(1), projectId: U(2), subject: { kind: "issue", issueId: ID }, issueId: ID, sessionId: U(3), deviceId: U(4), url: "https://pv.example.test/", state: "live", reason: null, detail: null,
  command: "pnpm dev", port: 3000, idleMinutes: 0, approvedPatchId: null, approvedBy: null, createdBy: U(5), createdAt: AT, liveAt: AT, lastViewedAt: null, closedAt: null, streams: 0, streamsWaiting: 0,
};

const question = {
  id: "q1", projectId: P, issueId: ID, status: "void", blockerKind: "human", maxRounds: 3, voidReason: "The run ended", endedReason: null, parkDeadlineAt: null, createdAt: AT, updatedAt: AT,
  steps: [{ round: 1, prompt: "Which door should the refusal name first?", askedAt: AT, answerShape: "free_text", needed: "the door" }],
  answerShape: "free_text", options: [], recommendedOptionId: "", needed: "the door", locked: false,
};

function core(c: Call) {
  const path = c.path.split("?")[0] ?? "";
  if (path === "/projects") return { body: [{ id: P, slug: "forge", name: "Forge", role: "admin", orgId: null }] };
  if (path === `/issues/${ID}` || path === "/issues/ISS-451") return { body: issue };
  if (path.endsWith("/issues/standing/ISS-451")) return { body: { ...issue, key: "ISS-451", standing, steps: [], releaseApproval: true, blocker: null, stepOutcomes: [] } };
  if (path.endsWith("/criteria")) return { body: { criteria, retired: [] } };
  if (path.endsWith("/attachments")) return { body: files };
  if (path.startsWith("/projects/") && path.endsWith("/comments")) return { body: { comments: [], returned: 0 } };
  if (path.endsWith("/comments")) return { body: { items: [], totalCount: 0 } };
  if (path.endsWith("/activity") || path.endsWith("/activities")) return { body: { items: [] } };
  if (path.endsWith("/dependencies")) return { body: { incoming: [edge("e1", "449", ID), edge("e2", "450", ID)], outgoing: ["452", "453", "454", "455", "456", "457"].map((n, i) => edge(`o${i}`, ID, n)) } };
  if (path.endsWith("/cost")) return { body: { estimatedCost: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 } };
  if (path.endsWith("/questions")) return { body: { questions: [question] } };
  if (path.endsWith("/preview")) return { body: { preview: PREVIEW } };
  if (path.endsWith("/checks")) return { body: { issueId: ID, totalMs: 0, kinds: [], checks: [] } };
  if (path.endsWith("/members")) return { body: [] };
  if (path.includes("/forecast")) return { body: { forecast: { kind: "ended" } } };
  if (path.endsWith("/labels")) return { body: [] };
  if (path.endsWith("/patterns")) return { body: { patterns: [], decidable: [] } };
  if (path.endsWith("/cost-summary")) return { body: { estimatedCost: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 } };
  if (path.endsWith("/park")) return { body: { park: null } };
  if (path.endsWith("/policy")) return { body: {} };
  if (path.endsWith("/roster")) return { body: { gateStatus: null, baseBranch: "main", nextCutAt: null, issues: [] } };
  if (path.endsWith("/mockups")) return { body: { mockups: [], returned: 0 } };
  return undefined;
}

/** The words a reader sees: the tokens of every text node outside a hidden element that hold a letter or a digit (a mark, a chevron or a dash is not a word). */
function visibleWords(root: HTMLElement): number {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let words = 0;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    // what a 1440-wide window does not draw: hidden folds, and what only a phone-width window shows
    if (node.parentElement?.closest("[hidden],[aria-hidden='true'],script,style,[class~='md:hidden']")) continue;
    words += (node.textContent ?? "").split(/\s+/).filter((token) => /[\p{L}\p{N}]/u.test(token)).length;
  }
  return words;
}

async function page(search = "") {
  window.history.replaceState(null, "", `/projects/forge/issues/ISS-451${search}`);
  fakeCore((c) => core(c));
  renderWithQuery(<IssueDetailScreen projectId={P} slug="forge" id="ISS-451" />);
  const screenEl = await screen.findByTestId("issue-detail");
  await screen.findByTestId("criterion-18-verdict");
  await waitFor(() => expect(within(screenEl).queryByTestId("issue-now")).not.toBeNull());
  await screen.findByTestId("details-files");
  return screenEl;
}

describe("an issue page in the person's view", () => {
  it("shows at most 300 words however long the record behind it", async () => {
    const root = await page();
    expect(visibleWords(root)).toBeLessThanOrEqual(300);
  });

  it("opens on Now, Needs you and Done by, then the criteria rows, and holds the long record folded", async () => {
    const root = await page();
    const order = ["issue-now", "issue-needs-you", "view-criteria", "issue-details"].map((id) => within(root).getByTestId(id));
    for (const [i, el] of order.slice(1).entries()) {
      expect(order[i]?.compareDocumentPosition(el) ?? 0).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    }
    expect(within(root).getByTestId("details-plan")).toHaveTextContent("26 steps");
    expect(within(root).getByTestId("details-files")).toHaveTextContent("13");
    expect(within(root).queryByText(/Step 26/)).toBeNull();
    // the voided question is Activity's, never the top of the page
    expect(within(root).queryByText(/Which door should the refusal name first/)).toBeNull();
  });

  it("counts the criteria in the filter pills and marks each row, one line apiece", async () => {
    const root = await page();
    expect(within(root).getByRole("button", { name: "All 18" })).toBeInTheDocument();
    expect(within(root).getByRole("button", { name: "Failing 4" })).toBeInTheDocument();
    expect(within(root).getByRole("button", { name: "Not judged 6" })).toBeInTheDocument();
    expect(within(root).getByRole("button", { name: "Passing 8" })).toBeInTheDocument();
    expect(within(root).getByTestId("criterion-1-verdict")).toHaveAccessibleName("Pass");
    expect(within(root).getByTestId("criterion-9-verdict")).toHaveAccessibleName("Fail");
    await userEvent.click(within(root).getByRole("button", { name: "Failing 4" }));
    expect(within(root).getAllByTestId("criterion-row")).toHaveLength(4);
  });

  it("says Running once, and never says an edit would be overwritten until someone starts one", async () => {
    const root = await page();
    expect(root.textContent?.match(/Running/g) ?? []).toHaveLength(0);
    expect(root.textContent).not.toMatch(/overwritten/);
  });

  it("shows two relations of each kind and counts the rest", async () => {
    const root = await page();
    expect(within(within(root).getByTestId("rail-holds-up")).getAllByRole("link")).toHaveLength(2);
    expect(within(root).getByRole("button", { name: "4 more" })).toBeInTheDocument();
  });
});

describe("an issue page in the developer view", () => {
  it("opens every fold: the plan, the files and the voided question", async () => {
    const root = await page("?view=developer");
    expect(await within(root).findByText(/Step 26/)).toBeInTheDocument();
    expect(await within(root).findByText(/Which door should the refusal name first/)).toBeInTheDocument();
    expect(visibleWords(root)).toBeGreaterThan(300);
  });
});
