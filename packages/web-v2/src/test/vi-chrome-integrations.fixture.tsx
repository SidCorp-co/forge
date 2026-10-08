import type { ReactElement } from "react";
import type { QueryKey } from "@tanstack/react-query";
import { fireEvent } from "@testing-library/react";
import type { ConnectionDirectoryItem } from "@forge/contracts/integrations";
import { ConnectionEditDrawer } from "@/features/integrations/components/connection-edit-drawer";
import { DeliveryLogViewer } from "@/features/integrations/components/delivery-log-viewer";
import { IntegrationsScreen } from "@/features/integrations/components/integrations-screen";
import { ProjectIntegrationsPanel } from "@/features/integrations/components/project-integrations-panel";
import { AutoflowSection } from "@/features/integrations/providers/autoflow/section";
import { CoolifyConnectionConfig } from "@/features/integrations/providers/coolify/connection-config";
import { CoolifySection } from "@/features/integrations/providers/coolify/section";
import { EpodsystemConnectionConfig } from "@/features/integrations/providers/epodsystem/connection-config";
import { EpodsystemSection } from "@/features/integrations/providers/epodsystem/section";
import { GitHubSection } from "@/features/integrations/providers/github/section";
import { GitlabSection } from "@/features/integrations/providers/gitlab/section";
import { RocketchatConnectionConfig } from "@/features/integrations/providers/rocketchat/connection-config";
import { RocketchatSection } from "@/features/integrations/providers/rocketchat/section";
import { SentrySection } from "@/features/integrations/providers/sentry/section";
import type { IntegrationSummary, StatusCard } from "@/features/integrations/types";
import { IntegrationsTab } from "@/features/project-settings/components/integrations-tab";
import { type ProductCopyKey, productCopy } from "@/lib/i18n/product-copy";
import { Seeded } from "./vi-chrome-requirements";
import { cardDetail, say, verbatim } from "./said";

// The Integrations screens for the vi walking test: the workspace connection directory and a
// connection's drawer, a project's integrations table with its MCP preview, and every provider's
// section with a binding in each state it can show. A provider's name, a host, a key prefix and
// core's own health sentence stay as they are.

const P = "p1";
const NOW = Date.now();
const ago = (min: number) => new Date(NOW - min * 60_000).toISOString();

const connection = (over: Partial<ConnectionDirectoryItem>): ConnectionDirectoryItem =>
  ({
    id: "c1",
    ownerType: "user",
    ownerId: "u1",
    provider: "coolify",
    displayName: null,
    config: { baseUrl: "https://coolify.example.com" },
    active: true,
    lastHealthStatus: "ok",
    lastHealthDetail: null,
    lastHealthAt: ago(5),
    breakerOpenedAt: null,
    directoryStatus: "connected",
    hasSecrets: true,
    createdAt: ago(600),
    updatedAt: ago(60),
    usage: { bindings: [{ id: "b1", projectId: P, role: "deploy", label: "", name: "dev", active: true }] },
    ...over,
  }) as ConnectionDirectoryItem;

const CONNECTIONS = [
  connection({}),
  connection({ id: "c2", provider: "gitlab", displayName: "GitLab fork", ownerType: "org", ownerId: "o1", lastHealthStatus: "needs_reauth", directoryStatus: "needs_reauth", usage: { bindings: [] } }),
  connection({ id: "c3", provider: "agent", active: false, directoryStatus: "disabled", hasSecrets: false, lastHealthStatus: null, lastHealthAt: null }),
  connection({ id: "c4", provider: "github", displayName: "Forge App", ownerType: "org", ownerId: "o2" }),
];

const binding = (provider: string, over: Partial<IntegrationSummary> = {}): IntegrationSummary =>
  ({
    id: `b-${provider}`,
    connectionId: provider === "github" ? "c4" : "c1",
    projectId: P,
    provider,
    role: "service",
    config: {},
    bindingConfig: {},
    label: "",
    active: true,
    bindingActive: true,
    connectionActive: true,
    lastHealthStatus: "ok",
    lastHealthDetail: null,
    lastHealthAt: ago(3),
    breakerOpenedAt: null,
    hasSecrets: true,
    integrationSecretSet: true,
    agentAccess: "none",
    agentPathKind: "direct-mcp",
    revision: 1,
    createdAt: ago(100),
    ...over,
  }) as IntegrationSummary;

