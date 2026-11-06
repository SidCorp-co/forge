// The routed screens witness/screens-all.witness.tsx draws: a name, the address the page is opened at,
// the route pattern, and what it renders from its fixtures. A screen is added here once a seed draws it
// faithfully, and in witness/screens.inventory.ts either way.

import type { QueryKey } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { FeedbackScreen } from "@/features/feedback/components/feedback-screen";
import { IssueDetailScreen } from "@/features/issues/components/issue-detail-screen";
import { ReleasesScreen } from "@/features/releases/components/releases-screen";
import { RequirementsScreen } from "@/features/requirements/components/requirements-screen";
import { DocsScreen } from "@/features/docs/components/docs-screen";
import { NotFoundBody } from "@/features/shell/components/not-found-body";
import { Route as ApprovalsRoute } from "@/routes/_workspace/projects/$slug/approvals/index";
import { Route as StatusRoute } from "@/routes/_workspace/projects/$slug/status/index";
import { Route as LoginRoute } from "@/routes/_auth/login/index";
import { Route as RegisterRoute } from "@/routes/_auth/register/index";
import { EcosystemScreen } from "@/features/ecosystem/components/ecosystem-screen";
import { EcosystemsHome } from "@/features/ecosystem/components/ecosystems-home";
import { MyForgeFeedback } from "@/features/feedback";
import { HomeScreen } from "@/features/overview";
import { P as FB_P } from "@/test/vi-chrome-feedback";
import { P as REL_P, releaseSeed } from "@/test/vi-chrome-rel-wf";
import { REQ_PROJECT, Seeded } from "@/test/vi-chrome-requirements";

import { HOME_SEED } from "./owner-home.fixture";
import { ECOSYSTEM_ID } from "./screens.fixture";

export interface ScreenPage {
  name: string;
  path: string;
  pattern?: string;
  render: () => ReactNode;
  /** a tab the stage opens before it counts */
  tab?: string;
  /** a page drawn outside the workspace shell (sign-in, 404): no rail, no top bar */
  bare?: boolean;
}

interface Kit {
  vi: (name: string) => ReactNode;
  HomePage: () => ReactNode;
  ISSUE_TITLED: [QueryKey, unknown][];
  REQUIREMENTS_TITLED: [QueryKey, unknown][];
  FEEDBACK_TITLED: [QueryKey, unknown][];
}

const P = "/projects/hop";

/** A route's own page component, drawn as the router draws it (its gates read the stubbed core). */
const routeOf = (route: { options: { component?: unknown } }) => {
  const Page = route.options.component as () => ReactNode;
  return <Page />;
};

export function SCREEN_PAGES({ vi, HomePage, ISSUE_TITLED, REQUIREMENTS_TITLED, FEEDBACK_TITLED }: Kit): ScreenPage[] {
  return [
    { name: "project-home", path: P, pattern: "/projects/$slug", render: () => <HomePage /> },
    { name: "issues-list", path: `${P}/issues`, render: () => vi("Issues table") },
    { name: "issue-detail", path: `${P}/issues/ISS-1`, render: () => <Seeded data={ISSUE_TITLED}><IssueDetailScreen projectId="p1" slug="hop" id="i1" /></Seeded> },
    { name: "requirements-list", path: `${P}/requirements`, render: () => <Seeded data={REQUIREMENTS_TITLED}><RequirementsScreen projectId={REQ_PROJECT} slug="hop" /></Seeded> },
    { name: "requirement-detail", path: `${P}/requirements/REQ-1`, render: () => vi("Requirement detail · Overview") },
    { name: "feedback-list", path: `${P}/feedback`, render: () => <Seeded data={FEEDBACK_TITLED}><FeedbackScreen projectId={FB_P} slug="hop" /></Seeded> },
    { name: "feedback-detail", path: `${P}/feedback/FB-1`, render: () => vi("Feedback detail") },
    { name: "releases-list", path: `${P}/releases`, render: () => <Seeded data={releaseSeed()}><ReleasesScreen projectId={REL_P} slug="hop" /></Seeded> },
    { name: "release-detail", path: `${P}/releases/0.3.2`, render: () => vi("Release detail") },
    { name: "workflows-list", path: `${P}/workflows`, render: () => vi("Workflows") },
    { name: "workflow-design", path: `${P}/workflows/dat-hang`, render: () => vi("Workflow design") },
    { name: "agents-runs", path: `${P}/agents`, render: () => vi("Agents · runs") },
    { name: "agents-master", path: `${P}/agents/master`, render: () => vi("Master page · passes") },
    { name: "run-detail", path: `${P}/agents/runs/r1`, render: () => vi("Run page · running 5") },
    { name: "session-detail", path: `${P}/agents/s-run`, render: () => vi("Session · run report") },
    { name: "automation", path: `${P}/automation`, render: () => vi("Automation · schedules") },
    { name: "schedule-detail", path: `${P}/automation/schedules/s1`, render: () => vi("Automation · schedule page") },
    { name: "fire-detail", path: `${P}/automation/fires/a-fire-0001`, render: () => vi("Automation · fire page") },
    { name: "contract-detail", path: `${P}/contracts/hop/orders`, render: () => vi("Contract detail") },
    { name: "development-overview", path: `${P}/overview`, render: () => vi("Development overview") },
    { name: "project-settings", path: `${P}/settings`, render: () => vi("Project settings · General") },
    { name: "integrations", path: "/integrations", pattern: "/integrations", render: () => vi("Integrations") },
    { name: "runners", path: "/runners", pattern: "/runners", render: () => vi("Runners") },
    { name: "owner-home", path: "/", pattern: "/", render: () => <Seeded data={HOME_SEED}><HomeScreen /></Seeded> },
    { name: "org-home", path: "/org", pattern: "/org", render: () => vi("Settings · organization home") },
    { name: "settings-account", path: "/settings", pattern: "/settings", render: () => vi("Account preferences") },
    { name: "approvals", path: `${P}/approvals`, pattern: "/projects/$slug/approvals", render: () => routeOf(ApprovalsRoute) },
    { name: "status", path: `${P}/status`, pattern: "/projects/$slug/status", render: () => routeOf(StatusRoute) },
    { name: "forge-feedback", path: "/forge-feedback", pattern: "/forge-feedback", render: () => <MyForgeFeedback /> },
    { name: "ecosystems-home", path: "/ecosystems", pattern: "/ecosystems", render: () => <EcosystemsHome /> },
    { name: "ecosystem-detail", path: "/ecosystems/ecosystem-1", pattern: "/ecosystems/$id", render: () => <EcosystemScreen ecosystemId={ECOSYSTEM_ID} /> },
    { name: "docs", path: "/docs", pattern: "/docs", render: () => <DocsScreen /> },
    { name: "sign-in", path: "/login", pattern: "/login", render: () => routeOf(LoginRoute), bare: true },
    { name: "register", path: "/register", pattern: "/register", render: () => routeOf(RegisterRoute), bare: true },
    { name: "not-found", path: "/nowhere", pattern: "/nowhere", render: () => <NotFoundBody />, bare: true },
  ];
}
