// The routed screens ISS-1137 brought under the word budget: each one a page of the app with its reads
// answered by witness/screens.fixture.tsx's stubbed core, drawn by witness/screens-all.witness.tsx beside
// witness/screens.pages.tsx's. A route's own page component is drawn as the router draws it, so its
// gates (the project, the operator) read the same stubbed core.

import type { ReactNode } from "react";
import { HELP_DOCS } from "@/features/docs/help-content.generated";
import { buildCorpus, searchPlaceholder } from "@/features/guides/corpus";
import { GuideShell } from "@/features/guides/components/guide-shell";
import { PublicLanding } from "@/features/guides/components/public-docs";
import { OperatorClientGate, OperatorGroup, OperatorOverviewScreen } from "@/features/operator";
import { Route as ActivityRoute } from "@/routes/_workspace/activity/index";
import { Route as AttentionRoute } from "@/routes/_workspace/attention/index";
import { Route as EcosystemSettingsRoute } from "@/routes/_workspace/ecosystems/$id/settings/index";
import { Route as NewEcosystemRoute } from "@/routes/_workspace/ecosystems/new/index";
import { Route as ThreadsRoute } from "@/routes/_workspace/ecosystems/threads/index";
import { Route as PairRoute } from "@/routes/_workspace/pair/index";
import { Route as ProjectsRoute } from "@/routes/_workspace/projects/index";
import { Route as ChannelRoute } from "@/routes/_workspace/projects/$slug/channels/$channel/index";
import { Route as ChannelsRoute } from "@/routes/_workspace/projects/$slug/channels/index";
import { Route as ContractsRoute } from "@/routes/_workspace/projects/$slug/contracts/index";
import { Route as ApiRoute } from "@/routes/_workspace/projects/$slug/ecosystem/api/index";
import { Route as DocumentRoute } from "@/routes/_workspace/projects/$slug/ecosystem/channel/$ref/index";
import { Route as ComposeRoute } from "@/routes/_workspace/projects/$slug/ecosystem/channel/new/index";
import { Route as ModuleRoute } from "@/routes/_workspace/projects/$slug/modules/$module/index";
import { Route as ModulesRoute } from "@/routes/_workspace/projects/$slug/modules/index";
import { Route as RoomRoute } from "@/routes/_workspace/projects/$slug/rooms/$room/index";
import { Route as InviteRoute } from "@/routes/invite/accept/index";
import { Route as LinkChatRoute } from "@/routes/link-chat/index";
import { Route as AuthorizeRoute } from "@/routes/oauth/authorize/index";
import { Route as ShareRoute } from "@/routes/s/$token/index";
import { Route as WidgetRoute } from "@/routes/w/$siteKey/index";
import { Route as WidgetStatusRoute } from "@/routes/w/status/$token/index";
import { ActiveOrgProvider } from "@/features/orgs";
import { AuthProvider } from "@/providers/auth-provider";
import type { ScreenPage } from "./screens.pages";
import { ECOSYSTEM_ID } from "./screens.fixture";
import { PROJECT, ROOM_ID, SHARE_TOKEN, WIDGET_SITE, WIDGET_STATUS } from "./screens-rest.reads";

const P = "/projects/hop";
const PS = "/projects/$slug";

/** A route's own page, inside what the app's layout gives it: the signed-in person and, in the workspace, their org. */
const routeOf = (route: { options: { component?: unknown } }, workspace = true) => {
  const Page = route.options.component as () => ReactNode;
  return <AuthProvider>{workspace ? <ActiveOrgProvider><Page /></ActiveOrgProvider> : <Page />}</AuthProvider>;
};
const bareOf = (route: { options: { component?: unknown } }) => routeOf(route, false);

/** The guides read core's published guides in their route's loader; the help pages the web carries are enough to draw the landing.
 *  A guide's own page is an article, its words what it is for, so it is not held to a first-view budget (witness/screens.inventory.mjs). */
const corpus = () => buildCorpus(HELP_DOCS, []);

const operator = (page: ReactNode) => <AuthProvider><OperatorClientGate>{page}</OperatorClientGate></AuthProvider>;