const BINDINGS = [
  binding("coolify", { role: "deploy", agentPathKind: "none", config: { baseUrl: "https://coolify.example.com", targets: [{ id: "t1", label: "Backend", resourceUuid: "y8w4c4ks", healthUrl: "https://api.example.com/health" }], releaseRunnerLabel: "release" }, bindingConfig: { releaseRunnerLabel: "release" } }),
  binding("epodsystem", { lastHealthStatus: "error", config: { storeName: "Hop", domain: "hop.example.com", scopes: ["products:write"], commerceEnabled: true } }),
  binding("epodsystem", { id: "b-epod-2", label: "partner-a", active: false, connectionActive: false }),
  binding("autoflow", { lastHealthStatus: "needs_reauth", lastHealthDetail: "HTTP 401", config: { shop: "hop" } }),
  binding("rocketchat", { config: { serverUrl: "https://chat.example.com", rids: ["r1", "r9"] }, agentPathKind: "core-mediated", agentAccess: "all" }),
  binding("sentry", { connectionId: "c2", config: { host: "logs.example.com", organizationSlug: "sid", targets: [{ label: "Backend prod", organizationSlug: "sid" }] } }),
  binding("gitlab", { agentPathKind: "core-mediated", config: { baseUrl: "https://gitlab.com", projectPath: "it/hop" } }),
  binding("github", { agentPathKind: "core-mediated", config: { owner: "SidCorp-co", repo: "hop" } }),
];

const cards: StatusCard[] = [
  { key: "repository", label: "Repository", status: "not_configured", ...cardDetail(say("integrations.detail.unreachedConnect", { host: "github.com", provider: "GitHub" })), lastSyncAt: null, configured: true, meta: { repository: "github.com/SidCorp-co/hop", remoteUrl: "https://github.com/SidCorp-co/hop", provider: null, connectProvider: "github" } },
  { key: "github", label: "GitHub", status: "not_configured", ...cardDetail(say("integrations.detail.noneConfigured", { provider: "GitHub" })), lastSyncAt: null, configured: false, meta: { capabilities: { hasDeliveryLog: false } } },
  { key: "coolify:dev", label: "Coolify (dev)", status: "connected", ...cardDetail(say("integrations.detail.lastHealth", { status: "ok" })), lastSyncAt: ago(4), configured: true, meta: { capabilities: { hasDeliveryLog: true }, bindingId: "b-coolify", role: "deploy", environment: "dev", name: "dev" } },
  { key: "sentry", label: "Sentry", status: "error", ...cardDetail(say("integrations.detail.lastHealthWhy", { status: "error", detail: verbatim("401 from logs.example.com") })), lastSyncAt: ago(30), configured: true, meta: { capabilities: { hasDeliveryLog: false }, bindingId: "b-sentry", role: "service" } },
] as StatusCard[];

const mcp = (reason: string, over: Record<string, unknown> = {}) => ({
  provider: "sentry",
  serverName: `sentry-${reason}`,
  bindingId: "b-sentry",
  role: "service",
  configured: true,
  active: true,
  willInject: reason === "ok",
  reason,
  url: "https://mcp.sentry.dev/mcp",
  headers: null,
  lastHealthStatus: "ok",
  lastHealthAt: ago(9),
  ...over,
});

const SERVERS = [
  mcp("ok"),
  mcp("not_granted"),
  mcp("shadowed"),
  mcp("not_resolved", { lastHealthStatus: null }),
  mcp("no_credential"),
  mcp("disabled"),
  mcp("not_configured", { provider: "epodsystem", bindingId: null, role: null, configured: false, url: null }),
];

const queries = (items: IntegrationSummary[] = BINDINGS): [QueryKey, unknown][] => [
  [["integration-connections"], { items: CONNECTIONS }],
  [["integration-connections", "c1", "bindings"], { items: [items[0]] }],
  [["orgs"], [{ id: "o1", name: "SidCorp", role: "member", isPersonal: false }, { id: "o2", name: "Hop", role: "owner", isPersonal: false }]],
  [["projects"], [{ id: P, slug: "hop", name: "Hop", orgId: "o1", orgName: "SidCorp", orgIsPersonal: false, orgRole: "member" }]],
  [["projects", "all"], [{ id: P, slug: "hop", name: "Hop", orgId: "o1", archivedAt: null }, { id: "p2", slug: "old", name: "Old", orgId: "o1", archivedAt: ago(9000) }]],
  [["project", P], { id: P, slug: "hop", name: "Hop" }],
  [["integrations", "list", P], { items }],
  [["integrations", "status", P], { cards }],
  [["integrations", "mcp-preview", P], { servers: SERVERS }],
  [["integrations", "rc-rooms", P, "b-rocketchat"], { rooms: [{ rid: "r1", name: "hop-dev", type: "p" }, { rid: "r2", name: "general" }] }],
  [["integrations", "deliveries", P, "b-coolify"], { items: [
    { id: "d1", direction: "outbound", eventName: "deploy.trigger", status: "ok", durationMs: 812, createdAt: ago(7), payload: { uuid: "y8w4c4ks" }, response: { ok: true }, errorMessage: null },
    { id: "d2", direction: "inbound", eventName: "push", status: "refused", durationMs: null, createdAt: ago(70), payload: {}, response: null, errorMessage: "bad signature" },
  ] }],
];

// a control found by its label in either language: the rail test draws each screen in en as well
const clickKey = (key: ProductCopyKey, nth = 0) => () => {
  const labels = [productCopy("vi")(key), productCopy("en")(key)];
  const hits = [...document.querySelectorAll("button, a")].filter((b) => labels.includes(b.textContent?.trim() ?? ""));
  const el = hits[nth];
  if (!el) throw new Error(`nothing to open labelled ${key}`);
  fireEvent.click(el);
};

