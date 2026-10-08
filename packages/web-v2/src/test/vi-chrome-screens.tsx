import { verbatim } from "@forge/contracts/said";
import { RULE, say, waitingOn } from "./said";
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
import { releaseDetailScreen, releasesScreen, systemOverviewScreen, workflowCanvasScreen, workflowDesignScreen, workflowsScreen } from "./vi-chrome-rel-wf";
import { ACCOUNT_SCREENS } from "./vi-chrome-account";
import { SHARED_SCREENS } from "./vi-chrome-shared";
import { SHELL_SCREENS } from "./vi-chrome-shell";
import { ISSUE_SCREENS } from "./vi-chrome-issues";
import { OVERVIEW_SCREENS } from "./vi-chrome-overview";
import { QUESTION_SCREENS } from "./vi-chrome-questions";
import { RUNNER_SCREENS } from "./vi-chrome-runners";
import { INTEGRATION_SCREENS } from "./vi-chrome-integrations.fixture";
import { SETTINGS_SCREENS } from "./vi-chrome-settings";
import { AUTOMATION_SCREENS } from "./vi-chrome-automation";
import { AGENTS_SCREENS } from "./vi-chrome-agents";
import { SESSIONS_SCREENS } from "./vi-chrome-sessions";
import { CONVERSATION_SCREENS } from "./vi-chrome-conversations";
import { GATE_SCREENS } from "./vi-chrome-gate";
import { THREADS_SCREENS } from "./vi-chrome-threads";
import { PROJECT_SETTINGS_SCREENS } from "./vi-chrome-project-settings.fixture";
import { feedbackDetail, feedbackFacts, feedbackFilingForm, feedbackForms, feedbackList, feedbackPeek } from "./vi-chrome-feedback";

// The screens the vi walking test renders. Adding a screen is one entry: a name and a function that
// returns it filled with data that carries NO English words of its own (fixture content is not chrome).
// The next lanes register Requirements, Feedback, Releases and Workflows here.

const clock = { lang: "vi" as const, now: Date.parse("2026-10-07T12:00:00Z"), timeZone: "UTC" };
const you = waitingOn("you", { who: say("standing.who.you"), act: say("standing.act.cut", { v: "0.1.0", more: null }), rule: RULE });
const needs = (area: NeedsYouItem["area"], entity: NeedsYouItem["entity"], key: string): NeedsYouItem => ({ area, entity, key, title: `Muc ${key}`, titleLang: "vi", waitingOn: you, touchedAt: "2026-10-07T10:00:00Z", says: { title: verbatim(`Muc ${key}`) } });
const row = (key: string, over: Partial<PlanRow> = {}): PlanRow => ({ kind: "requirement", key, title: `Muc ${key}`, release: null, href: `/projects/hop/requirements/${key}`, eta: null, late: null, ...over });

export interface ChromeScreen {
  name: string;
  render: () => ReactElement;
  /** What the screen opens once drawn (a menu, a popover), so the chrome inside it is read too. */
  act?: () => void;
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
        <LandsThisWeek slug="hop" clock={clock} rows={[row("REQ-2"), row("REQ-3", { release: { version: "0.1.0", who: say("standing.who.holderOf", { perm: "releases.approve" }) } }), row("REQ-4", { release: { version: "0.1.0", who: say("standing.who.holderOf", { perm: "releases.approve" }) } })]} />
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
  { name: "Releases", render: releasesScreen },
  { name: "Release detail", render: releaseDetailScreen },
  { name: "Workflows", render: workflowsScreen },
  { name: "System overview", render: systemOverviewScreen },
  { name: "Workflow design", render: workflowDesignScreen },
  { name: "Workflow canvas", render: workflowCanvasScreen },
  { name: "Feedback list", render: feedbackList },
  { name: "Feedback detail", render: feedbackDetail },
  { name: "Feedback peek", render: feedbackPeek },
  { name: "Feedback facts and history", render: feedbackFacts },
  { name: "Feedback triage and message forms", render: feedbackForms },
  { name: "Feedback filing form", render: feedbackFilingForm },
  ...SHELL_SCREENS, ...ACCOUNT_SCREENS, ...SHARED_SCREENS, ...ISSUE_SCREENS, ...QUESTION_SCREENS, ...OVERVIEW_SCREENS, ...RUNNER_SCREENS, ...INTEGRATION_SCREENS, ...SETTINGS_SCREENS, ...AUTOMATION_SCREENS, ...AGENTS_SCREENS, ...SESSIONS_SCREENS, ...CONVERSATION_SCREENS, ...GATE_SCREENS, ...PROJECT_SETTINGS_SCREENS, ...THREADS_SCREENS,
];
