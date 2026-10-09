// Every step of every tour points at a `data-tour` anchor its page draws. A page that loses an anchor
// fails here naming the tour and the step, before a person meets a popover pointing at nothing.
// It sits with the routes because it composes them: the pages of three features beside the tour
// registry, which those features themselves import, so no one feature can hold it.

import type { ReleaseChanges } from "@forge/contracts/releases";
import type { TourId } from "@forge/contracts/tours";
import { screen } from "@testing-library/react";
import type { ReactElement } from "react";
import { describe, expect, it, vi } from "vitest";
import type { StatusCard } from "@/features/integrations/types";
import { IntegrationsTab } from "@/features/project-settings/components/integrations-tab";
import { ReleasePage } from "@/features/releases/components/release-page";
import type { ReleaseDetail } from "@/features/releases/types";
import { releasePage } from "@/test/release-page";
import { fakeCore, renderWithQuery } from "@/test/render";
import { TOURS } from "@/features/tours/registry";
import { cardDetail, say } from "@/test/said";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/projects/forge/settings",
  useSearchParams: () => new URLSearchParams("tab=connections"),
}));

const CHANGES: ReleaseChanges = {
  surfaces: [
    { surface: "ui", count: 1, shipsNothing: false, issues: ["ISS-1"], artifacts: [{ ref: "screen:/releases/:v", change: "added", issues: ["ISS-1"], carriedBy: null }] },
    { surface: "data", count: 1, shipsNothing: false, issues: ["ISS-2"], artifacts: [{ ref: "table:issues", change: "changed", issues: ["ISS-2"], carriedBy: null }] },
    { surface: "design", count: 1, shipsNothing: true, issues: ["ISS-3"], artifacts: [{ ref: "issue-to-release@rev10", change: "changed", issues: ["ISS-3"], carriedBy: null }] },
  ],
  risks: [{ risk: "data_changed", surface: "data", ref: "table:issues", issues: ["ISS-2"], sentence: "table:issues changes shape" }],
  unclassified: [],
  boxRead: [],
  shipsNothing: false,
} as unknown as ReleaseChanges;

/** A shipped release as core serves it; the page draws its reader from `releasePage`. */
const RELEASE = {
  key: "0.1.0",
  version: "0.1.0",
  state: "shipped",
  runId: "run-1",
  approval: null,
  verified: { level: "none", proven: 0, total: 0, check: null, provider: null },
  issues: [],
  gates: [],
  cuts: [],
  attempts: [],
  approvals: [],
  criteria: { total: 0 },
  issueCriteria: [],
  requirementsCompleted: [],
  feedbackAnswered: [],
  notes: { designs: [], sections: [], withoutNotes: [], language: "en", attention: [] },
  changes: CHANGES,
  production: null,
  continuedAs: null,
  can: { cut: false, decide: false, split: false },
  attentionGroup: "done",
  waitingOn: { kind: "none", who: "", act: "", rule: "r", ref: null, dueAt: null },
} as unknown as ReleaseDetail;

const REPOSITORY: StatusCard = {
  key: "repository",
  label: "Repository",
  status: "not_configured",
  ...cardDetail(say("integrations.detail.unreachedConnect", { host: "github.com", provider: "GitHub" })),
  lastSyncAt: null,
  configured: true,
  meta: { repository: "github.com/SidCorp-co/forge", remoteUrl: "https://github.com/SidCorp-co/forge", host: "github.com", provider: null, connectProvider: "github" },
};

function serveCore() {
  fakeCore((call) => {
    if (call.path === "/projects/p1/releases/0.1.0") return { body: { release: RELEASE } };
    if (call.path === "/projects/p1/releases") return { body: { releases: [] } };
    if (call.path.startsWith("/projects/p1/releases/0.1.0/page")) return { body: releasePage() };
    if (call.path === "/projects/p1/integrations/status") return { body: { cards: [REPOSITORY] } };
    if (call.path === "/projects/p1/integrations") return { body: { items: [] } };
    if (call.path === "/projects/p1/integrations/mcp-preview") return { body: { servers: [] } };
    if (call.path === "/me/product-state") return { body: { items: [] } };
    if (call.path.startsWith("/projects")) return { body: [] };
    return { body: { items: [] } };
  });
}

/** Each tour's page, drawn the way its route draws the anchored parts, with data that holds every part. */
const PAGES: Record<TourId, { route: string; draw: () => ReactElement; renders: (ui: ReactElement) => unknown; ready: () => Promise<unknown> }> = {
  "release-what-changes": {
    route: "/projects/:slug/releases/:version",
    draw: () => <ReleasePage projectId="p1" slug="forge" version="0.1.0" />,
    renders: (ui) => {
      serveCore();
      return renderWithQuery(ui);
    },
    ready: () => screen.findByTestId("release-reader"),
  },
  integrations: {
    route: "/projects/:slug/settings?tab=connections",
    draw: () => <IntegrationsTab projectId="p1" canEdit />,
    renders: (ui) => {
      serveCore();
      return renderWithQuery(ui);
    },
    ready: () => screen.findAllByText("Repository"),
  },
};

describe("every tour step has its anchor on its page", () => {
  for (const tour of TOURS) {
    it(`tour ${tour.id}: every step's anchor is drawn on ${PAGES[tour.id].route}`, async () => {
      const page = PAGES[tour.id];
      page.renders(page.draw());
      await page.ready();
      const missing = tour.steps.flatMap((step, i) =>
        document.querySelector(`[data-tour="${step.anchor}"]`) ? [] : [`tour ${tour.id} step ${i + 1} (data-tour="${step.anchor}")`],
      );
      expect(missing, `anchors missing on ${page.route}: ${missing.join("; ")}`).toEqual([]);
    });
  }
});