const sectionOf = (render: () => ReactElement, items?: IntegrationSummary[]) => () => <Seeded data={queries(items)}>{render()}</Seeded>;

export const SCREENS = [
  { name: "Integrations", render: sectionOf(() => <IntegrationsScreen />) },
  { name: "Integrations · add", render: sectionOf(() => <IntegrationsScreen />), act: clickKey("integrations.add") },
  { name: "Integrations · empty", render: () => <Seeded data={[[["integration-connections"], { items: [] }], [["orgs"], []], [["projects", "all"], []]]}><IntegrationsScreen /></Seeded> },
  {
    name: "Integrations · connection drawer",
    render: sectionOf(() => <ConnectionEditDrawer connection={CONNECTIONS[0] as ConnectionDirectoryItem} onClose={() => {}} />),
    act: clickKey("integrations.edit.removeOpen"),
  },
  {
    name: "Integrations · drawer without credential",
    render: sectionOf(() => (
      <>
        <ConnectionEditDrawer connection={{ ...(CONNECTIONS[2] as ConnectionDirectoryItem), provider: "github" }} onClose={() => {}} />
        <ConnectionEditDrawer connection={{ ...(CONNECTIONS[1] as ConnectionDirectoryItem), id: "c9", ownerType: "user", hasSecrets: false, lastHealthStatus: null }} onClose={() => {}} />
      </>
    )),
  },
  {
    name: "Integrations · connection config",
    render: sectionOf(() => (
      <>
        <CoolifyConnectionConfig connection={{ id: "c1", config: { baseUrl: "https://coolify.example.com" } }} canManage />
        <RocketchatConnectionConfig connection={{ id: "c2", config: {} }} canManage />
        <EpodsystemConnectionConfig connection={{ id: "c5", config: {} }} canManage={false} />
      </>
    )),
  },
  { name: "Project integrations", render: sectionOf(() => <ProjectIntegrationsPanel projectId={P} canEdit />) },
  { name: "Project integrations · drawer", render: sectionOf(() => <ProjectIntegrationsPanel projectId={P} canEdit />), act: clickKey("integrations.panel.manage") },
  { name: "Project integrations · share", render: sectionOf(() => <IntegrationsTab projectId={P} canEdit />) },
  { name: "Project integrations · read only", render: sectionOf(() => <IntegrationsTab projectId={P} canEdit={false} />, []) },
  { name: "Integration · Coolify", render: sectionOf(() => <CoolifySection projectId={P} />) },
  { name: "Integration · Coolify new", render: sectionOf(() => <CoolifySection projectId={P} />, []) },
  {
    name: "Integration · Epodsystem",
    render: sectionOf(() => <EpodsystemSection projectId={P} />),
    act: () => {
      clickKey("integrations.epod.rotateKey")();
      clickKey("integrations.epod.add")();
    },
  },
  {
    name: "Integration · Autoflow",
    render: sectionOf(() => <AutoflowSection projectId={P} />),
    act: () => {
      clickKey("integrations.autoflow.replaceToken")();
      clickKey("integrations.autoflow.add")();
    },
  },
  { name: "Integration · Rocket.Chat", render: sectionOf(() => <RocketchatSection projectId={P} />), act: clickKey("integrations.rocket.rotate") },
  { name: "Integration · Rocket.Chat connect", render: sectionOf(() => <RocketchatSection projectId={P} />, []) },
  { name: "Integration · Sentry", render: sectionOf(() => <SentrySection projectId={P} />) },
  {
    name: "Integration · Sentry retired shape",
    render: sectionOf(() => <SentrySection projectId={P} />, [binding("sentry", { config: { host: "logs.example.com", organizationSlug: "sid", projectSlug: "hop", targets: [] } })]),
  },
  { name: "Integration · GitLab", render: sectionOf(() => <GitlabSection projectId={P} />) },
  { name: "Integration · GitLab new", render: sectionOf(() => <GitlabSection projectId={P} />, []) },
  { name: "Integration · GitHub", render: sectionOf(() => <GitHubSection projectId={P} />) },
  { name: "Integration · GitHub repository", render: sectionOf(() => <GitHubSection projectId={P} />), act: clickKey("integrations.github.changeRepo") },
  { name: "Integration · GitHub existing App", render: sectionOf(() => <GitHubSection projectId={P} />, []) },
  {
    name: "Integration · GitHub new App",
    render: () => (
      <Seeded data={[...queries([]), [["integration-connections"], { items: [] }]]}>
        <GitHubSection projectId={P} />
      </Seeded>
    ),
  },
  { name: "Integration · delivery log", render: sectionOf(() => <><DeliveryLogViewer projectId={P} bindingId="b-coolify" /><DeliveryLogViewer projectId={P} bindingId={null} /></>) },
];
