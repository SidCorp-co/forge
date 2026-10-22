// The peek beside a list, open, in the shell at 1440 and 1024 by 900: the issues, requirements and
// feedback lists each with a row's peek. Each stage reads that the peek takes two fifths of the page
// or more, that the list beside it still gives each row's title room, that "Open full page" and the
// title are links to the row's page, and that the peek says what the item is (its own words).
//
//   pnpm --filter web-v2 witness witness/peek-panel.witness.tsx --out <dir>

import { QueryClient, QueryClientProvider, type QueryKey } from "@tanstack/react-query";
import { Component, type ReactNode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { TopBarSlotProvider } from "@/design";
import { FeedbackScreen } from "@/features/feedback/components/feedback-screen";
import { IssuesBoard } from "@/features/issues/components/issues-board";
import { issueQueryKey } from "@/features/issues/derive";
import { issueKeys } from "@/features/issues/queries";
import type { CommentNode, IssueDetail } from "@/features/issues/types";
import { RequirementsScreen } from "@/features/requirements/components/requirements-screen";
import { ShellTopBar } from "@/features/shell/components/shell-top-bar";
import { notifyLocationChange } from "@/lib/utils/use-location-search";
import { FEEDBACK_SEED, ITEM as FB_ITEM, P as FB_PROJECT } from "@/test/vi-chrome-feedback";
import { STANDING_LIST, STANDING_ROWS } from "@/test/vi-chrome-issues";
import { REQ_PROJECT, reqQueries, Seeded } from "@/test/vi-chrome-requirements";
import "./entry";
import { InRouter } from "./router";

// a read no fixture seeded stays in flight, as in the vi walking test
window.fetch = () => new Promise<Response>(() => {});
const barClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

const P = "p1";
const AT = "2026-10-15T08:00:00.000Z";
const TITLES = [
  "A refused merge does not say which rule refused it",
  "Release notes miss the issues merged by hand",
  "The job pool hands a box a credential it cannot read",
  "Hoisting lets root scripts use packages they never declare",
  "A paused issue keeps its lease past the pause",
  "Ship the merge-check summary on the release page",
];
const rows = STANDING_ROWS.map((r, i) => ({ ...r, title: TITLES[i] ?? r.title }));
const first = rows[0] as (typeof rows)[number];
const issue = {
  id: first.id,
  displayId: first.key,
  projectId: P,
  status: first.status,
  description: [
    "When `POST /issues/:id/merge` refuses a merge, the response carries `MERGE_REFUSED` and nothing else. The person reading it cannot tell whether the branch was behind, a check was red, or the issue was not in progress.",
    "",
    "**Expected:** the refusal names the rule that refused it and the value it read — `branch behind dev by 3 commits`, `ci-passed is red on 4d4ac33`.",
    "",
    "**Where:** `merge-record.ts:recordMerge`, the three guards before the write. Each throws the same code today.",
    "",
    "**Why it matters:** a master retries a refused merge blind, and a person has to open the run log to learn what a single sentence would have said.",
  ].join("\n"),
  descriptionFormat: "markdown",
  descriptionNodes: null,
  writtenLang: "en",
} as unknown as IssueDetail;
const comment = (id: string, who: string, agent: boolean, body: string, createdAt: string, replies: CommentNode[] = []) =>
  ({ id, issueId: first.id, authorId: id, nodes: null, record: null, body, format: "markdown", template: null, parentId: null, createdAt, updatedAt: createdAt, replies, attachments: [], author: { type: agent ? "device" : "user", id, displayName: who, isAgent: agent } }) as unknown as CommentNode;
const judged = (verdict: "pass" | "fail") => ({ verdict, reason: "", identityKind: "commit", commitSha: "4d4ac3383".padEnd(40, "0"), authorAgency: "agent", createdAt: AT });
const issueQueries: [QueryKey, unknown][] = [
  [["issues", "standing", P, "open"], { ...STANDING_LIST, issues: rows }],
  [issueQueryKey(first.key, P), issue],
  [issueQueryKey(first.id, P), issue],
  [
    issueKeys.comments(first.id, P),
    {
      items: [
        comment("c1", "Lan", false, "Seen twice this week on dev. The second time the branch was only behind.", "2026-10-14T09:00:00.000Z", [
          comment("c2", "forge", true, "Planned: one refusal code per guard, each naming the value it read. The three guards move into one `mergeRefusal()` so the route and the MCP verb say the same sentence.", "2026-10-15T07:40:00.000Z"),
        ]),
      ],
      totalCount: 2,
    },
  ],
  [
    issueKeys.criteria(first.id),
    {
      criteria: [
        { id: "k1", n: 1, statement: "A merge refused for a branch behind dev names how many commits behind", position: 0, requirementCriterionId: null, latest: judged("pass") },
        { id: "k2", n: 2, statement: "A merge refused for a red check names the check and the commit", position: 1, requirementCriterionId: null, latest: judged("fail") },
        { id: "k3", n: 3, statement: "The MCP merge verb returns the same sentence as the route", position: 2, requirementCriterionId: null, latest: null },
      ],
      retired: [],
    },
  ],
  [issueKeys.attachments(first.id), []],
];

const PAGES = [
  { name: "issues", peek: first.key, draw: () => <Seeded data={issueQueries}><IssuesBoard scope={{ projectId: P, slug: "hop" }} mode="attention" /></Seeded> },
  { name: "requirements", peek: "REQ-1", draw: () => <Seeded data={reqQueries()}><RequirementsScreen projectId={REQ_PROJECT} slug="hop" /></Seeded> },
  { name: "feedback", peek: FB_ITEM.key, draw: () => <Seeded data={FEEDBACK_SEED}><FeedbackScreen projectId={FB_PROJECT} slug="hop" /></Seeded> },
] as const;

const at: { show: (i: number) => void } = { show: () => {} };

/** A page that throws is named by the stage that drew it, never read as a peek that did not open. */
class Caught extends Component<{ children: ReactNode }, { error: string | null }> {
  state = { error: null as string | null };
  static getDerivedStateFromError(e: unknown) {
    return { error: e instanceof Error ? `${e.message} ${e.stack?.split("\n").slice(1, 4).join(" ") ?? ""}` : String(e) };
  }
  render() {
    return this.state.error ? <p data-witness="threw">{this.state.error}</p> : this.props.children;
  }
}

function Shell() {
  const [page, setPage] = useState(0);
  useEffect(() => {
    at.show = setPage;
  });
  const p = PAGES[page] ?? PAGES[0];
  return (
    <InRouter key={p.name} at={`/projects/hop/${p.name}`} pattern="/projects/$slug/$">
      <TopBarSlotProvider>
        <div className="flex h-dvh overflow-hidden bg-app" data-shell>
          <div className="hidden h-full flex-none border-r border-line bg-surface md:block" style={{ width: 88 }} />
          <div className="flex min-w-0 flex-1 flex-col" data-witness="page" data-witness-page={p.name}>
            {/* the bar reads the served version (bf024e1d0): a client of its own, its read held in flight like every unseeded one */}
            <QueryClientProvider client={barClient}>
              <ShellTopBar chatOpen={false} onToggleChat={() => {}} />
            </QueryClientProvider>
            <main className="min-h-0 flex-1 overflow-y-auto" data-witness="main">
              <Caught key={p.name}>{p.draw()}</Caught>
            </main>
          </div>
        </div>
      </TopBarSlotProvider>
    </InRouter>
  );
}

const q = (sel: string) => document.querySelector<HTMLElement>(sel);
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
const peekAt = (key: string) => {
  window.history.replaceState(null, "", `${window.location.pathname}?peek=${encodeURIComponent(key)}`);
  notifyLocationChange();
};

window.__witness = {
  cases: [
    { name: "wide-1440", width: 1440 },
    { name: "narrow-1024", width: 1024 },
  ],
  ready: () => Boolean(q("[data-witness=page]")),
  stages: PAGES.map((p, i) => ({
    name: p.name,
    run: async () => {
      window.history.replaceState(null, "", window.location.pathname);
      at.show(i);
      await pause(500);
      const threw = q("[data-witness=threw]");
      if (threw) return [`the ${p.name} list threw: ${threw.innerText.slice(0, 300)}`];
      const key = p.peek ?? q("[data-testid=list-row]")?.dataset.key;
      if (!key) return [`the ${p.name} list drew no row to open`];
      peekAt(key);
      await pause(900);
      const panel = q("aside[data-peek-root='1']");
      if (!panel) return [`the ${p.name} peek did not open on ${key}`];
      const wrong: string[] = [];
      const main = (q("[data-witness=main]") as HTMLElement).getBoundingClientRect().width;
      const share = panel.getBoundingClientRect().width / main;
      console.log(`${p.name}: peek ${Math.round(panel.getBoundingClientRect().width)} px of ${Math.round(main)} (${Math.round(share * 100)}%)`);
      if (share < 0.38) wrong.push(`the ${p.name} peek takes ${Math.round(share * 100)}% of the page, under two fifths`);
      for (const id of ["open-full-page", "peek-title-link"]) {
        const link = panel.querySelector<HTMLElement>(`[data-testid=${id}]`);
        if (link?.tagName !== "A" || !link.getAttribute("href")?.includes(key)) wrong.push(`the ${p.name} peek's ${id} is not a link to ${key}'s page`);
      }
      // the list beside it keeps room to read its rows: a title squeezed under 120 px reads as nothing
      for (const r of document.querySelectorAll<HTMLElement>("[data-testid=list-pane] [data-testid=list-row]")) {
        const title = r.children[1] as HTMLElement | undefined;
        const w = title?.getBoundingClientRect().width ?? 0;
        if (w < 120) wrong.push(`the ${p.name} list's ${r.dataset.key} title has ${Math.round(w)} px beside the peek`);
      }
      const words = panel.querySelector("[data-testid=peek-excerpt]");
      if (!words) wrong.push(`the ${p.name} peek does not say what ${key} is: no excerpt of its own words`);
      return wrong;
    },
  })),
};

const root = document.getElementById("root");
if (!root) throw new Error("the witness page has no #root to mount into");
createRoot(root).render(<Shell />);
