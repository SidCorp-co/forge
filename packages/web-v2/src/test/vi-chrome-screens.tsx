import type { ReactElement } from "react";
import type { NeedsYouItem } from "@/features/needs-you/types";
import { AttentionQueue } from "@/features/project-dashboard/components/attention-queue";
import { BaFigures } from "@/features/project-dashboard/components/ba-figures";
import { LandsThisWeek, LateItems } from "@/features/project-dashboard/components/plan-sections";
import type { PlanRow } from "@/features/project-dashboard/ba-derive";
import { NavRail } from "@/design/patterns/nav-rail";
import { PROJECT_ITEMS, WORKSPACE_ITEMS } from "@/features/shell";
import { CreateRequirementForm, RequirementsScreen } from "@/features/requirements/components/requirements-screen";
import { RequirementPeek } from "@/features/requirements/components/requirement-peek";
import { RequirementScreen } from "@/features/requirements/components/requirement-screen";
import { RequirementPage } from "@/features/requirements/components/requirement-detail";
import { REQ_PROJECT, reqQueries, Seeded } from "./vi-chrome-requirements";

// The screens the vi walking test renders. Adding a screen is one entry: a name and a function that
// returns it filled with data that carries NO English words of its own (fixture content is not chrome).
// The next lanes register Requirements, Feedback, Releases and Workflows here.

const clock = { lang: "vi" as const, now: Date.parse("2026-10-07T12:00:00Z"), timeZone: "UTC" };
const you = { kind: "you", who: "You", act: "cut 0.1.0", rule: "r", ref: null, dueAt: null } as const;
const needs = (area: NeedsYouItem["area"], entity: NeedsYouItem["entity"], key: string): NeedsYouItem => ({ area, entity, key, title: `Muc ${key}`, waitingOn: you, touchedAt: "2026-10-07T10:00:00Z" });
const row = (key: string, over: Partial<PlanRow> = {}): PlanRow => ({ kind: "requirement", key, title: `Muc ${key}`, release: null, href: `/projects/hop/requirements/${key}`, eta: null, late: null, ...over });

export interface ChromeScreen {
  name: string;
  render: () => ReactElement;
}

export const CHROME_SCREENS: ChromeScreen[] = [
  {
    name: "Dashboard",
    render: () => (
      <>
        <BaFigures
          slug="hop"
          requirements={[{ state: "in_delivery", count: 2 }, { state: "delivered", count: 1 }] as never}
          feedback={{ open: 3, untriaged: 1, aging: 1 }}
          release={null}
          clock={clock}
        />
        <AttentionQueue items={[needs("requirements", "requirement", "REQ-1"), needs("releases", "release", "0.1.0")]} slug="hop" />
        <LandsThisWeek slug="hop" clock={clock} rows={[row("REQ-2"), row("REQ-3", { release: { version: "0.1.0", who: "A release approver" } }), row("REQ-4", { release: { version: "0.1.0", who: "A release approver" } })]} />
        <LateItems clock={clock} rows={[row("REQ-5", { late: { reason: "p85_passed", since: "x", byMinutes: 150 } })]} />
        <LateItems clock={clock} rows={[]} />
      </>
    ),
  },
  {
    name: "Navigation rail",
    render: () => <NavRail workspaceItems={WORKSPACE_ITEMS} projectItems={PROJECT_ITEMS as never} activeKey="proj-overview" />,
  },
  { name: "Requirements list", render: () => <Seeded data={reqQueries()}><RequirementsScreen projectId={REQ_PROJECT} slug="hop" /></Seeded> },
  { name: "New requirement form", render: () => <Seeded data={[]}><CreateRequirementForm projectId={REQ_PROJECT} onDone={() => {}} /></Seeded> },
  {
    name: "Requirement peek",
    render: () => (
      <Seeded data={reqQueries()}>
        <RequirementPeek projectId={REQ_PROJECT} slug="hop" reqKey="REQ-1" peek={{ open: "REQ-1", position: { at: 1, of: 2 }, set: () => {}, move: () => {} }} onOpenFull={() => {}} />
      </Seeded>
    ),
  },
  { name: "Requirement detail · Overview", render: () => <Seeded data={reqQueries()}><RequirementScreen projectId={REQ_PROJECT} slug="hop" reqKey="REQ-1" /></Seeded> },
  ...(["criteria", "revisions", "activity"] as const).map((tab) => ({
    name: `Requirement detail · ${tab}`,
    render: () => (
      <Seeded data={reqQueries()}>
        <RequirementPage projectId={REQ_PROJECT} slug="hop" reqKey="REQ-1" tab={tab} onTab={() => {}} />
      </Seeded>
    ),
  })),
];