export const REST_PAGES: ScreenPage[] = [
  { name: "attention", path: "/attention", pattern: "/attention", render: () => routeOf(AttentionRoute) },
  { name: "activity", path: "/activity", pattern: "/activity", render: () => routeOf(ActivityRoute) },
  { name: "projects", path: "/projects", pattern: "/projects", render: () => routeOf(ProjectsRoute) },
  { name: "pair", path: "/pair?code=K7QD-9XWM", pattern: "/pair", render: () => routeOf(PairRoute) },
  { name: "ecosystem-new", path: "/ecosystems/new", pattern: "/ecosystems/new", render: () => routeOf(NewEcosystemRoute) },
  { name: "ecosystem-settings", path: `/ecosystems/${ECOSYSTEM_ID}/settings`, pattern: "/ecosystems/$id/settings", render: () => routeOf(EcosystemSettingsRoute) },
  { name: "threads", path: "/ecosystems/threads", pattern: "/ecosystems/threads", render: () => routeOf(ThreadsRoute) },
  { name: "contracts", path: `${P}/contracts`, pattern: `${PS}/contracts`, render: () => routeOf(ContractsRoute) },
  { name: "channels", path: `${P}/channels`, pattern: `${PS}/channels`, render: () => routeOf(ChannelsRoute) },
  { name: "channel", path: `${P}/channels/c1`, pattern: `${PS}/channels/$channel`, render: () => routeOf(ChannelRoute) },
  { name: "modules", path: `${P}/modules`, pattern: `${PS}/modules`, render: () => routeOf(ModulesRoute) },
  { name: "module-detail", path: `${P}/modules/patients`, pattern: `${PS}/modules/$module`, render: () => routeOf(ModuleRoute) },
  { name: "preview-room", path: `${P}/rooms/${ROOM_ID}`, pattern: `${PS}/rooms/$room`, render: () => routeOf(RoomRoute) },
  { name: "ecosystem-api", path: `${P}/ecosystem/api`, pattern: `${PS}/ecosystem/api`, render: () => routeOf(ApiRoute) },
  { name: "channel-document", path: `${P}/ecosystem/channel/EC-1`, pattern: `${PS}/ecosystem/channel/$ref`, render: () => routeOf(DocumentRoute) },
  { name: "channel-compose", path: `${P}/ecosystem/channel/new`, pattern: `${PS}/ecosystem/channel/new`, render: () => routeOf(ComposeRoute) },
  { name: "invite-accept", path: "/invite/accept?token=inv-1", pattern: "/invite/accept", render: () => bareOf(InviteRoute), bare: true },
  { name: "link-chat", path: `/link-chat?projectId=${PROJECT}&source=rocketchat&externalId=u-77`, pattern: "/link-chat", render: () => bareOf(LinkChatRoute), bare: true },
  { name: "oauth-consent", path: "/oauth/authorize?client_id=c1&redirect_uri=https%3A%2F%2Fclaude.ai%2Fcb&scope=forge&state=s&code_challenge=x&code_challenge_method=S256&response_type=code", pattern: "/oauth/authorize", render: () => bareOf(AuthorizeRoute), bare: true },
  { name: "guides", path: "/guides", pattern: "/guides", render: () => <GuideShell><PublicLanding corpus={corpus()} placeholder={searchPlaceholder(corpus())} /></GuideShell>, bare: true },
  { name: "shared-answer", path: `/s/${SHARE_TOKEN}`, pattern: "/s/$token", render: () => bareOf(ShareRoute), bare: true },
  { name: "widget", path: `/w/${WIDGET_SITE}`, pattern: "/w/$siteKey", render: () => bareOf(WidgetRoute), bare: true },
  { name: "widget-status", path: `/w/status/${WIDGET_STATUS}`, pattern: "/w/status/$token", render: () => bareOf(WidgetStatusRoute), bare: true },
  { name: "admin", path: "/admin", pattern: "/admin", render: () => operator(<OperatorOverviewScreen />), bare: true },
  { name: "admin-alerts", path: "/admin/alerts", pattern: "/admin/alerts", render: () => operator(<OperatorGroup section="alerts" />), bare: true },
  { name: "admin-fleet", path: "/admin/fleet", pattern: "/admin/fleet", render: () => operator(<OperatorGroup section="fleet" />), bare: true },
  { name: "admin-growth", path: "/admin/growth", pattern: "/admin/growth", render: () => operator(<OperatorGroup section="growth" />), bare: true },
  { name: "admin-mcp-logs", path: "/admin/mcp-logs", pattern: "/admin/mcp-logs", render: () => operator(<OperatorGroup section="mcp-logs" />), bare: true },
  { name: "admin-pipeline", path: "/admin/pipeline", pattern: "/admin/pipeline", render: () => operator(<OperatorGroup section="pipeline" />), bare: true },
];
