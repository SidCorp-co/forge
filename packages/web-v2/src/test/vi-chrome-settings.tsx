import type { QueryKey } from "@tanstack/react-query";
import { fireEvent } from "@testing-library/react";
import type { ReactNode } from "react";
import { AgentsTab } from "@/features/agent-accounts/components/agents-tab";
import { ActiveOrgProvider } from "@/features/orgs/active-org";
import { OrgHome } from "@/features/orgs/components/org-home";
import { OrgsTab } from "@/features/orgs/components/orgs-tab";
import { CurrentProjectProvider } from "@/features/projects/current-project";
import type { ProjectListItem } from "@/features/projects/types";
import { McpTab } from "@/features/settings/components/mcp-tab";
import { TokensTab } from "@/features/settings/components/tokens-tab";
import { type ProductCopyKey, productCopy } from "@/lib/i18n/product-copy";
import { Seeded } from "./vi-chrome-requirements";

// The Settings tabs of the Development space for the vi walking test: organizations and an org's
// members, agents and an agent's self, API tokens, and the MCP connect page. An email, a handle, a
// slug, a token prefix, a scope and a permission name stay as they are.

const NOW = Date.now();
const ago = (min: number) => new Date(NOW - min * 60_000).toISOString();

const ORGS = [
  { id: "o1", name: "Me", slug: "me", role: "owner", isPersonal: true },
  { id: "o2", name: "Hop", slug: "hop", role: "owner", isPersonal: false },
  { id: "o3", name: "Partner", slug: "partner", role: "member", isPersonal: false },
];

const PROJECT = { id: "p1", slug: "hop", name: "Hop", orgId: "o2", orgName: "Hop", orgIsPersonal: false, orgRole: "owner" } as unknown as ProjectListItem;

const token = (n: number, over: Record<string, unknown> = {}) => ({
  id: `t${n}`,
  name: `ci-${n}`,
  prefix: `forge_pat_${n}ab`,
  scopes: ["read"],
  projectIds: null,
  permissions: ["issues.read", "issues.write"],
  grant: "named",
  boundProjectId: null,
  expiresAt: ago(-60 * 24 * 30),
  createdAt: ago(60 * 24),
  lastUsedAt: ago(30),
  lastUsedIp: null,
  revokedAt: null,
  ...over,
});

const agent = (n: number, over: Record<string, unknown> = {}) => ({
  userId: `a${n}`,
  handle: `hop-${n}`,
  displayName: n === 1 ? "Hop bot" : null,
  email: `hop-${n}@agents.local`,
  projects: [{ id: "p1", role: "member" }],
  createdAt: ago(600),
  activeTokens: 1,
  canAct: true,
  ...over,
});

const queries = (activeOrg = "o2"): [QueryKey, unknown][] => [
  [["orgs"], ORGS],
  [["settings", "preferences"], { activeOrgId: activeOrg }],
  [["orgs", "o2", "members"], [{ userId: "u1", email: "an@example.com", role: "owner", lenses: ["technical"] }, { userId: "u2", email: "binh@example.com", role: "member", lenses: [] }]],
  [["orgs", "o2", "projects"], [{ id: "p1", name: "Hop", slug: "hop", archivedAt: null }, { id: "p2", name: "Old", slug: "old", archivedAt: ago(9000) }]],
  [["orgs", "o2", "invitations"], [{ email: "chi@example.com", role: "admin", expired: true }]],
  [["orgs", "o1", "projects"], []],
  [["projects"], [PROJECT]],
  [["agent-accounts", "o2"], [agent(1), agent(2, { projects: [], activeTokens: 1, canAct: false }), agent(3, { activeTokens: 0, canAct: false })]],
  [["agent-accounts", "o2", "self", "a1"], { userId: "a1", soul: null, instructions: null, emoji: null, greeting: null, presence: { answerInGroup: "mention" }, updatedBy: null, createdAt: null, updatedAt: null }],
  [["settings", "tokens"], {
    tokens: [token(1), token(2, { grant: "full", boundProjectId: "p1", scopes: ["read", "write"] }), token(3, { grant: "legacy", revokedAt: ago(5), expiresAt: null, lastUsedAt: null }), token(4, { permissions: ["issues.read"] })],
    menu: { permissions: ["issues.read", "issues.write"], full: "*" },
  }],
];

const inOrg = (children: ReactNode, activeOrg?: string) => (
  <Seeded data={queries(activeOrg)}>
    <ActiveOrgProvider>{children}</ActiveOrgProvider>
  </Seeded>
);

// a control found by its label in either language: the rail test draws each screen in en as well
const clickKey = (key: ProductCopyKey, nth = 0) => () => {
  const labels = [productCopy("vi")(key), productCopy("en")(key)];
  const hits = [...document.querySelectorAll("button, a")].filter((b) => labels.includes(b.textContent?.trim() ?? ""));
  const el = hits[nth];
  if (!el) throw new Error(`nothing to open labelled ${key}`);
  fireEvent.click(el);
};

export const SETTINGS_SCREENS = [
  { name: "Settings · organizations", render: () => inOrg(<OrgsTab />), act: clickKey("settings.orgs.members") },
  { name: "Settings · organization home", render: () => inOrg(<OrgHome />), act: clickKey("integrations.edit.rename") },
  { name: "Settings · personal home", render: () => inOrg(<OrgHome />, "o1") },
  { name: "Settings · agents", render: () => inOrg(<AgentsTab />), act: clickKey("settings.agents.self") },
  { name: "Settings · agents, not an admin", render: () => inOrg(<AgentsTab />, "o3") },
  { name: "Settings · tokens", render: () => inOrg(<TokensTab />), act: clickKey("settings.tokens.create") },
  { name: "Settings · MCP", render: () => inOrg(<CurrentProjectProvider project={PROJECT}><McpTab /></CurrentProjectProvider>) },
  { name: "Settings · MCP, no project chosen", render: () => inOrg(<McpTab />) },
];
